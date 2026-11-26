/**
 * 工作区对话的模型设置由服务端解析。顶栏按钮与生效状态由 AgentModelControls 持有，只读详情与编辑表单以弹窗呈现，
 * 避免占用对话首屏；保存与读取仍共用同一份设置缓存。
 */
import { useId, useState, type FormEvent } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { tx } from "../../locale";
import icons from "../../admin-icons.svg?no-inline";
import type { Workspace } from "../../api";
import { Button, Field, Select, SelectItem } from "../../components";
import type { AiAdapter } from "../ai/adapters";
import {
    agentErrorCode,
    agentWorkspaceReadDenied,
    observeAgentRead,
    type AgentSchemas,
    type CloudAgentAdapter,
} from "./adapters";
import { AgentError, agentOperationError, agentProblem } from "./feedback";
import { useOperationFeedback } from "../../operation-feedback";
import { useRequestLifetime } from "../../request-lifetime";

type Settings = AgentSchemas["AgentSettingsWrite"];
type SettingsDTO = AgentSchemas["AgentSettingsDTO"];
const labels = { READY: "Ready", UNAVAILABLE: "Unavailable", UNCONFIGURED: "Unconfigured" };
// Radix 保留空字符串供占位使用，无模型选项用非空的界面值表示，写入草稿时立即恢复为空引用。
const noProvider = "no-provider";

/**
 * 工作区对话的模型设置读取由服务端解析，模型状态与选择标识共享给会话视图与顶栏入口，二者读取同一份缓存。
 */
export function useAgentSettings(
    workspace: Workspace,
    owner: string,
    adapter: CloudAgentAdapter,
    signal: AbortSignal,
    onWorkspaceReadDenied: (error: unknown) => void = () => {},
) {
    const key = ["workspace", workspace.id, "agent", owner, "settings"];
    const settings = useQuery({
        queryKey: key,
        queryFn: ({ signal: request }) => {
            const active = AbortSignal.any([signal, request]);
            return observeAgentRead(adapter.settings(active), active, onWorkspaceReadDenied);
        },
    });
    return { key, settings };
}

/**
 * 弹窗内的模型设置内容：普通成员看到只读详情，管理成员可编辑默认与专用两个独立选择；保存由服务端验证并写回缓存。
 */
export function ModelSettings({
    workspace,
    owner,
    adapter,
    providers,
    signal,
    onWorkspaceReadDenied = () => {},
    onSaved = () => {},
    settings,
    settingsKey,
}: {
    workspace: Workspace;
    owner: string;
    adapter: CloudAgentAdapter;
    providers: Pick<AiAdapter, "providers">;
    signal: AbortSignal;
    onWorkspaceReadDenied?: (error: unknown) => void;
    onSaved?: () => void;
    settings: UseQueryResult<SettingsDTO>;
    settingsKey: string[];
}) {
    const manage = !workspace.archived && ["OWNER", "ADMIN"].includes(workspace.role);
    const defaultField = useId();
    const conversationField = useId();
    const { showSuccess, showFailure } = useOperationFeedback();
    const [draft, setDraft] = useState<Settings>();
    const [saving, setSaving] = useState(false);
    const cache = useQueryClient();
    const directory = useInfiniteQuery({
        queryKey: ["workspace", workspace.id, "agent", owner, "providers"],
        queryFn: ({ pageParam, signal: request }) => providers.providers(pageParam, AbortSignal.any([signal, request])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        enabled: manage,
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
                <SelectItem value={selected}>
                    {selected} · {tx("Selected provider is missing from this page")}
                </SelectItem>
            )}
            {available.map((item) => (
                <SelectItem key={item.id} value={item.id} disabled={!item.enabled}>
                    {item.name} · {item.model}
                </SelectItem>
            ))}
        </>
    );

    // 仅当前工作区仍拥有写入时发布结果。重新读取时采用回传的权威状态，并清理已成功提交的编辑草稿。
    async function save(event: FormEvent) {
        event.preventDefault();
        if (!manage || saving || !current || !draft) return;
        setSaving(true);
        try {
            const updated = await adapter.saveSettings(draft, signal);
            signal.throwIfAborted();
            await cache.cancelQueries({ queryKey: settingsKey, exact: true });
            signal.throwIfAborted();
            cache.setQueryData(settingsKey, updated);
            setDraft(undefined);
            onSaved();
            showSuccess(tx("Model settings saved"));
        } catch (failure) {
            if (!signal.aborted) {
                if (agentErrorCode(failure) === "AUTHENTICATION_REQUIRED") {
                    onWorkspaceReadDenied(failure);
                } else {
                    showFailure(agentOperationError(failure));
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
        <div className="vq-agent-dialog-body">
            <AgentError error={settings.error} retry={() => void settings.refetch()} />
            {current?.errorCode && <p role="status">{agentProblem(current.errorCode)}</p>}
            {!manage && (
                <dl>
                    <dt>{tx("Workspace default provider")}</dt>
                    <dd>{current?.defaultProviderId ?? tx("No default provider")}</dd>
                    <dt>{tx("Conversation provider")}</dt>
                    <dd>{current?.agentProviderId ?? tx("Inherit workspace default")}</dd>
                </dl>
            )}
            {manage && (
                <form className="vq-agent-settings" onSubmit={(event) => void save(event)}>
                    <Field
                        label={tx("Workspace default provider")}
                        htmlFor={defaultField}
                        hint={tx("Workspace default provider guidance")}
                        required
                    >
                        <Select
                            id={defaultField}
                            value={choice.defaultProviderId ?? noProvider}
                            disabled={!current || saving}
                            appearance="default-dropdown"
                            contentClassName="vq-agent-model-select"
                            escapeClosesSelectOnly
                            required
                            onValueChange={(value) =>
                                setDraft({ ...choice, defaultProviderId: value === noProvider ? null : value })
                            }
                        >
                            <SelectItem value={noProvider}>{tx("No default provider")}</SelectItem>
                            {choices(choice.defaultProviderId)}
                        </Select>
                    </Field>
                    <Field
                        label={tx("Conversation provider")}
                        htmlFor={conversationField}
                        hint={tx("Conversation provider guidance")}
                        required
                    >
                        <Select
                            id={conversationField}
                            value={choice.agentProviderId ?? noProvider}
                            disabled={!current || saving}
                            appearance="default-dropdown"
                            contentClassName="vq-agent-model-select"
                            escapeClosesSelectOnly
                            required
                            onValueChange={(value) =>
                                setDraft({ ...choice, agentProviderId: value === noProvider ? null : value })
                            }
                        >
                            <SelectItem value={noProvider}>{tx("Inherit workspace default")}</SelectItem>
                            {choices(choice.agentProviderId)}
                        </Select>
                    </Field>
                    <div className="vq-agent-toolbar">
                        {directory.hasNextPage && (
                            <button
                                type="button"
                                disabled={directory.isFetchingNextPage}
                                onClick={() => void directory.fetchNextPage()}
                            >
                                {tx("More providers")}
                            </button>
                        )}
                        <Button
                            type="submit"
                            tone="primary"
                            className="vq-agent-save"
                            disabled={!current || !draft || saving}
                        >
                            {tx("Save model settings")}
                        </Button>
                    </div>
                    <AgentError error={directory.error} retry={() => void directory.refetch()} />
                </form>
            )}
        </div>
    );
}

/**
 * 顶栏的模型设置入口：按钮与当前生效状态并排，点击后以弹窗展示 ModelSettings。未选工作区时由宿主条件渲染。
 */
export function AgentModelControls({
    workspace,
    owner,
    adapter,
    providers,
    signal: parentSignal,
}: {
    workspace: Workspace;
    owner: string;
    adapter: CloudAgentAdapter;
    providers: Pick<AiAdapter, "providers">;
    signal?: AbortSignal;
}) {
    const signal = useRequestLifetime(parentSignal)?.signal;
    return signal ? (
        <AgentModelControlsView
            workspace={workspace}
            owner={owner}
            adapter={adapter}
            providers={providers}
            signal={signal}
        />
    ) : null;
}

function AgentModelControlsView({
    workspace,
    owner,
    adapter,
    providers,
    signal,
}: {
    workspace: Workspace;
    owner: string;
    adapter: CloudAgentAdapter;
    providers: Pick<AiAdapter, "providers">;
    signal: AbortSignal;
}) {
    const { key: settingsKey, settings } = useAgentSettings(workspace, owner, adapter, signal);
    const current = settings.data;
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                className="vq-sheet-size-toggle"
                aria-label={tx("Model settings")}
                title={tx("Model settings")}
                onClick={() => setOpen(true)}
            >
                <svg aria-hidden="true" width="16" height="16">
                    <use href={`${icons}#settings`} />
                </svg>
            </button>
            {current && (
                <span className="vq-agent-model-state">
                    <strong className="vq-agent-status" data-status={current.providerStatus}>
                        {tx(labels[current.providerStatus])}
                    </strong>
                    {current.agentProviderId ? tx("Uses conversation provider") : tx("Inherits workspace default")}
                </span>
            )}
            <Dialog.Root open={open} onOpenChange={setOpen}>
                <Dialog.Portal>
                    <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                    <Dialog.Content className="vq-dialog vq-workspace-dialog">
                        <div className="vq-card-heading">
                            <Dialog.Title>{tx("Model settings")}</Dialog.Title>
                            <Dialog.Close className="vq-sheet-close" aria-label={tx("Close")}>
                                ×
                            </Dialog.Close>
                        </div>
                        {open && (
                            <ModelSettings
                                workspace={workspace}
                                owner={owner}
                                adapter={adapter}
                                providers={providers}
                                signal={signal}
                                onSaved={() => setOpen(false)}
                                settings={settings}
                                settingsKey={settingsKey}
                            />
                        )}
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </>
    );
}
