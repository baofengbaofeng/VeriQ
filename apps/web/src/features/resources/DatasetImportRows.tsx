import { useEffect, useId, useRef, useState } from "react";
import { Button, Section } from "@veriq/ui";
import type { DataRowV2, DatasetV2 } from "@veriq/contracts";
import { Select, SelectItem } from "../../components/Select";
import { tx, useAppLocale } from "../../locale";
import { DataTable, useTableView } from "../../table-view";
import {
    datasetImportLimit,
    parseDatasetImport,
    type DatasetImportPlan,
    type DatasetImportResult,
} from "./dataset-import";

const acceptedFile = { CSV: ".csv", JSON: ".json", EXCEL: ".xlsx" };
type FileFormat = keyof typeof acceptedFile;
type ImportFormat = FileFormat | "TEXT";
const formatOptions = ["CSV", "JSON", "EXCEL", "TEXT"] as const;
const importSizeMiB = datasetImportLimit / (1024 * 1024);

/**
 * 列映射按新增或改名优先显示，分页限制同屏渲染数量，搜索与下载仍可处理预检得到的每一个字段映射。
 */
function ImportModelPreview({
    plan,
    currentFields,
    allowTableExport,
    hideEmptyMapping,
}: {
    plan: DatasetImportPlan;
    currentFields: DatasetV2["fields"];
    allowTableExport: boolean;
    hideEmptyMapping: boolean;
}) {
    const known = (column: (typeof plan.columns)[number]) =>
        column.header === column.field && Object.hasOwn(currentFields, column.field);
    const columns = plan.columns.filter((column) => !known(column)).concat(plan.columns.filter(known));
    const view = useTableView(columns, {
        scope: plan,
        matches: ({ header, field, type }, term) =>
            [header, field, type].some((value) => value.toLowerCase().includes(term)),
    });
    return (
        <>
            <p>
                {plan.rowKey === null
                    ? tx("Row keys will be generated in file order.")
                    : tx("Row key uses column {{header}}.", { header: plan.rowKey })}
            </p>
            {plan.tree && (
                <p>
                    {tx("Parent key uses column {{header}}.", { header: plan.tree.parentKey })}{" "}
                    {plan.tree.order === null
                        ? tx("Sibling order will be generated within each parent group in file order.")
                        : tx("Sibling order uses column {{header}}.", { header: plan.tree.order })}
                </p>
            )}
            {plan.removedStarter && <p>{tx("The blank starter field name will be removed.")}</p>}
            {(!hideEmptyMapping || columns.length > 0) && (
                <DataTable
                    label={tx("Imported column mapping")}
                    view={view}
                    searchLabel={tx("Search column mappings")}
                    exportAllowed={allowTableExport}
                    exportColumns={[
                        { label: tx("File header"), value: ({ header }) => header },
                        { label: tx("Dataset field"), value: ({ field }) => field },
                        { label: tx("Field type"), value: ({ type }) => type },
                    ]}
                >
                    <div className="table-scroll vq-dataset-table-scroll">
                        <table className="vq-dataset-import-columns" aria-label={tx("Imported column mapping")}>
                            <thead>
                                <tr>
                                    <th scope="col">{tx("File header")}</th>
                                    <th scope="col">{tx("Dataset field")}</th>
                                    <th scope="col">{tx("Field type")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {view.filteredCount === 0 && (
                                    <tr>
                                        <td className="vq-table-empty" colSpan={3}>
                                            {tx(
                                                columns.length ? "No matching column mappings." : "No column mappings.",
                                            )}
                                        </td>
                                    </tr>
                                )}
                                {view.rows.map(({ header, field, type }) => (
                                    <tr key={field}>
                                        <td>{header}</td>
                                        <td>{field}</td>
                                        <td>{type}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </DataTable>
            )}
        </>
    );
}

/**
 * 预检结果绑定当前字段和草稿快照，输入、格式或原始草稿发生变化就使旧结果失效。文件读取完成前后的选择序号
 * 隔离较慢的异步读取，确保先选文件不能覆盖后来粘贴的文本或随后选择的文件。
 * 对应用操作一起交付预检的字段和行，结构化 JSON 仍使用当前草稿的字段声明。
 */
export function ImportRows({
    dataset,
    apply,
    readOnly,
    allowTableExport,
    standalone = false,
}: {
    dataset: Extract<DatasetV2, { source: { kind: "STATIC" } }>;
    apply: (rows: DataRowV2[], fields: DatasetV2["fields"]) => void;
    readOnly: boolean;
    allowTableExport: boolean;
    standalone?: boolean;
}) {
    useAppLocale();
    const formatId = useId();
    const guidanceId = useId();
    const uploadHintId = useId();
    const formatLabel = tx("Import format");
    const [format, setFormat] = useState<ImportFormat>("CSV"),
        [text, setText] = useState("");
    const [selectedFile, setSelectedFile] = useState<File>();
    const [dragging, setDragging] = useState(false);
    const [preview, setPreview] = useState<{ baseline: string; result: DatasetImportResult }>();
    const [error, setError] = useState(""),
        [pending, setPending] = useState(false),
        loading = useRef(0);
    const input = useRef<HTMLInputElement>(null);
    const textarea = useRef<HTMLTextAreaElement>(null);
    useEffect(
        () => () => {
            loading.current++;
        },
        [],
    );
    const baseline = JSON.stringify(dataset),
        result = preview?.baseline === baseline ? preview.result : undefined;
    const fileExtension = format === "TEXT" ? undefined : acceptedFile[format];
    const clear = () => {
        loading.current++;
        setPreview(undefined);
        setError("");
        setPending(false);
    };
    // 切换格式时取消已选文件及等待中的读取，独立页签的粘贴内容不会作为新格式的文件内容参与预检。
    const changeFormat = (next: ImportFormat) => {
        clear();
        setSelectedFile(undefined);
        setDragging(false);
        if (standalone) setText("");
        setFormat(next);
    };
    // 祖先字段组禁用时，文本和文件控件都拒绝预检或应用，拖放也不会绕过只读和保存中的控件限制。
    const isLocked = () => readOnly || input.current?.matches(":disabled") || textarea.current?.matches(":disabled");
    async function acceptFiles(files: FileList | null) {
        const file = files?.item(0);
        if (isLocked() || !fileExtension || !files || !file) return;
        clear();
        setText("");
        setSelectedFile(undefined);
        if (standalone && format === "EXCEL" && files.length === 1 && /\.xls$/iu.test(file.name)) {
            setError(tx("For .xls files, save as .xlsx or export as CSV"));
            return;
        }
        if (files.length !== 1 || !file.name.toLowerCase().endsWith(fileExtension)) {
            setError(tx("Choose one {{extension}} file.", { extension: fileExtension }));
            return;
        }
        if (file.size > datasetImportLimit) {
            setError("DATASET_SIZE_LIMIT");
            return;
        }
        setSelectedFile(file);
        if (format === "EXCEL") return;
        // 等待期间如果又选择文件、切换格式或开始输入文本，旧内容没有资格覆盖用户的当前选择。
        const current = loading.current;
        try {
            const contents = await file.text();
            if (current === loading.current && !isLocked()) setText(contents);
        } catch {
            if (current === loading.current && !isLocked()) setError("FILE_READ_FAILED");
        }
    }
    async function readPreview() {
        if (isLocked()) return;
        clear();
        if (format !== "EXCEL") {
            // 文本入口用首个非空白字符识别结构化输入，保留原文本交给解析器计量大小并诊断格式错误。
            const parser = format === "TEXT" ? (/^[[{]/u.test(text.trimStart()) ? "JSON" : "CSV") : format;
            setPreview({ baseline, result: parseDatasetImport(parser, text, dataset) });
            return;
        }
        if (!selectedFile) return;
        const current = loading.current;
        setPending(true);
        try {
            const { readDatasetExcel } = await import("./dataset-excel");
            if (current !== loading.current) return;
            const result = await readDatasetExcel(selectedFile, dataset);
            if (current === loading.current) setPreview({ baseline, result });
        } catch {
            if (current === loading.current) setError("FILE_READ_FAILED");
        } finally {
            if (current === loading.current) setPending(false);
        }
    }
    const guidance =
        format === "TEXT"
            ? tx("Paste CSV with headers or a JSON array of row objects. Up to {{size}} MiB.", { size: importSizeMiB })
            : format === "JSON"
              ? tx(
                    standalone
                        ? "Choose a JSON file with an array of row objects."
                        : "Paste a JSON array of row objects.",
                )
              : [
                    tx(format === "CSV" ? "CSV headers and inferred types" : "Excel header and types"),
                    dataset.shape === "TREE" && tx("Tree import order guidance"),
                    tx("Import reserved column guidance"),
                ]
                    .filter(Boolean)
                    .join(" ");
    return (
        <Section title={tx("Import rows")}>
            <div className="vq-dataset-import-body">
                <p id={guidanceId} className="vq-dataset-import-guidance">
                    {guidance}
                </p>
                <div className={standalone ? "vq-dataset-import-radio-source" : "vq-dataset-import-sources"}>
                    {standalone ? (
                        <div
                            className="vq-dataset-import-formats"
                            role="radiogroup"
                            aria-labelledby={formatId}
                            aria-describedby={guidanceId}
                        >
                            <span id={formatId}>{formatLabel}</span>
                            <div className="vq-dataset-import-options">
                                {formatOptions.map((option) => (
                                    <label key={option}>
                                        <input
                                            type="radio"
                                            name={formatId}
                                            value={option}
                                            checked={format === option}
                                            disabled={readOnly}
                                            onChange={() => changeFormat(option)}
                                        />
                                        {option === "TEXT" ? tx("Text") : option === "EXCEL" ? "Excel" : option}
                                    </label>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <label htmlFor={formatId}>
                            {formatLabel}
                            <Select
                                id={formatId}
                                aria-label={formatLabel}
                                aria-describedby={guidanceId}
                                appearance="default-dropdown"
                                size="compact"
                                disabled={readOnly}
                                escapeClosesSelectOnly
                                value={format}
                                onValueChange={(value) => changeFormat(value as FileFormat)}
                            >
                                <SelectItem value="CSV">CSV</SelectItem>
                                <SelectItem value="JSON">JSON</SelectItem>
                                <SelectItem value="EXCEL">{tx("Excel (.xlsx)")}</SelectItem>
                            </Select>
                        </label>
                    )}
                    {fileExtension && (
                        <div className="vq-dataset-import-file">
                            <span>{tx("Import file")}</span>
                            <input
                                key={format}
                                ref={input}
                                type="file"
                                aria-label={tx("Import file")}
                                disabled={readOnly}
                                accept={fileExtension}
                                hidden
                                onChange={(event) => {
                                    void acceptFiles(event.currentTarget.files);
                                    event.currentTarget.value = "";
                                }}
                            />
                            <fieldset
                                className="vq-dataset-control-lock"
                                onDragOver={(event) => {
                                    if (!event.dataTransfer.types.includes("Files")) return;
                                    event.preventDefault();
                                    const locked = isLocked();
                                    event.dataTransfer.dropEffect = locked ? "none" : "copy";
                                    setDragging(!locked);
                                }}
                                onDragLeave={(event) => {
                                    const next = event.relatedTarget;
                                    if (!(next instanceof Node) || !event.currentTarget.contains(next))
                                        setDragging(false);
                                }}
                                onDrop={(event) => {
                                    if (!event.dataTransfer.types.includes("Files")) return;
                                    event.preventDefault();
                                    setDragging(false);
                                    void acceptFiles(event.dataTransfer.files);
                                }}
                            >
                                <button
                                    type="button"
                                    className="vq-dataset-dropzone"
                                    data-dragging={dragging || undefined}
                                    aria-label={tx("Choose import file")}
                                    aria-describedby={uploadHintId}
                                    disabled={readOnly}
                                    onClick={() => input.current?.click()}
                                >
                                    <span className="vq-dataset-upload-icon">
                                        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
                                            <path
                                                d="M12 16V4m-5 5 5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"
                                                stroke="currentColor"
                                                strokeWidth="1.5"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                            />
                                        </svg>
                                    </span>
                                    <span className="vq-dataset-upload-title" aria-live="polite">
                                        {selectedFile?.name ?? tx("Drop a file here or browse")}
                                    </span>
                                    <span id={uploadHintId} className="vq-dataset-upload-hint">
                                        {tx("{{extension}} file · up to {{size}} MiB", {
                                            extension: fileExtension,
                                            size: importSizeMiB,
                                        })}
                                    </span>
                                </button>
                            </fieldset>
                        </div>
                    )}
                </div>
                {(format === "TEXT" || (!standalone && format !== "EXCEL")) && (
                    <label className="vq-dataset-import-text">
                        {tx("Import text")}
                        <textarea
                            ref={textarea}
                            disabled={readOnly}
                            aria-describedby={guidanceId}
                            value={text}
                            onChange={(e) => {
                                clear();
                                setSelectedFile(undefined);
                                setText(e.target.value);
                            }}
                        />
                    </label>
                )}
                <Button
                    className="vq-dataset-import-action"
                    tone="secondary"
                    disabled={readOnly || pending || (format === "EXCEL" ? !selectedFile : !text)}
                    onClick={() => void readPreview()}
                >
                    {tx("Preview import")}
                </Button>
                {pending && <p role="status">{tx("Reading Excel workbook…")}</p>}
                {error && <p role="alert">{error}</p>}
                {result &&
                    (result.issues.length ? (
                        <ul role="alert">
                            {[
                                ...new Set(
                                    result.issues.map((issue) => [issue.row, issue.field, issue.code].join(" · ")),
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
                            {result.plan && (
                                <ImportModelPreview
                                    plan={result.plan}
                                    currentFields={dataset.fields}
                                    allowTableExport={allowTableExport && !readOnly}
                                    hideEmptyMapping={standalone}
                                />
                            )}
                            <figure className="vq-dataset-import-preview">
                                <figcaption>{tx("Import preview")}</figcaption>
                                <pre>{JSON.stringify(result.rows.slice(0, 5), null, 2)}</pre>
                            </figure>
                        </>
                    ))}
                <Button
                    className="vq-dataset-import-action"
                    disabled={readOnly || !result || !!result.issues.length}
                    onClick={() => {
                        if (!isLocked() && result && !result.issues.length) {
                            apply(result.rows, result.plan?.fields ?? dataset.fields);
                            clear();
                            setText("");
                            setSelectedFile(undefined);
                        }
                    }}
                >
                    {tx("Apply import")}
                </Button>
            </div>
        </Section>
    );
}
