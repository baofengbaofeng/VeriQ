/**
 * 服务端外壳只为本次登录维护一份成员空间目录。选中项的取消信号和查询缓存仍由原有作用域提供，
 * 因此普通换页保留选择，切换账户则随 Provider 一并销毁目录及目标授权结果。
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { Auth } from "../../auth-context";
import { api, type Workspace } from "../../api";
import { tx } from "../../locale";
import { useWorkspace } from "./WorkspaceContext";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const linkedRoutes = ["/reports", "/agent", "/execution-plans"];
type Directory = {
    items: Workspace[];
    workspace?: Workspace;
    requested: string;
    loading: boolean;
    error: Error | null;
    nextCursor?: string | null;
    loadingMore: boolean;
    pagingError: boolean;
    more: () => void;
    retry: () => void;
    choose: (id: string) => void;
    created: (workspace: Workspace) => void;
};
const DirectoryContext = createContext<Directory | null>(null);

/**
 * Web 页面从同一目录读取经过成员接口确认的空间对象，桌面仍可直接向共享业务视图传入自己的适配器。
 */
export function useWorkspaceDirectory() {
    const value = useContext(DirectoryContext);
    if (!value) throw new Error("Workspace directory is unavailable");
    return value;
}

/**
 * 普通选择沿用已加载的目录页；深链接另取目标详情，避免在尚未判明成员身份时挂载旧空间的业务视图。
 */
export function WorkspaceDirectory({ children }: { children: ReactNode }) {
    const { user } = useContext(Auth);
    const { selected, select } = useWorkspace();
    const client = useQueryClient();
    const location = useLocation();
    const navigate = useNavigate();
    const superseded = useRef<string>();
    const previousPath = useRef(location.pathname);
    const params = new URLSearchParams(location.search);
    const raw = params.get("workspaceId") ?? "";
    const linked = linkedRoutes.some((path) => matchPath(path, location.pathname));
    const candidate = linked && superseded.current !== location.key && uuid.test(raw) ? raw.toLowerCase() : "";
    const directory = useInfiniteQuery({
        queryKey: ["workspaces", user?.id],
        queryFn: ({ pageParam, signal }) => api.workspaces(pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        enabled: !!user,
    });
    const { refetch } = directory;
    useEffect(() => {
        if (previousPath.current !== location.pathname && user) void refetch();
        previousPath.current = location.pathname;
    }, [location.pathname, refetch, user]);
    const items = directory.data?.pages.flatMap((page) => page.items) ?? [];
    const requested =
        matchPath("/reports", location.pathname) &&
        !uuid.test(params.get("runId") ?? "") &&
        !items.some((item) => item.id === candidate)
            ? ""
            : candidate;
    const listed = items.find((item) => item.id === selected);
    const target = useQuery({
        queryKey: ["workspace-link", user?.id, location.key, requested],
        queryFn: ({ signal }) => api.workspace(requested, signal),
        enabled: !!user && !!requested,
        refetchOnMount: "always",
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });
    const retained = useQuery({
        queryKey: ["directory-entry", user?.id, selected],
        queryFn: ({ signal }) => api.workspace(selected, signal),
        enabled: !!user && !!selected && !listed && !requested,
    });
    const authorized =
        target.isSuccess && target.isFetchedAfterMount && target.fetchStatus === "idle" ? target.data : undefined;
    const first = items[0]?.id;
    useLayoutEffect(() => {
        if (requested) {
            if (superseded.current !== location.key && authorized?.id === requested) {
                client.setQueryData(["directory-entry", user?.id, requested], authorized);
                select(requested);
            }
        } else if (!selected && first) select(first);
    }, [requested, location.key, authorized, select, selected, first, user?.id, client]);
    const workspace = requested
        ? selected === requested
            ? authorized
            : undefined
        : (listed ?? (retained.isSuccess ? retained.data : undefined));
    if (workspace && !items.some((item) => item.id === workspace.id)) items.push(workspace);

    // 先标记此历史条目的选中意图已失效，再更新作用域并清理目标参数；慢响应不能在地址替换提交前抢回选择。
    function choose(id: string) {
        if (linked && (params.has("workspaceId") || params.has("runId") || params.has("planId"))) {
            superseded.current = location.key;
            for (const key of ["workspaceId", "runId", "planId"]) params.delete(key);
            void navigate(
                { pathname: location.pathname, search: params.toString(), hash: location.hash },
                { replace: true },
            );
        }
        select(id);
    }
    function created(item: Workspace) {
        client.setQueryData(["directory-entry", user?.id, item.id], item);
        choose(item.id);
        void client.invalidateQueries({ queryKey: ["workspaces", user?.id] });
    }
    const lookup = requested ? target : retained;
    return (
        <DirectoryContext.Provider
            value={{
                workspace,
                requested,
                items,
                choose,
                created,
                loading: !!user && !workspace && (directory.isPending || lookup.fetchStatus !== "idle"),
                error:
                    (requested || (!listed && selected) ? lookup.error : null) ??
                    (directory.isFetchNextPageError ? null : directory.error),
                nextCursor: directory.data?.pages.at(-1)?.nextCursor,
                pagingError: directory.isFetchNextPageError,
                loadingMore: directory.isFetchingNextPage,
                more: () => void directory.fetchNextPage(),
                retry: () => {
                    if (lookup.error) void lookup.refetch();
                    if (directory.error) void directory.refetch();
                },
            }}
        >
            {children}
        </DirectoryContext.Provider>
    );
}

/**
 * 工作区页面共用加载、失败与空目录反馈，重试仍指向实际失败的成员目录或目标授权请求。
 */
export function WorkspaceStatus() {
    const { workspace, loading, error, retry } = useWorkspaceDirectory();
    if (error)
        return (
            <div role="alert">
                {error.message}{" "}
                <button type="button" onClick={retry}>
                    {tx("Retry Workspaces")}
                </button>
            </div>
        );
    if (loading) return <p role="status">{tx("Loading Workspaces…")}</p>;
    if (!workspace) return <p>{tx("No Workspaces yet.")}</p>;
    return null;
}
