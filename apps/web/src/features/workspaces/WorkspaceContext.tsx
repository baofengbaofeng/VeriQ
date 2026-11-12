/**
 * 当前选中 Workspace、AbortSignal 与切换时清理订阅的 React 作用域，外裹 QueryClient。
 * 必须用认证用户 ID 作为 Provider key，避免跨账号查询残留。
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
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
 * 读取 selected/select/signal/subscribe；功能页用 selected 构造 Cloud*Adapter 并传入 signal。
 * 切换空间会 abort 旧控制器并移除 queryKey 含 workspace 的缓存。
 */
export const useWorkspace = () => useContext(WorkspaceContext);

/**
 * 创建不重试的 QueryClient，维护 selected 与 lifetime AbortController，切换时 dispose 全部订阅。
 * 卸载时 abort+cancelQueries+clear，防止离开路由后仍写入已卸载组件。
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
    const [selected, setSelected] = useState("");
    const [lifetime] = useState(() => ({ controller: new AbortController() }));
    const dispose = () => {
        for (const unsubscribe of subscriptions) unsubscribe();
        subscriptions.clear();
    };
    useEffect(
        () => () => {
            dispose();
            lifetime.controller.abort();
            void client.cancelQueries();
            client.clear();
        },
        [client],
    );
    const select = (workspaceId: string) => {
        if (workspaceId === selected) return;
        dispose();
        lifetime.controller.abort();
        lifetime.controller = new AbortController();
        void client.cancelQueries({ queryKey: ["workspace"] });
        client.removeQueries({ queryKey: ["workspace"] });
        setSelected(workspaceId);
    };
    return (
        <QueryClientProvider client={client}>
            <WorkspaceContext.Provider
                value={{
                    selected,
                    select,
                    signal: lifetime.controller.signal,
                    subscribe: (unsubscribe) => {
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
                }}
            >
                {children}
            </WorkspaceContext.Provider>
        </QueryClientProvider>
    );
}
