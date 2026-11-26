/**
 * Web 入口验证链接指定的工作区，并提供与桌面共享的在线会话视图。页面加载链接不会自动创建会话或请求模型。
 */
import { useContext, useMemo } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { Auth } from "../../auth-context";
import { tx, useAppLocale } from "../../locale";
import { Panel } from "../../ui";
import { CloudAiAdapter } from "../ai/adapters";
import { CloudReportAdapter } from "../reports/adapters";
import { useWorkspaceDirectory, WorkspaceStatus } from "../workspaces/WorkspaceDirectory";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { CloudAgentAdapter } from "./adapters";
import { AgentWorkspaceView } from "./AgentWorkspaceView";
import { acknowledgeAgentReply } from "../notifications/transport";

const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 只在确定目标空间的员工成员权限后打开对话。手动切换会清空链接中的计划标识，并取消先前空间所有对话请求。
 */
export function AgentPage() {
    useAppLocale();
    const { user } = useContext(Auth);
    const { workspace, requested } = useWorkspaceDirectory();
    const { selected, signal } = useWorkspace();
    const [params] = useSearchParams();
    const rawPlan = params.get("planId") ?? "";
    const initialPlan = requested && isId.test(rawPlan) ? rawPlan.toLowerCase() : undefined;
    const adapters = useMemo(
        () => ({
            agent: new CloudAgentAdapter(selected),
            providers: new CloudAiAdapter(selected),
            reports: new CloudReportAdapter(selected),
        }),
        [selected],
    );
    if (!user) return <Navigate to="/login" />;
    return (
        <Panel title={tx("Test Agent")}>
            <WorkspaceStatus />
            {workspace && (
                <AgentWorkspaceView
                    key={`${user.id}/${workspace.id}/${initialPlan ?? ""}`}
                    workspace={workspace}
                    owner={user.id}
                    ownerName={user.displayName}
                    adapter={adapters.agent}
                    providers={adapters.providers}
                    reports={adapters.reports}
                    onReplyVisible={acknowledgeAgentReply}
                    parentSignal={signal}
                    initialPlanId={initialPlan}
                    navigate={(runId) => (
                        <Link to={`/reports?workspaceId=${workspace.id}&runId=${runId}`}>{tx("Open full report")}</Link>
                    )}
                />
            )}
        </Panel>
    );
}
