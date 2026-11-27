/**
 * 报告页：按 Workspace 列出 Run，选中后加载报告、时间线、证据与审计。SSE 断开后按 signal 停止重连。
 * CloudReportAdapter(selected)；订阅随 Workspace signal abort。
 */

import { tx, useAppLocale } from "../../locale";
import {
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Auth } from "../../auth-context";
import { Button } from "../../components/Button";
import { useOperationFeedback } from "../../operation-feedback";
import { Panel } from "../../ui";
import { canExportWorkspaceTable, collectTablePages, DataTable, useTableView } from "../../table-view";
import { useWorkspaceDirectory, WorkspaceStatus } from "../workspaces/WorkspaceDirectory";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import {
    CloudReportAdapter,
    reportAuthentication,
    type ReportAdapter,
    type ReportArtifact,
    type RunReport,
    type ReportEvent,
} from "./adapters";
import { reportI18n } from "./i18n";
import "./reports.css";
const useLabels = () => useTranslation("reports", { i18n: reportI18n }).t;
const shown = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2));
const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

// 版本较旧的报告可能包含当前枚举表没有的状态，展示已知状态的翻译并原样保留未知的技术值。
const reportCode = (t: ReturnType<typeof useLabels>, group: string, value: unknown, fallback: string) =>
    typeof value === "string" ? t(`${group}.${value}`, { defaultValue: value }) : fallback;
/**
 * 报告历史跟随顶栏空间，链接中的运行标识只交给已确认授权的目标；身份、空间或运行变化会重建视图。
 */
export function ReportPage() {
    useAppLocale();
    const { user } = useContext(Auth);
    const { workspace, requested } = useWorkspaceDirectory();
    const { selected, signal } = useWorkspace();
    const t = useLabels();
    const [params] = useSearchParams();
    const initialRunId = requested ? (params.get("runId") ?? "") : "";
    const adapter = useMemo(() => new CloudReportAdapter(selected), [selected]);
    if (!user) return <Navigate to="/login" />;
    return (
        <Panel title={t("reports")}>
            <WorkspaceStatus />
            {workspace && (
                <ReportWorkspaceView
                    initialRunId={initialRunId}
                    key={`${user.id}/${selected}/${initialRunId}`}
                    adapter={adapter}
                    signal={signal}
                    rawEvidenceAllowed={["OWNER", "ADMIN"].includes(workspace.role)}
                    allowTableExport={canExportWorkspaceTable(workspace.role)}
                />
            )}
        </Panel>
    );
}
/**
 * 运行清单先读取授权空间的游标页，再按标识、来源、状态和结果搜索；筛选与分页不影响已打开报告的历史订阅。
 */
export function ReportWorkspaceView({
    initialRunId = "",
    adapter,
    signal,
    rawEvidenceAllowed = false,
    allowTableExport = false,
}: {
    initialRunId?: string;
    adapter: ReportAdapter;
    signal?: AbortSignal;
    rawEvidenceAllowed?: boolean;
    allowTableExport?: boolean;
}) {
    const { language } = useAppLocale();
    const t = useLabels(),
        [selected, setSelected] = useState(initialRunId);
    const runs = useQuery({
        queryKey: ["workspace", "reports", adapter],
        queryFn: ({ signal: querySignal }) =>
            collectTablePages(
                (cursor, activeSignal) => adapter.list(cursor, activeSignal),
                signal ? AbortSignal.any([querySignal, signal]) : querySignal,
            ),
    });
    const audit = useQuery({
        queryKey: ["workspace", "report-audit", adapter],
        queryFn: ({ signal }) => adapter.audit(undefined, signal),
    });
    const runView = useTableView(runs.data ?? [], {
        scope: adapter,
        // 运维可直接粘贴平台接口的原始标识，操作员也可使用界面中当前语言的来源、状态或结果文字查找。
        matches: (run, term) =>
            [
                run.id,
                run.source,
                run.state,
                run.outcome ?? "",
                tx(`Run source: ${run.source}`),
                tx(`Run state: ${run.state}`),
                run.outcome ? tx(`Run outcome: ${run.outcome}`) : tx("Pending"),
            ].some((value) => value.toLowerCase().includes(term)),
    });
    const formatDate = (value: string) => new Date(value).toLocaleString(language, { timeZone: "Asia/Shanghai" });
    return (
        <div className="veriq-reports">
            <h2 className="report-history-heading">{t("history")}</h2>
            {runs.error && (
                <div>
                    <p role="alert">{runs.error.message}</p>
                    <Button size="compact" tone="secondary" onClick={() => void runs.refetch()}>
                        {t("retry")}
                    </Button>
                </div>
            )}
            {runs.isPending && <p role="status">{t("loading")}</p>}
            {(runs.isSuccess || runView.filteredCount > 0) && (
                <DataTable
                    label={t("history")}
                    view={runView}
                    searchLabel={t("runSearch")}
                    paginationLabel={t("history")}
                    busy={runs.isFetching || runs.isError}
                    exportAllowed={allowTableExport}
                    exportColumns={[
                        { label: t("runId"), value: ({ id }) => id },
                        { label: tx("Created"), value: ({ createdAt }) => formatDate(createdAt) },
                        { label: t("runSource"), value: ({ source }) => tx(`Run source: ${source}`) },
                        { label: tx("Status"), value: ({ state }) => tx(`Run state: ${state}`) },
                        {
                            label: t("runOutcome"),
                            value: ({ outcome }) => (outcome ? tx(`Run outcome: ${outcome}`) : tx("Pending")),
                        },
                    ]}
                >
                    {/* biome-ignore lint/a11y/noNoninteractiveTabindex: 为键盘用户保留独立的历史表格横向滚动位置。 */}
                    <section className="table-scroll" aria-label={t("history")} tabIndex={0}>
                        <table className="report-history-table" aria-label={t("history")}>
                            <colgroup>
                                <col className="report-history-id" />
                                <col className="report-history-time" />
                                <col className="report-history-source" />
                                <col className="report-history-status" />
                                <col className="report-history-outcome" />
                            </colgroup>
                            <thead>
                                <tr>
                                    <th scope="col">{t("runId")}</th>
                                    <th scope="col">{tx("Created")}</th>
                                    <th scope="col">{t("runSource")}</th>
                                    <th scope="col">{tx("Status")}</th>
                                    <th scope="col">{t("runOutcome")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {runView.filteredCount === 0 && (
                                    <tr>
                                        <td className="vq-table-empty" colSpan={5}>
                                            {t(runs.data?.length ? "runNoMatches" : "empty")}
                                        </td>
                                    </tr>
                                )}
                                {runView.rows.map((run) => (
                                    <tr key={run.id}>
                                        <td>
                                            <Button
                                                size="compact"
                                                tone="secondary"
                                                aria-pressed={selected === run.id}
                                                onClick={() => setSelected(run.id)}
                                            >
                                                {run.id}
                                            </Button>
                                        </td>
                                        <td>
                                            <time dateTime={run.createdAt}>{formatDate(run.createdAt)}</time>
                                        </td>
                                        <td>{tx(`Run source: ${run.source}`)}</td>
                                        <td>{tx(`Run state: ${run.state}`)}</td>
                                        <td>{run.outcome ? tx(`Run outcome: ${run.outcome}`) : tx("Pending")}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </section>
                </DataTable>
            )}
            {selected ? (
                <ReportView
                    key={selected}
                    adapter={adapter}
                    runId={selected}
                    signal={signal}
                    rawEvidenceAllowed={rawEvidenceAllowed}
                />
            ) : (
                <p>{t("select")}</p>
            )}
            <details>
                <summary>{t("audit")}</summary>
                {audit.error && <p role="alert">{audit.error.message}</p>}
                <ul>
                    {audit.data?.items.map((item) => (
                        <li key={item.id}>
                            {item.createdAt} · {item.action} · {item.actorId ?? tx("Service")} · {item.targetId}
                        </li>
                    ))}
                </ul>
            </details>
        </div>
    );
}
/**
 * 单个 Run 的报告主体：门禁、用例树、Attempt 事件、证据下载与审计片段。原始证据区按角色条件渲染；原始证据区仅对 Owner
 * 或 Admin 角色展开。
 * subscribe 更新 report 头；history 按 after 增量追加，不做 Playwright 重试展示。
 */
export function ReportView({
    adapter,
    runId,
    signal,
    rawEvidenceAllowed = false,
}: {
    adapter: ReportAdapter;
    runId: string;
    signal?: AbortSignal;
    rawEvidenceAllowed?: boolean;
}) {
    useAppLocale();
    const t = useLabels(),
        [report, setReport] = useState<RunReport>(),
        [error, setError] = useState(""),
        [attemptId, setAttempt] = useState(""),
        [generation, setGeneration] = useState(0),
        [restart, setRestart] = useState(0),
        [caseLimit, setCaseLimit] = useState(25);
    const retry = () => {
        setError("");
        setReport(undefined);
        setRestart((r) => r + 1);
    };
    // 订阅始终占据同一子节点位置，报告由加载态变为成功态时不能重挂载；只有显式 Retry 的 key 改变才结束旧订阅，并保留父
    // 组件拥有的选中项和分页数量。
    const subscription = (
        <ReportSubscription
            key={restart}
            adapter={adapter}
            runId={runId}
            signal={signal}
            setReport={setReport}
            setError={setError}
            setGeneration={setGeneration}
        />
    );
    if (!report)
        return (
            <>
                {subscription}
                <div>
                    <p role={error ? "alert" : "status"}>{error ? tx(error) : t("loading")}</p>
                    {error && (
                        <Button size="compact" tone="secondary" onClick={retry}>
                            {t("retry")}
                        </Button>
                    )}
                </div>
            </>
        );
    return (
        <>
            {subscription}
            <section aria-label={tx("Run report")}>
                <h2>
                    {report.run.outcome
                        ? tx(`Run outcome: ${report.run.outcome}`)
                        : tx(`Run state: ${report.run.state}`)}{" "}
                    · {tx(`Run source: ${report.run.source}`)}
                </h2>
                <p>
                    {t("gateAt")}: <strong>{t(report.gateAtExecution.passed ? "gatePass" : "gateBlocked")}</strong>
                    {" · "}
                    {t("gateNow")}: <strong>{t(report.gateNow.passed ? "gatePass" : "gateBlocked")}</strong>
                </p>
                {!report.gateNow.passed && <p>{report.gateNow.reasons.join(", ")}</p>}
                <p>
                    {`${t("cases")}: ${report.statistics.caseCount} · ` +
                        `${t("firstPass")}: ${report.statistics.firstPassCount} · ` +
                        `${t("retryPass")}: ${report.statistics.retryPassCount} · ${t("infra")}: ` +
                        `${report.statistics.infrastructureErrorCount}`}
                </p>
                {report.cases.slice(0, caseLimit).map((c) => (
                    <CaseCard key={c.id} value={c} runId={runId} adapter={adapter} choose={setAttempt} />
                ))}
                {report.cases.length > caseLimit && (
                    <Button size="compact" tone="secondary" onClick={() => setCaseLimit((n) => n + 25)}>
                        {t("moreCases")}
                    </Button>
                )}
                <details>
                    <summary>{t("technical")}</summary>
                    <p>
                        {tx("Run ")}
                        {runId}
                    </p>
                    <pre>{JSON.stringify(report.run, null, 2)}</pre>
                </details>
                {attemptId && (
                    <AttemptDetails
                        key={attemptId + restart}
                        adapter={adapter}
                        runId={runId}
                        attemptId={attemptId}
                        generation={generation}
                        signal={signal}
                        rawEvidenceAllowed={rawEvidenceAllowed}
                    />
                )}
            </section>
        </>
    );
}
function ReportSubscription({
    adapter,
    runId,
    signal,
    setReport,
    setError,
    setGeneration,
}: {
    adapter: ReportAdapter;
    runId: string;
    signal?: AbortSignal;
    setReport: Dispatch<SetStateAction<RunReport | undefined>>;
    setError: Dispatch<SetStateAction<string>>;
    setGeneration: Dispatch<SetStateAction<number>>;
}) {
    useAppLocale();
    // 首个流快照接管本代报告后取消初始读取，使迟到的快照及其传输层认证错误都失效；流继续使用视图的生命周期信号。
    useEffect(() => {
        const lifetime = new AbortController();
        const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
        const snapshot = new AbortController();
        const initial = AbortSignal.any([active, snapshot.signal]);
        void adapter
            .report(runId, initial)
            .then((r) => {
                if (!initial.aborted) setReport(r);
            })
            .catch((e) => {
                if (!initial.aborted) setError(e instanceof Error ? e.message : String(e));
            });
        void adapter
            .subscribe(
                runId,
                (r) => {
                    if (!active.aborted) {
                        snapshot.abort();
                        setReport(r);
                        setGeneration((g) => g + 1);
                    }
                },
                active,
            )
            .catch((e) => {
                if (!active.aborted) {
                    setError(e instanceof Error ? e.message : String(e));
                    setReport(undefined);
                    lifetime.abort();
                }
            });
        return () => lifetime.abort();
    }, [adapter, runId, signal, setReport, setError, setGeneration]);
    return null;
}

function CaseCard({
    value,
    adapter,
    runId,
    choose,
}: {
    value: RunReport["cases"][number];
    adapter: ReportAdapter;
    runId: string;
    choose: (id: string) => void;
}) {
    useAppLocale();
    const t = useLabels();
    const first = value.attempts[0]?.id;
    const metadata = useQuery({
        queryKey: ["workspace", "report-display", adapter, runId, first],
        queryFn: ({ signal }) => adapter.display(runId, first!, signal),
        enabled: !!first,
    });
    return (
        <section className="report-case">
            <h3>
                {metadata.data?.display
                    ? `${metadata.data.display.title} (${metadata.data.display.caseKey})`
                    : t("labelsAbsent")}{" "}
                · {reportCode(t, "status", value.outcome ?? value.state, t("unknown"))}
            </h3>
            {metadata.error && <p role="alert">{metadata.error.message}</p>}
            {metadata.data && (
                <p>
                    {t("environment")}: {metadata.data.environment.browser ?? "—"} ·{" "}
                    {metadata.data.environment.baseURL ?? "—"} · {metadata.data.environment.locale ?? "—"} /{" "}
                    {metadata.data.environment.timezone ?? "—"}
                </p>
            )}
            {!value.attempts.length && <p>{t("noAttempt")}</p>}
            {value.attempts.map((a) => (
                <article key={a.id}>
                    <Button size="compact" tone="secondary" onClick={() => choose(a.id)}>
                        {t("attempt")} {a.attemptNo} · {reportCode(t, "status", a.outcome ?? a.phase, t("unknown"))}
                    </Button>
                    <p>
                        {t("business")}: {reportCode(t, "status", a.facts.business, t("unknown"))}
                        {" · "}
                        {t("cleanup")}: {reportCode(t, "status", a.facts.cleanup, t("unknown"))}
                        {" · "}
                        {t("evidence")}: {reportCode(t, "status", a.facts.evidence, t("unknown"))}
                    </p>
                    {a.activatedAt && a.finishedAt && (
                        <p>
                            {t("duration")}: {new Date(a.finishedAt).getTime() - new Date(a.activatedAt).getTime()} ms
                        </p>
                    )}
                    {typeof a.facts.errorCode === "string" && <p role="status">{a.facts.errorCode}</p>}
                    {a.compensations.length > 0 && (
                        <p>
                            {t("compensation")}:{" "}
                            {a.compensations
                                .map((c) =>
                                    [c.state, c.outcome]
                                        .filter((value) => value !== null)
                                        .map((value) => reportCode(t, "status", value, t("unknown")))
                                        .join(" · "),
                                )
                                .join(", ")}
                        </p>
                    )}
                    <details>
                        <summary>{t("technical")}</summary>
                        <p>
                            {a.createdAt} {tx(" · Runtime ")}
                            {a.runtimeId}
                        </p>
                        <pre>
                            {JSON.stringify(
                                {
                                    versionId: value.caseVersionId,
                                    variant: value.provenance,
                                    provenance: a.provenance,
                                    facts: a.facts,
                                },
                                null,
                                2,
                            )}
                        </pre>
                    </details>
                </article>
            ))}
        </section>
    );
}
function AttemptDetails({
    adapter,
    runId,
    attemptId,
    generation,
    signal,
    rawEvidenceAllowed,
}: {
    adapter: ReportAdapter;
    runId: string;
    attemptId: string;
    generation: number;
    signal?: AbortSignal;
    rawEvidenceAllowed: boolean;
}) {
    useAppLocale();
    const feedback = useOperationFeedback();
    const t = useLabels(),
        [events, setEvents] = useState<ReportEvent[]>([]),
        [more, setMore] = useState(false),
        [error, setError] = useState(""),
        [preview, setPreview] = useState("");
    const lifetime = useMemo(() => new AbortController(), []),
        active = useMemo(
            () => (signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal),
            [signal, lifetime],
        );
    const previewUrl = useRef("");
    useEffect(
        () => () => {
            lifetime.abort();
            if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
        },
        [lifetime],
    );
    const artifacts = useQuery({
        queryKey: ["workspace", "report-artifacts", adapter, attemptId, generation],
        queryFn: ({ signal }) => adapter.artifacts(attemptId, AbortSignal.any([signal, active])),
    });
    const metadata = useQuery({
        queryKey: ["workspace", "report-display", adapter, runId, attemptId],
        queryFn: ({ signal }) => adapter.display(runId, attemptId, AbortSignal.any([signal, active])),
    });
    const cursor = useRef(0);
    // 游标只供下一次显式加载读取，推进它不触发额外请求；并发响应仍按 sequence 合并且游标单调前进，既不自动排空分页，也
    // 不引入额外的过期代次丢弃协议。
    const load = useCallback(async () => {
        try {
            const page = await adapter.history(attemptId, cursor.current, active);
            if (active.aborted) return;
            setEvents((previous) => {
                const map = new Map(previous.map((e) => [e.sequence, e]));
                for (const e of page.items) map.set(e.sequence, e);
                return [...map.values()].sort((a, b) => a.sequence - b.sequence);
            });
            cursor.current = Math.max(cursor.current, page.nextSequence);
            setMore(page.hasMore);
        } catch (e) {
            if (!active.aborted) setError(e instanceof Error ? e.message : String(e));
        }
    }, [adapter, attemptId, active]);
    const display = metadata.data?.display;
    const authentication = reportAuthentication(events);
    // 仅当前尝试可以反馈显式打开或下载证据的失败，历史查询错误则继续保留在步骤区，供用户判断是否重新载入。
    const evidenceFailed = (failure: unknown) => {
        if (!active.aborted) feedback.showFailure(failure instanceof Error ? failure.message : t("evidenceFailed"));
    };
    const saveEvidence = (artifact: ReportArtifact) => {
        // 宿主确认取消与实际保存都返回空值，所以桌面仍由原生窗口呈现处理结果，共享弹窗只报告明确失败。
        if (adapter.nativeArtifact) {
            void adapter.nativeArtifact(attemptId, artifact.id, "save", active).catch(evidenceFailed);
            return;
        }
        void adapter
            .download(attemptId, artifact.id, active)
            .then((blob) => {
                if (active.aborted) return;
                const url = URL.createObjectURL(blob),
                    link = document.createElement("a");
                link.href = url;
                const names = { TRACE: "trace.zip", HTML: "report.html", JUNIT: "junit.xml" };
                link.download = Object.hasOwn(names, artifact.kind)
                    ? names[artifact.kind as keyof typeof names]
                    : `evidence-${artifact.id}.${artifact.kind === "SCREENSHOT" ? "png" : "bin"}`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                feedback.showSuccess(t("downloadStarted"));
            })
            .catch(evidenceFailed);
    };
    const previewScreenshot = (artifact: ReportArtifact) => {
        if (adapter.nativeArtifact) {
            void adapter.nativeArtifact(attemptId, artifact.id, "preview", active).catch(evidenceFailed);
            return;
        }
        // 浏览器先确认本次读取的内容可解码，再显示预览和成功回执；切换运行时只回收本次创建的临时对象地址。
        void adapter
            .download(attemptId, artifact.id, active)
            .then(async (blob) => {
                if (active.aborted) return;
                const url = URL.createObjectURL(new Blob([blob], { type: "image/png" }));
                const image = new Image();
                image.src = url;
                try {
                    await image.decode();
                    active.throwIfAborted();
                } catch (error) {
                    URL.revokeObjectURL(url);
                    throw error;
                }
                if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
                previewUrl.current = url;
                setPreview(url);
                feedback.showSuccess(t("previewReady"));
            })
            .catch(evidenceFailed);
    };
    return (
        <section aria-label={tx("Attempt details")}>
            <HistoryPageLoader key={generation} load={load} />
            {authentication && (
                <section aria-label={t("authentication")}>
                    <h3>{t("authentication")}</h3>
                    <p>
                        {t(`authenticationStage.${authentication.stage}`)} ·{" "}
                        {t(`authenticationOutcome.${authentication.outcome}`)} · {authentication.durationMs} ms
                        {authentication.errorCode && (
                            <>
                                {" "}
                                · <code>{authentication.errorCode}</code>
                            </>
                        )}
                    </p>
                </section>
            )}
            <h3>{t("steps")}</h3>
            {error && <p role="alert">{tx(error)}</p>}
            {metadata.error && <p role="alert">{metadata.error.message}</p>}
            {!display && (
                <p>
                    {t("labelsAbsent")}
                    {metadata.data?.metadataStatus === "REDACTED" ? " · " + t("unavailable") : ""}
                </p>
            )}
            <ol className="report-steps">
                {display?.steps.map((step) => {
                    const finish = events.find((e) => e.type === "STEP_FINISHED" && e.stepId === step.id),
                        payload = object(finish?.payload);
                    const parent = display.steps.find((s) => s.id === step.parentId);
                    return (
                        <li key={step.id}>
                            <h4>
                                {parent ? parent.sourceId + " / " : ""}
                                {step.sourceId} · {step.action} ·{" "}
                                {reportCode(t, "status", payload.status, t("noResult"))}
                            </h4>
                            {typeof payload.durationMs === "number" && (
                                <p>
                                    {t("duration")}: {payload.durationMs} ms
                                </p>
                            )}
                            {step.assertions.map((assertion) => {
                                const event = events.find(
                                        (e) =>
                                            e.type === "ASSERTION_RESULT" &&
                                            e.stepId === step.id &&
                                            e.assertionId === assertion.id,
                                    ),
                                    p = object(event?.payload),
                                    actual = object(p.actual),
                                    sample = object(p.sample),
                                    basis = shown(p.expectedSource ?? assertion.expectedSource);
                                return (
                                    <div className="report-assertion" key={assertion.id}>
                                        <h5>
                                            {assertion.sourceId} · {assertion.type} {assertion.operator ?? ""} ·{" "}
                                            {reportCode(t, "status", p.status, t("noResult"))}
                                        </h5>
                                        <p>
                                            {t("severity")}:{" "}
                                            {reportCode(t, "severityLabel", assertion.severity, t("unknown"))} ·{" "}
                                            {t("basis")}: {basis} · {t("duration")}: {shown(p.durationMs ?? "—")} ms
                                        </p>
                                        {typeof sample.fetchedAt === "string" &&
                                            typeof sample.sourceVersionId === "string" && (
                                                <p>
                                                    {tx("采样时间 / Sampled at")}{" "}
                                                    <time dateTime={sample.fetchedAt}>{sample.fetchedAt}</time>
                                                </p>
                                            )}
                                        {event && !event.valuesAvailable ? (
                                            <p className="vq-table-empty">{t("unavailable")}</p>
                                        ) : (
                                            <dl className="report-assertion-values">
                                                <div>
                                                    <dt>{t("expected")}</dt>
                                                    <dd>
                                                        <pre>{event ? shown(p.expected) : t("noResult")}</pre>
                                                    </dd>
                                                </div>
                                                <div>
                                                    <dt>{t("actual")}</dt>
                                                    <dd>
                                                        <pre>
                                                            {event
                                                                ? actual.present === false
                                                                    ? t("missing")
                                                                    : shown(actual.value)
                                                                : t("noResult")}
                                                        </pre>
                                                        {shown(actual.value).includes(tx("[REDACTED]")) && (
                                                            <small>{t("withheld")}</small>
                                                        )}
                                                    </dd>
                                                </div>
                                            </dl>
                                        )}
                                    </div>
                                );
                            })}
                            {!!step.observers.length && (
                                <div>
                                    <h5>{t("requests")}</h5>
                                    {step.observers.map((observer) => {
                                        const result = events.find(
                                            (e) =>
                                                e.type === "OBSERVER_RESULT" &&
                                                e.stepId === step.id &&
                                                object(e.payload).observerId === observer.id,
                                        );
                                        const p = object(result?.payload);
                                        return (
                                            <div key={observer.id}>
                                                <strong>
                                                    {observer.id} · {observer.method ?? observer.kind}{" "}
                                                    {observer.path ?? ""}
                                                </strong>
                                                <dl>
                                                    {Object.entries(p)
                                                        .filter(([k]) => k !== "observerId")
                                                        .map(([k, v]) => (
                                                            <div key={k}>
                                                                <dt>{k}</dt>
                                                                <dd>{shown(v)}</dd>
                                                            </div>
                                                        ))}
                                                </dl>
                                                {!result && <p>{t("noResult")}</p>}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </li>
                    );
                })}
            </ol>
            {more && (
                <Button size="compact" tone="secondary" onClick={() => void load()}>
                    {t("moreEvents")}
                </Button>
            )}
            <details>
                <summary>{t("technical")}</summary>
                <pre>{JSON.stringify(events, null, 2)}</pre>
            </details>
            <h3>{t("evidence")}</h3>
            <p>{t("rawHelp")}</p>
            <p>
                {t("traceHelp")} <code>veriq trace open trace.zip</code>
            </p>
            {artifacts.error && <p role="alert">{artifacts.error.message}</p>}
            <ul>
                {artifacts.data?.items.map((artifact) => {
                    const kind = reportCode(t, "artifactKind", artifact.kind, t("unknown"));
                    return (
                        <li key={artifact.id}>
                            {kind} · {t("evidenceSize", { count: artifact.sizeBytes })} ·{" "}
                            {reportCode(t, "status", artifact.state, t("unknown"))} · {t("restricted")}{" "}
                            {artifact.state === "AVAILABLE" && rawEvidenceAllowed && (
                                <>
                                    <Button size="compact" tone="secondary" onClick={() => saveEvidence(artifact)}>
                                        {t("download")} {kind}
                                    </Button>
                                    {artifact.kind === "TRACE" && adapter.nativeArtifact && (
                                        <Button
                                            size="compact"
                                            tone="secondary"
                                            onClick={() =>
                                                void adapter
                                                    .nativeArtifact?.(attemptId, artifact.id, "trace", active)
                                                    .catch(evidenceFailed)
                                            }
                                        >
                                            {tx("打开 Trace / Open Trace")}
                                        </Button>
                                    )}
                                    {artifact.kind === "SCREENSHOT" && (
                                        <Button
                                            size="compact"
                                            tone="secondary"
                                            onClick={() => previewScreenshot(artifact)}
                                        >
                                            {t("preview")}
                                        </Button>
                                    )}
                                </>
                            )}
                        </li>
                    );
                })}
            </ul>
            {preview && <img className="report-screenshot" src={preview} alt={t("previewAlt")} />}
        </section>
    );
}

function HistoryPageLoader({ load }: { load: () => Promise<void> }) {
    useAppLocale();
    // 每次服务端报告代次提交仅挂载一个无界面加载器，累计事件仍属于 AttemptDetails；证据查询完成或历史状态变化不会重挂载
    // 它，手动 More 也只调用同一加载函数一次。
    useEffect(() => {
        void load();
    }, [load]);
    return null;
}
