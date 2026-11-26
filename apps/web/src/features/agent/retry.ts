/**
 * 对话响应丢失时跨重载只恢复请求身份和已审阅的标识。存储没有消息正文、模型配置或员工凭证。
 */
import type { AgentSchemas } from "./adapters";

type Submission = AgentSchemas["AgentTurnSubmit"];

// 页面内记录记住最近一次写入或结清。持久操作失败时，以页面内结果遮住仍可读取的旧存储值。
interface PageRetry {
    value?: string;
    overridesStorage: boolean;
}

const fallback = new Map<string, PageRetry>();
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

// 持久操作失败后的页面记录有优先权，包括没有值的结清记录。正常存储继续提供标签页重载时的身份。
function read(key: string): string | undefined {
    const page = fallback.get(key);
    if (page?.overridesStorage) {
        return page.value;
    }
    try {
        return sessionStorage.getItem(key) ?? page?.value;
    } catch {
        return page?.value;
    }
}

// 保留当前页面最近一次写入供读取失败时使用。持久删除成功后释放对应页面记录，失败则记住结清结果。
function write(key: string, value?: string) {
    try {
        if (value) {
            sessionStorage.setItem(key, value);
        } else {
            sessionStorage.removeItem(key);
        }
    } catch {
        fallback.set(key, { value, overridesStorage: true });
        return;
    }
    if (value) {
        fallback.set(key, { value, overridesStorage: false });
    } else {
        fallback.delete(key);
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
    intent: { confirmation: boolean; expectedProposalId?: string; attachments?: Submission["attachments"] },
    signal: AbortSignal,
): Promise<Submission> {
    // 旧版无附件请求的摘要保持可重放；附件按提交顺序参与散列，浏览器存储继续只记录不可逆摘要及绑定的编号。
    const attachments = intent.attachments?.length ? intent.attachments : undefined;
    const materials = attachments?.map(({ name, mediaType, dataBase64 }) => [name, mediaType, dataBase64]);
    const encoded = new TextEncoder().encode(materials ? JSON.stringify([text, materials]) : text);
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
    return {
        requestId,
        text,
        ...(target ? { expectedProposalId: target } : {}),
        ...(attachments ? { attachments } : {}),
    };
}

/**
 * 清除已知结算的请求，迟到结果须匹配现存编号，手工重试已失败轮次时则明确要求下一次重新生成编号。
 */
export function clearAgentSubmission(key: string, requestId?: string) {
    if (!requestId || retryRecord(read(key))?.requestId === requestId) write(key);
}
