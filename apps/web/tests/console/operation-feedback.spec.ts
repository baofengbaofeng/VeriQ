/**
 * 使用真实管理员会话与返回的版本标识验证操作结果弹窗，检查操作反馈、键盘关闭和列表呈现各自拥有正确的语义。
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { editorScope } from "../editor-fixture";
import { installed } from "../support/install-console";

test("adapter creation shows its returned version in the shared success dialog", async ({ page }) => {
    await installed(page);
    const { workspaceId } = await editorScope(page, `operation-feedback-${randomUUID()}`);
    await page.goto(`/workspaces?tab=auth-credentials&workspaceId=${workspaceId}`);
    const posted = page.waitForResponse(
        (response) =>
            response.request().method() === "POST" &&
            response.url().endsWith(`/workspaces/${workspaceId}/auth-adapters`),
    );
    await page.getByRole("button", { name: "Create adapter version" }).click();
    const response = await posted;
    expect(response.status()).toBe(201);
    const versionId = (await response.json()).data.versionId;
    expect(versionId).toMatch(/^[\da-f-]{36}$/);
    const result = page.getByRole("dialog", { name: "Operation succeeded" });
    await expect(result).toBeVisible();
    await expect(result).toContainText(`Adapter created: ${versionId}`);
    await expect(result).toHaveCSS("border-radius", "16px");
    const ok = result.getByRole("button", { name: "OK", exact: true });
    await expect(ok).toBeFocused();
    await ok.press("Escape");
    await expect(result).toHaveCount(0);
    await expect(page.getByText(`Adapter created: ${versionId}`, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("table").getByText(versionId, { exact: true })).toBeVisible();
});

test("a rejected login uses the shared failure dialog and keeps the form usable", async ({ page }) => {
    await installed(page);
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill(`rejected-test-${randomUUID()}`);
    await page.getByRole("button", { name: "Sign in" }).click();
    const result = page.getByRole("dialog", { name: "Operation failed" });
    await expect(result).toBeVisible();
    await result.getByRole("button", { name: "Close", exact: true }).click();
    await expect(result).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
});
