/**
 * 以真实工作区的账户、邀请和模型提供方记录验证设置页的状态对比，切换主题后仍保留可辨认的徽章和原始状态文案。
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { editorScope } from "../editor-fixture";
import { chooseWorkspace } from "../support/console-controls";
import { installed } from "../support/install-console";

test.use({ viewport: { width: 1280, height: 800 } });

/**
 * 检查浏览器实际绘制的徽章布局、圆角与底色；仅出现原有状态文案时，这些断言必须观察到仍是普通表格单元格。
 */
async function expectBadge(badge: Locator, background: string) {
    await expect(badge).toBeVisible();
    await expect(badge).toHaveCSS("display", "inline-flex");
    await expect(badge).toHaveCSS("border-radius", "999px");
    await expect(badge).toHaveCSS("background-color", background);
}

/**
 * 用真实顶栏开关切换主题，确保深色根标记生效后，同一状态行仍使用相应主题的对比色。
 */
async function enableDarkMode(page: Page) {
    await page.getByRole("banner").getByRole("button", { name: "Dark mode", pressed: false }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
}

test("Workspace member account statuses use readable badges in both themes", async ({ page }) => {
    await installed(page);
    const key = `member-badges-${randomUUID()}`;
    const { workspaceId, headers } = await editorScope(page, key);
    for (const status of ["active", "disabled"]) {
        const response = await page.request.post("/api/v1/admin/users", {
            headers,
            data: {
                email: `${key}-${status}@example.com`,
                displayName: `Badge example ${status}`,
                password: "Workspace badge test password 123!",
                systemAdmin: false,
            },
        });
        expect(response.status()).toBe(201);
        if (status === "disabled") {
            const id: string = (await response.json()).data.id;
            const disabled = await page.request.patch(`/api/v1/admin/users/${id}`, {
                headers,
                data: { disabled: true },
            });
            expect(disabled.status()).toBe(200);
        }
    }
    await page.goto("/workspaces?tab=members");
    await chooseWorkspace(page, workspaceId);
    await page.getByPlaceholder("Search users").fill(key);
    const state = (status: string, label: string) =>
        page
            .getByRole("row")
            .filter({ hasText: `${key}-${status}@example.com` })
            .getByText(label, { exact: true });
    await expectBadge(state("active", "Active"), "rgb(229, 245, 237)");
    await expectBadge(state("disabled", "Disabled"), "rgb(242, 244, 247)");
    await enableDarkMode(page);
    await expectBadge(state("active", "Active"), "rgb(18, 59, 49)");
    await expectBadge(state("disabled", "Disabled"), "rgb(52, 64, 84)");
});

test("Workspace providers use enablement badges and a keyboard-accessible edit icon", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `provider-badges-${randomUUID()}`);
    for (const enabled of [true, false]) {
        const response = await page.request.post(`/api/v1/workspaces/${workspaceId}/ai/providers`, {
            headers,
            data: {
                name: enabled ? "Badge provider enabled" : "Badge provider disabled",
                adapter: "OPENAI_COMPATIBLE",
                baseURL: "https://api.openai.com/v1",
                model: "badge-fixture",
                apiKey: "offline-badge-fixture-key",
                enabled,
                monthlyBudgetUsd: 1,
                inputUsdPerMillion: 1,
                outputUsdPerMillion: 2,
                maxOutputTokens: 1024,
                maxRequestUsd: 0.5,
            },
        });
        expect(response.status()).toBe(201);
    }
    await page.goto("/workspaces?tab=ai-providers");
    await chooseWorkspace(page, workspaceId);
    const enabledRow = page.getByRole("row").filter({ hasText: "Badge provider enabled" });
    const enabled = enabledRow.getByText("Enabled", { exact: true });
    const disabled = page
        .getByRole("row")
        .filter({ hasText: "Badge provider disabled" })
        .getByText("Disabled", { exact: true });
    await expectBadge(enabled, "rgb(229, 245, 237)");
    await expectBadge(disabled, "rgb(242, 244, 247)");
    await enableDarkMode(page);
    await expectBadge(enabled, "rgb(18, 59, 49)");
    await expectBadge(disabled, "rgb(52, 64, 84)");
    const edit = enabledRow.getByRole("button", { name: /^Edit/ });
    await expect(edit).toHaveText("");
    await expect(edit).toHaveAccessibleName("Edit · Badge provider enabled");
    await expect(edit.locator("svg")).toBeVisible();
    await expect(edit.locator("svg")).toHaveAttribute("aria-hidden", "true");
    await edit.press("Enter");
    await expect(page.getByRole("heading", { name: "Edit · Badge provider enabled" })).toBeVisible();
});

test("Workspace invitation badges distinguish pending and revoked records", async ({ page }) => {
    await installed(page);
    const key = `invitation-badges-${randomUUID()}`;
    const { workspaceId, headers } = await editorScope(page, key);
    const email = `${key}@example.com`;
    const invite = await page.request.post(`/api/v1/workspaces/${workspaceId}/invitations`, {
        headers,
        data: { email, role: "VIEWER", sendEmail: false },
    });
    expect(invite.status()).toBe(201);
    await page.goto("/workspaces?tab=members");
    await chooseWorkspace(page, workspaceId);
    const row = page.getByRole("row").filter({ hasText: email });
    const pending = row.getByText("Pending", { exact: true });
    await expectBadge(pending, "rgb(253, 242, 217)");
    const revoke = row.getByRole("button", { name: "Revoke invitation", exact: true });
    await expect(revoke).toHaveCSS("background-color", "rgb(253, 242, 217)");
    await enableDarkMode(page);
    await expectBadge(pending, "rgb(66, 51, 25)");
    await expect(revoke).toHaveCSS("background-color", "rgb(66, 51, 25)");
    let sent = 0;
    let releaseRevoke = () => {};
    const gate = new Promise<void>((resolve) => {
        releaseRevoke = resolve;
    });
    await page.route(`**/api/v1/workspaces/${workspaceId}/invitations/*`, async (route) => {
        if (route.request().method() !== "DELETE") return route.fallback();
        sent += 1;
        await gate;
        await route.continue();
    });
    await revoke.click();
    const confirm = page.getByRole("dialog", { name: "Revoke invitation", exact: true });
    await expect(confirm).toContainText(email);
    expect(sent).toBe(0);
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(revoke).toBeFocused();
    expect(sent).toBe(0);
    await expect(pending).toBeVisible();
    await revoke.click();
    try {
        const proceed = confirm.getByRole("button", { name: "Revoke invitation", exact: true });
        await expect(proceed).toHaveCSS("background-color", "rgb(66, 51, 25)");
        await proceed.click();
        await expect(confirm).toBeHidden();
        await expect(page.getByRole("dialog", { name: "Operation in progress", exact: true })).toBeVisible();
        await expect.poll(() => sent).toBe(1);
    } finally {
        releaseRevoke();
    }
    const result = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
    await expect(result).toContainText("Invitation revoked");
    await result.getByRole("button", { name: "OK" }).click();
    const revoked = row.getByText("Revoked", { exact: true });
    await expectBadge(revoked, "rgb(56, 36, 39)");
    await page.getByRole("banner").getByRole("button", { name: "Dark mode", pressed: true }).click();
    await expectBadge(revoked, "rgb(255, 243, 240)");
});
