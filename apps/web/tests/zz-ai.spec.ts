import { test, expect } from "@playwright/test";
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
test.beforeAll(async () => {
    model = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        calls++;
        const body = JSON.parse(raw);
        const context = JSON.parse(body.messages[1].content).context;
        if (hold)
            await new Promise<void>((resolve) => {
                release = resolve;
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
    await new Promise<void>((resolve) =>
        model.listen(18890, "127.0.0.1", resolve),
    );
});
test.afterAll(async () => {
    release?.();
    await new Promise<void>((resolve, reject) =>
        model.close((e) => (e ? reject(e) : resolve())),
    );
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
        await page.getByLabel("语言 / Language").selectOption("en");
        await page.getByTestId("ai-name").fill("Local HTTP protocol emulator");
        await page.getByTestId("ai-baseURL").fill("http://127.0.0.1:18890/v1");
        await page.getByTestId("ai-model").fill("emulator");
        await page.getByTestId("ai-key").fill("synthetic-browser-provider-key");
        await page.getByTestId("ai-enabled").check();
        await page.getByTestId("ai-save").click();
        await expect(page.getByTestId("ai-key")).toHaveValue("");
        await expect(page.getByTestId("ai-budget")).toContainText("Available");
        await page.getByTestId("ai-test").click();
        await expect(page.getByTestId("ai-history")).toContainText(
            "CONNECTION_TEST · SUCCEEDED",
        );
        const prior = calls;
        await page
            .getByTestId("ai-prompt")
            .fill(
                "REQ-LOGIN: open the login page. Expected results must cite this requirement.",
            );
        await page.getByTestId("ai-versions").fill(catalogId);
        await page
            .getByTestId("ai-data")
            .fill('{"password":"do-not-send","username":"test-user"}');
        await page.getByTestId("ai-preview").click();
        await expect(page.getByTestId("ai-context")).toContainText("[REDACTED]");
        await expect(page.getByTestId("ai-context")).not.toContainText(
            "do-not-send",
        );
        expect(calls).toBe(prior);
        await page.getByTestId("ai-generate").click();
        await expect(page.getByTestId("ai-review")).toContainText("SUCCEEDED");
        await expect(page.getByTestId("ai-output")).toContainText(
            "Requirement-backed draft",
        );
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
        await expect(page.locator("body")).not.toContainText(
            "synthetic-browser-provider-key",
        );
        const other = await page.request.post("/api/v1/workspaces", {
            headers: scope.headers,
            data: { key: "ai-other", name: "Other AI Workspace" },
        });
        expect(other.status()).toBe(201);
        await page.reload();
        await page
            .getByTestId("ai-workspace")
            .selectOption((await other.json()).data.id);
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
        await page.getByLabel("语言 / Language").selectOption("en");
        await page.getByTestId("ai-resource").fill(resourceId);
        await page
            .getByTestId("ai-prompt")
            .fill(
                "REQ-1: revise the existing CASE title based on this reviewed requirement.",
            );
        const generate = async () => {
            await page.getByTestId("ai-preview").click();
            await expect(page.getByTestId("ai-generate")).toBeEnabled();
            const response = page.waitForResponse(
                (r) =>
                    r.url().endsWith("/ai/generations") &&
                    r.request().method() === "POST",
            );
            await page.getByTestId("ai-generate").click();
            expect((await response).status()).toBe(201);
            await expect(page.getByTestId("ai-review")).toContainText("SUCCEEDED");
        };
        await generate();
        // Do not fill new-resource fields: acceptance of an existing target needs only its revision.
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
            await (
                await page.request.get(base + "/resources/" + resourceId + "/draft")
            ).json()
        ).data;
        expect(draft.revision).toBe(2);
        expect(draft.content.document.title).toBe("Requirement-backed draft");
        expect(
            (
                await (await page.request.get(base + "/resources?kind=CASE")).json()
            ).data.items.map((r: { id: string }) => r.id),
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
        const updated = await page.request.put(
            base + "/resources/" + resourceId + "/draft",
            { headers: scope.headers, data: { revision: 2, content: concurrent } },
        );
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
            await (
                await page.request.get(base + "/resources/" + resourceId + "/draft")
            ).json()
        ).data;
        expect(draft.revision).toBe(3);
        expect(draft.content.document.title).toBe("Concurrent human revision");
        expect(
            (
                await (await page.request.get(base + "/resources?kind=CASE")).json()
            ).data.items.map((r: { id: string }) => r.id),
        ).toEqual([resourceId]);
    } finally {
        await compiler.close();
    }
});
