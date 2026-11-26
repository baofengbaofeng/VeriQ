/**
 * 数据集详情链接同时携带资源和工作区标识，列表、导航和授权目录共用相同路径，刷新时仍能确认所属空间。
 */

/**
 * 资源页、面包屑和切换工作区时的返回目标共用列表路径，统一当前侧栏选中项及真实导航链接。
 */
export const datasetListPath = "/resources/datasets";

/**
 * 详情路由由识别列表子路径的调用方共用，实际请求前仍需独立校验资源与工作区两个标识。
 */
export const datasetDetailRoute = `${datasetListPath}/:datasetId`;

/**
 * 详情入口只接收服务返回的资源与工作区标识，显式编码后由目录在视图挂载前验证工作区成员身份。
 */
export function datasetDetailHref(workspaceId: string, datasetId: string) {
    return `${datasetListPath}/${encodeURIComponent(datasetId)}?workspaceId=${encodeURIComponent(workspaceId)}`;
}

/**
 * 列表返回位置属于当前工作区及本次导航，浏览器历史条目只携带页面视图参数，不参与数据读取授权。
 */
export type DatasetListPosition = {
    workspaceId: string;
    search: string;
    status: string;
    page: number;
    pageSize: number;
};

/**
 * 从详情返回时恢复匹配工作区的列表位置。直接打开详情和切换到其它空间时仍使用该列表的默认参数。
 */
export function restoreDatasetListPosition(state: unknown, workspaceId: string): DatasetListPosition | undefined {
    if (!state || typeof state !== "object") return;
    const position = state as Partial<DatasetListPosition>;
    if (
        position.workspaceId === workspaceId &&
        typeof position.search === "string" &&
        typeof position.status === "string" &&
        typeof position.page === "number" &&
        Number.isSafeInteger(position.page) &&
        position.page > 0 &&
        typeof position.pageSize === "number" &&
        [5, 10, 20, 50].includes(position.pageSize)
    )
        return {
            workspaceId,
            search: position.search,
            status: position.status,
            page: position.page,
            pageSize: position.pageSize,
        };
}
