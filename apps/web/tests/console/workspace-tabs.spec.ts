/**
 * 设置页使用真实工作区和停用的模型提供方，验证键盘、浏览器历史与服务端权限，不发起收费的模型调用。
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { editorScope } from "../editor-fixture";
import { installed } from "../support/install-console";
import { chooseWorkspace } from "../support/console-controls";

test("workspace settings tabs isolate member management and provider configuration", async ({ page }) => {
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
    await expect(tabs.getByRole("tab")).toHaveText(["Basic information", "Members", "AI providers"]);
    const basic = tabs.getByRole("tab", { name: "Basic information" });
    const members = tabs.getByRole("tab", { name: "Members" });
    const ai = tabs.getByRole("tab", { name: "AI providers" });
    await expect(basic).toHaveAttribute("aria-selected", "true");
    await expect(
        page.getByRole("tabpanel", { name: "Basic information" }).getByRole("button", { name: "Rename Workspace" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Create invitation" })).toHaveCount(0);
    await expect(basic).toHaveCSS("border-bottom-color", "rgb(70, 95, 255)");
    await expect(members).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
    await basic.press("ArrowRight");
    await expect(members).toBeFocused();
    await expect(basic).toHaveAttribute("aria-selected", "true");
    await expect(members).toHaveCSS("outline-color", "rgb(115, 115, 115)");
    await members.press("Enter");
    await expect(page).toHaveURL(/view=compact&tab=members#settings$/);
    await expect(
        page.getByRole("tabpanel", { name: "Members" }).getByRole("button", { name: "Create invitation" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Rename Workspace" })).toHaveCount(0);
    const requests: string[] = [];
    page.on("request", (r) => requests.push(new URL(r.url()).pathname));
    await members.press("End");
    await expect(ai).toBeFocused();
    await ai.press("Space");
    const panel = page.getByRole("tabpanel", { name: "AI providers" });
    const form = panel.getByRole("group", { name: "Provider", exact: true });
    await expect(form).toBeVisible();
    await form.getByLabel("Name", { exact: true }).fill("Disabled UI provider");
    await form.getByLabel("Model", { exact: true }).fill("disabled-fixture");
    await form.getByLabel("Write-only API key").fill("disabled-ui-test-key");
    await form.getByLabel("Monthly budget USD").fill("7");
    await form.getByRole("button", { name: "Save provider" }).click();
    await expect(panel.getByRole("option", { name: "Disabled UI provider · OFF" })).toBeAttached();
    await expect(panel).toContainText("Budget");
    await expect(form.getByRole("button", { name: /Test connection/ })).toBeDisabled();
    await expect(panel.getByText("Call history", { exact: true })).toHaveCount(0);
    expect(requests).toContain(`/api/v1/workspaces/${scope.workspaceId}/ai/providers`);
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
    await expect(basic).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
    await page.setViewportSize({ width: 700, height: 760 });
    await expect(tabs).toHaveCSS("height", "48px");
    for (const button of await tabs.getByRole("tab").all()) {
        await expect(button).toHaveCSS("font-size", "14px");
        await expect(button.locator("svg")).toHaveCSS("width", "16px");
        await expect(button).toBeInViewport({ ratio: 1 });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(700);
    await page.setViewportSize({ width: 1280, height: 800 });
    await form.getByLabel("Write-only API key").fill("unsubmitted-fixture-key");
    await chooseWorkspace(page, otherId);
    await expect(panel.getByRole("option", { name: "Disabled UI provider · OFF" })).toHaveCount(0);
    await expect(form.getByLabel("Write-only API key")).toHaveValue("");
    await chooseWorkspace(page, scope.workspaceId);
    await expect(panel.getByRole("option", { name: "Disabled UI provider · OFF" })).toBeAttached();
    await expect(form.getByLabel("Write-only API key")).toHaveValue("");
    await page.getByRole("link", { name: "AI", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Call history" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Disabled UI provider · OFF" })).toBeAttached();
    await page.getByRole("link", { name: "Workspace settings", exact: true }).click();
    await ai.click();
    await form.getByRole("button", { name: "Provider Disabled UI provider" }).click();
    await form.getByLabel("Name", { exact: true }).fill("Updated UI provider");
    await form.getByRole("button", { name: "Save provider" }).click();
    await expect(panel.getByRole("option", { name: "Updated UI provider · OFF" })).toBeAttached();
    const picker = panel.getByRole("combobox", { name: "Provider", exact: true });
    const updatedId = await picker.inputValue();
    await form.getByRole("button", { name: "New provider" }).click();
    await form.getByLabel("Name", { exact: true }).fill("Remaining UI provider");
    await form.getByLabel("Model", { exact: true }).fill("disabled-fixture");
    await form.getByLabel("Write-only API key").fill("remaining-ui-test-key");
    await form.getByLabel("Monthly budget USD").fill("4");
    await form.getByRole("button", { name: "Save provider" }).click();
    const remaining = panel.getByRole("option", { name: "Remaining UI provider · OFF" });
    await expect(remaining).toBeAttached();
    const remainingId = await remaining.getAttribute("value");
    if (!remainingId) throw new Error("Missing authenticated provider identifier");
    await picker.selectOption(updatedId);
    const providerList = `**/api/v1/workspaces/${scope.workspaceId}/ai/providers`;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
    });
    let captured!: (status: number) => void;
    const capturedResponse = new Promise<number>((resolve) => {
        captured = resolve;
    });
    await page.route(
        providerList,
        async (route) => {
            const response = await route.fetch();
            captured(response.status());
            await barrier;
            await route.fulfill({ response });
        },
        { times: 1 },
    );
    try {
        await form.getByRole("button", { name: "Delete provider" }).click();
        expect(await capturedResponse).toBe(200);
        await expect(picker).toHaveValue(updatedId);
        await expect(form.getByRole("button", { name: "Delete provider" })).toBeDisabled();
    } finally {
        release();
    }
    await expect(panel.getByRole("option", { name: "Updated UI provider · OFF" })).toHaveCount(0);
    await expect(picker).toHaveValue(remainingId);
    await expect(panel.getByText("Budget USD", { exact: true }).locator("..")).toContainText(/Available: 4(?:\.0+)?$/);
    await page.getByRole("link", { name: "AI", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Provider", exact: true })).toHaveValue(remainingId);
});
