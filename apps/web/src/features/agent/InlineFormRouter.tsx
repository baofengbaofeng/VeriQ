/**
 * 在现有浏览器路由内部为工作区表单提供独立的位置和历史。领域页的导航钩子只操作本地记录，外层路由和聊天组件均保持挂载。
 */
import { useContext, useId, useMemo, useState } from "react";
import {
    Link,
    useLocation,
    Route,
    Routes,
    UNSAFE_NavigationContext,
    UNSAFE_RouteContext,
    createPath,
    parsePath,
    type Navigator,
    type To,
} from "react-router-dom";
import { tx } from "../../locale";
import { EnvironmentPage } from "../environments/EnvironmentPage";
import { InboxProvider } from "../notifications/InboxProvider";
import { NotificationsPage } from "../notifications/NotificationsPage";
import type { ReportAdapter } from "../reports/adapters";
import { ReportPage } from "../reports/ReportPage";
import { DatasetDetailPage, ResourcePage } from "../resources/ResourcePage";
import { datasetDetailRoute, datasetListPath } from "../resources/dataset-routes";
import { ExecutionPlansPage } from "../runs/ExecutionPlansPage";
import { RuntimePage } from "../runtimes/RuntimePage";
import { WorkspacePage } from "../workspaces/WorkspacePage";
import { inlineFormPath } from "./inline-form-routes";
import type { WorkspaceFormReference } from "./workspace-forms";

type PageEntry = { href: string; state: unknown; key: string };
const rootRoute = { outlet: null, matches: [], isDataRoute: false };

/**
 * 外层面包屑始终反映真实浏览器地址；内嵌详情按原资源列表的位置返回，筛选和分页保持在本地历史中。
 */
function DatasetFormDetail() {
    const location = useLocation();
    return (
        <>
            <nav aria-label={tx("Breadcrumb")}>
                <Link to={datasetListPath} state={location.state}>
                    {tx("Datasets")}
                </Link>
            </nav>
            <DatasetDetailPage />
        </>
    );
}

export function InlineFormRouter({
    href,
    reference,
    signal,
    nativeReportAdapter,
}: {
    href: string;
    reference: WorkspaceFormReference;
    signal: AbortSignal;
    nativeReportAdapter?: ReportAdapter;
}) {
    const baseNavigation = useContext(UNSAFE_NavigationContext);
    const anchor = useId();
    const [history, setHistory] = useState({ entries: [{ href, state: null, key: "0" } as PageEntry], index: 0 });
    const navigator = useMemo<Navigator>(() => {
        function move(to: To, state: unknown, replace: boolean) {
            if (signal.aborted) return;
            const next = inlineFormPath(reference, typeof to === "string" ? to : createPath(to));
            if (!next) return;
            const entry = { href: next, state, key: crypto.randomUUID() };
            setHistory((previous) => {
                const entries = previous.entries.slice(0, previous.index + (replace ? 0 : 1));
                entries.push(entry);
                return { entries, index: entries.length - 1 };
            });
        }
        return {
            createHref: () => `#${anchor}`,
            push: (to, state) => move(to, state, false),
            replace: (to, state) => move(to, state, true),
            go: (delta) => {
                if (!signal.aborted)
                    setHistory((previous) => ({
                        ...previous,
                        index: Math.max(0, Math.min(previous.entries.length - 1, previous.index + delta)),
                    }));
            },
        };
    }, [anchor, reference, signal]);
    const entry = history.entries[history.index];
    return (
        <div id={anchor}>
            <UNSAFE_NavigationContext.Provider value={{ ...baseNavigation, basename: "/", navigator }}>
                <UNSAFE_RouteContext.Provider value={rootRoute}>
                    <Routes location={{ ...parsePath(entry.href), key: entry.key, state: entry.state }}>
                        <Route path="/resources/environments" element={<EnvironmentPage />} />
                        <Route path="/resources/fixtures" element={<ResourcePage fixedKind="FIXTURE" />} />
                        <Route path={datasetListPath} element={<ResourcePage fixedKind="DATASET" />} />
                        <Route path={datasetDetailRoute} element={<DatasetFormDetail />} />
                        <Route path="/workspaces" element={<WorkspacePage capability={reference.capability} />} />
                        <Route
                            path="/execution-plans"
                            element={<ExecutionPlansPage capability={reference.capability} />}
                        />
                        <Route path="/runtimes" element={<RuntimePage capability={reference.capability} />} />
                        <Route
                            path="/notifications"
                            element={
                                <InboxProvider
                                    parentSignal={signal}
                                    liveUpdates={nativeReportAdapter ? "poll" : "stream"}
                                >
                                    <NotificationsPage />
                                </InboxProvider>
                            }
                        />
                        <Route
                            path="/reports"
                            element={
                                <>
                                    {reference.capability === "NOTIFICATION_INBOX" && (
                                        <Link to="/notifications">{tx("Back to notifications")}</Link>
                                    )}
                                    <ReportPage
                                        reportAdapter={nativeReportAdapter}
                                        initialAuditOpen={reference.capability === "WORKSPACE_AUDIT"}
                                    />
                                </>
                            }
                        />
                    </Routes>
                </UNSAFE_RouteContext.Provider>
            </UNSAFE_NavigationContext.Provider>
        </div>
    );
}
