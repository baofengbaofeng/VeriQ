/**
 * 以个人收件箱的跨空间记录验证原生宿主调用、回执归属、当前会话撤销与同工作区报表的精确目标。
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("desktop inbox scopes writes, reports and polling to the current form", async ({ page }) => {
    const workspace = randomUUID();
    const turn = randomUUID();
    const run = randomUUID();
    const stamp = "2026-01-01T12:00:00Z";
    const common = { workspaceId: workspace, workspaceName: "Selected", readAt: null, occurredAt: stamp };
    const local = {
        ...common,
        id: randomUUID(),
        runId: run,
        planName: "Local plan",
        kind: "RUN_FINISHED",
        outcome: "PASSED",
    };
    const foreign = {
        ...local,
        id: randomUUID(),
        workspaceId: randomUUID(),
        planName: "Foreign plan",
        runId: randomUUID(),
    };
    const invite = {
        ...common,
        id: randomUUID(),
        workspaceId: randomUUID(),
        kind: "WORKSPACE_INVITED",
        invitationId: randomUUID(),
        invitationStatus: "PENDING",
        invitationRole: "VIEWER",
        actorName: "Staff",
    };
    const notices = [local, foreign, invite];
    let deny = false;
    const calls: { method: string; path: string; body: unknown; origin?: string }[] = [];
    await page.exposeFunction(
        "inboxTestCall",
        (method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
            calls.push({ method, path, body, origin: headers?.["X-VeriQ-Agent-Form"] });
            if (method === "REPORT") return null;
            if (path === `/workspaces/${workspace}`) return { id: workspace, name: "Selected", role: "VIEWER" };
            if (path.startsWith("/notifications?")) {
                if (deny) return "DENIED";
                const cursor = new URLSearchParams(path.split("?")[1]).get("cursor");
                return {
                    items: cursor ? [{ ...local, planName: cursor }] : notices,
                    unreadCount: 3,
                    readThrough: "known-watermark",
                    nextCursor: cursor === "oldest" ? null : cursor === "older" ? "oldest" : "older",
                };
            }
            if (path === "/notifications/read-all") return { updated: 3 };
            for (const notice of notices) {
                const item = `/notifications/${notice.id}`;
                if (path === item || path === `${item}/read`) return { ...notice, readAt: stamp };
                if (path === `${item}/accept`) return { workspaceId: notice.workspaceId };
            }
            throw new Error(`Unexpected host call ${method} ${path}`);
        },
    );
    await page.addInitScript(() => localStorage.setItem("veriq.language", "en"));
    await page.clock.install();
    await page.goto(`/tests/desktop-notifications-fixture.html?${new URLSearchParams({ workspace, turn, run })}`);
    const table = page.getByRole("table", { name: "Notifications", exact: true });
    await table
        .getByRole("row")
        .filter({ hasText: "Foreign plan" })
        .getByRole("button", { name: "View", exact: true })
        .click();
    const detail = page.getByRole("region", { name: "Notification details" });
    await expect(detail.getByText("Foreign plan")).toBeVisible();
    await detail.getByRole("link", { name: "Back to notifications" }).click();
    await table.getByRole("row").filter({ hasText: "Local plan" }).getByRole("button", { name: "View report" }).click();
    await expect.poll(() => calls.filter((call) => call.method === "REPORT").map((call) => call.path)).toContain(run);
    await page.getByRole("link", { name: "Back to notifications" }).click();
    await table.getByRole("button", { name: "Accept invitation", exact: true }).click();
    await page.getByRole("dialog").getByRole("button").last().click();
    await page.getByRole("button", { name: "Mark all as read" }).click();
    await page.getByRole("dialog").getByRole("button").last().click();
    const writes = calls.filter((call) => call.method === "POST");
    expect(writes.map((call) => [call.path, call.origin, call.body])).toEqual([
        [`/notifications/${foreign.id}/read`, undefined, {}],
        [`/notifications/${local.id}/read`, turn, {}],
        [`/notifications/${invite.id}/accept`, undefined, {}],
        ["/notifications/read-all", undefined, { through: "known-watermark" }],
    ]);
    expect(calls.some((call) => call.method === "GET" && call.path === `/notifications/${foreign.id}`)).toBe(true);
    const next = page.getByRole("button", { name: "Next", exact: true });
    await next.click();
    await expect(table.getByText("older", { exact: true })).toBeVisible();
    await next.click();
    await expect(table.getByText("oldest", { exact: true })).toBeVisible();
    const beforeRefresh = calls.length;
    await page.clock.fastForward(30_001);
    await expect.poll(() => calls.slice(beforeRefresh).some((call) => call.path.endsWith("cursor=oldest"))).toBe(true);
    expect(calls.slice(beforeRefresh).some((call) => call.path.endsWith("cursor=older"))).toBe(false);
    deny = true;
    await page.clock.fastForward(30_001);
    await expect(table.getByText("oldest", { exact: true })).toBeHidden();
    await expect(page.getByText("Unable to load notifications.")).toBeVisible();
    const afterDenial = calls.length;
    await page.clock.fastForward(90_000);
    expect(calls).toHaveLength(afterDenial);
    deny = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(table.getByText("oldest", { exact: true })).toBeVisible();
    const afterRecovery = calls.length;
    await page.getByRole("button", { name: "Close fixture form" }).click();
    await expect(table).toBeHidden();
    await page.clock.fastForward(90_000);
    expect(calls).toHaveLength(afterRecovery);
    expect(calls.some((call) => ["STREAM", "BINARY"].includes(call.method))).toBe(false);
});
