/**
 * 资源页：Workspace 下列表、创建、草稿编辑、校验作业轮询与发布；可被桌面复用编辑器视图。归档资源默认只读；桌面宿主可嵌
 * 入同一编辑器且归档资源只读。
 * CloudResourceAdapter(selected)；桌面可注入 LocalResourceAdapter。
 */

import { ResourceSelectField, ResourceSelectItem, ResourceSelect } from "./ResourceSelect";
import { tx, useAppLocale } from "../../locale";
import {
    Fragment,
    useId,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent,
    type ReactNode,
    type RefObject,
} from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from "@tanstack/react-table";
import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import { validateSchema, type DatasetV2, type ResourceDocumentV1, type ResourceKind } from "@veriq/contracts";
import { Section } from "@veriq/ui";
import { ConfirmDialog } from "../../locale-ui";
import { api, ApiError, type Workspace } from "../../api";
import { Auth } from "../../auth-context";
import { Panel } from "../../ui";
import { Button, Field, Select, SelectItem, Sheet, Tooltip } from "../../components";
import adminIcons from "../../admin-icons.svg?no-inline";
import { useWorkspaceDirectory, WorkspaceStatus } from "../workspaces/WorkspaceDirectory";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { SettingsPanel, SettingsTabList } from "../workspaces/SettingsTabs";
import { WorkspaceTableFilters } from "../workspaces/WorkspaceTableFilters";
import { useOperationFeedback, type PendingOperation } from "../../operation-feedback";
import { useRequestLifetime } from "../../request-lifetime";
import { canExportWorkspaceTable, collectTablePages, DataTable, useTableView } from "../../table-view";
import {
    CloudResourceAdapter,
    type ResourceAdapter,
    type Resource,
    type Draft,
    type Version,
    type Receipt,
    type Job,
} from "./adapters";
import { formJson } from "./dataset-import";
import { ImportRows } from "./DatasetImportRows";
import { datasetDetailHref, restoreDatasetListPosition, type DatasetListPosition } from "./dataset-routes";
import {
    ResourceForms,
    datasetCreationFormats,
    defaultDatasetCreationFormat,
    newDocument,
    resourceKinds,
    type DatasetCreationFormat,
} from "./ResourceForms";
import { Monaco, MonacoDiff } from "./Monaco";
import { useEditorTranslationOptions } from "./i18n";
import type { EditorValues, VersionOption } from "./fields";
import "./resources.css";
import "./resource-console.css";
const clean = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
type ValidationCandidate = Pick<
    Receipt,
    "workspaceId" | "resourceId" | "jobId" | "revision" | "sourceHash" | "engineVersion"
> & { documentHash: string; generation: number; showReceiptDetails: boolean };
/**
 * 自动发布只接收本次编译代次的回执，等待期间一旦草稿快照或权限发生变化，拒绝当前请求并停止发布。
 */
type PublicationWaiter = {
    generation: number;
    revision: Draft["revision"];
    documentHash: Draft["documentHash"];
    resolve: (receipt: Receipt) => void;
    reject: (reason: unknown) => void;
};
const receiptMatchesCandidate = (receipt: Receipt, candidate: ValidationCandidate) =>
    receipt.workspaceId === candidate.workspaceId &&
    receipt.resourceId === candidate.resourceId &&
    receipt.jobId === candidate.jobId &&
    receipt.revision === candidate.revision &&
    receipt.sourceHash === candidate.sourceHash &&
    receipt.engineVersion === candidate.engineVersion;
const matchesResource = (resource: Resource, query: string) =>
    resource.name.toLowerCase().includes(query) || resource.key.toLowerCase().includes(query);
const allResourceStatuses = "ALL";
const resourceStatuses = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
const datasetDialogSelect = "vq-dataset-dialog-select";
const schemas: Record<ResourceKind, string> = {
    CASE: "CaseDslV1",
    ELEMENT_CATALOG: "ElementCatalogV1",
    ASSERTION_TEMPLATE: "AssertionTemplateV1",
    DATASET: "DatasetDocument",
    FLOW: "FlowV1",
    FIXTURE: "FixtureV1",
    SUITE: "SuiteV1",
    ENVIRONMENT: "EnvironmentV1",
};
const editableRole = (workspace: Workspace, kind: ResourceKind) =>
    !workspace.archived &&
    (kind === "ENVIRONMENT"
        ? ["OWNER", "ADMIN"].includes(workspace.role)
        : ["OWNER", "ADMIN", "EDITOR"].includes(workspace.role));
/**
 * 只挂载持有当前信号的视图，开发模式重放或父边界变更后重新提交查询，旧请求始终保留已关闭的信号。
 */
function ResourceLifetime({
    parent,
    fallback,
    children,
}: {
    parent?: AbortSignal;
    fallback?: ReactNode;
    children: (signal: AbortSignal) => ReactNode;
}) {
    const lifetime = useRequestLifetime(parent);
    return lifetime ? <Fragment key={lifetime.generation}>{children(lifetime.signal)}</Fragment> : fallback;
}
/**
 * 资源入口由路由固定类型或提供聚合筛选，切换菜单及工作区时重新建立视图，旧表单和在途操作随原视图退出。
 */
export function ResourcePage({ fixedKind }: { fixedKind?: ResourceKind }) {
    useAppLocale();
    const { user } = useContext(Auth),
        { workspace } = useWorkspaceDirectory(),
        { t } = useTranslation(undefined, useEditorTranslationOptions);
    if (!user) return <Navigate to="/login" />;
    const library = fixedKind !== "ELEMENT_CATALOG";
    const view = workspace && (
        <CloudWorkspace
            key={`${user.id}:${workspace.id}:${fixedKind ?? "all"}`}
            workspace={workspace}
            library={library}
            fixedKind={fixedKind}
        />
    );
    if (workspace && library)
        return (
            <section className="panel">
                <WorkspaceStatus />
                {view}
            </section>
        );
    return (
        <Panel title={t(resourceTitle(fixedKind))}>
            <WorkspaceStatus />
            {view}
        </Panel>
    );
}

const datasetIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * 独立数据集详情沿用管理台的工作区授权。在目录验证分享链接的工作区之前，不读取资源头也不挂载旧空间的草稿。
 */
export function DatasetDetailPage() {
    useAppLocale();
    const { user } = useContext(Auth);
    const { datasetId = "" } = useParams();
    const { workspace, requested } = useWorkspaceDirectory();
    const { signal } = useWorkspace();
    if (!user) return <Navigate to="/login" />;
    if (!datasetIdPattern.test(datasetId))
        return (
            <Panel title="Dataset details">
                <p role="alert">{tx("Dataset not found.")}</p>
            </Panel>
        );
    if (!workspace || workspace.id !== requested)
        return (
            <Panel title="Dataset details">
                <WorkspaceStatus />
            </Panel>
        );
    return (
        <ResourceLifetime parent={signal} fallback={<Panel title="Dataset details">{tx("Loading…")}</Panel>}>
            {(lifetime) => (
                <DatasetDetail
                    key={`${workspace.id}:${datasetId}`}
                    workspace={workspace}
                    id={datasetId.toLowerCase()}
                    signal={lifetime}
                />
            )}
        </ResourceLifetime>
    );
}

function DatasetDetail({ workspace, id, signal }: { workspace: Workspace; id: string; signal: AbortSignal }) {
    const client = useQueryClient();
    const adapter = useMemo(() => new CloudResourceAdapter(workspace.id), [workspace.id]);
    const queryKey = ["workspace", workspace.id, "resource", id];
    const header = useQuery({
        queryKey,
        queryFn: async ({ signal: querySignal }) => {
            const resource = await adapter.resource(id, AbortSignal.any([signal, querySignal]));
            // 只有路径指定的资源类型、标识和工作区都匹配时才读取草稿，即使元数据读取本身已经通过成员鉴权。
            if (resource.kind !== "DATASET" || resource.id !== id || resource.workspaceId !== workspace.id)
                throw new Error("Dataset not found.");
            return resource;
        },
    });
    const heading = useRef<HTMLHeadingElement>(null);
    useLayoutEffect(() => heading.current?.focus({ preventScroll: true }), []);
    const resource = header.data;
    const denied = header.error instanceof ApiError && [401, 403, 404].includes(header.error.status);
    const feedback = header.error && <ErrorState error={header.error} retry={() => void header.refetch()} />;
    return (
        <section className="panel">
            <div className="vq-resources" data-console>
                <div className="vq-page-heading">
                    <h1 ref={heading} tabIndex={-1}>
                        {resource && !denied ? resource.name : tx("Dataset details")}
                    </h1>
                </div>
                {!resource || denied ? (
                    (feedback ?? <p role="status">{tx("Loading…")}</p>)
                ) : (
                    <>
                        <DraftLoader
                            workspace={workspace}
                            resource={resource}
                            adapter={adapter}
                            signal={signal}
                            refresh={() => client.invalidateQueries({ queryKey: ["workspace", workspace.id] })}
                            onResource={(next) => client.setQueryData(queryKey, next)}
                            webConsole
                            standalone
                        />
                        {feedback}
                    </>
                )}
            </div>
        </section>
    );
}

function CloudWorkspace({
    library = false,
    workspace,
    fixedKind,
}: {
    workspace: Workspace;
    library?: boolean;
    fixedKind?: ResourceKind;
}) {
    useAppLocale();
    const adapter = useMemo(() => new CloudResourceAdapter(workspace.id), [workspace.id]),
        { signal } = useWorkspace(),
        navigate = useNavigate(),
        { state } = useLocation();
    const datasets = fixedKind === "DATASET";
    return (
        <ResourceWorkspaceView
            workspace={workspace}
            adapter={adapter}
            signal={signal}
            fixedKind={fixedKind}
            library={library}
            webConsole
            datasetPosition={datasets ? restoreDatasetListPosition(state, workspace.id) : undefined}
            openDataset={
                datasets
                    ? (id, position) =>
                          void navigate(datasetDetailHref(workspace.id, id), {
                              state: position,
                          })
                    : undefined
            }
        />
    );
}
/**
 * 已选和未选工作区时复用同一个标题映射，执行环境保留侧栏采用的名称，普通资源页沿用各自的类型名称。
 */
function resourceTitle(kind?: ResourceKind) {
    return kind === "ENVIRONMENT" ? "environments" : kind ? `kinds.${kind}` : "resources";
}
// 夹具和断言用同一个面向用户的名称贯穿创建页与详情标题，保存和草稿校验继续读取契约枚举值。
const usesLocalizedHeading = (kind?: ResourceKind) => kind === "FIXTURE" || kind === "ASSERTION_TEMPLATE";
type ResourceWorkspaceViewProps = {
    workspace: Workspace;
    adapter: ResourceAdapter;
    signal?: AbortSignal;
    library?: boolean;
    workspaceControls?: React.ReactNode;
    fixedKind?: ResourceKind;
    webConsole?: boolean;
    datasetPosition?: DatasetListPosition;
    openDataset?: (id: string, position: DatasetListPosition) => void;
};

/**
 * 按工作区读取资源表并管理创建和编辑。Web 专页绑定当前类型，元素目录和桌面入口继续使用行内创建与标识入口。
 * 确认创建结果后打开新的编辑抽屉，退出时将焦点还给列表入口；桌面沿用宿主已有的抽屉档位与页面布局。
 */
export function ResourceWorkspaceView(props: ResourceWorkspaceViewProps) {
    return (
        <ResourceLifetime parent={props.signal}>
            {(signal) => <ResourceWorkspaceContent {...props} signal={signal} />}
        </ResourceLifetime>
    );
}

function ResourceWorkspaceContent({
    workspaceControls,
    library = workspaceControls !== undefined,
    workspace,
    adapter,
    signal,
    fixedKind,
    webConsole = false,
    datasetPosition,
    openDataset,
}: ResourceWorkspaceViewProps & { signal: AbortSignal }) {
    const { language } = useAppLocale();
    const client = useQueryClient(),
        { t } = useTranslation(undefined, useEditorTranslationOptions);
    const { showSuccess, showFailure } = useOperationFeedback();
    const [creating, setCreating] = useState(false);
    const datasetToolbar = webConsole && fixedKind === "DATASET";
    const createInDialog = library && datasetToolbar;
    const creatingPage = creating && !createInDialog;
    const heading = useRef<HTMLHeadingElement>(null);
    const newResource = useRef<HTMLButtonElement>(null);
    const copyDatasetButton = useRef<HTMLButtonElement>(null);
    const createName = useRef<HTMLInputElement>(null);
    const createRequest = useRef(false);
    const copyRequest = useRef(false);
    const createdDataset = useRef<Resource | null>(null);
    const copiedResource = useRef<Resource | null>(null);
    const writeScope = useRef({ workspace, adapter, signal });
    // 工作区归档或角色变化可能保留同一个页面实例，操作确认及复制抽屉关闭时必须读取最新提交的页面权限。
    useLayoutEffect(() => {
        writeScope.current = { workspace, adapter, signal };
    }, [workspace, adapter, signal]);
    function canWrite(kind: ResourceKind) {
        const current = writeScope.current;
        return (
            !signal.aborted &&
            current.signal === signal &&
            current.workspace.id === workspace.id &&
            current.adapter === adapter &&
            !current.adapter.readOnly &&
            editableRole(current.workspace, kind)
        );
    }
    // 主动返回时焦点交回新建按钮；提交成功紧接着打开编辑抽屉，避免在抽屉接管焦点后再次争抢。
    const returnToList = useRef(false);
    useLayoutEffect(() => {
        if (creatingPage) heading.current?.focus();
        else if (returnToList.current) {
            returnToList.current = false;
            newResource.current?.focus();
        }
    }, [creatingPage]);
    const keyFieldId = useId();
    const nameFieldId = useId();
    const kindFieldId = useId();
    const formatFieldId = useId();
    const kindFilterId = useId();
    const statusFilterId = useId();
    const [filterKind, setFilterKind] = useState<ResourceKind | "">(""),
        [datasetFormat, setDatasetFormat] = useState<DatasetCreationFormat>(defaultDatasetCreationFormat),
        [selectedCreateKind, setSelectedCreateKind] = useState<ResourceKind>("CASE"),
        [key, setKey] = useState(""),
        [name, setName] = useState(""),
        [copying, setCopying] = useState(false),
        [copyBusy, setCopyBusy] = useState(false),
        [selected, setSelected] = useState<Resource | null>(null),
        [statusFilter, setStatusFilter] = useState<string>(
            resourceStatuses.find((status) => status === datasetPosition?.status) ?? "",
        ),
        [busy, setBusy] = useState(false);
    // 只有聚合入口允许筛选和切换新建类型；专页的查询键及提交正文均直接使用路由提供的固定类型。
    const kind = fixedKind ?? filterKind;
    const createKind = fixedKind ?? selectedCreateKind;
    const resources = useQuery({
        queryKey: ["workspace", workspace.id, "resources", kind],
        queryFn: ({ signal: querySignal }) =>
            collectTablePages(
                (cursor, request) => adapter.list(kind || undefined, cursor, request),
                AbortSignal.any([signal, querySignal]),
            ),
    });
    // 列表请求只传资源类型，按游标读取当前类型的完整记录后再筛选名称、标识和状态，使后续页也参加匹配。
    const items = useMemo(
        () => (resources.data ?? []).filter((resource) => !statusFilter || resource.status === statusFilter),
        [resources.data, statusFilter],
    );
    const view = useTableView(items, {
        matches: matchesResource,
        scope: `${workspace.id}:${kind}`,
        pageSize: datasetPosition?.pageSize,
        initial: datasetPosition,
    });
    const listPosition = useMemo<DatasetListPosition>(
        () => ({
            workspaceId: workspace.id,
            status: statusFilter,
            search: view.search,
            page: view.page,
            pageSize: view.pageSize,
        }),
        [statusFilter, view.page, view.pageSize, view.search, workspace.id],
    );
    const selectStatus = (value: string) => {
        setStatusFilter(value);
        view.setPage(1);
    };
    const refresh = () => client.invalidateQueries({ queryKey: ["workspace", workspace.id] });
    const datasetColumns = useMemo(() => {
        // 表格和 CSV 共享同一套摘要文案与格式化规则，使下载始终与可见列对应，并沿用界面的语言和时区。
        const locale = language === "zh" ? "zh-CN" : "en";
        const number = new Intl.NumberFormat(locale);
        const missing = "—";
        return {
            format: {
                label: t("datasetList.format"),
                value: ({ datasetSummary }: Resource) =>
                    datasetSummary ? t(`datasetList.formats.${datasetSummary.format}`) : missing,
            },
            size: {
                label: t("datasetList.size"),
                value: ({ datasetSummary }: Resource) => {
                    if (!datasetSummary) return missing;
                    const { fieldCount, entryCount, format } = datasetSummary;
                    const fields = t("datasetList.fields", { count: fieldCount, number: number.format(fieldCount) });
                    // 动态来源显示声明字段数和动态标记，静态来源按表行或树节点显示数量，零条也使用相应计数。
                    const entries =
                        entryCount === undefined
                            ? t("datasetList.dynamic")
                            : t(format === "STATIC_TREE" ? "datasetList.nodes" : "datasetList.rows", {
                                  count: entryCount,
                                  number: number.format(entryCount),
                              });
                    return `${fields} · ${entries}`;
                },
            },
            lastSaved: {
                label: t("datasetList.lastSaved"),
                value: ({ datasetSummary }: Resource) =>
                    datasetSummary
                        ? new Date(datasetSummary.lastSavedAt).toLocaleString(locale, { timeZone: "Asia/Shanghai" })
                        : missing,
            },
            pending: t("datasetList.pending"),
        };
    }, [language, t]);
    const columns = useMemo<ColumnDef<Resource>[]>(() => {
        const firstKey = library ? "name" : "key";
        const secondKey = library ? "key" : "name";
        const datasetActions = fixedKind === "DATASET";
        const cols: ColumnDef<Resource>[] = [
            {
                header: t(library ? "columnName" : "columnKey"),
                accessorKey: firstKey,
                cell: (info) => {
                    const value = String(info.getValue());
                    const open = datasetActions ? undefined : () => setSelected(info.row.original);
                    if (webConsole)
                        return (
                            <ResourceTableValue
                                value={value}
                                label={t(library ? "columnName" : "columnKey")}
                                open={open}
                            />
                        );
                    return open ? (
                        <Button tone="secondary" onClick={open}>
                            {value}
                        </Button>
                    ) : (
                        value
                    );
                },
            },
            {
                header: t(library ? "columnKey" : "columnName"),
                accessorKey: secondKey,
                cell: (info) => {
                    const value = String(info.getValue());
                    return webConsole ? (
                        <ResourceTableValue value={value} label={t(library ? "columnKey" : "columnName")} />
                    ) : (
                        value
                    );
                },
            },
        ];
        if (!fixedKind || fixedKind === "ELEMENT_CATALOG")
            cols.push({
                header: t("columnKind"),
                accessorKey: "kind",
                cell: (info) => (webConsole || library ? t(`kinds.${info.row.original.kind}`) : info.row.original.kind),
            });
        if (datasetToolbar)
            cols.push(
                {
                    id: "datasetFormat",
                    header: datasetColumns.format.label,
                    cell: ({ row }) => datasetColumns.format.value(row.original),
                },
                {
                    id: "datasetSize",
                    header: datasetColumns.size.label,
                    cell: ({ row }) => datasetColumns.size.value(row.original),
                },
            );
        cols.push({
            header: t("columnStatus"),
            accessorKey: "status",
            cell: (info) =>
                webConsole || library ? (
                    <>
                        <span className="vq-state" data-status={info.row.original.status}>
                            {t(`statuses.${info.row.original.status}`)}
                        </span>
                        {datasetToolbar && info.row.original.datasetSummary?.hasUnpublishedChanges && (
                            <span className="vq-dataset-pending">{datasetColumns.pending}</span>
                        )}
                    </>
                ) : (
                    info.row.original.status
                ),
        });
        if (datasetToolbar)
            cols.push({
                id: "datasetLastSaved",
                header: datasetColumns.lastSaved.label,
                cell: ({ row }) => {
                    const text = datasetColumns.lastSaved.value(row.original);
                    const savedAt = row.original.datasetSummary?.lastSavedAt;
                    return savedAt ? <time dateTime={savedAt}>{text}</time> : text;
                },
            });
        if (datasetActions)
            cols.push({
                id: "actions",
                header: tx("Actions"),
                cell: ({ row }) => {
                    const resource = row.original;
                    if (openDataset)
                        return (
                            <Link
                                className="vq-dataset-details-link"
                                to={datasetDetailHref(resource.workspaceId, resource.id)}
                                state={listPosition}
                                aria-label={t("detailsLabel", { name: resource.name, key: resource.key })}
                            >
                                {tx("Details")}
                            </Link>
                        );
                    return (
                        <Button
                            tone={webConsole ? "ghost" : "secondary"}
                            size={webConsole ? "compact" : undefined}
                            aria-label={t("detailsLabel", { name: resource.name, key: resource.key })}
                            onClick={(event) => {
                                // 点击时主动聚焦实际触发键，确保没有自动聚焦按钮的浏览器也能在抽屉关闭后回到同一行。
                                event.currentTarget.focus({ preventScroll: true });
                                setSelected(resource);
                            }}
                        >
                            {tx("Details")}
                        </Button>
                    );
                },
            });
        return cols;
    }, [datasetColumns, datasetToolbar, fixedKind, library, listPosition, openDataset, t, webConsole]);
    const table = useReactTable({
        data: view.rows,
        columns,
        getCoreRowModel: getCoreRowModel(),
        // 资源标识维持列表中每行的身份，刷新与重新排序后，关闭编辑抽屉仍能回到原来触发操作的那一行。
        getRowId: (resource) => resource.id,
    });
    const filter = (
        <label htmlFor={kindFilterId}>
            {tx("筛选类型 / Filter kind")}
            <ResourceSelect
                id={kindFilterId}
                value={filterKind}
                onValueChange={(selection) => setFilterKind(selection as ResourceKind | "")}
            >
                <ResourceSelectItem value="">{tx("全部 / All")}</ResourceSelectItem>
                {resourceKinds.map((k) => (
                    <ResourceSelectItem key={k} value={k}>
                        {library ? t(`kinds.${k}`) : k}
                    </ResourceSelectItem>
                ))}
            </ResourceSelect>
        </label>
    );
    const listFilters = (
        <div className="vq-resource-filters">
            {!fixedKind && filter}
            <label htmlFor={statusFilterId}>
                {t("filterStatus")}
                <Select
                    id={statusFilterId}
                    aria-label={t("filterStatus")}
                    appearance="default-dropdown"
                    value={statusFilter || allResourceStatuses}
                    onValueChange={(value) => selectStatus(value === allResourceStatuses ? "" : value)}
                >
                    <SelectItem value={allResourceStatuses}>{tx("全部 / All")}</SelectItem>
                    {resourceStatuses.map((status) => (
                        <SelectItem key={status} value={status}>
                            {t(`statuses.${status}`)}
                        </SelectItem>
                    ))}
                </Select>
            </label>
        </div>
    );
    // 首次读取成功后显示列标题，后台刷新失败时保留已有的可见缓存行，空态依据已经成功读取的结果呈现。
    const rows = (
        <>
            {resources.isPending && <p role="status">{t("loading")}</p>}
            {resources.error && <ErrorState error={resources.error} retry={() => void resources.refetch()} />}
            {(resources.isSuccess || view.filteredCount > 0) && (
                <section
                    className="table-scroll vq-resource-table-scroll"
                    aria-label={t("resourceTable")}
                    tabIndex={webConsole ? 0 : undefined}
                >
                    <table>
                        <thead>
                            {table.getHeaderGroups().map((group) => (
                                <tr key={group.id}>
                                    {group.headers.map((h) => (
                                        <th key={h.id} scope="col">
                                            {flexRender(h.column.columnDef.header, h.getContext())}
                                        </th>
                                    ))}
                                </tr>
                            ))}
                        </thead>
                        <tbody>
                            {view.filteredCount === 0 && (
                                <tr>
                                    <td className="vq-table-empty" colSpan={table.getVisibleLeafColumns().length}>
                                        {t(resources.data?.length ? "noMatches" : "empty")}
                                    </td>
                                </tr>
                            )}
                            {table.getRowModel().rows.map((row) => (
                                <tr key={row.id}>
                                    {row.getVisibleCells().map((cell) => (
                                        <td key={cell.id}>
                                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}
        </>
    );
    const nameColumn = { label: t("columnName"), value: ({ name }: Resource) => name };
    const keyColumn = { label: t("columnKey"), value: ({ key }: Resource) => key };
    const exportColumns = library ? [nameColumn, keyColumn] : [keyColumn, nameColumn];
    if (!fixedKind || fixedKind === "ELEMENT_CATALOG")
        exportColumns.push({
            label: t("columnKind"),
            value: ({ kind }) => (webConsole || library ? t(`kinds.${kind}`) : kind),
        });
    if (datasetToolbar) exportColumns.push(datasetColumns.format, datasetColumns.size);
    exportColumns.push({
        label: t("columnStatus"),
        value: ({ status, datasetSummary }) => {
            const label = webConsole || library ? t(`statuses.${status}`) : status;
            return datasetToolbar && datasetSummary?.hasUnpublishedChanges
                ? `${label} · ${datasetColumns.pending}`
                : label;
        },
    });
    if (datasetToolbar) exportColumns.push(datasetColumns.lastSaved);
    const kindField = (
        <Field htmlFor={kindFieldId} label={tx("类型 / Kind")} required>
            <ResourceSelect
                id={kindFieldId}
                required
                value={selectedCreateKind}
                onValueChange={(selection) => setSelectedCreateKind(selection as ResourceKind)}
            >
                {resourceKinds.map((k) => (
                    <ResourceSelectItem key={k} value={k}>
                        {library ? t(`kinds.${k}`) : k}
                    </ResourceSelectItem>
                ))}
            </ResourceSelect>
        </Field>
    );
    const datasetFormatField = createKind === "DATASET" && (
        <Field htmlFor={formatFieldId} label={tx("Dataset format")} hint={t("datasetFormatHint")} required>
            <ResourceSelect
                id={formatFieldId}
                required
                value={datasetFormat}
                disabled={createInDialog && busy}
                contentClassName={createInDialog ? datasetDialogSelect : undefined}
                onValueChange={(selection) => setDatasetFormat(selection as DatasetCreationFormat)}
            >
                {Object.entries(datasetCreationFormats).map(([value, { label }]) => (
                    <ResourceSelectItem key={value} value={value}>
                        {tx(label)}
                    </ResourceSelectItem>
                ))}
            </ResourceSelect>
        </Field>
    );
    const canCopyDataset =
        !adapter.readOnly && editableRole(workspace, "DATASET") && (!fixedKind || fixedKind === "DATASET");
    const copyButton = canCopyDataset && (
        <Button
            ref={copyDatasetButton}
            tone="secondary"
            size={webConsole ? "compact" : undefined}
            aria-haspopup="dialog"
            onClick={() => setCopying(true)}
        >
            {t("copyDataset")}
        </Button>
    );
    const nameField = (
        <Field
            htmlFor={nameFieldId}
            label={t("columnName")}
            hint={t(createInDialog ? "datasetNameHint" : "nameHint")}
            required
        >
            <input
                id={nameFieldId}
                aria-label={t("columnName")}
                ref={createName}
                required
                disabled={createInDialog && busy}
                value={name}
                onChange={(e) => setName(e.target.value)}
            />
        </Field>
    );
    const keyField = (
        <Field
            htmlFor={keyFieldId}
            label={tx("Key")}
            hint={createInDialog ? t("datasetKeyHint") : undefined}
            longHint={createInDialog ? undefined : tx("Resource key format")}
            required
        >
            <input
                id={keyFieldId}
                aria-label={tx("Key")}
                required
                disabled={createInDialog && busy}
                pattern={String.raw`[A-Za-z_][A-Za-z0-9_\-]*`}
                value={key}
                onChange={(e) => setKey(e.target.value)}
            />
        </Field>
    );
    const submit = (
        <Button
            type="submit"
            size={webConsole ? "regular" : undefined}
            disabled={busy || !editableRole(workspace, createKind)}
        >
            {t("create")}
        </Button>
    );
    const resetCreateFields = () => {
        setKey("");
        setName("");
        setDatasetFormat(defaultDatasetCreationFormat);
    };
    const leave = () => {
        if (createRequest.current) return;
        returnToList.current = !createInDialog;
        setCreating(false);
        resetCreateFields();
    };
    /**
     * 结果确认后重新检查目录权限及资源所属空间，再由专页或共享抽屉打开编辑器，防止旧操作跳到已离开的工作区。
     */
    function announceDraft(resource: Resource, kind: ResourceKind, opener: RefObject<HTMLElement>, message: string) {
        showSuccess(message, () => {
            if (resource.workspaceId !== workspace.id || !canWrite(kind)) return;
            if (kind === "DATASET" && openDataset) {
                openDataset(resource.id, listPosition);
                return;
            }
            opener.current?.focus({ preventScroll: true });
            setSelected(resource);
        });
    }
    function setCopyPending(pending: boolean) {
        copyRequest.current = pending;
        setCopyBusy(pending);
    }
    // 页面、弹窗和桌面表单共用提交路径，当前请求完成前同步拒绝重复写入，只交付已经返回的新资源。
    const form = (
        <form
            className={
                createInDialog
                    ? "vq-workspace-form vq-workspace-compact-form"
                    : library
                      ? "vq-library-form"
                      : "vq-create"
            }
            aria-busy={createInDialog && busy ? true : undefined}
            onSubmit={(e) => {
                e.preventDefault();
                if (createRequest.current || !canWrite(createKind)) return;
                createRequest.current = true;
                setBusy(true);
                void adapter
                    .create(
                        {
                            kind: createKind,
                            key,
                            name,
                            content: newDocument(createKind, key, name, datasetFormat),
                        },
                        signal,
                    )
                    .then((resource) => {
                        signal.throwIfAborted();
                        if (createInDialog) createdDataset.current = resource;
                        else announceDraft(resource, createKind, newResource, t("created"));
                        setCreating(false);
                        resetCreateFields();
                        void refresh();
                    })
                    .catch((e) => {
                        if (!signal.aborted) showFailure(resourceErrorMessage(e));
                    })
                    .finally(() => {
                        createRequest.current = false;
                        if (!signal.aborted) setBusy(false);
                    });
            }}
        >
            {createInDialog ? (
                <>
                    {nameField}
                    {datasetFormatField}
                    {keyField}
                    <div className="vq-workspace-form-actions">
                        <Dialog.Close asChild>
                            <Button tone="secondary" size="regular" disabled={busy}>
                                {tx("Cancel")}
                            </Button>
                        </Dialog.Close>
                        {submit}
                    </div>
                </>
            ) : library ? (
                <>
                    <section className="vq-library-fields">
                        <h2>{tx("Basic information")}</h2>
                        <div>
                            {nameField}
                            {!fixedKind && kindField}
                            {datasetFormatField}
                            <div className="vq-resource-key">{keyField}</div>
                        </div>
                    </section>
                    <div className="vq-create-actions">
                        <Button
                            tone="secondary"
                            size={webConsole ? "regular" : undefined}
                            disabled={busy}
                            onClick={leave}
                        >
                            {tx("Back to list")}
                        </Button>
                        {submit}
                    </div>
                </>
            ) : (
                <>
                    {datasetFormatField}
                    {keyField}
                    {nameField}
                    {submit}
                </>
            )}
        </form>
    );
    const title = t(resourceTitle(fixedKind));
    const createLabel = fixedKind && fixedKind !== "ELEMENT_CATALOG" ? t(`newByKind.${fixedKind}`) : tx("New resource");
    const createTitle = usesLocalizedHeading(fixedKind) ? createLabel : tx("New resource");
    const createButton = !adapter.readOnly && (
        <Button
            ref={newResource}
            size={webConsole ? "compact" : undefined}
            disabled={!editableRole(workspace, fixedKind ?? "CASE")}
            aria-haspopup={createInDialog ? "dialog" : undefined}
            onClick={() => {
                if (!fixedKind) setSelectedCreateKind(kind && editableRole(workspace, kind) ? kind : "CASE");
                setCreating(true);
            }}
        >
            <span aria-hidden="true">＋</span> {createLabel}
        </Button>
    );
    const resourceTable = (
        <DataTable
            label={t("resourceTable")}
            view={view}
            searchLabel={t("searchResources")}
            paginationLabel={t("resourcePages")}
            filters={datasetToolbar ? undefined : listFilters}
            beforeDownload={
                datasetToolbar && (
                    <WorkspaceTableFilters
                        filters={[
                            {
                                label: t("columnStatus"),
                                value: statusFilter,
                                choices: [
                                    ["", tx("全部 / All")],
                                    ...resourceStatuses.map((status) => [status, t(`statuses.${status}`)] as const),
                                ],
                                onChange: selectStatus,
                            },
                        ]}
                        onReset={() => {
                            setStatusFilter("");
                            view.setSearch("");
                        }}
                    />
                )
            }
            busy={resources.isFetching || resources.isError}
            exportAllowed={canExportWorkspaceTable(workspace.role)}
            exportColumns={exportColumns}
        >
            {rows}
        </DataTable>
    );
    const copyForm = copying && (
        <DatasetCopyForm
            target={workspace.id}
            adapter={adapter}
            parent={signal}
            webConsole={webConsole}
            centered={createInDialog}
            canCopy={() => canWrite("DATASET")}
            onBusyChange={createInDialog ? setCopyPending : undefined}
            onCopied={(resource) => {
                copiedResource.current = resource;
                setCopying(false);
                void refresh();
            }}
        />
    );
    return (
        <div className="vq-resources" data-console={webConsole || undefined}>
            {library ? (
                <>
                    <div className="vq-page-heading">
                        <h1 ref={heading} tabIndex={-1}>
                            {creatingPage ? createTitle : title}
                        </h1>
                        {creatingPage && workspaceControls && (
                            <div className="vq-workspace-context">{workspaceControls}</div>
                        )}
                        {!creatingPage &&
                            (fixedKind === "DATASET" && canCopyDataset ? (
                                <div className="vq-create-actions">
                                    {copyButton}
                                    {createButton}
                                </div>
                            ) : (
                                createButton
                            ))}
                    </div>
                    {creatingPage ? (
                        form
                    ) : (
                        <>
                            {(workspaceControls || (!fixedKind && copyButton)) && (
                                <div className="vq-library-toolbar">
                                    {workspaceControls}
                                    {!fixedKind && copyButton}
                                </div>
                            )}
                            <section className="vq-library-table">{resourceTable}</section>
                        </>
                    )}
                </>
            ) : (
                <>
                    {resourceTable}
                    {copyButton}
                    {!adapter.readOnly && <Section title={t("create")}>{form}</Section>}
                </>
            )}
            {createInDialog && (
                <DatasetActionDialog
                    open={creating}
                    title={createLabel}
                    busy={busy}
                    initialFocus={createName}
                    onClose={leave}
                    onAfterClose={() => {
                        if (signal.aborted) return;
                        newResource.current?.focus({ preventScroll: true });
                        // 创建窗口先释放模态焦点，再显示操作结果，确认后由当前入口在正确的工作区打开刚创建的草稿。
                        const resource = createdDataset.current;
                        createdDataset.current = null;
                        if (resource) announceDraft(resource, "DATASET", newResource, t("created"));
                    }}
                >
                    {form}
                </DatasetActionDialog>
            )}
            {createInDialog ? (
                <DatasetActionDialog
                    open={canCopyDataset && copying}
                    title={t("copyDataset")}
                    busy={copyBusy}
                    onClose={() => {
                        if (!copyRequest.current) setCopying(false);
                    }}
                    onAfterClose={() => {
                        if (signal.aborted) return;
                        const opener = copyDatasetButton.current ?? heading.current;
                        opener?.focus({ preventScroll: true });
                        const resource = copiedResource.current;
                        copiedResource.current = null;
                        // 复制权限变化也会关闭对话框，因此关闭后统一清除复制状态，防止重新获权时自动打开先前的表单。
                        setCopying(false);
                        if (resource) announceDraft(resource, "DATASET", copyDatasetButton, t("copied"));
                    }}
                >
                    {canCopyDataset && copyForm}
                </DatasetActionDialog>
            ) : (
                canCopyDataset && (
                    <Sheet
                        open={copying}
                        onOpenChange={setCopying}
                        title={t("copyDataset")}
                        size={webConsole ? "third" : "default"}
                        resizable={webConsole}
                        onAfterClose={() => {
                            // 复制窗先归还焦点并释放模态范围，再打开目标草稿，连续使用键盘时不会被退出的抽屉抢回焦点。
                            const resource = copiedResource.current;
                            copiedResource.current = null;
                            if (resource?.workspaceId === workspace.id && canWrite("DATASET")) setSelected(resource);
                        }}
                    >
                        {copyForm}
                    </Sheet>
                )
            )}
            <Sheet
                open={!!selected}
                fallbackFocus={library ? newResource : undefined}
                onOpenChange={(open) => {
                    if (!open) setSelected(null);
                }}
                title={selected?.name ?? t("resources")}
                size={webConsole ? "third" : "wide"}
                resizable={webConsole}
            >
                {selected && (
                    <DraftLoader
                        key={selected.id}
                        resource={selected}
                        adapter={adapter}
                        workspace={workspace}
                        signal={signal}
                        refresh={refresh}
                        onResource={setSelected}
                        webConsole={webConsole}
                    />
                )}
            </Sheet>
        </div>
    );
}

/**
 * 资源名称与标识在单行内截断，键盘可从文本按钮打开完整值；主要名称已有详情动作时仍直接进入编辑器。
 */
function ResourceTableValue({ value, label, open }: { value: string; label: string; open?: () => void }) {
    const [element, setElement] = useState<HTMLElement | null>(null);
    const [truncated, setTruncated] = useState(false);
    // 只为确实截断的静态值添加打开全文的按钮，普通数据集名称仍是文本；改宽或切换字号时重新检查溢出。
    useLayoutEffect(() => {
        if (open || !element || element.textContent !== value) return;
        const update = () => setTruncated(element.scrollWidth > element.clientWidth);
        const resize = new ResizeObserver(update);
        update();
        resize.observe(element);
        return () => resize.disconnect();
    }, [element, open, value]);
    if (!open && !truncated)
        return (
            <span ref={setElement} className="vq-resource-table-value">
                {value}
            </span>
        );
    const trigger = (
        <Button
            ref={open ? undefined : setElement}
            tone="ghost"
            size="compact"
            className="vq-resource-table-value"
            title={value}
            onClick={open}
        >
            {value}
        </Button>
    );
    if (open) return trigger;
    return (
        <Dialog.Root>
            <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="vq-overlay" />
                <Dialog.Content className="vq-dialog vq-resource-value-dialog">
                    <Dialog.Title>{label}</Dialog.Title>
                    <Dialog.Description>{value}</Dialog.Description>
                    <Dialog.Close asChild>
                        <Button size="compact" tone="secondary">
                            {tx("Close")}
                        </Button>
                    </Dialog.Close>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
/**
 * 数据集列表上的新建和复制复用居中布局及关闭行为，子表单各自负责请求状态和关闭后应当恢复的焦点。
 */
function DatasetActionDialog({
    open,
    title,
    busy,
    initialFocus,
    onClose,
    onAfterClose,
    children,
}: {
    open: boolean;
    title: string;
    busy: boolean;
    initialFocus?: RefObject<HTMLElement>;
    onClose: () => void;
    onAfterClose: () => void;
    children: ReactNode;
}) {
    return (
        <Dialog.Root
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen) onClose();
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                <Dialog.Content
                    className="vq-dialog vq-workspace-dialog"
                    aria-describedby={undefined}
                    onOpenAutoFocus={(event) => {
                        if (!initialFocus?.current) return;
                        event.preventDefault();
                        initialFocus.current.focus();
                    }}
                    onEscapeKeyDown={(event) => {
                        if (busy) event.preventDefault();
                    }}
                    onPointerDownOutside={(event) => event.preventDefault()}
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        onAfterClose();
                    }}
                >
                    <div className="vq-card-heading">
                        <Dialog.Title>{title}</Dialog.Title>
                        <Dialog.Close className="vq-sheet-close" aria-label={tx("Close")} disabled={busy}>
                            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
                                <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.5" />
                            </svg>
                        </Dialog.Close>
                    </div>
                    {children}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

/**
 * 工作区列表按当前会话分页读取，只列出能够下载的来源工作区；版本查询和复制写入仍绑定目标适配器。
 * 搜索结果不含正文，提交时使用所选发布版本标识，由服务端重新检查两个工作区的授权。
 */
type DatasetCopyFormProps = {
    target: string;
    adapter: ResourceAdapter;
    parent: AbortSignal;
    webConsole: boolean;
    centered: boolean;
    canCopy: () => boolean;
    onBusyChange?: (busy: boolean) => void;
    onCopied: (resource: Resource) => void;
};

function DatasetCopyForm({ parent, ...props }: DatasetCopyFormProps) {
    return (
        <ResourceLifetime parent={parent}>
            {(signal) => <DatasetCopyFields {...props} signal={signal} />}
        </ResourceLifetime>
    );
}

function DatasetCopyFields({
    target,
    adapter,
    signal,
    webConsole,
    centered,
    canCopy,
    onBusyChange,
    onCopied,
}: Omit<DatasetCopyFormProps, "parent"> & { signal: AbortSignal }) {
    const { t } = useTranslation(undefined, useEditorTranslationOptions);
    const { showSuccess, showFailure } = useOperationFeedback();
    const sourceId = useId();
    const versionId = useId();
    const keyId = useId();
    const nameId = useId();
    const [source, setSource] = useState("");
    const [version, setVersion] = useState("");
    const [busy, setBusy] = useState(false);
    const request = useRef(false);
    const spaces = useInfiniteQuery({
        queryKey: ["workspace", target, "dataset-copy-workspaces"],
        queryFn: ({ pageParam, signal: qs }) => api.workspaces(pageParam, AbortSignal.any([qs, signal])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
        gcTime: 0,
    });
    const versions = useInfiniteQuery({
        queryKey: ["workspace", target, "dataset-copy-versions", source],
        queryFn: ({ pageParam, signal: qs }) =>
            adapter.listDatasetCopySources(source, pageParam, AbortSignal.any([qs, signal])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
        enabled: !!source,
        gcTime: 0,
    });
    const options = spaces.data?.pages.flatMap((p) => p.items).filter((w) => w.id !== target && w.role !== "VIEWER");
    const items = versions.data?.pages.flatMap((p) => p.items);
    const submit = (
        <Button type="submit" size={webConsole ? "regular" : undefined} disabled={busy || !version}>
            {t("copySubmit")}
        </Button>
    );
    return (
        <form
            className={
                centered
                    ? "vq-workspace-form vq-workspace-compact-form"
                    : webConsole
                      ? "vq-create vq-resource-copy"
                      : "vq-create"
            }
            aria-busy={centered && busy ? true : undefined}
            onSubmit={async (event) => {
                event.preventDefault();
                if (request.current || !source || !version || !canCopy()) return;
                const fields = new FormData(event.currentTarget);
                // 同步记录请求后再更新按钮状态，防止事件批处理前重复提交或通过退出键关闭仍在写入的复制窗。
                request.current = true;
                onBusyChange?.(true);
                setBusy(true);
                try {
                    const resource = await adapter.copyDataset(
                        {
                            sourceWorkspaceId: source,
                            sourceDatasetVersionId: version,
                            key: String(fields.get("key")),
                            name: String(fields.get("name")),
                        },
                        signal,
                    );
                    signal.throwIfAborted();
                    if (centered) onCopied(resource);
                    else {
                        showSuccess(t("copied"), () => {
                            if (!signal.aborted && canCopy()) onCopied(resource);
                        });
                    }
                } catch (reason) {
                    if (!signal.aborted) showFailure(resourceErrorMessage(reason));
                } finally {
                    request.current = false;
                    onBusyChange?.(false);
                    if (!signal.aborted) setBusy(false);
                }
            }}
        >
            <Field htmlFor={sourceId} label={t("copySource")} hint={t("copySourceHint")} required>
                <ResourceSelect
                    id={sourceId}
                    aria-label={t("copySource")}
                    required
                    disabled={busy}
                    contentClassName={centered ? datasetDialogSelect : undefined}
                    placeholder={tx("选择 / Select")}
                    value={source}
                    onValueChange={(selection) => {
                        setSource(selection);
                        setVersion("");
                    }}
                >
                    <ResourceSelectItem value="">{tx("选择 / Select")}</ResourceSelectItem>
                    {options?.map((w) => (
                        <ResourceSelectItem key={w.id} value={w.id}>
                            {w.name}
                        </ResourceSelectItem>
                    ))}
                </ResourceSelect>
            </Field>
            {spaces.hasNextPage && (
                <Button size={webConsole ? "compact" : undefined} onClick={() => void spaces.fetchNextPage()}>
                    {tx("更多空间 / More Workspaces")}
                </Button>
            )}
            {spaces.error && <ErrorState error={spaces.error} retry={() => void spaces.refetch()} />}
            <Field htmlFor={versionId} label={t("copyVersion")} hint={t("copyVersionHint")} required>
                <ResourceSelect
                    id={versionId}
                    aria-label={t("copyVersion")}
                    required
                    disabled={busy || !source}
                    contentClassName={centered ? datasetDialogSelect : undefined}
                    placeholder={tx("选择 / Select")}
                    value={version}
                    onValueChange={setVersion}
                >
                    <ResourceSelectItem value="">{tx("选择 / Select")}</ResourceSelectItem>
                    {items?.map((v) => (
                        <ResourceSelectItem key={v.versionId} value={v.versionId}>
                            {v.name} · {v.key} · v{v.versionNo}
                        </ResourceSelectItem>
                    ))}
                </ResourceSelect>
            </Field>
            {(spaces.isFetching || versions.isFetching) && <p role="status">{t("loading")}</p>}
            {versions.isSuccess && !items?.length && <p>{t("copyNoVersions")}</p>}
            {versions.hasNextPage && (
                <Button size={webConsole ? "compact" : undefined} onClick={() => void versions.fetchNextPage()}>
                    {tx("更多版本 / More versions")}
                </Button>
            )}
            {versions.error && <ErrorState error={versions.error} retry={() => void versions.refetch()} />}
            <Field
                htmlFor={keyId}
                label={t("columnKey")}
                hint={centered ? t("copyKeyHint") : undefined}
                longHint={centered ? undefined : t("copyKeyHint")}
                required
            >
                <input
                    id={keyId}
                    name="key"
                    aria-label={t("columnKey")}
                    required
                    disabled={busy}
                    maxLength={160}
                    pattern="[A-Za-z_][A-Za-z0-9_.\-]*"
                />
            </Field>
            <Field htmlFor={nameId} label={t("columnName")} hint={t("copyNameHint")} required>
                <input id={nameId} name="name" aria-label={t("columnName")} required disabled={busy} maxLength={160} />
            </Field>
            {centered ? (
                <div className="vq-workspace-form-actions">
                    <Dialog.Close asChild>
                        <Button tone="secondary" size="regular" disabled={busy}>
                            {tx("Cancel")}
                        </Button>
                    </Dialog.Close>
                    {submit}
                </div>
            ) : (
                submit
            )}
        </form>
    );
}

type DraftLoaderProps = {
    resource: Resource;
    adapter: ResourceAdapter;
    workspace: Workspace;
    signal: AbortSignal;
    refresh: () => Promise<unknown>;
    onResource: (r: Resource) => void;
    webConsole: boolean;
    standalone?: boolean;
};

function DraftLoader(props: DraftLoaderProps) {
    return (
        <ResourceLifetime parent={props.signal} fallback={<p role="status">{tx("正在加载草稿 / Loading draft…")}</p>}>
            {(signal) => <DraftQuery {...props} signal={signal} />}
        </ResourceLifetime>
    );
}

function DraftQuery(props: DraftLoaderProps) {
    useAppLocale();
    const draft = useQuery({
        queryKey: ["workspace", props.workspace.id, "draft", props.resource.id],
        queryFn: ({ signal: querySignal }) =>
            props.adapter.draft(props.resource.id, AbortSignal.any([props.signal, querySignal])),
    });
    const denied = draft.error instanceof ApiError && [401, 403, 404].includes(draft.error.status);
    const feedback = draft.error && <ErrorState error={draft.error} retry={() => void draft.refetch()} />;
    if (!draft.data || denied) return feedback ?? <p role="status">{tx("正在加载草稿 / Loading draft…")}</p>;
    // 后台回读暂时失败时保留已有编辑器和刚输入的内容，重试区域置于编辑器之后，恢复回读也不会重置草稿。
    return (
        <>
            <ResourceEditorView {...props} initial={draft.data} />
            <div>{feedback}</div>
        </>
    );
}
type ResourceEditorViewProps = {
    resource: Resource;
    adapter: ResourceAdapter;
    workspace: Workspace;
    signal?: AbortSignal;
    initial: Draft;
    refresh: () => Promise<unknown>;
    onResource: (r: Resource) => void;
    webConsole?: boolean;
    standalone?: boolean;
};

/**
 * 单资源编辑器统一管理图形表单、JSON、修订恢复和版本历史，只有已保存的同一份草稿与匹配回执可参与发布。
 * AI 及桌面宿主仍通过 ResourceAdapter 获取草稿、不可变版本和只读生成源码，管理台样式可单独启用。
 */
export function ResourceEditorView(props: ResourceEditorViewProps) {
    return (
        <ResourceLifetime parent={props.signal} fallback={<p role="status">{tx("正在加载草稿 / Loading draft…")}</p>}>
            {(signal) => <ScopedResourceEditor {...props} signal={signal} />}
        </ResourceLifetime>
    );
}

function ScopedResourceEditor({
    resource,
    adapter,
    workspace,
    signal,
    initial,
    refresh,
    onResource,
    webConsole = false,
    standalone = false,
}: ResourceEditorViewProps & { signal: AbortSignal }) {
    const { language } = useAppLocale();
    const { t } = useTranslation(undefined, useEditorTranslationOptions);
    const { showSuccess, showFailure, showPending } = useOperationFeedback();
    const dataset = resource.kind === "DATASET";
    const standaloneDatasetSource = dataset && standalone;
    const form = useForm<EditorValues>({
        defaultValues: { content: formJson(initial.content) },
        shouldUnregister: false,
    });
    const watched = useWatch({ control: form.control, name: "content" }),
        content = clean(watched) as ResourceDocumentV1,
        serialized = pretty(content);

    const [saved, setSaved] = useState(initial),
        [mode, setMode] = useState<"form" | "json">("form"),
        [datasetTab, setDatasetTab] = useState<"form" | "json" | "import" | "versions" | "settings">("form"),
        [formLifetime, setFormLifetime] = useState(0),
        [datasetImportGeneration, setDatasetImportGeneration] = useState(0),
        [buffer, setBuffer] = useState(pretty(initial.content)),
        [jsonBaseline, setJsonBaseline] = useState(pretty(initial.content)),
        [error, setError] = useState<Error | null>(null),
        [busy, setBusy] = useState(false),
        [conflict, setConflict] = useState<Draft | null>(null),
        [validation, setValidation] = useState<ValidationCandidate | null>(null),
        [receipt, setReceipt] = useState<Receipt | null>(null),
        [receiptError, setReceiptError] = useState<Error | null>(null),
        [receiptRetry, setReceiptRetry] = useState(0),
        [published, setPublished] = useState<Version | null>(null),
        [rename, setRename] = useState(resource.name);
    const validationGeneration = useRef(0),
        receiptRequest = useRef<AbortController | null>(null);
    const validationDialog = useRef<PendingOperation | null>(null);
    const publicationRequest = useRef<AbortController | null>(null);
    const publicationWaiter = useRef<PublicationWaiter | null>(null);
    const importSaveButton = useRef<HTMLButtonElement>(null);
    const reportedValidation = useRef<number>();
    const reportedReceiptError = useRef<{ generation: number; attempt: number }>();
    useEffect(() => () => validationDialog.current?.dismiss(), []);
    const invalidateValidation = () => {
        const generation = ++validationGeneration.current;
        publicationWaiter.current?.reject(new Error("VALIDATION_NOT_COMPLETED"));
        receiptRequest.current?.abort();
        receiptRequest.current = null;
        validationDialog.current?.dismiss();
        validationDialog.current = null;
        setValidation(null);
        setReceipt(null);
        setReceiptError(null);
        return generation;
    };
    const jsonDirty = buffer !== jsonBaseline,
        dirty = serialized !== pretty(saved.content),
        writable = !adapter.readOnly && resource.status !== "ARCHIVED" && editableRole(workspace, resource.kind);
    const canPublish = writable && ["OWNER", "ADMIN"].includes(workspace.role);
    const publicationState = useRef({ canPublish, draft: saved, clean: !dirty && !jsonDirty });
    // 发布跨越多个异步响应，以最新提交的权限和草稿状态阻断旧请求，同时让变化立即结束当前等待。
    useLayoutEffect(() => {
        const clean = !dirty && !jsonDirty;
        publicationState.current = { canPublish, draft: saved, clean };
        const waiting = publicationWaiter.current;
        if (!waiting) return;
        if (!canPublish) waiting.reject(new Error(t("readonly")));
        else if (!clean || saved.revision !== waiting.revision || saved.documentHash !== waiting.documentHash) {
            waiting.reject(new ApiError("STALE_REVISION", "Draft changed before publication", 409, ""));
        }
    }, [canPublish, saved, dirty, jsonDirty, t]);
    const jobId = validation?.jobId ?? "";
    const candidateIsCurrent =
        !!validation &&
        validation.generation === validationGeneration.current &&
        validation.workspaceId === workspace.id &&
        validation.resourceId === resource.id &&
        validation.revision === saved.revision &&
        validation.documentHash === saved.documentHash &&
        !dirty &&
        !jsonDirty;
    const currentReceipt =
        receipt && validation && candidateIsCurrent && receiptMatchesCandidate(receipt, validation) ? receipt : null;
    // clean 每次渲染都会复制文档，因此用实际序列化内容作为校验输入边界；无关状态改变不重建诊断快照，重复诊断的展示身份
    // 也不会随一次普通渲染而变化。
    const issues = useMemo(() => {
        const document = JSON.parse(serialized) as ResourceDocumentV1;
        return validateSchema(schemas[resource.kind], document.document);
    }, [resource.kind, serialized]);
    const allVersions = useQuery({
        queryKey: ["workspace", workspace.id, "reference-versions"],
        queryFn: async ({ signal: querySignal }) => {
            const scope = AbortSignal.any([signal, querySignal]);
            const options: VersionOption[] = [];
            let cursor: string | undefined;
            do {
                const page = await adapter.list(undefined, cursor, scope);
                for (const r of page.items) {
                    let versionCursor: string | undefined;
                    do {
                        const versions = await adapter.versions(r.id, versionCursor, scope);
                        options.push(
                            ...versions.items.map((v) => ({
                                id: v.id,
                                name: r.name,
                                kind: r.kind,
                                versionNo: v.versionNo,
                                content: v.content as ResourceDocumentV1,
                            })),
                        );
                        versionCursor = versions.nextCursor ?? undefined;
                    } while (versionCursor);
                }
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
            return options;
        },
    });
    const {
        data: finishedJob,
        error: jobError,
        isPending: jobPending,
        isFetching: jobFetching,
        refetch: reloadJob,
    } = useQuery({
        queryKey: ["workspace", workspace.id, "validation-job", jobId],
        queryFn: ({ signal: querySignal }) => adapter.job(jobId, AbortSignal.any([signal, querySignal])),
        enabled: !!jobId,
        refetchOnWindowFocus: !standaloneDatasetSource,
        refetchOnReconnect: !standaloneDatasetSource,
        refetchInterval: (query) =>
            query.state.data?.state === "FINISHED" || (standaloneDatasetSource && query.state.status === "error")
                ? false
                : 1000,
    });
    // 独立详情仅在同一个结果窗口渲染作业状态，读取失败暂停轮询，等待用户重试对应作业后再等待回执。
    useEffect(() => {
        const dialog = validationDialog.current;
        if (!dialog || !validation || !candidateIsCurrent || signal.aborted) return;
        const waiting = publicationWaiter.current;
        const publication = waiting?.generation === validation.generation ? waiting : null;
        const sameJob = finishedJob?.id === validation.jobId ? finishedJob : null;
        if (publication && finishedJob && !sameJob) {
            publication.reject(new Error("VALIDATION_JOB_MISMATCH"));
            return;
        }
        if (jobError && !jobFetching) {
            if (publication) {
                publication.reject(jobError);
                return;
            }
            dialog.complete("failure", resourceErrorMessage(jobError), {
                message: t("queued"),
                onRetry: () => void reloadJob(),
            });
        } else if (sameJob) {
            dialog.update(<ValidationState job={sameJob} receipt={null} awaitingReceipt />);
        }
    }, [validation, candidateIsCurrent, signal, finishedJob, jobError, jobFetching, reloadJob, t]);
    // 成功弹窗依赖已核对的回执；收到失败或取消的终态时仅发布一次结果，仍保留作业诊断供用户检查。
    useEffect(() => {
        if (
            !validation ||
            !candidateIsCurrent ||
            signal.aborted ||
            reportedValidation.current === validation.generation ||
            finishedJob?.id !== validation.jobId ||
            finishedJob.state !== "FINISHED"
        )
            return;
        if (finishedJob.outcome !== "PASSED") {
            reportedValidation.current = validation.generation;
            const message = t(finishedJob.outcome === "CANCELLED" ? "validationCancelled" : "validationFailed");
            if (standaloneDatasetSource) {
                validationDialog.current?.complete(
                    "failure",
                    <>
                        <p>{message}</p>
                        <ValidationState job={finishedJob} receipt={null} />
                    </>,
                );
            } else showFailure(finishedJob.errorCode ?? message);
            const waiting = publicationWaiter.current;
            if (waiting?.generation === validation.generation) waiting.reject(new Error(message));
            return;
        }
        // 失败回执读取只在用户明确重试时重新发起，切换中英文或刷新同一终态都不会重复弹出失败对话框。
        const failed = reportedReceiptError.current;
        if (failed?.generation === validation.generation && failed.attempt === receiptRetry) return;
        const controller = new AbortController(),
            receiptSignal = AbortSignal.any([signal, controller.signal]);
        const generation = validation.generation;
        let active = true;
        receiptRequest.current = controller;
        void adapter
            .receipt(validation.jobId, receiptSignal)
            .then((r) => {
                if (!active || receiptSignal.aborted || validationGeneration.current !== generation) return;
                if (!receiptMatchesCandidate(r, validation)) throw new Error("VALIDATION_RECEIPT_MISMATCH");
                setReceipt(r);
                reportedValidation.current = generation;
                setReceiptError(null);
                const waiting = publicationWaiter.current;
                if (waiting?.generation === generation) waiting.resolve(r);
                else if (standaloneDatasetSource) {
                    validationDialog.current?.complete(
                        "success",
                        <>
                            {validation.showReceiptDetails && <p>{t("success")}</p>}
                            <ValidationState
                                job={finishedJob}
                                receipt={r}
                                showReceiptDetails={validation.showReceiptDetails}
                            />
                        </>,
                    );
                } else showSuccess(t("success"));
            })
            .catch((reason: unknown) => {
                if (!active || receiptSignal.aborted || validationGeneration.current !== generation) return;
                const waiting = publicationWaiter.current;
                if (waiting?.generation === generation) {
                    waiting.reject(reason);
                    return;
                }
                reportedReceiptError.current = { generation, attempt: receiptRetry };
                const message = resourceErrorMessage(reason);
                if (standaloneDatasetSource) {
                    validationDialog.current?.complete(
                        "failure",
                        <>
                            <p>{t("validationReceiptFailed")}</p>
                            <p>{message}</p>
                            <ValidationState job={finishedJob} receipt={null} />
                        </>,
                        {
                            message: <ValidationState job={finishedJob} receipt={null} awaitingReceipt />,
                            onRetry: () => setReceiptRetry((attempt) => attempt + 1),
                        },
                    );
                } else {
                    setReceiptError(reason instanceof Error ? reason : new Error(message));
                    showFailure(message);
                }
            });
        return () => {
            active = false;
            controller.abort();
            if (receiptRequest.current === controller) receiptRequest.current = null;
        };
    }, [
        finishedJob,
        validation,
        candidateIsCurrent,
        signal,
        adapter,
        t,
        showFailure,
        showSuccess,
        receiptRetry,
        standaloneDatasetSource,
    ]);
    const run = (action: () => Promise<void>, feedback?: PendingOperation) => {
        setBusy(true);
        setError(null);
        const dismiss = () => feedback?.dismiss();
        signal.addEventListener("abort", dismiss, { once: true });
        void action()
            .catch(async (e) => {
                if (signal.aborted) return;
                let message = resourceErrorMessage(e);
                if (!feedback) showFailure(message);
                if (e instanceof ApiError && e.status === 409 && e.code === "STALE_REVISION") {
                    try {
                        const remote = await adapter.draft(resource.id, signal);
                        if (!signal.aborted) setConflict(remote);
                    } catch (readError) {
                        if (feedback) message += `\n${resourceErrorMessage(readError)}`;
                        else if (!signal.aborted) setError(readError as Error);
                    }
                }
                if (!signal.aborted) feedback?.complete("failure", message);
            })
            .finally(() => {
                signal.removeEventListener("abort", dismiss);
                if (!signal.aborted) setBusy(false);
            });
    };
    const guard = (requireSaved = false) => {
        if (jsonDirty) throw new Error(t("pendingJson"));
        if (issues.length) throw new Error(t("invalid"));
        if (requireSaved && dirty) throw new Error(t("dirty"));
    };
    const discardBuffer = () => {
        setBuffer(serialized);
        setJsonBaseline(serialized);
    };
    const restore = (remote: Draft) => {
        invalidateValidation();
        form.reset({ content: formJson(remote.content) });
        setFormLifetime((previous) => previous + 1);
        setSaved(remote);
        setBuffer(pretty(remote.content));
        setJsonBaseline(pretty(remote.content));
        setConflict(null);
    };
    const kindLabel =
        usesLocalizedHeading(resource.kind) || language === "zh" ? t(`kinds.${resource.kind}`) : resource.kind;
    const tabsId = useId();
    const renameId = useId();
    const staticDataset =
        content.kind === "DATASET" &&
        content.document.schemaVersion === "2.0" &&
        content.document.source.kind === "STATIC"
            ? (content.document as Extract<DatasetV2, { source: { kind: "STATIC" } }>)
            : undefined;
    const importDataset = standaloneDatasetSource ? staticDataset : undefined;
    // 远端草稿切换来源时回到有效的数据页签，源码按钮仅由当前页签决定，避免沿用离开源码时的模式。
    const selectedDatasetTab = datasetTab === "import" && !importDataset ? "form" : datasetTab;
    const showJsonDraftActions = standaloneDatasetSource && selectedDatasetTab === "json";
    const allowDatasetExport = canExportWorkspaceTable(workspace.role);
    const activateMode = (next: "form" | "json") => {
        if (next === "json" && !jsonDirty) discardBuffer();
        setMode(next);
    };
    // 离开数据页签时保留编辑模式，回到 JSON 后继续使用尚未应用的缓冲区，以及与模式关联的编辑器生命周期。
    function activateDatasetTab(next: typeof datasetTab) {
        if (next === "form" || next === "json") activateMode(next);
        setDatasetTab(next);
    }
    const visualFields = (
        <fieldset className="vq-editor-fields" disabled={busy || (!writable && !staticDataset)}>
            <ResourceForms
                key={formLifetime}
                kind={resource.kind}
                versions={allVersions.data ?? []}
                preview={(data) => adapter.httpPreview(resource.id, data, signal)}
                lockDatasetEdits={!writable}
                allowDatasetExport={allowDatasetExport}
                datasetImportGeneration={standaloneDatasetSource ? datasetImportGeneration : undefined}
                authenticationSettings={
                    resource.kind === "ENVIRONMENT" && writable && adapter instanceof CloudResourceAdapter ? (
                        <Link to={`/workspaces?tab=auth-credentials&workspaceId=${workspace.id}`}>
                            {tx("Manage authentication and credentials")}
                        </Link>
                    ) : undefined
                }
            />
        </fieldset>
    );
    const importFields = importDataset && (
        <fieldset className="vq-editor-fields vq-dataset-import-fields" disabled={busy}>
            <ImportRows
                dataset={importDataset}
                readOnly={!writable}
                allowTableExport={allowDatasetExport}
                standalone
                apply={(rows, fields) => {
                    if (!writable || busy) return;
                    // 导入的字段和数据行同时写入草稿，再重建行控件，避免旧行的编辑状态套用到新导入的数据。
                    invalidateValidation();
                    form.setValue(
                        "content.document",
                        formJson({ ...importDataset, fields, source: { kind: "STATIC", rows } }),
                        { shouldDirty: true },
                    );
                    setDatasetImportGeneration((previous) => previous + 1);
                    showSuccess(tx("Import applied to the draft. Save the draft to keep the changes."), () =>
                        importSaveButton.current?.focus(),
                    );
                }}
            />
        </fieldset>
    );
    const jsonActionsDisabled = !writable || busy;
    const discardJson = () => {
        discardBuffer();
        if (showJsonDraftActions) showSuccess(t("jsonDiscarded"));
    };
    // 合法源码一次替换整个图形草稿，重建字段控件并清除旧校验回执，失败时保留原草稿和当前源码内容。
    const applyJson = () => {
        try {
            const next: unknown = JSON.parse(buffer);
            const problems = validateSchema("ResourceDocumentV1", next);
            if (problems.length) throw new Error(problems.map((p) => `${p.path}: ${p.message}`).join("\n"));
            if ((next as ResourceDocumentV1).kind !== resource.kind) throw new Error("RESOURCE_KIND_IMMUTABLE");
            invalidateValidation();
            form.reset({ content: formJson(next as ResourceDocumentV1) });
            setFormLifetime((previous) => previous + 1);
            setJsonBaseline(buffer);
            if (showJsonDraftActions) showSuccess(t("jsonApplied"));
        } catch (e) {
            showFailure(resourceErrorMessage(e));
        }
    };
    // 图标按钮的可访问名称和悬停提示共用已有译文，源码只读或有写入任务时仍使用原生按钮的禁用语义。
    const sourceAction = (label: string, icon: string, onClick: (event: MouseEvent<HTMLButtonElement>) => void) => (
        <Tooltip content={label}>
            <Button tone="ghost" size="compact" disabled={jsonActionsDisabled} aria-label={label} onClick={onClick}>
                <svg aria-hidden="true" width="16" height="16">
                    <use href={`${adminIcons}#${icon}`} />
                </svg>
            </Button>
        </Tooltip>
    );
    const jsonFields =
        mode === "json" ? (
            <fieldset className="vq-editor-fields" disabled={jsonActionsDisabled}>
                <Monaco
                    value={buffer}
                    onChange={setBuffer}
                    readOnly={!writable}
                    label="JSON source"
                    automaticTabNavigation={standaloneDatasetSource}
                    footer={
                        standaloneDatasetSource && (
                            <div className="vq-dataset-json-tools">
                                {sourceAction(t("discard"), "undo", discardJson)}
                                {sourceAction(t("apply"), "log-in", applyJson)}
                                {sourceAction(t("validate"), "code-check", compileDraft)}
                            </div>
                        )
                    }
                />
                {!standaloneDatasetSource && (
                    <div className="vq-actions">
                        <Button disabled={jsonActionsDisabled} onClick={applyJson}>
                            {t("apply")}
                        </Button>
                        <Button tone="secondary" disabled={jsonActionsDisabled} onClick={discardJson}>
                            {t("discard")}
                        </Button>
                    </div>
                )}
            </fieldset>
        ) : null;
    const draftFeedback = (
        <>
            {!writable && <p>{t("readonly")}</p>}
            {error && <ErrorState error={error} />}
            {allVersions.error && <ErrorState error={allVersions.error} retry={() => void allVersions.refetch()} />}
            {jsonDirty && <p role="alert">{t("pendingJson")}</p>}
            {issues.length > 0 && (
                <ul role="alert">
                    {diagnosticRows(issues).map(({ issue, key }) => (
                        <li key={key}>
                            {issue.path || "/"} · {issue.code}: {issue.message}
                        </li>
                    ))}
                </ul>
            )}
            {conflict && (
                <Section title={t("conflict")}>
                    <MonacoDiff original={pretty(conflict.content)} modified={serialized} />
                    <ConfirmDialog title={t("reload")} trigger={t("reload")} onConfirm={() => restore(conflict)}>
                        <p>{tx("远端内容将替换本地草稿 / Replace local content with the remote draft.")}</p>
                    </ConfirmDialog>
                    <Button
                        onClick={() => {
                            invalidateValidation();
                            setSaved(conflict);
                            setConflict(null);
                        }}
                    >
                        {t("keep")}
                    </Button>
                </Section>
            )}
        </>
    );
    // 关闭等待窗口只结束页面观察，编译和写入的执行与取消仍由服务端管理，当前候选的回执匹配也继续执行。
    const startFeedback = (message: string, trigger: HTMLButtonElement) =>
        showPending(message, { trigger, onClose() {} });
    // 图形编辑与源码入口共用同一编译流程，先校验草稿状态，再跟踪与当前文档摘要和修订匹配的回执。
    function compileDraft(event: MouseEvent<HTMLButtonElement>) {
        const feedback = standaloneDatasetSource
            ? startFeedback(t("preparingValidation"), event.currentTarget)
            : undefined;
        run(async () => {
            guard(true);
            await queueDraftValidation(invalidateValidation(), feedback, signal);
        }, feedback);
    }
    // 两种入口都用服务端预览锁定文档及编译输入，再把队列响应绑定到本地编译代次供统一轮询与核对。
    async function queueDraftValidation(
        generation: number,
        feedback: PendingOperation | undefined,
        request: AbortSignal,
    ) {
        validationDialog.current = feedback ?? null;
        const preview = await adapter.preview(resource.id, request);
        request.throwIfAborted();
        if (preview.revision !== saved.revision || preview.documentHash !== saved.documentHash)
            throw new ApiError("STALE_REVISION", "Draft changed before validation", 409, "");
        const queued = await adapter.validate(
            resource.id,
            { revision: saved.revision, sourceHash: preview.sourceHash },
            request,
        );
        request.throwIfAborted();
        if (validationGeneration.current !== generation) return;
        feedback?.update(t("queued"));
        setValidation({
            workspaceId: workspace.id,
            resourceId: resource.id,
            jobId: queued.id,
            revision: preview.revision,
            documentHash: preview.documentHash,
            sourceHash: preview.sourceHash,
            engineVersion: preview.engineVersion,
            generation,
            // 按发起编译时的入口决定回执展示，关闭等待窗口后切换页签也不会改变该次操作的显示范围。
            showReceiptDetails: !showJsonDraftActions,
        });
    }
    // 发布保持一个等待操作；同一轮询核对回执后重读预览，其他会话改动草稿或引擎时不送出发布请求。
    async function waitForPublicationReceipt(feedback: PendingOperation, request: AbortSignal) {
        request.throwIfAborted();
        const generation = invalidateValidation();
        const completion = new Promise<Receipt>((resolve, reject) => {
            publicationWaiter.current = {
                resolve,
                reject,
                generation,
                revision: saved.revision,
                documentHash: saved.documentHash,
            };
        });
        const abort = () => {
            const waiting = publicationWaiter.current;
            if (waiting?.generation === generation) waiting.reject(request.reason);
        };
        request.addEventListener("abort", abort, { once: true });
        try {
            const [, validated] = await Promise.all([queueDraftValidation(generation, feedback, request), completion]);
            request.throwIfAborted();
            feedback.update(t("publishing"));
            const latest = await adapter.preview(resource.id, request);
            request.throwIfAborted();
            if (
                validationGeneration.current !== generation ||
                latest.revision !== saved.revision ||
                latest.documentHash !== saved.documentHash ||
                latest.sourceHash !== validated.sourceHash ||
                latest.engineVersion !== validated.engineVersion
            ) {
                throw new ApiError("STALE_REVISION", "Draft changed before publication", 409, "");
            }
            return validated;
        } finally {
            request.removeEventListener("abort", abort);
            if (publicationWaiter.current?.generation === generation) publicationWaiter.current = null;
            if (validationDialog.current === feedback) validationDialog.current = null;
        }
    }
    // 同一次点击在编译与发布之间保留写入锁，关闭等待框可阻止后续提交，已发出的发布仍由服务端处理。
    function publishDraft(event: MouseEvent<HTMLButtonElement>) {
        if (!canPublish || busy || publicationRequest.current) return;
        const controller = new AbortController();
        publicationRequest.current = controller;
        const needsValidation = showJsonDraftActions && !currentReceipt;
        const feedback = showJsonDraftActions
            ? showPending(t(needsValidation ? "preparingValidation" : "publishing"), {
                  trigger: event.currentTarget,
                  onClose: () => controller.abort(),
              })
            : undefined;
        const request = AbortSignal.any([signal, controller.signal]);
        run(async () => {
            try {
                guard(true);
                const proof =
                    needsValidation && feedback ? await waitForPublicationReceipt(feedback, request) : currentReceipt;
                request.throwIfAborted();
                if (!proof) throw new Error("VALIDATION_NOT_COMPLETED");
                if (needsValidation) {
                    const state = publicationState.current;
                    if (!state.canPublish) throw new Error(t("readonly"));
                    if (
                        !state.clean ||
                        state.draft.revision !== saved.revision ||
                        state.draft.documentHash !== saved.documentHash
                    ) {
                        throw new ApiError("STALE_REVISION", "Draft changed before publication", 409, "");
                    }
                }
                const version = await adapter.publish(
                    resource.id,
                    { revision: saved.revision, validationReceiptId: proof.id },
                    signal,
                );
                signal.throwIfAborted();
                setPublished(version);
                onResource({ ...resource, status: "PUBLISHED", latestVersionId: version.id });
                if (feedback) feedback.complete("success", t("published"));
                else showSuccess(t("published"));
                void refresh();
            } finally {
                publicationRequest.current = null;
            }
        }, feedback);
    }
    const draftActions = (
        <>
            <div className={showJsonDraftActions ? "vq-actions vq-dataset-json-actions" : "vq-actions"}>
                <Button
                    size="compact"
                    tone={showJsonDraftActions ? "secondary" : undefined}
                    ref={selectedDatasetTab === "import" ? importSaveButton : undefined}
                    disabled={!writable || busy}
                    onClick={(event) => {
                        const feedback = showJsonDraftActions
                            ? startFeedback(t("saving"), event.currentTarget)
                            : undefined;
                        run(async () => {
                            guard();
                            invalidateValidation();
                            const draft = await adapter.save(
                                resource.id,
                                { revision: saved.revision, content },
                                signal,
                            );
                            signal.throwIfAborted();
                            setSaved(draft);
                            if (feedback) feedback.complete("success", t("saved"));
                            else showSuccess(t("saved"));
                            // 列表与草稿的回读失败由查询区处理，写入回执已确认时不会再弹出相反的操作结果误导用户重试。
                            void refresh();
                        }, feedback);
                    }}
                >
                    {t("save")}
                </Button>
                {!showJsonDraftActions && (
                    <Button size="compact" disabled={!writable || busy} onClick={compileDraft}>
                        {t("validate")}
                    </Button>
                )}
                <Button
                    size="compact"
                    disabled={!canPublish || busy || (!showJsonDraftActions && !currentReceipt)}
                    onClick={publishDraft}
                >
                    {t("publish")}
                </Button>
            </div>
            {!standaloneDatasetSource && (
                <>
                    {candidateIsCurrent && !finishedJob && jobPending && <p role="status">{t("queued")}</p>}
                    {candidateIsCurrent && finishedJob && (
                        <ValidationState job={finishedJob} receipt={currentReceipt} />
                    )}
                    {jobError && <ErrorState error={jobError} retry={() => void reloadJob()} />}
                    {candidateIsCurrent && receiptError && (
                        <ErrorState error={receiptError} retry={() => setReceiptRetry((attempt) => attempt + 1)} />
                    )}
                </>
            )}
            {!showJsonDraftActions && published && (
                <p>
                    v{published.versionNo} · {published.id} · {published.sha256}
                </p>
            )}
        </>
    );
    // 字段持续挂载以保留导入文本、预览和焦点历史，只有当前数据页签渲染草稿反馈和一组可操作按钮。
    function renderDraft(editor: ReactNode, active = true) {
        return (
            <FormProvider {...form}>
                {active && draftFeedback}
                {editor}
                {active && draftActions}
            </FormProvider>
        );
    }
    const settings = (
        <Section title={tx("资源设置 / Resource settings")}>
            <Field htmlFor={renameId} label={t("columnName")} hint={t("renameHint")}>
                <input id={renameId} value={rename} disabled={!writable} onChange={(e) => setRename(e.target.value)} />
            </Field>
            <Button
                size={webConsole ? "compact" : undefined}
                disabled={!writable || busy || !rename.trim()}
                onClick={() =>
                    run(async () => {
                        const next = await adapter.update(resource.id, { name: rename }, signal);
                        signal.throwIfAborted();
                        onResource(next);
                        showSuccess(t("renamed"));
                        void refresh();
                    })
                }
            >
                {tx("更新名称 / Rename")}
            </Button>
            {!adapter.readOnly && editableRole(workspace, resource.kind) && (
                <ConfirmDialog
                    title={resource.status === "ARCHIVED" ? t("restore") : t("archive")}
                    trigger={resource.status === "ARCHIVED" ? t("restore") : t("archive")}
                    onConfirm={() =>
                        run(async () => {
                            const next = await adapter.update(
                                resource.id,
                                {
                                    name: resource.name,
                                    archived: resource.status !== "ARCHIVED",
                                },
                                signal,
                            );
                            signal.throwIfAborted();
                            onResource(next);
                            showSuccess(t(next.status === "ARCHIVED" ? "archived" : "restored"));
                            void refresh();
                        })
                    }
                >
                    <p>{tx("版本及 key 会保留 / Immutable versions and keys are retained.")}</p>
                </ConfirmDialog>
            )}
        </Section>
    );
    const versions = (
        <VersionHistory
            key={resource.latestVersionId ?? "versions"}
            resource={resource}
            adapter={adapter}
            workspaceId={workspace.id}
            signal={signal}
            content={content}
        />
    );
    const impact = <Impact resource={resource} adapter={adapter} workspaceId={workspace.id} signal={signal} />;
    return (
        <article
            className="vq-resource-editor"
            data-console={webConsole || undefined}
            data-standalone={standalone || undefined}
        >
            <div className="vq-actions vq-resource-editor-heading">
                {!standalone && (
                    <h2>
                        {resource.name} · {kindLabel}
                    </h2>
                )}
                <span>
                    {t("draftRevision", { revision: saved.revision })} · {t(`roles.${workspace.role}`)}
                </span>
            </div>
            {dataset ? (
                <>
                    <SettingsTabList
                        tabs={
                            [
                                { id: "form", label: tx("Data (Form)"), icon: "table" },
                                { id: "json", label: tx("Data (JSON)"), icon: "code" },
                                ...(importDataset
                                    ? [{ id: "import" as const, label: tx("Dataset import tab"), icon: "upload" }]
                                    : []),
                                { id: "versions", label: tx("Dataset tab versions"), icon: "reports" },
                                { id: "settings", label: tx("Settings & references"), icon: "settings" },
                            ] as const
                        }
                        selected={selectedDatasetTab}
                        prefix={tabsId}
                        activate={activateDatasetTab}
                        label={tx("Dataset editor")}
                        className="vq-settings-tabs vq-dataset-tabs"
                    />
                    <div className="vq-dataset-panels">
                        <SettingsPanel tab="form" prefix={tabsId} selected={selectedDatasetTab}>
                            {renderDraft(visualFields, selectedDatasetTab === "form")}
                        </SettingsPanel>
                        <SettingsPanel tab="json" prefix={tabsId} selected={selectedDatasetTab}>
                            {renderDraft(jsonFields, selectedDatasetTab === "json")}
                        </SettingsPanel>
                        {importDataset && (
                            <SettingsPanel tab="import" prefix={tabsId} selected={selectedDatasetTab}>
                                {renderDraft(importFields, selectedDatasetTab === "import")}
                            </SettingsPanel>
                        )}
                        <SettingsPanel tab="versions" prefix={tabsId} selected={selectedDatasetTab}>
                            {versions}
                        </SettingsPanel>
                        <SettingsPanel tab="settings" prefix={tabsId} selected={selectedDatasetTab}>
                            {settings}
                            {impact}
                        </SettingsPanel>
                    </div>
                </>
            ) : (
                <>
                    {renderDraft(
                        <>
                            <div className="vq-actions">
                                <Button tone="secondary" onClick={() => activateMode("form")}>
                                    {t("form")}
                                </Button>
                                <Button tone="secondary" onClick={() => activateMode("json")}>
                                    {t("json")}
                                </Button>
                            </div>
                            {mode === "form" ? visualFields : jsonFields}
                        </>,
                    )}
                    {settings}
                    {versions}
                    {impact}
                </>
            )}
        </article>
    );
}
function ValidationState({
    job,
    receipt,
    awaitingReceipt = false,
    showReceiptDetails = true,
}: {
    job: Job;
    receipt: Receipt | null;
    awaitingReceipt?: boolean;
    showReceiptDetails?: boolean;
}) {
    useAppLocale();
    const { t } = useTranslation(undefined, useEditorTranslationOptions);
    // 等待原因仅在接口实际给出时显示，服务端编译排队时不把 Runtime 在线状态当成校验成功或失败的依据。
    const state = [
        t(`validationStates.${job.state}`),
        job.outcome && t(`validationOutcomes.${job.outcome}`),
        job.waitReason && t(`validationWaitReasons.${job.waitReason}`),
        job.errorCode,
    ].filter(Boolean);
    return (
        <section>
            <p role="status">{state.join(" · ")}</p>
            {job.diagnostics?.length ? (
                <ul aria-label={tx("Compiler diagnostics")}>
                    {diagnosticRows(job.diagnostics).map(({ issue, key }) => (
                        <li key={key}>
                            <code>{issue.code}</code>{" "}
                            {issue.pathStatus === "EXACT" ? (
                                <code>{issue.path || "/"}</code>
                            ) : (
                                tx("Source path withheld")
                            )}
                            : {issue.message}
                        </li>
                    ))}
                </ul>
            ) : null}
            {job.state === "FINISHED" && !receipt && (
                <p>
                    {awaitingReceipt
                        ? t("checkingValidationReceipt")
                        : tx("尚无成功校验回执 / No successful validation receipt.")}
                </p>
            )}
            {receipt && showReceiptDetails && (
                <p>
                    {receipt.id} · {receipt.engineVersion} · {receipt.sourceHash}
                </p>
            )}
        </section>
    );
}
function VersionHistory({
    resource,
    adapter,
    workspaceId,
    signal,
    content,
}: {
    resource: Resource;
    adapter: ResourceAdapter;
    workspaceId: string;
    signal: AbortSignal;
    content: ResourceDocumentV1;
}) {
    useAppLocale();
    const { t } = useTranslation(undefined, useEditorTranslationOptions),
        [versionId, setVersionId] = useState(resource.latestVersionId ?? ""),
        [other, setOther] = useState("draft"),
        [path, setPath] = useState("");
    useEffect(() => {
        if (!versionId && resource.latestVersionId) setVersionId(resource.latestVersionId);
    }, [resource.latestVersionId, versionId]);
    const versions = useInfiniteQuery({
        queryKey: ["workspace", workspaceId, "versions", resource.id],
        queryFn: ({ pageParam, signal: qs }) => adapter.versions(resource.id, pageParam, AbortSignal.any([signal, qs])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const items = versions.data?.pages.flatMap((p) => p.items) ?? [],
        selected = items.find((v) => v.id === versionId),
        compared = other === "draft" ? content : items.find((v) => v.id === other)?.content;
    const files = useQuery({
        queryKey: ["workspace", workspaceId, "compiled-files", resource.id, versionId],
        queryFn: ({ signal: qs }) => adapter.sourceFiles(resource.id, versionId, AbortSignal.any([signal, qs])),
        enabled: !!selected,
    });
    const file = files.data?.files.find((f) => f.path === path);
    const source = useQuery({
        queryKey: ["workspace", workspaceId, "compiled-source", versionId, path],
        queryFn: ({ signal: qs }) => adapter.source(resource.id, versionId, file!, AbortSignal.any([signal, qs])),
        enabled: !!file,
    });
    return (
        <>
            <Section title={t("versions")}>
                {versions.isPending && <p role="status">{t("loading")}</p>}
                {versions.error && <ErrorState error={versions.error} retry={() => void versions.refetch()} />}
                {!items.length && versions.isSuccess && <p>{tx("尚无发布版本 / No published versions.")}</p>}
                {!!items.length && (
                    <>
                        <ResourceSelectField
                            label={tx("基础版本 / Base version")}
                            value={versionId}
                            onValueChange={(selection) => {
                                setVersionId(selection);
                                setPath("");
                            }}
                        >
                            <ResourceSelectItem value="">{tx("选择 / Select")}</ResourceSelectItem>
                            {items.map((v) => (
                                <ResourceSelectItem value={v.id} key={v.id}>
                                    v{v.versionNo} · {v.sha256}
                                </ResourceSelectItem>
                            ))}
                        </ResourceSelectField>
                        <ResourceSelectField
                            label={tx("比较版本 / Compare with")}
                            value={other}
                            onValueChange={(selection) => setOther(selection)}
                        >
                            <ResourceSelectItem value="draft">{tx("当前草稿 / Current draft")}</ResourceSelectItem>
                            {items.map((v) => (
                                <ResourceSelectItem value={v.id} key={v.id}>
                                    v{v.versionNo}
                                </ResourceSelectItem>
                            ))}
                        </ResourceSelectField>
                        {selected && compared && (
                            <MonacoDiff original={pretty(selected.content)} modified={pretty(compared)} />
                        )}
                    </>
                )}
                {versions.hasNextPage && (
                    <Button onClick={() => void versions.fetchNextPage()}>{tx("更多版本 / More versions")}</Button>
                )}
            </Section>
            <Section title={t("source")}>
                {!selected && <p>{t("noSource")}</p>}
                {files.isFetching && <p role="status">{t("loading")}</p>}
                {files.error && <ErrorState error={files.error} retry={() => void files.refetch()} />}
                {files.data && (
                    <>
                        <p>
                            {tx("descriptor SHA-256: ")}
                            {files.data.descriptorSha256}
                        </p>
                        <ResourceSelectField
                            label={tx("保留文件 / Retained file")}
                            value={path}
                            onValueChange={(selection) => setPath(selection)}
                        >
                            <ResourceSelectItem value="">{tx("选择 / Select")}</ResourceSelectItem>
                            {files.data.files.map((f) => (
                                <ResourceSelectItem key={f.path} value={f.path}>
                                    {f.path} · {f.sha256}
                                </ResourceSelectItem>
                            ))}
                        </ResourceSelectField>
                    </>
                )}
                {source.isFetching && <p role="status">{t("loading")}</p>}
                {source.error && <ErrorState error={source.error} retry={() => void source.refetch()} />}
                {source.data !== undefined && file && (
                    <>
                        <p>
                            {file.sizeBytes} {tx(" bytes · SHA-256: ")}
                            {file.sha256}
                        </p>
                        <Monaco
                            value={source.data}
                            language="typescript"
                            readOnly
                            label="Generated TypeScript read only"
                        />
                    </>
                )}
            </Section>
        </>
    );
}
function Impact({
    resource,
    adapter,
    workspaceId,
    signal,
}: {
    resource: Resource;
    adapter: ResourceAdapter;
    workspaceId: string;
    signal: AbortSignal;
}) {
    useAppLocale();
    const dependents = useInfiniteQuery({
        queryKey: ["workspace", workspaceId, "dependents", resource.id],
        queryFn: ({ pageParam, signal: qs }) =>
            adapter.dependents(resource.id, pageParam, AbortSignal.any([signal, qs])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const items = dependents.data?.pages.flatMap((p) => p.items) ?? [];
    return (
        <Section title={tx("引用影响 / Reference impact")}>
            {dependents.isPending && <p role="status">{tx("正在加载 / Loading…")}</p>}
            {dependents.error && <ErrorState error={dependents.error} retry={() => void dependents.refetch()} />}
            {dependents.isSuccess && !items.length && (
                <p>{tx("没有已发布资源引用此资源 / No published dependents.")}</p>
            )}
            <ul>
                {items.map((r) => (
                    <li key={r.id}>
                        {r.kind} · {r.key} · {r.name}
                    </li>
                ))}
            </ul>
            {dependents.hasNextPage && (
                <Button onClick={() => void dependents.fetchNextPage()}>{tx("更多引用 / More dependents")}</Button>
            )}
        </Section>
    );
}
/**
 * 资源查询失败时的告警与可选 retry 按钮，避免空白页吞掉 ApiError 信息。无 retry 时仅展示错误文本。
 * retry 由调用方绑定 refetch；本组件不直接触碰 adapter。
 */
export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
    useAppLocale();
    return (
        <div role="alert">
            {resourceErrorMessage(error)}
            {retry && (
                <Button tone="secondary" onClick={retry}>
                    {tx("重试 / Retry")}
                </Button>
            )}
        </div>
    );
}

/**
 * 查询告警和操作结果共用同一安全错误摘要，让服务端错误代号与请求标识在弹窗迁移后仍可以核对。
 */
function resourceErrorMessage(error: unknown) {
    if (error instanceof ApiError)
        return tx("{{value0}} · {{value1}} · Request {{value2}}", {
            value0: error.code,
            value1: tx(error.message),
            value2: error.requestId,
        });
    return error instanceof Error ? tx(error.message) : tx("Operation failed");
}

function diagnosticRows<T extends { code: string; path?: string; message: string }>(issues: T[]) {
    // 只读诊断没有可编辑行状态，路径、代码、消息及完整快照项组成语义身份，同一诊断重复出现时再附出现次数；这种 key 保留
    // 顺序和重复项，也无需伪造后端诊断 ID。
    const occurrences = new Map<string, number>();
    return issues.map((issue) => {
        const semantic = JSON.stringify(issue);
        const occurrence = occurrences.get(semantic) ?? 0;
        occurrences.set(semantic, occurrence + 1);
        return { issue, key: JSON.stringify([semantic, occurrence]) };
    });
}
