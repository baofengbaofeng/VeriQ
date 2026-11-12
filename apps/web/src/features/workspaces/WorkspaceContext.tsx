/**
 * 本文件 apps/web/src/features/workspaces/WorkspaceContext.tsx 实现 VeriQ Web/共享 UI 界面能力并导出公开组件与辅助函数
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
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
 * 公开符号 useWorkspace（const）定义 apps/web/src/features/workspaces/WorkspaceContext.tsx 对外可复用的界面或工具接口
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 */
export const useWorkspace = () => useContext(WorkspaceContext);

/** Mount with the authenticated user ID as React key. Identity changes destroy
 * all queries and subscriptions; Workspace switches discard scoped data. */
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
