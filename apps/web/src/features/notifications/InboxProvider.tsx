/**
 * 顶栏和列表共享个人收件箱的连接与写入状态，账户切换时由外层工作区容器卸载，普通工作区切换保留站内消息。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useMatch, useNavigate } from "react-router-dom";
import { api, ApiError } from "../../api";
import { Auth } from "../../auth-context";
import { tx } from "../../locale";
import { useOperationFeedback } from "../../operation-feedback";
import { useRequestLifetime } from "../../request-lifetime";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { useWorkspaceDirectory } from "../workspaces/WorkspaceDirectory";
import { invitationRefreshInterval } from "./model";
import type { AgentNotificationTarget, InboxNotification, InboxPage, InvitationNotification } from "./model";
import { notificationApi, observeInbox } from "./transport";

/**
 * 操作状态按登录账户共享，避免同时从通知列表和顶栏重复发起写入；路由和抽屉统一由活动所有者选择。
 */
type InboxContext = {
    owner?: string;
    signal?: AbortSignal;
    snapshot?: InboxPage;
    snapshotTime: number;
    loading: boolean;
    error: boolean;
    busy: boolean;
    bellOpen: boolean;
    setBellOpen: (open: boolean) => void;
    agentTarget?: AgentNotificationTarget;
    retry: () => void;
    clearAgentTarget: () => void;
    markAll: (trigger: HTMLElement, current: InboxPage) => Promise<void>;
    accept: (row: InvitationNotification, trigger: HTMLElement) => Promise<void>;
    opensDetail: (row: InboxNotification) => boolean;
    openItem: (row: InboxNotification, beforeOpen?: (movesFocus: boolean) => void) => Promise<void>;
};
const Inbox = createContext<InboxContext | null>(null);

/**
 * 订阅与操作必须位于会话外壳内，缺少容器时立即提示接线问题，避免匿名页面误用站内信入口。
 */
export function useInbox() {
    const value = useContext(Inbox);
    if (!value) throw new Error("Notification inbox provider is required");
    return value;
}

/**
 * 缓存键只属于当前用户，脱离工作区选择。状态通知使所有页、顶栏计数与详情同时重新验证读取权限。
 */
export function inboxKey(owner?: string) {
    return ["notifications", owner] as const;
}

/**
 * 短文案区分业务目标已失效与网络请求失败，避免将服务端内部错误、后端原始对象或目标正文显示给用户。
 */
function operationError(error: unknown) {
    return tx(
        error instanceof ApiError && [403, 404, 410].includes(error.status)
            ? "This notification or its target is no longer available."
            : "Unable to update notifications. Try again.",
    );
}

/**
 * 每次请求都使用已提交的会话有效期，迟到响应不得继续跳转、推送结果或重建旧账户下的通知查询。
 */
export function InboxProvider({ children, parentSignal }: { children: ReactNode; parentSignal?: AbortSignal }) {
    const { user } = useContext(Auth);
    const owner = user?.id;
    const { selected } = useWorkspace();
    const signal = useRequestLifetime(parentSignal)?.signal;
    const cache = useQueryClient();
    const navigate = useNavigate();
    const { search } = useLocation();
    const onReportsPage = useMatch("/reports") !== null;
    const onNotificationsPage = useMatch("/notifications") !== null;
    const directory = useWorkspaceDirectory();
    const { showPending, showFailure } = useOperationFeedback();
    const [agentTarget, setAgentTarget] = useState<AgentNotificationTarget>();
    const [busy, setBusy] = useState(false);
    const [bellOpen, setBellOpen] = useState(false);
    const mutation = useRef(false);
    const overview = useQuery({
        queryKey: [...inboxKey(owner), "overview"],
        queryFn: ({ signal: request }) => notificationApi.list(10, false, request),
        enabled: !!owner && !!signal,
        refetchInterval: ({ state }) =>
            bellOpen && state.status === "success" ? invitationRefreshInterval(state.data?.items) : false,
    });
    const ready = typeof overview.data?.readThrough === "string";
    const snapshot = ready && !overview.isError ? overview.data : undefined;
    const invalidate = useCallback(() => {
        void cache.invalidateQueries({ queryKey: inboxKey(owner) });
    }, [cache, owner]);
    useEffect(() => {
        if (!owner || !signal || !ready) return;
        const controller = new AbortController();
        void observeInbox(invalidate, AbortSignal.any([signal, controller.signal]));
        return () => controller.abort();
    }, [owner, signal, ready, invalidate]);

    // 操作完成以后重新读取真实状态；等待弹窗提前关闭仅隐藏观察结果，服务端最终是否写入仍由已完成的请求决定。
    async function mutate(
        trigger: HTMLElement,
        waiting: string,
        result: string,
        submit: (active: AbortSignal) => Promise<void>,
    ) {
        if (!owner || !signal || signal.aborted || mutation.current) return;
        mutation.current = true;
        setBusy(true);
        const feedback = showPending(tx(waiting), { trigger, onClose: () => undefined });
        try {
            await submit(signal);
            signal.throwIfAborted();
            feedback.complete("success", tx(result));
        } catch (error) {
            if (!signal.aborted) feedback.complete("failure", operationError(error));
        } finally {
            mutation.current = false;
            if (signal.aborted) feedback.dismiss();
            else {
                setBusy(false);
                invalidate();
            }
        }
    }

    // 个人收件箱可同时显示多个工作区的通知，只有表单所属空间的单条操作才能继承会话轮次作为回执来源。
    function itemSignal(row: InboxNotification, active: AbortSignal) {
        return parentSignal && row.workspaceId !== selected ? AbortSignal.any([active]) : active;
    }

    // 当前快照水位在点击时捕获，标记请求完成前到达的通知由下次快照加入，不会被这次写入意外覆盖。
    async function markAll(trigger: HTMLElement, current: InboxPage) {
        const through = current.readThrough;
        if (!through || !current.unreadCount) return;
        await mutate(trigger, "Marking notifications as read…", "Notifications marked as read.", async (active) => {
            await notificationApi.readAll(through, parentSignal ? AbortSignal.any([active]) : active);
        });
    }

    // 接受后重新读取成员目录和收件箱，未获授权时工作区的既有已选状态和邀请原始通知保持不变。
    async function accept(row: InvitationNotification, trigger: HTMLElement) {
        if (row.invitationStatus !== "PENDING") return;
        await mutate(trigger, "Accepting invitation…", "Invitation accepted.", async (active) => {
            await notificationApi.accept(row.id, itemSignal(row, active));
            active.throwIfAborted();
            void cache.invalidateQueries({ queryKey: ["workspaces", owner] });
        });
    }

    function opensDetail(row: InboxNotification) {
        return (
            row.kind === "WORKSPACE_INVITED" ||
            (!!parentSignal && (row.kind === "AGENT_REPLY" || row.workspaceId !== selected))
        );
    }

    // 视图只根据读回执选择内部目标，Agent 先复核工作区成员目录，再切换选择并让抽屉读取精确轮次。
    async function openItem(row: InboxNotification, beforeOpen?: (movesFocus: boolean) => void) {
        if (!owner || !signal || signal.aborted || mutation.current) return;
        mutation.current = true;
        setBusy(true);
        try {
            const current = await notificationApi.read(row.id, itemSignal(row, signal));
            signal.throwIfAborted();
            if (opensDetail(current)) {
                beforeOpen?.(!onNotificationsPage || new URLSearchParams(search).get("notificationId") !== current.id);
                void navigate(`/notifications?${new URLSearchParams({ notificationId: current.id })}`);
                return;
            }
            switch (current.kind) {
                case "AGENT_REPLY": {
                    const { workspaceId, sessionId, turnId } = current;
                    const workspace = await api.workspace(workspaceId, signal);
                    signal.throwIfAborted();
                    if (workspace.id !== workspaceId) throw new Error("Notification workspace changed");
                    beforeOpen?.(true);
                    directory.selectAuthorized(workspace);
                    setAgentTarget({ workspaceId, sessionId, turnId });
                    break;
                }
                case "RUN_STARTED":
                case "RUN_FINISHED":
                    // 报告页内只改变查询参数时没有路由标题聚焦，关闭后保留铃铛作为下一次键盘操作入口，并继续展示报告。
                    beforeOpen?.(!onReportsPage);
                    void navigate(
                        `/reports?${new URLSearchParams({ workspaceId: current.workspaceId, runId: current.runId })}`,
                    );
            }
        } catch (error) {
            if (!signal.aborted) showFailure(operationError(error));
        } finally {
            mutation.current = false;
            if (!signal.aborted) {
                setBusy(false);
                invalidate();
            }
        }
    }

    return (
        <Inbox.Provider
            value={{
                owner,
                signal,
                agentTarget,
                busy,
                bellOpen,
                setBellOpen,
                openItem,
                opensDetail,
                accept,
                markAll,
                snapshot,
                snapshotTime: overview.dataUpdatedAt,
                loading: overview.isPending,
                error: overview.isError,
                retry: () => void overview.refetch(),
                clearAgentTarget: () => setAgentTarget(undefined),
            }}
        >
            {children}
        </Inbox.Provider>
    );
}
