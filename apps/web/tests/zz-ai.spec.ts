import {
    chooseLanguage,
    chooseListFilter,
    chooseWorkspace,
    openWorkspaceMenu,
    selectedWorkspaceId,
    workspaceOption,
    workspacePicker,
} from "./support/console-controls";
import { test, expect, type Page, type Response } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { PlatformComponents } from "@veriq/contracts";
import { acknowledgeOperation, editorScope, selectResourceOption } from "./editor-fixture";

const modelPort = Number(process.env.VERIQ_TEST_MODEL_PORT ?? 18890);
const modelBaseUrl = `http://127.0.0.1:${modelPort}/v1`;

test.beforeAll(async ({ request }) => {
    const setup = await request.get("/api/v1/setup");
    const state = (await setup.json()).data;
    const headers = {
        Origin: new URL(setup.url()).origin,
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

/**
 * 提供方触发器展示真实名称和启用状态，审核测试用后端返回的配置核对当前选项，对应请求体仍验证提供方标识。
 */
function providerLabel(provider: Pick<PlatformComponents["schemas"]["ProviderDTO"], "name" | "enabled">) {
    return `${provider.name} · ${provider.enabled ? "Enabled" : "Disabled"}`;
}

/**
 * 关闭等待反馈后再访问历史或切换工作区；这个操作只解除界面焦点圈，不应取消后台对模型发出的请求。
 */
async function dismissGenerationWait(page: Page) {
    const dialog = page.getByRole("dialog", { name: "Operation in progress" });
    await expect(dialog).toContainText("Refresh history to inspect or cancel");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();
}

test("AI configuration is a real workspace page and explains no-provider execution", async ({ page }) => {
    await editorScope(page, "ai-browser");
    await page.getByRole("link", { name: "AI", exact: true }).click();
    await expect(page.getByText("No providers configured")).toBeVisible();
    await expect(page.getByText("Deterministic execution works without a model")).toBeVisible();
    const provider = page.getByRole("combobox", { name: "Provider", exact: true });
    const purpose = page.getByRole("combobox", { name: "Purpose", exact: true });
    const prompt = page.getByRole("textbox", { name: "Requirement / expected-result basis", exact: true });
    const runId = page.getByRole("textbox", { name: "Run ID for sanitized failure analysis", exact: true });
    await expect(provider).toBeDisabled();
    await expect(provider).toHaveAttribute("aria-required", "true");
    await expect(purpose).toHaveAttribute("data-appearance", "default-dropdown");
    await expect(purpose).toHaveAttribute("aria-required", "true");
    await expect(prompt).toHaveJSProperty("required", true);
    await expect(prompt).toHaveAccessibleDescription(
        "Describe the request and the expected outcome to use as the review basis.",
    );
    await expect(runId).toHaveJSProperty("required", false);
    await selectResourceOption(purpose, "FAILURE_ANALYSIS");
    await expect(runId).toHaveJSProperty("required", true);
    const history = page.getByRole("region", { name: "Call history" });
    await expect(history.getByRole("columnheader")).toHaveCount(7);
    await expect(history.getByRole("cell", { name: "No model calls in this Workspace." })).toBeVisible();
});

import { createServer, type Server } from "node:http";
import { closeResourceEditor, createResource, managedCompiler } from "./editor-fixture";
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
    await new Promise<void>((resolve) => model.listen(modelPort, "127.0.0.1", resolve));
});
test.afterAll(async () => {
    release?.();
    await new Promise<void>((resolve, reject) => model.close((e) => (e ? reject(e) : resolve())));
});

test("workspace AI provider connection results are acknowledged and retained in history", async ({ page }) => {
    await editorScope(page, `settings-model-${randomUUID()}`);
    await page.getByRole("link", { name: "Workspace settings", exact: true }).click();
    await page.getByRole("tab", { name: "AI providers", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "AI providers" });
    await panel.getByRole("textbox", { name: "Name", exact: true }).fill("Local HTTP protocol emulator");
    await panel.getByLabel("Base URL").fill(modelBaseUrl);
    await panel.getByRole("textbox", { name: "Model", exact: true }).fill("emulator");
    await panel.getByLabel("Write-only API key").fill("synthetic-settings-key");
    await panel.getByLabel("Enabled").check();
    await panel.getByRole("button", { name: "Save provider" }).click();
    await acknowledgeOperation(page, "Provider saved");
    await panel.getByRole("button", { name: "Test connection", exact: true }).click();
    await acknowledgeOperation(page, "Connection test succeeded");
    await panel.getByRole("textbox", { name: "Model", exact: true }).fill("updated-emulator");
    await panel.getByRole("button", { name: "Save provider" }).click();
    await acknowledgeOperation(page, "Provider saved");
    await page.getByRole("link", { name: "AI", exact: true }).click();
    await expect(
        page
            .getByRole("region", { name: "Call history" })
            .getByRole("table")
            .getByRole("row")
            .filter({ hasText: "CONNECTION_TEST" }),
    ).toContainText("SUCCEEDED");
});

test("real UI config, paid-call preview, review, genuine compiler, cancel and scoped history", async ({ page }) => {
    test.setTimeout(180000);
    const scope = await editorScope(page, "ai-full");
    const compiler = await managedCompiler(page, scope);
    try {
        await createResource(page, "ELEMENT_CATALOG", "catalog");
        catalogId = (await compiler.publish()).id;
        await closeResourceEditor(page);
        const providerResponse = await page.request.post("/api/v1/workspaces/" + scope.workspaceId + "/ai/providers", {
            headers: scope.headers,
            data: {
                name: "Local HTTP protocol emulator",
                adapter: "OPENAI_COMPATIBLE",
                baseURL: modelBaseUrl,
                model: "emulator",
                apiKey: "synthetic-browser-provider-key",
                enabled: true,
                monthlyBudgetUsd: 1,
                inputUsdPerMillion: 1,
                outputUsdPerMillion: 2,
                maxOutputTokens: 1024,
                maxRequestUsd: 0.5,
            },
        });
        expect(providerResponse.status()).toBe(201);
        const providerId = (await providerResponse.json()).data.id;
        await page.getByRole("link", { name: "AI", exact: true }).click();
        await chooseWorkspace(page, scope.workspaceId);
        await chooseLanguage(page, "en");
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
        await acknowledgeOperation(page, "Generation completed. Review the proposed output.");
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
        await selectResourceOption(page.getByRole("combobox", { name: "Purpose" }), "BOUNDARY_SUGGESTION");
        await page.getByRole("button", { name: "Review selected context and estimate" }).click();
        await expect(page.getByRole("button", { name: "Generate with reviewed context" })).toBeEnabled();
        hold = true;
        await page.getByRole("button", { name: "Generate with reviewed context" }).click();
        await expect.poll(() => !!release).toBe(true);
        await dismissGenerationWait(page);
        await page.getByRole("button", { name: "Refresh" }).click();
        await expect(page.getByRole("button", { name: "Cancel local result" })).toBeVisible();
        await page.getByRole("button", { name: "Cancel local result" }).click();
        await expect(
            page
                .getByRole("region", { name: "Call history" })
                .getByRole("table")
                .getByRole("row")
                .filter({ hasText: "BOUNDARY_SUGGESTION" }),
        ).toContainText("CANCELLED");
        release?.();
        hold = false;
        await expect(page.getByRole("heading", { name: "Proposed output", level: 3 }).locator("..")).toContainText(
            "CANCELLED",
        );
        const disableResponse = await page.request.put(
            "/api/v1/workspaces/" + scope.workspaceId + "/ai/providers/" + providerId,
            {
                headers: scope.headers,
                data: {
                    name: "Local HTTP protocol emulator",
                    adapter: "OPENAI_COMPATIBLE",
                    baseURL: modelBaseUrl,
                    model: "emulator",
                    enabled: false,
                    monthlyBudgetUsd: 1,
                    inputUsdPerMillion: 1,
                    outputUsdPerMillion: 2,
                    maxOutputTokens: 1024,
                    maxRequestUsd: 0.5,
                },
            },
        );
        expect(disableResponse.status()).toBe(200);
        await page.reload();
        await chooseWorkspace(page, scope.workspaceId);
        await page
            .getByLabel("Requirement / expected-result basis")
            .fill("REQ-LOGIN: disabled provider blocks generation.");
        await expect(page.getByRole("button", { name: "Review selected context and estimate" })).toBeDisabled();
        const other = await page.request.post("/api/v1/workspaces", {
            headers: scope.headers,
            data: { key: "ai-other", name: "Other AI Workspace" },
        });
        expect(other.status()).toBe(201);
        await page.reload();
        await chooseWorkspace(page, (await other.json()).data.id);
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
        await closeResourceEditor(page);
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
                baseURL: modelBaseUrl,
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
        await chooseWorkspace(page, scope.workspaceId);
        await chooseLanguage(page, "en");
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
            await acknowledgeOperation(page, "Generation completed. Review the proposed output.");
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
        await acknowledgeOperation(page, "Draft revision changed", "failed");
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
    const headers = { Origin: new URL(page.url()).origin, "X-CSRF-Token": session.csrfToken };
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
            baseURL: modelBaseUrl,
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
    const provider = (await response.json()).data as PlatformComponents["schemas"]["ProviderDTO"];
    expect(provider.monthlyBudgetUsd).toBe(budget);
    return provider;
}

test("AI call history filters across real cursor pages", async ({ page }) => {
    test.setTimeout(90_000);
    const { workspaceId, headers } = await editorScope(page, `ai-call-table-${randomUUID()}`);
    const provider = await aiEffectProvider(page, headers, workspaceId, 11);
    const base = `/api/v1/workspaces/${workspaceId}/ai`;
    for (let index = 0; index < 26; index++) {
        const response = await page.request.post(`${base}/providers/${provider.id}/connection-tests`, {
            headers,
            data: { requestId: randomUUID() },
        });
        expect(response.status(), await response.text()).toBe(200);
        expect((await response.json()).data.status).toBe("SUCCEEDED");
    }
    await page.goto("/ai");
    await chooseWorkspace(page, workspaceId);
    const section = page.getByRole("region", { name: "Call history", exact: true });
    const search = section.getByRole("searchbox", { name: "Search calls", exact: true });
    await expect(search).toBeVisible();
    const table = section.getByRole("table");
    const pagination = section.getByRole("navigation", { name: "Call history pagination", exact: true });
    await expect(table.getByRole("row")).toHaveCount(11);
    await pagination.getByRole("button", { name: "3", exact: true }).click();
    await expect(table.getByRole("row")).toHaveCount(7);
    await search.fill("connection_test");
    await expect(pagination.getByRole("button", { name: "1", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(table.getByRole("row")).toHaveCount(11);
    await chooseListFilter(page, "Filter by call status", "FAILED");
    await expect(section.getByText("No matching calls.", { exact: true })).toBeVisible();
    await chooseListFilter(page, "Filter by call status", "SUCCEEDED");
    await expect(table.getByRole("row")).toHaveCount(11);
});

/**
 * 作用域完成以三个真实列表响应为依据，所有等待都在导航或选择事件之前安装；返回服务端数据供空空间断言使用，不拦截或伪造
 * 业务响应，也不等待固定时长。
 */
function aiEffectLists(page: Page, workspaceId: string) {
    const wait = async <T>(path: string) => {
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
        return (await response.json()).data.items as T[];
    };
    return Promise.all([
        wait<PlatformComponents["schemas"]["ProviderDTO"]>("ai/providers"),
        wait<{ id: string }>("ai/generations"),
        wait<{ id: string }>("resources"),
    ]);
}

/**
 * 从真实空间分页响应核对新增选项，再用工作区菜单中的分页操作寻找自有夹具，避免误点同名的提供方或历史分页按钮。
 * 空页、重复记录或游标、列表耗尽及超过百页都明确失败，不改变默认选择或请求页大小。
 */
async function aiEffectWorkspaces(page: Page, firstPage: Response, workspaceIds: readonly string[]) {
    await openWorkspaceMenu(page);
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let response = firstPage;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        expect(response.status()).toBe(200);
        const body: PlatformComponents["schemas"]["WorkspaceDTOPageEnvelope"] = await response.json();
        const { items, nextCursor } = body.data;
        const last = items.at(-1);
        if (!last) throw new Error("Workspace pages must contain new options");
        for (const item of items) {
            expect(seenIds.has(item.id), "Workspace pages must not repeat IDs").toBe(false);
            seenIds.add(item.id);
        }
        await expect(workspaceOption(page, last.id)).toBeVisible();
        if (workspaceIds.every((id) => seenIds.has(id))) {
            for (const id of workspaceIds) await expect(workspaceOption(page, id)).toBeVisible();
            await page.keyboard.press("Escape");
            return;
        }
        if (!nextCursor) throw new Error("Known AI Workspaces were absent from the complete list");
        if (seenCursors.has(nextCursor)) throw new Error("Workspace pagination repeated a cursor");
        seenCursors.add(nextCursor);
        if (pageNumber === 99) break;
        const more = page.getByRole("menuitem", { name: "More Workspaces", exact: true });
        await expect(more).toBeEnabled();
        const nextPage = page.waitForResponse((candidate) => {
            const url = new URL(candidate.url());
            return (
                candidate.request().method() === "GET" &&
                url.pathname === "/api/v1/workspaces" &&
                url.searchParams.get("cursor") === nextCursor
            );
        });
        await more.click();
        response = await nextPage;
    }
    throw new Error("Known AI Workspaces were not loaded within 100 pages");
}

test("AI request inputs invalidate reviewed context and preserve manual scope", async ({ page }) => {
    test.setTimeout(120000);
    const scope = await aiEffectScope(page);
    const ownProviders = new Map<string, PlatformComponents["schemas"]["ProviderDTO"][]>();
    for (const id of [scope.alpha, scope.beta])
        ownProviders.set(
            id,
            [
                await aiEffectProvider(page, scope.headers, id, 11),
                await aiEffectProvider(page, scope.headers, id, 23),
            ].sort((a, b) => a.id.localeCompare(b.id)),
        );
    const listed = (await (await page.request.get("/api/v1/workspaces")).json()).data.items as {
        id: string;
    }[];
    const firstWorkspaceId = aiEffectItem(listed).id;
    const initial = aiEffectLists(page, firstWorkspaceId);
    const firstPage = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
            response.request().method() === "GET" &&
            url.pathname === "/api/v1/workspaces" &&
            !url.searchParams.has("cursor")
        );
    });
    await page.getByRole("link", { name: "AI", exact: true }).click();
    const [firstProviders] = await initial;
    await expect(workspacePicker(page)).toHaveAttribute("data-workspace-id", firstWorkspaceId);
    if (firstProviders?.length) {
        await expect(page.getByRole("combobox", { name: "Provider" })).toContainText(
            providerLabel(aiEffectItem(firstProviders)),
        );
    } else {
        expect(firstProviders).toEqual([]);
        await expect(page.getByRole("combobox", { name: "Provider" })).toBeDisabled();
        await expect(page.getByRole("combobox", { name: "Provider" })).toContainText("—");
        await expect(
            page.getByText("No providers configured. Add your own provider to generate drafts.", { exact: true }),
        ).toBeVisible();
    }
    await aiEffectWorkspaces(page, await firstPage, [scope.alpha, scope.beta]);
    // 默认首项允许没有提供方；正向预算断言改用自有空间，并以创建返回且独立排序的标识核对真实列表和默认提供方。
    let alphaProviders = firstProviders;
    if (firstWorkspaceId !== scope.alpha) {
        const alphaLists = aiEffectLists(page, scope.alpha);
        await chooseWorkspace(page, scope.alpha);
        [alphaProviders] = await alphaLists;
    }
    const knownAlpha = ownProviders.get(scope.alpha);
    expect(alphaProviders?.map((p) => p.id)).toEqual(knownAlpha?.map((p) => p.id));
    const firstProvider = aiEffectItem(knownAlpha);
    await expect(page.getByRole("combobox", { name: "Provider" })).toContainText(providerLabel(firstProvider));
    const manualWorkspace = scope.beta;
    const switched = aiEffectLists(page, manualWorkspace);
    await chooseWorkspace(page, manualWorkspace);
    const [providers] = await switched;
    const providerRows = (await (await page.request.get(`/api/v1/workspaces/${manualWorkspace}/ai/providers`)).json())
        .data.items as PlatformComponents["schemas"]["ProviderDTO"][];
    expect(providers?.map((p) => p.id)).toEqual(providerRows.map((p) => p.id));
    const knownBeta = ownProviders.get(scope.beta);
    expect(providerRows.map((p) => p.id)).toEqual(knownBeta?.map((p) => p.id));
    expect(providerRows.map((p) => p.monthlyBudgetUsd)).toEqual(knownBeta?.map((p) => p.monthlyBudgetUsd));
    const selected = aiEffectItem(knownBeta, 1);
    await selectResourceOption(page.getByRole("combobox", { name: "Provider" }), providerLabel(selected));
    await chooseLanguage(page, "en");
    const refreshed = page.waitForResponse(
        (r) => r.url().endsWith(`/workspaces/${manualWorkspace}/ai/generations`) && r.request().method() === "GET",
    );
    await page.getByRole("button", { name: "Refresh" }).click();
    expect((await refreshed).status()).toBe(200);
    await expect(page.getByRole("combobox", { name: "Provider" })).toContainText(providerLabel(selected));
    await expect(workspacePicker(page)).toHaveAttribute("data-workspace-id", manualWorkspace);
    await page.getByRole("link", { name: "Cases", exact: true }).click();
    await expect(workspacePicker(page)).toHaveAttribute("data-workspace-id", manualWorkspace);
    const returned = aiEffectLists(page, manualWorkspace);
    await page.getByRole("link", { name: "AI", exact: true }).click();
    await returned;
    await expect(workspacePicker(page)).toHaveAttribute("data-workspace-id", manualWorkspace);
    await selectResourceOption(page.getByRole("combobox", { name: "Provider" }), providerLabel(selected));
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
    await selectResourceOption(
        page.getByRole("combobox", { name: "Provider" }),
        providerLabel(aiEffectItem(providerRows)),
    );
    await invalidated();
    await selectResourceOption(page.getByRole("combobox", { name: "Provider" }), providerLabel(selected));
    await preview();
    await selectResourceOption(page.getByRole("combobox", { name: "Purpose" }), "BOUNDARY_SUGGESTION");
    await invalidated();
    await selectResourceOption(page.getByRole("combobox", { name: "Purpose" }), "CASE_DRAFT");
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
    await selectResourceOption(page.getByRole("combobox", { name: "Purpose" }), "BOUNDARY_SUGGESTION");
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
    await acknowledgeOperation(page, "Generation completed. Review the proposed output.");
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
    await expect(
        page
            .getByRole("region", { name: "Call history" })
            .getByRole("table")
            .getByRole("row")
            .filter({ hasText: "BOUNDARY_SUGGESTION" }),
    ).toContainText("SUCCEEDED");
    await expect(page.getByRole("heading", { name: "Exact sanitized context" }).locator("..")).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate with reviewed context" })).toBeDisabled();
    await page
        .getByLabel("Requirement / expected-result basis")
        .fill("REQ-EFFECTS: later invalidation retains completed output.");
    await expect(page.getByRole("heading", { name: "Exact sanitized context" }).locator("..")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Proposed output", level: 3 }).locator("..")).toContainText(
        "SUCCEEDED",
    );
    await expect(
        page
            .getByRole("region", { name: "Call history" })
            .getByRole("table")
            .getByRole("row")
            .filter({ hasText: "BOUNDARY_SUGGESTION" }),
    ).toContainText("SUCCEEDED");
    expect(calls).toBe(priorCalls + 1);
    expect(generationPosts).toBe(1);
});

test("AI generation completion stays in its owning workspace", async ({ page }) => {
    test.setTimeout(90000);
    const scope = await aiEffectScope(page);
    const provider = await aiEffectProvider(page, scope.headers, scope.alpha, 11);
    const firstPage = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
            response.request().method() === "GET" &&
            url.pathname === "/api/v1/workspaces" &&
            !url.searchParams.has("cursor")
        );
    });
    await page.getByRole("link", { name: "AI", exact: true }).click();
    await aiEffectWorkspaces(page, await firstPage, [scope.alpha, scope.beta]);
    if ((await selectedWorkspaceId(page)) !== scope.alpha) {
        const alphaLists = aiEffectLists(page, scope.alpha);
        await chooseWorkspace(page, scope.alpha);
        await alphaLists;
    }
    await expect(page.getByRole("combobox", { name: "Provider" })).toContainText(providerLabel(provider));
    await chooseLanguage(page, "en");
    await selectResourceOption(page.getByRole("combobox", { name: "Purpose" }), "BOUNDARY_SUGGESTION");
    await page.getByLabel("Requirement / expected-result basis").fill("REQ-ALPHA: delayed Alpha requirement.");
    await page.getByRole("button", { name: "Review selected context and estimate" }).click();
    await expect(page.getByRole("button", { name: "Generate with reviewed context" })).toBeEnabled();
    const priorCalls = calls;
    try {
        hold = true;
        await page.getByRole("button", { name: "Generate with reviewed context" }).click();
        await expect.poll(() => calls).toBe(priorCalls + 1);
        await expect.poll(() => typeof release).toBe("function");
        await dismissGenerationWait(page);
        const betaLists = aiEffectLists(page, scope.beta);
        await chooseWorkspace(page, scope.beta);
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
        await expect(workspacePicker(page)).toHaveAttribute("data-workspace-id", scope.beta);
        await expect(page.getByRole("combobox", { name: "Provider" })).toBeDisabled();
        await expect(page.getByLabel("Requirement / expected-result basis")).toHaveValue("");
        await expect(page.getByRole("heading", { name: "Exact sanitized context" }).locator("..")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Generate with reviewed context" })).toHaveCount(0);
        await expect(page.getByRole("heading", { name: "Proposed output", level: 3 }).locator("..")).toHaveCount(0);
        const emptyTable = page.getByRole("region", { name: "Call history" }).getByRole("table");
        await expect(emptyTable.getByRole("columnheader")).toHaveCount(7);
        await expect(emptyTable.getByRole("cell", { name: "No model calls in this Workspace." })).toBeVisible();
        await expect(page.getByRole("alert")).toHaveCount(0);
        expect(calls).toBe(priorCalls + 1);
    } finally {
        release?.();
        hold = false;
    }
});
