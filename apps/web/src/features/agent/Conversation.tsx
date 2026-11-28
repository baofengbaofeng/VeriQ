/**
 * 单条会话拥有自己的读写和报告取消边界。先显示服务器记录的轮次顺序，重新读取后以权威状态补齐正在处理的试验。
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { tx } from "../../locale";
import * as Dialog from "@radix-ui/react-dialog";
import icons from "../../admin-icons.svg?no-inline";
import { Avatar } from "../../components";
import { ApiError, type Workspace } from "../../api";
import type { FormLauncher } from "./workspace-forms";
import type { ReportAdapter } from "../reports/adapters";
import { agentErrorCode, observeAgentRead, type AgentSchemas, type CloudAgentAdapter } from "./adapters";
import { useRequestLifetime } from "../../request-lifetime";
import { canExportWorkspaceTable } from "../../table-view";
import { agentSubmission, clearAgentSubmission, pendingAgentConfirmationTarget } from "./retry";
import { AgentError, agentOperationError, agentProblem } from "./feedback";
import { useOperationFeedback } from "../../operation-feedback";
import { Proposal, ActionReceipt } from "./Proposal";
import { CapabilityCard } from "./CapabilityCard";
import { FormReceipts } from "./FormReceipts";
import { RunCard, type ReportNavigation, type RunReference } from "./RunCard";
import { BackgroundTasks, useAgentTasks } from "./BackgroundTasks";
import { Markdown } from "./Markdown";
import { agentConfirmation, canConfirmAgentAction } from "./confirmations";
import { useAgentReplyVisibility } from "./reply-visibility";
import type { AgentNotificationTarget } from "../notifications/model";
import {
    AgentAttachmentList,
    agentAttachmentAccept,
    encodeAgentAttachments,
    stageAgentAttachments,
    type StagedAgentAttachment,
} from "./Attachments";

type Turn = AgentSchemas["AgentTurnDTO"];

// 流式期间的步骤带临时 id 用于按序更新，落库后的 steps 无 id；二者共享工具名、状态、摘要与错误码。
type Step = {
    id?: string;
    name: string;
    status: "RUNNING" | "SUCCEEDED" | "FAILED";
    summary?: string;
    errorCode?: string;
};

const stepStatus = { RUNNING: "Running", SUCCEEDED: "Succeeded", FAILED: "Failed" };
const paperclipPath = "m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3 3 0 0 1 4 4l-8.5 8.5a1 1 0 0 1-1.5-1.5L16 7";

// 同页重开会话时查询缓存可能仍显示旧提议，待审阅的拒绝随重试作用域保留到新提议真正显示。
const supersededTargets = new Map<string, string>();

const sortTurns = (a: Turn, b: Turn) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

// 刷新将服务端记录与刚完成的请求合并：较早的读取不覆盖已确认回执或刚取得的最终轮次。
function mergeTurns(loaded: Turn[], updates: Map<string, Turn>): Turn[] {
    const result = new Map(updates);
    for (const turn of loaded) {
        const local = updates.get(turn.id);
        if ((!local?.receipt || turn.receipt) && (local?.status === "RUNNING" || turn.status !== "RUNNING" || !local))
            result.set(turn.id, turn);
    }
    return [...result.values()].sort(sortTurns);
}

// 正常确认与聊天确认可以引用相同运行，各轮保留自己的业务回执，报告查询按真正的运行标识去重。
function runReferences(turns: Turn[]): RunReference[] {
    const result = new Map<string, RunReference>();
    for (const turn of turns) {
        const receipt = turn.receipt && "runId" in turn.receipt ? turn.receipt : undefined;
        if (turn.relatedRunId && !result.has(turn.relatedRunId))
            result.set(turn.relatedRunId, { id: turn.relatedRunId });
        if (receipt?.type === "TRIGGER_PLAN")
            result.set(receipt.runId, { id: receipt.runId, decision: receipt.decision });
        else if (receipt && !result.has(receipt.runId)) result.set(receipt.runId, { id: receipt.runId });
    }
    return [...result.values()];
}

/**
 * 当前会话只在独立效果为其建立新的存活信号后挂载，任何已卸载会话都只能通过服务端历史恢复结果。
 */
export function Conversation({ parentSignal, ...props }: ConversationProps) {
    const signal = useRequestLifetime(parentSignal)?.signal;
    return signal ? <Thread {...props} signal={signal} /> : <p role="status">{tx("Loading VeriQ…")}</p>;
}

/**
 * 线程输入由授权工作区和选定会话共同限定，时间线、临时输入以及报告属于同一有效渲染代次。
 */
interface ConversationProps {
    workspace: Workspace;
    owner: string;
    sessionId: string;
    initialMessage: string;
    focusTurnId?: string;
    onReplyVisible?: (target: AgentNotificationTarget, signal: AbortSignal) => Promise<void>;
    adapter: CloudAgentAdapter;
    reports: Pick<ReportAdapter, "report" | "subscribe">;
    parentSignal: AbortSignal;
    navigate: ReportNavigation;
    formLauncher?: FormLauncher;
    onReadDenied: (error: unknown) => void;
    onWorkspaceReadDenied: (error: unknown) => void;
    onArchived: () => void;
    supportsImages: boolean;
    ownerName?: string;
}

// 本组件只接收当前挂载拥有的有效信号，角色和归档状态控制入口，服务器负责再次校验全部业务授权。
function Thread({
    workspace,
    owner,
    sessionId: id,
    initialMessage,
    focusTurnId,
    onReplyVisible,
    adapter,
    reports,
    signal,
    navigate,
    formLauncher,
    onReadDenied,
    onWorkspaceReadDenied,
    onArchived,
    supportsImages,
    ownerName = "",
}: Omit<ConversationProps, "parentSignal"> & { signal: AbortSignal }) {
    const [text, setText] = useState(initialMessage);
    const [delegationMode, setDelegationMode] = useState<AgentSchemas["AgentDelegationMode"]>("AUTO");
    const { showFailure } = useOperationFeedback();
    const [attachments, setAttachments] = useState<StagedAgentAttachment[]>([]);
    const [reattach, setReattach] = useState(false);
    const attachmentHelp = useId();
    const [operation, setOperation] = useState<"send" | "confirm" | "archive">();
    const [archiveOpen, setArchiveOpen] = useState(false);
    const [copiedKey, setCopiedKey] = useState("");
    const mutation = useRef(false);
    const recovering = useRef<{ id: string; requestId: string }>();
    const messagesRef = useRef<HTMLDivElement>(null);
    const requestedReply = useRef<HTMLDivElement>(null);
    const revealed = useRef<{ id: string; latest: string }>();
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const [updates, setUpdates] = useState(() => new Map<string, Turn>());
    const [streamText, setStreamText] = useState(() => new Map<string, string>());
    const [thinkingText, setThinkingText] = useState(() => new Map<string, string>());
    const [streamSteps, setStreamSteps] = useState(() => new Map<string, Step[]>());
    const [openThinking, setOpenThinking] = useState(() => new Map<string, boolean>());
    const [completedRuns, setCompletedRuns] = useState(() => new Set<string>());
    const reconcileFormUntil = useRef(0);
    const retryKey = "veriq.agent.retry/" + JSON.stringify([owner, workspace.id, id]);
    const supersededTarget = supersededTargets.get(retryKey);
    const key = ["workspace", workspace.id, "agent", owner, "session", id];
    const cache = useQueryClient();
    const refreshTitles = useCallback(() => {
        if (signal.aborted) return;
        const scope = ["workspace", workspace.id, "agent", owner];
        void cache.invalidateQueries({ queryKey: [...scope, "session", id], exact: true });
        void cache.invalidateQueries({ queryKey: [...scope, "sessions", false], exact: true });
        void cache.invalidateQueries({ queryKey: [...scope, "session", id, "tasks"], exact: true });
    }, [cache, id, owner, signal, workspace.id]);
    const current = useQuery({
        queryKey: key,
        queryFn: ({ signal: request }) => {
            const active = AbortSignal.any([signal, request]);
            return observeAgentRead(adapter.session(id, active), active, onReadDenied);
        },
    });
    const history = useInfiniteQuery({
        queryKey: [...key, "turns"],
        queryFn: ({ pageParam, signal: request }) => {
            const active = AbortSignal.any([signal, request]);
            return observeAgentRead(adapter.turns(id, pageParam, active), active, onReadDenied);
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page, _pages, _parameter, parameters) =>
            page.nextCursor && !parameters.includes(page.nextCursor) ? page.nextCursor : undefined,
        refetchInterval: (query) => {
            // 关闭表单面板可能中止浏览器等待，但服务端事务仍可能稍后提交，因此在回执对账窗口内继续短间隔读取历史。
            const remaining = reconcileFormUntil.current - Date.now();
            if (remaining > 0) return Math.max(250, Math.min(1500, remaining));
            const loaded = query.state.data?.pages.flatMap((page) => page.items) ?? [];
            return mergeTurns(loaded, updates).some((turn) => turn.status === "RUNNING") ? 2_000 : false;
        },
    });
    const session = current.data;
    const sessionId = session?.id;
    const tasks = useAgentTasks({
        owner,
        workspaceId: workspace.id,
        sessionId: id,
        adapter,
        signal,
        onReadDenied,
        enabled: sessionId === id && current.isSuccess,
    });
    const editable = !workspace.archived && !!session && !session.archived;
    const editor = ["OWNER", "ADMIN", "EDITOR"].includes(workspace.role);
    const plan = editable && editor;
    const execute = editable && workspace.role !== "VIEWER";
    const turns = mergeTurns(history.data?.pages.flatMap((page) => page.items) ?? [], updates);
    const lastTurn = turns.at(-1);
    const lastTurnKey = lastTurn ? `${lastTurn.id}:${lastTurn.status}` : "";
    const { fetchNextPage, hasNextPage, isFetching, isFetchNextPageError } = history;
    const targetReady =
        current.isSuccess && history.isSuccess && current.isFetchedAfterMount && history.isFetchedAfterMount;
    const focusedReply =
        targetReady && turns.some((turn) => turn.id === focusTurnId && turn.reply && turn.status === "COMPLETED");
    useAgentReplyVisibility({
        messages: messagesRef,
        workspaceId: workspace.id,
        sessionId: id,
        displayed: targetReady,
        signal,
        acknowledge: onReplyVisible,
    });

    // 只有通知定位尚未找到目标时才继续读取较早的签名页，发生失败或会话切换时交回现有手动重试入口。
    useEffect(() => {
        if (
            focusTurnId &&
            targetReady &&
            !focusedReply &&
            hasNextPage &&
            !isFetching &&
            !isFetchNextPageError &&
            !signal.aborted
        ) {
            void fetchNextPage({ cancelRefetch: false });
        }
    }, [fetchNextPage, focusTurnId, focusedReply, hasNextPage, isFetchNextPageError, isFetching, signal, targetReady]);

    // 授权历史装入后只对当前定位目标滚动一次；同步聚焦回复，后续重渲染与其它流式轮次不会抢走焦点。
    useEffect(() => {
        const reply = requestedReply.current;
        if (!focusTurnId || !focusedReply || revealed.current?.id === focusTurnId || !reply || signal.aborted) return;
        revealed.current = { id: focusTurnId, latest: lastTurnKey };
        reply.scrollIntoView({ block: "nearest" });
        reply.focus({ preventScroll: true });
    }, [focusTurnId, focusedReply, lastTurnKey, signal]);
    const latest = turns.filter((turn) => turn.proposal && turn.status === "COMPLETED").at(-1);
    const running = turns.some((turn) => turn.status === "RUNNING");
    const recovered = turns.find((turn) => turn.id === recovering.current?.id && turn.status !== "RUNNING");
    useEffect(() => {
        if (!signal.aborted && recovered && recovering.current) {
            clearAgentSubmission(retryKey, recovering.current.requestId);
            recovering.current = undefined;
            if (recovered.status === "COMPLETED") refreshTitles();
        }
    }, [recovered, refreshTitles, retryKey, signal]);
    // 最新一条消息新增或状态变化时仅滚动消息区域，让用户看到返回内容且保留输入框与所在页面的位置。
    useEffect(() => {
        const messages = messagesRef.current;
        if (!sessionId || !lastTurnKey || !messages) return;
        if (focusTurnId && (revealed.current?.id !== focusTurnId || revealed.current.latest === lastTurnKey)) return;
        messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" });
    }, [focusTurnId, lastTurnKey, sessionId]);
    const references = runReferences(turns);
    const focused = references.filter((run) => !completedRuns.has(run.id)).at(-1)?.id;
    const phrase = agentConfirmation(text);
    const isConfirmation = !!phrase;
    // 明确拒绝后的确认入口等权威读取显示可审阅的新提议，重挂时缓存在本次读取完成前不能解除门禁。
    const reviewable =
        !!latest &&
        latest.id !== supersededTarget &&
        (!supersededTarget || (current.isSuccess && history.isSuccess && history.isFetchedAfterMount)) &&
        (!history.hasNextPage || updates.has(latest.id));
    useEffect(() => {
        if (
            !signal.aborted &&
            !operation &&
            reviewable &&
            supersededTarget &&
            supersededTargets.get(retryKey) === supersededTarget
        ) {
            supersededTargets.delete(retryKey);
        }
    }, [operation, retryKey, reviewable, signal, supersededTarget]);
    const proposalType = latest?.proposal?.type;
    const allowed = (kind?: AgentSchemas["AgentProposal"]["type"]) =>
        editable && canConfirmAgentAction(workspace.role, kind);
    const mayConfirmText = reviewable && !!proposalType && allowed(proposalType) && !!phrase?.(proposalType);
    const pendingTarget = pendingAgentConfirmationTarget(retryKey);
    const pendingType = pendingTarget ? turns.find((turn) => turn.id === pendingTarget)?.proposal?.type : undefined;
    const canRetryConfirmation = allowed(pendingType);
    const canSend = isConfirmation
        ? !attachments.length && (mayConfirmText || (pendingType && canRetryConfirmation && phrase(pendingType)))
        : plan && (!!text.trim() || !!attachments.length);
    const busy = !!operation || running;

    // 从快照得知运行终态后重新分配实时订阅名额，不把报告读取成功或已排队的工作误作运行结束。
    const reportTerminal = useCallback((runId: string, finished: boolean) => {
        setCompletedRuns((known) => {
            if (known.has(runId) === finished) return known;
            const next = new Set(known);
            if (finished) next.add(runId);
            else next.delete(runId);
            return next;
        });
    }, []);

    const refresh = () => Promise.all([current.refetch(), history.refetch()]);

    // 写入前同步占用本会话请求位置，发送和确认共用。切换会话后旧回执只会从恢复的历史读取。
    async function act(kind: NonNullable<typeof operation>, action: () => Promise<void>) {
        if (mutation.current || signal.aborted) return;
        mutation.current = true;
        setOperation(kind);
        try {
            await action();
        } catch (failure) {
            if (!signal.aborted) {
                // 写操作可能只失去编辑或执行能力，除明确的账户失效外仍以新的读取结果决定对话是否可见。
                if (agentErrorCode(failure) === "AUTHENTICATION_REQUIRED") {
                    onWorkspaceReadDenied(failure);
                } else {
                    showFailure(agentOperationError(failure));
                    void refresh();
                }
            }
        } finally {
            mutation.current = false;
            if (!signal.aborted) setOperation(undefined);
        }
    }

    const receive = (turn: Turn) => {
        signal.throwIfAborted();
        setUpdates((previous) => new Map(previous).set(turn.id, turn));
        if (turn.status === "COMPLETED") refreshTitles();
        void history.refetch();
    };

    // 网络结果未知时，同一文本重试沿用同一个请求编号；收到已存轮次后清空编号，后续输入才是新的请求。
    function submitText(
        messageText: string,
        opts: { confirmation: boolean; expectedProposalId?: string },
        files: StagedAgentAttachment[] = [],
    ) {
        if ((!messageText.trim() && !files.length) || busy) return;
        void act("send", async () => {
            const attachments = await encodeAgentAttachments(files, signal);
            const data = await agentSubmission(
                retryKey,
                messageText,
                {
                    ...opts,
                    attachments,
                    delegationMode: opts.confirmation || delegationMode === "AUTO" ? undefined : delegationMode,
                },
                signal,
            );
            // 确认提案使用普通提交以便处理提案已被替换的响应，普通消息使用 SSE 逐段展示本轮回复。
            if (opts.confirmation) {
                const reviewed = turns.find((turn) => turn.id === data.expectedProposalId)?.proposal?.type;
                if (!reviewed || !allowed(reviewed) || !agentConfirmation(messageText)?.(reviewed))
                    throw new Error("AGENT_CONFIRM_TARGET_REQUIRED");
                const turn = await adapter.submit(id, data, signal).catch(async (failure: unknown) => {
                    if (
                        signal.aborted ||
                        !data.expectedProposalId ||
                        agentErrorCode(failure) !== "AGENT_PROPOSAL_SUPERSEDED"
                    ) {
                        throw failure;
                    }
                    // 只结清当前代次获明确拒绝的提交编号。保留输入并等待正常刷新，后续确认仍由用户主动发送。
                    clearAgentSubmission(retryKey, data.requestId);
                    supersededTargets.set(retryKey, data.expectedProposalId);
                    showFailure(agentOperationError(failure));
                    await refresh();
                });
                if (!turn) return;
                signal.throwIfAborted();
                clearAgentSubmission(retryKey, data.requestId);
                setDelegationMode("AUTO");
                setText("");
                receive(turn);
                return;
            }
            await streamTurn(data);
        });
    }

    // 消费 SSE 流：start 挂载运行中的轮次，delta 逐段追加到生成中气泡，done 用权威轮次兜底，error 抛业务代号。
    async function streamTurn(data: AgentSchemas["AgentTurnSubmit"]) {
        const response = await adapter.submitStream(id, data, signal);
        if (!response.body) throw new Error("Agent stream is unavailable.");
        const reader = response.body
            .pipeThrough(new TextDecoderStream())
            .pipeThrough(new EventSourceParserStream({ maxBufferSize: 32 * 1024 * 1024, onError: "terminate" }))
            .getReader();
        let turnId = "";
        try {
            while (!signal.aborted) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value.event === "start") {
                    const turn = JSON.parse(value.data) as Turn;
                    turnId = turn.id;
                    signal.throwIfAborted();
                    setText("");
                    setAttachments([]);
                    setReattach(false);
                    recovering.current = { id: turn.id, requestId: data.requestId };
                    receive(turn);
                } else if (value.event === "thinking") {
                    const { text } = JSON.parse(value.data) as { text: string };
                    setThinkingText((previous) => {
                        const next = new Map(previous);
                        next.set(turnId, (next.get(turnId) ?? "") + text);
                        return next;
                    });
                } else if (value.event === "step") {
                    const step = JSON.parse(value.data) as Step;
                    setStreamSteps((previous) => {
                        const next = new Map(previous);
                        const list = [...(next.get(turnId) ?? [])];
                        const index = list.findIndex((entry) => entry.id === step.id);
                        if (index >= 0) list[index] = step;
                        else list.push(step);
                        next.set(turnId, list);
                        return next;
                    });
                } else if (value.event === "delta") {
                    const { text } = JSON.parse(value.data) as { text: string };
                    setStreamText((previous) => {
                        const next = new Map(previous);
                        next.set(turnId, (next.get(turnId) ?? "") + text);
                        return next;
                    });
                } else if (value.event === "done") {
                    const turn = JSON.parse(value.data) as Turn;
                    signal.throwIfAborted();
                    if (turn.status === "RUNNING") recovering.current = { id: turn.id, requestId: data.requestId };
                    else clearAgentSubmission(retryKey, data.requestId);
                    setDelegationMode("AUTO");
                    setText("");
                    setAttachments([]);
                    setReattach(false);
                    setStreamText((previous) => {
                        const next = new Map(previous);
                        next.delete(turn.id);
                        return next;
                    });
                    setThinkingText((previous) => {
                        const next = new Map(previous);
                        next.delete(turn.id);
                        return next;
                    });
                    setStreamSteps((previous) => {
                        const next = new Map(previous);
                        next.delete(turn.id);
                        return next;
                    });
                    receive(turn);
                    break;
                } else if (value.event === "error") {
                    const { code } = JSON.parse(value.data) as { code: string };
                    signal.throwIfAborted();
                    throw new ApiError(code, agentProblem(code), 0, "");
                }
            }
        } finally {
            await reader.cancel();
            reader.releaseLock();
        }
    }

    function send(event: FormEvent) {
        event.preventDefault();
        if (!canSend || busy) return;
        const expectedProposalId = isConfirmation && mayConfirmText ? latest?.id : undefined;
        submitText(text.trim() ? text : "", { confirmation: isConfirmation, expectedProposalId }, attachments);
    }

    // 编辑仅恢复已保存正文，历史文件不留副本；重新生成涉及附件的轮次也要求先选回对应文件。
    function editMessage(turn: Turn) {
        if (signal.aborted) return;
        setText(turn.text);
        setAttachments([]);
        setReattach(!!turn.attachments?.length);
        inputRef.current?.focus({ preventScroll: true });
    }

    function regenerate(turn: Turn) {
        if (busy || signal.aborted) return;
        if (turn.attachments?.length) {
            editMessage(turn);
            return;
        }
        clearAgentSubmission(retryKey);
        submitText(turn.text, { confirmation: false });
    }

    function addFiles(files: File[]) {
        if (!files.length || signal.aborted || busy) return;
        try {
            setAttachments(stageAgentAttachments(attachments, files, supportsImages));
            setReattach(false);
        } catch (failure) {
            showFailure(agentOperationError(failure));
        }
    }

    async function copyText(key: string, value: string) {
        try {
            await navigator.clipboard.writeText(value);
            setCopiedKey(key);
            setTimeout(() => setCopiedKey(""), 1500);
        } catch {
            // 只有写入剪贴板成功才显示短暂的复制提示，浏览器拒绝访问时保留当前会话内容并允许用户继续操作。
        }
    }

    // 来自授权列表的标题不能代替详情读取；新会话只有在详情与历史都已到达后才挂载私有正文及操作。
    if (!session || !history.data) {
        return (
            <article className="vq-agent-thread">
                <AgentError error={history.error ?? current.error} retry={() => void refresh()} />
                {(current.isFetching || history.isFetching) && <p role="status">{tx("Loading VeriQ…")}</p>}
            </article>
        );
    }

    const exportAllowed = canExportWorkspaceTable(workspace.role) && !signal.aborted;
    const messages = (
        <>
            <AgentError error={history.error ?? current.error} retry={() => void refresh()} />
            {history.isPending && <p role="status">{tx("Loading VeriQ…")}</p>}
            {focusTurnId &&
                !focusedReply &&
                targetReady &&
                (hasNextPage ? (
                    <p role="status">{tx("Loading requested reply…")}</p>
                ) : (
                    <p role="alert">{tx("The requested Agent reply is no longer available.")}</p>
                ))}
            {session.archived && <p>{tx("This conversation is archived.")}</p>}
            {history.isSuccess && turns.length === 0 && <p className="vq-agent-centered">{tx("No messages yet.")}</p>}
            <ol className="vq-agent-history" aria-label={tx("Conversation history")}>
                {turns.map((turn) => {
                    const inProgress = turn.status === "RUNNING";
                    const partial = inProgress ? streamText.get(turn.id) : undefined;
                    const thinking = (inProgress ? thinkingText.get(turn.id) : undefined) ?? turn.thinking;
                    const thinkingOpen = openThinking.get(turn.id) ?? turn.status === "RUNNING";
                    const thinkingId = `vq-agent-summary-${turn.id}`;
                    const steps: Step[] = (inProgress ? streamSteps.get(turn.id) : undefined) ?? turn.steps ?? [];
                    const confirm =
                        reviewable && turn.id === latest?.id && !turn.receipt && allowed(turn.proposal?.type);
                    return (
                        <li key={turn.id}>
                            <div className="vq-agent-user">
                                <div className="vq-agent-user-content">
                                    <span className="vq-agent-user-name">{ownerName}</span>
                                    <div className="vq-agent-user-text">
                                        {turn.text && <Markdown exportAllowed={exportAllowed}>{turn.text}</Markdown>}
                                        <AgentAttachmentList attachments={turn.attachments ?? []} />
                                    </div>
                                </div>
                                <Avatar name={ownerName} size={32} fontSize={13} />
                            </div>
                            <div className="vq-agent-msg-actions vq-agent-msg-actions-user">
                                <button
                                    type="button"
                                    aria-label={tx("Copy message")}
                                    disabled={!turn.text}
                                    onClick={() => void copyText(`${turn.id}-user`, turn.text)}
                                >
                                    {copiedKey === `${turn.id}-user` ? (
                                        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none">
                                            <path
                                                d="M20 6L9 17l-5-5"
                                                stroke="currentColor"
                                                strokeWidth="1.5"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                            />
                                        </svg>
                                    ) : (
                                        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none">
                                            <rect
                                                x="9"
                                                y="9"
                                                width="13"
                                                height="13"
                                                rx="2"
                                                stroke="currentColor"
                                                strokeWidth="1.5"
                                            />
                                            <path
                                                d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                                                stroke="currentColor"
                                                strokeWidth="1.5"
                                            />
                                        </svg>
                                    )}
                                </button>
                                <button type="button" aria-label={tx("Edit message")} onClick={() => editMessage(turn)}>
                                    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24">
                                        <use href={`${icons}#edit`} />
                                    </svg>
                                </button>
                            </div>
                            {(turn.reply || turn.status === "RUNNING" || turn.errorCode) && (
                                <>
                                    <div className="vq-agent-reply">
                                        <span className="vq-agent-avatar" aria-hidden="true">
                                            <svg aria-hidden="true" width="16" height="16">
                                                <use href={`${icons}#robot`} />
                                            </svg>
                                        </span>
                                        <div className="vq-agent-reply-content">
                                            <span className="vq-agent-reply-name">{tx("Test Agent")}</span>
                                            {thinking && (
                                                <div className="vq-agent-thinking">
                                                    <button
                                                        type="button"
                                                        className="vq-agent-thinking-summary"
                                                        aria-expanded={thinkingOpen}
                                                        aria-controls={thinkingId}
                                                        onClick={() =>
                                                            setOpenThinking((previous) =>
                                                                new Map(previous).set(turn.id, !thinkingOpen),
                                                            )
                                                        }
                                                    >
                                                        <svg
                                                            aria-hidden="true"
                                                            width="12"
                                                            height="12"
                                                            viewBox="0 0 24 24"
                                                            fill="none"
                                                            className="vq-agent-thinking-chevron"
                                                            data-open={thinkingOpen}
                                                        >
                                                            <path
                                                                d="M9 18l6-6-6-6"
                                                                stroke="currentColor"
                                                                strokeWidth="2"
                                                                strokeLinecap="round"
                                                                strokeLinejoin="round"
                                                            />
                                                        </svg>
                                                        {tx("Reasoning summary")}
                                                        {turn.status === "RUNNING" && (
                                                            <span className="vq-agent-spinner" aria-hidden="true" />
                                                        )}
                                                    </button>
                                                    <div
                                                        id={thinkingId}
                                                        className="vq-agent-thinking-body"
                                                        hidden={!thinkingOpen}
                                                    >
                                                        {thinking}
                                                    </div>
                                                </div>
                                            )}
                                            {steps.length > 0 && (
                                                <ul
                                                    className="vq-agent-steps"
                                                    aria-label={tx("Tool activity")}
                                                    aria-live="polite"
                                                >
                                                    {steps.map((step, index) => (
                                                        <li
                                                            key={step.id ?? index}
                                                            className="vq-agent-step"
                                                            data-status={step.status}
                                                        >
                                                            <span className="vq-agent-step-icon" aria-hidden="true">
                                                                {step.status === "RUNNING" ? (
                                                                    <span className="vq-agent-spinner" />
                                                                ) : step.status === "SUCCEEDED" ? (
                                                                    "✓"
                                                                ) : (
                                                                    "✕"
                                                                )}
                                                            </span>
                                                            <span className="vq-agent-step-name">{tx(step.name)}</span>
                                                            <span className="vq-agent-step-status">
                                                                {tx(stepStatus[step.status])}
                                                            </span>
                                                            {step.summary && (
                                                                <span className="vq-agent-step-summary">
                                                                    {step.summary}
                                                                </span>
                                                            )}
                                                            {step.errorCode && (
                                                                <span className="vq-agent-step-error">
                                                                    {agentProblem(step.errorCode)}
                                                                </span>
                                                            )}
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}
                                            {turn.reply && (
                                                <div
                                                    className="vq-agent-reply-body"
                                                    data-agent-reply={turn.status === "COMPLETED" ? turn.id : undefined}
                                                    ref={turn.id === focusTurnId ? requestedReply : undefined}
                                                    tabIndex={turn.id === focusTurnId ? -1 : undefined}
                                                >
                                                    <Markdown exportAllowed={exportAllowed}>{turn.reply}</Markdown>
                                                </div>
                                            )}
                                            {turn.status === "RUNNING" && partial && (
                                                <p className="vq-agent-reply-body" role="status">
                                                    {partial}
                                                    <span className="vq-agent-cursor" aria-hidden="true" />
                                                </p>
                                            )}
                                            {turn.status === "RUNNING" && !partial && (
                                                <p className="vq-agent-reply-thinking" role="status">
                                                    <span className="vq-agent-spinner" aria-hidden="true" />
                                                    {tx("Thinking…")}
                                                </p>
                                            )}
                                            {turn.errorCode && (
                                                <p className="vq-agent-reply-body" role="alert">
                                                    {agentProblem(turn.errorCode)}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                    {(turn.reply || turn.errorCode || (plan && turn.status === "FAILED")) && (
                                        <div className="vq-agent-msg-actions vq-agent-msg-actions-agent">
                                            <button
                                                type="button"
                                                aria-label={tx("Copy message")}
                                                onClick={() =>
                                                    void copyText(
                                                        `${turn.id}-agent`,
                                                        turn.reply ??
                                                            (turn.errorCode ? agentProblem(turn.errorCode) : ""),
                                                    )
                                                }
                                            >
                                                {copiedKey === `${turn.id}-agent` ? (
                                                    <svg
                                                        aria-hidden="true"
                                                        width="14"
                                                        height="14"
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                    >
                                                        <path
                                                            d="M20 6L9 17l-5-5"
                                                            stroke="currentColor"
                                                            strokeWidth="1.5"
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                        />
                                                    </svg>
                                                ) : (
                                                    <svg
                                                        aria-hidden="true"
                                                        width="14"
                                                        height="14"
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                    >
                                                        <rect
                                                            x="9"
                                                            y="9"
                                                            width="13"
                                                            height="13"
                                                            rx="2"
                                                            stroke="currentColor"
                                                            strokeWidth="1.5"
                                                        />
                                                        <path
                                                            d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                                                            stroke="currentColor"
                                                            strokeWidth="1.5"
                                                        />
                                                    </svg>
                                                )}
                                            </button>
                                            {turn.reply && (
                                                <button
                                                    type="button"
                                                    aria-label={tx("Regenerate message")}
                                                    disabled={busy}
                                                    onClick={() => regenerate(turn)}
                                                >
                                                    <svg
                                                        aria-hidden="true"
                                                        width="14"
                                                        height="14"
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                    >
                                                        <polyline
                                                            points="23 4 23 10 17 10"
                                                            stroke="currentColor"
                                                            strokeWidth="1.5"
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                        />
                                                        <path
                                                            d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"
                                                            stroke="currentColor"
                                                            strokeWidth="1.5"
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                        />
                                                    </svg>
                                                </button>
                                            )}
                                            {plan && turn.status === "FAILED" && (
                                                <button
                                                    type="button"
                                                    aria-label={tx("Retry message")}
                                                    disabled={busy}
                                                    onClick={() => regenerate(turn)}
                                                >
                                                    <svg
                                                        aria-hidden="true"
                                                        width="14"
                                                        height="14"
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                    >
                                                        <polyline
                                                            points="1 4 1 10 7 10"
                                                            stroke="currentColor"
                                                            strokeWidth="1.5"
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                        />
                                                        <path
                                                            d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"
                                                            stroke="currentColor"
                                                            strokeWidth="1.5"
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                        />
                                                    </svg>
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </>
                            )}
                            {turn.workspaceForm && formLauncher && (
                                <CapabilityCard
                                    key={turn.workspaceForm.capability}
                                    card={turn.workspaceForm}
                                    sessionId={id}
                                    turnId={turn.id}
                                    workspaceId={workspace.id}
                                    signal={signal}
                                    launcher={formLauncher}
                                    authorize={(current) => adapter.getAgentWorkspaceForm(id, turn.id, current)}
                                    onClose={() => {
                                        reconcileFormUntil.current = Date.now() + 4500;
                                        void history.refetch();
                                    }}
                                />
                            )}
                            {turn.workspaceFormReceipts && <FormReceipts items={turn.workspaceFormReceipts} />}
                            {turn.proposal && (
                                <Proposal
                                    proposal={turn.proposal}
                                    delegationMode={turn.delegationMode}
                                    disabled={busy}
                                    confirm={
                                        confirm
                                            ? () =>
                                                  void act("confirm", async () =>
                                                      receive(await adapter.confirm(id, turn.id, signal)),
                                                  )
                                            : undefined
                                    }
                                />
                            )}
                            {turn.receipt && <ActionReceipt receipt={turn.receipt} />}
                        </li>
                    );
                })}
            </ol>
            {history.hasNextPage && (
                <button
                    type="button"
                    className="vq-agent-load-more"
                    disabled={history.isFetchingNextPage}
                    onClick={() => void history.fetchNextPage()}
                >
                    {`—— ${tx("Load more messages")} ——`}
                </button>
            )}
            {references.map((run) => (
                <RunCard
                    key={run.id}
                    workspaceId={workspace.id}
                    owner={owner}
                    run={run}
                    reports={reports}
                    signal={signal}
                    onWorkspaceReadDenied={onWorkspaceReadDenied}
                    focused={run.id === focused}
                    navigate={navigate}
                    reportTerminal={reportTerminal}
                    follow={editable && tasks.canFollow(run.id) ? () => tasks.follow(run.id) : undefined}
                    analyze={plan && tasks.canFollow(run.id) ? () => tasks.follow(run.id, true) : undefined}
                    followingBusy={tasks.busy}
                />
            ))}
            <BackgroundTasks tasks={tasks} editable={editable} canReadAnalysis={editor} />
        </>
    );
    return (
        <article className="vq-agent-thread">
            <div className="vq-agent-message-scroll" ref={messagesRef}>
                {messages}
            </div>
            {execute && (plan || canRetryConfirmation || allowed(proposalType)) && (
                <form className="vq-agent-composer" onSubmit={send}>
                    <textarea
                        ref={inputRef}
                        className="vq-agent-composer-input"
                        value={text}
                        rows={3}
                        maxLength={8_000}
                        placeholder={tx("Type your message…")}
                        aria-label={tx("Message")}
                        onChange={(event) => setText(event.target.value)}
                        disabled={!!operation}
                    />
                    <AgentAttachmentList
                        attachments={attachments}
                        remove={(id) => setAttachments((files) => files.filter((file) => file.id !== id))}
                        disabled={busy}
                    />
                    {isConfirmation && !canSend && (
                        <p>
                            {tx(
                                attachments.length
                                    ? "Remove attachments before confirming."
                                    : "Review a matching proposal before confirming it.",
                            )}
                        </p>
                    )}
                    {!plan && <p>{tx("You can confirm a run proposal here.")}</p>}
                    <div className="vq-agent-composer-footer">
                        {plan && (
                            <div className="vq-agent-composer-attachments">
                                <input
                                    ref={fileRef}
                                    type="file"
                                    aria-label={tx("Select attachments")}
                                    multiple
                                    hidden
                                    accept={agentAttachmentAccept}
                                    disabled={busy}
                                    onChange={(event) => {
                                        addFiles(Array.from(event.currentTarget.files ?? []));
                                        event.currentTarget.value = "";
                                    }}
                                />
                                <button
                                    type="button"
                                    className="vq-agent-attach"
                                    disabled={busy}
                                    aria-label={tx("Add attachments")}
                                    aria-describedby={attachmentHelp}
                                    onClick={() => fileRef.current?.click()}
                                >
                                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
                                        <path
                                            d={paperclipPath}
                                            stroke="currentColor"
                                            strokeWidth="1.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                    </svg>
                                </button>
                                <p id={attachmentHelp} className="vq-agent-attachment-help">
                                    {tx(
                                        reattach
                                            ? "Reattach the original files to reuse them."
                                            : "Attachment upload guidance",
                                    )}
                                </p>
                            </div>
                        )}
                        <div className="vq-agent-composer-actions">
                            <select
                                aria-label={tx("Run follow-up")}
                                title={tx("Run follow-up")}
                                value={isConfirmation ? (latest?.delegationMode ?? "AUTO") : delegationMode}
                                disabled={busy || isConfirmation}
                                onChange={(event) => {
                                    const mode = event.target.value;
                                    if (mode === "AUTO" || mode === "MAIN" || mode === "SUBAGENT")
                                        setDelegationMode(mode);
                                }}
                            >
                                <option value="AUTO">{tx("Auto follow-up")}</option>
                                <option value="SUBAGENT">{tx("Delegate follow-up")}</option>
                                <option value="MAIN">{tx("Main conversation only")}</option>
                            </select>
                            {editable && (
                                <button
                                    type="button"
                                    className="vq-agent-archive"
                                    disabled={busy}
                                    aria-label={tx("Archive conversation")}
                                    onClick={() => setArchiveOpen(true)}
                                >
                                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
                                        <path
                                            d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"
                                            stroke="currentColor"
                                            strokeWidth="1.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                    </svg>
                                </button>
                            )}
                            <button
                                type="submit"
                                className="vq-agent-send"
                                disabled={busy || !canSend}
                                aria-label={tx("Send")}
                            >
                                {operation === "send" ? (
                                    <span className="vq-agent-spinner" aria-hidden="true" />
                                ) : (
                                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
                                        <path
                                            d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"
                                            stroke="currentColor"
                                            strokeWidth="1.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                    </svg>
                                )}
                            </button>
                        </div>
                    </div>
                </form>
            )}
            <Dialog.Root open={archiveOpen} onOpenChange={setArchiveOpen}>
                <Dialog.Portal>
                    <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                    <Dialog.Content className="vq-dialog vq-workspace-dialog">
                        <div className="vq-card-heading">
                            <Dialog.Title>{tx("Archive conversation")}</Dialog.Title>
                            <Dialog.Close className="vq-sheet-close" aria-label={tx("Close")}>
                                ×
                            </Dialog.Close>
                        </div>
                        <Dialog.Description className="vq-workspace-key-hint">
                            {tx("Archive conversation hint")}
                        </Dialog.Description>
                        <div className="vq-workspace-form-actions">
                            <Dialog.Close type="button" className="vq-btn-secondary">
                                {tx("Cancel")}
                            </Dialog.Close>
                            <button
                                type="button"
                                className="vq-btn-danger"
                                disabled={busy}
                                onClick={() =>
                                    void act("archive", async () => {
                                        await adapter.archive(id, signal);
                                        signal.throwIfAborted();
                                        setArchiveOpen(false);
                                        onArchived();
                                    })
                                }
                            >
                                {tx("Archive conversation")}
                            </button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </article>
    );
}
