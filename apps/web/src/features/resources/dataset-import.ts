import {
    canonicalBytes,
    validateSchema,
    validateDataset,
    type DatasetV2,
    type DataRowV2,
    type DataFieldV2,
} from "@veriq/contracts";

/**
 * 在读取本地文件和转换候选资源时分别执行字节预算检查，包含字段声明的文档也必须能够通过草稿提交。
 */
export const datasetImportLimit = 2 * 1024 * 1024;

/**
 * 行号从一开始，CSV 使用记录起始物理行而 JSON 使用数组位置；字段使用原始业务名而非表单路径。
 */
export interface DatasetImportIssue {
    row: number;
    field: string;
    code: string;
}
type Result = { rows: DataRowV2[]; issues: DatasetImportIssue[] };
type RecordLine = { line: number; cells: string[] };
const decodeField = (token: string) => token.replaceAll("~1", "/").replaceAll("~0", "~");
const bytes = (value: string) => new TextEncoder().encode(value).length;

/**
 * 字符扫描保留引号内的换行、逗号及成对双引号；闭引号后只接受分隔符或行末，以免吞掉格式错误。
 * 每个记录记住起始行号，文件末尾已有换行时不会额外产生一条空记录。
 */
function* csvRecords(text: string, issues: DatasetImportIssue[]): Generator<RecordLine> {
    let headers: string[] | undefined;
    const malformed = () =>
        issues.push({
            row: start,
            field: headers?.[cells.length]?.replace(/^values\./u, "") || "CSV",
            code: "INVALID_CSV",
        });
    let cells: string[] = [],
        cell = "",
        quoted = false,
        closed = false,
        line = 1,
        start = 1;
    const finish = () => {
        cells.push(cell);
        const record = { line: start, cells };
        headers ??= cells;
        cells = [];
        cell = "";
        closed = false;
        return record;
    };
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else {
                    quoted = false;
                    closed = true;
                }
            } else {
                if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) line++;
                cell += c;
            }
        } else if (c === ",") {
            cells.push(cell);
            cell = "";
            closed = false;
        } else if (c === "\r" || c === "\n") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            yield finish();
            start = ++line;
        } else if (c === '"' && !cell && !closed) quoted = true;
        else if (closed || c === '"') {
            malformed();
            return;
        } else cell += c;
    }
    if (quoted) malformed();
    else if (cell || cells.length || closed) yield finish();
}

/**
 * CSV 字符串保留原文，其余类型按照 JSON 字面量读取，错误和缺失由调用方定位到当前记录及列。
 * JSON 的 null 只在 JSON 导入中有明确语义，CSV 中的空白只允许省略可选非字符串字段。
 */
function convert(value: string, field: DataFieldV2) {
    if (field.type === "string") return value;
    if (!value.trim() && !field.required) return undefined;
    const parsed: unknown = JSON.parse(value);
    if (parsed === null) throw new SyntaxError();
    return parsed;
}

function csvRows(text: string, dataset: DatasetV2, issues: DatasetImportIssue[], lines: number[]) {
    const records = csvRecords(text.replace(/^\uFEFF/u, ""), issues);
    const header = records.next().value as RecordLine | undefined;
    if (issues.length) return [];
    const names = header?.cells ?? [];
    const metadata = dataset.shape === "TREE" ? ["key", "parentKey", "order"] : ["key"];
    const metaSeen = new Set<string>(),
        fieldsSeen = new Set<string>();
    const columns = names.map((name) => {
        const meta = metadata.includes(name);
        const field = meta ? name : name.replace(/^values\./u, "");
        const seen = meta ? metaSeen : fieldsSeen;
        if (seen.has(field)) issues.push({ row: 1, field, code: "DUPLICATE_COLUMN" });
        else if (!meta && !Object.hasOwn(dataset.fields, field))
            issues.push({ row: 1, field, code: "DATASET_UNKNOWN_FIELD" });
        seen.add(field);
        return { field, meta };
    });
    for (const field of metadata) if (!metaSeen.has(field)) issues.push({ row: 1, field, code: "MISSING_COLUMN" });
    if (issues.length) return [];
    const rows = [];
    let size = 0;
    for (const { line, cells } of records) {
        if (issues.length >= 100) break;
        lines.push(line);
        const values = new Map<string, unknown>();
        const meta = new Map<string, unknown>();
        if (cells.length !== names.length) {
            issues.push({ row: line, field: "CSV", code: "COLUMN_COUNT" });
            continue;
        }
        for (const [i, raw] of cells.entries()) {
            const { field, meta: isMetadata } = columns[i]!;
            try {
                if (isMetadata) {
                    const value =
                        field === "order" ? JSON.parse(raw) : field === "parentKey" && raw === "" ? null : raw;
                    meta.set(field, value);
                } else {
                    const value = convert(raw, dataset.fields[field]!);
                    if (value !== undefined) values.set(field, value);
                }
            } catch (error) {
                if (!(error instanceof SyntaxError)) throw error;
                issues.push({ row: line, field, code: "DATASET_FIELD_TYPE_MISMATCH" });
            }
        }
        const row = { ...Object.fromEntries(meta), values: Object.fromEntries(values) };
        size += bytes(JSON.stringify(row)) + 1;
        if (size > datasetImportLimit) {
            issues.push({ row: line, field: "CSV", code: "DATASET_SIZE_LIMIT" });
            break;
        }
        rows.push(row);
    }
    return rows;
}

/**
 * 先核对每行结构，随后使用编译器共享的值类型及父链验证，任何阶段产生诊断都不会交出部分成功的行。
 * 校验目标包含现有字段声明；替换行不改变资源身份、草稿修订号或原始的字段定义。
 */
export function parseDatasetImport(format: "CSV" | "JSON", text: string, dataset: DatasetV2): Result {
    const issues: DatasetImportIssue[] = [],
        lines: number[] = [];
    const fail = (code: string): Result => ({ rows: [], issues: [{ row: 1, field: format, code }] });
    if (bytes(text) > datasetImportLimit) return fail("DATASET_SIZE_LIMIT");
    try {
        const rows: unknown = format === "CSV" ? csvRows(text, dataset, issues, lines) : JSON.parse(text);
        if (!Array.isArray(rows)) return fail("EXPECTED_ROW_ARRAY");
        if (issues.length) return { rows: [], issues };
        const candidate = { ...dataset, source: { kind: "STATIC", rows } } as DatasetV2;

        for (const [i, row] of rows.entries()) {
            for (const issue of validateSchema(dataset.shape === "TREE" ? "TreeDataRowV2" : "DataRowV1", row, true)) {
                issues.push({
                    row: lines[i] ?? i + 1,
                    field: decodeField(issue.path.split("/").pop() || "row"),
                    code: issue.code,
                });
            }
        }
        if (!issues.length) {
            try {
                if (canonicalBytes({ kind: "DATASET", document: candidate }).length > datasetImportLimit)
                    return fail("DATASET_SIZE_LIMIT");
            } catch (error) {
                if (error instanceof RangeError || (error instanceof Error && error.message === "Invalid Unicode"))
                    return fail("INVALID_JSON");
                throw error;
            }
            for (const issue of validateDataset(candidate)) {
                const [, , , index, ...path] = issue.path.split("/");
                issues.push({
                    row: lines[Number(index)] ?? Number(index) + 1,
                    field: decodeField(path.at(-1) ?? "row"),
                    code: issue.code,
                });
            }
        }
        return { rows: issues.length ? [] : rows, issues };
    } catch (error) {
        if (error instanceof SyntaxError || error instanceof RangeError) return fail("INVALID_JSON");
        throw error;
    }
}

/**
 * 表单库深拷贝会逐键赋值；仅在对象实际拥有原型访问器同名字段时去掉原型，让该键始终保持普通数据属性。
 * 递归处理通过 JSON 编辑器、文件以及服务器草稿进入表单的嵌套对象，不更改其可序列化表示。
 */
export function formJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value), (_key, node) =>
        node && typeof node === "object" && Object.hasOwn(node, "__proto__")
            ? Object.assign(Object.create(null), node)
            : node,
    );
}
