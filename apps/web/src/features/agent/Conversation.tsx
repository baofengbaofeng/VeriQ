/**
 * 单条会话拥有自己的读写和报告取消边界。先显示服务器记录的轮次顺序，重新读取后以权威状态补齐正在处理的试验。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { tx } from "../../locale";
import type { Workspace } from "../../api";
import type { ReportAdapter } from "../reports/adapters";
import type { AgentSchemas, CloudAgentAdapter } from "./adapters";
import { AgentError, agentProblem } from "./feedback";
import { Proposal, ActionReceipt } from "./Proposal";
import { RunCard, type ReportNavigation, type RunReference } from "./RunCard";

type Turn = AgentSchemas["AgentTurnDTO"];
type Session = AgentSchemas["AgentSessionDTO"];
type Submission = AgentSchemas["AgentTurnSubmit"];

// 这三组文案对应服务端确定性短语，仅用于启用当前角色的发送操作；服务器仍验证动作和会话权限。
const confirmAny = new Set(["confirm", "confirm action", "确认", "确认操作"]);
const confirmSave = new Set(["confirm plan", "confirm save", "确认保存"]);
const confirmRun = new Set(["confirm run", "确认执行", "确认运行"]);

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
 * 对话收集用户输入、显示持久化历史并确认当前提议。角色和归档状态只控制界面入口，业务授权由服务器逐次重新验证。
 */
export function Conversation({
    workspace,
    owner,
    initial,
    initialMessage,
    adapter,
    reports,
    parentSignal,
    navigate,
    onArchived,
}: {
    workspace: Workspace;
    owner: string;
    initial: Session;
    initialMessage: string;
    adapter: CloudAgentAdapter;
    reports: Pick<ReportAdapter, "report" | "subscribe">;
    parentSignal: AbortSignal;
    navigate: ReportNavigation;
    onArchived: () => void;
}) {
    const [lifetime] = useState(() => new AbortController());
    const signal = useMemo(() => AbortSignal.any([parentSignal, lifetime.signal]), [parentSignal, lifetime]);
    useEffect(() => () => lifetime.abort(), [lifetime]);

    const [text, setText] = useState(initialMessage);
    const [error, setError] = useState<unknown>();
    const [operation, setOperation] = useState<"send" | "confirm" | "archive">();
    const previousSubmission = useRef<Submission>();
    const mutation = useRef(false);
    const [updates, setUpdates] = useState(() => new Map<string, Turn>());
    const [completedRuns, setCompletedRuns] = useState(() => new Set<string>());
    const id = initial.id;
    const key = ["workspace", workspace.id, "agent", owner, "session", id];
    const current = useQuery({
        queryKey: key,
        queryFn: ({ signal: request }) => adapter.session(id, AbortSignal.any([signal, request])),
    });
    const history = useInfiniteQuery({
        queryKey: [...key, "turns"],
        queryFn: ({ pageParam, signal: request }) => adapter.turns(id, pageParam, AbortSignal.any([signal, request])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: (query) => {
            const loaded = query.state.data?.pages.flatMap((page) => page.items) ?? [];
            return mergeTurns(loaded, updates).some((turn) => turn.status === "RUNNING") ? 2_000 : false;
        },
    });
    const session = current.data ?? initial;
    const editable = !workspace.archived && !session.archived;
    const plan = editable && ["OWNER", "ADMIN", "EDITOR"].includes(workspace.role);
    const execute = editable && workspace.role !== "VIEWER";
    const turns = mergeTurns(history.data?.pages.flatMap((page) => page.items) ?? [], updates);
    const latest = turns.filter((turn) => turn.proposal && turn.status === "COMPLETED").at(-1);
    const running = turns.some((turn) => turn.status === "RUNNING");
    const references = runReferences(turns);
    const focused = references.filter((run) => !completedRuns.has(run.id)).at(-1)?.id;
    const confirmationText = text
        .trim()
        .toLowerCase()
        .replace(/[.!。！]+$/, "");
    const mayConfirmText =
        latest?.proposal?.type === "SAVE_PLAN"
            ? plan && (confirmAny.has(confirmationText) || confirmSave.has(confirmationText))
            : !!latest?.proposal && execute && (confirmAny.has(confirmationText) || confirmRun.has(confirmationText));
    const canSend = !!text.trim() && (plan || mayConfirmText);
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
                setError(failure);
                void refresh();
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
        const data =
            previousSubmission.current?.text === text
                ? previousSubmission.current
                : {
                      text,
                      requestId: crypto.randomUUID(),
                  };
        previousSubmission.current = data;
        void act("send", async () => {
            const turn = await adapter.submit(id, data, signal);
            signal.throwIfAborted();
            previousSubmission.current = undefined;
            setText("");
            receive(turn);
        });
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
                                <button type="button" disabled={busy} onClick={() => setText(turn.text)}>
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
                    focused={run.id === focused}
                    navigate={navigate}
                    reportTerminal={reportTerminal}
                />
            ))}
            <AgentError error={error} />
            {operation === "send" && <p role="status">{tx("Submitting message…")}</p>}
            {operation === "confirm" && <p role="status">{tx("Confirming action…")}</p>}
            {execute && (plan || (latest?.proposal && latest.proposal.type !== "SAVE_PLAN")) && (
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
                    {!plan && <p>{tx("You can confirm a run proposal here.")}</p>}
                    <button type="submit" disabled={busy || !canSend}>
                        {tx("Send")}
                    </button>
                </form>
            )}
        </article>
    );
}
