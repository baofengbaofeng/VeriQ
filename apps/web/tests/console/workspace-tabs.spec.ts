/**
 * 设置页使用真实工作区和停用的模型提供方，验证键盘、浏览器历史与服务端权限，不发起收费的模型调用。
 */
import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type Locator, type Page } from "@playwright/test";
import { acknowledgeOperation, editorScope, resourceCreateForm } from "../editor-fixture";
import { installed } from "../support/install-console";
import { chooseLanguage, chooseWorkspace } from "../support/console-controls";

/**
 * 测量已渲染的品牌图片和导航文字，逐项核对实际字形没有换行，也没有越过交互区域或侧栏的横向边界。
 */
async function expectCompactSidebar(sidebar: Locator) {
    const logo = sidebar.locator(".vq-sidebar-header img:visible");
    await expect(logo).toBeVisible();
    await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    const bounds = await logo.evaluate((image) => {
        const outer = image.closest(".vq-sidebar-header")?.getBoundingClientRect();
        if (!outer) throw new Error("Sidebar logo header is missing");
        const mark = image.getBoundingClientRect();
        return { left: mark.left - outer.left, right: outer.right - mark.right };
    });
    expect(bounds.left).toBeGreaterThan(0);
    expect(Math.abs(bounds.left - bounds.right)).toBeLessThanOrEqual(1);
    await expect(sidebar).toHaveCSS("width", "220px");

    const labels = sidebar.locator(".vq-nav-item > span:visible, .vq-nav-sub:visible, .vq-nav-group-label:visible");
    expect(await labels.count()).toBeGreaterThan(15);
    const clipped = await labels.evaluateAll((items) =>
        items
            .filter((label) => {
                const item = label.closest("button, a") ?? label;
                const nav = label.closest("nav");
                if (!nav) throw new Error("Sidebar navigation label is missing its container");
                const itemBounds = item.getBoundingClientRect();
                const navBounds = nav.getBoundingClientRect();
                const text = document.createRange();
                text.selectNodeContents(label);
                const boxes = Array.from(text.getClientRects());
                const left = Math.max(itemBounds.left, navBounds.left);
                const right = Math.min(itemBounds.right, navBounds.right);
                return boxes.length !== 1 || boxes.some((box) => box.left < left - 0.5 || box.right > right + 0.5);
            })
            .map((label) => label.textContent),
    );
    expect(clipped).toEqual([]);
}

/**
 * 在两档桌面字号与两种语言下核对侧栏的布局，通过菜单进入原有路由，并保留目标页面名称及路径说明。
 */
test("desktop sidebar keeps its compact width and concise authoring links", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installed(page);
    await editorScope(page, `sidebar-${randomUUID()}`);
    await page.goto("/resources/element-catalogs");
    const sidebar = page.locator("#vq-sidebar");
    const toggle = page.getByRole("button", { name: "Toggle sidebar", exact: true });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await expectCompactSidebar(sidebar);
    await toggle.click();
    await expect(sidebar).toHaveCSS("width", "90px");
    await toggle.click();
    await page.setViewportSize({ width: 1440, height: 800 });
    await expectCompactSidebar(sidebar);
    const assertion = sidebar.getByRole("link", { name: "Assertion", exact: true });
    await expect(assertion).toHaveAttribute("href", "/resources/assertion");
    await assertion.click();
    await expect(page).toHaveURL("/resources/assertion");
    await expect(page.getByRole("heading", { name: "Assertion", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).locator('[aria-current="page"]')).toHaveText(
        "Assertion",
    );
    const environments = sidebar.getByRole("link", { name: "Environments", exact: true });
    await environments.click();
    await expect(page).toHaveURL("/resources/environments");
    await expect(page.getByRole("heading", { name: "Execution environments", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).locator('[aria-current="page"]')).toHaveText(
        "Execution environments",
    );
    await chooseLanguage(page, "zh");
    await expect(sidebar.getByRole("link", { name: "断言", exact: true })).toHaveAttribute(
        "href",
        "/resources/assertion",
    );
    await expect(sidebar.getByRole("link", { name: "环境", exact: true })).toHaveAttribute(
        "href",
        "/resources/environments",
    );
    await expect(page.getByRole("heading", { name: "执行环境", exact: true })).toBeVisible();
    await expectCompactSidebar(sidebar);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expectCompactSidebar(sidebar);
});

/**
 * 使用工作区实际详情写入和归档响应检查确认弹窗，关闭结果后检查名称与只读状态已刷新到页面。
 */
test("Workspace overview shows metadata, copy feedback and acknowledged changes", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installed(page);
    const { workspaceId, key } = await editorScope(page, `workspace-mutations-${randomUUID()}`);
    const detailsResponse = await page.request.get(`/api/v1/workspaces/${workspaceId}`);
    expect(detailsResponse.ok()).toBe(true);
    const { createdAt } = (await detailsResponse.json()).data;
    await page.goto("/workspaces");
    await chooseWorkspace(page, workspaceId);
    const basics = page.getByRole("tabpanel", { name: "Basic information" });
    const overview = basics.getByRole("region", { name: key, exact: true });
    await expect(overview.getByRole("heading", { name: key, exact: true })).toBeVisible();
    await expect(overview.getByText("Active", { exact: true })).toBeVisible();
    await expect(overview.getByText(workspaceId, { exact: true })).toBeVisible();
    const creation = overview.locator("time");
    await expect(creation).toHaveAttribute("datetime", createdAt);
    await expect(creation).toHaveText(new Date(createdAt).toLocaleString("en", { timeZone: "Asia/Shanghai" }));
    const renameButton = overview.getByRole("button", { name: "Rename Workspace", exact: true });
    const archiveButton = basics.getByRole("button", { name: "Archive Workspace", exact: true });
    const archiveHint = basics.getByText("Archiving makes this workspace read-only.", { exact: true });
    await expect(archiveButton).toHaveAccessibleDescription("Archiving makes this workspace read-only.");
    const [titleBox, renameBox, keyBox, createdBox, identityBox, archiveBox, overviewBox, hintBox] = await Promise.all([
        overview.getByRole("heading", { name: key, exact: true }).boundingBox(),
        renameButton.boundingBox(),
        overview.getByText("Key", { exact: true }).locator("..").boundingBox(),
        overview.getByText("Created", { exact: true }).locator("..").boundingBox(),
        overview.getByText("Workspace ID", { exact: true }).locator("..").boundingBox(),
        archiveButton.boundingBox(),
        overview.boundingBox(),
        archiveHint.boundingBox(),
    ]);
    if (!titleBox || !renameBox || !keyBox || !createdBox || !identityBox || !archiveBox || !overviewBox || !hintBox) {
        throw new Error("Workspace overview controls and details must be visible");
    }
    expect(renameBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);
    expect(Math.abs(keyBox.y - createdBox.y)).toBeLessThanOrEqual(1);
    expect(createdBox.x).toBeGreaterThanOrEqual(keyBox.x + keyBox.width);
    expect(identityBox.width).toBeGreaterThan(keyBox.width + createdBox.width);
    expect(identityBox.y).toBeGreaterThan(keyBox.y + keyBox.height);
    expect(archiveBox.y).toBeGreaterThan(overviewBox.y + overviewBox.height);
    expect(archiveBox.width).toBe(renameBox.width);
    expect(Math.abs(archiveBox.x + archiveBox.width - renameBox.x - renameBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(hintBox.y + hintBox.height / 2 - archiveBox.y - archiveBox.height / 2)).toBeLessThanOrEqual(1);
    const archiveGap = archiveBox.x - (hintBox.x + hintBox.width);
    expect(archiveGap).toBeGreaterThan(0);
    expect(archiveGap).toBeLessThanOrEqual(16);
    await expect(archiveHint.locator("..")).toHaveCSS("border-top-width", "0px");
    await expect(renameButton).toHaveCSS("background-color", "rgb(253, 242, 217)");
    await expect(renameButton).toHaveCSS("color", "rgb(121, 82, 14)");
    await renameButton.hover();
    await expect(renameButton).toHaveCSS("background-color", "rgb(250, 229, 169)");

    await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    const copy = overview.getByRole("button", { name: "Copy Workspace ID", exact: true });
    const copyBox = await copy.boundingBox();
    const copyStatus = overview.getByRole("status");
    await copy.press("Shift+Tab");
    await expect(renameButton).toBeFocused();
    await expect(renameButton).toHaveCSS("background-color", "rgb(247, 216, 136)");
    await copy.press("Enter");
    const checkmark = copy.locator("svg use");
    await expect(checkmark).toHaveAttribute("href", /#check$/);
    await expect.poll(() => checkmark.evaluate((icon) => (icon as SVGUseElement).getBBox().width)).toBeGreaterThan(0);
    await expect(copyStatus).toHaveText("Workspace ID copied.");
    await expect(copyStatus).toHaveCSS("position", "absolute");
    await expect(copyStatus).toHaveCSS("width", "1px");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(workspaceId);
    await expect(copy).toBeFocused();
    expect(await copy.boundingBox()).toEqual(copyBox);
    await basics.screenshot({ path: testInfo.outputPath("workspace-overview-light-en.png") });

    const theme = page.getByRole("banner").getByRole("button", { name: "Dark mode", exact: true });
    await theme.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await chooseLanguage(page, "zh");
    const localized = page.getByRole("tabpanel", { name: "基本信息", exact: true });
    await expect(localized.getByText("有效", { exact: true })).toBeVisible();
    await expect(localized.getByRole("status")).toHaveText("工作区 ID 已复制。");
    const zhCopy = localized.getByRole("button", { name: "复制工作区 ID", exact: true });
    await expect(zhCopy.locator("svg use")).toHaveAttribute("href", /#check$/);
    const zhRename = localized.getByRole("button", { name: "重命名工作区", exact: true });
    const zhArchive = localized.getByRole("button", { name: "归档工作区", exact: true });
    const [zhRenameBox, zhArchiveBox] = await Promise.all([zhRename.boundingBox(), zhArchive.boundingBox()]);
    if (!zhRenameBox || !zhArchiveBox) throw new Error("Localized Workspace actions must be visible");
    expect(zhRenameBox.width).toBe(zhArchiveBox.width);
    expect(Math.abs(zhArchiveBox.x + zhArchiveBox.width - zhRenameBox.x - zhRenameBox.width)).toBeLessThanOrEqual(1);
    await expect(zhRename).toHaveCSS("background-color", "rgb(66, 51, 25)");
    await expect(zhRename).toHaveCSS("color", "rgb(254, 223, 137)");
    await zhRename.hover();
    await expect(zhRename).toHaveCSS("background-color", "rgb(85, 67, 29)");
    await zhCopy.press("Shift+Tab");
    await expect(zhRename).toBeFocused();
    await expect(zhRename).toHaveCSS("background-color", "rgb(103, 79, 31)");
    await expect(localized.locator("time")).toHaveText(
        new Date(createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    );
    await localized.screenshot({ path: testInfo.outputPath("workspace-overview-dark-zh.png") });
    await chooseLanguage(page, "en");

    await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, "writeText", {
            configurable: true,
            value: () => Promise.reject(new DOMException("Clipboard access declined", "NotAllowedError")),
        });
    });
    await copy.press("Enter");
    await expect(copyStatus).toHaveText("Workspace ID could not be copied.");
    await expect(copyStatus).toHaveCSS("width", "1px");
    await expect(copy.locator("svg use")).toHaveCount(0);

    await renameButton.click();
    const rename = page.getByRole("dialog", { name: "Rename Workspace", exact: true });
    await rename.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(renameButton).toBeFocused();
    await renameButton.click();
    await rename.getByRole("textbox", { name: "Name", exact: true }).fill("Updated via settings");
    const renameSubmit = rename.getByRole("button", { name: "Rename Workspace", exact: true });
    await expect(renameSubmit).toHaveCSS("background-color", "rgb(70, 95, 255)");
    await renameSubmit.click();
    await acknowledgeOperation(page, "Workspace updated");
    await expect(basics.getByRole("heading", { name: "Updated via settings", exact: true })).toBeVisible();
    await archiveButton.click();
    const archive = page.getByRole("dialog", { name: "Archive Workspace", exact: true });
    await archive.getByRole("button", { name: "Archive Workspace", exact: true }).click();
    await acknowledgeOperation(page, "Workspace archived");
    await expect(basics).toContainText("Archived Workspaces are read-only.");
    await expect(basics.getByText("Archived", { exact: true })).toBeVisible();
    await expect(basics.getByRole("button", { name: "Rename Workspace", exact: true })).toHaveCount(0);
    await expect(archiveButton).toHaveCount(0);
});

/**
 * 在桌面最小支持宽度核对两个表格的工具栏和菜单字号，并通过键盘退出嵌套菜单，检查焦点逐级返回。
 */
test("Workspace lists group tools and keyboard filters in both languages", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installed(page);
    const { workspaceId } = await editorScope(page, `workspace-toolbar-${randomUUID()}`);
    await page.goto("/workspaces?tab=members");
    await chooseWorkspace(page, workspaceId);
    for (const { language, panelName, prefix, controls, toolbars } of [
        {
            language: "en",
            panelName: "Members",
            prefix: "Help for",
            controls: ["Rows per page", "Filter", "See all", "Download"],
            toolbars: [
                ["Search users", "Role", "Membership", "Account status", "System administrator"],
                ["Search email", "Role", "Status"],
            ],
        },
        {
            language: "zh",
            panelName: "成员",
            prefix: "字段帮助",
            controls: ["每页条数", "筛选", "查看全部", "下载"],
            toolbars: [
                ["搜索用户", "角色", "成员状态", "账号状态", "系统管理员"],
                ["搜索邮箱", "角色", "状态"],
            ],
        },
    ] as const) {
        await chooseLanguage(page, language);
        const panel = page.getByRole("tabpanel", { name: panelName, exact: true });
        for (const [search, ...filters] of toolbars) {
            const searchbox = page.getByRole("searchbox", { name: search, exact: true });
            const toolbar = panel.locator(".vq-data-table-toolbar").filter({ has: searchbox });
            const [sizeName, filterName, resetName, downloadName] = controls;
            const pageSize = toolbar.getByRole("combobox", { name: sizeName, exact: true });
            const filter = toolbar.getByRole("button", { name: filterName, exact: true });
            const reset = toolbar.getByRole("button", { name: resetName, exact: true });
            const download = toolbar.getByRole("button", { name: downloadName, exact: true });
            await expect(toolbar.locator(".vq-data-table-controls").getByRole("searchbox")).toBeVisible();
            await expect(searchbox).toHaveAttribute("placeholder", search);
            await expect(toolbar.getByText(search, { exact: true })).toBeHidden();
            await expect(toolbar.getByRole("button", { name: new RegExp(`^${prefix} `) })).toHaveCount(0);
            await expect(filter).toBeVisible();
            const positions = await Promise.all(
                [pageSize, searchbox, filter, reset, download].map((control) => control.boundingBox()),
            );
            for (let index = 1; index < positions.length; index++) {
                const previous = positions[index - 1];
                const next = positions[index];
                if (!previous || !next) throw new Error("Missing visible Workspace table action");
                expect(next.x).toBeGreaterThan(previous.x + previous.width);
                expect(Math.abs(previous.y + previous.height / 2 - next.y - next.height / 2)).toBeLessThanOrEqual(1);
            }
            const fontSize = await searchbox.evaluate((node) => getComputedStyle(node).fontSize);
            const iconOffset = await download.evaluate((button) => {
                const icon = button.querySelector("svg")?.getBoundingClientRect();
                const label = Array.from(button.childNodes).find((child) => child.nodeType === Node.TEXT_NODE);
                if (!icon || !label) throw new Error("Missing a download icon or label");
                const range = document.createRange();
                range.selectNodeContents(label);
                const text = range.getBoundingClientRect();
                return {
                    center: Math.abs(icon.y + icon.height / 2 - text.y - text.height / 2),
                    gap: text.x - icon.right,
                };
            });
            expect(iconOffset.center).toBeLessThanOrEqual(2);
            expect(iconOffset.gap).toBeGreaterThanOrEqual(4);
            await expect(panel.locator(".vq-data-table-filters")).toHaveCount(0);
            await filter.press("Enter");
            const menu = page.getByRole("menu", { name: filterName, exact: true });
            if (language === "en" && search === "Search users") {
                await expect(menu).toBeVisible();
                await page.screenshot({ path: testInfo.outputPath("members-filter-menu.png") });
            }
            for (const name of filters) {
                const control = menu.getByRole("menuitem", { name, exact: true });
                await expect(control).toHaveCSS("font-size", fontSize);

                await control.press("ArrowRight");
                const submenu = page.getByRole("menu", { name, exact: true });
                const options = submenu.getByRole("menuitemcheckbox").or(submenu.getByRole("menuitemradio"));
                await expect(options.first()).toBeVisible();
                for (const option of await options.all()) {
                    await expect(option).toHaveCSS("font-size", fontSize);
                }
                await page.keyboard.press("Escape");
                await expect(submenu).toBeHidden();
                await expect(control).toBeFocused();
            }
            await page.keyboard.press("Escape");
            await expect(menu).toBeHidden();
            await expect(filter).toBeFocused();
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
    }
});

/**
 * 只观察两个工作区身份摘要接口，避免把同一路由下正常的资源或成员请求误认为敏感面板已经在后台挂载。
 */
function observeIdentityRequests(page: Page) {
    const paths: string[] = [];
    page.on("request", (request) => {
        const { pathname } = new URL(request.url());
        if (/^\/api\/v1\/workspaces\/[^/]+\/(credentials|auth-adapters)$/.test(pathname)) paths.push(pathname);
    });
    return paths;
}

/**
 * 执行环境作为普通资源页刷新时不请求凭证摘要，从草稿身份入口转到工作区设置后才加载数据库中的认证配置。
 * 关闭敏感表单所属页签后再次进入，浏览器内先前未提交的令牌必须清空。
 */
test("execution environments link to Workspace authentication and credentials", async ({ page }) => {
    await installed(page);
    const { workspaceId } = await editorScope(page, `identity-route-${randomUUID()}`);
    const identityRequests = observeIdentityRequests(page);
    await page.goto("/resources/environments");
    await expect(page.getByRole("heading", { name: "Execution environments", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Environments", exact: true })).toHaveAttribute(
        "href",
        "/resources/environments",
    );
    await chooseWorkspace(page, workspaceId);
    await page.getByRole("button", { name: "New execution environment", exact: true }).click();
    const form = resourceCreateForm(page);
    await form.getByLabel("Key", { exact: true }).fill("identity-environment");
    await form.getByLabel("Name", { exact: true }).fill("Identity environment");
    await form.getByRole("button", { name: "Create resource" }).click();
    await acknowledgeOperation(page, "Resource created");
    const authLink = page.getByRole("link", { name: "Manage authentication and credentials" });
    await expect(authLink).toBeVisible();
    expect(identityRequests).toEqual([]);
    await page.reload();
    await chooseWorkspace(page, workspaceId);
    await page.getByRole("button", { name: "Identity environment", exact: true }).click();
    const authenticationPath = `/workspaces?tab=auth-credentials&workspaceId=${workspaceId}`;
    await expect(authLink).toHaveAttribute("href", authenticationPath);
    await authLink.click();
    await expect(page).toHaveURL(authenticationPath);
    const panel = page.getByRole("tabpanel", { name: "Authentication and credentials" });
    const credentialTab = panel.getByRole("tab", { name: "Credential versions" });
    const adapterTable = panel.getByRole("table", { name: "Authentication adapter versions" });
    const emptyAdapters = adapterTable.getByRole("cell", { name: "No adapters.", exact: true });
    const credentialTable = panel.getByRole("table", { name: "Credential version list", exact: true });
    const emptyCredentials = credentialTable.getByRole("cell", { name: "No credentials.", exact: true });
    await expect(emptyAdapters).toHaveCSS("text-align", "center");
    await credentialTab.click();
    await expect(emptyCredentials).toHaveCSS("text-align", "center");
    expect(identityRequests).toContain(`/api/v1/workspaces/${workspaceId}/credentials`);
    expect(identityRequests).toContain(`/api/v1/workspaces/${workspaceId}/auth-adapters`);
    const token = panel.getByLabel("Bearer token");
    await token.fill("navigation-fixture-only");
    await page.getByRole("tab", { name: "Members" }).click();
    await expect(token).toHaveCount(0);
    await expect(page).toHaveURL("/workspaces?tab=members");
    await page.goBack();
    await credentialTab.click();
    await expect(token).toHaveValue("");
    identityRequests.length = 0;
    await page.reload();
    await expect(emptyAdapters).toBeVisible();
    await credentialTab.click();
    await expect(emptyCredentials).toBeVisible();
    expect(new Set(identityRequests)).toEqual(
        new Set([`/api/v1/workspaces/${workspaceId}/credentials`, `/api/v1/workspaces/${workspaceId}/auth-adapters`]),
    );
    const memberTab = page.getByRole("tab", { name: "Members" });
    const authenticationTab = page.getByRole("tab", { name: "Authentication and credentials" });
    await memberTab.click();
    await expect(memberTab).toHaveAttribute("aria-selected", "true");
    await memberTab.press("ArrowRight");
    await expect(authenticationTab).toBeFocused();
    await authenticationTab.press("Enter");
    await expect(page).toHaveURL("/workspaces?tab=auth-credentials");
    await expect(authenticationTab).toBeFocused();
    await expect(emptyAdapters).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
    const requested = identityRequests.length;
    await page.goto("/workspaces?tab=auth-credentials&workspaceId=missing");
    await expect(page.getByRole("alert")).toContainText("Invalid Workspace link.");
    await expect(panel).toHaveCount(0);
    expect(identityRequests).toHaveLength(requested);
});

/**
 * 使用真实邀请建立只读成员，直接打开身份页签再刷新，确认两次进入均不会发起认证与凭证摘要请求。
 */
test("Workspace viewers can open the credential tab without loading identity summaries", async ({ page, browser }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `identity-viewer-${randomUUID()}`);
    const privateWorkspace = await page.request.post("/api/v1/workspaces", {
        headers,
        data: { key: `identity-private-${randomUUID()}`, name: "Private identity Workspace" },
    });
    expect(privateWorkspace.status()).toBe(201);
    const privateId: string = (await privateWorkspace.json()).data.id;
    const provider = await page.request.post(`/api/v1/workspaces/${workspaceId}/ai/providers`, {
        headers,
        data: {
            name: "Visible provider",
            adapter: "OPENAI_COMPATIBLE",
            baseURL: "https://api.openai.com/v1",
            model: "viewer-fixture",
            apiKey: "offline-viewer-fixture-key",
            enabled: false,
            monthlyBudgetUsd: 1,
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 2,
            maxOutputTokens: 1024,
            maxRequestUsd: 0.5,
        },
    });
    expect(provider.status()).toBe(201);
    const email = `identity-viewer-${randomUUID()}@example.com`;
    const password = "Identity viewer password 123!";
    const invite = await page.request.post(`/api/v1/workspaces/${workspaceId}/invitations`, {
        headers,
        data: { email, role: "VIEWER", sendEmail: false },
    });
    expect(invite.status()).toBe(201);
    const invitation: string = (await invite.json()).data.invitationUrl;
    const context = await browser.newContext();
    try {
        const viewer = await context.newPage();
        await viewer.goto(invitation);
        await viewer.getByLabel("Create a new account").check();
        await viewer.getByLabel("Display name").fill("Identity test viewer");
        await viewer.getByLabel("Password").fill(password);
        await viewer.getByRole("button", { name: "Accept invitation" }).click();
        const accepted = viewer.getByRole("dialog", { name: "Operation succeeded", exact: true });
        await expect(accepted).toContainText("Invitation accepted.");
        await accepted.getByRole("button", { name: "OK" }).click();
        await expect(viewer.getByRole("status")).toContainText("Invitation accepted");
        await viewer.goto(new URL("/login", invitation).href);
        await viewer.getByRole("textbox", { name: "Email" }).fill(email);
        await viewer.getByLabel("Password").fill(password);
        await viewer.getByRole("button", { name: "Sign in" }).click();
        await expect(viewer.locator("dl")).toBeVisible();
        const path = new URL("/workspaces?tab=auth-credentials", viewer.url()).href;
        const requests = observeIdentityRequests(viewer);
        await viewer.goto(path);
        const panel = viewer.getByRole("tabpanel", { name: "Authentication and credentials" });
        await expect(panel).toContainText("Only Workspace owners and administrators can manage credentials.");
        await expect(panel.getByRole("button", { name: "Save credential version" })).toHaveCount(0);
        await viewer.reload();
        await expect(panel).toBeVisible();
        await viewer.goto(`${path}&workspaceId=${privateId}`);
        await expect(viewer.getByRole("main").getByRole("alert")).toBeVisible();
        await expect(panel).toHaveCount(0);
        expect(requests).toEqual([]);
        await viewer.goto(new URL("/workspaces", viewer.url()).href);
        const basics = viewer.getByRole("tabpanel", { name: "Basic information", exact: true });
        await expect(basics.getByText(workspaceId, { exact: true })).toBeVisible();
        await expect(basics.getByRole("button", { name: "Copy Workspace ID", exact: true })).toBeEnabled();
        await expect(basics.getByRole("button", { name: "Rename Workspace", exact: true })).toHaveCount(0);
        await expect(basics.getByRole("button", { name: "Archive Workspace", exact: true })).toHaveCount(0);
        await viewer.goto(new URL(`/workspaces?tab=ai-providers&workspaceId=${workspaceId}`, viewer.url()).href);
        const providers = viewer.getByRole("tabpanel", { name: "AI providers" });
        await expect(providers.getByRole("cell", { name: "Visible provider" })).toBeVisible();
        await expect(providers.getByRole("button", { name: "Download", exact: true })).toBeDisabled();
        const search = providers.getByRole("searchbox", { name: "Search providers", exact: true });
        await search.fill("absent provider");
        await expect(providers.getByText("No matching providers.", { exact: true })).toBeVisible();
    } finally {
        await context.close();
    }
});

/**
 * 用工作区设置的目录、写入表单与确认弹窗完成停用提供方的维护，并核对独立 AI 页只消费同一份已保存配置。
 * 键盘和浏览器历史检查使用支持的桌面宽度；切换工作区后只允许保留服务端已保存的字段。
 */
test("workspace settings tabs isolate member management and provider configuration", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installed(page);
    const scope = await editorScope(page, `tabs-${randomUUID()}`);
    const other = await page.request.post("/api/v1/workspaces", {
        headers: scope.headers,
        data: { name: "Second settings space", key: `tabs-${randomUUID()}` },
    });
    expect(other.status()).toBe(201);
    const otherId: string = (await other.json()).data.id;
    await page.goto("/workspaces?view=compact#settings");
    await chooseWorkspace(page, scope.workspaceId);
    const tabs = page.getByRole("tablist", { name: "Workspace settings" });
    await expect(tabs.getByRole("tab")).toHaveText([
        "Basic information",
        "Members",
        "Authentication and credentials",
        "AI providers",
    ]);
    const basic = tabs.getByRole("tab", { name: "Basic information" });
    const members = tabs.getByRole("tab", { name: "Members" });
    const ai = tabs.getByRole("tab", { name: "AI providers" });
    await expect(basic).toHaveAttribute("aria-selected", "true");
    await expect(
        page.getByRole("tabpanel", { name: "Basic information" }).getByRole("button", { name: "Rename Workspace" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Invite a member" })).toHaveCount(0);
    await expect(basic).toHaveCSS("border-bottom-color", "rgb(70, 95, 255)");
    await expect(basic).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(members).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
    await basic.press("ArrowRight");
    await expect(members).toBeFocused();
    await expect(basic).toHaveAttribute("aria-selected", "true");
    await expect(members).toHaveCSS("outline-style", "none");
    await expect(members).toHaveCSS("background-color", "rgb(110, 143, 210)");
    await members.press("Enter");
    await expect(page).toHaveURL(/view=compact&tab=members#settings$/);
    await expect(
        page.getByRole("tabpanel", { name: "Members" }).getByRole("button", { name: "Invite a member" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Rename Workspace" })).toHaveCount(0);
    const requests: string[] = [];
    page.on("request", (r) => requests.push(new URL(r.url()).pathname));
    await members.press("End");
    await expect(ai).toBeFocused();
    await ai.press("Space");
    const panel = page.getByRole("tabpanel", { name: "AI providers" });
    const newProvider = panel.getByRole("button", { name: "New provider", exact: true });
    const nameField = panel.getByRole("textbox", { name: "Name", exact: true });
    const adapterField = panel.getByRole("combobox", { name: "Adapter", exact: true });
    const secretField = panel.getByLabel("Write-only API key");
    const save = panel.getByRole("button", { name: "Save provider" });
    const operationResult = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
    const providerPath = `/api/v1/workspaces/${scope.workspaceId}/ai/providers`;
    const table = panel.getByRole("table");
    const providerRow = (name: string) =>
        table.getByRole("row").filter({ has: page.getByRole("cell", { name, exact: true }) });
    await newProvider.click();
    await expect(panel.getByRole("heading", { name: "New provider", exact: true })).toBeVisible();
    await expect(nameField).toHaveAccessibleDescription(
        "Use a name that identifies this configuration in the provider list.",
    );
    await expect(secretField).toHaveAccessibleDescription(
        "Write-only. Leave blank when editing to keep the existing key.",
    );
    await expect(adapterField).toHaveAttribute("aria-required", "true");
    await expect(adapterField).toHaveText(/OPENAI_COMPATIBLE/);
    await adapterField.click();
    await page.getByRole("option", { name: "ANTHROPIC", exact: true }).click();
    await expect(adapterField).toHaveText(/ANTHROPIC/);
    await adapterField.click();
    await page.getByRole("option", { name: "OPENAI_COMPATIBLE", exact: true }).click();
    await nameField.fill("Disabled UI provider");
    await panel.getByRole("textbox", { name: "Model", exact: true }).fill("disabled-fixture");
    await secretField.fill("disabled-ui-test-key");
    await panel.getByLabel("Monthly budget USD").fill("7");
    const created = page.waitForResponse(
        (response) => new URL(response.url()).pathname === providerPath && response.request().method() === "POST",
    );
    await save.click();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    await operationResult.getByRole("button", { name: "OK" }).click();
    const originalId: string = (await createdResponse.json()).data.id;
    const original = providerRow("Disabled UI provider");
    await expect(original.getByRole("cell", { name: "Disabled", exact: true })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Budget", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Test connection" })).toBeDisabled();
    await expect(secretField).toHaveValue("");
    await expect(panel.getByText("Call history", { exact: true })).toHaveCount(0);
    expect(requests).toContain(providerPath);
    expect(requests).not.toContain(`${providerPath}/${originalId}/connection-tests`);
    expect(requests).not.toContain(`/api/v1/workspaces/${scope.workspaceId}/ai/generations`);
    expect(requests).not.toContain(`/api/v1/workspaces/${scope.workspaceId}/resources`);
    await page.goBack();
    await expect(members).toHaveAttribute("aria-selected", "true");
    await page.goForward();
    await expect(ai).toHaveAttribute("aria-selected", "true");
    await ai.press("Home");
    await expect(basic).toBeFocused();
    await expect(ai).toHaveAttribute("aria-selected", "true");
    await page.getByRole("banner").getByRole("button", { name: "Dark mode" }).click();
    await expect(ai).toHaveCSS("border-bottom-color", "rgb(117, 146, 255)");
    await expect(ai).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(basic).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
    await expect(tabs).toHaveCSS("height", "48px");
    for (const button of await tabs.getByRole("tab").all()) {
        await expect(button).toHaveCSS("font-size", "12px");
        await expect(button.locator("svg")).toHaveCSS("width", "16px");
        await expect(button).toBeInViewport({ ratio: 1 });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
    await secretField.fill("unsubmitted-fixture-key");
    await chooseWorkspace(page, otherId);
    await expect(panel.getByText("No providers configured.", { exact: false })).toBeVisible();
    await expect(original).toHaveCount(0);
    await expect(secretField).toHaveValue("");
    await chooseWorkspace(page, scope.workspaceId);
    await expect(original).toBeVisible();
    await expect(secretField).toHaveValue("");
    const aiPicker = page.getByRole("combobox", { name: "Provider", exact: true });
    /*
     * 按服务端列表对应的原始标识核对选中项，再验证触发器显示相同名称且下拉选项确实处于选中状态。
     */
    const expectSelectedProvider = async (id: string, name: string) => {
        const listed = await page.request.get(providerPath);
        expect(listed.status()).toBe(200);
        const items: { id: string; name: string; enabled: boolean }[] = (await listed.json()).data.items;
        expect(items.map((item) => [item.id, item.name, item.enabled])).toEqual([[id, name, false]]);
        const label = `${name} · Disabled`;
        await expect(aiPicker).toContainText(label);
        await aiPicker.click();
        await expect(page.getByRole("option", { name: label, exact: true })).toHaveAttribute("aria-selected", "true");
        await page.keyboard.press("Escape");
    };
    await page.getByRole("link", { name: "AI", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Call history" })).toBeVisible();
    await expectSelectedProvider(originalId, "Disabled UI provider");
    await page.getByRole("link", { name: "Workspace settings", exact: true }).click();
    await ai.click();
    await original.getByRole("button", { name: "Edit · Disabled UI provider", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Edit · Disabled UI provider", exact: true })).toBeVisible();
    await expect(nameField).toHaveValue("Disabled UI provider");
    await expect(secretField).toHaveValue("");
    await nameField.fill("Updated UI provider");
    const updated = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === `${providerPath}/${originalId}` &&
            response.request().method() === "PUT",
    );
    await save.click();
    expect((await updated).status()).toBe(200);
    await operationResult.getByRole("button", { name: "OK" }).click();
    const edited = providerRow("Updated UI provider");
    await expect(edited).toBeVisible();
    await expect(original).toHaveCount(0);
    await newProvider.click();
    await expect(nameField).toHaveValue("");
    await nameField.fill("Remaining UI provider");
    await panel.getByRole("textbox", { name: "Model", exact: true }).fill("disabled-fixture");
    await secretField.fill("remaining-ui-test-key");
    await panel.getByLabel("Monthly budget USD").fill("4");
    const added = page.waitForResponse(
        (response) => new URL(response.url()).pathname === providerPath && response.request().method() === "POST",
    );
    await save.click();
    const addedResponse = await added;
    expect(addedResponse.status()).toBe(201);
    await operationResult.getByRole("button", { name: "OK" }).click();
    const remainingId: string = (await addedResponse.json()).data.id;
    const remaining = providerRow("Remaining UI provider");
    await expect(remaining).toBeVisible();
    await edited.getByRole("button", { name: "Edit · Updated UI provider", exact: true }).click();
    const deleteProvider = panel.getByRole("button", { name: "Delete provider", exact: true });
    await expect(deleteProvider).toBeEnabled();
    await deleteProvider.click();
    const dialog = page.getByRole("dialog", { name: "Delete provider", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(edited).toBeVisible();

    // 保留服务端列表的真实响应，延后浏览器收到它的时机，以检查删除确认期间仍显示原编辑对象且禁止重复提交。
    // 等新目录加载完后应清空被删记录的表单，AI 页从剩余目录重新选中唯一可用的已保存项。
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
    });
    let captured!: (response: APIResponse) => void;
    const capturedResponse = new Promise<APIResponse>((resolve) => {
        captured = resolve;
    });
    await page.route(
        `**${providerPath}`,
        async (route) => {
            const response = await route.fetch();
            captured(response);
            await barrier;
            await route.fulfill({ response });
        },
        { times: 1 },
    );
    try {
        await deleteProvider.click();
        const confirm = dialog.getByRole("button", { name: "Delete provider", exact: true });
        const removed = page.waitForResponse(
            (response) =>
                new URL(response.url()).pathname === `${providerPath}/${originalId}` &&
                response.request().method() === "DELETE",
        );
        await confirm.click();
        expect((await removed).status()).toBe(200);
        const refreshed = await capturedResponse;
        expect(refreshed.status()).toBe(200);
        const providers: { id: string }[] = (await refreshed.json()).data.items;
        expect(providers.map(({ id }) => id)).toEqual([remainingId]);
        await expect(dialog).toBeVisible();
        await expect(confirm).toBeDisabled();
        // 确认弹窗打开时背景仍然绘制，但从无障碍树隐藏；这里只读取背景文本和字段值，不操作背景控件。
        await expect(page.getByText("Updated UI provider", { exact: true })).toBeVisible();
        await expect(page.locator(".vq-ai-form").getByLabel(/^\*?\s*Name$/)).toHaveValue("Updated UI provider");
    } finally {
        release();
    }
    await expect(dialog).toBeHidden();
    await operationResult.getByRole("button", { name: "OK" }).click();
    await expect(edited).toHaveCount(0);
    await expect(nameField).toHaveValue("");
    await expect(remaining.getByRole("cell", { name: /Available 4(?:\.0+)?$/ })).toBeVisible();
    await page.getByRole("link", { name: "AI", exact: true }).click();
    await expectSelectedProvider(remainingId, "Remaining UI provider");
});
