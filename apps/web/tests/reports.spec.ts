import { chooseLanguage, workspacePicker } from "./support/console-controls";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { PlatformComponents } from "@veriq/contracts";
test("reports show real Workspace history and clear scope on switch", async ({ page }) => {
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
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const headers = {
        Origin: "http://127.0.0.1:5173",
        "X-CSRF-Token": session.csrfToken,
    };
    const a = await page.request.post("/api/v1/workspaces", {
        headers,
        data: { key: "reports-a", name: "Reports A" },
    });
    const b = await page.request.post("/api/v1/workspaces", {
        headers,
        data: { key: "reports-b", name: "Reports B" },
    });
    expect(a.status()).toBe(201);
    expect(b.status()).toBe(201);
    await page.getByRole("link", { name: "Reports", exact: true }).click();
    await chooseLanguage(page, "en");
    await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
    await workspacePicker(page).selectOption((await a.json()).data.id);
    await expect(page.getByText("No runs in this Workspace.", { exact: true })).toBeVisible();
    await workspacePicker(page).selectOption((await b.json()).data.id);
    await expect(page.getByText("No runs in this Workspace.", { exact: true })).toBeVisible();
    await expect(page.getByText("Select a run to inspect its report.", { exact: true })).toBeVisible();
});

/**
 * 工作区选择回归只创建真实账户空间并读取真实游标分页，不构造 Run、Attempt 或报告数据；因此它能覆盖 URL 与手动选择，却
 * 不能代替受管理引擎产生的订阅和历史验收。
 */
async function reportSession(page: Page) {
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
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    return { Origin: "http://127.0.0.1:5173", "X-CSRF-Token": session.csrfToken };
}

test("reports discover URL workspace on a later genuine page and retain manual choice", async ({ page }) => {
    test.setTimeout(90_000);
    const headers = await reportSession(page);
    for (let index = 0; index < 26; index += 1) {
        const response = await page.request.post("/api/v1/workspaces", {
            headers,
            data: { key: `reports-page-${randomUUID()}`, name: `Report pagination ${index}` },
        });
        expect(response.status()).toBe(201);
    }
    type WorkspacePage = PlatformComponents["schemas"]["WorkspaceDTOPageEnvelope"]["data"];
    const firstResponse = await page.request.get("/api/v1/workspaces");
    expect(firstResponse.status()).toBe(200);
    const first: WorkspacePage = (await firstResponse.json()).data;
    if (!first.nextCursor || !first.items.length) throw new Error("Expected genuine workspace pagination");
    const secondResponse = await page.request.get("/api/v1/workspaces", {
        params: { cursor: first.nextCursor },
    });
    expect(secondResponse.status()).toBe(200);
    const second: WorkspacePage = (await secondResponse.json()).data;
    const target = second.items[0];
    const fallback = first.items[0];
    if (!target || !fallback) throw new Error("Expected two populated workspace pages");
    const selector = workspacePicker(page);
    // 从会话打开指定 Run 时需要直接验证第二页的工作区，未知 Run 本身仍由真实报告接口拒绝，不能退回别的工作区。
    const missingRun = randomUUID();
    const runPath = `/workspaces/${target.id}/runs/${missingRun}`;
    const lookup = page.waitForResponse(
        (response) =>
            response.url().endsWith(runPath + "/report") || response.url().endsWith(runPath + "/events/stream"),
    );
    await page.goto(`/reports?workspaceId=${target.id}&runId=${missingRun}`);
    await expect(selector).toHaveValue(target.id);
    expect((await lookup).status()).toBe(404);
    await page.goto(`/reports?workspaceId=${target.id}`);
    await expect(selector).toHaveValue(fallback.id);
    await page.getByRole("button", { name: "More Workspaces", exact: true }).click();
    await expect(selector).toHaveValue(target.id);
    await selector.selectOption(fallback.id);
    await chooseLanguage(page, "en");
    await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
    await expect(selector).toHaveValue(fallback.id);
    // 同一个真实列表还覆盖首屏可见目标和缺失目标，页面导航新建选择生命周期；不能假设创建顺序就是服务端排序，所有目标与
    // 回退项均来自刚读取的 API 分页。
    await page.goto(`/reports?workspaceId=${fallback.id}`);
    await expect(selector).toHaveValue(fallback.id);
    const other = first.items.find((item) => item.id !== fallback.id);
    if (!other) throw new Error("Expected a manual alternative workspace");
    await selector.selectOption(other.id);
    await chooseLanguage(page, "zh");
    const localizedSelector = workspacePicker(page);
    await expect(localizedSelector).toHaveValue(other.id);
    await page.goto(`/reports?workspaceId=${randomUUID()}`);
    await expect(localizedSelector).toHaveValue(fallback.id);
});
