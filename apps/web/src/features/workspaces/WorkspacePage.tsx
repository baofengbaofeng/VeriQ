/**
 * Workspace 管理页：创建/重命名/归档空间，以及成员角色、邀请与接受邀请流程。归档后成员列表仍可只读查看；归档完成后成员
 * 与邀请列表仍可只读浏览。
 * 列表走 api.workspaces；成员与邀请均嵌套在选定 workspaceId 下。
 */

import { tx, useAppLocale } from "../../locale";
import { useContext, useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Workspace } from "../../api";
import { Select, SelectItem } from "../../components";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Auth } from "../../auth-context";
import { Field, Notice, Panel, useAction, values } from "../../ui";
import { useWorkspaceDirectory, WorkspaceStatus } from "./WorkspaceDirectory";
import { useWorkspace } from "./WorkspaceContext";
import { WorkspaceAiProviders } from "../ai/ProviderControls";
import { SettingsPanel, SettingsTabs, settingsTabs, type SettingsTab } from "./SettingsTabs";
import { SampleWorkspaceWizard } from "../examples/SampleWorkspaceWizard";

const message = (error: Error | null) =>
    error instanceof ApiError ? error.message : error ? "Unable to load Workspace data. Please retry." : "";

/**
 * 管理顶栏选择的空间及其成员与邀请；样例向导创建空间后通知目录，保留分页操作和成员权限判断。
 */
export function WorkspacePage() {
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

function WorkspaceDetail({ id, identity }: { id: string; identity: string }) {
    useAppLocale();
    const client = useQueryClient(),
        a = useAction(),
        { signal } = useWorkspace();
    const location = useLocation();
    const navigate = useNavigate();
    const prefix = useId();
    const params = new URLSearchParams(location.search);
    const tab = settingsTabs.find((entry) => entry.id === params.get("tab"))?.id ?? "basic";
    function activate(next: SettingsTab) {
        if (next === tab) return;
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
    const denied =
        (detail.error instanceof ApiError && [401, 403, 404].includes(detail.error.status)) ||
        (detail.isSuccess && (!["OWNER", "ADMIN"].includes(detail.data.role) || detail.data.archived));
    // 详情暂时失败时保留已签发的一次性链接，确认管理权限撤销时立即清除，并阻止较早的异步提交重新放回链接。
    useLayoutEffect(() => {
        if (denied) {
            accessGeneration.current++;
            setInvitation("");
        }
    }, [denied]);
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
    };
    if (detail.isPending) return <p role="status">{tx("Loading Workspace…")}</p>;
    if (detail.error)
        return (
            <>
                <Notice error={message(detail.error)} />
                <button type="button" onClick={() => void detail.refetch()}>
                    {tx("Retry Workspace")}
                </button>
            </>
        );
    const ws = detail.data;
    return (
        <article className="vq-workspace-settings">
            <SettingsTabs selected={tab} prefix={prefix} activate={activate} />
            <SettingsPanel tab="basic" prefix={prefix} selected={tab}>
                <WorkspaceBasics ws={ws} refresh={refresh} />
            </SettingsPanel>
            <SettingsPanel tab="members" prefix={prefix} selected={tab}>
                <WorkspaceMembers
                    key={`${ws.role}-${ws.archived}`}
                    ws={ws}
                    active={tab === "members"}
                    refresh={refresh}
                    link={invitation}
                    onIssued={issued}
                />
            </SettingsPanel>
            <SettingsPanel tab="ai-providers" prefix={prefix} selected={tab}>
                {tab === "ai-providers" && <WorkspaceAiProviders key={`${ws.role}-${ws.archived}`} workspace={ws} />}
            </SettingsPanel>
            <Notice error={a.error} message={a.message} />
        </article>
    );
}

type SettingsProps = { ws: Workspace; refresh: () => Promise<void> };

/**
 * 普通信息与成员操作分别保存表单和状态提示；切换标签仍能找回刚提交的结果，切换工作区则重新挂载。
 */
function WorkspaceBasics({ ws, refresh }: SettingsProps) {
    const { signal } = useWorkspace(),
        a = useAction();
    const { id } = ws;
    const canManage = ["OWNER", "ADMIN"].includes(ws.role) && !ws.archived;
    const canArchive = ws.role === "OWNER" && !ws.archived;
    const [renameOpen, setRenameOpen] = useState(false);
    const [archiveOpen, setArchiveOpen] = useState(false);
    return (
        <>
            <dl className="vq-workspace-meta">
                <dt>{tx("ID")}</dt>
                <dd>{ws.id}</dd>
                <dt>{tx("Key")}</dt>
                <dd>{ws.key}</dd>
                <dt>{tx("Name")}</dt>
                <dd>{ws.name}</dd>
                <dt>{tx("Created")}</dt>
                <dd>{new Date(ws.createdAt).toLocaleString(undefined, { timeZone: "Asia/Shanghai" })}</dd>
                <dt>{tx("Status")}</dt>
                <dd>{ws.archived ? tx("Archived") : tx("Active")}</dd>
            </dl>
            {canManage && (
                <div className="vq-create-actions">
                    <button type="button" onClick={() => setRenameOpen(true)}>
                        {tx("Rename Workspace")}
                    </button>
                    {canArchive && (
                        <button type="button" onClick={() => setArchiveOpen(true)}>
                            {tx("Archive Workspace")}
                        </button>
                    )}
                </div>
            )}
            {!canManage && (
                <p>
                    {ws.archived
                        ? tx("Archived Workspaces are read-only.")
                        : tx("Your role cannot manage this Workspace or its members.")}
                </p>
            )}
            <Notice error={a.error} message={a.message} />
            <Dialog.Root open={renameOpen} onOpenChange={setRenameOpen}>
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
                        <Dialog.Description className="vq-workspace-key-hint">
                            {tx("Rename Workspace hint")}
                        </Dialog.Description>
                        <form
                            className="vq-workspace-form"
                            onSubmit={(event) => {
                                const v = values(event);
                                void a.run(async () => {
                                    await api.renameWorkspace(id, v.name, signal);
                                    await refresh();
                                    a.setMessage("Workspace updated");
                                    setRenameOpen(false);
                                });
                            }}
                        >
                            <label>
                                {tx("Name")}
                                <input name="name" defaultValue={ws.name} required maxLength={160} />
                            </label>
                            <div className="vq-workspace-form-actions">
                                <Dialog.Close type="button" className="vq-btn-secondary">
                                    {tx("Cancel")}
                                </Dialog.Close>
                                <button type="submit" className="vq-btn-primary" disabled={a.busy}>
                                    {tx("Rename Workspace")}
                                </button>
                            </div>
                        </form>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
            <Dialog.Root open={archiveOpen} onOpenChange={setArchiveOpen}>
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
                            <Dialog.Close type="button" className="vq-btn-secondary">
                                {tx("Cancel")}
                            </Dialog.Close>
                            <button
                                type="button"
                                className="vq-btn-danger"
                                disabled={a.busy}
                                onClick={() =>
                                    void a.run(async () => {
                                        await api.archiveWorkspace(id, signal);
                                        await refresh();
                                        setArchiveOpen(false);
                                    })
                                }
                            >
                                {tx("Archive Workspace")}
                            </button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </>
    );
}

/**
 * 成员列表只在成员标签请求；同一工作区内的切页保留一次性邀请链接。管理权限或工作区身份改变时清除旧链接。
 */
function WorkspaceMembers({
    ws,
    active,
    refresh,
    link,
    onIssued,
}: {
    ws: Workspace;
    active: boolean;
    refresh: () => Promise<void>;
    link: string;
    onIssued: (link: string) => void;
}) {
    const { signal } = useWorkspace(),
        a = useAction();
    const canManage = ["OWNER", "ADMIN"].includes(ws.role) && !ws.archived;
    const [q, setQ] = useState("");
    const [roleFilter, setRoleFilter] = useState<string[]>([]);
    const [membership, setMembership] = useState("");
    const [disabled, setDisabled] = useState("");
    const [systemAdmin, setSystemAdmin] = useState("");
    const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
    const cursor = cursors[cursors.length - 1];
    const pageIndex = cursors.length - 1;
    const users = useQuery({
        queryKey: ["workspace-users", ws.id, q, roleFilter, membership, disabled, systemAdmin, cursor],
        queryFn: () =>
            api.users({
                workspaceId: ws.id,
                q: q || undefined,
                role: roleFilter.join(",") || undefined,
                membership: (membership || undefined) as "member" | "non-member" | undefined,
                disabled: disabled === "" ? undefined : disabled === "true",
                systemAdmin: systemAdmin === "" ? undefined : systemAdmin === "true",
                cursor,
            }),
        enabled: active,
    });
    const nextCursor = users.data?.nextCursor;
    const invites = useQuery({
        queryKey: ["workspace-invites", ws.id],
        queryFn: async ({ signal }) => {
            const all = [] as Awaited<ReturnType<typeof api.invitations>>["items"];
            let cursor: string | undefined;
            do {
                const page = await api.invitations(ws.id, cursor, signal);
                all.push(...page.items);
                cursor = page.nextCursor ?? undefined;
            } while (cursor && !signal.aborted);
            return all;
        },
        enabled: !!canManage && active,
    });
    const [linkOpen, setLinkOpen] = useState(false);
    const [inviteOpen, setInviteOpen] = useState(false);
    const [inviteRole, setInviteRole] = useState("VIEWER");
    const inviteDialogRef = useRef<HTMLDivElement>(null);
    const [inviteSearch, setInviteSearch] = useState("");
    const [inviteRoles, setInviteRoles] = useState<string[]>([]);
    const [inviteStatus, setInviteStatus] = useState("");
    const [invitePage, setInvitePage] = useState(0);
    const invitePageSize = 10;
    const inviteItems = (invites.data ?? []).filter(
        (invite) =>
            (!inviteSearch || invite.email.toLowerCase().includes(inviteSearch.toLowerCase())) &&
            (!inviteRoles.length || inviteRoles.includes(invite.role)) &&
            (!inviteStatus || invite.status === inviteStatus),
    );
    const invitePageCount = Math.max(1, Math.ceil(inviteItems.length / invitePageSize));
    const invitePageItems = inviteItems.slice(invitePage * invitePageSize, (invitePage + 1) * invitePageSize);
    return (
        <>
            <div className="vq-user-toolbar">
                <div className="vq-user-search">
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                        <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                    <input
                        type="search"
                        placeholder={tx("Search users")}
                        value={q}
                        maxLength={254}
                        onChange={(event) => {
                            setQ(event.target.value);
                            setCursors([undefined]);
                        }}
                    />
                </div>
                <div className="vq-user-filters">
                    <RoleFilter
                        value={roleFilter}
                        onChange={(roles) => {
                            setRoleFilter(roles);
                            setCursors([undefined]);
                        }}
                        roles={["OWNER", "ADMIN", "EDITOR", "EXECUTOR", "VIEWER"]}
                    />
                    <ChoiceFilter
                        label={tx("Membership")}
                        value={membership}
                        onChange={(value) => {
                            setMembership(value);
                            setCursors([undefined]);
                        }}
                        choices={[
                            ["", tx("All")],
                            ["member", tx("Member")],
                            ["non-member", tx("Non-member")],
                        ]}
                    />
                    <ChoiceFilter
                        label={tx("Account status")}
                        value={disabled}
                        onChange={(value) => {
                            setDisabled(value);
                            setCursors([undefined]);
                        }}
                        choices={[
                            ["", tx("All")],
                            ["false", tx("Active")],
                            ["true", tx("Disabled")],
                        ]}
                    />
                    <ChoiceFilter
                        label={tx("System administrator")}
                        value={systemAdmin}
                        onChange={(value) => {
                            setSystemAdmin(value);
                            setCursors([undefined]);
                        }}
                        choices={[
                            ["", tx("All")],
                            ["true", tx("Yes")],
                            ["false", tx("No")],
                        ]}
                    />
                </div>
            </div>
            {users.isPending && <p role="status">{tx("Loading users…")}</p>}
            {users.error && <Notice error={message(users.error)} />}
            {users.data && users.data.items.length === 0 && <p>{tx("No users found.")}</p>}
            {users.data && users.data.items.length > 0 && (
                <>
                    <div className="table-scroll">
                        <table className="vq-user-table">
                            <thead>
                                <tr>
                                    <th>{tx("ID")}</th>
                                    <th>{tx("Email")}</th>
                                    <th>{tx("Display name")}</th>
                                    <th>{tx("Account status")}</th>
                                    <th>{tx("System administrator")}</th>
                                    <th>{tx("Created")}</th>
                                    <th>{tx("Membership")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {users.data.items.map((user) => (
                                    <tr key={user.id}>
                                        <td className="vq-user-id">{user.id}</td>
                                        <td className="vq-user-email">{user.email}</td>
                                        <td>{user.displayName}</td>
                                        <td>{user.disabled ? tx("Disabled") : tx("Active")}</td>
                                        <td>{user.systemAdmin ? tx("Yes") : tx("No")}</td>
                                        <td>
                                            {new Date(user.createdAt).toLocaleString(undefined, {
                                                timeZone: "Asia/Shanghai",
                                            })}
                                        </td>
                                        <td>{user.isMember ? (user.role ?? "") : tx("Non-member")}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="vq-pagination">
                        <button
                            type="button"
                            disabled={pageIndex === 0}
                            onClick={() => setCursors((c) => c.slice(0, -1))}
                        >
                            {tx("Previous")}
                        </button>
                        {Array.from({ length: pageIndex + 1 }, (_, index) => index + 1).map((pageNumber) => (
                            <button
                                key={pageNumber}
                                type="button"
                                className="vq-page"
                                aria-current={pageNumber - 1 === pageIndex ? "page" : undefined}
                                onClick={() => setCursors((c) => c.slice(0, pageNumber))}
                            >
                                {pageNumber}
                            </button>
                        ))}
                        <button
                            type="button"
                            disabled={!nextCursor}
                            onClick={() => nextCursor && setCursors((c) => [...c, nextCursor])}
                        >
                            {tx("Next")}
                        </button>
                    </div>
                </>
            )}
            {canManage && (
                <>
                    <Dialog.Root open={inviteOpen} onOpenChange={setInviteOpen} modal={false}>
                        <Dialog.Portal>
                            <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                            <Dialog.Content ref={inviteDialogRef} className="vq-dialog vq-workspace-dialog">
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
                                        "Links expire after seven days and can be used once. Existing accounts sign in with their own credentials.",
                                    )}
                                </Dialog.Description>
                                <form
                                    className="vq-workspace-form"
                                    onSubmit={(e) => {
                                        const v = values(e);
                                        void a.run(async () => {
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
                                            onIssued(result.invitationUrl);
                                            setInviteOpen(false);
                                            setLinkOpen(true);
                                            await refresh();
                                            a.setMessage(
                                                result.delivery === "FAILED"
                                                    ? "Email delivery failed. Copy the invitation link instead."
                                                    : result.delivery === "SENT"
                                                      ? "Invitation emailed"
                                                      : "Invitation created",
                                            );
                                        });
                                    }}
                                >
                                    <label>
                                        {tx("Email")}
                                        <input name="email" type="email" required maxLength={254} />
                                    </label>
                                    <div className="vq-field">
                                        <span>{tx("Role")}</span>
                                        <Select
                                            value={inviteRole}
                                            onValueChange={setInviteRole}
                                            aria-label={tx("Role")}
                                        >
                                            <SelectItem value="ADMIN">ADMIN</SelectItem>
                                            <SelectItem value="EDITOR">EDITOR</SelectItem>
                                            <SelectItem value="EXECUTOR">EXECUTOR</SelectItem>
                                            <SelectItem value="VIEWER">VIEWER</SelectItem>
                                        </Select>
                                    </div>
                                    <label className="check">
                                        <input type="checkbox" name="sendEmail" />
                                        {tx("Send by configured SMTP")}
                                    </label>
                                    <div className="vq-workspace-form-actions">
                                        <Dialog.Close type="button" className="vq-btn-secondary">
                                            {tx("Cancel")}
                                        </Dialog.Close>
                                        <button type="submit" className="vq-btn-primary" disabled={a.busy}>
                                            {tx("Create invitation")}
                                        </button>
                                    </div>
                                </form>
                            </Dialog.Content>
                        </Dialog.Portal>
                    </Dialog.Root>
                    <Dialog.Root open={linkOpen} onOpenChange={setLinkOpen}>
                        <Dialog.Portal>
                            <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                            <Dialog.Content className="vq-dialog vq-workspace-dialog">
                                <div className="vq-card-heading">
                                    <Dialog.Title>{tx("Invitation link")}</Dialog.Title>
                                    <Dialog.Close className="vq-sheet-close" aria-label={tx("Close")}>
                                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
                                            <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.5" />
                                        </svg>
                                    </Dialog.Close>
                                </div>
                                <Dialog.Description className="vq-workspace-key-hint">
                                    {tx("Share this link privately with the invited user.")}
                                </Dialog.Description>
                                <input
                                    className="vq-invite-link"
                                    readOnly
                                    value={link}
                                    onFocus={(e) => e.currentTarget.select()}
                                />
                                <div className="vq-workspace-form-actions">
                                    <Dialog.Close type="button" className="vq-btn-secondary">
                                        {tx("Close")}
                                    </Dialog.Close>
                                    <button
                                        type="button"
                                        className="vq-btn-primary"
                                        onClick={() =>
                                            void a.run(async () => {
                                                await navigator.clipboard.writeText(link);
                                                a.setMessage("Link copied.");
                                            })
                                        }
                                    >
                                        {tx("Copy link")}
                                    </button>
                                </div>
                            </Dialog.Content>
                        </Dialog.Portal>
                    </Dialog.Root>
                    <h3>{tx("Invitations")}</h3>
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
                                    placeholder={tx("Search email")}
                                    value={inviteSearch}
                                    maxLength={254}
                                    onChange={(event) => {
                                        setInviteSearch(event.target.value);
                                        setInvitePage(0);
                                    }}
                                />
                            </div>
                            <button
                                type="button"
                                className="vq-invite-add"
                                aria-label={tx("Invite a member")}
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
                            </button>
                        </div>
                        <div className="vq-user-filters">
                            <RoleFilter
                                value={inviteRoles}
                                onChange={(roles) => {
                                    setInviteRoles(roles);
                                    setInvitePage(0);
                                }}
                                roles={["ADMIN", "EDITOR", "EXECUTOR", "VIEWER"]}
                            />
                            <ChoiceFilter
                                label={tx("Status")}
                                value={inviteStatus}
                                onChange={(value) => {
                                    setInviteStatus(value);
                                    setInvitePage(0);
                                }}
                                choices={[
                                    ["", tx("All")],
                                    ["PENDING", "PENDING"],
                                    ["ACCEPTED", "ACCEPTED"],
                                    ["REVOKED", "REVOKED"],
                                    ["EXPIRED", "EXPIRED"],
                                ]}
                            />
                        </div>
                    </div>
                    {invites.isPending && <p role="status">{tx("Loading invitations…")}</p>}
                    {invites.error && (
                        <>
                            <Notice error={message(invites.error)} />
                            <button type="button" onClick={() => void invites.refetch()}>
                                {tx("Retry invitations")}
                            </button>
                        </>
                    )}
                    {invites.isSuccess && inviteItems.length === 0 && <p>{tx("No invitations yet.")}</p>}
                    {inviteItems.length > 0 && (
                        <>
                            <div className="table-scroll">
                                <table className="vq-user-table">
                                    <thead>
                                        <tr>
                                            <th>{tx("ID")}</th>
                                            <th>{tx("Email")}</th>
                                            <th>{tx("Role")}</th>
                                            <th>{tx("Status")}</th>
                                            <th>{tx("Created")}</th>
                                            <th>{tx("Expires")}</th>
                                            <th />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {invitePageItems.map((invite) => (
                                            <tr key={invite.id}>
                                                <td className="vq-user-id">{invite.id}</td>
                                                <td>{invite.email}</td>
                                                <td>{invite.role}</td>
                                                <td>{invite.status}</td>
                                                <td>
                                                    {new Date(invite.createdAt).toLocaleString(undefined, {
                                                        timeZone: "Asia/Shanghai",
                                                    })}
                                                </td>
                                                <td>
                                                    {new Date(invite.expiresAt).toLocaleString(undefined, {
                                                        timeZone: "Asia/Shanghai",
                                                    })}
                                                </td>
                                                <td>
                                                    {invite.status === "PENDING" && (
                                                        <button
                                                            type="button"
                                                            disabled={a.busy}
                                                            onClick={() =>
                                                                void a.run(async () => {
                                                                    await api.revokeInvitation(
                                                                        ws.id,
                                                                        invite.id,
                                                                        signal,
                                                                    );
                                                                    await refresh();
                                                                    a.setMessage("Invitation revoked");
                                                                })
                                                            }
                                                        >
                                                            {tx("Revoke invitation")}
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <div className="vq-pagination">
                                <button
                                    type="button"
                                    disabled={invitePage === 0}
                                    onClick={() => setInvitePage((p) => p - 1)}
                                >
                                    {tx("Previous")}
                                </button>
                                {Array.from({ length: invitePageCount }, (_, index) => index + 1).map((pageNumber) => (
                                    <button
                                        key={pageNumber}
                                        type="button"
                                        className="vq-page"
                                        aria-current={pageNumber - 1 === invitePage ? "page" : undefined}
                                        onClick={() => setInvitePage(pageNumber - 1)}
                                    >
                                        {pageNumber}
                                    </button>
                                ))}
                                <button
                                    type="button"
                                    disabled={invitePage >= invitePageCount - 1}
                                    onClick={() => setInvitePage((p) => p + 1)}
                                >
                                    {tx("Next")}
                                </button>
                            </div>
                        </>
                    )}
                </>
            )}
        </>
    );
}

function RoleFilter({
    value,
    onChange,
    roles,
}: {
    value: string[];
    onChange: (roles: string[]) => void;
    roles: readonly string[];
}) {
    const label = value.length ? value.join(", ") : tx("Role");
    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger className="vq-filter-button">
                {label}
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
                    {roles.map((role) => (
                        <DropdownMenu.CheckboxItem
                            key={role}
                            className="vq-dropdown-item"
                            checked={value.includes(role)}
                            onCheckedChange={() =>
                                onChange(
                                    value.includes(role) ? value.filter((item) => item !== role) : [...value, role],
                                )
                            }
                            onSelect={(event) => event.preventDefault()}
                        >
                            {role}
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
                        </DropdownMenu.CheckboxItem>
                    ))}
                    {value.length > 0 && (
                        <>
                            <DropdownMenu.Separator className="vq-dropdown-separator" />
                            <DropdownMenu.Item className="vq-dropdown-item" onSelect={() => onChange([])}>
                                {tx("Clear filters")}
                            </DropdownMenu.Item>
                        </>
                    )}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}

function ChoiceFilter({
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
                        {choices.map(([item, label]) => (
                            <DropdownMenu.RadioItem key={item} value={item} className="vq-dropdown-item">
                                {label}
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
    const { user, refresh } = useContext(Auth);
    const [token, setToken] = useState("");
    const [newAccount, setNewAccount] = useState(false);
    const [accepted, setAccepted] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const generation = useRef(0);
    const identity = user?.id;
    const previousUser = useRef(identity);
    const inlineLogin = useRef<string>();
    useLayoutEffect(() => {
        if (identity !== previousUser.current && (!identity || inlineLogin.current !== identity)) {
            generation.current++;
            setAccepted(false);
            setError("");
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
        setError("");
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
                            setError("");
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
                                if (generation.current === current) setAccepted(true);
                            })()
                                .catch((cause) => {
                                    if (generation.current === current)
                                        setError(
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
                                <Field name="displayName" label={tx("Display name")} />
                                <Field
                                    name="password"
                                    label={tx("New password (at least 12 characters)")}
                                    type="password"
                                    minLength={12}
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
                                <Field name="email" label={tx("Invited account email")} type="email" />
                                <Field name="password" label={tx("Current account password")} type="password" />
                            </>
                        )}
                        <button type="submit" disabled={busy}>
                            {tx("Accept invitation")}
                        </button>
                    </form>
                </>
            )}
            <Notice error={error} />
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
