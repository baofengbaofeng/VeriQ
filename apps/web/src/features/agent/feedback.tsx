/**
 * 对话状态使用有限的业务代号提供中英文说明。未知错误保留标准代号，避免桌面将宿主路径或异常堆栈放进私有线程。
 */
import { tx } from "../../locale";
import { agentErrorCode } from "./adapters";

const messages: Record<string, string> = {
    PLAN_REVISION_CONFLICT: "The plan changed. Open the latest revision and request a new proposal.",
    AGENT_PROPOSAL_SUPERSEDED: "This proposal was superseded. Review the latest proposal.",
    AGENT_PROVIDER_UNCONFIGURED: "Configure a model to request a plan.",
    AGENT_TURN_BUSY: "The current turn is still processing.",
    AGENT_CALL_EXPIRED: "The model request expired.",
    AI_PROVIDER_DISABLED: "This provider is disabled.",
    AI_PROVIDER_NOT_FOUND: "This provider no longer exists.",
    AI_ENDPOINT_FORBIDDEN: "This provider endpoint is no longer allowed.",
};

/**
 * 提交、轮次和配置都使用同一业务代号表，未知服务端错误仍保留代号供用户与维护人员定位当前失败。
 */
export function agentProblem(code: string): string {
    const label = messages[code];
    return label ? `${tx(label)} (${code})` : code;
}

/**
 * 查询失败始终提供显式重试入口，父级在身份或工作区切换后卸载此组件，旧异常不会出现在新对话中。
 */
export function AgentError({ error, retry }: { error: unknown; retry?: () => void }) {
    if (!error) return null;
    const code = agentErrorCode(error);
    return (
        <div className="vq-agent-feedback">
            <p role="alert">{code ? agentProblem(code) : tx("Unable to load conversation data. Retry the request.")}</p>
            {retry && (
                <button type="button" onClick={retry}>
                    {tx("Retry")}
                </button>
            )}
        </div>
    );
}
