/**
 * 工作区设置与完整 AI 页面共用同一份模型目录和管理表单，配置入口只查询提供方，调用历史及生成输入由原页面拥有。
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import type { PlatformComponents } from "@veriq/contracts";
import { ApiError, type Workspace } from "../../api";
import icons from "../../admin-icons.svg?no-inline";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { Select, SelectItem } from "../../components/Select";
import { tx, useAppLocale } from "../../locale";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { WorkspaceTableFilters } from "../workspaces/WorkspaceTableFilters";
import { useOperationFeedback } from "../../operation-feedback";
import { canExportWorkspaceTable, collectTablePages, DataTable, useTableView } from "../../table-view";
import { CloudAiAdapter, type AiAdapter, type Generation, type Provider } from "./adapters";
import { aiI18n } from "./i18n";
import "./ai.css";

type S = PlatformComponents["schemas"];
const defaults: S["ProviderWrite"] = {
    name: "",
    adapter: "OPENAI_COMPATIBLE",
    baseURL: "https://api.openai.com/v1",
    model: "",
    enabled: false,
    supportsImages: false,
    monthlyBudgetUsd: 1,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    maxOutputTokens: 1024,
    maxRequestUsd: 0.5,
};
const matchesProvider = (provider: Provider, term: string) =>
    provider.name.toLowerCase().includes(term) ||
    (provider.model ?? "").toLowerCase().includes(term) ||
    provider.baseURL.toLowerCase().includes(term);

/**
 * 目录与写入共享工作区取消信号，离开设置标签或卸载桌面视图时也会终止本次挂载拥有的模型请求。
 */
export function useProviderDirectory(workspace: Workspace, adapter: AiAdapter, parent?: AbortSignal) {
    const { t } = useTranslation("ai", { i18n: aiI18n });
    const { showSuccess, showFailure } = useOperationFeedback();
    const [controller] = useState(() => new AbortController());
    const signal = useMemo(
        () => (parent ? AbortSignal.any([parent, controller.signal]) : controller.signal),
        [parent, controller],
    );
    useEffect(() => () => controller.abort(), [controller]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const providers = useQuery({
        queryKey: ["workspace", workspace.id, "ai", "providers"],
        queryFn: ({ signal: querySignal }) =>
            collectTablePages(
                (cursor, request) => adapter.providers(cursor, request),
                AbortSignal.any([signal, querySignal]),
            ),
    });
    // 读取保留行内失败和重试入口，写入在服务端完成后统一报告；自行判断业务返回的调用传入空结果以避免重复提示。
    const action = async (fn: () => Promise<unknown>, result?: string | null) => {
        setBusy(true);
        setError("");
        try {
            await fn();
            if (!signal.aborted && result) showSuccess(result);
        } catch (e) {
            if (!signal.aborted) {
                const message = e instanceof Error ? e.message : t("failed");
                if (result === undefined) setError(message);
                else showFailure(message);
            }
        } finally {
            if (!signal.aborted) setBusy(false);
        }
    };
    const accessDenied = providers.error instanceof ApiError && [401, 403, 404].includes(providers.error.status);
    const rows = accessDenied ? [] : (providers.data ?? []);
    const refreshProviders = async () => {
        const result = await providers.refetch();
        return result.data ?? [];
    };
    const manage = ["OWNER", "ADMIN"].includes(workspace.role) && !workspace.archived;
    return { adapter, signal, providers, rows, refreshProviders, manage, busy, error, setError, action };
}

/**
 * 只有幂等重放可能返回仍运行的测试，使用它的生成标识读取终态，有界等待结束后继续保留可关闭的处理中状态。
 */
async function trackConnection(adapter: AiAdapter, response: Generation, signal: AbortSignal): Promise<Generation> {
    if (response.status !== "RUNNING") return response;
    const limit = AbortSignal.timeout(40_000);
    const tracking = AbortSignal.any([signal, limit]);
    let result = response;
    try {
        while (result.status === "RUNNING") {
            tracking.throwIfAborted();
            await new Promise<void>((resolve, reject) => {
                const timer = window.setTimeout(() => {
                    tracking.removeEventListener("abort", abort);
                    resolve();
                }, 1000);
                function abort() {
                    window.clearTimeout(timer);
                    reject(tracking.reason);
                }
                tracking.addEventListener("abort", abort, { once: true });
            });
            result = await adapter.get(response.id, tracking);
        }
    } catch (error) {
        if (!limit.aborted || signal.aborted) throw error;
    }
    return result;
}

/**
 * 设置标签只创建云端提供方适配器。新增/编辑表单位于顶部，连接与预算各占一行；下方以表格列出已保存 Provider，
 * 并带名称搜索与适配器、状态筛选。连接测试展示本次调用的真实状态，切换空间或离开标签后清除未提交的密钥。
 */
export function WorkspaceAiProviders({ workspace }: { workspace: Workspace }) {
    useAppLocale();
    const adapterId = useId();
    const enabledHintId = useId();
    const imageHintId = useId();
    const { showPending } = useOperationFeedback();
    const { t } = useTranslation("ai", { i18n: aiI18n });
    const { signal: parentSignal } = useWorkspace();
    const adapter = useMemo(() => new CloudAiAdapter(workspace.id), [workspace.id]);
    const directory = useProviderDirectory(workspace, adapter, parentSignal);
    const { providers, rows, refreshProviders, manage, busy, error, action, signal } = directory;
    const [form, setForm] = useState<S["ProviderWrite"]>(defaults);
    const [editing, setEditing] = useState("");
    const [apiKey, setKey] = useState("");
    const [adapterFilter, setAdapterFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [deleteOpen, setDeleteOpen] = useState(false);
    const testing = useRef<AbortController>();

    const editingProvider = rows.find((item) => item.id === editing);

    /**
     * 同步门闩阻止同一提供方在 React 更新按钮前重放，关闭等待框只放弃前端观察，不声明远端已经取消。
     */
    const testConnection = (trigger: HTMLButtonElement) => {
        if (busy || signal.aborted || testing.current || !editingProvider?.enabled) return;
        const controller = new AbortController();
        testing.current = controller;
        const requestSignal = AbortSignal.any([signal, controller.signal]);
        const feedback = showPending(t("testing"), { trigger, onClose: () => controller.abort() });
        function release() {
            requestSignal.removeEventListener("abort", abort);
            if (testing.current === controller) testing.current = undefined;
        }
        function abort() {
            feedback.dismiss();
            release();
        }
        requestSignal.addEventListener("abort", abort, { once: true });
        void action(async () => {
            let unresolved = false;
            try {
                const response = await adapter.test(editingProvider.id, crypto.randomUUID(), requestSignal);
                const generation = await trackConnection(adapter, response, requestSignal);
                requestSignal.throwIfAborted();
                unresolved = generation.status === "RUNNING";
                if (unresolved) return;
                if (generation.status === "SUCCEEDED") feedback.complete("success", t("connectionSucceeded"));
                else feedback.complete("failure", generation.errorCode ?? t("connectionFailed"));
                void refreshProviders();
            } catch (error) {
                if (!requestSignal.aborted) {
                    feedback.complete("failure", error instanceof Error ? error.message : t("connectionFailed"));
                }
            } finally {
                if (!unresolved) release();
            }
        }, null);
    };

    const applyProvider = (provider: Provider) =>
        setForm({
            name: provider.name,
            adapter: provider.adapter,
            baseURL: provider.baseURL,
            model: provider.model,
            enabled: provider.enabled,
            supportsImages: provider.supportsImages ?? false,
            monthlyBudgetUsd: provider.monthlyBudgetUsd,
            inputUsdPerMillion: provider.inputUsdPerMillion,
            outputUsdPerMillion: provider.outputUsdPerMillion,
            maxOutputTokens: provider.maxOutputTokens,
            maxRequestUsd: provider.maxRequestUsd,
        });

    const selectProvider = (provider: Provider) => {
        setEditing(provider.id);
        applyProvider(provider);
        setKey("");
    };

    const resetForm = () => {
        setEditing("");
        setForm(defaults);
        setKey("");
    };

    const filtered = useMemo(
        () =>
            rows.filter(
                (provider) =>
                    (!adapterFilter || provider.adapter === adapterFilter) &&
                    (!statusFilter || String(provider.enabled) === statusFilter),
            ),
        [rows, adapterFilter, statusFilter],
    );
    const view = useTableView(filtered, { matches: matchesProvider, scope: workspace.id });

    /**
     * 页面和下载共用已用及可用额度的文案，导出的列仍与列表中展示的预算摘要保持一致。
     */
    const providerBudget = (provider: Provider) =>
        `${t("used")} ${provider.budget.estimatedUsedUsd} · ${t("available")} ${provider.budget.availableUsd}`;

    return (
        <div className="vq-ai">
            <p>{t("estimate")}</p>
            {!manage && <p>{tx("Provider configuration is read-only.")}</p>}
            {(error || providers.error) && <p role="alert">{error || providers.error?.message}</p>}
            {providers.isPending && <p role="status">{t("loading")}</p>}
            {providers.error && (
                <button type="button" onClick={() => void refreshProviders()}>
                    {tx("Retry")}
                </button>
            )}

            {manage && (
                <section className="vq-ai-form">
                    <h3 className="vq-ai-form-title">
                        {editing && editingProvider
                            ? `${t("editProvider")} · ${editingProvider.name}`
                            : t("newProvider")}
                    </h3>
                    <div className="vq-ai-form-row">
                        <h4>{t("connection")}</h4>
                        <Field label={t("name")} hint={t("providerNameHint")} required>
                            <input
                                aria-required="true"
                                value={form.name}
                                onChange={(e) => setForm({ ...form, name: e.target.value })}
                            />
                        </Field>
                        <Field label={t("adapter")} htmlFor={adapterId} hint={t("adapterHint")} required>
                            <Select
                                id={adapterId}
                                appearance="default-dropdown"
                                required
                                value={form.adapter}
                                onValueChange={(value) =>
                                    setForm({ ...form, adapter: value as S["ProviderWrite"]["adapter"] })
                                }
                            >
                                <SelectItem value="OPENAI_COMPATIBLE">OPENAI_COMPATIBLE</SelectItem>
                                <SelectItem value="ANTHROPIC">ANTHROPIC</SelectItem>
                            </Select>
                        </Field>
                        <Field label={t("endpoint")} hint={t("endpointHint")} required>
                            <input
                                aria-required="true"
                                value={form.baseURL}
                                onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
                            />
                        </Field>
                        <Field label={t("model")} hint={t("modelHint")} required>
                            <input
                                aria-required="true"
                                value={form.model}
                                onChange={(e) => setForm({ ...form, model: e.target.value })}
                            />
                        </Field>
                        <Field label={t("key")} hint={t("keyHint")}>
                            <input
                                type="password"
                                autoComplete="new-password"
                                value={apiKey}
                                onChange={(e) => setKey(e.target.value)}
                            />
                        </Field>
                    </div>
                    <div className="vq-ai-form-row">
                        <h4>{t("budget")}</h4>
                        <Field label={t("monthly")} hint={t("monthlyHint")} required>
                            <input
                                type="number"
                                aria-required="true"
                                min="0"
                                step="any"
                                value={form.monthlyBudgetUsd}
                                onChange={(e) => setForm({ ...form, monthlyBudgetUsd: Number(e.target.value) })}
                            />
                        </Field>
                        <Field label={t("inputRate")} hint={t("inputRateHint")} required>
                            <input
                                type="number"
                                aria-required="true"
                                min="0"
                                step="any"
                                value={form.inputUsdPerMillion}
                                onChange={(e) => setForm({ ...form, inputUsdPerMillion: Number(e.target.value) })}
                            />
                        </Field>
                        <Field label={t("outputRate")} hint={t("outputRateHint")} required>
                            <input
                                type="number"
                                aria-required="true"
                                min="0"
                                step="any"
                                value={form.outputUsdPerMillion}
                                onChange={(e) => setForm({ ...form, outputUsdPerMillion: Number(e.target.value) })}
                            />
                        </Field>
                        <Field label={t("outputLimit")} hint={t("outputLimitHint")} required>
                            <input
                                type="number"
                                aria-required="true"
                                min="0"
                                step="any"
                                value={form.maxOutputTokens}
                                onChange={(e) => setForm({ ...form, maxOutputTokens: Number(e.target.value) })}
                            />
                        </Field>
                        <Field label={t("requestLimit")} hint={t("requestLimitHint")} required>
                            <input
                                type="number"
                                aria-required="true"
                                min="0"
                                step="any"
                                value={form.maxRequestUsd}
                                onChange={(e) => setForm({ ...form, maxRequestUsd: Number(e.target.value) })}
                            />
                        </Field>
                    </div>
                    <div className="vq-ai-form-row vq-ai-form-actions">
                        <div className="vq-ai-enabled-field">
                            <label className="vq-ai-check">
                                <input
                                    type="checkbox"
                                    aria-describedby={imageHintId}
                                    checked={form.supportsImages ?? false}
                                    disabled={busy}
                                    onChange={(event) => setForm({ ...form, supportsImages: event.target.checked })}
                                />
                                {t("supportsImages")}
                            </label>
                            <span id={imageHintId} className="vq-field-hint">
                                {t("supportsImagesHint")}
                            </span>
                        </div>
                        <div className="vq-ai-enabled-field">
                            <label className="vq-ai-check">
                                <input
                                    type="checkbox"
                                    aria-describedby={enabledHintId}
                                    checked={form.enabled}
                                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                                />
                                {t("enabled")}
                            </label>
                            <span id={enabledHintId} className="vq-field-hint">
                                {t("enabledHint")}
                            </span>
                        </div>
                        <div className="vq-ai-provider-buttons">
                            <Button
                                tone="primary"
                                size="regular"
                                disabled={busy}
                                onClick={() =>
                                    void action(async () => {
                                        const provider = await adapter.save(
                                            { ...form, ...(apiKey ? { apiKey } : {}) },
                                            editing || undefined,
                                            signal,
                                        );
                                        if (signal.aborted) return;
                                        setKey("");
                                        setEditing(provider.id);
                                        applyProvider(provider);
                                        await refreshProviders();
                                    }, t("providerSaved"))
                                }
                            >
                                {t("save")}
                            </Button>
                            {editing && editingProvider && (
                                <Button
                                    tone="secondary"
                                    size="regular"
                                    className="vq-ai-test-connection"
                                    disabled={busy || !editingProvider.enabled}
                                    onClick={(event) => testConnection(event.currentTarget)}
                                >
                                    {t("test")}
                                </Button>
                            )}
                            {editing && (
                                <Button
                                    tone="danger"
                                    size="regular"
                                    disabled={busy}
                                    onClick={() => setDeleteOpen(true)}
                                >
                                    {t("remove")}
                                </Button>
                            )}
                        </div>
                        {editing && (
                            <Dialog.Root open={deleteOpen} onOpenChange={setDeleteOpen}>
                                <Dialog.Portal>
                                    <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                                    <Dialog.Content className="vq-dialog vq-workspace-dialog">
                                        <div className="vq-card-heading">
                                            <Dialog.Title>{t("remove")}</Dialog.Title>
                                            <Dialog.Close className="vq-sheet-close" aria-label={tx("Close")}>
                                                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
                                                    <path
                                                        d="m4 4 8 8m0-8-8 8"
                                                        stroke="currentColor"
                                                        strokeWidth="1.5"
                                                    />
                                                </svg>
                                            </Dialog.Close>
                                        </div>
                                        <Dialog.Description className="vq-workspace-key-hint">
                                            {t("removeHint")}
                                        </Dialog.Description>
                                        <div className="vq-workspace-form-actions">
                                            <Dialog.Close type="button" className="vq-btn-secondary">
                                                {tx("Cancel")}
                                            </Dialog.Close>
                                            <Button
                                                tone="danger"
                                                disabled={busy}
                                                onClick={() =>
                                                    void action(async () => {
                                                        await adapter.remove(editing, signal);
                                                        if (signal.aborted) return;
                                                        await refreshProviders();
                                                        signal.throwIfAborted();
                                                        resetForm();
                                                        setDeleteOpen(false);
                                                    }, t("providerDeleted"))
                                                }
                                            >
                                                {t("remove")}
                                            </Button>
                                        </div>
                                    </Dialog.Content>
                                </Dialog.Portal>
                            </Dialog.Root>
                        )}
                    </div>
                </section>
            )}

            <section>
                <header className="vq-workspace-table-heading">
                    <h3>{t("providers")}</h3>
                    {manage && (
                        <Button
                            size="compact"
                            className="vq-workspace-table-add"
                            aria-label={t("newProvider")}
                            title={t("newProvider")}
                            onClick={resetForm}
                        >
                            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <path
                                    d="M8 3v10M3 8h10"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                />
                            </svg>
                        </Button>
                    )}
                </header>
                <DataTable
                    label={t("provider")}
                    view={view}
                    searchLabel={t("searchProviders")}
                    searchMaxLength={254}
                    paginationLabel={t("providerPages")}
                    exportAllowed={canExportWorkspaceTable(workspace.role)}
                    busy={busy || providers.isFetching || providers.isError || signal.aborted}
                    exportColumns={[
                        { label: t("name"), value: (provider) => provider.name },
                        { label: t("adapter"), value: (provider) => provider.adapter },
                        { label: t("model"), value: (provider) => provider.model },
                        { label: t("status"), value: (provider) => t(provider.enabled ? "enabled" : "disabled") },
                        { label: t("budget"), value: providerBudget },
                    ]}
                    beforeDownload={
                        <WorkspaceTableFilters
                            filters={[
                                {
                                    label: t("adapter"),
                                    value: adapterFilter,
                                    choices: [
                                        ["", t("all")],
                                        ["OPENAI_COMPATIBLE", "OPENAI_COMPATIBLE"],
                                        ["ANTHROPIC", "ANTHROPIC"],
                                    ],
                                    onChange: (value) => {
                                        setAdapterFilter(value);
                                        view.setPage(1);
                                    },
                                },
                                {
                                    label: t("status"),
                                    value: statusFilter,
                                    choices: [
                                        ["", t("all")],
                                        ["true", t("enabled")],
                                        ["false", t("disabled")],
                                    ],
                                    onChange: (value) => {
                                        setStatusFilter(value);
                                        view.setPage(1);
                                    },
                                },
                            ]}
                            onReset={() => {
                                setAdapterFilter("");
                                setStatusFilter("");
                                view.setSearch("");
                            }}
                        />
                    }
                >
                    {(providers.isSuccess || view.filteredCount > 0) && (
                        <div className="table-scroll">
                            <table className="vq-user-table" aria-label={t("provider")}>
                                <thead>
                                    <tr>
                                        <th>{t("name")}</th>
                                        <th>{t("adapter")}</th>
                                        <th>{t("model")}</th>
                                        <th>{t("endpoint")}</th>
                                        <th>{t("status")}</th>
                                        <th>{t("budget")}</th>
                                        {manage && <th>{t("editProvider")}</th>}
                                    </tr>
                                </thead>
                                <tbody>
                                    {view.filteredCount === 0 && (
                                        <tr>
                                            <td className="vq-table-empty" colSpan={manage ? 7 : 6}>
                                                {t(rows.length ? "noMatchingProviders" : "empty")}
                                            </td>
                                        </tr>
                                    )}
                                    {view.rows.map((provider) => (
                                        <tr key={provider.id}>
                                            <td>{provider.name}</td>
                                            <td>{provider.adapter}</td>
                                            <td>{provider.model}</td>
                                            <td>{provider.baseURL}</td>
                                            <td>
                                                <span
                                                    className="vq-state vq-workspace-state"
                                                    data-tone={provider.enabled ? "success" : "neutral"}
                                                >
                                                    {provider.enabled ? t("enabled") : t("disabled")}
                                                </span>
                                            </td>
                                            <td>{providerBudget(provider)}</td>
                                            {manage && (
                                                <td>
                                                    <button
                                                        type="button"
                                                        className="vq-icon-button"
                                                        aria-label={`${t("editProvider")} · ${provider.name}`}
                                                        title={t("editProvider")}
                                                        onClick={() => selectProvider(provider)}
                                                    >
                                                        <svg aria-hidden="true" width="16" height="16">
                                                            <use href={`${icons}#settings`} />
                                                        </svg>
                                                    </button>
                                                </td>
                                            )}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </DataTable>
            </section>
        </div>
    );
}
