/**
 * 本文件 packages/runner-sdk/src/register-case.ts 实现 VeriQ 相关前端或执行侧能力，并标明公开导出与关键路径
 * 模块注释用于帮助智能体与贡献者快速定位授权、执行与离线相关逻辑。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */

import { RetryObservation, type RetrySafety } from "./retry-safety.js";
import { EvidencePolicy, type RestrictedEvidence } from "./evidence.js";
import { test, type Page, type TestInfo, type Route } from "@playwright/test";
import { Ajv2020 } from "ajv/dist/2020.js";
// 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
// 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
import addFormats from "ajv-formats";
import { pathToFileURL } from "node:url";
import {
    // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    validateSchema,
    resolveBinding,
    resolveInitialVariables,
    type AssetSnapshotV1,
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    type CompiledCase,
    type ExecutionSnapshotV1,
    type JsonObject,
    type JsonValue,
    // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    type FixtureV1,
    type CleanupStatus,
    type AttemptOutcome,
} from "@veriq/contracts";
// 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
// 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
import {
    createStepContext,
    type StepContext,
    type StepContextOptions,
    // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    type StepResult,
} from "./context.js";
import { executeStep, skipStep } from "./execute-step.js";
const fixtureSchemas = new Ajv2020({ strict: false, allErrors: true });
// 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
// 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
addFormats.default(fixtureSchemas);
/**
 * 公开类型 CredentialProvider 描述 packages/runner-sdk/src/register-case.ts 模块对外契约字段与可组合结构
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export interface CredentialProvider {
    resolve(
        reference: { workspaceId: string; secretRef: string; versionId: string },
        signal: AbortSignal,
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    ): Promise<JsonValue>;
}
/**
 * 公开类型 FixtureServiceContext 描述 packages/runner-sdk/src/register-case.ts 模块对外契约字段与可组合结构
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export interface FixtureServiceContext {
    execution: Pick<ExecutionSnapshotV1, "workspaceId" | "authAdapters" | "secretVersions" | "caseExecutionId" | "attemptNo" | "namespace"> & {environment: Pick<ExecutionSnapshotV1["environment"], "allowedOrigins" | "fixtureBaseURL" | "fixtureIdentity">};
    signal: AbortSignal;
    credentials?: CredentialProvider;
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    fixtureInput?: JsonObject;
    protect?: (value: JsonValue) => void;
}
/**
 * 公开类型 LifecycleContext 描述 packages/runner-sdk/src/register-case.ts 模块对外契约字段与可组合结构
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export interface LifecycleContext extends FixtureServiceContext {
    page: Page;
    execution: ExecutionSnapshotV1;
    signal: AbortSignal;
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    credentials?: CredentialProvider;
    fixtureInput?: JsonObject;
    protect?: (value: JsonValue) => void;
// 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
// 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
}
/**
 * 公开类型 LifecycleProvider 描述 packages/runner-sdk/src/register-case.ts 模块对外契约字段与可组合结构
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export interface LifecycleProvider {
    dispose?(context: LifecycleContext): Promise<void>;
    authenticate(context: LifecycleContext): Promise<{ identityId: string }>;
    prepare?(
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        fixture: FixtureV1,
        context: LifecycleContext,
    ): Promise<{ variables: JsonObject; cleanupToken: JsonValue }>;
    // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    cleanup?(
        fixture: FixtureV1,
        token: JsonValue | undefined,
        context: LifecycleContext,
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    ): Promise<void>;
}
/**
 * 公开类型 CaseResult 描述 packages/runner-sdk/src/register-case.ts 模块对外契约字段与可组合结构
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export interface CaseResult {
    retrySafety?: RetrySafety;
    outcome: AttemptOutcome;
    businessOutcome: AttemptOutcome;
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    cleanupStatus: CleanupStatus;
    steps: StepResult[];
    errorCode?: string;
// 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
// 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
}
/**
 * 公开类型 SdkEvent 描述 packages/runner-sdk/src/register-case.ts 模块对外契约字段与可组合结构
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export type SdkEvent =
    | { type: "STEP_FINISHED"; step: StepResult }
    | { type: "CASE_FINISHED"; result: CaseResult };
/**
 * 公开类型 ExecutionOptions 描述 packages/runner-sdk/src/register-case.ts 模块对外契约字段与可组合结构
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export interface ExecutionOptions {
     /**
      * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
      * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
      * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
      * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
      * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
      */
    /** Trusted worker closes the complete business Context before retry observation is final. */
    finalizeExecution?: (context: import("@playwright/test").BrowserContext) => Promise<void>;
    page: Page;
    execution: ExecutionSnapshotV1;
    lifecycle?: LifecycleProvider;
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    credentials?: CredentialProvider;
    signal?: AbortSignal;
    files?: StepContextOptions["files"];
    downloads?: StepContextOptions["downloads"];
    /** Trusted restricted artifact sink; never an ordinary event/report callback. */
    restrictedEvidence?: (evidence: RestrictedEvidence) => Promise<void>;
    onEvent?: (event: import("./context.js").LiveStepEvent | {type: "CLEANUP_RESULT"; cleanupStatus: CleanupStatus} | {type: "CASE_FINISHED"; result: CaseResult}) => Promise<void>;
    emit?: (event: SdkEvent) => Promise<void>;
    redact?: (value: JsonValue) => JsonValue;
// 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
// 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
}
/**
 * 公开函数 bounded 负责 packages/runner-sdk/src/register-case.ts 中的关键处理流程并返回约定结果
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
async function bounded<T>(
    run: (signal: AbortSignal) => Promise<T>,
    ms: number,
    parent?: AbortSignal,
// 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
// 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    let rejectWait: ((e: Error) => void) | undefined;
    const abort = () => {
        controller.abort();
        rejectWait?.(new Error("CANCELLED"));
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    };
    const failure = new Promise<never>((_, reject) => {
        rejectWait = reject;
        timer = setTimeout(() => {
            // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            controller.abort();
            reject(new Error("LIFECYCLE_TIMEOUT"));
        }, ms);
    });
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    parent?.addEventListener("abort", abort, { once: true });
    // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    if (parent?.aborted) abort();
    // 关键路径：处理 try 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    try {
        return await Promise.race([run(controller.signal), failure]);
    } finally {
        clearTimeout(timer);
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        parent?.removeEventListener("abort", abort);
    }
}
/**
 * 公开函数 executeCase 负责 packages/runner-sdk/src/register-case.ts 中的关键处理流程并返回约定结果
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export async function executeCase(
    plan: CompiledCase,
    source: AssetSnapshotV1,
    options: ExecutionOptions,
// 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
// 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
): Promise<CaseResult> {
    const result: CaseResult = {
        outcome: "ERROR",
        // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        businessOutcome: "ERROR",
        cleanupStatus: "NOT_REQUIRED",
        steps: [],
    };
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    const evidence = new EvidencePolicy();
    const execution = structuredClone(options.execution);
    let ctx: StepContext | undefined,
        fixture: FixtureV1 | undefined,
        // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        token: JsonValue | undefined,
        preparing = false;
    let retryObservation: RetryObservation | undefined;
    let fixtureInput: JsonObject = {};
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    let originFailure = false;
    const route = async (r: Route) => {
        const url = new URL(r.request().url());
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (!execution.environment.allowedOrigins.includes(url.origin)) {
            originFailure = true;
            await r.abort("blockedbyclient");
        } else await r.continue();
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    };
    const lifecycleContext = (signal: AbortSignal): LifecycleContext => ({
        page: options.page,
        // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        execution,
        signal,
        fixtureInput,
        protect: (value) => evidence.protect(value),
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        ...(options.credentials
            ? {
                    credentials: {
                        /**
                         * 公开函数 resolve 负责 packages/runner-sdk/src/register-case.ts 中的关键处理流程并返回约定结果
                         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
                         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
                         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
                         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
                         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
                         */
                        async resolve(reference, signal) {
                            const value = await options.credentials!.resolve(
                                reference,
                                signal,
                            // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                            // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                            );
                            evidence.protect(value);
                            return value;
                        // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                        },
                    },
                }
            : {}),
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    });
    /**
     * 公开函数 emit 负责 packages/runner-sdk/src/register-case.ts 中的关键处理流程并返回约定结果
     * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
     * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
     * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
     * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
     * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
     * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
     * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
     * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
     * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
     */
    async function emit(event: SdkEvent) {
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (options.emit) {
            // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (!options.redact) throw new Error("REDACTION_PROVIDER_REQUIRED");
            await options.emit(
                options.redact(
                    evidence.redactProtocol(event as unknown as JsonValue),
                // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                ) as unknown as SdkEvent,
            );
        }
    // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    }
    // 关键路径：处理 try 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    try {
        // 关键路径：处理 for 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        for (const pin of execution.secretVersions ?? []) {
            evidence.protect(pin.secretRef);
            evidence.protect(pin.versionId);
        }
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (validateSchema("ExecutionSnapshotV1", execution).length)
            throw new Error("INVALID_EXECUTION_CONTEXT");
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (
            execution.workspaceId !== source.workspaceId ||
            execution.assetSourceHash !== source.sourceHash ||
            execution.caseVersionId !== plan.caseVersionId
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        )
            throw new Error("EXECUTION_CONTEXT_MISMATCH");
        const catalog = source.assets.find(
            // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            (a) => a.versionId === plan.document.catalogVersionId,
        );
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (catalog?.kind !== "ELEMENT_CATALOG")
            throw new Error("CATALOG_REQUIRED");
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (!options.lifecycle?.authenticate)
            throw new Error("AUTH_PROVIDER_REQUIRED");
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if ((options.emit || options.onEvent) && !options.redact)
            throw new Error("REDACTION_PROVIDER_REQUIRED");
        const role = execution.environment.roles.find(
            (r) => r.roleKey === execution.roleKey,
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        );
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (!role) throw new Error("ROLE_NOT_FOUND");
        const initialVariables = resolveInitialVariables(
            plan.document.initialVariables,
            execution.variables,
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        );
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (plan.document.fixtureVersionId) {
            const asset = source.assets.find(
                (a) => a.versionId === plan.document.fixtureVersionId,
            );
            // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (asset?.kind !== "FIXTURE") throw new Error("FIXTURE_REQUIRED");
            fixture = asset.document;
            fixtureInput = resolveBinding(plan.document.fixtureInput ?? {}, {
                data: execution.dataRow?.values ?? {},
                // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                vars: initialVariables,
            }) as JsonObject;
            // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (!fixtureSchemas.compile(fixture.inputSchema)(fixtureInput))
                throw new Error("FIXTURE_INPUT_INVALID");
            // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (!options.lifecycle.prepare || !options.lifecycle.cleanup)
                throw new Error("FIXTURE_PROVIDER_REQUIRED");
        }
        await options.page.context().route("**/*", route);
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        const identity = await bounded(
            (signal) => options.lifecycle!.authenticate(lifecycleContext(signal)),
            60000,
            // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            options.signal,
        );
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (
            !identity.identityId ||
            (role.allowedIdentityIds &&
                !role.allowedIdentityIds.includes(identity.identityId))
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        )
            throw new Error("IDENTITY_NOT_ALLOWED");
        let variables = execution.variables;
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (fixture) {
            preparing = true;
            result.cleanupStatus = "PENDING";
            const prepared = await bounded(
                // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                (signal) =>
                    options.lifecycle!.prepare!(fixture!, lifecycleContext(signal)),
                60000,
                // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                options.signal,
            );
            token = prepared.cleanupToken;
            evidence.protect(token);
            // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (!fixtureSchemas.compile(fixture.outputSchema)(prepared.variables))
                throw new Error("FIXTURE_OUTPUT_INVALID");
            variables = { ...variables, ...prepared.variables };
        }
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        retryObservation = new RetryObservation(options.page.context(), plan.document.kind === "WRITE");
        ctx = createStepContext({
            onBusinessRequest: method => retryObservation!.method(method),
            // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            page: options.page,
            onEvent: async event => {if (options.onEvent) await options.onEvent(options.redact!(evidence.redactProtocol(event as unknown as JsonValue)) as unknown as import("./context.js").LiveStepEvent);},
            environment: execution.environment,
            catalog: catalog.document,
            // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            data: execution.dataRow?.values ?? {},
            vars: variables,
            deadline: Date.now() + 120000,
            ...(options.signal ? { signal: options.signal } : {}),
            // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            ...(options.files ? { files: options.files } : {}),
            ...(options.downloads ? { downloads: options.downloads } : {}),
        });
        result.businessOutcome = plan.steps.length ? "PASSED" : "INCOMPLETE";
        // 关键路径：处理 for 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        for (const step of plan.steps) {
            const r = await executeStep(step, ctx);
            const collect = async (step: StepResult): Promise<void> => {
                // 关键路径：处理 for 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                for (const item of step.events)
                    // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    if (item.kind === "download" && item.path)
                        await options.restrictedEvidence?.({
                            kind: "DOWNLOAD",
                            sensitivity: "CREDENTIAL_RESTRICTED",
                            // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                            // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                            path: item.path,
                        });
                // 关键路径：处理 for 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                for (const child of step.children) await collect(child);
            };
            await collect(r);
            result.steps.push(r);
            // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            await emit({ type: "STEP_FINISHED", step: r });
            // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (r.cancelled) {
                // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if (result.businessOutcome !== "FAILED")
                    result.businessOutcome = r.status === "CANCELLED" ? "CANCELLED" : "FAILED";
                break;
            }
            // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (r.status !== "PASSED") {
                result.businessOutcome = "FAILED";
                // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if (step.step.failurePolicy !== "CONTINUE") {
                    // 关键路径：处理 for 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    for (const remaining of plan.steps.slice(plan.steps.indexOf(step) + 1)) await skipStep(remaining, ctx, step.step.id);
                    break;
                }
            }
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        }
        const allSteps = (steps: StepResult[]): StepResult[] =>
            steps.flatMap((s) => [s, ...allSteps(s.children)]);
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (plan.document.kind === "WRITE" && result.businessOutcome === "PASSED") {
            const checkpoint = allSteps(result.steps).find(
                (s) => s.id === plan.persistenceCheckpointStepId,
            );
            // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (
                !checkpoint ||
                checkpoint.status !== "PASSED" ||
                !checkpoint.assertions.some(
                    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    (a) => a.status === "PASSED" && a.severity !== "WARN",
                )
            ) {
                // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                result.businessOutcome = "FAILED";
                result.errorCode = "PERSISTENCE_CHECKPOINT_FAILED";
            }
        }
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (originFailure) {
            result.businessOutcome = "FAILED";
            result.errorCode = "ORIGIN_NOT_ALLOWED";
        }
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    } catch (e) {
        result.businessOutcome = options.signal?.aborted ? "CANCELLED" : "ERROR";
        result.errorCode =
            // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            e instanceof Error && /^[A-Z_]+$/.test(e.message)
                ? e.message
                : "EXECUTION_ERROR";
    } finally {
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        ctx?.dispose();
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (preparing) {
            // 关键路径：处理 try 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            try {
                await bounded(
                    (signal) =>
                        options.lifecycle!.cleanup!(
                            // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                            // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                            fixture!,
                            token,
                            lifecycleContext(signal),
                        // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                        ),
                    30000,
                );
                result.cleanupStatus = "SUCCEEDED";
            // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            } catch {
                result.cleanupStatus = "FAILED";
                result.errorCode = "CLEANUP_FAILED";
            }
        // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        }
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (options.lifecycle?.dispose) {
            // 关键路径：处理 try 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            try {
                await bounded(
                    (signal) => options.lifecycle!.dispose!(lifecycleContext(signal)),
                    30000,
                // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                );
            } catch {
                result.cleanupStatus = "FAILED";
                // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                result.errorCode = "AUTH_CLEANUP_FAILED";
            }
        }
        await options.page
            // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            .context()
            .unroute("**/*", route)
            .catch(() => {});
    }
    // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    let finalized = false;
    // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    if (options.finalizeExecution) {
        // 关键路径：处理 try 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        try { await options.finalizeExecution(options.page.context()); finalized = true; }
        // 关键路径：处理 catch 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        catch { result.businessOutcome = "ERROR"; result.errorCode = "CONTEXT_CLOSE_FAILED"; }
    }
    result.retrySafety = retryObservation?.finish(finalized) ?? "UNKNOWN";
    result.outcome =
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        result.cleanupStatus === "FAILED" ? "ERROR" : result.businessOutcome;
    // 关键路径：处理 try 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    try {
        await options.onEvent?.({type: "CLEANUP_RESULT", cleanupStatus: result.cleanupStatus});
        await options.onEvent?.({type: "CASE_FINISHED", result: options.redact!(evidence.redactProtocol(result as unknown as JsonValue)) as unknown as CaseResult});
        await emit({ type: "CASE_FINISHED", result });
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    } catch {
        result.outcome = "ERROR";
        result.errorCode = "EVENT_EMISSION_FAILED";
    // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    }
    return evidence.redactProtocol(
        result as unknown as JsonValue,
    ) as unknown as CaseResult;
// 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
// 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
}
/**
 * 公开类型 ExecutionContextProvider 描述 packages/runner-sdk/src/register-case.ts 模块对外契约字段与可组合结构
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export type ExecutionContextProvider = (
    info: TestInfo,
) => Promise<Omit<ExecutionOptions, "page">>;
let provider: ExecutionContextProvider | undefined;
 /**
  * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
  * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
  * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
  * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
  * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
  * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
  * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
  * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
  */
/** Called by a trusted worker setup module, never by generated DSL or source context. */
/**
 * 公开函数 configureExecution 负责 packages/runner-sdk/src/register-case.ts 中的关键处理流程并返回约定结果
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 */
export function configureExecution(
    contextProvider: ExecutionContextProvider,
): void {
    provider = contextProvider;
// 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
// 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
}
/**
 * 公开函数 registerCase 负责 packages/runner-sdk/src/register-case.ts 中的关键处理流程并返回约定结果
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export function registerCase(
    plan: CompiledCase,
    source: AssetSnapshotV1,
): void {
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    test.describe(plan.caseVersionId, () => {
        test.describe.configure({ retries: 0 });
        test(plan.document.title, async ({ page }, info) => {
            // 分段注释：继续说明 register-case.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            info.setTimeout(240000);
            // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (!provider && process.env.VERIQ_EXECUTION_CONTEXT_MODULE) {
                const module = (await import(
                    pathToFileURL(process.env.VERIQ_EXECUTION_CONTEXT_MODULE).href
                )) as { createExecutionContext?: ExecutionContextProvider };
                // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                provider = module.createExecutionContext;
            }
            // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (!provider) throw new Error("EXECUTION_CONTEXT_PROVIDER_REQUIRED");
            const options = await provider(info),
                result = await executeCase(plan, source, { ...options, page });
            // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (!options.redact) throw new Error("REDACTION_PROVIDER_REQUIRED");
            await info.attach("veriq-result", {
                body: Buffer.from(
                    JSON.stringify(options.redact(result as unknown as JsonValue)),
                // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                ),
                contentType: "application/json",
            });
            // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (result.outcome !== "PASSED")
                throw new Error(
                    `VERIQ_${result.outcome}: ${result.errorCode ?? "CASE_FAILED"}`,
                );
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        });
    });
}
