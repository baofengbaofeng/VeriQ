/**
 * 后台任务按员工、工作区和会话独立读取，用户切换会话会取消轮询和写入回执，停止跟进只影响对应任务。
 */
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { tx } from "../../locale";
import { useOperationFeedback } from "../../operation-feedback";
import { agentErrorCode, observeAgentRead, type AgentSchemas, type CloudAgentAdapter } from "./adapters";
import { AgentError, agentOperationError, agentProblem } from "./feedback";

type Task = AgentSchemas["AgentTask"];
type TaskScope = {
    owner: string;
    workspaceId: string;
    sessionId: string;
    signal: AbortSignal;
    adapter: CloudAgentAdapter;
    onReadDenied: (error: unknown) => void;
    enabled: boolean;
};

const active = (task: Task) => task.state === "QUEUED" || task.state === "FOLLOWING" || task.state === "ANALYZING";
const states = {
    QUEUED: "Queued for follow-up",
    FOLLOWING: "Following run",
    ANALYZING: "Analyzing run",
    COMPLETED: "Follow-up complete",
    STOPPED: "Stopped following",
    FAILED: "Follow-up failed",
} satisfies Record<Task["state"], string>;

/**
 * 列表和任务写入共享本会话的取消边界，任务的运行时间独立于单次接口请求，主对话可以继续发送消息。
 */
export function useAgentTasks({ owner, workspaceId, sessionId, signal, adapter, onReadDenied, enabled }: TaskScope) {
    const key = ["workspace", workspaceId, "agent", owner, "session", sessionId, "tasks"];
    const cache = useQueryClient();
    const { showFailure } = useOperationFeedback();
    const mutation = useRef(false);
    const [busy, setBusy] = useState(false);
    const requests = useRef(new Map<string, { requestId: string; previousTaskId?: string; analyze: boolean }>());
    const query = useQuery({
        queryKey: key,
        enabled,
        queryFn: ({ signal: request }) => {
            const scope = AbortSignal.any([signal, request]);
            return observeAgentRead(adapter.tasks(sessionId, scope), scope, onReadDenied);
        },
        refetchOnMount: "always",
        refetchInterval: (query) => (query.state.data?.items.some(active) ? 2_000 : 8_000),
    });
    const items = enabled && query.isSuccess && query.isFetchedAfterMount ? query.data.items : undefined;

    async function update(send: () => Promise<Task>) {
        if (!items || mutation.current || signal.aborted) return;
        mutation.current = true;
        setBusy(true);
        try {
            const task = await send();
            signal.throwIfAborted();
            await cache.cancelQueries({ queryKey: key, exact: true });
            signal.throwIfAborted();
            requests.current.delete(task.runId);
            cache.setQueryData<AgentSchemas["AgentTaskCollection"]>(key, (page) => ({
                items: [task, ...(page?.items ?? []).filter((previous) => previous.id !== task.id)],
            }));
        } catch (failure) {
            if (!signal.aborted) {
                if (agentErrorCode(failure) === "AUTHENTICATION_REQUIRED") onReadDenied(failure);
                else showFailure(agentOperationError(failure));
            }
        } finally {
            mutation.current = false;
            if (!signal.aborted) {
                setBusy(false);
                void query.refetch();
            }
        }
    }

    function follow(runId: string, analyze = false) {
        void update(() => {
            // 请求应答丢失时沿用同一编号，服务器若已记录新的任务，后续重新跟进则登记一次新的手动委托。
            const previousTaskId = items?.find((task) => task.runId === runId)?.id;
            const pending = requests.current.get(runId);
            const requestId =
                pending && pending.analyze === analyze && pending.previousTaskId === previousTaskId
                    ? pending.requestId
                    : crypto.randomUUID();
            requests.current.set(runId, { requestId, previousTaskId, analyze });
            return adapter.follow(sessionId, { requestId, runId, ...(analyze ? { analyze: true } : {}) }, signal);
        });
    }

    return {
        items,
        error: query.error,
        retry: () => void query.refetch(),
        busy,
        follow,
        canFollow: (runId: string) => !!items && !items.some((task) => task.runId === runId && active(task)),
        stop: (taskId: string) => void update(() => adapter.stopFollowing(sessionId, taskId, signal)),
    };
}

/**
 * 同一运行可以有多次独立跟进，历史按服务端返回的任务标识展示，只有当前活跃的任务提供停止入口。
 */
export function BackgroundTasks({
    tasks,
    editable,
    canReadAnalysis,
}: {
    tasks: ReturnType<typeof useAgentTasks>;
    editable: boolean;
    canReadAnalysis: boolean;
}) {
    if (tasks.error) return <AgentError error={tasks.error} retry={tasks.retry} />;
    if (!tasks.items?.length) return null;
    return (
        <section className="vq-agent-card" aria-label={tx("Background tasks")}>
            <h4>{tx("Background tasks")}</h4>
            <ul>
                {tasks.items.map((task) => (
                    <li key={task.id}>
                        <code>{task.runId}</code>
                        <p>
                            {tx(states[task.state])} ·{" "}
                            {tx(task.mode === "AUTO" ? "Automatic delegation" : "Manual delegation")}
                        </p>
                        {task.outcome && <p>{task.outcome}</p>}
                        {canReadAnalysis && task.analysis && (
                            <>
                                <h5>{tx("Run analysis")}</h5>
                                <p>{task.analysis.basis}</p>
                                <ul>
                                    {[...new Set(task.analysis.suggestions)].map((suggestion) => (
                                        <li key={suggestion}>{suggestion}</li>
                                    ))}
                                </ul>
                            </>
                        )}
                        {task.errorCode && <p>{agentProblem(task.errorCode)}</p>}
                        {editable && active(task) && (
                            <button type="button" disabled={tasks.busy} onClick={() => tasks.stop(task.id)}>
                                {tx("Stop following")}
                            </button>
                        )}
                    </li>
                ))}
            </ul>
        </section>
    );
}
