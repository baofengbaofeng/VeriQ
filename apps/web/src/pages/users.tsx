import { useState, useContext, useEffect } from "react";
import { Navigate } from "react-router-dom";
import { api, type User, type ResetLink, type UserListQuery } from "../api";
import { Auth } from "../auth-context";
import { Notice, Field, useAction, values, Panel } from "../ui";
export function AdminUsers() {
  const { user, refresh } = useContext(Auth),
    a = useAction();
  const [users, setUsers] = useState<User[] | null>(null),
    [link, setLink] = useState<ResetLink | null>(null);
  const [filters, setFilters] = useState<UserListQuery>({ limit: 25 });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const load = async (cursor?: string) => {
    const page = await api.users({ ...filters, cursor });
    setUsers((previous) =>
      cursor && previous ? [...previous, ...page.items] : page.items,
    );
    setNextCursor(page.nextCursor);
  };
  useEffect(() => {
    if (user?.systemAdmin) void a.run(() => load());
  }, [user?.systemAdmin, filters]);
  if (!user) return <Navigate to="/login" />;
  if (!user.systemAdmin)
    return (
      <Panel title="Access restricted">
        <p role="alert">System administrator permission is required.</p>
      </Panel>
    );
  return (
    <Panel title="Users">
      <p>
        Create accounts, manage access and issue one-time password reset links.
      </p>
      <h2>Create user</h2>
      <form
        onSubmit={(e) => {
          const form = e.currentTarget,
            v = values(e);
          void a.run(async () => {
            await api.createUser({
              email: v.email,
              displayName: v.displayName,
              password: v.password,
              systemAdmin: v.systemAdmin === "on",
            });
            form.reset();
            await load();
            a.setMessage("User created.");
          });
        }}
      >
        <Field name="email" label="Email" type="email" />
        <Field name="displayName" label="Display name" />
        <Field
          name="password"
          label="Initial password (at least 12 characters)"
          type="password"
          minLength={12}
        />
        <label className="check">
          <input type="checkbox" name="systemAdmin" data-testid="systemAdmin" />
          System administrator
        </label>
        <button data-testid="create-user" disabled={a.busy}>
          {a.busy ? "Working…" : "Create user"}
        </button>
      </form>
      <Notice error={a.error} message={a.message} />
      {link && (
        <aside data-testid="reset-link">
          <h2>One-time reset link</h2>
          <p>
            Expires {new Date(link.expiresAt).toLocaleString()}. Share privately
            with this user.
          </p>
          <input
            aria-label="Reset link"
            data-testid="reset-url"
            readOnly
            value={link.url}
          />
          <button
            onClick={() =>
              void a.run(async () => {
                await navigator.clipboard.writeText(link.url);
                a.setMessage("Link copied.");
              })
            }
          >
            Copy link
          </button>
          <button onClick={() => setLink(null)}>Dismiss</button>
        </aside>
      )}
      <h2>All users</h2>
      <form
        data-testid="users-filters"
        onSubmit={(event) => {
          const input = values(event);
          setFilters({
            q: input.q,
            disabled:
              input.disabled === "" ? undefined : input.disabled === "true",
            systemAdmin:
              input.systemAdmin === ""
                ? undefined
                : input.systemAdmin === "true",
            limit: Number(input.limit),
          });
        }}
      >
        <label>
          Search email or display name
          <input
            name="q"
            data-testid="users-search"
            type="search"
            maxLength={254}
          />
        </label>
        <label>
          Account status
          <select name="disabled" data-testid="users-disabled">
            <option value="">All statuses</option>
            <option value="false">Enabled</option>
            <option value="true">Disabled</option>
          </select>
        </label>
        <label>
          Permission
          <select name="systemAdmin" data-testid="users-admin">
            <option value="">All users</option>
            <option value="true">System administrators</option>
            <option value="false">Users without system administration</option>
          </select>
        </label>
        <label>
          Users per page
          <select name="limit" defaultValue="25" data-testid="users-limit">
            {[1, 10, 25, 50, 100].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button data-testid="users-filter-submit" disabled={a.busy}>
          Apply filters
        </button>
      </form>
      {users === null ? (
        a.error ? (
          <div>
            <p>Users could not be loaded.</p>
            <button onClick={() => void a.run(() => load())} disabled={a.busy}>
              Retry users
            </button>
          </div>
        ) : (
          <p role="status">Loading users…</p>
        )
      ) : users.length === 0 ? (
        <p>No users found.</p>
      ) : (
        <div className="table-scroll">
          <table data-testid="users">
            <thead>
              <tr>
                <th>User</th>
                <th>Access</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} data-testid={`user-${u.email}`}>
                  <td>
                    {u.displayName}
                    <small>{u.email}</small>
                  </td>
                  <td>
                    {u.disabled
                      ? "Disabled"
                      : u.systemAdmin
                        ? "System administrator"
                        : "User"}
                  </td>
                  <td>
                    <button
                      disabled={a.busy}
                      onClick={() =>
                        void a.run(async () => {
                          await api.updateUser(u.id, { disabled: !u.disabled });
                          if (u.id === user.id) {
                            await refresh();
                            return;
                          }
                          await load();
                        })
                      }
                    >
                      {u.disabled ? "Enable" : "Disable"}
                    </button>
                    <button
                      disabled={a.busy || u.disabled}
                      onClick={() =>
                        void a.run(async () => {
                          setLink(await api.resetLink(u.id));
                        })
                      }
                    >
                      Reset link
                    </button>
                    <button
                      disabled={a.busy}
                      onClick={() =>
                        void a.run(async () => {
                          await api.revokeUser(u.id);
                          if (u.id === user.id) await refresh();
                          a.setMessage("Sessions revoked.");
                        })
                      }
                    >
                      Revoke sessions
                    </button>
                    <button
                      disabled={a.busy}
                      onClick={() =>
                        void a.run(async () => {
                          await api.updateUser(u.id, {
                            systemAdmin: !u.systemAdmin,
                          });
                          if (u.id === user.id) {
                            await refresh();
                            return;
                          }
                          await load();
                        })
                      }
                    >
                      {u.systemAdmin ? "Remove admin" : "Make admin"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor && (
        <button
          data-testid="users-more"
          disabled={a.busy}
          onClick={() => void a.run(() => load(nextCursor))}
        >
          {a.busy ? "Loading users…" : "Load more users"}
        </button>
      )}
    </Panel>
  );
}
