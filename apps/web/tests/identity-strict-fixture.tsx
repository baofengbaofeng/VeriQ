/**
 * 使用真实会话和工作区网络适配器重放 React 请求效果，保持认证配置编辑和凭证元数据的授权边界与管理台一致。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../src/api";
import { IdentityManager } from "../src/features/environments/IdentityManager";
import { CloudIdentityAdapter } from "../src/features/environments/identity-adapter";
import { AppLocaleProvider } from "../src/locale-ui";
import "../src/style.css";
import "../src/admin.css";
import "../src/web-theme.css";

/**
 * 仅在读取真实员工会话及目标空间成员资格后挂载，网络请求继续经现有适配器，不注入作为成功证据的模拟列表。
 */
async function mount() {
    const workspaceId = new URLSearchParams(location.search).get("workspaceId");
    const root = document.getElementById("root");
    if (!workspaceId || !root) throw new Error("Missing credential fixture context");
    await api.session();
    const workspace = await api.workspace(workspaceId);
    if (workspace.archived || !["OWNER", "ADMIN"].includes(workspace.role))
        throw new Error("Missing fixture authority");
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    createRoot(root).render(
        <StrictMode>
            <QueryClientProvider client={cache}>
                <AppLocaleProvider>
                    <IdentityManager adapter={new CloudIdentityAdapter(workspaceId)} workspaceId={workspaceId} />
                </AppLocaleProvider>
            </QueryClientProvider>
        </StrictMode>,
    );
}

void mount();
