import { useId, useRef, useState } from "react";
import { Button, Section } from "@veriq/ui";
import { validateSchema, type DataFieldV2, type DataRowV2, type DatasetV2, type JsonValue } from "@veriq/contracts";
import { tx, useAppLocale } from "../../locale";
import { JsonValueControl, useSet } from "./fields";
import { usePrimitiveRows } from "./row-identity";
import { datasetImportLimit, formJson, parseDatasetImport } from "./dataset-import";

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

const pageSize = 10;

/**
 * 原生多行输入会把 CRLF 和 CR 一律显示为 LF；仅替换实际改变的区间，保留未编辑的前后文本中的原换行样式。
 * 浏览器选择范围按 UTF-16 单元计数，原文位置同样按单元计算，避免将跨两个单元的字符误作单个偏移量。
 */
function editedString(previous: string, next: string) {
    if (!previous.includes("\r")) return next;
    const visible = previous.replace(/\r\n?/gu, "\n");
    let start = 0,
        oldEnd = visible.length,
        newEnd = next.length;
    while (start < oldEnd && start < newEnd && visible[start] === next[start]) start++;
    while (oldEnd > start && newEnd > start && visible[oldEnd - 1] === next[newEnd - 1]) {
        oldEnd--;
        newEnd--;
    }
    function originalOffset(displayOffset: number) {
        let offset = 0;
        for (let i = 0; i < displayOffset; i++, offset++) {
            if (previous[offset] === "\r" && previous[offset + 1] === "\n") offset++;
        }
        return offset;
    }
    return (
        previous.slice(0, originalOffset(start)) + next.slice(start, newEnd) + previous.slice(originalOffset(oldEnd))
    );
}

function multiline(label: string, value: string, change: (value: string) => void) {
    return (
        <label>
            {label}
            <textarea
                aria-label={label}
                value={value}
                onChange={(event) => change(editedString(value, event.target.value))}
            />
        </label>
    );
}

/**
 * 将字段和行分开分页，单次渲染至多十行十列；所有修改仍作用于完整文档，切页不会替换未显示的数据。
 * 用户删除末页最后一个元素时自动显示有效页，新增元素则可直接跳转到其所在页继续编辑。
 */
function useDatasetPage(count: number) {
    const [requested, set] = useState(0);
    const last = Math.max(0, Math.ceil(count / pageSize) - 1),
        page = Math.min(requested, last);
    return { page, last, set, start: page * pageSize };
}
function PageButtons({ scope, pages }: { scope: "rows" | "fields"; pages: ReturnType<typeof useDatasetPage> }) {
    if (!pages.last) return null;
    const row = scope === "rows";
    return (
        <div className="vq-actions">
            <Button tone="secondary" disabled={pages.page === 0} onClick={() => pages.set(0)}>
                {tx(row ? "First row page" : "First field page")}
            </Button>
            <Button tone="secondary" disabled={pages.page === 0} onClick={() => pages.set(pages.page - 1)}>
                {tx(row ? "Previous row page" : "Previous field page")}
            </Button>
            <span>
                {pages.page + 1} / {pages.last + 1}
            </span>
            <Button tone="secondary" disabled={pages.page === pages.last} onClick={() => pages.set(pages.page + 1)}>
                {tx(row ? "Next row page" : "Next field page")}
            </Button>
            <Button tone="secondary" disabled={pages.page === pages.last} onClick={() => pages.set(pages.last)}>
                {tx(row ? "Last row page" : "Last field page")}
            </Button>
        </div>
    );
}

/**
 * 创建静态数据集时附上一个可立即保存的字段和一行数据，树行另有显式的根标记及同级排序值。
 */
export function newStaticDataset(shape: DatasetV2["shape"]): DatasetV2 {
    const base = { schemaVersion: "2.0" as const, fields: { name: defaultField } };
    const row = { key: "row_1", values: { name: "" } };
    return shape === "TREE"
        ? { ...base, shape, source: { kind: "STATIC", rows: [{ ...row, parentKey: null, order: 0 }] } }
        : { ...base, shape, source: { kind: "STATIC", rows: [row] } };
}

/**
 * 数据集仅通过固定文档路径写入表单；业务字段键可以含点或与原型键相同，不能拼作表单路径。
 * 成功导入会重新建立行的局部组件身份，避免上一份草稿的嵌套 JSON 输入框状态遗留在新数组中。
 */
export function DatasetFields({ dataset }: { dataset: DatasetV2 }) {
    useAppLocale();
    const set = useSet();
    const [generation, setGeneration] = useState(0);
    const update = (fields: DatasetV2["fields"], rows: DataRowV2[]) =>
        set("content.document", formJson({ ...dataset, fields, source: { kind: "STATIC", rows } }));
    const rows = dataset.source.rows;
    const entries = Object.entries(dataset.fields),
        pages = useDatasetPage(entries.length);
    const visibleFields = entries.slice(pages.start, pages.start + pageSize);
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
            <Section title={tx("Dataset fields")}>
                <PageButtons scope="fields" pages={pages} />
                {visibleFields.map(([key, field]) => {
                    const change = (patch: Partial<DataFieldV2>) =>
                        update({ ...dataset.fields, [key]: { ...field, ...patch } }, rows);
                    return (
                        <div className="vq-item" key={key}>
                            <label>
                                {tx("Field name")}
                                <input
                                    defaultValue={key}
                                    onBlur={(e) => {
                                        if (!rename(key, e.target.value)) e.target.value = key;
                                    }}
                                />
                            </label>
                            <label>
                                {tx("Field type")}
                                <select
                                    value={field.type}
                                    onChange={(e) => change({ type: e.target.value as DataFieldV2["type"] })}
                                >
                                    {Object.keys(initialValues).map((type) => (
                                        <option key={type}>{type}</option>
                                    ))}
                                </select>
                            </label>
                            {(["required", "nullable"] as const).map((flag) => (
                                <label key={flag}>
                                    {tx(flag === "required" ? "Required" : "Nullable")}
                                    <input
                                        type="checkbox"
                                        checked={field[flag]}
                                        onChange={(e) => change({ [flag]: e.target.checked })}
                                    />
                                </label>
                            ))}
                            <Button
                                tone="danger"
                                onClick={() =>
                                    update(
                                        without(dataset.fields, key),
                                        rows.map((row) => ({ ...row, values: without(row.values, key) })),
                                    )
                                }
                            >
                                {tx("Remove field")}
                            </Button>
                        </div>
                    );
                })}
                <Button
                    tone="secondary"
                    onClick={() => {
                        let i = 1;
                        while (Object.hasOwn(dataset.fields, "field_" + i)) i++;
                        const key = "field_" + i;
                        pages.set(Math.floor(entries.length / pageSize));
                        update(
                            { ...dataset.fields, [key]: defaultField },
                            rows.map((row) => ({ ...row, values: { ...row.values, [key]: "" } })),
                        );
                    }}
                >
                    {tx("Add field")}
                </Button>
            </Section>
            <DatasetRows
                key={generation}
                dataset={dataset}
                visibleFields={visibleFields}
                update={(next) => update(dataset.fields, next)}
            />
            <ImportRows
                dataset={dataset}
                apply={(next) => {
                    update(dataset.fields, next);
                    setGeneration((value) => value + 1);
                }}
            />
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
}: {
    dataset: DatasetV2;
    update: (rows: DataRowV2[]) => void;
    visibleFields: [string, DataFieldV2][];
}) {
    const rows = dataset.source.rows,
        ids = usePrimitiveRows(rows.length);
    const parents = useId();
    const pages = useDatasetPage(rows.length);
    return (
        <Section title={tx("数据行 / Dataset rows")}>
            {dataset.shape === "TREE" && (
                <datalist id={parents}>
                    {rows.map((row) => (
                        <option key={row.key} value={row.key} />
                    ))}
                </datalist>
            )}
            <PageButtons scope="rows" pages={pages} />
            {rows.slice(pages.start, pages.start + pageSize).map((row: DataRowV2, slot) => {
                const index = pages.start + slot;
                const patch = (change: Partial<DataRowV2>) =>
                    update(rows.map((item, i) => (i === index ? { ...item, ...change } : item)));
                const values = (key: string, value: JsonValue) => patch({ values: { ...row.values, [key]: value } });
                return (
                    <div className="vq-item" key={ids.keys[index]}>
                        <label>
                            {tx("数据行 key / Row key")}
                            <input
                                defaultValue={row.key}
                                onBlur={(e) => {
                                    const key = e.target.value;
                                    if (key === row.key) return;
                                    if (validateSchema("Key", key).length || rows.some((item) => item.key === key)) {
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
                        </label>
                        {"parentKey" in row && (
                            <>
                                <label>
                                    {tx("Parent node")}
                                    <input
                                        list={parents}
                                        value={row.parentKey ?? ""}
                                        placeholder={tx("Root node")}
                                        onChange={(e) => patch({ parentKey: e.target.value || null })}
                                    />
                                </label>
                                <label>
                                    {tx("Sibling order")}
                                    <input
                                        type="number"
                                        step="any"
                                        value={row.order}
                                        onChange={(e) => {
                                            if (Number.isFinite(e.target.valueAsNumber))
                                                patch({ order: e.target.valueAsNumber });
                                        }}
                                    />
                                </label>
                            </>
                        )}
                        {visibleFields.map(([key, field]) => (
                            <Section title={key} key={key}>
                                {Object.hasOwn(row.values, key) ? (
                                    <>
                                        <JsonValueControl
                                            label={key}
                                            renderString={multiline}
                                            value={row.values[key]!}
                                            onChange={(v) => values(key, v)}
                                        />
                                        <Button
                                            tone="secondary"
                                            onClick={() => patch({ values: without(row.values, key) })}
                                        >
                                            {tx("设为缺失 / Mark missing")}
                                        </Button>
                                    </>
                                ) : (
                                    <Button onClick={() => values(key, initialValues[field.type])}>
                                        {tx("设置值 / Set ")} {key}
                                    </Button>
                                )}
                            </Section>
                        ))}
                        <Button
                            tone="danger"
                            onClick={() => {
                                ids.remove(index);
                                update(rows.filter((_, i) => i !== index));
                            }}
                        >
                            {tx("Remove row")}
                        </Button>
                    </div>
                );
            })}
            <Button
                onClick={() => {
                    const row = {
                        key: "row_" + crypto.randomUUID(),
                        values: Object.fromEntries(
                            Object.entries(dataset.fields)
                                .filter(([, f]) => f.required)
                                .map(([key, f]) => [key, initialValues[f.type]]),
                        ),
                    };
                    pages.set(Math.floor(rows.length / pageSize));
                    ids.append();
                    update([...rows, dataset.shape === "TREE" ? { ...row, parentKey: null, order: rows.length } : row]);
                }}
            >
                {tx("Add row")}
            </Button>
        </Section>
    );
}

/**
 * 预检结果绑定当前字段和草稿快照，输入、格式或原始草稿发生变化就使旧结果失效。文件读取完成前后的选择序号
 * 隔离较慢的异步读取，确保先选文件不能覆盖后来粘贴的文本或随后选择的文件。
 */
function ImportRows({ dataset, apply }: { dataset: DatasetV2; apply: (rows: DataRowV2[]) => void }) {
    const [format, setFormat] = useState<"CSV" | "JSON">("CSV"),
        [text, setText] = useState("");
    const [preview, setPreview] = useState<{ baseline: string; result: ReturnType<typeof parseDatasetImport> }>();
    const [error, setError] = useState(""),
        loading = useRef(0);
    const baseline = JSON.stringify(dataset),
        result = preview?.baseline === baseline ? preview.result : undefined;
    const clear = () => {
        loading.current++;
        setPreview(undefined);
        setError("");
    };
    return (
        <Section title={tx("Import rows")}>
            <label>
                {tx("Import format")}
                <select
                    value={format}
                    onChange={(e) => {
                        clear();
                        setFormat(e.target.value as typeof format);
                    }}
                >
                    <option>CSV</option>
                    <option>JSON</option>
                </select>
            </label>
            <p>
                {format === "JSON"
                    ? tx("Paste a JSON array of row objects.")
                    : tx(
                          dataset.shape === "TREE"
                              ? "CSV columns: key, parentKey, order and dataset fields."
                              : "CSV columns: key and dataset fields.",
                      )}
            </p>
            {format === "CSV" && (
                <p>{tx("Use values.<field> for data columns sharing a metadata name or starting with values.")}</p>
            )}
            <label>
                {tx("Import file")}
                <input
                    type="file"
                    accept={format === "CSV" ? ".csv" : ".json"}
                    onChange={async (e) => {
                        const file = e.target.files?.[0];
                        clear();
                        setText("");
                        if (!file) return;
                        if (file.size > datasetImportLimit) {
                            setError("DATASET_SIZE_LIMIT");
                            return;
                        }
                        const current = loading.current;
                        try {
                            const contents = await file.text();
                            if (current === loading.current) setText(contents);
                        } catch {
                            if (current === loading.current) setError("FILE_READ_FAILED");
                        }
                    }}
                />
            </label>
            <label>
                {tx("Import text")}
                <textarea
                    value={text}
                    onChange={(e) => {
                        clear();
                        setText(e.target.value);
                    }}
                />
            </label>
            <Button
                tone="secondary"
                disabled={!text}
                onClick={() => setPreview({ baseline, result: parseDatasetImport(format, text, dataset) })}
            >
                {tx("Preview import")}
            </Button>
            {error && <p role="alert">{error}</p>}
            {result &&
                (result.issues.length ? (
                    <ul role="alert">
                        {[
                            ...new Set(
                                result.issues
                                    .slice(0, 100)
                                    .map((issue) => [issue.row, issue.field, issue.code].join(" · ")),
                            ),
                        ].map((message) => (
                            <li key={message}>{message}</li>
                        ))}
                    </ul>
                ) : (
                    <>
                        <p role="status">
                            {tx("Rows ready to apply")} · {result.rows.length}
                        </p>
                        <figure>
                            <figcaption>{tx("Import preview")}</figcaption>
                            <pre>{JSON.stringify(result.rows.slice(0, 5), null, 2)}</pre>
                        </figure>
                    </>
                ))}
            <Button
                disabled={!result || !!result.issues.length}
                onClick={() => {
                    if (result && !result.issues.length) {
                        apply(result.rows);
                        clear();
                        setText("");
                    }
                }}
            >
                {tx("Apply import")}
            </Button>
        </Section>
    );
}
