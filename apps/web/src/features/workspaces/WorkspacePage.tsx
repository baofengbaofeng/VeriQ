/**
 * Workspace 管理页：创建/重命名/归档空间，以及成员角色、邀请与接受邀请流程。归档后成员列表仍可只读查看；归档完成后成员
 * 与邀请列表仍可只读浏览。
 * 列表走 api.workspaces；成员与邀请均嵌套在选定 workspaceId 下。
 */

import { tx, useAppLocale } from "../../locale";
import { ConfirmDialog } from "../../locale-ui";
import { canExportWorkspaceTable, collectTablePages, DataTable, useTableView } from "../../table-view";
import { useCallback, useContext, useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Workspace } from "../../api";
import icons from "../../admin-icons.svg?no-inline";
import { Button, Field as FormField, Input, Select, SelectItem } from "../../components";
import * as Dialog from "@radix-ui/react-dialog";
import { Auth } from "../../auth-context";
import { Field, Notice, Panel, useAction, values } from "../../ui";
import { useOperationFeedback } from "../../operation-feedback";
import { useWorkspaceDirectory, WorkspaceStatus } from "./WorkspaceDirectory";
import { useWorkspace } from "./WorkspaceContext";
import type { WorkspaceCapability } from "../agent/workspace-forms";
import { WorkspaceAiProviders } from "../ai/ProviderControls";
import { WorkspaceIdentityManager } from "../environments/IdentityManager";
import { SettingsPanel, SettingsTabs, settingsTabs, type SettingsTab } from "./SettingsTabs";
import { MemberActions, MemberRoster } from "./MemberActions";
import { WorkspaceTableFilters } from "./WorkspaceTableFilters";
import { SampleWorkspaceWizard } from "../examples/SampleWorkspaceWizard";
import "./workspace-management.css";

const workspaceFormTabs: Partial<Record<WorkspaceCapability, SettingsTab>> = {
    WORKSPACE_ARCHIVE: "basic",
    WORKSPACE_MEMBERS: "members",
    AUTH_CREDENTIALS: "auth-credentials",
    AI_PROVIDERS: "ai-providers",
};

const message = (error: Error | null) =>
    error instanceof ApiError ? error.message : error ? "Unable to load Workspace data. Please retry." : "";

/**
 * 工作区信息与成员、邀请表共享上海时区的时间显示，表格下载沿用同一转换以便核对原始记录。
 */
const workspaceTimestamp = (value: string, locale?: string) =>
    new Date(value).toLocaleString(locale, { timeZone: "Asia/Shanghai" });

/**
 * 后台查询暂时失败时可以继续查看已经读取的结果；服务明确拒绝当前访问时，旧数据不得继续展示。
 */
function deniesWorkspaceAccess(error: Error | null) {
    return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

/**
 * 每份查询在所属表格或详情区域报告加载和失败，按钮只重试该请求，已发布的写入回执由共享结果框独立管理。
 */
function WorkspaceQueryFeedback({
    loading,
    error,
    loadingLabel,
    retryLabel,
    retry,
}: {
    loading: boolean;
    error: Error | null;
    loadingLabel: string;
    retryLabel: string;
    retry: () => void;
}) {
    if (error)
        return (
            <div className="vq-workspace-query-error">
                <Notice error={message(error)} />
                <Button size="compact" tone="secondary" onClick={retry}>
                    {tx(retryLabel)}
                </Button>
            </div>
        );
    if (loading) return <p role="status">{tx(loadingLabel)}</p>;
    return null;
}

/**
 * 管理顶栏选择的空间及其成员与邀请；样例向导创建空间后通知目录，保留分页操作和成员权限判断。
 */
export function WorkspacePage({ capability }: { capability?: WorkspaceCapability } = {}) {
    useAppLocale();
    const { user } = useContext(Auth),
        { workspace, choose } = useWorkspaceDirectory(),
        client = useQueryClient();
    const [sampleOpen, setSampleOpen] = useState(false);
    const sampleTrigger = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (sampleOpen) document.getElementById("sample-wizard-title")?.focus();
    }, [sampleOpen]);
    if (!user) return <Navigate to="/login" />;
    if (capability) {
        const tab = workspaceFormTabs[capability];
        if (!tab) return null;
        return workspace ? (
            <WorkspaceDetail key={user.id + workspace.id} id={workspace.id} identity={user.id} pinned={tab} />
        ) : (
            <WorkspaceStatus />
        );
    }
    return (
        <Panel title={workspace ? `${tx("Workspaces")}: ${workspace.name}` : tx("Workspaces")}>
            <p>{tx("One project is one Workspace. Membership controls access to its resources.")}</p>
            <WorkspaceStatus />
            {sampleOpen && (
                <div id="sample-workspace-panel">
                    <SampleWorkspaceWizard
                        workspaceId={
                            workspace && !workspace.archived && ["OWNER", "ADMIN"].includes(workspace.role)
                                ? workspace.id
                                : undefined
                        }
                        onWorkspaceCreated={(id) => {
                            choose(id);
                            void client.invalidateQueries({ queryKey: ["workspaces", user.id] });
                        }}
                        onClose={() => {
                            setSampleOpen(false);
                            sampleTrigger.current?.focus();
                        }}
                    />
                </div>
            )}
            {workspace && <WorkspaceDetail key={user.id + workspace.id} id={workspace.id} identity={user.id} />}
        </Panel>
    );
}

function WorkspaceDetail({ id, identity, pinned }: { id: string; identity: string; pinned?: SettingsTab }) {
    useAppLocale();
    const client = useQueryClient(),
        { signal } = useWorkspace();
    const location = useLocation();
    const navigate = useNavigate();
    const prefix = useId();
    const params = new URLSearchParams(location.search);
    const tab = pinned ?? settingsTabs.find((entry) => entry.id === params.get("tab"))?.id ?? "basic";
    function activate(next: SettingsTab) {
        if (next === tab) return;
        if (!params.has("fromAgentForm") && tab === "auth-credentials") params.delete("workspaceId");
        if (next === "basic") params.delete("tab");
        else params.set("tab", next);
        void navigate({ pathname: location.pathname, search: params.toString(), hash: location.hash });
    }
    const key = ["workspace", identity, id];
    const detail = useQuery({
        queryKey: [...key, "detail"],
        queryFn: ({ signal }) => api.workspace(id, signal),
    });
    const [invitation, setInvitation] = useState("");
    const accessGeneration = useRef(0);
    const clearInvitation = useCallback(() => {
        accessGeneration.current++;
        setInvitation("");
    }, []);
    const accessFailure = deniesWorkspaceAccess(detail.error);
    const denied =
        accessFailure || (detail.isSuccess && (!["OWNER", "ADMIN"].includes(detail.data.role) || detail.data.archived));
    // 详情暂时失败时保留已签发的一次性链接，确认管理权限撤销时立即清除，并阻止较早的异步提交重新放回链接。
    useLayoutEffect(() => {
        if (denied) clearInvitation();
    }, [denied, clearInvitation]);
    const generation = accessGeneration.current;
    function issued(link: string) {
        if (!signal?.aborted && generation === accessGeneration.current) setInvitation(link);
    }
    const refresh = async () => {
        if (signal?.aborted) return;
        await client.invalidateQueries({ queryKey: key });
        if (signal?.aborted) return;
        await client.invalidateQueries({ queryKey: ["workspaces", identity] });
        await client.invalidateQueries({ queryKey: ["directory-entry", identity, id] });
        await client.invalidateQueries({ queryKey: ["workspace-invites", id] });
        await Promise.all([
            client.invalidateQueries({ queryKey: ["workspace-members", id] }),
            client.invalidateQueries({ queryKey: ["workspace-users", id] }),
        ]);
    };
    const status = (
        <WorkspaceQueryFeedback
            loading={detail.isPending}
            error={detail.error}
            loadingLabel="Loading Workspace…"
            retryLabel="Retry Workspace"
            retry={() => void detail.refetch()}
        />
    );
    const ws = detail.data;
    if (!ws || accessFailure) return status;
    const panels: Record<SettingsTab, React.ReactNode> = {
        basic: <WorkspaceBasics ws={ws} refresh={refresh} archiveOnly={!!pinned} />,
        members: (
            <WorkspaceMembers
                key={`${ws.role}-${ws.archived}`}
                ws={ws}
                active={tab === "members"}
                refresh={refresh}
                link={invitation}
                onIssued={issued}
                onClearIssued={clearInvitation}
                membersOnly={!!pinned}
            />
        ),
        "auth-credentials": tab === "auth-credentials" && <WorkspaceAuthentication workspace={ws} />,
        "ai-providers": tab === "ai-providers" && (
            <WorkspaceAiProviders key={`${ws.role}-${ws.archived}`} workspace={ws} />
        ),
    };
    return (
        <article className="vq-workspace-settings">
            {status}
            {pinned ? (
                panels[pinned]
            ) : (
                <>
                    <SettingsTabs selected={tab} prefix={prefix} activate={activate} />
                    {settingsTabs.map(({ id: tabId }) => (
                        <SettingsPanel key={tabId} tab={tabId} prefix={prefix} selected={tab}>
                            {panels[tabId]}
                        </SettingsPanel>
                    ))}
                </>
            )}
        </article>
    );
}

/**
 * 当前空间的所有者与管理员可读取版本摘要，归档时以只读模式重建身份面板并释放旧表单和写入请求。
 * 活动标签变化时卸载面板；空间变更则由详情容器键和空间取消信号同时隔离。
 */
function WorkspaceAuthentication({ workspace }: { workspace: Workspace }) {
    const { signal } = useWorkspace();
    return <WorkspaceIdentityManager workspace={workspace} signal={signal} />;
}

type SettingsProps = { ws: Workspace; refresh: () => Promise<void> };

/**
 * 概览集中展示所选工作区的标识和状态，归档单独提供给所有者，名称更新和权限状态仍以服务端回读为准。
 */
function WorkspaceBasics({ ws, refresh, archiveOnly = false }: SettingsProps & { archiveOnly?: boolean }) {
    const { signal } = useWorkspace(),
        a = useAction();
    const { language } = useAppLocale();
    const { id } = ws;
    const canManage = ["OWNER", "ADMIN"].includes(ws.role) && !ws.archived;
    const canArchive = ws.role === "OWNER" && !ws.archived;
    const titleId = useId();
    const archiveHintId = useId();
    const [renameOpen, setRenameOpen] = useState(false);
    const [archiveOpen, setArchiveOpen] = useState(false);
    const [copyState, setCopyState] = useState<"done" | "failed">();

    /**
     * 只有操作系统确认写入才显示复制成功，失去当前空间后晚到的结果不更新其他空间的可访问提示。
     */
    async function copyWorkspaceId() {
        if (signal?.aborted) return;
        setCopyState(undefined);
        try {
            await navigator.clipboard.writeText(id);
            if (!signal?.aborted) setCopyState("done");
        } catch {
            if (!signal?.aborted) setCopyState("failed");
        }
    }

    return (
        <>
            <Dialog.Root open={renameOpen} onOpenChange={setRenameOpen}>
                <section className="vq-workspace-overview" aria-labelledby={titleId}>
                    <header className="vq-workspace-overview-head">
                        <div className="vq-workspace-overview-title">
                            <h2 id={titleId}>{ws.name}</h2>
                            <span
                                className="vq-state vq-workspace-state"
                                data-tone={ws.archived ? "neutral" : "success"}
                            >
                                {tx(ws.archived ? "Workspace state: archived" : "Workspace state: active")}
                            </span>
                        </div>
                        {canManage && !archiveOnly && (
                            <Dialog.Trigger asChild>
                                <Button
                                    size="regular"
                                    tone="secondary"
                                    className="vq-workspace-overview-action vq-workspace-overview-rename"
                                >
                                    {tx("Rename Workspace")}
                                </Button>
                            </Dialog.Trigger>
                        )}
                    </header>
                    <dl className="vq-workspace-overview-details">
                        <div>
                            <dt>{tx("Key")}</dt>
                            <dd>{ws.key}</dd>
                        </div>
                        <div>
                            <dt>{tx("Created")}</dt>
                            <dd>
                                <time dateTime={ws.createdAt}>
                                    {workspaceTimestamp(ws.createdAt, language === "zh" ? "zh-CN" : "en")}
                                </time>
                            </dd>
                        </div>
                        <div className="vq-workspace-overview-identity">
                            <dt>{tx("Workspace ID")}</dt>
                            <dd>
                                <span className="vq-workspace-overview-id">{id}</span>
                                <button
                                    type="button"
                                    className="vq-icon-button"
                                    title={tx("Copy Workspace ID")}
                                    aria-label={tx("Copy Workspace ID")}
                                    onClick={() => void copyWorkspaceId()}
                                >
                                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
                                        {copyState === "done" ? (
                                            <use href={`${icons}#check`} />
                                        ) : (
                                            <>
                                                <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" />
                                                <path
                                                    d="M6 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v2"
                                                    stroke="currentColor"
                                                    strokeLinecap="round"
                                                />
                                            </>
                                        )}
                                    </svg>
                                </button>
                                <span className="vq-visually-hidden" role="status">
                                    {copyState === "done" && tx("Workspace ID copied.")}
                                    {copyState === "failed" && tx("Workspace ID could not be copied.")}
                                </span>
                            </dd>
                        </div>
                    </dl>
                </section>
                <Dialog.Portal>
                    <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                    <Dialog.Content className="vq-dialog vq-workspace-dialog">
                        <div className="vq-card-heading">
                            <Dialog.Title>{tx("Rename Workspace")}</Dialog.Title>
                            <Dialog.Close className="vq-sheet-close" aria-label={tx("Close")}>
                                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
                                    <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.5" />
                                </svg>
                            </Dialog.Close>
                        </div>
                        <Dialog.Description className="vq-visually-hidden">
                            {tx("Rename Workspace hint")}
                        </Dialog.Description>
                        <form
                            className="vq-workspace-form vq-workspace-compact-form"
                            onSubmit={(event) => {
                                const v = values(event);
                                void a.submit(async (complete) => {
                                    await api.renameWorkspace(id, v.name, signal);
                                    setRenameOpen(false);
                                    complete("Workspace updated");
                                    await refresh();
                                });
                            }}
                        >
                            <FormField
                                htmlFor="workspace-new-name"
                                label={tx("Name")}
                                hint={tx("Workspace name guidance")}
                                required
                            >
                                <Input
                                    id="workspace-new-name"
                                    name="name"
                                    defaultValue={ws.name}
                                    required
                                    maxLength={160}
                                />
                            </FormField>
                            <div className="vq-workspace-form-actions">
                                <Dialog.Close asChild>
                                    <Button size="regular" tone="secondary">
                                        {tx("Cancel")}
                                    </Button>
                                </Dialog.Close>
                                <Button type="submit" size="regular" disabled={a.busy}>
                                    {tx("Rename Workspace")}
                                </Button>
                            </div>
                        </form>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
            {!canManage && (
                <p className="vq-workspace-overview-readonly">
                    {ws.archived
                        ? tx("Archived Workspaces are read-only.")
                        : tx("Your role cannot manage this Workspace or its members.")}
                </p>
            )}
            <Notice error={a.error} />
            <Dialog.Root open={archiveOpen} onOpenChange={setArchiveOpen}>
                {canArchive && (
                    <div className="vq-workspace-overview-archive">
                        <p id={archiveHintId}>{tx("Archive Workspace hint")}</p>
                        <Dialog.Trigger asChild>
                            <Button
                                size="regular"
                                tone="danger"
                                className="vq-workspace-overview-action"
                                aria-describedby={archiveHintId}
                            >
                                {tx("Archive Workspace")}
                            </Button>
                        </Dialog.Trigger>
                    </div>
                )}
                <Dialog.Portal>
                    <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                    <Dialog.Content className="vq-dialog vq-workspace-dialog">
                        <div className="vq-card-heading">
                            <Dialog.Title>{tx("Archive Workspace")}</Dialog.Title>
                            <Dialog.Close className="vq-sheet-close" aria-label={tx("Close")}>
                                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
                                    <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.5" />
                                </svg>
                            </Dialog.Close>
                        </div>
                        <Dialog.Description className="vq-workspace-key-hint">
                            {tx("Archive Workspace hint")}
                        </Dialog.Description>
                        <div className="vq-workspace-form-actions">
                            <Dialog.Close asChild>
                                <Button size="regular" tone="secondary">
                                    {tx("Cancel")}
                                </Button>
                            </Dialog.Close>
                            <Button
                                size="regular"
                                tone="danger"
                                disabled={a.busy}
                                onClick={() =>
                                    void a.submit(async (complete) => {
                                        await api.archiveWorkspace(id, signal);
                                        setArchiveOpen(false);
                                        complete("Workspace archived");
                                        await refresh();
                                    })
                                }
                            >
                                {tx("Archive Workspace")}
                            </Button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </>
    );
}

// 邀请徽章沿用当前列表的状态值，等待接受与主动撤销分别突出显示，已到期状态使用普通中性色。
const invitationStatusTones = {
    PENDING: "warning",
    ACCEPTED: "success",
    REVOKED: "danger",
    EXPIRED: "neutral",
} as const;

const memberRoles = ["OWNER", "ADMIN", "EDITOR", "EXECUTOR", "VIEWER"] as const;
const invitationRoles = ["ADMIN", "EDITOR", "EXECUTOR", "VIEWER"] as const;

/**
 * 成员列表只在成员标签请求；同一工作区内的切页保留一次性邀请链接。管理权限或工作区身份改变时清除旧链接。
 */
function WorkspaceMembers({
    ws,
    active,
    refresh,
    link,
    onIssued,
    onClearIssued,
    membersOnly,
}: {
    ws: Workspace;
    active: boolean;
    refresh: () => Promise<void>;
    link: string;
    onIssued: (link: string) => void;
    onClearIssued: () => void;
    membersOnly: boolean;
}) {
    const { signal } = useWorkspace(),
        a = useAction();
    const canManage = ["OWNER", "ADMIN"].includes(ws.role) && !ws.archived;
    const globalAdmin = useContext(Auth).user?.systemAdmin === true;
    const globalDirectory = globalAdmin && !membersOnly;
    const [q, setQ] = useState("");
    const [roleFilter, setRoleFilter] = useState<string[]>([]);
    const [membership, setMembership] = useState("");
    const [disabled, setDisabled] = useState("");
    const [systemAdmin, setSystemAdmin] = useState("");
    const [memberPageSize, setMemberPageSize] = useState(25);
    const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
    const cursor = cursors[cursors.length - 1];
    const pageIndex = cursors.length - 1;
    const users = useQuery({
        queryKey: ["workspace-users", ws.id, q, roleFilter, membership, disabled, systemAdmin, memberPageSize, cursor],
        queryFn: ({ signal: querySignal }) =>
            api.users(
                {
                    workspaceId: ws.id,
                    q: q || undefined,
                    role: roleFilter.join(",") || undefined,
                    membership: (membership || undefined) as "member" | "non-member" | undefined,
                    disabled: disabled === "" ? undefined : disabled === "true",
                    systemAdmin: systemAdmin === "" ? undefined : systemAdmin === "true",
                    limit: memberPageSize,
                    cursor,
                },
                signal ? AbortSignal.any([signal, querySignal]) : querySignal,
            ),
        enabled: active && globalDirectory,
    });
    const nextCursor = users.data?.nextCursor;
    const invites = useQuery({
        queryKey: ["workspace-invites", ws.id],
        queryFn: ({ signal: querySignal }) =>
            collectTablePages(
                (cursor, activeSignal) => api.invitations(ws.id, cursor, activeSignal),
                signal ? AbortSignal.any([signal, querySignal]) : querySignal,
            ),
        enabled: !!canManage && active,
    });
    const [linkOpen, setLinkOpen] = useState(false);
    const [deliveryMessage, setDeliveryMessage] = useState("");
    const [inviteOpen, setInviteOpen] = useState(false);
    const [inviteRole, setInviteRole] = useState("VIEWER");
    const inviteTrigger = useRef<HTMLButtonElement>(null);
    const invitationAccess = useRef({ denied: false, revision: 0 });
    const invitationAccessDenied =
        deniesWorkspaceAccess(invites.error) || (!invites.isSuccess && invitationAccess.current.denied);
    /**
     * 邀请目录可能先于详情发现权限撤销。立即销毁旧链接，且后续重试恢复读取时也不能交付旧代次链接。
     * 重试尚未成功时继续保持拒绝状态，避免沿用缓存详情开放新的签发入口。
     */
    useLayoutEffect(() => {
        const access = invitationAccess.current;
        access.denied = invitationAccessDenied;
        if (invitationAccessDenied) {
            access.revision++;
            onClearIssued();
            setInviteOpen(false);
            setLinkOpen(false);
        }
    }, [invitationAccessDenied, onClearIssued]);
    const activeMembers = useRef(active);
    useLayoutEffect(() => {
        activeMembers.current = active;
        return () => {
            activeMembers.current = false;
        };
    }, [active]);
    const [inviteRoles, setInviteRoles] = useState<string[]>([]);
    const [inviteStatus, setInviteStatus] = useState("");
    const inviteItems = useMemo(
        () =>
            (invites.data ?? []).filter(
                (invite) =>
                    (!inviteRoles.length || inviteRoles.includes(invite.role)) &&
                    (!inviteStatus || invite.status === inviteStatus),
            ),
        [invites.data, inviteRoles, inviteStatus],
    );
    const inviteView = useTableView(inviteItems, {
        matches: (invite, term) => invite.email.toLowerCase().includes(term),
    });
    const memberRows = deniesWorkspaceAccess(users.error) ? undefined : users.data?.items;
    const hasMemberFilters = !!(q.trim() || roleFilter.length || membership || disabled || systemAdmin);
    const revokeWarning = tx("Revoking this invitation prevents it from being accepted.");
    return (
        <>
            {!globalDirectory && active && <MemberRoster ws={ws} refresh={refresh} />}
            {globalDirectory && (
                <DataTable
                    label={tx("Members")}
                    searchLabel={tx("Search users")}
                    searchMaxLength={254}
                    exportAllowed={canExportWorkspaceTable(ws.role)}
                    busy={users.isFetching || users.isError || !memberRows}
                    hasMore={!!nextCursor}
                    view={{
                        rows: memberRows ?? [],
                        search: q,
                        setSearch: (value) => {
                            setQ(value);
                            setCursors([undefined]);
                        },
                        pageSize: memberPageSize,
                        setPageSize: (size) => {
                            setMemberPageSize(size);
                            setCursors([undefined]);
                        },
                        page: pageIndex + 1,
                        pageCount: cursors.length,
                        filteredCount:
                            memberRows && !nextCursor ? pageIndex * memberPageSize + memberRows.length : undefined,
                        setPage: (page) => {
                            if (page <= cursors.length) setCursors((current) => current.slice(0, page));
                            else if (nextCursor) setCursors((current) => [...current, nextCursor]);
                        },
                    }}
                    exportColumns={[
                        { label: tx("ID"), value: (user) => user.id },
                        { label: tx("Email"), value: (user) => user.email },
                        { label: tx("Display name"), value: (user) => user.displayName },
                        { label: tx("Account status"), value: (user) => tx(user.disabled ? "Disabled" : "Active") },
                        { label: tx("System administrator"), value: (user) => tx(user.systemAdmin ? "Yes" : "No") },
                        { label: tx("Created"), value: (user) => workspaceTimestamp(user.createdAt) },
                        {
                            label: tx("Membership"),
                            value: (user) => tx(user.isMember && user.role ? user.role : "Non-member"),
                        },
                    ]}
                    beforeDownload={
                        <WorkspaceTableFilters
                            filters={[
                                {
                                    label: tx("Role"),
                                    multiple: true,
                                    value: roleFilter,
                                    choices: memberRoles.map((role) => [role, tx(role)] as const),
                                    onChange: (roles) => {
                                        setRoleFilter(roles);
                                        setCursors([undefined]);
                                    },
                                },
                                {
                                    label: tx("Membership"),
                                    value: membership,
                                    choices: [
                                        ["", tx("All")],
                                        ["member", tx("Member")],
                                        ["non-member", tx("Non-member")],
                                    ],
                                    onChange: (value) => {
                                        setMembership(value);
                                        setCursors([undefined]);
                                    },
                                },
                                {
                                    label: tx("Account status"),
                                    value: disabled,
                                    choices: [
                                        ["", tx("All")],
                                        ["false", tx("Active")],
                                        ["true", tx("Disabled")],
                                    ],
                                    onChange: (value) => {
                                        setDisabled(value);
                                        setCursors([undefined]);
                                    },
                                },
                                {
                                    label: tx("System administrator"),
                                    value: systemAdmin,
                                    choices: [
                                        ["", tx("All")],
                                        ["true", tx("Yes")],
                                        ["false", tx("No")],
                                    ],
                                    onChange: (value) => {
                                        setSystemAdmin(value);
                                        setCursors([undefined]);
                                    },
                                },
                            ]}
                            onReset={() => {
                                setQ("");
                                setRoleFilter([]);
                                setMembership("");
                                setDisabled("");
                                setSystemAdmin("");
                                setCursors([undefined]);
                            }}
                        />
                    }
                >
                    <WorkspaceQueryFeedback
                        loading={users.isPending}
                        error={users.error}
                        loadingLabel="Loading users…"
                        retryLabel="Retry members"
                        retry={() => void users.refetch()}
                    />
                    {memberRows && (
                        <div className="table-scroll">
                            <table className="vq-user-table vq-workspace-table">
                                <caption className="vq-visually-hidden">{tx("Members")}</caption>
                                <thead>
                                    <tr>
                                        <th>{tx("ID")}</th>
                                        <th>{tx("Email")}</th>
                                        <th>{tx("Display name")}</th>
                                        <th>{tx("Account status")}</th>
                                        <th>{tx("System administrator")}</th>
                                        <th>{tx("Created")}</th>
                                        <th>{tx("Membership")}</th>
                                        {canManage && <th>{tx("Actions")}</th>}
                                    </tr>
                                </thead>
                                <tbody>
                                    {memberRows.length === 0 && (
                                        <tr>
                                            <td className="vq-table-empty" colSpan={canManage ? 8 : 7}>
                                                {tx(hasMemberFilters ? "No matching users." : "No users found.")}
                                            </td>
                                        </tr>
                                    )}
                                    {memberRows.map((user) => (
                                        <tr key={user.id}>
                                            <td className="vq-user-id">{user.id}</td>
                                            <td className="vq-user-email">{user.email}</td>
                                            <td>{user.displayName}</td>
                                            <td>
                                                <span
                                                    className="vq-state vq-workspace-state"
                                                    data-tone={user.disabled ? "neutral" : "success"}
                                                >
                                                    {user.disabled ? tx("Disabled") : tx("Active")}
                                                </span>
                                            </td>
                                            <td>{user.systemAdmin ? tx("Yes") : tx("No")}</td>
                                            <td>{workspaceTimestamp(user.createdAt)}</td>
                                            <td>
                                                {user.role ? tx(user.role) : tx("Non-member")}
                                                {user.role && !user.isMember && <> · {tx("Disabled")}</>}
                                            </td>
                                            {canManage && (
                                                <td>
                                                    {user.role && (
                                                        <MemberActions
                                                            ws={ws}
                                                            refresh={refresh}
                                                            member={{
                                                                userId: user.id,
                                                                role: user.role,
                                                                email: user.email,
                                                                userDisabled: user.disabled,
                                                                status: user.isMember ? "ACTIVE" : "DISABLED",
                                                            }}
                                                        />
                                                    )}
                                                </td>
                                            )}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </DataTable>
            )}
            {canManage && (
                <>
                    <Dialog.Root
                        open={inviteOpen && !invitationAccessDenied}
                        onOpenChange={setInviteOpen}
                        modal={false}
                    >
                        <Dialog.Portal>
                            <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                            <Dialog.Content
                                className="vq-dialog vq-workspace-dialog"
                                onCloseAutoFocus={(event) => {
                                    event.preventDefault();
                                    inviteTrigger.current?.focus();
                                }}
                            >
                                <div className="vq-card-heading">
                                    <Dialog.Title>{tx("Invite a member")}</Dialog.Title>
                                    <Dialog.Close className="vq-sheet-close" aria-label={tx("Close")}>
                                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
                                            <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.5" />
                                        </svg>
                                    </Dialog.Close>
                                </div>
                                <Dialog.Description className="vq-workspace-key-hint">
                                    {tx(
                                        "Links expire after seven days and can be used once. " +
                                            "Existing accounts sign in with their own credentials.",
                                    )}
                                </Dialog.Description>
                                <form
                                    className="vq-workspace-form vq-workspace-compact-form"
                                    onSubmit={(e) => {
                                        const v = values(e);
                                        const revision = invitationAccess.current.revision;
                                        const canDeliver = () =>
                                            !signal?.aborted &&
                                            !invitationAccess.current.denied &&
                                            invitationAccess.current.revision === revision;
                                        void a.submit(async (complete) => {
                                            const result = await api.invite(
                                                ws.id,
                                                {
                                                    email: v.email,
                                                    role: inviteRole as "ADMIN" | "EDITOR" | "EXECUTOR" | "VIEWER",
                                                    sendEmail: v.sendEmail === "on",
                                                },
                                                signal,
                                            );
                                            if (signal?.aborted) return;
                                            const delivery =
                                                result.delivery === "FAILED"
                                                    ? "Email delivery failed. Copy the invitation link instead."
                                                    : result.delivery === "SENT"
                                                      ? "Invitation emailed"
                                                      : "Invitation created";
                                            const receipt =
                                                result.delivery === "FAILED"
                                                    ? "Invitation created. Email delivery failed."
                                                    : delivery;
                                            // Radix Dialog 归还焦点后再交付链接，回执仅存 receipt 和回调。
                                            if (
                                                !complete(receipt, () => {
                                                    if (activeMembers.current && canDeliver()) setLinkOpen(true);
                                                })
                                            )
                                                return;
                                            if (canDeliver()) onIssued(result.invitationUrl);
                                            setDeliveryMessage(delivery);
                                            setInviteOpen(false);
                                            await refresh();
                                        });
                                    }}
                                >
                                    <FormField
                                        htmlFor="workspace-invite-email"
                                        label={tx("Email")}
                                        hint={tx("Invite email guidance")}
                                        required
                                    >
                                        <Input
                                            id="workspace-invite-email"
                                            name="email"
                                            type="email"
                                            required
                                            maxLength={254}
                                        />
                                    </FormField>
                                    <FormField
                                        htmlFor="workspace-invite-role"
                                        label={tx("Role")}
                                        hint={tx("Invite role guidance")}
                                        required
                                    >
                                        <Select
                                            id="workspace-invite-role"
                                            value={inviteRole}
                                            onValueChange={setInviteRole}
                                            required
                                        >
                                            {invitationRoles.map((role) => (
                                                <SelectItem key={role} value={role}>
                                                    {tx(role)}
                                                </SelectItem>
                                            ))}
                                        </Select>
                                    </FormField>
                                    <div className="vq-workspace-check">
                                        <label className="check">
                                            <input
                                                type="checkbox"
                                                name="sendEmail"
                                                aria-describedby="workspace-invite-delivery-help"
                                            />
                                            {tx("Send by configured SMTP")}
                                        </label>
                                        <p id="workspace-invite-delivery-help" className="vq-field-hint">
                                            {tx("Invite email delivery guidance")}
                                        </p>
                                    </div>
                                    <div className="vq-workspace-form-actions">
                                        <Dialog.Close asChild>
                                            <Button size="regular" tone="secondary">
                                                {tx("Cancel")}
                                            </Button>
                                        </Dialog.Close>
                                        <Button type="submit" size="regular" disabled={a.busy}>
                                            {tx("Create invitation")}
                                        </Button>
                                    </div>
                                </form>
                            </Dialog.Content>
                        </Dialog.Portal>
                    </Dialog.Root>
                    <Dialog.Root open={linkOpen && !!link && !invitationAccessDenied} onOpenChange={setLinkOpen}>
                        <Dialog.Portal>
                            <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                            <Dialog.Content
                                className="vq-dialog vq-workspace-dialog"
                                onCloseAutoFocus={(event) => {
                                    event.preventDefault();
                                    inviteTrigger.current?.focus();
                                }}
                            >
                                <div className="vq-card-heading">
                                    <Dialog.Title>{tx("Invitation link")}</Dialog.Title>
                                    <Dialog.Close className="vq-sheet-close" aria-label={tx("Close")}>
                                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
                                            <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.5" />
                                        </svg>
                                    </Dialog.Close>
                                </div>
                                <Dialog.Description className="vq-workspace-key-hint">
                                    {tx(deliveryMessage)} {tx("Share this link privately with the invited user.")}
                                </Dialog.Description>
                                <Input
                                    className="vq-invite-link"
                                    aria-label={tx("Invitation link")}
                                    readOnly
                                    value={link}
                                    onFocus={(e) => e.currentTarget.select()}
                                />
                                <div className="vq-workspace-form-actions">
                                    <Dialog.Close asChild>
                                        <Button size="regular" tone="secondary">
                                            {tx("Close")}
                                        </Button>
                                    </Dialog.Close>
                                    <Button
                                        size="regular"
                                        disabled={a.busy}
                                        onClick={() =>
                                            void a.submit(async (complete) => {
                                                await navigator.clipboard.writeText(link);
                                                complete("Link copied.");
                                            })
                                        }
                                    >
                                        {tx("Copy link")}
                                    </Button>
                                </div>
                            </Dialog.Content>
                        </Dialog.Portal>
                    </Dialog.Root>
                    <header className="vq-workspace-table-heading">
                        <h3>{tx("Invitations")}</h3>
                        <Button
                            ref={inviteTrigger}
                            size="compact"
                            className="vq-workspace-table-add"
                            aria-label={tx("Invite a member")}
                            title={tx("Invite a member")}
                            disabled={invitationAccessDenied}
                            onClick={() => setInviteOpen(true)}
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
                    </header>
                    <DataTable
                        label={tx("Invitations")}
                        view={invitationAccessDenied ? { ...inviteView, rows: [], filteredCount: 0 } : inviteView}
                        searchLabel={tx("Search email")}
                        searchMaxLength={254}
                        exportAllowed={canExportWorkspaceTable(ws.role)}
                        busy={invites.isFetching || invites.isError || invitationAccessDenied}
                        exportColumns={[
                            { label: tx("Email"), value: (invite) => invite.email },
                            { label: tx("Role"), value: (invite) => tx(invite.role) },
                            { label: tx("Status"), value: (invite) => tx(invite.status) },
                            { label: tx("Created"), value: (invite) => workspaceTimestamp(invite.createdAt) },
                            { label: tx("Expires"), value: (invite) => workspaceTimestamp(invite.expiresAt) },
                        ]}
                        beforeDownload={
                            <WorkspaceTableFilters
                                filters={[
                                    {
                                        label: tx("Role"),
                                        multiple: true,
                                        value: inviteRoles,
                                        choices: invitationRoles.map((role) => [role, tx(role)] as const),
                                        onChange: (roles) => {
                                            setInviteRoles(roles);
                                            inviteView.setPage(1);
                                        },
                                    },
                                    {
                                        label: tx("Status"),
                                        value: inviteStatus,
                                        choices: [
                                            ["", tx("All")],
                                            ["PENDING", tx("PENDING")],
                                            ["ACCEPTED", tx("ACCEPTED")],
                                            ["REVOKED", tx("REVOKED")],
                                            ["EXPIRED", tx("EXPIRED")],
                                        ],
                                        onChange: (value) => {
                                            setInviteStatus(value);
                                            inviteView.setPage(1);
                                        },
                                    },
                                ]}
                                onReset={() => {
                                    setInviteRoles([]);
                                    setInviteStatus("");
                                    inviteView.setSearch("");
                                }}
                            />
                        }
                    >
                        <WorkspaceQueryFeedback
                            loading={invites.isPending}
                            error={invites.error}
                            loadingLabel="Loading invitations…"
                            retryLabel="Retry invitations"
                            retry={() => void invites.refetch()}
                        />
                        {!invitationAccessDenied && (invites.isSuccess || inviteView.filteredCount > 0) && (
                            <div className="table-scroll">
                                <table className="vq-user-table vq-workspace-table">
                                    <caption className="vq-visually-hidden">{tx("Invitations")}</caption>
                                    <thead>
                                        <tr>
                                            <th>{tx("ID")}</th>
                                            <th>{tx("Email")}</th>
                                            <th>{tx("Role")}</th>
                                            <th>{tx("Status")}</th>
                                            <th>{tx("Created")}</th>
                                            <th>{tx("Expires")}</th>
                                            <th>{tx("Actions")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {inviteView.filteredCount === 0 && (
                                            <tr>
                                                <td className="vq-table-empty" colSpan={7}>
                                                    {tx(
                                                        invites.data?.length
                                                            ? "No matching invitations."
                                                            : "No invitations yet.",
                                                    )}
                                                </td>
                                            </tr>
                                        )}
                                        {inviteView.rows.map((invite) => (
                                            <tr key={invite.id}>
                                                <td className="vq-user-id">{invite.id}</td>
                                                <td>{invite.email}</td>
                                                <td>{tx(invite.role)}</td>
                                                <td>
                                                    <span
                                                        className="vq-state vq-workspace-state"
                                                        data-tone={invitationStatusTones[invite.status]}
                                                    >
                                                        {tx(invite.status)}
                                                    </span>
                                                </td>
                                                <td>{workspaceTimestamp(invite.createdAt)}</td>
                                                <td>{workspaceTimestamp(invite.expiresAt)}</td>
                                                <td>
                                                    {invite.status === "PENDING" && (
                                                        <ConfirmDialog
                                                            title="Revoke invitation"
                                                            trigger="Revoke invitation"
                                                            confirmLabel={tx("Revoke invitation")}
                                                            triggerClassName="vq-workspace-revoke-trigger"
                                                            confirmClassName="vq-workspace-revoke-confirm"
                                                            disabled={a.busy}
                                                            confirmAfterClose
                                                            onConfirm={(trigger) => {
                                                                if (
                                                                    !trigger ||
                                                                    !activeMembers.current ||
                                                                    invitationAccess.current.denied ||
                                                                    signal?.aborted
                                                                )
                                                                    return;
                                                                void a.submit(
                                                                    async (complete) => {
                                                                        await api.revokeInvitation(
                                                                            ws.id,
                                                                            invite.id,
                                                                            signal,
                                                                        );
                                                                        complete("Invitation revoked");
                                                                        await refresh();
                                                                    },
                                                                    { waitingFrom: trigger, signal },
                                                                );
                                                            }}
                                                        >
                                                            <p>{invite.email}</p>
                                                            <p>{revokeWarning}</p>
                                                        </ConfirmDialog>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </DataTable>
                </>
            )}
        </>
    );
}

/**
 * 邀请令牌由身份作用域外的组件持有，使内联登录后的同一提交得以继续；其它身份变化或离开页面会使旧提交失效。
 */
export function AcceptInvitation({
    entry,
    render,
}: {
    entry?: string;
    render: (content?: React.ReactNode) => React.ReactNode;
}) {
    useAppLocale();
    const feedback = useOperationFeedback();
    const { user, refresh } = useContext(Auth);
    const [token, setToken] = useState("");
    const [newAccount, setNewAccount] = useState(false);
    const [accepted, setAccepted] = useState(false);
    const [busy, setBusy] = useState(false);
    const generation = useRef(0);
    const identity = user?.id;
    const previousUser = useRef(identity);
    const inlineLogin = useRef<string>();
    useLayoutEffect(() => {
        if (identity !== previousUser.current && (!identity || inlineLogin.current !== identity)) {
            generation.current++;
            setAccepted(false);
            setBusy(false);
        }
        previousUser.current = identity;
        inlineLogin.current = undefined;
    }, [identity]);
    useLayoutEffect(() => {
        if (entry) {
            setToken(new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "");
            window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
        } else setToken("");
        setNewAccount(false);
        setAccepted(false);
        setBusy(false);
        return () => {
            generation.current++;
            inlineLogin.current = undefined;
        };
    }, [entry]);
    if (!entry) return render();
    return render(
        <Panel title={tx("Accept Workspace invitation")}>
            {!token ? (
                <Notice error="Invitation link is missing its token. Ask for a new link." />
            ) : accepted ? (
                <InvitationStatus>
                    {tx("Invitation accepted.")}{" "}
                    {user ? (
                        <Link to="/workspaces?tab=members">
                            {tx("Open workspace settings to view your membership.")}
                        </Link>
                    ) : (
                        tx("Sign in with your account to open the Workspace.")
                    )}
                </InvitationStatus>
            ) : (
                <>
                    <p>
                        {tx(
                            "Existing accounts must sign in as the invited identity. Invitations never change an exi" +
                                "sting account password.",
                        )}
                    </p>
                    <label className="check">
                        <input type="checkbox" checked={newAccount} onChange={(e) => setNewAccount(e.target.checked)} />
                        {tx("Create a new account")}
                    </label>
                    <form
                        onSubmit={(e) => {
                            const v = values(e);
                            const current = ++generation.current;
                            setBusy(true);
                            void (async () => {
                                if (!newAccount && !user) {
                                    const session = await api.login({ email: v.email, password: v.password });
                                    if (generation.current !== current) return;
                                    inlineLogin.current = session.user.id;
                                    await refresh();
                                    if (generation.current !== current) return;
                                }
                                await api.acceptInvitation(
                                    newAccount
                                        ? {
                                              token,
                                              displayName: v.displayName,
                                              password: v.password,
                                          }
                                        : { token },
                                );
                                if (generation.current === current) {
                                    setAccepted(true);
                                    feedback.showSuccess("Invitation accepted.");
                                }
                            })()
                                .catch((cause) => {
                                    if (generation.current === current)
                                        feedback.showFailure(
                                            cause instanceof ApiError
                                                ? cause.message
                                                : "Unable to reach VeriQ. Please try again.",
                                        );
                                })
                                .finally(() => {
                                    if (generation.current === current) setBusy(false);
                                });
                        }}
                    >
                        {newAccount ? (
                            <>
                                <Field
                                    name="displayName"
                                    label={tx("Display name")}
                                    hint={tx("Name shown to other members")}
                                />
                                <Field
                                    name="password"
                                    label={tx("New password (at least 12 characters)")}
                                    type="password"
                                    minLength={12}
                                    hint={tx("至少 12 个字符，建议混用字母、数字与符号。")}
                                />
                            </>
                        ) : user ? (
                            <p>
                                {tx("Accept as ")}
                                {user.email}
                                {tx(". Sign out first to use another account.")}
                            </p>
                        ) : (
                            <>
                                <Field
                                    name="email"
                                    label={tx("Invited account email")}
                                    type="email"
                                    hint={tx("Invited email guidance")}
                                />
                                <Field
                                    name="password"
                                    label={tx("Current account password")}
                                    type="password"
                                    hint={tx("Current password guidance")}
                                />
                            </>
                        )}
                        <Button type="submit" size="regular" disabled={busy}>
                            {tx("Accept invitation")}
                        </Button>
                    </form>
                </>
            )}
        </Panel>,
    );
}

/**
 * 接受邀请后刷新当前身份的目录，内联登录导致的身份切换在提交之前已经完成，令牌由外层持续持有。
 */
function InvitationStatus({ children }: { children: React.ReactNode }) {
    const client = useQueryClient();
    const { user } = useContext(Auth);
    useEffect(() => {
        if (user) void client.invalidateQueries({ queryKey: ["workspaces", user.id] });
    }, [client, user]);
    return <p role="status">{children}</p>;
}
