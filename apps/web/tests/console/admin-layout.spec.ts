/**
 * 布局回归使用浏览器读取实际尺寸、导航状态及资源创建结果；初次运行使用真实安装接口建立管理员。
 * 单个工作空间仅供创建回归使用，展示字号的用例直接访问已有用户列表。
 */

import { chooseWorkspace, openWorkspaceMenu, workspaceOption, workspacePicker } from "../support/console-controls";
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
    await expect(page.getByRole("heading", { level: 1, name: "Profile", exact: true })).toBeVisible();
}

test("server console follows the approved layout", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/users");
    const header = page.getByRole("banner");
    const profile = header.getByRole("button", { name: "Browser Administrator", exact: true });
    const controls = [
        header.getByRole("link", { name: "VeriQ" }),
        workspacePicker(page),
        header.getByRole("button", { name: "Add workspace", exact: true }),
        header.getByRole("link", { name: "Workspace settings" }),
        profile,
    ];
    let right = 0;
    for (const control of controls) {
        const box = await control.boundingBox();
        if (!box) throw new Error("Header control has no visible bounding box");
        expect(box.x).toBeGreaterThanOrEqual(right);
        right = box.x + box.width;
    }
    await expect(header).toHaveCSS("height", "77px");
    await expect(controls[0]).toHaveText("");
    await expect(controls[0]).toHaveCSS("font-size", "14px");
    const sidebar = page.getByRole("complementary");
    const width = (await sidebar.boundingBox())?.width;
    expect(width).toBeGreaterThanOrEqual(180);
    expect(width).toBeLessThanOrEqual(200);
    await expect(sidebar.getByRole("link", { name: "Account", exact: true })).toHaveCount(0);
    const users = sidebar.getByRole("link", { name: "Users" });
    await expect(users).toHaveAttribute("aria-current", "page");
    await expect(users).toHaveCSS("font-size", "13px");
    await expect(page.getByRole("heading", { name: "Users", level: 1 })).toHaveCSS("font-size", "14px");
    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader").first()).toHaveCSS("font-size", "12px");
    await expect(table.getByRole("cell").first()).toHaveCSS("font-size", "12px");
    await expect(table.getByRole("button").first()).toHaveCSS("font-size", "12px");
    await profile.click();
    const settings = page.getByRole("menuitem", { name: "Account settings" });
    const glyph = await page.getByRole("menuitem", { name: "Sign out" }).locator("svg").screenshot();
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
    await expect(page.getByRole("heading", { level: 1, name: "Profile", exact: true })).toBeVisible();
});

test("compact console navigation closes on selection and exposes the current branch", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto("/resources/");
    const header = page.getByRole("banner");
    const actions = header.getByRole("button", { name: "Toggle application menu" });
    await expect(actions).toHaveAttribute("aria-expanded", "false");
    await actions.click();
    await expect(header.getByText("Browser Administrator", { exact: true })).toBeVisible();
    await actions.click();
    await expect(workspacePicker(page)).toBeVisible();
    await expect(header.getByRole("button", { name: "Add workspace" })).toBeVisible();
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
    await expect(workspacePicker(page)).toHaveAttribute("data-workspace-id", workspaceId);
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

    test("desktop touch header stays 77px with 44px targets", async ({ page }) => {
        await signIn(page);
        const header = page.getByRole("banner");
        await expect(header).toHaveCSS("height", "77px");
        for (const control of await header.locator("a, button, select").all()) {
            const box = await control.boundingBox();
            expect(box?.height).toBeGreaterThanOrEqual(44);
            expect(box?.width).toBeGreaterThanOrEqual(44);
        }
    });
});

test("Web controls distinguish field, keyboard and pointer focus", async ({ page }) => {
    const { workspaceId } = await editorScope(page, `focus-${randomUUID()}`);
    await page.goto(`/agent?workspaceId=${workspaceId}`);
    const conversations = page.getByRole("complementary", { name: "Conversations" });
    const archived = conversations.getByRole("button", { name: "Archived", exact: true });
    const title = conversations.getByRole("textbox", { name: "Conversation title" });

    await archived.click();
    await expect(archived).toHaveAttribute("aria-pressed", "true");
    await expect(archived).toHaveCSS("outline-style", "none");
    await page.keyboard.press("Tab");
    await expect(title).toBeFocused();
    await expect(title).toHaveCSS("outline-color", "rgb(117, 131, 154)");
    await expect(title).toHaveCSS("outline-style", "solid");
    await expect(title).toHaveCSS("outline-width", "2px");
    await expect(title).toHaveCSS("outline-offset", "2px");
    await expect(title).toHaveCSS("border-color", "rgb(156, 185, 255)");
    await expect(title).toHaveCSS("box-shadow", "rgba(70, 95, 255, 0.1) 0px 0px 0px 4px");
    await page.keyboard.press("Shift+Tab");
    await expect(archived).toBeFocused();
    await expect(archived).toHaveCSS("outline-style", "solid");
    await expect(archived).toHaveCSS("outline-color", "rgb(117, 131, 154)");
    await expect(archived).toHaveCSS("outline-offset", "3px");
    await expect(archived).toHaveAttribute("aria-pressed", "true");

    await page.emulateMedia({ forcedColors: "active" });
    await page.keyboard.press("Tab");
    await expect(title).toBeFocused();
    await expect(title).toHaveCSS("box-shadow", "none");
    await expect(title).toHaveCSS("outline-style", "solid");
    await expect(title).toHaveCSS("outline-width", "2px");
});

test("header creates and retains an authorized workspace across navigation", async ({ page }) => {
    await signIn(page);
    const header = page.getByRole("banner");
    const selector = workspacePicker(page);
    await expect(selector).toBeVisible();
    const ids: string[] = [];
    const firstKey = `shell-${randomUUID()}`;
    for (const name of ["Alpha", "Beta"]) {
        if (name === "Beta") await page.getByRole("link", { name: "Runtimes", exact: true }).click();
        await header.getByRole("button", { name: "Add workspace" }).click();
        const dialog = page.getByRole("dialog", { name: "Add workspace" });
        await dialog.getByLabel("Key").fill(firstKey);
        await dialog.getByLabel("Name").fill(name);
        if (name === "Beta") {
            await dialog.getByRole("button", { name: "Create Workspace" }).click();
            await expect(dialog.getByRole("alert")).toBeVisible();
            await expect(dialog.getByLabel("Name")).toHaveValue(name);
            await expect(workspacePicker(page)).toHaveAttribute("data-workspace-id", ids[0]);
            await dialog.getByLabel("Key").fill(`shell-${randomUUID()}`);
        }
        const response = page.waitForResponse(
            (r) => r.url().endsWith("/workspaces") && r.request().method() === "POST",
        );
        await dialog.getByRole("button", { name: "Create Workspace" }).click();
        const created = await response;
        expect(created.status()).toBe(201);
        const id: string = (await created.json()).data.id;
        ids.push(id);
        await expect(dialog).toBeHidden();
        await expect(selector).toHaveAttribute("data-workspace-id", id);
    }
    await page.getByRole("link", { name: "Resources", exact: true }).click();
    await expect(selector).toHaveAttribute("data-workspace-id", ids[1]);
    await expect(page.getByRole("main").locator("button.vq-workspace-picker")).toHaveCount(0);
    await page.goto(`/agent?workspaceId=${ids[0]}&planId=${randomUUID()}&view=details#conversation`);
    await expect(selector).toHaveAttribute("data-workspace-id", ids[0]);
    await expect(page.getByRole("complementary", { name: "Conversations" })).toBeVisible();
    await page.getByRole("link", { name: "Resources", exact: true }).click();
    await chooseWorkspace(page, ids[1]);
    await page.context().setOffline(true);
    try {
        await page.goBack();
        await expect(page.getByRole("heading", { name: "Test Agent", exact: true })).toBeVisible();
        await expect(selector).toHaveAttribute("data-workspace-id", "");
        await expect(page.getByRole("complementary", { name: "Conversations" })).toHaveCount(0);
        await chooseWorkspace(page, ids[1]);
        await expect(page).toHaveURL(/\/agent\?view=details#conversation$/);
    } finally {
        await page.context().setOffline(false);
    }
    await expect(page.getByRole("complementary", { name: "Conversations" })).toBeVisible();
    await expect(selector).toHaveAttribute("data-workspace-id", ids[1]);
    const profile = header.getByRole("button", { name: "Browser Administrator" });
    await profile.press("Enter");
    const menu = page.getByRole("menu");
    await menu.getByRole("menuitem", { name: /^Language/ }).press("ArrowRight");
    await expect(page.getByRole("menuitemradio", { name: "English" })).toBeChecked();
    await page.getByRole("menuitemradio", { name: "中文" }).press("Enter");
    await expect(workspacePicker(page)).toHaveAttribute("data-workspace-id", ids[1]);
    await profile.press("Enter");
    await menu.getByRole("menuitem", { name: /^语言/ }).press("ArrowRight");
    await page.getByRole("menuitemradio", { name: "English" }).press("Enter");
    await profile.press("Enter");
    await menu.getByRole("menuitem", { name: "Account settings" }).press("Enter");
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole("heading", { level: 1, name: "Profile", exact: true })).toBeFocused();
    await profile.press("Enter");
    await page.keyboard.press("Escape");
    await expect(profile).toBeFocused();
    await profile.press("Enter");
    await menu.getByRole("menuitem", { name: "Sign out" }).press("Enter");
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await expect(selector).toHaveCount(0);
    await expect(header.getByLabel("Language")).toBeVisible();
});

test("TailAdmin profile dimensions and theme persist through real navigation", async ({ page }) => {
    const { workspaceId } = await editorScope(page, `theme-${randomUUID()}`);
    const banner = page.getByRole("banner");
    const theme = banner.getByRole("button", { name: "Dark mode", exact: true });
    await expect(theme).toBeVisible();
    await expect(theme).toHaveCSS("width", "44px");
    await expect(theme).toHaveCSS("height", "44px");
    await expect(theme).toHaveAttribute("aria-pressed", "false");
    const profile = banner.getByRole("button", { name: "Browser Administrator", exact: true });
    await expect(profile.locator(".vq-avatar")).toHaveCSS("width", "44px");
    await page.getByRole("button", { name: "New resource", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Unsubmitted resource");
    await theme.click();
    await expect(theme).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    const resourceName = page.getByLabel("Name", { exact: true });
    await expect(resourceName).toHaveValue("Unsubmitted resource");
    await expect(resourceName).toHaveCSS("background-color", "rgb(24, 32, 47)");
    await expect(page.getByRole("button", { name: "Create resource", exact: true })).toHaveCSS(
        "background-color",
        "rgb(70, 95, 255)",
    );
    await expect(workspacePicker(page)).toHaveAttribute("data-workspace-id", workspaceId);
    await page.getByRole("link", { name: "Test Agent", exact: true }).click();
    const archived = page.getByRole("button", { name: "Archived", exact: true });
    await archived.click();
    await expect(archived).toHaveCSS("background-color", "rgb(35, 52, 85)");
    await expect(archived).toHaveAttribute("aria-pressed", "true");
    await profile.press("Enter");
    const menu = page.getByRole("menu");
    await expect(menu).toHaveCSS("width", "260px");
    await expect(menu).toHaveCSS("border-radius", "16px");
    await expect(menu).toHaveCSS("padding", "12px");
    await expect(menu).toHaveCSS("background-color", "rgb(30, 38, 53)");
    await expect(menu.getByText("browser-admin@example.com")).toBeVisible();
    const logout = menu.getByRole("menuitem", { name: "Sign out" });
    await logout.hover();
    await expect(logout).toHaveCSS("color", "rgb(253, 162, 155)");
    await expect(logout).toHaveCSS("background-color", "rgb(56, 36, 39)");
    await menu.getByRole("menuitem", { name: "Account settings" }).press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Profile" })).toBeFocused();
    await expect(
        page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Home" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Personal information" })).toBeVisible();
    await expect(page.locator(".vq-profile-summary .vq-avatar")).toHaveCSS("width", "80px");
    await expect(page.locator(".vq-profile")).toHaveCSS("border-radius", "16px");
    await expect(page.locator(".vq-profile-card").first()).toHaveCSS("padding", "24px");
    await page.reload();
    await expect(theme).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    await theme.click();
    await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
    await theme.click();
    await profile.click();
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await expect(theme).toHaveAttribute("aria-pressed", "true");
});

test("theme still switches when browser preference storage is blocked", async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(window, "localStorage", {
            get() {
                throw new DOMException("Access denied", "SecurityError");
            },
        });
    });
    await page.goto("/login");
    const theme = page.getByRole("button", { name: "Dark mode" });
    await expect(theme).toHaveAttribute("aria-pressed", "false");
    await theme.press("Enter");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    await expect(page.getByLabel("Password")).toBeVisible();
});

test("TailAdmin banner sizes and nested language choices preserve the resource draft", async ({ page }) => {
    const scope = await editorScope(page, `aaa-${randomUUID()}-${"workspace".repeat(8)}`);
    const banner = page.getByRole("banner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(banner).toHaveCSS("height", "77px");
    const theme = banner.getByRole("button", { name: "Dark mode" });
    const user = banner.getByRole("button", { name: "Browser Administrator" });
    await expect(theme).toHaveCSS("border-radius", "10px");
    await expect(user.locator(".vq-avatar")).toHaveCSS("border-radius", "8px");
    await expect(user.getByText("Browser Administrator")).toHaveCSS("font-size", "14px");
    for (let i = 0; i < 26; i++) {
        const response = await page.request.post("/api/v1/workspaces", {
            headers: scope.headers,
            data: { key: `zz-${randomUUID()}`, name: `Workspace ${i}` },
        });
        expect(response.status()).toBe(201);
    }
    await page.goto("/resources?section=assets#draft");
    const picker = workspacePicker(page);
    await chooseWorkspace(page, scope.workspaceId);
    await page.getByRole("button", { name: "New resource", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Keep draft across languages");
    const draftNode = await page.getByLabel("Name", { exact: true }).elementHandle();
    await user.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 900 });
    const toggle = banner.getByRole("button", { name: "Toggle application menu" });
    await expect(banner).toHaveCSS("height", "69px");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.setViewportSize({ width: 320, height: 740 });
    await expect(banner).toHaveCSS("height", "65px");
    const workspaces = await openWorkspaceMenu(page);
    await expect(workspaces.getByRole("menuitem", { name: "More Workspaces" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveCSS("width", "40px");
    await toggle.click();
    await expect(user).toBeVisible();
    await user.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await toggle.click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await toggle.press("Enter");
    await user.press("Enter");
    const language = page.getByRole("menuitem", { name: /Language/ });
    await expect(language).toContainText("EN");
    await expect(language.locator(".vq-locale-badge svg")).toHaveCSS("width", "14px");
    await language.press("ArrowRight");
    const english = page.getByRole("menuitemradio", { name: "English", exact: true });
    await expect(english).toBeChecked();
    await expect(english.locator("svg")).toHaveCSS("width", "20px");
    const submenu = english.locator('xpath=ancestor::*[@role="menu"][1]');
    const bounds = await submenu.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect(bounds && bounds.x + bounds.width).toBeLessThanOrEqual(320);
    await page.keyboard.press("Escape");
    await expect(language).toBeFocused();
    await expect(english).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(user).toBeFocused();
    await user.click();
    await language.click();
    await page.getByRole("menuitemradio", { name: "中文", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(picker).toHaveAttribute("data-workspace-id", scope.workspaceId);
    expect(page.url()).toMatch(/\/resources\?section=assets#draft$/);
    expect(await draftNode?.evaluate((input) => input.isConnected && (input as HTMLInputElement).value)).toBe(
        "Keep draft across languages",
    );
    await user.click();
    await expect(page.getByRole("menuitem", { name: /语言/ })).toContainText("ZH");
    await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
    const guestToggle = banner.getByRole("button", { name: "展开或收起应用菜单" });
    await expect(guestToggle).toHaveAttribute("aria-expanded", "false");
    await guestToggle.click();
    await banner.getByRole("combobox", { name: "语言" }).selectOption("en");
    await expect(banner.getByRole("button", { name: "Dark mode" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test("Workspace toolbar browses paginated members and opens workspace settings", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const header = page.getByRole("banner");
    const settings = header.getByRole("link", { name: "Workspace settings" });
    await expect(settings).toHaveAttribute("href", "/workspaces");
    await expect(
        page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Workspaces" }),
    ).toHaveCount(0);
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const headers = { Origin: "http://127.0.0.1:5173", "X-CSRF-Token": session.csrfToken };
    for (let i = 0; i < 51; i++) {
        const created = await page.request.post("/api/v1/workspaces", {
            headers,
            data: {
                key: `zzzz-picker-${randomUUID()}`,
                name: `Menu workspace ${i}`,
            },
        });
        expect(created.status()).toBe(201);
    }
    await settings.click();
    await expect(page.getByRole("heading", { name: "Workspaces", level: 1 })).toBeVisible();
    const trigger = header.getByRole("button", { name: /^Workspace:/ });
    await trigger.press("Enter");
    const menu = page.getByRole("menu", { name: /^Workspace:/ });
    const selected = menu.getByRole("menuitemradio", { checked: true });
    await expect(selected).toHaveCount(1);
    const first = await selected.getAttribute("data-workspace-id");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.press("ArrowDown");
    const more = menu.getByRole("menuitem", { name: "More Workspaces", exact: true });
    await page.route(
        (url) => url.pathname === "/api/v1/workspaces" && url.searchParams.has("cursor"),
        (r) => r.abort("failed"),
        { times: 1 },
    );
    await more.press("Enter");
    const retry = menu.getByRole("menuitem", { name: "Retry more workspaces" });
    await expect(retry).toBeVisible();
    const radios = menu.getByRole("menuitemradio");
    for (let action = retry; ; action = more) {
        const before = new Set(
            await radios.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-workspace-id"))),
        );
        const response = page.waitForResponse((r) => {
            const url = new URL(r.url());
            return url.pathname === "/api/v1/workspaces" && url.searchParams.has("cursor");
        });
        await action.press("Enter");
        const fetched = await response;
        expect(fetched.status()).toBe(200);
        const data: { items: { id: string }[]; nextCursor: string | null } = (await fetched.json()).data;
        const added = data.items.find((item) => !before.has(item.id));
        if (!added) throw new Error("Expected a new member workspace from this page");
        await expect(workspaceOption(page, added.id)).toBeFocused();
        if (!data.nextCursor) break;
    }
    await expect(more).toBeHidden();
    const last = menu.getByRole("menuitemradio").last();
    const id = await last.getAttribute("data-workspace-id");
    expect(id).toBeTruthy();
    expect(id).not.toBe(first);
    await last.press("Enter");
    await expect(trigger).toHaveAttribute("data-workspace-id", id!);
    await expect(trigger).toBeFocused();
    await header.getByRole("button", { name: "Add workspace" }).click();
    await expect(page.getByRole("dialog", { name: "Add workspace" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 320, height: 750 });
    await header.getByRole("button", { name: "Toggle application menu" }).click();
    await header.getByRole("button", { name: "Dark mode" }).click();
    await trigger.click();
    await expect(menu).toHaveCSS("background-color", "rgb(30, 38, 53)");
    const bounds = await menu.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect(bounds && bounds.x + bounds.width).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});
