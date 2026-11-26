/**
 * 使用实际工作区、资源和对话设置检查右侧抽屉的宽度、布局及焦点，不调用模型，也不替换应用的网络响应。
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Locator } from "@playwright/test";
import { editorScope } from "../editor-fixture";
import { chooseLanguage, chooseWorkspace } from "../support/console-controls";
import { installed } from "../support/install-console";

const viewport = { width: 1440, height: 900 };
test.use({ viewport });

/**
 * 用真实渲染尺寸同时验证切换结果和右侧锚点，窄抽屉与全宽抽屉均须贴合视口上下边缘并保持直角。
 */
async function expectDrawerWidth(drawer: Locator, width: number) {
    await expect(drawer).toHaveCSS("border-radius", "0px");
    await expect.poll(async () => Math.round((await drawer.boundingBox())?.width ?? 0)).toBe(Math.round(width));
    const box = await drawer.boundingBox();
    if (!box) throw new Error("The drawer must have a visible bounding box");
    expect(Math.round(box.x + box.width)).toBe(viewport.width);
    expect(box.y).toBe(0);
    expect(box.height).toBe(viewport.height);
}

/**
 * 夹具编辑抽屉支持从左缘拖动和切换宽度，保留跨宽度的未保存值，关闭后回到当前夹具列表入口。
 */
test("fixture editors retain the right drawer width control", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `sheet-resource-${randomUUID()}`);
    const name = "Drawer fixture";
    const created = await page.request.post(`/api/v1/workspaces/${workspaceId}/resources`, {
        headers,
        data: {
            kind: "FIXTURE",
            name,
            key: "drawer_fixture",
            content: {
                kind: "FIXTURE",
                document: {
                    schemaVersion: "1.0",
                    prepare: { method: "POST", path: "/prepare" },
                    query: { method: "GET", path: "/query" },
                    cleanup: { method: "POST", path: "/cleanup" },
                    inputSchema: { type: "object" },
                    outputSchema: { type: "object" },
                    ttlSeconds: 1800,
                },
            },
        },
    });
    expect(created.status()).toBe(201);
    await page.goto("/resources/fixtures");
    await chooseWorkspace(page, workspaceId);
    const details = page.getByRole("table").getByRole("button", { name, exact: true });
    await details.press("Enter");
    const editor = page.getByRole("dialog", { name, exact: true });
    await expectDrawerWidth(editor, viewport.width / 3);
    const value = editor.getByRole("textbox", { name: "Prepare path", exact: true });
    await value.fill("/unsaved");
    const handle = await editor.locator(".vq-sheet-resizer").boundingBox();
    if (!handle) throw new Error("The fixture editor must offer a resize handle");
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 80, y, { steps: 5 });
    await page.mouse.up();
    await expectDrawerWidth(editor, viewport.width / 3 + 80);
    await editor.getByRole("button", { name: "Full width", exact: true }).press("Enter");
    await expectDrawerWidth(editor, viewport.width);
    const shrink = editor.getByRole("button", { name: "One third width", exact: true });
    await expect(shrink).toBeFocused();
    await shrink.press("Enter");
    await expectDrawerWidth(editor, viewport.width / 3);
    await expect(value).toHaveValue("/unsaved");
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(details).toBeFocused();
    await details.press("Enter");
    await expectDrawerWidth(editor, viewport.width / 3);
});

/**
 * Test Agent 在真实设置下显示紧凑选择器或完整会话栏，拖动后的宽度不能覆盖随后明确选择的三分之一宽度。
 */
test("Test Agent resets dragged width when switching modes or reopening", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `sheet-agent-${randomUUID()}`);
    const base = `/api/v1/workspaces/${workspaceId}`;
    const provider = await page.request.post(`${base}/ai/providers`, {
        headers,
        data: {
            name: "Drawer fixture provider",
            adapter: "OPENAI_COMPATIBLE",
            baseURL: "https://api.openai.com/v1",
            model: "drawer-layout-only",
            apiKey: "drawer-fixture-transport-unused",
            enabled: true,
            monthlyBudgetUsd: 1,
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 2,
            maxOutputTokens: 1024,
            maxRequestUsd: 0.5,
        },
    });
    expect(provider.status()).toBe(201);
    const { id } = (await provider.json()).data;
    const settings = await page.request.put(`${base}/agent/settings`, {
        headers,
        data: { defaultProviderId: id, agentProviderId: null },
    });
    expect(settings.status()).toBe(200);

    const trigger = page.getByRole("banner").getByRole("button", { name: "Test Agent", exact: true });
    await trigger.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Test Agent", exact: true });
    const conversations = drawer.getByRole("complementary", { name: "Conversations", exact: true });
    const chooser = drawer.getByRole("button", { name: "Choose a conversation", exact: true });
    const full = drawer.getByRole("button", { name: "Full width", exact: true });
    const third = drawer.getByRole("button", { name: "One third width", exact: true });
    await expectDrawerWidth(drawer, viewport.width / 3);
    await expect(chooser).toBeVisible();
    const handle = drawer.locator(".vq-sheet-resizer");
    const edge = await handle.boundingBox();
    if (!edge) throw new Error("The compact Agent drawer must be draggable");
    const pointer = { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 };
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.down();
    await page.mouse.move(pointer.x - 96, pointer.y, { steps: 5 });
    await page.mouse.up();
    await expectDrawerWidth(drawer, viewport.width / 3 + 96);
    await full.click();
    await expectDrawerWidth(drawer, viewport.width);
    await expect(conversations).toBeVisible();
    await expect(handle).toHaveCount(0);
    await third.click();
    await expectDrawerWidth(drawer, viewport.width / 3);
    await expect(conversations).toHaveCount(0);
    await expect(chooser).toBeVisible();
    await expect(handle).toBeVisible();
    await full.click();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.press("Enter");
    await expectDrawerWidth(drawer, viewport.width / 3);
    await expect(chooser).toBeVisible();
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
    await expect(trigger).toBeFocused();

    await chooseLanguage(page, "zh");
    await page.getByRole("banner").getByRole("button", { name: "测试 Agent", exact: true }).press("Enter");
    const localized = page.getByRole("dialog", { name: "测试 Agent", exact: true });
    await localized.getByRole("button", { name: "全宽", exact: true }).press("Enter");
    await expect(localized.getByRole("button", { name: "三分之一宽度", exact: true })).toBeFocused();
});
