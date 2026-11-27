/**
 * 个人收件箱列表保持服务端分页，详情与列表分别核验当前授权；筛选切换不影响顶栏的统一未读数与读取水位。
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { ApiError } from "../../api";
import { Button, Select, SelectItem } from "../../components";
import { tx, useAppLocale } from "../../locale";
import { DataTable } from "../../table-view";
import { Panel } from "../../ui";
import { inboxKey, useInbox } from "./InboxProvider";
import { inboxRefreshInterval } from "./model";
import { MarkInboxRead, NoticeActions, NoticeSummary, NoticeTime, noticeTitle } from "./NoticeContent";
import { notificationApi } from "./transport";

const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 独立详情通过通知 ID 向服务端确认访问，只有取得最新快照时才展示正文；链接未包含接受邀请所需的私有材料。
 */
function NotificationDetail({ id }: { id: string }) {
    const { owner, signal, opensDetail, liveUpdates, error, accessGeneration } = useInbox();
    const title = useRef<HTMLHeadingElement>(null);
    const details = useQuery({
        queryKey: [...inboxKey(owner), "detail", id, accessGeneration],
        queryFn: ({ signal: request }) =>
            notificationApi.detail(id, signal ? AbortSignal.any([request, signal]) : request),
        enabled: !!owner && !!signal && identifier.test(id),
        refetchOnMount: "always",
        refetchInterval: ({ state }) =>
            inboxRefreshInterval(
                liveUpdates,
                signal,
                state.status === "success" && state.data ? [state.data] : undefined,
                state.error instanceof ApiError ? state.error.status : undefined,
            ),
    });
    const unavailable = !identifier.test(id) || details.isError || (!signal && error);
    const authorized = !!signal && !signal.aborted && details.isSuccess && details.isFetchedAfterMount;
    useEffect(() => {
        if (authorized) title.current?.focus();
    }, [authorized]);
    return (
        <section className="vq-notification-detail" aria-label={tx("Notification details")}>
            <h2 ref={title} tabIndex={-1}>
                {tx("Notification details")}
            </h2>
            {unavailable && <p role="alert">{tx("This notification or its target is no longer available.")}</p>}
            {!unavailable && !authorized && <p role="status">{tx("Loading VeriQ…")}</p>}
            {authorized && (
                <>
                    <NoticeTime stamp={details.data.occurredAt} />
                    <NoticeSummary row={details.data} />
                    <NoticeActions row={details.data} details={opensDetail(details.data)} />
                </>
            )}
            <Link to="/notifications">{tx("Back to notifications")}</Link>
        </section>
    );
}

/**
 * 列表页在原应用壳下显示，根据当前账户与筛选参数独立缓存游标页，未读集合更新时仍只显示服务端当前页。
 */
export function NotificationsPage() {
    useAppLocale();
    const { owner, signal, openItem, busy, liveUpdates, error, retry, accessGeneration } = useInbox();
    const [params] = useSearchParams();
    const [filter, setFilter] = useState("all");
    const [pageSize, setPageSize] = useState(10);
    const [selectedPage, setSelectedPage] = useState(1);
    const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
    const cursor = cursors[selectedPage - 1];
    const list = useQuery({
        queryKey: [...inboxKey(owner), "page", filter, pageSize, cursor, accessGeneration],
        queryFn: ({ signal: request }) =>
            notificationApi.list(
                pageSize,
                filter === "unread",
                signal ? AbortSignal.any([request, signal]) : request,
                cursor,
            ),
        enabled: !!owner && !!signal,
        refetchOnMount: "always",
        refetchInterval: ({ state }) =>
            inboxRefreshInterval(
                liveUpdates,
                signal,
                state.status === "success" ? state.data?.items : undefined,
                state.error instanceof ApiError ? state.error.status : undefined,
            ),
    });
    if (!owner) return <Navigate replace to="/login" />;
    const id = params.get("notificationId");
    const unavailable = list.isError || (!signal && error);
    const current = signal && !signal.aborted && !unavailable && list.isFetchedAfterMount ? list.data : undefined;
    const rows = current?.items ?? [];
    const nextCursor = current?.nextCursor;
    const hasMore = !!nextCursor && !cursors.slice(0, selectedPage).includes(nextCursor);
    const pageCount = hasMore && nextCursor === cursors[selectedPage] ? cursors.length : selectedPage;
    const label = tx("Notifications");

    // 每次只重读正在展示的游标页。返回已访问的页后使用服务端最新的后继游标，避免在后台重复拉取历史页。
    function setPage(number: number) {
        if (number === selectedPage + 1 && hasMore && number > pageCount) {
            setCursors([...cursors.slice(0, selectedPage), nextCursor]);
            setSelectedPage(number);
        } else if (number > 0 && number <= pageCount) {
            setSelectedPage(number);
        }
    }

    return (
        <Panel title="Notifications" action={<MarkInboxRead list={current} receivedAt={list.dataUpdatedAt} />}>
            {id && <NotificationDetail key={id} id={id} />}
            <DataTable
                label={label}
                view={{
                    page: selectedPage,
                    pageCount,
                    rows,
                    pageSize,
                    setPage,
                    search: "",
                    setSearch: () => undefined,
                    setPageSize: (size) => {
                        setPageSize(size);
                        setCursors([undefined]);
                        setSelectedPage(1);
                    },
                }}
                hasMore={hasMore}
                busy={list.isPending || unavailable}
                actions={
                    <Select
                        value={filter}
                        aria-label={tx("Filter notifications")}
                        onValueChange={(value) => {
                            setFilter(value);
                            setCursors([undefined]);
                            setSelectedPage(1);
                        }}
                    >
                        <SelectItem value="all">{tx("All notifications")}</SelectItem>
                        <SelectItem value="unread">{tx("Unread notifications")}</SelectItem>
                    </Select>
                }
            >
                {unavailable && (
                    <div className="vq-notification-empty">
                        <p role="alert">{tx("Unable to load notifications.")}</p>
                        <Button
                            size="compact"
                            tone="secondary"
                            onClick={() => (signal ? void list.refetch() : retry())}
                        >
                            {tx("Retry")}
                        </Button>
                    </div>
                )}
                <div className="vq-notification-table">
                    <table className="vq-user-table" aria-label={label}>
                        <thead>
                            <tr>
                                <th scope="col">{tx("Notification type")}</th>
                                <th scope="col">{tx("Message")}</th>
                                <th scope="col">{tx("Time")}</th>
                                <th scope="col">{tx("Status")}</th>
                                <th scope="col">{tx("Actions")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => (
                                <tr key={row.id}>
                                    <td>
                                        <button
                                            type="button"
                                            className="vq-notification-row-title"
                                            disabled={busy}
                                            onClick={() => void openItem(row)}
                                        >
                                            {noticeTitle(row)}
                                        </button>
                                    </td>
                                    <td>
                                        <NoticeSummary row={row} />
                                    </td>
                                    <td>
                                        <NoticeTime stamp={row.occurredAt} />
                                    </td>
                                    <td>{tx(row.readAt ? "Read" : "Unread")}</td>
                                    <td>
                                        <NoticeActions row={row} />
                                    </td>
                                </tr>
                            ))}
                            {!unavailable && !rows.length && (
                                <tr>
                                    <td colSpan={5} className="vq-notification-empty" role="status">
                                        {tx(list.isPending ? "Loading VeriQ…" : "No notifications yet.")}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </DataTable>
        </Panel>
    );
}
