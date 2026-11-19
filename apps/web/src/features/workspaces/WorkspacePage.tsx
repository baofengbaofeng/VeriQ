/**
 * Workspace 管理页：创建/重命名/归档空间，以及成员角色、邀请与接受邀请流程。归档后成员列表仍可只读查看；归档完成后成员
 * 与邀请列表仍可只读浏览。
 * 列表走 api.workspaces；成员与邀请均嵌套在选定 workspaceId 下。
 */

import { tx, useAppLocale } from "../../locale";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Member, type Workspace } from "../../api";
import { Auth } from "../../auth-context";
import { Field, Notice, Panel, useAction, values } from "../../ui";
import { useWorkspaceDirectory, WorkspaceStatus } from "./WorkspaceDirectory";
import { useWorkspace } from "./WorkspaceContext";
import { SampleWorkspaceWizard } from "../examples/SampleWorkspaceWizard";

const roles = ["OWNER", "ADMIN", "EDITOR", "EXECUTOR", "VIEWER"] as const;
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
        <Panel
            title={tx("Workspaces")}
            action={
                <button
                    type="button"
                    ref={sampleTrigger}
                    aria-expanded={sampleOpen}
                    aria-controls="sample-workspace-panel"
                    onClick={() => setSampleOpen((open) => !open)}
                >
                    {tx("Import sample workspace")}
                </button>
            }
        >
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
    const canManage = detail.data && ["OWNER", "ADMIN"].includes(detail.data.role) && !detail.data.archived;
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
        await client.invalidateQueries({ queryKey: ["directory-entry", identity, id] });
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
        <article>
            <h2>{ws.name}</h2>
            <p>
                {ws.key} · {ws.role} · {ws.archived ? tx("Archived") : tx("Active")}
            </p>
            <button type="button" onClick={() => void a.run(refresh)} disabled={a.busy}>
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
                        <input name="name" defaultValue={ws.name} required maxLength={160} />
                    </label>
                    <button type="submit" disabled={a.busy}>
                        {tx("Rename Workspace")}
                    </button>
                </form>
            )}
            {ws.role === "OWNER" && !ws.archived && (
                <button
                    type="button"
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
                <p>
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
            <ul>
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
                            <input name="email" type="email" required maxLength={254} />
                        </label>
                        <label>
                            {tx("Role")}
                            <select name="role" defaultValue="VIEWER">
                                {roles
                                    .filter((role) => role !== "OWNER")
                                    .map((role) => (
                                        <option key={role}>{role}</option>
                                    ))}
                            </select>
                        </label>
                        <label className="check">
                            <input type="checkbox" name="sendEmail" />
                            {tx("Send by configured SMTP")}
                        </label>
                        <button type="submit" disabled={a.busy}>
                            {tx("Create invitation")}
                        </button>
                    </form>
                    {link && (
                        <label>
                            {tx("Copy invitation link")}
                            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
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
                                <li key={invite.id}>
                                    {invite.email} · {invite.role} · {invite.status} {tx(" · Expires")}{" "}
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
                                                    await api.revokeInvitation(id, invite.id, signal);
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
        <li>
            <p>
                {member.displayName} · {member.email} · {member.role} · {member.status}
                {member.userDisabled ? tx(" · Account disabled") : ""}
            </p>
            {editable && (
                <>
                    <label>
                        {tx("Role")}
                        <select value={role} onChange={(e) => setRole(e.target.value as Member["role"])}>
                            {roles
                                .filter((r) => r !== "OWNER" || workspace.role === "OWNER")
                                .map((r) => (
                                    <option key={r}>{r}</option>
                                ))}
                        </select>
                    </label>
                    <label>
                        {tx("Membership")}
                        <select value={status} onChange={(e) => setStatus(e.target.value as Member["status"])}>
                            <option>ACTIVE</option>
                            <option>DISABLED</option>
                        </select>
                    </label>
                    <button
                        type="button"
                        disabled={a.busy}
                        onClick={() =>
                            void a.run(async () => {
                                await api.updateMember(workspace.id, member.userId, { role, status }, signal);
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
                        <Link to="/workspaces">{tx("Open workspace settings to view your membership.")}</Link>
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
