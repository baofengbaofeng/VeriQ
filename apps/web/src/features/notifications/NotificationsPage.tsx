/**
 * 个人收件箱列表保持服务端分页，详情与列表分别核验当前授权；筛选切换不影响顶栏的统一未读数与读取水位。
 */
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { Button, Select, SelectItem } from "../../components";
import { tx, useAppLocale } from "../../locale";
import { DataTable } from "../../table-view";
import { Panel } from "../../ui";
import { inboxKey, useInbox } from "./InboxProvider";
import { invitationRefreshInterval } from "./model";
import { MarkInboxRead, NoticeActions, NoticeSummary, NoticeTime, noticeTitle } from "./NoticeContent";
import { notificationApi } from "./transport";

const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 独立详情通过通知 ID 向服务端确认访问，只有取得最新快照时才展示正文；链接未包含接受邀请所需的私有材料。
 */
function NotificationDetail({ id }: { id: string }) {
    const { owner, signal } = useInbox();
    const title = useRef<HTMLHeadingElement>(null);
    const details = useQuery({
        queryKey: [...inboxKey(owner), "detail", id],
        queryFn: ({ signal: request }) => notificationApi.detail(id, request),
        enabled: !!owner && !!signal && identifier.test(id),
        refetchOnMount: "always",
        refetchInterval: ({ state }) =>
            state.status === "success" && state.data ? invitationRefreshInterval([state.data]) : false,
    });
    const authorized = details.isSuccess && details.isFetchedAfterMount;
    useEffect(() => {
        if (authorized) title.current?.focus();
    }, [authorized]);
    return (
        <section className="vq-notification-detail" aria-label={tx("Notification details")}>
            <h2 ref={title} tabIndex={-1}>
                {tx("Notification details")}
            </h2>
            {(!identifier.test(id) || details.isError) && (
                <p role="alert">{tx("This notification or its target is no longer available.")}</p>
            )}
            {identifier.test(id) && !details.isError && !authorized && <p role="status">{tx("Loading VeriQ…")}</p>}
            {authorized && (
                <>
                    <NoticeTime stamp={details.data.occurredAt} />
                    <NoticeSummary row={details.data} />
                    <NoticeActions row={details.data} details={details.data.kind === "WORKSPACE_INVITED"} />
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
    const { owner, signal, openItem, busy } = useInbox();
    const [params] = useSearchParams();
    const [filter, setFilter] = useState("all");
    const [pageSize, setPageSize] = useState(10);
    const [selectedPage, setSelectedPage] = useState(1);
    const list = useInfiniteQuery({
        queryKey: [...inboxKey(owner), "pages", filter, pageSize],
        queryFn: ({ signal: request, pageParam }) =>
            notificationApi.list(pageSize, filter === "unread", request, pageParam),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last, _pages, _parameter, parameters) =>
            last.nextCursor && !parameters.includes(last.nextCursor) ? last.nextCursor : undefined,
        enabled: !!owner && !!signal,
        refetchInterval: ({ state }) => {
            if (state.status !== "success") return false;
            const pages = state.data?.pages;
            const visible = pages?.[Math.min(selectedPage, pages.length) - 1];
            return invitationRefreshInterval(visible?.items);
        },
    });
    if (!owner) return <Navigate replace to="/login" />;
    const id = params.get("notificationId");
    const pages = list.isError ? undefined : list.data?.pages;
    const pageCount = Math.max(1, pages?.length ?? 0);
    const page = Math.min(selectedPage, pageCount);
    const rows = pages?.at(page - 1)?.items ?? [];
    const label = tx("Notifications");
    const setPage = (number: number) => {
        if (number <= pageCount) setSelectedPage(number);
        else if (list.hasNextPage && !list.isFetching) {
            void list.fetchNextPage().then((result) => {
                if (result.isSuccess && (result.data?.pages.length ?? 0) >= number) setSelectedPage(number);
            });
        }
    };

    return (
        <Panel title="Notifications" action={<MarkInboxRead list={pages?.at(-1)} receivedAt={list.dataUpdatedAt} />}>
            {id && <NotificationDetail key={id} id={id} />}
            <DataTable
                label={label}
                view={{
                    page,
                    pageCount,
                    rows,
                    pageSize,
                    setPage,
                    search: "",
                    setSearch: () => undefined,
                    setPageSize: (size) => {
                        setPageSize(size);
                        setSelectedPage(1);
                    },
                }}
                hasMore={list.hasNextPage}
                busy={list.isPending || list.isFetchingNextPage}
                actions={
                    <Select
                        value={filter}
                        aria-label={tx("Filter notifications")}
                        onValueChange={(value) => {
                            setFilter(value);
                            setSelectedPage(1);
                        }}
                    >
                        <SelectItem value="all">{tx("All notifications")}</SelectItem>
                        <SelectItem value="unread">{tx("Unread notifications")}</SelectItem>
                    </Select>
                }
            >
                {list.isError && (
                    <div className="vq-notification-empty">
                        <p role="alert">{tx("Unable to load notifications.")}</p>
                        <Button size="compact" tone="secondary" onClick={() => void list.refetch()}>
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
                            {!list.isError && !rows.length && (
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
