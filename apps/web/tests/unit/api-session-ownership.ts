/**
 * 传输单元用例通过受控 fetch 观察请求取消、全局事件和 CSRF 头归属，不构造报告、作业或领域回执；它们无法证明浏览器何时
 * 应用真实 Set-Cookie，该部分单独交给 V01 的真实会话验收。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    api,
    ApiError,
    binaryRequest,
    request,
    streamRequest,
    streamAuthorizationError,
} from "../../src/api.js";

function envelope(data: unknown, status = 200): Response {
    return Response.json(status === 200 ? { data } : data, { status });
}
function deferred() {
    let deliver!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
        deliver = resolve;
    });
    return { response, deliver };
}
const credentials = { email: "owner@example.com", password: "test-password-only" };
const expired = {
    code: "AUTHENTICATION_REQUIRED",
    message: "Please sign in",
    requestId: "owner-test",
};

test("transport side effects belong to the current session and request lifetime", async (context) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { value: events, configurable: true });
    let expiries = 0;
    events.addEventListener("veriq:session-expired", () => {
        expiries += 1;
    });
    try {
        // 旧 JSON、SSE、下载及安装探测响应都在新登录前发起，登录之后原样返回；请求本身保留真实错误语义，但全局过期事件
        // 和 CSRF 令牌只能由当前身份拥有。
        await context.test(
            "stale responses cannot expire a newer login or replace its token",
            async (t) => {
                const oldJson = deferred(),
                    oldStream = deferred(),
                    oldBinary = deferred(),
                    oldSetup = deferred();
                let sentToken: string | null = null;
                t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
                    if (url.endsWith("/old-json")) return oldJson.response;
                    if (url.endsWith("/old-stream")) return oldStream.response;
                    if (url.endsWith("/old-binary")) return oldBinary.response;
                    if (url.endsWith("/setup")) return oldSetup.response;
                    if (url.endsWith("/auth/login"))
                        return envelope({ csrfToken: "current-token" });
                    sentToken = new Headers(init?.headers).get("X-CSRF-Token");
                    return envelope({});
                });
                const json = request("/old-json").catch((error: unknown) => error);
                const stream = streamRequest("/old-stream", {}, new AbortController().signal).catch(
                    (error: unknown) => error,
                );
                const binary = binaryRequest("/old-binary");
                const setup = api.setup();
                await api.login(credentials);
                oldJson.deliver(envelope(expired, 401));
                oldStream.deliver(envelope(expired, 401));
                oldBinary.deliver(envelope(expired, 401));
                oldSetup.deliver(envelope({ initialized: true, csrfToken: "old-token" }));
                assert.ok((await json) instanceof ApiError);
                assert.ok((await stream) instanceof ApiError);
                assert.equal((await binary).status, 401);
                await setup;
                await request("/write", "POST", {});
                assert.equal(sentToken, "current-token");
                assert.equal(expiries, 0);
            },
        );
        await context.test(
            "credential errors stay local and current authentication expiry remains active",
            async (t) => {
                let code = "INVALID_CREDENTIALS";
                t.mock.method(globalThis, "fetch", async () => envelope({ ...expired, code }, 401));
                for (const path of [
                    "/auth/login",
                    "/runtime-enrollments/inspect",
                    "/service-account-check",
                ]) {
                    await assert.rejects(request(path, "POST", {}), ApiError);
                }
                assert.equal(expiries, 0);
                code = "AUTHENTICATION_REQUIRED";
                await assert.rejects(api.session(), ApiError);
                assert.equal(expiries, 1);
                await assert.rejects(
                    streamRequest("/current-stream", {}, new AbortController().signal),
                    ApiError,
                );
                assert.equal(expiries, 2);
                assert.equal((await binaryRequest("/current-binary")).status, 401);
                assert.equal(expiries, 3);
            },
        );
        await context.test(
            "SSE expiry is a domain end and authentication frames retain request ownership",
            async (t) => {
                t.mock.method(globalThis, "fetch", async (url: string) =>
                    url.endsWith("/auth/login")
                        ? envelope({ csrfToken: "stream-owner-token" })
                        : new Response("", { status: 200 }),
                );
                const before = expiries;
                const response = await streamRequest(
                    "/events/stream",
                    {},
                    new AbortController().signal,
                );
                const expiredReport = streamAuthorizationError(response, {
                    code: "REPORT_EXPIRED",
                });
                assert.equal(expiredReport.code, "REPORT_EXPIRED");
                assert.equal(expiredReport.status, 410);
                assert.equal(expiries, before);
                const forbidden = streamAuthorizationError(response, {
                    code: "WORKSPACE_ACCESS_DENIED",
                });
                assert.equal(forbidden.status, 403);
                assert.equal(expiries, before);
                await api.login(credentials);
                assert.equal(streamAuthorizationError(response, expired).status, 401);
                assert.equal(expiries, before);
                const current = await streamRequest(
                    "/events/stream",
                    {},
                    new AbortController().signal,
                );
                assert.equal(streamAuthorizationError(current, expired).status, 401);
                assert.equal(expiries, before + 1);
            },
        );
        // 新认证请求发出前必须已经取消仍在等待的旧退出，旧响应即使被测试交付也只能作为 AbortError 结束；这验证控制器顺
        // 序，不能等同于浏览器网络层已经排除了 Cookie 头。
        await context.test(
            "new login cancels a pending logout before sending its request",
            async (t) => {
                const pending = deferred();
                let logoutSignal: AbortSignal | undefined;
                t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
                    if (url.endsWith("/auth/logout")) {
                        logoutSignal = init?.signal ?? undefined;
                        return pending.response;
                    }
                    assert.equal(logoutSignal?.aborted, true);
                    return envelope({ csrfToken: "next-token" });
                });
                const logout = api.logout().catch((error: unknown) => error);
                await api.login(credentials);
                pending.deliver(envelope({}));
                const outcome = await logout;
                assert.ok(outcome instanceof DOMException);
                assert.equal(outcome.name, "AbortError");
            },
        );
    } finally {
        if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
        else Reflect.deleteProperty(globalThis, "window");
    }
});
