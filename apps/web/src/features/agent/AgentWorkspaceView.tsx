/**
 * Web 和 Electron 都使用同一工作区会话视图，当前员工的会话列表和模型状态与独立运行报告共享已有服务端授权。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { tx, useAppLocale } from "../../locale";
import icons from "../../admin-icons.svg?no-inline";
import type { Workspace } from "../../api";
import type { AiAdapter } from "../ai/adapters";
import type { FormLauncher } from "./workspace-forms";
import type { ReportAdapter } from "../reports/adapters";
import { agentErrorCode, agentWorkspaceReadDenied, observeAgentRead, type AgentSchemas } from "./adapters";
import type { CloudAgentAdapter } from "./adapters";
import { AgentError, agentOperationError } from "./feedback";
import { useOperationFeedback } from "../../operation-feedback";
import { Conversation } from "./Conversation";
import { useRequestLifetime } from "../../request-lifetime";
import { useAgentSettings } from "./ModelSettings";
import type { ReportNavigation } from "./RunCard";
import "./agent.css";
import type { AgentNotificationTarget } from "../notifications/model";

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
    const signal = useRequestLifetime(parentSignal)?.signal;
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
    formLauncher?: FormLauncher;
    initialPlanId?: string;
    wide?: boolean;
    ownerName?: string;
    target?: AgentNotificationTarget;
    onReplyVisible?: (target: AgentNotificationTarget, signal: AbortSignal) => Promise<void>;
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
    focusTurnId?: string;
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

// 会话列表在一周内依次按分钟、小时和天数显示经过的时间，满一周后改用浏览器本地格式显示日期。
function formatRelativeTime(iso: string): string {
    const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return tx("Now");
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;
    return new Date(iso).toLocaleDateString();
}

// 工作区列表、模型设置及当前会话共用这一代有效信号，选中会话变化仍由线程自己的挂载边界取消旧请求。
function WorkspaceConversation({
    workspace,
    owner,
    adapter,
    reports,
    signal,
    navigate,
    formLauncher,
    initialPlanId,
    onWorkspaceReadDenied,
    wide = false,
    ownerName = "",
    target,
    onReplyVisible,
}: WorkspaceConversationProps) {
    const [search, setSearch] = useState("");
    const [showAllActive, setShowAllActive] = useState(false);
    const [showAllArchived, setShowAllArchived] = useState(false);
    const [selected, setSelected] = useState<SelectedSession>();
    const [creating, setCreating] = useState(false);
    const { showFailure } = useOperationFeedback();
    const [sessionDenial, setSessionDenial] = useState<unknown>();
    const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
    const [renameTitle, setRenameTitle] = useState("");
    const [renamingBusy, setRenamingBusy] = useState(false);
    const ignoredSessions = useRef(new Set<string>());
    const retryingSessions = useRef(false);
    const creation = useRef(false);
    const activeSelection = useRef<AbortController>();
    const remainingPlan = useRef(initialPlanId);
    const cache = useQueryClient();
    const key = ["workspace", workspace.id, "agent", owner, "sessions"];
    const activeSessions = useInfiniteQuery({
        queryKey: [...key, false],
        queryFn: async ({ pageParam, signal: request }) => {
            const active = AbortSignal.any([signal, request]);
            const page = await observeAgentRead(
                adapter.sessions(false, pageParam, active),
                active,
                onWorkspaceReadDenied,
            );
            return withoutDeniedSessions(page, ignoredSessions.current);
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });
    const archivedSessions = useInfiniteQuery({
        queryKey: [...key, true],
        queryFn: async ({ pageParam, signal: request }) => {
            const active = AbortSignal.any([signal, request]);
            const page = await observeAgentRead(
                adapter.sessions(true, pageParam, active),
                active,
                onWorkspaceReadDenied,
            );
            return withoutDeniedSessions(page, ignoredSessions.current);
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });
    const activeRows =
        activeSessions.data?.pages.flatMap((page) => withoutDeniedSessions(page, ignoredSessions.current).items) ?? [];
    const archivedRows =
        archivedSessions.data?.pages.flatMap((page) => withoutDeniedSessions(page, ignoredSessions.current).items) ??
        [];
    const matches = (item: { title: string }) => !search || item.title.toLowerCase().includes(search.toLowerCase());
    const visibleActive = activeRows.filter(matches);
    const visibleArchived = archivedRows.filter(matches);
    const shownActive = showAllActive ? visibleActive : visibleActive.slice(0, 5);
    const shownArchived = showAllArchived ? visibleArchived : visibleArchived.slice(0, 5);
    const { settings } = useAgentSettings(workspace, owner, adapter, signal, onWorkspaceReadDenied);
    const configured = settings.data?.providerStatus !== "UNCONFIGURED";

    const choose = useCallback(
        (id?: string, initialMessage = "", focusTurnId?: string) => {
            activeSelection.current?.abort();
            if (!id) {
                activeSelection.current = undefined;
                setSelected(undefined);
                return;
            }
            const controller = new AbortController();
            activeSelection.current = controller;
            setSelected({
                id,
                initialMessage,
                focusTurnId,
                controller,
                signal: AbortSignal.any([signal, controller.signal]),
            });
        },
        [signal],
    );

    // 通知携带的会话独立于侧栏分页，线程沿用本人的授权详情接口和选择代次，避免为定位而遍历无关会话。
    useEffect(() => {
        if (target?.workspaceId === workspace.id) choose(target.sessionId, "", target.turnId);
    }, [choose, target, workspace.id]);

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
        if (!activeSessions.data) void activeSessions.refetch();
        if (!archivedSessions.data) void archivedSessions.refetch();
        setSessionDenial(failure);
    }

    // 重试时同时读取活动和归档会话，两个列表均返回后才撤销本次拒绝标记，随后仍由用户自己选择会话。
    async function retrySessions() {
        if (retryingSessions.current || signal.aborted) {
            return;
        }
        retryingSessions.current = true;
        const recovering = new Set(ignoredSessions.current);
        try {
            const [activePage, archivedPage] = await Promise.all([
                observeAgentRead(adapter.sessions(false, undefined, signal), signal, onWorkspaceReadDenied),
                observeAgentRead(adapter.sessions(true, undefined, signal), signal, onWorkspaceReadDenied),
            ]);
            await cache.cancelQueries({ queryKey: key });
            signal.throwIfAborted();
            for (const id of recovering) {
                ignoredSessions.current.delete(id);
            }
            cache.setQueryData(
                [...key, false],
                firstSessionPage(withoutDeniedSessions(activePage, ignoredSessions.current)),
            );
            cache.setQueryData(
                [...key, true],
                firstSessionPage(withoutDeniedSessions(archivedPage, ignoredSessions.current)),
            );
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

    // 新会话不再要求用户填标题，由服务端生成默认名称；计划页传入的标识只用于本工作区第一个新会话的可编辑草稿。
    async function createNew() {
        if (creation.current || workspace.archived || signal.aborted) return;
        creation.current = true;
        setCreating(true);
        try {
            const session = await adapter.createSession({}, signal);
            signal.throwIfAborted();
            const planId = remainingPlan.current;
            remainingPlan.current = undefined;
            choose(session.id, planId ? tx("Discuss changes to execution plan {{planId}}.", { planId }) : "");
            void cache.invalidateQueries({ queryKey: key });
        } catch (failure) {
            if (!signal.aborted) {
                if (agentErrorCode(failure) === "AUTHENTICATION_REQUIRED") {
                    onWorkspaceReadDenied(failure);
                } else {
                    showFailure(agentOperationError(failure));
                    if (agentWorkspaceReadDenied(failure)) {
                        void activeSessions.refetch();
                        void archivedSessions.refetch();
                    }
                }
            }
        } finally {
            creation.current = false;
            if (!signal.aborted) setCreating(false);
        }
    }

    function openRename(id: string, title: string) {
        setRenaming({ id, title });
        setRenameTitle(title);
    }

    async function rename() {
        if (!renaming || renamingBusy || signal.aborted) return;
        const next = renameTitle.trim();
        if (!next) return;
        setRenamingBusy(true);
        try {
            await adapter.renameSession(renaming.id, { title: next }, signal);
            signal.throwIfAborted();
            await cache.invalidateQueries({ queryKey: key });
            setRenaming(null);
        } catch (failure) {
            if (!signal.aborted) showFailure(agentOperationError(failure));
        } finally {
            if (!signal.aborted) setRenamingBusy(false);
        }
    }

    async function archiveSession(sessionId: string) {
        if (signal.aborted) return;
        try {
            await adapter.archive(sessionId, signal);
            signal.throwIfAborted();
            if (selected?.id === sessionId) choose();
            void cache.invalidateQueries({ queryKey: key });
        } catch (failure) {
            if (!signal.aborted) showFailure(agentOperationError(failure));
        }
    }

    const conversation = selected ? (
        <Conversation
            key={selected.id}
            workspace={workspace}
            owner={owner}
            ownerName={ownerName}
            supportsImages={settings.data?.supportsImages === true}
            sessionId={selected.id}
            initialMessage={selected.initialMessage}
            focusTurnId={selected.focusTurnId}
            onReplyVisible={onReplyVisible}
            adapter={adapter}
            reports={reports}
            parentSignal={selected.signal}
            navigate={navigate}
            formLauncher={formLauncher}
            onReadDenied={(failure) => onConversationReadDenied(selected, failure)}
            onWorkspaceReadDenied={onWorkspaceReadDenied}
            onArchived={() => {
                choose();
                void cache.invalidateQueries({ queryKey: key });
            }}
        />
    ) : (
        <p className="vq-agent-empty">{tx("Choose or create a conversation.")}</p>
    );

    const renameButton = (id: string, title: string) => (
        <button
            type="button"
            className="vq-agent-rename"
            aria-label={tx("Rename conversation")}
            onClick={() => openRename(id, title)}
        >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24">
                <use href={`${icons}#edit`} />
            </svg>
        </button>
    );

    const sessionRow = (item: AgentSchemas["AgentSessionDTO"], canArchive: boolean) => (
        <li
            key={item.id}
            className="vq-agent-session-row"
            data-selected={selected?.id === item.id ? "true" : undefined}
        >
            <button
                type="button"
                className="vq-agent-session"
                aria-pressed={selected?.id === item.id}
                onClick={() => {
                    if (selected?.id !== item.id) choose(item.id);
                }}
            >
                <span className="vq-agent-session-title">{item.title}</span>
                <span className="vq-agent-session-time">{formatRelativeTime(item.createdAt)}</span>
            </button>
            <DropdownMenu.Root>
                <DropdownMenu.Trigger className="vq-agent-session-menu" aria-label={tx("More options")}>
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <use href={`${icons}#horizontal-dots`} />
                    </svg>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                    <DropdownMenu.Content className="vq-dropdown" align="end" sideOffset={4} collisionPadding={8}>
                        <DropdownMenu.Item
                            className="vq-dropdown-item"
                            onSelect={() => openRename(item.id, item.title)}
                        >
                            {tx("Rename conversation")}
                        </DropdownMenu.Item>
                        {canArchive && (
                            <DropdownMenu.Item
                                className="vq-dropdown-item"
                                onSelect={() => void archiveSession(item.id)}
                            >
                                {tx("Archive conversation")}
                            </DropdownMenu.Item>
                        )}
                    </DropdownMenu.Content>
                </DropdownMenu.Portal>
            </DropdownMenu.Root>
        </li>
    );

    const selectedTitle = selected
        ? ((activeRows.find((item) => item.id === selected.id) ?? archivedRows.find((item) => item.id === selected.id))
              ?.title ?? "")
        : "";

    return (
        <div className="vq-agent">
            {!configured ? (
                <p className="vq-agent-empty">{tx("No model configured yet")}</p>
            ) : wide ? (
                <div className="vq-agent-columns">
                    <aside className="vq-agent-sessions" aria-label={tx("Conversations")}>
                        {!workspace.archived && (
                            <button
                                type="button"
                                className="vq-agent-new-chat"
                                disabled={creating}
                                onClick={() => void createNew()}
                            >
                                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
                                    <path
                                        d="M12 5v14M5 12h14"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                    />
                                </svg>
                                {tx("New conversation")}
                            </button>
                        )}
                        <div className="vq-agent-search">
                            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                                <path
                                    d="m10.5 10.5 3 3"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                />
                            </svg>
                            <input
                                type="search"
                                placeholder={tx("Search conversations")}
                                value={search}
                                maxLength={254}
                                onChange={(event) => setSearch(event.target.value)}
                            />
                        </div>
                        <AgentError
                            error={activeSessions.error ?? archivedSessions.error}
                            retry={() => void retrySessions()}
                        />
                        <AgentError error={sessionDenial} retry={() => void retrySessions()} />

                        <section className="vq-agent-session-group">
                            <h4>{tx("Active")}</h4>
                            {activeSessions.isPending && <p role="status">{tx("Loading VeriQ…")}</p>}
                            {!activeSessions.isPending && visibleActive.length === 0 && (
                                <p>{tx("No conversations in this list.")}</p>
                            )}
                            <ul>{shownActive.map((item) => sessionRow(item, true))}</ul>
                            {(visibleActive.length > 5 || activeSessions.hasNextPage) && (
                                <button
                                    type="button"
                                    className="vq-agent-show-toggle"
                                    onClick={() => {
                                        setShowAllActive(!showAllActive);
                                        if (!showAllActive && activeSessions.hasNextPage) {
                                            void activeSessions.fetchNextPage();
                                        }
                                    }}
                                >
                                    <span>{showAllActive ? tx("Show less") : tx("Show more")}</span>
                                    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none">
                                        <path
                                            d={showAllActive ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"}
                                            stroke="currentColor"
                                            strokeWidth="1.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                    </svg>
                                </button>
                            )}
                        </section>

                        <section className="vq-agent-session-group">
                            <h4>{tx("Archived")}</h4>
                            {archivedSessions.isPending && <p role="status">{tx("Loading VeriQ…")}</p>}
                            {!archivedSessions.isPending && visibleArchived.length === 0 && (
                                <p>{tx("No conversations in this list.")}</p>
                            )}
                            <ul>{shownArchived.map((item) => sessionRow(item, false))}</ul>
                            {(visibleArchived.length > 5 || archivedSessions.hasNextPage) && (
                                <button
                                    type="button"
                                    className="vq-agent-show-toggle"
                                    onClick={() => {
                                        setShowAllArchived(!showAllArchived);
                                        if (!showAllArchived && archivedSessions.hasNextPage) {
                                            void archivedSessions.fetchNextPage();
                                        }
                                    }}
                                >
                                    <span>{showAllArchived ? tx("Show less") : tx("Show more")}</span>
                                    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none">
                                        <path
                                            d={showAllArchived ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"}
                                            stroke="currentColor"
                                            strokeWidth="1.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                    </svg>
                                </button>
                            )}
                        </section>
                    </aside>
                    {conversation}
                </div>
            ) : (
                <>
                    <div className="vq-agent-session-picker">
                        <DropdownMenu.Root>
                            <DropdownMenu.Trigger className="vq-filter-button vq-agent-session-trigger">
                                <span className="vq-agent-session-label">
                                    {selectedTitle || tx("Choose a conversation")}
                                </span>
                                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
                                    <path
                                        d="m3 4.5 3 3 3-3"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    />
                                </svg>
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Portal>
                                <DropdownMenu.Content
                                    className="vq-dropdown"
                                    align="start"
                                    sideOffset={4}
                                    collisionPadding={8}
                                >
                                    <DropdownMenu.RadioGroup
                                        value={selected?.id ?? ""}
                                        onValueChange={(value) => choose(value || undefined)}
                                    >
                                        {activeRows.map((item) => (
                                            <DropdownMenu.RadioItem
                                                key={item.id}
                                                value={item.id}
                                                className="vq-dropdown-item"
                                            >
                                                {item.title}
                                                <DropdownMenu.ItemIndicator className="vq-dropdown-check">
                                                    <svg
                                                        aria-hidden="true"
                                                        width="14"
                                                        height="14"
                                                        viewBox="0 0 14 14"
                                                        fill="none"
                                                    >
                                                        <path
                                                            d="m3 7.5 2.5 2.5L11 4.5"
                                                            stroke="currentColor"
                                                            strokeWidth="1.5"
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                        />
                                                    </svg>
                                                </DropdownMenu.ItemIndicator>
                                            </DropdownMenu.RadioItem>
                                        ))}
                                    </DropdownMenu.RadioGroup>
                                </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                        {selected && renameButton(selected.id, selectedTitle)}
                        {!workspace.archived && (
                            <button
                                type="button"
                                className="vq-agent-new"
                                aria-label={tx("New conversation")}
                                disabled={creating}
                                onClick={() => void createNew()}
                            >
                                +
                            </button>
                        )}
                    </div>
                    {conversation}
                </>
            )}
            <Dialog.Root open={!!renaming} onOpenChange={(open) => !open && setRenaming(null)}>
                <Dialog.Portal>
                    <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                    <Dialog.Content className="vq-dialog vq-workspace-dialog">
                        <div className="vq-card-heading">
                            <Dialog.Title>{tx("Rename conversation")}</Dialog.Title>
                            <Dialog.Close className="vq-sheet-close" aria-label={tx("Close")}>
                                ×
                            </Dialog.Close>
                        </div>
                        <form
                            className="vq-workspace-form"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void rename();
                            }}
                        >
                            <label>
                                {tx("Conversation title")}
                                <input
                                    value={renameTitle}
                                    maxLength={160}
                                    onChange={(event) => setRenameTitle(event.target.value)}
                                />
                            </label>
                            <div className="vq-workspace-form-actions">
                                <Dialog.Close type="button" className="vq-btn-secondary">
                                    {tx("Cancel")}
                                </Dialog.Close>
                                <button
                                    type="submit"
                                    className="vq-btn-primary"
                                    disabled={renamingBusy || !renameTitle.trim()}
                                >
                                    {tx("Save")}
                                </button>
                            </div>
                        </form>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </div>
    );
}
