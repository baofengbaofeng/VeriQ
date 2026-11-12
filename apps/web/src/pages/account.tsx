/**
 * 账户页：展示资料、改密、分页列出本账户会话，并可吊销全部其他会话。不展示其他用户的会话；界面逻辑保证绝不渲染其他用户的会话行。
 * 调用 api.account/sessions/password/revokeOwn；未登录重定向 /login。
 */

import { useState, useContext, useEffect } from "react";
import { Navigate } from "react-router-dom";
import { api, type AccountSessions } from "../api";
import { Auth } from "../auth-context";
import { Notice, Field, useAction, values, Panel } from "../ui";
/**
 * 拥有 sessions 列表与 limit 状态；loadSessions 支持 cursor 追加，改密成功后可要求重新登录。
 * 不涉及 Workspace 资源；会话吊销后通过 refresh 同步 Auth。
 */
export function Account() {
    const { user, refresh } = useContext(Auth),
        a = useAction();
    const [sessions, setSessions] = useState<AccountSessions | null>(null);
    const [limit, setLimit] = useState(25);
    const loadSessions = async (cursor?: string) => {
        const page = await api.sessions({ limit, cursor });
        setSessions((previous) =>
            cursor && previous
                ? {
                      items: [...previous.items, ...page.items],
                      nextCursor: page.nextCursor,
                  }
                : page,
        );
    };
    useEffect(() => {
        if (user) void a.run(() => loadSessions());
    }, [user?.id, limit]);
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
                <Field name="currentPassword" label="Current password" type="password" />
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
            <label>
                Sessions per page
                <select
                    data-testid="sessions-limit"
                    value={limit}
                    disabled={a.busy}
                    onChange={(e) => setLimit(Number(e.target.value))}
                >
                    {[1, 10, 25, 50, 100].map((value) => (
                        <option key={value} value={value}>
                            {value}
                        </option>
                    ))}
                </select>
            </label>
            {!sessions ? (
                a.error ? (
                    <div>
                        <p>Sessions could not be loaded.</p>
                        <button onClick={() => void a.run(() => loadSessions())} disabled={a.busy}>
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
            {sessions?.nextCursor && (
                <button
                    data-testid="sessions-more"
                    disabled={a.busy}
                    onClick={() => void a.run(() => loadSessions(sessions.nextCursor!))}
                >
                    {a.busy ? "Loading sessions…" : "Load more sessions"}
                </button>
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
