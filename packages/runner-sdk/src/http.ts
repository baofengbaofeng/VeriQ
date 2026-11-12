/**
 * 本文件提供业务 HTTP 辅助：规范化授权 URL：并在取消信号下发起不跟随重定向的 API 请求（http/INVALID_PATH）。
 */

import { businessHeaders } from "./fixtures/auth.js";
import type { HttpMethod, JsonObject, JsonValue } from "@veriq/contracts";
import { randomUUID } from "node:crypto";
import { budget, type StepContext } from "./context.js";
import {
    responseData,
    queryData,
    queryParameters,
    type Exchange,
} from "./observers/network.js";
/**
 * 公开函数 authorizedURL 在业务基址上解析相对路径：拒绝越出授权 Origin 的地址（authorizedURL/INVALID_PATH）。
 */
export function authorizedURL(
    path: string,
    base: string,
    origins: string[],
): URL {
    let decoded = path;
    while (true) {
        if (!/^\/(?!\/)/u.test(decoded) || /[\\\u0000-\u001f\u007f]/u.test(decoded))
            throw new Error("INVALID_PATH");
        let next: string;
        try {
            next = decodeURIComponent(decoded);
        } catch {
            throw new Error("INVALID_PATH");
        }
        if (next === decoded) break;
        decoded = next;
    }
    const url = new URL(path, base);
    if (url.origin !== new URL(base).origin || !origins.includes(url.origin))
        throw new Error("ORIGIN_NOT_ALLOWED");
    return url;
}
/**
 * 公开函数 apiRequest 发起不跟随重定向、省略 Cookie 的业务请求：尊重 AbortSignal：超限响应体失败关闭。
 */
export async function apiRequest(
    ctx: StepContext,
    method: HttpMethod,
    path: string,
    query?: JsonObject,
    body?: JsonValue,
    headers?: Record<string, string>,
    timeout = 10000,
): Promise<Exchange> {
    let url = authorizedURL(
        path,
        ctx.environment.apiBaseURL,
        ctx.environment.allowedOrigins,
    );
    const parameters = queryParameters(query ?? {});
    for (const [key, value] of Object.entries(query ?? {})) {
        if (!Array.isArray(value)) url.searchParams.delete(key);
        for (const item of parameters.getAll(key))
            url.searchParams.append(key, item);
    }
    const start = Date.now(),
        deadline = start + budget(ctx, timeout),
        original = url;
    const data = {
        method,
        path: original.pathname,
        query: queryData(original),
        body: body ?? null,
        headers: headers ?? {},
    };
    ctx.onBusinessRequest?.(method);
    const captured = ctx.registry.captureRequest(original.href, data);
    try {
        for (let redirects = 0; redirects <= 10; redirects++) {
            const response = await ctx.page.request.fetch(url.href, {
                method,
                ...(body === undefined ? {} : { data: body }),
                headers: {
                    ...headers,
                    ...businessHeaders(ctx.page.context(), url.href),
                },
                timeout: budget(ctx, deadline - Date.now()),
                maxRedirects: 0,
                maxRetries: 0,
            });
            try {
                if ([301, 302, 303, 307, 308].includes(response.status())) {
                    const location = response.headers().location;
                    if (!location) throw new Error("INVALID_REDIRECT");
                    url = new URL(location, url);
                    if (
                        url.origin !== original.origin ||
                        !ctx.environment.allowedOrigins.includes(url.origin)
                    )
                        throw new Error("ORIGIN_NOT_ALLOWED");
                    authorizedURL(
                        url.pathname + url.search,
                        ctx.environment.apiBaseURL,
                        ctx.environment.allowedOrigins,
                    );
                    // Never replay a write at an implicit redirect destination.
                    if (method !== "GET" && method !== "HEAD")
                        throw new Error("WRITE_REDIRECT_FORBIDDEN");
                    continue;
                }
                const result = await responseData(response);
                captured(result);
                return {
                    requestId: randomUUID(),
                    request: data,
                    response: result,
                    durationMs: Date.now() - start,
                };
            } finally {
                await response.dispose();
            }
        }
        throw new Error("REDIRECT_LIMIT");
    } catch (e) {
        captured(e instanceof Error ? e : new Error(String(e)));
        throw e;
    }
}
