/**
 * 正常设置路由使用真实 Provider 控件与共享反馈层，浏览器拦截边界只控制本地响应，避免调用真实模型或写开发数据库。
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const userId = "2369cfe0-f0f9-42af-a745-bbda9fdbb5fd";
const workspaceId = "c1298643-acdc-4316-8aaa-d6a731597b3b";
const providerId = "8f310417-4a3a-4721-9cb9-f2bad6e08242";
const generationId = "c821114e-c81c-4bb5-884f-ff75c71995f2";
const createdAt = "2026-01-01T00:00:00Z";
const base = `/api/v1/workspaces/${workspaceId}/ai`;
const user = {
    id: userId,
    email: "synthetic-owner@example.test",
    displayName: "Synthetic owner",
    disabled: false,
    systemAdmin: false,
    createdAt,
};
const workspace = { id: workspaceId, key: "synthetic", name: "Synthetic", role: "OWNER", archived: false, createdAt };
const provider = {
    id: providerId,
    name: "Synthetic provider",
    adapter: "OPENAI_COMPATIBLE",
    baseURL: "https://model.example.test/v1",
    model: "local-fixture",
    enabled: true,
    monthlyBudgetUsd: 1,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    maxOutputTokens: 1024,
    maxRequestUsd: 0.5,
    revision: 1,
    keyConfigured: true,
    budget: { estimatedUsedUsd: 0, availableUsd: 1 },
};

/**
 * 测试独立控制连接 POST 的响应时点，其余查询提供固定摘要，工作区、权限和路由仍经实际管理台初始化。
 */
async function providerSettings(page: Page, edit = true, providers: (typeof provider)[] = [provider]) {
    await page.addInitScript(() => localStorage.setItem("veriq.language", "en"));
    let releasePost: (route: Route) => void = () => {};
    const posted = new Promise<Route>((resolve) => {
        releasePost = resolve;
    });
    let posts = 0;
    await page.route("**/api/v1/**", async (route) => {
        const { pathname } = new URL(route.request().url());
        if (pathname === `${base}/providers/${providerId}/connection-tests`) {
            expect(route.request().method()).toBe("POST");
            posts++;
            releasePost(route);
            return;
        }
        expect(route.request().method()).toBe("GET");
        const items = (data: unknown[]) => ({ items: data, nextCursor: null });
        const data: Record<string, unknown> = {
            "/api/v1/setup": { initialized: true },
            "/api/v1/auth/session": { user, csrfToken: "synthetic" },
            "/api/v1/account": user,
            "/api/v1/workspaces": items([workspace]),
            [`/api/v1/workspaces/${workspaceId}`]: workspace,
            [`${base}/providers`]: items(providers),
            [`${base}/generations/${generationId}`]: generation("SUCCEEDED"),
        };
        await route.fulfill({ json: { code: "OK", data: data[pathname] ?? items([]) } });
    });
    await page.goto(`/workspaces?tab=ai-providers&workspaceId=${workspaceId}`);
    if (edit) await page.getByRole("button", { name: "Edit · Synthetic provider", exact: true }).click();
    const trigger = page.getByRole("button", { name: "Test connection", exact: true });
    const table = page.getByRole("table", { includeHidden: true });
    return { trigger, table, posted, posts: () => posts };
}

/**
 * 用两个实际筛选维度检查组合结果，并测量工具栏和新增图标布局；还原不改变操作者选定的每页条数。
 */
test("provider directory groups filters and centers the create icon", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const providers = [
        provider,
        { ...provider, name: "Synthetic Claude enabled", adapter: "ANTHROPIC" },
        { ...provider, name: "Synthetic Claude disabled", adapter: "ANTHROPIC", enabled: false },
        { ...provider, name: "Synthetic OpenAI disabled", enabled: false },
        { ...provider, name: "Synthetic fallback" },
        { ...provider, name: "Synthetic alternative" },
    ].map((item, index) => ({ ...item, id: `00000000-0000-4000-8000-00000000000${index}` }));
    await providerSettings(page, false, providers);
    const table = page.getByRole("table", { name: "Provider", exact: true });
    const sheet = page.locator(".vq-data-table").filter({ has: table });
    const search = sheet.getByRole("searchbox", { name: "Search providers", exact: true });
    const size = sheet.getByRole("combobox", { name: "Rows per page", exact: true });
    const filter = sheet.getByRole("button", { name: "Filter", exact: true });
    const reset = sheet.getByRole("button", { name: "See all", exact: true });
    const download = sheet.getByRole("button", { name: "Download", exact: true });
    const heading = page.getByRole("heading", { name: "Providers", exact: true });
    const add = heading.locator("..").getByRole("button", { name: "New provider", exact: true });
    await expect(filter).toBeVisible();
    await expect(sheet.locator(".vq-data-table-filters")).toHaveCount(0);
    await expect(heading).toBeVisible();
    await expect(sheet.getByRole("button", { name: "New provider", exact: true })).toHaveCount(0);
    const controls = [search, filter, reset, download];
    const bounds = await Promise.all(controls.map((control) => control.boundingBox()));
    for (let index = 1; index < bounds.length; index++) {
        const previous = bounds[index - 1];
        const next = bounds[index];
        if (!previous || !next) throw new Error("Expected each directory control to be visible");
        expect(next.x).toBeGreaterThan(previous.x + previous.width);
        expect(Math.abs(previous.y + previous.height / 2 - next.y - next.height / 2)).toBeLessThanOrEqual(1);
    }
    const [button, icon, title, list] = await Promise.all([
        add.boundingBox(),
        add.locator("svg").boundingBox(),
        heading.boundingBox(),
        sheet.boundingBox(),
    ]);
    if (!button || !icon || !title || !list) throw new Error("Expected visible Provider directory heading");
    expect(button.height).toBe(34);
    expect(button.width).toBe(34);
    expect(button.x - (title.x + title.width)).toBe(8);
    expect(Math.abs(button.y + button.height / 2 - title.y - title.height / 2)).toBeLessThanOrEqual(1);
    expect(button.y + button.height).toBeLessThan(list.y);
    await expect(add).toHaveCSS("background-color", "rgb(70, 95, 255)");
    expect(Math.abs(button.x + button.width / 2 - icon.x - icon.width / 2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(button.y + button.height / 2 - icon.y - icon.height / 2)).toBeLessThanOrEqual(0.5);

    await size.click();
    await page.getByRole("option", { name: "5", exact: true }).click();
    await search.fill("Synthetic");
    const pager = sheet.getByRole("navigation", { name: "Provider pagination", exact: true });
    await pager.getByRole("button", { name: "Next", exact: true }).click();
    await expect(pager.locator('[aria-current="page"]')).toHaveText("2");
    await reset.click();
    await expect(pager.locator('[aria-current="page"]')).toHaveText("1");
    await expect(search).toHaveValue("");
    await expect(size).toContainText("5");

    await filter.press("Enter");
    await page.getByRole("menuitem", { name: "Adapter", exact: true }).press("ArrowRight");
    await page.getByRole("menuitemradio", { name: "ANTHROPIC", exact: true }).press("Enter");
    await page.keyboard.press("Escape");
    await page.getByRole("menuitem", { name: "Status", exact: true }).press("ArrowRight");
    await page.getByRole("menuitemradio", { name: "Disabled", exact: true }).press("Enter");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(filter).toBeFocused();
    await expect(table.getByRole("row")).toHaveCount(2);
    await expect(table.getByRole("cell", { name: "Synthetic Claude disabled", exact: true })).toBeVisible();
    await search.fill("Claude");
    await reset.click();
    await expect(search).toHaveValue("");
    await expect(size).toContainText("5");
    await expect(sheet.getByText("Showing 1 to 5 of 6 entries", { exact: true })).toBeVisible();
    await table.getByRole("button", { name: "Edit · Synthetic provider", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Edit · Synthetic provider", exact: true })).toBeVisible();
    await add.click();
    await expect(page.getByRole("heading", { name: "New provider", exact: true })).toBeVisible();
});

/**
 * 使用实际位置核对两组输入填满对齐的五列，图片和启用选项排在第三行左侧，保存与两行最右字段对齐。
 */
test("new provider puts image support, enabled and save on the third row", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await providerSettings(page, false);
    const form = page
        .locator(".vq-ai-form")
        .filter({ has: page.getByRole("heading", { name: "New provider", exact: true }) });
    const fields = form.locator(".vq-field, .vq-ai-enabled-field");
    const save = form.getByRole("button", { name: "Save provider", exact: true });
    await expect(fields).toHaveCount(12);
    await expect(form.getByRole("checkbox").nth(0)).toHaveAccessibleName("Accept images in Test Agent");
    await expect(form.getByRole("checkbox").nth(1)).toHaveAccessibleName("Enabled");
    await expect(save).toBeVisible();
    await expect(form.getByRole("button", { name: /^(Save provider|Test connection|Delete provider)$/ })).toHaveCount(
        1,
    );
    const positions = () =>
        form.evaluate((element) => {
            const action = element.querySelector(".vq-ai-form-actions button");
            if (!action) throw new Error("Provider save action is missing");
            const cells = [...element.querySelectorAll(".vq-field, .vq-ai-enabled-field")].map((cell) => {
                const { top, bottom, left, width } = cell.getBoundingClientRect();
                const control = cell.querySelector("input, [role='combobox']");
                if (!control) throw new Error("Provider field control is missing");
                const box = control.getBoundingClientRect();
                return {
                    top,
                    bottom,
                    left,
                    width,
                    controlCenter: box.top + box.height / 2,
                    controlHeight: box.height,
                    checkbox: control.matches("input[type='checkbox']"),
                };
            });
            const { top, bottom, left, right } = action.getBoundingClientRect();
            const bottomSpace = element.getBoundingClientRect().bottom - bottom;
            return { cells, save: { top, left, right, bottomSpace } };
        });
    const { cells: desktop, save: desktopSave } = await positions();
    expect(desktop.map(({ checkbox }) => checkbox)).toEqual([...Array<boolean>(10).fill(false), true, true]);
    for (const row of [desktop.slice(0, 5), desktop.slice(5, 10)]) {
        expect(new Set(row.map(({ top }) => Math.round(top))).size).toBe(1);
        expect(new Set(row.map(({ left }) => Math.round(left))).size).toBe(5);
        expect(Math.max(...row.map(({ width }) => width)) - Math.min(...row.map(({ width }) => width))).toBeLessThan(1);
        const centers = row.map(({ controlCenter }) => controlCenter);
        expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(1);
    }
    const [images, enabled] = desktop.slice(10);
    expect(images.top).toBeGreaterThan(Math.max(...desktop.slice(5, 10).map(({ bottom }) => bottom)));
    expect(images.left).toBe(desktop[0].left);
    expect(enabled.left).toBe(desktop[1].left);
    expect(images.top).toBe(enabled.top);
    expect(desktopSave.top).toBeGreaterThanOrEqual(images.top);
    for (const rightmost of [desktop[4], desktop[9]]) {
        expect(desktopSave.left).toBeGreaterThanOrEqual(rightmost.left - 1);
        expect(Math.abs(desktopSave.right - (rightmost.left + rightmost.width))).toBeLessThan(1);
    }
    const checkControlHeights = async () => {
        for (const theme of ["light", "dark"] as const) {
            await page.locator("html").evaluate((root, next) => {
                root.dataset.theme = next;
            }, theme);
            const reference = await page
                .getByRole("searchbox", { name: "Search providers", exact: true })
                .evaluate((input) => input.parentElement?.getBoundingClientRect().height ?? 0);
            expect(reference).toBe(34);
            const { cells, save: action } = await positions();
            const heights = cells.filter(({ checkbox }) => !checkbox).map(({ controlHeight }) => controlHeight);
            expect(heights, `Provider input heights in ${theme}`).toEqual(Array<number>(10).fill(reference));
            expect(action.bottomSpace, `Save bottom spacing in ${theme}`).toBeGreaterThanOrEqual(12);
            expect(action.bottomSpace, `Save bottom spacing in ${theme}`).toBeLessThanOrEqual(18);
        }
    };
    await checkControlHeights();

    for (const width of [640, 420]) {
        await page.setViewportSize({ width, height: 800 });
        const { cells: compact, save: compactSave } = await positions();
        expect(new Set(compact.slice(0, 5).map(({ top }) => Math.round(top))).size).toBeGreaterThan(1);
        expect(compact.every(({ left, width: size }) => left >= 0 && left + size <= width)).toBe(true);
        expect(compactSave.right).toBeLessThanOrEqual(width);
        expect(
            compact.slice(10).every(({ left, width, bottom }) => {
                return compactSave.left >= left + width || compactSave.top >= bottom;
            }),
        ).toBe(true);
    }

    // 扩大共享控件行来模拟布局拉伸，验证各输入框的外框高度仍与同页标准搜索栏一致，并保留各行中心对齐。
    await page.setViewportSize({ width: 1280, height: 800 });
    await form.locator(".vq-ai-form-row:not(.vq-ai-form-actions)").evaluateAll((rows) => {
        for (const row of rows) {
            if (row instanceof HTMLElement) row.style.gridTemplateRows = "auto auto 56px auto";
        }
    });
    await checkControlHeights();
    const { cells: stretched } = await positions();
    for (const row of [stretched.slice(0, 5), stretched.slice(5, 10)]) {
        const centers = row.map(({ controlCenter }) => controlCenter);
        expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(1);
    }
});

/**
 * 生成摘要只包含测试所需的终态和稳定错误码，工作区配置、账单和诊断数据由原有页面独立呈现。
 */
function generation(status: "RUNNING" | "SUCCEEDED" | "FAILED") {
    return {
        id: generationId,
        providerId,
        requestId: generationId,
        createdAt,
        status,
        purpose: "CONNECTION_TEST",
        reservedUsd: 0.1,
        costState: "UNKNOWN",
        ...(status === "FAILED" ? { errorCode: "SYNTHETIC_CONNECTION_FAILED" } : {}),
    };
}

/**
 * 测量已保存提供方的三个实际操作框，窄视口保持同行的等宽等高排版，主题切换和悬停仍可分辨各个操作。
 */
test("provider actions have matching dimensions and a green connection button", async ({ page }) => {
    const { trigger } = await providerSettings(page);
    const save = page.getByRole("button", { name: "Save provider", exact: true });
    const remove = page.getByRole("button", { name: "Delete provider", exact: true });
    for (const width of [1280, 640]) {
        await page.setViewportSize({ width, height: 800 });
        const [saveBox, testBox, deleteBox] = await Promise.all([
            save.boundingBox(),
            trigger.boundingBox(),
            remove.boundingBox(),
        ]);
        if (!saveBox || !testBox || !deleteBox) throw new Error("Provider action buttons must be visible");
        expect(Math.abs(saveBox.width - testBox.width)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(deleteBox.width - testBox.width)).toBeLessThanOrEqual(0.5);
        expect(saveBox.height).toBe(testBox.height);
        expect(deleteBox.height).toBe(testBox.height);
        expect(saveBox.y).toBe(testBox.y);
        expect(deleteBox.y).toBe(testBox.y);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const theme of ["light", "dark"] as const) {
        await page.locator("html").evaluate((root, next) => {
            root.dataset.theme = next;
        }, theme);
        const [formBox, saveBox, testBox, deleteBox] = await Promise.all([
            page.locator(".vq-ai-form").boundingBox(),
            save.boundingBox(),
            trigger.boundingBox(),
            remove.boundingBox(),
        ]);
        if (!formBox || !saveBox || !testBox || !deleteBox) throw new Error("Expected editor geometry in both themes");
        const cardBottom = formBox.y + formBox.height;
        for (const box of [saveBox, testBox, deleteBox]) {
            const bottomSpace = cardBottom - box.y - box.height;
            expect(bottomSpace).toBeGreaterThanOrEqual(12);
            expect(bottomSpace).toBeLessThanOrEqual(18);
        }
        await expect(save).toHaveCSS("background-color", "rgb(70, 95, 255)");
        await expect(trigger).toHaveCSS("background-color", "rgb(6, 118, 71)");
        await expect(trigger).toHaveCSS("color", "rgb(255, 255, 255)");
        await expect(remove).toHaveCSS(
            "background-color",
            theme === "light" ? "rgb(255, 243, 240)" : "rgb(56, 36, 39)",
        );
        await trigger.hover();
        await expect(trigger).toHaveCSS("background-color", "rgb(8, 93, 58)");
        await save.focus();
        await page.keyboard.press("Tab");
        await expect(trigger).toBeFocused();
        const focus = theme === "light" ? "rgb(110, 143, 210)" : "rgb(154, 181, 240)";
        await expect(trigger).toHaveCSS("background-color", focus);
        await page.mouse.move(1, 1);
        await trigger.blur();
    }
});

/**
 * 展开等待对话框后才完成网络请求，核对原有对话框节点、原表格位置以及关闭结果后返回的真实操作焦点。
 */
for (const outcome of ["success", "failure", "network", "running"] as const) {
    test(`connection feedback updates one dialog in place for ${outcome}`, async ({ page }) => {
        const { trigger, table, posted, posts } = await providerSettings(page);
        const location = await table.boundingBox();
        expect(location).not.toBeNull();
        await trigger.click();
        const pending = page.getByRole("dialog", { name: "Operation in progress", exact: true });
        await expect(pending).toBeVisible();
        await expect(pending).toContainText("Testing connection…");
        const original = await pending.elementHandle();
        expect(await table.boundingBox()).toEqual(location);
        const route = await posted;
        if (outcome === "network") {
            await route.abort("failed");
        } else {
            const status = outcome === "failure" ? "FAILED" : outcome === "running" ? "RUNNING" : "SUCCEEDED";
            await route.fulfill({ json: { code: "OK", data: generation(status) } });
        }
        const success = outcome === "success" || outcome === "running";
        const result = page.getByRole("dialog", { name: success ? "Operation succeeded" : "Operation failed" });
        await expect(result).toBeVisible();
        const message = success
            ? "Connection test succeeded"
            : outcome === "network"
              ? "Failed to fetch"
              : /SYNTHETIC_/;
        await expect(result).toContainText(message);
        expect(await result.evaluate((element, previous) => element === previous, original)).toBe(true);
        expect(await table.boundingBox()).toEqual(location);
        expect(posts()).toBe(1);
        await result.getByRole("button", { name: "OK", exact: true }).press("Enter");
        await expect(result).toBeHidden();
        await expect(trigger).toBeFocused();
    });
}

/**
 * 用户可在等待网络时关闭浮层，随后到达的响应不应恢复已关闭的操作或发布第二份结果。
 */
test("dismissed connection feedback ignores late results", async ({ page }) => {
    const { trigger, posted, posts } = await providerSettings(page);
    await trigger.click();
    const pending = page.getByRole("dialog", { name: "Operation in progress", exact: true });
    await expect(pending).toBeVisible();
    const route = await posted;
    await page.keyboard.press("Escape");
    await expect(pending).toBeHidden();
    await route.fulfill({ json: { code: "OK", data: generation("SUCCEEDED") } });
    await expect(trigger).toBeEnabled();
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(posts()).toBe(1);
});

/**
 * 浏览器后退只切换设置标签，共享反馈层仍挂载，验证请求作用域撤销会主动清除等待框并拒绝过时的客户端结果。
 */
test("leaving provider settings dismisses its pending connection feedback", async ({ page }) => {
    const { trigger, posted, posts } = await providerSettings(page);
    const basic = page.getByRole("tab", { name: "Basic information", exact: true });
    await basic.click();
    await page.getByRole("tab", { name: "AI providers", exact: true }).click();
    await page.getByRole("button", { name: "Edit · Synthetic provider", exact: true }).click();
    await trigger.click();
    const pending = page.getByRole("dialog", { name: "Operation in progress", exact: true });
    await expect(pending).toBeVisible();
    const route = await posted;
    await page.goBack();
    await expect(basic).toHaveAttribute("aria-selected", "true");
    await expect(pending).toBeHidden();
    await route.fulfill({ json: { code: "OK", data: generation("SUCCEEDED") } });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(posts()).toBe(1);
});
