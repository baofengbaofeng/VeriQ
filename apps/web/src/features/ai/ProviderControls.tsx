/**
 * 工作区设置与完整 AI 页面共用同一份模型目录和管理表单，配置入口只查询提供方，调用历史及生成输入由原页面拥有。
 */
import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import type { PlatformComponents } from "@veriq/contracts";
import type { Workspace } from "../../api";
import { tx, useAppLocale } from "../../locale";
import { useWorkspace } from "../workspaces/WorkspaceContext";
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
    monthlyBudgetUsd: 1,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    maxOutputTokens: 1024,
    maxRequestUsd: 0.5,
};

/**
 * 目录与写入共享工作区取消信号，离开设置标签或卸载桌面视图时也会终止本次挂载拥有的模型请求。
 */
export function useProviderDirectory(workspace: Workspace, adapter: AiAdapter, parent?: AbortSignal) {
    const { t } = useTranslation("ai", { i18n: aiI18n });
    const [controller] = useState(() => new AbortController());
    const signal = useMemo(
        () => (parent ? AbortSignal.any([parent, controller.signal]) : controller.signal),
        [parent, controller],
    );
    useEffect(() => () => controller.abort(), [controller]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const providers = useInfiniteQuery({
        queryKey: ["workspace", workspace.id, "ai", "providers"],
        queryFn: ({ pageParam, signal: querySignal }) =>
            adapter.providers(pageParam, AbortSignal.any([signal, querySignal])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const action = async (fn: () => Promise<unknown>) => {
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
    const rows = providers.data?.pages.flatMap((page) => page.items) ?? [];
    const refreshProviders = async () => {
        const result = await providers.refetch();
        return result.data?.pages.flatMap((page) => page.items) ?? [];
    };
    const manage = ["OWNER", "ADMIN"].includes(workspace.role) && !workspace.archived;
    return { adapter, signal, providers, rows, refreshProviders, manage, busy, error, setError, action };
}

/**
 * 单值筛选下拉，沿用成员页的 Default Dropdown 视觉；值由宿主持有，选项文案在调用处完成翻译。
 */
function AiChoiceFilter({
    label,
    value,
    onChange,
    choices,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    choices: [string, string][];
}) {
    const active = choices.find(([item]) => item === value)?.[1] ?? label;
    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger className="vq-filter-button">
                {active}
                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path
                        d="m3 4.5 3 3 3-3"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content className="vq-dropdown" align="start" sideOffset={4} collisionPadding={8}>
                    <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
                        {choices.map(([item, choiceLabel]) => (
                            <DropdownMenu.RadioItem key={item} value={item} className="vq-dropdown-item">
                                {choiceLabel}
                                <DropdownMenu.ItemIndicator className="vq-dropdown-check">
                                    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none">
                                        <path
                                            d="m3 7.5 2.5 2.5L11 4.5"
                                            stroke="currentColor"
                                            strokeWidth="1.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                    </svg>
                                </DropdownMenu.ItemIndicator>
                            </DropdownMenu.RadioItem>
                        ))}
                    </DropdownMenu.RadioGroup>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}

/**
 * 设置标签只创建云端提供方适配器。新增/编辑表单位于顶部，连接与预算各占一行；下方以表格列出已保存 Provider，并带名称搜索与
 * 适配器、状态筛选。连接测试展示本次调用的真实状态，切换空间或离开标签后清除未提交的密钥。
 */
export function WorkspaceAiProviders({ workspace }: { workspace: Workspace }) {
    useAppLocale();
    const { t } = useTranslation("ai", { i18n: aiI18n });
    const { signal: parentSignal } = useWorkspace();
    const adapter = useMemo(() => new CloudAiAdapter(workspace.id), [workspace.id]);
    const directory = useProviderDirectory(workspace, adapter, parentSignal);
    const { providers, rows, refreshProviders, manage, busy, error, action, signal } = directory;
    const [form, setForm] = useState<S["ProviderWrite"]>(defaults);
    const [editing, setEditing] = useState("");
    const [apiKey, setKey] = useState("");
    const [tested, setTested] = useState<{ result: Generation; revision: number }>();
    const [search, setSearch] = useState("");
    const [adapterFilter, setAdapterFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [testOpen, setTestOpen] = useState(false);

    const editingProvider = rows.find((item) => item.id === editing);
    const result =
        tested && editingProvider && tested.revision === editingProvider.revision ? tested.result : undefined;

    const applyProvider = (provider: Provider) =>
        setForm({
            name: provider.name,
            adapter: provider.adapter,
            baseURL: provider.baseURL,
            model: provider.model,
            enabled: provider.enabled,
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
        setTested(undefined);
    };

    const resetForm = () => {
        setEditing("");
        setForm(defaults);
        setKey("");
        setTested(undefined);
    };

    const filtered = rows.filter(
        (provider) =>
            (!search ||
                provider.name.toLowerCase().includes(search.toLowerCase()) ||
                (provider.model ?? "").toLowerCase().includes(search.toLowerCase()) ||
                provider.baseURL.toLowerCase().includes(search.toLowerCase())) &&
            (!adapterFilter || provider.adapter === adapterFilter) &&
            (!statusFilter || String(provider.enabled) === statusFilter),
    );

    return (
        <div className="vq-ai">
            <p>{t("estimate")}</p>
            {!manage && <p>{tx("Provider configuration is read-only.")}</p>}
            {(error || providers.error) && <p role="alert">{error || providers.error?.message}</p>}
            {providers.isPending && <p role="status">{t("loading")}</p>}

            {manage && (
                <section className="vq-ai-form">
                    <h3 className="vq-ai-form-title">
                        {editing && editingProvider
                            ? `${t("editProvider")} · ${editingProvider.name}`
                            : t("newProvider")}
                    </h3>
                    <div className="vq-ai-form-row">
                        <h4>{t("connection")}</h4>
                        <label>
                            {t("name")}
                            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                        </label>
                        <label>
                            {t("adapter")}
                            <select
                                value={form.adapter}
                                onChange={(e) =>
                                    setForm({ ...form, adapter: e.target.value as S["ProviderWrite"]["adapter"] })
                                }
                            >
                                <option>OPENAI_COMPATIBLE</option>
                                <option>ANTHROPIC</option>
                            </select>
                        </label>
                        <label>
                            {t("endpoint")}
                            <input
                                value={form.baseURL}
                                onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
                            />
                        </label>
                        <label>
                            {t("model")}
                            <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
                        </label>
                        <label>
                            {t("key")}
                            <input
                                type="password"
                                autoComplete="new-password"
                                value={apiKey}
                                onChange={(e) => setKey(e.target.value)}
                            />
                        </label>
                    </div>
                    <div className="vq-ai-form-row">
                        <h4>{t("budget")}</h4>
                        <label>
                            {t("monthly")}
                            <input
                                type="number"
                                min="0"
                                step="any"
                                value={form.monthlyBudgetUsd}
                                onChange={(e) => setForm({ ...form, monthlyBudgetUsd: Number(e.target.value) })}
                            />
                        </label>
                        <label>
                            {t("inputRate")}
                            <input
                                type="number"
                                min="0"
                                step="any"
                                value={form.inputUsdPerMillion}
                                onChange={(e) => setForm({ ...form, inputUsdPerMillion: Number(e.target.value) })}
                            />
                        </label>
                        <label>
                            {t("outputRate")}
                            <input
                                type="number"
                                min="0"
                                step="any"
                                value={form.outputUsdPerMillion}
                                onChange={(e) => setForm({ ...form, outputUsdPerMillion: Number(e.target.value) })}
                            />
                        </label>
                        <label>
                            {t("outputLimit")}
                            <input
                                type="number"
                                min="0"
                                step="any"
                                value={form.maxOutputTokens}
                                onChange={(e) => setForm({ ...form, maxOutputTokens: Number(e.target.value) })}
                            />
                        </label>
                        <label>
                            {t("requestLimit")}
                            <input
                                type="number"
                                min="0"
                                step="any"
                                value={form.maxRequestUsd}
                                onChange={(e) => setForm({ ...form, maxRequestUsd: Number(e.target.value) })}
                            />
                        </label>
                    </div>
                    <div className="vq-ai-form-actions">
                        <label className="vq-ai-check">
                            <input
                                type="checkbox"
                                checked={form.enabled}
                                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                            />
                            {t("enabled")}
                        </label>
                        <button
                            type="button"
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
                                })
                            }
                        >
                            {t("save")}
                        </button>
                        {editing && editingProvider && (
                            <button
                                type="button"
                                disabled={busy || !editingProvider.enabled}
                                onClick={() =>
                                    void action(async () => {
                                        setTested(undefined);
                                        setTestOpen(true);
                                        const generation = await adapter.test(editing, crypto.randomUUID(), signal);
                                        if (signal.aborted) return;
                                        setTested({ result: generation, revision: editingProvider.revision });
                                        await refreshProviders();
                                    })
                                }
                            >
                                {t("test")}
                            </button>
                        )}
                        {editing && (
                            <>
                                <button type="button" disabled={busy} onClick={() => setDeleteOpen(true)}>
                                    {t("remove")}
                                </button>
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
                                                <button
                                                    type="button"
                                                    className="vq-btn-danger"
                                                    disabled={busy}
                                                    onClick={() =>
                                                        void action(async () => {
                                                            await adapter.remove(editing, signal);
                                                            if (signal.aborted) return;
                                                            await refreshProviders();
                                                            resetForm();
                                                            setDeleteOpen(false);
                                                        })
                                                    }
                                                >
                                                    {t("remove")}
                                                </button>
                                            </div>
                                        </Dialog.Content>
                                    </Dialog.Portal>
                                </Dialog.Root>
                            </>
                        )}
                    </div>
                    <Dialog.Root open={testOpen} onOpenChange={setTestOpen}>
                        <Dialog.Portal>
                            <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                            <Dialog.Content className="vq-dialog vq-workspace-dialog">
                                <div className="vq-card-heading">
                                    <Dialog.Title>{t("test")}</Dialog.Title>
                                    <Dialog.Close className="vq-sheet-close" aria-label={tx("Close")}>
                                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
                                            <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.5" />
                                        </svg>
                                    </Dialog.Close>
                                </div>
                                <Dialog.Description className="vq-workspace-key-hint">
                                    {result && result.providerId === editing
                                        ? `${result.status}${result.errorCode ? ` ${result.errorCode}` : ""}`
                                        : t("testing")}
                                </Dialog.Description>
                                <div className="vq-workspace-form-actions">
                                    <Dialog.Close type="button" className="vq-btn-secondary">
                                        {tx("Close")}
                                    </Dialog.Close>
                                </div>
                            </Dialog.Content>
                        </Dialog.Portal>
                    </Dialog.Root>
                </section>
            )}

            <section>
                <div className="vq-user-toolbar">
                    <div className="vq-invite-group">
                        <div className="vq-user-search">
                            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                                <path
                                    d="m10.5 10.5 3 3"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                />
                            </svg>
                            <input
                                type="search"
                                placeholder={t("searchProviders")}
                                value={search}
                                maxLength={254}
                                onChange={(event) => setSearch(event.target.value)}
                            />
                        </div>
                        {manage && (
                            <button
                                type="button"
                                className="vq-invite-add"
                                aria-label={t("newProvider")}
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
                            </button>
                        )}
                    </div>
                    <div className="vq-user-filters">
                        <AiChoiceFilter
                            label={t("adapter")}
                            value={adapterFilter}
                            onChange={setAdapterFilter}
                            choices={[
                                ["", t("all")],
                                ["OPENAI_COMPATIBLE", "OPENAI_COMPATIBLE"],
                                ["ANTHROPIC", "ANTHROPIC"],
                            ]}
                        />
                        <AiChoiceFilter
                            label={t("status")}
                            value={statusFilter}
                            onChange={setStatusFilter}
                            choices={[
                                ["", t("all")],
                                ["true", t("enabled")],
                                ["false", t("disabled")],
                            ]}
                        />
                    </div>
                </div>
                {!providers.isPending && filtered.length === 0 && <p>{t("empty")}</p>}
                {filtered.length > 0 && (
                    <div className="table-scroll">
                        <table className="vq-user-table">
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
                                {filtered.map((provider) => (
                                    <tr key={provider.id}>
                                        <td>{provider.name}</td>
                                        <td>{provider.adapter}</td>
                                        <td>{provider.model}</td>
                                        <td>{provider.baseURL}</td>
                                        <td>{provider.enabled ? t("enabled") : t("disabled")}</td>
                                        <td>
                                            {`${t("used")} ${provider.budget.estimatedUsedUsd} · ${t("available")} ${provider.budget.availableUsd}`}
                                        </td>
                                        {manage && (
                                            <td>
                                                <button type="button" onClick={() => selectProvider(provider)}>
                                                    {t("editProvider")}
                                                </button>
                                            </td>
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                <div className="vq-ai-form-actions">
                    {providers.hasNextPage && (
                        <button type="button" onClick={() => void providers.fetchNextPage()}>
                            {t("more")}
                        </button>
                    )}
                </div>
            </section>
        </div>
    );
}
