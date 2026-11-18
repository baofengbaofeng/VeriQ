/**
 * 会话的 Run 关联只用于定位真实授权报告。一个会话最多由最新的非终态卡片使用实时订阅，其余卡片读取各自报告快照。
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api";
import { tx } from "../../locale";
import type { ReportAdapter, RunReport } from "../reports/adapters";
import { agentErrorCode, type AgentSchemas } from "./adapters";
import { AgentError } from "./feedback";

type Receipt = AgentSchemas["AgentReceipt"];

/**
 * 父级根据时间线去重后的运行项只提供标识，报告卡仍需从现有报告服务读取并检查工作区和运行关系。
 */
export interface RunReference {
    id: string;
    receipt?: Exclude<Receipt, { type: "SAVE_PLAN" }>;
}

/**
 * 工作区报告入口可由 Web 渲染为链接、由 Electron 切换本机页面，仅在取得被授权的真实报告后呈现。
 */
export type ReportNavigation = (runId: string) => React.ReactNode;

const matching = (workspaceId: string, runId: string, report: RunReport) => {
    if (report.run.id !== runId || report.run.workspaceId !== workspaceId) throw new Error("REPORT_CONTEXT_MISMATCH");
    return report;
};

/**
 * 为已读取的工作区 Run 显示派发回执、用例进度和真实门禁。订阅失效保留已授权的最近快照并提供恢复入口。
 */
export function RunCard({
    workspaceId,
    owner,
    run,
    reports,
    signal,
    focused,
    navigate,
    reportTerminal,
}: {
    workspaceId: string;
    owner: string;
    run: RunReference;
    reports: Pick<ReportAdapter, "report" | "subscribe">;
    signal: AbortSignal;
    focused: boolean;
    navigate: ReportNavigation;
    reportTerminal: (id: string, terminal: boolean) => void;
}) {
    const id = run.id;
    const cache = useQueryClient();
    const [streamError, setStreamError] = useState<unknown>();
    const [refreshSignal, setRefreshSignal] = useState(() => new AbortController());
    const key = useMemo(() => ["workspace", workspaceId, "agent", owner, "report", id], [workspaceId, owner, id]);
    const report = useQuery({
        queryKey: key,
        queryFn: async ({ signal: request }) =>
            matching(workspaceId, id, await reports.report(id, AbortSignal.any([signal, request]))),
        refetchInterval: (snapshot) =>
            !focused && snapshot.state.data && snapshot.state.data.run.state !== "FINISHED" ? 8_000 : false,
        refetchOnWindowFocus: (snapshot) => !focused || !snapshot.state.data,
    });
    const loaded = !!report.data;
    const terminal = report.data?.run.state === "FINISHED";
    const streaming = focused && !!report.data && !terminal && !report.error;
    useEffect(() => {
        if (!streaming) return;
        const lifetime = new AbortController();
        const active = AbortSignal.any([signal, lifetime.signal, refreshSignal.signal]);
        setStreamError(undefined);
        // 订阅只在首份授权快照到达后启动，避免较慢的初始读取覆盖已接收的更新；终态主体由同一报告源提供。
        void reports
            .subscribe(
                id,
                (next) => {
                    if (active.aborted) return;
                    cache.setQueryData(key, matching(workspaceId, id, next));
                    if (next.run.state === "FINISHED") lifetime.abort();
                },
                active,
            )
            .catch((error: unknown) => {
                if (!active.aborted) setStreamError(error);
            });
        return () => lifetime.abort();
    }, [streaming, reports, id, signal, cache, key, workspaceId, refreshSignal]);

    // 把权威终态通知展现层以释放监听位置，让更早的仍活动运行可以获得后续订阅。
    useEffect(() => {
        if (loaded) reportTerminal(id, terminal);
    }, [id, loaded, reportTerminal, terminal]);

    // 刷新先关闭旧流再取新的授权快照，避免延迟初始数据覆盖已经观察到的终态。
    const refresh = async () => {
        refreshSignal.abort();
        await report.refetch();
        if (!signal.aborted) setRefreshSignal(new AbortController());
    };
    const problem = report.error ?? streamError;
    const code = agentErrorCode(problem);
    const inaccessible =
        (problem instanceof ApiError && [401, 403, 404, 410].includes(problem.status)) ||
        ["WORKSPACE_FORBIDDEN", "REPORT_EXPIRED", "AUTHENTICATION_REQUIRED", "RUN_NOT_FOUND"].includes(code ?? "");
    const value = inaccessible ? undefined : report.data;
    const finished = value?.cases.filter((item) => item.state === "FINISHED").length;
    return (
        <section className="vq-agent-card vq-agent-run" aria-label={tx("Run status")}>
            <h4>{tx("Run status")}</h4>
            <p>
                <code>{id}</code>
                {run.receipt?.type === "TRIGGER_PLAN" && <> · {run.receipt.decision}</>}
            </p>
            {report.isPending && <p role="status">{tx("Reading Run status…")}</p>}
            <AgentError error={problem} />
            {value && (
                <>
                    <p role="status">
                        <strong>{value.run.state}</strong>
                        {value.run.outcome && <> · {value.run.outcome}</>}
                        {value.run.reasonCode && <> · {value.run.reasonCode}</>}
                    </p>
                    <p>
                        {tx("Cases finished")} {finished} / {value.statistics.caseCount}
                        {" · "}
                        {tx("Passed first attempt")} {value.statistics.firstPassCount}
                        {" · "}
                        {tx("Passed after retry")} {value.statistics.retryPassCount}
                        {" · "}
                        {tx("Infrastructure errors")} {value.statistics.infrastructureErrorCount}
                    </p>
                    <p>
                        {tx("Gate at execution")} {value.gateAtExecution.passed ? "PASS" : "BLOCKED"}
                        {" · "}
                        {tx("Current gate")} {value.gateNow.passed ? "PASS" : "BLOCKED"}
                    </p>
                    {navigate(id)}
                </>
            )}
            {(!terminal || report.error || !!streamError) && (
                <button type="button" disabled={report.isFetching} onClick={() => void refresh()}>
                    {tx("Refresh run status")}
                </button>
            )}
        </section>
    );
}
