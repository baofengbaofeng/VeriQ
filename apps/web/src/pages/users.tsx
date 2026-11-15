/**
 * 系统管理员用户管理页：创建用户、过滤列表、签发重置链接并吊销目标用户会话。普通成员打开会看到权限受限提示；非 systemAdmin 访问时只渲染权限受限面板。
 * 非 systemAdmin 显示受限面板；数据全部来自 /admin/users*。
 */

import { useState, useContext, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { Navigate } from "react-router-dom";
import { api, type User, type ResetLink, type UserListQuery } from "../api";
import { Auth } from "../auth-context";
import { Notice, Field, useAction, values, Panel } from "../ui";
/**
 * 管理当前管理员可见的用户列表、已提交筛选、分页游标和短暂重置链接，各写入仍通过 useAction 处理反馈，创建或更新后的重新加载继续使用已提交的同一组查询条件。
 * 重置链接仅短暂展示在本页，刷新后需重新签发。
 */
export function AdminUsers() {
    const { user, refresh } = useContext(Auth),
        a = useAction();
    const [users, setUsers] = useState<User[] | null>(null),
        [link, setLink] = useState<ResetLink | null>(null);
    const [filters, setFilters] = useState<UserListQuery>({ limit: 25 });
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const userId = user?.id;
    const isAdmin = user?.systemAdmin ?? false;
    const key = JSON.stringify([userId, isAdmin, filters]);
    const owner = useRef({ key, request: 0, mounted: false });
    const { run } = a;
    /** 当前用户、管理员能力与已提交筛选共同拥有列表和游标，输入框草稿不参与此边界；切换边界先清空首屏，旧响应和旧操作持有的加载函数均不能覆盖当前查询结果。 */
    useLayoutEffect(() => {
        owner.current = { key, request: owner.current.request + 1, mounted: true };
        setUsers(null);
        setNextCursor(null);
        return () => {
            owner.current.mounted = false;
            owner.current.request += 1;
        };
    }, [key]);
    /** 加载始终读取本次提交的筛选快照并仅请求一页，首屏、Retry 和写入后刷新都会替换结果；旧管理员或旧查询持有的回调与错误不得越过当前身份及筛选边界。 */
    const load = useCallback(
        async (cursor?: string): Promise<void> => {
            if (!userId || !isAdmin || !owner.current.mounted || owner.current.key !== key) return;
            const request = ++owner.current.request;
            const current = () =>
                owner.current.mounted &&
                owner.current.key === key &&
                owner.current.request === request;
            try {
                const page = await api.users({ ...filters, cursor });
                if (!current()) return;
                setUsers((previous) =>
                    cursor && previous ? [...previous, ...page.items] : page.items,
                );
                setNextCursor(page.nextCursor);
            } catch (error) {
                if (current()) throw error;
            }
        },
        [filters, isAdmin, key, userId],
    );
    useEffect(() => {
        if (userId && isAdmin) void run(() => load());
    }, [userId, isAdmin, run, load]);
    if (!user) return <Navigate to="/login" />;
    if (!user.systemAdmin)
        return (
            <Panel title="Access restricted">
                <p role="alert">System administrator permission is required.</p>
            </Panel>
        );
    return (
        <Panel title="Users">
            <p>Create accounts, manage access and issue one-time password reset links.</p>
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
                <button type="submit" data-testid="create-user" disabled={a.busy}>
                    {a.busy ? "Working…" : "Create user"}
                </button>
            </form>
            <Notice error={a.error} message={a.message} />
            {link && (
                <aside data-testid="reset-link">
                    <h2>One-time reset link</h2>
                    <p>
                        Expires {new Date(link.expiresAt).toLocaleString()}. Share privately with
                        this user.
                    </p>
                    <input
                        aria-label="Reset link"
                        data-testid="reset-url"
                        readOnly
                        value={link.url}
                    />
                    <button
                        type="button"
                        onClick={() =>
                            void a.run(async () => {
                                await navigator.clipboard.writeText(link.url);
                                a.setMessage("Link copied.");
                            })
                        }
                    >
                        Copy link
                    </button>
                    <button type="button" onClick={() => setLink(null)}>
                        Dismiss
                    </button>
                </aside>
            )}
            <h2>All users</h2>
            <form
                data-testid="users-filters"
                onSubmit={(event) => {
                    const input = values(event);
                    setFilters({
                        q: input.q,
                        disabled: input.disabled === "" ? undefined : input.disabled === "true",
                        systemAdmin:
                            input.systemAdmin === "" ? undefined : input.systemAdmin === "true",
                        limit: Number(input.limit),
                    });
                }}
            >
                <label>
                    Search email or display name
                    <input name="q" data-testid="users-search" type="search" maxLength={254} />
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
                <button type="submit" data-testid="users-filter-submit" disabled={a.busy}>
                    Apply filters
                </button>
            </form>
            {users === null ? (
                a.error ? (
                    <div>
                        <p>Users could not be loaded.</p>
                        <button
                            type="button"
                            onClick={() => void a.run(() => load())}
                            disabled={a.busy}
                        >
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
                                            type="button"
                                            disabled={a.busy}
                                            onClick={() =>
                                                void a.run(async () => {
                                                    await api.updateUser(u.id, {
                                                        disabled: !u.disabled,
                                                    });
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
                                            type="button"
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
                                            type="button"
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
                                            type="button"
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
                    type="button"
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
