/**
 * 浏览器通过真实员工会话访问当前工作区，模型响应只在批准的本地协议边界产生，计划、回执和报告均由真实服务持久化。
 */
import { workspacePicker } from "./support/console-controls";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { test, expect, type Page } from "@playwright/test";
import type { PlatformComponents } from "@veriq/contracts";
import { editorScope } from "./editor-fixture";

type S = PlatformComponents["schemas"];
let model: Server;
let output: unknown;
let modelCalls = 0;
let hold: { entered: () => void; released: Promise<void> } | undefined;

test.beforeAll(async ({ request }) => {
    const state = (await (await request.get("/api/v1/setup")).json()).data;
    if (!state.initialized) {
        const response = await request.post("/api/v1/setup", {
            headers: { Origin: "http://127.0.0.1:5173", "X-CSRF-Token": state.csrfToken },
            data: {
                installationSecret: "browser-operator-secret",
                email: "browser-admin@example.com",
                displayName: "Browser administrator",
                password: "Browser password 123!",
            },
        });
        expect(response.status()).toBe(201);
    }
    model = createServer(async (request, response) => {
        for await (const _chunk of request) {
            // 清空协议请求体后才发布模型响应，让测试可以确定调用已经到达实际服务端网关，未截断输入。
        }
        modelCalls++;
        if (hold) {
            hold.entered();
            await hold.released;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(
            JSON.stringify({
                id: "conversation-emulator",
                object: "chat.completion",
                created: 0,
                model: "emulator",
                choices: [
                    {
                        index: 0,
                        finish_reason: "stop",
                        message: { role: "assistant", content: JSON.stringify(output) },
                    },
                ],
                usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
            }),
        );
    });
    await new Promise<void>((resolve) => model.listen(18890, "127.0.0.1", resolve));
});
test.afterAll(async () => {
    await new Promise<void>((resolve, reject) => model.close((error) => (error ? reject(error) : resolve())));
});

/**
 * 通过现有设置页候选来源创建有效模型，测试密钥仅用于本机协议模拟器，服务端仍执行真实出口与预算限制。
 */
async function provider(page: Page, workspaceId: string, headers: Record<string, string>) {
    const result = await page.request.post(`/api/v1/workspaces/${workspaceId}/ai/providers`, {
        headers,
        data: {
            name: "Conversation emulator",
            adapter: "OPENAI_COMPATIBLE",
            baseURL: "http://127.0.0.1:18890/v1",
            model: "emulator",
            apiKey: "synthetic-conversation-provider-key",
            enabled: true,
            monthlyBudgetUsd: 1,
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 2,
            maxOutputTokens: 1024,
            maxRequestUsd: 0.5,
        },
    });
    expect(result.status(), await result.text()).toBe(201);
    return ((await result.json()).data as S["ProviderDTO"]).id;
}

/**
 * 第一条路径经过用户可见设置、提议、真实计划保存和运行报告，回到归档历史时可再次读取已确认内容。
 */
test("inherits a model and persists plan and Run receipts through authorized UI", async ({ page }) => {
    test.setTimeout(180_000);
    const scope = await editorScope(page, "conversation-run");
    await page.getByRole("link", { name: "Test Agent", exact: true }).click();
    await workspacePicker(page).selectOption(scope.workspaceId);
    const base = `/api/v1/workspaces/${scope.workspaceId}`;
    const providerId = await provider(page, scope.workspaceId, scope.headers);
    await page.getByRole("button", { name: "Model settings", exact: true }).click();
    await page.getByLabel("Workspace default provider").selectOption(providerId);
    await page.getByLabel("Conversation provider").selectOption("");
    const saving = page.waitForResponse(
        (response) => response.url().endsWith("/agent/settings") && response.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "Save model settings" }).click();
    const savedSettings = await saving;
    expect(savedSettings.request().postDataJSON()).toEqual({ defaultProviderId: providerId, agentProviderId: null });
    expect(savedSettings.status(), await savedSettings.text()).toBe(200);
    await expect(page.getByText("Inherits workspace default")).toBeVisible();
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Model settings", exact: true }).click();

    // 复用服务器业务测试的已发布资源准备，浏览器仍通过真实接口创建计划、派单和读取报告。
    const fixture = await promisify(execFile)(
        "uv",
        [
            "run",
            "--project",
            "apps/srv",
            "--frozen",
            "--no-sync",
            "python",
            "apps/srv/tests/auth/browser_agent_fixture.py",
            scope.workspaceId,
        ],
        {
            cwd: fileURLToPath(new URL("../../../", import.meta.url)),
            env: { ...process.env, UV_CACHE_DIR: "/tmp/veriq-t02-uv" },
        },
    );
    const { environmentVersionId, suiteVersionId, runtimeId } = JSON.parse(fixture.stdout) as {
        environmentVersionId: string;
        suiteVersionId: string;
        runtimeId: string;
    };
    const plan = {
        name: "Conversation smoke",
        suiteVersionId,
        environmentVersionId,
        browsers: ["chromium"],
        runtimeIds: [runtimeId],
        roleKeys: ["reader"],
        overlapPolicy: "QUEUE",
        maxCaseRetries: 0,
    };
    await page.getByLabel("Conversation title").fill("Smoke history");
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    output = { reply: "Payment is outside this smoke plan.", proposal: { type: "SAVE_PLAN", plan } };
    await page.getByLabel("Message").fill("Plan the reader smoke coverage");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Payment is outside this smoke plan.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Plan preview" })).toContainText("Conversation smoke");
    expect((await (await page.request.get(`${base}/execution-plans`)).json()).data.items).toHaveLength(0);
    await page.getByRole("button", { name: "Confirm save plan" }).click();
    await expect(page.getByText("Plan saved", { exact: true })).toBeVisible();
    const [saved] = (await (await page.request.get(`${base}/execution-plans`)).json()).data.items;
    expect(saved.name).toBe(plan.name);
    output = {
        reply: "Change the plan name and keep its selections.",
        proposal: {
            type: "SAVE_PLAN",
            planId: saved.id,
            plan: { revision: saved.revision, name: "Revised smoke" },
        },
    };
    await page.getByLabel("Message").fill("Rename the saved plan");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("region", { name: "Plan preview" }).last()).toContainText("Revised smoke");
    await expect(page.getByRole("region", { name: "Plan preview" }).last()).toContainText("Conversation smoke");
    output = {
        reply: "Run the smoke plan once.",
        proposal: { type: "TRIGGER_PLAN", planId: saved.id, planRevision: saved.revision },
    };
    await page.getByLabel("Message").fill("Execute the saved reader smoke plan now");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirm run saved plan" })).toBeVisible();
    const lastIntent = "**/agent/sessions/*/turns";
    let lost: S["AgentTurnSubmit"] | undefined;
    // 第一次确认已经到达真实服务，浏览器却没有收到回执。另一个客户端随后在同一会话提出不同运行。
    await page.route(lastIntent, async (route) => {
        const request = route.request();
        if (request.method() !== "POST" || lost || request.postDataJSON().text !== "confirm run")
            return route.continue();
        lost = request.postDataJSON();
        const response = await route.fetch();
        expect(response.status(), await response.text()).toBe(200);
        expect((await response.json()).data.receipt.decision).toBe("ENQUEUED");
        await route.abort();
    });
    await page.getByLabel("Message").fill("confirm run");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Unable to load conversation data. Retry the request.");
    const sessionList = await page.request.get(`${base}/agent/sessions`);
    const sessionId = (await sessionList.json()).data.items[0].id;
    output = {
        reply: "A second client proposes another run.",
        proposal: { type: "TRIGGER_PLAN", planId: saved.id, planRevision: saved.revision },
    };
    const newer = await page.request.post(`${base}/agent/sessions/${sessionId}/turns`, {
        headers: scope.headers,
        data: { requestId: crypto.randomUUID(), text: "Queue a second run from the other client" },
    });
    expect(newer.status(), await newer.text()).toBe(200);
    const replacement = (await newer.json()).data.id;
    expect(replacement).not.toBe(lost?.expectedProposalId);
    const previousCalls = modelCalls;
    const settings = await page.request.put(`${base}/agent/settings`, {
        headers: scope.headers,
        data: { defaultProviderId: null, agentProviderId: null },
    });
    expect(settings.status()).toBe(200);
    await page.reload();
    await workspacePicker(page).selectOption(scope.workspaceId);
    const stream = page.waitForRequest((request) => request.url().endsWith("/events/stream"));
    await page.getByRole("button", { name: "Smoke history", exact: true }).click();
    await expect(page.getByText("A second client proposes another run.")).toBeVisible();
    const replay = page.waitForResponse(
        (response) => response.url().endsWith("/turns") && response.request().method() === "POST",
    );
    await page.getByLabel("Message").fill("confirm run");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const repeated = await replay;
    expect(repeated.status(), await repeated.text()).toBe(200);
    expect(repeated.request().postDataJSON()).toEqual(lost);
    expect((await (await page.request.get(`${base}/runs`)).json()).data.items).toHaveLength(1);
    await expect(page.getByRole("button", { name: "Confirm run saved plan" })).toBeVisible();
    const run = page.getByRole("region", { name: "Run status" });
    await expect(run).toContainText("ENQUEUED");
    await expect(run).toContainText("QUEUED");
    expect(modelCalls).toBe(previousCalls);
    const report = run.getByRole("link", { name: "Open full report" });
    await expect(report).toBeVisible();
    const link = await report.getAttribute("href");
    const reportHref = new URL(link!, "http://127.0.0.1:5173");
    const runId = reportHref.searchParams.get("runId");
    expect(reportHref.searchParams.get("workspaceId")).toBe(scope.workspaceId);
    const authorized = await page.request.get(`${base}/runs/${runId}/report`);
    expect(authorized.status(), await authorized.text()).toBe(200);
    expect((await authorized.json()).data.run.id).toBe(runId);
    expect((await stream).url()).toContain(`${base}/runs/${runId}`);
    const cancelled = await page.request.post(`${base}/runs/${runId}/cancel`, {
        headers: scope.headers,
        data: { reason: "Cancel the queued conversation test Run" },
    });
    expect(cancelled.status(), await cancelled.text()).toBe(200);
    await expect(run).toContainText("FINISHED");
    await expect(run).toContainText("CANCELLED");

    await page.reload();
    await workspacePicker(page).selectOption(scope.workspaceId);
    await page.getByRole("button", { name: "Smoke history", exact: true }).click();
    await expect(page.getByText("Payment is outside this smoke plan.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Run status" })).toContainText("CANCELLED");
    await page.getByRole("button", { name: "Archive conversation" }).click();
    await page.getByRole("button", { name: "Archived", exact: true }).click();
    await page.getByRole("button", { name: "Smoke history", exact: true }).click();
    await expect(page.getByRole("link", { name: "Open full report" })).toBeVisible();
    await expect(page.getByLabel("Message")).toHaveCount(0);
    await page.getByRole("link", { name: "Open full report" }).click();
    await expect(page.getByRole("region", { name: "Run report" })).toContainText("CANCELLED");

    await page.goto(`/execution-plans?workspaceId=${scope.workspaceId}&planId=${saved.id}`);
    const entry = page.getByRole("region", { name: plan.name }).getByRole("link", { name: "Discuss with Test Agent" });
    await expect(entry).toHaveAttribute("href", `/agent?workspaceId=${scope.workspaceId}&planId=${saved.id}`);
    await entry.click();
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await expect(page.getByLabel("Message")).toHaveValue(new RegExp(saved.id));
    expect(modelCalls).toBe(previousCalls);
});

/**
 * 更换工作区时请求可以在旧端完成，只有当前工作区的私有会话能够出现在新视图，旧轮次仍可通过授权历史恢复。
 */
test("a delayed model reply cannot repopulate another Workspace", async ({ page }) => {
    const first = await editorScope(page, "conversation-first");
    const second = await page.request.post("/api/v1/workspaces", {
        headers: first.headers,
        data: { key: "conversation-second", name: "Second conversation Workspace" },
    });
    expect(second.status()).toBe(201);
    const secondId = (await second.json()).data.id;
    const id = await provider(page, first.workspaceId, first.headers);
    const base = `/api/v1/workspaces/${first.workspaceId}/agent`;
    expect(
        (
            await page.request.put(`${base}/settings`, {
                headers: first.headers,
                data: { defaultProviderId: id, agentProviderId: null },
            })
        ).status(),
    ).toBe(200);
    await page.goto(`/agent?workspaceId=${first.workspaceId}`);
    await expect(workspacePicker(page)).toHaveValue(first.workspaceId);
    await page.getByLabel("Conversation title").fill("Private conversation");
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    output = { reply: "Private delayed reply." };
    hold = { entered: entered.resolve, released: released.promise };
    try {
        await page.getByLabel("Message").fill("Assess this Workspace");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await entered.promise;
        await workspacePicker(page).selectOption(secondId);
        released.resolve();
        const sessions = (await (await page.request.get(`${base}/sessions`)).json()).data.items;
        const history = `${base}/sessions/${sessions[0].id}/turns`;
        await expect
            .poll(async () => (await (await page.request.get(history)).json()).data.items[0]?.reply)
            .toBe("Private delayed reply.");
        await expect(page.getByRole("button", { name: "Private conversation" })).toHaveCount(0);
        await expect(page.getByText("Private delayed reply.")).toHaveCount(0);
        await workspacePicker(page).selectOption(first.workspaceId);
        await page.getByRole("button", { name: "Private conversation" }).click();
        await expect(page.getByText("Private delayed reply.")).toBeVisible();
    } finally {
        released.resolve();
        hold = undefined;
    }
});

/**
 * 桌面采用的 React 严格模式可重放挂载效果。第一次服务器响应即使已持久化却丢失，重载仍须续用原来的发送身份。
 */
test("StrictMode preserves conversation requests and reload retries reuse the same intent", async ({ page }) => {
    const scope = await editorScope(page, "conversation-strict");
    const id = await provider(page, scope.workspaceId, scope.headers);
    const base = `/api/v1/workspaces/${scope.workspaceId}/agent`;
    const settings = await page.request.put(`${base}/settings`, {
        headers: scope.headers,
        data: { defaultProviderId: id, agentProviderId: null },
    });
    expect(settings.status()).toBe(200);
    await page.goto(`/tests/agent-strict-fixture.html?workspaceId=${scope.workspaceId}`);
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    await page.getByLabel("Conversation title").fill("Replay safe");
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Replay safe" })).toBeVisible();

    output = { reply: "The strict workspace replied once." };
    const callsBefore = modelCalls;
    const text = "Assess this reload-safe Workspace";
    const boundary = "**/agent/sessions/*/turns";
    let originalId = "";
    // 第一次 POST 已送达真实服务，浏览器只丢失响应；随后交给默认网络，避免用拦截器伪造业务重放。
    await page.route(boundary, async (route) => {
        if (route.request().method() !== "POST" || originalId) return route.continue();
        originalId = route.request().postDataJSON().requestId;
        const response = await route.fetch();
        expect(response.status(), await response.text()).toBe(200);
        await route.abort();
    });
    await page.getByLabel("Message").fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Unable to load conversation data. Retry the request.");
    const stored = await page.evaluate(() =>
        Object.entries(sessionStorage).filter(([key]) => key.startsWith("veriq.agent.retry/")),
    );
    expect(stored.map(([, value]) => value)).toEqual([
        expect.stringMatching(new RegExp(`^[a-f0-9]{64}/${originalId}/$`)),
    ]);
    expect(JSON.stringify(stored)).not.toContain(text);
    await page.reload();
    await page.getByRole("button", { name: "Replay safe", exact: true }).click();
    await expect(page.getByText("The strict workspace replied once.")).toBeVisible();
    const replay = page.waitForResponse(
        (response) => response.url().endsWith("/turns") && response.request().method() === "POST",
    );
    await page.getByLabel("Message").fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const repeated = await replay;
    expect(repeated.status(), await repeated.text()).toBe(200);
    expect(repeated.request().postDataJSON().requestId).toBe(originalId);
    await expect(page.getByText(text, { exact: true })).toHaveCount(1);
    expect(modelCalls).toBe(callsBefore + 1);
    await expect(page.getByLabel("Message")).toHaveValue("");
    const next = page.waitForResponse(
        (response) => response.url().endsWith("/turns") && response.request().method() === "POST",
    );
    await page.getByLabel("Message").fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const fresh = await next;
    expect(fresh.status(), await fresh.text()).toBe(200);
    expect(fresh.request().postDataJSON().requestId).not.toBe(originalId);
    await expect(page.getByText(text, { exact: true })).toHaveCount(2);
    expect(modelCalls).toBe(callsBefore + 2);
});
