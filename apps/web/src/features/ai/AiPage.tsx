/**
 * AI 页：选择 Workspace 后配置 Provider、预览上下文、触发生成并审核历史记录。历史刷新可取消进行中的预留。
 * CloudAiAdapter(selected)；无模型凭证时测试用例仍可加载本页静态结构。
 */

import { tx, useAppLocale } from "../../locale";
import { useCallback, useContext, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { validateSchema, type PlatformComponents } from "@veriq/contracts";
import { type Workspace } from "../../api";
import { Auth } from "../../auth-context";
import { Panel } from "../../ui";
import { useWorkspaceDirectory, WorkspaceStatus } from "../workspaces/WorkspaceDirectory";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { ResourceEditorView } from "../resources/ResourcePage";
import { CloudResourceAdapter, type ResourceAdapter } from "../resources/adapters";
import { CloudAiAdapter, type AiAdapter, type Generation, type GenerationRequest } from "./adapters";
import { aiI18n } from "./i18n";
import { ProviderControls, useProviderDirectory } from "./ProviderControls";
type S = PlatformComponents["schemas"];
const useLabels = () => useTranslation("ai", { i18n: aiI18n }).t;
const json = (v: unknown) => JSON.stringify(v, null, 2);
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
 * 拥有 Provider 表单、生成请求、历史无限查询与审核动作等 UI 状态。Provider 禁用后隐藏生成按钮；Provider 一旦禁用就必须
 * 隐藏生成入口按钮。
 * 调用 adapter.providers/generate/review/cancel；输出需人工审核，不会自动 publish。
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
    const directory = useProviderDirectory(workspace, adapter, parent);
    const { signal, providers, rows, busy, error, setError, action } = directory;
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
        [key, setResourceKey] = useState(""),
        [name, setName] = useState(""),
        [editorId, setEditorId] = useState("");
    const history = useInfiniteQuery({
        queryKey: ["workspace", workspace.id, "ai", "history"],
        queryFn: ({ pageParam }) => adapter.history(pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const sources = useInfiniteQuery({
        queryKey: ["workspace", workspace.id, "ai", "sources"],
        queryFn: ({ pageParam }) => resources.list(undefined, pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const calls = history.data?.pages.flatMap((p) => p.items) ?? [];
    const provider = rows.find((p) => p.id === providerId);
    const setProvider = useCallback((id: string) => changeInput("providerId", id), [changeInput]);
    const refresh = async () => {
        const [updated] = await Promise.all([directory.refreshProviders(), history.refetch()]);
        return updated;
    };
    const makeRequest = (): GenerationRequest => ({
        requestId: crypto.randomUUID(),
        providerId,
        purpose,
        prompt,
        versionIds: versions
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        openapi: JSON.parse(openapi),
        data: JSON.parse(data),
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
    return (
        <div className="vq-ai">
            <p>{t("independent")}</p>
            <p>{t("privacy")}</p>
            <p>{t("estimate")}</p>
            {!edit && <p>{t("readonly")}</p>}
            {(error || providers.error || history.error || sources.error) && (
                <p role="alert">
                    {error || providers.error?.message || history.error?.message || sources.error?.message}
                </p>
            )}
            {(busy || providers.isPending) && <p role="status">{t("loading")}</p>}
            <ProviderControls
                key={directory.manage ? "manage" : "read-only"}
                directory={directory}
                providerId={providerId}
                onSelect={setProvider}
                refresh={refresh}
                onTest={(result) => setGeneration(result)}
            />
            <fieldset disabled={!edit || busy || generating}>
                <legend>{t("selected")}</legend>
                <p>{t("privacy")}</p>
                <label>
                    {t("purpose")}
                    <select
                        value={purpose}
                        onChange={(e) => changeInput("purpose", e.target.value as GenerationRequest["purpose"])}
                    >
                        <option>CASE_DRAFT</option>
                        <option>BOUNDARY_SUGGESTION</option>
                        <option>FAILURE_ANALYSIS</option>
                    </select>
                </label>
                <label>
                    {t("requirement")}
                    <textarea
                        maxLength={16000}
                        value={prompt}
                        onChange={(e) => changeInput("prompt", e.target.value)}
                    />
                </label>
                {(["versions", "resourceId", "runId"] as const).map((field, i) => (
                    <label key={field}>
                        {t((["versions", "resource", "run"] as const)[i]!)}
                        <input value={inputs[field]} onChange={(e) => changeInput(field, e.target.value)} />
                    </label>
                ))}
                <label>
                    {t("openapi")}
                    <textarea value={openapi} onChange={(e) => changeInput("openapi", e.target.value)} />
                </label>
                <label>
                    {t("data")}
                    <textarea value={data} onChange={(e) => changeInput("data", e.target.value)} />
                </label>
                <details>
                    <summary>{t("selected")}</summary>
                    {sources.data?.pages
                        .flatMap((p) => p.items)
                        .filter((r) => !["ENVIRONMENT", "SUITE"].includes(r.kind))
                        .map((r) => (
                            <p key={r.id}>
                                {r.name} · {r.kind}{" "}
                                {r.latestVersionId && (
                                    <button
                                        type="button"
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
                                    </button>
                                )}
                                {r.kind === "CASE" && (
                                    <button type="button" onClick={() => changeInput("resourceId", r.id)}>
                                        {t("target")}
                                    </button>
                                )}
                            </p>
                        ))}
                    {sources.hasNextPage && (
                        <button type="button" onClick={() => void sources.fetchNextPage()}>
                            {t("more")}
                        </button>
                    )}
                </details>
                <button
                    type="button"
                    disabled={!provider?.enabled || !prompt}
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
                        })
                    }
                >
                    {t("preview")}
                </button>
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
                    <button
                        type="button"
                        disabled={busy || generating || !edit || !reviewedRequest}
                        onClick={() => {
                            if (!reviewedRequest) return;
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
                                        await refresh();
                                    }
                                })
                                .catch((e) => {
                                    if (!signal.aborted) setError(e.message);
                                })
                                .finally(() => {
                                    if (!signal.aborted) setGenerating(false);
                                });
                        }}
                    >
                        {t("generate")}
                    </button>
                </section>
            )}
            {generating && <p role="status">{t("pending")}</p>}
            <section>
                <h3>{t("history")}</h3>
                <button type="button" onClick={() => void action(refresh)}>
                    {t("refresh")}
                </button>
                {!calls.length && <p>{t("noHistory")}</p>}
                <ul>
                    {calls.map((g) => (
                        <li key={g.id}>
                            <button
                                type="button"
                                onClick={() =>
                                    void action(async () => {
                                        const value = await adapter.get(g.id, signal);
                                        if (!signal.aborted) setGeneration(value);
                                    })
                                }
                            >
                                {g.purpose} · {g.status} · {g.createdAt}
                            </button>{" "}
                            {`${g.costState === "UNKNOWN" ? t("unknown") : "USD " + g.costUsd}` +
                                ` (${g.inputTokens ?? "?"} / ${g.outputTokens ?? "?"} ${tx(" tokens)")}`}{" "}
                            {g.status === "RUNNING" && edit && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        void action(async () => {
                                            await adapter.cancel(g.id, signal);
                                            await refresh();
                                        })
                                    }
                                >
                                    {t("cancel")}
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
                {history.hasNextPage && (
                    <button type="button" onClick={() => void history.fetchNextPage()}>
                        {t("more")}
                    </button>
                )}
            </section>
            {generation && (
                <section>
                    <h3>
                        {t("output")} · {generation.status}
                    </h3>
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
                        <fieldset disabled={busy}>
                            {!generation.resourceId && generation.purpose === "CASE_DRAFT" && (
                                <>
                                    <label>
                                        {t("keyName")}
                                        <input value={key} onChange={(e) => setResourceKey(e.target.value)} />
                                    </label>
                                    <label>
                                        {t("resourceName")}
                                        <input value={name} onChange={(e) => setName(e.target.value)} />
                                    </label>
                                </>
                            )}
                            {generation.purpose === "CASE_DRAFT" && (
                                <button
                                    type="button"
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
                                            setGeneration(g);
                                            await refresh();
                                        })
                                    }
                                >
                                    {t("apply")}
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() =>
                                    void action(async () => {
                                        const g = await adapter.review(generation.id, { decision: "REJECT" }, signal);
                                        if (signal.aborted) return;
                                        setGeneration(g);
                                        await refresh();
                                    })
                                }
                            >
                                {t("reject")}
                            </button>
                        </fieldset>
                    )}
                    {generation.status === "REVIEWED" && generation.resourceId && (
                        <button type="button" onClick={() => setEditorId(generation.resourceId!)}>
                            {t("edit")}
                        </button>
                    )}
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
        </div>
    );
}
