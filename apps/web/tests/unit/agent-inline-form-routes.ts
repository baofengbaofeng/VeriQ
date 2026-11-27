/**
 * 内嵌工作区的导航范围绑定到员工看到的卡片，检查所有产品入口、数据集列表与详情切换以及外部地址和跨空间拒绝路径。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formDestination, type WorkspaceCapability } from "../../src/features/agent/workspace-forms";
import { inlineFormPath } from "../../src/features/agent/inline-form-routes";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const dataset = "22222222-2222-4222-8222-222222222222";
const cases: WorkspaceCapability[] = [
    "ENVIRONMENT",
    "FIXTURE",
    "HTTP_DATASET",
    "AUTH_CREDENTIALS",
    "DEVICE_ACCESS",
    "DEVICE_CREDENTIAL_DELIVERY",
    "CI_PLAN_TOKENS",
    "WORKSPACE_MEMBERS",
    "AI_PROVIDERS",
    "NOTIFICATION_INBOX",
    "WORKSPACE_ARCHIVE",
    "REPORT_EVIDENCE",
    "WORKSPACE_AUDIT",
];

test("every Web card admits its fixed route and settings tab", () => {
    for (const capability of cases) {
        const destination = formDestination({ type: "OPEN_WORKSPACE_FORM", workspaceId, capability }, "web");
        assert.ok(destination?.platform === "web");
        assert.equal(inlineFormPath({ workspaceId, capability }, destination.href), destination.href);
    }
});

test("dataset drilldown and return retain the pinned workspace", () => {
    for (const path of ["/resources/datasets", `/resources/datasets/${dataset}`]) {
        assert.equal(
            inlineFormPath({ workspaceId, capability: "HTTP_DATASET" }, path),
            `${path}?workspaceId=${workspaceId}&fromAgentForm=1`,
        );
    }
});

test("foreign workspaces, origins, capabilities, settings tabs and invalid IDs cannot replace the panel", () => {
    for (const path of [
        `/resources/datasets?workspaceId=${dataset}`,
        "//example.org/resources/datasets",
        "https://example.org/resources/datasets",
        "/resources/datasets/not-an-id",
        "/runtimes",
        `/resources/datasets?workspaceId=${workspaceId}&workspaceId=${dataset}`,
        "/resources/datasets?surprise=1",
    ]) {
        assert.equal(inlineFormPath({ workspaceId, capability: "HTTP_DATASET" }, path), undefined);
    }
    assert.equal(inlineFormPath({ workspaceId, capability: "AI_PROVIDERS" }, "/workspaces?tab=members"), undefined);
    assert.equal(inlineFormPath({ workspaceId, capability: "LOCAL_RETENTION" }, "/reports"), undefined);
});

test("notification detail and its own workspace report stay inside the private router", () => {
    const scope = { workspaceId, capability: "NOTIFICATION_INBOX" } as const;
    const details = `/notifications?notificationId=${dataset}`;
    const report = `/reports?workspaceId=${workspaceId}&runId=${dataset}`;
    assert.equal(inlineFormPath(scope, details), details);
    assert.equal(inlineFormPath(scope, report), report);
    for (const path of [
        `/reports?workspaceId=${dataset}&runId=${dataset}`,
        `/reports?runId=${dataset}`,
        "/reports",
        "/agent",
    ]) {
        assert.equal(inlineFormPath(scope, path), undefined);
    }
});
