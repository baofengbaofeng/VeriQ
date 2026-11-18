/**
 * 对话响应丢失时跨重载只恢复请求身份和已审阅的标识。存储没有消息正文、模型配置或员工凭证。
 */
import type { AgentSchemas } from "./adapters";

type Submission = AgentSchemas["AgentTurnSubmit"];
const fallback = new Map<string, string>();
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// 三段记录分别保存正文摘要、请求和原始目标，旧版两段记录不具备足够信息来推断唯一确认目标。
function retryRecord(raw?: string) {
    const parts = raw?.split("/");
    const [digest, requestId, target] = parts ?? [];
    if (parts?.length !== 3 || !digest || !/^[0-9a-f]{64}$/.test(digest) || !requestId || !uuid.test(requestId))
        return undefined;
    if (target && !uuid.test(target)) return undefined;
    return { digest, requestId, target: target || undefined };
}

// 只在当前标签页读取操作身份。受限存储模式仍能在当前渲染进程重用已发送的请求编号，切换工作区不会共用一条记录。
function read(key: string): string | undefined {
    try {
        return sessionStorage.getItem(key) ?? fallback.get(key);
    } catch {
        return fallback.get(key);
    }
}

// 写入失败时使用进程中的有限当前记录，删除某条请求只影响它所属的身份、工作区与会话，不接触其它标签页。
function write(key: string, value?: string) {
    if (value) fallback.set(key, value);
    else fallback.delete(key);
    try {
        if (value) sessionStorage.setItem(key, value);
        else sessionStorage.removeItem(key);
    } catch {
        // 无法持久化时仍保留内存副本供页面内重试，且不会为了重试将对话正文另行保存。
    }
}

/**
 * 即使线程已出现不同动作，保存的原始确认仍可尝试重放；发送逻辑会再次核对精确正文摘要和作用域。
 */
export function hasPendingAgentConfirmation(key: string): boolean {
    return !!retryRecord(read(key))?.target;
}

/**
 * 同一未结算正文复用已登记的目标和请求编号，刷新出来的新提议只适用于新意图，不能替换原确认目标。
 */
export async function agentSubmission(
    key: string,
    text: string,
    intent: { confirmation: boolean; expectedProposalId?: string },
    signal: AbortSignal,
): Promise<Submission> {
    const encoded = new TextEncoder().encode(text);
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
    const digest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    signal.throwIfAborted();
    const raw = read(key);
    const stored = retryRecord(raw);
    if (raw && !stored && intent.confirmation) throw new Error("AGENT_CONFIRM_RETRY_UNAVAILABLE");
    const previous = stored?.digest === digest ? stored : undefined;
    const target = previous ? previous.target : intent.expectedProposalId;
    if (intent.confirmation && !target) throw new Error("AGENT_CONFIRM_TARGET_REQUIRED");
    const requestId = previous?.requestId ?? crypto.randomUUID();
    write(key, `${digest}/${requestId}/${target ?? ""}`);
    return { requestId, text, ...(target ? { expectedProposalId: target } : {}) };
}

/**
 * 清除已知结算的请求，迟到结果须匹配现存编号，手工重试已失败轮次时则明确要求下一次重新生成编号。
 */
export function clearAgentSubmission(key: string, requestId?: string) {
    if (!requestId || retryRecord(read(key))?.requestId === requestId) write(key);
}
