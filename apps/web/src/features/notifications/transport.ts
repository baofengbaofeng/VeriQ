/**
 * 通知传输复用 Web 会话和标准事件流解析，连接只发送失效信号，内容由各自授权的快照请求读取。
 */
import { EventSourceParserStream } from "eventsource-parser/stream";
import { ApiError, request, streamAuthorizationError, streamRequest } from "../../api";
import type { AgentNotificationTarget, InboxNotification, InboxPage } from "./model";

const path = "/notifications";

/**
 * 所有写入均沿用已有的会话 CSRF 请求头；列表筛选与分页仅使用服务端返回的游标和当前界面选项。
 */
export const notificationApi = {
    list: (limit: number, unread: boolean, signal: AbortSignal, cursor?: string) => {
        const query = new URLSearchParams({ limit: String(limit) });
        if (unread) query.set("unread", "true");
        if (cursor) query.set("cursor", cursor);
        return request<InboxPage>(`${path}?${query}`, "GET", undefined, signal);
    },
    detail: (id: string, signal: AbortSignal) =>
        request<InboxNotification>(`${path}/${encodeURIComponent(id)}`, "GET", undefined, signal),
    read: (id: string, signal: AbortSignal) =>
        request<InboxNotification>(`${path}/${encodeURIComponent(id)}/read`, "POST", {}, signal),
    readAll: (through: string, signal: AbortSignal) =>
        request<{ updated: number }>(`${path}/read-all`, "POST", { through }, signal),
    accept: (id: string, signal: AbortSignal) =>
        request<{ workspaceId: string }>(`${path}/${encodeURIComponent(id)}/accept`, "POST", {}, signal),
};

/**
 * 已展示回执只携带当前对话的三个标识，实际提交由可见性观察触发，同一轮次可由服务端幂等确认。
 */
export async function acknowledgeAgentReply(target: AgentNotificationTarget, signal: AbortSignal): Promise<void> {
    await request<{ acknowledged: boolean }>(`${path}/agent-seen`, "POST", target, signal);
}

/**
 * 重连等待绑定当前账户的有效期，取消立即清理计时器与监听器，退出后的连接不能再次访问收件箱。
 */
function retryDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve) => {
        function finish() {
            window.clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
        }
        const timer = window.setTimeout(finish, milliseconds);
        signal.addEventListener("abort", finish, { once: true });
    });
}

/**
 * 每次连接首帧重新读取当前快照，网络断开后采用有上限的退避，服务端明确拒绝当前连接则结束订阅。
 */
export async function observeInbox(invalidate: () => void, signal: AbortSignal): Promise<void> {
    let wait = 1000;
    while (!signal.aborted) {
        try {
            const response = await streamRequest(`${path}/stream`, {}, signal);
            if (!response.body) throw new Error("Notification stream is unavailable");
            const reader = response.body
                .pipeThrough(new TextDecoderStream())
                .pipeThrough(new EventSourceParserStream({ maxBufferSize: 4096, onError: "terminate" }))
                .getReader();
            try {
                // 版本是服务端维护的失效标志，浏览器只需在本次连接中识别重复帧，连接重建后总是进行首次刷新。
                let revision: string | undefined;
                while (!signal.aborted) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value.event === "authorization")
                        throw streamAuthorizationError(response, JSON.parse(value.data));
                    if (value.event !== "inbox") continue;
                    const next = (JSON.parse(value.data) as { revision?: unknown }).revision;
                    if (typeof next === "string" && next !== revision) {
                        revision = next;
                        wait = 1000;
                        invalidate();
                    }
                }
            } finally {
                await reader.cancel().catch(() => undefined);
                reader.releaseLock();
            }
        } catch (error) {
            if (signal.aborted) return;
            if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
                invalidate();
                return;
            }
        }
        if (!signal.aborted) await retryDelay(wait, signal);
        wait = Math.min(wait * 2, 15000);
    }
}
