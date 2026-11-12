/**
 * 本文件构建步骤执行上下文：绑定解析、预算中断、定位器与交换对象：供生成代码与断言共用，标注导出符号 context 供检索。
 */

import type { Page, Locator } from "@playwright/test";
import {
    resolveBinding,
    type JsonObject,
    type JsonValue,
    type ElementCatalogV1,
    type EnvironmentV1,
    type CompiledAssertion,
    type AssertionResultPayloadV1,
    type StepFinishedPayloadV1,
    type ObserverResultPayloadV1,
} from "@veriq/contracts";
import {
    ObserverRegistry,
    type Exchange,
    type ObserverHandle,
} from "./observers/network.js";
/**
 * 公开接口 AssertionResult 描述单条断言的通过/失败与可安全投影的实际值摘要（AssertionResult）。
 */
export interface AssertionResult extends AssertionResultPayloadV1 {
    id: string;
    sourcePath: string;
}
/**
 * 公开接口 StepResult 汇总步骤结局、断言结果与观察器输出：供事件上报与报告投影（StepResult）（StepResult）。
 */
export interface StepResult extends StepFinishedPayloadV1 {
    id: string;
    sourcePath: string;
    assertions: AssertionResult[];
    observers: ObserverResultPayloadV1[];
    children: StepResult[];
    events: import("./observers/events.js").EventEvidence[];
    cancelled?: boolean;
}
/**
 * 公开类型 LiveStepEvent 枚举步骤生命周期实时事件：供 EventBuffer/SDK 观察者消费（LiveStepEvent）。
 */
export type LiveStepEvent =
    | {type: "STEP_STARTED"; stepId: string}
    | {type: "STEP_FINISHED"; stepId: string; result: StepFinishedPayloadV1}
    | {type: "ASSERTION_RESULT"; stepId: string; assertionId: string; result: AssertionResultPayloadV1}
    | {type: "OBSERVER_RESULT"; stepId: string; result: ObserverResultPayloadV1};
/**
 * 公开接口 StepContextOptions 配置 createStepContext 所需的页面、执行、预算与绑定环境。
 */
/**
 * 公开接口 StepContext 暴露生成代码可用的定位、交换、断言与预算 API：由 createStepContext 构造。
 */
export interface StepContextOptions {
    onBusinessRequest?: (method: string) => void;
    onEvent?: (event: LiveStepEvent) => Promise<void>;
    page: Page;
    environment: EnvironmentV1;
    catalog: ElementCatalogV1;
    data?: JsonObject;
    vars?: JsonObject;
    signal?: AbortSignal;
    deadline?: number;
    downloads?: { directory: string; maxBytes: number };
    files?: (
        paths: string[],
    ) => Promise<{ name: string; mimeType: string; buffer: Buffer }[]>;
}
/**
 * 公开接口 StepContext 在 StepContextOptions 之上暴露 originalPage、观察器注册表与 dispose，供生成步骤代码使用。
 */
export interface StepContext extends StepContextOptions {
    originalPage: Page;
    dialogObservers: Map<Page, number>;
    data: JsonObject;
    vars: JsonObject;
    registry: ObserverRegistry;
    sources: Map<string, Exchange | ObserverHandle>;
    pages: Map<string, Promise<Page>>;
    dispose(): void;
}
/**
 * 公开类型 ResolvedStep 表示编译后步骤加上运行时解析后的绑定与子步骤树，标注导出 ResolvedStep。
 */
export type ResolvedStep = import("@veriq/contracts").CompiledStep;
/**
 * 公开函数 createStepContext 装配 StepContext：注入取消信号与证据策略：生成代码只依赖该稳定面。
 */
export function createStepContext(options: StepContextOptions): StepContext {
    const registry = new ObserverRegistry();
    const abort = () => {
        registry.dispose();
        void options.page
            .context()
            .close()
            .catch(() => {});
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    return {
        ...options,
        originalPage: options.page,
        dialogObservers: new Map(),
        data: structuredClone(options.data ?? {}),
        vars: structuredClone(options.vars ?? {}),
        registry,
        sources: new Map(),
        pages: new Map(),
        dispose() {
            options.signal?.removeEventListener("abort", abort);
            registry.dispose();
        },
    };
}
/** A typed interruption, selected only when abort wins over operation settlement. */
/**
 * 公开类 ExecutionCancelled 表示执行被取消或预算耗尽：用于中断嵌套等待而不伪装成断言失败（ExecutionCancelled/BUSINESS_TIMEOUT）。
 */
export class ExecutionCancelled extends Error {
    constructor() { super("CANCELLED"); }
}
/**
 * 公开函数 interruptible 在 AbortSignal 触发时拒绝 Promise：包装可等待操作以支持取消。
 */
export function interruptible<T>(ctx: Pick<StepContext, "signal">, operation: () => Promise<T>): Promise<T> {
    if (ctx.signal?.aborted) return Promise.reject(new ExecutionCancelled());
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (value: T | undefined, error?: unknown) => {
            if (settled) return;
            settled = true;
            ctx.signal?.removeEventListener("abort", abort);
            if (error !== undefined) reject(error); else resolve(value as T);
        };
        const abort = () => finish(undefined, new ExecutionCancelled());
        ctx.signal?.addEventListener("abort", abort, {once:true});
        try { operation().then(value => finish(value), error => finish(undefined, error)); }
        catch (error) { finish(undefined, error); }
    });
}
/**
 * 公开函数 budget 从剩余总预算派生嵌套超时：防止子等待超过 Attempt 剩余时间（budget/BUSINESS_TIMEOUT）。
 */
export function budget(ctx: StepContext, requested: number): number {
    if (ctx.signal?.aborted) throw new ExecutionCancelled();
    const n = Math.min(requested, (ctx.deadline ?? Infinity) - Date.now());
    if (n <= 0) throw new Error("BUSINESS_TIMEOUT");
    return n;
}
/**
 * 公开函数 binding 解析 DSL 绑定表达式：区分缺失与 null：类型不符抛出稳定错误（binding/BINDING_TYPE_MISMATCH）。
 */
export function binding(value: JsonValue, ctx: StepContext): JsonValue {
    return resolveBinding(value, { data: ctx.data, vars: ctx.vars });
}
/**
 * 公开函数 stringBinding 要求绑定结果为字符串：供需要文本输入的动作与断言使用（stringBinding/BINDING_TYPE_MISMATCH）。
 */
export function stringBinding(value: JsonValue, ctx: StepContext): string {
    const v = binding(value, ctx);
    if (typeof v !== "string") throw new Error("BINDING_TYPE_MISMATCH");
    return v;
}
/**
 * 公开函数 assertionScope 构造断言求值作用域：注入 data/vars：限制可见绑定面（assertionScope/CATALOG_SCOPE_CYCLE）。
 */
export function assertionScope(
    item: CompiledAssertion,
    ctx: StepContext,
): StepContext {
    let result = ctx;
    for (const frame of item.parameters)
        result = {
            ...result,
            data: { ...result.data, ...(binding(frame, result) as JsonObject) },
        };
    return result;
}
/**
 * 公开函数 locator 按编译后的定位描述创建 Playwright Locator：不接受运行时拼装的任意选择器字符串。
 */
export function locator(
    key: string,
    ctx: StepContext,
    seen = new Set<string>(),
): Locator {
    if (seen.has(key)) throw new Error("CATALOG_SCOPE_CYCLE");
    seen.add(key);
    const e = ctx.catalog.elements.find((x) => x.key === key);
    if (!e) throw new Error("TARGET_NOT_FOUND");
    const root = e.scope ? locator(e.scope, ctx, seen) : ctx.page;
    let result =
        e.locator.by === "testId"
            ? root.getByTestId(e.locator.value)
            : root.getByRole(e.locator.role as Parameters<Page["getByRole"]>[0], {
                    ...(e.locator.name === undefined
                        ? {}
                        : { name: stringBinding(e.locator.name, ctx) }),
                    ...(e.locator.exact === undefined ? {} : { exact: e.locator.exact }),
                });
    if (e.recordKey !== undefined)
        result = result.and(
            ctx.page.locator(
                `[data-record-key=${JSON.stringify(stringBinding(e.recordKey, ctx))}]`,
            ),
        );
    return result;
}
/**
 * 公开函数 exchange 等待并返回已武装网络观察器捕获的交换：超时或取消时失败关闭（exchange/SOURCE_UNAVAILABLE）。
 */
export async function exchange(
    source: string,
    ctx: StepContext,
): Promise<Exchange> {
    const value = ctx.sources.get(source.slice(source.indexOf(":") + 1));
    if (!value) throw new Error("SOURCE_UNAVAILABLE");
    return "waitFirst" in value ? value.waitFirst() : value;
}
