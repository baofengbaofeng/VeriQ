/**
 * 从已保存的真实资源和模型提供方触发写入，观察统一结果弹窗，并核对写入失败仍保留后续恢复所需的草稿状态。
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
    acknowledgeOperation,
    closeResourceEditor,
    editorScope,
    replaceEditorJson,
    resourceCreateForm,
} from "../editor-fixture";
import { chooseWorkspace } from "../support/console-controls";
import { installed } from "../support/install-console";

test.use({ viewport: { width: 1280, height: 800 } });

/**
 * 用真实服务核对成功确认与同标识冲突的反馈；第二次写入被拒绝后，输入保留在新建表单供用户直接修正。
 */
test("resource creation reports confirmed outcomes and keeps rejected inputs", async ({ page }) => {
    await installed(page);
    const { workspaceId } = await editorScope(page, `resource-create-feedback-${randomUUID()}`);
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    const path = `/api/v1/workspaces/${workspaceId}/resources`;
    const start = page.getByRole("button", { name: "New dataset", exact: true });
    const createDialog = page.getByRole("dialog", { name: "New dataset", exact: true });
    const form = resourceCreateForm(page);
    const key = form.getByLabel("Key", { exact: true });
    const name = form.getByLabel("Name", { exact: true });
    const submit = form.getByRole("button", { name: "Create resource", exact: true });
    await start.click();
    await key.fill("unique_resource_key");
    await name.fill("New resource name");
    let finishWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => {
        finishWrite = resolve;
    });
    let requestHeld!: () => void;
    const held = new Promise<void>((resolve) => {
        requestHeld = resolve;
    });
    await page.route(`**${path}`, async (route) => {
        if (route.request().method() === "POST") {
            requestHeld();
            await writeReleased;
        }
        await route.continue();
    });
    const first = page.waitForResponse((r) => r.url().endsWith(path) && r.request().method() === "POST");
    try {
        await submit.press("Enter");
        await held;
        await expect(form).toHaveAttribute("aria-busy", "true");
        for (const label of ["Close", "Cancel"]) {
            await expect(createDialog.getByRole("button", { name: label, exact: true })).toBeDisabled();
        }
        await page.keyboard.press("Escape");
        await expect(createDialog).toBeVisible();
    } finally {
        finishWrite();
    }
    const created = await first;
    expect(created.status(), await created.text()).toBe(201);
    const result = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
    const detail = page.getByRole("heading", { name: "New resource name", exact: true, level: 1 });
    await expect(result.getByRole("button", { name: "OK", exact: true })).toBeFocused();
    await expect(createDialog).toHaveCount(0);
    await expect(detail).toHaveCount(0);
    await acknowledgeOperation(page, "Resource created");
    await expect(detail).toBeFocused();
    await closeResourceEditor(page);
    await expect(start).toBeVisible();

    await start.click();
    await key.fill("unique_resource_key");
    await name.fill("A different resource name");
    const second = page.waitForResponse((r) => r.url().endsWith(path) && r.request().method() === "POST");
    await submit.click();
    const rejected = await second;
    expect(rejected.status(), await rejected.text()).toBe(409);
    await acknowledgeOperation(page, (await rejected.json()).code, "failed");
    await expect(createDialog).toBeVisible();
    await expect(key).toHaveValue("unique_resource_key");
    await expect(name).toHaveValue("A different resource name");
    await expect(page.getByRole("heading", { name: "A different resource name", exact: true, level: 1 })).toHaveCount(
        0,
    );
});

/**
 * 另一会话归档同一个工作区后，目录回读撤销当前编辑权限，确认此前已完成的写入仍应停留在只读列表。
 */
test("resource success acknowledgement respects an archived workspace", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `archive-before-ack-${randomUUID()}`);
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    const start = page.getByRole("button", { name: "New dataset", exact: true });
    await start.click();
    const form = resourceCreateForm(page);
    await form.getByLabel("Key", { exact: true }).fill("archive_before_ack");
    await form.getByLabel("Name", { exact: true }).fill("Archive before acknowledgment");
    await form.getByRole("button", { name: "Create resource", exact: true }).click();
    const result = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
    await expect(result).toContainText("Resource created");
    const archived = await page.request.delete(`/api/v1/workspaces/${workspaceId}`, { headers });
    expect(archived.ok(), await archived.text()).toBe(true);
    const refreshed = page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/v1/workspaces" && r.request().method() === "GET",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    expect((await refreshed).ok()).toBe(true);
    await expect(page.locator(".vq-resources").getByText("Copy dataset", { exact: true })).toHaveCount(0);
    await acknowledgeOperation(page, "Resource created");
    await page.getByRole("searchbox", { name: "Search name or key", exact: true }).fill("Archive before");
    await expect(start).toBeDisabled();
    await expect(
        page.getByRole("heading", { name: "Archive before acknowledgment", exact: true, level: 1 }),
    ).toHaveCount(0);
});

/**
 * 设置中的名称修改、归档和恢复均核对真实写入响应与结果框；归档期间禁用草稿保存，恢复后重新开放编辑。
 */
test("resource settings report rename, archive, and restore after writes", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `resource-settings-feedback-${randomUUID()}`);
    const base = `/api/v1/workspaces/${workspaceId}/resources`;
    const key = "resource_settings";
    const name = "Resource settings dataset";
    const created = await page.request.post(base, {
        headers,
        data: {
            key,
            name,
            kind: "DATASET",
            content: {
                kind: "DATASET",
                document: { schemaVersion: "1.0", columns: { name: "string" }, rows: [{ key, values: { name } }] },
            },
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = (await created.json()).data;
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    await page.getByRole("link", { name: `Details for ${name} (${key})`, exact: true }).click();
    const renamed = "Renamed resource dataset";
    const editor = page.getByRole("main");
    await editor.getByRole("tab", { name: "Settings & references", exact: true }).click();
    await editor.getByRole("textbox", { name: "Name", exact: true }).fill(renamed);
    const nextWrite = () =>
        page.waitForResponse((r) => r.url().endsWith(`${base}/${id}`) && r.request().method() === "PATCH");
    const rename = nextWrite();
    await editor.getByRole("button", { name: "Rename", exact: true }).click();
    expect((await (await rename).json()).data).toMatchObject({ status: "DRAFT", name: renamed });
    await acknowledgeOperation(page, "Resource name updated");
    await expect(editor.getByRole("heading", { name: renamed, exact: true })).toBeVisible();

    for (const [label, status, message] of [
        ["Archive", "ARCHIVED", "Resource archived"],
        ["Restore", "DRAFT", "Resource restored"],
    ] as const) {
        await editor.getByRole("button", { name: label, exact: true }).click();
        const confirmation = page.getByRole("dialog", { name: label, exact: true });
        const changed = nextWrite();
        await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
        expect((await (await changed).json()).data).toMatchObject({ status, name: renamed });
        await acknowledgeOperation(page, message);
        const nameInput = editor.getByRole("textbox", { name: "Name", exact: true });
        if (status === "ARCHIVED") await expect(nameInput).toBeDisabled();
        else await expect(nameInput).toBeEnabled();
    }
});

test("resource save shows results and preserves recovery for a stale revision", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `feedback-resource-${randomUUID()}`);
    const base = `/api/v1/workspaces/${workspaceId}/resources`;
    const content = {
        kind: "DATASET",
        document: {
            schemaVersion: "1.0",
            columns: { label: "string" },
            rows: [{ key: "before", values: { label: "Original" } }],
        },
    };
    const created = await page.request.post(base, {
        headers,
        data: { kind: "DATASET", name: "Feedback dataset", key: "feedback_dataset", content },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = (await created.json()).data;
    const path = `${base}/${id}/draft`;
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    await page.getByRole("link", { name: "Details for Feedback dataset (feedback_dataset)" }).click();
    const editor = page.getByRole("main");
    const label = editor.getByRole("textbox", { name: "label", exact: true });
    await label.fill("Edited locally");
    const saved = page.waitForResponse(
        (response) => response.url().endsWith(path) && response.request().method() === "PUT",
    );
    await editor.getByRole("button", { name: "Save draft", exact: true }).click();
    const savedDraft = await saved;
    expect(savedDraft.status()).toBe(200);
    const success = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
    await expect(success.getByText("Saved", { exact: true })).toBeVisible();
    await success.getByRole("button", { name: "OK", exact: true }).click();

    const { revision } = (await savedDraft.json()).data;
    const remote = await page.request.put(path, { headers, data: { content, revision } });
    expect(remote.status(), await remote.text()).toBe(200);
    await label.fill("Keep this local change");
    const stale = page.waitForResponse(
        (response) => response.url().endsWith(path) && response.request().method() === "PUT",
    );
    await editor.getByRole("button", { name: "Save draft", exact: true }).click();
    expect((await stale).status()).toBe(409);
    const failure = page.getByRole("dialog", { name: "Operation failed", exact: true });
    await expect(failure).toContainText("STALE_REVISION");
    await failure.getByRole("button", { name: "OK", exact: true }).click();
    await expect(editor.getByRole("button", { name: "Reload remote draft" })).toBeVisible();
    await expect(label).toHaveValue("Keep this local change");
});

/**
 * 草稿保存成功后让一次背景回读中断，确认新输入不随回读错误退出表单，并能用实际服务重新读取同一草稿。
 */
test("a transient draft reload failure keeps edits made after saving", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `draft-reload-error-${randomUUID()}`);
    const base = `/api/v1/workspaces/${workspaceId}/resources`;
    const name = "Draft reload dataset";
    const key = "draft_reload_dataset";
    const created = await page.request.post(base, {
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
                    rows: [{ key, values: { label: name } }],
                },
            },
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = (await created.json()).data;
    const path = `${base}/${id}/draft`;
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    await page.getByRole("link", { name: `Details for ${name} (${key})`, exact: true }).click();
    const editor = page.getByRole("main");
    const label = editor.getByRole("textbox", { name: "label", exact: true });
    await label.fill("Saved value");
    const gate = Promise.withResolvers<void>();
    const getDraft = (r: import("@playwright/test").Request) => r.url().endsWith(path) && r.method() === "GET";
    await page.route(`**${path}`, async (route) => {
        if (!getDraft(route.request())) return route.continue();
        await gate.promise;
        await route.fulfill({ status: 503, json: { code: "DRAFT_RELOAD_UNAVAILABLE", message: "Try again" } });
    });
    try {
        const reload = page.waitForResponse((r) => getDraft(r.request()));
        await editor.getByRole("button", { name: "Save draft", exact: true }).click();
        await acknowledgeOperation(page, "Saved");
        await label.fill("New edit while reloading");
        gate.resolve();
        expect((await reload).status()).toBe(503);
        const failure = editor.getByRole("alert").filter({ hasText: "DRAFT_RELOAD_UNAVAILABLE" });
        await expect(failure).toBeVisible();
        await expect(label).toHaveValue("New edit while reloading");
        await page.unroute(`**${path}`);
        const retry = page.waitForResponse((r) => getDraft(r.request()));
        await failure.getByRole("button", { name: "Retry", exact: true }).click();
        expect((await retry).status()).toBe(200);
        await expect(failure).toHaveCount(0);
        await expect(label).toHaveValue("New edit while reloading");
    } finally {
        gate.resolve();
    }
});

test("filtered dataset row edits retain their original draft positions", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `filtered-rows-${randomUUID()}`);
    const base = `/api/v1/workspaces/${workspaceId}/resources`;
    const rows = Array.from({ length: 12 }, (_, index) => ({
        key: `row_${index + 1}`,
        values: { label: `Original ${index + 1}` },
    }));
    const created = await page.request.post(base, {
        headers,
        data: {
            kind: "DATASET",
            name: "Filterable dataset",
            key: "filterable_dataset",
            content: {
                kind: "DATASET",
                document: {
                    schemaVersion: "2.0",
                    shape: "TABLE",
                    fields: { label: { type: "string", required: true, nullable: false } },
                    source: { kind: "STATIC", rows },
                },
            },
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = (await created.json()).data;
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    await page.getByRole("link", { name: "Details for Filterable dataset (filterable_dataset)" }).click();
    const editor = page.getByRole("main");
    const search = editor.getByRole("searchbox", { name: "Search row keys", exact: true });
    await editor
        .getByRole("navigation", { name: "Dataset row pagination", exact: true })
        .getByRole("button", { name: "Next", exact: true })
        .click();
    await expect(search).toBeVisible();
    await search.fill("row_12");
    const label = editor.getByRole("textbox", { name: "label", exact: true });
    await expect(label).toHaveValue("Original 12");
    await label.fill("Filtered edit");
    await search.fill("row_11");
    await expect(label).toHaveValue("Original 11");
    await editor.getByRole("button", { name: "Remove row", exact: true }).click();
    await expect(editor.getByText("No matching rows.", { exact: true })).toBeVisible();
    const saved = page.waitForResponse(
        (response) => response.url().endsWith(`${base}/${id}/draft`) && response.request().method() === "PUT",
    );
    await editor.getByRole("button", { name: "Save draft", exact: true }).click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(200);
    const { content } = (await response.json()).data;
    expect(content.document.source.rows).toEqual([
        ...rows.slice(0, 10),
        { key: "row_12", values: { label: "Filtered edit" } },
    ]);
});

/**
 * 同一个树形草稿包含两条记录与多列字段，用户可以在抽屉内横向滚动并在同一水平行编辑父节点和字段。
 */
test("static dataset fields and records share aligned, compact rows", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `aligned-dataset-${randomUUID()}`);
    const base = `/api/v1/workspaces/${workspaceId}/resources`;
    const names = ["description", "category", "variant", "details", "notes"];
    const fields = Object.fromEntries(
        names.map((name) => [
            name,
            {
                type: name === "details" ? "object" : "string",
                required: false,
                nullable: false,
            },
        ]),
    );
    const rows = [
        { key: "parent", parentKey: null, order: 0, values: { description: "Parent record" } },
        {
            key: "child",
            parentKey: "parent",
            order: 1,
            values: { description: "Child record", details: { label: "Old" } },
        },
    ];
    const created = await page.request.post(base, {
        headers,
        data: {
            kind: "DATASET",
            name: "Aligned dataset",
            key: "aligned_dataset",
            content: {
                kind: "DATASET",
                document: { schemaVersion: "2.0", shape: "TREE", fields, source: { kind: "STATIC", rows } },
            },
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = (await created.json()).data;
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    await page.getByRole("link", { name: "Details for Aligned dataset (aligned_dataset)" }).click();
    const editor = page.getByRole("main");
    const fieldsTable = editor.getByRole("table", { name: "Dataset fields", exact: true });
    const records = editor.getByRole("table", { name: "Dataset rows", exact: true });
    await expect(fieldsTable.getByRole("row")).toHaveCount(6);
    const fieldNames = await fieldsTable
        .getByRole("textbox", { name: "Field name", exact: true })
        .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
    expect(fieldNames.toSorted()).toEqual(names.toSorted());
    await expect(records.getByRole("columnheader")).toHaveText([
        "Row key",
        "Parent node",
        "Sibling order",
        ...fieldNames,
        "Actions",
    ]);
    await expect(records.getByRole("row")).toHaveCount(3);
    const parent = records.getByRole("row").nth(1);
    const child = records.getByRole("row").nth(2);
    const [fieldBox, rowBox, keyBox, descriptionBox] = await Promise.all([
        fieldsTable.getByRole("row").nth(1).boundingBox(),
        child.boundingBox(),
        child.getByRole("textbox", { name: "Row key", exact: true }).boundingBox(),
        child.getByRole("textbox", { name: "description", exact: true }).boundingBox(),
    ]);
    if (!fieldBox || !rowBox || !keyBox || !descriptionBox) throw new Error("Expected rendered table rows");
    expect(fieldBox.height).toBeLessThan(60);
    expect(rowBox.height).toBeLessThan(60);
    expect(Math.abs(keyBox.y - descriptionBox.y)).toBeLessThan(5);
    const gutter = records.locator("..");
    expect(await gutter.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);

    await parent.getByRole("textbox", { name: "Row key", exact: true }).fill("renamed_parent");
    await parent.getByRole("textbox", { name: "Row key", exact: true }).press("Tab");
    await expect(child.getByRole("combobox", { name: "Parent node", exact: true })).toHaveValue("renamed_parent");
    await child.getByRole("textbox", { name: "description", exact: true }).fill("Edited child");
    await child.getByText("JSON value", { exact: true }).click();
    await child.getByRole("textbox", { name: "details.label", exact: true }).fill("New");
    const updating = page.waitForResponse(
        (response) => response.url().endsWith(`${base}/${id}/draft`) && response.request().method() === "PUT",
    );
    await editor.getByRole("button", { name: "Save draft", exact: true }).click();
    const saved = await updating;
    expect(saved.status(), await saved.text()).toBe(200);
    expect((await saved.json()).data.content.document.source.rows).toEqual([
        { ...rows[0], key: "renamed_parent" },
        { ...rows[1], parentKey: "renamed_parent", values: { description: "Edited child", details: { label: "New" } } },
    ]);
});

/**
 * 表单和 JSON 与版本及设置同属一级标签，验证键盘激活、未应用的 JSON 和未保存的图形编辑可以共存。
 */
test("dataset detail tabs keep both editor modes on the primary tab list", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `dataset-tabs-${randomUUID()}`);
    const created = await page.request.post(`/api/v1/workspaces/${workspaceId}/resources`, {
        headers,
        data: {
            kind: "DATASET",
            name: "Tab state dataset",
            key: "tab_state_dataset",
            content: {
                kind: "DATASET",
                document: {
                    schemaVersion: "2.0",
                    shape: "TABLE",
                    fields: { label: { type: "string", required: true, nullable: false } },
                    source: { kind: "STATIC", rows: [{ key: "before", values: { label: "Original" } }] },
                },
            },
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspaceId);
    await page.getByRole("link", { name: "Details for Tab state dataset (tab_state_dataset)" }).click();
    const editor = page.getByRole("main");
    const sections = editor.getByRole("tablist", { name: "Dataset editor", exact: true });
    const visual = sections.getByRole("tab", { name: "Data (Form)", exact: true });
    const json = sections.getByRole("tab", { name: "Data (JSON)", exact: true });
    const importing = sections.getByRole("tab", { name: "Import", exact: true });
    const versions = sections.getByRole("tab", { name: "Versions", exact: true });
    const settings = sections.getByRole("tab", { name: "Settings & references", exact: true });
    await expect(sections.getByRole("tab")).toHaveText([
        "Data (Form)",
        "Data (JSON)",
        "Import",
        "Versions",
        "Settings & references",
    ]);
    await expect(editor.getByRole("tablist")).toHaveCount(1);
    await expect(visual).toHaveAttribute("aria-selected", "true");
    await expect(visual.locator("svg use")).toHaveAttribute("href", /#table$/);
    await expect(json.locator("svg use")).toHaveAttribute("href", /#code$/);
    await expect(importing.locator("svg use")).toHaveAttribute("href", /#upload$/);
    const value = editor.getByRole("textbox", { name: "label", exact: true });
    await value.fill("Unsaved draft value");
    await expect(editor.getByRole("textbox", { name: "Import text", exact: true })).toHaveCount(0);
    await visual.press("ArrowRight");
    await expect(json).toBeFocused();
    await json.press("ArrowRight");
    await expect(importing).toBeFocused();
    await expect(visual).toHaveAttribute("aria-selected", "true");
    await importing.press("Enter");
    const importPanel = editor.getByRole("tabpanel", { name: "Import", exact: true });
    await importPanel.getByRole("radio", { name: "Text", exact: true }).check();
    const importText = importPanel.getByRole("textbox", { name: "Import text", exact: true });
    const previewImport = importPanel.getByRole("button", { name: "Preview import", exact: true });
    const applyImport = importPanel.getByRole("button", { name: "Apply import", exact: true });
    await importText.fill("key,label\nbefore,Staged import");
    await previewImport.click();
    await expect(applyImport).toBeEnabled();
    await importing.press("ArrowRight");
    await expect(versions).toBeFocused();
    await versions.press("Enter");
    await expect(editor.getByRole("tabpanel", { name: "Versions", exact: true })).toBeVisible();
    await expect(editor.getByRole("heading", { name: "Immutable versions and diff", exact: true })).toBeVisible();
    await settings.click();
    await expect(editor.getByRole("tabpanel", { name: "Settings & references", exact: true })).toBeVisible();
    await expect(editor.getByRole("heading", { name: "Resource settings", exact: true })).toBeVisible();
    await expect(editor.getByRole("heading", { name: "Reference impact", exact: true })).toBeVisible();
    await expect(editor.getByRole("button", { name: "Save draft", exact: true })).toHaveCount(0);
    await visual.click();
    await expect(value).toHaveValue("Unsaved draft value");
    expect(await editor.evaluate((el) => el.scrollWidth)).toBe(await editor.evaluate((el) => el.clientWidth));
    const fieldsHeading = editor.getByRole("heading", { name: "Dataset fields", exact: true });
    await expect(fieldsHeading).toHaveCSS("font-size", "16px");
    const tabBox = await sections.boundingBox();
    const fieldsBox = await fieldsHeading.boundingBox();
    if (!tabBox || !fieldsBox) throw new Error("Expected visible editor tabs and fields heading");
    expect(fieldsBox.y).toBeGreaterThanOrEqual(tabBox.y + tabBox.height);
    expect(Math.abs(tabBox.x - fieldsBox.x)).toBeLessThan(2);
    await visual.press("ArrowRight");
    await expect(json).toBeFocused();
    await json.press("Enter");
    const jsonPanel = editor.getByRole("tabpanel", { name: "Data (JSON)", exact: true });
    await expect(jsonPanel.getByRole("textbox", { name: "JSON source", exact: true })).toBeVisible();
    const jsonEditorBox = await jsonPanel.locator(".vq-monaco").boundingBox();
    if (!jsonEditorBox) throw new Error("Expected JSON editor");
    expect(jsonEditorBox.y).toBeGreaterThanOrEqual(tabBox.y + tabBox.height);
    expect(Math.abs(tabBox.x - jsonEditorBox.x)).toBeLessThan(2);
    await expect(jsonPanel.getByText(/Use Ctrl\+M/u)).not.toBeVisible();
    await expect(jsonPanel.getByRole("button", { name: "Toggle Tab key navigation" })).toHaveCount(0);
    const source = jsonPanel.getByRole("group", { name: "JSON source", exact: true });
    const sourceActions = ["Discard JSON changes", "Apply JSON", "Compile and validate"];
    await expect(source.getByRole("button")).toHaveCount(3);
    await expect(jsonPanel.getByRole("button")).toHaveCount(5);
    const [discard, apply, compile] = sourceActions.map((name) => source.getByRole("button", { name, exact: true }));
    const save = jsonPanel.getByRole("button", { name: "Save draft", exact: true });
    const publish = jsonPanel.getByRole("button", { name: "Publish version", exact: true });
    await expect(source.getByRole("button")).toHaveText(["", "", ""]);
    await expect(discard.locator("svg[aria-hidden=true] use")).toHaveAttribute("href", /#undo$/u);
    await expect(apply.locator("svg[aria-hidden=true] use")).toHaveAttribute("href", /#log-in$/u);
    await expect(compile.locator("svg[aria-hidden=true] use")).toHaveAttribute("href", /#code-check$/u);
    const frame = source.locator(".vq-monaco-frame");
    await expect(frame).toHaveCSS("border-bottom-style", "solid");
    const frameBox = await frame.boundingBox();
    const boxes = await Promise.all([discard, apply, compile, save, publish].map((action) => action.boundingBox()));
    const [undoBox, applyBox, compileBox, saveBox, publishBox] = boxes;
    if (!frameBox || !undoBox || !applyBox || !compileBox || !saveBox || !publishBox) {
        throw new Error("Expected the editor and draft actions to be visible");
    }
    expect(undoBox.x).toBeLessThan(applyBox.x);
    expect(applyBox.x).toBeLessThan(compileBox.x);
    expect(compileBox.y).toBeCloseTo(undoBox.y, 0);
    expect(undoBox.y).toBeGreaterThanOrEqual(jsonEditorBox.y + jsonEditorBox.height);
    const rightInset = frameBox.x + frameBox.width - compileBox.x - compileBox.width;
    expect(rightInset).toBeGreaterThan(0);
    expect(rightInset).toBeLessThan(16);
    const frameBottom = frameBox.y + frameBox.height;
    for (const box of [undoBox, applyBox, compileBox]) expect(box.y + box.height).toBeLessThan(frameBottom);
    expect(saveBox.y).toBeGreaterThanOrEqual(frameBottom);
    expect(publishBox.y).toBeGreaterThanOrEqual(frameBottom);
    expect(publishBox.x).toBeGreaterThan(saveBox.x);
    await expect(save).toHaveClass(/\bvq-btn-secondary\b/u);
    await expect(publish).toHaveClass(/\bvq-btn-primary\b/u);

    // 从源码使用 Monaco 键盘出口后仍可正常按 Tab 浏览页面，重新进入源码时恢复缩进。
    await editor.locator(".vq-monaco .view-lines").click();
    await page.keyboard.press(process.platform === "darwin" ? "Control+Shift+m" : "Control+m");
    await page.keyboard.press("Tab");
    await expect(discard).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveText("Discard JSON changes");
    await page.keyboard.press("Tab");
    await expect(apply).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(compile).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(save).toBeFocused();
    await editor.locator(".vq-monaco .view-lines").click();
    await page.keyboard.press("Tab");
    await expect(editor.getByText(/Unapplied JSON changes/)).toBeVisible();
    await versions.click();
    await json.click();
    await expect(json).toHaveAttribute("aria-selected", "true");
    await expect(editor.getByText(/Unapplied JSON changes/)).toBeVisible();
    await importing.click();
    await expect(importText).toHaveValue("key,label\nbefore,Staged import");
    await expect(applyImport).toBeEnabled();
    await expect(importPanel.getByRole("button", { name: "Apply JSON", exact: true })).toHaveCount(0);
    await visual.click();
    await expect(value).toHaveValue("Unsaved draft value");
    await editor.getByRole("button", { name: "Save draft", exact: true }).click();
    const failure = page.getByRole("dialog", { name: "Operation failed", exact: true });
    await expect(failure).toContainText(/Unapplied JSON changes/);
    await failure.getByRole("button", { name: "OK", exact: true }).click();
    await expect(value).toHaveValue("Unsaved draft value");
    await value.fill("New draft value");
    await importing.click();
    await expect(importText).toHaveValue("key,label\nbefore,Staged import");
    await expect(applyImport).toBeDisabled();

    // 编译仍须拒绝待应用的源码；放弃只恢复图形草稿，随后应用的新 JSON 才替换图形数据。
    await json.click();
    await compile.click();
    await acknowledgeOperation(page, /Unapplied JSON changes/u, "failed");
    await expect(compile).toBeFocused();
    await discard.click();
    await acknowledgeOperation(page, "JSON changes discarded.");
    await expect(source.locator(".view-lines")).toContainText("New draft value");
    await replaceEditorJson(
        page,
        JSON.stringify({
            kind: "DATASET",
            document: {
                schemaVersion: "2.0",
                shape: "TABLE",
                fields: { label: { type: "string", required: true, nullable: false } },
                source: { kind: "STATIC", rows: [{ key: "before", values: { label: "Applied source value" } }] },
            },
        }),
    );
    await apply.click();
    await acknowledgeOperation(page, "JSON applied to the draft editor.");
    await visual.click();
    await expect(value).toHaveValue("Applied source value");
});

test("provider save and Agent model settings show completed write results", async ({ page }) => {
    await installed(page);
    const { workspaceId } = await editorScope(page, `feedback-provider-${randomUUID()}`);
    await page.goto("/workspaces?tab=ai-providers");
    await chooseWorkspace(page, workspaceId);
    const panel = page.getByRole("tabpanel", { name: "AI providers", exact: true });
    await panel.getByRole("textbox", { name: "Name", exact: true }).fill("Feedback provider");
    await panel.getByRole("textbox", { name: "Model", exact: true }).fill("test-model");
    await panel.getByLabel("Write-only API key", { exact: true }).fill("feedback-key-only-for-database-test");
    await panel.getByLabel("Enabled", { exact: true }).check();
    const providerSaved = page.waitForResponse(
        (response) => response.url().endsWith("/ai/providers") && response.request().method() === "POST",
    );
    await panel.getByRole("button", { name: "Save provider", exact: true }).click();
    const provider = await providerSaved;
    expect(provider.status(), await provider.text()).toBe(201);
    const success = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
    await expect(success.getByText("Provider saved", { exact: true })).toBeVisible();
    await success.getByRole("button", { name: "OK", exact: true }).click();
    await expect(panel.getByRole("cell", { name: "Feedback provider", exact: true })).toBeVisible();
    const filter = panel.getByRole("button", { name: "Filter", exact: true });
    const adapter = page.getByRole("menuitem", { name: "Adapter", exact: true });
    const status = page.getByRole("menuitem", { name: "Status", exact: true });
    const all = page.getByRole("menuitemradio", { name: "All", exact: true });
    const disabled = page.getByRole("menuitemradio", { name: "Disabled", exact: true });
    const enabled = page.getByRole("menuitemradio", { name: "Enabled", exact: true });
    await filter.press("Enter");
    await adapter.press("ArrowRight");
    await expect(all).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await status.press("ArrowRight");
    await expect(all).toHaveAttribute("aria-checked", "true");
    await disabled.press("Enter");
    await expect(disabled).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(status).toHaveAccessibleDescription("Disabled");
    await page.keyboard.press("Escape");
    await expect(filter).toBeFocused();
    await expect(panel.getByText("No matching providers.", { exact: true })).toBeVisible();
    await filter.press("Enter");
    await status.press("ArrowRight");
    await enabled.press("Enter");
    await expect(enabled).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(panel.getByRole("cell", { name: "Feedback provider", exact: true })).toBeVisible();

    await page.getByRole("banner").getByRole("button", { name: "Test Agent", exact: true }).click();
    await page.getByRole("button", { name: "Model settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Model settings", exact: true });
    const { id } = (await provider.json()).data;
    await settings.getByRole("combobox", { name: "Workspace default provider", exact: true }).click();
    await page.getByRole("option", { name: "Feedback provider · test-model", exact: true }).click();
    const settingsSaved = page.waitForResponse(
        (response) => response.url().endsWith("/agent/settings") && response.request().method() === "PUT",
    );
    await settings.getByRole("button", { name: "Save model settings", exact: true }).click();
    const savedSettings = await settingsSaved;
    expect(savedSettings.status()).toBe(200);
    expect(savedSettings.request().postDataJSON()).toEqual({ defaultProviderId: id, agentProviderId: null });
    await expect(success.getByText("Model settings saved", { exact: true })).toBeVisible();
    await success.getByRole("button", { name: "OK", exact: true }).click();
    await expect(settings).toHaveCount(0);
});

/**
 * 在网格布局的模型目录内检查宽记录的滚动边界，浏览器仍须能定位最后一列编辑入口并打开对应表单。
 */
test("wide provider values scroll inside their grid section", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `provider-scroll-${randomUUID()}`);
    const name = `Wide provider ${"WWWW ".repeat(28).trimEnd()}`;
    const created = await page.request.post(`/api/v1/workspaces/${workspaceId}/ai/providers`, {
        headers,
        data: {
            name,
            adapter: "OPENAI_COMPATIBLE",
            baseURL: "https://api.openai.com/v1",
            model: "provider-scroll-test",
            apiKey: "scroll-layout-test-fixture",
            enabled: false,
            monthlyBudgetUsd: 1,
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 2,
            maxOutputTokens: 1024,
            maxRequestUsd: 0.5,
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    await page.goto("/workspaces?tab=ai-providers");
    await chooseWorkspace(page, workspaceId);
    const panel = page.getByRole("tabpanel", { name: "AI providers", exact: true });
    const table = panel.getByRole("table");
    const scrollArea = table.locator("..");
    await expect(table.getByRole("columnheader", { name: "Base URL", exact: true })).toHaveCSS("white-space", "nowrap");
    await expect(table.getByRole("cell", { name, exact: true })).toHaveCSS("white-space", "nowrap");
    expect(await scrollArea.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
    const main = page.getByRole("main");
    expect(await main.evaluate((node) => node.scrollWidth)).toBe(await main.evaluate((node) => node.clientWidth));
    const edit = table.getByRole("button", { name: `Edit · ${name}`, exact: true });
    await edit.scrollIntoViewIfNeeded();
    await expect(edit).toBeInViewport();
    expect(await scrollArea.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    await edit.click();
    await expect(panel.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
});
