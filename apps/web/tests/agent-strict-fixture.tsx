/**
 * 浏览器夹具通过真实员工会话和工作区接口挂载共享对话视图，复用桌面启用的 React 严格模式效果重放。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../src/api";
import { AgentWorkspaceView } from "../src/features/agent/AgentWorkspaceView";
import { CloudAgentAdapter } from "../src/features/agent/adapters";
import { CloudAiAdapter } from "../src/features/ai/adapters";
import { CloudReportAdapter } from "../src/features/reports/adapters";
import { AppLocaleProvider } from "../src/locale-ui";

/**
 * 挂载前由当前真实会话刷新内存中的防伪令牌；夹具只准备渲染环境，业务请求依然进入相同的 Cookie 传输。
 */
async function mount() {
    const workspaceId = new URLSearchParams(location.search).get("workspaceId");
    const root = document.getElementById("root");
    if (!workspaceId || !root) throw new Error("Missing Agent fixture context");
    const session = await api.session();
    const workspace = await api.workspace(workspaceId);
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    createRoot(root).render(
        <StrictMode>
            <QueryClientProvider client={cache}>
                <AppLocaleProvider>
                    <AgentWorkspaceView
                        workspace={workspace}
                        owner={session.user.id}
                        adapter={new CloudAgentAdapter(workspaceId)}
                        providers={new CloudAiAdapter(workspaceId)}
                        reports={new CloudReportAdapter(workspaceId)}
                        navigate={() => null}
                    />
                </AppLocaleProvider>
            </QueryClientProvider>
        </StrictMode>,
    );
}

void mount();
