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

test("AI configuration is a real workspace page and explains no-provider execution", async ({
    page,
}) => {
    await editorScope(page, "ai-browser");
    await page.getByRole("link", { name: "AI", exact: true }).click();
    await expect(page.getByTestId("ai-empty")).toBeVisible();
    await expect(page.getByTestId("ai-execution-independent")).toBeVisible();
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

test("real UI config, paid-call preview, review, genuine compiler, cancel and scoped history", async ({
    page,
}) => {
    test.setTimeout(180000);
    const scope = await editorScope(page, "ai-full");
    const compiler = await managedCompiler(page, scope);
    try {
        await createResource(page, "ELEMENT_CATALOG", "catalog");
        catalogId = (await compiler.publish()).id;
        await page.getByRole("link", { name: "AI", exact: true }).click();
        await page.getByTestId("ai-workspace").selectOption(scope.workspaceId);
        await page.getByTestId("app-language").selectOption("en");
        await page.getByTestId("ai-name").fill("Local HTTP protocol emulator");
        await page.getByTestId("ai-baseURL").fill("http://127.0.0.1:18890/v1");
        await page.getByTestId("ai-model").fill("emulator");
        await page.getByTestId("ai-key").fill("synthetic-browser-provider-key");
        await page.getByTestId("ai-enabled").check();
        await page.getByTestId("ai-save").click();
        await expect(page.getByTestId("ai-key")).toHaveValue("");
        await expect(page.getByTestId("ai-budget")).toContainText("Available");
        await page.getByTestId("ai-test").click();
        await expect(page.getByTestId("ai-history")).toContainText("CONNECTION_TEST · SUCCEEDED");
        const prior = calls;
        await page
            .getByTestId("ai-prompt")
            .fill("REQ-LOGIN: open the login page. Expected results must cite this requirement.");
        await page.getByTestId("ai-versions").fill(catalogId);
        await page.getByTestId("ai-data").fill('{"password":"do-not-send","username":"test-user"}');
        await page.getByTestId("ai-preview").click();
        await expect(page.getByTestId("ai-context")).toContainText("[REDACTED]");
        await expect(page.getByTestId("ai-context")).not.toContainText("do-not-send");
        expect(calls).toBe(prior);
        await page.getByTestId("ai-generate").click();
        await expect(page.getByTestId("ai-review")).toContainText("SUCCEEDED");
        await expect(page.getByTestId("ai-output")).toContainText("Requirement-backed draft");
        const caseList = await page.request.get(
            "/api/v1/workspaces/" + scope.workspaceId + "/resources?kind=CASE",
        );
        expect((await caseList.json()).data.items).toHaveLength(0);
        await expect(page.getByTestId("ai-accept")).toBeDisabled();
        await page.getByTestId("ai-resource-name").fill("Reviewed AI case");
        await page.getByTestId("ai-resource-key").fill("invalid/key");
        await expect(page.getByTestId("ai-accept")).toBeDisabled();
        await page.getByTestId("ai-resource-key").fill("reviewed-ai-case");
        await expect(page.getByTestId("ai-accept")).toBeEnabled();
        await page.getByTestId("ai-accept").click();
        await expect(page.getByTestId("ai-review")).toContainText("REVIEWED");
        await page.screenshot({
            path: "../../.superpowers/sdd/veriq-1/evidence/t13/ai-reviewed.png",
            fullPage: true,
        });
        await page.getByTestId("ai-open-editor").click();
        await expect(page.getByTestId("resource-editor")).toBeVisible();
        const beforeCompile = calls;
        await compiler.publish();
        expect(calls).toBe(beforeCompile);
        await page.getByTestId("ai-purpose").selectOption("BOUNDARY_SUGGESTION");
        await page.getByTestId("ai-preview").click();
        await expect(page.getByTestId("ai-generate")).toBeEnabled();
        hold = true;
        await page.getByTestId("ai-generate").click();
        await expect.poll(() => !!release).toBe(true);
        await page.getByTestId("ai-refresh").click();
        await expect(page.getByTestId("ai-cancel")).toBeVisible();
        await page.getByTestId("ai-cancel").click();
        await expect(page.getByTestId("ai-history")).toContainText("CANCELLED");
        release?.();
        hold = false;
        await expect(page.getByTestId("ai-review")).toContainText("CANCELLED");
        await page.getByTestId("ai-edit-provider").click();
        await page.getByTestId("ai-enabled").uncheck();
        await page.getByTestId("ai-save").click();
        await expect(page.getByTestId("ai-preview")).toBeDisabled();
        await expect(page.locator("body")).not.toContainText("synthetic-browser-provider-key");
        const other = await page.request.post("/api/v1/workspaces", {
            headers: scope.headers,
            data: { key: "ai-other", name: "Other AI Workspace" },
        });
        expect(other.status()).toBe(201);
        await page.reload();
        await page.getByTestId("ai-workspace").selectOption((await other.json()).data.id);
        await expect(page.getByTestId("ai-empty")).toBeVisible();
        await expect(page.getByTestId("ai-review")).toHaveCount(0);
    } finally {
        release?.();
        hold = false;
        await compiler.close();
    }
});

test("fix1 existing CASE review increments only its draft and rejects a stale revision", async ({
    page,
}) => {
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
        await page.getByTestId("ai-workspace").selectOption(scope.workspaceId);
        await page.getByTestId("app-language").selectOption("en");
        await page.getByTestId("ai-resource").fill(resourceId);
        await page
            .getByTestId("ai-prompt")
            .fill("REQ-1: revise the existing CASE title based on this reviewed requirement.");
        const generate = async () => {
            await page.getByTestId("ai-preview").click();
            await expect(page.getByTestId("ai-generate")).toBeEnabled();
            const response = page.waitForResponse(
                (r) => r.url().endsWith("/ai/generations") && r.request().method() === "POST",
            );
            await page.getByTestId("ai-generate").click();
            expect((await response).status()).toBe(201);
            await expect(page.getByTestId("ai-review")).toContainText("SUCCEEDED");
        };
        await generate();
        // 现有 CASE 的人工接受只依赖当前草稿修订号，因此这里保持新资源名称与键字段为空，以真实验证更新既有草稿的分支而不意外创建第二份资源或绕过并发修订检查。
        const acceptance = page.waitForResponse(
            (r) => r.url().endsWith("/review") && r.request().method() === "POST",
        );
        await page.getByTestId("ai-accept").click();
        const accepted = await acceptance;
        expect(accepted.status(), await accepted.text()).toBe(200);
        expect(accepted.request().postDataJSON()).toEqual({
            decision: "ACCEPT_DRAFT",
            revision: 1,
        });
        await expect(page.getByTestId("ai-review")).toContainText("REVIEWED");
        let draft = (
            await (await page.request.get(base + "/resources/" + resourceId + "/draft")).json()
        ).data;
        expect(draft.revision).toBe(2);
        expect(draft.content.document.title).toBe("Requirement-backed draft");
        expect(
            (await (await page.request.get(base + "/resources?kind=CASE")).json()).data.items.map(
                (r: { id: string }) => r.id,
            ),
        ).toEqual([resourceId]);
        await generate();
        await expect(page.getByTestId("ai-resource-key")).toHaveCount(0);
        await expect(page.getByTestId("ai-resource-name")).toHaveCount(0);
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
        const stale = page.waitForResponse(
            (r) => r.url().endsWith("/review") && r.request().method() === "POST",
        );
        await page.getByTestId("ai-accept").click();
        const rejected = await stale;
        expect(rejected.status(), await rejected.text()).toBe(409);
        expect((await rejected.json()).code).toBe("STALE_REVISION");
        expect(rejected.request().postDataJSON()).toEqual({
            decision: "ACCEPT_DRAFT",
            revision: 2,
        });
        draft = (
            await (await page.request.get(base + "/resources/" + resourceId + "/draft")).json()
        ).data;
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

/** 真实列表中的必要记录必须经过存在性检查后才能参与默认选择和预算断言；缺少记录立即使测试失败，避免以非空断言隐藏准备失败或给新增回归引入静态诊断。 */
function aiEffectItem<T>(items: readonly T[] | undefined, index = 0): T {
    const item = items?.[index];
    if (item === undefined) throw new Error("Missing required real AI fixture record");
    return item;
}

/** VeriQ 的 AI 钩子回归从真实登录后的空选中作用域开始，通过服务端创建独立空间与启用的回环 Provider，避免编辑器夹具提前选择空间而掩盖默认选择错误。 */
async function aiEffectScope(page: Page) {
    await page.goto("/login");
    await page.getByTestId("email").fill("browser-admin@example.com");
    await page.getByTestId("password").fill("Browser password 123!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toBeVisible();
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

/** 每个测试 Provider 都经过真实权限、密钥加密与预算验证，唯一允许的模型目标是文件级 HTTP 夹具；不同预算使断言能够识别实际被选中的 Provider 状态而非浏览器默认选项。 */
async function aiEffectProvider(
    page: Page,
    headers: Record<string, string>,
    workspaceId: string,
    budget: number,
) {
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

/** 作用域完成以三个真实列表响应为依据，所有等待都在导航或选择事件之前安装；返回服务端数据供空空间断言使用，不拦截或伪造业务响应，也不等待固定时长。 */
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

test("AI request inputs invalidate reviewed context and preserve manual scope", async ({
    page,
}) => {
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
    await expect(page.getByTestId("ai-workspace")).toHaveValue(firstWorkspaceId);
    await expect(page.getByTestId("ai-provider")).toHaveValue(aiEffectItem(firstProviders).id);
    await expect(page.getByTestId("ai-budget")).toBeVisible();
    const firstProvider = aiEffectItem(
        firstProviders,
    ) as PlatformComponents["schemas"]["ProviderDTO"];
    await expect(page.getByTestId("ai-budget")).toContainText(
        String(firstProvider.monthlyBudgetUsd),
    );
    const manualWorkspace = aiEffectItem(listed.filter((w) => w.id !== firstWorkspaceId)).id;
    const switched = aiEffectLists(page, manualWorkspace);
    await page.getByTestId("ai-workspace").selectOption(manualWorkspace);
    const [providers] = await switched;
    const providerRows = (
        await (await page.request.get(`/api/v1/workspaces/${manualWorkspace}/ai/providers`)).json()
    ).data.items as PlatformComponents["schemas"]["ProviderDTO"][];
    expect(providers?.map((p) => p.id)).toEqual(providerRows.map((p) => p.id));
    const selected = aiEffectItem(providerRows, 1);
    await page.getByTestId("ai-provider").selectOption(selected.id);
    await page.getByTestId("app-language").selectOption("en");
    await expect(page.getByTestId("ai-budget")).toContainText(
        `Available: ${selected.monthlyBudgetUsd}`,
    );
    const refreshed = page.waitForResponse(
        (r) =>
            r.url().endsWith(`/workspaces/${manualWorkspace}/ai/providers`) &&
            r.request().method() === "GET",
    );
    await page.getByTestId("ai-refresh").click();
    expect((await refreshed).status()).toBe(200);
    await expect(page.getByTestId("ai-provider")).toHaveValue(selected.id);
    await expect(page.getByTestId("ai-workspace")).toHaveValue(manualWorkspace);
    await page.getByRole("link", { name: "Resources", exact: true }).click();
    await expect(page.getByTestId("resource-workspace")).toHaveValue(manualWorkspace);
    await page.getByRole("link", { name: "AI", exact: true }).click();
    await expect(page.getByTestId("ai-workspace")).toHaveValue(manualWorkspace);
    await page.getByTestId("ai-provider").selectOption(selected.id);
    await page.getByTestId("ai-prompt").fill("REQ-EFFECTS: reject empty passwords.");
    const priorCalls = calls;
    let generationPosts = 0;
    page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/ai/generations"))
            generationPosts++;
    });
    const preview = async () => {
        const response = page.waitForResponse(
            (r) => r.url().endsWith("/ai/context") && r.request().method() === "POST",
        );
        await page.getByTestId("ai-preview").click();
        const context = await response;
        expect(context.status()).toBe(200);
        const dto = (await context.json()).data as PlatformComponents["schemas"]["AiContextDTO"];
        expect(dto.contextHash).toMatch(/^[a-f0-9]{64}$/);
        expect(dto.provenance).toEqual([]);
        await expect(page.getByTestId("ai-context")).toContainText("REQ-EFFECTS");
        await expect(page.getByTestId("ai-context")).toContainText("[]");
        await expect(page.getByTestId("ai-generate")).toBeEnabled();
        return { dto, request: context.request().postDataJSON() };
    };
    const invalidated = async () => {
        await expect(page.getByTestId("ai-context")).toHaveCount(0);
        await expect(page.getByTestId("ai-generate")).toHaveCount(0);
        expect(generationPosts).toBe(0);
        expect(calls).toBe(priorCalls);
    };
    await preview();
    await page.getByTestId("ai-edit-provider").click();
    await expect(page.getByTestId("ai-generate")).toBeEnabled();
    const saved = page.waitForResponse(
        (r) => r.url().endsWith(`/ai/providers/${selected.id}`) && r.request().method() === "PUT",
    );
    await page.getByTestId("ai-save").click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByTestId("ai-generate")).toBeEnabled();
    await page.getByTestId("ai-name").fill("Unsaved provider editor survives request edits");
    await page.getByTestId("ai-provider").selectOption(aiEffectItem(providerRows).id);
    await invalidated();
    await page.getByTestId("ai-provider").selectOption(selected.id);
    await preview();
    await page.getByTestId("ai-purpose").selectOption("BOUNDARY_SUGGESTION");
    await invalidated();
    await page.getByTestId("ai-purpose").selectOption("CASE_DRAFT");
    await preview();
    // 八个请求字段分别触发审核失效，版本、资源及运行标识仅编辑后立即恢复再预览，避免把虚构引用提交服务端；每次恢复仍需重新预览，证明编辑再撤销不会复活旧审核结果。
    for (const [field, changed, original] of [
        ["prompt", "REQ-EFFECTS: changed requirement", "REQ-EFFECTS: reject empty passwords."],
        ["versions", "unsubmitted-version-reference", ""],
        ["openapi", '{"info":{"title":"effects"}}', "{}"],
        ["data", '{"scenario":"effects"}', "{}"],
        ["resource", "unsubmitted-resource-reference", ""],
        ["run", "unsubmitted-run-reference", ""],
    ] as const) {
        await page.getByTestId(`ai-${field}`).fill(changed);
        await invalidated();
        await page.getByTestId(`ai-${field}`).fill(original);
        await invalidated();
        await preview();
    }
    await expect(page.getByTestId("ai-name")).toHaveValue(
        "Unsaved provider editor survives request edits",
    );
    await page.getByTestId("ai-purpose").selectOption("BOUNDARY_SUGGESTION");
    await page.getByTestId("ai-prompt").fill("REQ-EFFECTS: current reviewed boundary requirement.");
    await page.getByTestId("ai-data").fill('{"scenario":"current-reviewed"}');
    const reviewed = await preview();
    const response = page.waitForResponse(
        (r) => r.url().endsWith("/ai/generations") && r.request().method() === "POST",
    );
    await page.getByTestId("ai-generate").click();
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
    await expect(page.getByTestId("ai-review")).toContainText("SUCCEEDED");
    await expect(page.getByTestId("ai-output")).toContainText(
        "An empty password should be rejected.",
    );
    await expect(page.getByTestId("ai-history")).toContainText("BOUNDARY_SUGGESTION · SUCCEEDED");
    await expect(page.getByTestId("ai-context")).toBeVisible();
    await expect(page.getByTestId("ai-generate")).toBeDisabled();
    await page
        .getByTestId("ai-prompt")
        .fill("REQ-EFFECTS: later invalidation retains completed output.");
    await expect(page.getByTestId("ai-context")).toHaveCount(0);
    await expect(page.getByTestId("ai-review")).toContainText("SUCCEEDED");
    await expect(page.getByTestId("ai-history")).toContainText("BOUNDARY_SUGGESTION · SUCCEEDED");
    await expect(page.getByTestId("ai-name")).toHaveValue(
        "Unsaved provider editor survives request edits",
    );
    expect(calls).toBe(priorCalls + 1);
    expect(generationPosts).toBe(1);
});

test("AI generation completion stays in its owning workspace", async ({ page }) => {
    test.setTimeout(90000);
    const scope = await aiEffectScope(page);
    const provider = await aiEffectProvider(page, scope.headers, scope.alpha, 11);
    await page.getByRole("link", { name: "AI", exact: true }).click();
    await page.getByTestId("ai-workspace").selectOption(scope.alpha);
    await expect(page.getByTestId("ai-provider")).toHaveValue(provider.id);
    await page.getByTestId("app-language").selectOption("en");
    await page.getByTestId("ai-purpose").selectOption("BOUNDARY_SUGGESTION");
    await page.getByTestId("ai-prompt").fill("REQ-ALPHA: delayed Alpha requirement.");
    await page.getByTestId("ai-preview").click();
    await expect(page.getByTestId("ai-generate")).toBeEnabled();
    const priorCalls = calls;
    try {
        hold = true;
        await page.getByTestId("ai-generate").click();
        await expect.poll(() => calls).toBe(priorCalls + 1);
        await expect.poll(() => typeof release).toBe("function");
        const betaLists = aiEffectLists(page, scope.beta);
        await page.getByTestId("ai-workspace").selectOption(scope.beta);
        expect(await betaLists).toEqual([[], [], []]);
        await expect(page.getByTestId("ai-empty")).toBeVisible();
        release?.();
        hold = false;
        const alphaHistory = async () => {
            const response = await page.request.get(
                `/api/v1/workspaces/${scope.alpha}/ai/generations`,
            );
            expect(response.status()).toBe(200);
            return (await response.json()).data
                .items as PlatformComponents["schemas"]["GenerationDTO"][];
        };
        await expect
            .poll(async () => (await alphaHistory()).map((g) => g.status))
            .toEqual(["SUCCEEDED"]);
        const [completed] = await alphaHistory();
        const detail = await page.request.get(
            `/api/v1/workspaces/${scope.alpha}/ai/generations/${aiEffectItem([completed]).id}`,
        );
        expect(detail.status()).toBe(200);
        expect((await detail.json()).data).toMatchObject({
            status: "SUCCEEDED",
            purpose: "BOUNDARY_SUGGESTION",
        });
        await expect(page.getByTestId("ai-workspace")).toHaveValue(scope.beta);
        await expect(page.getByTestId("ai-provider")).toHaveValue("");
        await expect(page.getByTestId("ai-prompt")).toHaveValue("");
        await expect(page.getByTestId("ai-context")).toHaveCount(0);
        await expect(page.getByTestId("ai-generate")).toHaveCount(0);
        await expect(page.getByTestId("ai-review")).toHaveCount(0);
        await expect(page.getByTestId("ai-history").getByRole("button")).toHaveCount(0);
        await expect(page.getByRole("alert")).toHaveCount(0);
        expect(calls).toBe(priorCalls + 1);
    } finally {
        release?.();
        hold = false;
    }
});
