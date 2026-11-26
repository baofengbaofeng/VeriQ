/**
 * 使用真实数据库、编译 Agent 与浏览器表单验证计划和服务令牌管理，所有资源由实际发布接口产生，测试不拦截 API 或注入假
 * UI 数据；令牌只在一次性显示区域读取且不写入测试日志。
 */
import { randomUUID } from "node:crypto";
import { chooseLanguage, chooseWorkspace } from "./support/console-controls";
import { installed } from "./support/install-console";
import { test, expect } from "@playwright/test";
import { acknowledgeOperation, editorScope, managedCompiler } from "./editor-fixture";

// 令牌只存在于本次浏览器上下文和实际接口响应中，禁用自动网络跟踪、录像和截图，保留关闭令牌后的人工布局证据。
test.use({ screenshot: "off", trace: "off", video: "off" });

test("plan lifecycle, scoped tokens and report history through actual GUI", async ({ page }, testInfo) => {
    test.setTimeout(240000);
    await installed(page);
    const scope = await editorScope(page, `t16-plans-${randomUUID()}`);
    const base = `/api/v1/workspaces/${scope.workspaceId}`;

    // 编译任务已迁入服务端，测试独立通过注册接口准备实际持久化的云端设备；不启动测试浏览器引擎或伪造运行结果。
    const enrollmentAccount = await page.request.post(base + "/service-accounts", {
        headers: scope.headers,
        data: { name: "Enrollment fixture" },
    });
    expect(enrollmentAccount.status()).toBe(201);
    const accountId: string = (await enrollmentAccount.json()).data.id;
    const enrollment = await page.request.post(`${base}/service-accounts/${accountId}/tokens`, {
        headers: scope.headers,
        data: { purpose: "RUNTIME_ENROLLMENT" },
    });
    expect(enrollment.status()).toBe(201);
    const registered = await page.request.post("/internal/v1/runtime-enrollments/service", {
        headers: { Authorization: `Bearer ${(await enrollment.json()).data.token}` },
        data: {
            name: "Plan browser fixture",
            sharedWithWorkspace: true,
            capabilities: { engineVersion: "0.1.0", os: "linux", arch: "x64", browsers: ["chromium"] },
        },
    });
    expect(registered.status()).toBe(201);
    const runtimeId: string = (await registered.json()).data.runnerId;
    const trusted = await page.request.put(`${base}/runtimes/${runtimeId}/trust`, {
        headers: scope.headers,
        data: { trustStatus: "MANAGED", allowCredentialDelivery: true },
    });
    expect(trusted.status()).toBe(200);
    const compiler = await managedCompiler(page, scope, "t16");
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
                await page.request.get(base + "/jobs/" + (await queued.json()).data.id + "/validation-receipt")
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
            elements: [{ key: "name", locator: { by: "veriqId", value: "name" } }],
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
        await chooseWorkspace(page, scope.workspaceId);
        await page.getByRole("textbox", { name: "Plan name", exact: true }).fill("Scheduled GUI smoke");
        await page.getByRole("combobox", { name: "Suite resource", exact: true }).click();
        await page.getByRole("option", { name: suite.resource.name, exact: true }).click();
        await page.getByRole("combobox", { name: "Suite version", exact: true }).click();
        await page.getByRole("option", { name: new RegExp(suite.version.id + "$") }).click();
        await page.getByRole("combobox", { name: "Environment resource", exact: true }).click();
        await page.getByRole("option", { name: environment.resource.name, exact: true }).click();
        await page.getByRole("combobox", { name: "Environment version", exact: true }).click();
        await page.getByRole("option", { name: new RegExp(environment.version.id + "$") }).click();
        await page
            .getByRole("group", { name: "Runtimes" })
            .getByRole("checkbox", { name: "Plan browser fixture · Managed", exact: true })
            .check();
        const variables = page.getByRole("textbox", { name: "Plan variables", exact: true });
        await variables.fill("{");
        await page.getByRole("button", { name: "Save plan", exact: true }).click();
        await acknowledgeOperation(page, "Plan variables must be valid JSON.", "failed");
        await expect(variables).toHaveValue("{");
        await variables.fill("{}");
        const saved = page.waitForResponse(
            (r) => r.url().endsWith("/execution-plans") && r.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Save plan", exact: true }).click();
        const saveResponse = await saved;
        expect(saveResponse.status(), await saveResponse.text()).toBe(201);
        await acknowledgeOperation(page, "Execution plan created.");
        const plan = (await saveResponse.json()).data;
        const plans = page.getByRole("table", { name: "Plan list", exact: true });
        const row = plans
            .getByRole("row")
            .filter({ has: page.getByRole("rowheader", { name: "Scheduled GUI smoke" }) });
        await row.getByRole("button", { name: "Edit", exact: true }).click();
        const { id, workspaceId, archived, ...body } = plan;
        const concurrent = await page.request.put(base + "/execution-plans/" + id, {
            headers: scope.headers,
            data: { ...body, name: "Concurrent update" },
        });
        expect(concurrent.status()).toBe(200);
        await page.getByRole("textbox", { name: "Plan name", exact: true }).fill("Unsaved local update");
        await page.getByRole("button", { name: "Save plan", exact: true }).click();
        await acknowledgeOperation(page, "revision", "failed");
        await expect(page.getByRole("textbox", { name: "Plan name", exact: true })).toHaveValue("Unsaved local update");
        await page.reload();
        await chooseWorkspace(page, scope.workspaceId);
        const updated = plans
            .getByRole("row")
            .filter({ has: page.getByRole("rowheader", { name: "Concurrent update" }) });
        const triggered = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" && response.url().endsWith(`/execution-plans/${id}/trigger`),
        );
        await updated.getByRole("button", { name: "Trigger", exact: true }).click();
        const triggerResponse = await triggered;
        expect(triggerResponse.status(), await triggerResponse.text()).toBe(202);
        const runId: string = (await triggerResponse.json()).data.runId;
        await acknowledgeOperation(page, "Run enqueued.");
        const triggerStatus = page.getByRole("region", { name: "Trigger status", exact: true });
        await expect(triggerStatus).toContainText("Enqueued · Queued · Managed cloud");
        await page.getByRole("textbox", { name: "Service account name", exact: true }).fill("GUI scheduler");
        await page.getByRole("button", { name: "Create account", exact: true }).click();
        await acknowledgeOperation(page, "Service account created.");
        await page
            .getByRole("group", { name: "Allowed plans" })
            .getByRole("checkbox", { name: "Concurrent update" })
            .check();
        await page.getByRole("button", { name: "Issue token", exact: true }).click();
        await acknowledgeOperation(page, "Service token issued.");
        const oneTime = page.getByRole("region", { name: "One-time token" });
        await expect(oneTime).toBeVisible();
        const secretLength = await oneTime.locator("output").evaluate((value) => value.textContent?.length ?? 0);
        await oneTime.getByRole("button", { name: "Dismiss token", exact: true }).click();
        await expect(oneTime).toHaveCount(0);
        expect(secretLength).toBeGreaterThan(40);
        const tokens = page.getByRole("table", { name: "Service tokens", exact: true });
        const token = tokens.getByRole("row").filter({ has: page.getByRole("cell", { name: "Plan execution" }) });
        await token.getByRole("button", { name: "Revoke", exact: true }).click();
        await acknowledgeOperation(page, "Service token revoked.");
        await expect(token.getByRole("cell", { name: "Revoked", exact: true })).toBeVisible();
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: testInfo.outputPath("browser-plan.png") });

        // 同一真实运行应可按本地化词和平台原值定位，切换语言时保持当前选择，关闭报告后再检查真实取消与归档。
        await triggerStatus.getByRole("link", { name: "Run report", exact: true }).click();
        const search = page.getByRole("searchbox", { name: "Search run history", exact: true });
        const history = page.getByRole("table", { name: "Run history", exact: true });
        const run = history.getByRole("row").filter({ has: page.getByRole("button", { name: runId, exact: true }) });
        await expect(run.getByRole("cell", { name: "Managed cloud", exact: true })).toBeVisible();
        await expect(run.getByRole("cell", { name: "Queued", exact: true })).toBeVisible();
        for (const term of ["Managed cloud", "MANAGED_CLOUD"]) {
            await search.fill(term);
            await expect(run).toBeVisible();
        }
        await chooseLanguage(page, "zh");
        const localizedSearch = page.getByRole("searchbox", { name: "搜索运行历史", exact: true });
        await expect(localizedSearch).toHaveValue("MANAGED_CLOUD");
        await localizedSearch.fill("受管云端");
        const localizedHistory = page.getByRole("table", { name: "运行历史", exact: true });
        await expect(localizedHistory.getByRole("button", { name: runId, exact: true })).toBeVisible();
        await chooseLanguage(page, "en");

        const cancelled = await page.request.post(`${base}/runs/${runId}/cancel`, {
            headers: scope.headers,
            data: { reason: "Browser test cleanup" },
        });
        expect(cancelled.ok()).toBe(true);
        await page.goto("/execution-plans");
        await chooseWorkspace(page, scope.workspaceId);
        await updated.getByRole("button", { name: "Archive", exact: true }).click();
        await acknowledgeOperation(page, "Execution plan archived.");
        await expect(updated.getByRole("cell", { name: "Archived", exact: true })).toBeVisible();
        const other = await page.request.post("/api/v1/workspaces", {
            headers: scope.headers,
            data: { key: `t16-other-${randomUUID()}`, name: "T16 other" },
        });
        expect(other.status()).toBe(201);
        await page.reload();
        await chooseWorkspace(page, (await other.json()).data.id);
        await expect(page.getByRole("rowheader", { name: "Concurrent update", exact: true })).toHaveCount(0);
        await expect(oneTime).toHaveCount(0);
        await expect(page.getByRole("textbox", { name: "Plan name", exact: true })).toHaveValue("");
    } finally {
        await compiler.close();
    }
});
