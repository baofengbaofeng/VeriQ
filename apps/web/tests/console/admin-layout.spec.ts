/**
 * 布局回归使用浏览器读取实际尺寸、导航状态及资源创建结果；初次运行使用真实安装接口建立管理员。
 * 单个工作空间仅供创建回归使用，展示字号的用例直接访问已有用户列表。
 */

import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { editorScope } from "../editor-fixture";
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
    const glyph = await header.getByRole("button", { name: "Sign out" }).locator("svg").screenshot();
    const contrast = await page.evaluate(
        async (image) => {
            const bitmap = await createImageBitmap(await (await fetch(image)).blob());
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Missing 2D context");
            context.drawImage(bitmap, 0, 0);
            const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
            const red = pixels.filter((_, index) => index % 4 === 0);
            return Math.max(...red) - Math.min(...red);
        },
        `data:image/png;base64,${glyph.toString("base64")}`,
    );
    expect(contrast).toBeGreaterThan(60);
    await settings.click();
    await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
});

test("compact console navigation closes on selection and exposes the current branch", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto("/resources/");
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link", { name: "Resources" })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("button", { name: "Authoring" }).click();
    await expect(nav.getByRole("link", { name: "Resources" })).toBeHidden();
    await menu.click();
    await menu.click();
    await expect(nav.getByRole("link", { name: "Resources" })).toBeVisible();
    await nav.getByRole("link", { name: "Runtimes" }).click();
    await expect(nav).toBeHidden();
    await menu.click();
    await expect(nav.getByRole("link", { name: "Runtimes" })).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("compact console returns focus to Menu after selecting the current route", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto("/resources");
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await menu.press("Enter");
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    const resources = nav.getByRole("link", { name: "Resources" });
    await expect(resources).toHaveAttribute("aria-current", "page");
    await resources.focus();
    await expect(resources).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/resources");
    await expect(nav).toBeHidden();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(resources).toHaveAttribute("aria-current", "page");
});

test("console resources return to the selected list and create in the same workspace", async ({ page }) => {
    const { workspaceId } = await editorScope(page, `console-${randomUUID()}`);
    const filter = page.getByLabel("Filter kind");
    await filter.selectOption("DATASET");
    const start = page.getByRole("button", { name: "New resource", exact: true });
    await expect(start).toBeVisible();
    await start.press("Enter");
    await expect(page.getByRole("heading", { name: "New resource", level: 1 })).toBeFocused();
    await expect(filter).toBeHidden();
    await page.getByRole("button", { name: "Back to list" }).press("Enter");
    await expect(start).toBeFocused();
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
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(start).toBeFocused();
    await expect(page.getByRole("row", { name: /Console dataset/ })).toBeVisible();
    await expect(filter).toHaveValue("DATASET");
});

test("workspace title and import action share a row", async ({ page }) => {
    await signIn(page);
    await page.goto("/workspaces");
    const heading = page.getByRole("heading", { name: "Workspaces", level: 1 });
    const importAction = page.getByRole("button", { name: "Import sample workspace" });
    await expect(importAction).toBeVisible();
    const title = await heading.boundingBox();
    const button = await importAction.boundingBox();
    if (!title || !button) throw new Error("Missing workspace title or import action");
    expect(button.x).toBeGreaterThanOrEqual(title.x + title.width);
    expect(Math.abs(button.y + button.height / 2 - title.y - title.height / 2)).toBeLessThan(1);
    await importAction.press("Enter");
    await expect(page.locator("#sample-wizard-title")).toBeFocused();
});

test.describe("desktop touch console", () => {
    test.use({ hasTouch: true, viewport: { width: 1280, height: 800 } });

    test("desktop touch header stays 56px with 44px targets", async ({ page }) => {
        await signIn(page);
        const header = page.getByRole("banner");
        await expect(header).toHaveCSS("height", "56px");
        for (const control of await header.locator("a, button, select").all()) {
            const box = await control.boundingBox();
            expect(box?.height).toBeGreaterThanOrEqual(44);
            expect(box?.width).toBeGreaterThanOrEqual(44);
        }
    });
});
