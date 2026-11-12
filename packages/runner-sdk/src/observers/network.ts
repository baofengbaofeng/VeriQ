/**
 * 本文件装载网络交换观察器：按规则匹配请求响应并提取可断言数据：步骤结束时卸除全部监听，供调用方理解 network 路径。
 */

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Page, Request, Response, APIResponse } from "@playwright/test";
import {
    canonicalBytes,
    type JsonValue,
    type NetworkObserverV1,
    type ObserverResultPayloadV1,
} from "@veriq/contracts";

/**
 * 公开接口 Exchange 表示一次匹配到的 HTTP 交换：含请求与响应摘要：供 HTTP 断言读取（Exchange）。
 */
export interface Exchange {
    requestId: string;
    request: {
        method: string;
        path: string;
        query: Record<string, JsonValue>;
        body: JsonValue;
        headers: Record<string, string>;
    };
    response: {
        status: number;
        body: JsonValue;
        bodyKind: "json" | "text" | "empty";
        headers: Record<string, string>;
    };
    durationMs: number;
}
/**
 * 公开接口 ObserverHandle 描述单个网络观察器句柄：可捕获请求并在结束时 dispose（ObserverHandle）。
 */
export interface ObserverHandle {
    waitFirst(): Promise<Exchange>;
    finalize(): Promise<ObserverResultPayloadV1>;
    /**
     * 公开方法 dispose 卸除并清空全部观察器：步骤或用例结束时必须调用以防泄漏监听，供调用方理解 dispose 路径。
     */
    dispose(): void;
    captureRequest?(
        url: string,
        data: Exchange["request"],
    ): ((response: Exchange["response"] | Error) => void) | undefined;
}
/**
 * 公开类 ObserverRegistry 登记步骤内活跃的网络观察器：统一转发请求并在 dispose 时清空（ObserverRegistry）。
 */
export class ObserverRegistry {
    private handles = new Set<
        Pick<ObserverHandle, "dispose" | "captureRequest">
    >();
    /**
     * 公开方法 add 把观察器句柄登记进注册表：后续请求将分发给其 captureRequest，供调用方理解 add 路径。
     */
    add(handle: Pick<ObserverHandle, "dispose" | "captureRequest">): void {
        this.handles.add(handle);
    }
    /**
     * 公开方法 remove 从注册表移除观察器句柄：不再接收后续请求回调，供调用方理解 remove 路径上的输入与失败语义。
     */
    remove(handle: Pick<ObserverHandle, "dispose" | "captureRequest">): void {
        this.handles.delete(handle);
    }
    /**
     * 公开方法 captureRequest 把请求分发给活跃观察器：返回响应收尾回调：无匹配则忽略（captureRequest）。
     */
    captureRequest(
        url: string,
        data: Exchange["request"],
    ): (response: Exchange["response"] | Error) => void {
        const callbacks = [...this.handles].map((h) =>
            h.captureRequest?.(url, data),
        );
        return (response) => {
            for (const cb of callbacks) cb?.(response);
        };
    }
    /**
     * 公开方法 activeCount 返回当前仍登记的网络观察器数量：供步骤收尾断言观察器已卸除（activeCount）。
     */
    activeCount(): number {
        return this.handles.size;
    }
    dispose(): void {
        for (const h of this.handles) h.dispose();
    }
}
/**
 * 公开接口 NetworkContext 为网络观察器提供页面/上下文与注册表等运行依赖（NetworkContext）。
 */
export interface NetworkContext {
    page: Page;
    apiBaseURL: string;
    allowedOrigins: string[];
    registry: ObserverRegistry;
    signal?: AbortSignal;
    deadline?: number;
}
/**
 * 公开函数 responseData 按编码读取响应体并限制体积：超限失败：供断言提取字段，供调用方理解 responseData 路径。
 */
export async function responseData(
    response: Response | APIResponse,
): Promise<Exchange["response"]> {
    const text = await response.text();
    let body: JsonValue = text,
        bodyKind: Exchange["response"]["bodyKind"] = text ? "text" : "empty";
    if (text) {
        try {
            body = JSON.parse(text) as JsonValue;
            bodyKind = "json";
        } catch {
            /* Non-JSON remains evidence, never a JSON null. */
        }
    }
    return {
        status: response.status(),
        body,
        bodyKind,
        headers: response.headers(),
    };
}
/**
 * 公开函数 requestData 从已捕获请求提取可断言数据视图：不回放原始流，供调用方理解 requestData 路径。
 */
export function requestData(request: Request): Exchange["request"] {
    const url = new URL(request.url());
    let body: JsonValue = request.postData();
    if (body !== null) {
        try {
            body = JSON.parse(body) as JsonValue;
        } catch {
            /* Preserve non-JSON body. */
        }
    }
    return {
        method: request.method(),
        path: url.pathname,
        query: queryData(url),
        body,
        headers: request.headers(),
    };
}
/** Scalars use URL strings; outer arrays repeat keys; structured values use canonical JSON. */
/**
 * 公开函数 queryParameters 解析 URL 查询参数为对象：供断言按名取值（queryParameters）。
 */
export function queryParameters(
    query: Record<string, JsonValue>,
): URLSearchParams {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        for (const item of Array.isArray(value) ? value : [value]) {
            params.append(
                key,
                item !== null && typeof item === "object"
                    ? new TextDecoder().decode(canonicalBytes(item))
                    : String(item),
            );
        }
    }
    return params;
}
/**
 * 公开函数 queryData 从交换中提取查询或正文数据片段：供字段级 HTTP 断言使用，供调用方理解 queryData 路径。
 */
export function queryData(
    url: URL | URLSearchParams,
): Record<string, JsonValue> {
    const params = url instanceof URL ? url.searchParams : url;
    return Object.fromEntries(
        [...new Set(params.keys())].map((k) => {
            const v = params.getAll(k);
            return [k, v.length === 1 ? v[0]! : v];
        }),
    );
}
function subset(actual: JsonValue, expected: JsonValue): boolean {
    if (
        expected === null ||
        typeof expected !== "object" ||
        Array.isArray(expected)
    )
        return isDeepStrictEqual(actual, expected);
    return (
        actual !== null &&
        typeof actual === "object" &&
        !Array.isArray(actual) &&
        Object.entries(expected).every(
            ([k, v]) => Object.hasOwn(actual, k) && subset(actual[k]!, v),
        )
    );
}
/** Timers express the declared observation window, never retry a browser action. */
/**
 * 公开函数 armObserver 按编译规则武装网络观察器并登记到 ObserverRegistry：步骤结束必须 dispose。
 */
export function armObserver(
    spec: NetworkObserverV1,
    ctx: NetworkContext,
): ObserverHandle {
    const start = Date.now(),
        timeout = Math.min(
            start + (spec.timeoutMs ?? 15000),
            ctx.deadline ?? Infinity,
        );
    const queryMatch = spec.queryMatch
        ? queryData(queryParameters(spec.queryMatch))
        : undefined;
    const fixedEnd =
        spec.window?.mode === "FIXED" ? start + spec.window.durationMs : undefined;
    const records: {
        request?: Request;
        data: Exchange["request"];
        at: number;
        completedAt?: number;
        response?: Exchange["response"];
        error?: Error;
        id: string;
    }[] = [];
    const pending = new Set<Promise<void>>();
    const watchers = new Set<() => void>();
    let disposed = false,
        last = start;
    const notify = () => {
        for (const f of watchers) f();
    };
    function captureRequest(address: string, data: Exchange["request"]) {
        const url = new URL(address);
        if (disposed || (fixedEnd !== undefined && Date.now() > fixedEnd)) return;
        if (
            url.origin !== new URL(ctx.apiBaseURL).origin ||
            !ctx.allowedOrigins.includes(url.origin) ||
            data.method !== spec.method ||
            url.pathname !== spec.path
        )
            return;
        if (
            (queryMatch && !subset(data.query, queryMatch)) ||
            (spec.bodyMatch && !subset(data.body, spec.bodyMatch))
        )
            return;
        const record: (typeof records)[number] = {
            data,
            at: Date.now(),
            id: randomUUID(),
        };
        records.push(record);
        last = Date.now();
        notify();
        return record;
    }
    const onRequest = (request: Request) => {
        const r = captureRequest(request.url(), requestData(request));
        if (r) r.request = request;
    };
    const onResponse = (response: Response) => {
        const record = records.find((r) => r.request === response.request());
        if (!record) return;
        const work = responseData(response)
            .then(
                (data) => {
                    record.response = data;
                    record.completedAt = Date.now();
                },
                (e) => {
                    record.error = e instanceof Error ? e : new Error(String(e));
                },
            )
            .finally(() => {
                pending.delete(work);
                notify();
            });
        pending.add(work);
    };
    const onFailed = (request: Request) => {
        const r = records.find((r) => r.request === request);
        if (r) {
            r.error = new Error("NETWORK_REQUEST_FAILED");
            notify();
        }
    };
    function check(): void {
        if (ctx.signal?.aborted) throw new Error("CANCELLED");
        if (disposed) throw new Error("OBSERVER_DISPOSED");
    }
    function changed(until: number): Promise<void> {
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                watchers.delete(done);
                resolve();
            };
            const timer = setTimeout(done, Math.max(0, until - Date.now()));
            watchers.add(done);
        });
    }
    const handle: ObserverHandle = {
        captureRequest(url, data) {
            const r = captureRequest(url, data);
            if (!r) return;
            return (response) => {
                if (response instanceof Error) r.error = response;
                else {
                    r.response = response;
                    r.completedAt = Date.now();
                }
                notify();
            };
        },
        async waitFirst() {
            while (true) {
                check();
                const r = records[0];
                if (r?.error) throw r.error;
                if (r?.response)
                    return {
                        requestId: r.id,
                        request: r.data,
                        response: r.response,
                        durationMs: r.completedAt! - r.at,
                    };
                if (Date.now() >= timeout) throw new Error("NETWORK_TIMEOUT");
                await changed(timeout);
            }
        },
        async finalize() {
            const settled = Date.now();
            // Exact-count windows validate their count below. An ordinary observer
            // must acquire a request, but need not await its response body.
            if (spec.expectedCount === undefined) {
                const acquisitionEnd = Math.min(timeout, fixedEnd ?? Infinity);
                while (records.length === 0) {
                    check();
                    if (Date.now() >= acquisitionEnd) throw new Error("NETWORK_TIMEOUT");
                    await changed(acquisitionEnd);
                }
                if (records[0]!.at > acquisitionEnd) throw new Error("NETWORK_TIMEOUT");
            }
            while (true) {
                check();
                const end =
                    fixedEnd ??
                    Math.max(settled, last) +
                        (spec.window?.mode === "UNTIL_ACTION_SETTLED"
                            ? (spec.window.quietMs ?? 500)
                            : 500);
                if (Date.now() >= end) break;
                if (Date.now() >= timeout) throw new Error("NETWORK_TIMEOUT");
                await changed(Math.min(end, timeout));
            }
            check();
            const first = records[0];
            const ambiguous =
                records.length > 1 &&
                (spec.retryPolicy !== "ALLOW_MATCHING_RETRIES" ||
                    records.some((r) => !isDeepStrictEqual(r.data, first!.data)));
            if (ambiguous) throw new Error("AMBIGUOUS_REQUEST");
            if (
                spec.expectedCount !== undefined &&
                records.length !== spec.expectedCount
            )
                throw new Error("REQUEST_COUNT_MISMATCH");
            return {
                observerId: spec.id,
                matchedCount: records.length,
                windowMode: spec.window?.mode ?? "UNTIL_ACTION_SETTLED",
                durationMs: Date.now() - start,
                ambiguous,
                requests: records.map((r) => ({
                    requestId: r.id,
                    method: spec.method,
                    path: r.data.path,
                    ...(r.response ? { status: r.response.status } : {}),
                })),
            };
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            ctx.page.off("request", onRequest);
            ctx.page.off("response", onResponse);
            ctx.page.off("requestfailed", onFailed);
            ctx.signal?.removeEventListener("abort", notify);
            ctx.registry.remove(handle);
            notify();
        },
    };
    ctx.page.on("request", onRequest);
    ctx.page.on("response", onResponse);
    ctx.page.on("requestfailed", onFailed);
    ctx.signal?.addEventListener("abort", notify);
    ctx.registry.add(handle);
    return handle;
}
