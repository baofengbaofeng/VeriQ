/**
 * 编译入口需要将分析问题写入结构化结果，此处以固定英文说明替换原始消息，并按长度和分段白名单决定是否保留路径。
 */

import type { ValidationIssue } from "./dependency.js";
/**
 * 仅保留这里枚举的模式属性名与有限十进制索引段，动态对象键即使来自合法源文档也可能包含凭据而需要隐藏。
 */
const propertyWords =
    "assets document steps children beforeAssertions afterAssertions assertions observers target action path method " +
    "source pointer expected value type id catalogVersionId fixtureVersionId datasetVersionId flowVersionId " +
    "templateVersionId entryCaseVersionIds validationTarget sourceHash engineVersion workspaceId schemaVersion " +
    "elements locator by severity expectedSource parameters vars columns rows values timeoutMs roleKey browsers " +
    "kind versionId resourceId sha256 key parentKey fields shape cases order";
const properties = new Set(propertyWords.split(" "));
const messages: Record<string, string> = {
    SELF_REFERENTIAL_EXPECTED: "The expected value comes from the same observed field.",
    UNKNOWN_ELEMENT: "Element is not declared in the pinned catalog.",
    MISSING_REFERENCE: "Referenced version is missing from the dependency snapshot.",
    REFERENCE_KIND_MISMATCH: "Referenced version has an incompatible resource kind.",
    SOURCE_HASH_MISMATCH: "Source snapshot integrity check failed.",
    DOCUMENT_HASH_MISMATCH: "Resource document integrity check failed.",
    INVALID_ENTRY_CASE: "Selected entry is not a case version.",
    DATASET_EMPTY_MATRIX: "A matrix dataset requires at least one row.",
    DATASET_DUPLICATE_ROW_KEY: "Dataset row keys must be unique.",
    DATASET_ORPHAN_NODE: "Tree row parent does not exist in the dataset.",
    DATASET_TREE_CYCLE: "Dataset parent links contain a cycle.",
    DATASET_TREE_DEPTH_LIMIT: "Dataset tree exceeds the maximum depth of 100.",
    DATASET_UNKNOWN_FIELD: "Dataset row includes a field without a declaration.",
    DATASET_REQUIRED_FIELD_MISSING: "A required dataset field is missing.",
    DATASET_FIELD_NULL_FORBIDDEN: "Dataset field does not allow explicit null.",
    DATASET_FIELD_TYPE_MISMATCH: "Dataset field value does not match its declared type.",
};
/**
 * 最多投影前一百条分析问题，路径不满足本地白名单检查时置空；消息只取固定英文映射或通用说明，不复制原始消息。
 * 路径检查限制长度为 512 个字符串单元，非空值须以 ASCII 斜杠起始；后续段只接受白名单名称、0 或无前导零的六位以内整数。
 * EXACT 表示原路径通过上述检查并原样保留，REDACTED 表示路径隐藏；代码只校验大写标识形状。
 */
export function safeDiagnostics(issues: ValidationIssue[]) {
    return issues.slice(0, 100).map((issue) => {
        const exact =
            issue.path.length <= 512 &&
            (issue.path === "" || issue.path.startsWith("/")) &&
            issue.path
                .split("/")
                .slice(1)
                .every((part) => /^(0|[1-9][0-9]{0,5})$/.test(part) || properties.has(part));
        const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(issue.code) ? issue.code : "SCHEMA_VALIDATION_FAILED";
        return {
            code,
            path: exact ? issue.path : "",
            pathStatus: exact ? ("EXACT" as const) : ("REDACTED" as const),
            message: messages[code] ?? "Source validation failed; review the indicated field and its schema.",
        };
    });
}
