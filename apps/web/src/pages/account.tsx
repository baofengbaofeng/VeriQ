/**
 * 账户页：展示资料、改密、分页列出本账户会话，并可吊销全部其他会话。不展示其他用户的会话；界面逻辑保证绝不渲染其他用户
 * 的会话行。
 * 调用 api.account/sessions/password/revokeOwn；未登录重定向 /login。
 */

import { tx, useAppLocale } from "../locale";
import { useState, useContext, useEffect, useLayoutEffect, useCallback, useRef, Fragment } from "react";
import { Link, Navigate } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { api, type AccountSessions } from "../api";
import { Avatar } from "../components";
import { Auth } from "../auth-context";
import adminIcons from "../admin-icons.svg?no-inline";
import { Notice, Field, useAction, values } from "../ui";
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
    const passwordForm = useRef<HTMLFormElement>(null);
    const [limit, setLimit] = useState(25);
    const [showPassword, setShowPassword] = useState(false);
    const [revokeOpen, setRevokeOpen] = useState(false);
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
        <section className="vq-account">
            <div className="vq-profile-heading">
                <h1 tabIndex={-1}>{tx("Profile")}</h1>
                <nav aria-label={tx("Breadcrumb")}>
                    <Link to="/">{tx("Home")}</Link>
                    <span aria-hidden="true">›</span>
                    <span aria-current="page">{tx("Profile")}</span>
                </nav>
            </div>
            <div className="vq-profile">
                <section className="vq-profile-card vq-profile-summary">
                    <Avatar name={user.displayName} size={80} fontSize={16} />
                    <div className="vq-profile-meta">
                        <h3>{user.displayName}</h3>
                        <p>{user.systemAdmin ? tx("System administrator") : tx("User")}</p>
                    </div>
                    <button
                        type="button"
                        className="vq-profile-edit"
                        aria-expanded={showPassword}
                        onClick={() => setShowPassword(!showPassword)}
                    >
                        <svg aria-hidden="true" width="18" height="18">
                            <use href={`${adminIcons}#edit`} />
                        </svg>
                        {tx("Change password")}
                    </button>
                </section>
                <section className="vq-profile-card">
                    <h3>{tx("Personal information")}</h3>
                    <dl>
                        <div>
                            <dt>{tx("Display name")}</dt>
                            <dd>{user.displayName}</dd>
                        </div>
                        <div>
                            <dt>{tx("Email")}</dt>
                            <dd>{user.email}</dd>
                        </div>
                        <div>
                            <dt>{tx("Permission")}</dt>
                            <dd>{user.systemAdmin ? tx("System administrator") : tx("User")}</dd>
                        </div>
                    </dl>
                </section>
                {showPassword && (
                    <section className="vq-profile-card">
                        <h3>{tx("Change password")}</h3>
                        <form
                            ref={passwordForm}
                            className="vq-password-form"
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
                    </section>
                )}
                <section className="vq-profile-card">
                    <div className="vq-sessions-head">
                        <h3>{tx("Active sessions")}</h3>
                        <div className="vq-session-limit">
                            <span>{tx("Sessions per page")}:</span>
                            {[1, 10, 25, 50, 100].map((value, index) => (
                                <Fragment key={value}>
                                    {index > 0 && <span className="vq-session-limit-sep">/</span>}
                                    <button
                                        type="button"
                                        className="vq-session-limit-option"
                                        aria-pressed={limit === value}
                                        disabled={a.busy}
                                        onClick={() => setLimit(value)}
                                    >
                                        {value}
                                    </button>
                                </Fragment>
                            ))}
                        </div>
                    </div>
                    {!sessions ? (
                        a.error ? (
                            <div>
                                <p>{tx("Sessions could not be loaded.")}</p>
                                <button
                                    type="button"
                                    onClick={() => void a.run(() => loadSessions())}
                                    disabled={a.busy}
                                >
                                    {tx("Retry sessions")}
                                </button>
                            </div>
                        ) : (
                            <p role="status">{tx("Loading sessions…")}</p>
                        )
                    ) : sessions.items.length === 0 ? (
                        <p>{tx("No active sessions.")}</p>
                    ) : (
                        <div className="table-scroll">
                            <table className="vq-user-table">
                                <thead>
                                    <tr>
                                        <th>{tx("Session")}</th>
                                        <th>{tx("Created")}</th>
                                        <th>{tx("Expires")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {sessions.items.map((s) => (
                                        <tr key={s.id}>
                                            <td>{s.current ? tx("This session") : tx("Other session")}</td>
                                            <td>{new Date(s.createdAt).toLocaleString()}</td>
                                            <td>{new Date(s.expiresAt).toLocaleString()}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <div className="vq-sessions-actions">
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
                            className="vq-btn-danger"
                            disabled={a.busy}
                            onClick={() => setRevokeOpen(true)}
                        >
                            {tx("Revoke all sessions and sign out")}
                        </button>
                    </div>
                    <Dialog.Root open={revokeOpen} onOpenChange={setRevokeOpen}>
                        <Dialog.Portal>
                            <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                            <Dialog.Content className="vq-dialog vq-workspace-dialog">
                                <div className="vq-card-heading">
                                    <Dialog.Title>{tx("Revoke all sessions and sign out")}</Dialog.Title>
                                    <Dialog.Close className="vq-sheet-close" aria-label={tx("Close")}>
                                        ×
                                    </Dialog.Close>
                                </div>
                                <Dialog.Description className="vq-workspace-key-hint">
                                    {tx("Revoke all sessions hint")}
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
                                                await api.revokeOwn();
                                                setRevokeOpen(false);
                                                await signedOut();
                                            })
                                        }
                                    >
                                        {tx("Revoke all sessions and sign out")}
                                    </button>
                                </div>
                            </Dialog.Content>
                        </Dialog.Portal>
                    </Dialog.Root>
                </section>
                <Notice error={a.error} />
            </div>
        </section>
    );
}
