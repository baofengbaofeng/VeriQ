/**
 * 统一控制表格的搜索范围、当前页和可访问分页按钮，保留各业务表对搜索字段与服务端查询边界的控制。
 */
import { useMemo, useState, type ReactNode } from "react";
import { Button } from "./components/Button";
import { Select, SelectItem } from "./components/Select";
import { tx, useAppLocale } from "./locale";

type TableOptions<Row> = {
    matches?: (row: Row, term: string) => boolean;
    scope?: string | object;
    pageSize?: number;
    initial?: { search: string; page: number };
};
type PaginationView = { page: number; pageCount: number; setPage: (page: number) => void };

/**
 * 业务表负责决定授权数据、搜索条件与分页请求，共享外壳仅处理当前页可见记录。游标接口尚无总数时可省略计数。
 */
export type TableDataView<Row> = PaginationView & {
    rows: readonly Row[];
    search: string;
    setSearch: (value: string) => void;
    pageSize: number;
    setPageSize: (value: number) => void;
    filteredCount?: number;
};

/**
 * 调用方逐列声明可下载的展示值，表格外壳不会从记录对象、隐藏单元格或业务操作入口取值。
 */
export type TableExportColumn<Row> = {
    label: string;
    value: (row: Row) => string | number | boolean | null | undefined;
};

const standardPageSizes = [5, 10, 20, 50];

/**
 * 工作区表格导出遵循服务端下载角色范围。调用方还需使用当前工作区的授权数据，并在失权时丢弃旧列表。
 */
export function canExportWorkspaceTable(role: string | null | undefined) {
    return role === "OWNER" || role === "ADMIN" || role === "EDITOR" || role === "EXECUTOR";
}

/**
 * 对同一数据范围的记录先筛选再分页；切换工作区或外部筛选条件时重置视图，记录减少时将页码约束在有效范围内。
 */
export function useTableView<Row>(
    rows: readonly Row[],
    { matches, scope, pageSize: initialPageSize = 10, initial }: TableOptions<Row> = {},
) {
    const [view, setView] = useState({
        scope,
        search: initial?.search ?? "",
        page: initial?.page ?? 1,
        selectedSize: undefined as number | undefined,
    });
    if (view.scope !== scope) setView({ ...view, scope, search: "", page: 1 });
    const pageSize = view.selectedSize ?? initialPageSize;
    const term = view.search.trim().toLowerCase();
    const filtered = useMemo(
        () => (matches && term ? rows.filter((row) => matches(row, term)) : rows),
        [matches, rows, term],
    );
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(view.page, pageCount);
    return {
        rows: useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page, pageSize]),
        filteredCount: filtered.length,
        search: view.search,
        setSearch: (search: string) => setView((current) => ({ ...current, search, page: 1 })),
        pageSize,
        setPageSize: (selectedSize: number) => setView((current) => ({ ...current, selectedSize, page: 1 })),
        page,
        pageCount,
        setPage: (value: number) =>
            setView((current) => ({ ...current, page: Math.max(1, Math.min(value, pageCount)) })),
        /**
         * 编辑器新增记录后可在同一次更新内解除筛选并跳到目标页，下一次渲染再根据新增后的行数限制实际页码。
         */
        revealPage: (value: number) => setView((current) => ({ ...current, search: "", page: Math.max(1, value) })),
    };
}

/**
 * 文本前置的公式标记、制表符或回车换行会被电子表格作特殊解释，导出时保留原值并用文本前缀阻断公式执行。
 * 数字与布尔值由受控列提供，负数按数字保留。所有字段统一转义，确保逗号、引号和换行不能分裂单元格。
 */
function csvCell(value: ReturnType<TableExportColumn<never>["value"]>) {
    const text = String(value ?? "");
    const formula = typeof value === "string" && /^\s*[=+@＝＋＠－-]|^[\t\r\n]/u.test(value);
    return `"${formula ? "'" : ""}${text.replaceAll('"', '""')}"`;
}

/**
 * 按当前页顺序生成工作表可读取的 UTF-8 编码文件。下载由浏览器处理，本地路径和文件系统权限留在宿主。
 */
function downloadTablePage<Row>(label: string, rows: readonly Row[], columns: readonly TableExportColumn<Row>[]) {
    const lines = [
        columns.map((column) => csvCell(column.label)).join(","),
        ...rows.map((row) => columns.map((column) => csvCell(column.value(row))).join(",")),
    ];
    const url = URL.createObjectURL(
        new Blob(["\uFEFF", lines.join("\r\n"), "\r\n"], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    const filename =
        label
            .replace(/[^\p{L}\p{N}-]+/gu, "-")
            .replace(/^-+|-+$/gu, "")
            .slice(0, 72) || "table";
    link.href = url;
    link.download = `${filename}.csv`;
    link.click();
    // 下载由宿主异步开始，等点击事件返回后再释放文件地址，同时避免每次导出都留下未释放的对象。
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * 全站数据表使用统一工具栏、原生表格和页脚。布局不定义业务列，也不替调用方决定需要分页的查询范围。
 * 筛选菜单和重置入口可放到搜索与下载之间，其它表保留原工具栏和既有独立筛选行。
 */
export function DataTable<Row>({
    label,
    view,
    searchLabel,
    searchMaxLength,
    exportColumns,
    exportAllowed = true,
    pageSizes = standardPageSizes,
    pageSizeLabel,
    paginationLabel,
    actions,
    filters,
    beforeDownload,
    children,
    hasMore = false,
    busy = false,
}: {
    label: string;
    view: TableDataView<Row>;
    searchLabel?: string;
    searchMaxLength?: number;
    exportColumns?: readonly TableExportColumn<Row>[];
    exportAllowed?: boolean;
    pageSizes?: readonly number[];
    pageSizeLabel?: string;
    paginationLabel?: string;
    actions?: ReactNode;
    filters?: ReactNode;
    beforeDownload?: ReactNode;
    children: ReactNode;
    hasMore?: boolean;
    busy?: boolean;
}) {
    const { language } = useAppLocale();
    const sizes = [...new Set([...pageSizes, view.pageSize])].sort((a, b) => a - b);
    const format = new Intl.NumberFormat(language);
    const start = view.rows.length ? (view.page - 1) * view.pageSize + 1 : 0;
    const end = start ? start + view.rows.length - 1 : 0;
    // 游标表自身不知道服务端总量，只有到达末页且请求已经稳定时，当前可见范围的上界才能作为完整计数。
    const count = view.filteredCount ?? (!hasMore && !busy && view.page === view.pageCount ? end : undefined);
    const summary = {
        first: format.format(start),
        last: format.format(end),
        count: count === undefined ? undefined : format.format(count),
    };
    const search = searchLabel && (
        <TableSearch label={searchLabel} value={view.search} onChange={view.setSearch} maxLength={searchMaxLength} />
    );
    const size = (
        <div className="vq-data-table-size">
            <span>{tx("Table show entries prefix")}</span>
            <Select
                value={String(view.pageSize)}
                onValueChange={(value) => view.setPageSize(Number(value))}
                aria-label={pageSizeLabel ?? tx("Rows per page")}
                appearance="default-dropdown"
                size="compact"
                disabled={busy}
                escapeClosesSelectOnly
            >
                {sizes.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                        {size}
                    </SelectItem>
                ))}
            </Select>
            <span>{tx("Table show entries suffix")}</span>
        </div>
    );
    return (
        <div className="vq-data-table">
            <div className="vq-data-table-toolbar">
                {size}
                <div className="vq-data-table-controls">
                    {search}
                    {beforeDownload}
                    {exportColumns && (
                        <Button
                            className="vq-data-table-download"
                            tone="secondary"
                            disabled={!exportAllowed || busy || view.rows.length === 0 || exportColumns.length === 0}
                            title={tx("Download current page as CSV")}
                            onClick={() => downloadTablePage(label, view.rows, exportColumns)}
                        >
                            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <path
                                    d="M8 2v8m-3-3 3 3 3-3M3 10v3h10v-3"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />
                            </svg>
                            {tx("Download table")}
                        </Button>
                    )}
                    {actions}
                </div>
            </div>
            {filters && <div className="vq-data-table-filters">{filters}</div>}
            {children}
            <div className="vq-data-table-footer">
                <span className="vq-data-table-count" aria-live="polite">
                    {tx(
                        count === undefined ? "Showing {{first}} to {{last}}" : "Table showing filtered entries",
                        summary,
                    )}
                </span>
                <TablePagination view={view} label={paginationLabel ?? label} busy={busy} hasMore={hasMore} />
            </div>
        </div>
    );
}

/**
 * 传入完整页 API 的查询函数，严格按真实游标收集业务表记录；取消时丢弃部分结果，重复游标以可重试的错误结束。
 */
export async function collectTablePages<Row>(
    read: (cursor: string | undefined, signal: AbortSignal) => Promise<{ items: Row[]; nextCursor: string | null }>,
    signal: AbortSignal,
): Promise<Row[]> {
    const rows: Row[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
        signal.throwIfAborted();
        const page = await read(cursor, signal);
        signal.throwIfAborted();
        rows.push(...page.items);
        if (page.nextCursor === null) return rows;
        if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error("Unable to load all table pages.");
        cursor = page.nextCursor;
        seen.add(cursor);
    }
}

/**
 * 搜索框以调用方给出的字段描述作为可访问名称，同时沿用控制台搜索图标和输入框样式，供多表页面区分各自的搜索框。
 */
export function TableSearch({
    label,
    value,
    onChange,
    maxLength,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    maxLength?: number;
}) {
    return (
        <div className="vq-user-search">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
                type="search"
                aria-label={label}
                placeholder={label}
                value={value}
                maxLength={maxLength}
                onChange={(event) => onChange(event.currentTarget.value)}
            />
        </div>
    );
}

/**
 * 分页按钮以当前页为中心只展示可达的页码，游标表仅展示已访问页并通过真实下一页游标决定后续按钮的可用状态。
 */
export function TablePagination({
    view: { page, pageCount, setPage },
    label,
    hasMore = false,
    busy = false,
}: {
    view: PaginationView;
    label: string;
    hasMore?: boolean;
    busy?: boolean;
}) {
    useAppLocale();
    const first = Math.max(1, Math.min(page - 2, pageCount - 4));
    const pages = Array.from({ length: Math.min(pageCount, first + 4) - first + 1 }, (_, index) => first + index);
    return (
        <nav className="vq-pagination" aria-label={label}>
            <button type="button" disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>
                {tx("Previous")}
            </button>
            {pages.map((number) => (
                <button
                    key={number}
                    type="button"
                    className="vq-page"
                    aria-current={number === page ? "page" : undefined}
                    disabled={busy}
                    onClick={() => setPage(number)}
                >
                    {number}
                </button>
            ))}
            <button type="button" disabled={busy || (page >= pageCount && !hasMore)} onClick={() => setPage(page + 1)}>
                {tx("Next")}
            </button>
        </nav>
    );
}
