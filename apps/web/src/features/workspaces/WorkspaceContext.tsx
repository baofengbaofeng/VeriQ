/**
 * VeriQ 的 Workspace 作用域把选中标识与取消控制器作为同一份快照发布，切换时关闭旧订阅并清除空间查询；认证用户仍通过
 * Provider 的键隔离全部会话资源。
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type ScopeState = {
    selected: string;
    signal?: AbortSignal;
    select: (workspaceId: string) => void;
    subscribe: (dispose: () => void) => () => void;
};
const WorkspaceContext = createContext<ScopeState>({
    selected: "",
    select: () => {},
    subscribe: () => () => {},
});
/**
 * 功能页通过此入口读取选中空间、取消信号和订阅所有权；选择回调始终读取调用时的当前空间，同空间重复选择不会关闭订阅、取
 * 消请求或清除查询缓存。
 */
export const useWorkspace = () => useContext(WorkspaceContext);

/**
 * 每个认证用户的 Provider 独立拥有查询客户端、订阅集合和当前控制器，普通重渲染保持这些资源存活，最终卸载读取最新控制器
 * 并清理全部查询和订阅。
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
    const [client] = useState(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: { retry: false, staleTime: 0 },
                    mutations: { retry: false },
                },
            }),
    );
    const [subscriptions] = useState(() => new Set<() => void>());
    const [lifetime] = useState(() => ({
        current: { selected: "", controller: new AbortController() },
    }));
    const [scope, setScope] = useState(lifetime.current);
    const dispose = useCallback(() => {
        for (const unsubscribe of subscriptions) unsubscribe();
        subscriptions.clear();
    }, [subscriptions]);
    useEffect(
        () => () => {
            dispose();
            lifetime.current.controller.abort();
            void client.cancelQueries();
            client.clear();
        },
        [client, dispose, lifetime],
    );
    /**
     * 切换事件沿用先关闭订阅再终止旧请求的顺序，当前快照在事件内更新以支持保留的回调；React 提交随后同时发布空间与信号
     * ，状态更新器中不执行清理副作用。
     */
    const select = useCallback(
        (workspaceId: string) => {
            if (workspaceId === lifetime.current.selected) return;
            dispose();
            lifetime.current.controller.abort();
            const next = { selected: workspaceId, controller: new AbortController() };
            lifetime.current = next;
            void client.cancelQueries({ queryKey: ["workspace"] });
            client.removeQueries({ queryKey: ["workspace"] });
            setScope(next);
        },
        [client, dispose, lifetime],
    );
    /**
     * 订阅关闭函数的身份由单次注册持有，主动取消、空间切换及最终卸载可以重复调用同一关闭函数；首次关闭立即移出集合，避
     * 免后续清理重复释放订阅资源。
     */
    const subscribe = useCallback(
        (unsubscribe: () => void) => {
            let disposed = false;
            const close = () => {
                if (disposed) return;
                disposed = true;
                subscriptions.delete(close);
                unsubscribe();
            };
            subscriptions.add(close);
            return close;
        },
        [subscriptions],
    );
    return (
        <QueryClientProvider client={client}>
            <WorkspaceContext.Provider
                value={{
                    selected: scope.selected,
                    select,
                    signal: scope.controller.signal,
                    subscribe,
                }}
            >
                {children}
            </WorkspaceContext.Provider>
        </QueryClientProvider>
    );
}

/**
 * 内嵌领域页仅持有已核验工作区的取消信号。独立查询缓存与受此信号约束的订阅随表单销毁，保留外层会话的数据和选择。
 */
export function PinnedFormWorkspace({
    selected,
    signal,
    children,
}: {
    selected: string;
    signal: AbortSignal;
    children: ReactNode;
}) {
    const [client] = useState(
        () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }),
    );
    useEffect(
        () => () => {
            client.clear();
        },
        [client],
    );
    const subscribe = useCallback(
        (dispose: () => void) => {
            let disposed = false;
            function release() {
                if (disposed) return;
                disposed = true;
                signal.removeEventListener("abort", release);
                dispose();
            }
            if (signal.aborted) release();
            else signal.addEventListener("abort", release, { once: true });
            return release;
        },
        [signal],
    );
    return (
        <QueryClientProvider client={client}>
            <WorkspaceContext.Provider value={{ selected, signal, subscribe, select: () => {} }}>
                {children}
            </WorkspaceContext.Provider>
        </QueryClientProvider>
    );
}
