/**
 * 本文件把校验问题投影为可安全外泄的诊断：只保留 schema 拥有的路径段：动态键一律脱敏以免泄露凭证形态字段（Set）。
 */

import type { ValidationIssue } from "./dependency.js";
/** Only schema-owned segments may survive. Dynamic keys can themselves be credentials. */
const properties = new Set(
    "assets document steps children beforeAssertions afterAssertions assertions observers target action path method source pointer expected value type id catalogVersionId fixtureVersionId datasetVersionId flowVersionId templateVersionId entryCaseVersionIds validationTarget sourceHash engineVersion workspaceId schemaVersion elements locator by severity expectedSource parameters vars columns rows values timeoutMs roleKey browsers kind versionId resourceId sha256".split(
        " ",
    ),
);
const messages: Record<string, string> = {
    UNKNOWN_ELEMENT: "Element is not declared in the pinned catalog.",
    MISSING_REFERENCE:
        "Referenced version is missing from the dependency snapshot.",
    REFERENCE_KIND_MISMATCH:
        "Referenced version has an incompatible resource kind.",
    SOURCE_HASH_MISMATCH: "Source snapshot integrity check failed.",
    DOCUMENT_HASH_MISMATCH: "Resource document integrity check failed.",
    INVALID_ENTRY_CASE: "Selected entry is not a case version.",
};
/**
 * 公开函数 safeDiagnostics 截断并脱敏 ValidationIssue：路径段不在白名单时标记 REDACTED。
 * 消息映射到稳定中文友好说明。
 */
export function safeDiagnostics(issues: ValidationIssue[]) {
    return issues.slice(0, 100).map((issue) => {
        const exact =
            issue.path.length <= 512 &&
            issue.path
                .split("/")
                .slice(1)
                .every(
                    (part) => /^(0|[1-9][0-9]{0,5})$/.test(part) || properties.has(part),
                );
        const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(issue.code)
            ? issue.code
            : "SCHEMA_VALIDATION_FAILED";
        return {
            code,
            path: exact ? issue.path : "",
            pathStatus: exact ? ("EXACT" as const) : ("REDACTED" as const),
            message:
                messages[code] ??
                "Source validation failed; review the indicated field and its schema.",
        };
    });
}
