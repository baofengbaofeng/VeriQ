import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveOperation } from "../src/main/policy.ts";
import catalog from "../src/shared/operations.generated.json" with { type: "json" };

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const targetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const turnId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * 原生表单只使用已挂载页面实际调用的管理接口，校验相关命名操作与附近的非表单操作以防白名单被意外扩大。
 */
test("native forms expose their named member, invitation, plan and CI operations", () => {
    for (const name of [
        "listMembers",
        "updateMember",
        "removeMember",
        "listInvitations",
        "inviteMember",
        "revokeInvitation",
        "archiveWorkspace",
        "listExecutionPlans",
        "listServiceAccounts",
        "createServiceAccount",
        "disableServiceAccount",
        "listServiceTokens",
        "issueServiceToken",
        "revokeServiceToken",
    ])
        assert.ok(Object.hasOwn(catalog, name), name);
    for (const operation of [
        "createWorkspace",
        "renameWorkspace",
        "acknowledgeNotificationAgentReply",
        "subscribeNotificationInbox",
    ])
        assert.throws(() => resolveOperation({ operation }, workspaceId), /IPC_OPERATION_DENIED/);
    const plan = {
        operation: "createExecutionPlan",
        params: { workspaceId },
        data: {
            name: "Native plan",
            suiteVersionId: targetId,
            environmentVersionId: targetId,
            browsers: ["chromium"],
            runtimeIds: [targetId],
            overlapPolicy: "QUEUE",
            maxCaseRetries: 0,
            roleKeys: ["reader"],
            variables: {},
        },
    };
    assert.deepEqual(resolveOperation(plan, workspaceId), {
        method: "POST",
        path: `/api/v1/workspaces/${workspaceId}/execution-plans`,
        kind: "json",
        data: plan.data,
    });
    assert.throws(() => resolveOperation({ operation: "createExecutionPlan" }, workspaceId), /IPC_PAYLOAD_INVALID/);
    assert.throws(() => resolveOperation(plan, targetId), /WORKSPACE_SCOPE_MISMATCH/);
});

/**
 * 逐个检查桌面已有操作与共享契约的回执参数，避免新加业务写入误携带回执或漏掉本应支持的回执入口。
 */
test("every Desktop receipt flag matches the canonical AgentFormOrigin operation parameter", () => {
    const spec = JSON.parse(
        readFileSync(new URL("../../../packages/contracts/openapi/platform.yaml", import.meta.url), "utf8"),
    );
    type SpecOperation = { operationId: string; parameters?: { $ref?: string }[] };
    const specOperations = Object.values(spec.paths as Record<string, Record<string, SpecOperation>>).flatMap(
        Object.values,
    );
    const marked = new Set(
        specOperations
            .filter((op) =>
                op.parameters?.some((parameter) => parameter.$ref === "#/components/parameters/AgentFormOrigin"),
            )
            .map((op) => op.operationId),
    );
    for (const [name, entry] of Object.entries(catalog)) {
        assert.equal("agentForm" in entry && entry.agentForm === true, marked.has(name), name);
    }
});

test("Desktop plan-token writes require a form turn and cannot issue other token purposes", () => {
    const issue = {
        operation: "issueServiceToken",
        params: { workspaceId, serviceAccountId: targetId },
        data: { purpose: "EXECUTION", operations: ["trigger"], planIds: [targetId] },
    };
    const revoke = {
        operation: "revokeServiceToken",
        params: { workspaceId, serviceAccountId: targetId, tokenId: targetId },
        data: {},
    };
    for (const input of [issue, revoke]) {
        assert.throws(() => resolveOperation(input, workspaceId), /IPC_PAYLOAD_INVALID/);
        assert.equal(resolveOperation({ ...input, agentFormTurnId: turnId }, workspaceId).agentFormTurnId, turnId);
    }
    assert.throws(
        () =>
            resolveOperation(
                { ...issue, agentFormTurnId: turnId, data: { purpose: "RUNTIME_ENROLLMENT" } },
                workspaceId,
            ),
        /IPC_PAYLOAD_INVALID/,
    );
});

/**
 * 设备授权除了路径以外还会在正文选择目标空间，两种入口都必须在网络请求之前与窗口当前工作区进行核对。
 */
test("enrollment approval and runtime grants bind the validated request body to the active workspace", () => {
    const commands = [
        {
            operation: "approveEnrollment",
            params: { enrollmentId: targetId },
            data: { workspaceId, private: true, sharedWithUserIds: [], userCode: "ABCDEFGHIJKL" },
        },
        {
            operation: "updateRuntimeGrants",
            params: { workspaceId, runtimeId: targetId },
            data: { workspaceId, userIds: [], sharedWithWorkspace: true },
        },
    ];
    for (const command of commands) {
        assert.throws(
            () => resolveOperation({ ...command, data: { ...command.data, workspaceId: targetId } }, workspaceId),
            /WORKSPACE_SCOPE_MISMATCH/,
        );
        assert.throws(() => resolveOperation(command, undefined), /WORKSPACE_SCOPE_MISMATCH/);
        assert.equal(resolveOperation({ ...command, agentFormTurnId: turnId }, workspaceId).agentFormTurnId, turnId);
    }
});

/**
 * 收件箱以当前登录用户读取通知，只有针对具体通知的操作可以关联表单，批量标记及查询不应接受回执引用。
 */
test("personal inbox uses fixed actor-scoped operations and only single-item receipt writes", () => {
    const params = { notificationId: targetId };
    for (const [operation, suffix] of [
        ["markNotificationRead", "read"],
        ["acceptNotificationInvitation", "accept"],
    ]) {
        const request = resolveOperation({ operation, params, data: {}, agentFormTurnId: turnId }, workspaceId);
        assert.equal(request.path, `/api/v1/notifications/${targetId}/${suffix}`);
        assert.equal(request.agentFormTurnId, turnId);
        assert.equal(request.method, "POST");
    }
    const reads = [
        { operation: "listNotifications", query: { unread: true, limit: 10 } },
        { operation: "getNotification", params },
        { operation: "markAllNotificationsRead", data: { through: new Date(0).toISOString() } },
    ];
    for (const read of reads) {
        assert.match(resolveOperation(read, workspaceId).path, /^\/api\/v1\/notifications/);
        assert.throws(() => resolveOperation({ ...read, agentFormTurnId: turnId }, workspaceId), /IPC_PAYLOAD_INVALID/);
        assert.throws(
            () => resolveOperation({ ...read, params: { ...read.params, workspaceId } }, workspaceId),
            /IPC_PAYLOAD_INVALID/,
        );
    }
});
