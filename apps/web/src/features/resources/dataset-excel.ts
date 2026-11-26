import type { DatasetV2 } from "@veriq/contracts";
import { unzipSync } from "fflate";
import { readSheet } from "read-excel-file/browser";
import { datasetImportLimit, parseDatasetSpreadsheet, type DatasetImportResult } from "./dataset-import";

const maxExpandedBytes = 16 * 1024 * 1024;
const maxParts = 512;
const maxMaterializedCells = 500_000;

/**
 * 读取前限制压缩目录与展开预算，避免小文件声明过大的输出；检查 XML 中的实际坐标以约束解析器填充稀疏单元格的开销。
 * 预检仅提取 XML，展开预算包括同一归档的全部条目，以覆盖浏览器工作簿读取器的解压路径。
 */
function checkArchive(bytes: Uint8Array) {
    if (bytes.length < 22) throw new Error("INVALID_EXCEL");
    const names = new Set<string>();
    let expanded = 0;
    const parts = unzipSync(bytes, {
        filter: ({ name, size, originalSize, compression }) => {
            if (names.has(name) || Object.hasOwn(Object.prototype, name)) throw new Error("INVALID_EXCEL");
            names.add(name);
            if (names.size > maxParts) throw new Error("DATASET_SIZE_LIMIT");
            expanded += compression === 0 ? size : originalSize;
            if (expanded > maxExpandedBytes) throw new Error("DATASET_SIZE_LIMIT");
            return /\.xml(?:\.rels)?$/u.test(name);
        },
    });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const part of Object.values(parts)) {
        const xml = decoder.decode(part);
        if (/<!DOCTYPE/u.test(xml)) throw new Error("INVALID_EXCEL");
        if (xml.includes("sheetData")) checkSheetRange(xml);
    }
}

/**
 * Excel 读取器会把缺失位置补成空单元格，预算按坐标形成的矩形计算，格式模板无须依赖不可靠的 dimension 声明。
 * 在解析 XML 的节点及属性后校验，嵌在注释、CDATA 或属性实体中的文字不会被当作坐标边界。
 */
function checkSheetRange(xml: string) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("INVALID_EXCEL");
    const rowElements = doc.getElementsByTagNameNS("*", "row");
    const cellElements = doc.getElementsByTagNameNS("*", "c");
    let rows = 0,
        columns = 1;
    for (const element of rowElements) {
        const ref = element.getAttribute("r");
        if (ref !== null && !/^[1-9][0-9]*$/u.test(ref)) throw new Error("INVALID_EXCEL");
        rows = Math.max(rows + 1, Number(ref));
        if (rows > maxMaterializedCells) throw new Error("EXCEL_RANGE_LIMIT");
    }
    for (const element of cellElements) {
        const match = /^([A-Z]{1,3})([1-9][0-9]*)$/u.exec(element.getAttribute("r") ?? "");
        if (!match) throw new Error("INVALID_EXCEL");
        let column = 0;
        for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
        rows = Math.max(rows, Number(match[2]));
        columns = Math.max(columns, column);
        if (rows * columns > maxMaterializedCells) throw new Error("EXCEL_RANGE_LIMIT");
    }
}

/**
 * 只读取第一张工作表，保留文本空格及换行，并把解析异常转换为独立预检诊断，防止破损文件覆盖当前数据行。
 */
export async function readDatasetExcel(file: File, dataset: DatasetV2): Promise<DatasetImportResult> {
    try {
        if (file.size > datasetImportLimit) throw new Error("DATASET_SIZE_LIMIT");
        if (!/\.xlsx$/iu.test(file.name)) throw new Error("INVALID_EXCEL");
        const bytes = new Uint8Array(await file.arrayBuffer());
        checkArchive(bytes);
        const cells = await readSheet(bytes, 1, {
            trim: false,
            parseNumber: (numberText) => ({ numberText }),
        });
        return parseDatasetSpreadsheet(cells, dataset);
    } catch (error) {
        const limit = error instanceof Error && ["DATASET_SIZE_LIMIT", "EXCEL_RANGE_LIMIT"].includes(error.message);
        return { rows: [], issues: [{ row: 1, field: "Excel", code: limit ? error.message : "INVALID_EXCEL" }] };
    }
}
