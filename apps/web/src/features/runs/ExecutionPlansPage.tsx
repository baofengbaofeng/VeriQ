/**
 * 执行计划页面在当前员工和空间的生命周期内管理已发布资产选择及受限自动化身份，切换身份或空间时卸载全部表单和一次性令牌
 * ，查询缓存只保存无秘密的计划与令牌元数据。
 */
import { tx, useAppLocale } from "../../locale";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PlatformComponents } from "@veriq/contracts";
import { Auth } from "../../auth-context";
import { ApiError, inheritAgentFormSignal, request, runtimeApi, type Workspace } from "../../api";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { Select, SelectItem } from "../../components/Select";
import { useOperationFeedback } from "../../operation-feedback";
import { canExportWorkspaceTable, collectTablePages, DataTable, useTableView } from "../../table-view";
import { Panel, useAction } from "../../ui";
import { useWorkspaceDirectory, WorkspaceStatus } from "../workspaces/WorkspaceDirectory";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { CloudResourceAdapter } from "../resources/adapters";
import "./execution-plans.css";
type S = PlatformComponents["schemas"];
type Plan = S["ExecutionPlanDTO"];
type Write = S["ExecutionPlanWrite"];
type Page<T> = { items: T[]; nextCursor: string | null };

// 触发接口的回执表示本次提交如何处理，结果文案不把入队、复用或跳过误报为实际执行已完成。
const TRIGGER_MESSAGES = {
    ENQUEUED: "Run enqueued.",
    REUSED: "Existing run reused.",
    SKIPPED: "Run trigger skipped.",
} satisfies Record<S["TriggerReceipt"]["decision"], string>;

const TOKEN_PURPOSES = ["EXECUTION", "MAINTENANCE", "RUNTIME_ENROLLMENT"] as const;
const UNSELECTED = "unselected";

/**
 * 执行计划只接收当前目录已授权的工作区；页面以用户与空间为键，链接中的计划标识仅对该空间有效。
 */
export function ExecutionPlansPage() {
    useAppLocale();
    const { user } = useContext(Auth);
    const { workspace, requested } = useWorkspaceDirectory();
    const { selected } = useWorkspace();
    const [params] = useSearchParams();
    if (!user) return <Navigate to="/login" />;
    return (
        <Panel title={tx("执行计划")}>
            <WorkspaceStatus />
            {workspace && (
                <PlanWorkspace
                    key={user.id + selected}
                    workspace={workspace}
                    requestedPlanId={requested ? (params.get("planId") ?? "") : ""}
                />
            )}
        </Panel>
    );
}

/**
 * 资源版本选择器分别分页读取资源和已发布版本，选中资源改变时立即清空版本，只有服务返回的不可变版本才能写入表单；编辑旧
 * 计划时保留明确版本标识而不自动替换为最新版本。
 */
function VersionSelector({
    workspace,
    kind,
    value,
    onChange,
    signal,
}: {
    workspace: string;
    kind: "SUITE" | "ENVIRONMENT";
    value: string;
    onChange: (value: string) => void;
    signal: AbortSignal;
}) {
    useAppLocale();
    const adapter = useMemo(() => new CloudResourceAdapter(workspace), [workspace]);
    const [resource, setResource] = useState("");
    const resources = useInfiniteQuery({
        queryKey: ["workspace", workspace, "plan-resources", kind],
        queryFn: ({ pageParam, signal: q }) => adapter.list(kind, pageParam, AbortSignal.any([signal, q])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const versions = useInfiniteQuery({
        queryKey: ["workspace", workspace, "plan-versions", resource],
        queryFn: ({ pageParam, signal: q }) => adapter.versions(resource, pageParam, AbortSignal.any([signal, q])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
        enabled: !!resource,
    });
    const listed = versions.data?.pages.flatMap((p) => p.items) ?? [];
    const isSuite = kind === "SUITE";
    const resourceId = `plan-${kind.toLowerCase()}-resource`;
    const versionId = `plan-${kind.toLowerCase()}-version`;
    const resourcePrompt = tx("选择资源 / Select resource");
    const versionPrompt = tx("选择已发布版本 / Select published version");
    return (
        <fieldset>
            <legend>{tx(isSuite ? "套件 / Suite" : "环境 / Environment")}</legend>
            {resources.isPending && <p role="status">{tx("Loading resources…")}</p>}
            {resources.isSuccess && !resources.data.pages.some((page) => page.items.length) && (
                <p>{tx("No resources available.")}</p>
            )}
            {resource && versions.isPending && <p role="status">{tx("Loading versions…")}</p>}
            {resource && versions.isSuccess && !listed.length && <p>{tx("No published versions available.")}</p>}
            <Field
                label={tx(isSuite ? "Suite resource" : "Environment resource")}
                hint={tx("Choose a resource to see its versions.")}
                htmlFor={resourceId}
            >
                <Select
                    id={resourceId}
                    appearance="default-dropdown"
                    value={resource}
                    placeholder={resourcePrompt}
                    onValueChange={(next) => {
                        setResource(next === UNSELECTED ? "" : next);
                        onChange("");
                    }}
                >
                    <SelectItem value={UNSELECTED}>{resourcePrompt}</SelectItem>
                    {resources.data?.pages
                        .flatMap((p) => p.items)
                        .filter((r) => r.status !== "ARCHIVED")
                        .map((r) => (
                            <SelectItem key={r.id} value={r.id}>
                                {r.name}
                            </SelectItem>
                        ))}
                </Select>
            </Field>
            {resources.hasNextPage && (
                <Button size="compact" tone="secondary" onClick={() => void resources.fetchNextPage()}>
                    {tx("更多资源 / More resources")}
                </Button>
            )}
            <Field
                label={tx(isSuite ? "Suite version" : "Environment version")}
                hint={tx("Use a published version.")}
                htmlFor={versionId}
                required
            >
                <Select
                    id={versionId}
                    appearance="default-dropdown"
                    required
                    value={value}
                    placeholder={versionPrompt}
                    onValueChange={(next) => onChange(next === UNSELECTED ? "" : next)}
                >
                    <SelectItem value={UNSELECTED}>{versionPrompt}</SelectItem>
                    {value && !listed.some((v) => v.id === value) && <SelectItem value={value}>{value}</SelectItem>}
                    {listed.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                            {v.versionNo} — {v.id}
                        </SelectItem>
                    ))}
                </Select>
            </Field>
            {versions.hasNextPage && (
                <Button size="compact" tone="secondary" onClick={() => void versions.fetchNextPage()}>
                    {tx("更多版本 / More versions")}
                </Button>
            )}
            {(resources.error || versions.error) && (
                <p role="alert">{resources.error?.message ?? versions.error?.message}</p>
            )}
        </fieldset>
    );
}

/**
 * 计划管理表单只发送明确选择，运行触发保留一次操作的幂等键供网络重试；服务端冲突会原样显示并保留用户输入，查询和轮询在
 * 页面卸载时取消，旧空间结果不会更新新空间的状态。
 */
function PlanWorkspace({ workspace, requestedPlanId }: { workspace: Workspace; requestedPlanId: string }) {
    useAppLocale();
    const base = `/workspaces/${workspace.id}`,
        cache = useQueryClient();
    const { busy, error, submit: act } = useAction();
    const { signal: workspaceSignal } = useWorkspace();
    const controller = useMemo(() => new AbortController(), []);
    useEffect(() => () => controller.abort(), [controller]);
    const signal = useMemo(
        () =>
            inheritAgentFormSignal(
                workspaceSignal ? AbortSignal.any([controller.signal, workspaceSignal]) : controller.signal,
                workspaceSignal,
            ),
        [controller, workspaceSignal],
    );
    const canEdit = !workspace.archived && ["OWNER", "ADMIN", "EDITOR"].includes(workspace.role);
    const canExecute = !workspace.archived && workspace.role !== "VIEWER";
    const [editing, setEditing] = useState<Plan | null>(null),
        [name, setName] = useState(""),
        [suite, setSuite] = useState(""),
        [environment, setEnvironment] = useState(""),
        [roles, setRoles] = useState("reader"),
        [variables, setVariables] = useState("{}"),
        [browsers, setBrowsers] = useState<string[]>(["chromium"]),
        [runtimeIds, setRuntimeIds] = useState<string[]>([]),
        [policy, setPolicy] = useState<Write["overlapPolicy"]>("QUEUE"),
        [retries, setRetries] = useState(0),
        [receipt, setReceipt] = useState<S["TriggerReceipt"] | null>(null);
    const triggerKey = useRef<{ plan: string; key: string }>();
    const plans = useQuery({
        queryKey: ["workspace", workspace.id, "plans"],
        queryFn: ({ signal: q }) =>
            collectTablePages(
                (cursor, activeSignal) =>
                    request<Page<Plan>>(
                        base + "/execution-plans" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
                        "GET",
                        undefined,
                        activeSignal,
                    ),
                AbortSignal.any([signal, q]),
            ),
    });
    const runtimes = useInfiniteQuery({
        queryKey: ["workspace", workspace.id, "plan-runtimes"],
        queryFn: ({ pageParam, signal: q }) => runtimeApi.list(workspace.id, pageParam, AbortSignal.any([signal, q])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const status = useQuery({
        queryKey: ["workspace", workspace.id, "plan-status", receipt?.runId],
        queryFn: ({ signal: q }) =>
            request<S["RunDTO"]>(base + "/runs/" + receipt!.runId, "GET", undefined, AbortSignal.any([signal, q])),
        enabled: !!receipt,
        refetchInterval: (query) => (query.state.data?.state === "FINISHED" ? false : 2000),
    });
    const requested = useQuery({
        queryKey: ["workspace", workspace.id, "requested-plan", requestedPlanId],
        queryFn: ({ signal: querySignal }) =>
            request<Plan>(
                base + "/execution-plans/" + encodeURIComponent(requestedPlanId),
                "GET",
                undefined,
                AbortSignal.any([signal, querySignal]),
            ),
        enabled: !!requestedPlanId,
    });
    const listedRows = plans.data ?? [];
    const rows =
        requested.data && !listedRows.some((plan) => plan.id === requested.data.id)
            ? [requested.data, ...listedRows]
            : listedRows;
    const planView = useTableView(rows, {
        scope: workspace.id,
        matches: (plan, term) =>
            [
                plan.name,
                plan.overlapPolicy,
                tx(`Overlap: ${plan.overlapPolicy}`),
                tx(plan.archived ? "归档 / Archived" : "Active plan"),
                String(plan.revision),
            ].some((value) => value.toLowerCase().includes(term)),
    });
    const refresh = () => cache.invalidateQueries({ queryKey: ["workspace", workspace.id, "plans"] });
    const edit = (p: Plan | null) => {
        setEditing(p);
        setName(p?.name ?? "");
        setSuite(p?.suiteVersionId ?? "");
        setEnvironment(p?.environmentVersionId ?? "");
        setRoles(p?.roleKeys.join(", ") ?? "reader");
        setVariables(JSON.stringify(p?.variables ?? {}, null, 4));
        setBrowsers(p?.browsers ?? ["chromium"]);
        setRuntimeIds(p?.runtimeIds ?? []);
        setPolicy(p?.overlapPolicy ?? "QUEUE");
        setRetries(p?.maxCaseRetries ?? 0);
    };
    const archive = (plan: Plan, waitingFrom: HTMLElement) =>
        act(
            async (complete) => {
                await request(base + "/execution-plans/" + plan.id, "DELETE", { revision: plan.revision }, signal);
                complete("Execution plan archived.");
                await refresh();
            },
            { waitingFrom, signal },
        );
    const trigger = (plan: Plan, waitingFrom: HTMLElement) =>
        act(
            async (complete) => {
                // 同一计划的请求在网络失败后继续使用原幂等键，只有控制服务返回有效回执才清除本次操作的键。
                if (triggerKey.current?.plan !== plan.id)
                    triggerKey.current = { plan: plan.id, key: crypto.randomUUID() };
                const result = await request<S["TriggerReceipt"]>(
                    base + "/execution-plans/" + plan.id + "/trigger",
                    "POST",
                    {},
                    signal,
                    { "Idempotency-Key": triggerKey.current.key },
                );
                if (!signal.aborted) {
                    setReceipt(result);
                    triggerKey.current = undefined;
                    complete(TRIGGER_MESSAGES[result.decision]);
                }
            },
            { waitingFrom, signal },
        );
    return (
        <div className="vq-plan-workspace">
            <section className="vq-plan-section" aria-labelledby="execution-plan-list">
                <div className="vq-plan-toolbar">
                    <h2 id="execution-plan-list">{tx("Plan list")}</h2>
                    <Link to="/runtimes" className="vq-plan-link">
                        {tx("设备登记、共享与凭证投递 / Runtime enrollment and permissions")}
                    </Link>
                </div>
                <p>{tx("计划只保存执行选择；定时由外部调度器调用 HTTP。 / Scheduling is external.")}</p>
                {(error || plans.error || runtimes.error) && (
                    <p role="alert">{tx(error || plans.error?.message || runtimes.error?.message || "")}</p>
                )}
                {(plans.isPending || (requestedPlanId && requested.isPending)) && (
                    <p role="status">{tx("加载计划 / Loading plans…")}</p>
                )}
                {requested.error && <p role="alert">{tx(requested.error.message)}</p>}
                {!canEdit && <p>{tx("Your role or the archived Workspace allows read-only plan access.")}</p>}
                {(rows.length > 0 || (plans.isSuccess && !requested.isFetching)) && (
                    <DataTable
                        label={tx("Plan list")}
                        view={planView}
                        searchLabel={tx("Search execution plans")}
                        busy={busy || plans.isFetching || plans.isError}
                        exportAllowed={canExportWorkspaceTable(workspace.role)}
                        exportColumns={[
                            { label: tx("Plan name"), value: ({ name }) => name },
                            {
                                label: tx("Overlap policy"),
                                value: ({ overlapPolicy }) => tx(`Overlap: ${overlapPolicy}`),
                            },
                            { label: tx("Revision"), value: ({ revision }) => revision },
                            {
                                label: tx("Status"),
                                value: ({ archived }) => tx(archived ? "归档 / Archived" : "Active plan"),
                            },
                        ]}
                    >
                        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: 保留键盘横向滚动入口。 */}
                        <section className="table-scroll" aria-label={tx("Plan list")} tabIndex={0}>
                            <table className="vq-plan-table" aria-label={tx("Plan list")}>
                                <colgroup>
                                    <col className="vq-plan-name-column" />
                                    <col className="vq-plan-policy-column" />
                                    <col className="vq-plan-revision-column" />
                                    <col className="vq-plan-status-column" />
                                    <col className="vq-plan-actions-column" />
                                </colgroup>
                                <thead>
                                    <tr>
                                        <th scope="col">{tx("Plan name")}</th>
                                        <th scope="col">{tx("Overlap policy")}</th>
                                        <th scope="col">{tx("Revision")}</th>
                                        <th scope="col">{tx("Status")}</th>
                                        <th scope="col">{tx("Actions")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {planView.filteredCount === 0 && (
                                        <tr>
                                            <td className="vq-table-empty" colSpan={5}>
                                                {tx(
                                                    rows.length
                                                        ? "No matching execution plans."
                                                        : "No execution plans yet.",
                                                )}
                                            </td>
                                        </tr>
                                    )}
                                    {planView.rows.map((p) => (
                                        <tr key={p.id}>
                                            <th scope="row">{p.name}</th>
                                            <td>{tx(`Overlap: ${p.overlapPolicy}`)}</td>
                                            <td>{p.revision}</td>
                                            <td>{tx(p.archived ? "归档 / Archived" : "Active plan")}</td>
                                            <td>
                                                <div className="vq-plan-actions">
                                                    {canEdit && !p.archived && (
                                                        <>
                                                            <Button
                                                                size="compact"
                                                                tone="secondary"
                                                                disabled={busy}
                                                                onClick={() => edit(p)}
                                                            >
                                                                {tx("编辑 / Edit")}
                                                            </Button>
                                                            <Button
                                                                size="compact"
                                                                tone="danger"
                                                                disabled={busy}
                                                                onClick={(event) =>
                                                                    void archive(p, event.currentTarget)
                                                                }
                                                            >
                                                                {tx("归档 / Archive")}
                                                            </Button>
                                                            <Link
                                                                to={`/agent?workspaceId=${workspace.id}&planId=${p.id}`}
                                                            >
                                                                {tx("Discuss with Test Agent")}
                                                            </Link>
                                                        </>
                                                    )}
                                                    {canExecute && !p.archived && (
                                                        <Button
                                                            size="compact"
                                                            disabled={busy}
                                                            onClick={(event) => void trigger(p, event.currentTarget)}
                                                        >
                                                            {tx("触发 / Trigger")}
                                                        </Button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </section>
                    </DataTable>
                )}
            </section>
            {receipt && (
                <section className="vq-plan-section" aria-label={tx("Trigger status")}>
                    <h2>{tx("Trigger status")}</h2>
                    <p role="status">
                        {[
                            tx(`Decision: ${receipt.decision}`),
                            status.data && tx(`Run state: ${status.data.state}`),
                            status.data?.outcome && tx(`Run outcome: ${status.data.outcome}`),
                            status.data?.source && tx(`Run source: ${status.data.source}`),
                            status.data?.reasonCode,
                        ]
                            .filter(Boolean)
                            .join(" · ")}
                    </p>
                    {status.error && <p role="alert">{tx(status.error.message)}</p>}
                    <div className="vq-plan-actions">
                        <Link to={`/reports?runId=${receipt.runId}&workspaceId=${workspace.id}`}>
                            {tx("运行报告 / Run report")}
                        </Link>
                        {canExecute && status.data?.state !== "FINISHED" && (
                            <Button
                                size="compact"
                                tone="danger"
                                disabled={busy}
                                onClick={(event) =>
                                    void act(
                                        async (complete) => {
                                            await request(
                                                base + "/runs/" + receipt.runId + "/cancel",
                                                "POST",
                                                { reason: "Cancelled from execution plans" },
                                                signal,
                                            );
                                            complete("Run cancellation requested.");
                                            await status.refetch();
                                        },
                                        { waitingFrom: event.currentTarget, signal },
                                    )
                                }
                            >
                                {tx("取消运行 / Cancel Run")}
                            </Button>
                        )}
                    </div>
                </section>
            )}
            {canEdit && (
                <form
                    className="vq-plan-section"
                    aria-label={tx("Execution plan form")}
                    onSubmit={(e) => {
                        e.preventDefault();
                        void act(
                            async (complete) => {
                                let parsedVariables: Write["variables"];
                                try {
                                    parsedVariables = JSON.parse(variables);
                                } catch {
                                    throw new ApiError("INVALID_JSON", "Plan variables must be valid JSON.", 400, "");
                                }
                                const body: Write = {
                                    name,
                                    suiteVersionId: suite,
                                    environmentVersionId: environment,
                                    roleKeys: roles
                                        .split(",")
                                        .map((r) => r.trim())
                                        .filter(Boolean),
                                    browsers: browsers as Write["browsers"],
                                    runtimeIds,
                                    overlapPolicy: policy,
                                    maxCaseRetries: retries,
                                    variables: parsedVariables,
                                    ...(editing ? { revision: editing.revision } : {}),
                                };
                                await request(
                                    base + "/execution-plans" + (editing ? "/" + editing.id : ""),
                                    editing ? "PUT" : "POST",
                                    body,
                                    signal,
                                );
                                if (!signal.aborted) edit(null);
                                complete(editing ? "Execution plan updated." : "Execution plan created.");
                                await refresh();
                            },
                            { waitingFrom: (e.nativeEvent as SubmitEvent).submitter, signal },
                        );
                    }}
                >
                    <h2>{editing ? tx("编辑计划 / Edit plan") : tx("创建计划 / Create plan")}</h2>
                    <Field
                        label={tx("Plan name")}
                        hint={tx("Use a name that identifies the run configuration.")}
                        required
                    >
                        <input required maxLength={160} value={name} onChange={(e) => setName(e.target.value)} />
                    </Field>
                    <div className="vq-plan-fields">
                        <VersionSelector
                            workspace={workspace.id}
                            kind="SUITE"
                            value={suite}
                            onChange={setSuite}
                            signal={signal}
                        />
                        <VersionSelector
                            workspace={workspace.id}
                            kind="ENVIRONMENT"
                            value={environment}
                            onChange={setEnvironment}
                            signal={signal}
                        />
                    </div>
                    <div className="vq-plan-fields">
                        <Field
                            label={tx("Plan roles")}
                            hint={tx("Separate environment role keys with commas.")}
                            required
                        >
                            <input required value={roles} onChange={(e) => setRoles(e.target.value)} />
                        </Field>
                        <Field
                            label={tx("Plan variables")}
                            longHint={tx("Enter a JSON object with values to use at the start of each run.")}
                            htmlFor="plan-variables"
                            required
                        >
                            <textarea
                                id="plan-variables"
                                aria-required="true"
                                rows={3}
                                value={variables}
                                onChange={(e) => setVariables(e.target.value)}
                            />
                        </Field>
                    </div>
                    <div className="vq-plan-fields">
                        <fieldset aria-describedby="plan-browser-help">
                            <legend>
                                <span className="vq-field-label">
                                    <span className="vq-field-required" aria-hidden="true">
                                        *
                                    </span>
                                    {tx("浏览器 / Browsers")}
                                </span>
                            </legend>
                            <div className="vq-plan-choices">
                                {["chromium", "firefox", "webkit"].map((b) => (
                                    <label key={b} className="check">
                                        <input
                                            type="checkbox"
                                            checked={browsers.includes(b)}
                                            onChange={(e) =>
                                                setBrowsers(
                                                    e.target.checked
                                                        ? [...browsers, b]
                                                        : browsers.filter((v) => v !== b),
                                                )
                                            }
                                        />
                                        {b}
                                    </label>
                                ))}
                            </div>
                            <small id="plan-browser-help" className="vq-field-hint">
                                {tx("Select one or more browsers.")}
                            </small>
                        </fieldset>
                        <fieldset aria-describedby="plan-runtimes-help">
                            <legend>
                                <span className="vq-field-label">
                                    <span className="vq-field-required" aria-hidden="true">
                                        *
                                    </span>
                                    {tx("执行设备 / Runtimes")}
                                </span>
                            </legend>
                            <div className="vq-plan-choices">
                                {runtimes.data?.pages
                                    .flatMap((p) => p.items)
                                    .map((r) => (
                                        <label key={r.id} className="check">
                                            <input
                                                type="checkbox"
                                                checked={runtimeIds.includes(r.id)}
                                                onChange={(e) =>
                                                    setRuntimeIds(
                                                        e.target.checked
                                                            ? [...runtimeIds, r.id]
                                                            : runtimeIds.filter((v) => v !== r.id),
                                                    )
                                                }
                                            />
                                            {r.name} · {tx(`Trust: ${r.trustStatus}`)}
                                        </label>
                                    ))}
                                {runtimeIds
                                    .filter((id) => !runtimes.data?.pages.some((p) => p.items.some((r) => r.id === id)))
                                    .map((id) => (
                                        <label key={id} className="check">
                                            <input
                                                type="checkbox"
                                                checked
                                                onChange={() => setRuntimeIds(runtimeIds.filter((v) => v !== id))}
                                            />
                                            {id}
                                        </label>
                                    ))}
                            </div>
                            {runtimes.hasNextPage && (
                                <Button size="compact" tone="secondary" onClick={() => void runtimes.fetchNextPage()}>
                                    {tx("更多设备 / More Runtimes")}
                                </Button>
                            )}
                            <small id="plan-runtimes-help" className="vq-field-hint">
                                {tx("Select one or more devices.")}
                            </small>
                        </fieldset>
                    </div>
                    <div className="vq-plan-fields">
                        <Field
                            label={tx("Overlap policy")}
                            hint={tx("Choose what happens when a prior run is still active.")}
                            htmlFor="plan-overlap"
                            required
                        >
                            <Select
                                id="plan-overlap"
                                appearance="default-dropdown"
                                required
                                value={policy}
                                onValueChange={(next) => setPolicy(next as Write["overlapPolicy"])}
                            >
                                {(["QUEUE", "SKIP", "REJECT"] as const).map((value) => (
                                    <SelectItem key={value} value={value}>
                                        {tx(`Overlap: ${value}`)}
                                    </SelectItem>
                                ))}
                            </Select>
                        </Field>
                        <Field
                            label={tx("整用例重试 / Case retries")}
                            hint={tx("Maximum retries for an eligible case.")}
                            htmlFor="plan-case-retries"
                            required
                        >
                            <Select
                                id="plan-case-retries"
                                appearance="default-dropdown"
                                required
                                value={String(retries)}
                                onValueChange={(next) => setRetries(Number(next))}
                            >
                                <SelectItem value="0">0</SelectItem>
                                <SelectItem value="1">1</SelectItem>
                            </Select>
                        </Field>
                    </div>
                    <div className="vq-plan-actions">
                        <Button
                            size="regular"
                            type="submit"
                            disabled={busy || !suite || !environment || !runtimeIds.length || !browsers.length}
                        >
                            {tx("保存计划 / Save plan")}
                        </Button>
                        {editing && (
                            <Button size="regular" tone="secondary" onClick={() => edit(null)}>
                                {tx("新建 / New plan")}
                            </Button>
                        )}
                    </div>
                </form>
            )}
            {["OWNER", "ADMIN"].includes(workspace.role) && !workspace.archived && (
                <ServiceAccounts workspace={workspace.id} plans={rows.filter((p) => !p.archived)} signal={signal} />
            )}
        </div>
    );
}

/**
 * 服务身份管理仅把一次性签发值留在本组件内存，关闭显示、切换账号或卸载即清除，分页缓存只保存账号和令牌元数据；签发用途
 * 分别限定维护操作、执行计划或短期设备登记，避免用途混用。
 */
function ServiceAccounts({ workspace, plans, signal }: { workspace: string; plans: Plan[]; signal: AbortSignal }) {
    const { language } = useAppLocale();
    const feedback = useOperationFeedback();
    const base = `/workspaces/${workspace}/service-accounts`,
        cache = useQueryClient();
    const { busy, error, submit } = useAction();
    const [account, setAccount] = useState(""),
        [name, setName] = useState(""),
        [delivery, setDelivery] = useState<{ id: string; secret: string; visible: boolean }>(),
        [purpose, setPurpose] = useState<S["ServiceTokenDTO"]["purpose"]>("EXECUTION"),
        [scopes, setScopes] = useState<string[]>(["trigger", "read", "cancel"]),
        [planIds, setPlanIds] = useState<string[]>([]);
    const accounts = useInfiniteQuery({
        queryKey: ["workspace", workspace, "service-accounts"],
        queryFn: ({ pageParam, signal: q }) =>
            request<Page<S["ServiceAccountDTO"]>>(
                base + (pageParam ? "?cursor=" + encodeURIComponent(pageParam) : ""),
                "GET",
                undefined,
                AbortSignal.any([signal, q]),
            ),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const tokens = useQuery({
        queryKey: ["workspace", workspace, "service-tokens", account],
        queryFn: ({ signal: q }) =>
            collectTablePages(
                (cursor, activeSignal) =>
                    request<S["ServiceTokenPage"]>(
                        base + "/" + account + "/tokens" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
                        "GET",
                        undefined,
                        activeSignal,
                    ),
                AbortSignal.any([signal, q]),
            ),
        enabled: !!account,
    });
    const formatDate = (value: string) => new Date(value).toLocaleString(language, { timeZone: "Asia/Shanghai" });
    // 搜索与下载共用界面已显示的令牌元数据投影；签发时一次性交付的秘密不会进入表格数据。
    const tokenPurpose = ({ purpose }: S["ServiceTokenMetadata"]) => tx(`Token purpose: ${purpose}`);
    const tokenOperations = ({ purpose, operations }: S["ServiceTokenMetadata"]) =>
        operations
            .map((operation) => (purpose === "EXECUTION" ? tx(`Token scope: ${operation}`) : operation))
            .join(", ") || "—";
    const tokenStatus = ({ revoked, consumed }: S["ServiceTokenMetadata"]) =>
        [
            revoked && tx("Token state: revoked"),
            consumed && tx("Token state: consumed"),
            !revoked && !consumed && tx("Token state: issued"),
        ]
            .filter(Boolean)
            .join(" · ");
    const tokenView = useTableView(tokens.data ?? [], {
        scope: account,
        matches: (token, term) =>
            [
                token.id,
                tokenPurpose(token),
                tokenOperations(token),
                tokenStatus(token),
                formatDate(token.expiresAt),
                ...token.planIds,
            ].some((value) => value.toLowerCase().includes(term)),
    });
    const act = (action: Parameters<typeof submit>[0], options?: Parameters<typeof submit>[1]) => {
        setDelivery(undefined);
        return submit(action, options);
    };
    const revokeToken = (id: string, waitingFrom: HTMLElement) =>
        act(
            async (complete) => {
                await request(`${base}/${account}/tokens/${id}/revoke`, "POST", {}, signal);
                complete("Service token revoked.");
                await tokens.refetch();
            },
            { waitingFrom, signal },
        );
    const choices =
        purpose === "EXECUTION"
            ? ["trigger", "read", "cancel"]
            : [
                  "expired-leases/reap",
                  "fixture-cleanups/reconcile",
                  "capacity/reconcile",
                  "artifacts/expire",
                  "lifecycle/expire",
              ];
    return (
        <section className="vq-plan-section" aria-label={tx("Service accounts")}>
            <h2>{tx("服务账号与受限令牌 / Service accounts")}</h2>
            {accounts.isPending && <p role="status">{tx("Loading service accounts…")}</p>}
            {accounts.isSuccess && !accounts.data.pages.some((page) => page.items.length) && (
                <p>{tx("No service accounts yet.")}</p>
            )}
            {(error || accounts.error || tokens.error) && (
                <p role="alert">{tx(error || accounts.error?.message || tokens.error?.message || "")}</p>
            )}
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    void act(
                        async (complete) => {
                            const created = await request<S["ServiceAccountDTO"]>(base, "POST", { name }, signal);
                            if (!signal.aborted) {
                                setAccount(created.id);
                                setName("");
                                complete("Service account created.");
                            }
                            await cache.invalidateQueries({
                                queryKey: ["workspace", workspace, "service-accounts"],
                            });
                        },
                        { waitingFrom: (e.nativeEvent as SubmitEvent).submitter, signal },
                    );
                }}
            >
                <Field
                    label={tx("Service account name")}
                    hint={tx("Name the service that will use this account.")}
                    required
                >
                    <input required maxLength={160} value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Button size="regular" type="submit" disabled={busy}>
                    {tx("创建账号 / Create account")}
                </Button>
            </form>
            <div className="vq-plan-toolbar">
                <Field
                    label={tx("Service account")}
                    hint={tx("Choose an account to manage its tokens.")}
                    htmlFor="plan-service-account"
                >
                    <Select
                        id="plan-service-account"
                        appearance="default-dropdown"
                        disabled={busy}
                        value={account}
                        placeholder={tx("选择账号 / Select account")}
                        onValueChange={(next) => {
                            setAccount(next === UNSELECTED ? "" : next);
                            setDelivery(undefined);
                        }}
                    >
                        <SelectItem value={UNSELECTED}>{tx("选择账号 / Select account")}</SelectItem>
                        {accounts.data?.pages
                            .flatMap((p) => p.items)
                            .map((a) => (
                                <SelectItem key={a.id} value={a.id} disabled={a.disabled}>
                                    {a.name}
                                    {a.disabled ? tx(" (disabled)") : ""}
                                </SelectItem>
                            ))}
                    </Select>
                </Field>
                <div className="vq-plan-actions">
                    {accounts.hasNextPage && (
                        <Button size="compact" tone="secondary" onClick={() => void accounts.fetchNextPage()}>
                            {tx("更多账号 / More accounts")}
                        </Button>
                    )}
                    {account && (
                        <Button
                            size="compact"
                            tone="danger"
                            disabled={busy}
                            onClick={(event) =>
                                void act(
                                    async (complete) => {
                                        await request(base + "/" + account + "/disable", "POST", {}, signal);
                                        if (!signal.aborted) {
                                            setAccount("");
                                            complete(
                                                "Service account disabled; its devices can no longer authenticate.",
                                            );
                                        }
                                        await accounts.refetch();
                                    },
                                    { waitingFrom: event.currentTarget, signal },
                                )
                            }
                        >
                            {tx("禁用账号 / Disable account")}
                        </Button>
                    )}
                </div>
            </div>
            {account && (
                <>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            void act(async () => {
                                const { id, token } = await request<S["ServiceTokenDTO"]>(
                                    base + "/" + account + "/tokens",
                                    "POST",
                                    {
                                        purpose,
                                        ...(purpose !== "RUNTIME_ENROLLMENT" ? { operations: scopes } : {}),
                                        ...(purpose === "EXECUTION" ? { planIds } : {}),
                                    },
                                    signal,
                                );
                                if (signal.aborted) return;
                                // 共享回执只持有无秘密的标识，确认后再按当前令牌标识公开组件内存中暂存的一次性值。
                                setDelivery({ id, secret: token, visible: false });
                                feedback.showSuccess("Service token issued.", () => {
                                    if (signal.aborted) return;
                                    setDelivery((current) =>
                                        current?.id === id ? { ...current, visible: true } : current,
                                    );
                                });
                                await tokens.refetch();
                            });
                        }}
                    >
                        <Field
                            label={tx("Token purpose")}
                            hint={tx("Select the permitted use before issuing a token.")}
                            htmlFor="plan-token-purpose"
                            required
                        >
                            <Select
                                id="plan-token-purpose"
                                appearance="default-dropdown"
                                required
                                disabled={busy}
                                value={purpose}
                                onValueChange={(next) => {
                                    setPurpose(next as S["ServiceTokenDTO"]["purpose"]);
                                    setScopes([]);
                                    setDelivery(undefined);
                                }}
                            >
                                {TOKEN_PURPOSES.map((value) => (
                                    <SelectItem key={value} value={value}>
                                        {tx(`Token purpose: ${value}`)}
                                    </SelectItem>
                                ))}
                            </Select>
                        </Field>
                        <p>
                            {purpose === "RUNTIME_ENROLLMENT"
                                ? tx("10 分钟内一次登记 / One enrollment within 10 minutes")
                                : tx("有效期 24 小时，可立即吊销 / Expires in 24 hours; revocable")}
                        </p>
                        {purpose !== "RUNTIME_ENROLLMENT" && (
                            <fieldset disabled={busy}>
                                <legend>{tx("操作 / Operations")}</legend>
                                <div className="vq-plan-choices">
                                    {choices.map((operation) => (
                                        <label key={operation} className="check">
                                            <input
                                                type="checkbox"
                                                checked={scopes.includes(operation)}
                                                onChange={(e) =>
                                                    setScopes(
                                                        e.target.checked
                                                            ? [...scopes, operation]
                                                            : scopes.filter((s) => s !== operation),
                                                    )
                                                }
                                            />
                                            {purpose === "EXECUTION" ? tx(`Token scope: ${operation}`) : operation}
                                        </label>
                                    ))}
                                </div>
                            </fieldset>
                        )}
                        {purpose === "EXECUTION" && (
                            <fieldset disabled={busy}>
                                <legend>{tx("授权计划 / Allowed plans")}</legend>
                                <small>
                                    {tx(
                                        "服务仅能使用自己拥有或所有者共享到空间的设备。 / Service-owned or " +
                                            "explicitly Workspace-shared Runt" +
                                            "imes only.",
                                    )}
                                </small>
                                <div className="vq-plan-choices">
                                    {plans.map((p) => (
                                        <label key={p.id} className="check">
                                            <input
                                                type="checkbox"
                                                checked={planIds.includes(p.id)}
                                                onChange={(e) =>
                                                    setPlanIds(
                                                        e.target.checked
                                                            ? [...planIds, p.id]
                                                            : planIds.filter((id) => id !== p.id),
                                                    )
                                                }
                                            />
                                            {p.name}
                                        </label>
                                    ))}
                                </div>
                            </fieldset>
                        )}
                        <Button
                            size="regular"
                            type="submit"
                            disabled={
                                busy ||
                                (purpose !== "RUNTIME_ENROLLMENT" && !scopes.length) ||
                                (purpose === "EXECUTION" && !planIds.length)
                            }
                        >
                            {tx("签发令牌 / Issue token")}
                        </Button>
                    </form>
                    {delivery?.visible && (
                        <section className="vq-token-delivery" aria-label={tx("One-time token")}>
                            <p>{tx("仅显示一次，请保存到 CI 秘密变量。 / Shown once; save in CI secrets.")}</p>
                            <output>{delivery.secret}</output>
                            <Button size="compact" tone="secondary" onClick={() => setDelivery(undefined)}>
                                {tx("关闭令牌 / Dismiss token")}
                            </Button>
                        </section>
                    )}
                    {tokens.isPending && <p role="status">{tx("Loading tokens…")}</p>}
                    {(tokens.isSuccess || !!tokens.data?.length) && (
                        <DataTable
                            label={tx("Service tokens")}
                            view={tokenView}
                            searchLabel={tx("Search service tokens")}
                            busy={busy || tokens.isFetching || tokens.isError}
                            exportColumns={[
                                { label: tx("Token ID"), value: ({ id }) => id },
                                { label: tx("Token purpose"), value: tokenPurpose },
                                { label: tx("Token expiry"), value: ({ expiresAt }) => formatDate(expiresAt) },
                                { label: tx("操作 / Operations"), value: tokenOperations },
                                {
                                    label: tx("授权计划 / Allowed plans"),
                                    value: ({ planIds }) => planIds.join(", ") || "—",
                                },
                                { label: tx("Status"), value: tokenStatus },
                            ]}
                        >
                            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: 保留键盘横向滚动入口。 */}
                            <section className="table-scroll" aria-label={tx("Service tokens")} tabIndex={0}>
                                <table className="vq-plan-table vq-token-table" aria-label={tx("Service tokens")}>
                                    <thead>
                                        <tr>
                                            <th scope="col">{tx("Token ID")}</th>
                                            <th scope="col">{tx("Token purpose")}</th>
                                            <th scope="col">{tx("Token expiry")}</th>
                                            <th scope="col">{tx("操作 / Operations")}</th>
                                            <th scope="col">{tx("授权计划 / Allowed plans")}</th>
                                            <th scope="col">{tx("Status")}</th>
                                            <th scope="col">{tx("Actions")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {tokenView.filteredCount === 0 && (
                                            <tr>
                                                <td className="vq-table-empty" colSpan={7}>
                                                    {tx(
                                                        tokens.data?.length
                                                            ? "No matching service tokens."
                                                            : "No tokens issued for this account.",
                                                    )}
                                                </td>
                                            </tr>
                                        )}
                                        {tokenView.rows.map((token) => (
                                            <tr key={token.id}>
                                                <th scope="row">{token.id}</th>
                                                <td>{tokenPurpose(token)}</td>
                                                <td>
                                                    <time dateTime={token.expiresAt}>
                                                        {formatDate(token.expiresAt)}
                                                    </time>
                                                </td>
                                                <td>{tokenOperations(token)}</td>
                                                <td>{token.planIds.join(", ") || "—"}</td>
                                                <td>{tokenStatus(token)}</td>
                                                <td>
                                                    {!token.revoked && (
                                                        <Button
                                                            size="compact"
                                                            tone="danger"
                                                            disabled={busy}
                                                            onClick={(event) =>
                                                                void revokeToken(token.id, event.currentTarget)
                                                            }
                                                        >
                                                            {tx("吊销 / Revoke")}
                                                        </Button>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </section>
                        </DataTable>
                    )}
                </>
            )}
        </section>
    );
}
