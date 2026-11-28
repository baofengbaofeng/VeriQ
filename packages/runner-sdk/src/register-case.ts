/**
 * 本文件注册并执行整案：注入凭证/夹具/生命周期：编排准备清理与取消并产出 CaseResult（register-case）。
 */

import { connectedDatasetResolver, type HttpDatasetReader } from "./datasets.js";
import { isDeepStrictEqual } from "node:util";
import { RetryObservation, type RetrySafety } from "./retry-safety.js";
import { EvidencePolicy, type RestrictedEvidence } from "./evidence.js";
import { type Page, type TestInfo, type Route } from "@playwright/test";
import { controlledBrowserTest as test } from "./controlled-browser.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { pathToFileURL } from "node:url";
import {
    validateSchema,
    resolveBinding,
    resolveInitialVariables,
    type AssetSnapshotV1,
    type ConnectedSourceSnapshotV2,
    type CompiledCase,
    type CompiledStep,
    type ExecutionSnapshotV1,
    type JsonObject,
    type JsonValue,
    type FixtureV1,
    type CleanupStatus,
    type AttemptOutcome,
    type BrowserSsoResultV1,
} from "@veriq/contracts";
import { createStepContext, type StepContext, type StepContextOptions, type StepResult } from "./context.js";
import { executeStep, skipStep } from "./execute-step.js";
const fixtureSchemas = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(fixtureSchemas);
/**
 * 公开接口 CredentialProvider 定义按钉选引用解析密钥的注入缝：SDK 自身不假装解析凭证（CredentialProvider）。
 */
export interface CredentialProvider {
    resolve(
        reference: { workspaceId: string; secretRef: string; versionId: string },
        signal: AbortSignal,
    ): Promise<JsonValue>;
}
/**
 * 公开接口 FixtureServiceContext 描述夹具服务调用时可见的执行与凭证上下文（FixtureServiceContext）。
 */
export interface FixtureServiceContext {
    execution: Pick<
        ExecutionSnapshotV1,
        "workspaceId" | "authAdapters" | "secretVersions" | "caseExecutionId" | "attemptNo" | "namespace"
    > & {
        environment: Pick<ExecutionSnapshotV1["environment"], "allowedOrigins" | "fixtureBaseURL" | "fixtureIdentity">;
    };
    signal: AbortSignal;
    credentials?: CredentialProvider;
    fixtureInput?: JsonObject;
    protect?: (value: JsonValue) => void;
}
/**
 * 公开接口 LifecycleContext 提供认证/准备阶段所需的 page、execution、signal 与可选 credentials。
 */
export interface LifecycleContext extends FixtureServiceContext {
    page: Page;
    execution: ExecutionSnapshotV1;
    signal: AbortSignal;
    credentials?: CredentialProvider;
    fixtureInput?: JsonObject;
    protect?: (value: JsonValue) => void;
    onSsoStage?: (stage: BrowserSsoResultV1["stage"]) => void;
    onSsoOriginDenied?: () => void;
}
/**
 * 公开接口 LifecycleProvider 定义 authenticate 等生命周期钩子：必须返回非空 identityId。
 */
export interface LifecycleProvider {
    dispose?(context: LifecycleContext): Promise<void>;
    authenticate(context: LifecycleContext): Promise<{ identityId: string }>;
    prepare?(
        fixture: FixtureV1,
        context: LifecycleContext,
    ): Promise<{ variables: JsonObject; cleanupToken: JsonValue }>;
    cleanup?(fixture: FixtureV1, token: JsonValue | undefined, context: LifecycleContext): Promise<void>;
}
/**
 * 公开接口 CaseResult 汇总整案业务结局与 cleanupStatus：供事件上报与完成清单使用（CaseResult）。
 */
export interface CaseResult {
    retrySafety?: RetrySafety;
    outcome: AttemptOutcome;
    businessOutcome: AttemptOutcome;
    cleanupStatus: CleanupStatus;
    steps: StepResult[];
    errorCode?: string;
    cleanupErrorCode?: string;
    authentication?: BrowserSsoResultV1;
}
/**
 * 公开类型 SdkEvent 为整案执行过程中向上层报告的实时事件联合类型，专用于 SdkEvent 路径（CANCELLED）。
 */
export type SdkEvent = { type: "STEP_FINISHED"; step: StepResult } | { type: "CASE_FINISHED"; result: CaseResult };
/**
 * 公开接口 ExecutionOptions 配置 executeCase 的上下文提供者、信号、事件回调与预算相关选项。
 */
export interface ExecutionOptions {
    datasetProtected?: boolean;
    readHttpDataset?: HttpDatasetReader;
    /**
     * 可信回调负责关闭业务 BrowserContext，已有观察器始终结算，标记可能写入时优先返回 WRITE_POSSIBLE。
     * 只有回调成功、观察到上下文关闭且未标记可能写入时，才返回 READ_ONLY_OBSERVED。
     */
    finalizeExecution?: (context: import("@playwright/test").BrowserContext) => Promise<void>;
    page: Page;
    hydrateSource?: (source: ConnectedSourceSnapshotV2, aliases: string[]) => Promise<AssetSnapshotV1>;
    execution: ExecutionSnapshotV1;
    lifecycle?: LifecycleProvider;
    credentials?: CredentialProvider;
    signal?: AbortSignal;
    /**
     * 独立传递运行时清理授权信号，即使仍在用户取消的清理宽限期内，租约失效也必须立即中断清理阶段。
     */
    cleanupSignal?: AbortSignal;
    files?: StepContextOptions["files"];
    downloads?: StepContextOptions["downloads"];
    /**
     * 捕获到的下载文件由可信受限制品接收器处理，普通报告和事件回调收到的脱敏投影会移除原始路径。
     */
    restrictedEvidence?: (evidence: RestrictedEvidence) => Promise<void>;
    onEvent?: (
        event:
            | import("./context.js").LiveStepEvent
            | { type: "CLEANUP_RESULT"; cleanupStatus: CleanupStatus; errorCode?: string }
            | { type: "CASE_FINISHED"; result: CaseResult },
    ) => Promise<void>;
    emit?: (event: SdkEvent) => Promise<void>;
    redact?: (value: JsonValue) => JsonValue;
}
async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
    if (parent?.aborted) throw new Error("CANCELLED");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectWait: ((e: Error) => void) | undefined;
    const abort = () => {
        controller.abort();
        rejectWait?.(new Error("CANCELLED"));
    };
    const failure = new Promise<never>((_, reject) => {
        rejectWait = reject;
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error("LIFECYCLE_TIMEOUT"));
        }, ms);
    });
    parent?.addEventListener("abort", abort, { once: true });
    try {
        return await Promise.race([run(controller.signal), failure]);
    } finally {
        clearTimeout(timer);
        parent?.removeEventListener("abort", abort);
    }
}
/**
 * 公开函数 executeCase 按编译用例执行准备、步骤、清理全流程：取消与失败仍尽量做 cleanup：返回 CaseResult。
 */
export async function executeCase(
    plan: CompiledCase,
    source: AssetSnapshotV1,
    options: ExecutionOptions,
): Promise<CaseResult> {
    const result: CaseResult = {
        outcome: "ERROR",
        businessOutcome: "ERROR",
        cleanupStatus: "NOT_REQUIRED",
        steps: [],
    };
    const evidence = new EvidencePolicy(options.datasetProtected);
    const execution = structuredClone(options.execution);
    let ctx: StepContext | undefined,
        fixture: FixtureV1 | undefined,
        token: JsonValue | undefined,
        preparing = false;
    let retryObservation: RetryObservation | undefined;
    let stepOptions: StepContextOptions | undefined;
    let fixtureInput: JsonObject = {};
    let originFailure = false;
    let ssoStage: BrowserSsoResultV1["stage"] = "ENTRY";
    let ssoStarted: number | undefined;
    const route = async (r: Route) => {
        const url = new URL(r.request().url());
        if (!execution.environment.allowedOrigins.includes(url.origin)) {
            originFailure = true;
            await r.abort("blockedbyclient");
        } else await r.continue();
    };
    const lifecycleContext = (signal: AbortSignal): LifecycleContext => ({
        page: options.page,
        execution,
        signal,
        fixtureInput,
        protect: (value) => evidence.protect(value),
        onSsoStage: (stage) => (ssoStage = stage),
        onSsoOriginDenied: () => {
            originFailure = true;
        },
        ...(options.credentials
            ? {
                  credentials: {
                      async resolve(reference, signal) {
                          const value = await options.credentials!.resolve(reference, signal);
                          evidence.protect(value);
                          return value;
                      },
                  },
              }
            : {}),
    });
    async function emit(event: SdkEvent) {
        if (options.emit) {
            if (!options.redact) throw new Error("REDACTION_PROVIDER_REQUIRED");
            await options.emit(
                options.redact(evidence.redactProtocol(event as unknown as JsonValue)) as unknown as SdkEvent,
            );
        }
    }
    async function collect(step: StepResult): Promise<void> {
        for (const item of step.events)
            if (item.kind === "download" && item.path)
                await options.restrictedEvidence?.({
                    kind: "DOWNLOAD",
                    sensitivity: "CREDENTIAL_RESTRICTED",
                    path: item.path,
                });
        for (const child of step.children) await collect(child);
    }
    async function runSteps(
        steps: CompiledStep[],
        context: StepContext,
        onStep?: (step: StepResult) => void,
        cleanupWindow?: AbortSignal,
    ): Promise<StepResult | undefined> {
        let failed: StepResult | undefined;
        for (const [index, step] of steps.entries()) {
            cleanupWindow?.throwIfAborted();
            const r = await executeStep(step, context);
            cleanupWindow?.throwIfAborted();
            await collect(r);
            cleanupWindow?.throwIfAborted();
            result.steps.push(r);
            await emit({ type: "STEP_FINISHED", step: r });
            onStep?.(r);
            if (r.status !== "PASSED") failed ??= r;
            if (r.cancelled) break;
            if (r.status !== "PASSED" && step.step.failurePolicy !== "CONTINUE") {
                for (const remaining of steps.slice(index + 1)) await skipStep(remaining, context, step.step.id);
                break;
            }
        }
        return failed;
    }
    function recordBusiness(r: StepResult): void {
        if (r.status === "ERROR") {
            result.businessOutcome = "ERROR";
            result.errorCode ??= r.errorCode ?? "DATASET_READ_ERROR";
        } else if (r.status !== "PASSED" && result.businessOutcome !== "ERROR" && result.businessOutcome !== "FAILED") {
            result.businessOutcome = r.status === "CANCELLED" ? "CANCELLED" : "FAILED";
        }
    }
    function recordOriginFailure(): void {
        if (originFailure && result.businessOutcome !== "ERROR") {
            result.businessOutcome = "FAILED";
            result.errorCode = "ORIGIN_NOT_ALLOWED";
        }
    }
    function cleanupFailed(code: string): void {
        result.cleanupStatus = "FAILED";
        if (plan.prepare || plan.cleanup) {
            result.cleanupErrorCode ??= code;
            result.errorCode ??= code;
        } else result.errorCode = code;
    }
    try {
        for (const pin of execution.secretVersions ?? []) {
            evidence.protect(pin.secretRef);
            evidence.protect(pin.versionId);
        }
        if (validateSchema("ExecutionSnapshotV1", execution).length) throw new Error("INVALID_EXECUTION_CONTEXT");
        if (
            execution.workspaceId !== source.workspaceId ||
            execution.assetSourceHash !== source.sourceHash ||
            execution.caseVersionId !== plan.caseVersionId
        )
            throw new Error("EXECUTION_CONTEXT_MISMATCH");
        if (!isDeepStrictEqual(plan.document.datasetBindings ?? {}, execution.datasetBindings ?? {}))
            throw new Error("DATASET_BINDINGS_MISMATCH");
        const documents = new Map(
            Object.entries(plan.document.datasetBindings ?? {}).map(([alias, id]) => {
                const version = source.assets.find((a) => a.versionId === id);
                if (version?.kind !== "DATASET") throw new Error("DATASET_VERSION_MISSING");
                return [alias, version.document] as const;
            }),
        );
        const catalog = source.assets.find((a) => a.versionId === plan.document.catalogVersionId);
        if (catalog?.kind !== "ELEMENT_CATALOG") throw new Error("CATALOG_REQUIRED");
        if (!options.lifecycle?.authenticate) throw new Error("AUTH_PROVIDER_REQUIRED");
        if ((options.emit || options.onEvent) && !options.redact) throw new Error("REDACTION_PROVIDER_REQUIRED");
        const role = execution.environment.roles.find((r) => r.roleKey === execution.roleKey);
        if (!role) throw new Error("ROLE_NOT_FOUND");
        const initialVariables = resolveInitialVariables(plan.document.initialVariables, execution.variables);
        if (plan.document.fixtureVersionId) {
            const asset = source.assets.find((a) => a.versionId === plan.document.fixtureVersionId);
            if (asset?.kind !== "FIXTURE") throw new Error("FIXTURE_REQUIRED");
            fixture = asset.document;
            fixtureInput = resolveBinding(plan.document.fixtureInput ?? {}, {
                data: execution.dataRow?.values ?? {},
                vars: initialVariables,
            }) as JsonObject;
            if (!fixtureSchemas.compile(fixture.inputSchema)(fixtureInput)) throw new Error("FIXTURE_INPUT_INVALID");
            if (!options.lifecycle.prepare || !options.lifecycle.cleanup) throw new Error("FIXTURE_PROVIDER_REQUIRED");
        }
        await options.page.context().route("**/*", route);
        const adapter = execution.authAdapters?.find((a) => a.versionId === role.authAdapterVersionId);
        if (adapter?.configuration.kind === "BROWSER_SSO") {
            ssoStarted = performance.now();
            if (!options.datasetProtected) throw new Error("SSO_SCOPE_UNAVAILABLE");
        }
        const identity = await bounded(
            (signal) => options.lifecycle!.authenticate(lifecycleContext(signal)),
            60000,
            options.signal,
        );
        if (!identity.identityId || (role.allowedIdentityIds && !role.allowedIdentityIds.includes(identity.identityId)))
            throw new Error("IDENTITY_NOT_ALLOWED");
        if (ssoStarted !== undefined) {
            result.authentication = {
                stage: ssoStage,
                outcome: "PASSED",
                durationMs: Math.round(performance.now() - ssoStarted),
            };
        }
        let variables = execution.variables;
        if (fixture) {
            preparing = true;
            result.cleanupStatus = "PENDING";
            const prepared = await bounded(
                (signal) => options.lifecycle!.prepare!(fixture!, lifecycleContext(signal)),
                60000,
                options.signal,
            );
            token = prepared.cleanupToken;
            evidence.protect(token);
            if (!fixtureSchemas.compile(fixture.outputSchema)(prepared.variables))
                throw new Error("FIXTURE_OUTPUT_INVALID");
            variables = { ...variables, ...prepared.variables };
        }
        retryObservation = new RetryObservation(options.page.context(), plan.document.kind === "WRITE");
        stepOptions = {
            datasets: connectedDatasetResolver(
                documents,
                execution.datasetBindings ?? {},
                execution.environmentVersionId,
                options.readHttpDataset,
            ),
            datasetProtected: options.datasetProtected === true,
            onBusinessRequest: (method) => retryObservation!.method(method),
            page: options.page,
            onEvent: async (event) => {
                if (options.onEvent)
                    await options.onEvent(
                        options.redact!(
                            evidence.redactProtocol(event as unknown as JsonValue),
                        ) as unknown as import("./context.js").LiveStepEvent,
                    );
            },
            environment: execution.environment,
            catalog: catalog.document,
            data: execution.dataRow?.values ?? {},
            vars: variables,
            ...(options.files ? { files: options.files } : {}),
            ...(options.downloads ? { downloads: options.downloads } : {}),
        };
        ctx = createStepContext({
            ...stepOptions,
            deadline: Date.now() + 120000,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(plan.cleanup?.some(({ on }) => on === "CANCELLED") ? { preservePageOnAbort: true } : {}),
        });
        result.businessOutcome = plan.steps.length ? "PASSED" : "INCOMPLETE";
        const preparationFailure = await runSteps(plan.prepare ?? [], ctx, recordBusiness);
        if (!preparationFailure) await runSteps(plan.steps, ctx, recordBusiness);
        else if (!options.signal?.aborted) {
            result.errorCode ??= "PAGE_PREPARE_FAILED";
            for (const step of plan.steps) await skipStep(step, ctx, preparationFailure.id);
        }
        const allSteps = (steps: StepResult[]): StepResult[] => steps.flatMap((s) => [s, ...allSteps(s.children)]);
        if (plan.document.kind === "WRITE" && result.businessOutcome === "PASSED") {
            const checkpoint = allSteps(result.steps).find((s) => s.id === plan.persistenceCheckpointStepId);
            if (
                !checkpoint ||
                checkpoint.status !== "PASSED" ||
                !checkpoint.assertions.some((a) => a.status === "PASSED" && a.severity !== "WARN")
            ) {
                result.businessOutcome = "FAILED";
                result.errorCode = "PERSISTENCE_CHECKPOINT_FAILED";
            }
        }
        recordOriginFailure();
    } catch (e) {
        result.businessOutcome = options.signal?.aborted ? "CANCELLED" : "ERROR";
        result.errorCode = e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : "EXECUTION_ERROR";
        if (ssoStarted !== undefined && !result.authentication) {
            const code = validateSchema("ProtectedExecutionErrorCode", result.errorCode).length
                ? "SSO_AUTHENTICATION_FAILED"
                : result.errorCode;
            result.authentication = {
                stage: ssoStage,
                outcome: options.signal?.aborted ? "CANCELLED" : "FAILED",
                durationMs: Math.round(performance.now() - ssoStarted),
                errorCode: code as BrowserSsoResultV1["errorCode"] & string,
            };
        }
    } finally {
        ctx?.dispose();
        const condition =
            result.businessOutcome === "CANCELLED"
                ? "CANCELLED"
                : ["PASSED", "UNSTABLE", "SKIPPED"].includes(result.businessOutcome)
                  ? "SUCCESS"
                  : "FAILURE";
        const cleanup = plan.cleanup?.find(({ on }) => on === condition);
        if (cleanup) {
            const maximumCleanupMs = condition === "CANCELLED" ? 10000 : 30000;
            const deadline = Date.now() + maximumCleanupMs;
            try {
                if (
                    !stepOptions ||
                    options.page.isClosed() ||
                    options.cleanupSignal?.aborted ||
                    (options.signal?.aborted && condition !== "CANCELLED")
                ) {
                    cleanupFailed("PAGE_CLEANUP_UNAVAILABLE");
                } else {
                    originFailure = false;
                    const didFail = await bounded(
                        async (signal) => {
                            await Promise.allSettled(ctx?.inFlight ?? []);
                            if (signal.aborted || options.page.isClosed()) throw new Error("PAGE_CLEANUP_UNAVAILABLE");
                            const context = createStepContext({
                                ...stepOptions!,
                                signal,
                                deadline,
                                onEvent: async (event) => {
                                    if (!signal.aborted) await stepOptions?.onEvent?.(event);
                                },
                            });
                            try {
                                return await runSteps(cleanup.steps, context, undefined, signal);
                            } finally {
                                context.dispose();
                            }
                        },
                        maximumCleanupMs,
                        options.cleanupSignal,
                    );
                    if (didFail || originFailure) cleanupFailed("PAGE_CLEANUP_FAILED");
                    else result.cleanupStatus = "SUCCEEDED";
                }
            } catch {
                cleanupFailed("PAGE_CLEANUP_UNAVAILABLE");
            }
        }
        if (options.signal?.aborted && ctx?.preservePageOnAbort && (!cleanup || result.cleanupStatus === "FAILED")) {
            void options.page
                .context()
                .close()
                .catch(() => {});
        }
        if (preparing) {
            try {
                await bounded(
                    (signal) => options.lifecycle!.cleanup!(fixture!, token, lifecycleContext(signal)),
                    30000,
                );
                if (!result.cleanupErrorCode) result.cleanupStatus = "SUCCEEDED";
            } catch {
                cleanupFailed("CLEANUP_FAILED");
            }
        }
        if (options.lifecycle?.dispose) {
            try {
                await bounded((signal) => options.lifecycle!.dispose!(lifecycleContext(signal)), 30000);
            } catch {
                cleanupFailed("AUTH_CLEANUP_FAILED");
            }
        }
        await options.page
            .context()
            .unroute("**/*", route)
            .catch(() => {});
    }
    let finalized = false;
    if (options.finalizeExecution) {
        try {
            await options.finalizeExecution(options.page.context());
            finalized = true;
        } catch {
            result.businessOutcome = "ERROR";
            result.errorCode = "CONTEXT_CLOSE_FAILED";
        }
    }
    result.retrySafety = retryObservation?.finish(finalized) ?? "UNKNOWN";
    result.outcome = result.cleanupStatus === "FAILED" ? "ERROR" : result.businessOutcome;
    try {
        await options.onEvent?.({
            type: "CLEANUP_RESULT",
            cleanupStatus: result.cleanupStatus,
            ...(result.cleanupErrorCode ? { errorCode: result.cleanupErrorCode } : {}),
        });
        await options.onEvent?.({
            type: "CASE_FINISHED",
            result: options.redact!(evidence.redactProtocol(result as unknown as JsonValue)) as unknown as CaseResult,
        });
        await emit({ type: "CASE_FINISHED", result });
    } catch {
        result.outcome = "ERROR";
        result.errorCode = "EVENT_EMISSION_FAILED";
    }
    return evidence.redactProtocol(result as unknown as JsonValue) as unknown as CaseResult;
}
/**
 * 公开类型 ExecutionContextProvider 是创建浏览器上下文与生命周期依赖的工厂函数类型（ExecutionContextProvider/EXECUTION
 * _CONTEXT_PROVIDER_REQUIRED）。
 */
export type ExecutionContextProvider = (info: TestInfo) => Promise<Omit<ExecutionOptions, "page">>;
let provider: ExecutionContextProvider | undefined;
/**
 * 公开函数 configureExecution 为后续 registerCase 配置默认 ExecutionContextProvider。测试可替换。
 */
export function configureExecution(contextProvider: ExecutionContextProvider): void {
    provider = contextProvider;
}
/**
 * 公开函数 registerCase 把编译用例登记为可被 Playwright 调度的测试入口：实际执行委托 executeCase。
 */
export function registerCase(plan: CompiledCase, source: AssetSnapshotV1 | ConnectedSourceSnapshotV2): void {
    test.describe(plan.caseVersionId, () => {
        test.describe.configure({ retries: 0 });
        test(plan.document.title, async ({ page }, info) => {
            info.setTimeout(240000);
            if (!provider && process.env.VERIQ_EXECUTION_CONTEXT_MODULE) {
                const module = (await import(pathToFileURL(process.env.VERIQ_EXECUTION_CONTEXT_MODULE).href)) as {
                    createExecutionContext?: ExecutionContextProvider;
                };
                provider = module.createExecutionContext;
            }
            if (!provider) throw new Error("EXECUTION_CONTEXT_PROVIDER_REQUIRED");
            const options = await provider(info);
            const live =
                source.schemaVersion === "2.0"
                    ? await options.hydrateSource?.(source, Object.values(plan.document.datasetBindings ?? {}))
                    : source;
            if (!live) throw new Error("DATASET_PROVIDER_REQUIRED");
            const result = await executeCase(plan, live, { ...options, page });
            if (!options.redact) throw new Error("REDACTION_PROVIDER_REQUIRED");
            if (!options.datasetProtected)
                await info.attach("veriq-result", {
                    body: Buffer.from(JSON.stringify(options.redact(result as unknown as JsonValue))),
                    contentType: "application/json",
                });
            if (result.outcome !== "PASSED")
                throw new Error(`VERIQ_${result.outcome}: ${result.errorCode ?? "CASE_FAILED"}`);
        });
    });
}
