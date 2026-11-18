/**
 * 本文件定义编译后用例/步骤/断言的不可变结构：保留源路径与展示用 sourceId：供运行与报告共用（compiled）。
 */

import type { AssertionV1, StepV1, CaseDslV1, JsonValue } from "./types.generated.js";
/**
 * 公开接口 CompiledAssertion 表示展开后的不可变断言：含源路径、可选 sourceId 与参数行：排除 template 类型。
 */
export interface CompiledAssertion {
    assertion: Exclude<
        AssertionV1,
        {
            type: "template";
        }
    >;
    sourcePath: string;
    /**
     * 报告可用此字段显示断言在原始 DSL 中的标识，历史编译计划允许缺失该字段，仍保留独立的来源路径。
     */
    sourceId?: string;
    parameters: Record<string, JsonValue>[];
}
/**
 * 公开接口 CompiledStep 表示编译后步骤树节点：含前后断言、响应断言与可选子步骤（CompiledStep）。
 */
export interface CompiledStep {
    step: StepV1;
    sourcePath: string;
    /**
     * 报告可用此字段显示步骤在原始 DSL 中的标识，历史编译计划允许缺失该字段，子步骤仍各有自己的来源路径。
     */
    sourceId?: string;
    before: CompiledAssertion[];
    responseAssertions: CompiledAssertion[];
    after: CompiledAssertion[];
    children?: CompiledStep[];
}
/**
 * 公开接口 CompiledCase 绑定 caseVersionId、DSL 文档与编译步骤树：可选 persistenceCheckpointStepId。
 */
export interface CompiledCase {
    caseVersionId: string;
    document: CaseDslV1;
    steps: CompiledStep[];
    persistenceCheckpointStepId?: string;
}

/**
 * 给编译器与执行器提供统一的预期值类型约束，保持数据集返回的 JSON 类型，不对字符串、真假或数字做隐式转换。
 */
export function assertionExpectedTypes(a: CompiledAssertion["assertion"]): import("./types.generated.js").ValueType[] {
    if (a.type === "ui") {
        if (a.operator === "countEquals") return ["integer"];
        return ["textEquals", "textContains", "valueEquals"].includes(a.operator) ? ["string"] : ["boolean"];
    }
    if (a.type === "url" || a.type === "request") return ["string"];
    if (["duration", "requestCount", "httpStatus"].includes(a.type)) return ["integer"];
    if (a.operator === "exists") return ["boolean"];
    if (a.operator === "in") return ["array"];
    if (a.operator === "contains") return ["string", "array"];
    return ["string", "number", "boolean", "object", "array", "null"];
}
