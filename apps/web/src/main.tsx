/**
 * Web 入口先探测安装状态再读取当前会话与账户，向 Auth 注入稳定刷新入口并按用户身份挂载各功能路由，使启动、重试和退出共享明确的异步结果发布边界。
 * 每个需空间作用域的路由用 user.id 作 Provider key，身份切换即清空查询与订阅。
 */

import { ExecutionPlansPage } from "./features/runs/ExecutionPlansPage";
import { BundlePage } from "./features/bundles/BundlePage";
import { AiPage } from "./features/ai/AiPage";
import { ReportPage } from "./features/reports/ReportPage";
import { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError, type User } from "./api";
import { Auth } from "./auth-context";
import { Panel } from "./ui";
import { SignIn, Setup, ResetRequest, ResetConfirm } from "./pages/auth";
import { Account } from "./pages/account";
import { AdminUsers } from "./pages/users";
import { WorkspaceProvider } from "./features/workspaces/WorkspaceContext";
import { WorkspacePage, AcceptInvitation } from "./features/workspaces/WorkspacePage";
import { RuntimePage } from "./features/runtimes/RuntimePage";
import { ResourcePage } from "./features/resources/ResourcePage";
import { EnvironmentPage } from "./features/environments/EnvironmentPage";
import "./style.css";
function App() {
    const [user, setUser] = useState<User | null>(null),
        [ready, setReady] = useState(false),
        [initialized, setInitialized] = useState(false),
        [failure, setFailure] = useState("");
    const mounted = useRef(false),
        identityGeneration = useRef(0),
        loadGeneration = useRef(0),
        logoutIntent = useRef<number | null>(null);
    /** 会话探测与账户读取共用调用者分配的身份代次，每个 await 后都检查当前归属；过期事件先清除身份，旧成功及旧异常均不能重新发布已失效的账户或故障状态。 */
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
    /** 稳定刷新入口只在退出意图仍拥有当前身份代次时拒绝旧操作回调，防止其抢走退出发布权；真实会话过期使旧意图失效后，后来的成功登录可立即建立新身份而不必等待旧退出响应。 */
    const refresh = useCallback(async (): Promise<void> => {
        if (logoutIntent.current === identityGeneration.current) return;
        loadGeneration.current += 1;
        await readIdentity(++identityGeneration.current);
    }, [readIdentity]);
    /** 安装探测的所有权独立于身份探测，因此本轮匿名会话的正常 401 仍可完成启动；新的刷新、退出或卸载会使旧启动失效，防止旧 Retry 覆盖当前就绪或失败状态。 */
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
    /** 退出意图在发送请求前就撤销旧身份读取的发布权，随后复用同一代次探测真正的退出结果；只有仍归属于这次退出的异常可以显示失败，避免旧 catch 干扰后续登录。 */
    const logout = useCallback(async (): Promise<void> => {
        const request = ++identityGeneration.current;
        logoutIntent.current = request;
        loadGeneration.current += 1;
        try {
            await api.logout();
            if (mounted.current && identityGeneration.current === request)
                await readIdentity(request);
        } catch {
            if (mounted.current && identityGeneration.current === request)
                setFailure("Unable to sign out. Please retry.");
        } finally {
            if (logoutIntent.current === request) logoutIntent.current = null;
        }
    }, [readIdentity]);
    if (failure)
        return (
            <Panel title="VeriQ unavailable">
                <p role="alert">{failure}</p>
                <button type="button" onClick={() => void load()}>
                    Retry
                </button>
            </Panel>
        );
    if (!ready) return <p role="status">Loading VeriQ…</p>;
    return (
        <Auth.Provider value={{ user, refresh, setupComplete: () => setInitialized(true) }}>
            <header>
                <Link to="/account" className="brand">
                    VeriQ
                </Link>
                <nav>
                    {user ? (
                        <>
                            <Link to="/account">Account</Link>
                            <Link to="/workspaces">Workspaces</Link>
                            <Link to="/runtimes">Runtimes</Link>
                            <Link to="/reports">Reports</Link>
                            <Link to="/execution-plans">执行计划 / Plans</Link>
                            <Link to="/bundles">Bundles</Link>
                            <Link to="/ai">AI</Link>
                            <Link to="/resources">资源 / Resources</Link>
                            <Link to="/environments">环境 / Environments</Link>
                            {user.systemAdmin && <Link to="/admin/users">Users</Link>}
                            <button
                                type="button"
                                data-testid="logout"
                                onClick={() => void logout()}
                            >
                                Sign out
                            </button>
                        </>
                    ) : (
                        <Link to="/login">Sign in</Link>
                    )}
                </nav>
            </header>
            <main>
                <Routes>
                    <Route path="/setup" element={<Setup />} />
                    <Route
                        path="/login"
                        element={
                            user ? (
                                <Navigate to="/account" />
                            ) : initialized ? (
                                <SignIn />
                            ) : (
                                <Navigate to="/setup" />
                            )
                        }
                    />
                    <Route path="/reset" element={<ResetRequest />} />
                    <Route path="/reset/confirm" element={<ResetConfirm />} />
                    <Route path="/account" element={<Account />} />
                    <Route path="/admin/users" element={<AdminUsers />} />
                    <Route
                        path="/workspaces"
                        element={
                            <WorkspaceProvider key={user?.id ?? "anonymous"}>
                                <WorkspacePage />
                            </WorkspaceProvider>
                        }
                    />
                    <Route
                        path="/runtimes"
                        element={
                            <WorkspaceProvider key={user?.id ?? "anonymous"}>
                                <RuntimePage />
                            </WorkspaceProvider>
                        }
                    />
                    <Route
                        path="/resources"
                        element={
                            <WorkspaceProvider key={user?.id ?? "anonymous"}>
                                <ResourcePage />
                            </WorkspaceProvider>
                        }
                    />
                    <Route
                        path="/environments"
                        element={
                            <WorkspaceProvider key={user?.id ?? "anonymous"}>
                                <EnvironmentPage />
                            </WorkspaceProvider>
                        }
                    />
                    <Route
                        path="/ai"
                        element={
                            <WorkspaceProvider key={user?.id ?? "anonymous"}>
                                <AiPage />
                            </WorkspaceProvider>
                        }
                    />
                    <Route
                        path="/bundles"
                        element={
                            <WorkspaceProvider key={user?.id ?? "anonymous"}>
                                <BundlePage />
                            </WorkspaceProvider>
                        }
                    />
                    <Route
                        path="/reports"
                        element={
                            <WorkspaceProvider key={user?.id ?? "anonymous"}>
                                <ReportPage />
                            </WorkspaceProvider>
                        }
                    />
                    <Route
                        path="/execution-plans"
                        element={
                            <WorkspaceProvider key={user?.id ?? "anonymous"}>
                                <ExecutionPlansPage />
                            </WorkspaceProvider>
                        }
                    />
                    <Route path="/invitations/accept" element={<AcceptInvitation />} />
                    <Route
                        path="/"
                        element={
                            <Navigate to={user ? "/account" : initialized ? "/login" : "/setup"} />
                        }
                    />
                    <Route
                        path="*"
                        element={
                            <Panel title="Page not found">
                                <Link to="/">Return to VeriQ</Link>
                            </Panel>
                        }
                    />
                </Routes>
            </main>
        </Auth.Provider>
    );
}
createRoot(document.getElementById("root")!).render(
    <BrowserRouter>
        <App />
    </BrowserRouter>,
);
