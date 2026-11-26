/**
 * 表格空态回归使用实际工作区和筛选结果，再读取浏览器计算的文字边界与列表可用宽度，覆盖正常页面入口。
 */
import { randomUUID } from "node:crypto";
import { expect, test as browserTest, type Locator, type Page } from "@playwright/test";
import { editorScope } from "../editor-fixture";
import { chooseWorkspace } from "../support/console-controls";
import { installed } from "../support/install-console";

const test = browserTest.extend<{ workspaceId: string }>({
    workspaceId: [
        async ({ page }, use) => {
            await installed(page);
            const { workspaceId } = await editorScope(page, `table-empty-${randomUUID()}`);
            await use(workspaceId);
        },
        { auto: true },
    ],
});

/**
 * 加载各自的正常路由后用实际工作区目录选中新空间，避免复用管理员临时偏好或上一用例留下的列表范围。
 */
async function openEmptyWorkspace(page: Page, path: string, workspaceId: string) {
    await page.goto(path);
    await chooseWorkspace(page, workspaceId);
}

/**
 * 核对真实表头、跨列单元格和文字坐标，排除表外提示或仅将背景占满整行却仍把文字靠左的布局。
 */
async function expectEmptyTable(message: Locator) {
    await expect(message).toBeVisible();
    const layout = await message.evaluate((element) => {
        const table = element.closest("table");
        const header = table?.tHead?.rows[0];
        if (!(element instanceof HTMLTableCellElement) || !element.closest("tbody") || !table || !header) {
            throw new Error("Empty message must be a cell below the table header");
        }
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        const bounds = table.getBoundingClientRect();
        const headerBounds = header.getBoundingClientRect();
        return {
            columns: header.cells.length,
            spans: element.colSpan,
            headerHeight: headerBounds.height,
            below: text.top >= headerBounds.bottom,
            offset: Math.abs(text.left + text.width / 2 - (bounds.left + bounds.width / 2)),
        };
    });
    expect(layout.columns).toBeGreaterThan(0);
    expect(layout.spans).toBe(layout.columns);
    expect(layout.headerHeight).toBeGreaterThan(0);
    expect(layout.below).toBe(true);
    expect(layout.offset).toBeLessThanOrEqual(1);
    await expect(message).toHaveCSS("text-align", "center");
}

test("empty resource table centers its message", async ({ page, workspaceId }) => {
    await openEmptyWorkspace(page, "/resources/datasets", workspaceId);
    await expectEmptyTable(page.getByRole("cell", { name: "No resources in this Workspace.", exact: true }));
});

test("empty system users table centers its filtered result", async ({ page }) => {
    await page.goto("/admin/users");
    await page.getByLabel("Search email or display name").fill(`no-user-${randomUUID()}`);
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expectEmptyTable(page.getByRole("cell", { name: "No matching users.", exact: true }));
});

test("empty Workspace member user table centers its filtered result", async ({ page, workspaceId }) => {
    await openEmptyWorkspace(page, "/workspaces?tab=members", workspaceId);
    await page.getByPlaceholder("Search users").fill(`no-member-${randomUUID()}`);
    await expectEmptyTable(page.getByRole("cell", { name: "No matching users.", exact: true }));
});

test("empty Workspace invitations table centers its message", async ({ page, workspaceId }) => {
    await openEmptyWorkspace(page, "/workspaces?tab=members", workspaceId);
    await expectEmptyTable(page.getByRole("cell", { name: "No invitations yet.", exact: true }));
});

test("empty Workspace AI provider table centers its message", async ({ page, workspaceId }) => {
    await openEmptyWorkspace(page, "/workspaces?tab=ai-providers", workspaceId);
    await expectEmptyTable(page.getByRole("cell", { name: "No providers configured.", exact: false }));
});

test("empty AI call history table centers its message", async ({ page, workspaceId }) => {
    await openEmptyWorkspace(page, "/ai", workspaceId);
    await expectEmptyTable(page.getByRole("cell", { name: "No model calls in this Workspace.", exact: true }));
});

test("empty run history retains its table and centered message", async ({ page, workspaceId }) => {
    await openEmptyWorkspace(page, "/reports", workspaceId);
    await expectEmptyTable(page.getByRole("cell", { name: "No runs in this Workspace.", exact: true }));
});

test("empty execution plans retain their table and centered message", async ({ page, workspaceId }) => {
    await openEmptyWorkspace(page, "/execution-plans", workspaceId);
    await expectEmptyTable(page.getByRole("cell", { name: "No execution plans yet.", exact: true }));
});
