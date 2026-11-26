import {
    canonicalBytes,
    validateSchema,
    validateDataset,
    valueType,
    type DatasetV2,
    type DataRowV2,
    type DataFieldV2,
} from "@veriq/contracts";

/**
 * 上传、粘贴及候选草稿共用字节上限，分别检查输入及规范资源，避免可预检的行在保存时才因资源封装超出预算。
 */
export const datasetImportLimit = 10 * 1024 * 1024;

/**
 * 行号从一开始，CSV 使用记录起始物理行而 JSON 使用数组位置；字段使用原始业务名而非表单路径。
 */
export interface DatasetImportIssue {
    row: number;
    field: string;
    code: string;
}
const issueLimit = 100;
const rowMetadata = { TREE: ["key", "parentKey", "order"], TABLE: ["key"] };

/**
 * 成功的表格预检同时返回字段定义、表头映射及行键来源，使应用操作能按预览结果一起替换行并更新字段。
 */
export type DatasetImportPlan = {
    fields: DatasetV2["fields"];
    columns: { header: string; field: string; type: DataFieldV2["type"] }[];
    rowKey: string | null;
    removedStarter: boolean;
    tree?: { parentKey: string; order: string | null };
};

/**
 * 预检同时返回可应用的数据行与诊断，只有成功的表格才附导入计划，避免调用方应用部分成功的结果。
 */
export type DatasetImportResult = { rows: DataRowV2[]; issues: DatasetImportIssue[]; plan?: DatasetImportPlan };
type ImportCandidate = { rows: unknown; plan?: DatasetImportPlan };
type ExcelCell = string | number | boolean | Date | { numberText: string } | null;
type RecordLine<Cell = ExcelCell> = { line: number; cells: readonly Cell[] };
type Column = { header: string; field: string; meta: boolean; idRank?: number; keyRank?: number };
type Format = "CSV" | "Excel";
const nativeNumber = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;
const decodeField = (token: string) => token.replaceAll("~1", "/").replaceAll("~0", "~");
const bytes = (value: string) => new TextEncoder().encode(value).length;

/**
 * 字符扫描保留引号内的换行、逗号及成对双引号；闭引号后只接受分隔符或行末，以免吞掉格式错误。
 * 每个记录记住起始行号，文件末尾已有换行时不会额外产生一条空记录。
 */
function* csvRecords(text: string, issues: DatasetImportIssue[]): Generator<RecordLine<string>> {
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
        // 只跳过未加引号的独立空白行，分隔符和引号都可以明确表示真实的空值，仍应参与字段推断。
        let record: RecordLine<string> | undefined;
        if (cells.length || closed || cell.trim()) {
            cells.push(cell);
            record = { line: start, cells };
            headers ??= cells;
        }
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
            const record = finish();
            if (record) yield record;
            start = ++line;
        } else if (c === '"' && !cell && !closed) quoted = true;
        else if (closed || c === '"') {
            malformed();
            return;
        } else cell += c;
    }
    if (quoted) malformed();
    else {
        const record = finish();
        if (record) yield record;
    }
}

/**
 * CSV 字符串保留原文，其余类型按照 JSON 字面量读取，错误和缺失由调用方定位到当前记录及列。
 * JSON 的 null 只在 JSON 导入中有明确语义，CSV 中的空白只允许省略可选非字符串字段。
 */
function convert(value: string, field: DataFieldV2, numeric: boolean) {
    if (field.type === "string") return value;
    if (!value.trim() && !field.required) return undefined;
    const parsed = parseTabularValue(value, numeric);
    if (parsed === null) throw new SyntaxError();
    return parsed;
}

/**
 * 标识列按明确的名称惯例分级，避免把名称里偶然含有标识字母的业务列识别成实体的主键来源。
 */
function identifierRank(field: string) {
    if (/^id$/iu.test(field)) return 0;
    if (/[_.-]id$/iu.test(field) || /[a-z0-9](?:Id|ID)$/u.test(field)) return 1;
    if (/^code$/iu.test(field) || /[_.-]code$/iu.test(field) || /[a-z0-9](?:Code|CODE)$/u.test(field)) return 2;
    return undefined;
}

/**
 * 表头仍区分行元数据与业务列，保留合法字段键并公开其他映射，避免规范化后相同的列覆盖彼此。
 */
function mapColumns(names: readonly ExcelCell[], metadata: string[], issues: DatasetImportIssue[], row = 1) {
    const metaSeen = new Set<string>(),
        fieldsSeen = new Set<string>(),
        headersSeen = new Set<string>();
    const columns: Column[] = [];
    for (const [index, cell] of names.entries()) {
        const header = String(cell ?? "");
        const name = header.trim();
        const meta = metadata.includes(name);
        const qualified = name.startsWith("values.");
        const raw = meta ? name : name.replace(/^values\./u, "");
        const normalized = raw.trim().replace(/\s+/gu, "_");
        const field = validateSchema("Key", normalized).length ? `column_${index + 1}` : normalized;
        const seen = meta ? metaSeen : fieldsSeen;
        if (!raw.trim()) issues.push({ row, field: header || field, code: "INVALID_COLUMN_NAME" });
        else if (headersSeen.has(name) || seen.has(field)) issues.push({ row, field, code: "DUPLICATE_COLUMN" });
        headersSeen.add(name);
        seen.add(field);
        if (issues.length >= issueLimit) break;
        const idRank = meta ? undefined : identifierRank(field);
        columns.push({ header, field, meta, idRank, keyRank: qualified ? undefined : idRank });
    }
    return columns;
}

/**
 * 同级列不能独立确定真实主键时不猜测，较低优先级的列也不能在更强的候选有歧义时悄然取代它。
 */
function keySource(columns: Column[]) {
    const explicit = columns.findIndex((column) => column.meta && column.field === "key");
    if (explicit >= 0) return explicit;
    for (const rank of [0, 1, 2]) {
        const first = columns.findIndex((column) => column.keyRank === rank);
        if (first >= 0) {
            const ambiguous = columns.some((column, index) => index > first && column.keyRank === rank);
            return ambiguous ? -1 : first;
        }
    }
    return -1;
}

/**
 * 树形导入只识别约定的裸列名作为父引用，明确的父键元数据优先，其他相似名称继续作为业务字段使用。
 */
function parentSource(columns: Column[]) {
    const explicit = columns.findIndex((column) => column.meta && column.field === "parentKey");
    return explicit >= 0 ? explicit : columns.findIndex((column) => column.header.trim() === "parent");
}

/**
 * 工作簿显式文本保留字面内容，数字单元格也保留未经过浮点转换的原始拼写，日期按已有规则转换成标准文本。
 */
function cellText(cell: ExcelCell) {
    if (cell instanceof Date) return cell.toISOString();
    if (cell && typeof cell === "object") {
        if (!nativeNumber.test(cell.numberText)) throw new SyntaxError();
        return cell.numberText;
    }
    return String(cell ?? "");
}

/**
 * 十进制拼写归一化只调整尾零和指数，不把系数转成浮点，因此能区分精度变化与无损的科学计数写法。
 */
function decimalSpelling(text: string) {
    const parts = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:e([+-]?\d+))?$/iu.exec(text);
    if (!parts) return undefined;
    const [, sign = "", whole = "", fraction = "", exponent = "0"] = parts;
    const digits = (whole + fraction).replace(/^0+/u, "");
    let end = digits.length;
    while (end > 0 && digits[end - 1] === "0") end--;
    const coefficient = digits.slice(0, end);
    const power = Number(exponent) - fraction.length + digits.length - end;
    return coefficient ? `${sign}${coefficient}e${power}` : `${sign}0`;
}

/**
 * 工作簿原生数值允许前置正号及小数点两侧的简写，规范化拼写只用于比对精度，分开保留原始文本和标识列。
 */
function excelDecimal(text: string) {
    return text
        .replace(/^\+/u, "")
        .replace(/^\./u, "0.")
        .replace(/^-\./u, "-0.")
        .replace(/\.(?=e|$)/iu, ".0");
}

/**
 * 使用契约允许的安全数值范围和十进制回写核对是否保真，短小或长尾零的兼容拼写仍可表示相同业务值。
 */
function preservesNumber(text: string, value: number) {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return false;
    const normal = decimalSpelling(text);
    const spelling = Object.is(value, -0) ? "-0" : String(value);
    return normal !== undefined && decimalSpelling(spelling) === normal;
}

/**
 * 已声明的数值和树顺序不能静默降级成文字，重导入遇到舍入、溢出或下溢时继续使用对应原始列的错误定位。
 */
function parseTabularValue(text: string, numeric: boolean): unknown {
    const parsed: unknown = numeric ? Number(text) : JSON.parse(text);
    if (typeof parsed === "number") {
        const decimal = numeric ? excelDecimal(text).replace(/^(-?)0+(?=\d)/u, "$1") : text.trim();
        if (!preservesNumber(decimal, parsed)) throw new SyntaxError();
    }
    return parsed;
}

/**
 * 数字推断检查可移植范围和可靠的十进制回写，保留前导零、超过安全范围的整数及不能保留原始精度的小数。
 */
function inferredNumber(text: string): DataFieldV2["type"] {
    if (text.length > 64) return "string";
    const value = Number(text);
    if (Object.is(value, -0) || !preservesNumber(text, value)) return "string";
    return Number.isInteger(value) ? "integer" : "number";
}

/**
 * 只有结构化文本能够无损回写且通过可移植 JSON 检查时才推断为容器，歧义值继续作为普通业务字符串。
 */
function inferredType(cell: ExcelCell, format: Format, text: string): DataFieldV2["type"] {
    if (typeof cell === "boolean") return "boolean";
    if (format === "Excel") {
        if (typeof cell === "number") return inferredNumber(text);
        if (cell && typeof cell === "object" && "numberText" in cell) return inferredNumber(excelDecimal(text));
        return "string";
    }
    if (text === "true" || text === "false") return "boolean";
    if (!text.startsWith("{") && !text.startsWith("[")) return inferredNumber(text);
    try {
        const value: unknown = JSON.parse(text);
        if (JSON.stringify(value) === text && !validateSchema("JsonValue", value).length)
            return Array.isArray(value) ? "array" : "object";
    } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof RangeError)) throw error;
    }
    return "string";
}

/**
 * 字段声明只向已有模型追加，只有一行空白且完全匹配编辑器初始化形状的占位字段允许由表头替换。
 */
function isBlankStarter(dataset: DatasetV2) {
    if (!Object.hasOwn(dataset.fields, "name") || Object.keys(dataset.fields).length !== 1) return false;
    const field = dataset.fields.name;
    if (field?.type !== "string" || !field.required || field.nullable || dataset.source.kind !== "STATIC") return false;
    const [row] = dataset.source.rows;
    if (dataset.source.rows.length !== 1 || row?.key !== "row_1") return false;
    if (!Object.hasOwn(row.values, "name") || Object.keys(row.values).length !== 1 || row.values.name !== "")
        return false;
    return dataset.shape === "TABLE" || ("parentKey" in row && row.parentKey === null && row.order === 0);
}

/**
 * 数字始终兼容整数，其他不一致的类型统一退回字符串，同一规则也适用于源文件中具有原生类型的值。
 */
function mergeFieldType(previous: DataFieldV2["type"] | undefined, next: DataFieldV2["type"]): DataFieldV2["type"] {
    if (!previous || previous === next) return next;
    if ((previous === "integer" && next === "number") || (previous === "number" && next === "integer")) return "number";
    return "string";
}

/**
 * 两阶段处理在读完所有非空单元格之后再转换值，同列混合类型会安全回退为字符串而不丢弃原字面值。
 */
function inferFields(
    records: Iterable<RecordLine>,
    columns: Column[],
    format: Format,
    fields: DatasetV2["fields"],
    issues: DatasetImportIssue[],
    parentIndex: number,
) {
    const inferred = columns.flatMap((column, index) =>
        column.meta || Object.hasOwn(fields, column.field)
            ? []
            : [{ column, index, type: undefined as DataFieldV2["type"] | undefined, required: true }],
    );
    if (!inferred.length) return false;
    let textSize = 0;
    for (const { line, cells } of records) {
        if (cells.length !== columns.length) {
            issues.push({ row: line, field: format, code: "COLUMN_COUNT" });
            if (issues.length >= issueLimit) break;
            continue;
        }
        for (const candidate of inferred) {
            const cell = cells[candidate.index] ?? null;
            const text = cellText(cell);
            textSize += text.length;
            if (textSize > datasetImportLimit) {
                issues.push({ row: line, field: format, code: "DATASET_SIZE_LIMIT" });
                return true;
            }
            if (!text.trim()) candidate.required = false;
            else if (candidate.type !== "string") {
                const identifier = candidate.column.idRank !== undefined || candidate.index === parentIndex;
                const next = identifier ? "string" : inferredType(cell, format, text);
                candidate.type = mergeFieldType(candidate.type, next);
            }
        }
    }
    for (const { column, type, required } of inferred) {
        Object.defineProperty(fields, column.field, {
            value: { type: type ?? "string", required: !!type && required, nullable: false },
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    return true;
}

/**
 * 推断的数字标识需要固定前缀以满足契约，父节点引用在同一导入中使用完全相同的映射规则。
 */
function aliasKey(text: string) {
    return /^-?(?:\d|\.\d)/u.test(text) ? `id_${text}` : text;
}

/**
 * 映射开始前每个业务列必须已有明确类型，拒绝意外漏建的字段，避免继承属性被当成当前导入的字段定义。
 */
function fieldDefinition(fields: DatasetV2["fields"], key: string) {
    const field = fields[key];
    if (!Object.hasOwn(fields, key) || !field) throw new Error("Missing import field definition");
    return field;
}

/**
 * 表格映射统一处理显式行元数据与推断行键，沿用行及候选文档字节限制，避免返回可应用的部分结果。
 */
function mappedRows(
    read: () => IterableIterator<RecordLine>,
    format: Format,
    dataset: DatasetV2,
    issues: DatasetImportIssue[],
    lines: number[],
): ImportCandidate {
    let records = read();
    const header = records.next().value as RecordLine | undefined;
    if (issues.length) return { rows: [] };
    const metadata = rowMetadata[dataset.shape];
    const headerLine = header?.line ?? 1;
    const columns = mapColumns(header?.cells ?? [], metadata, issues, headerLine);
    const keyIndex = keySource(columns);
    const tree = dataset.shape === "TREE";
    const parentIndex = tree ? parentSource(columns) : -1;
    const parentColumn = columns[parentIndex];
    const orderColumn = columns.find((column) => column.meta && column.field === "order");
    const missing = [];
    if (keyIndex < 0 && (tree || !header)) missing.push("key");
    if (tree && !parentColumn) missing.push("parentKey");
    for (const field of missing)
        if (issues.length < issueLimit) issues.push({ row: headerLine, field, code: "MISSING_COLUMN" });
    if (issues.length) return { rows: [] };

    const fields = { ...dataset.fields };
    const fieldColumns = columns.filter((column) => !column.meta);
    const removedStarter =
        isBlankStarter(dataset) && fieldColumns.length > 0 && !fieldColumns.some((column) => column.field === "name");
    if (removedStarter) delete fields.name;
    if (inferFields(records, columns, format, fields, issues, parentIndex)) {
        if (issues.length) return { rows: [] };
        records = read();
        records.next();
    }
    const keyColumn = columns[keyIndex];
    const inferredKey = keyColumn && !keyColumn.meta;
    const plan: DatasetImportPlan = {
        fields,
        columns: fieldColumns.map(({ header, field }) => ({
            header,
            field,
            type: fieldDefinition(fields, field).type,
        })),
        rowKey: keyColumn?.header ?? null,
        removedStarter,
        ...(parentColumn ? { tree: { parentKey: parentColumn.header, order: orderColumn?.header ?? null } } : {}),
    };
    const siblingOrders = tree && !orderColumn ? new Map<string | null, number>() : undefined;
    const rows: unknown[] = [];
    let size = 0;
    for (const { line, cells } of records) {
        lines.push(line);
        const values = new Map<string, unknown>();
        const meta = new Map<string, unknown>([["key", `row_${rows.length + 1}`]]);
        let parent: string | null = null;
        if (cells.length !== columns.length) {
            issues.push({ row: line, field: format, code: "COLUMN_COUNT" });
            if (issues.length >= issueLimit) return { rows: [] };
            continue;
        }
        for (const [i, { field, meta: isMetadata }] of columns.entries()) {
            const cell = cells[i] ?? null;
            const raw = cellText(cell);
            const numeric = !!(cell && typeof cell === "object" && "numberText" in cell);
            if (i === parentIndex && raw !== "") parent = inferredKey ? aliasKey(raw) : raw;
            if (i === keyIndex && inferredKey) {
                const key = aliasKey(raw);
                if (validateSchema("Key", key).length) issues.push({ row: line, field, code: "INVALID_ROW_KEY" });
                if (issues.length >= issueLimit) return { rows: [] };
                meta.set("key", key);
            }
            try {
                if (isMetadata) {
                    if (field === "key") meta.set("key", raw);
                    if (field === "order") meta.set("order", parseTabularValue(raw, numeric));
                } else {
                    const value = convert(raw, fieldDefinition(fields, field), numeric);
                    if (value !== undefined) values.set(field, value);
                }
            } catch (error) {
                if (!(error instanceof SyntaxError)) throw error;
                issues.push({ row: line, field, code: "DATASET_FIELD_TYPE_MISMATCH" });
                if (issues.length >= issueLimit) return { rows: [] };
            }
        }
        if (tree) meta.set("parentKey", parent);
        // 根节点独立成组，子节点用解析后的父键计数，相距多行甚至先于父节点出现时也保留输入顺序。
        if (siblingOrders) {
            const order = siblingOrders.get(parent) ?? 0;
            meta.set("order", order);
            siblingOrders.set(parent, order + 1);
        }
        const row = { ...Object.fromEntries(meta), values: Object.fromEntries(values) };
        size += bytes(JSON.stringify(row)) + 1;
        if (size > datasetImportLimit) {
            issues.push({ row: line, field: format, code: "DATASET_SIZE_LIMIT" });
            break;
        }
        rows.push(row);
    }
    return { rows, plan };
}

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
const ownValue = (record: Record<string, unknown>, column: Column | undefined) =>
    column && Object.hasOwn(record, column.header) ? record[column.header] : undefined;

/**
 * 扁平对象的标识列与文件表头遵循同样的优先级，行键与父引用共用转换，业务字段仍保留原生数值和空值。
 */
function jsonAlias(value: unknown) {
    if (typeof value === "string") return aliasKey(value);
    if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value))
    )
        return aliasKey(String(value));
    return value;
}

/**
 * 扁平对象可包含稀疏字段，按各行实际属性映射已有字段名，同时从显式或推断的元数据生成契约要求的行结构。
 */
function flatJsonRows(rows: unknown[], shape: DatasetV2["shape"], issues: DatasetImportIssue[]) {
    const headers = new Set<string>();
    for (const row of rows) if (isJsonRecord(row)) for (const key of Object.keys(row)) headers.add(key);
    const columns = mapColumns([...headers], rowMetadata[shape], issues);
    const keyColumn = columns[keySource(columns)];
    const parentColumn = shape === "TREE" ? columns[parentSource(columns)] : undefined;
    const orderColumn = columns.find(({ meta, field }) => meta && field === "order");
    if (shape === "TREE" && !keyColumn && issues.length < issueLimit)
        issues.push({ row: 1, field: "key", code: "MISSING_COLUMN" });
    if (shape === "TREE" && !parentColumn && issues.length < issueLimit)
        issues.push({ row: 1, field: "parentKey", code: "MISSING_COLUMN" });
    const tree = parentColumn && { parentKey: parentColumn.header, order: orderColumn?.header ?? null };
    const rowKey = keyColumn?.header ?? null;
    const business = columns.filter(({ meta }) => !meta);
    if (issues.length) return { rows: [], business, rowKey, tree };

    const fieldsByHeader = new Map(business.map(({ header, field }) => [header, field]));
    const siblingOrders = new Map<unknown, number>();
    const normalized = rows.map((row, index) => {
        if (!isJsonRecord(row)) return row;
        const values = Object.fromEntries(
            Object.entries(row).flatMap(([header, value]) => {
                const field = fieldsByHeader.get(header);
                return field ? [[field, value]] : [];
            }),
        );
        const rawKey = ownValue(row, keyColumn);
        const inferredKey = keyColumn && !keyColumn.meta;
        const key = !keyColumn ? `row_${index + 1}` : inferredKey ? jsonAlias(rawKey) : rawKey;
        if (!tree) return { key, values };

        const rawParent = ownValue(row, parentColumn);
        const parentKey = rawParent == null || rawParent === "" ? null : inferredKey ? jsonAlias(rawParent) : rawParent;
        let order: unknown = ownValue(row, orderColumn);
        if (!orderColumn) {
            const nextOrder = siblingOrders.get(parentKey) ?? 0;
            siblingOrders.set(parentKey, nextOrder + 1);
            order = nextOrder;
        }
        return { key, parentKey, order, values };
    });
    return { rows: normalized, business, rowKey, tree };
}

type JsonFieldEvidence = { type?: DataFieldV2["type"]; present: number; nullable: boolean };

/**
 * 只统计实际提供的属性来辨认必填及空值，类型冲突退回字符串，不覆盖用户声明或把不存在的属性补成空值。
 */
function jsonFieldEvidence(rows: unknown[]) {
    const observed = new Map<string, JsonFieldEvidence>();
    for (const row of rows) {
        if (!isJsonRecord(row) || !isJsonRecord(row.values)) continue;
        for (const [key, value] of Object.entries(row.values)) {
            const evidence = observed.get(key) ?? { present: 0, nullable: false };
            evidence.present++;
            const type = valueType(value);
            if (type === "null") evidence.nullable = true;
            else evidence.type = mergeFieldType(evidence.type, type);
            observed.set(key, evidence);
        }
    }
    return observed;
}

/**
 * 只对新推断为字符串且值不是文字的字段做保真序列化，先经过规范 JSON 检查以免无效数字或 Unicode 静默变成字符串。
 */
function portableFieldText(value: unknown) {
    try {
        return new TextDecoder().decode(canonicalBytes(value));
    } catch (error) {
        if (error instanceof Error && ["Expected portable JSON", "Invalid Unicode"].includes(error.message))
            throw new SyntaxError(error.message);
        throw error;
    }
}

/**
 * 已有行包裹层继续由原有结构校验约束。只有确认是扁平对象数组时才映射外部属性，预检始终同时返回行和新增字段。
 */
function jsonRows(rows: unknown, dataset: DatasetV2, issues: DatasetImportIssue[]): ImportCandidate {
    if (!Array.isArray(rows) || !rows.some(isJsonRecord)) return { rows };
    // 每条可保存行至少占用键与值对象的固定开销，跨越预算的输入不再分配完整的中间行数组与字段模型。
    if (rows.length * '{"key":"a","values":{}}'.length > datasetImportLimit) {
        issues.push({ row: 1, field: "JSON", code: "DATASET_SIZE_LIMIT" });
        return { rows: [] };
    }
    const metadata = rowMetadata[dataset.shape];
    const wrapped = rows.some(
        (row) =>
            isJsonRecord(row) &&
            Object.hasOwn(row, "values") &&
            (Object.hasOwn(row, "key") || Object.keys(row).every((key) => key === "values" || metadata.includes(key))),
    );
    const flat = wrapped ? undefined : flatJsonRows(rows, dataset.shape, issues);
    if (issues.length) return { rows: [] };
    const normalized: unknown[] = flat?.rows ?? rows;
    const observed = jsonFieldEvidence(normalized);
    const fields = { ...dataset.fields };
    const inferred = new Map<string, DataFieldV2>();
    for (const [key, { type, nullable, present }] of observed)
        if (!Object.hasOwn(fields, key) && !validateSchema("Key", key).length)
            inferred.set(key, { type: type ?? "string", required: present === rows.length, nullable });
    if (!flat && !inferred.size) return { rows };

    const removedStarter = isBlankStarter(dataset) && inferred.size > 0 && !observed.has("name");
    if (removedStarter) delete fields.name;
    const combined = { ...fields, ...Object.fromEntries(inferred) };
    const columns = flat?.business ?? [...observed.keys()].map((field) => ({ field, header: field }));
    const converted = inferred.size
        ? normalized.map((row) => {
              if (!isJsonRecord(row) || !isJsonRecord(row.values)) return row;
              const values = Object.fromEntries(
                  Object.entries(row.values).map(([field, value]) => [
                      field,
                      inferred.get(field)?.type === "string" && value !== null && typeof value !== "string"
                          ? portableFieldText(value)
                          : value,
                  ]),
              );
              return { ...row, values };
          })
        : normalized;
    return {
        rows: converted,
        plan: {
            fields: combined,
            columns: columns
                .filter(({ field }) => Object.hasOwn(combined, field))
                .map(({ header, field }) => ({ header, field, type: fieldDefinition(combined, field).type })),
            rowKey: flat ? flat.rowKey : "key",
            removedStarter,
            ...(flat?.tree && { tree: flat.tree }),
        },
    };
}

/**
 * 文件与粘贴原文按相同的字节上限检查，随后用共享的字段类型和父链规则验证，任何诊断都会阻止应用整批行。
 * 表格和 JSON 候选同时校验新字段和行，导入不改变资源身份或草稿修订号。
 */
export function parseDatasetImport(format: "CSV" | "JSON", text: string, dataset: DatasetV2): DatasetImportResult {
    if (bytes(text) > datasetImportLimit) return failedImport(format, "DATASET_SIZE_LIMIT");
    const content = text.replace(/^\uFEFF/u, "");
    return validatedImport(format, dataset, (issues, lines) =>
        format === "CSV"
            ? mappedRows(() => csvRecords(content, issues), format, dataset, issues, lines)
            : jsonRows(JSON.parse(content), dataset, issues),
    );
}

/**
 * 首行读取实际文本列名，跳过整行留空的记录，其余单元格按表格导入规则转换，诊断仍指向工作表行号。
 */
export function parseDatasetSpreadsheet(
    sheet: ReadonlyArray<readonly ExcelCell[]>,
    dataset: DatasetV2,
): DatasetImportResult {
    const header = sheet[0] ?? [];
    if (!header.length || header.some((cell) => typeof cell !== "string" || !cell.trim()))
        return failedImport("Excel", "INVALID_EXCEL_HEADER");
    function* records(): Generator<RecordLine> {
        for (const [index, row] of sheet.entries()) {
            if (index > 0 && row.every((cell) => cell === null)) continue;
            yield {
                line: index + 1,
                cells: row,
            };
        }
    }
    return validatedImport("Excel", dataset, (issues, lines) => mappedRows(records, "Excel", dataset, issues, lines));
}

function failedImport(field: string, code: string): DatasetImportResult {
    return { rows: [], issues: [{ row: 1, field, code }] };
}

function validatedImport(
    format: "CSV" | "JSON" | "Excel",
    dataset: DatasetV2,
    read: (issues: DatasetImportIssue[], lines: number[]) => ImportCandidate,
): DatasetImportResult {
    const issues: DatasetImportIssue[] = [],
        lines: number[] = [];
    const fail = (code: string) => failedImport(format, code);
    const invalidValue = format === "Excel" ? "INVALID_EXCEL" : "INVALID_JSON";
    try {
        const { rows, plan } = read(issues, lines);
        if (!Array.isArray(rows)) return fail("EXPECTED_ROW_ARRAY");
        if (issues.length) return { rows: [], issues };
        const candidate = { ...dataset, fields: plan?.fields ?? dataset.fields, source: { kind: "STATIC", rows } };

        const allowed = new Set([...rowMetadata[dataset.shape], "values"]);
        for (const [i, row] of rows.entries()) {
            const line = lines[i] ?? i + 1;
            // 单行若已含足够多的额外属性，只记录实际存在的未知键，避免全错误模式在校验器内先生成整份诊断。
            if (row && typeof row === "object" && !Array.isArray(row)) {
                const keys = Object.keys(row);
                if (keys.length >= allowed.size + issueLimit - issues.length) {
                    for (const field of keys) {
                        if (!allowed.has(field)) issues.push({ row: line, field, code: "SCHEMA_VIOLATION" });
                        if (issues.length >= issueLimit) return { rows: [], issues };
                    }
                }
            }
            for (const issue of validateSchema(dataset.shape === "TREE" ? "TreeDataRowV2" : "DataRowV1", row, true)) {
                issues.push({
                    row: line,
                    field: decodeField(issue.path.split("/").pop() || "row"),
                    code: issue.code,
                });
                if (issues.length >= issueLimit) return { rows: [], issues };
            }
        }
        if (!issues.length) {
            try {
                if (canonicalBytes({ kind: "DATASET", document: candidate }).length > datasetImportLimit)
                    return fail("DATASET_SIZE_LIMIT");
            } catch (error) {
                if (error instanceof RangeError || (error instanceof Error && error.message === "Invalid Unicode"))
                    return fail(invalidValue);
                throw error;
            }
            for (const issue of validateDataset(candidate as DatasetV2, "", issueLimit)) {
                const [, , , index, ...path] = issue.path.split("/");
                issues.push({
                    row: lines[Number(index)] ?? Number(index) + 1,
                    field: decodeField(path.at(-1) ?? "row"),
                    code: issue.code,
                });
            }
        }
        return issues.length ? { rows: [], issues } : { rows, issues, ...(plan ? { plan } : {}) };
    } catch (error) {
        if (error instanceof SyntaxError || error instanceof RangeError) return fail(invalidValue);
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
