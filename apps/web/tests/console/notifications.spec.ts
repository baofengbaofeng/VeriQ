/**
 * 经由真实账户与工作区邀请验证顶栏通知的阅读和处理流程，隔离浏览器账户以便观察收件人身份边界。
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { editorScope } from "../editor-fixture";
import { installed } from "../support/install-console";
import { chooseLanguage } from "../support/console-controls";

// 邀请签发响应携带短期凭证，验收只观察通知内容和成员关系，不记录凭证所在的浏览器流量或图像。
test.use({ screenshot: "off", trace: "off", video: "off", viewport: { width: 1280, height: 800 } });

/**
 * 在浏览器开关和分页用例中隔离会话建立，只虚拟 API、使用实际应用壳层，避免引入真实模型配置或站点依赖。
 */
async function shellFixture(page: Page, workspaces: unknown[]) {
    const user = { id: randomUUID(), displayName: "Inbox owner", email: "owner@example.test", createdAt: stamp };
    const responses: Record<string, unknown> = {
        "/api/v1/setup": { initialized: true },
        "/api/v1/auth/session": { user, csrfToken: "fixture-only" },
        "/api/v1/account": user,
        "/api/v1/workspaces": { items: workspaces, nextCursor: null },
    };
    await page.addInitScript(() => localStorage.setItem("veriq.language", "en"));
    await page.route("**/api/v1/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ json: { data: responses[path] ?? { items: [], nextCursor: null } } });
    });
    await page.route("**/api/v1/notifications/stream", (route) =>
        route.fulfill({ contentType: "text/event-stream", body: 'event: inbox\ndata: {"revision":"1"}\n\n' }),
    );
}

const stamp = "2026-11-24T13:00:00Z";

/**
 * 同一条通知的查看和快捷操作共享右边界，切换语言后从顶栏进入通知列表仍能用中文找到原操作。
 */
test("notification actions appear in Chinese and align to the right", async ({ page }) => {
    await shellFixture(page, []);
    const workspaceId = randomUUID();
    const workspaceName = "Invitation workspace";
    const sessionTitle = "Example Agent conversation";
    const common = { workspaceId, workspaceName, occurredAt: stamp, readAt: null };
    const items = [
        {
            ...common,
            id: randomUUID(),
            kind: "WORKSPACE_INVITED",
            invitationId: randomUUID(),
            invitationRole: "VIEWER",
            invitationStatus: "PENDING",
            actorName: "Inviter",
        },
        {
            ...common,
            id: randomUUID(),
            kind: "AGENT_REPLY",
            sessionId: randomUUID(),
            sessionTitle,
            turnId: randomUUID(),
            preview: "A synthetic reply",
        },
    ];
    await page.route("**/api/v1/notifications?*", (route) =>
        route.fulfill({ json: { data: { items, unreadCount: items.length, readThrough: "watermark" } } }),
    );
    await page.goto("/account");
    await chooseLanguage(page, "zh");
    await page.getByRole("button", { name: "通知", exact: true }).click();
    const popover = page.getByRole("dialog", { name: "通知", exact: true });
    const invite = popover.getByRole("listitem").filter({ hasText: workspaceName });
    const reply = popover.getByRole("listitem").filter({ hasText: sessionTitle });
    const accept = invite.getByRole("button", { name: "接受邀请", exact: true });
    const viewReply = reply.getByRole("button", { name: "查看", exact: true });
    await expect(accept).toBeVisible();
    const [action, time] = await Promise.all([accept.boundingBox(), invite.locator("time").boundingBox()]);
    if (!action || !time) throw new Error("Notification actions and timestamp must be visible");
    expect.soft(action.x + action.width).toBeCloseTo(time.x + time.width, 0);
    await expect(invite.getByRole("button", { name: "查看", exact: true })).toBeVisible();
    await expect(viewReply).toBeVisible();
    expect(await viewReply.evaluate((node) => node.getBoundingClientRect().right)).toBeCloseTo(time.x + time.width, 0);
    await popover.getByRole("link", { name: "查看全部通知", exact: true }).click();
    const table = page.getByRole("table", { name: "通知", exact: true });
    await expect(table.getByRole("button", { name: "查看", exact: true })).toHaveCount(2);
    const tableReply = table.getByRole("row").filter({ hasText: sessionTitle });
    const tableActions = [
        table.getByRole("button", { name: "接受邀请", exact: true }),
        tableReply.getByRole("button", { name: "查看", exact: true }),
    ];
    const [inviteEdge, replyEdge] = await Promise.all(
        tableActions.map((button) => button.evaluate((node) => node.getBoundingClientRect().right)),
    );
    expect(inviteEdge).toBeCloseTo(replyEdge, 0);
});

/**
 * 报告编号改变时仍在同一路由，浮层关闭后须保留可用键盘焦点；通知列表内重复打开列表也遵循相同返回行为。
 */
test("same-page notification navigation restores focus to the bell", async ({ page }) => {
    const workspace = { id: randomUUID(), name: "Notification workspace", key: "reports", role: "VIEWER" };
    await shellFixture(page, [workspace]);
    const row = {
        id: randomUUID(),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        kind: "RUN_FINISHED",
        runId: randomUUID(),
        planName: "Earlier run",
        outcome: "PASSED",
        occurredAt: stamp,
        readAt: null,
    };
    await page.route(`**/api/v1/workspaces/${workspace.id}`, (route) => route.fulfill({ json: { data: workspace } }));
    await page.route(`**/api/v1/workspaces/${workspace.id}/runs/*/report`, (route) =>
        route.fulfill({ status: 404, json: { code: "REPORT_NOT_FOUND", message: "No report in the focus fixture" } }),
    );
    await page.route("**/api/v1/notifications?*", (route) =>
        route.fulfill({
            json: { data: { items: [row], unreadCount: 1, readThrough: "watermark-1" } },
        }),
    );
    await page.route(`**/api/v1/notifications/${row.id}/read`, (route) =>
        route.fulfill({ json: { data: { ...row, readAt: stamp } } }),
    );
    await page.goto(`/reports?workspaceId=${workspace.id}&runId=${randomUUID()}`);
    const bell = page.getByRole("button", { name: "Notifications", exact: true });
    const popover = page.getByRole("dialog", { name: "Notifications", exact: true });
    await bell.press("Enter");
    await popover.getByRole("button", { name: "View report", exact: true }).press("Enter");
    await expect(page).toHaveURL(`/reports?workspaceId=${workspace.id}&runId=${row.runId}`);
    await expect(bell).toBeFocused();
    await page.goto("/notifications");
    await bell.press("Enter");
    await popover.getByRole("link", { name: "View all notifications", exact: true }).press("Enter");
    await expect(popover).toBeHidden();
    await expect(bell).toBeFocused();
});

/**
 * 模拟一个没有新事件的邀请自然到期，只有浮层实际打开且仍包含等待中的邀请时才按慢速间隔重新读取状态。
 */
test("open inbox refreshes elapsed invitation expiry without background polling", async ({ page }) => {
    await shellFixture(page, []);
    await page.route("**/api/v1/notifications/stream", (route) =>
        route.fulfill({ status: 403, json: { code: "FORBIDDEN", message: "Test disables stream updates" } }),
    );
    const row = {
        id: randomUUID(),
        kind: "WORKSPACE_INVITED",
        workspaceId: randomUUID(),
        workspaceName: "Expiring workspace",
        invitationId: randomUUID(),
        invitationRole: "VIEWER",
        actorName: "Inviter",
        occurredAt: stamp,
        readAt: null,
    };
    let expired = false;
    let lookups = 0;
    await page.route("**/api/v1/notifications?*", (route) => {
        lookups++;
        return route.fulfill({
            json: {
                data: {
                    items: [{ ...row, invitationStatus: expired ? "EXPIRED" : "PENDING" }],
                    unreadCount: 1,
                    readThrough: "watermark-1",
                },
            },
        });
    });
    await page.clock.install();
    await page.goto("/account");
    const bell = page.getByRole("button", { name: "Notifications", exact: true });
    const popover = page.getByRole("dialog", { name: "Notifications", exact: true });
    await bell.click();
    await expect(popover.getByRole("button", { name: "Accept invitation", exact: true })).toBeVisible();
    expired = true;
    await page.clock.runFor(31_000);
    await expect(popover.getByText("Expired", { exact: true })).toBeVisible();
    await expect(popover.getByRole("button", { name: "Accept invitation", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    expired = false;
    await bell.click();
    await expect(popover.getByRole("button", { name: "Accept invitation", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    const closed = lookups;
    await page.clock.runFor(61_000);
    expect(lookups).toBe(closed);
    await page.goto("/notifications");
    const table = page.getByRole("table", { name: "Notifications", exact: true });
    await expect(table.getByRole("button", { name: "Accept invitation", exact: true })).toBeVisible();
    expired = true;
    await page.clock.runFor(31_000);
    await expect(table.getByText("Expired", { exact: true })).toBeVisible();
});

test("marking all as read keeps notices arriving behind the inbox watermark unread", async ({ page }) => {
    await shellFixture(page, []);
    const workspaceId = randomUUID();
    const nextId = randomUUID();
    const row = {
        id: randomUUID(),
        kind: "RUN_STARTED",
        workspaceId,
        workspaceName: "Inbox workspace",
        runId: randomUUID(),
        planName: "Previously queued plan",
        occurredAt: stamp,
        readAt: null as string | null,
        outcome: null,
    };
    let arrived = false;
    await page.route("**/api/v1/notifications?*", (route) =>
        route.fulfill({
            json: {
                data: {
                    items: arrived ? [{ ...row, id: nextId, planName: "New plan", readAt: null }, row] : [row],
                    readThrough: arrived ? "watermark-2" : "watermark-1",
                    unreadCount: 1,
                },
            },
        }),
    );
    await page.route("**/api/v1/notifications/read-all", (route) => {
        expect(route.request().postDataJSON()).toEqual({ through: "watermark-1" });
        row.readAt = stamp;
        arrived = true;
        return route.fulfill({ json: { data: { updated: 1 } } });
    });
    await page.goto("/account");
    await page.getByRole("button", { name: "Notifications", exact: true }).click();
    const popover = page.getByRole("dialog", { name: "Notifications", exact: true });
    await expect(popover.getByText("Previously queued plan", { exact: true })).toBeVisible();
    await expect(popover.getByRole("button", { name: "Mark all as read", exact: true })).toBeEnabled();
    await popover.getByRole("button", { name: "Mark all as read", exact: true }).click();
    const result = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
    await result.getByRole("button", { name: "OK", exact: true }).click();
    await expect(popover.getByText("New plan", { exact: true })).toBeVisible();
    await expect(popover.getByRole("button", { name: "Mark all as read", exact: true })).toBeEnabled();
});

/**
 * 通过真实壳层打开另一工作区中不在会话列表的回复，验证查询续页、焦点定位和可见后的展示确认。
 */
test("an Agent notification opens and acknowledges the exact reply on an older page", async ({ page }) => {
    const initial = { id: randomUUID(), key: "initial", name: "Initial workspace", role: "VIEWER", createdAt: stamp };
    const workspace = { ...initial, id: randomUUID(), key: "target", name: "Target workspace" };
    await shellFixture(page, [initial]);
    const session = { id: randomUUID(), title: "Private conversation", createdAt: stamp, archived: false };
    const row = {
        id: randomUUID(),
        kind: "AGENT_REPLY",
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        sessionId: session.id,
        sessionTitle: session.title,
        turnId: randomUUID(),
        preview: "Earlier reply preview",
        occurredAt: stamp,
        readAt: null,
    };
    await page.route("**/api/v1/notifications?*", (route) =>
        route.fulfill({
            json: { data: { items: [row], unreadCount: 1, readThrough: "watermark-1" } },
        }),
    );
    await page.route(`**/api/v1/notifications/${row.id}/read`, (route) => {
        expect(route.request().method()).toBe("POST");
        return route.fulfill({ json: { data: { ...row, readAt: stamp } } });
    });
    const workPath = `/api/v1/workspaces/${workspace.id}`;
    await page.route(`**${workPath}`, (route) => route.fulfill({ json: { data: workspace } }));
    await page.route(`**${workPath}/agent/settings`, (route) =>
        route.fulfill({
            json: { data: { providerStatus: "READY", defaultProviderId: null, agentProviderId: null } },
        }),
    );
    const sessionPath = `${workPath}/agent/sessions/${session.id}`;
    await page.route(`**${sessionPath}`, (route) => route.fulfill({ json: { data: session } }));
    const latest = {
        id: randomUUID(),
        createdAt: stamp,
        text: "Later prompt",
        reply: "Later reply",
        status: "COMPLETED",
    };
    const earlier = { ...latest, id: row.turnId, createdAt: "2026-11-24T12:00:00Z", reply: "Exact earlier reply" };
    await page.route(
        (url) => url.pathname === `${sessionPath}/turns`,
        (route) => {
            const older = new URL(route.request().url()).searchParams.get("cursor") === "older";
            return route.fulfill({
                json: { data: { items: [older ? earlier : latest], nextCursor: older ? null : "older" } },
            });
        },
    );
    const seen: string[] = [];
    await page.route("**/api/v1/notifications/agent-seen", (route) => {
        seen.push(route.request().postDataJSON().turnId);
        return route.fulfill({ json: { data: { acknowledged: true } } });
    });
    await page.goto("/account");
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    const bell = page.getByRole("button", { name: "Notifications", exact: true });
    await bell.click();
    const popover = page.getByRole("dialog", { name: "Notifications", exact: true });
    await expect(popover.getByText("Earlier reply preview", { exact: true })).toBeVisible();
    const selected = page.waitForRequest(
        (request) =>
            request.url().endsWith("/notifications/agent-seen") && request.postDataJSON()?.turnId === row.turnId,
    );
    // 保持文档和回复的真实渲染，只模拟宿主窗口暂未聚焦，验证相交结果也不能在这种状态下发送已展示回执。
    await page.evaluate(() => Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false }));
    await popover.getByRole("button", { name: "Agent reply", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Test Agent", exact: true });
    const target = drawer.locator("[tabindex='-1']").filter({ hasText: "Exact earlier reply" });
    await expect(target).toBeFocused();
    await target.evaluate(
        (node) =>
            new Promise<void>((resolve) => {
                const observer = new IntersectionObserver(([entry]) => {
                    if (!entry?.isIntersecting) return;
                    observer.disconnect();
                    resolve();
                });
                observer.observe(node);
            }),
    );
    expect(seen).not.toContain(row.turnId);
    await page.evaluate(() => {
        Reflect.deleteProperty(document, "hasFocus");
        document.activeElement?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect((await selected).postDataJSON()).toEqual({
        workspaceId: workspace.id,
        sessionId: session.id,
        turnId: row.turnId,
    });
});

test("workspace invitations support separate read and accept actions in the inbox", async ({ page, browser }) => {
    await installed(page);
    const name = `inbox-${randomUUID()}`;
    const { workspaceId, headers } = await editorScope(page, name);
    const email = `${name}@example.test`;
    const password = "Inbox browser password 123!";
    const created = await page.request.post("/api/v1/admin/users", {
        headers,
        data: { email, password, displayName: "Inbox recipient", systemAdmin: false },
    });
    expect(created.status()).toBe(201);

    const recipient = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
        const inbox = await recipient.newPage();
        await inbox.addInitScript(() => localStorage.setItem("veriq.language", "en"));
        await inbox.goto("/login");
        await inbox.getByRole("textbox", { name: "Email" }).fill(email);
        await inbox.getByLabel("Password").fill(password);
        await inbox.getByRole("button", { name: "Sign in" }).click();
        const bell = inbox.getByRole("button", { name: "Notifications", exact: true });
        await expect(bell).toBeVisible();
        const issueInvitation = () =>
            page.request.post(`/api/v1/workspaces/${workspaceId}/invitations`, {
                headers,
                data: { email, role: "VIEWER", sendEmail: false },
            });
        expect((await issueInvitation()).status()).toBe(201);
        await bell.press("Enter");
        const popover = inbox.getByRole("dialog", { name: "Notifications", exact: true });
        await expect(popover.getByRole("button", { name: "Mark all as read", exact: true })).toBeEnabled();
        await expect(popover.getByText(name, { exact: true })).toBeVisible();
        await inbox.keyboard.press("Escape");
        await expect(bell).toBeFocused();

        // 查看只读取当前消息及其已读状态，邀请快捷操作仍须由账户明确触发后才能取得工作区成员权限。
        await bell.click();
        await popover.getByRole("button", { name: "View", exact: true }).click();
        await expect(inbox).toHaveURL(/\/notifications\?notificationId=/u);
        const detail = inbox.getByRole("region", { name: "Notification details", exact: true });
        await expect(detail.getByText(name, { exact: true })).toBeVisible();
        await bell.press("Enter");
        await popover.getByRole("button", { name: "View", exact: true }).press("Enter");
        await expect(popover).toBeHidden();
        await expect(bell).toBeFocused();
        const accept = detail.getByRole("button", { name: "Accept invitation", exact: true });
        await expect(accept).toBeEnabled();
        await expect(inbox.getByRole("button", { name: "Mark all as read", exact: true })).toBeDisabled();
        await accept.click();
        const success = inbox.getByRole("dialog", { name: "Operation succeeded", exact: true });
        await success.getByRole("button", { name: "OK", exact: true }).click();
        await expect(detail.getByText("Accepted", { exact: true })).toBeVisible();
        expect((await inbox.request.get(`/api/v1/workspaces/${workspaceId}`)).status()).toBe(200);

        await chooseLanguage(inbox, "zh");
        await expect(inbox.getByRole("heading", { name: "通知", exact: true })).toBeVisible();
        const localized = inbox.getByRole("region", { name: "通知详情", exact: true });
        await expect(localized.getByText("已接受", { exact: true })).toBeVisible();

        // 真实账户在另一工作区收到邀请，批量已读后再次请求工作区详情，确认阅读操作不会授予成员访问权限。
        const second = await page.request.post("/api/v1/workspaces", {
            headers,
            data: { key: `${name}-other`, name: `${name}-other` },
        });
        expect(second.status()).toBe(201);
        const other = (await second.json()).data.id as string;
        const pending = await page.request.post(`/api/v1/workspaces/${other}/invitations`, {
            headers,
            data: { email, role: "VIEWER", sendEmail: false },
        });
        expect(pending.status()).toBe(201);
        const all = inbox.getByRole("button", { name: "全部已读", exact: true });
        await expect(all).toBeEnabled();
        await all.click();
        await inbox
            .getByRole("dialog", { name: "操作成功", exact: true })
            .getByRole("button", { name: "确定", exact: true })
            .click();
        await expect(all).toBeDisabled();
        expect((await inbox.request.get(`/api/v1/workspaces/${other}`)).status()).toBe(403);
    } finally {
        await recipient.close();
    }
});
