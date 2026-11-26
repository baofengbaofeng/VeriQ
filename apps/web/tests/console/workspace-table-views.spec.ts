/**
 * 通过真实工作区验证控制台表格的跨页搜索和范围重置，邀请由服务端创建，报告空状态由实际运行清单接口提供。
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { editorScope } from "../editor-fixture";
import { chooseWorkspace } from "../support/console-controls";
import { installed } from "../support/install-console";

test("Workspace invitation search covers records beyond the first server page", async ({ page }) => {
    await installed(page);
    const key = randomUUID();
    const { workspaceId, headers } = await editorScope(page, `invitation-pagination-${key}`);
    const invitations = `/api/v1/workspaces/${workspaceId}/invitations`;
    for (let index = 0; index < 26; index += 1) {
        const response = await page.request.post(invitations, {
            headers,
            data: { email: `invitation-${index}-${key}@example.com`, role: "VIEWER", sendEmail: false },
        });
        expect(response.status()).toBe(201);
    }
    const response = await page.request.get(invitations);
    expect(response.status()).toBe(200);
    const first = (await response.json()).data;
    const second = await page.request.get(invitations, { params: { cursor: first.nextCursor } });
    expect(second.status()).toBe(200);
    const [older] = (await second.json()).data.items;
    expect(older.email).toMatch(key);
    expect(first.items.some(({ email }: { email: string }) => email === older.email)).toBe(false);

    await page.goto("/workspaces?tab=members");
    await chooseWorkspace(page, workspaceId);
    const table = page.getByRole("table", { name: "Invitations" });
    const pagination = page.getByRole("navigation", { name: "Invitations" });
    await expect(table.getByRole("row")).toHaveCount(11);
    await pagination.getByRole("button", { name: "Next" }).click();
    await expect(pagination.getByRole("button", { name: "2", exact: true })).toHaveAttribute("aria-current", "page");
    const search = page.getByRole("searchbox", { name: "Search email" });
    await search.fill(older.email);
    await expect(table.getByRole("row")).toHaveCount(2);
    await expect(table.getByRole("cell", { name: older.email })).toBeVisible();
    await expect(pagination.getByRole("button", { name: "Previous" })).toBeDisabled();
    await expect(pagination.getByRole("button", { name: "Next" })).toBeDisabled();
    await search.fill(`unmatched-${key}`);
    await expect(table.getByRole("columnheader", { name: "Email", exact: true })).toBeVisible();
    await expect(table.getByRole("cell", { name: "No matching invitations.", exact: true })).toHaveAttribute(
        "colspan",
        "7",
    );

    const wrapper = page.locator(".vq-data-table").filter({ has: table });
    const size = wrapper.getByRole("combobox", { name: "Rows per page", exact: true });
    await size.click();
    await page.getByRole("option", { name: "5", exact: true }).click();
    await search.fill(key);
    await pagination.getByRole("button", { name: "Next" }).click();
    await expect(pagination.getByRole("button", { name: "2", exact: true })).toHaveAttribute("aria-current", "page");
    await wrapper.getByRole("button", { name: "See all", exact: true }).click();
    await expect(pagination.getByRole("button", { name: "1", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(size).toContainText("5");
    await expect(search).toHaveValue("");
    await wrapper.getByRole("button", { name: "Filter", exact: true }).press("Enter");
    await page.getByRole("menuitem", { name: "Status", exact: true }).press("ArrowRight");
    await page.getByRole("menuitemradio", { name: "Revoked", exact: true }).press("Enter");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(table.getByRole("cell", { name: "No matching invitations.", exact: true })).toBeVisible();
    await wrapper.getByRole("button", { name: "See all", exact: true }).click();
    await expect(table.getByRole("row")).toHaveCount(6);
    await expect(wrapper.getByText("Showing 1 to 5 of 26 entries", { exact: true })).toBeVisible();
});

/**
 * 成员筛选通过真实目录请求解析权限范围、角色与游标。还原当前表时保留每页数量和另一张表的独立搜索。
 */
test("Members filters use server roles and reset only the current table", async ({ page }) => {
    await installed(page);
    const key = randomUUID();
    const { workspaceId } = await editorScope(page, `members-filter-${key}`);
    await page.goto("/workspaces?tab=members");
    await chooseWorkspace(page, workspaceId);
    const table = page.getByRole("table", { name: "Members", exact: true });
    const wrapper = page.locator(".vq-data-table").filter({ has: table });
    const search = wrapper.getByRole("searchbox", { name: "Search users", exact: true });
    const invitationSearch = page.getByRole("searchbox", { name: "Search email", exact: true });
    const size = wrapper.getByRole("combobox", { name: "Rows per page", exact: true });
    await size.click();
    await page.getByRole("option", { name: "5", exact: true }).click();
    await invitationSearch.fill(key);
    await search.fill(key);
    await expect(table.getByRole("cell", { name: "No matching users.", exact: true })).toBeVisible();
    const filter = wrapper.getByRole("button", { name: "Filter", exact: true });
    await filter.press("Enter");
    await page.getByRole("menuitem", { name: "Role", exact: true }).press("ArrowRight");
    const owner = page.getByRole("menuitemcheckbox", { name: "Owner", exact: true });
    const viewer = page.getByRole("menuitemcheckbox", { name: "Viewer", exact: true });
    await owner.press("Enter");
    await expect(owner).toHaveAttribute("aria-checked", "true");
    const selectedRoles = page.waitForResponse((response) => {
        const { pathname, searchParams } = new URL(response.url());
        return (
            pathname === "/api/v1/admin/users" &&
            searchParams.get("workspaceId") === workspaceId &&
            searchParams.get("role") === "OWNER,VIEWER" &&
            searchParams.get("limit") === "5"
        );
    });
    await viewer.press("Enter");
    expect((await selectedRoles).ok()).toBe(true);
    await expect(owner).toHaveAttribute("aria-checked", "true");
    await expect(viewer).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(filter).toBeFocused();
    const resetRequest = page.waitForResponse((response) => {
        const { pathname, searchParams } = new URL(response.url());
        return (
            pathname === "/api/v1/admin/users" &&
            searchParams.get("workspaceId") === workspaceId &&
            searchParams.get("limit") === "5" &&
            ["q", "role", "membership", "disabled", "systemAdmin", "cursor"].every((key) => !searchParams.has(key))
        );
    });
    await wrapper.getByRole("button", { name: "See all", exact: true }).click();
    expect((await resetRequest).ok()).toBe(true);
    await expect(search).toHaveValue("");
    await expect(invitationSearch).toHaveValue(key);
    await expect(size).toContainText("5");
    await expect(wrapper.locator('[aria-current="page"]')).toHaveText("1");
});

test("Run history search retains the real empty result and clears on Workspace change", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `report-search-${randomUUID()}`);
    const response = await page.request.post("/api/v1/workspaces", {
        headers,
        data: { key: `report-search-${randomUUID()}`, name: "Second report search scope" },
    });
    expect(response.status()).toBe(201);
    const otherId: string = (await response.json()).data.id;
    await page.goto("/reports");
    await chooseWorkspace(page, workspaceId);
    const search = page.getByRole("searchbox", { name: "Search run history" });
    await expect(search).toBeVisible();
    await search.fill("completed");
    await expect(page.getByText("No runs in this Workspace.", { exact: true })).toBeVisible();
    await chooseWorkspace(page, otherId);
    await expect(search).toHaveValue("");
    await expect(page.getByText("No runs in this Workspace.", { exact: true })).toBeVisible();
});
