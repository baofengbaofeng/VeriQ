/**
 * 本文件提供业务认证夹具辅助：组装鉴权头并在页面或请求上完成已钉选身份的登录校验，专用于 auth 路径（CANCELLED）。
 */

import {
    request,
    type APIRequestContext,
    type BrowserContext,
    type Route,
} from "@playwright/test";
import { createHash } from "node:crypto";
import {
    canonicalBytes,
    resolvePointer,
    type FixtureIdentityV1,
    type JsonObject,
    type JsonValue,
} from "@veriq/contracts";
import type { LifecycleContext, FixtureServiceContext } from "../register-case.js";
import { authorizedURL } from "../http.js";
const headers = new WeakMap<
    BrowserContext,
    { origin: string; token: string }
>();
/**
 * 公开函数 businessHeaders 根据认证材料组装业务请求头：不把密钥回写入普通日志字段（businessHeaders/CANCELLED）。
 */
export function businessHeaders(
    context: BrowserContext,
    url: string,
): Record<string, string> {
    const value = headers.get(context);
    return value && new URL(url).origin === value.origin
        ? { authorization: `Bearer ${value.token}` }
        : {};
}
/**
 * 公开函数 authenticatedRequest 在已鉴权上下文中发起业务请求：失败时保留状态码而不泄露令牌（authenticatedRequest/CANCELLED）。
 */
export async function authenticatedRequest(
    context: FixtureServiceContext,
    identity: FixtureIdentityV1,
    base: string,
): Promise<{
    client: APIRequestContext;
    identityId: string;
    dispose: () => Promise<void>;
    token?: string;
}> {
    const { execution, signal } = context;
    if (signal.aborted) throw new Error("CANCELLED");
    const adapter = execution.authAdapters?.find(
        (a) => a.versionId === identity.authAdapterVersionId,
    );
    if (!adapter || adapter.workspaceId !== execution.workspaceId)
        throw new Error("AUTH_ADAPTER_REQUIRED");
    if (
        createHash("sha256")
            .update(canonicalBytes(adapter.configuration))
            .digest("hex") !== adapter.contentHash
    )
        throw new Error("AUTH_ADAPTER_HASH_MISMATCH");
    if (
        !execution.secretVersions.some(
            (s) =>
                s.secretRef === identity.secretRef &&
                s.versionId === identity.secretVersionId,
        )
    )
        throw new Error("SECRET_VERSION_MISMATCH");
    if (!context.credentials) throw new Error("CREDENTIAL_PROVIDER_REQUIRED");
    const config = adapter.configuration;
    const identityURL = authorizedURL(
        config.identityPath,
        base,
        execution.environment.allowedOrigins,
    ).href;
    const loginURL =
        config.kind === "HTTP_SESSION"
            ? authorizedURL(
                    config.loginPath,
                    base,
                    execution.environment.allowedOrigins,
                ).href
            : undefined;
    const secret = await context.credentials.resolve(
        {
            workspaceId: execution.workspaceId,
            secretRef: identity.secretRef,
            versionId: identity.secretVersionId,
        },
        signal,
    );
    context.protect?.(secret);
    if (signal.aborted) throw new Error("CANCELLED");
    let token: string | undefined;
    if (config.kind === "HTTP_BEARER") {
        if (
            !secret ||
            typeof secret !== "object" ||
            Array.isArray(secret) ||
            typeof secret.token !== "string" ||
            !secret.token ||
            /[\r\n]/u.test(secret.token)
        )
            throw new Error("CREDENTIAL_SHAPE_INVALID");
        token = secret.token;
    }
    const client = await request.newContext({
        ...(token
            ? { extraHTTPHeaders: { authorization: `Bearer ${token}` } }
            : {}),
    });
    const abort = () => {
        void client.dispose().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    const dispose = async () => {
        signal.removeEventListener("abort", abort);
        await client.dispose();
    };
    try {
        if (loginURL) {
            const login = await client.post(loginURL, {
                data: secret,
                maxRedirects: 0,
                maxRetries: 0,
                timeout: 15000,
            });
            try {
                if (!login.ok()) throw new Error("AUTHENTICATION_FAILED");
            } finally {
                await login.dispose();
            }
        }
        const response = await client.get(identityURL, {
            maxRedirects: 0,
            maxRetries: 0,
            timeout: 15000,
        });
        let identityId: string;
        try {
            if (!response.ok()) throw new Error("AUTHENTICATION_FAILED");
            const found = resolvePointer(
                (await response.json()) as JsonValue,
                config.identityPointer,
            );
            if (
                !found.present ||
                typeof found.value !== "string" ||
                !identity.allowedIdentityIds?.includes(found.value)
            )
                throw new Error("IDENTITY_NOT_ALLOWED");
            identityId = found.value;
        } finally {
            await response.dispose();
        }
        const state = await client.storageState();
        context.protect?.(state as unknown as JsonValue);
        return { client, identityId, dispose, ...(token ? { token } : {}) };
    } catch {
        await dispose();
        throw new Error(signal.aborted ? "CANCELLED" : "AUTHENTICATION_FAILED");
    }
}
/**
 * 公开函数 authenticateBusiness 按生命周期提供者完成业务登录：校验返回的 identityId 非空且落在允许集合。
 */
export async function authenticateBusiness(
    context: LifecycleContext,
): Promise<{ identityId: string; dispose: () => Promise<void> }> {
    const role = context.execution.environment.roles.find(
        (r) => r.roleKey === context.execution.roleKey,
    );
    if (!role) throw new Error("ROLE_NOT_FOUND");
    const base = context.execution.environment.apiBaseURL;
    const authenticated = await authenticatedRequest(context, role, base);
    const browser = context.page.context();
    let route: ((route: Route) => Promise<void>) | undefined;
    try {
        if (authenticated.token) {
            headers.set(browser, {
                origin: new URL(base).origin,
                token: authenticated.token,
            });
            route = async (r) => {
                try {
                    const url = r.request().url();
                    if (
                        !context.execution.environment.allowedOrigins.includes(
                            new URL(url).origin,
                        )
                    ) {
                        await r.abort();
                        return;
                    }
                    const auth = businessHeaders(browser, url);
                    if (!auth.authorization) {
                        await r.continue();
                        return;
                    }
                    // Fulfill each hop separately: route.continue headers otherwise follow redirects.
                    const response = await r.fetch({
                        headers: { ...r.request().headers(), ...auth },
                        maxRedirects: 0,
                        maxRetries: 0,
                    });
                    try {
                        await r.fulfill({ response });
                    } finally {
                        await response.dispose();
                    }
                } catch {
                    // Playwright errors can embed authentication headers. Convert transport
                    // failure into an observable failed browser request, never a raw log.
                    if (!context.page.isClosed()) {
                        try {
                            await r.abort("failed");
                        } catch {
                            if (!context.page.isClosed())
                                throw new Error("AUTHENTICATED_REQUEST_ABORT_FAILED");
                        }
                    }
                }
            };
            await browser.route("**/*", route);
        } else {
            const cookies = (await authenticated.client.storageState()).cookies;
            const host = new URL(base).hostname;
            if (cookies.some((c) => c.domain.replace(/^\./u, "") !== host))
                throw new Error("COOKIE_ORIGIN_NOT_ALLOWED");
            await browser.addCookies(cookies);
        }
        return {
            identityId: authenticated.identityId,
            dispose: async () => {
                headers.delete(browser);
                if (context.page.isClosed()) return;
                if (route) await browser.unroute("**/*", route);
                else await browser.clearCookies({ domain: new URL(base).hostname });
            },
        };
    } finally {
        await authenticated.dispose();
    }
}
