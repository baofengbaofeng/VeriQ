/**
 * 顶栏和列表复用同一组通知摘要与操作，文案由受限事件类型产生，用户和模型文本只以普通节点显示。
 */
import { Button } from "../../components";
import { tx, useAppLocale } from "../../locale";
import { useInbox } from "./InboxProvider";
import type { InboxNotification, InboxPage } from "./model";

const titles = {
    WORKSPACE_INVITED: "Workspace invitation",
    AGENT_REPLY: "Agent reply",
    RUN_STARTED: "Plan run started",
    RUN_FINISHED: "Plan run finished",
} as const;

/**
 * 表格类型列和任意语言的消息详情以同一标题为准，动态业务名称保留用户创建时的原始文字。
 */
export function noticeTitle(row: InboxNotification) {
    return tx(titles[row.kind]);
}

/**
 * 通知时间按控制台时区显示，机器可读的 datetime 属性保留服务端事件的原始时间，避免浏览器时区改变结果。
 */
export function NoticeTime({ stamp }: { stamp: string }) {
    const { language } = useAppLocale();
    const label = new Intl.DateTimeFormat(language, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Shanghai",
    }).format(new Date(stamp));
    return (
        <time className="vq-notice-time" dateTime={stamp} title={label}>
            {label}
        </time>
    );
}

/**
 * 当前授权对象的名称和摘要按消息种类展示，邀请详情为独立的状态文字，Agent 摘要不会作为 HTML 解释。
 */
export function NoticeSummary({ row }: { row: InboxNotification }) {
    const { kind } = row;
    if (kind === "WORKSPACE_INVITED") {
        return (
            <div className="vq-notice-summary">
                <strong>{row.workspaceName}</strong>
                <span>
                    {tx("Invited by {{name}} as {{role}}", { name: row.actorName, role: tx(row.invitationRole) })}
                </span>
                <span>{tx(`Invitation notice state: ${row.invitationStatus}`)}</span>
            </div>
        );
    }
    if (kind === "AGENT_REPLY")
        return (
            <div className="vq-notice-summary">
                <strong>{row.sessionTitle}</strong>
                <span>{row.preview}</span>
            </div>
        );
    return (
        <div className="vq-notice-summary">
            <strong>{row.planName}</strong>
            <span>{row.workspaceName}</span>
            {row.outcome && <span>{tx(`Run outcome: ${row.outcome}`)}</span>}
        </div>
    );
}

/**
 * 构建各业务的独立操作区域，查看不会隐式接受邀请，已经过期或被吊销的邀请保持可读且没有接受入口。
 */
export function NoticeActions({
    row,
    details = false,
    beforeOpen,
}: {
    row: InboxNotification;
    details?: boolean;
    beforeOpen?: (movesFocus: boolean) => void;
}) {
    const { openItem, accept, busy } = useInbox();
    const viewLabel = row.kind === "RUN_STARTED" ? "View run" : row.kind === "RUN_FINISHED" ? "View report" : "View";
    return (
        <div className="vq-notice-actions">
            {!details && (
                <Button size="compact" tone="secondary" disabled={busy} onClick={() => void openItem(row, beforeOpen)}>
                    {tx(viewLabel)}
                </Button>
            )}
            {row.kind === "WORKSPACE_INVITED" && row.invitationStatus === "PENDING" && (
                <Button size="compact" disabled={busy} onClick={(event) => void accept(row, event.currentTarget)}>
                    {tx("Accept invitation")}
                </Button>
            )}
        </div>
    );
}

/**
 * 全部已读按钮读取两处共享的快照，有活动写入或未获得未读水位时保持禁用，避免跨页修改未经加载的数据。
 */
export function MarkInboxRead({ list, receivedAt = 0 }: { list?: InboxPage; receivedAt?: number }) {
    const { snapshot, snapshotTime, busy, markAll } = useInbox();
    const current = list && (!snapshot || receivedAt >= snapshotTime) ? list : snapshot;
    return (
        <Button
            size="compact"
            tone="secondary"
            disabled={busy || !current?.unreadCount}
            onClick={(event) => {
                if (current) void markAll(event.currentTarget, current);
            }}
        >
            {tx("Mark all as read")}
        </Button>
    );
}
