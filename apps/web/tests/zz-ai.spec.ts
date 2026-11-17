import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { PlatformComponents } from "@veriq/contracts";
import { editorScope } from "./editor-fixture";

test.beforeAll(async ({ request }) => {
    const state = (await (await request.get("/api/v1/setup")).json()).data;
    const headers = {
        Origin: "http://127.0.0.1:5173",
        "X-CSRF-Token": state.csrfToken,
    };
    if (!state.initialized) {
        const r = await request.post("/api/v1/setup", {
            headers,
            data: {
                installationSecret: "browser-operator-secret",
                email: "browser-admin@example.com",
                displayName: "AI administrator",
                password: "Browser password 123!",
            },
        });
        expect(r.status()).toBe(201);
    }
});

test("AI configuration is a real workspace page and explains no-provider execution", async ({ page }) => {
    await editorScope(page, "ai-browser");
    await page.getByRole("link", { name: "AI", exact: true }).click();
    await expect(page.getByText("No providers configured")).toBeVisible();
    await expect(page.getByText("Deterministic execution works without a model")).toBeVisible();
});

import { createServer, type Server } from "node:http";
import { createResource, managedCompiler } from "./editor-fixture";
let model: Server,
    calls = 0;
let catalogId = "";
let release: (() => void) | undefined;
let hold = false;
const modelContexts: unknown[] = [];
test.beforeAll(async () => {
    model = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        calls++;
        const body = JSON.parse(raw);
        const context = JSON.parse(body.messages[1].content).context;
        modelContexts.push(context);
        if (hold)
            await new Promise<void>((resolve) => {
                release = () => {
                    release = undefined;
                    resolve();
                };
            });
        const output =
            context.purpose === "CASE_DRAFT"
                ? {
                      kind: "CASE",
                      document: {
                          schemaVersion: "1.0",
                          caseKey: "ai-case",
                          title: "Requirement-backed draft",
                          kind: "READ",
                          roleKey: "reader",
                          catalogVersionId: catalogId,
                          steps: [{ id: "open", action: "goto", path: "/" }],
                      },
                  }
                : {
                      suggestions: ["An empty password should be rejected."],
                      basis: "REQ-LOGIN",
                  };
        res.setHeader("Content-Type", "application/json");
        res.end(
            JSON.stringify({
                id: "chatcmpl_local",
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
                usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
            }),
        );
    });
    await new Promise<void>((resolve) => model.listen(18890, "127.0.0.1", resolve));
});
test.afterAll(async () => {
    release?.();
    await new Promise<void>((resolve, reject) => model.close((e) => (e ? reject(e) : resolve())));
});

test("real UI config, paid-call preview, review, genuine compiler, cancel and scoped history", async ({ page }) => {
    test.setTimeout(180000);
    const scope = await editorScope(page, "ai-full");
    const compiler = await managedCompiler(page, scope);
    try {
        await createResource(page, "ELEMENT_CATALOG", "catalog");
        catalogId = (await compiler.publish()).id;
        await page.getByRole("link", { name: "AI", exact: true }).click();
        await page.getByLabel("Workspace").selectOption(scope.workspaceId);
        await page.getByLabel("Language").selectOption("en");
        await page.getByLabel("Name").fill("Local HTTP protocol emulator");
        await page.getByLabel("Base URL").fill("http://127.0.0.1:18890/v1");
        await page.getByLabel("Model").fill("emulator");
        await page.getByLabel("Write-only API key").fill("synthetic-browser-provider-key");
        await page.getByLabel("Enabled").check();
        await page.getByRole("button", { name: "Save provider" }).click();
        await expect(page.getByLabel("Write-only API key")).toHaveValue("");
        await expect(page.getByText("Budget USD").locator("..")).toContainText("Available");
        await page.getByRole("button", { name: "Test connection (uses budget)" }).click();
        await expect(page.getByRole("heading", { name: "Call history" }).locator("..").getByRole("list")).toContainText(
            "CONNECTION_TEST · SUCCEEDED",
        );
        const prior = calls;
        await page
            .getByLabel("Requirement / expected-result basis")
            .fill("REQ-LOGIN: open the login page. Expected results must cite this requirement.");
        await page.getByLabel("Selected immutable version IDs (comma separated)").fill(catalogId);
        await page
            .getByLabel("Supplied nonsecret test data JSON")
            .fill('{"password":"do-not-send","username":"test-user"}');
        await page.getByRole("button", { name: "Review selected context and estimate" }).click();
        await expect(page.getByRole("heading", { name: "Exact sanitized context" }).locator("..")).toContainText(
            "[REDACTED]",
        );
        await expect(page.getByRole("heading", { name: "Exact sanitized context" }).locator("..")).not.toContainText(
            "do-not-send",
        );
        expect(calls).toBe(prior);
        await page.getByRole("button", { name: "Generate with reviewed context" }).click();
        await expect(page.getByRole("heading", { name: "Proposed output", level: 3 }).locator("..")).toContainText(
            "SUCCEEDED",
        );
        await expect(
            page.getByRole("heading", { name: "Proposed output", level: 4 }).locator("..").locator("pre"),
        ).toContainText("Requirement-backed draft");
        const caseList = await page.request.get("/api/v1/workspaces/" + scope.workspaceId + "/resources?kind=CASE");
        expect((await caseList.json()).data.items).toHaveLength(0);
        await expect(page.getByRole("button", { name: "Accept as DRAFT" })).toBeDisabled();
        await page.getByLabel("New resource name").fill("Reviewed AI case");
        await page.getByLabel("New resource key").fill("invalid/key");
        await expect(page.getByRole("button", { name: "Accept as DRAFT" })).toBeDisabled();
        await page.getByLabel("New resource key").fill("reviewed-ai-case");
        await expect(page.getByRole("button", { name: "Accept as DRAFT" })).toBeEnabled();
        await page.getByRole("button", { name: "Accept as DRAFT" }).click();
        await expect(page.getByRole("heading", { name: "Proposed output", level: 3 }).locator("..")).toContainText(
            "REVIEWED",
        );
        await page.screenshot({
            path: "../../.superpowers/sdd/veriq-1/evidence/t13/ai-reviewed.png",
            fullPage: true,
        });
        await page.getByRole("button", { name: "Open draft editor: validate, debug, publish" }).click();
        await expect(page.getByRole("article")).toBeVisible();
        const beforeCompile = calls;
        await compiler.publish();
        expect(calls).toBe(beforeCompile);
        await page.getByLabel("Purpose").selectOption("BOUNDARY_SUGGESTION");
        await page.getByRole("button", { name: "Review selected context and estimate" }).click();
        await expect(page.getByRole("button", { name: "Generate with reviewed context" })).toBeEnabled();
        hold = true;
        await page.getByRole("button", { name: "Generate with reviewed context" }).click();
        await expect.poll(() => !!release).toBe(true);
        await page.getByRole("button", { name: "Refresh" }).click();
        await expect(page.getByRole("button", { name: "Cancel local result" })).toBeVisible();
        await page.getByRole("button", { name: "Cancel local result" }).click();
        await expect(page.getByRole("heading", { name: "Call history" }).locator("..").getByRole("list")).toContainText(
            "CANCELLED",
        );
        release?.();
        hold = false;
        await expect(page.getByRole("heading", { name: "Proposed output", level: 3 }).locator("..")).toContainText(
            "CANCELLED",
        );
        await page.getByRole("button", { name: /Provider / }).click();
        await page.getByLabel("Enabled").uncheck();
        await page.getByRole("button", { name: "Save provider" }).click();
        await expect(page.getByRole("button", { name: "Review selected context and estimate" })).toBeDisabled();
        await expect(page.locator("body")).not.toContainText("synthetic-browser-provider-key");
        const other = await page.request.post("/api/v1/workspaces", {
            headers: scope.headers,
            data: { key: "ai-other", name: "Other AI Workspace" },
        });
        expect(other.status()).toBe(201);
        await page.reload();
        await page.getByLabel("Workspace").selectOption((await other.json()).data.id);
        await expect(page.getByText("No providers configured")).toBeVisible();
        await expect(page.getByRole("heading", { name: "Proposed output", level: 3 }).locator("..")).toHaveCount(0);
    } finally {
        release?.();
        hold = false;
        await compiler.close();
    }
});

test("fix1 existing CASE review increments only its draft and rejects a stale revision", async ({ page }) => {
    test.setTimeout(120000);
    const scope = await editorScope(page, "ai-existing-fix1");
    const compiler = await managedCompiler(page, scope);
    const base = "/api/v1/workspaces/" + scope.workspaceId;
    try {
        await createResource(page, "ELEMENT_CATALOG", "existing-catalog");
        catalogId = (await compiler.publish()).id;
        const original = {
            kind: "CASE",
            document: {
                schemaVersion: "1.0",
                caseKey: "existing-case",
                title: "Original human draft",
                kind: "READ",
                roleKey: "reader",
                catalogVersionId: catalogId,
                steps: [{ id: "open", action: "goto", path: "/" }],
            },
        };
        const created = await page.request.post(base + "/resources", {
            headers: scope.headers,
            data: {
                kind: "CASE",
                key: "existing-case",
                name: "Existing CASE",
                content: original,
            },
        });
        expect(created.status(), await created.text()).toBe(201);
        const resourceId = (await created.json()).data.id;
        const configured = await page.request.post(base + "/ai/providers", {
            headers: scope.headers,
            data: {
                name: "Existing draft emulator",
                adapter: "OPENAI_COMPATIBLE",
                baseURL: "http://127.0.0.1:18890/v1",
                model: "emulator",
                apiKey: "synthetic-existing-key",
                enabled: true,
                monthlyBudgetUsd: 1,
                inputUsdPerMillion: 1,
                outputUsdPerMillion: 2,
                maxOutputTokens: 1024,
                maxRequestUsd: 0.5,
            },
        });
        expect(configured.status(), await configured.text()).toBe(201);
        await page.getByRole("link", { name: "AI", exact: true }).click();
        await page.getByLabel("Workspace").selectOption(scope.workspaceId);
        await page.getByLabel("Language").selectOption("en");
        await page.getByLabel("Existing CASE resource ID (optional)").fill(resourceId);
        await page
            .getByLabel("Requirement / expected-result basis")
            .fill("REQ-1: revise the existing CASE title based on this reviewed requirement.");
        const generate = async () => {
            await page.getByRole("button", { name: "Review selected context and estimate" }).click();
            await expect(page.getByRole("button", { name: "Generate with reviewed context" })).toBeEnabled();
            const response = page.waitForResponse(
                (r) => r.url().endsWith("/ai/generations") && r.request().method() === "POST",
            );
            await page.getByRole("button", { name: "Generate with reviewed context" }).click();
            expect((await response).status()).toBe(201);
            await expect(page.getByRole("heading", { name: "Proposed output", level: 3 }).locator("..")).toContainText(
                "SUCCEEDED",
            );
        };
        await generate();
        // 现有 CASE 的人工接受只依赖当前草稿修订号，因此这里保持新资源名称与键字段为空，以真实验证更新既有草稿的分支而
        // 不意外创建第二份资源或绕过并发修订检查。
        const acceptance = page.waitForResponse((r) => r.url().endsWith("/review") && r.request().method() === "POST");
        await page.getByRole("button", { name: "Accept as DRAFT" }).click();
        const accepted = await acceptance;
        expect(accepted.status(), await accepted.text()).toBe(200);
        expect(accepted.request().postDataJSON()).toEqual({
            decision: "ACCEPT_DRAFT",
            revision: 1,
        });
        await expect(page.getByRole("heading", { name: "Proposed output", level: 3 }).locator("..")).toContainText(
            "REVIEWED",
        );
        let draft = (await (await page.request.get(base + "/resources/" + resourceId + "/draft")).json()).data;
        expect(draft.revision).toBe(2);
        expect(draft.content.document.title).toBe("Requirement-backed draft");
        expect(
            (await (await page.request.get(base + "/resources?kind=CASE")).json()).data.items.map(
                (r: { id: string }) => r.id,
            ),
        ).toEqual([resourceId]);
        await generate();
        await expect(page.getByLabel("New resource key")).toHaveCount(0);
        await expect(page.getByLabel("New resource name")).toHaveCount(0);
        const concurrent = {
            ...draft.content,
            document: {
                ...draft.content.document,
                title: "Concurrent human revision",
            },
        };
        const updated = await page.request.put(base + "/resources/" + resourceId + "/draft", {
            headers: scope.headers,
            data: { revision: 2, content: concurrent },
        });
        expect(updated.status(), await updated.text()).toBe(200);
        const stale = page.waitForResponse((r) => r.url().endsWith("/review") && r.request().method() === "POST");
        await page.getByRole("button", { name: "Accept as DRAFT" }).click();
        const rejected = await stale;
        expect(rejected.status(), await rejected.text()).toBe(409);
        expect((await rejected.json()).code).toBe("STALE_REVISION");
        expect(rejected.request().postDataJSON()).toEqual({
            decision: "ACCEPT_DRAFT",
            revision: 2,
        });
        draft = (await (await page.request.get(base + "/resources/" + resourceId + "/draft")).json()).data;
        expect(draft.revision).toBe(3);
        expect(draft.content.document.title).toBe("Concurrent human revision");
        expect(
            (await (await page.request.get(base + "/resources?kind=CASE")).json()).data.items.map(
                (r: { id: string }) => r.id,
            ),
        ).toEqual([resourceId]);
    } finally {
        await compiler.close();
    }
});

/**
 * 真实列表中的必要记录必须经过存在性检查后才能参与默认选择和预算断言；缺少记录立即使测试失败，避免以非空断言隐藏准备失
 * 败或给新增回归引入静态诊断。
 */
function aiEffectItem<T>(items: readonly T[] | undefined, index = 0): T {
    const item = items?.[index];
    if (item === undefined) throw new Error("Missing required real AI fixture record");
    return item;
}

/**
 * VeriQ 的 AI 钩子回归从真实登录后的空选中作用域开始，通过服务端创建独立空间与启用的回环 Provider，避免编辑器夹具提前
 * 选择空间而掩盖默认选择错误。
 */
async function aiEffectScope(page: Page) {
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const headers = { Origin: "http://127.0.0.1:5173", "X-CSRF-Token": session.csrfToken };
    const workspaces: string[] = [];
    for (const name of ["Alpha", "Beta"]) {
        const response = await page.request.post("/api/v1/workspaces", {
            headers,
            data: { key: `ai-effects-${randomUUID()}`, name: `AI effects ${name}` },
        });
        expect(response.status()).toBe(201);
        workspaces.push((await response.json()).data.id);
    }
    return { headers, alpha: aiEffectItem(workspaces), beta: aiEffectItem(workspaces, 1) };
}

/**
 * 每个测试 Provider 都经过真实权限、密钥加密与预算验证，唯一允许的模型目标是文件级 HTTP 夹具；不同预算使断言能够识别实
 * 际被选中的 Provider 状态而非浏览器默认选项。
 */
async function aiEffectProvider(page: Page, headers: Record<string, string>, workspaceId: string, budget: number) {
    const response = await page.request.post(`/api/v1/workspaces/${workspaceId}/ai/providers`, {
        headers,
        data: {
            name: `Effect emulator ${budget}`,
            adapter: "OPENAI_COMPATIBLE",
            baseURL: "http://127.0.0.1:18890/v1",
            model: "emulator",
            apiKey: "synthetic-ai-effects-key",
            enabled: true,
            monthlyBudgetUsd: budget,
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 2,
            maxOutputTokens: 1024,
            maxRequestUsd: 0.5,
        },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).data as PlatformComponents["schemas"]["ProviderDTO"];
}

/**
 * 作用域完成以三个真实列表响应为依据，所有等待都在导航或选择事件之前安装；返回服务端数据供空空间断言使用，不拦截或伪造
 * 业务响应，也不等待固定时长。
 */
function aiEffectLists(page: Page, workspaceId: string) {
    return Promise.all(
        ["ai/providers", "ai/generations", "resources"].map(async (path) => {
            const response = await page
                .waitForResponse(
                    (r) =>
                        new URL(r.url()).pathname === `/api/v1/workspaces/${workspaceId}/${path}` &&
                        r.request().method() === "GET",
                )
                .catch((cause) => {
                    throw new Error(`Missing real scoped response: ${path}`, { cause });
                });
            expect(response.status()).toBe(200);
            return (await response.json()).data.items as { id: string }[];
        }),
    );
}

test("AI request inputs invalidate reviewed context and preserve manual scope", async ({ page }) => {
    test.setTimeout(120000);
    const scope = await aiEffectScope(page);
    for (const id of [scope.alpha, scope.beta]) {
        await aiEffectProvider(page, scope.headers, id, 11);
        await aiEffectProvider(page, scope.headers, id, 23);
    }
    const listed = (await (await page.request.get("/api/v1/workspaces")).json()).data.items as {
        id: string;
    }[];
    const firstWorkspaceId = aiEffectItem(listed).id;
    const initial = aiEffectLists(page, firstWorkspaceId);
    await page.getByRole("link", { name: "AI", exact: true }).click();
    const [firstProviders] = await initial;
    await expect(page.getByLabel("Workspace")).toHaveValue(firstWorkspaceId);
    await expect(page.getByLabel("Provider")).toHaveValue(aiEffectItem(firstProviders).id);
    await expect(page.getByText("Budget USD").locator("..")).toBeVisible();
    const firstProvider = aiEffectItem(firstProviders) as PlatformComponents["schemas"]["ProviderDTO"];
    await expect(page.getByText("Budget USD").locator("..")).toContainText(String(firstProvider.monthlyBudgetUsd));
    const manualWorkspace = aiEffectItem(listed.filter((w) => w.id !== firstWorkspaceId)).id;
    const switched = aiEffectLists(page, manualWorkspace);
    await page.getByLabel("Workspace").selectOption(manualWorkspace);
    const [providers] = await switched;
    const providerRows = (await (await page.request.get(`/api/v1/workspaces/${manualWorkspace}/ai/providers`)).json())
        .data.items as PlatformComponents["schemas"]["ProviderDTO"][];
    expect(providers?.map((p) => p.id)).toEqual(providerRows.map((p) => p.id));
    const selected = aiEffectItem(providerRows, 1);
    await page.getByLabel("Provider").selectOption(selected.id);
    await page.getByLabel("Language").selectOption("en");
    await expect(page.getByText("Budget USD").locator("..")).toContainText(`Available: ${selected.monthlyBudgetUsd}`);
    const refreshed = page.waitForResponse(
        (r) => r.url().endsWith(`/workspaces/${manualWorkspace}/ai/providers`) && r.request().method() === "GET",
    );
    await page.getByRole("button", { name: "Refresh" }).click();
    expect((await refreshed).status()).toBe(200);
    await expect(page.getByLabel("Provider")).toHaveValue(selected.id);
    await expect(page.getByLabel("Workspace")).toHaveValue(manualWorkspace);
    await page.getByRole("link", { name: "Resources", exact: true }).click();
    await expect(page.getByLabel("Workspace")).toHaveValue(manualWorkspace);
    await page.getByRole("link", { name: "AI", exact: true }).click();
    await expect(page.getByLabel("Workspace")).toHaveValue(manualWorkspace);
    await page.getByLabel("Provider").selectOption(selected.id);
    await page.getByLabel("Requirement / expected-result basis").fill("REQ-EFFECTS: reject empty passwords.");
    const priorCalls = calls;
    let generationPosts = 0;
    page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/ai/generations")) generationPosts++;
    });
    const preview = async () => {
        const response = page.waitForResponse(
            (r) => r.url().endsWith("/ai/context") && r.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Review selected context and estimate" }).click();
        const context = await response;
        expect(context.status()).toBe(200);
        const dto = (await context.json()).data as PlatformComponents["schemas"]["AiContextDTO"];
        expect(dto.contextHash).toMatch(/^[a-f0-9]{64}$/);
        expect(dto.provenance).toEqual([]);
        await expect(page.getByRole("heading", { name: "Exact sanitized context" }).locator("..")).toContainText(
            "REQ-EFFECTS",
        );
        await expect(page.getByRole("heading", { name: "Exact sanitized context" }).locator("..")).toContainText("[]");
        await expect(page.getByRole("button", { name: "Generate with reviewed context" })).toBeEnabled();
        return { dto, request: context.request().postDataJSON() };
    };
    const invalidated = async () => {
        await expect(page.getByRole("heading", { name: "Exact sanitized context" }).locator("..")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Generate with reviewed context" })).toHaveCount(0);
        expect(generationPosts).toBe(0);
        expect(calls).toBe(priorCalls);
    };
    await preview();
    await page.getByRole("button", { name: /Provider / }).click();
    await expect(page.getByRole("button", { name: "Generate with reviewed context" })).toBeEnabled();
    const saved = page.waitForResponse(
        (r) => r.url().endsWith(`/ai/providers/${selected.id}`) && r.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "Save provider" }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Generate with reviewed context" })).toBeEnabled();
    await page.getByLabel("Name").fill("Unsaved provider editor survives request edits");
    await page.getByLabel("Provider").selectOption(aiEffectItem(providerRows).id);
    await invalidated();
    await page.getByLabel("Provider").selectOption(selected.id);
    await preview();
    await page.getByLabel("Purpose").selectOption("BOUNDARY_SUGGESTION");
    await invalidated();
    await page.getByLabel("Purpose").selectOption("CASE_DRAFT");
    await preview();
    // 八个请求字段分别触发审核失效，版本、资源及运行标识仅编辑后立即恢复再预览，避免把虚构引用提交服务端；每次恢复仍需
    // 重新预览，证明编辑再撤销不会复活旧审核结果。
    const fieldLabels: Record<string, string> = {
        prompt: "Requirement / expected-result basis",
        versions: "Selected immutable version IDs (comma separated)",
        openapi: "Supplied OpenAPI JSON",
        data: "Supplied nonsecret test data JSON",
        resource: "Existing CASE resource ID (optional)",
        run: "Run ID for sanitized failure analysis",
    };
    for (const [field, changed, original] of [
        ["prompt", "REQ-EFFECTS: changed requirement", "REQ-EFFECTS: reject empty passwords."],
        ["versions", "unsubmitted-version-reference", ""],
        ["openapi", '{"info":{"title":"effects"}}', "{}"],
        ["data", '{"scenario":"effects"}', "{}"],
        ["resource", "unsubmitted-resource-reference", ""],
        ["run", "unsubmitted-run-reference", ""],
    ] as const) {
        await page.getByLabel(fieldLabels[field]).fill(changed);
        await invalidated();
        await page.getByLabel(fieldLabels[field]).fill(original);
        await invalidated();
        await preview();
    }
    await expect(page.getByLabel("Name")).toHaveValue("Unsaved provider editor survives request edits");
    await page.getByLabel("Purpose").selectOption("BOUNDARY_SUGGESTION");
    await page
        .getByLabel("Requirement / expected-result basis")
        .fill("REQ-EFFECTS: current reviewed boundary requirement.");
    await page.getByLabel("Supplied nonsecret test data JSON").fill('{"scenario":"current-reviewed"}');
    const reviewed = await preview();
    const response = page.waitForResponse(
        (r) => r.url().endsWith("/ai/generations") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Generate with reviewed context" }).click();
    const generated = await response;
    expect(generated.status()).toBe(201);
    expect(generated.request().postDataJSON()).toEqual({
        ...reviewed.request,
        contextHash: reviewed.dto.contextHash,
    });
    expect(generated.request().postDataJSON()).toMatchObject({
        providerId: selected.id,
        purpose: "BOUNDARY_SUGGESTION",
        prompt: "REQ-EFFECTS: current reviewed boundary requirement.",
        data: { scenario: "current-reviewed" },
    });
    expect(generationPosts).toBe(1);
    expect(calls).toBe(priorCalls + 1);
    expect(modelContexts.at(-1)).toEqual(reviewed.dto.context);
    await expect(page.getByRole("heading", { name: "Proposed output", level: 3 }).locator("..")).toContainText(
        "SUCCEEDED",
    );
    await expect(
        page.getByRole("heading", { name: "Proposed output", level: 4 }).locator("..").locator("pre"),
    ).toContainText("An empty password should be rejected.");
    await expect(page.getByRole("heading", { name: "Call history" }).locator("..").getByRole("list")).toContainText(
        "BOUNDARY_SUGGESTION · SUCCEEDED",
    );
    await expect(page.getByRole("heading", { name: "Exact sanitized context" }).locator("..")).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate with reviewed context" })).toBeDisabled();
    await page
        .getByLabel("Requirement / expected-result basis")
        .fill("REQ-EFFECTS: later invalidation retains completed output.");
    await expect(page.getByRole("heading", { name: "Exact sanitized context" }).locator("..")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Proposed output", level: 3 }).locator("..")).toContainText(
        "SUCCEEDED",
    );
    await expect(page.getByRole("heading", { name: "Call history" }).locator("..").getByRole("list")).toContainText(
        "BOUNDARY_SUGGESTION · SUCCEEDED",
    );
    await expect(page.getByLabel("Name")).toHaveValue("Unsaved provider editor survives request edits");
    expect(calls).toBe(priorCalls + 1);
    expect(generationPosts).toBe(1);
});

test("AI generation completion stays in its owning workspace", async ({ page }) => {
    test.setTimeout(90000);
    const scope = await aiEffectScope(page);
    const provider = await aiEffectProvider(page, scope.headers, scope.alpha, 11);
    await page.getByRole("link", { name: "AI", exact: true }).click();
    await page.getByLabel("Workspace").selectOption(scope.alpha);
    await expect(page.getByLabel("Provider")).toHaveValue(provider.id);
    await page.getByLabel("Language").selectOption("en");
    await page.getByLabel("Purpose").selectOption("BOUNDARY_SUGGESTION");
    await page.getByLabel("Requirement / expected-result basis").fill("REQ-ALPHA: delayed Alpha requirement.");
    await page.getByRole("button", { name: "Review selected context and estimate" }).click();
    await expect(page.getByRole("button", { name: "Generate with reviewed context" })).toBeEnabled();
    const priorCalls = calls;
    try {
        hold = true;
        await page.getByRole("button", { name: "Generate with reviewed context" }).click();
        await expect.poll(() => calls).toBe(priorCalls + 1);
        await expect.poll(() => typeof release).toBe("function");
        const betaLists = aiEffectLists(page, scope.beta);
        await page.getByLabel("Workspace").selectOption(scope.beta);
        expect(await betaLists).toEqual([[], [], []]);
        await expect(page.getByText("No providers configured")).toBeVisible();
        release?.();
        hold = false;
        const alphaHistory = async () => {
            const response = await page.request.get(`/api/v1/workspaces/${scope.alpha}/ai/generations`);
            expect(response.status()).toBe(200);
            return (await response.json()).data.items as PlatformComponents["schemas"]["GenerationDTO"][];
        };
        await expect.poll(async () => (await alphaHistory()).map((g) => g.status)).toEqual(["SUCCEEDED"]);
        const [completed] = await alphaHistory();
        const detail = await page.request.get(
            `/api/v1/workspaces/${scope.alpha}/ai/generations/${aiEffectItem([completed]).id}`,
        );
        expect(detail.status()).toBe(200);
        expect((await detail.json()).data).toMatchObject({
            status: "SUCCEEDED",
            purpose: "BOUNDARY_SUGGESTION",
        });
        await expect(page.getByLabel("Workspace")).toHaveValue(scope.beta);
        await expect(page.getByLabel("Provider")).toHaveValue("");
        await expect(page.getByLabel("Requirement / expected-result basis")).toHaveValue("");
        await expect(page.getByRole("heading", { name: "Exact sanitized context" }).locator("..")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Generate with reviewed context" })).toHaveCount(0);
        await expect(page.getByRole("heading", { name: "Proposed output", level: 3 }).locator("..")).toHaveCount(0);
        await expect(
            page.getByRole("heading", { name: "Call history" }).locator("..").getByRole("list").getByRole("button"),
        ).toHaveCount(0);
        await expect(page.getByRole("alert")).toHaveCount(0);
        expect(calls).toBe(priorCalls + 1);
    } finally {
        release?.();
        hold = false;
    }
});
