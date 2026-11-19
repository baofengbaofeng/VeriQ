/**
 * 语言回归通过真实安装状态、浏览器表单和已挂载的独立翻译实例观察当前界面，不构造权限、资源或报告响应；切换语言只改变展
 * 示与持久化偏好，未提交输入及其实际 DOM 节点必须保持原样。
 */
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createResource, editorScope } from "./editor-fixture";

import { installed } from "./support/install-console";

test.use({ locale: "en-US" });

test("global locale preserves unsent login fields and persists a supported preference", async ({ page }) => {
    await installed(page);
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ", exact: true })).toBeVisible();
    const email = page.getByRole("textbox", { name: "Email" });
    const password = page.getByLabel("Password");
    await email.fill("unsubmitted@example.com");
    await password.fill("unsubmitted password");
    const node = await email.elementHandle();
    if (!node) throw new Error("Missing actual email input");
    await page.getByLabel("Language").selectOption("zh");
    await expect(page.getByRole("heading", { name: "登录 VeriQ", exact: true })).toBeVisible();
    const localizedEmail = page.getByRole("textbox", { name: "邮箱", exact: true });
    await expect(localizedEmail).toHaveValue("unsubmitted@example.com");
    await expect(page.getByLabel(/^密码/)).toHaveValue("unsubmitted password");
    expect(await localizedEmail.evaluate((current, retained) => current === retained, node)).toBe(true);
    await page.reload();
    await expect(page.getByRole("combobox", { name: "语言", exact: true, includeHidden: true })).toHaveValue("zh");
    await expect(page.getByRole("heading", { name: "登录 VeriQ", exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "语言", exact: true, includeHidden: true }).selectOption("en");
    await page.getByRole("link", { name: "Forgot password?", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Reset your password", exact: true })).toBeFocused();
});

test("editor and AI locale events synchronize without replacing unsaved resource controls", async ({ page }) => {
    await installed(page);
    await editorScope(page, `locale-${randomUUID()}`);
    await createResource(page, "DATASET", `locale-data-${randomUUID()}`);
    const name = page.getByLabel("Row key", { exact: true });
    await name.fill("unsaved_localized_row");
    const node = await name.elementHandle();
    if (!node) throw new Error("Missing actual resource input");
    await page.evaluate(async () => {
        const modulePath = "/src/features/resources/i18n.ts";
        const { editorI18n } = await import(/* @vite-ignore */ modulePath);
        await editorI18n.changeLanguage("zh");
    });
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page.getByRole("link", { name: "工作区设置", exact: true, includeHidden: true })).toBeVisible();
    const localizedName = page.getByLabel("数据行 key", { exact: true });
    await expect(localizedName).toHaveValue("unsaved_localized_row");
    expect(await localizedName.evaluate((current, retained) => current === retained, node)).toBe(true);
    await page.evaluate(async () => {
        const modulePath = "/src/features/ai/i18n.ts";
        const { aiI18n } = await import(/* @vite-ignore */ modulePath);
        await aiI18n.changeLanguage("en");
    });
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(
        page.getByRole("link", { name: "Workspace settings", exact: true, includeHidden: true }),
    ).toBeVisible();
    await expect(name).toHaveValue("unsaved_localized_row");
    expect(await name.evaluate((current, retained) => current === retained, node)).toBe(true);
});

test.describe("Chinese browser preference", () => {
    test.use({ locale: "zh-CN" });
    test("invalid stored values fall back to the browser and the skip link reaches the main landmark", async ({
        page,
    }) => {
        await installed(page);
        await page.addInitScript(() => localStorage.setItem("veriq.language", "unsupported-locale"));
        await page.goto("/login");
        await expect(page.getByRole("combobox", { name: "语言", exact: true, includeHidden: true })).toHaveValue("zh");
        await expect(page.getByRole("heading", { name: "登录 VeriQ", exact: true })).toBeVisible();
        await page.keyboard.press("Tab");
        await expect(page.getByRole("link", { name: "跳至主要内容", exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page.locator("#main-content")).toBeFocused();
    });
});
