/**
 * AI 页：选择 Workspace 后配置 Provider、预览上下文、触发生成并审核历史记录。历史刷新可取消进行中的预留。
 * CloudAiAdapter(selected)；无模型凭证时测试用例仍可加载本页静态结构。
 */

import { tx, useAppLocale } from "../../locale";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { validateSchema, type PlatformComponents } from "@veriq/contracts";
import { api, type Workspace } from "../../api";
import { Auth } from "../../auth-context";
import { Panel } from "../../ui";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { ResourceEditorView } from "../resources/ResourcePage";
import { CloudResourceAdapter, type ResourceAdapter } from "../resources/adapters";
import {
    CloudAiAdapter,
    type AiAdapter,
    type Generation,
    type GenerationRequest,
    type Provider,
} from "./adapters";
import { aiI18n } from "./i18n";
import "./ai.css";
type S = PlatformComponents["schemas"];
const useLabels = () => useTranslation("ai", { i18n: aiI18n }).t;
const json = (v: unknown) => JSON.stringify(v, null, 2);
const defaults: S["ProviderWrite"] = {
    name: "",
    adapter: "OPENAI_COMPATIBLE",
    baseURL: "https://api.openai.com/v1",
    model: "",
    enabled: false,
    monthlyBudgetUsd: 1,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    maxOutputTokens: 1024,
    maxRequestUsd: 0.5,
};
/**
 * 工作区选择壳：默认选中首个空间，再渲染 AiWorkspaceView 并传入 adapter 与 signal。无空间时提示先创建或加入。未登录重
 * 定向；自身不缓存 generation 表单以免切换空间泄漏。
 */
export function AiPage() {
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
    const items = workspaces.data?.pages.flatMap((p) => p.items) ?? [];
    const firstWorkspaceId = items[0]?.id;
    useEffect(() => {
        if (!selected && firstWorkspaceId) select(firstWorkspaceId);
    }, [selected, firstWorkspaceId, select]);
    const adapter = useMemo(() => new CloudAiAdapter(selected), [selected]);
    const resources = useMemo(() => new CloudResourceAdapter(selected), [selected]);
    if (!user) return <Navigate to="/login" />;
    const ws = items.find((w) => w.id === selected);
    return (
        <Panel title={t("title")}>
            <label>
                {tx("Workspace")}
                <select
                    data-testid="ai-workspace"
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
            {workspaces.error && <p role="alert">{workspaces.error.message}</p>}
            {workspaces.hasNextPage && (
                <button type="button" onClick={() => void workspaces.fetchNextPage()}>
                    {t("more")}
                </button>
            )}
            {!items.length && <p>{t("noWorkspace")}</p>}
            {ws && (
                <AiWorkspaceView
                    key={user.id + selected}
                    workspace={ws}
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
    const [controller] = useState(() => new AbortController());
    const signal = useMemo(
        () => (parent ? AbortSignal.any([parent, controller.signal]) : controller.signal),
        [parent, controller],
    );
    useEffect(() => () => controller.abort(), [controller]);
    const manage = ["OWNER", "ADMIN"].includes(workspace.role) && !workspace.archived;
    const edit = ["OWNER", "ADMIN", "EDITOR"].includes(workspace.role) && !workspace.archived;
    const [error, setError] = useState(""),
        [busy, setBusy] = useState(false),
        [generating, setGenerating] = useState(false);
    const [form, setForm] = useState<S["ProviderWrite"]>(defaults),
        [editing, setEditing] = useState(""),
        [apiKey, setKey] = useState("");
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
    const changeInput = useCallback(
        <K extends keyof RequestInputs>(field: K, value: RequestInputs[K]) => {
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
        },
        [],
    );
    const [generation, setGeneration] = useState<Generation>(),
        [key, setResourceKey] = useState(""),
        [name, setName] = useState(""),
        [editorId, setEditorId] = useState("");
    const providers = useInfiniteQuery({
        queryKey: ["workspace", workspace.id, "ai", "providers"],
        queryFn: ({ pageParam }) => adapter.providers(pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
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
    const rows = providers.data?.pages.flatMap((p) => p.items) ?? [],
        calls = history.data?.pages.flatMap((p) => p.items) ?? [];
    const provider = rows.find((p) => p.id === providerId);
    const firstProviderId = rows[0]?.id;
    useEffect(() => {
        if (!providerId && firstProviderId) changeInput("providerId", firstProviderId);
    }, [providerId, firstProviderId, changeInput]);
    const refresh = async () => {
        await Promise.all([providers.refetch(), history.refetch()]);
    };
    const action = async (fn: () => Promise<void>) => {
        setBusy(true);
        setError("");
        try {
            await fn();
        } catch (e) {
            if (!signal.aborted) setError(e instanceof Error ? e.message : t("failed"));
        } finally {
            if (!signal.aborted) setBusy(false);
        }
    };
    const selectProvider = (p: Provider) => {
        setEditing(p.id);
        changeInput("providerId", p.id);
        setForm({
            name: p.name,
            adapter: p.adapter,
            baseURL: p.baseURL,
            model: p.model,
            enabled: p.enabled,
            monthlyBudgetUsd: p.monthlyBudgetUsd,
            inputUsdPerMillion: p.inputUsdPerMillion,
            outputUsdPerMillion: p.outputUsdPerMillion,
            maxOutputTokens: p.maxOutputTokens,
            maxRequestUsd: p.maxRequestUsd,
        });
        setKey("");
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
            <p data-testid="ai-execution-independent">{t("independent")}</p>
            <p>{t("privacy")}</p>
            <p>{t("estimate")}</p>
            {!edit && <p>{t("readonly")}</p>}
            {(error || providers.error || history.error || sources.error) && (
                <p role="alert">
                    {error ||
                        providers.error?.message ||
                        history.error?.message ||
                        sources.error?.message}
                </p>
            )}
            {(busy || providers.isPending) && <p role="status">{t("loading")}</p>}
            {!providers.isPending && !rows.length && <p data-testid="ai-empty">{t("empty")}</p>}
            <label>
                {t("provider")}
                <select
                    data-testid="ai-provider"
                    value={providerId}
                    onChange={(e) => changeInput("providerId", e.target.value)}
                >
                    <option value="">—</option>
                    {rows.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.name} · {p.enabled ? "ON" : "OFF"}
                        </option>
                    ))}
                </select>
            </label>
            {providers.hasNextPage && (
                <button type="button" onClick={() => void providers.fetchNextPage()}>
                    {t("more")}
                </button>
            )}
            {provider && (
                <div data-testid="ai-budget">
                    <strong>{t("budget")} USD</strong> {t("used")}:{" "}
                    {provider.budget.estimatedUsedUsd} · {t("held")}: {provider.budget.heldUsd} ·{" "}
                    {t("available")}: {provider.budget.availableUsd}
                </div>
            )}
            {manage && (
                <fieldset disabled={busy}>
                    <legend>{t("provider")}</legend>
                    <button
                        type="button"
                        onClick={() => {
                            setEditing("");
                            setForm(defaults);
                            setKey("");
                        }}
                    >
                        {t("newProvider")}
                    </button>
                    {provider && (
                        <button
                            type="button"
                            data-testid="ai-edit-provider"
                            onClick={() => selectProvider(provider)}
                        >
                            {t("provider")} {provider.name}
                        </button>
                    )}
                    {(["name", "baseURL", "model"] as const).map((k, i) => (
                        <label key={k}>
                            {t((["name", "endpoint", "model"] as const)[i]!)}
                            <input
                                data-testid={"ai-" + k}
                                value={form[k]}
                                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                            />
                        </label>
                    ))}
                    <label>
                        {tx("Adapter")}
                        <select
                            data-testid="ai-adapter"
                            value={form.adapter}
                            onChange={(e) =>
                                setForm({
                                    ...form,
                                    adapter: e.target.value as S["ProviderWrite"]["adapter"],
                                })
                            }
                        >
                            <option>OPENAI_COMPATIBLE</option>
                            <option>ANTHROPIC</option>
                        </select>
                    </label>
                    <label>
                        {t("key")}
                        <input
                            type="password"
                            autoComplete="new-password"
                            data-testid="ai-key"
                            value={apiKey}
                            onChange={(e) => setKey(e.target.value)}
                        />
                    </label>
                    <p>{t("keyHint")}</p>
                    {(
                        [
                            "monthlyBudgetUsd",
                            "inputUsdPerMillion",
                            "outputUsdPerMillion",
                            "maxOutputTokens",
                            "maxRequestUsd",
                        ] as const
                    ).map((k, i) => (
                        <label key={k}>
                            {t(
                                (
                                    [
                                        "monthly",
                                        "inputRate",
                                        "outputRate",
                                        "outputLimit",
                                        "requestLimit",
                                    ] as const
                                )[i]!,
                            )}
                            <input
                                type="number"
                                min="0"
                                step="any"
                                data-testid={"ai-" + k}
                                value={form[k]}
                                onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
                            />
                        </label>
                    ))}
                    <label>
                        <input
                            type="checkbox"
                            data-testid="ai-enabled"
                            checked={form.enabled}
                            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                        />
                        {t("enabled")}
                    </label>
                    <button
                        type="button"
                        data-testid="ai-save"
                        onClick={() =>
                            void action(async () => {
                                const p = await adapter.save(
                                    { ...form, ...(apiKey ? { apiKey } : {}) },
                                    editing || undefined,
                                    signal,
                                );
                                if (signal.aborted) return;
                                setKey("");
                                setEditing(p.id);
                                changeInput("providerId", p.id);
                                await refresh();
                            })
                        }
                    >
                        {t("save")}
                    </button>
                    {provider && (
                        <>
                            <button
                                type="button"
                                data-testid="ai-test"
                                disabled={!provider.enabled}
                                onClick={() =>
                                    void action(async () => {
                                        const g = await adapter.test(
                                            provider.id,
                                            crypto.randomUUID(),
                                            signal,
                                        );
                                        if (signal.aborted) return;
                                        setGeneration(g);
                                        await refresh();
                                    })
                                }
                            >
                                {t("test")}
                            </button>
                            <button
                                type="button"
                                data-testid="ai-delete"
                                onClick={() =>
                                    void action(async () => {
                                        await adapter.remove(provider.id, signal);
                                        if (signal.aborted) return;
                                        changeInput("providerId", "");
                                        setEditing("");
                                        setForm(defaults);
                                        await refresh();
                                    })
                                }
                            >
                                {t("remove")}
                            </button>
                        </>
                    )}
                </fieldset>
            )}
            <fieldset disabled={!edit || busy || generating}>
                <legend>{t("selected")}</legend>
                <p>{t("privacy")}</p>
                <label>
                    {t("purpose")}
                    <select
                        data-testid="ai-purpose"
                        value={purpose}
                        onChange={(e) =>
                            changeInput("purpose", e.target.value as GenerationRequest["purpose"])
                        }
                    >
                        <option>CASE_DRAFT</option>
                        <option>BOUNDARY_SUGGESTION</option>
                        <option>FAILURE_ANALYSIS</option>
                    </select>
                </label>
                <label>
                    {t("requirement")}
                    <textarea
                        data-testid="ai-prompt"
                        maxLength={16000}
                        value={prompt}
                        onChange={(e) => changeInput("prompt", e.target.value)}
                    />
                </label>
                {(["versions", "resourceId", "runId"] as const).map((field, i) => (
                    <label key={field}>
                        {t((["versions", "resource", "run"] as const)[i]!)}
                        <input
                            data-testid={"ai-" + (["versions", "resource", "run"] as const)[i]}
                            value={inputs[field]}
                            onChange={(e) => changeInput(field, e.target.value)}
                        />
                    </label>
                ))}
                <label>
                    {t("openapi")}
                    <textarea
                        data-testid="ai-openapi"
                        value={openapi}
                        onChange={(e) => changeInput("openapi", e.target.value)}
                    />
                </label>
                <label>
                    {t("data")}
                    <textarea
                        data-testid="ai-data"
                        value={data}
                        onChange={(e) => changeInput("data", e.target.value)}
                    />
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
                                    <button
                                        type="button"
                                        onClick={() => changeInput("resourceId", r.id)}
                                    >
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
                    data-testid="ai-preview"
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
                <section data-testid="ai-context">
                    <h3>{t("context")}</h3>
                    <pre>{json(preview.context)}</pre>
                    <pre>{json(preview.provenance)}</pre>
                    <p>
                        {preview.inputTokenBound} {tx(" tokens · USD ")}
                        {preview.reservedUsd}
                    </p>
                    <button
                        type="button"
                        data-testid="ai-generate"
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
                <button type="button" data-testid="ai-refresh" onClick={() => void action(refresh)}>
                    {t("refresh")}
                </button>
                {!calls.length && <p>{t("noHistory")}</p>}
                <ul data-testid="ai-history">
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
                            {g.costState === "UNKNOWN" ? t("unknown") : "USD " + g.costUsd} (
                            {g.inputTokens ?? "?"} / {g.outputTokens ?? "?"} {tx(" tokens)")}{" "}
                            {g.status === "RUNNING" && edit && (
                                <button
                                    type="button"
                                    data-testid="ai-cancel"
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
                <section data-testid="ai-review">
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
                            <pre data-testid="ai-original">{json(generation.original ?? null)}</pre>
                        </div>
                        <div>
                            <h4>{t("output")}</h4>
                            <pre data-testid="ai-output">{json(generation.output ?? null)}</pre>
                        </div>
                    </div>
                    {generation.status === "SUCCEEDED" && edit && (
                        <fieldset disabled={busy}>
                            {!generation.resourceId && generation.purpose === "CASE_DRAFT" && (
                                <>
                                    <label>
                                        {t("keyName")}
                                        <input
                                            data-testid="ai-resource-key"
                                            value={key}
                                            onChange={(e) => setResourceKey(e.target.value)}
                                        />
                                    </label>
                                    <label>
                                        {t("resourceName")}
                                        <input
                                            data-testid="ai-resource-name"
                                            value={name}
                                            onChange={(e) => setName(e.target.value)}
                                        />
                                    </label>
                                </>
                            )}
                            {generation.purpose === "CASE_DRAFT" && (
                                <button
                                    type="button"
                                    data-testid="ai-accept"
                                    disabled={
                                        generation.resourceId
                                            ? !generation.revision
                                            : !name.trim() ||
                                              name.length > 160 ||
                                              validateSchema("Key", key).length > 0
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
                                data-testid="ai-reject"
                                onClick={() =>
                                    void action(async () => {
                                        const g = await adapter.review(
                                            generation.id,
                                            { decision: "REJECT" },
                                            signal,
                                        );
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
                        <button
                            type="button"
                            data-testid="ai-open-editor"
                            onClick={() => setEditorId(generation.resourceId!)}
                        >
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
