/**
 * 工作区设置与完整 AI 页面共用同一份模型目录和管理表单，配置入口只查询提供方，调用历史及生成输入由原页面拥有。
 */
import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
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

type Directory = ReturnType<typeof useProviderDirectory>;

/**
 * 普通成员能查看配置摘要和预算，只有当前可管理且未归档的空间提供密钥输入及读写操作。选择回调由宿主拥有。
 */
export function ProviderControls({
    directory,
    providerId,
    onSelect,
    onTest,
    refresh,
}: {
    directory: Directory;
    providerId: string;
    onSelect: (id: string) => void;
    onTest: (result: Generation, revision: number) => void;
    refresh: () => Promise<Provider[]>;
}) {
    const { t } = useTranslation("ai", { i18n: aiI18n });
    const { providers, rows, action, signal, busy, adapter, manage } = directory;
    const provider = rows.find((p) => p.id === providerId);
    const first = rows[0]?.id;
    useEffect(() => {
        if (!providerId && first) onSelect(first);
    }, [providerId, first, onSelect]);
    const [form, setForm] = useState<S["ProviderWrite"]>(defaults),
        [editing, setEditing] = useState(""),
        [apiKey, setKey] = useState("");
    const selectProvider = (p: Provider) => {
        setEditing(p.id);
        onSelect(p.id);
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
    return (
        <>
            {!providers.isPending && !rows.length && <p>{t("empty")}</p>}
            <label>
                {t("provider")}
                <select value={providerId} onChange={(e) => onSelect(e.target.value)}>
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
                <div>
                    <strong>{t("budget")} USD</strong>{" "}
                    {`${t("used")}: ${provider.budget.estimatedUsedUsd} · ${t("held")}: ${provider.budget.heldUsd} · ` +
                        `${t("available")}: ${provider.budget.availableUsd}`}
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
                        <button type="button" onClick={() => selectProvider(provider)}>
                            {t("provider")} {provider.name}
                        </button>
                    )}
                    {(["name", "baseURL", "model"] as const).map((k, i) => (
                        <label key={k}>
                            {t((["name", "endpoint", "model"] as const)[i]!)}
                            <input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                        </label>
                    ))}
                    <label>
                        {tx("Adapter")}
                        <select
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
                            {t((["monthly", "inputRate", "outputRate", "outputLimit", "requestLimit"] as const)[i]!)}
                            <input
                                type="number"
                                min="0"
                                step="any"
                                value={form[k]}
                                onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
                            />
                        </label>
                    ))}
                    <label>
                        <input
                            type="checkbox"
                            checked={form.enabled}
                            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                        />
                        {t("enabled")}
                    </label>
                    <button
                        type="button"
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
                                onSelect(p.id);
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
                                disabled={!provider.enabled}
                                onClick={() =>
                                    void action(async () => {
                                        const g = await adapter.test(provider.id, crypto.randomUUID(), signal);
                                        if (signal.aborted) return;
                                        onTest(g, provider.revision);
                                        await refresh();
                                    })
                                }
                            >
                                {t("test")}
                            </button>
                            <button
                                type="button"
                                onClick={() =>
                                    void action(async () => {
                                        await adapter.remove(provider.id, signal);
                                        if (signal.aborted) return;
                                        const remaining = await refresh();
                                        if (signal.aborted) return;
                                        setKey("");
                                        onSelect(remaining.find((item) => item.id !== provider.id)?.id ?? "");
                                        setEditing("");
                                        setForm(defaults);
                                    })
                                }
                            >
                                {t("remove")}
                            </button>
                        </>
                    )}
                </fieldset>
            )}
        </>
    );
}

/**
 * 设置标签只创建云端提供方适配器。连接测试展示本次调用的真实状态，切换空间或离开标签后清除未提交的密钥。
 */
export function WorkspaceAiSettings({ workspace }: { workspace: Workspace }) {
    useAppLocale();
    const { t } = useTranslation("ai", { i18n: aiI18n });
    const { signal } = useWorkspace();
    const adapter = useMemo(() => new CloudAiAdapter(workspace.id), [workspace.id]);
    const directory = useProviderDirectory(workspace, adapter, signal);
    const { providers, busy, error, action } = directory;
    const [selected, setSelected] = useState("");
    const [tested, setTested] = useState<{ result: Generation; revision: number }>();
    const selectedProvider = directory.rows.find((item) => item.id === selected);
    const result = tested?.revision === selectedProvider?.revision ? tested?.result : undefined;
    return (
        <div className="vq-ai">
            <p>{t("estimate")}</p>
            {!directory.manage && <p>{tx("Provider configuration is read-only.")}</p>}
            {(error || providers.error) && <p role="alert">{error || providers.error?.message}</p>}
            {(busy || providers.isPending) && <p role="status">{t("loading")}</p>}
            <ProviderControls
                directory={directory}
                providerId={selected}
                onSelect={setSelected}
                onTest={(result, revision) => setTested({ result, revision })}
                refresh={directory.refreshProviders}
            />
            {result && result.providerId === selected && (
                <p role="status">
                    {t("test")} · {result.status} {result.errorCode}
                </p>
            )}
            <button type="button" disabled={busy} onClick={() => void action(directory.refreshProviders)}>
                {t("refresh")}
            </button>
        </div>
    );
}
