import { useState, useContext, useEffect } from "react";
import { Navigate } from "react-router-dom";
import { api, type AccountSessions } from "../api";
import { Auth } from "../auth-context";
import { Notice, Field, useAction, values, Panel } from "../ui";
export function Account() {
  const { user, refresh } = useContext(Auth),
    a = useAction();
  const [sessions, setSessions] = useState<AccountSessions | null>(null);
  const loadSessions = async () => setSessions(await api.sessions());
  useEffect(() => {
    if (user) void a.run(loadSessions);
  }, [user?.id]);
  if (!user) return <Navigate to="/login" />;
  const signedOut = async () => {
    await refresh();
  };
  return (
    <Panel title="Your account">
      <dl data-testid="account-info">
        <dt>Display name</dt>
        <dd>{user.displayName}</dd>
        <dt>Email</dt>
        <dd>{user.email}</dd>
        <dt>Permission</dt>
        <dd>{user.systemAdmin ? "System administrator" : "User"}</dd>
      </dl>
      <h2>Change password</h2>
      <form
        onSubmit={(e) => {
          const v = values(e);
          void a.run(async () => {
            await api.password({
              currentPassword: v.currentPassword,
              newPassword: v.newPassword,
            });
            await signedOut();
          });
        }}
      >
        <Field
          name="currentPassword"
          label="Current password"
          type="password"
        />
        <Field
          name="newPassword"
          label="New password (at least 12 characters)"
          type="password"
          minLength={12}
        />
        <button data-testid="change-password" disabled={a.busy}>
          Change password and sign out
        </button>
      </form>
      <h2>Active sessions</h2>
      {!sessions ? (
        a.error ? (
          <div>
            <p>Sessions could not be loaded.</p>
            <button onClick={() => void a.run(loadSessions)} disabled={a.busy}>
              Retry sessions
            </button>
          </div>
        ) : (
          <p role="status">Loading sessions…</p>
        )
      ) : sessions.items.length === 0 ? (
        <p>No active sessions.</p>
      ) : (
        <ul data-testid="sessions">
          {sessions.items.map((s) => (
            <li key={s.id}>
              {s.current ? "This session" : "Other session"} · Expires{" "}
              {new Date(s.expiresAt).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
      <button
        data-testid="revoke-own"
        disabled={a.busy}
        onClick={() =>
          void a.run(async () => {
            await api.revokeOwn();
            await signedOut();
          })
        }
      >
        Revoke all sessions and sign out
      </button>
      <Notice error={a.error} />
    </Panel>
  );
}
