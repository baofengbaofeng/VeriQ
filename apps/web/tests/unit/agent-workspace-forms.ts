/**
 * 固定表单映射由两个宿主复用；回读旧卡、撤销人员权限或中途切换会话均不得继续进入业务页面。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    authorizedFormDestination,
    formDestination,
    type WorkspaceFormCard,
} from "../../src/features/agent/workspace-forms";

const workspaceId = "9d7b8c6e-6f54-4e32-b123-5ba9e71aa743";
const card: WorkspaceFormCard = { type: "OPEN_WORKSPACE_FORM", capability: "AUTH_CREDENTIALS", workspaceId };

test("authenticated destinations are fixed, scoped, and limited to implemented platform forms", () => {
    const web = formDestination(card, "web");
    assert.equal(web?.platform, "web");
    assert.equal(
        web?.platform === "web" && web.href,
        `/workspaces?tab=auth-credentials&workspaceId=${workspaceId}&fromAgentForm=1`,
    );
    for (const capability of [
        "AUTH_CREDENTIALS",
        "DEVICE_ACCESS",
        "DEVICE_CREDENTIAL_DELIVERY",
        "CI_PLAN_TOKENS",
        "WORKSPACE_MEMBERS",
        "AI_PROVIDERS",
        "NOTIFICATION_INBOX",
        "WORKSPACE_ARCHIVE",
    ] as const) {
        const management = { ...card, capability };
        const route = formDestination(management, "web");
        assert.ok(route?.platform === "web");
        assert.deepEqual(formDestination(management, "desktop"), {
            platform: "desktop",
            workspaceId,
            tab: "management",
            href: route.href,
        });
    }
    assert.deepEqual(formDestination({ ...card, capability: "FIXTURE" }, "desktop"), {
        platform: "desktop",
        workspaceId,
        tab: "resources",
        resourceKind: "FIXTURE",
    });
    assert.equal(formDestination({ ...card, capability: "LOCAL_RETENTION" }, "web"), undefined);
});

test("a swapped card, failed authorization or changed scope cannot open an existing workspace form", async () => {
    const scope = new AbortController();
    const check = (read: () => Promise<WorkspaceFormCard>) =>
        authorizedFormDestination(card, workspaceId, "desktop", scope.signal, read);
    await assert.rejects(check(async () => ({ ...card, workspaceId: "other" })));
    await assert.rejects(check(async () => ({ ...card, capability: "DEVICE_ACCESS" })));
    await assert.rejects(
        check(async () => {
            throw new Error("WORKSPACE_FORBIDDEN");
        }),
    );
    assert.equal((await check(async () => card))?.platform, "desktop");
    assert.equal(
        await check(async () => {
            scope.abort();
            return card;
        }),
        undefined,
    );
    assert.equal(
        await check(async () => {
            assert.fail("A closed scope must not send another request");
        }),
        undefined,
    );
});
