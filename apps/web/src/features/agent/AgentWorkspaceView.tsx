/**
 * Web 和 Electron 都使用同一工作区会话视图，当前员工的会话列表和模型状态与独立运行报告共享已有服务端授权。
 */
import { useCallback, useMemo, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { tx, useAppLocale } from "../../locale";
import type { Workspace } from "../../api";
import type { AiAdapter } from "../ai/adapters";
import type { ReportAdapter } from "../reports/adapters";
import { agentErrorCode, agentWorkspaceReadDenied, observeAgentRead, type AgentSchemas } from "./adapters";
import type { CloudAgentAdapter } from "./adapters";
import { AgentError } from "./feedback";
import { Conversation } from "./Conversation";
import { useAgentLifetime } from "./lifetime";
import { ModelSettings } from "./ModelSettings";
import type { ReportNavigation } from "./RunCard";
import "./agent.css";

/**
 * 私有列表页沿用服务器条目与签名游标，活动及归档各有缓存，重取授权时用新第一页替换当前筛选。
 */
type SessionPage = AgentSchemas["AgentSessionDTOPageEnvelope"]["data"];

/**
 * 工作区视图边界属于当前员工、空间及服务端源。未完成严格模式重放设置之前不发起依赖工作区信号的查询。
 */
export function AgentWorkspaceView(props: WorkspaceProps) {
    useAppLocale();
    return <WorkspaceMount {...props} key={JSON.stringify([props.owner, props.workspace.id])} />;
}

function WorkspaceMount({ parentSignal, ...props }: WorkspaceProps) {
    const signal = useAgentLifetime(parentSignal);
    return signal ? <WorkspaceReadBoundary {...props} signal={signal} /> : <p role="status">{tx("Loading VeriQ…")}</p>;
}

/**
 * 对话入口必须提供当前真实工作区及现有在线传输。父级可额外提供工作区切换信号和仅用于草稿的计划定位。
 */
interface WorkspaceProps {
    workspace: Workspace;
    owner: string;
    adapter: CloudAgentAdapter;
    providers: Pick<AiAdapter, "providers">;
    reports: Pick<ReportAdapter, "report" | "subscribe">;
    parentSignal?: AbortSignal;
    navigate: ReportNavigation;
    initialPlanId?: string;
}

/**
 * 已挂载的工作区收到有效信号，授权读取、显式恢复和离开工作区时的所有子请求都受该信号约束。
 */
interface WorkspaceScope extends Omit<WorkspaceProps, "parentSignal"> {
    signal: AbortSignal;
}

/**
 * 选中代次保留标识和草稿，控制器主动结束本次选择，合成信号供线程与工作区共同取消在途请求。
 */
interface SelectedSession {
    id: string;
    initialMessage: string;
    controller: AbortController;
    signal: AbortSignal;
}

// 新授权列表以第一页及其游标重新建立分页缓存，不接续任何已失效界面的分页位置或列表内容。
function firstSessionPage(page: SessionPage): InfiniteData<SessionPage> {
    return { pages: [page], pageParams: [undefined] };
}

// 工作区级拒绝收拢当前对话视图及其全部子请求，除非显式重试取得新列表，否则不创建新的有效代次。
function WorkspaceReadBoundary({ signal: parent, ...props }: WorkspaceScope) {
    const cache = useQueryClient();
    const { adapter, owner, workspace } = props;
    const key = useMemo(() => ["workspace", workspace.id, "agent", owner], [workspace.id, owner]);
    const [controller, setController] = useState(() => new AbortController());
    const signal = useMemo(() => AbortSignal.any([parent, controller.signal]), [parent, controller]);
    const [denied, setDenied] = useState<unknown>();
    const [retryError, setRetryError] = useState<unknown>();
    const [retrying, setRetrying] = useState(false);
    const recovery = useRef(false);

    const onWorkspaceReadDenied = useCallback(
        (failure: unknown) => {
            if (signal.aborted || !agentWorkspaceReadDenied(failure)) {
                return;
            }
            // 先同步终止拥有旧内容的所有操作，再丢弃该身份在此空间的缓存，阻止迟到的结果再次填充。
            controller.abort();
            cache.removeQueries({ queryKey: key });
            setDenied(failure);
        },
        [cache, controller, key, signal],
    );

    async function retry() {
        if (recovery.current || parent.aborted) {
            return;
        }
        recovery.current = true;
        setRetrying(true);
        setRetryError(undefined);
        const next = new AbortController();
        const attempt = AbortSignal.any([parent, next.signal]);
        try {
            const page = await adapter.sessions(false, undefined, attempt);
            attempt.throwIfAborted();
            cache.setQueryData([...key, "sessions", false], firstSessionPage(page));
            setController(next);
            setDenied(undefined);
        } catch (failure) {
            if (!attempt.aborted) {
                setRetryError(failure);
            }
        } finally {
            recovery.current = false;
            if (!parent.aborted) {
                setRetrying(false);
            }
        }
    }

    if (denied) {
        return (
            <div className="vq-agent">
                <AgentError error={retryError ?? denied} retry={retrying ? undefined : () => void retry()} />
                {retrying && <p role="status">{tx("Loading VeriQ…")}</p>}
            </div>
        );
    }
    return <WorkspaceConversation {...props} signal={signal} onWorkspaceReadDenied={onWorkspaceReadDenied} />;
}

/**
 * 子视图将读取拒绝交给管理缓存和生命周期的边界，在现有工作区授权内管理列表筛选和线程选择。
 */
interface WorkspaceConversationProps extends WorkspaceScope {
    onWorkspaceReadDenied: (error: unknown) => void;
}

// 私有会话拒绝只移除这一行，刷新和增量分页仍保留同一工作区内其他已经取得授权的会话。
function withoutDeniedSessions(page: SessionPage, denied: ReadonlySet<string>): SessionPage {
    if (denied.size === 0) {
        return page;
    }
    return { ...page, items: page.items.filter((session) => !denied.has(session.id)) };
}

// 工作区列表、模型设置及当前会话共用这一代有效信号，选中会话变化仍由线程自己的挂载边界取消旧请求。
function WorkspaceConversation({
    workspace,
    owner,
    adapter,
    providers,
    reports,
    signal,
    navigate,
    initialPlanId,
    onWorkspaceReadDenied,
}: WorkspaceConversationProps) {
    const [archived, setArchived] = useState(false);
    const [selected, setSelected] = useState<SelectedSession>();
    const [title, setTitle] = useState("");
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<unknown>();
    const [sessionDenial, setSessionDenial] = useState<unknown>();
    const ignoredSessions = useRef(new Set<string>());
    const retryingSessions = useRef(false);
    const creation = useRef(false);
    const activeSelection = useRef<AbortController>();
    const remainingPlan = useRef(initialPlanId);
    const cache = useQueryClient();
    const key = ["workspace", workspace.id, "agent", owner, "sessions"];
    const listKey = [...key, archived];
    const sessions = useInfiniteQuery({
        queryKey: listKey,
        queryFn: async ({ pageParam, signal: request }) => {
            const active = AbortSignal.any([signal, request]);
            const page = await observeAgentRead(
                adapter.sessions(archived, pageParam, active),
                active,
                onWorkspaceReadDenied,
            );
            return withoutDeniedSessions(page, ignoredSessions.current);
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });
    const rows =
        sessions.data?.pages.flatMap((page) => withoutDeniedSessions(page, ignoredSessions.current).items) ?? [];

    function choose(id?: string, initialMessage = "") {
        activeSelection.current?.abort();
        if (!id) {
            activeSelection.current = undefined;
            setSelected(undefined);
            return;
        }
        const controller = new AbortController();
        activeSelection.current = controller;
        setSelected({ id, initialMessage, controller, signal: AbortSignal.any([signal, controller.signal]) });
    }

    // 线程级拒绝立即停止该选中代次的读写和报告，留存其他会话的查询数据与仍获授权的共享报告。
    function onConversationReadDenied(selection: SelectedSession, failure: unknown) {
        if (signal.aborted || selection.controller.signal.aborted) {
            return;
        }
        if (agentErrorCode(failure) !== "AGENT_SESSION_NOT_FOUND") {
            onWorkspaceReadDenied(failure);
            return;
        }
        choose();
        ignoredSessions.current.add(selection.id);
        cache.removeQueries({ queryKey: ["workspace", workspace.id, "agent", owner, "session", selection.id] });
        // 先结束在途列表分页，再清理旧行，避免观察者离开时恢复查询开始前仍含私有标题的缓存快照。
        void cache.cancelQueries({ queryKey: key });
        cache.setQueriesData<InfiniteData<SessionPage>>(
            { queryKey: key },
            (data) =>
                data && {
                    ...data,
                    pages: data.pages.map((page) => withoutDeniedSessions(page, ignoredSessions.current)),
                },
        );
        if (!sessions.data) {
            void sessions.refetch();
        }
        setSessionDenial(failure);
    }

    // 显式重取当前筛选的授权列表，完成前继续隐藏已拒绝的会话，返回后仍由用户自行选择会话。
    async function retrySessions() {
        if (retryingSessions.current || signal.aborted) {
            return;
        }
        retryingSessions.current = true;
        const recovering = new Set(ignoredSessions.current);
        try {
            const page = await observeAgentRead(
                adapter.sessions(archived, undefined, signal),
                signal,
                onWorkspaceReadDenied,
            );
            await cache.cancelQueries({ queryKey: listKey, exact: true });
            signal.throwIfAborted();
            for (const id of recovering) {
                ignoredSessions.current.delete(id);
            }
            cache.setQueryData(listKey, firstSessionPage(withoutDeniedSessions(page, ignoredSessions.current)));
            if (ignoredSessions.current.size === 0) {
                setSessionDenial(undefined);
            }
        } catch (failure) {
            if (!signal.aborted) {
                setSessionDenial(failure);
            }
        } finally {
            retryingSessions.current = false;
        }
    }

    // 当前筛选与选中会话一同切换，归档和活动列表的签名游标不能互换，也不会复用上一会话的编辑正文。
    function filter(next: boolean) {
        if (next === archived) return;
        setArchived(next);
        choose();
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
            choose(session.id, planId ? tx("Discuss changes to execution plan {{planId}}.", { planId }) : "");
            setTitle("");
            setArchived(false);
            void cache.invalidateQueries({ queryKey: key });
        } catch (failure) {
            if (!signal.aborted) {
                if (agentErrorCode(failure) === "AUTHENTICATION_REQUIRED") {
                    onWorkspaceReadDenied(failure);
                } else {
                    setError(failure);
                    if (agentWorkspaceReadDenied(failure)) {
                        void sessions.refetch();
                    }
                }
            }
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
                onWorkspaceReadDenied={onWorkspaceReadDenied}
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
                    <AgentError error={sessionDenial} retry={() => void retrySessions()} />
                    <ul>
                        {rows.map((item) => (
                            <li key={item.id}>
                                <button
                                    type="button"
                                    aria-pressed={selected?.id === item.id}
                                    onClick={() => {
                                        if (selected?.id !== item.id) {
                                            choose(item.id);
                                        }
                                    }}
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
                        key={selected.id}
                        workspace={workspace}
                        owner={owner}
                        sessionId={selected.id}
                        initialMessage={selected.initialMessage}
                        adapter={adapter}
                        reports={reports}
                        parentSignal={selected.signal}
                        navigate={navigate}
                        onReadDenied={(failure) => onConversationReadDenied(selected, failure)}
                        onWorkspaceReadDenied={onWorkspaceReadDenied}
                        onArchived={() => {
                            choose();
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
