/**
 * 本文件是契约包入口：提供 Ajv 严格校验、可移植 JSON 序列化、JCS 规范字节与资产源投影哈希输入，供调用方理解 as 路径。
 */

import canonicalizeModule from "canonicalize";
// canonicalize 2.x ships an ESM default declaration for its CommonJS export.
const canonicalize = canonicalizeModule as unknown as (value: unknown) => string | undefined;
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../schemas/platform-v1.schema.json" with { type: "json" };

export type * from "./types.generated.js";
export type { paths as PlatformPaths, components as PlatformComponents } from "./api.generated.js";

/**
 * 公开接口 ValidationIssue 描述契约校验问题：code 仅 SCHEMA_VIOLATION 或 INVALID_JSON。
 * 供各层稳定映射。
 */
export interface ValidationIssue {
    path: string;
    code: "SCHEMA_VIOLATION" | "INVALID_JSON";
    message: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats.default(ajv);
ajv.addSchema(schema);

function portableJson(value: unknown, ancestors = new Set<object>()): boolean {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number")
        return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
    if (typeof value !== "object" || ancestors.has(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
    ancestors.add(value);
    try {
        if (Object.getOwnPropertySymbols(value).length) return false;
        if (Array.isArray(value))
            return Array.from(value).every((item) => portableJson(item, ancestors));
        return Object.values(value).every((item) => portableJson(item, ancestors));
    } finally {
        ancestors.delete(value);
    }
}

/**
 * 不做强制转换、默认填充、删字段或语义引用解析，只报告 schema 违例。
 * 公开函数 validateSchema 按 schema 名对值做严格校验：无强制、无默认、无删字段：也不做语义引用解析。
 */
export function validateSchema(schemaName: string, value: unknown): ValidationIssue[] {
    if (!Object.hasOwn(schema.$defs, schemaName))
        throw new Error(`Unknown contract schema: ${schemaName}`);
    if (!portableJson(value))
        return [
            { path: "", code: "INVALID_JSON", message: "Expected finite, portable JSON values" },
        ];
    const validate = ajv.getSchema(`${schema.$id}#/$defs/${schemaName}`)!;
    if (validate(value)) return [];
    return (validate.errors ?? []).map((error) => ({
        path: error.instancePath,
        code: "SCHEMA_VIOLATION",
        message: error.message ?? error.keyword,
    }));
}

/**
 * 公开函数 validateCaseSchema 特化校验 CaseDslV1：等价于 validateSchema("CaseDslV1", value)。
 */
export function validateCaseSchema(value: unknown): ValidationIssue[] {
    return validateSchema("CaseDslV1", value);
}

/**
 * 公开函数 serializeContract 先校验再 JSON 序列化契约对象：有问题时抛出 issues 的 JSON 文本。
 */
export function serializeContract(schemaName: string, value: unknown): string {
    const issues = validateSchema(schemaName, value);
    if (issues.length) throw new Error(JSON.stringify(issues));
    return JSON.stringify(value);
}

/**
 * 公开函数 parseContract 解析文本并按 schema 名校验：返回未知值：失败抛出 issues JSON。
 */
export function parseContract(schemaName: string, text: string): unknown {
    const value: unknown = JSON.parse(text);
    const issues = validateSchema(schemaName, value);
    if (issues.length) throw new Error(JSON.stringify(issues));
    return value;
}

/**
 * 产出 RFC8785/JCS 字节；这不能替代对清单成员的精确字节签名。
 * 公开函数 canonicalBytes 生成 RFC8785/JCS 规范字节：拒绝非可移植 JSON 与孤立代理项：不替代精确字节清单签名。
 */
export function canonicalBytes(value: unknown): Uint8Array {
    if (!portableJson(value)) throw new Error("Expected portable JSON");
    const result = canonicalize(value);
    if (result === undefined) throw new Error("Expected JSON");
    // JCS rejects lone surrogates; JSON.stringify otherwise silently escapes them.
    function unicode(v: unknown): void {
        if (typeof v === "string" && /[\uD800-\uDFFF]/u.test(v)) throw new Error("Invalid Unicode");
        if (Array.isArray(v)) v.forEach(unicode);
        else if (v !== null && typeof v === "object")
            for (const [k, x] of Object.entries(v)) {
                unicode(k);
                unicode(x);
            }
    }
    unicode(value);
    return new TextEncoder().encode(result);
}

/**
 * 与 Python 共享的精确源投影；由调用方 SHA-256。排除 validationTarget、receipt/job 与声称的 sourceHash。
 * 公开函数 assetSourceBytes 投影资产源的规范字节：排除 validationTarget/receipt 与声称的 sourceHash。
 * 供调用方自行 SHA-256。
 */
export function assetSourceBytes(snapshot: Record<string, unknown>): Uint8Array {
    return canonicalBytes(
        Object.fromEntries(
            [
                "schemaVersion",
                "workspaceId",
                "engineVersion",
                "entryCaseVersionIds",
                "assets",
                ...(Object.hasOwn(snapshot, "authAdapters") ? ["authAdapters"] : []),
            ].map((key) => [
                key,
                key === "authAdapters"
                    ? [...(snapshot[key] as { versionId: string }[])].sort((a, b) =>
                          a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0,
                      )
                    : snapshot[key],
            ]),
        ),
    );
}

export * from "./bindings.js";
export type * from "./compiled.js";
