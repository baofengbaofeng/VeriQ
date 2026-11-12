/**
 * 本文件观察浏览器上下文的写副作用以判定整案重试安全性：区分只读完结、可能写过与状态未知三类（retry-safety）。
 */

import type { BrowserContext, Page, Request } from "@playwright/test";
/**
 * 公开类型 RetrySafety 枚举重试安全结论：READ_ONLY_OBSERVED / WRITE_POSSIBLE / UNKNOWN。
 * 供平台决定是否允许整案重试。
 */
export type RetrySafety = "READ_ONLY_OBSERVED" | "WRITE_POSSIBLE" | "UNKNOWN";
/** No URL/header/body is retained. A closed, fully observed business Context is required. */
/**
 * 公开类 RetryObservation 监听 Context 的请求/页面/WebSocket：在 finish 时给出 RetrySafety。
 * 不保留 URL 或正文。
 */
export class RetryObservation {
    private writes: boolean;
    private closed = false;
    private pages = new Set<Page>();
    private request = (request: Request) => this.method(request.method());
    private websocket = () => {
        this.writes = true;
    };
    private page = (page: Page) => {
        this.pages.add(page);
        page.on("websocket", this.websocket);
    };
    private close = () => {
        this.closed = true;
    };
    constructor(
        private context: BrowserContext,
        declaredWrites: boolean,
    ) {
        this.writes = declaredWrites;
        context.on("request", this.request);
        context.on("page", this.page);
        context.on("close", this.close);
        for (const page of context.pages()) this.page(page);
    }
    /**
     * 公开方法 method 根据 HTTP 方法更新写副作用标记：非 GET/HEAD/OPTIONS 一律视为可能写入（method）。
     */
    method(method: string) {
        if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) this.writes = true;
    }
    /**
     * 公开方法 finish 卸除监听并返回 RetrySafety：仅在 finalized 且 Context 已关闭且无写痕迹时才是 READ_ONLY_OBSERVED。
     */
    finish(finalized: boolean): RetrySafety {
        this.context.off("request", this.request);
        this.context.off("page", this.page);
        this.context.off("close", this.close);
        for (const page of this.pages) page.off("websocket", this.websocket);
        return this.writes
            ? "WRITE_POSSIBLE"
            : finalized && this.closed
              ? "READ_ONLY_OBSERVED"
              : "UNKNOWN";
    }
}
