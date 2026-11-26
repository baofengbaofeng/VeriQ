/**
 * 发布回归只暂缓自己匹配的真实校验回执，真实请求仍由服务端生成；此屏障负责等待回调及响应资源结算，不生成或修改任何业务
 * 回执，也不卸载其它测试拥有的请求处理器。
 */
import type { Page, Route, APIResponse } from "@playwright/test";
import { withCleanup } from "./case-profile-cleanup.js";

/**
 * 回执释放后必须等待实际回调结束再卸载处理器，否则默认卸载会自动继续仍被持有的请求；回调错误先保存后由正文等待或清理
 * 原样交付一次，避免未处理拒绝和正文、清理重复报告同一错误。
 */
export async function holdValidationReceipt(page: Pick<Page, "route" | "unroute">, requested: (url: URL) => boolean) {
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const holding = new Promise<void>((resolve) => (held = resolve));
    let callback: Promise<void> | undefined;
    let captured = false;
    let closing = false;
    let callbackFailed = false;
    let callbackError: unknown;
    let reported = false;
    const matches = (url: URL) => !captured && !closing && requested(url);
    const throwCallbackError = () => {
        if (callbackFailed && !reported) {
            reported = true;
            throw callbackError;
        }
    };
    const handler = (route: Route) => {
        captured = true;
        callback = (async () => {
            let response: APIResponse | undefined;
            try {
                await withCleanup(
                    async () => {
                        response = await route.fetch();
                        if (response.status() !== 200) throw new Error("Validation receipt upstream failed");
                        held();
                        await gate;
                        if (!route.request().failure()) await route.fulfill({ response });
                    },
                    async () => {
                        await response?.dispose();
                    },
                );
            } catch (error) {
                callbackFailed = true;
                callbackError = error;
            } finally {
                held();
            }
        })();
        return callback;
    };
    await page.route(matches, handler);
    return {
        holding: async () => {
            await holding;
            throwCallbackError();
        },
        release,
        delivered: async () => {
            await callback;
            throwCallbackError();
        },
        close: async () => {
            closing = true;
            release();
            await withCleanup(
                async () => {
                    await callback;
                    throwCallbackError();
                },
                () => page.unroute(matches, handler),
            );
        },
    };
}
