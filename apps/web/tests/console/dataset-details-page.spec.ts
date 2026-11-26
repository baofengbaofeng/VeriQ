/**
 * 真正的列表链接应进入能独立刷新和打开的详情页，共用管理台导航并继续按 URL 中的工作区校验数据集身份。
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { editorScope, saveDraft } from "../editor-fixture";
import { chooseLanguage, chooseWorkspace } from "../support/console-controls";
import { installed } from "../support/install-console";

const listPath = "/resources/datasets";
const datasetKey = "dataset_page";
const datasetName = "Page details dataset";

/**
 * 通过真实 API 创建数据集和用于测试类型不匹配的夹具，两类资源都留给控制服务正常分配稳定标识。
 */
async function seedResource(
    page: Page,
    scope: Awaited<ReturnType<typeof editorScope>>,
    kind: "DATASET" | "ELEMENT_CATALOG",
) {
    const dataset = {
        schemaVersion: "2.0",
        shape: "TABLE",
        fields: { title: { type: "string", required: true, nullable: false } },
        source: { kind: "STATIC", rows: [{ key: "one", values: { title: "First line\nSecond line" } }] },
    };
    const document =
        kind === "DATASET"
            ? dataset
            : { schemaVersion: "1.0", elements: [{ key: "name", locator: { by: "veriqId", value: "name" } }] };
    const response = await page.request.post(`/api/v1/workspaces/${scope.workspaceId}/resources`, {
        headers: scope.headers,
        data: {
            kind,
            key: kind === "DATASET" ? datasetKey : "other_resource",
            name: kind === "DATASET" ? datasetName : "Other resource",
            content: { kind, document },
        },
    });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()).data.id as string;
}

test("dataset details use a dedicated page with breadcrumbs, refresh and draft editing", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installed(page);
    const scope = await editorScope(page, `dataset-details-page-${randomUUID()}`);
    const id = await seedResource(page, scope, "DATASET");
    const url = `${listPath}/${id}?workspaceId=${scope.workspaceId}`;
    await page.goto(listPath);
    await chooseWorkspace(page, scope.workspaceId);
    const details = page.getByRole("link", { name: `Details for ${datasetName} (${datasetKey})` });
    await expect(details).toHaveAttribute("href", url);
    await details.press("Enter");
    await expect(page).toHaveURL(new RegExp(url.replace("?", "\\?") + "$"));
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: datasetName, exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(main.getByRole("tablist", { name: "Dataset editor" })).toBeVisible();
    const breadcrumb = main.getByRole("navigation", { name: "Breadcrumb", exact: true });
    const back = breadcrumb.getByRole("link", { name: "Datasets", exact: true });
    await expect(back).toHaveAttribute("href", listPath);
    await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText("Dataset details");
    const title = main.getByRole("textbox", { name: "title", exact: true });
    await expect(title).toHaveCSS("resize", "vertical");
    const initialHeight = (await title.boundingBox())?.height;
    expect(initialHeight).toBeGreaterThan(0);
    const updated = "Saved on detail page\nSecond line";
    await title.fill(updated);
    expect((await title.boundingBox())?.height).toBe(initialHeight);
    await saveDraft(page);
    await page.reload();
    await expect(title).toHaveValue(updated);
    await chooseLanguage(page, "zh");
    const localizedBack = main.getByRole("navigation").getByRole("link", { name: "数据集", exact: true });
    await expect(localizedBack).toHaveAttribute("href", listPath);
    await localizedBack.click();
    await expect(page).toHaveURL(new RegExp(listPath + "$"));
    await expect(main.getByRole("heading", { name: "数据集", exact: true, level: 1 })).toBeVisible();
    await expect(main.getByRole("cell", { name: datasetName, exact: true })).toBeVisible();
});

/**
 * 工作区切换回到列表，拼接错误工作区或其它资源的链接时仍不能打开草稿，缺失空间也不回退到当前目录。
 */
test("dataset detail links never read a mismatched resource draft", async ({ page }) => {
    await installed(page);
    const scope = await editorScope(page, `dataset-detail-scope-${randomUUID()}`);
    const datasetId = await seedResource(page, scope, "DATASET");
    const catalogId = await seedResource(page, scope, "ELEMENT_CATALOG");
    const otherKey = `dataset-other-workspace-${randomUUID()}`;
    const created = await page.request.post("/api/v1/workspaces", {
        headers: scope.headers,
        data: { name: otherKey, key: otherKey },
    });
    expect(created.status(), await created.text()).toBe(201);
    const otherId = (await created.json()).data.id;
    await page.goto(`${listPath}/${datasetId}?workspaceId=${scope.workspaceId}`);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: datasetName, exact: true, level: 1 })).toBeVisible();
    await chooseWorkspace(page, otherId);
    await expect(page).toHaveURL(new RegExp(listPath + "$"));
    await expect(main.getByRole("heading", { name: "Dataset", exact: true, level: 1 })).toBeVisible();
    await expect(main.getByRole("cell", { name: datasetName, exact: true })).toHaveCount(0);

    const draftRequests: string[] = [];
    page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.endsWith("/draft")) draftRequests.push(path);
    });
    await page.goto(`${listPath}/${datasetId}?workspaceId=${otherId}`);
    await expect(main.getByRole("alert")).toContainText("RESOURCE_NOT_FOUND");
    await page.goto(`${listPath}/${catalogId}?workspaceId=${scope.workspaceId}`);
    await expect(main.getByRole("alert")).toContainText("Dataset not found.");
    await page.goto(`${listPath}/${datasetId}`);
    await expect(main.getByRole("alert")).toContainText("Invalid Workspace link.");
    await expect(main.getByRole("tablist", { name: "Dataset editor" })).toHaveCount(0);
    expect(draftRequests).toEqual([]);
});
