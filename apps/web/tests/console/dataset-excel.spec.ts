import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { acknowledgeOperation, editorScope, saveDraft, selectResourceOption } from "../editor-fixture";
import { installed } from "../support/install-console";

const spreadsheet = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const packageRels = "http://schemas.openxmlformats.org/package/2006/relationships";
const documentRels = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const contentTypes = "http://schemas.openxmlformats.org/package/2006/content-types";

/**
 * 构造真实的工作簿容器，同时保留单元格原生类型和行号，浏览器测试会从文件选择器读取完整档案。
 */
function workbook(rowNumber: number, departmentCell: string, padding?: { bytes: number; compressed?: boolean }) {
    const rows =
        "<row r='1'>" +
        `<c r='A1' t='inlineStr'><is><t>key</t></is></c>` +
        `<c r='B1' t='inlineStr'><is><t>employee</t></is></c>` +
        `<c r='C1' t='inlineStr'><is><t>active</t></is></c>` +
        `<c r='D1' t='inlineStr'><is><t>department</t></is></c>` +
        "</row>" +
        `<row r='${rowNumber}'>` +
        `<c r='A${rowNumber}' t='inlineStr'><is><t>reader</t></is></c>` +
        `<c r='B${rowNumber}' t='inlineStr'><is><t>001\n  测试  </t></is></c>` +
        `<c r='C${rowNumber}' t='b'><v>1</v></c>` +
        `<c r='D${rowNumber}' t='n'><v>${departmentCell}</v></c>` +
        "</row>";
    const types =
        `<Types xmlns='${contentTypes}'>` +
        `<Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/>` +
        `<Default Extension='xml' ContentType='application/xml'/>` +
        `<Default Extension='bin' ContentType='application/octet-stream'/>` +
        `<Override PartName='/xl/workbook.xml' ` +
        `ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'/>` +
        `<Override PartName='/xl/worksheets/sheet1.xml' ` +
        `ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'/>` +
        `</Types>`;
    return {
        name: "employees.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(
            zipSync({
                "[Content_Types].xml": strToU8(types),
                "_rels/.rels": strToU8(
                    `<Relationships xmlns='${packageRels}'>` +
                        `<Relationship Id='rId1' Type='${documentRels}/officeDocument' Target='xl/workbook.xml'/>` +
                        `</Relationships>`,
                ),
                "xl/workbook.xml": strToU8(
                    `<workbook xmlns='${spreadsheet}' xmlns:r='${documentRels}'>` +
                        `<sheets><sheet name='Employees' sheetId='1' r:id='rId1'/></sheets></workbook>`,
                ),
                "xl/_rels/workbook.xml.rels": strToU8(
                    `<Relationships xmlns='${packageRels}'>` +
                        `<Relationship Id='rId1' Type='${documentRels}/worksheet' Target='worksheets/sheet1.xml'/>` +
                        `</Relationships>`,
                ),
                "xl/worksheets/sheet1.xml": strToU8(
                    `<worksheet xmlns='${spreadsheet}'><sheetData>${rows}</sheetData></worksheet>`,
                ),
                ...(padding
                    ? { "xl/media/padding.bin": [new Uint8Array(padding.bytes), { level: padding.compressed ? 6 : 0 }] }
                    : {}),
            }),
        ),
    };
}

/**
 * 用户只能应用预检通过的工作簿，稀疏坐标超出预算时仍保留原草稿，之后正确文件可以按原类型导入并保存。
 */
test("previews and saves a typed Excel worksheet, rejecting a sparse workbook first", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(
        page,
        `dataset-excel-${randomUUID()}`,
        "/resources/element-catalogs",
    );
    const fields = {
        employee: { type: "string", required: true, nullable: false },
        active: { type: "boolean", required: true, nullable: false },
        department: { type: "integer", required: true, nullable: false },
    };
    const doc = {
        schemaVersion: "2.0",
        shape: "TABLE",
        fields,
        source: {
            kind: "STATIC",
            rows: [{ key: "original", values: { employee: "Original", active: false, department: 1 } }],
        },
    };
    const created = await page.request.post(`/api/v1/workspaces/${workspaceId}/resources`, {
        headers,
        data: {
            key: "employee_xlsx",
            name: "Excel employees",
            kind: "DATASET",
            content: { kind: "DATASET", document: doc },
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Datasets" }).click();
    await page.getByRole("link", { name: "Details for Excel employees (employee_xlsx)" }).click();
    const editor = page.getByRole("article");
    await expect(editor.getByRole("heading", { name: "Dataset fields", exact: true })).toBeVisible();
    await expect(editor.getByRole("radiogroup", { name: "Import format" })).toHaveCount(0);
    await editor.getByRole("tab", { name: "Import", exact: true }).click();
    const importPanel = editor.getByRole("tabpanel", { name: "Import", exact: true });
    const format = importPanel.getByRole("radiogroup", { name: "Import format" });
    await format.getByRole("radio", { name: "Excel", exact: true }).check();
    await expect(importPanel.getByRole("textbox", { name: "Import text" })).toHaveCount(0);
    const file = importPanel.getByLabel("Import file", { exact: true });
    const preview = importPanel.getByRole("button", { name: "Preview import" });
    const apply = importPanel.getByRole("button", { name: "Apply import" });
    await expect(file).toHaveAttribute("accept", /\.xlsx/u);
    await file.setInputFiles({ name: "legacy.xls", mimeType: "application/vnd.ms-excel", buffer: Buffer.from("xls") });
    await expect(importPanel.getByRole("alert")).toContainText("save it as .xlsx or export it as CSV");
    await expect(preview).toBeDisabled();
    await file.setInputFiles(workbook(1_048_576, "8"));
    await preview.click();
    await expect(editor.getByText(/EXCEL_RANGE_LIMIT/u)).toBeVisible();
    await expect(apply).toBeDisabled();
    await file.setInputFiles({ ...workbook(2, "8"), buffer: Buffer.from("not a workbook") });
    await preview.click();
    await expect(editor.getByText(/INVALID_EXCEL/u)).toBeVisible();
    await expect(apply).toBeDisabled();
    const expandedWorkbook = workbook(2, "8", { bytes: 16 * 1024 * 1024, compressed: true });
    expect(expandedWorkbook.buffer.length).toBeLessThan(10 * 1024 * 1024);
    await file.setInputFiles(expandedWorkbook);
    await preview.click();
    await expect(editor.getByText(/DATASET_SIZE_LIMIT/u)).toBeVisible();
    await expect(apply).toBeDisabled();
    const paddedWorkbook = workbook(2, "8", { bytes: 3 * 1024 * 1024 });
    expect(paddedWorkbook.buffer.length).toBeGreaterThan(2 * 1024 * 1024);
    await file.setInputFiles(paddedWorkbook);
    await expect(preview).toBeEnabled();
    await expect(importPanel.getByRole("button", { name: "Choose import file" })).toHaveAccessibleDescription(
        ".xlsx file · up to 10 MiB",
    );
    await preview.click();
    await expect(editor.getByText(/Rows ready to apply.*1/u)).toBeVisible();
    const mappings = editor.getByRole("table", { name: "Imported column mapping" });
    await expect(mappings.getByRole("row", { name: /department department integer/u })).toBeVisible();
    const mappingSearch = editor.getByRole("searchbox", { name: "Search column mappings" });
    await expect(mappingSearch).toBeVisible();
    await mappingSearch.fill("absent");
    await expect(mappings.getByRole("columnheader")).toHaveCount(3);
    await expect(mappings.getByText("No matching column mappings.")).toBeVisible();
    await editor.getByRole("tab", { name: "Data (Form)", exact: true }).click();
    await expect(editor.getByRole("textbox", { name: "employee", exact: true })).toHaveValue("Original");
    await editor.getByRole("tab", { name: "Import", exact: true }).click();
    await expect(importPanel.getByText(/Rows ready to apply.*1/u)).toBeVisible();
    await apply.click();
    await acknowledgeOperation(page, "Import applied to the draft. Save the draft to keep the changes.");
    await expect(importPanel).toBeVisible();
    await expect(importPanel.getByRole("button", { name: "Save draft", exact: true })).toBeFocused();
    expect((await saveDraft(page)).content).toEqual({
        kind: "DATASET",
        document: {
            ...doc,
            source: {
                kind: "STATIC",
                rows: [{ key: "reader", values: { employee: "001\n  测试  ", active: true, department: 8 } }],
            },
        },
    });
});

/**
 * 将表格中可见的第二页行编辑后再筛选，保存时必须修改完整文档中的原记录，前一页不得被替换。
 */
test("keeps dataset row identity across page size and search changes", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(
        page,
        `dataset-paging-${randomUUID()}`,
        "/resources/element-catalogs",
    );
    const rows = Array.from({ length: 7 }, (_, index) => ({
        key: `employee_${index + 1}`,
        values: { name: `Employee ${index + 1}` },
    }));
    const created = await page.request.post(`/api/v1/workspaces/${workspaceId}/resources`, {
        headers,
        data: {
            key: "employee_pages",
            name: "Paged employees",
            kind: "DATASET",
            content: {
                kind: "DATASET",
                document: {
                    schemaVersion: "2.0",
                    shape: "TABLE",
                    fields: { name: { type: "string", required: true, nullable: false } },
                    source: { kind: "STATIC", rows },
                },
            },
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Datasets" }).click();
    await page.getByRole("link", { name: "Details for Paged employees (employee_pages)" }).click();
    const editor = page.getByRole("article");
    const table = editor.getByRole("table", { name: "Dataset rows" });
    const size = editor.getByRole("combobox", { name: "Dataset rows per page" });
    await expect(size).toBeVisible();
    await selectResourceOption(size, "5");
    await expect(table.getByRole("row")).toHaveCount(6);
    const pagination = editor.getByRole("navigation", { name: "Dataset row pagination" });
    await pagination.getByRole("button", { name: "Next", exact: true }).click();
    await expect(table.getByRole("row")).toHaveCount(3);
    const rowKey = table.getByRole("textbox", { name: "Row key" }).first();
    await expect(rowKey).toHaveValue("employee_6");
    await rowKey.fill("updated_employee");
    const search = editor.getByRole("searchbox", { name: "Search row keys" });
    await search.fill("updated");
    await expect(table.getByRole("row")).toHaveCount(2);
    await expect(rowKey).toHaveValue("updated_employee");
    const saved = await saveDraft(page);
    expect(saved.content).toMatchObject({
        document: {
            source: {
                rows: rows.map((row, index) => (index === 5 ? { ...row, key: "updated_employee" } : row)),
            },
        },
    });
});

/**
 * 在实际详情页测量分区、页签和下拉选项，并拖入表格文件走完预检、应用及草稿保存的原有路径。
 */
test("keeps dataset import controls aligned and accepts file drops", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `dataset-drop-${randomUUID()}`);
    const fields = { title: { type: "string", required: false, nullable: false } };
    const created = await page.request.post(`/api/v1/workspaces/${workspaceId}/resources`, {
        headers,
        data: {
            key: "drop_tree",
            name: "Drop tree",
            kind: "DATASET",
            content: {
                kind: "DATASET",
                document: { schemaVersion: "2.0", shape: "TREE", fields, source: { kind: "STATIC", rows: [] } },
            },
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = (await created.json()).data;
    await page.goto(`/resources/datasets/${id}?workspaceId=${workspaceId}`);
    const editor = page.getByRole("article");
    const tabs = editor.getByRole("tablist", { name: "Dataset editor" });
    const formTab = tabs.getByRole("tab", { name: "Data (Form)", exact: true });
    const importTab = tabs.getByRole("tab", { name: "Import", exact: true });
    await expect(formTab).toHaveAttribute("aria-selected", "true");
    const heading = editor.getByRole("heading", { name: "Dataset fields" });
    const headingFontSize = await heading.evaluate((node) => getComputedStyle(node).fontSize);
    const headingX = (await heading.boundingBox())?.x;
    for (const [table, button] of [
        ["Dataset fields", "Add field"],
        ["Dataset rows", "Add row"],
    ]) {
        const wrapper = editor.getByRole("table", { name: table, exact: true }).locator("../..");
        const tableBox = await wrapper.boundingBox();
        const actionBox = await editor.getByRole("button", { name: button, exact: true }).boundingBox();
        if (!tableBox || !actionBox) throw new Error("Expected a visible table and action");
        expect(actionBox.y - (tableBox.y + tableBox.height)).toBeGreaterThanOrEqual(8);
    }

    const rowButton = editor.getByRole("button", { name: "Add row", exact: true });
    const rowBox = await rowButton.boundingBox();
    if (!rowBox) throw new Error("Expected the dataset row action");
    const draftActions = ["Save draft", "Compile and validate", "Publish version"];
    for (const name of draftActions) {
        const box = await editor.getByRole("button", { name, exact: true }).boundingBox();
        if (!box) throw new Error(`Missing the ${name} draft action`);
        expect(box.height).toBe(rowBox.height);
    }
    await tabs.getByRole("tab", { name: "Settings & references", exact: true }).click();
    for (const name of ["Rename", "Archive"]) {
        const box = await editor.getByRole("button", { name, exact: true }).boundingBox();
        if (!box) throw new Error(`Missing the ${name} resource action`);
        expect(box.height).toBe(rowBox.height);
    }
    await importTab.click();
    const section = editor.getByRole("tabpanel", { name: "Import", exact: true });
    const importHeading = section.getByRole("heading", { name: "Import rows", exact: true });
    const format = section.getByRole("radiogroup", { name: "Import format" });
    const csv = format.getByRole("radio", { name: "CSV", exact: true });
    const json = format.getByRole("radio", { name: "JSON", exact: true });
    const excel = format.getByRole("radio", { name: "Excel", exact: true });
    const text = format.getByRole("radio", { name: "Text", exact: true });
    await expect(importHeading).toHaveCSS("font-size", headingFontSize);
    await expect(importHeading.locator("..")).toHaveCSS("border-top-width", "0px");
    expect((await importHeading.boundingBox())?.x).toBe(headingX);
    await expect(section.getByText(/header.*inferred.*parentKey.*values\./i)).toBeVisible();
    await expect(format.getByRole("radio")).toHaveCount(4);
    await expect(csv).toBeChecked();
    await csv.press("ArrowRight");
    await expect(json).toBeFocused();
    await expect(json).toBeChecked();
    await json.press("ArrowRight");
    await expect(excel).toBeChecked();
    await excel.press("ArrowRight");
    await expect(text).toBeChecked();
    const paste = section.getByRole("textbox", { name: "Import text" });
    const guidanceText = "Paste CSV with headers or a JSON array of row objects. Up to 10 MiB.";
    const guidance = section.getByText(guidanceText, { exact: true });
    await expect(paste).toHaveAccessibleDescription(guidanceText);
    await expect(guidance).toHaveCSS("font-size", "10px");
    const [pasteBox, guidanceBox] = await Promise.all([paste.boundingBox(), guidance.boundingBox()]);
    if (!pasteBox || !guidanceBox) throw new Error("Expected the text area and visible import guidance");
    expect(guidanceBox.y + guidanceBox.height).toBeLessThanOrEqual(pasteBox.y);
    expect(pasteBox.height).toBeGreaterThanOrEqual(132);
    await expect(section.getByRole("button", { name: "Choose import file" })).toHaveCount(0);
    await paste.fill("key,parentKey\nmetadata_only,\n");
    await section.getByRole("button", { name: "Preview import" }).click();
    await expect(section.getByText(/Rows ready to apply.*1/u)).toBeVisible();
    await expect(section.getByText("Row key uses column key.", { exact: true })).toBeVisible();
    await expect(section.getByRole("table", { name: "Imported column mapping" })).toHaveCount(0);
    await text.press("ArrowRight");
    await expect(csv).toBeChecked();
    await expect(section.getByRole("textbox", { name: "Import text" })).toHaveCount(0);
    const radioBoxes = await Promise.all([csv, json, excel, text].map((option) => option.boundingBox()));
    const csvPosition = radioBoxes[0];
    if (!csvPosition) throw new Error("Expected the CSV radio control");
    for (const bounds of radioBoxes) {
        if (!bounds) throw new Error("Expected visible import format radios");
        expect(bounds.y).toBeCloseTo(csvPosition.y, 0);
        expect(bounds.width).toBe(bounds.height);
    }

    const drop = section.getByRole("button", { name: "Choose import file" });
    await expect(drop).toHaveCSS("border-top-style", "dashed");
    for (const option of [json, excel, csv]) {
        await option.check();
        const [dropBox, iconBox, hintBox] = await Promise.all([
            drop.boundingBox(),
            drop.locator(".vq-dataset-upload-icon").boundingBox(),
            drop.locator(".vq-dataset-upload-hint").boundingBox(),
        ]);
        if (!dropBox || !iconBox || !hintBox) throw new Error("Expected the upload area and its visible contents");
        expect(dropBox.height).toBeCloseTo(pasteBox.height, 0);
        const contentsCenter = (iconBox.y + hintBox.y + hintBox.height) / 2;
        expect(contentsCenter).toBeCloseTo(dropBox.y + dropBox.height / 2, 0);
    }
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), drop.press("Enter")]);
    const content = "key,parentKey,order,title\nroot,,0,Dropped tree";
    await chooser.setFiles({ name: "chosen.csv", mimeType: "text/csv", buffer: Buffer.from(content) });
    await expect(section.getByText("chosen.csv", { exact: true })).toBeVisible();
    await csv.focus();

    const dataTransfer = await page.evaluateHandle((value) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([value], "dropped.csv", { type: "text/csv" }));
        return transfer;
    }, content);
    const initialBackground = await drop.evaluate((node) => getComputedStyle(node).backgroundColor);
    await drop.dispatchEvent("dragover", { dataTransfer });
    await expect(drop).not.toHaveCSS("background-color", initialBackground);
    await drop.dispatchEvent("drop", { dataTransfer });
    await dataTransfer.dispose();
    await expect(section.getByText("dropped.csv", { exact: true })).toBeVisible();
    await expect(section.getByRole("textbox", { name: "Import text" })).toHaveCount(0);
    await section.getByRole("button", { name: "Preview import" }).click();
    await section.getByRole("button", { name: "Apply import" }).click();
    await acknowledgeOperation(page, "Import applied to the draft. Save the draft to keep the changes.");
    const saved = await saveDraft(page);
    expect(saved.content.document).toMatchObject({
        source: { rows: [{ key: "root", parentKey: null, order: 0, values: { title: "Dropped tree" } }] },
    });
});
