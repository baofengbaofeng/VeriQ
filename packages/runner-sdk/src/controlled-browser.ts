/** 生成用例在公开 worker fixture 阶段连接原有浏览器，使控制端点失败早于测试级 artifact API 监听器安装；连接异常从无秘密字面量的 SDK 模块重新抛出固定错误，保留原 Browser 身份、选项以及
 * Playwright 自身上下文与关闭所有权。 */
import { test as baseTest, type BrowserType } from "@playwright/test";

type ConnectObject = Parameters<BrowserType["connect"]>[0];
type ConnectOptions = Omit<ConnectObject, "wsEndpoint">;

/**
 * 保护只包围同一个 BrowserType 的公开 connect，并按调用原样保留两个重载、接收者和参数对象；结束时恢复准确的自有属性描述符或继承关系，所有权冲突明确失败，原错误的 cause、动态文本与附加字段绝不复制到新异
 * 常。
 */
export function protectBrowserConnection(browserType: BrowserType): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(browserType, "connect"),
        original = browserType.connect;
    function guarded(
        this: BrowserType,
        endpoint: string,
        options?: ConnectOptions,
    ): ReturnType<BrowserType["connect"]>;
    function guarded(this: BrowserType, options: ConnectObject): ReturnType<BrowserType["connect"]>;
    async function guarded(
        this: BrowserType,
        ...args: unknown[]
    ): ReturnType<BrowserType["connect"]> {
        try {
            return await Reflect.apply(original, this, args);
        } catch {
            throw new Error("VERIQ_BROWSER_CONNECTION_FAILED");
        }
    }
    Object.defineProperty(browserType, "connect", {
        value: guarded,
        configurable: true,
        writable: true,
        enumerable: descriptor?.enumerable ?? false,
    });
    let restored = false;
    return () => {
        if (restored) return;
        if (browserType.connect !== guarded)
            throw new Error("VERIQ_BROWSER_GUARD_RESTORE_CONFLICT");
        if (descriptor) Object.defineProperty(browserType, "connect", descriptor);
        else if (!Reflect.deleteProperty(browserType, "connect"))
            throw new Error("VERIQ_BROWSER_GUARD_RESTORE_FAILED");
        restored = true;
    };
}

/**
 * 仅 registerCase 使用这个内部扩展测试，worker 自动夹具显式依赖原始内建 browser，先建立其原有 connect 或 launch 再进入测试级 artifacts；原 browser 的 use、cl
 * ose、页面认证、追踪与重试流程均由 Playwright 保留，本模块不创建替代 Browser 或结果。
 */
export const controlledBrowserTest = baseTest.extend<{}, { veriqControlledBrowserReady: void }>({
    playwright: [
        async ({ playwright, browserName }, use) => {
            const restore = protectBrowserConnection(playwright[browserName]);
            try {
                await use(playwright);
            } finally {
                restore();
            }
        },
        { scope: "worker" },
    ],
    veriqControlledBrowserReady: [
        async ({ browser }, use) => {
            void browser;
            await use();
        },
        { scope: "worker", auto: true },
    ],
});
