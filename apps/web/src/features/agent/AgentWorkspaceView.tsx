/**
 * Web 和 Electron 都使用同一工作区会话视图，当前员工的会话列表和模型状态与独立运行报告共享已有服务端授权。
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { tx, useAppLocale } from "../../locale";
import type { Workspace } from "../../api";
import type { AiAdapter } from "../ai/adapters";
import type { ReportAdapter } from "../reports/adapters";
import type { AgentSchemas, CloudAgentAdapter } from "./adapters";
import { AgentError } from "./feedback";
import { Conversation } from "./Conversation";
import { ModelSettings } from "./ModelSettings";
import type { ReportNavigation } from "./RunCard";
import "./agent.css";

type Session = AgentSchemas["AgentSessionDTO"];

/**
 * 调用方用员工和工作区作为组件身份，桌面额外绑定平台源。离开 Agent 会关闭当前视图请求，已提交操作由服务端继续结算。
 */
export function AgentWorkspaceView({
    workspace,
    owner,
    adapter,
    providers,
    reports,
    parentSignal,
    navigate,
    initialPlanId,
}: {
    workspace: Workspace;
    owner: string;
    adapter: CloudAgentAdapter;
    providers: Pick<AiAdapter, "providers">;
    reports: Pick<ReportAdapter, "report" | "subscribe">;
    parentSignal?: AbortSignal;
    navigate: ReportNavigation;
    initialPlanId?: string;
}) {
    useAppLocale();
    const [lifetime] = useState(() => new AbortController());
    const signal = useMemo(
        () => (parentSignal ? AbortSignal.any([parentSignal, lifetime.signal]) : lifetime.signal),
        [parentSignal, lifetime],
    );
    useEffect(() => () => lifetime.abort(), [lifetime]);

    const [archived, setArchived] = useState(false);
    const [selected, setSelected] = useState<{ session: Session; initialMessage: string }>();
    const [title, setTitle] = useState("");
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<unknown>();
    const creation = useRef(false);
    const remainingPlan = useRef(initialPlanId);
    const cache = useQueryClient();
    const key = ["workspace", workspace.id, "agent", owner, "sessions"];
    const sessions = useInfiniteQuery({
        queryKey: [...key, archived],
        queryFn: ({ pageParam, signal: request }) =>
            adapter.sessions(archived, pageParam, AbortSignal.any([signal, request])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });
    const rows = sessions.data?.pages.flatMap((page) => page.items) ?? [];

    // 当前筛选与选中会话一同切换，归档和活动列表的签名游标不能互换，也不会复用上一会话的编辑正文。
    function filter(next: boolean) {
        if (next === archived) return;
        setArchived(next);
        setSelected(undefined);
    }

    // 从计划页传入的标识只用于本工作区第一个新会话的可编辑草稿，页面不主动发出模型请求。
    async function create(event: FormEvent) {
        event.preventDefault();
        if (creation.current || workspace.archived || signal.aborted) return;
        creation.current = true;
        setCreating(true);
        setError(undefined);
        try {
            const session = await adapter.createSession(title.trim() ? { title } : {}, signal);
            signal.throwIfAborted();
            const planId = remainingPlan.current;
            remainingPlan.current = undefined;
            setSelected({
                session,
                initialMessage: planId ? tx("Discuss changes to execution plan {{planId}}.", { planId }) : "",
            });
            setTitle("");
            setArchived(false);
            void cache.invalidateQueries({ queryKey: key });
        } catch (failure) {
            if (!signal.aborted) setError(failure);
        } finally {
            creation.current = false;
            if (!signal.aborted) setCreating(false);
        }
    }

    return (
        <div className="vq-agent">
            <ModelSettings
                workspace={workspace}
                owner={owner}
                adapter={adapter}
                providers={providers}
                signal={signal}
            />
            <div className="vq-agent-columns">
                <aside className="vq-agent-sessions" aria-label={tx("Conversations")}>
                    <h3>{tx("Conversations")}</h3>
                    <div className="vq-agent-toolbar">
                        <button type="button" aria-pressed={!archived} onClick={() => filter(false)}>
                            {tx("Active")}
                        </button>
                        <button type="button" aria-pressed={archived} onClick={() => filter(true)}>
                            {tx("Archived")}
                        </button>
                    </div>
                    {sessions.isPending && <p role="status">{tx("Loading VeriQ…")}</p>}
                    {sessions.isSuccess && !rows.length && <p>{tx("No conversations in this list.")}</p>}
                    <AgentError error={sessions.error} retry={() => void sessions.refetch()} />
                    <ul>
                        {rows.map((item) => (
                            <li key={item.id}>
                                <button
                                    type="button"
                                    aria-pressed={selected?.session.id === item.id}
                                    onClick={() => setSelected({ session: item, initialMessage: "" })}
                                >
                                    {item.title}
                                </button>
                            </li>
                        ))}
                    </ul>
                    {sessions.hasNextPage && (
                        <button
                            type="button"
                            disabled={sessions.isFetchingNextPage}
                            onClick={() => void sessions.fetchNextPage()}
                        >
                            {tx("More conversations")}
                        </button>
                    )}
                    {!workspace.archived && (
                        <form onSubmit={(event) => void create(event)}>
                            <label>
                                {tx("Conversation title")}
                                <input
                                    value={title}
                                    maxLength={160}
                                    disabled={creating}
                                    onChange={(event) => setTitle(event.target.value)}
                                />
                            </label>
                            <button type="submit" disabled={creating}>
                                {tx("New conversation")}
                            </button>
                        </form>
                    )}
                    <AgentError error={error} />
                </aside>
                {selected ? (
                    <Conversation
                        key={selected.session.id}
                        workspace={workspace}
                        owner={owner}
                        initial={selected.session}
                        initialMessage={selected.initialMessage}
                        adapter={adapter}
                        reports={reports}
                        parentSignal={signal}
                        navigate={navigate}
                        onArchived={() => {
                            setSelected(undefined);
                            void cache.invalidateQueries({ queryKey: key });
                        }}
                    />
                ) : (
                    <p className="vq-agent-empty">{tx("Choose or create a conversation.")}</p>
                )}
            </div>
        </div>
    );
}
