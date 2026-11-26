/**
 * 在独立的浏览器用例中验证真实邀请签发和确认回执，关闭凭证所在页面的追踪、视频与屏幕截图。
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { editorScope } from "../editor-fixture";
import { chooseLanguage, chooseWorkspace } from "../support/console-controls";
import { installed } from "../support/install-console";

// 签发流程的响应和复制字段带有一次性凭证，浏览器验收仍然通过真实接口，但不会采集这一用例的界面和网络痕迹。
test.use({ screenshot: "off", trace: "off", video: "off" });

/**
 * 通过键盘提交邀请，确认共享结果和专用交付窗口按序出现，实际目录用当前语言显示角色与等待状态。
 */
test("shows an acknowledged result before returning to the invitation link", async ({ page }) => {
    await installed(page);
    const { workspaceId } = await editorScope(page, `invitation-result-${randomUUID()}`);
    const email = `invitation-result-${randomUUID()}@example.test`;
    await page.goto("/workspaces?tab=members");
    await chooseWorkspace(page, workspaceId);
    const invite = page.getByRole("button", { name: "Invite a member", exact: true });
    const search = page.getByRole("searchbox", { name: "Search email", exact: true });
    await expect(invite).toHaveAttribute("title", "Invite a member");
    await expect(invite.locator("svg")).toBeVisible();
    const toolbar = page.locator(".vq-data-table-toolbar").filter({ has: search });
    const download = toolbar.getByRole("button", { name: "Download", exact: true });
    await expect(download).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Invite a member", exact: true })).toHaveCount(0);
    const heading = page.getByRole("heading", { name: "Invitations", exact: true });
    const [titleBox, inviteBox] = await Promise.all([heading.boundingBox(), invite.boundingBox()]);
    if (!titleBox || !inviteBox) throw new Error("Invitation title and create button must be visible");
    expect(inviteBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);
    expect(inviteBox.x - (titleBox.x + titleBox.width)).toBeLessThanOrEqual(12);
    expect(Math.abs(inviteBox.y + inviteBox.height / 2 - titleBox.y - titleBox.height / 2)).toBeLessThanOrEqual(1);
    await invite.click();
    const create = page.getByRole("dialog", { name: "Invite a member", exact: true });
    const role = create.getByRole("combobox", { name: "Role", exact: true });
    await expect(role).toHaveAttribute("aria-required", "true");
    await expect(role.getByText("Viewer", { exact: true })).toBeVisible();
    await expect(role).toHaveAccessibleDescription("The member receives this role when they accept.");
    const roleCaption = create.locator("label").filter({ has: page.getByText("Role", { exact: true }) });
    const marker = roleCaption.getByText("*", { exact: true });
    await expect(marker).toHaveCSS("color", "rgb(166, 45, 45)");
    const [markBox, labelBox] = await Promise.all([
        marker.boundingBox(),
        roleCaption.getByText("Role", { exact: true }).boundingBox(),
    ]);
    if (!markBox || !labelBox) throw new Error("Required role marker and label must be visible");
    expect(markBox.x + markBox.width).toBeLessThanOrEqual(labelBox.x);
    const input = create.getByRole("textbox", { name: "Email", exact: true });
    await input.fill(email);
    const delivery = page.getByRole("dialog", { name: "Invitation link", exact: true, includeHidden: true });
    const result = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
    let correctLink = false;
    let operationSummary = "";
    let okFocused = false;
    try {
        await input.press("Enter");
        await result.waitFor({ state: "visible" });
        if ((await delivery.count()) > 0) throw new Error("The invitation link opened before acknowledgement");
        operationSummary = (await result.textContent()) ?? "";
        const ok = result.getByRole("button", { name: "OK", exact: true });
        okFocused = await ok.evaluate((button) => button === document.activeElement);
        await ok.click();
        const link = delivery.getByRole("textbox", { name: "Invitation link", exact: true });
        correctLink = (await link.inputValue()).includes("/invitations/accept#token=");
        await page.keyboard.press("Escape");
        await delivery.waitFor({ state: "hidden" });
    } catch (error) {
        // 关闭持有凭证的页面后再交给测试报告器，避免失败时自动生成的无障碍快照记录一次性链接原值。
        await page.close();
        throw error;
    }
    expect(operationSummary).toContain("Invitation created");
    expect(okFocused).toBe(true);
    expect(correctLink).toBe(true);
    await expect(invite).toBeFocused();
    const table = page.getByRole("table", { name: "Invitations" });
    const row = table.getByRole("row", { name: new RegExp(email) });
    await expect(row.getByRole("cell", { name: "Viewer", exact: true })).toBeVisible();
    await expect(row.getByRole("cell", { name: "Pending", exact: true })).toBeVisible();
    await chooseLanguage(page, "zh");
    const localized = page
        .getByRole("table", { name: "邀请", exact: true })
        .getByRole("row", { name: new RegExp(email) });
    await expect(localized.getByRole("cell", { name: "查看者", exact: true })).toBeVisible();
    await expect(localized.getByRole("cell", { name: "待接受", exact: true })).toBeVisible();
});

/**
 * 邀请成功后模拟目录读取拒绝，保留真实创建回执；仍可查询拒绝提示，已签发的链接不能在关闭回执后重新进入页面。
 */
test("an explicit invitation read denial suppresses deferred delivery", async ({ page }) => {
    await installed(page);
    const { workspaceId } = await editorScope(page, `invitation-denial-${randomUUID()}`);
    await page.goto("/workspaces?tab=members");
    await chooseWorkspace(page, workspaceId);
    await expect(page.getByText("No invitations yet.", { exact: true })).toBeVisible();
    const invite = page.getByRole("button", { name: "Invite a member", exact: true });
    await invite.click();
    const create = page.getByRole("dialog", { name: "Invite a member", exact: true });
    await create.getByRole("textbox", { name: "Email", exact: true }).fill(`missing-${randomUUID()}@example.test`);

    const pathname = `/api/v1/workspaces/${workspaceId}/invitations`;
    let denyReads = true;
    await page.route(
        (url) => url.pathname === pathname,
        async (route) => {
            if (!denyReads || route.request().method() !== "GET") return route.continue();
            await route.fulfill({ status: 403, json: { code: "FORBIDDEN", message: "Invitation access was revoked" } });
        },
    );
    const created = page.waitForResponse(
        (response) => response.request().method() === "POST" && new URL(response.url()).pathname === pathname,
    );
    const delivery = page.getByRole("dialog", { name: "Invitation link", exact: true, includeHidden: true });
    const retry = page.getByRole("button", { name: "Retry invitations", exact: true, includeHidden: true });
    try {
        await create.getByRole("button", { name: "Create invitation", exact: true }).click();
        expect((await created).status()).toBe(201);
        const result = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
        await result.waitFor({ state: "visible" });
        await retry.waitFor({ state: "attached" });
        const deniedAgain = page.waitForResponse(
            (response) => response.request().method() === "GET" && new URL(response.url()).pathname === pathname,
        );
        await result.getByRole("button", { name: "OK", exact: true }).click();
        await retry.click();
        expect((await deniedAgain).status()).toBe(403);
        if ((await delivery.count()) > 0) throw new Error("A denied invitation link was made visible");
    } catch (error) {
        // 若待修复页面仍打开交付框，先结束页面，再让失败报告留在不包含令牌或无障碍快照的操作步骤。
        await page.close();
        throw error;
    }
    await expect(invite).toBeDisabled();
    await expect(page.getByRole("alert")).toContainText("Invitation access was revoked");
    denyReads = false;
    await retry.click();
    await expect(page.getByRole("table", { name: "Invitations", exact: true })).toBeVisible();
    await expect(invite).toBeEnabled();
    await expect(delivery).toHaveCount(0);
});
