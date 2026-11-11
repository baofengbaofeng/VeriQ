import { ReportPage } from "./features/reports/ReportPage";
import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError, type User } from "./api";
import { Auth } from "./auth-context";
import { Panel } from "./ui";
import { SignIn, Setup, ResetRequest, ResetConfirm } from "./pages/auth";
import { Account } from "./pages/account";
import { AdminUsers } from "./pages/users";
import { WorkspaceProvider } from "./features/workspaces/WorkspaceContext";
import {
  WorkspacePage,
  AcceptInvitation,
} from "./features/workspaces/WorkspacePage";
import { RuntimePage } from "./features/runtimes/RuntimePage";
import { ResourcePage } from "./features/resources/ResourcePage";
import { EnvironmentPage } from "./features/environments/EnvironmentPage";
import "./style.css";
function App() {
  const [user, setUser] = useState<User | null>(null),
    [ready, setReady] = useState(false),
    [initialized, setInitialized] = useState(false),
    [failure, setFailure] = useState("");
  const refresh = async () => {
    try {
      await api.session();
      setUser(await api.account());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setUser(null);
      else throw e;
    }
  };
  const load = async () => {
    try {
      setFailure("");
      setInitialized((await api.setup()).initialized);
      await refresh();
      setReady(true);
    } catch {
      setFailure("Unable to connect to VeriQ.");
    }
  };
  useEffect(() => {
    const expired = () => setUser(null);
    window.addEventListener("veriq:session-expired", expired);
    void load();
    return () => window.removeEventListener("veriq:session-expired", expired);
  }, []);
  if (failure)
    return (
      <Panel title="VeriQ unavailable">
        <p role="alert">{failure}</p>
        <button onClick={() => void load()}>Retry</button>
      </Panel>
    );
  if (!ready) return <p role="status">Loading VeriQ…</p>;
  return (
    <Auth.Provider
      value={{ user, refresh, setupComplete: () => setInitialized(true) }}
    >
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
                <Link to="/resources">资源 / Resources</Link>
              <Link to="/environments">环境 / Environments</Link>
              {user.systemAdmin && <Link to="/admin/users">Users</Link>}
              <button
                data-testid="logout"
                onClick={() => {
                  void api
                    .logout()
                    .then(refresh)
                    .catch(() =>
                      setFailure("Unable to sign out. Please retry."),
                    );
                }}
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
          <Route path="/reports" element={<WorkspaceProvider key={user?.id ?? "anonymous"}><ReportPage /></WorkspaceProvider>} />
          <Route path="/invitations/accept" element={<AcceptInvitation />} />
          <Route
            path="/"
            element={
              <Navigate
                to={user ? "/account" : initialized ? "/login" : "/setup"}
              />
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
