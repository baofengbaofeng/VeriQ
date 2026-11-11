import { useContext, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, ApiError, type Member, type Workspace } from "../../api";
import { Auth } from "../../auth-context";
import { Field, Notice, Panel, useAction, values } from "../../ui";
import { useWorkspace } from "./WorkspaceContext";

const roles = ["OWNER", "ADMIN", "EDITOR", "EXECUTOR", "VIEWER"] as const;
const message = (error: Error | null) =>
  error instanceof ApiError
    ? error.message
    : error
      ? "Unable to load Workspace data. Please retry."
      : "";

export function WorkspacePage() {
  const { user } = useContext(Auth),
    { selected, select, signal } = useWorkspace(),
    client = useQueryClient(),
    a = useAction();
  const workspaces = useInfiniteQuery({
    queryKey: ["workspaces", user?.id],
    queryFn: ({ pageParam, signal }) => api.workspaces(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !!user,
  });
  const items = workspaces.data?.pages.flatMap((page) => page.items) ?? [];
  useEffect(() => {
    if (!selected && items.length) select(items[0].id);
  }, [items[0]?.id, selected]);
  if (!user) return <Navigate to="/login" />;
  return (
    <Panel title="Workspaces">
      <p>
        One project is one Workspace. Membership controls access to its
        resources.
      </p>
      {workspaces.isPending && <p role="status">Loading Workspaces…</p>}
      {workspaces.error && (
        <>
          <Notice error={message(workspaces.error)} />
          <button onClick={() => void workspaces.refetch()}>
            Retry Workspaces
          </button>
        </>
      )}
      {workspaces.isSuccess && !items.length && <p>No Workspaces yet.</p>}
      {!!items.length && (
        <label>
          Current Workspace
          <select
            data-testid="workspace-selector"
            value={selected}
            onChange={(e) => select(e.target.value)}
          >
            <option value="" disabled>
              Select Workspace
            </option>
            {selected && !items.some((ws) => ws.id === selected) && (
              <option value={selected}>Selected Workspace</option>
            )}
            {items.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
                {ws.archived ? " (Archived)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {workspaces.hasNextPage && (
        <button
          data-testid="workspaces-more"
          disabled={workspaces.isFetchingNextPage}
          onClick={() => void workspaces.fetchNextPage()}
        >
          Load more Workspaces
        </button>
      )}
      <h2>Create Workspace</h2>
      <form
        onSubmit={(e) => {
          const v = values(e);
          const form = e.currentTarget;
          void a.run(async () => {
            const ws = await api.createWorkspace(
              { key: v.key, name: v.name },
              signal,
            );
            await client.invalidateQueries({
              queryKey: ["workspaces", user.id],
            });
            select(ws.id);
            form.reset();
          });
        }}
      >
        <label>
          Key
          <input
            data-testid="workspace-key"
            name="key"
            required
            pattern="[A-Za-z_][A-Za-z0-9_.-]*"
            maxLength={160}
          />
        </label>
        <label>
          Name
          <input
            data-testid="workspace-name"
            name="name"
            required
            maxLength={160}
          />
        </label>
        <button data-testid="workspace-create" disabled={a.busy}>
          Create Workspace
        </button>
      </form>
      <Notice error={a.error} />
      {selected && (
        <WorkspaceDetail
          key={user.id + selected}
          id={selected}
          identity={user.id}
        />
      )}
    </Panel>
  );
}

function WorkspaceDetail({ id, identity }: { id: string; identity: string }) {
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
    detail.data &&
    ["OWNER", "ADMIN"].includes(detail.data.role) &&
    !detail.data.archived;
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
  if (detail.isPending) return <p role="status">Loading Workspace…</p>;
  if (detail.error)
    return (
      <>
        <Notice error={message(detail.error)} />
        <button onClick={() => void detail.refetch()}>Retry Workspace</button>
      </>
    );
  const ws = detail.data;
  return (
    <article data-testid="workspace-detail">
      <h2>{ws.name}</h2>
      <p>
        {ws.key} · {ws.role} · {ws.archived ? "Archived" : "Active"}
      </p>
      <button
        data-testid="workspace-refresh"
        onClick={() => void a.run(refresh)}
        disabled={a.busy}
      >
        Refresh Workspace
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
            Name
            <input
              name="name"
              data-testid="workspace-rename-name"
              defaultValue={ws.name}
              required
              maxLength={160}
            />
          </label>
          <button data-testid="workspace-rename" disabled={a.busy}>
            Rename Workspace
          </button>
        </form>
      )}
      {ws.role === "OWNER" && !ws.archived && (
        <button
          data-testid="workspace-archive"
          disabled={a.busy}
          onClick={() =>
            void a.run(async () => {
              await api.archiveWorkspace(id, signal);
              await refresh();
            })
          }
        >
          Archive Workspace
        </button>
      )}
      {!canManage && (
        <p data-testid="workspace-permission">
          {ws.archived
            ? "Archived Workspaces are read-only."
            : "Your role cannot manage this Workspace or its members."}
        </p>
      )}
      <h3>Members</h3>
      {members.isPending && <p role="status">Loading members…</p>}
      {members.error && (
        <>
          <Notice error={message(members.error)} />
          <button onClick={() => void members.refetch()}>Retry members</button>
        </>
      )}
      {members.isSuccess &&
        !members.data.pages.some((page) => page.items.length) && (
          <p>No members found.</p>
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
          data-testid="members-more"
          disabled={members.isFetchingNextPage}
          onClick={() => void members.fetchNextPage()}
        >
          Load more members
        </button>
      )}
      {canManage && (
        <>
          <h3>Invite a member</h3>
          <p>
            Links expire after seven days and can be used once. Existing
            accounts sign in with their own credentials.
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
              Email
              <input
                name="email"
                type="email"
                data-testid="invite-email"
                required
                maxLength={254}
              />
            </label>
            <label>
              Role
              <select
                name="role"
                data-testid="invite-role"
                defaultValue="VIEWER"
              >
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
              Send by configured SMTP
            </label>
            <button data-testid="invite-create" disabled={a.busy}>
              Create invitation
            </button>
          </form>
          {link && (
            <label>
              Copy invitation link
              <input
                data-testid="invitation-url"
                readOnly
                value={link}
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
          )}
          <h3>Invitations</h3>
          {invites.isPending && <p role="status">Loading invitations…</p>}
          {invites.error && (
            <>
              <Notice error={message(invites.error)} />
              <button onClick={() => void invites.refetch()}>
                Retry invitations
              </button>
            </>
          )}
          {invites.isSuccess &&
            !invites.data.pages.some((page) => page.items.length) && (
              <p>No invitations yet.</p>
            )}
          <ul>
            {invites.data?.pages
              .flatMap((page) => page.items)
              .map((invite) => (
                <li key={invite.id} data-testid={`invitation-${invite.email}`}>
                  {invite.email} · {invite.role} · {invite.status} · Expires{" "}
                  {new Date(invite.expiresAt).toLocaleString(undefined, {
                    timeZone: "Asia/Shanghai",
                  })}{" "}
                  (Asia/Shanghai, UTC+08:00)
                  {invite.status === "PENDING" && (
                    <button
                      disabled={a.busy}
                      onClick={() =>
                        void a.run(async () => {
                          await api.revokeInvitation(id, invite.id, signal);
                          await refresh();
                          a.setMessage("Invitation revoked");
                        })
                      }
                    >
                      Revoke invitation
                    </button>
                  )}
                </li>
              ))}
          </ul>
          {invites.hasNextPage && (
            <button
              data-testid="invitations-more"
              disabled={invites.isFetchingNextPage}
              onClick={() => void invites.fetchNextPage()}
            >
              Load more invitations
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
  const { signal } = useWorkspace(),
    a = useAction(),
    [role, setRole] = useState(member.role),
    [status, setStatus] = useState(member.status);
  useEffect(() => {
    setRole(member.role);
    setStatus(member.status);
  }, [member.role, member.status]);
  const editable =
    manageable && (member.role !== "OWNER" || workspace.role === "OWNER");
  return (
    <li data-testid={`member-${member.email}`}>
      <p>
        {member.displayName} · {member.email} · {member.role} · {member.status}
        {member.userDisabled ? " · Account disabled" : ""}
      </p>
      {editable && (
        <>
          <label>
            Role
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
            Membership
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
            Save member
          </button>
          <button
            disabled={a.busy}
            onClick={() =>
              void a.run(async () => {
                await api.removeMember(workspace.id, member.userId, signal);
                await refresh();
              })
            }
          >
            Remove member
          </button>
        </>
      )}
      <Notice error={a.error} message={a.message} />
    </li>
  );
}

export function AcceptInvitation() {
  const { user, refresh } = useContext(Auth),
    a = useAction();
  const [token] = useState(() => {
    const value =
      new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    window.history.replaceState(null, "", window.location.pathname);
    return value;
  });
  const [newAccount, setNewAccount] = useState(false),
    [accepted, setAccepted] = useState(false);
  return (
    <Panel title="Accept Workspace invitation">
      {!token ? (
        <Notice error="Invitation link is missing its token. Ask for a new link." />
      ) : accepted ? (
        <p role="status">
          Invitation accepted.{" "}
          {user
            ? "Open Workspaces to view your membership."
            : "Sign in with your account to open the Workspace."}
        </p>
      ) : (
        <>
          <p>
            Existing accounts must sign in as the invited identity. Invitations
            never change an existing account password.
          </p>
          <label className="check">
            <input
              type="checkbox"
              data-testid="invite-new-account"
              checked={newAccount}
              onChange={(e) => setNewAccount(e.target.checked)}
            />
            Create a new account
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
                <Field name="displayName" label="Display name" />
                <Field
                  name="password"
                  label="New password (at least 12 characters)"
                  type="password"
                  minLength={12}
                />
              </>
            ) : user ? (
              <p>
                Accept as {user.email}. Sign out first to use another account.
              </p>
            ) : (
              <>
                <Field
                  name="email"
                  label="Invited account email"
                  type="email"
                />
                <Field
                  name="password"
                  label="Current account password"
                  type="password"
                />
              </>
            )}
            <button data-testid="invite-accept" disabled={a.busy}>
              Accept invitation
            </button>
          </form>
        </>
      )}
      <Notice error={a.error} />
    </Panel>
  );
}
