/** 使用真实数据库、编译 Agent 与浏览器表单验证计划和服务令牌管理，所有资源由实际发布接口产生，测试不拦截 API 或注入假 UI 数据；令牌只在一次性显示区域读取且不写入测试日志。 */
import { test, expect } from "@playwright/test";
import { editorScope, managedCompiler } from "./editor-fixture";

test("plans create, revision conflict, trigger and scoped token lifecycle through actual GUI", async ({
    page,
}) => {
    test.setTimeout(240000);
    const setup = (await (await page.request.get("/api/v1/setup")).json()).data;
    if (!setup.initialized) {
        const response = await page.request.post("/api/v1/setup", {
            headers: { Origin: "http://127.0.0.1:5173", "X-CSRF-Token": setup.csrfToken },
            data: {
                installationSecret: "browser-operator-secret",
                email: "browser-admin@example.com",
                displayName: "Browser Administrator",
                password: "Browser password 123!",
            },
        });
        expect(response.status()).toBe(201);
    }
    const scope = await editorScope(page, "t16-plans"),
        compiler = await managedCompiler(page, scope, "t16");
    const base = `/api/v1/workspaces/${scope.workspaceId}`;
    async function publish(kind: string, key: string, document: unknown) {
        const created = await page.request.post(base + "/resources", {
            headers: scope.headers,
            data: { kind, key, name: key, content: { kind, document } },
        });
        expect(created.status(), await created.text()).toBe(201);
        const resource = (await created.json()).data,
            path = base + "/resources/" + resource.id;
        const preview = (await (await page.request.get(path + "/validation-preview")).json()).data;
        const queued = await page.request.post(path + "/validate", {
            headers: scope.headers,
            data: { revision: preview.revision, sourceHash: preview.sourceHash },
        });
        expect(queued.status()).toBe(202);
        await compiler.compile();
        const receipt = (
            await (
                await page.request.get(
                    base + "/jobs/" + (await queued.json()).data.id + "/validation-receipt",
                )
            ).json()
        ).data;
        const published = await page.request.post(path + "/publish", {
            headers: scope.headers,
            data: { revision: preview.revision, validationReceiptId: receipt.id },
        });
        expect(published.status(), await published.text()).toBe(201);
        return { resource, version: (await published.json()).data };
    }
    try {
        const catalog = await publish("ELEMENT_CATALOG", "catalog", {
            schemaVersion: "1.0",
            elements: [{ key: "name", locator: { by: "testId", value: "name" } }],
        });
        const caseVersion = await publish("CASE", "case", {
            schemaVersion: "1.0",
            caseKey: "case",
            title: "Plan case",
            kind: "READ",
            roleKey: "reader",
            catalogVersionId: catalog.version.id,
            steps: [{ id: "open", action: "goto", path: "/" }],
        });
        const suite = await publish("SUITE", "suite", {
            schemaVersion: "1.0",
            cases: [{ versionId: caseVersion.version.id }],
        });
        const secret = (
            await (
                await page.request.post(base + "/credentials", {
                    headers: scope.headers,
                    data: {
                        secretRef: "reader",
                        value: { token: "synthetic-ui-ci-secret" },
                        allowedIdentityIds: ["reader"],
                    },
                })
            ).json()
        ).data;
        const adapter = (
            await (
                await page.request.post(base + "/auth-adapters", {
                    headers: scope.headers,
                    data: {
                        configuration: {
                            kind: "HTTP_BEARER",
                            identityPath: "/me",
                            identityPointer: "/id",
                        },
                    },
                })
            ).json()
        ).data;
        const environment = await publish("ENVIRONMENT", "environment", {
            schemaVersion: "1.0",
            baseURL: "https://business.test",
            apiBaseURL: "https://business.test",
            allowedOrigins: ["https://business.test"],
            locale: "en-US",
            timezone: "UTC",
            roles: [
                {
                    roleKey: "reader",
                    authAdapterVersionId: adapter.versionId,
                    secretRef: "reader",
                    secretVersionId: secret.versionId,
                    allowedIdentityIds: ["reader"],
                },
            ],
        });
        await page.goto("/execution-plans");
        await page.getByLabel("Plan Workspace", { exact: true }).selectOption(scope.workspaceId);
        await page.getByLabel("Plan name", { exact: true }).fill("Scheduled GUI smoke");
        await page.getByLabel("SUITE resource", { exact: true }).selectOption(suite.resource.id);
        await page.getByLabel("SUITE version", { exact: true }).selectOption(suite.version.id);
        await page
            .getByLabel("ENVIRONMENT resource", { exact: true })
            .selectOption(environment.resource.id);
        await page
            .getByLabel("ENVIRONMENT version", { exact: true })
            .selectOption(environment.version.id);
        await page
            .getByRole("group", { name: "执行设备 / Runtimes" })
            .getByRole("checkbox")
            .check();
        const saved = page.waitForResponse(
            (r) => r.url().endsWith("/execution-plans") && r.request().method() === "POST",
        );
        await page.getByRole("button", { name: "保存计划 / Save plan", exact: true }).click();
        const saveResponse = await saved;
        expect(saveResponse.status(), await saveResponse.text()).toBe(201);
        const plan = (await saveResponse.json()).data;
        const row = page.getByRole("region", { name: "Scheduled GUI smoke", exact: true });
        await row.getByRole("button", { name: "编辑 / Edit", exact: true }).click();
        const { id, workspaceId, archived, ...body } = plan;
        const concurrent = await page.request.put(base + "/execution-plans/" + id, {
            headers: scope.headers,
            data: { ...body, name: "Concurrent update" },
        });
        expect(concurrent.status()).toBe(200);
        await page.getByLabel("Plan name", { exact: true }).fill("Unsaved local update");
        await page.getByRole("button", { name: "保存计划 / Save plan", exact: true }).click();
        await expect(page.getByRole("alert")).toContainText("revision");
        await expect(page.getByLabel("Plan name", { exact: true })).toHaveValue(
            "Unsaved local update",
        );
        await page.reload();
        await page.getByLabel("Plan Workspace", { exact: true }).selectOption(scope.workspaceId);
        await page
            .getByRole("region", { name: "Concurrent update", exact: true })
            .getByRole("button", { name: "触发 / Trigger", exact: true })
            .click();
        await expect(page.getByRole("region", { name: "Trigger status" })).toContainText(
            "ENQUEUED",
        );
        await page.getByLabel("Service account name", { exact: true }).fill("GUI scheduler");
        await page.getByRole("button", { name: "创建账号 / Create account", exact: true }).click();
        await page
            .getByRole("group", { name: "授权计划 / Allowed plans" })
            .getByRole("checkbox", { name: "Concurrent update" })
            .check();
        await page.getByRole("button", { name: "签发令牌 / Issue token", exact: true }).click();
        const oneTime = page.getByRole("region", { name: "One-time token" });
        await expect(oneTime).toBeVisible();
        const issuedSecret = await oneTime.locator("output").innerText();
        expect(issuedSecret.length).toBeGreaterThan(40);
        await oneTime
            .getByRole("button", { name: "关闭令牌 / Dismiss token", exact: true })
            .click();
        await expect(page.getByText(issuedSecret, { exact: true })).toHaveCount(0);
        const tokens = page
            .getByRole("region", { name: "Service accounts", exact: true })
            .locator("article");
        await expect(tokens).toContainText("EXECUTION");
        await tokens.getByRole("button", { name: "吊销 / Revoke", exact: true }).click();
        await expect(tokens).toContainText("revoked");
        await page.screenshot({
            path: "../../.superpowers/sdd/veriq-1/evidence/t16/browser-plan.png",
            fullPage: true,
        });
        const other = await page.request.post("/api/v1/workspaces", {
            headers: scope.headers,
            data: { key: "t16-other", name: "T16 other" },
        });
        expect(other.status()).toBe(201);
        await page.reload();
        await page
            .getByLabel("Plan Workspace", { exact: true })
            .selectOption((await other.json()).data.id);
        await expect(
            page.getByRole("region", { name: "Concurrent update", exact: true }),
        ).toHaveCount(0);
        await expect(oneTime).toHaveCount(0);
        await expect(page.getByLabel("Plan name", { exact: true })).toHaveValue("");
    } finally {
        await compiler.close();
    }
});
