/**
 * AI 页在当前工作区预览上下文、发起生成并审核输出，历史共享筛选与分页，刷新后可取消仍在进行的本地调用。
 */

import { tx, useAppLocale } from "../../locale";
import { useCallback, useContext, useEffect, useId, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { validateSchema, type PlatformComponents } from "@veriq/contracts";
import { ApiError, type Workspace } from "../../api";
import { Auth } from "../../auth-context";
import { Button, Field, Select, SelectItem } from "../../components";
import { useOperationFeedback } from "../../operation-feedback";
import { canExportWorkspaceTable, collectTablePages, DataTable, useTableView } from "../../table-view";
import { Panel } from "../../ui";
import { ChoiceFilter } from "../workspaces/ChoiceFilter";
import { useWorkspaceDirectory, WorkspaceStatus } from "../workspaces/WorkspaceDirectory";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { ResourceEditorView } from "../resources/ResourcePage";
import { CloudResourceAdapter, type ResourceAdapter } from "../resources/adapters";
import { CloudAiAdapter, type AiAdapter, type Generation, type GenerationRequest } from "./adapters";
import { aiI18n } from "./i18n";
import { useProviderDirectory } from "./ProviderControls";
type S = PlatformComponents["schemas"];
const useLabels = () => useTranslation("ai", { i18n: aiI18n }).t;
const json = (v: unknown) => JSON.stringify(v, null, 2);
const callStatuses = ["RUNNING", "SUCCEEDED", "FAILED", "REVIEWED", "REJECTED", "CANCELLED"] as const;
const generationPurposes = ["CASE_DRAFT", "BOUNDARY_SUGGESTION", "FAILURE_ANALYSIS"] as const;
const contextReferences = [
    ["versions", "versions", "versionsHint"],
    ["resourceId", "resource", "resourceHint"],
    ["runId", "run", "runHint"],
] as const;
const matchesCall = (call: Generation, term: string) =>
    [call.purpose, call.status, call.createdAt].some((value) => value.toLowerCase().includes(term));
/**
 * 按照顶部目录选中的工作区建立模型与资源适配器，切换空间时替换表单并停止原空间的异步任务。
 */
export function AiPage() {
    useAppLocale();
    const { user } = useContext(Auth);
    const { workspace } = useWorkspaceDirectory();
    const { selected, signal } = useWorkspace();
    const t = useLabels();
    const adapter = useMemo(() => new CloudAiAdapter(selected), [selected]);
    const resources = useMemo(() => new CloudResourceAdapter(selected), [selected]);
    if (!user) return <Navigate to="/login" />;
    return (
        <Panel title={t("title")}>
            <WorkspaceStatus />
            {workspace && (
                <AiWorkspaceView
                    key={user.id + selected}
                    workspace={workspace}
                    adapter={adapter}
                    resources={resources}
                    signal={signal}
                />
            )}
        </Panel>
    );
}
/**
 * 请求输入保留表单中的原始字符串以及明确的生成用途，只有这八个字段参与人工上下文审核失效；Provider 编辑器和已完成的生
 * 成历史拥有独立状态，不能被输入变更一起清空。
 */
type RequestInputs = {
    providerId: string;
    purpose: GenerationRequest["purpose"];
    prompt: string;
    versions: string;
    openapi: string;
    data: string;
    resourceId: string;
    runId: string;
};
/**
 * 人工预览和已审核请求与当前输入集中存储，使每次真实输入变更能够原子清除两份审核结果；成功预览只合并审核数据而保留当前
 * 输入，响应归属仍由现有工作区生命周期决定。
 */
type RequestState = {
    inputs: RequestInputs;
    preview?: S["AiContextDTO"];
    reviewedRequest?: GenerationRequest;
};
/**
 * 生成表单仅使用当前工作区的 Provider，调用记录与生成草稿分开管理，状态筛选和切页不会改变已审核输入。
 * 输出须由人员审核后应用为草稿，通过资源编辑器另行验证和发布。
 */
export function AiWorkspaceView({
    workspace,
    adapter,
    resources,
    signal: parent,
}: {
    workspace: Workspace;
    adapter: AiAdapter;
    resources: ResourceAdapter;
    signal?: AbortSignal;
}) {
    useAppLocale();
    const t = useLabels();
    const { showPending } = useOperationFeedback();
    const { signal, providers, rows, busy, error, setError, action } = useProviderDirectory(workspace, adapter, parent);
    const edit = ["OWNER", "ADMIN", "EDITOR"].includes(workspace.role) && !workspace.archived;
    const [generating, setGenerating] = useState(false);
    const [requestState, setRequestState] = useState<RequestState>({
        inputs: {
            providerId: "",
            purpose: "CASE_DRAFT",
            prompt: "",
            versions: "",
            openapi: "{}",
            data: "{}",
            resourceId: "",
            runId: "",
        },
    });
    const { inputs, preview, reviewedRequest } = requestState;
    const { providerId, purpose, prompt, versions, openapi, data, resourceId, runId } = inputs;
    /**
     * 所有请求字段写入共用稳定回调，并在函数式更新内比较原始值；同值编辑保持原审核对象，实际编辑即使随后恢复原值也须重
     * 新预览，状态更新器不触发其他状态或清理副作用。
     */
    const changeInput = useCallback(<K extends keyof RequestInputs>(field: K, value: RequestInputs[K]) => {
        setRequestState((current) =>
            Object.is(current.inputs[field], value)
                ? current
                : {
                      ...current,
                      inputs: { ...current.inputs, [field]: value },
                      preview: undefined,
                      reviewedRequest: undefined,
                  },
        );
    }, []);
    const [generation, setGeneration] = useState<Generation>(),
        [viewed, setViewed] = useState<Generation | null>(null),
        [editorId, setEditorId] = useState("");
    const historyLabel = useId();
    const requestField = useId();
    const [callStatus, setCallStatus] = useState("");
    const history = useQuery({
        queryKey: ["workspace", workspace.id, "ai", "history"],
        // 搜索和状态筛选覆盖整个工作区历史，连续查询取得完整范围后才渲染，以免把未读取的记录当作无匹配。
        queryFn: ({ signal: querySignal }) =>
            collectTablePages(
                (cursor, request) => adapter.history(cursor, request),
                AbortSignal.any([signal, querySignal]),
            ),
    });
    const sources = useInfiniteQuery({
        queryKey: ["workspace", workspace.id, "ai", "sources"],
        queryFn: ({ pageParam }) => resources.list(undefined, pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const historyDenied = history.error instanceof ApiError && [401, 403, 404].includes(history.error.status);
    const calls = useMemo(
        () => (historyDenied ? [] : (history.data ?? []).filter((call) => !callStatus || call.status === callStatus)),
        [history.data, historyDenied, callStatus],
    );
    const callView = useTableView(calls, { matches: matchesCall, scope: workspace.id });
    const provider = rows.find((p) => p.id === providerId);
    const setProvider = useCallback((id: string) => changeInput("providerId", id), [changeInput]);
    const firstProviderId = rows[0]?.id;
    useEffect(() => {
        if (!providerId && firstProviderId) setProvider(firstProviderId);
    }, [providerId, firstProviderId, setProvider]);
    const refresh = () => history.refetch();
    const makeRequest = (): GenerationRequest => ({
        requestId: crypto.randomUUID(),
        providerId,
        purpose,
        prompt,
        versionIds: versions
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        openapi: JSON.parse(openapi.trim() || "{}"),
        data: JSON.parse(data.trim() || "{}"),
        ...(resourceId ? { resourceId } : {}),
        ...(runId ? { runId } : {}),
    });
    const editor = useQuery({
        queryKey: ["workspace", workspace.id, "ai", "editor", editorId],
        queryFn: async () => ({
            resource: await adapter.resource(editorId, signal),
            draft: await resources.draft(editorId, signal),
        }),
        enabled: !!editorId,
    });
    const requestDisabled = !edit || busy || generating;
    const runRequired = purpose === "FAILURE_ANALYSIS";
    return (
        <div className="vq-ai vq-ai-workbench">
            <p>{t("independent")}</p>
            <p>{t("privacy")}</p>
            <p>{t("estimate")}</p>
            {!edit && <p>{t("readonly")}</p>}
            {(error || providers.error || history.error || sources.error) && (
                <p role="alert">
                    {error || providers.error?.message || history.error?.message || sources.error?.message}
                </p>
            )}
            {providers.isPending && <p role="status">{t("loading")}</p>}
            {!providers.isPending && !rows.length && <p>{t("empty")}</p>}
            <div className="vq-ai-request-options">
                <Field label={t("provider")} htmlFor={requestField + "-provider"} hint={t("providerHint")} required>
                    <Select
                        id={requestField + "-provider"}
                        appearance="default-dropdown"
                        placeholder="—"
                        disabled={busy || generating || !rows.length}
                        required
                        value={providerId}
                        onValueChange={setProvider}
                    >
                        {rows.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                                {p.name} · {p.enabled ? t("enabled") : t("disabled")}
                            </SelectItem>
                        ))}
                    </Select>
                </Field>
                <Field label={t("purpose")} htmlFor={requestField + "-purpose"} hint={t("purposeHint")} required>
                    <Select
                        id={requestField + "-purpose"}
                        appearance="default-dropdown"
                        disabled={requestDisabled}
                        required
                        value={purpose}
                        onValueChange={(value) => changeInput("purpose", value as GenerationRequest["purpose"])}
                    >
                        {generationPurposes.map((value) => (
                            <SelectItem key={value} value={value}>
                                {value}
                            </SelectItem>
                        ))}
                    </Select>
                </Field>
            </div>
            <fieldset className="vq-ai-request" disabled={requestDisabled}>
                <legend>{t("selected")}</legend>
                <div className="vq-ai-wide-field">
                    <Field
                        label={t("requirement")}
                        htmlFor={requestField + "-prompt"}
                        hint={t("requirementHint")}
                        required
                    >
                        <textarea
                            id={requestField + "-prompt"}
                            required
                            maxLength={16000}
                            value={prompt}
                            onChange={(e) => changeInput("prompt", e.target.value)}
                        />
                    </Field>
                </div>
                {contextReferences.map(([field, label, hint]) => {
                    const id = requestField + "-" + field;
                    const required = field === "runId" && runRequired;
                    return (
                        <Field key={field} label={t(label)} htmlFor={id} hint={t(hint)} required={required}>
                            <input
                                id={id}
                                required={required}
                                value={inputs[field]}
                                onChange={(e) => changeInput(field, e.target.value)}
                            />
                        </Field>
                    );
                })}
                <Field label={t("openapi")} htmlFor={requestField + "-openapi"} hint={t("openapiHint")}>
                    <textarea
                        id={requestField + "-openapi"}
                        value={openapi}
                        onChange={(e) => changeInput("openapi", e.target.value)}
                    />
                </Field>
                <Field label={t("data")} htmlFor={requestField + "-data"} hint={t("dataHint")}>
                    <textarea
                        id={requestField + "-data"}
                        value={data}
                        onChange={(e) => changeInput("data", e.target.value)}
                    />
                </Field>
                <details className="vq-ai-wide-field">
                    <summary>{t("selected")}</summary>
                    {sources.data?.pages
                        .flatMap((p) => p.items)
                        .filter((r) => !["ENVIRONMENT", "SUITE"].includes(r.kind))
                        .map((r) => (
                            <div key={r.id} className="vq-ai-actions">
                                <span>
                                    {r.name} · {r.kind}
                                </span>
                                {r.latestVersionId && (
                                    <Button
                                        size="compact"
                                        tone="secondary"
                                        onClick={() =>
                                            changeInput(
                                                "versions",
                                                [
                                                    ...new Set([
                                                        ...versions.split(",").filter(Boolean),
                                                        r.latestVersionId!,
                                                    ]),
                                                ].join(","),
                                            )
                                        }
                                    >
                                        {t("use")}
                                    </Button>
                                )}
                                {r.kind === "CASE" && (
                                    <Button
                                        size="compact"
                                        tone="secondary"
                                        onClick={() => changeInput("resourceId", r.id)}
                                    >
                                        {t("target")}
                                    </Button>
                                )}
                            </div>
                        ))}
                    {sources.hasNextPage && (
                        <Button size="compact" tone="secondary" onClick={() => void sources.fetchNextPage()}>
                            {t("more")}
                        </Button>
                    )}
                </details>
                <Button
                    size="regular"
                    disabled={!provider?.enabled || !prompt || (runRequired && !runId.trim())}
                    onClick={() =>
                        void action(async () => {
                            const req = makeRequest();
                            const p = await adapter.preview(req, signal);
                            if (signal.aborted) return;
                            setRequestState((current) => ({
                                ...current,
                                preview: p,
                                reviewedRequest: { ...req, contextHash: p.contextHash },
                            }));
                        }, null)
                    }
                >
                    {t("preview")}
                </Button>
            </fieldset>
            {preview && (
                <section>
                    <h3>{t("context")}</h3>
                    <pre>{json(preview.context)}</pre>
                    <pre>{json(preview.provenance)}</pre>
                    <p>
                        {preview.inputTokenBound} {tx(" tokens · USD ")}
                        {preview.reservedUsd}
                    </p>
                    <Button
                        size="regular"
                        disabled={busy || generating || !edit || !reviewedRequest}
                        onClick={(event) => {
                            if (!reviewedRequest) return;
                            // 关闭等待框只退出提示，已分配的调用仍可从历史刷新和取消，切换工作区才清理当前反馈。
                            const feedback = showPending(t("pending"), {
                                trigger: event.currentTarget,
                                onClose: () => {},
                            });
                            signal.addEventListener("abort", feedback.dismiss, { once: true });
                            setGenerating(true);
                            setError("");
                            void adapter
                                .generate(reviewedRequest, signal)
                                .then(async (g) => {
                                    if (!signal.aborted) {
                                        setGeneration(g);
                                        setRequestState((current) => ({
                                            ...current,
                                            reviewedRequest: undefined,
                                        }));
                                        // 仅 FAILED 显示失败反馈，取消时收起等待框，刷新历史后可查看该次生成的记录。
                                        if (g.status === "FAILED") {
                                            feedback.complete("failure", g.errorCode ?? t("generationFailed"));
                                        } else if (g.status === "SUCCEEDED") {
                                            feedback.complete("success", t("generationSucceeded"));
                                        } else {
                                            feedback.dismiss();
                                        }
                                        await refresh();
                                    }
                                })
                                .catch((failure: unknown) => {
                                    if (!signal.aborted) {
                                        feedback.complete(
                                            "failure",
                                            failure instanceof Error ? failure.message : t("generationFailed"),
                                        );
                                    }
                                })
                                .finally(() => {
                                    signal.removeEventListener("abort", feedback.dismiss);
                                    if (!signal.aborted) setGenerating(false);
                                });
                        }}
                    >
                        {t("generate")}
                    </Button>
                </section>
            )}
            <section aria-labelledby={historyLabel}>
                <div className="vq-ai-pagination">
                    <h3 id={historyLabel}>{t("history")}</h3>
                    <button
                        type="button"
                        className="vq-icon-button"
                        aria-label={t("refresh")}
                        onClick={() => void action(refresh)}
                    >
                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <path
                                d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                            />
                            <path
                                d="M13.5 2.5V6H10"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </svg>
                    </button>
                </div>
                <DataTable
                    label={t("history")}
                    view={callView}
                    searchLabel={t("searchCalls")}
                    paginationLabel={t("callPages")}
                    exportAllowed={canExportWorkspaceTable(workspace.role)}
                    busy={history.isFetching || history.isError || signal.aborted}
                    exportColumns={[
                        { label: t("purpose"), value: (call) => call.purpose },
                        { label: t("status"), value: (call) => call.status },
                        { label: t("time"), value: (call) => call.createdAt },
                        {
                            label: t("cost"),
                            value: (call) => (call.costState === "UNKNOWN" ? t("unknown") : "USD " + call.costUsd),
                        },
                        { label: t("tokensIn"), value: (call) => call.inputTokens ?? "?" },
                        { label: t("tokensOut"), value: (call) => call.outputTokens ?? "?" },
                    ]}
                    filters={
                        <div className="vq-ai-call-filters">
                            <ChoiceFilter
                                label={t("filterCallStatus")}
                                value={callStatus}
                                choices={[["", t("all")], ...callStatuses.map((value) => [value, value] as const)]}
                                onChange={(value) => {
                                    setCallStatus(value);
                                    callView.setPage(1);
                                }}
                            />
                        </div>
                    }
                >
                    {history.isPending && <p role="status">{t("loading")}</p>}
                    {(history.isSuccess || callView.filteredCount > 0) && (
                        <div className="table-scroll">
                            <table className="vq-user-table" aria-labelledby={historyLabel}>
                                <thead>
                                    <tr>
                                        <th>{t("purpose")}</th>
                                        <th>{t("status")}</th>
                                        <th>{t("time")}</th>
                                        <th>{t("cost")}</th>
                                        <th>{t("tokensIn")}</th>
                                        <th>{t("tokensOut")}</th>
                                        <th>{t("action")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {callView.filteredCount === 0 && (
                                        <tr>
                                            <td className="vq-table-empty" colSpan={7}>
                                                {t(history.data?.length ? "noMatchingCalls" : "noHistory")}
                                            </td>
                                        </tr>
                                    )}
                                    {callView.rows.map((g) => (
                                        <tr key={g.id}>
                                            <td>{g.purpose}</td>
                                            <td>{g.status}</td>
                                            <td>{g.createdAt}</td>
                                            <td>{g.costState === "UNKNOWN" ? t("unknown") : "USD " + g.costUsd}</td>
                                            <td>{g.inputTokens ?? "?"}</td>
                                            <td>{g.outputTokens ?? "?"}</td>
                                            <td>
                                                <Button
                                                    size="compact"
                                                    tone="secondary"
                                                    onClick={() =>
                                                        void action(async () => {
                                                            const value = await adapter.get(g.id, signal);
                                                            if (!signal.aborted) setViewed(value);
                                                        })
                                                    }
                                                >
                                                    {t("view")}
                                                </Button>
                                                {g.status === "RUNNING" && edit && (
                                                    <Button
                                                        size="compact"
                                                        tone="danger"
                                                        onClick={() =>
                                                            void action(async () => {
                                                                await adapter.cancel(g.id, signal);
                                                                await refresh();
                                                            }, null)
                                                        }
                                                    >
                                                        {t("cancel")}
                                                    </Button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </DataTable>
            </section>
            {generation && (
                <section>
                    <h3>
                        {t("output")} · {generation.status}
                    </h3>
                    <GenerationDetail
                        generation={generation}
                        onReviewed={setGeneration}
                        onEdit={setEditorId}
                        edit={edit}
                        busy={busy}
                        action={action}
                        adapter={adapter}
                        signal={signal}
                        refresh={refresh}
                    />
                </section>
            )}
            {editor.error && <p role="alert">{editor.error.message}</p>}
            {editor.data && (
                <ResourceEditorView
                    key={editorId}
                    resource={editor.data.resource}
                    initial={editor.data.draft}
                    adapter={resources}
                    workspace={workspace}
                    signal={signal}
                    refresh={async () => {
                        await editor.refetch();
                    }}
                    onResource={() => void editor.refetch()}
                />
            )}
            <Dialog.Root
                open={!!viewed}
                onOpenChange={(open) => {
                    if (!open) setViewed(null);
                }}
            >
                <Dialog.Portal>
                    <Dialog.Overlay className="vq-ai-dialog-overlay" />
                    <Dialog.Content className="vq-ai-dialog">
                        <div className="vq-card-heading">
                            <Dialog.Title>
                                {t("output")} · {viewed?.status ?? ""}
                            </Dialog.Title>
                            <Dialog.Close className="vq-sheet-close" aria-label={tx("Close")}>
                                ×
                            </Dialog.Close>
                        </div>
                        {viewed && (
                            <GenerationDetail
                                generation={viewed}
                                onReviewed={setViewed}
                                onEdit={(id) => {
                                    setViewed(null);
                                    setEditorId(id);
                                }}
                                edit={edit}
                                busy={busy}
                                action={action}
                                adapter={adapter}
                                signal={signal}
                                refresh={refresh}
                            />
                        )}
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </div>
    );
}

/**
 * 生成详情：展示一次 AI 生成的状态、诊断与 original/output diff，并对 SUCCEEDED 记录提供接受/拒绝审核。
 * 内联「输出」区与「查看」弹窗共用；审核完成后通过 onReviewed 交回宿主更新对应状态。
 */
function GenerationDetail({
    generation,
    onReviewed,
    onEdit,
    edit,
    busy,
    action,
    adapter,
    signal,
    refresh,
}: {
    generation: Generation;
    onReviewed: (g: Generation) => void;
    onEdit: (resourceId: string) => void;
    edit: boolean;
    busy: boolean;
    action: (fn: () => Promise<unknown>, result?: string | null) => void;
    adapter: AiAdapter;
    signal: AbortSignal;
    refresh: () => Promise<unknown>;
}) {
    const t = useLabels();
    const reviewField = useId();
    const [key, setResourceKey] = useState("");
    const [name, setName] = useState("");
    return (
        <>
            <p>{t("review")}</p>
            {generation.errorCode && <p role="alert">{generation.errorCode}</p>}
            {generation.diagnostics && (
                <pre>
                    {t("diagnostics")}: {json(generation.diagnostics)}
                </pre>
            )}
            <div className="vq-ai-diff">
                <div>
                    <h4>{t("original")}</h4>
                    <pre>{json(generation.original ?? null)}</pre>
                </div>
                <div>
                    <h4>{t("output")}</h4>
                    <pre>{json(generation.output ?? null)}</pre>
                </div>
            </div>
            {generation.status === "SUCCEEDED" && edit && (
                <fieldset className="vq-ai-review" disabled={busy}>
                    {!generation.resourceId && generation.purpose === "CASE_DRAFT" && (
                        <>
                            <Field label={t("keyName")} htmlFor={reviewField + "-key"} hint={t("keyNameHint")} required>
                                <input
                                    id={reviewField + "-key"}
                                    required
                                    value={key}
                                    onChange={(e) => setResourceKey(e.target.value)}
                                />
                            </Field>
                            <Field
                                label={t("resourceName")}
                                htmlFor={reviewField + "-name"}
                                hint={t("resourceNameHint")}
                                required
                            >
                                <input
                                    id={reviewField + "-name"}
                                    required
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                />
                            </Field>
                        </>
                    )}
                    <div className="vq-ai-actions vq-ai-wide-field">
                        {generation.purpose === "CASE_DRAFT" && (
                            <Button
                                size="regular"
                                disabled={
                                    generation.resourceId
                                        ? !generation.revision
                                        : !name.trim() || name.length > 160 || validateSchema("Key", key).length > 0
                                }
                                onClick={() =>
                                    void action(async () => {
                                        const g = await adapter.review(
                                            generation.id,
                                            {
                                                decision: "ACCEPT_DRAFT",
                                                ...(generation.resourceId
                                                    ? { revision: generation.revision }
                                                    : { key, name }),
                                            },
                                            signal,
                                        );
                                        if (signal.aborted) return;
                                        onReviewed(g);
                                        await refresh();
                                    }, null)
                                }
                            >
                                {t("apply")}
                            </Button>
                        )}
                        <Button
                            size="regular"
                            tone="danger"
                            onClick={() =>
                                void action(async () => {
                                    const g = await adapter.review(generation.id, { decision: "REJECT" }, signal);
                                    if (signal.aborted) return;
                                    onReviewed(g);
                                    await refresh();
                                }, null)
                            }
                        >
                            {t("reject")}
                        </Button>
                    </div>
                </fieldset>
            )}
            {generation.status === "REVIEWED" && generation.resourceId && (
                <Button size="regular" tone="secondary" onClick={() => onEdit(generation.resourceId!)}>
                    {t("edit")}
                </Button>
            )}
        </>
    );
}
