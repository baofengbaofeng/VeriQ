/**
 * 通过真实控制服务和浏览器验证短期设备登记令牌的签发回执与一次性交付，测试产物关闭跟踪、视频和截图。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { errors, expect, test } from "@playwright/test";
import { acknowledgeOperation, editorScope } from "../editor-fixture";
import { chooseLanguage, chooseWorkspace } from "../support/console-controls";
import { installed } from "../support/install-console";

// 原始凭证只在交付区域使用，通过关闭界面和网络追踪避免测试产物长期保留短期令牌及其原始响应。
test.use({ screenshot: "off", trace: "off", video: "off" });

/**
 * 不需要已发布套件的登记令牌可直接通过真实签发请求验证，回执确认前后分别观察操作说明和受限交付区域。
 */
test("acknowledges enrollment token issuance and dismisses its one-time delivery", async ({ page }) => {
    await installed(page);
    const { workspaceId } = await editorScope(page, `plan-token-${randomUUID()}`);
    await page.goto("/execution-plans");
    await chooseWorkspace(page, workspaceId);
    let releaseCreation = () => {};
    const creation = new Promise<void>((resolve) => {
        releaseCreation = resolve;
    });
    await page.route(`**/api/v1/workspaces/${workspaceId}/service-accounts`, async (route) => {
        if (route.request().method() !== "POST") {
            await route.fallback();
            return;
        }
        await creation;
        await route.continue();
    });
    await page.getByRole("textbox", { name: "Service account name", exact: true }).fill("Enrollment test");
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    try {
        const waiting = page.getByRole("dialog", { name: "Operation in progress", exact: true });
        await expect(waiting).toBeVisible();
        await waiting.evaluate((element) => element.setAttribute("data-test-dialog", "creation"));
    } finally {
        releaseCreation();
    }
    await expect(page.getByRole("dialog", { name: "Operation succeeded", exact: true })).toHaveAttribute(
        "data-test-dialog",
        "creation",
    );
    await acknowledgeOperation(page, "Service account created.");
    await page.getByRole("combobox", { name: "Token purpose", exact: true }).click();
    await page.getByRole("option", { name: "Runtime enrollment", exact: true }).click();
    const issued = page.waitForResponse((response) => {
        return response.request().method() === "POST" && response.url().endsWith("/tokens");
    });
    await page.getByRole("button", { name: "Issue token", exact: true }).press("Enter");
    const issueResponse = await issued;
    expect(issueResponse.status()).toBe(201);
    const tokenId: string = (await issueResponse.json()).data.id;
    const delivery = page.getByRole("region", { name: "One-time token", exact: true });
    const dismiss = delivery.getByRole("button", { name: "Dismiss token", exact: true });
    const result = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
    let confirmed = true;
    try {
        await result.waitFor({ state: "visible" });
    } catch (error) {
        if (!(error instanceof errors.TimeoutError)) throw error;
        confirmed = false;
        // 回归失败时先清除早期实现留下的明文，再抛出断言，避免 Playwright 的诊断快照包含一次性令牌。
        if (await dismiss.isVisible()) await dismiss.press("Enter");
    }
    expect(confirmed).toBe(true);
    await expect(page.getByRole("region", { name: "One-time token", exact: true, includeHidden: true })).toHaveCount(0);
    await acknowledgeOperation(page, "Service token issued.");
    const secretOutput = delivery.locator("output");
    await expect(secretOutput).toBeVisible();
    const issuedSecret = (await secretOutput.textContent())?.trim() ?? "";
    await dismiss.press("Enter");
    await expect(delivery).toHaveCount(0);

    /**
     * 下载只包含列表端点允许展示的元数据。比较布尔结果并立即删除下载，避免失败诊断携带测试凭证。
     */
    const table = page.getByRole("table", { name: "Service tokens", exact: true });
    const wrapper = page.locator(".vq-data-table").filter({ has: table });
    await expect(table.getByRole("rowheader", { name: tokenId, exact: true })).toBeVisible();
    await expect(table.getByRole("cell", { name: "Runtime enrollment", exact: true })).toBeVisible();
    await expect(wrapper.getByRole("combobox", { name: "Rows per page", exact: true })).toBeVisible();
    await expect(wrapper.getByRole("searchbox", { name: "Search service tokens", exact: true })).toBeVisible();
    await expect(wrapper.getByText("Showing 1 to 1 of 1 entries", { exact: true })).toBeVisible();
    const pager = wrapper.getByRole("navigation", { name: "Service tokens", exact: true });
    await expect(pager.getByRole("button", { name: "1", exact: true })).toHaveAttribute("aria-current", "page");
    const downloading = page.waitForEvent("download");
    await wrapper.getByRole("button", { name: "Download", exact: true }).click();
    const download = await downloading;
    let exportsMetadata = false;
    let excludesSecret = false;
    try {
        const csv = await readFile(await download.path(), "utf8");
        exportsMetadata = csv.includes(tokenId) && csv.includes('"Runtime enrollment"');
        excludesSecret = issuedSecret.length > 0 && !csv.includes(issuedSecret);
    } finally {
        await download.delete();
    }
    expect(exportsMetadata).toBe(true);
    expect(excludesSecret).toBe(true);
});

/**
 * 外部调度策略和帮助应跟随当前语言切换，表单同时维持操作员已经选定的协议值和工作区范围。
 */
test("localizes plan policy options and preserves the draft choice", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installed(page);
    const { workspaceId } = await editorScope(page, `plan-options-${randomUUID()}`);
    await page.goto("/execution-plans");
    await chooseWorkspace(page, workspaceId);
    const overlap = page.getByRole("combobox", { name: "Overlap policy", exact: true });
    await overlap.press("Enter");
    await page.getByRole("option", { name: "Skip", exact: true }).click();
    await expect(overlap).toContainText("Skip");
    await expect(overlap).toHaveAccessibleDescription("Choose what happens when a prior run is still active.");
    const suite = page.getByRole("combobox", { name: "Suite version", exact: true });
    await expect.poll(async () => (await suite.boundingBox())?.width ?? 0).toBeGreaterThan(240);
    await expect(page.getByText("Suite version", { exact: true })).toHaveCSS("white-space", "nowrap");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath("plan-en.png") });
    await chooseLanguage(page, "zh");
    const localized = page.getByRole("combobox", { name: "重叠策略", exact: true });
    await expect(localized).toContainText("跳过");
    await localized.press("Enter");
    await expect(page.getByRole("option", { name: "跳过", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(localized).toBeFocused();
    await expect(localized).toHaveAccessibleDescription("选择上一次运行仍在进行时如何处理。");
    const localizedSuite = page.getByRole("combobox", { name: "套件版本", exact: true });
    await expect.poll(async () => (await localizedSuite.boundingBox())?.width ?? 0).toBeGreaterThan(240);
    await expect(page.getByText("套件版本", { exact: true })).toHaveCSS("white-space", "nowrap");
    await page.screenshot({ path: testInfo.outputPath("plan-zh.png") });
});
