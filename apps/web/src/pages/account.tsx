/**
 * 账户页展示当前帐号资料和会话摘要并支持确认后吊销其他会话；切换帐号时立即清空列表并取消未完成的请求。
 */

import { tx, useAppLocale } from "../locale";
import { useState, useContext, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { Navigate } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { api, ApiError, type AccountSessions } from "../api";
import { Avatar, Button } from "../components";
import { Auth } from "../auth-context";
import adminIcons from "../admin-icons.svg?no-inline";
import { Notice, Field, useAction, values } from "../ui";
import { collectTablePages, DataTable, useTableView } from "../table-view";
import { ConfirmDialog } from "../locale-ui";
import "./account-management.css";

type AccountSession = AccountSessions["items"][number];
const noSessions: AccountSessions["items"] = [];
const unknownSessionValue = "—";
const browserNames: Record<NonNullable<AccountSession["browser"]>, string> = {
    CHROME: "Chrome",
    CHROMIUM: "Chromium",
    EDGE: "Microsoft Edge",
    FIREFOX: "Firefox",
    SAFARI: "Safari",
    OPERA: "Opera",
    ELECTRON: "Electron",
    OTHER: "Other browser",
};
const systemNames: Record<NonNullable<AccountSession["operatingSystem"]>, string> = {
    WINDOWS: "Windows",
    MACOS: "macOS",
    LINUX: "Linux",
    IOS: "iOS",
    ANDROID: "Android",
    CHROMEOS: "ChromeOS",
    OTHER: "Other operating system",
};

/**
 * 设备名称仅来自服务端的粗粒度枚举，旧会话未记录的部分显示短横线，搜索和下载共用该展示值。
 */
function sessionDevice(session: AccountSession) {
    const browser = session.browser && tx(browserNames[session.browser]);
    const system = session.operatingSystem && tx(systemNames[session.operatingSystem]);
    return browser || system
        ? `${browser || unknownSessionValue} / ${system || unknownSessionValue}`
        : unknownSessionValue;
}

const sessionLabel = (session: AccountSession) => tx(session.current ? "This session" : "Other session");

/**
 * 会话详情与写入均由当前账号拥有。单条吊销只刷新列表，改密或吊销全部才重新探测当前认证身份。
 */
export function Account() {
    const { language } = useAppLocale();
    const { user, refresh } = useContext(Auth),
        a = useAction();
    const [sessions, setSessions] = useState<AccountSessions["items"] | null>(null);
    const [sessionReadFailed, setSessionReadFailed] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [revokeOpen, setRevokeOpen] = useState(false);
    const userId = user?.id;
    const owner = useRef<{ userId?: string; request: number; controller: AbortController }>();
    const formatTime = useMemo(
        () =>
            new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
                timeZone: "Asia/Shanghai",
                dateStyle: "short",
                timeStyle: "medium",
            }),
        [language],
    );
    const timeText = (value?: string) => (value ? formatTime.format(new Date(value)) : unknownSessionValue);
    const sessionTime = (value?: string) =>
        value ? <time dateTime={value}>{timeText(value)}</time> : unknownSessionValue;
    const sessionTable = useTableView(sessions ?? noSessions, {
        scope: userId,
        pageSize: 25,
        matches: (session, term) =>
            [
                sessionLabel(session),
                sessionDevice(session),
                timeText(session.lastActiveAt),
                timeText(session.createdAt),
                timeText(session.expiresAt),
            ].some((value) => value.toLowerCase().includes(term)),
    });
    const { run } = a;
    /**
     * 身份切换时在布局阶段终止旧帐号的分页请求并清空结果；本地筛选与每页数量变化不重复获取会话摘要。
     */
    useLayoutEffect(() => {
        const controller = new AbortController();
        owner.current = { userId, controller, request: 0 };
        setSessions(null);
        setSessionReadFailed(false);
        return () => controller.abort();
    }, [userId]);
    /**
     * 每次列表读取由当前帐号与读取代次拥有，无论收到数据或错误都核对归属，避免过期结果覆盖新会话表或它的重试提示。
     */
    const loadSessions = useCallback(async (): Promise<void> => {
        const active = owner.current;
        if (!userId || active?.userId !== userId || active.controller.signal.aborted) return;
        const request = ++active.request;
        const current = () => !active.controller.signal.aborted && active.request === request;
        setSessionReadFailed(false);
        try {
            const loaded = await collectTablePages(
                (cursor, signal) => api.sessions({ limit: 100, cursor }, signal),
                active.controller.signal,
            );
            if (current()) setSessions(loaded);
        } catch {
            if (current()) setSessionReadFailed(true);
        }
    }, [userId]);
    useEffect(() => {
        if (userId) void run(() => loadSessions());
    }, [userId, run, loadSessions]);

    /**
     * 只有服务端确认吊销或告知目标已不存在才移除该行。读取重试独立报告，以免把刷新失败误判为吊销失败。
     */
    function revokeSession(target: AccountSession, trigger: HTMLButtonElement | null) {
        const active = owner.current;
        if (!trigger || !active || active.userId !== userId || target.current || a.busy) return;
        const signal = active.controller.signal;
        if (signal.aborted) return;
        active.request++;
        const current = () => owner.current === active && !signal.aborted;
        const removeConfirmedRow = () => setSessions((rows) => rows?.filter(({ id }) => id !== target.id) ?? null);
        void a.submit(
            async (complete) => {
                try {
                    await api.revokeSession(target.id, signal);
                } catch (error) {
                    if (
                        current() &&
                        error instanceof ApiError &&
                        error.status === 404 &&
                        error.code === "SESSION_NOT_FOUND"
                    ) {
                        removeConfirmedRow();
                        await loadSessions();
                    }
                    throw error;
                }
                if (!current()) return;
                removeConfirmedRow();
                complete("Session revoked.");
                await loadSessions();
            },
            { waitingFrom: trigger, signal },
        );
    }

    if (!user) return <Navigate to="/login" />;
    return (
        <section className="vq-account">
            <h1 className="vq-visually-hidden" tabIndex={-1}>
                {tx("Profile")}
            </h1>
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
                            className="vq-password-form"
                            onSubmit={(e) => {
                                const v = values(e);
                                void a.submit(async () => {
                                    await api.password({
                                        currentPassword: v.currentPassword,
                                        newPassword: v.newPassword,
                                    });
                                    await refresh();
                                });
                            }}
                        >
                            <Field
                                name="currentPassword"
                                label={tx("Current password")}
                                type="password"
                                hint={tx("Current password guidance")}
                            />
                            <Field
                                name="newPassword"
                                label={tx("New password (at least 12 characters)")}
                                type="password"
                                minLength={12}
                                hint={tx("至少 12 个字符，建议混用字母、数字与符号。")}
                            />
                            <Button type="submit" size="regular" disabled={a.busy}>
                                {tx("Change password and sign out")}
                            </Button>
                        </form>
                    </section>
                )}
                <section className="vq-profile-card">
                    <h3>{tx("Active sessions")}</h3>
                    <DataTable
                        label={tx("Active sessions")}
                        view={sessionTable}
                        searchLabel={tx("Search sessions")}
                        pageSizeLabel={tx("Sessions per page")}
                        pageSizes={[1, 5, 10, 20, 25, 50, 100]}
                        paginationLabel={tx("Session table pagination")}
                        busy={a.busy || !sessions || sessionReadFailed}
                        exportColumns={[
                            { label: tx("Session"), value: sessionLabel },
                            { label: tx("Browser / System"), value: sessionDevice },
                            { label: tx("Recent activity"), value: (session) => timeText(session.lastActiveAt) },
                            { label: tx("Signed in"), value: (session) => timeText(session.createdAt) },
                            { label: tx("Expires"), value: (session) => timeText(session.expiresAt) },
                        ]}
                        actions={
                            <Button size="regular" tone="danger" disabled={a.busy} onClick={() => setRevokeOpen(true)}>
                                {tx("Revoke all sessions and sign out")}
                            </Button>
                        }
                    >
                        {sessionReadFailed && (
                            <div className="vq-account-session-read-error">
                                <Notice error="Sessions could not be loaded." />
                                <Button
                                    size="compact"
                                    tone="secondary"
                                    onClick={() => void a.run(loadSessions)}
                                    disabled={a.busy}
                                >
                                    {tx("Retry sessions")}
                                </Button>
                            </div>
                        )}
                        {!sessions && !sessionReadFailed && <p role="status">{tx("Loading sessions…")}</p>}
                        {sessions && (
                            <div className="table-scroll">
                                <table
                                    className="vq-user-table vq-account-sessions-table"
                                    aria-label={tx("Active sessions")}
                                >
                                    <thead>
                                        <tr>
                                            <th scope="col">{tx("Session")}</th>
                                            <th scope="col">{tx("Browser / System")}</th>
                                            <th scope="col">{tx("Recent activity")}</th>
                                            <th scope="col">{tx("Signed in")}</th>
                                            <th scope="col">{tx("Expires")}</th>
                                            <th scope="col">{tx("Actions")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {sessionTable.filteredCount === 0 && (
                                            <tr>
                                                <td colSpan={6} className="vq-table-empty">
                                                    {tx(
                                                        sessions.length
                                                            ? "No matching sessions."
                                                            : "No active sessions.",
                                                    )}
                                                </td>
                                            </tr>
                                        )}
                                        {sessionTable.rows.map((session) => (
                                            <tr key={session.id}>
                                                <td>{sessionLabel(session)}</td>
                                                <td>{sessionDevice(session)}</td>
                                                <td>{sessionTime(session.lastActiveAt)}</td>
                                                <td>{sessionTime(session.createdAt)}</td>
                                                <td>{sessionTime(session.expiresAt)}</td>
                                                <td className="vq-account-session-action">
                                                    {!session.current && (
                                                        <ConfirmDialog
                                                            title="Revoke session"
                                                            trigger="Revoke session"
                                                            triggerClassName="vq-danger vq-account-session-revoke"
                                                            confirmClassName="vq-danger"
                                                            confirmLabel={tx("Revoke session")}
                                                            disabled={a.busy || sessionReadFailed}
                                                            confirmAfterClose
                                                            onConfirm={(trigger) => revokeSession(session, trigger)}
                                                        >
                                                            <p>{tx("Revoke session hint")}</p>
                                                            <p>
                                                                {sessionDevice(session)} · {tx("Signed in")}{" "}
                                                                {sessionTime(session.createdAt)}
                                                            </p>
                                                        </ConfirmDialog>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </DataTable>
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
                                    <Dialog.Close asChild>
                                        <Button size="regular" tone="secondary">
                                            {tx("Cancel")}
                                        </Button>
                                    </Dialog.Close>
                                    <Button
                                        size="regular"
                                        tone="danger"
                                        disabled={a.busy}
                                        onClick={() =>
                                            void a.submit(async () => {
                                                await api.revokeOwn();
                                                setRevokeOpen(false);
                                                await refresh();
                                            })
                                        }
                                    >
                                        {tx("Revoke all sessions and sign out")}
                                    </Button>
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
