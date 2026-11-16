/** 真实认证响应必须在浏览器应用头部之前暂停，Playwright 的 route.fetch 会提前修改同一上下文的 Cookie；此屏障用 Node 直连同一个本机服务转发原请求，既不共享浏览器 Cookie 容器也不改写认证内容。 */
import { request as httpRequest } from "node:http";
import type { Page, Route } from "@playwright/test";

type HeldResponse = { status: number; headers: Record<string, string>; body: Buffer };

/** 屏障只接受固定开发源上的明确认证路径与方法，复制原始请求头和正文并有界读取真实响应；release 可重复执行，浏览器已因产品取消而失败时仅完成屏障结算，绝不人工 route.abort 制造取消证据。 */
export async function holdAuthResponse(page: Page, pathname: string, method: string) {
    const origin = "http://127.0.0.1:5173";
    if (!["/api/v1/auth/logout", "/api/v1/setup"].includes(pathname))
        throw new Error("Unsupported authentication barrier path");
    let heldResolve!: (response: HeldResponse) => void;
    let heldReject!: (error: unknown) => void;
    let releaseGate!: () => void;
    let complete!: () => void;
    let captured = false;
    const held = new Promise<HeldResponse>((resolve, reject) => {
        heldResolve = resolve;
        heldReject = reject;
    });
    const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
    });
    const done = new Promise<void>((resolve) => {
        complete = resolve;
    });
    const matches = (url: URL) => url.origin === origin && url.pathname === pathname;
    const handler = async (route: Route) => {
        if (captured || route.request().method() !== method) return route.continue();
        captured = true;
        try {
            const outgoing = route.request();
            const headers = await outgoing.allHeaders();
            const response = await new Promise<HeldResponse>((resolve, reject) => {
                const upstream = httpRequest(outgoing.url(), { method, headers }, (incoming) => {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    incoming.on("data", (chunk: Buffer) => {
                        size += chunk.length;
                        if (size > 1024 * 1024) {
                            incoming.destroy(
                                new Error("Authentication barrier body exceeds limit"),
                            );
                            return;
                        }
                        chunks.push(chunk);
                    });
                    incoming.on("error", reject);
                    incoming.on("end", () => {
                        const originalHeaders: Record<string, string> = {};
                        // Playwright 用换行承载重复头部值，因此保留服务端同名头部的原始值与顺序，包含 Set-Cookie；不解压、不解析、不移除 Cookie 头，浏览器只有 fulfill 时才能看到这些字节。
                        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
                            const name = incoming.rawHeaders[index]!.toLowerCase();
                            const value = incoming.rawHeaders[index + 1]!;
                            originalHeaders[name] =
                                originalHeaders[name] === undefined
                                    ? value
                                    : originalHeaders[name] + "\n" + value;
                        }
                        if (incoming.statusCode === undefined) {
                            reject(new Error("Authentication barrier received no HTTP status"));
                            return;
                        }
                        resolve({
                            status: incoming.statusCode,
                            headers: originalHeaders,
                            body: Buffer.concat(chunks),
                        });
                    });
                });
                upstream.setTimeout(10_000, () =>
                    upstream.destroy(new Error("Authentication barrier upstream timed out")),
                );
                upstream.on("error", reject);
                upstream.end(outgoing.postDataBuffer() ?? undefined);
            });
            heldResolve(response);
            await gate;
            if (!outgoing.failure()) await route.fulfill(response);
        } catch (error) {
            heldReject(error);
            throw error;
        } finally {
            complete();
        }
    };
    await page.route(matches, handler);
    return {
        held,
        release: async () => {
            releaseGate();
            if (captured) await done;
            await page.unroute(matches, handler);
        },
    };
}
