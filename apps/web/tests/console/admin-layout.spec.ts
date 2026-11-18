/**
 * 布局回归使用浏览器读取实际尺寸、导航状态及资源创建结果；初次运行使用真实安装接口建立管理员。
 * 单个工作空间仅供创建回归使用，展示字号的用例直接访问已有用户列表。
 */

import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { closeResourceEditor, editorScope } from "../editor-fixture";
import { installed } from "../support/install-console";

test.beforeEach(async ({ page }) => installed(page));

/**
 * 浏览器沿用正常表单建立会话并等待账户加载，后续可直接打开深层链接验证路由驱动的导航状态。
 */
async function signIn(page: Page) {
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
}

test("server console follows the approved layout", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/users");
    const header = page.getByRole("banner");
    const settings = header.getByRole("link", { name: "Settings" });
    await expect(settings).toHaveAttribute("href", "/account");
    const controls = [
        header.getByRole("link", { name: "VeriQ" }),
        header.locator(".vq-avatar"),
        header.getByText("Browser Administrator", { exact: true }),
        header.getByLabel("Language"),
        header.getByRole("button", { name: "Sign out" }),
        settings,
    ];
    let right = 0;
    for (const control of controls) {
        const box = await control.boundingBox();
        if (!box) throw new Error("Header control has no visible bounding box");
        expect(box.x).toBeGreaterThanOrEqual(right);
        right = box.x + box.width;
    }
    await expect(header).toHaveCSS("height", "56px");
    await expect(controls[0]).toHaveCSS("font-size", "14px");
    const sidebar = page.getByRole("complementary");
    const width = (await sidebar.boundingBox())?.width;
    expect(width).toBeGreaterThanOrEqual(180);
    expect(width).toBeLessThanOrEqual(200);
    const users = sidebar.getByRole("link", { name: "Users" });
    await expect(users).toHaveAttribute("aria-current", "page");
    await expect(users).toHaveCSS("font-size", "13px");
    await expect(page.getByRole("heading", { name: "Users", level: 1 })).toHaveCSS("font-size", "14px");
    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader").first()).toHaveCSS("font-size", "12px");
    await expect(table.getByRole("cell").first()).toHaveCSS("font-size", "12px");
    await expect(table.getByRole("button").first()).toHaveCSS("font-size", "12px");
    await settings.click();
    await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
});

test("compact console navigation closes on selection and exposes the current branch", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto("/resources");
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link", { name: "Resources" })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Workspaces" }).click();
    await expect(nav).toBeHidden();
    await menu.click();
    await expect(nav.getByRole("link", { name: "Workspaces" })).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("console resources return to the selected list and create in the same workspace", async ({ page }) => {
    const { workspaceId } = await editorScope(page, `console-${randomUUID()}`);
    const filter = page.getByLabel("Filter kind");
    await filter.selectOption("DATASET");
    const start = page.getByRole("button", { name: "New resource", exact: true });
    await expect(start).toBeVisible();
    await start.click();
    await expect(page.getByRole("heading", { name: "New resource", level: 1 })).toBeVisible();
    await expect(filter).toBeHidden();
    await page.getByRole("button", { name: "Back to list" }).click();
    await expect(page.getByLabel("Workspace")).toHaveValue(workspaceId);
    await expect(filter).toHaveValue("DATASET");
    await start.click();
    await page.getByRole("combobox", { name: "Kind", exact: true }).selectOption("DATASET");
    await page.getByLabel("Name", { exact: true }).fill("Console dataset");
    await page.getByLabel("Key", { exact: true }).fill("console_data");
    const response = page.waitForResponse(
        (r) => r.url().endsWith(`/workspaces/${workspaceId}/resources`) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create resource" }).click();
    expect((await response).status()).toBe(201);
    await expect(page.getByRole("dialog").getByRole("article")).toBeVisible();
    await closeResourceEditor(page);
    await expect(page.getByRole("row", { name: /Console dataset/ })).toBeVisible();
    await expect(filter).toHaveValue("DATASET");
});
