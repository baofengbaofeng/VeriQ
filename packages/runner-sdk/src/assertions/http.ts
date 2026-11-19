/**
 * 本文件实现 HTTP/数据断言：按字段匹配期望值：并在交换对象上运行编译期展开后的断言列表，供调用方理解 http 路径。
 */

import { addAbortListener } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { expect } from "@playwright/test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
    accepts,
    assertionExpectedTypes,
    valueType,
    validateSchema,
    resolvePointer,
    type CompiledAssertion,
    type HttpDatasetSample,
    type JsonValue,
    type Presence,
    type JsonObject,
} from "@veriq/contracts";
import {
    assertionScope,
    interruptible,
    ExecutionCancelled,
    binding,
    budget,
    exchange,
    type StepContext,
    type AssertionResult,
} from "../context.js";
import { assertUI, uiActual } from "./ui.js";
import { apiRequest } from "../http.js";
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
/**
 * 公开函数 fieldMatches 按断言操作符比较期望与实际字段：类型不接受时失败：供 runAssertion 复用。
 */
export function fieldMatches(actual: Presence, operator: string, expected: JsonValue): boolean {
    if (operator === "exists") return actual.present === expected;
    if (!actual.present) return false;
    const value = actual.value;
    switch (operator) {
        case "equals":
            return isDeepStrictEqual(value, expected);
        case "notEquals":
            return !isDeepStrictEqual(value, expected);
        case "in":
            return Array.isArray(expected) && expected.some((x) => isDeepStrictEqual(x, value));
        case "contains":
            return typeof value === "string" && typeof expected === "string"
                ? value.includes(expected)
                : Array.isArray(value) &&
                      Array.isArray(expected) &&
                      expected.every((e) => value.some((v) => isDeepStrictEqual(e, v)));
        default:
            return false;
    }
}
/**
 * 受保护断言只发送固定标记，服务端根据实际冻结来源生成最终出处；普通断言保留作者说明。
 */
export function assertionExpectedSource(item: CompiledAssertion, ctx: StepContext): string {
    return ctx.datasetProtected ? "PROTECTED_CASE" : item.assertion.expectedSource;
}
/**
 * 公开函数 runAssertion 在 Exchange/数据上下文上执行单条编译断言：返回 AssertionResult。不把原始密钥写入结果。
 */
export async function runAssertion(
    item: CompiledAssertion,
    outer: StepContext,
    counts?: Map<string, number>,
): Promise<AssertionResult> {
    const start = Date.now(),
        a = item.assertion;
    let actual: Presence = { present: false },
        expected: JsonValue = "expected" in a ? a.expected : null,
        ctx = outer;
    let sample: HttpDatasetSample | undefined;
    let queryError = "datasetExpected" in a;
    let errorCode: string | undefined;
    try {
        budget(ctx, 1);
        ctx = { ...assertionScope(item, outer), page: outer.originalPage };
        if ("pageKey" in a && a.pageKey) {
            const page = ctx.pages.get(a.pageKey);
            if (!page) throw new Error("UNKNOWN_PAGE_KEY");
            ctx = { ...ctx, page: await interruptible(ctx, () => page) };
        }
        if ("datasetExpected" in a) {
            budget(ctx, 1);
            const { datasets, deadline, signal: userSignal } = ctx;
            if (!datasets) throw new Error("DATASET_RESOLVER_REQUIRED");
            const sampling = new AbortController();
            const timeout = new Error("BUSINESS_TIMEOUT");
            const userAbort = userSignal && addAbortListener(userSignal, () => sampling.abort(userSignal.reason));
            let timer: ReturnType<typeof setTimeout> | undefined;
            let acceptingSample = true;
            let receivedSample: HttpDatasetSample | undefined;

            // 按当前挂钟安排一次等待，超过单次定时器上限时再核对原截止时间，避免提前触发业务超时。
            const scheduleTimeout = () => {
                const remaining = (deadline ?? Infinity) - Date.now();
                if (remaining <= 0) {
                    sampling.abort(timeout);
                } else if (Number.isFinite(remaining)) {
                    timer = setTimeout(scheduleTimeout, Math.min(remaining, 2 ** 31 - 1));
                }
            };
            try {
                scheduleTimeout();
                const result = await interruptible(sampling, () =>
                    datasets.read(
                        a.datasetExpected,
                        { data: ctx.data, vars: ctx.vars },
                        sampling.signal,
                        (metadata) => {
                            if (acceptingSample && !sampling.signal.aborted) receivedSample = metadata;
                        },
                    ),
                ).then(
                    (value) => ({ value }),
                    (error: unknown) => ({ error }),
                );

                // 定时器回调可能晚于读取完成，交付值与样本出处前用实际挂钟和已经发生的取消再判定一次。
                if (userSignal?.aborted) throw new ExecutionCancelled();
                if (sampling.signal.reason === timeout || (deadline !== undefined && Date.now() >= deadline)) {
                    sampling.abort(timeout);
                    throw timeout;
                }
                sample = receivedSample;
                if ("error" in result) throw result.error;
                expected = result.value;
            } finally {
                // 断言离开采样后停止接受元数据并解绑用户取消，忽略取消的读取也无法影响接下来的断言。
                acceptingSample = false;
                clearTimeout(timer);
                userAbort?.[Symbol.dispose]();
            }
            if (!assertionExpectedTypes(a).some((t) => accepts(t, valueType(expected))))
                throw new Error("DATASET_EXPECTED_TYPE");
            if (
                ["httpStatus", "duration", "requestCount", "request"].includes(a.type) ||
                a.operator === "countEquals"
            ) {
                const { datasetExpected: _query, ...literal } = a;
                if (validateSchema("AssertionV1", { ...literal, expected }).length)
                    throw new Error("DATASET_EXPECTED_TYPE");
            }
            queryError = false;
        } else expected = a.type === "responseSchema" ? a.expected : binding(a.expected, ctx);
        let pass = false;
        if (a.type === "ui" || a.type === "url") {
            actual = await interruptible(ctx, () => assertUI(a, expected, ctx));
            pass = true;
        } else if (a.type === "eventually") {
            const timeout = budget(ctx, a.timeoutMs ?? 10000),
                deadline = Date.now() + timeout;
            const path = binding(a.query.path, ctx);
            if (typeof path !== "string" || a.query.method !== "GET") throw new Error("READ_ONLY_QUERY_REQUIRED");
            await interruptible(ctx, () =>
                expect
                    .poll(
                        async () => {
                            const x = await apiRequest(
                                {
                                    ...ctx,
                                    deadline: Math.min(ctx.deadline ?? Infinity, deadline),
                                },
                                "GET",
                                path,
                                binding(a.query.query ?? {}, ctx) as JsonObject,
                                undefined,
                                undefined,
                                timeout,
                            );
                            actual =
                                x.response.bodyKind === "json"
                                    ? resolvePointer(x.response.body, a.pointer)
                                    : { present: false };
                            return fieldMatches(actual, a.operator, expected);
                        },
                        { timeout, intervals: [a.intervalMs ?? 500] },
                    )
                    .toBe(true),
            );
            pass = true;
        } else if (a.type === "requestCount") {
            const count = counts?.get(a.source.slice(8));
            if (count === undefined) throw new Error("OBSERVER_WINDOW_REQUIRED");
            actual = { present: true, value: count };
            pass = count === expected;
        } else {
            const x = await interruptible(ctx, () => exchange(a.source, ctx));
            switch (a.type) {
                case "httpStatus":
                    actual = { present: true, value: x.response.status };
                    pass = isDeepStrictEqual(x.response.status, expected);
                    break;
                case "duration":
                    actual = { present: true, value: x.durationMs };
                    pass = x.durationMs <= Number(expected);
                    break;
                case "request":
                    actual = {
                        present: true,
                        value: a.operator === "methodEquals" ? x.request.method : x.request.path,
                    };
                    pass = isDeepStrictEqual(actual.value, expected);
                    break;
                case "requestField":
                    actual = resolvePointer(x.request as unknown as JsonValue, a.pointer);
                    pass = fieldMatches(actual, a.operator, expected);
                    break;
                case "responseField":
                    actual =
                        x.response.bodyKind === "json"
                            ? resolvePointer(x.response.body, a.pointer)
                            : { present: false };
                    pass = fieldMatches(actual, a.operator, expected);
                    break;
                case "responseSchema":
                    actual = { present: true, value: x.response.body };
                    pass = x.response.bodyKind === "json" && ajv.compile(a.expected)(x.response.body) === true;
                    break;
            }
        }
        if (!pass) errorCode = "ASSERTION_FAILED";
    } catch (e) {
        if (e instanceof ExecutionCancelled) throw e;
        errorCode =
            e instanceof Error && /^[A-Z_]+$/.test(e.message)
                ? e.message
                : queryError
                  ? "DATASET_READ_ERROR"
                  : "ASSERTION_FAILED";
        if (!queryError && (a.type === "ui" || a.type === "url")) {
            try {
                actual = await uiActual(a, ctx);
            } catch {
                /*
                 * 页面不可用而无法补取界面或地址证据时，继续保留原断言错误及已有值，缺失的数据维持缺失状态。
                 */
            }
        }
    }
    return {
        id: a.id,
        sourcePath: item.sourcePath,
        status: queryError ? "ERROR" : errorCode ? (a.severity === "WARN" ? "WARN" : "FAILED") : "PASSED",
        severity: a.severity,
        expectedSource: assertionExpectedSource(item, ctx),
        expected: ctx.datasetProtected || "datasetExpected" in a ? null : expected,
        actual: ctx.datasetProtected || "datasetExpected" in a ? { present: false } : actual,
        ...(sample ? { sample } : {}),
        durationMs: Date.now() - start,
        ...(errorCode ? { errorCode } : {}),
    };
}
