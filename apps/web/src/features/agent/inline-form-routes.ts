/**
 * 内嵌页只接受当前能力的产品路径与明确支持的查询参数，忽略浏览器全局历史。数据集返回列表时补回固定工作区。
 */
import { datasetListPath } from "../resources/dataset-routes";
import { formDestination, type WorkspaceFormReference } from "./workspace-forms";

type RouteScope = Pick<WorkspaceFormReference, "workspaceId" | "capability">;
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const base = "https://inline.invalid";

export function inlineFormPath(scope: RouteScope, href: string): string | undefined {
    const destination = formDestination({ type: "OPEN_WORKSPACE_FORM", ...scope }, "web");
    if (destination?.platform !== "web" || !href.startsWith("/") || /[\\#\s]/.test(href) || href.startsWith("//"))
        return;
    const target = new URL(href, base);
    const entry = new URL(destination.href, base);
    if (scope.capability === "NOTIFICATION_INBOX" && target.pathname === "/reports") {
        const query = target.searchParams;
        if (
            query.size !== 2 ||
            query.get("workspaceId") !== scope.workspaceId ||
            !uuid.test(query.get("runId") ?? "")
        ) {
            return;
        }
        return target.pathname + target.search;
    }
    const dataset =
        scope.capability === "HTTP_DATASET" &&
        target.pathname.startsWith(`${datasetListPath}/`) &&
        uuid.test(target.pathname.slice(datasetListPath.length + 1));
    if (target.origin !== base || (target.pathname !== entry.pathname && !dataset)) return;
    const query = target.searchParams;
    const extra =
        scope.capability === "NOTIFICATION_INBOX"
            ? "notificationId"
            : entry.pathname === "/reports"
              ? "runId"
              : undefined;
    for (const [key, value] of query) {
        if (query.getAll(key).length !== 1) return;
        if (key === extra && uuid.test(value)) continue;
        if (!entry.searchParams.has(key) || entry.searchParams.get(key) !== value) return;
    }
    if (entry.searchParams.get("tab") !== query.get("tab")) return;
    for (const [key, value] of entry.searchParams) query.set(key, value);
    return target.pathname + target.search;
}
