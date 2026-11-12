/**
 * 本文件定义编译后用例/步骤/断言的不可变结构：保留源路径与展示用 sourceId：供运行与报告共用（compiled）。
 */

import type {
    AssertionV1,
    StepV1,
    CaseDslV1,
    JsonValue,
} from "./types.generated.js";
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
    /** Original DSL identifier for report display; absent in historical compiled plans. */
    sourceId?: string;
    parameters: Record<string, JsonValue>[];
}
/**
 * 公开接口 CompiledStep 表示编译后步骤树节点：含前后断言、响应断言与可选子步骤（CompiledStep）。
 */
export interface CompiledStep {
    step: StepV1;
    sourcePath: string;
    /** Original DSL identifier for report display; absent in historical compiled plans. */
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
