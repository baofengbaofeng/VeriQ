import { useId, useState, type ReactNode } from "react";
import { Button, Section } from "@veriq/ui";
import {
    accepts,
    validateSchema,
    valueType,
    type DataFieldV2,
    type DataRowV2,
    type DatasetV2,
    type JsonValue,
} from "@veriq/contracts";
import { Select, SelectItem } from "../../components/Select";
import { tx, useAppLocale } from "../../locale";
import { DataTable, useTableView, type TableExportColumn } from "../../table-view";
import { JsonValueControl, useSet } from "./fields";
import { usePrimitiveRows } from "./row-identity";
import { formJson } from "./dataset-import";
import { ImportRows } from "./DatasetImportRows";

const initialValues: Record<DataFieldV2["type"], JsonValue> = {
    string: "",
    number: 0,
    integer: 0,
    boolean: false,
    object: {},
    array: [],
};
const defaultField: DataFieldV2 = { type: "string", required: true, nullable: false };
const without = <T,>(record: Record<string, T>, key: string) =>
    Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

const displayString = (raw: string) => raw.replace(/\r\n?/gu, "\n");

/**
 * 原生多行输入会把 CRLF 和 CR 一律显示为 LF；仅替换实际改变的区间，保留未编辑的前后文本中的原换行样式。
 * 浏览器选择范围按 UTF-16 单元计数，原文位置同样按单元计算，避免将跨两个单元的字符误作单个偏移量。
 */
function editedString(previous: string, next: string, caret: number) {
    if (!previous.includes("\r")) return next;
    const visible = displayString(previous);
    let start = 0,
        oldEnd = visible.length,
        newEnd = next.length;
    // 输入事件发生后，光标位于替换内容末尾。先固定它右侧未改变的后缀，避免连续相同行界被误认成左侧前缀。
    while (oldEnd > 0 && newEnd > caret && visible[oldEnd - 1] === next[newEnd - 1]) {
        oldEnd--;
        newEnd--;
    }
    while (start < oldEnd && start < newEnd && visible[start] === next[start]) start++;
    function originalOffset(displayOffset: number) {
        let offset = 0;
        for (let i = 0; i < displayOffset; i++, offset++) {
            if (previous[offset] === "\r" && previous[offset + 1] === "\n") offset++;
        }
        return offset;
    }
    // 在拼接处若孤立 CR 遇到 LF，将左边的行界扩为 CRLF，保留右边独立的 LF，使两个可见换行不被合并。
    const join = (left: string, right: string) =>
        left.endsWith("\r") && right.startsWith("\n") ? left + "\n" + right : left + right;
    const prefix = previous.slice(0, originalOffset(start));
    const suffix = previous.slice(originalOffset(oldEnd));
    const result = join(join(prefix, next.slice(start, newEnd)), suffix);
    return displayString(result) === next ? result : next;
}

function multiline(label: string, value: string, change: (value: string) => void) {
    return (
        <label>
            {label}
            <textarea
                aria-label={label}
                rows={1}
                title={value}
                value={displayString(value)}
                onChange={({ currentTarget }) =>
                    change(editedString(value, currentTarget.value, currentTarget.selectionStart))
                }
            />
        </label>
    );
}

/**
 * 创建静态数据集时附上一个可立即保存的字段和一行数据，树行另有显式的根标记及同级排序值。
 */
export function newStaticDataset(shape: DatasetV2["shape"]): Extract<DatasetV2, { source: { kind: "STATIC" } }> {
    const base = { schemaVersion: "2.0" as const, fields: { name: defaultField } };
    const row = { key: "row_1", values: { name: "" } };
    return shape === "TREE"
        ? { ...base, shape, source: { kind: "STATIC", rows: [{ ...row, parentKey: null, order: 0 }] } }
        : { ...base, shape, source: { kind: "STATIC", rows: [row] } };
}

/**
 * 数据集仅通过固定文档路径写入表单；业务字段键可以含点或与原型键相同，不能拼作表单路径。
 * 成功导入一次写入预检字段和数据行，并重建局部行身份，避免上一份草稿的 JSON 输入状态遗留在新数组中。
 * 独立导入页签传入自己的应用计数，图形表单只重建数据行；嵌入式表单在本地完成同一操作。
 * 字段类型菜单将选项弹层移出可横向滚动的字段表，打开时不会被表格裁剪。
 */
export function DatasetFields({
    dataset,
    readOnly = false,
    allowTableExport = true,
    externalImportGeneration,
}: {
    dataset: Extract<DatasetV2, { source: { kind: "STATIC" } }>;
    readOnly?: boolean;
    allowTableExport?: boolean;
    externalImportGeneration?: number;
}) {
    useAppLocale();
    const set = useSet();
    const [generation, setGeneration] = useState(0);
    // 只读状态允许浏览表格，所有图形字段写入仍通过同一个守卫校验，页码和搜索变化不会修改草稿。
    const update = (fields: DatasetV2["fields"], rows: DataRowV2[]) => {
        if (!readOnly) set("content.document", formJson({ ...dataset, fields, source: { kind: "STATIC", rows } }));
    };
    const rows = dataset.source.rows;
    const entries = Object.entries(dataset.fields);
    const fieldView = useTableView(entries, {
        matches: ([key, field], term) => key.toLowerCase().includes(term) || field.type.includes(term),
    });
    const visibleFields = fieldView.rows;
    function rename(old: string, next: string) {
        if (old === next || validateSchema("Key", next).length || Object.hasOwn(dataset.fields, next)) return false;
        const replace = <T,>(record: Record<string, T>) =>
            Object.fromEntries(Object.entries(record).map(([k, v]) => [k === old ? next : k, v]));
        update(
            replace(dataset.fields),
            rows.map((row) => ({ ...row, values: replace(row.values) })),
        );
        return true;
    }
    return (
        <>
            <section className="vq-section vq-dataset-field-section">
                <h3>{tx("Dataset fields")}</h3>
                <DataTable
                    label={tx("Dataset fields")}
                    view={fieldView}
                    searchLabel={tx("Search dataset fields")}
                    pageSizeLabel={tx("Dataset fields per page")}
                    paginationLabel={tx("Dataset field pagination")}
                    exportAllowed={allowTableExport}
                    exportColumns={[
                        { label: tx("Field name"), value: ([key]) => key },
                        { label: tx("Field type"), value: ([, field]) => field.type },
                        { label: tx("Required"), value: ([, field]) => field.required },
                        { label: tx("Nullable"), value: ([, field]) => field.nullable },
                    ]}
                >
                    <div className="table-scroll vq-dataset-table-scroll">
                        <table
                            className="vq-dataset-table vq-dataset-definition-table"
                            aria-label={tx("Dataset fields")}
                        >
                            <thead>
                                <tr>
                                    <th scope="col" className="vq-dataset-name-column">
                                        {tx("Field name")}
                                    </th>
                                    <th scope="col" className="vq-dataset-type-column">
                                        {tx("Field type")}
                                    </th>
                                    <th scope="col" className="vq-dataset-flag-column">
                                        {tx("Required")}
                                    </th>
                                    <th scope="col" className="vq-dataset-flag-column">
                                        {tx("Nullable")}
                                    </th>
                                    <th scope="col">{tx("Actions")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {visibleFields.length === 0 && (
                                    <tr>
                                        <td className="vq-table-empty" colSpan={5}>
                                            {tx(entries.length ? "No matching dataset fields." : "No dataset fields.")}
                                        </td>
                                    </tr>
                                )}
                                {visibleFields.map(([key, field]) => {
                                    const change = (patch: Partial<DataFieldV2>) =>
                                        update({ ...dataset.fields, [key]: { ...field, ...patch } }, rows);
                                    return (
                                        <tr key={key}>
                                            <td>
                                                <input
                                                    aria-label={tx("Field name")}
                                                    disabled={readOnly}
                                                    defaultValue={key}
                                                    onBlur={(e) => {
                                                        if (!rename(key, e.target.value)) e.target.value = key;
                                                    }}
                                                />
                                            </td>
                                            <td>
                                                <Select
                                                    aria-label={tx("Field type")}
                                                    disabled={readOnly}
                                                    value={field.type}
                                                    appearance="default-dropdown"
                                                    escapeClosesSelectOnly
                                                    onValueChange={(type) =>
                                                        change({ type: type as DataFieldV2["type"] })
                                                    }
                                                >
                                                    {Object.keys(initialValues).map((type) => (
                                                        <SelectItem key={type} value={type}>
                                                            {type}
                                                        </SelectItem>
                                                    ))}
                                                </Select>
                                            </td>
                                            {(["required", "nullable"] as const).map((flag) => (
                                                <td key={flag}>
                                                    <input
                                                        aria-label={tx(flag === "required" ? "Required" : "Nullable")}
                                                        disabled={readOnly}
                                                        type="checkbox"
                                                        checked={field[flag]}
                                                        onChange={(e) => change({ [flag]: e.target.checked })}
                                                    />
                                                </td>
                                            ))}
                                            <td>
                                                <Button
                                                    tone="danger"
                                                    disabled={readOnly}
                                                    onClick={() =>
                                                        update(
                                                            without(dataset.fields, key),
                                                            rows.map((row) => ({
                                                                ...row,
                                                                values: without(row.values, key),
                                                            })),
                                                        )
                                                    }
                                                >
                                                    {tx("Remove field")}
                                                </Button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </DataTable>
                <Button
                    className="vq-dataset-add-action"
                    disabled={readOnly}
                    onClick={() => {
                        let i = 1;
                        while (Object.hasOwn(dataset.fields, "field_" + i)) i++;
                        const key = "field_" + i;
                        fieldView.revealPage(Math.floor(entries.length / fieldView.pageSize) + 1);
                        update(
                            { ...dataset.fields, [key]: defaultField },
                            rows.map((row) => ({ ...row, values: { ...row.values, [key]: "" } })),
                        );
                    }}
                >
                    <span className="vq-dataset-add-icon" aria-hidden="true">
                        +
                    </span>
                    {tx("Add field")}
                </Button>
            </section>
            <DatasetRows
                key={externalImportGeneration ?? generation}
                dataset={dataset}
                visibleFields={visibleFields}
                readOnly={readOnly}
                allowTableExport={allowTableExport}
                update={(next) => update(dataset.fields, next)}
            />
            {externalImportGeneration === undefined && (
                <ImportRows
                    dataset={dataset}
                    readOnly={readOnly}
                    allowTableExport={allowTableExport}
                    apply={(nextRows, nextFields) => {
                        if (readOnly) return;
                        update(nextFields, nextRows);
                        setGeneration((value) => value + 1);
                    }}
                />
            )}
        </>
    );
}

/**
 * 业务键在失焦时提交并同步所有子节点的父引用，连续输入不改变 React 行身份；排序与父键互相独立。
 * 缺失字段使用独立设置操作，已有值则复用通用 JSON 编辑器，允许明确输入空值以及对象和数组。
 */
function DatasetRows({
    dataset,
    update,
    visibleFields,
    readOnly,
    allowTableExport,
}: {
    dataset: Extract<DatasetV2, { source: { kind: "STATIC" } }>;
    update: (rows: DataRowV2[]) => void;
    visibleFields: readonly [string, DataFieldV2][];
    readOnly: boolean;
    allowTableExport: boolean;
}) {
    const rows = dataset.source.rows,
        ids = usePrimitiveRows(rows.length);
    const parents = useId();
    // 翻页和筛选只改变可见位置，编辑、删除和树节点重命名仍须使用原始数组索引及持久的组件身份。
    const indexedRows = rows.map((row, index) => ({ row, index }));
    const view = useTableView(indexedRows, {
        matches: ({ row }, term) => row.key.toLowerCase().includes(term),
    });
    const tree = dataset.shape === "TREE";
    const title = tx("数据行 / Dataset rows");
    const exportColumns: TableExportColumn<(typeof indexedRows)[number]>[] = [
        { label: tx("数据行 key / Row key"), value: ({ row }) => row.key },
    ];
    if (tree) {
        exportColumns.push(
            { label: tx("Parent node"), value: ({ row }) => ("parentKey" in row ? row.parentKey : undefined) },
            { label: tx("Sibling order"), value: ({ row }) => ("order" in row ? row.order : undefined) },
        );
    }
    exportColumns.push(
        ...visibleFields.map(([key]) => ({
            label: key,
            value: ({ row }: (typeof indexedRows)[number]) => {
                const value = Object.hasOwn(row.values, key) ? row.values[key] : undefined;
                return typeof value === "object" ? JSON.stringify(value) : value;
            },
        })),
    );
    return (
        <Section title={title}>
            {tree && (
                <datalist id={parents}>
                    {rows.map((row) => (
                        <option key={row.key} value={row.key} />
                    ))}
                </datalist>
            )}
            <DataTable
                label={title}
                view={view}
                searchLabel={tx("Search row keys")}
                pageSizeLabel={tx("Dataset rows per page")}
                paginationLabel={tx("Dataset row pagination")}
                exportAllowed={allowTableExport}
                exportColumns={exportColumns}
            >
                <div className="table-scroll vq-dataset-table-scroll">
                    <table className="vq-dataset-table vq-dataset-record-table" aria-label={title}>
                        <colgroup>
                            <col className="vq-dataset-key-column" />
                            {tree && (
                                <>
                                    <col className="vq-dataset-key-column" />
                                    <col className="vq-dataset-order-column" />
                                </>
                            )}
                            {visibleFields.map(([key]) => (
                                <col className="vq-dataset-field-column" key={key} />
                            ))}
                            <col className="vq-dataset-action-column" />
                        </colgroup>
                        <thead>
                            <tr>
                                <th scope="col">{tx("数据行 key / Row key")}</th>
                                {tree && (
                                    <>
                                        <th scope="col">{tx("Parent node")}</th>
                                        <th scope="col">{tx("Sibling order")}</th>
                                    </>
                                )}
                                {visibleFields.map(([key]) => (
                                    <th key={key} scope="col" title={key}>
                                        {key}
                                    </th>
                                ))}
                                <th scope="col">{tx("Actions")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {view.filteredCount === 0 && (
                                <tr>
                                    <td className="vq-table-empty" colSpan={visibleFields.length + (tree ? 4 : 2)}>
                                        {tx(rows.length ? "No matching rows." : "No dataset rows.")}
                                    </td>
                                </tr>
                            )}
                            {view.rows.map(({ row, index }) => {
                                const patch = (change: Partial<DataRowV2>) =>
                                    update(rows.map((item, i) => (i === index ? { ...item, ...change } : item)));
                                const values = (key: string, value: JsonValue) =>
                                    patch({ values: { ...row.values, [key]: value } });
                                return (
                                    <tr key={ids.keys[index]}>
                                        <td>
                                            <input
                                                aria-label={tx("数据行 key / Row key")}
                                                disabled={readOnly}
                                                defaultValue={row.key}
                                                onBlur={(e) => {
                                                    const key = e.target.value;
                                                    if (key === row.key) return;
                                                    if (
                                                        validateSchema("Key", key).length ||
                                                        rows.some((item) => item.key === key)
                                                    ) {
                                                        e.target.value = row.key;
                                                        return;
                                                    }
                                                    update(
                                                        rows.map((item, i) => ({
                                                            ...item,
                                                            ...(i === index ? { key } : {}),
                                                            ...("parentKey" in item && item.parentKey === row.key
                                                                ? { parentKey: key }
                                                                : {}),
                                                        })),
                                                    );
                                                }}
                                            />
                                        </td>
                                        {tree && "parentKey" in row && (
                                            <>
                                                <td>
                                                    <input
                                                        aria-label={tx("Parent node")}
                                                        disabled={readOnly}
                                                        list={parents}
                                                        value={row.parentKey ?? ""}
                                                        placeholder={tx("Root node")}
                                                        onChange={(e) => patch({ parentKey: e.target.value || null })}
                                                    />
                                                </td>
                                                <td>
                                                    <input
                                                        aria-label={tx("Sibling order")}
                                                        disabled={readOnly}
                                                        type="number"
                                                        step="any"
                                                        value={row.order}
                                                        onChange={(e) => {
                                                            if (Number.isFinite(e.target.valueAsNumber))
                                                                patch({ order: e.target.valueAsNumber });
                                                        }}
                                                    />
                                                </td>
                                            </>
                                        )}
                                        {visibleFields.map(([key, field]) => (
                                            <td key={key}>
                                                {Object.hasOwn(row.values, key) ? (
                                                    <DatasetValueCell
                                                        field={field}
                                                        readOnly={readOnly}
                                                        label={key}
                                                        value={row.values[key]!}
                                                        onChange={(v) => values(key, v)}
                                                        onClear={() => patch({ values: without(row.values, key) })}
                                                    />
                                                ) : (
                                                    <Button
                                                        className="vq-dataset-set"
                                                        disabled={readOnly}
                                                        onClick={() => values(key, initialValues[field.type])}
                                                    >
                                                        {tx("设置值 / Set ")} {key}
                                                    </Button>
                                                )}
                                            </td>
                                        ))}
                                        <td>
                                            <Button
                                                tone="danger"
                                                disabled={readOnly}
                                                onClick={() => {
                                                    ids.remove(index);
                                                    update(rows.filter((_, i) => i !== index));
                                                }}
                                            >
                                                {tx("Remove row")}
                                            </Button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </DataTable>
            <Button
                className="vq-dataset-add-action"
                disabled={readOnly}
                onClick={() => {
                    const row = {
                        key: "row_" + crypto.randomUUID(),
                        values: Object.fromEntries(
                            Object.entries(dataset.fields)
                                .filter(([, f]) => f.required)
                                .map(([key, f]) => [key, initialValues[f.type]]),
                        ),
                    };
                    view.revealPage(Math.floor(rows.length / view.pageSize) + 1);
                    ids.append();
                    update([...rows, dataset.shape === "TREE" ? { ...row, parentKey: null, order: rows.length } : row]);
                }}
            >
                <span className="vq-dataset-add-icon" aria-hidden="true">
                    +
                </span>
                {tx("Add row")}
            </Button>
        </Section>
    );
}

/**
 * 顶层单元格按字段声明编辑，容器内未声明类型的节点仍用递归编辑器；变更字段声明后保留原值，直到用户明确重置。
 * 显式空值只是可空字段的有效值，缺失仍由清除操作单独表达，两者分别保留在数据集中。
 */
function DatasetValueCell({
    field,
    readOnly,
    label,
    value,
    onChange,
    onClear,
}: {
    field: DataFieldV2;
    readOnly: boolean;
    label: string;
    value: JsonValue;
    onChange: (value: JsonValue) => void;
    onClear: () => void;
}) {
    const actual = valueType(value);
    const assignDefault = () => onChange(initialValues[field.type]);
    let editor: ReactNode;
    if (actual === "null" && field.nullable) {
        editor = (
            <div className="vq-dataset-cell-state">
                <code>null</code>
                <Button tone="secondary" onClick={assignDefault}>
                    {tx("Edit value")}
                </Button>
            </div>
        );
    } else if (!accepts(field.type, actual)) {
        editor = (
            <div className="vq-dataset-cell-state">
                <small>
                    {tx("Expected {{expected}}. Current type is {{actual}}.", { expected: field.type, actual })}
                </small>
                <Button tone="secondary" onClick={assignDefault}>
                    {tx("Reset value")}
                </Button>
            </div>
        );
    } else {
        editor = (
            <JsonValueControl
                declaredType={field.type}
                label={label}
                value={value}
                onChange={onChange}
                renderString={multiline}
            />
        );
        if (actual === "object" || actual === "array") {
            editor = (
                <details>
                    <summary>{tx("JSON value")}</summary>
                    {editor}
                </details>
            );
        }
    }
    const missing = tx("设为缺失 / Mark missing");
    const setNull = tx("Set to null");
    const cell = (
        <div className="vq-dataset-cell">
            {editor}
            {field.nullable && actual !== "null" && (
                <Button tone="secondary" onClick={() => onChange(null)} aria-label={setNull} title={setNull}>
                    null
                </Button>
            )}
            <Button tone="secondary" onClick={onClear} aria-label={missing} title={missing}>
                <span aria-hidden="true">×</span>
            </Button>
        </div>
    );
    return readOnly ? (
        <fieldset className="vq-dataset-control-lock" disabled>
            {cell}
        </fieldset>
    ) : (
        cell
    );
}
