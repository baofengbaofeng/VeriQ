/**
 * Agent 的展示确认只从当前浏览器真正可见且已完成的回复产生，关闭抽屉与切换上下文会取消未完成回执。
 */
import { useEffect, useRef, type RefObject } from "react";
import type { AgentNotificationTarget } from "../notifications/model";

/**
 * 每个线程独立跟踪已确认轮次。重新分页与滚出可见区不会重复确认，失败后可随下一次实际可见性变化重试。
 */
export function useAgentReplyVisibility({
    messages,
    workspaceId,
    sessionId,
    displayed,
    signal,
    acknowledge,
}: {
    messages: RefObject<HTMLDivElement>;
    workspaceId: string;
    sessionId: string;
    displayed: boolean;
    signal: AbortSignal;
    acknowledge?: (target: AgentNotificationTarget, signal: AbortSignal) => Promise<void>;
}) {
    const acknowledged = useRef(new Set<string>());
    useEffect(() => {
        const container = messages.current;
        if (!container || !displayed || !acknowledge || signal.aborted) return;
        const controller = new AbortController();
        const active = AbortSignal.any([signal, controller.signal]);
        const visible = new Set<HTMLElement>();
        const observed = new Set<HTMLElement>();

        // 页面有焦点且正文经过浏览器视口与各滚动容器裁剪后才发确认，被模态窗口遮蔽的回复等待焦点回到对话。
        function confirmVisible() {
            if (document.visibilityState !== "visible" || !document.hasFocus() || active.aborted || !acknowledge)
                return;
            for (const node of visible) {
                const turnId = node.dataset.agentReply;
                if (!turnId || acknowledged.current.has(turnId) || node.closest('[aria-hidden="true"], [inert]'))
                    continue;
                acknowledged.current.add(turnId);
                void acknowledge({ workspaceId, sessionId, turnId }, active).catch(() => {
                    acknowledged.current.delete(turnId);
                });
            }
        }
        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!(entry.target instanceof HTMLElement)) continue;
                if (entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0) {
                    visible.add(entry.target);
                } else visible.delete(entry.target);
            }
            confirmVisible();
        });
        // 只在回复节点增删或从运行中变为完整时更新观察目标，续页和新回复不取消前一条正在提交的展示回执。
        function reconcile() {
            if (!container) return;
            const nodes = new Set(container.querySelectorAll<HTMLElement>("[data-agent-reply]"));
            for (const node of observed) {
                if (nodes.has(node)) continue;
                observer.unobserve(node);
                observed.delete(node);
                visible.delete(node);
            }
            for (const node of nodes) {
                if (observed.has(node)) continue;
                observed.add(node);
                observer.observe(node);
            }
        }
        reconcile();
        const changes = new MutationObserver(reconcile);
        changes.observe(container, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["data-agent-reply"],
        });
        document.addEventListener("visibilitychange", confirmVisible);
        document.addEventListener("focusin", confirmVisible);
        window.addEventListener("focus", confirmVisible);
        return () => {
            controller.abort();
            observer.disconnect();
            changes.disconnect();
            document.removeEventListener("visibilitychange", confirmVisible);
            document.removeEventListener("focusin", confirmVisible);
            window.removeEventListener("focus", confirmVisible);
        };
    }, [acknowledge, displayed, messages, sessionId, signal, workspaceId]);
}
