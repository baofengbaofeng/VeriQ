import assert from "node:assert/strict";
import test from "node:test";
import { resolveOperation } from "../src/main/policy.ts";

/** 正常登录与资源查询必须映射到宿主拥有的固定路径，本组断言同时证明白名单提供实际业务能力，避免全部拒绝的空实现被当成通过安全验收的实现。 */
test("login maps to its fixed ordinary-session route", () => {
    const result = resolveOperation(
        { operation: "login", data: { email: "test@example.com", password: "Password 123!" } },
        undefined,
    );
    assert.deepEqual(result, {
        path: "/api/v1/auth/login",
        method: "POST",
        data: { email: "test@example.com", password: "Password 123!" },
        kind: "json",
    });
});

test("resource reads bind the selected workspace", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const result = resolveOperation(
        { operation: "listResources", params: { workspaceId }, query: { kind: "CASE" } },
        workspaceId,
    );
    assert.deepEqual(result, {
        path: `/api/v1/workspaces/${workspaceId}/resources?kind=CASE`,
        method: "GET",
        kind: "json",
    });
});

/** 来自渲染进程的同形恶意输入不得突破固定业务操作集合，未知字段和跨工作区请求均必须在网络发送前失败，而不是交给远端错误偶然阻止越权。 */
test("arbitrary transport fields and device-token operations are rejected", () => {
    for (const value of [
        { operation: "fetch", url: "https://evil.example" },
        { operation: "login", data: {}, headers: { Authorization: "Bearer forbidden" } },
        { operation: "pollEnrollment", data: { deviceCode: "secret" } },
        { operation: "session", path: "/internal/v1/runtime" },
    ])
        assert.throws(
            () => resolveOperation(value, undefined),
            /IPC_OPERATION_DENIED|IPC_PAYLOAD_INVALID/,
        );
});

test("foreign workspace is rejected before a resource request", () => {
    assert.throws(
        () =>
            resolveOperation(
                {
                    operation: "listResources",
                    params: { workspaceId: "00000000-0000-4000-8000-000000000002" },
                },
                "00000000-0000-4000-8000-000000000001",
            ),
        /WORKSPACE_SCOPE_MISMATCH/,
    );
});
