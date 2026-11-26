/**
 * 用户管理页由当前系统管理员身份拥有，列表保存已提交筛选和服务端游标，写入仅在服务端确认后显示操作结果。
 * 一次性重置链接留在当前页面的组件状态，退出、失去管理员权限或关闭后不再保留。
 */

import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { api, ApiError, type ResetLink, type User, type UserListQuery } from "../api";
import { Auth } from "../auth-context";
import { Button, Field, Input, Sheet } from "../components";
import { ChoiceFilter } from "../features/workspaces/ChoiceFilter";
import { tx, useAppLocale } from "../locale";
import { DataTable } from "../table-view";
import { Notice, Panel, useAction, values } from "../ui";
import "./account-management.css";

const firstUserPage = { number: 1, cursors: [undefined] as (string | undefined)[] };
const userPageSizes = [1, 5, 10, 20, 25, 50, 100];
type ListFailure = { message: string; number: number; cursor?: string };

/**
 * 导出和账户访问徽标使用相同的本地化状态，避免把内部标识或会话操作凭证写入用户目录文件。
 */
function userAccess(user: User) {
    if (user.disabled) return tx("Disabled");
    return tx(user.systemAdmin ? "System administrator" : "User");
}

/**
 * 权限守卫位于列表和抽屉之外，切换身份时卸载写入回执与保存在内存中的一次性链接，同时结束列表请求。
 */
export function AdminUsers() {
    useAppLocale();
    const { user, refresh } = useContext(Auth);
    if (!user) return <Navigate to="/login" />;
    if (!user.systemAdmin)
        return (
            <Panel title={tx("Access restricted")}>
                <p role="alert">{tx("System administrator permission is required.")}</p>
            </Panel>
        );
    return <UserDirectory key={user.id} userId={user.id} refresh={refresh} />;
}

/**
 * 仅在拥有管理权限的身份下挂载目录。输入草稿、已提交筛选、查询状态和业务回执各自保留所属的状态。
 */
function UserDirectory({ userId, refresh }: { userId: string; refresh: () => Promise<void> }) {
    const action = useAction();
    const { language } = useAppLocale();
    const [users, setUsers] = useState<User[] | null>(null);
    const [listing, setListing] = useState(true);
    const [failure, setFailure] = useState<ListFailure>();
    const [link, setLink] = useState<ResetLink>();
    const [createOpen, setCreateOpen] = useState(false);
    const [filters, setFilters] = useState<UserListQuery>({ limit: 25 });
    const [query, setQuery] = useState("");
    const [disabled, setDisabled] = useState("");
    const [systemAdmin, setSystemAdmin] = useState("");
    const hasFilters = !!filters.q?.trim() || filters.disabled !== undefined || filters.systemAdmin !== undefined;
    const [pagination, setPagination] = useState(firstUserPage);
    const createTrigger = useRef<HTMLButtonElement>(null);
    const resetTrigger = useRef<HTMLButtonElement | null>(null);
    const createSheetActive = useRef(false);
    const createReceipt = useRef<() => boolean>();
    const key = JSON.stringify(filters);
    const owner = useRef({ key, request: 0, controller: new AbortController() });
    const locked = listing || action.busy;

    /**
     * 搜索和筛选的草稿不启动请求，提交后才替换查询归属。旧查询或写入后的旧刷新不能清空新查询的页码和数据。
     */
    useLayoutEffect(() => {
        const controller = new AbortController();
        owner.current = { key, request: 0, controller };
        setUsers(null);
        setListing(true);
        setFailure(undefined);
        setPagination(firstUserPage);
        return () => controller.abort();
    }, [key]);

    /**
     * 按服务端签发的游标读取对应页，并仅保留与返回游标一致的下一页。失败留在列表区域，并重试同一页。
     */
    const load = useCallback(
        async (number = 1, cursor?: string): Promise<void> => {
            const active = owner.current;
            const signal = active.controller.signal;
            if (signal.aborted || active.key !== key) return;
            const request = ++active.request;
            const current = () => !signal.aborted && active.request === request;
            setListing(true);
            setFailure(undefined);
            try {
                const page = await api.users({ ...filters, cursor }, signal);
                if (!current()) return;
                setUsers(page.items);
                setPagination((previous) => {
                    const next = page.nextCursor ?? undefined;
                    if (next === previous.cursors[number]) return { ...previous, number };
                    const cursors = previous.cursors.slice(0, number);
                    if (next) cursors.push(next);
                    return { number, cursors };
                });
            } catch (error) {
                if (current())
                    setFailure({
                        message: error instanceof ApiError ? error.message : "Unable to reach VeriQ. Please try again.",
                        number,
                        cursor,
                    });
            } finally {
                if (current()) setListing(false);
            }
        },
        [filters, key],
    );
    useEffect(() => {
        void load();
    }, [load]);

    /**
     * 修改自己会影响当前身份，按既有认证入口回读。回读前保持可退出，已失去作用域的操作不会补发迟到回执。
     */
    function update(
        target: User,
        changes: { disabled?: boolean; systemAdmin?: boolean },
        message: string,
        trigger: HTMLButtonElement,
    ) {
        const request = owner.current;
        void action.submit(
            async (complete) => {
                await api.updateUser(target.id, changes);
                if (target.id === userId) {
                    try {
                        await refresh();
                    } finally {
                        complete(message);
                    }
                } else if (!request.controller.signal.aborted) {
                    complete(message);
                    await load();
                }
            },
            target.id === userId ? undefined : { waitingFrom: trigger, signal: request.controller.signal },
        );
    }

    /**
     * 联网返回的链接只在当前目录存活时交付到就地复制区，操作结果只携带已签发的摘要，且不能写回旧筛选范围。
     */
    function issueResetLink(targetId: string, trigger: HTMLButtonElement) {
        const request = owner.current;
        void action.submit(
            async (complete) => {
                const issued = await api.resetLink(targetId);
                if (!request.controller.signal.aborted && complete("Reset link generated.")) {
                    resetTrigger.current = trigger;
                    setLink(issued);
                }
            },
            { waitingFrom: trigger, signal: request.controller.signal },
        );
    }

    function createUser(event: FormEvent<HTMLFormElement>) {
        const input = values(event);
        void action.submit(async (complete) => {
            await api.createUser({
                email: input.email,
                displayName: input.displayName,
                password: input.password,
                systemAdmin: input.systemAdmin === "on",
            });
            // 先将焦点还给创建入口，再打开共享结果框；手动提前关闭时直接按当时的焦点发布结果。
            if (createSheetActive.current) {
                createReceipt.current = () => complete("User created.");
                setCreateOpen(false);
            } else complete("User created.");
            await load();
        });
    }

    /**
     * 仅提交搜索和筛选草稿中的新条件；更改每页数量时保留已提交条件，由原查询归属机制重读第一页。
     */
    function applyFilters(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!locked)
            setFilters({
                q: query,
                disabled: disabled === "" ? undefined : disabled === "true",
                systemAdmin: systemAdmin === "" ? undefined : systemAdmin === "true",
                limit: filters.limit,
            });
    }

    const pageSize = filters.limit ?? 25;
    const hasMore = pagination.number < pagination.cursors.length;

    return (
        <Panel
            title={tx("Users")}
            action={
                <Button
                    ref={createTrigger}
                    className="vq-admin-user-create-trigger"
                    size="regular"
                    aria-disabled={locked}
                    onClick={() => {
                        if (locked) return;
                        createSheetActive.current = true;
                        setCreateOpen(true);
                    }}
                >
                    {tx("Create user")}
                </Button>
            }
        >
            <Sheet
                open={createOpen}
                onOpenChange={setCreateOpen}
                title={tx("Create user")}
                description={tx("Create accounts, manage access and issue one-time password reset links.")}
                size="third"
                resizable
                fallbackFocus={createTrigger}
                onAfterClose={() => {
                    createSheetActive.current = false;
                    const publish = createReceipt.current;
                    createReceipt.current = undefined;
                    publish?.();
                }}
            >
                <CreateUserForm busy={action.busy} onSubmit={createUser} onCancel={() => setCreateOpen(false)} />
            </Sheet>
            <Notice error={action.error} />
            {link && (
                <aside className="vq-admin-reset-link" aria-labelledby="vq-admin-reset-title">
                    <h2 id="vq-admin-reset-title">{tx("One-time reset link")}</h2>
                    <p>
                        {tx("Expires ")}
                        {new Date(link.expiresAt).toLocaleString(language === "zh" ? "zh-CN" : "en", {
                            timeZone: "Asia/Shanghai",
                        })}
                        {tx(". Share privately with this user.")}
                    </p>
                    <div className="vq-admin-user-actions">
                        <Input aria-label={tx("Reset link")} readOnly value={link.url} />
                        <Button
                            size="compact"
                            tone="secondary"
                            disabled={locked}
                            onClick={() =>
                                void action.submit(async (complete) => {
                                    await navigator.clipboard.writeText(link.url);
                                    complete("Link copied.");
                                })
                            }
                        >
                            {tx("Copy link")}
                        </Button>
                        <Button
                            size="compact"
                            tone="ghost"
                            onClick={() => {
                                setLink(undefined);
                                const trigger = resetTrigger.current;
                                if (trigger?.isConnected && !trigger.disabled) trigger.focus();
                                else createTrigger.current?.focus();
                                resetTrigger.current = null;
                            }}
                        >
                            {tx("Dismiss")}
                        </Button>
                    </div>
                </aside>
            )}
            <form aria-label={tx("User list filters")} className="vq-admin-user-list" onSubmit={applyFilters}>
                <DataTable
                    label={tx("All users")}
                    searchLabel={tx("Search email or display name")}
                    searchMaxLength={254}
                    pageSizeLabel={tx("Users per page")}
                    pageSizes={userPageSizes}
                    paginationLabel={tx("User table pagination")}
                    busy={locked || !!failure}
                    view={{
                        rows: users ?? [],
                        search: query,
                        setSearch: setQuery,
                        pageSize,
                        setPageSize: (limit) => {
                            if (!locked && limit !== pageSize) setFilters({ ...filters, limit });
                        },
                        page: pagination.number,
                        pageCount: pagination.cursors.length,
                        filteredCount:
                            users && !hasMore ? (pagination.number - 1) * pageSize + users.length : undefined,
                        setPage: (page) => {
                            if (page !== pagination.number) void load(page, pagination.cursors[page - 1]);
                        },
                    }}
                    exportColumns={[
                        { label: tx("Display name"), value: (user) => user.displayName },
                        { label: tx("Email"), value: (user) => user.email },
                        { label: tx("Access"), value: userAccess },
                    ]}
                    filters={
                        <div className="vq-admin-user-filters">
                            <ChoiceFilter
                                label={tx("Account status")}
                                value={disabled}
                                onChange={setDisabled}
                                choices={[
                                    ["", tx("All statuses")],
                                    ["false", tx("Enabled")],
                                    ["true", tx("Disabled")],
                                ]}
                            />
                            <ChoiceFilter
                                label={tx("Permission")}
                                value={systemAdmin}
                                onChange={setSystemAdmin}
                                choices={[
                                    ["", tx("All users")],
                                    ["true", tx("System administrators")],
                                    ["false", tx("Users without system administration")],
                                ]}
                            />
                            <Button type="submit" size="compact" tone="secondary" disabled={locked}>
                                {tx("Apply filters")}
                            </Button>
                        </div>
                    }
                >
                    {failure && (
                        <div className="vq-admin-user-query-error">
                            <Notice error={`${tx("Users could not be loaded.")} ${tx(failure.message)}`} />
                            <Button
                                size="compact"
                                tone="secondary"
                                onClick={() => void load(failure.number, failure.cursor)}
                                disabled={listing}
                            >
                                {tx("Retry users")}
                            </Button>
                        </div>
                    )}
                    {users === null && !failure && <p role="status">{tx("Loading users…")}</p>}
                    {users && (
                        <div className="table-scroll">
                            <table className="vq-user-table vq-admin-user-table">
                                <caption className="vq-visually-hidden">{tx("All users")}</caption>
                                <thead>
                                    <tr>
                                        <th scope="col">{tx("User")}</th>
                                        <th scope="col">{tx("Access")}</th>
                                        <th scope="col">{tx("Actions")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {users.length === 0 && (
                                        <tr>
                                            <td className="vq-table-empty" colSpan={3}>
                                                {tx(hasFilters ? "No matching users." : "No users found.")}
                                            </td>
                                        </tr>
                                    )}
                                    {users.map((target) => (
                                        <tr key={target.id}>
                                            <td>
                                                {target.displayName} <small>{target.email}</small>
                                            </td>
                                            <td>
                                                <span
                                                    className="vq-state vq-workspace-state"
                                                    data-tone={target.disabled ? "neutral" : "success"}
                                                >
                                                    {userAccess(target)}
                                                </span>
                                            </td>
                                            <td>
                                                <div className="vq-admin-user-actions">
                                                    <Button
                                                        size="compact"
                                                        tone={target.disabled ? "secondary" : "danger"}
                                                        disabled={locked}
                                                        onClick={(event) =>
                                                            update(
                                                                target,
                                                                { disabled: !target.disabled },
                                                                target.disabled ? "User enabled." : "User disabled.",
                                                                event.currentTarget,
                                                            )
                                                        }
                                                    >
                                                        {target.disabled ? tx("Enable") : tx("Disable")}
                                                    </Button>
                                                    <Button
                                                        size="compact"
                                                        tone="secondary"
                                                        disabled={locked || target.disabled}
                                                        onClick={(event) =>
                                                            issueResetLink(target.id, event.currentTarget)
                                                        }
                                                    >
                                                        {tx("Reset link")}
                                                    </Button>
                                                    <Button
                                                        size="compact"
                                                        tone="danger"
                                                        disabled={locked}
                                                        onClick={(event) =>
                                                            void action.submit(
                                                                async (complete) => {
                                                                    await api.revokeUser(target.id);
                                                                    complete("Sessions revoked.");
                                                                    if (target.id === userId) await refresh();
                                                                },
                                                                target.id === userId
                                                                    ? undefined
                                                                    : { waitingFrom: event.currentTarget },
                                                            )
                                                        }
                                                    >
                                                        {tx("Revoke sessions")}
                                                    </Button>
                                                    <Button
                                                        size="compact"
                                                        tone={target.systemAdmin ? "danger" : "secondary"}
                                                        disabled={locked}
                                                        onClick={(event) =>
                                                            update(
                                                                target,
                                                                { systemAdmin: !target.systemAdmin },
                                                                target.systemAdmin
                                                                    ? "System administrator permission removed."
                                                                    : "System administrator permission granted.",
                                                                event.currentTarget,
                                                            )
                                                        }
                                                    >
                                                        {target.systemAdmin ? tx("Remove admin") : tx("Make admin")}
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </DataTable>
            </form>
        </Panel>
    );
}

/**
 * 抽屉字段在一次编辑期间由浏览器持有，服务端拒绝时保留输入，成功关闭后销毁；密码明确标为新账号密码。
 */
function CreateUserForm({
    busy,
    onSubmit,
    onCancel,
}: {
    busy: boolean;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
    onCancel: () => void;
}) {
    return (
        <form className="vq-admin-user-create" onSubmit={onSubmit}>
            <Field htmlFor="new-user-email" label={tx("Email")} hint={tx("Email used to sign in")} required>
                <Input id="new-user-email" name="email" type="email" autoComplete="off" maxLength={254} required />
            </Field>
            <Field htmlFor="new-user-name" label={tx("Display name")} hint={tx("Name shown to other members")} required>
                <Input id="new-user-name" name="displayName" autoComplete="off" maxLength={160} required />
            </Field>
            <Field
                htmlFor="new-user-password"
                label={tx("Initial password (at least 12 characters)")}
                hint={tx("Initial password guidance")}
                required
            >
                <Input
                    id="new-user-password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={1024}
                    required
                />
            </Field>
            <div className="vq-admin-user-check">
                <label className="check">
                    <input type="checkbox" name="systemAdmin" aria-describedby="new-user-admin-help" />
                    {tx("System administrator")}
                </label>
                <p id="new-user-admin-help" className="vq-field-hint">
                    {tx("System administrator guidance")}
                </p>
            </div>
            <div className="vq-admin-user-actions">
                <Button size="regular" tone="secondary" onClick={onCancel}>
                    {tx("Cancel")}
                </Button>
                <Button type="submit" size="regular" disabled={busy}>
                    {busy ? tx("Working…") : tx("Create user")}
                </Button>
            </div>
        </form>
    );
}
