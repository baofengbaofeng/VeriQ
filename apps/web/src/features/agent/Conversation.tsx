/**
 * 单条会话拥有自己的读写和报告取消边界。先显示服务器记录的轮次顺序，重新读取后以权威状态补齐正在处理的试验。
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { tx } from "../../locale";
import type { Workspace } from "../../api";
import type { ReportAdapter } from "../reports/adapters";
import { agentErrorCode, observeAgentRead, type AgentSchemas, type CloudAgentAdapter } from "./adapters";
import { useAgentLifetime } from "./lifetime";
import { agentSubmission, clearAgentSubmission, hasPendingAgentConfirmation } from "./retry";
import { AgentError, agentProblem } from "./feedback";
import { Proposal, ActionReceipt } from "./Proposal";
import { RunCard, type ReportNavigation, type RunReference } from "./RunCard";

type Turn = AgentSchemas["AgentTurnDTO"];

// 这三组文案对应服务端确定性短语，仅用于启用当前角色的发送操作；服务器仍验证动作和会话权限。
const confirmAny = new Set(["confirm", "confirm action", "确认", "确认操作"]);
const confirmSave = new Set(["confirm plan", "confirm save", "确认保存"]);
const confirmRun = new Set(["confirm run", "确认执行", "确认运行"]);

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
        const receipt = turn.receipt?.type === "SAVE_PLAN" ? undefined : turn.receipt;
        if (turn.relatedRunId && !result.has(turn.relatedRunId))
            result.set(turn.relatedRunId, { id: turn.relatedRunId });
        if (receipt) result.set(receipt.runId, { id: receipt.runId, receipt });
    }
    return [...result.values()];
}

/**
 * 当前会话只在独立效果为其建立新的存活信号后挂载，任何已卸载会话都只能通过服务端历史恢复结果。
 */
export function Conversation({ parentSignal, ...props }: ConversationProps) {
    const signal = useAgentLifetime(parentSignal);
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
    adapter: CloudAgentAdapter;
    reports: Pick<ReportAdapter, "report" | "subscribe">;
    parentSignal: AbortSignal;
    navigate: ReportNavigation;
    onReadDenied: (error: unknown) => void;
    onWorkspaceReadDenied: (error: unknown) => void;
    onArchived: () => void;
}

// 本组件只接收当前挂载拥有的有效信号，角色和归档状态控制入口，服务器负责再次校验全部业务授权。
function Thread({
    workspace,
    owner,
    sessionId: id,
    initialMessage,
    adapter,
    reports,
    signal,
    navigate,
    onReadDenied,
    onWorkspaceReadDenied,
    onArchived,
}: Omit<ConversationProps, "parentSignal"> & { signal: AbortSignal }) {
    const [text, setText] = useState(initialMessage);
    const [error, setError] = useState<unknown>();
    const [operation, setOperation] = useState<"send" | "confirm" | "archive">();
    const mutation = useRef(false);
    const recovering = useRef<{ id: string; requestId: string }>();
    const [updates, setUpdates] = useState(() => new Map<string, Turn>());
    const [completedRuns, setCompletedRuns] = useState(() => new Set<string>());
    const retryKey = "veriq.agent.retry/" + JSON.stringify([owner, workspace.id, id]);
    const supersededTarget = supersededTargets.get(retryKey);
    const key = ["workspace", workspace.id, "agent", owner, "session", id];
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
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: (query) => {
            const loaded = query.state.data?.pages.flatMap((page) => page.items) ?? [];
            return mergeTurns(loaded, updates).some((turn) => turn.status === "RUNNING") ? 2_000 : false;
        },
    });
    const session = current.data;
    const editable = !workspace.archived && !!session && !session.archived;
    const plan = editable && ["OWNER", "ADMIN", "EDITOR"].includes(workspace.role);
    const execute = editable && workspace.role !== "VIEWER";
    const turns = mergeTurns(history.data?.pages.flatMap((page) => page.items) ?? [], updates);
    const latest = turns.filter((turn) => turn.proposal && turn.status === "COMPLETED").at(-1);
    const running = turns.some((turn) => turn.status === "RUNNING");
    const recovered = turns.find((turn) => turn.id === recovering.current?.id && turn.status !== "RUNNING");
    useEffect(() => {
        if (!signal.aborted && recovered && recovering.current) {
            clearAgentSubmission(retryKey, recovering.current.requestId);
            recovering.current = undefined;
        }
    }, [recovered, retryKey, signal]);
    const references = runReferences(turns);
    const focused = references.filter((run) => !completedRuns.has(run.id)).at(-1)?.id;
    const confirmationText = text
        .trim()
        .toLowerCase()
        .replace(/[.!。！]+$/, "");
    const isConfirmation =
        confirmAny.has(confirmationText) || confirmSave.has(confirmationText) || confirmRun.has(confirmationText);
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
    const mayConfirmText =
        reviewable &&
        (latest?.proposal?.type === "SAVE_PLAN"
            ? plan && (confirmAny.has(confirmationText) || confirmSave.has(confirmationText))
            : execute && (confirmAny.has(confirmationText) || confirmRun.has(confirmationText)));
    const canRetryConfirmation = execute && hasPendingAgentConfirmation(retryKey);
    const canSend = !!text.trim() && (isConfirmation ? mayConfirmText || canRetryConfirmation : plan);
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
        setError(undefined);
        try {
            await action();
        } catch (failure) {
            if (!signal.aborted) {
                // 写操作可能只失去编辑或执行能力，除明确的账户失效外仍以新的读取结果决定对话是否可见。
                if (agentErrorCode(failure) === "AUTHENTICATION_REQUIRED") {
                    onWorkspaceReadDenied(failure);
                } else {
                    setError(failure);
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
        void refresh();
    };

    // 网络结果未知时，同一文本重试沿用同一个请求编号；收到已存轮次后清空编号，后续输入才是新的请求。
    function send(event: FormEvent) {
        event.preventDefault();
        if (!canSend || busy) return;
        const expectedProposalId = isConfirmation && mayConfirmText ? latest?.id : undefined;
        void act("send", async () => {
            const data = await agentSubmission(
                retryKey,
                text,
                { confirmation: isConfirmation, expectedProposalId },
                signal,
            );
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
                setError(failure);
                await refresh();
            });
            if (!turn) {
                return;
            }
            signal.throwIfAborted();
            if (turn.status === "RUNNING") recovering.current = { id: turn.id, requestId: data.requestId };
            else clearAgentSubmission(retryKey, data.requestId);
            setText("");
            receive(turn);
        });
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

    return (
        <article className="vq-agent-thread">
            <header className="vq-agent-toolbar">
                <h3>{session.title}</h3>
                <button type="button" onClick={() => void refresh()}>
                    {tx("Refresh conversation")}
                </button>
                {editable && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                            void act("archive", async () => {
                                await adapter.archive(id, signal);
                                signal.throwIfAborted();
                                onArchived();
                            })
                        }
                    >
                        {tx("Archive conversation")}
                    </button>
                )}
            </header>
            <AgentError error={history.error ?? current.error} retry={() => void refresh()} />
            {history.isPending && <p role="status">{tx("Loading VeriQ…")}</p>}
            {session.archived && <p>{tx("This conversation is archived.")}</p>}
            {history.isSuccess && turns.length === 0 && <p>{tx("No messages yet.")}</p>}
            <ol className="vq-agent-history" aria-label={tx("Conversation history")}>
                {turns.map((turn) => {
                    const confirm =
                        reviewable &&
                        turn.id === latest?.id &&
                        !turn.receipt &&
                        (turn.proposal?.type === "SAVE_PLAN" ? plan : execute);
                    return (
                        <li key={turn.id}>
                            <p className="vq-agent-user-text">{turn.text}</p>
                            {turn.reply && <p className="vq-agent-reply">{turn.reply}</p>}
                            {turn.status === "RUNNING" && <p role="status">{tx("Waiting for model response…")}</p>}
                            {turn.errorCode && <p role="alert">{agentProblem(turn.errorCode)}</p>}
                            {plan && turn.status === "FAILED" && (
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => {
                                        if (!signal.aborted) {
                                            clearAgentSubmission(retryKey);
                                            setText(turn.text);
                                        }
                                    }}
                                >
                                    {tx("Retry message")}
                                </button>
                            )}
                            {turn.proposal && (
                                <Proposal
                                    proposal={turn.proposal}
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
                    disabled={history.isFetchingNextPage}
                    onClick={() => void history.fetchNextPage()}
                >
                    {tx("Load more messages")}
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
                />
            ))}
            <AgentError error={error} />
            {operation === "send" && <p role="status">{tx("Submitting message…")}</p>}
            {operation === "confirm" && <p role="status">{tx("Confirming action…")}</p>}
            {execute &&
                (plan || canRetryConfirmation || (latest?.proposal && latest.proposal.type !== "SAVE_PLAN")) && (
                    <form className="vq-agent-composer" onSubmit={send}>
                        <label>
                            {tx("Message")}
                            <textarea
                                value={text}
                                rows={3}
                                maxLength={8_000}
                                onChange={(event) => setText(event.target.value)}
                                disabled={!!operation}
                            />
                        </label>
                        {isConfirmation && !canSend && <p>{tx("Review a matching proposal before confirming it.")}</p>}
                        {!plan && <p>{tx("You can confirm a run proposal here.")}</p>}
                        <button type="submit" disabled={busy || !canSend}>
                            {tx("Send")}
                        </button>
                    </form>
                )}
        </article>
    );
}
