/**
 * Web 入口先探测安装状态再读取当前会话与账户，向 Auth 注入稳定刷新入口并按用户身份挂载各功能路由，使启动、重试和退出共
 * 享明确的异步结果发布边界。
 * 每个需空间作用域的路由用 user.id 作 Provider key，身份切换即清空查询与订阅。
 */

import { tx, useAppLocale } from "./locale";
import { installBrowserDiagnostics } from "./browser-logging";
import { ExecutionPlansPage } from "./features/runs/ExecutionPlansPage";
import { AgentPage } from "./features/agent/AgentPage";
import { AiPage } from "./features/ai/AiPage";
import { ReportPage } from "./features/reports/ReportPage";
import { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation, Link, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { api, ApiError, type User } from "./api";
import { Auth } from "./auth-context";
import { AuthLayout } from "./auth-layout";
import { Panel } from "./ui";
import { SignIn, Setup, ResetRequest, ResetConfirm } from "./pages/auth";
import { Account } from "./pages/account";
import { AdminUsers } from "./pages/users";
import { WorkspaceProvider } from "./features/workspaces/WorkspaceContext";
import { WorkspacePage, AcceptInvitation } from "./features/workspaces/WorkspacePage";
import { RuntimePage } from "./features/runtimes/RuntimePage";
import { DatasetDetailPage, ResourcePage } from "./features/resources/ResourcePage";
import { datasetDetailRoute, datasetListPath } from "./features/resources/dataset-routes";
import { EnvironmentPage } from "./features/environments/EnvironmentPage";
import { AccessibilityNavigation, AppLocaleProvider, LanguageDropdown } from "./locale-ui";
import { WorkspaceDirectory } from "./features/workspaces/WorkspaceDirectory";
import { AppShell, PageBreadcrumb } from "./layout";
import { InboxProvider } from "./features/notifications/InboxProvider";
import { NotificationsPage } from "./features/notifications/NotificationsPage";
import { useOperationFeedback } from "./operation-feedback";
import "./menu-focus";
import "./style.css";
import "./admin.css";
import "./web-theme.css";
import "./auth.css";
function App() {
    const { pathname, key: locationKey } = useLocation();
    useAppLocale();
    const { showFailure } = useOperationFeedback();
    const [user, setUser] = useState<User | null>(null),
        [ready, setReady] = useState(false),
        [initialized, setInitialized] = useState(false),
        [failure, setFailure] = useState("");
    const mounted = useRef(false),
        identityGeneration = useRef(0),
        loadGeneration = useRef(0),
        logoutIntent = useRef<number | null>(null);
    /**
     * 会话探测与账户读取共用调用者分配的身份代次，每个 await 后都检查当前归属；过期事件先清除身份，旧成功及旧异常均不
     * 能重新发布已失效的账户或故障状态。
     */
    const readIdentity = useCallback(async (request: number): Promise<void> => {
        const current = () => mounted.current && identityGeneration.current === request;
        try {
            if (!current()) return;
            await api.session();
            if (!current()) return;
            const account = await api.account();
            if (current()) setUser(account);
        } catch (e) {
            if (!current()) return;
            if (e instanceof ApiError && e.status === 401) setUser(null);
            else throw e;
        }
    }, []);
    /**
     * 稳定刷新入口只在退出意图仍拥有当前身份代次时拒绝旧操作回调，防止其抢走退出发布权；真实会话过期使旧意图失效后，后
     * 来的成功登录可立即建立新身份而不必等待旧退出响应。
     */
    const refresh = useCallback(async (): Promise<void> => {
        if (logoutIntent.current === identityGeneration.current) return;
        loadGeneration.current += 1;
        await readIdentity(++identityGeneration.current);
    }, [readIdentity]);
    /**
     * 安装探测的所有权独立于身份探测，因此本轮匿名会话的正常 401 仍可完成启动；新的刷新、退出或卸载会使旧启动失效，防
     * 止旧 Retry 覆盖当前就绪或失败状态。
     */
    const load = useCallback(async (): Promise<void> => {
        const request = ++loadGeneration.current;
        const identityRequest = ++identityGeneration.current;
        const current = () => mounted.current && loadGeneration.current === request;
        try {
            if (!current()) return;
            setFailure("");
            const setup = await api.setup();
            if (!current()) return;
            setInitialized(setup.initialized);
            await readIdentity(identityRequest);
            if (current()) setReady(true);
        } catch {
            if (current()) setFailure("Unable to connect to VeriQ.");
        }
    }, [readIdentity]);
    useEffect(() => {
        mounted.current = true;
        const expired = () => {
            identityGeneration.current += 1;
            setUser(null);
        };
        window.addEventListener("veriq:session-expired", expired);
        void load();
        return () => {
            mounted.current = false;
            identityGeneration.current += 1;
            loadGeneration.current += 1;
            window.removeEventListener("veriq:session-expired", expired);
        };
    }, [load]);
    /**
     * 退出意图在发送请求前就撤销旧身份读取的发布权，随后复用同一代次探测真正的退出结果；只有仍归属于这次退出的异常可以
     * 显示失败，避免旧 catch 干扰后续登录。
     */
    const logout = useCallback(async (): Promise<void> => {
        const request = ++identityGeneration.current;
        logoutIntent.current = request;
        loadGeneration.current += 1;
        try {
            await api.logout();
            if (mounted.current && identityGeneration.current === request) await readIdentity(request);
        } catch {
            if (mounted.current && identityGeneration.current === request)
                showFailure("Unable to sign out. Please retry.");
        } finally {
            if (logoutIntent.current === request) logoutIntent.current = null;
        }
    }, [readIdentity, showFailure]);
    if (failure)
        return (
            <main id="main-content" className="vq-standalone" tabIndex={-1}>
                <PageBreadcrumb currentLabel="VeriQ unavailable" />
                <LanguageDropdown />
                <Panel title={tx("VeriQ unavailable")}>
                    <p role="alert">{tx(failure)}</p>
                    <button type="button" onClick={() => void load()}>
                        {tx("Retry")}
                    </button>
                </Panel>
            </main>
        );
    if (!ready)
        return (
            <main id="main-content" className="vq-standalone" tabIndex={-1}>
                <PageBreadcrumb currentLabel="Loading VeriQ…" />
                <LanguageDropdown />
                <p role="status">{tx("Loading VeriQ…")}</p>
            </main>
        );
    const shell = (invitation?: React.ReactNode) => {
        // 认证页：独立全屏分栏，访客不挂载 Workspace 上下文与应用外壳，登录初始化与重置统一由 AuthLayout 居中承载。
        const authRoutes = (
            <Route element={<AuthLayout />}>
                <Route path="/setup" element={<Setup />} />
                <Route
                    path="/login"
                    element={user ? <Navigate to="/account" /> : initialized ? <SignIn /> : <Navigate to="/setup" />}
                />
                <Route path="/reset" element={<ResetRequest />} />
                <Route path="/reset/confirm" element={<ResetConfirm />} />
            </Route>
        );
        // 已登录功能页：保留 Workspace 上下文与应用外壳，按用户身份重挂载以清空查询与订阅，邀请与兜底路由同组渲染。
        const consoleRoutes = (
            <Route
                element={
                    <WorkspaceProvider key={user?.id ?? "anonymous"}>
                        <WorkspaceDirectory>
                            <InboxProvider>
                                <AppShell onLogout={() => void logout()}>
                                    <Outlet />
                                </AppShell>
                            </InboxProvider>
                        </WorkspaceDirectory>
                    </WorkspaceProvider>
                }
            >
                <Route path="/account" element={<Account />} />
                <Route path="/admin/users" element={<AdminUsers />} />
                <Route path="/workspaces" element={<WorkspacePage />} />
                <Route path="/runtimes" element={<RuntimePage />} />
                <Route path="/resources/element-catalogs" element={<ResourcePage fixedKind="ELEMENT_CATALOG" />} />
                <Route path={datasetListPath} element={<ResourcePage fixedKind="DATASET" />} />
                <Route path={datasetDetailRoute} element={<DatasetDetailPage />} />
                <Route path="/resources/fixtures" element={<ResourcePage fixedKind="FIXTURE" />} />
                <Route path="/resources/assertion" element={<ResourcePage fixedKind="ASSERTION_TEMPLATE" />} />
                <Route path="/resources/environments" element={<EnvironmentPage />} />
                <Route path="/resources/flows" element={<ResourcePage fixedKind="FLOW" />} />
                <Route path="/resources/cases" element={<ResourcePage fixedKind="CASE" />} />
                <Route path="/resources/suites" element={<ResourcePage fixedKind="SUITE" />} />
                <Route path="/agent" element={<AgentPage />} />
                <Route path="/ai" element={<AiPage />} />
                <Route path="/reports" element={<ReportPage />} />
                <Route path="/notifications" element={<NotificationsPage />} />
                <Route path="/execution-plans" element={<ExecutionPlansPage />} />
                <Route path="/invitations/accept" element={invitation} />
                <Route path="/" element={<Navigate to={user ? "/account" : initialized ? "/login" : "/setup"} />} />
                <Route
                    path="*"
                    element={
                        <Panel title={tx("Page not found")}>
                            <Link to="/">{tx("Return to VeriQ")}</Link>
                        </Panel>
                    }
                />
            </Route>
        );
        return (
            <Routes>
                {authRoutes}
                {consoleRoutes}
            </Routes>
        );
    };
    return (
        <Auth.Provider value={{ user, refresh, setupComplete: () => setInitialized(true) }}>
            <AcceptInvitation
                entry={pathname.toLowerCase().replace(/\/$/, "") === "/invitations/accept" ? locationKey : undefined}
                render={shell}
            />
        </Auth.Provider>
    );
}
installBrowserDiagnostics("web");
createRoot(document.getElementById("root")!).render(
    <AppLocaleProvider>
        <BrowserRouter>
            <AccessibilityNavigation />
            <App />
        </BrowserRouter>
    </AppLocaleProvider>,
);
