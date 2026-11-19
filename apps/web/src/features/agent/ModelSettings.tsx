/**
 * 工作区成员可以读取生效状态。管理成员打开表单后从已有 AI 目录选择供应商，在保存时由服务器验证两项配置。
 */
import { useState, type FormEvent } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { tx } from "../../locale";
import type { Workspace } from "../../api";
import type { AiAdapter } from "../ai/adapters";
import {
    agentErrorCode,
    agentWorkspaceReadDenied,
    observeAgentRead,
    type AgentSchemas,
    type CloudAgentAdapter,
} from "./adapters";
import { AgentError, agentProblem } from "./feedback";

type Settings = AgentSchemas["AgentSettingsWrite"];
const labels = { READY: "Ready", UNAVAILABLE: "Unavailable", UNCONFIGURED: "Unconfigured" };

/**
 * 模型选择解析由服务端定义。即使专用配置失效，页面继续显示被选标识及错误，方便管理成员有意识地修改或恢复配置。
 */
export function ModelSettings({
    workspace,
    owner,
    adapter,
    providers,
    signal,
    onWorkspaceReadDenied,
}: {
    workspace: Workspace;
    owner: string;
    adapter: CloudAgentAdapter;
    providers: Pick<AiAdapter, "providers">;
    signal: AbortSignal;
    onWorkspaceReadDenied: (error: unknown) => void;
}) {
    const manage = !workspace.archived && ["OWNER", "ADMIN"].includes(workspace.role);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<Settings>();
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<unknown>();
    const cache = useQueryClient();
    const key = ["workspace", workspace.id, "agent", owner, "settings"];
    const settings = useQuery({
        queryKey: key,
        queryFn: ({ signal: request }) => {
            const active = AbortSignal.any([signal, request]);
            return observeAgentRead(adapter.settings(active), active, onWorkspaceReadDenied);
        },
    });
    const directory = useInfiniteQuery({
        queryKey: ["workspace", workspace.id, "agent", owner, "providers"],
        queryFn: ({ pageParam, signal: request }) => providers.providers(pageParam, AbortSignal.any([signal, request])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        enabled: open && manage,
    });
    const available = directory.data?.pages.flatMap((page) => page.items) ?? [];
    const current = settings.data;
    const choice = draft ?? {
        defaultProviderId: current?.defaultProviderId ?? null,
        agentProviderId: current?.agentProviderId ?? null,
    };

    // 即使服务器的选定供应商已被删除或仍在后续页，选项也要保留对应 ID，避免无意间改写既有配置。
    const choices = (selected: string | null) => (
        <>
            {selected && !available.some((item) => item.id === selected) && (
                <option value={selected}>
                    {selected} · {tx("Selected provider is missing from this page")}
                </option>
            )}
            {available.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.enabled}>
                    {item.name} · {item.model}
                </option>
            ))}
        </>
    );

    // 仅当前工作区仍拥有写入时发布结果。重新读取时采用回传的权威状态，并清理已成功提交的编辑草稿。
    async function save(event: FormEvent) {
        event.preventDefault();
        if (!manage || saving || !current || !draft) return;
        setSaving(true);
        setError(undefined);
        try {
            const updated = await adapter.saveSettings(draft, signal);
            signal.throwIfAborted();
            await cache.cancelQueries({ queryKey: key, exact: true });
            signal.throwIfAborted();
            cache.setQueryData(key, updated);
            setDraft(undefined);
        } catch (failure) {
            if (!signal.aborted) {
                if (agentErrorCode(failure) === "AUTHENTICATION_REQUIRED") {
                    onWorkspaceReadDenied(failure);
                } else {
                    setError(failure);
                    // 保存失败可能只失去管理权限；沿用设置读取复核可读权限，原来的保存请求由用户自行处置。
                    if (agentWorkspaceReadDenied(failure)) {
                        void settings.refetch();
                    }
                }
            }
        } finally {
            if (!signal.aborted) setSaving(false);
        }
    }

    return (
        <section className="vq-agent-model" aria-label={tx("Model settings")}>
            <div className="vq-agent-toolbar">
                <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
                    {tx("Model settings")}
                </button>
                {current && (
                    <span role="status" className="vq-agent-model-state">
                        <strong>{tx(labels[current.providerStatus])}</strong>
                        {current.agentProviderId ? tx("Uses conversation provider") : tx("Inherits workspace default")}
                    </span>
                )}
                {settings.isPending && <span role="status">{tx("Loading VeriQ…")}</span>}
            </div>
            <AgentError error={settings.error} retry={() => void settings.refetch()} />
            {current?.errorCode && <p role="status">{agentProblem(current.errorCode)}</p>}
            {open && current && !manage && (
                <dl>
                    <dt>{tx("Workspace default provider")}</dt>
                    <dd>{current.defaultProviderId ?? tx("No default provider")}</dd>
                    <dt>{tx("Conversation provider")}</dt>
                    <dd>{current.agentProviderId ?? tx("Inherit workspace default")}</dd>
                </dl>
            )}
            {open && manage && (
                <form className="vq-agent-settings" onSubmit={(event) => void save(event)}>
                    <label>
                        {tx("Workspace default provider")}
                        <select
                            value={choice.defaultProviderId ?? ""}
                            disabled={!current || saving}
                            onChange={(event) => setDraft({ ...choice, defaultProviderId: event.target.value || null })}
                        >
                            <option value="">{tx("No default provider")}</option>
                            {choices(choice.defaultProviderId)}
                        </select>
                    </label>
                    <label>
                        {tx("Conversation provider")}
                        <select
                            value={choice.agentProviderId ?? ""}
                            disabled={!current || saving}
                            onChange={(event) => setDraft({ ...choice, agentProviderId: event.target.value || null })}
                        >
                            <option value="">{tx("Inherit workspace default")}</option>
                            {choices(choice.agentProviderId)}
                        </select>
                    </label>
                    <div className="vq-agent-toolbar">
                        <button type="submit" disabled={!current || !draft || saving}>
                            {tx("Save model settings")}
                        </button>
                        {directory.hasNextPage && (
                            <button
                                type="button"
                                disabled={directory.isFetchingNextPage}
                                onClick={() => void directory.fetchNextPage()}
                            >
                                {tx("More providers")}
                            </button>
                        )}
                    </div>
                    <AgentError error={directory.error} retry={() => void directory.refetch()} />
                    <AgentError error={error} />
                </form>
            )}
        </section>
    );
}
