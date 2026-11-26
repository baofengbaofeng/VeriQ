/**
 * 用可控时钟验证数据集断言何时可以取得预期值，以及预算耗尽后读取与断言结果各自应有的行为。
 */

import { getEventListeners } from "node:events";
import type { Page } from "@playwright/test";
import type { CompiledAssertion, DatasetDocument, HttpDatasetResponse, JsonValue } from "@veriq/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import httpDatasetFixture from "../../contracts/fixtures/http-dataset.json" with { type: "json" };
import { runAssertion } from "../src/assertions/http.js";
import { createStepContext, ExecutionCancelled, type AssertionResult } from "../src/context.js";
import {
    connectedDatasetResolver,
    staticDatasetResolver,
    type DatasetResolver,
    type HttpDatasetReader,
} from "../src/datasets.js";

const sample = {
    sourceVersionId: "00000000-0000-4000-8000-000000000007",
    fetchedAt: "2026-01-02T03:04:05.000Z",
};
const label = "{{data.name}}";
const response: HttpDatasetResponse = { ...sample, rows: [{ key: "one", values: { label } }] };
const item = {
    sourcePath: "/steps/0/afterAssertions/0",
    parameters: [{ search: "{{vars.lookup}}" }],
    assertion: {
        id: "label",
        type: "responseField",
        source: "response:action",
        pointer: "/name",
        operator: "equals",
        severity: "BLOCK",
        expectedSource: "REQ-label",
        datasetExpected: {
            alias: "names",
            op: "field",
            key: "one",
            field: "label",
            parameters: { q: "{{data.search}}" },
        },
    },
} satisfies CompiledAssertion;

beforeEach(() => {
    vi.useFakeTimers({ now: new Date(sample.fetchedAt) });
});
afterEach(() => {
    vi.useRealTimers();
});

function deferred<T>() {
    // 由测试交付读取结果，推进业务时钟与完成异步工作可以独立发生，避免等待实际时间造成顺序不确定。
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

function context(datasets: DatasetResolver, actual: JsonValue = label) {
    // 断言使用已捕获的网络交换，页面只占据上下文的必填位置，若意外调用页面方法则由测试直接暴露。
    const ctx = createStepContext({
        page: {} as Page,
        environment: {
            schemaVersion: "1.0",
            baseURL: "http://localhost",
            apiBaseURL: "http://localhost",
            allowedOrigins: ["http://localhost"],
            locale: "en-US",
            timezone: "UTC",
            roles: [
                {
                    roleKey: "reader",
                    authAdapterVersionId: sample.sourceVersionId,
                    secretRef: "reader",
                    secretVersionId: sample.sourceVersionId,
                },
            ],
        },
        catalog: { schemaVersion: "1.0", elements: [{ key: "name", locator: { by: "veriqId", value: "name" } }] },
        data: { name: "must stay unevaluated", search: "outer" },
        vars: { lookup: "scoped" },
        datasets,
        datasetProtected: true,
    });
    ctx.sources.set("action", {
        requestId: "req",
        request: { method: "GET", path: "/items", query: {}, body: null, headers: {} },
        response: { status: 200, body: { name: actual }, bodyKind: "json", headers: {} },
        durationMs: 1,
    });
    return ctx;
}

function httpPhase(read: HttpDatasetReader) {
    // 只替换冻结版本的传输回调，继续走真实的联网数据求值、样本元数据投影及同阶段缓存路径。
    const document = {
        schemaVersion: "2.0",
        shape: "TABLE",
        fields: { label: { type: "string", required: true, nullable: false } },
        source: {
            ...httpDatasetFixture.source,
            kind: "HTTP",
            method: "GET",
            parameters: { q: "string" },
            auth: { kind: "NONE" },
        },
    } satisfies DatasetDocument;
    const resolver = connectedDatasetResolver(
        new Map([["names", document]]),
        { names: sample.sourceVersionId },
        document.source.environmentVersionId,
        read,
    );
    if (!resolver.phase) throw new Error("HTTP dataset fixture requires a sampling phase");
    return resolver.phase();
}

function expectTimeout(result: AssertionResult | undefined, severity: "BLOCK" | "WARN") {
    // 只有在实际返回了预算错误并且没有样本出处时才算失效关闭，同时保留断言在编译产物中的定位信息。
    expect(result).toMatchObject({
        id: "label",
        sourcePath: "/steps/0/afterAssertions/0",
        severity,
        status: "ERROR",
        errorCode: "BUSINESS_TIMEOUT",
        expected: null,
        actual: { present: false },
    });
    expect(result).not.toHaveProperty("sample");
}

it.each([
    [label, "PASSED"],
    ["different", "WARN"],
] as const)("compares an in-budget HTTP sample with actual %s as %s", async (actual, status) => {
    const read = vi.fn(async () => response);
    const phase = httpPhase(read);
    const ctx = context(phase, actual);
    const assertion = { ...item, assertion: { ...item.assertion, severity: "WARN" as const } };
    try {
        const result = await runAssertion(assertion, { ...ctx, deadline: Date.now() + 20 });
        expect(read).toHaveBeenCalledWith(sample.sourceVersionId, { q: "scoped" }, expect.any(AbortSignal));
        expect(result).toMatchObject({
            id: "label",
            sourcePath: "/steps/0/afterAssertions/0",
            expectedSource: "PROTECTED_CASE",
            status,
            sample,
            expected: null,
            actual: { present: false },
        });
    } finally {
        phase.close();
    }
});

it("evaluates static dataset values without adding HTTP sample metadata", async () => {
    const staticData: DatasetDocument = {
        schemaVersion: "1.0",
        columns: { label: "string" },
        rows: [{ key: "one", values: { label } }],
    };
    const ctx = context(staticDatasetResolver(new Map([["names", staticData]])));
    const assertion = {
        ...item,
        assertion: { ...item.assertion, datasetExpected: { alias: "names", op: "field", key: "one", field: "label" } },
    } satisfies CompiledAssertion;
    const result = await runAssertion(assertion, { ...ctx, deadline: Date.now() + 20 });
    expect(result.status).toBe("PASSED");
    expect(result).not.toHaveProperty("sample");
});

it.each(["BLOCK", "WARN"] as const)("does not start the reader for an expired %s assertion", async (severity) => {
    const read = vi.fn(async () => label);
    const ctx = context({ read });
    const result = await runAssertion(
        { ...item, assertion: { ...item.assertion, severity } },
        {
            ...ctx,
            deadline: Date.now(),
        },
    );
    expectTimeout(result, severity);
    expect(read).not.toHaveBeenCalled();
});

it.each(["BLOCK", "WARN"] as const)("aborts a pending HTTP reader at the %s deadline", async (severity) => {
    const late = deferred<HttpDatasetResponse>();
    let signal: AbortSignal | undefined;
    const phase = httpPhase((_version, _parameters, sampling) => {
        signal = sampling;
        return late.promise;
    });
    const ctx = context(phase);
    const compare = vi.spyOn(ctx.sources, "get");
    let completed: AssertionResult | undefined;
    const assertion = { ...item, assertion: { ...item.assertion, severity } };
    const result = runAssertion(assertion, { ...ctx, deadline: Date.now() + 20 }).then((value) => {
        completed = value;
    });

    // 用时钟推进到临界点，验证断言先于忽略取消的读取完成，之后释放读取以验证迟到值无法再触发比较。
    try {
        await vi.advanceTimersByTimeAsync(19);
        expect(completed).toBeUndefined();
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expectTimeout(completed, severity);
        expect(signal?.aborted).toBe(true);
        late.resolve(response);
        await result;
        await vi.advanceTimersByTimeAsync(0);
        expectTimeout(completed, severity);
        expect(compare).not.toHaveBeenCalled();
    } finally {
        phase.close();
        late.resolve(response);
        await result;
    }
});

it("rejects a value delivered after the clock reaches the deadline before the timer fires", async () => {
    const pending = deferred<JsonValue>();
    let readSignal: AbortSignal | undefined;
    const ctx = context({
        read(_query, _scope, signal, sampled) {
            readSignal = signal;
            sampled?.(sample);
            return pending.promise;
        },
    });
    const compare = vi.spyOn(ctx.sources, "get");
    const deadline = Date.now() + 20;
    const result = runAssertion(item, { ...ctx, deadline });

    // 先交付元数据再推进挂钟，但不执行计时器，让同一轮抵达的值只能凭实际时钟判定为超时。
    vi.setSystemTime(deadline);
    pending.resolve(label);
    expectTimeout(await result, "BLOCK");
    expect(readSignal?.aborted).toBe(true);
    expect(compare).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
});

it("preserves ExecutionCancelled for user cancellation during the read", async () => {
    const pending = deferred<JsonValue>();
    const user = new AbortController();
    let readSignal: AbortSignal | undefined;
    const ctx = context({
        read(_query, _scope, signal) {
            readSignal = signal;
            return pending.promise;
        },
    });
    const result = runAssertion(item, { ...ctx, signal: user.signal, deadline: Date.now() + 20 });
    const cancelled = expect(result).rejects.toBeInstanceOf(ExecutionCancelled);
    user.abort();
    await cancelled;
    expect(readSignal?.aborted).toBe(true);
    expect(getEventListeners(user.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    pending.reject(new Error("LATE_READER_ERROR"));
    await vi.advanceTimersByTimeAsync(0);
});

it("leaves a read without a deadline pending until the provider returns", async () => {
    const pending = deferred<HttpDatasetResponse>();
    const phase = httpPhase(() => pending.promise);
    const ctx = context(phase);
    let completed = false;
    const result = runAssertion(item, ctx).then((value) => {
        completed = true;
        return value;
    });
    try {
        await vi.advanceTimersByTimeAsync(1_000_000);
        expect(completed).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        pending.resolve(response);
        expect(await result).toMatchObject({ status: "PASSED", sample });
    } finally {
        phase.close();
        pending.resolve(response);
        await result;
    }
});

it("releases sampling timers and abort listeners across completed assertions", async () => {
    const user = new AbortController();
    const signals: AbortSignal[] = [];
    const ctx = context({
        async read(_query, _scope, signal) {
            signals.push(signal);
            if (signals.length === 2) throw new Error("DATASET_UPSTREAM_REJECTED");
            return label;
        },
    });
    const scoped = { ...ctx, signal: user.signal, deadline: Date.now() + 20 };
    for (const status of ["PASSED", "ERROR", "PASSED"]) {
        expect(await runAssertion(item, scoped)).toMatchObject({ status });
        expect(vi.getTimerCount()).toBe(0);
        expect(getEventListeners(user.signal, "abort")).toHaveLength(0);
        for (const signal of signals) expect(getEventListeners(signal, "abort")).toHaveLength(0);
    }
    user.abort();
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false, false]);
});
