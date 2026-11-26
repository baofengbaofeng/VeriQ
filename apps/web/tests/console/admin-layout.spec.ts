/**
 * 布局回归使用浏览器读取实际尺寸、导航状态及资源创建结果；初次运行使用真实安装接口建立管理员。
 * 单个工作空间仅供创建回归使用，展示字号的用例直接访问已有用户列表。
 */

import {
    chooseLanguage,
    chooseWorkspace,
    openWorkspaceMenu,
    workspaceOption,
    workspacePicker,
} from "../support/console-controls";
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
    acknowledgeOperation,
    closeResourceEditor,
    createResource,
    editorScope,
    replaceEditorJson,
    resourceCreateForm,
} from "../editor-fixture";
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

/**
 * 同一管理页跨视口切换后，导航、表格、头像与继承正文均按基线减少两像素，根文字尺寸和横幅控件尺寸保持稳定。
 */
test("console typography reduces by two pixels in the compact viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await page.goto("/admin/users");
    const users = page.getByRole("link", { name: "Users", exact: true });
    const heading = page.getByRole("heading", { name: "Users", exact: true });
    const content = page.getByRole("main");
    const tableHeader = page.getByRole("table").getByRole("columnheader").first();
    const tableCell = page.getByRole("table").getByRole("cell").first();
    const directoryEmail = page.getByRole("table").locator("small").first();
    const avatar = page.getByRole("banner").locator(".vq-avatar");
    const body = page.locator("body");
    const root = page.locator("html");
    const menu = page.getByRole("button", { name: "Toggle sidebar" });
    await expect(users).toHaveCSS("font-size", "14px");
    await expect(heading).toHaveCSS("font-size", "16px");
    await expect(content).toHaveCSS("font-size", "12px");
    await expect(tableHeader).toHaveCSS("font-size", "12px");
    await expect(tableCell).toHaveCSS("font-size", "12px");
    await expect(directoryEmail).toHaveCSS("font-size", "12px");
    await expect(avatar).toHaveCSS("font-size", "13px");
    await expect(body).toHaveCSS("font-size", "16px");
    await expect(menu).toHaveCSS("width", "32px");

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(users).toHaveCSS("font-size", "12px");
    await expect(heading).toHaveCSS("font-size", "14px");
    await expect(content).toHaveCSS("font-size", "10px");
    await expect(tableHeader).toHaveCSS("font-size", "10px");
    await expect(tableCell).toHaveCSS("font-size", "10px");
    await expect(directoryEmail).toHaveCSS("font-size", "10px");
    await expect(avatar).toHaveCSS("font-size", "11px");
    await expect(body).toHaveCSS("font-size", "14px");
    await expect(root).toHaveCSS("font-size", "16px");
    await expect(menu).toHaveCSS("width", "32px");
});

/**
 * 缩放使用真实数据集的源码编辑器，检查当前实例尺寸更新后仍显示同一模型，确认字号变化也覆盖嵌入式编辑区域。
 */
test("compact typography updates the open JSON editor", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { workspaceId, headers } = await editorScope(page, `font-size-${randomUUID()}`);
    const response = await page.request.post(`/api/v1/workspaces/${workspaceId}/resources`, {
        headers,
        data: {
            kind: "DATASET",
            name: "Editor typography",
            key: "editor_typography",
            content: {
                kind: "DATASET",
                document: {
                    schemaVersion: "1.0",
                    columns: { label: "string" },
                    rows: [{ key: "font", values: { label: "Typography sample" } }],
                },
            },
        },
    });
    expect(response.status(), await response.text()).toBe(201);
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    await page.getByRole("link", { name: "Details for Editor typography (editor_typography)" }).click();
    const detail = page.getByRole("main");
    await detail.getByRole("tab", { name: "Data (JSON)", exact: true }).click();
    const editorText = detail.locator(".vq-monaco .view-lines");
    await expect(editorText).toHaveCSS("font-size", "13px");
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(editorText).toHaveCSS("font-size", "11px");
    await expect(editorText).toContainText("Typography sample");
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(editorText).toHaveCSS("font-size", "13px");
});

/**
 * 在中英文各切换一轮足以滚动的真实数据集表单和源码，测量页首与页签坐标，保护完整的视口布局。
 */
test("dataset detail keeps page headings and tabs anchored across editor modes", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const { workspaceId, headers } = await editorScope(page, `dataset-tabs-layout-${randomUUID()}`);
    const fields = Object.fromEntries(
        Array.from({ length: 13 }, (_, index) => [
            `field_${index}`,
            { type: "string", required: true, nullable: false },
        ]),
    );
    const values = Object.fromEntries(Object.keys(fields).map((name) => [name, "Sample value"]));
    const rows = Array.from({ length: 17 }, (_, index) => ({ key: `row_${index}`, values }));
    const created = await page.request.post(`/api/v1/workspaces/${workspaceId}/resources`, {
        headers,
        data: {
            kind: "DATASET",
            key: "tab_layout",
            name: "Tab layout",
            content: {
                kind: "DATASET",
                document: { schemaVersion: "2.0", shape: "TABLE", fields, source: { kind: "STATIC", rows } },
            },
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    await page.getByRole("link", { name: "Details for Tab layout (tab_layout)", exact: true }).click();
    const detail = page.getByRole("main");
    const geometry = async () => ({
        title: await detail.getByRole("heading", { level: 1 }).boundingBox(),
        tabs: await detail.getByRole("tablist").boundingBox(),
        header: await page.getByRole("banner").boundingBox(),
        main: await detail.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollTop })),
        document: await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: window.scrollY })),
    });

    for (const [language, formName, jsonName] of [
        ["en", "Data (Form)", "Data (JSON)"],
        ["zh", "数据（表单）", "数据（JSON）"],
    ] as const) {
        if (language === "zh") await chooseLanguage(page, language);
        const form = detail.getByRole("tab", { name: formName, exact: true });
        const json = detail.getByRole("tab", { name: jsonName, exact: true });
        await expect(form).toHaveAttribute("aria-selected", "true");
        expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(800);
        const before = await geometry();
        await json.click();
        await expect(
            detail.getByRole("tabpanel", { name: jsonName, exact: true }).locator(".monaco-editor"),
        ).toBeVisible();
        expect(await geometry()).toEqual(before);
        await form.click();
        expect(await geometry()).toEqual(before);
    }
});

/**
 * 独立数据集源码应填满首屏剩余空间，窗口高度变化和待应用提示都不能挤出草稿按钮或清除未应用文本。
 */
test("dataset JSON editor tracks viewport height and keeps draft actions visible", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await editorScope(page, `json-height-${randomUUID()}`);
    await createResource(page, "DATASET", "viewport-source");
    await page.getByRole("tab", { name: "Data (JSON)", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Data (JSON)", exact: true });
    const editor = panel.getByRole("textbox", { name: "JSON source", exact: true });
    const editorHost = panel.locator(".vq-monaco");
    const editorWidget = editorHost.locator(".monaco-editor");
    const actions = ["Discard JSON changes", "Apply JSON", "Save draft", "Compile and validate", "Publish version"];
    await expect(editor).toBeVisible();
    await replaceEditorJson(page, '{"retained":"Viewport draft sentinel"}');
    await expect(panel.getByText(/Unapplied JSON changes/u)).toBeVisible();
    const baseline = await editorHost.evaluate((element) => element.clientHeight);

    // 比较实际编辑器节点与窗口高度的变化量，同时检查每个操作无需滚动即可完整显示。
    for (const height of [800, 1000, 800]) {
        await page.setViewportSize({ width: 1280, height });
        await expect
            .poll(async () => {
                const actual = await editorWidget.evaluate((element) => element.clientHeight);
                return Math.abs(actual - (baseline + height - 800));
            })
            .toBeLessThanOrEqual(1);
        for (const name of actions) {
            await expect(panel.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
        }
        const publish = await panel.getByRole("button", { name: "Publish version", exact: true }).boundingBox();
        if (!publish) throw new Error("Expected the final draft action");
        expect(height - publish.y - publish.height).toBeLessThan(80);
        await expect(editorWidget.locator(".view-lines")).toContainText("Viewport draft sentinel");
    }
    // 在 Monaco 内滚动超过一屏的源码，固定在编辑器边框底部的操作应保留原来的视口坐标。
    const longSource = {
        retained: "Viewport draft sentinel",
        lines: Array.from({ length: 100 }, (_, index) => `Scroll sample ${index}`),
    };
    await replaceEditorJson(page, JSON.stringify(longSource, null, 2));
    const sourceText = editorWidget.locator(".view-lines");
    await expect(sourceText).toContainText("Scroll sample 99");
    const compile = panel.getByRole("button", { name: "Compile and validate", exact: true });
    const anchored = await compile.boundingBox();
    expect(anchored).not.toBeNull();
    const mac = await page.evaluate(() => navigator.userAgent.includes("Macintosh"));
    await page.keyboard.press(mac ? "Meta+ArrowUp" : "Control+Home");
    await expect(sourceText).toContainText("Scroll sample 0");
    expect(await compile.boundingBox()).toEqual(anchored);

    // 中文标签沿用同一布局，切换语言后分别确认五个按钮的完整边界仍在当前视口内。
    await chooseLanguage(page, "zh");
    const translated = page.getByRole("tabpanel", { name: "数据（JSON）", exact: true });
    for (const name of ["放弃 JSON 更改", "应用 JSON", "保存草稿", "编译校验", "发布版本"]) {
        await expect(translated.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
    }
    await expect(translated.locator(".vq-monaco .view-lines")).toContainText("Viewport draft sentinel");

    // 在更矮的窗口中仍保留可编辑区域，末尾草稿操作可以通过滚动到达，不会被视口裁掉。
    await page.setViewportSize({ width: 1280, height: 420 });
    const compactEditor = translated.locator(".vq-monaco .monaco-editor");
    const compactHeight = () => compactEditor.evaluate((element) => element.clientHeight);
    await expect.poll(compactHeight).toBeLessThan(300);
    expect(await compactHeight()).toBeGreaterThan(100);
    const save = translated.getByRole("button", { name: "保存草稿", exact: true });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport({ ratio: 1 });
});

/**
 * 侧栏品牌区在展开时显示横版标识，折叠后仅保留方形图标；直接测量实际渲染的图片确认两种状态都来自真实资源。
 */
async function expectSidebarBrand(page: Page, collapsed = false) {
    const sidebar = page.getByRole("complementary");
    const brand = sidebar.getByRole("link", { name: "VeriQ", exact: true });
    await expect(brand).toBeVisible();
    const image = brand.getByRole("img", { name: "VeriQ" });
    await expect(image).toHaveCount(1);
    const box = await image.boundingBox();
    if (!box) throw new Error("Sidebar brand has no visible bounding box");
    expect(box.height).toBe(collapsed ? 32 : 40);
    expect(box.width).toBeGreaterThanOrEqual(box.height);
}

/**
 * 直接测量横幅内当前可见的全部交互元素；新外壳不再把品牌放入横幅，因此只校验控件高度与视口边界。
 */
async function expectBannerControls(page: Page, count: number, maxHeight = 32) {
    const banner = page.getByRole("banner");
    const controls = banner.locator("a:visible, button:visible, select:visible, input:visible");
    await expect(controls).toHaveCount(count);
    const viewport = await page.evaluate(() => document.documentElement.clientWidth);
    for (const control of await controls.all()) {
        const box = await control.boundingBox();
        if (!box) throw new Error("Banner control has no visible bounding box");
        expect(box.height).toBeLessThanOrEqual(maxHeight);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport);
    }
}

/**
 * 工作区菜单按触发器的实际宽度排版，极窄时保留可读下限；直接测量浮层以覆盖浏览器定位后的尺寸。
 */
async function expectWorkspaceMenuWidth(page: Page, menu: Locator) {
    const trigger = await workspacePicker(page).boundingBox();
    if (!trigger) throw new Error("Workspace trigger has no visible bounding box");
    expect((await menu.boundingBox())?.width).toBeCloseTo(Math.max(trigger.width, 160), 0);
}

/**
 * 核对不同语言和视口中工作区选择、新建及设置按钮的纵向中心，确认三个操作在头部保持同一行。
 */
async function expectWorkspaceRow(page: Page) {
    const banner = page.getByRole("banner");
    const controls = [
        workspacePicker(page),
        banner.getByRole("button", { name: /^(Add workspace|添加工作区)$/ }),
        banner.getByRole("link", { name: /^(Workspace settings|工作区设置)$/ }),
    ];
    let center: number | undefined;
    for (const control of controls) {
        const box = await control.boundingBox();
        if (!box) throw new Error("Workspace control has no visible bounds");
        center ??= box.y + box.height / 2;
        expect(box.y + box.height / 2).toBeCloseTo(center, 0);
    }
}

/**
 * 头部单行高度包含三十二像素控件、上下各十六像素内边距和一像素底边框，同时核对侧栏宽度与键盘顺序。
 */
test("server console follows the approved layout", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page);
    await page.goto("/admin/users");
    const header = page.getByRole("banner");
    const profile = header.getByRole("button", { name: "Browser Administrator", exact: true });
    const hamburger = header.getByRole("button", { name: "Toggle sidebar" });
    const controls = [
        hamburger,
        workspacePicker(page),
        header.getByRole("button", { name: "Add workspace", exact: true }),
        header.getByRole("link", { name: "Workspace settings" }),
        header.getByRole("button", { name: "Test Agent" }),
        header.getByRole("button", { name: "Dark mode" }),
        header.getByRole("button", { name: "Notifications" }),
        profile,
    ];
    await expectWorkspaceRow(page);
    const viewport = await page.evaluate(() => document.documentElement.clientWidth);
    let right = 0;
    await controls[0].focus();
    for (const [index, control] of controls.entries()) {
        if (index) await page.keyboard.press("Tab");
        await expect(control).toBeFocused();
        const box = await control.boundingBox();
        if (!box) throw new Error("Header control has no visible bounding box");
        expect(box.x).toBeGreaterThanOrEqual(right);
        if (control === profile) expect(box.x - right).toBeLessThanOrEqual(8);
        right = box.x + box.width;
    }
    expect(viewport - right).toBeLessThanOrEqual(24);
    await expect(header).toHaveCSS("height", "65px");
    await expectBannerControls(page, 8);
    await expect(controls[2]).toHaveCSS("width", "32px");
    await expect(controls[3]).toHaveCSS("width", "32px");
    await expect(hamburger).toHaveAttribute("aria-expanded", "true");
    await expect(hamburger).toHaveCSS("width", "32px");
    const sidebar = page.getByRole("complementary");
    await expectSidebarBrand(page);
    expect((await sidebar.boundingBox())?.width).toBe(220);
    await hamburger.click();
    await expect(hamburger).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    expect((await sidebar.boundingBox())?.width).toBe(90);
    await expectSidebarBrand(page, true);
    await hamburger.click();
    await expect(hamburger).toHaveAttribute("aria-expanded", "true");
    expect((await sidebar.boundingBox())?.width).toBe(220);
    await expect(sidebar.getByRole("link", { name: "Account", exact: true })).toHaveCount(0);
    const users = sidebar.getByRole("link", { name: "Users" });
    await expect(users).toHaveAttribute("aria-current", "page");
    await expect(users).toHaveCSS("font-size", "12px");
    await expect(page.getByRole("heading", { name: "Users", level: 1 })).toHaveCSS("font-size", "16px");
    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader").first()).toHaveCSS("font-size", "10px");
    await expect(table.getByRole("cell").first()).toHaveCSS("font-size", "10px");
    await expect(table.getByRole("button").first()).toHaveCSS("font-size", "10px");
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
    await page.setViewportSize({ width: 700, height: 844 });
    await signIn(page);
    await page.goto("/resources/datasets");
    const header = page.getByRole("banner");
    const actions = header.getByRole("button", { name: "Toggle application menu" });
    await expect(actions).toHaveAttribute("aria-expanded", "false");
    await expect(header.getByRole("button", { name: "Notifications" })).toBeHidden();
    await actions.click();
    await expect(actions).toHaveAttribute("aria-expanded", "true");
    await expect(header.getByText("Browser Administrator", { exact: true })).toBeVisible();
    await expect(header.getByRole("button", { name: "Notifications" })).toBeVisible();
    await expect(workspacePicker(page)).toBeVisible();
    await expect(header.getByRole("button", { name: "Add workspace" })).toBeVisible();
    await actions.click();
    await expect(actions).toHaveAttribute("aria-expanded", "false");
    await expect(header.getByRole("button", { name: "Notifications" })).toBeHidden();
    await expect(workspacePicker(page)).toBeVisible();
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    const datasets = nav.getByRole("link", { name: "Datasets", exact: true });
    await expect(datasets).toHaveAttribute("aria-current", "page");
    await nav.getByRole("button", { name: "Authoring" }).click();
    await expect(datasets).toBeHidden();
    await menu.click();
    await menu.click();
    await expect(datasets).toBeVisible();
    await nav.getByRole("link", { name: "Runtimes" }).click();
    await expect(nav).toBeHidden();
    await menu.click();
    await expect(nav.getByRole("link", { name: "Runtimes" })).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(700);
});

test("compact console returns focus to Menu after selecting the current route", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 844 });
    await signIn(page);
    await page.goto("/resources/datasets");
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await menu.press("Enter");
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    const datasets = nav.getByRole("link", { name: "Datasets", exact: true });
    await expect(datasets).toHaveAttribute("aria-current", "page");
    await datasets.focus();
    await expect(datasets).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/resources/datasets");
    await expect(nav).toBeHidden();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(datasets).toHaveAttribute("aria-current", "page");
});

/**
 * 在数据集列表打开真正的模态表单，确认前保留原节点和搜索内容，确认后再打开详情页并通过面包屑返回。
 */
test("dataset creation opens a centered dialog without replacing the current list", async ({ page }) => {
    const { workspaceId } = await editorScope(page, `console-${randomUUID()}`);
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Datasets" }).click();
    await expect(page).toHaveURL("/resources/datasets");
    const search = page.getByRole("searchbox", { name: "Search name or key", exact: true });
    await search.fill("Console");
    const start = page.getByRole("button", { name: "New dataset", exact: true });
    const dialog = page.getByRole("dialog", { name: "New dataset", exact: true });
    const heading = page.locator("main h1");
    const initialTitle = await heading.textContent();
    const table = page.locator(".vq-library-table table");
    const originalTable = await table.elementHandle();
    if (!originalTable) throw new Error("Expected the current dataset table");
    const form = resourceCreateForm(page);
    await expect(start).toBeVisible();
    await start.press("Enter");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) throw new Error("Expected centered dataset form bounds");
    expect(box.x + box.width / 2).toBeCloseTo(viewport.width / 2, 0);
    expect(box.y + box.height / 2).toBeCloseTo(viewport.height / 2, 0);
    expect(box.width).toBe(Math.min(400, viewport.width - 32));
    await expect(page).toHaveURL("/resources/datasets");
    await expect(heading).toHaveText(initialTitle ?? "");
    await expect(table).toBeVisible();
    expect(await table.evaluate((current, original) => current === original, originalTable)).toBe(true);
    const name = form.getByLabel("Name", { exact: true });
    await expect(name).toBeFocused();
    await expect(form.getByRole("combobox", { name: "Kind", exact: true })).toHaveCount(0);
    await name.fill("Unsubmitted form");
    const format = form.getByRole("combobox", { name: "Dataset format", exact: true });
    await format.press("Enter");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(format).toBeFocused();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(start).toBeFocused();
    await start.press("Enter");
    await expect(name).toHaveValue("");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
    await expect(dialog).toBeHidden();
    await expect(start).toBeFocused();
    await expect(workspacePicker(page)).toHaveAttribute("data-workspace-id", workspaceId);
    await expect(search).toHaveValue("Console");
    await start.click();
    await name.fill("Console dataset");
    await form.getByLabel("Key", { exact: true }).fill("console_data");
    const response = page.waitForResponse(
        (r) => r.url().endsWith(`/workspaces/${workspaceId}/resources`) && r.request().method() === "POST",
    );
    await form.getByRole("button", { name: "Create resource", exact: true }).click();
    const created = await response;
    expect(created.status()).toBe(201);
    expect((await created.json()).data).toMatchObject({
        kind: "DATASET",
        name: "Console dataset",
        key: "console_data",
    });
    await expect(dialog).toBeHidden();
    await acknowledgeOperation(page, "Resource created");
    const detail = page.getByRole("heading", { name: "Console dataset", exact: true, level: 1 });
    await expect(detail).toBeFocused();
    await expect(page.getByRole("main").getByRole("article")).toBeVisible();
    await closeResourceEditor(page);
    await expect(detail).toBeHidden();
    await expect(start).toBeVisible();
    await expect(page.getByRole("row", { name: /Console dataset/ })).toBeVisible();
    await expect(search).toHaveValue("Console");
    await expect(page).toHaveURL("/resources/datasets");
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

    test("desktop touch header stays 72px with inline controls", async ({ page }) => {
        await signIn(page);
        const header = page.getByRole("banner");
        await expect(header).toHaveCSS("height", "72px");
        await expectBannerControls(page, 7);
    });
});

const focusColors = [
    ["light", "rgb(110, 143, 210)"],
    ["dark", "rgb(154, 181, 240)"],
] as const;

/**
 * 资源下拉框保留触发器底色，个人菜单以背景提示焦点，强制配色下的工作区文本框沿用系统高亮边框。
 */
test("Web dropdowns preserve trigger fill and support keyboard focus and forced colors", async ({ page }) => {
    await editorScope(page, `focus-${randomUUID()}`, "/resources/fixtures");
    const filter = page.getByRole("combobox", { name: "Filter status", exact: true });
    const theme = page.getByRole("banner").getByRole("button", { name: "Dark mode" });
    const profile = page.getByRole("button", { name: "Browser Administrator", exact: true });
    const settings = page.getByRole("menuitem", { name: "Account settings" });
    for (const [mode, fill] of focusColors) {
        if (mode === "dark") await theme.click();
        const resting = await filter.evaluate((element) => {
            const style = getComputedStyle(element);
            return { borderWidth: style.borderWidth, backgroundColor: style.backgroundColor };
        });
        await filter.press("Enter");
        await expect(page.getByRole("listbox")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(filter).toBeFocused();
        await expect(filter).toHaveCSS("border-width", resting.borderWidth);
        await expect(filter).toHaveCSS("border-color", "rgb(156, 185, 255)");
        await expect(filter).toHaveCSS("background-color", resting.backgroundColor);
        await expect(filter).toHaveCSS("outline-style", "none");
        await expect(filter).toHaveCSS("box-shadow", "none");
        await profile.press("Enter");
        await expect(settings).toBeFocused();
        await expect(settings).toHaveCSS("background-color", fill);
        await expect(settings).toHaveCSS("outline-style", "none");
        await page.keyboard.press("Escape");
    }
    await page.emulateMedia({ forcedColors: "active" });
    const highlight = await page.evaluate(() => {
        const sample = document.createElement("span");
        sample.style.color = "Highlight";
        document.body.append(sample);
        const color = getComputedStyle(sample).color;
        sample.remove();
        return color;
    });
    await page.getByRole("banner").getByRole("button", { name: "Add workspace" }).press("Enter");
    const dialog = page.getByRole("dialog", { name: "Add workspace" });
    await dialog.getByRole("button", { name: "Close" }).press("Tab");
    for (const field of [dialog.getByLabel("Key"), dialog.getByLabel("Name")]) {
        await expect(field).toBeFocused();
        await expect(field).toHaveCSS("outline-style", "none");
        await expect(field).toHaveCSS("border-color", highlight);
        await page.keyboard.press("Tab");
    }
});

test("Workspace create fields keep their default fill for pointer and keyboard focus", async ({ page }) => {
    await signIn(page);
    const header = page.getByRole("banner");
    const dialog = page.getByRole("dialog", { name: "Add workspace" });
    for (const [mode] of focusColors) {
        const fill = mode === "dark" ? "rgb(16, 24, 40)" : "rgb(255, 255, 255)";
        if (mode === "dark") await header.getByRole("button", { name: "Dark mode" }).click();
        await header.getByRole("button", { name: "Add workspace" }).press("Enter");
        for (const field of [dialog.getByLabel("Key"), dialog.getByLabel("Name")]) {
            const label = field.locator("xpath=preceding-sibling::label").locator(".vq-field-label");
            await expect(label).toHaveCSS("font-weight", "550");
            const resting = await field.evaluate((element) => {
                const style = getComputedStyle(element);
                return { borderWidth: style.borderWidth, fill: style.backgroundColor };
            });
            expect(resting.fill).toBe(fill);
            await field.click();
            for (const interaction of ["pointer", "keyboard"]) {
                if (interaction === "keyboard") {
                    await page.keyboard.press("Shift+Tab");
                    await page.keyboard.press("Tab");
                }
                await expect(field).toBeFocused();
                await expect(label).toHaveCSS("font-weight", "700");
                await expect(field).toHaveCSS("font-weight", "500");
                await expect(field).toHaveCSS("border-width", resting.borderWidth);
                await expect(field).toHaveCSS("border-color", "rgb(156, 185, 255)");
                await expect(field).toHaveCSS("outline-style", "none");
                await expect(field).toHaveCSS("box-shadow", "none");
                await expect(field).toHaveCSS("background-color", fill);
            }
        }
        const key = dialog.getByLabel("Key");
        const idleBorder = await key.evaluate((element) => getComputedStyle(element).border);
        await key.fill("9-invalid");
        await dialog.getByRole("button", { name: "Create Workspace" }).click();
        await expect(key).toBeFocused();
        expect(await key.evaluate((element) => element.matches(":user-invalid"))).toBe(true);
        await expect(key).toHaveCSS("border", idleBorder);
        await expect(key).toHaveCSS("outline-style", "none");
        await expect(key).toHaveCSS("background-color", fill);
        await dialog.getByRole("button", { name: "Cancel" }).click();
    }
});

for (const [mode, fill] of focusColors) {
    test(`Web JSON editor shows a Find border and command fill in ${mode} mode`, async ({ page }) => {
        await editorScope(page, `focus-${randomUUID()}`);
        if (mode === "dark") await page.getByRole("banner").getByRole("button", { name: "Dark mode" }).click();
        await createResource(page, "DATASET", "focus-source");
        await page.getByRole("tab", { name: "Data (JSON)", exact: true }).click();
        const editor = page.getByRole("tabpanel", { name: "Data (JSON)", exact: true }).locator(".vq-monaco");
        await editor.locator(".view-lines").click();
        await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
        await editor.getByRole("textbox", { name: "Find", exact: true }).click();
        const search = editor.locator(".find-widget .monaco-inputbox.synthetic-focus");
        await expect(search).toHaveCSS("outline-style", "none");
        await expect(search).toHaveCSS("background-color", mode === "dark" ? "rgb(16, 24, 40)" : "rgb(255, 255, 255)");
        await expect(search).toHaveCSS("border-color", "rgb(156, 185, 255)");
        await editor.locator(".view-lines").click();
        await page.keyboard.press("F1");
        const commands = editor.locator(".quick-input-list > .monaco-list");
        await expect(commands).toBeVisible();
        await page.keyboard.press("Tab");
        await expect(commands).toBeFocused();
        const command = commands.locator(".monaco-list-row.focused");
        await expect(command).toHaveCSS("outline-style", "none");
        await expect(command).toHaveCSS("background-color", fill);
    });
}

/**
 * 读取实际对话框边界，在桌面与窄屏验证双轴居中、视口边距和有限宽度，避免创建表单退回右侧抽屉。
 */
async function expectCenteredCreateDialog(page: Page, dialog: Locator) {
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) throw new Error("Missing create dialog or viewport bounds");
    expect(box.x + box.width / 2).toBeCloseTo(viewport.width / 2, 0);
    expect(box.y + box.height / 2).toBeCloseTo(viewport.height / 2, 0);
    expect(box.width).toBe(Math.min(400, viewport.width - 32));
    expect(box.y).toBeGreaterThanOrEqual(16);
    await expect(dialog).toHaveCSS("border-radius", "16px");
    const title = dialog.getByRole("heading", { name: "Add workspace" });
    await expect(title).toHaveCSS("font-size", "14px");
    await expect(title).toHaveCSS("font-weight", "600");
    await expect(dialog.getByLabel("Key")).toHaveCSS("height", "36px");
    await expect(dialog.getByLabel("Name")).toHaveCSS("height", "36px");
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    const create = dialog.getByRole("button", { name: "Create Workspace", exact: true });
    const cancelBox = await cancel.boundingBox();
    const createBox = await create.boundingBox();
    const nameBox = await dialog.getByLabel("Name").boundingBox();
    if (!cancelBox || !createBox || !nameBox) throw new Error("Missing form actions or field");
    expect((await title.boundingBox())?.x).toBe(nameBox.x);
    expect(cancelBox.y).toBe(createBox.y);
    expect(createBox.x - (cancelBox.x + cancelBox.width)).toBe(8);
    expect(createBox.x + createBox.width).toBeCloseTo(nameBox.x + nameBox.width, 0);
    await expect(cancel).toHaveCSS("border-style", "solid");
    expect(await cancel.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(
        await create.evaluate((node) => getComputedStyle(node).backgroundColor),
    );
}

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
        await expectCenteredCreateDialog(page, dialog);
        await dialog.getByLabel("Key").fill(firstKey);
        await dialog.getByLabel("Name").fill(name);
        if (name === "Alpha") {
            await page.setViewportSize({ width: 320, height: 200 });
            await expectCenteredCreateDialog(page, dialog);
            expect(await dialog.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
            await expect(dialog.getByLabel("Key")).toHaveValue(firstKey);
            await expect(dialog.getByLabel("Name")).toBeFocused();
            await expect(dialog.getByLabel("Name")).toHaveValue(name);
        }
        if (name === "Beta") {
            const conflict = page.waitForResponse((r) => r.url().endsWith("/workspaces") && r.status() === 409);
            await dialog.getByRole("button", { name: "Create Workspace" }).click();
            await conflict;
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
        if (name === "Alpha") {
            await expect(header.getByRole("button", { name: "Add workspace" })).toBeFocused();
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    }
    await page.getByRole("link", { name: "Datasets", exact: true }).click();
    await expect(selector).toHaveAttribute("data-workspace-id", ids[1]);
    await expect(page.getByRole("main").locator("button.vq-workspace-picker")).toHaveCount(0);
    await page.goto(`/agent?workspaceId=${ids[0]}&planId=${randomUUID()}&view=details#conversation`);
    await expect(selector).toHaveAttribute("data-workspace-id", ids[0]);
    await expect(page.getByRole("complementary", { name: "Conversations" })).toBeVisible();
    await page.getByRole("link", { name: "Datasets", exact: true }).click();
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
    await expectWorkspaceRow(page);
    const add = header.getByRole("button", { name: "添加工作区" });
    await add.press("Enter");
    const localized = page.getByRole("dialog", { name: "添加工作区" });
    await expect(localized).toHaveAccessibleDescription("使用唯一标识，以英文字母或下划线开头。");
    await localized.getByRole("button", { name: "取消", exact: true }).click();
    await expect(add).toBeFocused();
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
    await expect(page.getByRole("banner")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "English" })).toBeVisible();
});

test("TailAdmin profile dimensions and theme persist through real navigation", async ({ page }) => {
    const { workspaceId } = await editorScope(page, `theme-${randomUUID()}`, "/resources/fixtures");
    const banner = page.getByRole("banner");
    const theme = banner.getByRole("button", { name: "Dark mode", exact: true });
    await expect(theme).toBeVisible();
    await expect(theme).toHaveCSS("width", "32px");
    await expect(theme).toHaveCSS("height", "32px");
    await expect(theme).toHaveAttribute("aria-pressed", "false");
    const profile = banner.getByRole("button", { name: "Browser Administrator", exact: true });
    await expect(profile.locator(".vq-avatar")).toHaveCSS("width", "32px");
    await page.getByRole("button", { name: "New fixture", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Unsubmitted resource");
    await theme.click();
    await expect(theme).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    await expect(workspacePicker(page)).toHaveCSS("border-color", "rgb(52, 64, 84)");
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
    await expect(menu).toHaveCSS("width", "200px");
    await expect(menu).toHaveCSS("border-radius", "12px");
    await expect(menu).toHaveCSS("padding", "8px");
    for (const action of await menu.getByRole("menuitem").all()) {
        await expect(action).toHaveCSS("font-size", "10px");
        await expect(action).toHaveCSS("height", "32px");
    }
    await expect(menu).toHaveCSS("background-color", "rgb(30, 38, 53)");
    const name = menu.getByText("Browser Administrator", { exact: true });
    await expect(name).toHaveCSS("font-size", "10px");
    await expect(name).toHaveCSS("line-height", "16px");
    const email = menu.getByText("browser-admin@example.com");
    await expect(email).toBeVisible();
    await expect(email).toHaveCSS("font-size", "9px");
    await expect(email).toHaveCSS("line-height", "16px");
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
    await expect(page.getByRole("button", { name: "Dark mode" })).toHaveAttribute("aria-pressed", "true");
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

test("TailAdmin header sizes and nested language choices preserve the resource draft", async ({ page }) => {
    const scope = await editorScope(page, `aaa-${randomUUID()}-${"workspace".repeat(8)}`);
    const banner = page.getByRole("banner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(banner).toHaveCSS("height", "72px");
    const theme = banner.getByRole("button", { name: "Dark mode" });
    const user = banner.getByRole("button", { name: "Browser Administrator" });
    await expect(theme).toHaveCSS("border-radius", "8px");
    await expect(user.locator(".vq-avatar")).toHaveCSS("border-radius", "6px");
    await expect(user.getByText("Browser Administrator")).toHaveCSS("font-size", "11px");
    for (let i = 0; i < 26; i++) {
        const response = await page.request.post("/api/v1/workspaces", {
            headers: scope.headers,
            data: { key: `zz-${randomUUID()}`, name: `Workspace ${i}` },
        });
        expect(response.status()).toBe(201);
    }
    await page.goto("/resources/fixtures?section=assets#draft");
    const picker = workspacePicker(page);
    await chooseWorkspace(page, scope.workspaceId);
    const width = (await picker.boundingBox())?.width;
    expect(width).toBeGreaterThan(100);
    expect(width).toBeLessThanOrEqual(182);
    await page.getByRole("button", { name: "New fixture", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Keep draft across languages");
    const draftNode = await page.getByLabel("Name", { exact: true }).elementHandle();
    await user.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.setViewportSize({ width: 1024, height: 900 });
    const toggle = banner.getByRole("button", { name: "Toggle application menu" });
    await expect(banner).toHaveCSS("height", "72px");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(user).toBeHidden();
    await expect(picker).toBeVisible();
    await expectBannerControls(page, 5);
    const workspaces = await openWorkspaceMenu(page);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expectWorkspaceMenuWidth(page, workspaces);
    const longOption = workspaces.getByRole("menuitemradio", { name: scope.key, exact: true });
    await expect(longOption).toBeChecked();
    await expect(longOption).toHaveCSS("height", "32px");
    await expect(longOption).toHaveAttribute("title", scope.key);
    const optionName = longOption.getByText(scope.key, { exact: true });
    await expect(optionName).toHaveCSS("white-space", "nowrap");
    await expect(optionName).toHaveCSS("text-overflow", "ellipsis");
    await expect(optionName).toHaveCSS("overflow", "hidden");
    expect(await optionName.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await longOption.evaluate((row) => row.scrollWidth <= row.clientWidth)).toBe(true);
    await longOption.scrollIntoViewIfNeeded();
    const check = longOption.locator("svg");
    await expect(check).toHaveCSS("width", "14px");
    await expect(check).toBeInViewport({ ratio: 1 });
    await expect(workspaces.getByRole("menuitem", { name: "More Workspaces" })).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveCSS("width", "32px");
    await expect(picker).toBeFocused();
    await expect(user).toBeVisible();
    await expect(banner).toHaveCSS("height", "72px");
    await expectBannerControls(page, 8);
    await expectWorkspaceRow(page);
    const themeBox = await theme.boundingBox();
    const account = await user.boundingBox();
    if (!themeBox || !account) throw new Error("Expanded header controls must have visible bounds");
    expect(account.y + account.height / 2).toBeCloseTo(themeBox.y + themeBox.height / 2, 0);
    for (const name of [picker.locator("span"), user.locator(".vq-user-name")]) {
        await expect(name).toHaveCSS("text-overflow", "ellipsis");
        expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    }
    await user.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(user).toBeHidden();
    await toggle.press("Enter");
    await expect(user).toBeVisible();
    await user.press("Enter");
    const language = page.getByRole("menuitem", { name: /Language/ });
    await expect(language).toContainText("EN");
    await expect(language.locator(".vq-locale-badge")).toHaveCSS("font-size", "9px");
    await expect(language.locator(".vq-locale-badge svg")).toHaveCSS("width", "12px");
    await language.press("ArrowRight");
    const english = page.getByRole("menuitemradio", { name: "English", exact: true });
    await expect(english).toBeChecked();
    await expect(english).toHaveCSS("height", "32px");
    await expect(english).toHaveCSS("font-size", "10px");
    await expect(english.locator("svg")).toHaveCSS("width", "16px");
    const submenu = english.locator('xpath=ancestor::*[@role="menu"][1]');
    await expect(submenu).toHaveCSS("width", "168px");
    const bounds = await submenu.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect(bounds && bounds.x + bounds.width).toBeLessThanOrEqual(1024);
    await page.keyboard.press("Escape");
    await expect(language).toBeFocused();
    await expect(english).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(user).toBeFocused();
    await user.click();
    await language.click();
    await page.getByRole("menuitemradio", { name: "中文", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expectWorkspaceRow(page);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(picker).toHaveAttribute("data-workspace-id", scope.workspaceId);
    await expect(page).toHaveURL("/resources/fixtures?section=assets#draft");
    expect(await draftNode?.evaluate((input) => input.isConnected && (input as HTMLInputElement).value)).toBe(
        "Keep draft across languages",
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await user.click();
    await expect(page.getByRole("menuitem", { name: /语言/ })).toContainText("ZH");
    await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
    await expect(page.getByRole("heading", { name: "登录 VeriQ" })).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(0);
    await expect(page.getByRole("complementary").getByRole("img", { name: "VeriQ" })).toBeVisible();
    await page.getByRole("button", { name: "中文" }).click();
    await page.getByRole("menuitemradio", { name: "English" }).click();
    await expect(page.getByRole("button", { name: "Dark mode" })).toBeVisible();
    await expect(page.getByRole("button", { name: "English" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
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
    const headers = { Origin: new URL(page.url()).origin, "X-CSRF-Token": session.csrfToken };
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
    await expectWorkspaceMenuWidth(page, menu);
    const group = menu.getByRole("group");
    expect((await group.boundingBox())?.height).toBeLessThanOrEqual(256);
    expect(await group.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    const selected = menu.getByRole("menuitemradio", { checked: true });
    await expect(selected).toHaveCount(1);
    const first = await selected.getAttribute("data-workspace-id");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.press("ArrowDown");
    const more = menu.getByRole("menuitem", { name: "More Workspaces", exact: true });
    await page.setViewportSize({ width: 1280, height: 240 });
    await expect(more).toBeInViewport({ ratio: 1 });
    expect((await group.boundingBox())?.height).toBeLessThan(240);
    await page.route(
        (url) => url.pathname === "/api/v1/workspaces" && url.searchParams.has("cursor"),
        (r) => r.abort("failed"),
        { times: 1 },
    );
    await more.press("Enter");
    const retry = menu.getByRole("menuitem", { name: "Retry more workspaces" });
    await expect(retry).toBeInViewport();
    await expect(retry).toHaveCSS("height", "32px");
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
    const option = menu.getByRole("menuitemradio", { name: "Menu workspace 0", exact: true });
    await expect(option).toHaveCSS("height", "32px");
    await expect(option).toHaveCSS("font-size", "10px");
    await expect(option).toHaveCSS("line-height", "16px");
    const last = menu.getByRole("menuitemradio").last();
    const id = await last.getAttribute("data-workspace-id");
    expect(id).toBeTruthy();
    expect(id).not.toBe(first);
    await last.press("Enter");
    await expect(trigger).toHaveAttribute("data-workspace-id", id!);
    await expect(trigger).toBeFocused();
    await page.getByRole("link", { name: "Datasets", exact: true }).click();
    await expect(page).toHaveURL("/resources/datasets");
    await trigger.press("Enter");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await page.setViewportSize({ width: 700, height: 750 });
    const expander = header.getByRole("button", { name: "Toggle application menu" });
    await expect(expander).toBeVisible();
    await expect(expander).toHaveAttribute("aria-expanded", "false");
    await expander.click();
    await expect(expander).toHaveAttribute("aria-expanded", "true");
    await expect(header).toHaveCSS("height", "72px");
    const add = header.getByRole("button", { name: "Add workspace" });
    await header.getByRole("button", { name: "Dark mode" }).click();
    await add.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Add workspace" });
    await expectCenteredCreateDialog(page, dialog);
    await expect(dialog).toHaveCSS("background-color", "rgb(26, 34, 49)");
    const posts: string[] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/workspaces")) posts.push(request.url());
    });
    await dialog.getByLabel("Key").fill(`cancel-${randomUUID()}`);
    await dialog.getByLabel("Name").fill("Canceled workspace");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
    await expect(dialog).toBeHidden();
    await expect(add).toBeFocused();
    expect(posts).toHaveLength(0);
    await add.press("Enter");
    await expect(dialog.getByLabel("Key")).toHaveValue("");
    await dialog.getByRole("button", { name: "Create Workspace" }).focus();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(add).toBeFocused();
    await settings.press("Enter");
    await expect(page).toHaveURL(/\/workspaces$/);
    await trigger.click();
    await expect(menu).toHaveCSS("background-color", "rgb(30, 38, 53)");
    const bounds = await menu.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect(bounds && bounds.x + bounds.width).toBeLessThanOrEqual(700);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(700);
});
