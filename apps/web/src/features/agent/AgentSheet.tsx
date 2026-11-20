/**
 * 顶栏 Test Agent 入口：以机器人图标按钮触发右侧抽屉，承载与桌面共享的对话视图，替代原先侧栏菜单入口。进入抽屉不会自动创建
 * 会话或请求模型；当前未选择工作区时仅展示目录状态提示。
 */
import { useContext, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Auth } from "../../auth-context";
import { tx, useAppLocale } from "../../locale";
import { Sheet } from "../../components";
import icons from "../../admin-icons.svg?no-inline";
import { CloudAiAdapter } from "../ai/adapters";
import { CloudReportAdapter } from "../reports/adapters";
import { useWorkspaceDirectory, WorkspaceStatus } from "../workspaces/WorkspaceDirectory";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { CloudAgentAdapter } from "./adapters";
import { AgentWorkspaceView } from "./AgentWorkspaceView";
import { AgentModelControls } from "./ModelSettings";

export function AgentSheet() {
    useAppLocale();
    const { user } = useContext(Auth);
    const { workspace } = useWorkspaceDirectory();
    const { selected, signal } = useWorkspace();
    const [open, setOpen] = useState(false);
    const [wide, setWide] = useState(false);
    const adapters = useMemo(
        () => ({
            agent: new CloudAgentAdapter(selected),
            providers: new CloudAiAdapter(selected),
            reports: new CloudReportAdapter(selected),
        }),
        [selected],
    );
    if (!user) return null;
    return (
        <>
            <button
                type="button"
                className="vq-workspace-icon"
                aria-label={tx("Test Agent")}
                title={tx("Test Agent")}
                onClick={() => {
                    setWide(false);
                    setOpen(true);
                }}
            >
                <svg aria-hidden="true" width="20" height="20">
                    <use href={`${icons}#robot`} />
                </svg>
            </button>
            <Sheet
                open={open}
                onOpenChange={setOpen}
                title={tx("Test Agent")}
                size={wide ? "full" : "third"}
                headerAction={
                    <>
                        <button
                            type="button"
                            className="vq-sheet-size-toggle"
                            aria-label={wide ? tx("One third width") : tx("Full width")}
                            title={wide ? tx("One third width") : tx("Full width")}
                            onClick={() => setWide((value) => !value)}
                        >
                            <svg aria-hidden="true" width="16" height="16">
                                <use href={`${icons}#${wide ? "minimize" : "maximize"}`} />
                            </svg>
                        </button>
                        {workspace && (
                            <AgentModelControls
                                workspace={workspace}
                                owner={user.id}
                                adapter={adapters.agent}
                                providers={adapters.providers}
                                signal={signal}
                            />
                        )}
                    </>
                }
            >
                <WorkspaceStatus />
                {workspace && (
                    <AgentWorkspaceView
                        key={`${user.id}/${workspace.id}`}
                        workspace={workspace}
                        owner={user.id}
                        ownerName={user.displayName}
                        adapter={adapters.agent}
                        providers={adapters.providers}
                        reports={adapters.reports}
                        parentSignal={signal}
                        wide={wide}
                        navigate={(runId) => (
                            <Link to={`/reports?workspaceId=${workspace.id}&runId=${runId}`}>
                                {tx("Open full report")}
                            </Link>
                        )}
                    />
                )}
            </Sheet>
        </>
    );
}
