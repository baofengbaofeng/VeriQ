/**
 * Web 入口验证链接指定的工作区，并提供与桌面共享的在线会话视图。页面加载链接不会自动创建会话或请求模型。
 */
import { useContext, useEffect, useMemo } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { Auth } from "../../auth-context";
import { tx, useAppLocale } from "../../locale";
import { Panel } from "../../ui";
import { CloudAiAdapter } from "../ai/adapters";
import { CloudReportAdapter } from "../reports/adapters";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { CloudAgentAdapter } from "./adapters";
import { AgentWorkspaceView } from "./AgentWorkspaceView";
import { AgentError } from "./feedback";

const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 只在确定目标空间的员工成员权限后打开对话。手动切换会清空链接中的计划标识，并取消先前空间所有对话请求。
 */
export function AgentPage() {
    useAppLocale();
    const { user } = useContext(Auth);
    const { selected, select, signal } = useWorkspace();
    const [parameters, setParameters] = useSearchParams();
    const workspaceId = parameters.get("workspaceId") ?? "";
    const planId = parameters.get("planId") ?? "";
    const requested = isId.test(workspaceId) ? workspaceId.toLowerCase() : "";
    const initialPlan = isId.test(planId) ? planId.toLowerCase() : undefined;
    const workspaces = useInfiniteQuery({
        queryKey: ["workspaces", user?.id],
        queryFn: ({ pageParam, signal: request }) => api.workspaces(pageParam, request),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        enabled: !!user,
    });
    const list = workspaces.data?.pages.flatMap((page) => page.items) ?? [];
    // 深链接可能指向尚未分页加载的空间，单独查询保证链接按当前成员权限校验，不依赖列表顺序。
    const target = useQuery({
        queryKey: ["agent-workspace-target", user?.id, requested],
        queryFn: ({ signal: request }) => api.workspace(requested, request),
        enabled: !!user && !!requested && !list.some((item) => item.id === requested),
    });
    const available = list.some((item) => item.id === requested) ? requested : target.data?.id;
    const first = list[0]?.id;
    useEffect(() => {
        if (available) select(available);
    }, [available, select]);
    useEffect(() => {
        if (!selected && !available && first && (!requested || target.isError)) select(first);
    }, [available, selected, first, requested, select, target.isError]);

    const spaces = target.data && !list.some((item) => item.id === target.data?.id) ? [...list, target.data] : list;
    const workspace = spaces.find((item) => item.id === selected);
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
            <label>
                {tx("Agent Workspace")}
                <select
                    value={selected}
                    onChange={(event) => {
                        const next = event.target.value;
                        select(next);
                        setParameters({ workspaceId: next }, { replace: true });
                    }}
                >
                    <option value="" disabled>
                        {tx("Workspace")}
                    </option>
                    {spaces.map((item) => (
                        <option key={item.id} value={item.id}>
                            {item.name}
                        </option>
                    ))}
                </select>
            </label>
            {(workspaces.isPending || (requested && !available && target.isFetching)) && (
                <p role="status">{tx("Loading Workspaces…")}</p>
            )}
            <AgentError error={target.error} retry={() => void target.refetch()} />
            <AgentError error={workspaces.error} retry={() => void workspaces.refetch()} />
            {workspaces.isSuccess && !spaces.length && <p>{tx("No Workspaces yet.")}</p>}
            {workspaces.hasNextPage && (
                <button
                    type="button"
                    disabled={workspaces.isFetchingNextPage}
                    onClick={() => void workspaces.fetchNextPage()}
                >
                    {tx("More workspaces")}
                </button>
            )}
            {workspace && (!requested || workspace.id === available || target.isError) && (
                <AgentWorkspaceView
                    key={`${user.id}/${workspace.id}/${selected === requested ? (initialPlan ?? "") : ""}`}
                    workspace={workspace}
                    owner={user.id}
                    adapter={adapters.agent}
                    providers={adapters.providers}
                    reports={adapters.reports}
                    parentSignal={signal}
                    initialPlanId={selected === requested && selected === available ? initialPlan : undefined}
                    navigate={(runId) => (
                        <Link to={`/reports?workspaceId=${workspace.id}&runId=${runId}`}>{tx("Open full report")}</Link>
                    )}
                />
            )}
        </Panel>
    );
}
