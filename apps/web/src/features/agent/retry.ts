/**
 * 对话响应丢失时跨重载只恢复请求身份。存储内容仅有 UUID 与意图摘要，不含消息正文、模型配置或员工凭证。
 */
import type { AgentSchemas } from "./adapters";

type Submission = AgentSchemas["AgentTurnSubmit"];
const fallback = new Map<string, string>();

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
 * 原文及确认目标共同确定一次可重试意图。异步计算返回后检查当前会话仍拥有信号，避免切换后登记另一请求。
 */
export async function agentSubmission(
    key: string,
    text: string,
    expectedProposalId: string | undefined,
    signal: AbortSignal,
): Promise<Submission> {
    const encoded = new TextEncoder().encode(JSON.stringify([text, expectedProposalId ?? null]));
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
    const digest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    signal.throwIfAborted();
    const previous = read(key);
    const requestId = previous?.startsWith(digest + "/") ? previous.slice(65) : undefined;
    const id =
        requestId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId) ? requestId : crypto.randomUUID();
    write(key, `${digest}/${id}`);
    return { requestId: id, text, ...(expectedProposalId ? { expectedProposalId } : {}) };
}

/**
 * 清除已知结算的请求，迟到结果须匹配现存编号，手工重试已失败轮次时则明确要求下一次重新生成编号。
 */
export function clearAgentSubmission(key: string, requestId?: string) {
    if (!requestId || read(key)?.endsWith("/" + requestId)) write(key);
}
