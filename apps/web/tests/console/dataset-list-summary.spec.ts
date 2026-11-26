/**
 * 从工作区真实路由核对列表摘要，更新来自实际保存回执，切换语言后继续显示同一套字段和状态。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { closeResourceEditor, editorScope, saveDraft } from "../editor-fixture";
import { chooseLanguage } from "../support/console-controls";
import { installed } from "../support/install-console";

/**
 * 同一列表同时验证静态表、静态树和动态数据，确认编辑器保存回执反映在列表的规模、时间和状态中。
 */
test("shows dataset format, saved size, time and pending publication", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installed(page);
    const { workspaceId, headers } = await editorScope(
        page,
        `dataset-summary-${randomUUID()}`,
        "/resources/element-catalogs",
    );
    const fields = { name: { type: "string", required: true, nullable: false } };
    const fixtures = [
        {
            key: "flat",
            name: "Flat dataset",
            shape: "TABLE",
            source: { kind: "STATIC", rows: [{ key: "one", values: { name: "Entry" } }] },
        },
        {
            key: "tree",
            name: "Tree dataset",
            shape: "TREE",
            source: { kind: "STATIC", rows: [{ key: "root", values: { name: "Root" }, parentKey: null, order: 0 }] },
        },
        {
            key: "remote",
            name: "Remote dataset",
            shape: "TABLE",
            source: {
                kind: "HTTP",
                connectionRef: null,
                environmentVersionId: null,
                method: "GET",
                path: "/items",
                query: [],
                headers: {},
                parameters: {},
                body: null,
                auth: { kind: "NONE" },
                mapping: { rows: "/items", key: "/id", values: { name: "/name" } },
            },
        },
    ];
    for (const { key, name, shape, source } of fixtures) {
        // 通过创建 API 写入互相独立的草稿，正常列表加载不得需要预览或外部 HTTP 配置，即可区分这些数据集的来源。
        const response = await page.request.post(`/api/v1/workspaces/${workspaceId}/resources`, {
            headers,
            data: {
                key,
                name,
                kind: "DATASET",
                content: {
                    kind: "DATASET",
                    document: {
                        schemaVersion: "2.0",
                        shape,
                        fields,
                        source,
                    },
                },
            },
        });
        expect(response.status(), await response.text()).toBe(201);
    }
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Datasets" }).click();
    const table = page.getByRole("region", { name: "Resource list" }).getByRole("table");
    await expect(table.getByRole("columnheader")).toHaveText([
        "Name",
        "Key",
        "Format",
        "Size",
        "Status",
        "Last saved",
        "Actions",
    ]);
    const flat = table.getByRole("row", { name: /Flat dataset/ });
    const tree = table.getByRole("row", { name: /Tree dataset/ });
    const remote = table.getByRole("row", { name: /Remote dataset/ });
    await expect(flat.getByRole("cell", { name: "Static table", exact: true })).toBeVisible();
    await expect(flat.getByRole("cell", { name: "1 field · 1 row", exact: true })).toBeVisible();
    await expect(tree.getByRole("cell", { name: "Static tree", exact: true })).toBeVisible();
    await expect(tree.getByRole("cell", { name: "1 field · 1 node", exact: true })).toBeVisible();
    await expect(remote.getByRole("cell", { name: "HTTP table", exact: true })).toBeVisible();
    await expect(remote.getByRole("cell", { name: "1 field · Dynamic", exact: true })).toBeVisible();
    await expect(flat.locator("time")).toHaveAttribute("datetime", /T.+Z$/);
    await expect(flat.getByText("Unpublished changes")).toHaveCount(0);
    const nameSize = await table
        .getByRole("columnheader", { name: "Name" })
        .evaluate((el) => getComputedStyle(el).fontSize);
    await expect(table.getByRole("columnheader", { name: "Format" })).toHaveCSS("font-size", nameSize);
    const cellSize = await flat
        .getByRole("cell", { name: "Flat dataset", exact: true })
        .evaluate((el) => getComputedStyle(el).fontSize);
    await expect(flat.getByRole("cell", { name: "Static table", exact: true })).toHaveCSS("font-size", cellSize);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);

    // 编辑器新行仅在保存成功后进入摘要，时间元素保留服务提供的 UTC 时间供调用方读取和比较。
    await flat.getByRole("link", { name: "Details for Flat dataset (flat)" }).click();
    await page.getByRole("main").getByRole("button", { name: "Add row" }).click();
    const saved = await saveDraft(page);
    await closeResourceEditor(page);
    await expect(flat.getByRole("cell", { name: "1 field · 2 rows", exact: true })).toBeVisible();
    await expect(flat.getByRole("cell", { name: /Draft.*Unpublished changes/ })).toBeVisible();
    await expect(flat.locator("time")).toHaveAttribute("datetime", saved.updatedAt);

    // 导出仍沿用当前页的可见列和顺序，状态提示跟随状态一起导出，不把行操作或草稿正文混入下载。
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const download = await downloading;
    try {
        const csv = await readFile(await download.path(), "utf8");
        expect(csv).toContain('"Name","Key","Format","Size","Status","Last saved"');
        expect(csv).toContain('"Flat dataset","flat","Static table","1 field · 2 rows","Draft · Unpublished changes"');
        expect(csv).not.toContain('"Actions"');
    } finally {
        await download.delete();
    }

    // 在同一视口切换中文，验证列名和计数语义一并切换，时间仍用与草稿读取一致的值和上海时区展示。
    await chooseLanguage(page, "zh");
    const chinese = page.getByRole("region", { name: "资源列表" }).getByRole("table");
    await expect(chinese.getByRole("columnheader")).toHaveText([
        "名称",
        "标识",
        "格式",
        "规模",
        "状态",
        "最近保存",
        "操作",
    ]);
    const savedRow = chinese.getByRole("row", { name: /Flat dataset/ });
    await expect(savedRow.getByRole("cell", { name: "1 个字段 · 2 行", exact: true })).toBeVisible();
    await expect(savedRow.getByRole("cell", { name: /草稿.*有待发布变更/ })).toBeVisible();
    await expect(savedRow.locator("time")).toHaveText(
        new Date(saved.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    );
});
