/**
 * 对话适配器将工作区、会话、轮次标识和签名游标交给现有员工传输，Web Cookie 与桌面白名单使用相同的返回契约。
 * 计划确认不接收模型参数，所有真实副作用必须通过服务端对已持久化提议的校验。
 */
import type { PlatformComponents } from "@veriq/contracts";
import { ApiError, request } from "../../api";

/**
 * 使用平台生成类型保留各业务操作的可辨识联合与可空引用，设置、轮次和报告可共享同一套版本定义。
 */
export type AgentSchemas = PlatformComponents["schemas"];

/**
 * 适配器绑定构造时的授权工作区。页面切换时调用方取消旧信号，并以新身份和新工作区重建视图。
 */
export class CloudAgentAdapter {
    private readonly base: string;
    constructor(workspaceId: string) {
        this.base = `/workspaces/${encodeURIComponent(workspaceId)}/agent`;
    }

    // 在路径中独立编码会话标识，获取详情、归档以及历史时都保持当前工作区和该会话的父子关系。
    private sessionPath = (id: string) => `${this.base}/sessions/${encodeURIComponent(id)}`;

    // 模型设置的写入是完整替换，两项都显式可空，不能用遗漏字段表达对当前设置的保留操作。
    settings = (signal?: AbortSignal) =>
        request<AgentSchemas["AgentSettingsDTO"]>(`${this.base}/settings`, "GET", undefined, signal);

    // 调用者以服务器回传解析状态更新表单，保存完成不直接从本地选项推断 Provider 已经可以使用。
    saveSettings = (data: AgentSchemas["AgentSettingsWrite"], signal?: AbortSignal) =>
        request<AgentSchemas["AgentSettingsDTO"]>(`${this.base}/settings`, "PUT", data, signal);

    // 签名游标只在同一个筛选下继续使用，归档筛选始终显式提交且不与活动列表共享分页状态。
    sessions = (archived: boolean, cursor?: string, signal?: AbortSignal) => {
        const query = new URLSearchParams({ archived: String(archived) });
        if (cursor) query.set("cursor", cursor);
        return request<AgentSchemas["AgentSessionDTOPageEnvelope"]["data"]>(
            `${this.base}/sessions?${query}`,
            "GET",
            undefined,
            signal,
        );
    };

    // 标题缺省时由服务端生成统一名称，同时分配私有会话的正式标识，客户端可据此继续读取本人会话。
    createSession = (data: AgentSchemas["AgentSessionCreate"], signal?: AbortSignal) =>
        request<AgentSchemas["AgentSessionDTO"]>(`${this.base}/sessions`, "POST", data, signal);

    // 会话详情保留归档标记，另一端变更状态后重新读取详情，才能更新当前聊天是否具备写入能力。
    session = (id: string, signal?: AbortSignal) =>
        request<AgentSchemas["AgentSessionDTO"]>(this.sessionPath(id), "GET", undefined, signal);

    // 归档只改变历史筛选状态，当前会话及轮次仍存在，因此无需提交任何正文或额外业务修订。
    archive = (id: string, signal?: AbortSignal) =>
        request<AgentSchemas["Empty"]>(this.sessionPath(id), "DELETE", undefined, signal);

    // 对话轮次按服务端时间顺序读取；签名游标只交给所属会话续页，未换页时当前线程保留首段历史。
    turns = (id: string, cursor?: string, signal?: AbortSignal) =>
        request<AgentSchemas["AgentTurnDTOPageEnvelope"]["data"]>(
            `${this.sessionPath(id)}/turns${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
            "GET",
            undefined,
            signal,
        );

    // 请求 UUID 属于单次文本提交，重试在服务器端复用原始轮次，后续新消息使用不同 UUID。
    submit = (id: string, data: AgentSchemas["AgentTurnSubmit"], signal?: AbortSignal) =>
        request<AgentSchemas["AgentTurnDTO"]>(`${this.sessionPath(id)}/turns`, "POST", data, signal);

    // 确认只选择服务器已保存的轮次，禁止在请求体增加覆盖参数，成功后读取该轮真实回执。
    confirm = (id: string, turnId: string, signal?: AbortSignal) =>
        request<AgentSchemas["AgentTurnDTO"]>(
            `${this.sessionPath(id)}/turns/${encodeURIComponent(turnId)}/confirm`,
            "POST",
            undefined,
            signal,
        );
}

/**
 * Web 直接提供 Problem code，Electron 将同一代号放入 IPC 异常消息，仅提取受限标识并保留统一展示能力。
 */
export function agentErrorCode(error: unknown): string | undefined {
    if (error instanceof ApiError) return error.code;
    const message = error instanceof Error ? error.message : "";
    return /(?:^|: )([A-Z][A-Z0-9_]{2,100})$/.exec(message)?.[1];
}

/**
 * 只有来自当前读接口的这些明确代号证明工作区对话不可读，报告专属错误和普通传输异常由各调用方继续处理。
 */
export function agentWorkspaceReadDenied(error: unknown): boolean {
    const code = agentErrorCode(error);
    return code === "AUTHENTICATION_REQUIRED" || code === "WORKSPACE_FORBIDDEN" || code === "WORKSPACE_NOT_FOUND";
}

/**
 * 在读取所属的取消边界仍有效时交付失败，先把明确拒绝传给视图，再让查询各自保留原始错误以供反馈。
 */
export async function observeAgentRead<T>(
    read: Promise<T>,
    signal: AbortSignal,
    onFailure: (error: unknown) => void,
): Promise<T> {
    try {
        const data = await read;
        signal.throwIfAborted();
        return data;
    } catch (error) {
        if (!signal.aborted) {
            onFailure(error);
        }
        throw error;
    }
}
