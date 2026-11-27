/**
 * 顶栏 Test Agent 入口：以机器人图标按钮触发右侧抽屉，承载与桌面共享的对话视图，替代原先侧栏菜单入口。
 * 进入抽屉不会自动创建会话或请求模型；当前未选择工作区时仅展示目录状态提示。
 */
import { useContext, useEffect, useMemo, useRef, useState } from "react";
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
import { WebAgentFormHost } from "./WebAgentFormHost";
import { AgentWorkspaceView } from "./AgentWorkspaceView";
import { AgentModelControls } from "./ModelSettings";
import type { AgentNotificationTarget } from "../notifications/model";
import { acknowledgeAgentReply } from "../notifications/transport";

/**
 * 顶栏只控制对话抽屉的开关，抽屉当前的全宽状态直接决定正文使用会话侧栏还是紧凑选择器，无需同步两份宽度状态。
 */
export function AgentSheet({ target, clearTarget }: { target?: AgentNotificationTarget; clearTarget?: () => void }) {
    useAppLocale();
    const { user } = useContext(Auth);
    const { workspace } = useWorkspaceDirectory();
    const { selected, signal } = useWorkspace();
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const activeWorkspace = !target || workspace?.id === target.workspaceId ? workspace : undefined;
    useEffect(() => {
        if (target) setOpen(true);
    }, [target]);
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
                ref={trigger}
                className="vq-workspace-icon"
                aria-label={tx("Test Agent")}
                title={tx("Test Agent")}
                onClick={() => setOpen(true)}
            >
                <svg aria-hidden="true" width="20" height="20">
                    <use href={`${icons}#robot`} />
                </svg>
            </button>
            <Sheet
                open={open}
                onOpenChange={(value) => {
                    setOpen(value);
                    if (!value) clearTarget?.();
                }}
                title={tx("Test Agent")}
                size="third"
                resizable
                fallbackFocus={trigger}
                headerAction={
                    activeWorkspace && (
                        <AgentModelControls
                            workspace={activeWorkspace}
                            owner={user.id}
                            adapter={adapters.agent}
                            providers={adapters.providers}
                            signal={signal}
                        />
                    )
                }
            >
                {(wide) => (
                    <>
                        <WorkspaceStatus />
                        {activeWorkspace && (
                            <WebAgentFormHost
                                key={`${user.id}/${activeWorkspace.id}`}
                                workspaceId={activeWorkspace.id}
                                signal={signal}
                            >
                                {(launcher) => (
                                    <AgentWorkspaceView
                                        workspace={activeWorkspace}
                                        owner={user.id}
                                        ownerName={user.displayName}
                                        adapter={adapters.agent}
                                        providers={adapters.providers}
                                        reports={adapters.reports}
                                        parentSignal={signal}
                                        target={target}
                                        onReplyVisible={acknowledgeAgentReply}
                                        wide={wide}
                                        formLauncher={launcher}
                                        navigate={(runId) => (
                                            <Link to={`/reports?workspaceId=${activeWorkspace.id}&runId=${runId}`}>
                                                {tx("Open full report")}
                                            </Link>
                                        )}
                                    />
                                )}
                            </WebAgentFormHost>
                        )}
                    </>
                )}
            </Sheet>
        </>
    );
}
