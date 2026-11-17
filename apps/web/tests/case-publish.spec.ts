import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import type { ResourceDocumentV1 } from "@veriq/contracts";
import { cleanupCaseProfile, withCleanup } from "./support/case-profile-cleanup";
import {
    editorScope,
    createResource,
    saveDraft,
    applyDocument,
    managedCompiler,
    queueValidation,
    replaceEditorJson,
} from "./editor-fixture";
test.beforeEach(async ({ page }) => {
    const state = (await (await page.request.get("/api/v1/setup")).json()).data;
    if (!state.initialized)
        expect(
            (
                await page.request.post("/api/v1/setup", {
                    headers: {
                        Origin: "http://127.0.0.1:5173",
                        "X-CSRF-Token": state.csrfToken,
                    },
                    data: {
                        installationSecret: "browser-operator-secret",
                        email: "browser-admin@example.com",
                        displayName: "Browser Administrator",
                        password: "Browser password 123!",
                    },
                })
            ).status(),
        ).toBe(201);
});

test("resource forms save a canonical case and publish only after real Agent validation", async ({
    page,
}, testInfo) => {
    test.setTimeout(180_000);
    const origin = "http://127.0.0.1:5173";
    const setup = (await (await page.request.get("/api/v1/setup")).json()).data;
    if (!setup.initialized) {
        const initialized = await page.request.post("/api/v1/setup", {
            headers: { Origin: origin, "X-CSRF-Token": setup.csrfToken },
            data: {
                installationSecret: "browser-operator-secret",
                email: "browser-admin@example.com",
                displayName: "Browser Administrator",
                password: "Browser password 123!",
            },
        });
        expect(initialized.status()).toBe(201);
    }
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const response = await page.request.post("/api/v1/workspaces", {
        headers: { Origin: origin, "X-CSRF-Token": session.csrfToken },
        data: { key: "editor-browser", name: "Editor Browser" },
    });
    expect(response.status()).toBe(201);
    const workspace = (await response.json()).data;
    const profile = await mkdtemp("/tmp/vq11-");
    const command = (args: string[], input = "") =>
        new Promise<{ code: number | null; output: string }>((resolve, reject) => {
            const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--config-dir", profile, ...args], {
                cwd: fileURLToPath(new URL("../../runtime/", import.meta.url)),
                stdio: ["pipe", "pipe", "pipe"],
            });
            let output = "";
            child.stdout.on("data", (d) => (output += String(d)));
            child.stderr.on("data", (d) => (output += String(d)));
            child.on("error", reject);
            child.on("close", (code) => resolve({ code, output }));
            child.stdin.end(input);
        });
    await withCleanup(
        async () => {
            const headers = { Origin: origin, "X-CSRF-Token": session.csrfToken };
            const account = (
                await (
                    await page.request.post(`/api/v1/workspaces/${workspace.id}/service-accounts`, {
                        headers,
                        data: { name: "Editor compiler" },
                    })
                ).json()
            ).data;
            const enrollment = (
                await (
                    await page.request.post(
                        `/api/v1/workspaces/${workspace.id}/service-accounts/${account.id}/tokens`,
                        { headers, data: { purpose: "RUNTIME_ENROLLMENT" } },
                    )
                ).json()
            ).data;
            const enrolled = await command(
                [
                    "enroll-service",
                    "--server",
                    origin,
                    "--name",
                    "Editor managed compiler",
                    "--share-workspace",
                    "--browser-executable",
                    "/usr/bin/chromium",
                ],
                enrollment.token,
            );
            expect(enrolled.code, enrolled.output).toBe(0);
            const device = JSON.parse(await readFile(join(profile, "device.json"), "utf8"));
            expect(
                (
                    await page.request.put(`/api/v1/workspaces/${workspace.id}/runtimes/${device.runnerId}/trust`, {
                        headers,
                        data: { trustStatus: "MANAGED", allowCredentialDelivery: false },
                    })
                ).status(),
            ).toBe(200);
            const compile = async () => {
                const result = await command([
                    "runtime",
                    "start",
                    "--release-dir",
                    fileURLToPath(new URL("../../../.superpowers/cache/t11/release/", import.meta.url)),
                    "--browser-executable",
                    "/usr/bin/chromium",
                    "--once",
                ]);
                expect(result.code, result.output).toBe(0);
            };
            const publish = async () => {
                const queuedResponse = page.waitForResponse(
                    (r) => r.url().endsWith("/validate") && r.request().method() === "POST",
                );
                await page.getByRole("button", { name: "Compile and validate" }).click();
                const queued = await queuedResponse;
                expect(queued.status(), await queued.text()).toBe(202);
                const job = (await queued.json()).data;
                await expect(page.getByRole("button", { name: "Publish version" })).toBeDisabled();
                await compile();
                await expect(
                    page.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} · /),
                ).toBeVisible({
                    timeout: 20_000,
                });
                const status = (
                    await (await page.request.get(`/api/v1/workspaces/${workspace.id}/jobs/${job.id}`)).json()
                ).data;
                expect(status.outcome).toBe("PASSED");
                const publishing = page.waitForResponse(
                    (r) => r.url().endsWith("/publish") && r.request().method() === "POST",
                );
                await page.getByRole("button", { name: "Publish version" }).click();
                const published = await publishing;
                expect(published.status(), await published.text()).toBe(201);
                await expect(page.getByText(/^v\d+ · .+ · .+$/)).toBeVisible();
                return (await published.json()).data;
            };
            await page.goto("/resources");
            await expect(page.getByRole("heading", { name: "Resources", exact: true })).toBeVisible();
            await page.getByLabel("Workspace").selectOption(workspace.id);
            await expect(page.getByText("No resources in this Workspace.")).toBeVisible();
            await page.getByLabel("Kind", { exact: true }).selectOption("ELEMENT_CATALOG");
            await page.getByLabel("Key").fill("catalog");
            await page.getByLabel("Name").fill("Browser catalog");
            await page.getByRole("button", { name: "Create resource" }).click();
            await expect(page.getByRole("article")).toBeVisible();
            await page.getByRole("button", { name: "Save draft" }).click();
            await expect(page.getByText("Saved")).toContainText("Saved");
            const catalog = await publish();
            const metadataResponse = await page.request.get(
                `/api/v1/workspaces/${workspace.id}/resources/${catalog.resourceId}/versions/${catalog.id}` +
                    `/compiled-source`,
            );
            expect(metadataResponse.status()).toBe(200);
            const metadata = (await metadataResponse.json()).data;
            expect(metadata.files.length).toBeGreaterThan(0);
            const file = metadata.files.find((f: { path: string }) => f.path.endsWith(".ts"));
            const sourceBase =
                `/api/v1/workspaces/${workspace.id}/resources/${catalog.resourceId}/versions/` +
                `${catalog.id}/compiled-source`;
            const exactResponse = await page.request.get(sourceBase, {
                params: { path: file.path },
            });
            expect(exactResponse.status()).toBe(200);
            const exact = await exactResponse.body();
            expect(exact.length).toBe(file.sizeBytes);
            expect(createHash("sha256").update(exact).digest("hex")).toBe(file.sha256);
            expect(exactResponse.headers()["content-type"]).toContain("text/plain");
            expect(exactResponse.headers()["x-content-type-options"]).toBe("nosniff");
            for (const path of ["package.json", "../../secrets", "trace.zip", "source/asset-snapshot.json"])
                expect((await page.request.get(sourceBase, { params: { path } })).status()).toBe(404);

            await expect(page.getByLabel("Retained file")).toBeVisible();
            await page.getByLabel("Retained file").selectOption(file.path);
            await expect(
                page
                    .getByRole("heading", { name: "Actual generated TypeScript (read only)" })
                    .locator("..")
                    .locator(".vq-monaco"),
            ).toBeVisible();
            await page.getByLabel("Kind", { exact: true }).selectOption("CASE");
            await page.getByLabel("Key").fill("smoke");
            await page.getByLabel("Name").fill("Smoke case");
            await page.getByRole("button", { name: "Create resource" }).click();
            await expect(page.getByLabel("Catalog version")).toBeVisible();
            await page.getByLabel("Catalog version").selectOption(catalog.id);
            await page.getByRole("button", { name: "Add After assertions" }).click();
            await expect(
                page.getByRole("heading", { name: "After assertions" }).locator("..").getByLabel("Assertion type"),
            ).toHaveValue("ui");
            await page.getByRole("button", { name: "Save draft" }).click();
            await expect(page.getByText("Saved")).toContainText("Saved");
            expect(await page.locator('ul[role="alert"]').count()).toBe(0);
            const version = await publish();
            const files = (
                await (
                    await page.request.get(
                        `/api/v1/workspaces/${workspace.id}/resources/${version.resourceId}/versions/${version.id}` +
                            `/compiled-source`,
                    )
                ).json()
            ).data;
            const generated = files.files.find((f: { path: string }) => f.path.startsWith("cases/"));
            await expect(page.getByLabel("Retained file")).toBeVisible();
            await page.getByLabel("Retained file").selectOption(generated.path);
            await expect(
                page
                    .getByRole("heading", { name: "Actual generated TypeScript (read only)" })
                    .locator("..")
                    .locator(".vq-monaco"),
            ).toContainText("registerCase");
            await page.setViewportSize({ width: 1280, height: 1000 });
            await page.screenshot({
                path: testInfo.outputPath("editor-1280.png"),
                fullPage: true,
            });
        },
        async () => {
            await cleanupCaseProfile(profile, testInfo.outputPath("agent-stops.json"));
        },
    );
});

test("environment manager creates immutable auth and credential versions without echoing secrets", async ({ page }) => {
    const alpha = await editorScope(page, `identity-immutable-${randomUUID()}`);
    await page.goto("/environments");
    await page.getByLabel("Workspace").selectOption(alpha.workspaceId);
    await expect(
        page.getByRole("heading", { name: "Environment identities and credentials" }).locator(".."),
    ).toBeVisible();
    await page.getByLabel("Identity path").fill("/identity");
    await page.getByLabel("Identity pointer").fill("/id");
    await page.getByRole("button", { name: "Create adapter version" }).click();
    await expect(
        page.getByRole("heading", { name: "Authentication adapters" }).locator("..").getByRole("article"),
    ).toContainText("HTTP_BEARER");
    await page.getByLabel("Secret ref").fill("browser_business");
    await page.getByLabel("Allowed identities").fill("reader");
    await page.getByLabel("Bearer token").fill("browser-secret-only-once");
    await page.getByRole("button", { name: "Save credential version" }).click();
    await expect(page.getByRole("heading", { name: "Credential versions" }).locator("..")).toContainText(
        "browser_business",
    );
    await expect(page.getByLabel("Bearer token")).toHaveValue("");
    await expect(page.locator("body")).not.toContainText("browser-secret-only-once");
    await page.getByLabel("Secret ref").fill("browser_business");
    await page.getByLabel("Allowed identities").fill("reader");
    await page.getByLabel("Bearer token").fill("browser-rotated-only-once");
    await page.getByLabel("Operation").selectOption("rotate");
    await page.getByRole("button", { name: "Save credential version" }).click();
    await expect(
        page.getByRole("heading", { name: "Credential versions" }).locator("..").getByRole("article"),
    ).toHaveCount(2);
    await expect(page.getByLabel("Bearer token")).toHaveValue("");
    await expect(page.locator("body")).not.toContainText("browser-rotated-only-once");
    await page
        .getByRole("heading", { name: "Credential versions" })
        .locator("..")
        .getByRole("button", { name: "Revoke" })
        .first()
        .click();
    await expect(page.getByRole("heading", { name: "Credential versions" }).locator("..")).toContainText("REVOKED");
});

/**
 * 使用真实身份管理器和服务端凭证提交验证表单生命周期，认证类型的无关重渲染必须保留未提交输入；旧空间请求已提交但响应尚
 * 未交付时切换空间，随后仅允许原空间显示已保存摘要。
 */
test("identity manager retains scope across rerenders and late credential responses", async ({ page }) => {
    const origin = "http://127.0.0.1:5173";
    const alpha = await editorScope(page, `identity-lifetime-alpha-${randomUUID()}`);
    const betaResponse = await page.request.post("/api/v1/workspaces", {
        headers: alpha.headers,
        data: { key: `identity-lifetime-beta-${randomUUID()}`, name: "Identity lifetime Beta" },
    });
    expect(betaResponse.status()).toBe(201);
    const betaId: string = (await betaResponse.json()).data.id;
    await page.goto("/environments");
    const selector = page.getByLabel("Workspace");
    await selector.selectOption(alpha.workspaceId);
    const manager = page.getByRole("heading", { name: "Environment identities and credentials" }).locator("..");
    await expect(manager).toBeVisible();
    const secretRef = "identity_late";
    const secret = "identity-lifetime-private-value";
    await page.getByLabel("Secret ref").fill(secretRef);
    await page.getByLabel("Allowed identities").fill("reader\nauditor");
    await page.getByLabel("Bearer token").fill(secret);
    await manager.getByRole("combobox", { name: "Type", exact: true }).selectOption("HTTP_SESSION");
    await expect(manager.getByRole("textbox", { name: "Login path" })).toBeVisible();
    await expect(page.getByLabel("Secret ref")).toHaveValue(secretRef);
    await expect(page.getByLabel("Allowed identities")).toHaveValue("reader\nauditor");
    await expect(page.getByLabel("Bearer token")).toHaveValue(secret);
    await manager.getByRole("combobox", { name: "Type", exact: true }).selectOption("HTTP_BEARER");
    await expect(manager.getByRole("textbox", { name: "Login path" })).toHaveCount(0);

    // 仅拦截 Alpha 的同源凭证创建请求并等待真实提交完成，持有原响应直到浏览器确认旧请求被取消；释放时只销毁响应，绝不向
    // 已中止的 Chromium 请求伪造或补发成功。
    const credentialUrl = `${origin}/api/v1/workspaces/${alpha.workspaceId}/credentials`;
    const matches = (url: URL) => url.href === credentialUrl;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    let committed!: (versionId: string) => void;
    const backendCommitted = new Promise<string>((resolve) => {
        committed = resolve;
    });
    let handler: Promise<void> | undefined;
    await page.route(matches, (route) => {
        if (route.request().method() !== "POST") return route.continue();
        handler = (async () => {
            const response = await route.fetch();
            try {
                expect(response.status()).toBe(201);
                const versionId: string = (await response.json()).data.versionId;
                expect(versionId).toBeTruthy();
                committed(versionId);
                await released;
            } finally {
                await response.dispose();
            }
        })();
        return handler;
    });
    let versionId = "";
    try {
        const aborted = page.waitForEvent("requestfailed", {
            predicate: (request) => request.url() === credentialUrl && request.method() === "POST",
        });
        await page.getByRole("button", { name: "Save credential version" }).click();
        versionId = await backendCommitted;
        await selector.selectOption(betaId);
        expect((await aborted).failure()?.errorText).toContain("ERR_ABORTED");
    } finally {
        release();
        try {
            await handler;
        } finally {
            await page.unroute(matches);
        }
    }
    await expect(selector).toHaveValue(betaId);
    await expect(page.getByRole("heading", { name: "Credential versions" }).locator("..")).not.toContainText(secretRef);
    await expect(manager).not.toContainText(versionId);
    await expect(manager).not.toContainText("Credential saved:");
    await expect(manager).not.toContainText(secret);
    await expect(page.getByLabel("Secret ref")).toHaveValue("");
    await expect(page.getByLabel("Allowed identities")).toHaveValue("");
    await expect(page.getByLabel("Bearer token")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Save credential version" })).toBeEnabled();
    await selector.selectOption(alpha.workspaceId);
    await expect(page.getByRole("heading", { name: "Credential versions" }).locator("..")).toContainText(secretRef);
    await expect(page.getByRole("heading", { name: "Credential versions" }).locator("..")).toContainText(versionId);
    await expect(page.getByRole("heading", { name: "Credential versions" }).locator("..")).toContainText(
        "reader, auditor",
    );
    await expect(page.getByLabel("Secret ref")).toHaveValue("");
    await expect(page.getByLabel("Allowed identities")).toHaveValue("");
    await expect(page.getByLabel("Bearer token")).toHaveValue("");
    await expect(manager).not.toContainText("Credential saved:");
    await expect(manager).not.toContainText(secret);
});

test("all eight kinds expose usable typed controls and preserve literal business values", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const workspaceResponse = await page.request.post("/api/v1/workspaces", {
        headers: {
            Origin: "http://127.0.0.1:5173",
            "X-CSRF-Token": session.csrfToken,
        },
        data: { key: "editor-types", name: "Typed editor" },
    });
    expect(workspaceResponse.status()).toBe(201);
    const workspace = (await workspaceResponse.json()).data;
    await page.goto("/resources");
    await page.getByLabel("Workspace").selectOption(workspace.id);
    const kinds = [
        "CASE",
        "ELEMENT_CATALOG",
        "ASSERTION_TEMPLATE",
        "DATASET",
        "FLOW",
        "FIXTURE",
        "SUITE",
        "ENVIRONMENT",
    ];
    for (const kind of kinds) {
        await page.getByLabel("Kind", { exact: true }).selectOption(kind);
        await page.getByLabel("Key").fill("typed_" + kind.toLowerCase());
        await page.getByLabel("Name").fill("Typed " + kind);
        const response = page.waitForResponse((r) => r.url().endsWith("/resources") && r.request().method() === "POST");
        await page.getByRole("button", { name: "Create resource" }).click();
        const created = await response;
        expect(created.status(), await created.text()).toBe(201);
        await expect(
            page.getByRole("article").getByRole("heading", { name: "Typed " + kind + " · " + kind }),
        ).toBeVisible();
        if (kind === "CASE" || kind === "FLOW") {
            await page.getByLabel("Action").first().selectOption("fill");
            await page.getByLabel("Value (bindings allowed)").first().fill("{{data.name}}");
            await page.getByRole("button", { name: "Add Observers" }).click();
            await page.getByLabel("Observer kind").selectOption("dialog");
            await page.getByLabel("Dialog type").selectOption("prompt");
            await page.getByLabel("Handling").selectOption("accept");
            await page.getByLabel("Prompt text").fill("{{vars.answer}}");
            await page.getByLabel("Observer kind").selectOption("newPage");
            await page.getByLabel("Captured page key").fill("detail");
            await page.getByRole("button", { name: "Add After assertions" }).click();
            const assertionPage = page
                .getByRole("heading", { name: "After assertions" })
                .locator("..")
                .getByLabel("Page (omit for original page)");
            if (kind === "FLOW") await assertionPage.fill("detail");
            else await assertionPage.selectOption("detail");
            await expect(assertionPage).toHaveValue("detail");
            await page
                .getByRole("heading", { name: "After assertions" })
                .locator("..")
                .getByLabel("Assertion type")
                .selectOption("eventually");
            await page
                .getByRole("heading", { name: "After assertions" })
                .locator("..")
                .getByLabel("Read-only query path")
                .fill("/status");
            await page
                .getByRole("heading", { name: "After assertions" })
                .locator("..")
                .getByLabel("JSON Pointer (RFC6901)")
                .fill("/ok");
            await page.getByLabel("Observer kind").selectOption("download");
            // 事件观察器不能提供网络响应的正文或请求头，所以提取来源列表必须排除该类观察器；这里使用真实编辑控件核对来
            // 源选项，防止不可执行的引用被保存进用例。
            await page.getByRole("button", { name: "Add Extractions" }).click();
            await expect(
                page
                    .getByRole("heading", { name: "Extractions" })
                    .locator("..")
                    .getByLabel("Network source")
                    .locator("option"),
            ).toHaveCount(0);
            await page
                .getByRole("heading", { name: "Extractions" })
                .locator("..")
                .getByRole("button", { name: "Move row 1 up" })
                .locator("..")
                .getByRole("button", { name: "Remove" })
                .click();
            await page.getByRole("button", { name: "Add Steps" }).click();
            await page.getByLabel("Step ID").nth(1).fill("last");
            await page
                .getByRole("button", { name: "Move row 2 up" })
                .locator("..")
                .getByRole("button", { name: "Remove" })
                .click();
        }
        if (kind === "ELEMENT_CATALOG") {
            await page.getByLabel("Locator").selectOption("role");
            await page.getByLabel("ARIA role").fill("button");
            await page.getByLabel("Accessible name").fill("保存");
            await page.getByLabel("Exact").check();
        }
        if (kind === "ASSERTION_TEMPLATE") {
            await page
                .getByRole("heading", { name: "Template parameter types" })
                .locator("..")
                .getByLabel("Name")
                .fill("expectedName");
            await page.getByRole("button", { name: "Add Template parameter types" }).click();
            await page.getByLabel("Operator").first().selectOption("textEquals");
            await page.getByLabel("Expected", { exact: true }).fill("{{data.expectedName}}");
            await page.getByLabel("Assertion type").first().selectOption("responseField");
            await page.getByLabel("Network source").first().fill("response:save");
            const expectedType = page.getByRole("combobox", {
                name: "Expected value 类型 / Type",
                exact: true,
            });
            await expectedType.selectOption("null");
            await expect(expectedType).toHaveValue("null");
        }
        if (kind === "DATASET") {
            await page.getByLabel("name", { exact: true }).fill("{{literal.notEvaluated()}}");
            await page.getByRole("button", { name: "Add Dataset rows" }).click();
            await page.getByLabel("Row key").nth(1).fill("second");
            await page.getByRole("button", { name: "Set name", exact: true }).click();
        }
        if (kind === "FIXTURE") {
            await page.getByLabel("Cleanup method").selectOption("DELETE");
            await page.getByLabel("TTL seconds").fill("600");
            await page.getByRole("button", { name: "Add schema property" }).first().click();
        }
        if (kind === "SUITE") {
            await page.getByLabel("firefox", { exact: true }).check();
            await page.getByRole("button", { name: "Add Roles" }).click();
            await page.getByRole("textbox", { name: "Roles 1", exact: true }).fill("reader");
        }
        if (kind === "ENVIRONMENT") {
            await page.getByLabel("Frontend URL").fill("https://example.com");
            await page.getByRole("button", { name: "Add Allowed origins" }).click();
            await page
                .getByRole("textbox", {
                    name: "Allowed origins 2",
                    exact: true,
                })
                .fill("https://example.com");
            await page.getByRole("button", { name: "Add Allowed identity IDs" }).click();
            await page
                .getByRole("textbox", {
                    name: "Allowed identity IDs 1",
                    exact: true,
                })
                .fill("reader");
        }
        expect(await page.locator('ul[role="alert"]').count()).toBe(0);
        const saved = page.waitForResponse((r) => r.url().endsWith("/draft") && r.request().method() === "PUT");
        await page.getByRole("button", { name: "Save draft" }).click();
        const result = await saved;
        expect(result.status(), await result.text()).toBe(200);
        const document = (await result.json()).data.content.document;
        if (kind === "DATASET") expect(document.rows[0].values.name).toBe("{{literal.notEvaluated()}}");
        if (kind === "ELEMENT_CATALOG")
            expect(document.elements[0].locator).toEqual({
                by: "role",
                role: "button",
                name: "保存",
                exact: true,
            });
        if (kind === "CASE" || kind === "FLOW")
            expect(document.steps[0].observers[0]).toMatchObject({
                kind: "download",
            });
        await page.getByRole("button", { name: "JSON source" }).click();
        await expect(page.locator(".vq-monaco").first()).toBeVisible();
        await page.getByRole("button", { name: "Visual form" }).click();
    }
});

test("JSON Apply is lossless, blocks unapplied writes, and revision recovery retains local edits", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    const scopeSession = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const ownWorkspaceResponse = await page.request.post("/api/v1/workspaces", {
        headers: {
            Origin: "http://127.0.0.1:5173",
            "X-CSRF-Token": scopeSession.csrfToken,
        },
        data: { key: "editor-json", name: "JSON editor" },
    });
    expect(ownWorkspaceResponse.status()).toBe(201);
    const ownWorkspace = (await ownWorkspaceResponse.json()).data;
    await page.goto("/resources");
    await page.getByLabel("Workspace").selectOption(ownWorkspace.id);
    await page.getByLabel("Kind", { exact: true }).selectOption("ELEMENT_CATALOG");
    await page.getByLabel("Key").fill("conflict_catalog");
    await page.getByLabel("Name").fill("Conflict catalog");
    const creation = page.waitForResponse((r) => r.url().endsWith("/resources") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Create resource" }).click();
    const resource = (await (await creation).json()).data;
    await expect(page.getByLabel("Element key")).toBeVisible();
    const source = {
        kind: "ELEMENT_CATALOG",
        document: {
            schemaVersion: "1.0",
            elements: [
                {
                    key: "literal",
                    locator: {
                        by: "role",
                        role: "button",
                        name: "{{data.label}}",
                        exact: false,
                    },
                    scope: "scope",
                    recordKey: "{{vars.record}}",
                },
                { key: "scope", locator: { by: "veriqId", value: "scope" } },
            ],
        },
    };
    await page.getByRole("button", { name: "JSON source" }).click();
    const replaceJson = async (text: string) => {
        await replaceEditorJson(page, text);
    };
    await replaceJson(JSON.stringify(source, null, 2));
    await expect(page.getByText("Unapplied JSON changes")).toBeVisible();
    let writes = 0;
    const record = (request: import("@playwright/test").Request) => {
        if (request.method() === "PUT" && request.url().endsWith("/draft")) writes++;
    };
    page.on("request", record);
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.locator('div[role="alert"]')).toContainText("尚未应用");
    expect(writes).toBe(0);
    await page.getByRole("button", { name: "Apply JSON" }).click();
    await expect(page.getByText("Unapplied JSON changes")).toHaveCount(0);
    await page.getByRole("button", { name: "Visual form" }).click();
    await expect(page.getByLabel("Accessible name")).toHaveValue("{{data.label}}");
    await expect(page.getByLabel("Exact")).not.toBeChecked();
    const saving = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/draft"));
    await page.getByRole("button", { name: "Save draft" }).click();
    const draft = (await (await saving).json()).data;
    expect(draft.content).toEqual(source);
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const base = `/api/v1/workspaces/${resource.workspaceId}/resources/${resource.id}`;
    const changed = await page.request.put(base + "/draft", {
        headers: {
            Origin: "http://127.0.0.1:5173",
            "X-CSRF-Token": session.csrfToken,
        },
        data: {
            revision: draft.revision,
            content: {
                ...source,
                document: {
                    ...source.document,
                    elements: source.document.elements.map((e, i) => (i ? e : { ...e, recordKey: "remote" })),
                },
            },
        },
    });
    expect(changed.status()).toBe(200);
    await page.getByLabel("Record key").fill("local");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("heading", { name: "The remote draft changed" }).locator("..")).toBeVisible();
    await expect(page.getByLabel("Record key")).toHaveValue("local");
    await page.getByRole("button", { name: "Keep local content with remote revision" }).click();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Saved")).toContainText("Saved");
    const retained = (await (await page.request.get(base + "/draft")).json()).data;
    expect(retained.content.document.elements[0].recordKey).toBe("local");
    expect(retained.revision).toBe(draft.revision + 2);
    page.off("request", record);
    const second = await page.request.post("/api/v1/workspaces", {
        headers: {
            Origin: "http://127.0.0.1:5173",
            "X-CSRF-Token": session.csrfToken,
        },
        data: { key: "editor-isolation", name: "Editor isolation" },
    });
    expect(second.status()).toBe(201);
    await page.goto("/resources");
    const secondWorkspace = (await second.json()).data;
    await expect(page.getByLabel("Workspace").locator(`option[value="${secondWorkspace.id}"]`)).toHaveText(
        "Editor isolation",
    );
    await page.getByLabel("Workspace").selectOption(ownWorkspace.id);
    await page.getByRole("button", { name: "conflict_catalog" }).click();
    await page.getByRole("button", { name: "JSON source" }).click();
    await replaceJson("{ invalid");
    await page.getByRole("button", { name: "Apply JSON" }).click();
    await expect(page.locator('div[role="alert"]')).toBeVisible();
    await page.getByLabel("Workspace").selectOption(secondWorkspace.id);
    await expect(page.getByRole("article")).toHaveCount(0);
    await expect(page.getByText("Unapplied JSON changes")).toHaveCount(0);
    await expect(page.getByText("No resources in this Workspace.")).toBeVisible();
});

test("fixture binding picker exposes declared initial variables without future outputs", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const response = await page.request.post("/api/v1/workspaces", {
        headers: {
            Origin: "http://127.0.0.1:5173",
            "X-CSRF-Token": session.csrfToken,
        },
        data: { key: "editor-bindings", name: "Binding editor" },
    });
    expect(response.status()).toBe(201);
    const workspace = (await response.json()).data;
    await page.goto("/resources");
    await page.getByLabel("Workspace").selectOption(workspace.id);
    await page.getByLabel("Kind", { exact: true }).selectOption("CASE");
    await page.getByLabel("Key").fill("bindings");
    await page.getByLabel("Name").fill("Binding source");
    await page.getByRole("button", { name: "Create resource" }).click();
    await page
        .getByRole("heading", { name: "Initial variable declarations" })
        .locator("..")
        .getByLabel("Name")
        .fill("initialAnswer");
    await page.getByRole("button", { name: "Add Initial variable declarations" }).click();
    await page
        .getByRole("textbox", {
            name: "Fixture input bindings 字段名 / Field name",
            exact: true,
        })
        .fill("answer");
    await page.getByRole("article").getByRole("button", { name: "Add field", exact: true }).first().click();
    const picker = page.getByRole("combobox", {
        name: "Fixture input bindings.answer 插入绑定 / Insert binding",
        exact: true,
    });
    await expect(picker).toBeVisible();
    await expect(picker.locator("option")).toHaveText(["Select binding", "{{vars.initialAnswer}}"]);
    await picker.selectOption("{{vars.initialAnswer}}");
    await expect(
        page.getByRole("textbox", {
            name: "Fixture input bindings.answer",
            exact: true,
        }),
    ).toHaveValue("{{vars.initialAnswer}}");
});

test("T11-R1 schema add/remove/add preserves existing property constraints", async ({ page }) => {
    await editorScope(page, "fix1-schema");
    await createResource(page, "FIXTURE", "schema-survivor");
    const section = page.getByRole("heading", { name: "Input schema", exact: true }).locator("..");
    await section
        .getByRole("button", {
            name: "Add schema property",
            exact: true,
        })
        .click();
    await section
        .getByRole("button", {
            name: "Add schema property",
            exact: true,
        })
        .click();
    await page
        .getByRole("combobox", {
            name: "Input schema.field_2 type",
            exact: true,
        })
        .selectOption("integer");
    const initial = await saveDraft(page);
    if (initial.content.kind !== "FIXTURE") throw new Error("Expected fixture");
    const surviving = {
        type: "integer",
        minimum: 7,
        maximum: 31,
        description: "Keep this contract",
    };
    await applyDocument(page, {
        ...initial.content,
        document: {
            ...initial.content.document,
            inputSchema: {
                type: "object",
                properties: { field_1: { type: "string" }, field_2: surviving },
                required: ["field_2"],
            },
        },
    });
    const first = page
        .getByRole("textbox", {
            name: "Input schema property field_1",
            exact: true,
        })
        .locator("..")
        .locator("..");
    await first.getByRole("button", { name: "Remove", exact: true }).click();
    await section
        .getByRole("button", {
            name: "Add schema property",
            exact: true,
        })
        .click();
    const saved = await saveDraft(page);
    if (saved.content.kind !== "FIXTURE") throw new Error("Expected fixture");
    expect(saved.content.document.inputSchema).toMatchObject({
        type: "object",
        properties: { field_2: surviving },
        required: ["field_2"],
    });
    expect(Object.keys(saved.content.document.inputSchema.properties as object)).toHaveLength(2);
});

test("T11-R2 BEFORE and AFTER observer choices match actual compiler phases", async ({ page }) => {
    test.setTimeout(180_000);
    const scope = await editorScope(page, "fix1-phases");
    const compiler = await managedCompiler(page, scope);
    try {
        await createResource(page, "ELEMENT_CATALOG", "phase-catalog");
        await saveDraft(page);
        const catalog = await compiler.publish();
        await createResource(page, "CASE", "phase-case");
        await page.getByLabel("Catalog version").selectOption(catalog.id);
        await page.getByLabel("Action").first().selectOption("apiRequest");
        await page.getByLabel("Origin-relative path").first().fill("/status");
        await page.getByRole("button", { name: "Add Observers" }).click();
        await page.getByLabel("Observer ID").fill("save");
        await page.getByLabel("Exact path").fill("/status");
        await page.getByRole("button", { name: "Add Before assertions" }).click();
        const before = page
            .getByRole("heading", { name: "Before assertions" })
            .locator("..")
            .getByLabel("Assertion type");
        const types = await before
            .locator("option")
            .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
        expect(types).not.toContain("httpStatus");
        expect(types).not.toContain("responseField");
        expect(types).not.toContain("requestCount");
        await before.selectOption("url");
        await page.getByRole("button", { name: "Add After assertions" }).click();
        await page
            .getByRole("heading", { name: "After assertions" })
            .locator("..")
            .getByLabel("Assertion type")
            .selectOption("httpStatus");
        await expect(
            page
                .getByRole("heading", { name: "After assertions" })
                .locator("..")
                .getByLabel("Network source")
                .locator("option"),
        ).toHaveText(["response:save"]);
        await page
            .getByRole("heading", { name: "After assertions" })
            .locator("..")
            .getByLabel("Network source")
            .selectOption("response:save");
        await saveDraft(page);
        const version = await compiler.publish();
        expect(version.content.kind).toBe("CASE");
    } finally {
        await compiler.close();
    }
});

test("T11-R3 reusable flow/template page keys round-trip and resolve only in caller scope", async ({ page }) => {
    test.setTimeout(240_000);
    const scope = await editorScope(page, "fix1-pages");
    const compiler = await managedCompiler(page, scope);
    try {
        await createResource(page, "ELEMENT_CATALOG", "page-catalog");
        await saveDraft(page);
        const catalog = await compiler.publish();
        await createResource(page, "FLOW", "caller-flow");
        await page.getByLabel("Action").first().selectOption("click");
        await page.getByLabel("Action page").first().fill("detail");
        const flowSource: ResourceDocumentV1 = {
            kind: "FLOW",
            document: {
                schemaVersion: "1.0",
                steps: [
                    { id: "caller", action: "click", target: "name", pageKey: "detail" },
                    {
                        id: "capture",
                        action: "click",
                        target: "name",
                        pageKey: "detail",
                        observers: [{ id: "local", kind: "newPage", pageKey: "inside" }],
                    },
                    {
                        id: "local-child",
                        action: "click",
                        target: "name",
                        pageKey: "inside",
                    },
                ],
            },
        };
        await applyDocument(page, flowSource);
        await expect(page.getByLabel("Action page").first()).toHaveValue("detail");
        const flowDraft = await saveDraft(page);
        expect(flowDraft.content).toEqual(flowSource);
        const flow = await compiler.publish();
        await createResource(page, "ASSERTION_TEMPLATE", "caller-template");
        await page.getByLabel("Page (omit for original page)").first().fill("detail");
        const templateSource: ResourceDocumentV1 = {
            kind: "ASSERTION_TEMPLATE",
            document: {
                schemaVersion: "1.0",
                assertions: [
                    {
                        id: "visible",
                        type: "ui",
                        target: "name",
                        pageKey: "detail",
                        operator: "visible",
                        expected: true,
                        severity: "BLOCK",
                        expectedSource: "REQ caller page",
                    },
                ],
            },
        };
        await applyDocument(page, templateSource);
        await expect(page.getByLabel("Page (omit for original page)").first()).toHaveValue("detail");
        expect((await saveDraft(page)).content).toEqual(templateSource);
        const template = await compiler.publish();
        await createResource(page, "CASE", "caller-case");
        const callerSource: ResourceDocumentV1 = {
            kind: "CASE",
            document: {
                schemaVersion: "1.0",
                caseKey: "caller-case",
                title: "Caller pages",
                kind: "READ",
                roleKey: "reader",
                catalogVersionId: catalog.id,
                steps: [
                    {
                        id: "capture",
                        action: "click",
                        target: "name",
                        observers: [{ id: "popup", kind: "newPage", pageKey: "detail" }],
                    },
                    {
                        id: "flow",
                        action: "callFlow",
                        versionId: flow.id,
                        afterAssertions: [
                            {
                                id: "template",
                                type: "template",
                                versionId: template.id,
                                severity: "BLOCK",
                                expectedSource: "REQ caller scope",
                            },
                        ],
                    },
                    {
                        id: "after-flow",
                        action: "click",
                        target: "name",
                        pageKey: "detail",
                    },
                ],
            },
        };
        await applyDocument(page, callerSource);
        const callerPages = page.getByLabel("Action page").nth(2);
        await expect(callerPages).toHaveValue("detail");
        expect(
            await callerPages
                .locator("option")
                .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
        ).toEqual(["", "detail"]);
        expect((await saveDraft(page)).content).toEqual(callerSource);
        await compiler.publish();
        // 导入文档里的未解析引用仍应以原始标识清晰显示在编辑器中，不能把它冒充为当前空间已有页面；断言保留引用值以便用
        // 户后续通过支持的真实资产流程修复。
        const invalid: ResourceDocumentV1 = {
            ...callerSource,
            document: {
                ...callerSource.document,
                steps: [
                    callerSource.document.steps[0],
                    ...callerSource.document.steps.slice(1, 2),
                    {
                        id: "after-flow",
                        action: "click",
                        target: "name",
                        pageKey: "inside",
                    },
                ],
            },
        };
        await applyDocument(page, invalid);
        await expect(page.getByLabel("Action page").nth(2)).toHaveValue("inside");
        await expect(page.getByLabel("Action page").nth(2).locator("option:checked")).toContainText("inside");
        await saveDraft(page);
        const failed = await queueValidation(page);
        await compiler.compile();
        await expect
            .poll(
                async () =>
                    (await (await page.request.get(`/api/v1/workspaces/${scope.workspaceId}/jobs/${failed.id}`)).json())
                        .data.outcome,
            )
            .toBe("ERROR");
        expect(
            (
                await page.request.get(`/api/v1/workspaces/${scope.workspaceId}/jobs/${failed.id}/validation-receipt`)
            ).status(),
        ).toBe(409);
        await expect(page.getByRole("button", { name: "Publish version" })).toBeDisabled();
    } finally {
        await compiler.close();
    }
});

test("T11-R4 delayed real J1 receipt cannot validate a saved candidate or queued J2", async ({ page }) => {
    test.setTimeout(180_000);
    const scope = await editorScope(page, "fix1-receipt");
    const compiler = await managedCompiler(page, scope);
    let release!: () => void;
    let held!: () => void;
    let delivered!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve)),
        delivery = new Promise<void>((resolve) => (delivered = resolve)),
        released = new Promise<void>((resolve) => (release = resolve));
    let heldJob = "";
    const receiptPath = `**/api/v1/workspaces/${scope.workspaceId}/jobs/*/validation-receipt`;
    await page.route(receiptPath, async (route) => {
        if (!route.request().url().includes(`/jobs/${heldJob}/`)) return route.continue();
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        held();
        await released;
        if (route.request().failure()) await response.dispose();
        else await route.fulfill({ response });
        delivered();
    });
    try {
        await createResource(page, "ELEMENT_CATALOG", "receipt-catalog");
        const firstDraft = await saveDraft(page);
        const j1 = await queueValidation(page);
        heldJob = j1.id;
        await compiler.compile();
        await holding;
        await page.getByLabel("veriqId").fill("next-revision");
        const next = await saveDraft(page);
        expect(next.revision).toBe(firstDraft.revision + 1);
        const j2 = await queueValidation(page);
        expect(j2.id).not.toBe(j1.id);
        release();
        await delivery;
        // 等待下一次真实 J2 状态轮询返回后再核对界面，使旧请求的回调已经获得完整的浏览器与渲染调度机会，避免仅凭切换后
        // 立即出现的新内容误判迟到响应已被隔离。
        await page.waitForResponse((response) => response.url().endsWith(`/jobs/${j2.id}`));
        await expect(page.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} · /)).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Publish version" })).toBeDisabled();
        await page.unroute(receiptPath);
        await compiler.compile();
        await expect(page.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} · /)).toBeVisible({
            timeout: 20_000,
        });
        const receipt = (
            await (
                await page.request.get(`/api/v1/workspaces/${scope.workspaceId}/jobs/${j2.id}/validation-receipt`)
            ).json()
        ).data;
        expect(receipt.revision).toBe(next.revision);
        await expect(page.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} · /)).toContainText(
            receipt.id,
        );
        await expect(page.getByRole("button", { name: "Publish version" })).toBeEnabled();
        if (next.content.kind !== "ELEMENT_CATALOG") throw new Error("Expected catalog");
        await applyDocument(page, {
            ...next.content,
            document: {
                ...next.content.document,
                elements: [{ key: "name", locator: { by: "veriqId", value: "applied-only" } }],
            },
        });
        await expect(page.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} · /)).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Publish version" })).toBeDisabled();
    } finally {
        release?.();
        await page.unroute(receiptPath);
        await compiler.close();
    }
});

/**
 * 通过真实资源创建、JSON Apply 和草稿保存观察字符串及混合 JSON 数组，重复值不能合并节点，输入不能重挂载，删除祖先行必
 * 须保留嵌套存活节点，最终正文只能含原始业务值而无私有行标记。
 */
test("primitive rows preserve focused survivors and persist only business values", async ({ page }) => {
    await editorScope(page, `primitive-rows-${randomUUID()}`);
    await createResource(page, "DATASET", `primitive-dataset-${randomUUID()}`);
    const dataset: ResourceDocumentV1 = {
        kind: "DATASET",
        document: {
            schemaVersion: "1.0",
            columns: { payload: "array" },
            rows: [
                {
                    key: "row_1",
                    values: { payload: ["same", "same", "", ["same", "same"], { flag: true }] },
                },
            ],
        },
    };
    await applyDocument(page, dataset);
    const nested = page.getByRole("textbox", { name: "payload[3][1]", exact: true });
    const survivor = await nested.elementHandle();
    if (!survivor) throw new Error("Missing nested primitive row");
    await nested.focus();
    await nested.press("End");
    await nested.pressSequentially(" edited");
    await expect(nested).toHaveValue("same edited");
    expect(await survivor.evaluate((node) => node === document.activeElement)).toBe(true);
    const root = page.getByRole("combobox", { name: "payload 类型 / Type", exact: true }).locator("../..");
    // 原生 click 激活前面的删除按钮而不把键盘焦点移到该按钮，以便直接观察存活输入节点的焦点；不改写 DOM、值或产品事件处
    // 理，增删仍完全经过真实 React 控件。
    await root
        .locator(":scope > div")
        .first()
        .getByRole("button", { name: "Remove 0", exact: true })
        .evaluate((button) => (button as HTMLButtonElement).click());
    const shifted = page.getByRole("textbox", { name: "payload[2][1]", exact: true });
    await expect(shifted).toHaveValue("same edited");
    expect(await shifted.evaluate((node, retained) => node === retained, survivor)).toBe(true);
    expect(await survivor.evaluate((node) => node === document.activeElement)).toBe(true);
    await root.locator(":scope > button").click();
    await root.locator(":scope > div").last().getByRole("button", { name: "Remove 4", exact: true }).click();
    await root.locator(":scope > button").click();
    const expected: ResourceDocumentV1 = {
        ...dataset,
        document: {
            ...dataset.document,
            rows: [
                {
                    key: "row_1",
                    values: { payload: ["same", "", ["same", "same edited"], { flag: true }, ""] },
                },
            ],
        },
    };
    expect((await saveDraft(page)).content).toEqual(expected);
    // 相同长度以及更短、更长的权威导入都开启新行生命周期，不能把旧重复值的标记猜测成新数组身份；每轮都经受支持的 JSON
    // Apply 保存并读取服务端实际草稿。
    for (const payload of [["fresh", "", ["x", "y"], { flag: false }, ""], [], ["a", "b", "c", "d", "e", "f"]]) {
        const replacement: ResourceDocumentV1 = {
            ...dataset,
            document: { ...dataset.document, rows: [{ key: "row_1", values: { payload } }] },
        };
        await applyDocument(page, replacement);
        expect(await survivor.evaluate((node) => node.isConnected)).toBe(false);
        expect((await saveDraft(page)).content).toEqual(replacement);
    }
    await createResource(page, "ENVIRONMENT", `primitive-environment-${randomUUID()}`);
    const environment = (await saveDraft(page)).content;
    if (environment.kind !== "ENVIRONMENT") throw new Error("Expected environment document");
    const origins: [string, ...string[]] = ["http://one.example", "http://two.example", "http://two.example"];
    const [firstRole, ...otherRoles] = environment.document.roles;
    if (!firstRole) throw new Error("Expected environment role");
    await applyDocument(page, {
        ...environment,
        document: { ...environment.document, allowedOrigins: origins, roles: [firstRole, ...otherRoles] },
    });
    const group = page.getByRole("group", { name: "Allowed origins", exact: true });
    const last = group.getByRole("textbox", { name: "Allowed origins 3", exact: true });
    const stringSurvivor = await last.elementHandle();
    if (!stringSurvivor) throw new Error("Missing string row");
    await last.focus();
    await last.press("End");
    await last.pressSequentially("/path");
    await group
        .getByRole("button", { name: "Remove", exact: true })
        .first()
        .evaluate((button) => (button as HTMLButtonElement).click());
    const remaining = group.getByRole("textbox", { name: "Allowed origins 2", exact: true });
    expect(await remaining.evaluate((node, retained) => node === retained, stringSurvivor)).toBe(true);
    expect(await stringSurvivor.evaluate((node) => node === document.activeElement)).toBe(true);
    await group.getByRole("button", { name: "Add Allowed origins" }).click();
    await group.getByRole("button", { name: "Remove", exact: true }).last().click();
    await group.getByRole("button", { name: "Add Allowed origins" }).click();
    await group.getByRole("textbox", { name: "Allowed origins 3", exact: true }).fill("http://three.example");
    expect((await saveDraft(page)).content).toEqual({
        ...environment,
        document: {
            ...environment.document,
            allowedOrigins: ["http://two.example", "http://two.example/path", "http://three.example"],
        },
    });
    await createResource(page, "CASE", `field-labels-${randomUUID()}`);
    // 关联检查跨越文本、枚举、数字、复选框及版本下拉分支，并保留原有测试标识与 RHF 输入；只检查真实
    // input.labels/htmlFor/id，不把可见文字或 aria-label 当作标签关联的替代品。
    for (const label of ["Title", "Case kind", "Timeout", "Critical", "Catalog version"]) {
        expect(
            await page.getByLabel(label).evaluate((element) => {
                const control = element as HTMLInputElement | HTMLSelectElement;
                return (
                    !!control.id && [...(control.labels ?? [])].some((fieldLabel) => fieldLabel.htmlFor === control.id)
                );
            }),
        ).toBe(true);
    }
});
