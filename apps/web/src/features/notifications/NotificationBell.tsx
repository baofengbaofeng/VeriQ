/**
 * TailAdmin 顶栏通知结构使用原有可访问对话框与按钮，内容区独立滚动，每条查看和快捷操作分别接收焦点。
 */
import { useId, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Link, useMatch } from "react-router-dom";
import icons from "../../admin-icons.svg?no-inline";
import { Button } from "../../components";
import { tx, useAppLocale } from "../../locale";
import { useInbox } from "./InboxProvider";
import { MarkInboxRead, NoticeActions, NoticeSummary, NoticeTime, noticeTitle } from "./NoticeContent";
import "./notifications.css";

/**
 * 打开时读取收件箱而不写入已读，关闭恢复焦点；点击后续业务入口时将焦点交给新的路由或 Agent 抽屉。
 */
export function NotificationBell() {
    useAppLocale();
    const { snapshot, loading, error, retry, busy, openItem, bellOpen, setBellOpen } = useInbox();
    const onNotificationsPage = useMatch("/notifications") !== null;
    const unreadDescription = useId();
    const departing = useRef(false);
    function beforeOpen(movesFocus: boolean) {
        departing.current = movesFocus;
        setBellOpen(false);
    }
    return (
        <div className="vq-notification-anchor">
            {!!snapshot?.unreadCount && (
                <span id={unreadDescription} className="vq-visually-hidden" role="status">
                    {tx("Unread notifications: {{count}}", { count: snapshot.unreadCount })}
                </span>
            )}
            <Dialog.Root
                modal={false}
                open={bellOpen}
                onOpenChange={(value) => {
                    setBellOpen(value);
                    if (value) retry();
                }}
            >
                <Dialog.Trigger asChild>
                    <button
                        type="button"
                        className="vq-icon-button"
                        aria-label={tx("Notifications")}
                        aria-describedby={snapshot?.unreadCount ? unreadDescription : undefined}
                    >
                        <svg className="vq-nav-icon" aria-hidden="true" width="16" height="16">
                            <use href={`${icons}#bell`} />
                        </svg>
                        {!!snapshot?.unreadCount && <span className="vq-notification-dot" aria-hidden="true" />}
                    </button>
                </Dialog.Trigger>
                <Dialog.Content
                    className="vq-notification-menu"
                    aria-describedby={undefined}
                    onInteractOutside={(event) => {
                        const target = event.detail.originalEvent.target;
                        if (target instanceof Element && target.closest(".vq-operation-result")) {
                            // 共享结果弹窗暂取焦点，关闭后归还给通知的原操作，列表依据服务端最新回执重新读取。
                            event.preventDefault();
                        }
                    }}
                    onCloseAutoFocus={(event) => {
                        if (departing.current) event.preventDefault();
                        departing.current = false;
                    }}
                >
                    <div className="vq-notification-heading">
                        <Dialog.Title>{tx("Notifications")}</Dialog.Title>
                        <MarkInboxRead />
                        <Dialog.Close className="vq-sheet-close" aria-label={tx("Close")}>
                            ×
                        </Dialog.Close>
                    </div>
                    <div className="vq-notification-scroll">
                        {error && (
                            <div className="vq-notification-empty">
                                <p role="alert">{tx("Unable to load notifications.")}</p>
                                <Button size="compact" tone="secondary" onClick={retry}>
                                    {tx("Retry")}
                                </Button>
                            </div>
                        )}
                        {loading && (
                            <p className="vq-notification-empty" role="status">
                                {tx("Loading VeriQ…")}
                            </p>
                        )}
                        {!error && snapshot?.items.length === 0 && (
                            <p className="vq-notification-empty">{tx("No notifications yet.")}</p>
                        )}
                        {snapshot && snapshot.items.length > 0 && (
                            <ul className="vq-notification-list">
                                {snapshot.items.map((row) => (
                                    <li key={row.id} className="vq-notification-row" data-unread={!row.readAt}>
                                        <div className="vq-notification-meta">
                                            <button
                                                type="button"
                                                className="vq-notification-row-title"
                                                disabled={busy}
                                                onClick={() => void openItem(row, beforeOpen)}
                                            >
                                                {noticeTitle(row)}
                                            </button>
                                            <NoticeTime stamp={row.occurredAt} />
                                        </div>
                                        <NoticeSummary row={row} />
                                        <NoticeActions row={row} beforeOpen={beforeOpen} />
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <Link
                        className="vq-btn vq-btn-secondary vq-notification-view-all"
                        to="/notifications"
                        onClick={() => beforeOpen(!onNotificationsPage)}
                    >
                        {tx("View all notifications")}
                    </Link>
                </Dialog.Content>
            </Dialog.Root>
        </div>
    );
}
