/**
 * 抽屉回归按指针层级、嵌套键盘关闭、原始焦点与长提示拆分，确保一个缺陷不会遮蔽其它独立行为的诊断结果。
 * 用例通过测试入口组合实际组件，断言真实浏览器交互，不检查源码或样式字符串。
 * 所有选择器使用角色、可访问名称或公开字段标签，鼠标操作不跳过命中测试。
 */
import { expect, test, type Page } from "@playwright/test";

/**
 * 从真实建议文本逐字取得浏览器排版坐标，并拒绝落在父框之外的文字，避免将裁剪的读屏描述误认为可见建议正文。
 * 这里只测量合成建议的非空白字符，不移动鼠标、不触发点击，也不修改组件样式或增加页面定位标记。
 */
function adviceCharacterCenters(this: Text) {
    const bounds = this.parentElement?.getBoundingClientRect();
    if (!bounds) return [];
    const points: { x: number; y: number }[] = [];
    const range = document.createRange();
    for (let offset = 0; offset < this.length; offset += 1) {
        if (/\s/.test(this.data[offset])) continue;
        range.setStart(this, offset);
        range.setEnd(this, offset + 1);
        const rect = range.getBoundingClientRect();
        const x = Math.floor(rect.left + rect.width / 2);
        const y = Math.floor(rect.top + rect.height / 2);
        if (rect.width <= 0 || rect.height <= 0) return [];
        if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) return [];
        if (x < 0 || x >= window.innerWidth || y < 0 || y >= window.innerHeight) return [];
        points.push({ x, y });
    }
    return points;
}

/**
 * 使用当前 Chromium 的实际前景命中结果检查建议全文，忽略指针禁用属性，使不可点击的提示气泡也必须位于抽屉前面。
 * 候选来自完整建议的真实文本节点，不依赖提示角色恰好位于可见容器，也不依赖任何层级数值或隐藏测试标记。
 * 每个非空白字符的中心都须命中该文本父框或其后代；独立读屏副本即使有文本也不能替代被遮挡的可见正文。
 */
async function adviceIsUnobscured(page: Page, advice: string): Promise<boolean> {
    const session = await page.context().newCDPSession(page);
    try {
        const { root } = await session.send("DOM.getDocument", { depth: -1 });
        const candidates: number[] = [];
        function collect(node: typeof root) {
            if (node.nodeType === 3 && node.nodeValue === advice) candidates.push(node.nodeId);
            for (const child of node.children ?? []) collect(child);
        }
        collect(root);
        for (const nodeId of candidates) {
            const { object } = await session.send("DOM.resolveNode", { nodeId });
            if (!object.objectId) throw new Error("ADVICE_TEXT_NODE_NOT_RESOLVED");
            const measurement = await session.send("Runtime.callFunctionOn", {
                objectId: object.objectId,
                functionDeclaration: adviceCharacterCenters.toString(),
                returnByValue: true,
            });
            expect(measurement.exceptionDetails).toBeUndefined();
            const points = measurement.result.value as { x: number; y: number }[];
            if (points.length === 0) continue;
            let unobscured = true;
            for (const point of points) {
                const front = await session.send("DOM.getNodeForLocation", {
                    ...point,
                    ignorePointerEventsNone: true,
                });
                const resolved = await session.send("DOM.resolveNode", { backendNodeId: front.backendNodeId });
                if (!resolved.object.objectId) throw new Error("ADVICE_FRONT_NODE_NOT_RESOLVED");
                const hit = await session.send("Runtime.callFunctionOn", {
                    objectId: object.objectId,
                    functionDeclaration: "function(front) { return this.parentElement.contains(front); }",
                    arguments: [{ objectId: resolved.object.objectId }],
                    returnByValue: true,
                });
                expect(hit.exceptionDetails).toBeUndefined();
                if (hit.result.value !== true) {
                    unobscured = false;
                    break;
                }
            }
            if (unobscured) return true;
        }
        return false;
    } finally {
        await session.detach();
    }
}

test.beforeEach(async ({ page }) => {
    await page.goto("/tests/interaction-fixture.html");
    await expect(page.getByRole("heading", { name: "Synthetic resource interactions" })).toBeVisible();
});

/**
 * 普通点击必须穿过正确的视觉层级到达确认按钮，计数变化和后续输入共同证明嵌套确认完成后抽屉仍然可用。
 * 单纯断言对话框可见不能发现被高层遮罩挡住的问题，因此保留实际点击与可见状态更新。
 */
test("nested archive confirmation receives an ordinary click and leaves the sheet usable", async ({ page }) => {
    await page.getByRole("button", { name: "Edit synthetic resource", exact: true }).click();
    await page.getByRole("button", { name: "Archive synthetic resource", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Archive synthetic resource?", exact: true });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "Confirm archive", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(page.getByRole("status")).toHaveText("Archive confirmations: 1");
    await page.getByLabel("Synthetic recovery phrase", { exact: false }).fill("edited synthetic phrase");
    await expect(page.getByRole("textbox")).toHaveValue("edited synthetic phrase");
});

/**
 * 取消路径单独使用真实指针点击，要求确认计数保持原值，避免只验证肯定动作而遗漏同一层级上的取消按钮。
 * 抽屉必须继续存在，随后正常关闭用于证明取消并没有误关外层编辑会话。
 */
test("nested cancel preserves the count and the sheet", async ({ page }) => {
    await page.getByRole("button", { name: "Edit synthetic resource", exact: true }).click();
    await page.getByRole("button", { name: "Archive synthetic resource", exact: true }).click();
    await page.getByRole("button", { name: "Cancel archive", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Archive confirmations: 0");
    await expect(page.getByRole("dialog", { name: "Synthetic resource", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
});

/**
 * 嵌套退出只应影响最上层确认框，等待确认面板出现后再发送退出按键，避免将尚未打开的面板误作关闭结果。
 * 显式检查外层输入可编辑及计数不变，不能把所有旧操作一律写成预期失败。
 */
test("Escape dismisses only the nested confirmation", async ({ page }) => {
    await page.getByRole("button", { name: "Edit synthetic resource", exact: true }).click();
    await page.getByRole("button", { name: "Archive synthetic resource", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Archive synthetic resource?", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Archive synthetic resource?", exact: true })).toBeHidden();
    await expect(page.getByRole("dialog", { name: "Synthetic resource", exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("Archive confirmations: 0");
    await page.getByRole("textbox").fill("still editable");
    await expect(page.getByRole("textbox")).toHaveValue("still editable");
});

/**
 * 编辑与新增入口分别经历两轮打开关闭，每次从精确原节点按键打开，以发现严格模式或重复挂载造成的焦点丢失。
 * 两种退出方式独立生成测试，首个退出失败不会阻止另一个关闭入口得到自己的诊断。
 */
for (const openerName of ["Edit synthetic resource", "Create synthetic resource"]) {
    for (const closeWith of ["Escape", "Close"]) {
        test(`${openerName} restores its exact live opener after ${closeWith}`, async ({ page }) => {
            const opener = page.getByRole("button", { name: openerName, exact: true });
            for (let cycle = 0; cycle < 2; cycle += 1) {
                await opener.focus();
                await expect(opener).toBeFocused();
                await page.keyboard.press("Enter");
                await expect(page.getByRole("dialog", { name: "Synthetic resource", exact: true })).toBeVisible();
                if (closeWith === "Escape") await page.keyboard.press("Escape");
                else await page.getByRole("button", { name: "Close", exact: true }).click();
                await expect(page.getByRole("dialog", { name: "Synthetic resource", exact: true })).toBeHidden();
                await expect(opener).toBeFocused();
            }
        });
    }
}

/**
 * 模拟列表刷新移除原入口，关闭后只要求焦点仍属于活文档且其它入口可继续使用，不强加尚未选定的回退目标。
 * 模态面板会隐藏背景的可访问角色，因此先捕获原节点，面板打开后只操作该句柄并在结束时释放。
 */
test("a detached opener allows safe close and another live opener", async ({ page }) => {
    const opener = page.getByRole("button", { name: "Edit synthetic resource", exact: true });
    const openerNode = await opener.elementHandle();
    if (!openerNode) throw new Error("DETACHED_OPENER_NODE_MISSING");
    try {
        await opener.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog", { name: "Synthetic resource", exact: true })).toBeVisible();
        await openerNode.evaluate((element) => element.remove());
    } finally {
        await openerNode.dispose();
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Synthetic resource", exact: true })).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.isConnected)).toBe(true);
    await page.getByRole("button", { name: "Create synthetic resource", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Synthetic resource", exact: true })).toBeVisible();
});

/**
 * 焦点从抽屉关闭按钮按顺序进入字段帮助；当前负索引会跳过帮助，这个焦点断言直接暴露键盘不可达的根因。
 * 字段本身的原生标签用于寻找帮助按钮，既不绑定问号这个缺陷名称，也不要求新增任何隐藏定位标记。
 * 到达帮助后还必须有语义名称、完整可见正文和描述关系，不能仅把按钮放回顺序而丢失建议内容。
 */
test("Tab reaches meaningful field help and exposes its complete advice", async ({ page }) => {
    await page.getByRole("button", { name: "Edit synthetic resource", exact: true }).click();
    const field = page.locator("label").filter({ has: page.getByText("Synthetic recovery phrase", { exact: true }) });
    const help = field.getByRole("button");
    await page.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(help).toBeFocused();
    await expect(help).toHaveAccessibleName(/Synthetic recovery phrase/i);
    const advice = "Use a unique synthetic recovery phrase. Store it offline and never reuse an account password.";
    await expect(page.getByRole("tooltip")).toHaveText(advice);
    await expect(page.getByRole("tooltip")).toBeVisible();
    await expect(help).toHaveAccessibleDescription(advice);
    expect(await adviceIsUnobscured(page, advice), "Every rendered advice character must be above the drawer").toBe(
        true,
    );
    await page.keyboard.press("Tab");
    await expect(page.getByRole("textbox")).toBeFocused();
});
