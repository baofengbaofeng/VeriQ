/**
 * 账户页：展示资料、改密、分页列出本账户会话，并可吊销全部其他会话。不展示其他用户的会话；界面逻辑保证绝不渲染其他用户
 * 的会话行。
 * 调用 api.account/sessions/password/revokeOwn；未登录重定向 /login。
 */

import { tx, useAppLocale } from "../locale";
import { useState, useContext, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { Navigate } from "react-router-dom";
import { api, type AccountSessions } from "../api";
import { Auth } from "../auth-context";
import { Notice, Field, useAction, values, Panel } from "../ui";
/**
 * 以当前 user.id 和所选每页数量拥有会话列表及游标，首次加载与重试替换首屏、More 仅追加当前游标的一页，并在改密或撤销后
 * 通过身份刷新进入重新登录流程。
 * 不涉及 Workspace 资源；会话吊销后通过 refresh 同步 Auth。
 */
export function Account() {
    useAppLocale();
    const { user, refresh } = useContext(Auth),
        a = useAction();
    const [sessions, setSessions] = useState<AccountSessions | null>(null);
    const [limit, setLimit] = useState(25);
    const userId = user?.id;
    const key = JSON.stringify([userId, limit]);
    const owner = useRef({ key, request: 0, mounted: false });
    const { run } = a;
    /**
     * 身份和页大小共同拥有当前列表，布局阶段先失效旧请求并清空分页，避免新身份短暂展示旧行；此处只阻止过期结果发布，不
     * 会取消已经发往后端的 HTTP 请求。
     */
    useLayoutEffect(() => {
        owner.current = { key, request: owner.current.request + 1, mounted: true };
        setSessions(null);
        return () => {
            owner.current.mounted = false;
            owner.current.request += 1;
        };
    }, [key]);
    /**
     * 未传游标时替换会话首屏，More 只追加当前游标对应的一页；调用开始与完成都核对身份和页大小，较早请求的错误也不会进
     * 入新列表的动作反馈区域或改变新游标。
     */
    const loadSessions = useCallback(
        async (cursor?: string): Promise<void> => {
            if (!userId || !owner.current.mounted || owner.current.key !== key) return;
            const request = ++owner.current.request;
            const current = () =>
                owner.current.mounted && owner.current.key === key && owner.current.request === request;
            try {
                const page = await api.sessions({ limit, cursor });
                if (!current()) return;
                setSessions((previous) =>
                    cursor && previous
                        ? { items: [...previous.items, ...page.items], nextCursor: page.nextCursor }
                        : page,
                );
            } catch (error) {
                if (current()) throw error;
            }
        },
        [key, limit, userId],
    );
    useEffect(() => {
        if (userId) void run(() => loadSessions());
    }, [userId, run, loadSessions]);
    if (!user) return <Navigate to="/login" />;
    const signedOut = async () => {
        await refresh();
    };
    return (
        <Panel title={tx("Your account")}>
            <dl>
                <dt>{tx("Display name")}</dt>
                <dd>{user.displayName}</dd>
                <dt>{tx("Email")}</dt>
                <dd>{user.email}</dd>
                <dt>{tx("Permission")}</dt>
                <dd>{user.systemAdmin ? tx("System administrator") : tx("User")}</dd>
            </dl>
            <h2>{tx("Change password")}</h2>
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
                <Field name="currentPassword" label={tx("Current password")} type="password" />
                <Field
                    name="newPassword"
                    label={tx("New password (at least 12 characters)")}
                    type="password"
                    minLength={12}
                    longHint={tx("至少 12 个字符，建议混用字母、数字与符号。")}
                />
                <button type="submit" disabled={a.busy}>
                    {tx("Change password and sign out")}
                </button>
            </form>
            <h2>{tx("Active sessions")}</h2>
            <label>
                {tx("Sessions per page")}
                <select value={limit} disabled={a.busy} onChange={(e) => setLimit(Number(e.target.value))}>
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
                        <p>{tx("Sessions could not be loaded.")}</p>
                        <button type="button" onClick={() => void a.run(() => loadSessions())} disabled={a.busy}>
                            {tx("Retry sessions")}
                        </button>
                    </div>
                ) : (
                    <p role="status">{tx("Loading sessions…")}</p>
                )
            ) : sessions.items.length === 0 ? (
                <p>{tx("No active sessions.")}</p>
            ) : (
                <ul>
                    {sessions.items.map((s) => (
                        <li key={s.id}>
                            {s.current ? tx("This session") : tx("Other session")} {tx(" · Expires")}{" "}
                            {new Date(s.expiresAt).toLocaleString()}
                        </li>
                    ))}
                </ul>
            )}
            {sessions?.nextCursor && (
                <button
                    type="button"
                    disabled={a.busy}
                    onClick={() => void a.run(() => loadSessions(sessions.nextCursor!))}
                >
                    {a.busy ? tx("Loading sessions…") : tx("Load more sessions")}
                </button>
            )}
            <button
                type="button"
                disabled={a.busy}
                onClick={() =>
                    void a.run(async () => {
                        await api.revokeOwn();
                        await signedOut();
                    })
                }
            >
                {tx("Revoke all sessions and sign out")}
            </button>
            <Notice error={a.error} />
        </Panel>
    );
}
