/**
 * 浏览器从真实登录入口访问各菜单和访客页，核对面包屑可导航、随路径及语言变化，并在内容画布上统一呈现。
 */
import { expect, test, type Page } from "@playwright/test";
import { installed } from "../support/install-console";

/**
 * 检查可访问导航和当前项，SVG 仅供视觉辨识；首页仍是站内链接，不将整条路径合并成不可点击的标签。
 */
async function expectBreadcrumb(page: Page, current: string, label = "Breadcrumb", home = "Home") {
    const breadcrumb = page.getByRole("navigation", { name: label, exact: true });
    await expect(breadcrumb).toHaveCount(1);
    await expect(page.getByRole("main").getByRole("navigation", { name: label, exact: true })).toBeVisible();
    await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(current);
    const homeLink = breadcrumb.getByRole("link", { name: home, exact: true });
    await expect(homeLink).toHaveAttribute("href", "/");
    await expect(homeLink.locator('svg[aria-hidden="true"]')).toHaveCSS("width", "16px");
    await expect(breadcrumb.locator("ol")).toHaveCSS("font-size", "12px");
    return breadcrumb;
}

/**
 * 通过键盘打开个人设置后，读取主标题的裁切状态、焦点及资料卡间距，确认面包屑仍显示当前页面名称。
 */
test("the profile breadcrumb remains visible without a second heading row", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installed(page);
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL("/account");
    await page.goto("/admin/users");
    await page.getByRole("button", { name: "Browser Administrator", exact: true }).press("Enter");
    await page.getByRole("menuitem", { name: "Account settings", exact: true }).press("Enter");
    await expect(page).toHaveURL("/account");
    const breadcrumb = await expectBreadcrumb(page, "Profile");
    const heading = page.getByRole("heading", { name: "Profile", exact: true, level: 1 });
    await expect(heading).toBeFocused();
    await expect(heading).toHaveCSS("clip", "rect(0px, 0px, 0px, 0px)");
    const profile = page.locator(".vq-profile");
    await expect(profile).toBeVisible();
    const [breadcrumbBox, profileBox] = await Promise.all([breadcrumb.boundingBox(), profile.boundingBox()]);
    if (!breadcrumbBox || !profileBox) throw new Error("Expected visible breadcrumb and profile");
    expect(profileBox.y - breadcrumbBox.y - breadcrumbBox.height).toBeCloseTo(16, 1);
});

test("all console routes share the icon breadcrumb below the header", async ({ page }) => {
    test.setTimeout(90_000);
    await installed(page);
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL("/account");
    await expectBreadcrumb(page, "Profile");

    /**
     * 用真实地址验证直接访问，覆盖普通页、资源子菜单以及没有独立侧栏入口的邀请和错误页面。
     */
    const routes = [
        ["/admin/users", "Users"],
        ["/workspaces?tab=members", "Workspace settings"],
        ["/runtimes", "Runtimes"],
        ["/resources/element-catalogs", "Element catalogs"],
        ["/resources/datasets", "Datasets"],
        ["/resources/fixtures", "Fixtures"],
        ["/resources/assertion", "Assertion"],
        ["/resources/environments", "Execution environments"],
        ["/resources/flows", "Flows"],
        ["/resources/cases", "Cases"],
        ["/resources/suites", "Suites"],
        ["/agent", "Test Agent"],
        ["/ai", "AI"],
        ["/reports", "Reports"],
        ["/execution-plans", "Plans"],
        ["/invitations/accept", "Accept Workspace invitation"],
        ["/resources/assertion-templates", "Page not found"],
        ["/missing-page", "Page not found"],
    ];
    for (const [path, name] of routes) {
        await page.goto(path);
        await expectBreadcrumb(page, name);
    }

    await page.goto("/resources/datasets");
    const breadcrumb = await expectBreadcrumb(page, "Datasets");
    await expect(breadcrumb.getByText("Authoring", { exact: true })).toBeVisible();
    await expect(breadcrumb.getByRole("link")).toHaveCount(1);
    await expect(breadcrumb.locator('li > svg[aria-hidden="true"]').first()).toHaveCSS("width", "16px");
    await expect(breadcrumb).toHaveCSS("background-color", "rgb(249, 250, 251)");
    const banner = page.getByRole("banner");
    const headerBox = await banner.boundingBox();
    const breadcrumbBox = await breadcrumb.boundingBox();
    if (!headerBox || !breadcrumbBox) throw new Error("Breadcrumb and header must have visible bounds");
    expect(breadcrumbBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Fixtures" }).click();
    await expectBreadcrumb(page, "Fixtures");
    await page.goBack();
    await expectBreadcrumb(page, "Datasets");
    await banner.getByRole("button", { name: "Dark mode" }).click();
    await expect(breadcrumb).toHaveCSS("background-color", "rgb(16, 24, 40)");
    await expect(breadcrumb.locator('[aria-current="page"]')).toHaveCSS("color", "rgb(242, 244, 247)");
    await banner.getByRole("button", { name: "Browser Administrator" }).click();
    await page.getByRole("menuitem", { name: /Language/ }).press("ArrowRight");
    await page.getByRole("menuitemradio", { name: "中文" }).click();
    const localized = await expectBreadcrumb(page, "数据集", "面包屑导航", "首页");
    await localized.getByRole("link", { name: "首页", exact: true }).click();
    await expect(page).toHaveURL("/account");
    await expectBreadcrumb(page, "个人资料", "面包屑导航", "首页");
});

test("public and standalone pages show one breadcrumb and keep the console menu private", async ({ page }) => {
    await installed(page);
    for (const [path, name] of [
        ["/login", "Sign in to VeriQ"],
        ["/setup", "Set up VeriQ"],
        ["/reset", "Reset your password"],
        ["/reset/confirm", "Choose a new password"],
        ["/invitations/accept", "Accept Workspace invitation"],
    ]) {
        await page.goto(path);
        await expectBreadcrumb(page, name);
        await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
    }

    await page.goto("/reset/confirm");
    const breadcrumb = await expectBreadcrumb(page, "Choose a new password");
    await breadcrumb.getByRole("link", { name: "Reset your password", exact: true }).click();
    await expect(page).toHaveURL("/reset");
    await expectBreadcrumb(page, "Reset your password");
});
