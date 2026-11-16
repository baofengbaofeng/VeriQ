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
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Auth } from "../../auth-context";
import { api } from "../../api";
import { Panel } from "../../ui";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import {
    CloudReportAdapter,
    type ReportAdapter,
    type RunReport,
    type ReportEvent,
} from "./adapters";
import { reportI18n } from "./i18n";
import "./reports.css";
const useLabels = () => useTranslation("reports", { i18n: reportI18n }).t;
const shown = (value: unknown) =>
    typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
/**
 * 工作区选择与默认首项逻辑；把 adapter 交给 ReportWorkspaceView。未登录直接 Navigate 登录页。
 * 不缓存所选 runId 跨空间，防止串读其他空间报告。
 */
export function ReportPage() {
    useAppLocale();
    const t = useLabels(),
        { user } = useContext(Auth),
        { selected, select, signal } = useWorkspace();
    const workspaces = useInfiniteQuery({
        queryKey: ["workspaces", user?.id],
        queryFn: ({ pageParam, signal }) => api.workspaces(pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
        enabled: !!user,
    });
    const [params] = useSearchParams();
    const requestedWorkspace = params.get("workspaceId");
    const requestedRun = params.get("runId") ?? "";
    const items = workspaces.data?.pages.flatMap((p) => p.items) ?? [];
    const firstWorkspaceId = items[0]?.id;
    const availableRequestedId = items.find((w) => w.id === requestedWorkspace)?.id;
    // URL 的目标只有在已加载分页中真正可见时才取得选择权，后续用户手动切换不会重新触发这一效果；稍后分页发现目标时仍应准确选择它，而非依赖首项变化。
    useEffect(() => {
        if (availableRequestedId) select(availableRequestedId);
    }, [availableRequestedId, select]);
    useEffect(() => {
        if (!selected && !availableRequestedId && firstWorkspaceId) select(firstWorkspaceId);
    }, [selected, availableRequestedId, firstWorkspaceId, select]);
    const adapter = useMemo(() => new CloudReportAdapter(selected), [selected]);
    if (!user) return <Navigate to="/login" />;
    const workspace = items.find((w) => w.id === selected);
    return (
        <Panel title={t("reports")}>
            <label>
                {t("workspace")}
                <select
                    aria-label={tx("Report Workspace")}
                    data-testid="report-workspace"
                    value={selected}
                    onChange={(e) => select(e.target.value)}
                >
                    {items.map((w) => (
                        <option key={w.id} value={w.id}>
                            {w.name}
                        </option>
                    ))}
                </select>
            </label>
            {workspaces.isPending && <p role="status">{t("loading")}</p>}
            {workspaces.isSuccess && !items.length && (
                <p>{tx("请先创建或加入工作区 / Create or join a Workspace first.")}</p>
            )}
            {workspaces.error && (
                <div>
                    <p role="alert">{workspaces.error.message}</p>
                    <button type="button" onClick={() => void workspaces.refetch()}>
                        {t("retry")}
                    </button>
                </div>
            )}
            {workspaces.hasNextPage && (
                <button
                    type="button"
                    disabled={workspaces.isFetchingNextPage}
                    onClick={() => void workspaces.fetchNextPage()}
                >
                    {tx("更多空间 / More Workspaces")}
                </button>
            )}
            {workspace && (
                <ReportWorkspaceView
                    initialRunId={selected === requestedWorkspace ? requestedRun : ""}
                    key={user.id + selected}
                    adapter={adapter}
                    signal={signal}
                    rawEvidenceAllowed={["OWNER", "ADMIN"].includes(workspace.role)}
                />
            )}
        </Panel>
    );
}
/**
 * 拥有 run 列表无限查询与当前选中 runId；打开 ReportView 并处理 Load more。切换 run 会重置 history after。
 * 空列表显示 empty 文案；错误用 retry 重新拉取。
 */
export function ReportWorkspaceView({
    initialRunId = "",
    adapter,
    signal,
    rawEvidenceAllowed = false,
}: {
    initialRunId?: string;
    adapter: ReportAdapter;
    signal?: AbortSignal;
    rawEvidenceAllowed?: boolean;
}) {
    useAppLocale();
    const t = useLabels(),
        [selected, setSelected] = useState(initialRunId);
    const runs = useInfiniteQuery({
        queryKey: ["workspace", "reports", adapter],
        queryFn: ({ pageParam, signal: s }) =>
            adapter.list(pageParam, signal ? AbortSignal.any([s, signal]) : s),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const audit = useQuery({
        queryKey: ["workspace", "report-audit", adapter],
        queryFn: ({ signal }) => adapter.audit(undefined, signal),
    });
    const items = runs.data?.pages.flatMap((p) => p.items) ?? [];
    return (
        <div className="veriq-reports">
            <h2>{t("history")}</h2>
            {runs.error && (
                <div>
                    <p role="alert">{runs.error.message}</p>
                    <button type="button" onClick={() => void runs.refetch()}>
                        {t("retry")}
                    </button>
                </div>
            )}
            {runs.isPending && <p role="status">{t("loading")}</p>}
            {runs.isSuccess && !items.length && <p>{t("empty")}</p>}
            <ul>
                {items.map((run) => (
                    <li key={run.id}>
                        <button type="button" onClick={() => setSelected(run.id)}>
                            {new Date(run.createdAt).toLocaleString()} · {run.source} · {run.state}{" "}
                            · {run.outcome ?? tx("Pending")}
                        </button>
                    </li>
                ))}
            </ul>
            {runs.hasNextPage && (
                <button
                    type="button"
                    disabled={runs.isFetchingNextPage}
                    onClick={() => void runs.fetchNextPage()}
                >
                    {t("moreRuns")}
                </button>
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
                            {item.createdAt} · {item.action} · {item.actorId ?? tx("Service")} ·{" "}
                            {item.targetId}
                        </li>
                    ))}
                </ul>
            </details>
        </div>
    );
}
/**
 * 单个 Run 的报告主体：门禁、用例树、Attempt 事件、证据下载与审计片段。原始证据区按角色条件渲染；原始证据区仅对 Owner 或 Admin 角色展开。
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
    // 订阅始终占据同一子节点位置，报告由加载态变为成功态时不能重挂载；只有显式 Retry 的 key 改变才结束旧订阅，并保留父组件拥有的选中项和分页数量。
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
                        <button type="button" onClick={retry}>
                            {t("retry")}
                        </button>
                    )}
                </div>
            </>
        );
    return (
        <>
            {subscription}
            <section aria-label={tx("Run report")}>
                <h2>
                    {report.run.outcome ?? report.run.state} · {report.run.source}
                </h2>
                <p data-testid="report-gates">
                    {t("gateAt")}:{" "}
                    <strong>{report.gateAtExecution.passed ? "PASS" : "BLOCKED"}</strong> ·{" "}
                    {t("gateNow")}: <strong>{report.gateNow.passed ? "PASS" : "BLOCKED"}</strong>
                </p>
                {!report.gateNow.passed && <p>{report.gateNow.reasons.join(", ")}</p>}
                <p>
                    {t("cases")}: {report.statistics.caseCount} · {t("firstPass")}:{" "}
                    {report.statistics.firstPassCount} · {t("retryPass")}:{" "}
                    {report.statistics.retryPassCount} · {t("infra")}:{" "}
                    {report.statistics.infrastructureErrorCount}
                </p>
                {report.cases.slice(0, caseLimit).map((c) => (
                    <CaseCard
                        key={c.id}
                        value={c}
                        runId={runId}
                        adapter={adapter}
                        choose={setAttempt}
                    />
                ))}
                {report.cases.length > caseLimit && (
                    <button type="button" onClick={() => setCaseLimit((n) => n + 25)}>
                        {t("moreCases")}
                    </button>
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
    // 初始快照与流共享同一个取消边界，流失败仍撤销同代快照请求；稳定的 React setter 不会因父组件正常渲染而更换，卸载清理时机沿用原有订阅效果。
    useEffect(() => {
        const lifetime = new AbortController();
        const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
        void adapter
            .report(runId, active)
            .then((r) => {
                if (!active.aborted) setReport(r);
            })
            .catch((e) => {
                if (!active.aborted) setError(e instanceof Error ? e.message : String(e));
            });
        void adapter
            .subscribe(
                runId,
                (r) => {
                    if (!active.aborted) {
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
                · {value.outcome ?? value.state}
            </h3>
            {metadata.error && <p role="alert">{metadata.error.message}</p>}
            {metadata.data && (
                <p>
                    {t("environment")}: {metadata.data.environment.browser ?? "—"} ·{" "}
                    {metadata.data.environment.baseURL ?? "—"} ·{" "}
                    {metadata.data.environment.locale ?? "—"} /{" "}
                    {metadata.data.environment.timezone ?? "—"}
                </p>
            )}
            {!value.attempts.length && <p>{t("noAttempt")}</p>}
            {value.attempts.map((a) => (
                <article key={a.id}>
                    <button type="button" onClick={() => choose(a.id)}>
                        {t("attempt")} {a.attemptNo} · {a.outcome ?? a.phase}
                    </button>
                    <p>
                        {t("business")}: {shown(a.facts.business ?? "UNKNOWN")} · {t("cleanup")}:{" "}
                        {shown(a.facts.cleanup ?? "UNKNOWN")} · {t("evidence")}:{" "}
                        {shown(a.facts.evidence ?? "UNKNOWN")}
                    </p>
                    {a.activatedAt && a.finishedAt && (
                        <p>
                            {t("duration")}:{" "}
                            {new Date(a.finishedAt).getTime() - new Date(a.activatedAt).getTime()}{" "}
                            ms
                        </p>
                    )}
                    {typeof a.facts.errorCode === "string" && (
                        <p role="status">{a.facts.errorCode}</p>
                    )}
                    {a.compensations.length > 0 && (
                        <p>
                            {t("compensation")}:{" "}
                            {a.compensations.map((c) => `${c.state} ${c.outcome ?? ""}`).join("; ")}
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
    useEffect(() => () => lifetime.abort(), [lifetime]);
    useEffect(
        () => () => {
            if (preview) URL.revokeObjectURL(preview);
        },
        [preview],
    );
    const artifacts = useQuery({
        queryKey: ["workspace", "report-artifacts", adapter, attemptId, generation],
        queryFn: ({ signal }) => adapter.artifacts(attemptId, AbortSignal.any([signal, active])),
    });
    const metadata = useQuery({
        queryKey: ["workspace", "report-display", adapter, runId, attemptId],
        queryFn: ({ signal }) =>
            adapter.display(runId, attemptId, AbortSignal.any([signal, active])),
    });
    const cursor = useRef(0);
    // 游标只供下一次显式加载读取，推进它不触发额外请求；并发响应仍按 sequence 合并且游标单调前进，既不自动排空分页，也不引入额外的过期代次丢弃协议。
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
    return (
        <section aria-label={tx("Attempt details")}>
            <HistoryPageLoader key={generation} load={load} />
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
                    const finish = events.find(
                            (e) => e.type === "STEP_FINISHED" && e.stepId === step.id,
                        ),
                        payload = object(finish?.payload);
                    const parent = display.steps.find((s) => s.id === step.parentId);
                    return (
                        <li key={step.id}>
                            <h4>
                                {parent ? parent.sourceId + " / " : ""}
                                {step.sourceId} · {step.action} ·{" "}
                                {shown(payload.status ?? t("noResult"))}
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
                                    actual = object(p.actual);
                                return (
                                    <div className="report-assertion" key={assertion.id}>
                                        <h5>
                                            {assertion.sourceId} · {assertion.type}{" "}
                                            {assertion.operator ?? ""} ·{" "}
                                            {shown(p.status ?? t("noResult"))}
                                        </h5>
                                        <p>
                                            {t("severity")}: {assertion.severity} · {t("basis")}:{" "}
                                            {assertion.expectedSource} · {t("duration")}:{" "}
                                            {shown(p.durationMs ?? "—")} ms
                                        </p>
                                        {event && !event.valuesAvailable ? (
                                            <p>{t("unavailable")}</p>
                                        ) : (
                                            <table>
                                                <thead>
                                                    <tr>
                                                        <th>{t("expected")}</th>
                                                        <th>{t("actual")}</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    <tr>
                                                        <td>
                                                            <pre>
                                                                {event
                                                                    ? shown(p.expected)
                                                                    : t("noResult")}
                                                            </pre>
                                                        </td>
                                                        <td>
                                                            <pre>
                                                                {event
                                                                    ? actual.present === false
                                                                        ? t("missing")
                                                                        : shown(actual.value)
                                                                    : t("noResult")}
                                                            </pre>
                                                            {shown(actual.value).includes(
                                                                tx("[REDACTED]"),
                                                            ) && <small>{t("withheld")}</small>}
                                                        </td>
                                                    </tr>
                                                </tbody>
                                            </table>
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
                                                    {observer.id} ·{" "}
                                                    {observer.method ?? observer.kind}{" "}
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
                <button type="button" onClick={() => void load()}>
                    {t("moreEvents")}
                </button>
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
                {artifacts.data?.items.map((a) => (
                    <li key={a.id}>
                        {a.kind} · {a.sizeBytes} {tx(" bytes · ")}
                        {a.state} · {t("restricted")}{" "}
                        {a.state === "AVAILABLE" && rawEvidenceAllowed && (
                            <>
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (adapter.nativeArtifact) {
                                            void adapter
                                                .nativeArtifact(attemptId, a.id, "save", active)
                                                .catch((e) =>
                                                    setError(
                                                        e instanceof Error ? e.message : String(e),
                                                    ),
                                                );
                                            return;
                                        }
                                        void adapter
                                            .download(attemptId, a.id, active)
                                            .then((blob) => {
                                                if (active.aborted) return;
                                                const url = URL.createObjectURL(blob),
                                                    link = document.createElement("a");
                                                link.href = url;
                                                link.download =
                                                    a.kind === "TRACE"
                                                        ? "trace.zip"
                                                        : a.kind === "HTML"
                                                          ? "report.html"
                                                          : a.kind === "JUNIT"
                                                            ? "junit.xml"
                                                            : `evidence-${a.id}.${a.kind === "SCREENSHOT" ? "png" : "bin"}`;
                                                link.click();
                                                setTimeout(() => URL.revokeObjectURL(url), 1000);
                                            })
                                            .catch((e) => {
                                                if (!active.aborted)
                                                    setError(
                                                        e instanceof Error ? e.message : String(e),
                                                    );
                                            });
                                    }}
                                >
                                    {t("download")} {a.kind}
                                </button>
                                {a.kind === "TRACE" && adapter.nativeArtifact && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void adapter
                                                .nativeArtifact?.(attemptId, a.id, "trace", active)
                                                .catch((e) =>
                                                    setError(
                                                        e instanceof Error ? e.message : String(e),
                                                    ),
                                                )
                                        }
                                    >
                                        {tx("打开 Trace / Open Trace")}
                                    </button>
                                )}
                                {a.kind === "SCREENSHOT" && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (adapter.nativeArtifact) {
                                                void adapter
                                                    .nativeArtifact(
                                                        attemptId,
                                                        a.id,
                                                        "preview",
                                                        active,
                                                    )
                                                    .catch((e) =>
                                                        setError(
                                                            e instanceof Error
                                                                ? e.message
                                                                : String(e),
                                                        ),
                                                    );
                                                return;
                                            }
                                            void adapter
                                                .download(attemptId, a.id, active)
                                                .then((blob) => {
                                                    if (!active.aborted)
                                                        setPreview(
                                                            URL.createObjectURL(
                                                                new Blob([blob], {
                                                                    type: "image/png",
                                                                }),
                                                            ),
                                                        );
                                                })
                                                .catch((e) => {
                                                    if (!active.aborted)
                                                        setError(
                                                            e instanceof Error
                                                                ? e.message
                                                                : String(e),
                                                        );
                                                });
                                        }}
                                    >
                                        {t("preview")}
                                    </button>
                                )}
                            </>
                        )}
                    </li>
                ))}
            </ul>
            {preview && (
                <img
                    className="report-screenshot"
                    src={preview}
                    alt="受限截图 / Restricted screenshot"
                />
            )}
        </section>
    );
}

function HistoryPageLoader({ load }: { load: () => Promise<void> }) {
    useAppLocale();
    // 每次服务端报告代次提交仅挂载一个无界面加载器，累计事件仍属于 AttemptDetails；证据查询完成或历史状态变化不会重挂载它，手动 More 也只调用同一加载函数一次。
    useEffect(() => {
        void load();
    }, [load]);
    return null;
}
