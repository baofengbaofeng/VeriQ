/**
 * Workspace 管理页：创建/重命名/归档空间，以及成员角色、邀请与接受邀请流程。归档后成员列表仍可只读查看；归档完成后成员与邀请列表仍可只读浏览。
 * 列表走 api.workspaces；成员与邀请均嵌套在选定 workspaceId 下。
 */

import { tx, useAppLocale } from "../../locale";
import { useContext, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Member, type Workspace } from "../../api";
import { Auth } from "../../auth-context";
import { Field, Notice, Panel, useAction, values } from "../../ui";
import { useWorkspace } from "./WorkspaceContext";
import { SampleWorkspaceWizard } from "../examples/SampleWorkspaceWizard";

const roles = ["OWNER", "ADMIN", "EDITOR", "EXECUTOR", "VIEWER"] as const;
const message = (error: Error | null) =>
    error instanceof ApiError
        ? error.message
        : error
          ? "Unable to load Workspace data. Please retry."
          : "";

/**
 * 拥有空间列表、成员与邀请分页 UI 状态；写操作调用 create/rename/archive/invite/updateMember。
 * 选择变更经 useWorkspace.select，确保下游 Runtime/Resource 页看到同一作用域。
 */
export function WorkspacePage() {
    useAppLocale();
    const { user } = useContext(Auth),
        { selected, select, signal } = useWorkspace(),
        client = useQueryClient(),
        a = useAction();
    const [sampleOpen, setSampleOpen] = useState(false);
    const sampleTrigger = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (sampleOpen) document.getElementById("sample-wizard-title")?.focus();
    }, [sampleOpen]);
    const workspaces = useInfiniteQuery({
        queryKey: ["workspaces", user?.id],
        queryFn: ({ pageParam, signal }) => api.workspaces(pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        enabled: !!user,
    });
    const items = workspaces.data?.pages.flatMap((page) => page.items) ?? [];
    // 空间管理页仅在未选择时采用首项，列表重取或续页不能替换用户正在查看的详情；手动选择即使暂时不在已加载页中，也由既有占位选项和详情查询维持归属。
    const firstWorkspaceId = items[0]?.id;
    useEffect(() => {
        if (!selected && firstWorkspaceId) select(firstWorkspaceId);
    }, [firstWorkspaceId, selected, select]);
    if (!user) return <Navigate to="/login" />;
    return (
        <Panel title={tx("Workspaces")}>
            <p>
                {tx("One project is one Workspace. Membership controls access to its resources.")}
            </p>
            {workspaces.isPending && <p role="status">{tx("Loading Workspaces…")}</p>}
            {workspaces.error && (
                <>
                    <Notice error={message(workspaces.error)} />
                    <button type="button" onClick={() => void workspaces.refetch()}>
                        {tx("Retry Workspaces")}
                    </button>
                </>
            )}
            {workspaces.isSuccess && !items.length && <p>{tx("No Workspaces yet.")}</p>}
            {!!items.length && (
                <label>
                    {tx("Current Workspace")}
                    <select
                        data-testid="workspace-selector"
                        value={selected}
                        onChange={(e) => select(e.target.value)}
                    >
                        <option value="" disabled>
                            {tx("Select Workspace")}
                        </option>
                        {selected && !items.some((ws) => ws.id === selected) && (
                            <option value={selected}>{tx("Selected Workspace")}</option>
                        )}
                        {items.map((ws) => (
                            <option key={ws.id} value={ws.id}>
                                {ws.name}
                                {ws.archived ? tx(" (Archived)") : ""}
                            </option>
                        ))}
                    </select>
                </label>
            )}
            {workspaces.hasNextPage && (
                <button
                    type="button"
                    data-testid="workspaces-more"
                    disabled={workspaces.isFetchingNextPage}
                    onClick={() => void workspaces.fetchNextPage()}
                >
                    {tx("Load more Workspaces")}
                </button>
            )}
            <button
                type="button"
                ref={sampleTrigger}
                data-testid="sample-workspace-open"
                aria-expanded={sampleOpen}
                aria-controls="sample-workspace-panel"
                onClick={() => setSampleOpen((open) => !open)}
            >
                {tx("Import sample workspace")}
            </button>
            {sampleOpen && (
                <div id="sample-workspace-panel">
                    <SampleWorkspaceWizard
                        workspaceId={
                            items.some(
                                (item) =>
                                    item.id === selected &&
                                    !item.archived &&
                                    ["OWNER", "ADMIN"].includes(item.role),
                            )
                                ? selected
                                : undefined
                        }
                        onWorkspaceCreated={(id) => {
                            select(id);
                            void client.invalidateQueries({ queryKey: ["workspaces", user.id] });
                        }}
                        onClose={() => {
                            setSampleOpen(false);
                            sampleTrigger.current?.focus();
                        }}
                    />
                </div>
            )}
            <h2>{tx("Create Workspace")}</h2>
            <form
                onSubmit={(e) => {
                    const v = values(e);
                    const form = e.currentTarget;
                    void a.run(async () => {
                        const ws = await api.createWorkspace({ key: v.key, name: v.name }, signal);
                        await client.invalidateQueries({
                            queryKey: ["workspaces", user.id],
                        });
                        select(ws.id);
                        form.reset();
                    });
                }}
            >
                <label>
                    {tx("Key")}
                    <input
                        data-testid="workspace-key"
                        name="key"
                        required
                        pattern="[A-Za-z_][A-Za-z0-9_.-]*"
                        maxLength={160}
                    />
                </label>
                <label>
                    {tx("Name")}
                    <input data-testid="workspace-name" name="name" required maxLength={160} />
                </label>
                <button type="submit" data-testid="workspace-create" disabled={a.busy}>
                    {tx("Create Workspace")}
                </button>
            </form>
            <Notice error={a.error} />
            {selected && (
                <WorkspaceDetail key={user.id + selected} id={selected} identity={user.id} />
            )}
        </Panel>
    );
}

function WorkspaceDetail({ id, identity }: { id: string; identity: string }) {
    useAppLocale();
    const client = useQueryClient(),
        a = useAction(),
        { signal } = useWorkspace();
    const key = ["workspace", identity, id];
    const detail = useQuery({
        queryKey: [...key, "detail"],
        queryFn: ({ signal }) => api.workspace(id, signal),
    });
    const members = useInfiniteQuery({
        queryKey: [...key, "members"],
        queryFn: ({ pageParam, signal }) => api.members(id, pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });
    const canManage =
        detail.data && ["OWNER", "ADMIN"].includes(detail.data.role) && !detail.data.archived;
    const invites = useInfiniteQuery({
        queryKey: [...key, "invitations"],
        queryFn: ({ pageParam, signal }) => api.invitations(id, pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        enabled: !!canManage,
    });
    const [link, setLink] = useState("");
    const refresh = async () => {
        await client.invalidateQueries({ queryKey: key });
        await client.invalidateQueries({ queryKey: ["workspaces", identity] });
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
        <article data-testid="workspace-detail">
            <h2>{ws.name}</h2>
            <p>
                {ws.key} · {ws.role} · {ws.archived ? tx("Archived") : tx("Active")}
            </p>
            <button
                type="button"
                data-testid="workspace-refresh"
                onClick={() => void a.run(refresh)}
                disabled={a.busy}
            >
                {tx("Refresh Workspace")}
            </button>
            {canManage && (
                <form
                    onSubmit={(e) => {
                        const v = values(e);
                        void a.run(async () => {
                            await api.renameWorkspace(id, v.name, signal);
                            await refresh();
                            a.setMessage("Workspace updated");
                        });
                    }}
                >
                    <label>
                        {tx("Name")}
                        <input
                            name="name"
                            data-testid="workspace-rename-name"
                            defaultValue={ws.name}
                            required
                            maxLength={160}
                        />
                    </label>
                    <button type="submit" data-testid="workspace-rename" disabled={a.busy}>
                        {tx("Rename Workspace")}
                    </button>
                </form>
            )}
            {ws.role === "OWNER" && !ws.archived && (
                <button
                    type="button"
                    data-testid="workspace-archive"
                    disabled={a.busy}
                    onClick={() =>
                        void a.run(async () => {
                            await api.archiveWorkspace(id, signal);
                            await refresh();
                        })
                    }
                >
                    {tx("Archive Workspace")}
                </button>
            )}
            {!canManage && (
                <p data-testid="workspace-permission">
                    {ws.archived
                        ? tx("Archived Workspaces are read-only.")
                        : tx("Your role cannot manage this Workspace or its members.")}
                </p>
            )}
            <h3>{tx("Members")}</h3>
            {members.isPending && <p role="status">{tx("Loading members…")}</p>}
            {members.error && (
                <>
                    <Notice error={message(members.error)} />
                    <button type="button" onClick={() => void members.refetch()}>
                        {tx("Retry members")}
                    </button>
                </>
            )}
            {members.isSuccess && !members.data.pages.some((page) => page.items.length) && (
                <p>{tx("No members found.")}</p>
            )}
            <ul data-testid="workspace-members">
                {members.data?.pages
                    .flatMap((page) => page.items)
                    .map((member) => (
                        <MemberRow
                            key={member.userId}
                            member={member}
                            workspace={ws}
                            manageable={!!canManage}
                            refresh={refresh}
                        />
                    ))}
            </ul>
            {members.hasNextPage && (
                <button
                    type="button"
                    data-testid="members-more"
                    disabled={members.isFetchingNextPage}
                    onClick={() => void members.fetchNextPage()}
                >
                    {tx("Load more members")}
                </button>
            )}
            {canManage && (
                <>
                    <h3>{tx("Invite a member")}</h3>
                    <p>
                        {tx(
                            "Links expire after seven days and can be used once. Existing accounts sign in with thei" +
                                "r own credentials.",
                        )}
                    </p>
                    <form
                        onSubmit={(e) => {
                            const v = values(e);
                            void a.run(async () => {
                                const result = await api.invite(
                                    id,
                                    {
                                        email: v.email,
                                        role: v.role as "ADMIN" | "EDITOR" | "EXECUTOR" | "VIEWER",
                                        sendEmail: v.sendEmail === "on",
                                    },
                                    signal,
                                );
                                setLink(result.invitationUrl);
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
                            <input
                                name="email"
                                type="email"
                                data-testid="invite-email"
                                required
                                maxLength={254}
                            />
                        </label>
                        <label>
                            {tx("Role")}
                            <select name="role" data-testid="invite-role" defaultValue="VIEWER">
                                {roles
                                    .filter((role) => role !== "OWNER")
                                    .map((role) => (
                                        <option key={role}>{role}</option>
                                    ))}
                            </select>
                        </label>
                        <label className="check">
                            <input
                                type="checkbox"
                                name="sendEmail"
                                data-testid="invite-email-send"
                            />
                            {tx("Send by configured SMTP")}
                        </label>
                        <button type="submit" data-testid="invite-create" disabled={a.busy}>
                            {tx("Create invitation")}
                        </button>
                    </form>
                    {link && (
                        <label>
                            {tx("Copy invitation link")}
                            <input
                                data-testid="invitation-url"
                                readOnly
                                value={link}
                                onFocus={(e) => e.currentTarget.select()}
                            />
                        </label>
                    )}
                    <h3>{tx("Invitations")}</h3>
                    {invites.isPending && <p role="status">{tx("Loading invitations…")}</p>}
                    {invites.error && (
                        <>
                            <Notice error={message(invites.error)} />
                            <button type="button" onClick={() => void invites.refetch()}>
                                {tx("Retry invitations")}
                            </button>
                        </>
                    )}
                    {invites.isSuccess && !invites.data.pages.some((page) => page.items.length) && (
                        <p>{tx("No invitations yet.")}</p>
                    )}
                    <ul>
                        {invites.data?.pages
                            .flatMap((page) => page.items)
                            .map((invite) => (
                                <li key={invite.id} data-testid={`invitation-${invite.email}`}>
                                    {invite.email} · {invite.role} · {invite.status}{" "}
                                    {tx(" · Expires")}{" "}
                                    {new Date(invite.expiresAt).toLocaleString(undefined, {
                                        timeZone: "Asia/Shanghai",
                                    })}{" "}
                                    (Asia/Shanghai, UTC+08:00)
                                    {invite.status === "PENDING" && (
                                        <button
                                            type="button"
                                            disabled={a.busy}
                                            onClick={() =>
                                                void a.run(async () => {
                                                    await api.revokeInvitation(
                                                        id,
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
                                </li>
                            ))}
                    </ul>
                    {invites.hasNextPage && (
                        <button
                            type="button"
                            data-testid="invitations-more"
                            disabled={invites.isFetchingNextPage}
                            onClick={() => void invites.fetchNextPage()}
                        >
                            {tx("Load more invitations")}
                        </button>
                    )}
                </>
            )}
            <Notice error={a.error} message={a.message} />
        </article>
    );
}

function MemberRow({
    member,
    workspace,
    manageable,
    refresh,
}: {
    member: Member;
    workspace: Workspace;
    manageable: boolean;
    refresh: () => Promise<void>;
}) {
    useAppLocale();
    const { signal } = useWorkspace(),
        a = useAction(),
        [role, setRole] = useState(member.role),
        [status, setStatus] = useState(member.status);
    useEffect(() => {
        setRole(member.role);
        setStatus(member.status);
    }, [member.role, member.status]);
    const editable = manageable && (member.role !== "OWNER" || workspace.role === "OWNER");
    return (
        <li data-testid={`member-${member.email}`}>
            <p>
                {member.displayName} · {member.email} · {member.role} · {member.status}
                {member.userDisabled ? tx(" · Account disabled") : ""}
            </p>
            {editable && (
                <>
                    <label>
                        {tx("Role")}
                        <select
                            data-testid="member-role"
                            value={role}
                            onChange={(e) => setRole(e.target.value as Member["role"])}
                        >
                            {roles
                                .filter((r) => r !== "OWNER" || workspace.role === "OWNER")
                                .map((r) => (
                                    <option key={r}>{r}</option>
                                ))}
                        </select>
                    </label>
                    <label>
                        {tx("Membership")}
                        <select
                            data-testid="member-status"
                            value={status}
                            onChange={(e) => setStatus(e.target.value as Member["status"])}
                        >
                            <option>ACTIVE</option>
                            <option>DISABLED</option>
                        </select>
                    </label>
                    <button
                        type="button"
                        disabled={a.busy}
                        onClick={() =>
                            void a.run(async () => {
                                await api.updateMember(
                                    workspace.id,
                                    member.userId,
                                    { role, status },
                                    signal,
                                );
                                await refresh();
                                a.setMessage("Member updated");
                            })
                        }
                    >
                        {tx("Save member")}
                    </button>
                    <button
                        type="button"
                        disabled={a.busy}
                        onClick={() =>
                            void a.run(async () => {
                                await api.removeMember(workspace.id, member.userId, signal);
                                await refresh();
                            })
                        }
                    >
                        {tx("Remove member")}
                    </button>
                </>
            )}
            <Notice error={a.error} message={a.message} />
        </li>
    );
}

/**
 * 独立路由页：提交邀请令牌调用 api.acceptInvitation，成功后刷新 Auth 并进入工作区。令牌无效时展示 ApiError。
 * 不依赖 WorkspaceProvider 的 selected；接受后用户才获得该空间成员资格。
 */
export function AcceptInvitation() {
    useAppLocale();
    const { user, refresh } = useContext(Auth),
        a = useAction();
    const [token] = useState(() => {
        const value = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
        window.history.replaceState(null, "", window.location.pathname);
        return value;
    });
    const [newAccount, setNewAccount] = useState(false),
        [accepted, setAccepted] = useState(false);
    return (
        <Panel title={tx("Accept Workspace invitation")}>
            {!token ? (
                <Notice error="Invitation link is missing its token. Ask for a new link." />
            ) : accepted ? (
                <p role="status">
                    {tx("Invitation accepted.")}{" "}
                    {user
                        ? tx("Open Workspaces to view your membership.")
                        : tx("Sign in with your account to open the Workspace.")}
                </p>
            ) : (
                <>
                    <p>
                        {tx(
                            "Existing accounts must sign in as the invited identity. Invitations never change an exi" +
                                "sting account password.",
                        )}
                    </p>
                    <label className="check">
                        <input
                            type="checkbox"
                            data-testid="invite-new-account"
                            checked={newAccount}
                            onChange={(e) => setNewAccount(e.target.checked)}
                        />
                        {tx("Create a new account")}
                    </label>
                    <form
                        onSubmit={(e) => {
                            const v = values(e);
                            void a.run(async () => {
                                if (!newAccount && !user) {
                                    await api.login({ email: v.email, password: v.password });
                                    await refresh();
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
                                setAccepted(true);
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
                                <Field
                                    name="email"
                                    label={tx("Invited account email")}
                                    type="email"
                                />
                                <Field
                                    name="password"
                                    label={tx("Current account password")}
                                    type="password"
                                />
                            </>
                        )}
                        <button type="submit" data-testid="invite-accept" disabled={a.busy}>
                            {tx("Accept invitation")}
                        </button>
                    </form>
                </>
            )}
            <Notice error={a.error} />
        </Panel>
    );
}
