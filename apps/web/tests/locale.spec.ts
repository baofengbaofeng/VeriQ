/**
 * 语言回归通过真实安装状态、浏览器表单和已挂载的独立翻译实例观察当前界面，不构造权限、资源或报告响应；切换语言只改变展
 * 示与持久化偏好，未提交输入及其实际 DOM 节点必须保持原样。
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createResource, editorScope } from "./editor-fixture";

test.use({ locale: "en-US" });

async function installed(page: Page): Promise<void> {
    const response = await page.request.get("/api/v1/setup");
    expect(response.status()).toBe(200);
    const setup = (await response.json()).data;
    if (setup.initialized) return;
    const created = await page.request.post("/api/v1/setup", {
        headers: { Origin: "http://127.0.0.1:5173", "X-CSRF-Token": setup.csrfToken },
        data: {
            installationSecret: "browser-operator-secret",
            email: "browser-admin@example.com",
            displayName: "Browser Administrator",
            password: "Browser password 123!",
        },
    });
    expect(created.status()).toBe(201);
}

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
    await expect(email).toHaveValue("unsubmitted@example.com");
    await expect(password).toHaveValue("unsubmitted password");
    expect(await email.evaluate((current, retained) => current === retained, node)).toBe(true);
    await page.reload();
    await expect(page.getByLabel("Language")).toHaveValue("zh");
    await expect(page.getByRole("heading", { name: "登录 VeriQ", exact: true })).toBeVisible();
    await page.getByLabel("Language").selectOption("en");
    await page.getByRole("link", { name: "Forgot password?", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Reset your password", exact: true })).toBeFocused();
});

test("editor and AI locale events synchronize without replacing unsaved resource controls", async ({ page }) => {
    await installed(page);
    await editorScope(page, `locale-${randomUUID()}`);
    await createResource(page, "DATASET", `locale-data-${randomUUID()}`);
    const name = page.getByLabel("Row key");
    await name.fill("unsaved_localized_row");
    const node = await name.elementHandle();
    if (!node) throw new Error("Missing actual resource input");
    await page.evaluate(async () => {
        const modulePath = "/src/features/resources/i18n.ts";
        const { editorI18n } = await import(/* @vite-ignore */ modulePath);
        await editorI18n.changeLanguage("zh");
    });
    await expect(page.getByLabel("Language")).toHaveValue("zh");
    await expect(page.getByRole("link", { name: "工作区", exact: true })).toBeVisible();
    await expect(name).toHaveValue("unsaved_localized_row");
    expect(await name.evaluate((current, retained) => current === retained, node)).toBe(true);
    await page.evaluate(async () => {
        const modulePath = "/src/features/ai/i18n.ts";
        const { aiI18n } = await import(/* @vite-ignore */ modulePath);
        await aiI18n.changeLanguage("en");
    });
    await expect(page.getByLabel("Language")).toHaveValue("en");
    await expect(page.getByRole("link", { name: "Workspaces", exact: true })).toBeVisible();
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
        await expect(page.getByLabel("Language")).toHaveValue("zh");
        await expect(page.getByRole("heading", { name: "登录 VeriQ", exact: true })).toBeVisible();
        await page.keyboard.press("Tab");
        await expect(page.getByRole("link", { name: "跳至主要内容", exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page.locator("#main-content")).toBeFocused();
    });
});
