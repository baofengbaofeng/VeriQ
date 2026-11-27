/**
 * 会话的 Run 关联只用于定位真实授权报告。一个会话最多由最新的非终态卡片使用实时订阅，其余卡片读取各自报告快照。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api";
import { tx } from "../../locale";
import type { ReportAdapter, RunReport } from "../reports/adapters";
import { agentErrorCode, agentWorkspaceReadDenied, observeAgentRead, type AgentSchemas } from "./adapters";
import { AgentError } from "./feedback";

type Receipt = AgentSchemas["AgentReceipt"];

/**
 * 父级根据时间线去重后的运行项只提供标识，报告卡仍需从现有报告服务读取并检查工作区和运行关系。
 */
export interface RunReference {
    id: string;
    decision?: Extract<Receipt, { type: "TRIGGER_PLAN" }>["decision"];
}

/**
 * 工作区报告入口可由 Web 渲染为链接、由 Electron 切换本机页面，仅在取得被授权的真实报告后呈现。
 */
export type ReportNavigation = (runId: string) => React.ReactNode;

const matching = (workspaceId: string, runId: string, report: RunReport) => {
    if (report.run.id !== runId || report.run.workspaceId !== workspaceId) throw new Error("REPORT_CONTEXT_MISMATCH");
    return report;
};

// Web 提供标准 HTTP Problem，桌面保留授权代号；任一来源已明确拒绝时都要隐藏此前缓存的报告和跳转入口。
function accessDenied(error: unknown): boolean {
    const code = agentErrorCode(error);
    return (
        (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) ||
        agentWorkspaceReadDenied(error) ||
        code === "REPORT_EXPIRED" ||
        code === "RUN_NOT_FOUND"
    );
}

/**
 * 为已读取的工作区 Run 显示派发回执、用例进度和真实门禁。订阅失效保留已授权的最近快照并提供恢复入口。
 */
export function RunCard({
    workspaceId,
    owner,
    run,
    reports,
    signal,
    onWorkspaceReadDenied,
    focused,
    navigate,
    reportTerminal,
    follow,
    analyze,
    followingBusy,
}: {
    workspaceId: string;
    owner: string;
    run: RunReference;
    reports: Pick<ReportAdapter, "report" | "subscribe">;
    signal: AbortSignal;
    onWorkspaceReadDenied: (error: unknown) => void;
    focused: boolean;
    navigate: ReportNavigation;
    follow?: () => void;
    analyze?: () => void;
    followingBusy: boolean;
    reportTerminal: (id: string, terminal: boolean) => void;
}) {
    const id = run.id;
    const cache = useQueryClient();
    const [streamError, setStreamError] = useState<unknown>();
    const generation = useRef(0);
    const [refreshSignal, setRefreshSignal] = useState(() => new AbortController());
    const key = useMemo(() => ["workspace", workspaceId, "agent", owner, "report", id], [workspaceId, owner, id]);
    const report = useQuery({
        queryKey: key,
        queryFn: async ({ signal: request }) => {
            const version = generation.current;
            const active = AbortSignal.any([signal, request]);
            const value = await observeAgentRead(reports.report(id, active), active, onWorkspaceReadDenied);
            const snapshot = matching(workspaceId, id, value);
            // 拥有本次读请求时记录的代际用于阻止慢 GET 覆盖已到达的较新 SSE 帧，显式刷新则停止旧流后重新读取。
            if (version !== generation.current) return cache.getQueryData<RunReport>(key) ?? snapshot;
            return snapshot;
        },
        refetchInterval: (snapshot) =>
            !focused && snapshot.state.data && snapshot.state.data.run.state !== "FINISHED" ? 8_000 : false,
        refetchOnWindowFocus: (snapshot) => !focused || !snapshot.state.data,
    });
    const loaded = !!report.data;
    const terminal = report.data?.run.state === "FINISHED";
    const streaming = focused && loaded && !terminal && !report.error && !report.isFetching;
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
                    const current = matching(workspaceId, id, next);
                    generation.current += 1;
                    cache.setQueryData(key, current);
                    if (next.run.state === "FINISHED") lifetime.abort();
                },
                active,
            )
            .catch(async (error: unknown) => {
                if (active.aborted) {
                    return;
                }
                const workspaceDenied = agentWorkspaceReadDenied(error);
                if (workspaceDenied && error instanceof ApiError) {
                    onWorkspaceReadDenied(error);
                    return;
                }
                setStreamError(error);
                // 桌面开流可能仅从状态推导错误代号，缺少授权码的帧也只说明流受限；以当前报告读取复核工作区。
                if (workspaceDenied || agentErrorCode(error) === "REPORT_ACCESS_CHANGED") {
                    try {
                        await observeAgentRead(reports.report(id, active), active, onWorkspaceReadDenied);
                    } catch (failure) {
                        // 报告读取若明确拒绝，只更新卡片的受限原因；临时传输中断仍保留已经观察到的首次订阅限制。
                        if (!active.aborted && accessDenied(failure)) {
                            setStreamError(failure);
                        }
                    }
                }
            });
        return () => lifetime.abort();
    }, [streaming, reports, id, signal, cache, key, workspaceId, refreshSignal, onWorkspaceReadDenied]);

    // 根据报告快照通知父级当前运行是否到达终态，以便把独占订阅名额转给尚未结束的其他运行。
    useEffect(() => {
        if (loaded) reportTerminal(id, terminal);
    }, [id, loaded, reportTerminal, terminal]);

    // 显式刷新先关闭旧订阅再读取授权快照，避免延迟快照覆盖同一次运行已经观察到的权威终态。
    const refresh = async () => {
        refreshSignal.abort();
        await report.refetch();
        if (!signal.aborted) setRefreshSignal(new AbortController());
    };
    const problem = report.error ?? streamError;
    const inaccessible = accessDenied(report.error) || accessDenied(streamError);
    const value = inaccessible ? undefined : report.data;
    const finished = value?.cases.filter((item) => item.state === "FINISHED").length;
    return (
        <section className="vq-agent-card vq-agent-run" aria-label={tx("Run status")}>
            <h4>{tx("Run status")}</h4>
            <p>
                <code>{id}</code>
                {run.decision && <> · {run.decision}</>}
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
                    {!terminal && follow && (
                        <button type="button" onClick={follow} disabled={followingBusy}>
                            {tx("Follow in background")}
                        </button>
                    )}
                    {analyze && (
                        <button type="button" onClick={analyze} disabled={followingBusy}>
                            {tx("Analyze in background")}
                        </button>
                    )}
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
