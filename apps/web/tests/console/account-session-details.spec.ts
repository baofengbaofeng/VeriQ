/**
 * 通过账户真实路由验证会话显示与单条吊销，不连接开发账号。合成网络边界控制确认、旧会话和刷新失败的时序。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { acknowledgeOperation } from "../editor-fixture";

test("account sessions expose safe summaries and revoke only the confirmed other session", async ({ page }) => {
    const user = {
        id: randomUUID(),
        email: `session-summary-${randomUUID()}@example.test`,
        displayName: "Synthetic session owner",
        disabled: false,
        systemAdmin: false,
        createdAt: "2026-01-01T00:00:00Z",
    };
    const times = { createdAt: "2026-01-01T01:00:00Z", expiresAt: "2026-01-03T04:00:00Z" };
    const current = { ...times, id: randomUUID(), current: true, browser: "CHROME", operatingSystem: "WINDOWS" };
    const other = {
        ...times,
        id: randomUUID(),
        current: false,
        browser: "FIREFOX",
        operatingSystem: "LINUX",
        lastActiveAt: "2026-01-01T09:10:00Z",
    };
    const legacy = { ...times, id: randomUUID(), current: false };
    let sessions = [current, other, legacy];
    const revoked: string[] = [];
    let failRefresh = false;
    let releaseRevocation = () => {};
    const waitForRelease = new Promise<void>((resolve) => {
        releaseRevocation = resolve;
    });
    await page.addInitScript(() => localStorage.setItem("veriq.language", "en"));
    await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const { pathname } = new URL(request.url());
        if (request.method() === "DELETE") {
            const id = pathname.split("/").at(-1) ?? "";
            expect([other.id, legacy.id]).toContain(id);
            expect(pathname).toBe(`/api/v1/account/sessions/${id}`);
            expect(request.headers()["x-csrf-token"]).toBe("synthetic");
            expect(request.postData()).toBeNull();
            revoked.push(id);
            if (revoked.length === 1) {
                return route.fulfill({
                    status: 503,
                    json: { code: "SERVICE_UNAVAILABLE", message: "Unable to revoke this session." },
                });
            }
            sessions = sessions.filter((session) => session.id !== id);
            if (id === legacy.id)
                return route.fulfill({
                    status: 404,
                    json: { code: "SESSION_NOT_FOUND", message: "Active session not found" },
                });
            await waitForRelease;
            failRefresh = true;
            return route.fulfill({ json: { code: "OK", data: {} } });
        }
        expect(request.method()).toBe("GET");
        if (pathname === "/api/v1/account/sessions" && failRefresh) {
            failRefresh = false;
            return route.fulfill({
                status: 503,
                json: { code: "SERVICE_UNAVAILABLE", message: "Session list unavailable." },
            });
        }
        const empty = { items: [], nextCursor: null };
        const data: Record<string, unknown> = {
            "/api/v1/setup": { initialized: true },
            "/api/v1/auth/session": { user, csrfToken: "synthetic" },
            "/api/v1/account": user,
            "/api/v1/account/sessions": { items: sessions, nextCursor: null },
        };
        return route.fulfill({ json: { code: "OK", data: data[pathname] ?? empty } });
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/account");
    const table = page.getByRole("table", { name: "Active sessions", exact: true });
    const currentRow = table.getByRole("row").filter({ hasText: "This session" });
    const otherRow = table.getByRole("row").filter({ hasText: "Firefox / Linux" });
    const revoke = otherRow.getByRole("button", { name: "Revoke session", exact: true });
    await expect(table.getByRole("columnheader")).toHaveText([
        "Session",
        "Browser / System",
        "Recent activity",
        "Signed in",
        "Expires",
        "Actions",
    ]);
    await expect(currentRow.getByText("Chrome / Windows", { exact: true })).toBeVisible();
    await expect(currentRow.getByText("This session", { exact: true })).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
    );
    await expect(currentRow.getByRole("button")).toHaveCount(0);
    await expect(otherRow.locator(`time[datetime="${other.lastActiveAt}"]`)).toBeVisible();
    await expect(otherRow.locator(`time[datetime="${times.createdAt}"]`)).toBeVisible();
    await expect(otherRow.locator(`time[datetime="${times.expiresAt}"]`)).toBeVisible();
    const legacyRow = table.getByRole("row").filter({ hasText: "Other session" }).filter({ hasNotText: "Firefox" });
    await expect(legacyRow.getByRole("cell", { name: "—", exact: true })).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);

    const search = page.getByRole("searchbox", { name: "Search sessions", exact: true });
    await search.fill("Linux");
    await expect(table.getByRole("row")).toHaveCount(2);
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const download = await downloading;
    try {
        const csv = await readFile(await download.path(), "utf8");
        expect(csv).toContain('"Other session","Firefox / Linux"');
        expect(csv.includes(other.id) || csv.includes("Revoke session") || csv.includes("Chrome")).toBe(false);
    } finally {
        await download.delete();
    }
    const confirm = page.getByRole("dialog", { name: "Revoke session", exact: true });
    const confirmButton = confirm.getByRole("button", { name: "Revoke session", exact: true });
    await revoke.click();
    await expect(confirm).toContainText("Firefox / Linux");
    expect(revoked).toEqual([]);
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(revoke).toBeFocused();
    expect(revoked).toEqual([]);

    await revoke.click();
    await confirmButton.click();
    await acknowledgeOperation(page, "Unable to revoke this session.", "failed");
    await expect(revoke).toBeEnabled();
    await expect(revoke).toBeFocused();
    await revoke.click();
    await confirmButton.click();
    try {
        await expect(confirm).toBeHidden();
        await expect(page.getByRole("dialog", { name: "Operation in progress", exact: true })).toBeVisible();
        await expect.poll(() => revoked).toEqual([other.id, other.id]);
    } finally {
        releaseRevocation();
    }
    await acknowledgeOperation(page, "Session revoked.");
    await expect(otherRow).toHaveCount(0);
    await expect(search).toHaveValue("Linux");
    await expect(page.getByText("Sessions could not be loaded.", { exact: true })).toBeVisible();
    await search.clear();
    await expect(currentRow).toBeVisible();
    await page.getByRole("button", { name: "Retry sessions", exact: true }).click();
    await expect(page.getByText("Sessions could not be loaded.", { exact: true })).toHaveCount(0);
    await legacyRow.getByRole("button", { name: "Revoke session", exact: true }).click();
    await confirmButton.click();
    await acknowledgeOperation(page, "Active session not found", "failed");
    await expect(legacyRow).toHaveCount(0);
    await expect(currentRow).toBeVisible();
    await expect(page).toHaveURL("/account");
});
