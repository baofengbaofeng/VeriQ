/**
 * 使用真实工作区、侧栏导航和资源请求验证专属页的列表与创建类型，避免把标题变化误认为已经切换了资源查询。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { acknowledgeOperation, closeResourceEditor, editorScope, resourceCreateForm } from "../editor-fixture";
import { chooseLanguage, chooseWorkspace } from "../support/console-controls";
import { installed } from "../support/install-console";

const menus = [
    { path: "datasets", link: "Datasets", kind: "DATASET", create: "New dataset" },
    { path: "fixtures", link: "Fixtures", kind: "FIXTURE", create: "New fixture" },
    {
        path: "assertion",
        link: "Assertion",
        kind: "ASSERTION_TEMPLATE",
        create: "New assertion",
    },
    { path: "flows", link: "Flows", kind: "FLOW", create: "New flow" },
    { path: "cases", link: "Cases", kind: "CASE", create: "New case" },
    { path: "suites", link: "Suites", kind: "SUITE", create: "New suite" },
    { path: "environments", link: "Environments", kind: "ENVIRONMENT", create: "New execution environment" },
] as const;

test.use({ viewport: { width: 1280, height: 800 } });

/**
 * 长标识应在窄屏表格内按单行显示，键盘进入被截断的标识后可读取全文，表格滚动不带动整个管理台。
 */
test("long resource values stay in the table and reveal on keyboard focus", async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `resource-long-value-${randomUUID()}`);
    const key = `dataset_${"long_key_".repeat(14)}end`;
    const name = `Dataset ${"long name ".repeat(12)}end`;
    const created = await page.request.post(`/api/v1/workspaces/${workspaceId}/resources`, {
        headers,
        data: {
            kind: "DATASET",
            key,
            name,
            content: {
                kind: "DATASET",
                document: {
                    schemaVersion: "1.0",
                    columns: { label: "string" },
                    rows: [{ key: "sample_row", values: { label: "Example" } }],
                },
            },
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    const table = page.getByRole("table");
    const region = table.locator("..");
    const value = table.getByRole("cell", { name: key, exact: true });
    await expect(table.getByRole("columnheader", { name: "Key", exact: true })).toHaveCSS("white-space", "nowrap");
    await expect(value).toHaveCSS("white-space", "nowrap");
    expect(await region.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(480);
    const keyLabel = value.getByRole("button", { name: key, exact: true });
    await keyLabel.press("Enter");
    const fullValue = page.getByRole("dialog", { name: "Key", exact: true });
    await expect(fullValue.getByText(key, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(fullValue).toHaveCount(0);
    await expect(keyLabel).toBeFocused();
    const details = table.getByRole("link", { name: `Details for ${name} (${key})`, exact: true });
    await details.press("Enter");
    await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible();
});

test("resource menu links, history and refresh keep only the current kind", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `menu-list-${randomUUID()}`);
    for (const example of ["dataset", "fixture", "catalog"]) {
        const file = new URL(`../../../../fixtures/sample-workspace/assets/${example}.json`, import.meta.url);
        const content = JSON.parse(await readFile(file, "utf8"));
        const created = await page.request.post(`/api/v1/workspaces/${workspaceId}/resources`, {
            headers,
            data: { kind: content.kind, key: `menu_${example}`, name: `Example ${example}`, content },
        });
        expect(created.status(), await created.text()).toBe(201);
    }
    const rows = page.getByRole("table").getByRole("row");
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    await expect(rows.nth(1)).toContainText("menu_dataset");
    await expect(rows).toHaveCount(2);

    const sidebar = page.getByRole("navigation", { name: "Main navigation" });
    await sidebar.getByRole("link", { name: "Fixtures", exact: true }).click();
    await expect(page).toHaveURL("/resources/fixtures");
    await expect(rows.nth(1)).toContainText("menu_fixture");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1).getByRole("button", { name: "Example fixture", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Actions", exact: true })).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL("/resources/datasets");
    await expect(rows.nth(1)).toContainText("menu_dataset");
    await page.goForward();
    await expect(page).toHaveURL("/resources/fixtures");
    await expect(rows.nth(1)).toContainText("menu_fixture");
    await page.reload();
    await chooseWorkspace(page, workspaceId);
    await expect(rows.nth(1)).toContainText("menu_fixture");
    await expect(rows).toHaveCount(2);
    await expect(page.getByRole("columnheader", { name: "Kind", exact: true })).toHaveCount(0);

    await sidebar.getByRole("link", { name: "Element catalogs", exact: true }).click();
    await expect(page).toHaveURL("/resources/element-catalogs");
    await expect(rows.nth(1)).toContainText("menu_catalog");
    await expect(rows).toHaveCount(2);
    await expect(page.getByRole("columnheader", { name: "Kind", exact: true })).toBeVisible();
    await expect(resourceCreateForm(page)).toBeVisible();
    const status = page.getByRole("combobox", { name: "Filter status", exact: true });
    await expect(status).toHaveJSProperty("tagName", "BUTTON");
    await expect(status.getByText("All", { exact: true })).toBeVisible();
    await status.press("Enter");
    const options = page.getByRole("listbox");
    await expect(options.getByRole("option", { name: "All", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(options.getByRole("option", { name: "Draft", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(status.getByText("Draft", { exact: true })).toBeVisible();
    await expect(rows.nth(1)).toContainText("menu_catalog");
    await expect(resourceCreateForm(page)).toBeVisible();
});

/**
 * 在中文专页创建并重新打开真实资源，核对菜单、面包屑及抽屉的显示名称和提交的契约类型各自保持一致。
 */
test("Chinese Fixture and Assertion labels stay consistent after creation and refresh", async ({ page }) => {
    await installed(page);
    const { workspaceId } = await editorScope(page, `localized-resource-${randomUUID()}`);
    await chooseLanguage(page, "zh");
    const sidebar = page.getByRole("navigation", { name: "主要导航", exact: true });
    const breadcrumb = page.getByRole("navigation", { name: "面包屑导航", exact: true });
    for (const [path, label, kind] of [
        ["fixtures", "夹具", "FIXTURE"],
        ["assertion", "断言", "ASSERTION_TEMPLATE"],
    ] as const) {
        const url = `/resources/${path}`;
        const menu = sidebar.getByRole("link", { name: label, exact: true });
        await expect(menu).toHaveAttribute("href", url);
        await menu.click();
        await expect(page).toHaveURL(url);
        await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(label);
        await expect(page.getByRole("heading", { name: label, exact: true, level: 1 })).toBeVisible();
        const createLabel = `新建${label}`;
        await page.getByRole("button", { name: createLabel, exact: true }).click();
        await expect(page.getByRole("heading", { name: createLabel, exact: true, level: 1 })).toBeFocused();

        const key = `localized_${kind.toLowerCase()}`;
        const name = `${label}示例`;
        await page.getByRole("textbox", { name: "标识", exact: true }).fill(key);
        await page.getByRole("textbox", { name: "名称", exact: true }).fill(name);
        const response = page.waitForResponse(
            (result) =>
                result.url().endsWith(`/workspaces/${workspaceId}/resources`) && result.request().method() === "POST",
        );
        await page.getByRole("button", { name: "创建资源", exact: true }).click();
        const created = await response;
        expect(created.status(), await created.text()).toBe(201);
        expect(created.request().postDataJSON()).toMatchObject({ kind, content: { kind } });
        const feedback = page.getByRole("dialog", { name: "操作成功", exact: true });
        await expect(feedback).toContainText("资源已创建");
        await feedback.getByRole("button", { name: "确定", exact: true }).click();
        const drawer = page.getByRole("dialog", { name, exact: true });
        const detail = drawer.getByRole("heading", { name: `${name} · ${label}`, exact: true });
        await expect(detail).toBeVisible();
        await drawer.getByRole("button", { name: "关闭", exact: true }).click();

        await page.reload();
        await chooseWorkspace(page, workspaceId);
        await expect(page).toHaveURL(url);
        await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(label);
        await page.getByRole("table").getByRole("button", { name, exact: true }).click();
        await expect(detail).toBeVisible();
        await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    }
});

/**
 * 两个同名资源使用独立标识和内容，核对两个详情链接打开对应草稿，并通过面包屑回到实际列表。
 * 在两种主题中均通过实际悬停检查详情链接没有底色且带下划线，深色主题中的键盘焦点仍有独立底色。
 */
test("dataset rows open their own page from the details link", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `dataset-details-${randomUUID()}`);
    const name = "Shared dataset title";
    const keys = ["menu_detail_alpha", "menu_detail_beta"];
    for (const key of keys) {
        const created = await page.request.post(`/api/v1/workspaces/${workspaceId}/resources`, {
            headers,
            data: {
                kind: "DATASET",
                key,
                name,
                content: {
                    kind: "DATASET",
                    document: {
                        schemaVersion: "1.0",
                        columns: { label: "string" },
                        rows: [{ key: `${key}_row`, values: { label: key } }],
                    },
                },
            },
        });
        expect(created.status(), await created.text()).toBe(201);
    }
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    const table = page.getByRole("table");
    const theme = page.getByRole("banner").getByRole("button", { name: "Dark mode", exact: true });
    await expect(theme).toHaveAttribute("aria-pressed", "false");
    await expect(table.getByRole("columnheader").last()).toHaveText("Actions");
    for (const [index, key] of keys.entries()) {
        if (index === 1) {
            await theme.click();
            await expect(theme).toHaveAttribute("aria-pressed", "true");
        }
        const row = table.getByRole("row").filter({ has: page.getByRole("cell", { name: key, exact: true }) });
        const nameCell = row.getByRole("cell", { name, exact: true });
        await expect(nameCell).toHaveText(name);
        await expect(nameCell.getByRole("button")).toHaveCount(0);
        await expect(nameCell.getByRole("link")).toHaveCount(0);
        const details = row.getByRole("link", { name: `Details for ${name} (${key})`, exact: true });
        await expect(details).toHaveText("Details");
        await details.hover();
        await expect(details).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(details).toHaveCSS("text-decoration-line", "underline");
        if (index === 0) await details.press("Enter");
        else {
            await details.press("Shift+Tab");
            await page.keyboard.press("Tab");
            await expect(details).toBeFocused();
            await expect(details).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
            await details.click();
        }
        await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeFocused();
        await expect(page.getByRole("main").getByRole("textbox", { name: "Row key", exact: true })).toHaveValue(
            `${key}_row`,
        );
        await closeResourceEditor(page);
        await expect(details).toBeVisible();
    }
    await chooseLanguage(page, "zh");
    await expect(table.getByRole("columnheader").last()).toHaveText("操作");
    await expect(page.getByRole("link", { name: `查看 ${name}（${keys[0]}）的详情`, exact: true })).toHaveText("详情");
});

/**
 * 使用接口允许的多词长名称撑开表格，末列详情仍由真实横向滚动进入视口，页面宽度与空结果居中不受影响。
 */
test("dataset headers and long values stay on one line inside the scroll area", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `dataset-scroll-${randomUUID()}`);
    const name = `Wide dataset ${"WWWW ".repeat(28).trimEnd()}`;
    const key = "wide_dataset";
    const created = await page.request.post(`/api/v1/workspaces/${workspaceId}/resources`, {
        headers,
        data: {
            kind: "DATASET",
            name,
            key,
            content: {
                kind: "DATASET",
                document: {
                    schemaVersion: "1.0",
                    columns: { label: "string" },
                    rows: [{ key: "row_1", values: { label: "Wide dataset row" } }],
                },
            },
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    const table = page.getByRole("table");
    const scrollArea = table.locator("..");
    await expect(table.getByRole("columnheader").first()).toHaveCSS("white-space", "nowrap");
    await expect(table.getByRole("cell", { name, exact: true })).toHaveCSS("white-space", "nowrap");
    expect(await scrollArea.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
    const main = page.getByRole("main");
    expect(await main.evaluate((node) => node.scrollWidth)).toBe(await main.evaluate((node) => node.clientWidth));

    const details = table.getByRole("link", { name: `Details for ${name} (${key})`, exact: true });
    await details.scrollIntoViewIfNeeded();
    await expect(details).toBeInViewport();
    expect(await scrollArea.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    await details.click();
    await expect(main.getByLabel("label", { exact: true })).toHaveValue("Wide dataset row");
    await closeResourceEditor(page);
    await page.getByRole("searchbox", { name: "Search name or key" }).fill("inexistent dataset");
    await expect(page.getByText("No matching resources.", { exact: true })).toHaveCSS("text-align", "center");
});

/**
 * 使用真实数据核对工具栏布局及页脚位置，通过键盘选择归档状态，验证查看全部还原条件并保留每页数量。
 */
test("dataset table combines the standard toolbar with its range and pagination", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `dataset-page-spacing-${randomUUID()}`);
    const resources = `/api/v1/workspaces/${workspaceId}/resources`;
    const archivedName = "Archived spacing dataset";
    for (let index = 1; index <= 11; index++) {
        const created = await page.request.post(resources, {
            headers,
            data: {
                kind: "DATASET",
                name: `Spacing dataset ${index}`,
                key: `spacing_dataset_${index}`,
                content: {
                    kind: "DATASET",
                    document: {
                        schemaVersion: "1.0",
                        columns: { label: "string" },
                        rows: [{ key: "row_1", values: { label: "Sample" } }],
                    },
                },
            },
        });
        expect(created.status(), await created.text()).toBe(201);
        if (index === 11) {
            const { id } = (await created.json()).data;
            const archived = await page.request.patch(`${resources}/${id}`, {
                headers,
                data: { name: archivedName, archived: true },
            });
            expect(archived.status(), await archived.text()).toBe(200);
        }
    }
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    const table = page.getByRole("table");
    const frame = page.getByRole("main").locator(".vq-library-table");
    const pager = page.getByRole("navigation", { name: "Resource list pages", exact: true });
    const count = frame.getByText("Showing 1 to 10 of 11 entries", { exact: true });
    const names = table.locator("tbody td:first-child");
    const size = frame.getByRole("combobox", { name: "Rows per page", exact: true });
    const search = frame.getByRole("searchbox", { name: "Search name or key", exact: true });
    const filter = frame.getByRole("button", { name: "Filter", exact: true });
    const seeAll = frame.getByRole("button", { name: "See all", exact: true });
    const download = frame.getByRole("button", { name: "Download", exact: true });
    await expect(filter).toBeVisible();
    await expect(names).toHaveCount(10);
    const firstPage = await names.allTextContents();
    const [frameBox, tableBox, countBox, pagerBox] = await Promise.all([
        frame.boundingBox(),
        table.boundingBox(),
        count.boundingBox(),
        pager.boundingBox(),
    ]);
    if (!frameBox || !tableBox || !countBox || !pagerBox) throw new Error("Expected complete resource table");
    expect(pagerBox.y).toBeGreaterThan(tableBox.y + tableBox.height);
    expect(pagerBox.y + pagerBox.height).toBeLessThan(frameBox.y + frameBox.height);
    expect(pagerBox.x).toBeGreaterThan(countBox.x + countBox.width);
    const toolbar = await Promise.all(
        [size, frame.locator(".vq-user-search"), filter, seeAll, download].map((item) => item.boundingBox()),
    );
    const [first, ...controls] = toolbar;
    if (!first) throw new Error("Expected the page-size control");
    let right = first.x + first.width;
    for (const control of controls) {
        if (!control) throw new Error("Expected all dataset toolbar controls");
        expect(control.x).toBeGreaterThan(right);
        expect(control.height).toBeCloseTo(first.height, 0);
        expect(control.y + control.height / 2).toBeCloseTo(first.y + first.height / 2, 0);
        right = control.x + control.width;
    }

    await pager.getByRole("button", { name: "Next", exact: true }).click();
    await expect(pager.locator('[aria-current="page"]')).toHaveText("2");
    await expect(names).toHaveCount(1);
    await expect(frame.getByText("Showing 11 to 11 of 11 entries", { exact: true })).toBeVisible();
    expect(firstPage).not.toContain(await names.first().textContent());
    await pager.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(pager.locator('[aria-current="page"]')).toHaveText("1");
    await expect(names).toHaveText(firstPage);

    await pager.getByRole("button", { name: "Next", exact: true }).click();
    await filter.press("Enter");
    const status = page.getByRole("menuitem", { name: "Status", exact: true });
    await status.press("ArrowRight");
    const options = page.getByRole("menuitemradio");
    await expect(options).toHaveText(["All", "Draft", "Published", "Archived"]);
    const archived = page.getByRole("menuitemradio", { name: "Archived", exact: true });
    await archived.press("Enter");
    await expect(archived).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(status).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(filter).toBeFocused();
    await expect(names).toHaveText([archivedName]);

    await size.click();
    await page.getByRole("option", { name: "5", exact: true }).click();
    await search.fill("inexistent dataset");
    await expect(frame.getByText("No matching resources.", { exact: true })).toBeVisible();
    await expect(pager.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
    await expect(pager.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
    await expect(frame.getByText("Showing 0 to 0 of 0 entries", { exact: true })).toBeVisible();
    await seeAll.click();
    await expect(search).toHaveValue("");
    await expect(size).toContainText("5");
    await expect(names).toHaveText(firstPage.slice(0, 5));
    await pager.getByRole("button", { name: "Next", exact: true }).click();
    await seeAll.click();
    await expect(pager.locator('[aria-current="page"]')).toHaveText("1");
    await expect(frame.getByText("Showing 1 to 5 of 11 entries", { exact: true })).toBeVisible();

    // 详情页通过历史条目带回当前视图状态，返回时继续使用同一工作区的搜索、筛选、页码和每页记录数。
    await filter.press("Enter");
    await status.press("ArrowRight");
    await page.getByRole("menuitemradio", { name: "Draft", exact: true }).press("Enter");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await search.fill("Spacing");
    await pager.getByRole("button", { name: "Next", exact: true }).click();
    await expect(frame.getByText("Showing 6 to 10 of 10 entries", { exact: true })).toBeVisible();
    await table
        .getByRole("link", { name: /^Details for Spacing dataset/ })
        .first()
        .click();
    await closeResourceEditor(page);
    await expect(search).toHaveValue("Spacing");
    await expect(size).toContainText("5");
    await expect(pager.locator('[aria-current="page"]')).toHaveText("2");
    await expect(frame.getByText("Showing 6 to 10 of 10 entries", { exact: true })).toBeVisible();
    await seeAll.click();

    await chooseLanguage(page, "zh");
    const localizedFilter = frame.getByRole("button", { name: "筛选", exact: true });
    await localizedFilter.press("Enter");
    await page.getByRole("menuitem", { name: "状态", exact: true }).press("ArrowRight");
    await expect(options).toHaveText(["全部", "草稿", "已发布", "已归档"]);
    await expect(page.getByRole("menuitemradio", { name: "全部", exact: true })).toHaveAttribute(
        "aria-checked",
        "true",
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(localizedFilter).toBeFocused();
});

/**
 * 三个字段在输入框或选择器下方提供可见帮助，以便使用者在填写前了解用途和格式限制。
 */
test("new dataset fields expose accessible guidance below each control", async ({ page }) => {
    await installed(page);
    await editorScope(page, `dataset-hints-${randomUUID()}`);
    await page.getByRole("button", { name: "New dataset", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New dataset", exact: true });
    for (const [control, text] of [
        [dialog.getByRole("textbox", { name: "Name", exact: true }), /dataset list/i],
        [dialog.getByRole("combobox", { name: "Dataset format", exact: true }), /static.*HTTP/i],
        [dialog.getByRole("textbox", { name: "Key", exact: true }), /letter.*underscore.*hyphen/i],
    ] as const) {
        await expect(control).toHaveAccessibleDescription(text);
        const hint = dialog.locator(".vq-field-hint").filter({ hasText: text });
        await expect(hint).toBeVisible();
        await expect(hint).toHaveCSS("font-size", "10px");
        const inputBounds = await control.boundingBox();
        const hintBounds = await hint.boundingBox();
        if (!inputBounds || !hintBounds) throw new Error("Missing dataset field or its guidance");
        expect(hintBounds.y).toBeGreaterThanOrEqual(inputBounds.y + inputBounds.height);
    }
    await expect(dialog.getByRole("button", { name: "Help for Key", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await chooseLanguage(page, "zh");
    await page.getByRole("button", { name: "新建数据集", exact: true }).click();
    const localized = page.getByRole("dialog", { name: "新建数据集", exact: true });
    await expect(localized.getByRole("textbox", { name: "名称", exact: true })).toHaveAccessibleDescription(/数据集/);
    await expect(localized.getByRole("combobox", { name: "数据集格式", exact: true })).toHaveAccessibleDescription(
        /静态.*HTTP/,
    );
    await expect(localized.getByRole("textbox", { name: "标识", exact: true })).toHaveAccessibleDescription(/下划线/);
});

/**
 * 逐项试点新建数据集对话框中的四种格式，核对下拉选项在模态层上方实际能收到指针事件。
 */
test("dataset format options receive pointer events above the new dataset dialog", async ({ page }) => {
    await installed(page);
    await editorScope(page, `dataset-layer-${randomUUID()}`);
    await page.getByRole("button", { name: "New dataset", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New dataset", exact: true });
    const format = dialog.getByRole("combobox", { name: "Dataset format", exact: true });
    await format.click();
    const options = page.getByRole("listbox");
    for (const name of ["Static table", "Static tree", "HTTP table", "HTTP tree"]) {
        await options.getByRole("option", { name, exact: true }).click({ trial: true, timeout: 3000 });
    }
    await options.getByRole("option", { name: "HTTP tree", exact: true }).click();
    await expect(format).toContainText("HTTP tree");
    await format.press("Enter");
    await expect(options).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(options).toHaveCount(0);
    await expect(format).toBeFocused();
    await expect(dialog).toBeVisible();
});

/**
 * 通过真实创建请求核对四种格式的版本、形状和来源，再打开已保存的旧草稿确认仍按原有字段布局读取。
 */
test("dataset creation offers four V2 formats and still opens a stored V1 draft", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `dataset-formats-${randomUUID()}`);
    const url = `/api/v1/workspaces/${workspaceId}/resources`;
    const legacyKey = "stored_legacy_dataset";
    const legacyName = "Stored legacy dataset";
    const legacy = await page.request.post(url, {
        headers,
        data: {
            kind: "DATASET",
            name: legacyName,
            key: legacyKey,
            content: {
                kind: "DATASET",
                document: {
                    schemaVersion: "1.0",
                    columns: { label: "string" },
                    rows: [{ key: "legacy_row", values: { label: "Existing value" } }],
                },
            },
        },
    });
    expect(legacy.status(), await legacy.text()).toBe(201);
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    const form = resourceCreateForm(page);
    const format = form.getByRole("combobox", { name: "Dataset format", exact: true });
    const choices = [
        ["TABLE", "Static table", "TABLE", "STATIC"],
        ["TREE", "Static tree", "TREE", "STATIC"],
        ["HTTP_TABLE", "HTTP table", "TABLE", "HTTP"],
        ["HTTP_TREE", "HTTP tree", "TREE", "HTTP"],
    ] as const;
    for (const [value, name, shape, source] of choices) {
        await page.getByRole("button", { name: "New dataset", exact: true }).click();
        await expect(format).toHaveJSProperty("tagName", "BUTTON");
        await expect(format).toHaveAttribute("aria-required", "true");
        await expect(format).toContainText("Static table");
        await format.press("Enter");
        const options = page.getByRole("listbox");
        await expect(options.getByRole("option")).toHaveCount(choices.length);
        for (const [index, [, label]] of choices.entries()) {
            await expect(options.getByRole("option").nth(index)).toHaveAccessibleName(label);
        }
        await options.getByRole("option", { name, exact: true }).click();
        await expect(format).toContainText(name);
        await form.getByLabel("Key", { exact: true }).fill(`new_${value.toLowerCase()}`);
        await form.getByLabel("Name", { exact: true }).fill(name);
        const created = page.waitForResponse((r) => r.url().endsWith(url) && r.request().method() === "POST");
        await form.getByRole("button", { name: "Create resource", exact: true }).click();
        const response = await created;
        expect(response.status(), await response.text()).toBe(201);
        expect(response.request().postDataJSON()).toMatchObject({
            kind: "DATASET",
            content: { kind: "DATASET", document: { schemaVersion: "2.0", shape, source: { kind: source } } },
        });
        await acknowledgeOperation(page, "Resource created");
        await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible();
        await closeResourceEditor(page);
    }

    await page.getByRole("link", { name: `Details for ${legacyName} (${legacyKey})`, exact: true }).click();
    const legacyPage = page.getByRole("main");
    await expect(legacyPage.getByRole("textbox", { name: "Row key", exact: true })).toHaveValue("legacy_row");
    await expect(legacyPage.getByRole("textbox", { name: "label", exact: true })).toHaveValue("Existing value");
    await closeResourceEditor(page);

    await chooseLanguage(page, "zh");
    await page.getByRole("button", { name: "新建数据集", exact: true }).click();
    const localizedFormat = page.getByRole("combobox", { name: "数据集格式", exact: true });
    await expect(localizedFormat).toContainText("静态表格");
    await localizedFormat.press("Enter");
    const localizedOptions = page.getByRole("listbox");
    for (const name of ["静态表格", "静态树", "HTTP 表格", "HTTP 树"]) {
        await expect(localizedOptions.getByRole("option", { name, exact: true })).toBeVisible();
    }
    await localizedOptions.getByRole("option", { name: "HTTP 树", exact: true }).click();
    await page.getByRole("dialog", { name: "新建数据集", exact: true }).getByRole("button", { name: "取消" }).click();
    await page.getByRole("button", { name: "新建数据集", exact: true }).click();
    await expect(localizedFormat).toContainText("静态表格");
});

test("seven resource menus expose creation only on demand and submit their own kinds", async ({ page }) => {
    test.setTimeout(90_000);
    await installed(page);
    const { workspaceId } = await editorScope(page, `menu-create-${randomUUID()}`);
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    const sidebar = page.getByRole("navigation", { name: "Main navigation" });
    const form = resourceCreateForm(page);
    for (const [index, menu] of menus.entries()) {
        if (index !== 0) await sidebar.getByRole("link", { name: menu.link, exact: true }).click();
        await expect(page).toHaveURL(`/resources/${menu.path}`);
        await expect(page.getByText("No resources in this Workspace.", { exact: true })).toBeVisible();
        await expect(form).toHaveCount(0);
        await expect(page.getByRole("button", { name: "New resource", exact: true })).toHaveCount(0);
        const start = page.getByRole("button", { name: menu.create, exact: true });
        if (menu.kind !== "DATASET") {
            await expect(page.getByRole("button", { name: "Copy dataset", exact: true })).toHaveCount(0);
        }
        await expect(start).toBeEnabled();
        await start.press("Enter");
        const createTitle =
            menu.kind === "FIXTURE" || menu.kind === "ASSERTION_TEMPLATE" ? menu.create : "New resource";
        const createHeading = page.getByRole("heading", { name: createTitle, exact: true, level: 1 });
        if (menu.kind !== "DATASET") await expect(createHeading).toBeFocused();
        await expect(form.getByRole("combobox", { name: "Kind", exact: true })).toHaveCount(0);
        const format = form.getByRole("combobox", { name: "Dataset format", exact: true });
        if (menu.kind === "DATASET") {
            const dialog = page.getByRole("dialog", { name: "New dataset", exact: true });
            await format.press("Enter");
            const options = page.getByRole("listbox");
            await expect(options.getByRole("option")).toHaveCount(4);
            await page.keyboard.press("Escape");
            await expect(options).toBeHidden();
            await expect(format).toBeFocused();
            await dialog.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
            await expect(start).toBeFocused();
            await expect(form).toHaveCount(0);
            await start.click();
            await format.click();
            await page.getByRole("listbox").getByRole("option", { name: "Static tree", exact: true }).click();
        } else await expect(format).toHaveCount(0);

        const key = `menu_${menu.kind.toLowerCase()}`;
        await form.getByLabel("Key", { exact: true }).fill(key);
        await form.getByLabel("Name", { exact: true }).fill(`Menu ${menu.kind}`);
        const response = page.waitForResponse(
            (r) => r.url().endsWith(`/workspaces/${workspaceId}/resources`) && r.request().method() === "POST",
        );
        await form.getByRole("button", { name: "Create resource", exact: true }).click();
        const created = await response;
        expect(created.status(), await created.text()).toBe(201);
        expect((await created.json()).data).toMatchObject({ kind: menu.kind, key });
        if (menu.kind === "DATASET") {
            expect(created.request().postDataJSON().content.document.shape).toBe("TREE");
        }
        await acknowledgeOperation(page, "Resource created");
        const editor = page.getByRole("article");
        await expect(editor).toBeVisible();
        await closeResourceEditor(page);
        if (menu.kind === "DATASET") await expect(start).toBeVisible();
        else await expect(start).toBeFocused();
        const rows = page.getByRole("table").getByRole("row");
        await expect(rows.nth(1)).toContainText(key);
        await expect(rows).toHaveCount(2);
        await expect(page.getByRole("columnheader", { name: "Kind", exact: true })).toHaveCount(0);
        await expect(form).toHaveCount(0);
    }
});

/**
 * 在真实页面比较两个操作的尺寸，验证复制弹窗的字段提示、菜单堆叠和取消后焦点返回，不发起复制写入。
 */
test("dataset copy is placed beside create and retains its own tone and focus", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `menu-copy-${randomUUID()}`);
    const sourceName = `Dataset copy source ${randomUUID()}`;
    const source = await page.request.post("/api/v1/workspaces", {
        headers,
        data: { key: `copy-source-${randomUUID()}`, name: sourceName },
    });
    expect(source.status(), await source.text()).toBe(201);
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    const copy = page.getByRole("button", { name: "Copy dataset", exact: true });
    const create = page.getByRole("button", { name: "New dataset", exact: true });
    await expect(copy).toHaveCount(1);
    await expect(create).toBeVisible();
    const [copyBox, createBox] = await Promise.all([copy.boundingBox(), create.boundingBox()]);
    if (!copyBox || !createBox) throw new Error("Missing dataset actions");
    const gap = createBox.x - (copyBox.x + copyBox.width);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThanOrEqual(16);
    expect(Math.abs(copyBox.y - createBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(copyBox.height - createBox.height)).toBeLessThanOrEqual(1);
    await expect(copy).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(create).toHaveCSS("background-color", "rgb(70, 95, 255)");

    await create.press("Enter");
    const newDialog = page.getByRole("dialog", { name: "New dataset", exact: true });
    const newDialogBox = await newDialog.boundingBox();
    if (!newDialogBox) throw new Error("Missing new dataset dialog");
    await page.keyboard.press("Escape");
    await expect(newDialog).toHaveCount(0);
    await copy.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Copy dataset", exact: true });
    const box = await dialog.boundingBox();
    if (!box) throw new Error("Missing copy dataset dialog");
    expect(box.x + box.width / 2).toBeCloseTo(newDialogBox.x + newDialogBox.width / 2, 0);
    expect(box.y + box.height / 2).toBeCloseTo(newDialogBox.y + newDialogBox.height / 2, 0);
    expect(box.width).toBe(newDialogBox.width);
    const workspace = dialog.getByRole("combobox", { name: "Source workspace", exact: true });
    const version = dialog.getByRole("combobox", { name: "Published version", exact: true });
    const key = dialog.getByRole("textbox", { name: "Key", exact: true });
    const name = dialog.getByRole("textbox", { name: "Name", exact: true });
    for (const [control, text] of [
        [workspace, /workspace where.*published/i],
        [version, /published version.*draft.*this workspace/i],
        [key, /ASCII letter.*unused Key/i],
        [name, /name.*dataset list.*editor/i],
    ] as const) {
        await expect(control).toHaveAccessibleDescription(text);
        const hint = dialog.locator(".vq-field-hint").filter({ hasText: text });
        await expect(hint).toBeVisible();
        await expect(hint).toHaveCSS("font-size", "10px");
        const hintBounds = await hint.boundingBox();
        const controlBounds = await control.boundingBox();
        if (!hintBounds || !controlBounds) throw new Error("Missing copy field or its guidance");
        expect(hintBounds.y).toBeGreaterThanOrEqual(controlBounds.y + controlBounds.height);
    }
    await expect(dialog.getByRole("button", { name: "Help for Key", exact: true })).toHaveCount(0);
    const dialogLayer = Number(await dialog.evaluate((element) => getComputedStyle(element).zIndex));
    const menu = page.getByRole("listbox");
    await expect(workspace).toBeVisible();
    await expect(version).toBeDisabled();
    await workspace.press("Enter");
    await expect(menu).toBeVisible();
    expect(Number(await menu.evaluate((element) => getComputedStyle(element).zIndex))).toBeGreaterThan(dialogLayer);
    await page.keyboard.press("Escape");
    await expect(workspace).toBeFocused();
    await expect(dialog).toBeVisible();
    await workspace.click();
    await page.getByRole("option", { name: sourceName, exact: true }).click();
    await expect(workspace).toContainText(sourceName);
    await expect(dialog.getByText("This workspace has no published dataset versions.")).toBeVisible();
    await version.click();
    await expect(menu).toBeVisible();
    expect(Number(await menu.evaluate((element) => getComputedStyle(element).zIndex))).toBeGreaterThan(dialogLayer);
    await menu.getByRole("option", { name: "Select", exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await key.fill("not_copied");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(copy).toBeFocused();
    await copy.press("Enter");
    await expect(version).toBeDisabled();
    await expect(key).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(copy).toBeFocused();

    await chooseLanguage(page, "zh");
    await expect(page.getByRole("button", { name: "新建数据集", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "复制数据集", exact: true }).click();
    const localized = page.getByRole("dialog", { name: "复制数据集", exact: true });
    await expect(localized.getByRole("combobox", { name: "源工作区", exact: true })).toHaveAccessibleDescription(
        /发布.*工作区/,
    );
    await expect(localized.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveAccessibleDescription(
        /已发布.*当前工作区.*草稿/,
    );
    await expect(localized.getByRole("textbox", { name: "标识", exact: true })).toHaveAccessibleDescription(
        /当前工作区.*未占用.*英文字母/,
    );
    await expect(localized.getByRole("textbox", { name: "名称", exact: true })).toHaveAccessibleDescription(
        /名称.*数据集列表.*编辑器/,
    );
});
