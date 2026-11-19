/**
 * 浏览器通过真实员工会话访问当前工作区，模型响应只在批准的本地协议边界产生，计划、回执和报告均由真实服务持久化。
 */
import { chooseWorkspace, workspacePicker } from "./support/console-controls";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { test, expect, type BrowserContext, type Page, type Response as BrowserResponse } from "@playwright/test";
import type { PlatformComponents } from "@veriq/contracts";
import { editorScope, type EditorScope } from "./editor-fixture";

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
 * 复用控制服务的已发布资源和排队设备夹具，通过真实工作区接口验证后续对话写入与报告授权。
 */
async function agentAssets(workspaceId: string) {
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
            workspaceId,
        ],
        {
            cwd: fileURLToPath(new URL("../../../", import.meta.url)),
            env: { ...process.env, UV_CACHE_DIR: "/tmp/veriq-t02-uv" },
        },
    );
    return JSON.parse(fixture.stdout) as {
        environmentVersionId: string;
        suiteVersionId: string;
        runtimeId: string;
    };
}

/**
 * 第一条路径经过用户可见设置、提议、真实计划保存和运行报告，回到归档历史时可再次读取已确认内容。
 */
test("inherits a model and persists plan and Run receipts through authorized UI", async ({ page }) => {
    test.setTimeout(180_000);
    const scope = await editorScope(page, "conversation-run");
    await page.getByRole("link", { name: "Test Agent", exact: true }).click();
    await chooseWorkspace(page, scope.workspaceId);
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

    const { environmentVersionId, suiteVersionId, runtimeId } = await agentAssets(scope.workspaceId);
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
    await chooseWorkspace(page, scope.workspaceId);
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
    await chooseWorkspace(page, scope.workspaceId);
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
    await expect(workspacePicker(page)).toHaveAttribute("data-workspace-id", first.workspaceId);
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
        await chooseWorkspace(page, secondId);
        released.resolve();
        const sessions = (await (await page.request.get(`${base}/sessions`)).json()).data.items;
        const history = `${base}/sessions/${sessions[0].id}/turns`;
        await expect
            .poll(async () => (await (await page.request.get(history)).json()).data.items[0]?.reply)
            .toBe("Private delayed reply.");
        await expect(page.getByRole("button", { name: "Private conversation" })).toHaveCount(0);
        await expect(page.getByText("Private delayed reply.")).toHaveCount(0);
        await chooseWorkspace(page, first.workspaceId);
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

const memberOrigin = "http://127.0.0.1:5173";

/**
 * 两个浏览器上下文分别保有 Owner 和普通员工会话，禁用成员时继续使用同一个员工 Cookie 观察读取拒绝。
 */
async function agentMember(owner: Page, member: BrowserContext, key: string, role: "EDITOR" | "ADMIN" = "EDITOR") {
    const scope = await editorScope(owner, key);
    const workspace = `/api/v1/workspaces/${scope.workspaceId}`;
    const email = `${key}@example.com`;
    const password = "Authorization member 123!";
    const user = await owner.request.post("/api/v1/admin/users", {
        headers: scope.headers,
        data: { email, displayName: "Authorization member", password, systemAdmin: false },
    });
    expect(user.status(), await user.text()).toBe(201);
    const userId: string = (await user.json()).data.id;
    const bootstrap = await member.request.get("/api/v1/setup");
    const login = await member.request.post("/api/v1/auth/login", {
        headers: { Origin: memberOrigin, "X-CSRF-Token": (await bootstrap.json()).data.csrfToken },
        data: { email, password },
    });
    expect(login.status(), await login.text()).toBe(200);
    const headers = { Origin: memberOrigin, "X-CSRF-Token": (await login.json()).data.csrfToken };
    const invite = await owner.request.post(`${workspace}/invitations`, {
        headers: scope.headers,
        data: { email, role },
    });
    expect(invite.status(), await invite.text()).toBe(201);
    const fragment = new URL((await invite.json()).data.invitationUrl).hash;
    const token = new URLSearchParams(fragment.slice(1)).get("token");
    const accepted = await member.request.post("/api/v1/auth/invitations/accept", { headers, data: { token } });
    expect(accepted.status(), await accepted.text()).toBe(200);
    const providerId = await provider(owner, scope.workspaceId, scope.headers);
    const configured = await owner.request.put(`${workspace}/agent/settings`, {
        headers: scope.headers,
        data: { defaultProviderId: providerId, agentProviderId: null },
    });
    expect(configured.status(), await configured.text()).toBe(200);
    async function membership(role: S["MemberWrite"]["role"], status: S["MemberWrite"]["status"]) {
        const response = await owner.request.put(`${workspace}/members/${userId}`, {
            headers: scope.headers,
            data: { role, status } satisfies S["MemberWrite"],
        });
        expect(response.status(), await response.text()).toBe(200);
        expect((await response.json()).data).toMatchObject({ userId, role, status });
    }

    return { scope, workspace, userId, membership };
}

/**
 * 等待所选真实会话写入请求返回，再用用户可见标题验证已进入相应线程，返回服务器分配的私有会话标识。
 */
async function newAgentSession(page: Page, title: string) {
    await page.getByLabel("Conversation title").fill(title);
    const creating = page.waitForResponse(
        (response) => response.url().endsWith("/agent/sessions") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    const created = await creating;
    expect(created.status(), await created.text()).toBe(201);
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    return ((await created.json()).data as S["AgentSessionDTO"]).id;
}

/**
 * 由 Owner 预置已发布计划与设备共享，成员仍使用实际聊天提议确认运行，由控制服务生成真实排队回执。
 */
async function queueableAgentPlan(owner: Page, scope: EditorScope, workspace: string, userId: string) {
    const assets = await agentAssets(scope.workspaceId);
    const grant = await owner.request.put(`${workspace}/runtimes/${assets.runtimeId}/grants`, {
        headers: scope.headers,
        data: { workspaceId: scope.workspaceId, userIds: [userId], sharedWithWorkspace: false },
    });
    expect(grant.status(), await grant.text()).toBe(200);
    const plan = {
        name: "Private Agent plan",
        suiteVersionId: assets.suiteVersionId,
        environmentVersionId: assets.environmentVersionId,
        browsers: ["chromium"],
        runtimeIds: [assets.runtimeId],
        roleKeys: ["reader"],
        overlapPolicy: "QUEUE",
        maxCaseRetries: 0,
    };
    const saved = await owner.request.post(`${workspace}/execution-plans`, {
        headers: scope.headers,
        data: { ...plan, variables: {} },
    });
    expect(saved.status(), await saved.text()).toBe(201);
    const savedPlan = (await saved.json()).data as S["ExecutionPlanDTO"];
    return { plan, savedPlan };
}

/**
 * 屏幕中的报告流与私有提议先通过现有接口建立，再切换真实成员权限检查读取拒绝、迟到结果和显式恢复。
 */
test("R15 StrictMode withdraws cached private Agent content after real member disablement", async ({
    page,
    browser,
}) => {
    test.setTimeout(120_000);
    test.info().annotations.push({ type: "browser", description: browser.version() });
    const member = await browser.newContext({ baseURL: memberOrigin });
    const releaseDetail = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    const releaseHistory = Promise.withResolvers<void>();
    try {
        const { scope, workspace, userId, membership } = await agentMember(page, member, "conversation-auth-r15");
        const { plan, savedPlan } = await queueableAgentPlan(page, scope, workspace, userId);
        const view = await member.newPage();
        const streamAborts: number[] = [];
        const streamStarts: number[] = [];
        await view.exposeFunction("observeAgentReportStream", (id: number, aborted: boolean) => {
            (aborted ? streamAborts : streamStarts).push(id);
        });
        await view.addInitScript(() => {
            const observe = (window as Window & { observeAgentReportStream?: (id: number, aborted: boolean) => void })
                .observeAgentReportStream;
            if (!observe) {
                throw new Error("Missing Agent report stream observer.");
            }
            const fetch = window.fetch.bind(window);
            let stream = 0;
            let pausedStream = 0;
            window.addEventListener("pauseAgentReportRead", () => {
                pausedStream = stream;
            });
            window.fetch = async (input, options) => {
                const signal = options?.signal;
                if (typeof input !== "string" || !input.endsWith("/events/stream") || !signal) {
                    return fetch(input, options);
                }
                const id = ++stream;
                observe(id, false);
                const cancelled = new Promise<void>((resolve) =>
                    signal.addEventListener(
                        "abort",
                        () => {
                            observe(id, true);
                            resolve();
                        },
                        { once: true },
                    ),
                );
                const response = await fetch(input, options);
                if (response.ok && response.body) {
                    const body = response.body.pipeThrough(
                        new TransformStream<Uint8Array, Uint8Array>({
                            async transform(chunk, controller) {
                                if (id === pausedStream) {
                                    await cancelled;
                                } else {
                                    controller.enqueue(chunk);
                                }
                            },
                        }),
                    );
                    Object.defineProperty(response, "body", { value: body });
                }
                return response;
            };
        });
        await view.goto(`/tests/agent-strict-fixture.html?workspaceId=${scope.workspaceId}`);
        await expect(view.getByText("Ready", { exact: true })).toBeVisible();
        const title = "Private revocation conversation";
        const sessionId = await newAgentSession(view, title);
        const detailPath = `${workspace}/agent/sessions/${sessionId}`;
        const historyPath = `${detailPath}/turns`;
        const message = view.getByRole("textbox", { name: "Message", exact: true });
        const send = view.getByRole("button", { name: "Send", exact: true });
        const refresh = view.getByRole("button", { name: "Refresh conversation", exact: true });
        const card = view.getByRole("region", { name: "Run status" });

        output = {
            reply: "The private Agent proposes a queued smoke run.",
            proposal: { type: "TRIGGER_PLAN", planId: savedPlan.id, planRevision: savedPlan.revision },
        };
        await message.fill("Execute the saved plan once");
        await send.click();
        const stream = view.waitForResponse((response) => response.url().endsWith("/events/stream"));
        await view.getByRole("button", { name: "Confirm run saved plan" }).click();
        expect((await stream).status()).toBe(200);
        await expect(card).toContainText("ENQUEUED");
        await expect(card).toContainText("QUEUED");

        const reply = "The private Agent proposes a distinct plan.";
        const proposal = view.getByRole("button", { name: "Confirm save plan" });
        output = { reply, proposal: { type: "SAVE_PLAN", plan: { ...plan, name: "Delayed private plan" } } };
        await message.fill("Prepare a distinct private plan");
        await send.click();
        await expect(view.getByText(reply, { exact: true })).toBeVisible();
        await expect(proposal).toBeVisible();

        // 模拟轮次读取的普通传输错误，仍可读取本会话旧正文，之后显式恢复历史以验证权限判断不依赖该故障。
        const offline = (url: URL) => url.pathname === historyPath;
        await view.route(offline, (route) => route.abort("internetdisconnected"));
        await refresh.click();
        await expect(view.getByRole("alert")).toHaveText("Unable to load conversation data. Retry the request.");
        await expect(view.getByText(reply, { exact: true })).toBeVisible();
        await view.unroute(offline);
        await refresh.click();
        await expect(view.getByRole("alert")).toHaveCount(0);

        await membership("VIEWER", "ACTIVE");
        const afterWriteDetail = view.waitForResponse(
            (response) => response.url().endsWith(detailPath) && response.request().method() === "GET",
        );
        const afterWriteHistory = view.waitForResponse(
            (response) => response.url().endsWith(historyPath) && response.request().method() === "GET",
        );
        const forbiddenWrite = view.waitForResponse(
            (response) => response.url().endsWith(historyPath) && response.request().method() === "POST",
        );
        await message.fill("This member can still read but cannot write");
        await send.click();
        const refused = await forbiddenWrite;
        expect(refused.status(), await refused.text()).toBe(403);
        expect((await refused.json()).code).toBe("WORKSPACE_FORBIDDEN");
        expect((await afterWriteDetail).status()).toBe(200);
        expect((await afterWriteHistory).status()).toBe(200);
        await expect(view.getByRole("alert")).toHaveText("WORKSPACE_FORBIDDEN");
        await expect(view.getByText(reply, { exact: true })).toBeVisible();
        await membership("EDITOR", "ACTIVE");

        // 延迟真实确认回执，确认已经提交至控制服务，客户端仍保留原始摘要、请求编号与被确认轮次。
        const writeReady = Promise.withResolvers<S["AgentTurnSubmit"]>();
        const writeReleased = Promise.withResolvers<void>();
        let submissions = 0;
        let holdHistory = false;
        await view.route(offline, async (route) => {
            const request = route.request();
            if (request.method() === "GET" && holdHistory) {
                await releaseHistory.promise;
            }
            if (request.method() !== "POST" || ++submissions !== 1) {
                await route.continue();
                return;
            }
            const response = await route.fetch();
            expect(response.status(), await response.text()).toBe(200);
            expect((await response.json()).data.receipt.type).toBe("SAVE_PLAN");
            writeReady.resolve(request.postDataJSON());
            await releaseWrite.promise;
            await route.fulfill({ response });
            writeReleased.resolve();
        });
        await message.fill("confirm plan");
        await send.click();
        const original = await writeReady.promise;
        expect(original.expectedProposalId).toBeTruthy();
        const record = () =>
            view.evaluate(() =>
                Object.entries(sessionStorage)
                    .filter(([key]) => key.startsWith("veriq.agent.retry/"))
                    .map(([, value]) => value),
            );
        const stored = await record();
        expect(stored).toEqual([
            expect.stringMatching(new RegExp(`^[a-f0-9]{64}/${original.requestId}/${original.expectedProposalId}$`)),
        ]);

        // 同一次刷新分别控制并行读取，禁用前取得真实详情，禁用后再放行轮次请求，随后交回旧的成功响应。
        const detailReady = Promise.withResolvers<void>();
        const detailReleased = Promise.withResolvers<void>();
        const detailRoute = (url: URL) => url.pathname === detailPath;
        await view.route(detailRoute, async (route) => {
            const response = await route.fetch();
            expect(response.status(), await response.text()).toBe(200);
            expect((await response.json()).data.title).toBe(title);
            detailReady.resolve();
            await releaseDetail.promise;
            await route.fulfill({ response });
            detailReleased.resolve();
        });
        holdHistory = true;
        await refresh.click();
        await detailReady.promise;
        const activeStream = streamStarts.at(-1);
        expect(activeStream).toBeDefined();
        expect(streamAborts).not.toContain(activeStream);
        // 暂停浏览器正在消费的真实报告流，使本轮明确由历史读取交付拒绝，流只能经视图取消信号解除门控。
        await view.evaluate(() => window.dispatchEvent(new Event("pauseAgentReportRead")));
        const denied = view.waitForResponse(
            (response) => response.url().endsWith(historyPath) && response.status() === 403,
        );
        await membership("EDITOR", "DISABLED");
        releaseHistory.resolve();
        const refusal = await denied;
        expect(refusal.request().method()).toBe("GET");
        expect((await refusal.json()).code).toBe("WORKSPACE_FORBIDDEN");
        test.info().annotations.push({ type: "agent-revocation", description: "GET 403 WORKSPACE_FORBIDDEN" });
        await expect(view.getByRole("alert")).toHaveText("WORKSPACE_FORBIDDEN");
        await expect(view.getByRole("button", { name: title, exact: true })).toHaveCount(0);
        await expect(view.getByRole("heading", { name: title, exact: true })).toHaveCount(0);
        await expect(view.getByText(reply, { exact: true })).toHaveCount(0);
        await expect(proposal).toHaveCount(0);
        await expect(message).toHaveCount(0);
        await expect(send).toHaveCount(0);
        await expect(view.getByRole("button", { name: "Archive conversation" })).toHaveCount(0);
        await expect(view.getByRole("button", { name: "New conversation" })).toHaveCount(0);
        await expect(card).toHaveCount(0);
        await expect.poll(() => streamAborts).toContain(activeStream);

        releaseDetail.resolve();
        releaseWrite.resolve();
        await Promise.all([detailReleased.promise, writeReleased.promise]);
        await expect(view.getByRole("button", { name: title, exact: true })).toHaveCount(0);
        await expect(view.getByText(reply, { exact: true })).toHaveCount(0);
        expect(await record()).toEqual(stored);

        await membership("EDITOR", "ACTIVE");
        const listReady = Promise.withResolvers<void>();
        const releaseList = Promise.withResolvers<void>();
        const collection = (url: URL) => url.pathname === `${workspace}/agent/sessions`;
        await view.route(collection, async (route) => {
            const response = await route.fetch();
            expect(response.status(), await response.text()).toBe(200);
            listReady.resolve();
            await releaseList.promise;
            await route.fulfill({ response });
        });
        const newList = view.waitForResponse((response) => collection(new URL(response.url())));
        await view.getByRole("button", { name: "Retry", exact: true }).click();
        try {
            await listReady.promise;
            await expect(view.getByRole("button", { name: title, exact: true })).toHaveCount(0);
            await expect(view.getByText(reply, { exact: true })).toHaveCount(0);
        } finally {
            releaseList.resolve();
        }
        expect((await newList).status()).toBe(200);
        await view.unroute(collection);
        await view.unroute(detailRoute);
        await expect(view.getByRole("button", { name: title, exact: true })).toBeVisible();
        await expect(view.getByText(reply, { exact: true })).toHaveCount(0);
        expect(submissions).toBe(1);
        const newDetailReady = Promise.withResolvers<void>();
        const releaseNewDetail = Promise.withResolvers<void>();
        await view.route(detailRoute, async (route) => {
            const response = await route.fetch();
            expect(response.status(), await response.text()).toBe(200);
            newDetailReady.resolve();
            await releaseNewDetail.promise;
            await route.fulfill({ response });
        });
        const newHistory = view.waitForResponse(
            (response) => response.url().endsWith(historyPath) && response.request().method() === "GET",
        );
        await view.getByRole("button", { name: title, exact: true }).click();
        try {
            await newDetailReady.promise;
            expect((await newHistory).status()).toBe(200);
            await expect(view.getByRole("heading", { name: title, exact: true })).toHaveCount(0);
            await expect(view.getByText(reply, { exact: true })).toHaveCount(0);
        } finally {
            releaseNewDetail.resolve();
        }
        await expect(view.getByText(reply, { exact: true })).toBeVisible();
        await view.unroute(detailRoute);
        expect(submissions).toBe(1);
        expect(await record()).toEqual(stored);

        const replay = view.waitForResponse(
            (response) => response.url().endsWith(historyPath) && response.request().method() === "POST",
        );
        await message.fill("confirm plan");
        await send.click();
        const repeated = await replay;
        expect(repeated.status(), await repeated.text()).toBe(200);
        expect(repeated.request().postDataJSON()).toEqual(original);
        expect((await repeated.json()).data.receipt.type).toBe("SAVE_PLAN");
        await expect.poll(record).toEqual([]);
        const plans = await page.request.get(`${workspace}/execution-plans`);
        expect(
            (await plans.json()).data.items.filter(
                (plan: S["ExecutionPlanDTO"]) => plan.name === "Delayed private plan",
            ),
        ).toHaveLength(1);

        // 报告自身找不到或到期时只收拢卡片，保留对话；报告真实收到工作区拒绝后才撤下整个工作区视图。
        const runs = await page.request.get(`${workspace}/runs`);
        const [run] = (await runs.json()).data.items as S["RunDTO"][];
        const reportPath = `${workspace}/runs/${run.id}/report`;
        const reportRoute = (url: URL) => url.pathname === reportPath;
        const refreshRun = card.getByRole("button", { name: "Refresh run status" });
        // 无代号的流授权帧只说明报告消费中断，不能据此推断当前工作区与私有会话一起失去读取权限。
        const streamRoute = (url: URL) => url.pathname === `${workspace}/runs/${run.id}/events/stream`;
        await view.route(streamRoute, (route) =>
            route.fulfill({ contentType: "text/event-stream", body: "event: authorization\ndata: {}\n\n" }),
        );
        await refreshRun.click();
        await expect(card.getByRole("alert")).toHaveText("REPORT_ACCESS_CHANGED");
        await expect(view.getByText(reply, { exact: true })).toBeVisible();
        await view.unroute(streamRoute);

        const absentRun = new URL(`${workspace}/runs/${crypto.randomUUID()}/report`, memberOrigin).href;
        await view.route(reportRoute, async (route) => {
            const response = await route.fetch({ url: absentRun });
            expect(response.status(), await response.text()).toBe(404);
            expect((await response.json()).code).toBe("RUN_NOT_FOUND");
            await route.fulfill({ response });
        });
        await refreshRun.click();
        await expect(card.getByRole("alert")).toHaveText("RUN_NOT_FOUND");
        await expect(card.getByText("QUEUED", { exact: true })).toHaveCount(0);
        await expect(view.getByText(reply, { exact: true })).toBeVisible();
        await view.unroute(reportRoute);

        // 到期使用标准 410 Problem 夹具，避免改写数据库中的真实运行证据或触发仓库维护流程。
        await view.route(reportRoute, (route) =>
            route.fulfill({ status: 410, json: { code: "REPORT_EXPIRED", message: "Report metadata expired." } }),
        );
        await refreshRun.click();
        await expect(card.getByRole("alert")).toHaveText("REPORT_EXPIRED");
        await expect(view.getByText(reply, { exact: true })).toBeVisible();
        await view.unroute(reportRoute);

        await membership("EDITOR", "DISABLED");
        const deniedReport = view.waitForResponse(
            (response) => reportRoute(new URL(response.url())) && response.status() === 403,
        );
        await refreshRun.click();
        expect((await (await deniedReport).json()).code).toBe("WORKSPACE_FORBIDDEN");
        await expect(view.getByRole("alert")).toHaveText("WORKSPACE_FORBIDDEN");
        await expect(card).toHaveCount(0);
        await expect(view.getByText(reply, { exact: true })).toHaveCount(0);
        await expect(view.getByRole("button", { name: title, exact: true })).toHaveCount(0);
    } finally {
        releaseDetail.resolve();
        releaseWrite.resolve();
        releaseHistory.resolve();
        await member.close();
    }
});

/**
 * 服务端用同一私有归属错误隐藏不可读会话，页面只移除收到该拒绝的选中项，仍允许打开其他本人线程。
 */
test("R15 fix1 keeps a private session retry within its original filter", async ({ page, browser }) => {
    const member = await browser.newContext({ baseURL: memberOrigin });
    try {
        const { scope, workspace } = await agentMember(page, member, "conversation-privacy-r15");
        const foreign = await page.request.post(`${workspace}/agent/sessions`, {
            headers: scope.headers,
            data: { title: "Owner private session" },
        });
        expect(foreign.status(), await foreign.text()).toBe(201);
        const foreignId = ((await foreign.json()).data as S["AgentSessionDTO"]).id;
        const view = await member.newPage();
        await view.goto(`/tests/agent-strict-fixture.html?workspaceId=${scope.workspaceId}`);
        const retained = "Retained member session";
        const removed = "Rejected member session";
        const archived = "Archived member session";
        await newAgentSession(view, archived);
        await view.getByRole("button", { name: "Archive conversation", exact: true }).click();
        await expect(view.getByRole("heading", { name: archived, exact: true })).toHaveCount(0);
        await newAgentSession(view, retained);
        const retainedReply = "The authorized member session remains readable.";
        output = { reply: retainedReply };
        await view.getByRole("textbox", { name: "Message", exact: true }).fill("Assess the retained member session");
        await view.getByRole("button", { name: "Send", exact: true }).click();
        await expect(view.getByText(retainedReply, { exact: true })).toBeVisible();
        const removedId = await newAgentSession(view, removed);
        const target = `${workspace}/agent/sessions/${removedId}`;
        const listEntry = (title: string) => view.getByRole("button", { name: title, exact: true });
        await expect(listEntry(retained)).toBeVisible();
        await expect(listEntry(removed)).toBeVisible();
        await expect(view.getByText("No messages yet.")).toBeVisible();

        // 读取改指 Owner 私有会话，取得真实服务的会话级拒绝，所选项仍用原始请求路径归属这个错误。
        await view.route(
            (url) => url.pathname === target,
            async (route) => {
                const response = await route.fetch({
                    url: new URL(`${workspace}/agent/sessions/${foreignId}`, memberOrigin).href,
                });
                expect(response.status(), await response.text()).toBe(404);
                expect((await response.json()).code).toBe("AGENT_SESSION_NOT_FOUND");
                await route.fulfill({ response });
            },
        );
        await view.getByRole("button", { name: "Refresh conversation" }).click();
        await expect(view.getByRole("alert")).toHaveText("AGENT_SESSION_NOT_FOUND");
        await expect(listEntry(removed)).toHaveCount(0);
        await expect(view.getByRole("heading", { name: removed })).toHaveCount(0);
        await expect(listEntry(retained)).toBeVisible();
        await listEntry(retained).click();
        await expect(view.getByRole("heading", { name: retained })).toBeVisible();
        await expect(view.getByText(retainedReply, { exact: true })).toBeVisible();
        await expect(listEntry(removed)).toHaveCount(0);

        // 活动列表重取与第一次归档读取各持有真实响应，必须先完成旧筛选的恢复，再放行归档首读。
        const activeList = Promise.withResolvers<void>();
        const archiveList = Promise.withResolvers<void>();
        const releaseActive = Promise.withResolvers<void>();
        const releaseArchive = Promise.withResolvers<void>();
        await view.route(
            (url) => url.pathname === `${workspace}/agent/sessions`,
            async (route) => {
                const isArchive = new URL(route.request().url()).searchParams.get("archived") === "true";
                const response = await route.fetch();
                expect(response.status(), await response.text()).toBe(200);
                if (isArchive) {
                    expect(
                        (await response.json()).data.items.map((item: S["AgentSessionDTO"]) => item.title),
                    ).toContain(archived);
                    archiveList.resolve();
                    await releaseArchive.promise;
                } else {
                    activeList.resolve();
                    await releaseActive.promise;
                }
                await route.fulfill({ response });
            },
        );
        try {
            await view.getByRole("button", { name: "Retry", exact: true }).click();
            await activeList.promise;
            await view.getByRole("button", { name: "Archived", exact: true }).click();
            await archiveList.promise;
            releaseActive.resolve();
            await expect(view.getByRole("alert")).toHaveCount(0);
            await expect(listEntry(archived)).toHaveCount(0);
            releaseArchive.resolve();
            await expect(listEntry(archived)).toBeVisible();
        } finally {
            releaseActive.resolve();
            releaseArchive.resolve();
        }
    } finally {
        await member.close();
    }
});

for (const status of ["ACTIVE", "DISABLED"] as const) {
    /**
     * 只在开流边界投影桌面宿主的普通错误，报告复核继续走真实员工 Cookie，分别观察准入失败和读取失权。
     */
    test(`R15 fix1 verifies Desktop stream status projection with a real report GET when ${status}`, async ({
        page,
        browser,
    }) => {
        test.info().annotations.push({ type: "browser", description: browser.version() });
        const member = await browser.newContext({ baseURL: memberOrigin });
        const streamStarted = Promise.withResolvers<void>();
        const releaseStream = Promise.withResolvers<void>();
        try {
            const { scope, workspace, userId, membership } = await agentMember(page, member, `r15-stream-${status}`);
            const { savedPlan } = await queueableAgentPlan(page, scope, workspace, userId);
            const view = await member.newPage();
            await view.exposeFunction("holdAgentDesktopOpen", () => {
                streamStarted.resolve();
                return releaseStream.promise;
            });
            await view.addInitScript(() => {
                const holdOpen = (window as Window & { holdAgentDesktopOpen?: () => Promise<void> })
                    .holdAgentDesktopOpen;
                if (!holdOpen) {
                    throw new Error("Missing Desktop open test gate.");
                }
                const fetch = window.fetch.bind(window);
                window.fetch = async (input, options) => {
                    if (typeof input === "string" && input.endsWith("/events/stream")) {
                        await holdOpen();
                        options?.signal?.throwIfAborted();
                        throw new Error("Error invoking remote method 'streamOpen': Error: WORKSPACE_FORBIDDEN");
                    }
                    return fetch(input, options);
                };
            });
            await view.goto(`/tests/agent-strict-fixture.html?workspaceId=${scope.workspaceId}`);
            const title = "Desktop status projection conversation";
            const sessionId = await newAgentSession(view, title);
            const detailPath = `${workspace}/agent/sessions/${sessionId}`;
            const reply = "The member may confirm a report-producing run.";
            output = {
                reply,
                proposal: { type: "TRIGGER_PLAN", planId: savedPlan.id, planRevision: savedPlan.revision },
            };
            await view.getByRole("textbox", { name: "Message", exact: true }).fill("Execute the saved plan once");
            await view.getByRole("button", { name: "Send", exact: true }).click();
            await expect(view.getByText(reply, { exact: true })).toBeVisible();
            const confirmation = view.waitForResponse((response) => response.url().endsWith("/confirm"));
            const detail = view.waitForResponse((response) => response.url().endsWith(detailPath));
            const history = view.waitForResponse(
                (response) => response.url().endsWith(`${detailPath}/turns`) && response.request().method() === "GET",
            );
            await view.getByRole("button", { name: "Confirm run saved plan" }).click();
            const confirmed = await confirmation;
            expect(confirmed.status(), await confirmed.text()).toBe(200);
            const runId = (await confirmed.json()).data.receipt.runId;
            expect((await detail).status()).toBe(200);
            expect((await history).status()).toBe(200);
            const card = view.getByRole("region", { name: "Run status" });
            await expect(card).toContainText("QUEUED");
            await streamStarted.promise;

            const checks: BrowserResponse[] = [];
            view.on("response", (response) => {
                if (response.url().endsWith(`${workspace}/runs/${runId}/report`)) {
                    checks.push(response);
                }
            });
            if (status === "DISABLED") {
                await membership("EDITOR", status);
            }
            releaseStream.resolve();
            if (status === "ACTIVE") {
                await expect(card.getByRole("alert")).toHaveText("WORKSPACE_FORBIDDEN");
                await expect.poll(() => checks.map((response) => response.status())).toEqual([200]);
                await expect(card.getByText("QUEUED", { exact: true })).toHaveCount(0);
                await expect(view.getByText(reply, { exact: true })).toBeVisible();
                await expect(view.getByRole("button", { name: title, exact: true })).toBeVisible();
            } else {
                await expect.poll(() => checks.map((response) => response.status())).toEqual([403]);
                expect((await checks[0].json()).code).toBe("WORKSPACE_FORBIDDEN");
                await expect(view.getByRole("alert")).toHaveText("WORKSPACE_FORBIDDEN");
                await expect(card).toHaveCount(0);
                await expect(view.getByText(reply, { exact: true })).toHaveCount(0);
                await expect(view.getByRole("button", { name: title, exact: true })).toHaveCount(0);
            }
        } finally {
            releaseStream.resolve();
            await member.close();
        }
    });
}

for (const status of ["ACTIVE", "DISABLED"] as const) {
    /**
     * 设置真实保存需要管理权，随后读取只需要可读权限。保持挂载的管理员控件由服务端当前权限实际拒绝。
     */
    test(`R15 fix1 settings save verifies VIEW after a real permission denial when ${status}`, async ({
        page,
        browser,
    }) => {
        const member = await browser.newContext({ baseURL: memberOrigin });
        try {
            const { scope, workspace, membership } = await agentMember(page, member, `r15-settings-${status}`, "ADMIN");
            const view = await member.newPage();
            await view.goto(`/tests/agent-strict-fixture.html?workspaceId=${scope.workspaceId}`);
            const title = "Settings permission conversation";
            await newAgentSession(view, title);
            const reply = "The member previously read this private response.";
            output = { reply };
            await view.getByRole("textbox", { name: "Message", exact: true }).fill("Assess settings without writes");
            await view.getByRole("button", { name: "Send", exact: true }).click();
            await expect(view.getByText(reply, { exact: true })).toBeVisible();
            await view.getByRole("button", { name: "Model settings", exact: true }).click();
            await view.getByLabel("Workspace default provider").selectOption("");
            const save = view.getByRole("button", { name: "Save model settings", exact: true });
            await expect(save).toBeEnabled();

            await membership(status === "ACTIVE" ? "VIEWER" : "ADMIN", status);
            const settingsPath = `${workspace}/agent/settings`;
            const checks: BrowserResponse[] = [];
            const writes: BrowserResponse[] = [];
            view.on("response", (response) => {
                if (response.url().endsWith(settingsPath)) {
                    (response.request().method() === "GET" ? checks : writes).push(response);
                }
            });
            await save.click();
            await expect.poll(() => writes.map((response) => response.status())).toEqual([403]);
            expect((await writes[0].json()).code).toBe("WORKSPACE_FORBIDDEN");
            await expect
                .poll(() => checks.map((response) => response.status()))
                .toEqual([status === "ACTIVE" ? 200 : 403]);
            if (status === "ACTIVE") {
                await expect(view.getByText(reply)).toBeVisible();
                await expect(view.getByRole("button", { name: title, exact: true })).toBeVisible();
            } else {
                expect((await checks[0].json()).code).toBe("WORKSPACE_FORBIDDEN");
                await expect(view.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
                await expect(view.getByText(reply)).toHaveCount(0);
                await expect(view.getByRole("button", { name: title, exact: true })).toHaveCount(0);
                await expect(save).toHaveCount(0);
            }
            expect(writes).toHaveLength(1);
        } finally {
            await member.close();
        }
    });
}
