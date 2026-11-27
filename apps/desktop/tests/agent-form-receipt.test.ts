/**
 * 使用真实宿主请求解析与会话发送验证资源草稿更新的表单来源标记，普通读取和未关联的请求不会携带轮次标识。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "electron";
import { HostSession } from "../src/main/session.ts";
import { resolveOperation } from "../src/main/policy.ts";
import httpDataset from "../../../packages/contracts/fixtures/http-dataset.json" with { type: "json" };

const workspaceId = "22222222-2222-4222-8222-222222222222";
const resourceId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const draft = {
    operation: "updateDraft",
    params: { workspaceId, resourceId },
    data: { revision: 1, content: { kind: "DATASET", document: httpDataset } },
} as const;

test("native DATASET draft writes send only the validated turn identifier on their ordinary host request", async () => {
    const sent: { url: string; headers: Headers }[] = [];
    const host = new HostSession(
        {
            fetch: async (url, init) => {
                sent.push({ url: String(url), headers: new Headers(init?.headers) });
                return Response.json({ data: {} });
            },
            clearStorageData: async () => {},
        } as Pick<Session, "fetch" | "clearStorageData">,
        "https://desktop.invalid",
    );
    host.workspace = { id: workspaceId, key: "one", name: "One", role: "EDITOR", archived: false, createdAt: "" };
    await host.cloud({ ...draft, agentFormTurnId: turnId });
    await host.cloud(draft);
    assert.equal(
        sent[0]?.url,
        `https://desktop.invalid/api/v1/workspaces/${workspaceId}/resources/${resourceId}/draft`,
    );
    assert.equal(sent[0]?.headers.get("X-VeriQ-Agent-Form"), turnId);
    assert.equal(sent[1]?.headers.get("X-VeriQ-Agent-Form"), null);
    assert.equal(sent[0]?.headers.get("Origin"), "https://desktop.invalid");
});

test("the Desktop host rejects form receipt references on reads and unrelated commands", () => {
    const read = { operation: "listResources", params: { workspaceId } };
    for (const input of [
        { ...read, agentFormTurnId: turnId },
        { operation: "getWorkspaceAudit", params: { workspaceId }, agentFormTurnId: turnId },
        { ...draft, agentFormTurnId: "arbitrary" },
        { ...draft, agentFormTurnId: `${turnId}\nInjected: value` },
        { ...draft, headers: { "X-VeriQ-Agent-Form": turnId } },
    ])
        assert.throws(() => resolveOperation(input, workspaceId));
    assert.throws(() => resolveOperation({ ...draft, agentFormTurnId: turnId }, resourceId));
});
