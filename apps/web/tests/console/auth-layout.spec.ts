/**
 * 认证页布局回归：登录页应为独立全屏分栏，左侧深色品牌面板与右上角主题/语言工具行，不再出现应用横幅；窄屏隐藏左栏。
 * 用真实安装状态观察，不构造权限或报告响应。
 */

import { expect, test } from "@playwright/test";
import { installed } from "../support/install-console";

test.beforeEach(async ({ page }) => installed(page));

/**
 * 登录页在初始化后呈现独立分栏：无 role=banner，左侧 complementary 品牌面板含 VeriQ 图片，右上角保留主题与语言切换，
 * 表单字段仍可访问。
 */
test("sign-in page renders the standalone split layout", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(0);
    const panel = page.getByRole("complementary");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("img", { name: "VeriQ" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Dark mode" })).toBeVisible();
    await expect(page.getByLabel("Language")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
});

/**
 * 窄屏隐藏左侧品牌面板，仅保留居中表单与右上角工具行。
 */
test("sign-in page hides the brand panel on narrow viewports", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 844 });
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await expect(page.getByRole("complementary")).toBeHidden();
    await expect(page.getByRole("button", { name: "Dark mode" })).toBeVisible();
});
