/**
 * 抽屉回归按指针层级、嵌套键盘关闭、原始焦点与长提示拆分，确保一个缺陷不会遮蔽其它独立行为的诊断结果。
 * 用例通过测试入口组合实际组件，断言真实浏览器交互，不检查源码或样式字符串。
 * 所有选择器使用角色、可访问名称或公开字段标签，鼠标操作不跳过命中测试。
 */
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

/**
 * 通过真实下拉、分页、搜索和文件下载检查可见行范围，确保特殊单元格写进 CSV 时仍为普通数据且保留引号和换行。
 */
test("data table shows the current range and downloads only the visible page", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("veriq.language", "en"));
    await page.goto("/tests/interaction-fixture.html?data-table");
    const table = page.getByRole("table", { name: "Example records" });
    const pager = page.getByRole("navigation", { name: "Example record pages" });
    await expect(table.getByRole("row")).toHaveCount(11);
    const size = page.getByRole("combobox", { name: "Rows per page" });
    const search = page.getByRole("searchbox", { name: "Search records" });
    const download = page.getByRole("button", { name: "Download", exact: true });
    await size.click({ timeout: 1500 });
    await page.getByRole("option", { name: "5", exact: true }).click();
    const range = page.getByText("Showing 1 to 5 of 12 entries", { exact: true });
    await expect(range).toBeVisible();
    /**
     * 工具栏与页脚的左右布局通过坐标验证，字号从旧表格的同一单元格读取，避免在测试里重建断点样式。
     */
    const [capacityBox, searchBox, downloadBox, rangeBox, pagerBox, tableBox] = await Promise.all(
        [size, search, download, range, pager, table].map((element) => element.boundingBox()),
    );
    if (!capacityBox || !searchBox || !downloadBox || !rangeBox || !pagerBox || !tableBox) {
        throw new Error("The table controls are missing from the rendered layout");
    }
    expect(capacityBox.x + capacityBox.width).toBeLessThan(searchBox.x);
    expect(searchBox.x + searchBox.width).toBeLessThan(downloadBox.x);
    expect(capacityBox.y + capacityBox.height).toBeLessThan(tableBox.y);
    expect(rangeBox.y).toBeGreaterThan(tableBox.y + tableBox.height);
    expect(rangeBox.x + rangeBox.width).toBeLessThan(pagerBox.x);
    const fontSize = await table.getByRole("cell", { name: "Record 01" }).evaluate((cell) => {
        return getComputedStyle(cell).fontSize;
    });
    for (const control of [size, search, download, range, pager.getByRole("button", { name: "Next" })]) {
        await expect(control).toHaveCSS("font-size", fontSize);
    }
    await expect(table.getByRole("row")).toHaveCount(6);
    await pager.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("Showing 6 to 10 of 12 entries", { exact: true })).toBeVisible();
    await expect(pager.locator("[aria-current=page]")).toHaveText("2");
    const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
    expect(file.suggestedFilename()).toBe("Example-records.csv");
    const csv = await readFile(await file.path(), "utf8");
    expect(csv).toBe(
        '\uFEFF"Name","Note"\r\n' +
            '"Record 06","\'=1+2"\r\n"Record 07","Value, ""quoted""\nnew line"\r\n' +
            '"Record 08",""\r\n"Record 09",""\r\n"Record 10",""\r\n',
    );
    await search.fill("Record 12");
    await expect(pager.locator("[aria-current=page]")).toHaveText("1");
    await expect(page.getByText("Showing 1 to 1 of 1 entries", { exact: true })).toBeVisible();
    await expect(table.getByRole("cell", { name: "Record 12" })).toBeVisible();
    await search.fill("unmatched");
    await expect(page.getByText("Showing 0 to 0 of 0 entries", { exact: true })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Name" })).toBeVisible();
    await expect(table.getByRole("cell", { name: "No matching records." })).toBeVisible();
    await expect(download).toBeDisabled();
    await expect(pager.getByRole("button", { name: "Next" })).toBeDisabled();
    await page.goto("/tests/interaction-fixture.html?data-table&viewer");
    await expect(table.getByRole("cell", { name: "Record 01" })).toBeVisible();
    await expect(download).toBeDisabled();
    await search.fill("Record 12");
    await expect(table.getByRole("cell", { name: "Record 12" })).toBeVisible();
});

/**
 * 严格模式重放不能中止随后挂载的目录；验证真实请求到达并成功显示空列表的表头和数据行提示。
 */
test("resource directory loads after StrictMode effect replay", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("veriq.language", "en"));
    const path = "/api/v1/workspaces/00000000-0000-4000-8000-000000000001/resources";
    let completedReads = 0;
    await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        expect(request.method()).toBe("GET");
        expect(url.pathname).toBe(path);
        expect(url.searchParams.get("kind")).toBe("DATASET");
        await route.fulfill({ json: { code: "OK", data: { items: [], nextCursor: null } } });
        completedReads++;
    });
    await page.goto("/tests/interaction-fixture.html?resource-directory");
    await expect(page.getByRole("columnheader", { name: "Name", exact: true })).toBeVisible();
    await expect(page.getByText("No resources in this Workspace.", { exact: true })).toBeVisible();
    expect(completedReads).toBeGreaterThan(0);
});

/**
 * 将只读会话放入真实抽屉，检查列表样式与长短历史滚动，并保留紧凑控件和发送前草稿的行为断言。
 */
test("Agent drawer keeps its composer at the bottom and only separates conversation turns", async ({ page }) => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const agentPath = `/api/v1/workspaces/${workspaceId}/agent`;
    const providerId = "00000000-0000-4000-8000-000000000002";
    const session = {
        id: "00000000-0000-4000-8000-000000000003",
        workspaceId,
        title: "Synthetic conversation",
        createdAt: "2026-01-01T00:00:00Z",
        archived: false,
    };
    const text = "A previously saved synthetic message";
    const reply = [
        "Read this first.",
        "",
        "- [Unordered entry](https://example.test/unordered)",
        "",
        "1. [Ordered entry](https://example.test/ordered)",
    ].join("\n");
    let turnCount = 1;
    const unexpectedMethods: string[] = [];
    await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() !== "GET") {
            unexpectedMethods.push(request.method());
            return route.abort();
        }
        if (url.pathname === `${agentPath}/settings`) {
            return route.fulfill({
                json: {
                    data: {
                        defaultProviderId: providerId,
                        agentProviderId: null,
                        resolvedProviderId: providerId,
                        providerStatus: "READY",
                    },
                },
            });
        }
        if (url.pathname === `${agentPath}/sessions`) {
            const archived = url.searchParams.get("archived") === "true";
            return route.fulfill({ json: { data: { items: archived ? [] : [session], nextCursor: null } } });
        }
        if (url.pathname === `${agentPath}/sessions/${session.id}`) return route.fulfill({ json: { data: session } });
        if (url.pathname === `${agentPath}/sessions/${session.id}/tasks`)
            return route.fulfill({ json: { data: { items: [] } } });
        if (url.pathname === `${agentPath}/sessions/${session.id}/turns`) {
            const turns = Array.from({ length: turnCount }, (_, index) => ({
                id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
                text: index ? `Synthetic message ${index + 1}` : text,
                reply,
                status: "COMPLETED",
                createdAt: session.createdAt,
            }));
            return route.fulfill({ json: { data: { items: turns, nextCursor: null } } });
        }
        return route.abort();
    });
    await page.goto("/tests/interaction-fixture.html?agent-appearance=sheet");
    const drawer = page.getByRole("dialog", { name: "Test Agent" });
    const history = drawer.getByRole("list", { name: "Conversation history" });
    const turns = history.locator(":scope > li");
    const composer = drawer.locator("form.vq-agent-composer");
    const expectComposerInset = async () => {
        const [drawerBox, composerBox] = await Promise.all([drawer.boundingBox(), composer.boundingBox()]);
        if (!drawerBox || !composerBox) throw new Error("The drawer and composer must be visible");
        const inset = drawerBox.y + drawerBox.height - composerBox.y - composerBox.height;
        expect(inset).toBeGreaterThanOrEqual(12);
        expect(inset).toBeLessThanOrEqual(36);
        return composerBox;
    };
    const picker = page.getByRole("button", { name: "Choose a conversation", exact: true });
    const create = page.getByRole("button", { name: "New conversation", exact: true });
    const expectBlueCreation = async () => {
        for (const theme of ["light", "dark"] as const) {
            await page.evaluate((mode) => (document.documentElement.dataset.theme = mode), theme);
            await expect(create).toHaveCSS("background-color", "rgb(70, 95, 255)");
            await expect(create).toHaveCSS("color", "rgb(255, 255, 255)");
        }
    };
    await expectBlueCreation();
    await expect(picker).toHaveCSS("height", "34px");
    await expect(create).toHaveCSS("height", "34px");
    await picker.press("Enter");
    const option = page.getByRole("menuitemradio", { name: session.title, exact: true });
    await expect(option).toHaveCSS("height", "34px");
    await option.press("Enter");

    await expect(turns).toHaveCount(1);
    for (const name of ["Unordered entry", "Ordered entry"]) {
        const link = history.getByRole("link", { name, exact: true });
        const item = link.locator("..");
        await expect(link).toHaveCSS("text-decoration-line", "none");
        await expect(item).toHaveCSS("border-bottom-width", "0px");
        await expect(item).toHaveCSS("display", "list-item");
    }
    await expect(turns.last()).toHaveCSS("border-bottom-width", "0px");
    await expectComposerInset();

    const bubble = page.locator(".vq-agent-user-text").filter({ hasText: text });
    await expect(bubble).toHaveCSS("background-color", "rgb(70, 95, 255)");
    await expect(bubble.getByText(text, { exact: true })).toHaveCSS("color", "rgb(255, 255, 255)");
    const archive = page.getByRole("button", { name: "Archive conversation", exact: true });
    const send = page.getByRole("button", { name: "Send", exact: true });
    for (const action of [archive, send]) {
        await expect(action).toHaveCSS("width", "34px");
        await expect(action).toHaveCSS("height", "34px");
    }
    const [archiveBox, sendBox] = await Promise.all([archive.boundingBox(), send.boundingBox()]);
    if (!archiveBox || !sendBox) throw new Error("Archive and send actions must be visible");
    expect(archiveBox.y).toBeCloseTo(sendBox.y, 1);
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("Unsaved draft");
    await expect(send).toBeEnabled();
    await archive.press("Tab");
    await expect(send).toBeFocused();
    await drawer.getByRole("button", { name: "Full width", exact: true }).click();
    await expect(message).toBeVisible();
    await expectComposerInset();

    turnCount = 18;
    await page.reload();
    await picker.click();
    await option.click();
    await expect(turns).toHaveCount(turnCount);
    await expect(turns.first()).toHaveCSS("border-bottom-width", "1px");
    await expect(turns.last()).toHaveCSS("border-bottom-width", "0px");
    const newestMessage = history.getByText(`Synthetic message ${turnCount}`, { exact: true });
    await expect(newestMessage).toBeInViewport();
    for (const layout of ["narrow", "wide"]) {
        if (layout === "wide") await drawer.getByRole("button", { name: "Full width", exact: true }).click();
        await expect(message).toBeInViewport();
        const reference = await expectComposerInset();
        const scroll = drawer.locator(".vq-agent-message-scroll");
        await expect.poll(() => scroll.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
        await scroll.evaluate((node) => node.scrollTo({ top: node.scrollHeight, behavior: "instant" }));
        await expect(newestMessage).toBeInViewport();
        const latestActions = turns.last().getByRole("button", { name: "Copy message", exact: true }).last();
        const latestBox = await latestActions.boundingBox();
        if (!latestBox) throw new Error("The last turn's controls must be visible");
        expect(latestBox.y + latestBox.height).toBeLessThan(reference.y);
        await scroll.evaluate((node) => node.scrollTo({ top: 0, behavior: "instant" }));
        await expect(history.getByText(text, { exact: true })).toBeInViewport();
        expect((await expectComposerInset()).y).toBeCloseTo(reference.y, 1);
    }
    await expect(page.getByRole("complementary", { name: "Conversations", exact: true })).toBeVisible();
    await expectBlueCreation();
    expect(unexpectedMethods).toEqual([]);
});

/**
 * 在测试抽屉内通过真实模型弹窗检查必选规则、鼠标与键盘交互，并捕获适配器实际发出的两个可空字段。
 */
test("Model settings dropdowns preserve missing selections and submit empty provider choices as null", async ({
    page,
}) => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const workspacePath = `/api/v1/workspaces/${workspaceId}`;
    const settingsPath = `${workspacePath}/agent/settings`;
    const defaultProvider = "00000000-0000-4000-8000-000000000002";
    const disabledProvider = "00000000-0000-4000-8000-000000000003";
    const createdAt = "2026-01-01T00:00:00Z";
    const user = {
        id: "00000000-0000-4000-8000-000000000004",
        displayName: "Synthetic owner",
        email: "owner@example.test",
        createdAt,
    };
    const workspaceEntry = { id: workspaceId, key: "model-settings", name: "Model settings workspace", role: "OWNER" };
    const responses: Record<string, unknown> = {
        "/api/v1/setup": { initialized: true },
        "/api/v1/auth/session": { user, csrfToken: "fixture-only" },
        "/api/v1/account": user,
        "/api/v1/workspaces": { items: [{ ...workspaceEntry, archived: false, createdAt }], nextCursor: null },
        "/api/v1/notifications": { items: [], unreadCount: 0, readThrough: "fixture" },
        [`${workspacePath}/agent/sessions`]: { items: [], nextCursor: null },
    };
    await page.addInitScript(() => localStorage.setItem("veriq.language", "en"));
    await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/api/v1/notifications/stream") {
            return route.fulfill({
                contentType: "text/event-stream",
                body: 'event: inbox\ndata: {"revision":"1"}\n\n',
            });
        }
        if (url.pathname === settingsPath && request.method() === "GET") {
            return route.fulfill({
                json: {
                    data: {
                        defaultProviderId: defaultProvider,
                        agentProviderId: disabledProvider,
                        resolvedProviderId: null,
                        providerStatus: "UNAVAILABLE",
                    },
                },
            });
        }
        if (url.pathname === settingsPath && request.method() === "PUT") {
            return route.fulfill({
                json: {
                    data: { ...request.postDataJSON(), resolvedProviderId: null, providerStatus: "UNCONFIGURED" },
                },
            });
        }
        if (url.pathname === `${workspacePath}/ai/providers` && request.method() === "GET") {
            const next = url.searchParams.get("cursor") === "next-provider";
            const item = next
                ? { id: defaultProvider, name: "Paged provider", model: "synthetic-model", enabled: true }
                : { id: disabledProvider, name: "Disabled provider", model: "synthetic-model", enabled: false };
            return route.fulfill({ json: { data: { items: [item], nextCursor: next ? null : "next-provider" } } });
        }
        const data = responses[url.pathname];
        return data ? route.fulfill({ json: { data } }) : route.abort();
    });
    await page.goto("/notifications");
    await page.getByRole("banner").getByRole("button", { name: "Test Agent", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Test Agent", exact: true });
    const opener = sheet.getByRole("button", { name: "Model settings", exact: true });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Model settings", exact: true });
    const workspace = dialog.getByRole("combobox", { name: "Workspace default provider", exact: true });
    const conversation = dialog.getByRole("combobox", { name: "Conversation provider", exact: true });
    const descriptions = [
        [
            workspace,
            "Workspace default provider",
            "Choose the workspace default or select No default provider to clear it.",
        ],
        [
            conversation,
            "Conversation provider",
            "Choose a provider for conversations or inherit the workspace default.",
        ],
    ] as const;
    for (const [field, name, description] of descriptions) {
        const label = dialog.locator("label").filter({ has: page.getByText(name, { exact: true }) });
        const marker = label.getByText("*", { exact: true });
        const hint = dialog.getByText(description, { exact: true });
        await expect(field).toHaveAccessibleDescription(description);
        await expect.soft(field).toHaveAttribute("aria-required", "true", { timeout: 500 });
        await expect.soft(marker).toHaveCSS("color", "rgb(166, 45, 45)", { timeout: 500 });
        await expect(hint).toHaveCSS("font-size", "10px");
        const [fieldBox, hintBox] = await Promise.all([field.boundingBox(), hint.boundingBox()]);
        if (!fieldBox || !hintBox) throw new Error("The provider field and its hint must be visible");
        expect(hintBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height);
    }
    await expect(workspace).toContainText(`${defaultProvider} · Selected provider is missing from this page`);
    await expect(conversation).toContainText("Disabled provider · synthetic-model");
    await workspace.press("Enter");
    const options = page.getByRole("listbox");
    await expect(options.getByRole("option", { name: "Disabled provider · synthetic-model" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(options).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(workspace).toBeFocused();

    await dialog.getByRole("button", { name: "More providers", exact: true }).click();
    await expect(workspace).toContainText("Paged provider · synthetic-model");
    const dialogLayer = await dialog.evaluate((node) => Number(getComputedStyle(node).zIndex));
    await workspace.click();
    // 弹窗被菜单暂时禁用指针事件时，测试仍须确认菜单实际绘制于弹窗之上，用户能够看见可点击的选项。
    const menuLayer = await options.evaluate((node) => Number(getComputedStyle(node.parentElement ?? node).zIndex));
    expect.soft(menuLayer).toBeGreaterThan(dialogLayer);
    await options.getByRole("option", { name: "No default provider", exact: true }).click();
    await conversation.click();
    await options.getByRole("option", { name: "Inherit workspace default", exact: true }).press("Enter");

    const saveRequest = page.waitForRequest(
        (request) => new URL(request.url()).pathname === settingsPath && request.method() === "PUT",
    );
    await dialog.getByRole("button", { name: "Save model settings", exact: true }).click();
    expect((await saveRequest).postDataJSON()).toEqual({ defaultProviderId: null, agentProviderId: null });
    const result = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
    await expect(result.getByText("Model settings saved", { exact: true })).toBeVisible();
    await result.getByRole("button", { name: "OK", exact: true }).click();
    await opener.click();
    await expect(workspace).toContainText("No default provider");
    await expect(conversation).toContainText("Inherit workspace default");
});

/**
 * 用浏览器绘制的系统颜色作为预期值，使操作系统采用不同高对比度方案时仍能验证同一个可见焦点契约。
 */
async function systemFocusColors(page: Page) {
    return page.evaluate(() => {
        const sample = document.createElement("span");
        sample.style.cssText = "background: Highlight; color: HighlightText; forced-color-adjust: none";
        document.body.append(sample);
        const style = getComputedStyle(sample);
        const colors = { background: style.backgroundColor, foreground: style.color };
        sample.style.backgroundColor = "Canvas";
        const inputBackground = style.backgroundColor;
        sample.remove();
        return { ...colors, inputBackground };
    });
}

/**
 * 使用方向键和鼠标测量实际焦点样式；标签延续填色反馈，输入和选择触发器以边框强调焦点，弹层保持主题底色。
 */
for (const mode of ["light", "dark", "forced"] as const) {
    test(`tabs, text fields and Select distinguish focus without a ring in ${mode} mode`, async ({ page }) => {
        if (mode === "forced") await page.emulateMedia({ forcedColors: "active" });
        await page.goto("/tests/interaction-fixture.html?focus");
        if (mode === "dark") await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
        const colors =
            mode === "forced"
                ? await systemFocusColors(page)
                : {
                      background: mode === "dark" ? "rgb(154, 181, 240)" : "rgb(110, 143, 210)",
                      foreground: "rgb(16, 31, 59)",
                      inputBackground: mode === "dark" ? "rgb(16, 24, 40)" : "rgb(255, 255, 255)",
                  };
        const fieldBorder = mode === "forced" ? colors.background : "rgb(156, 185, 255)";
        const selected = page.getByRole("tab", { name: "Basic information" });
        const members = page.getByRole("tab", { name: "Members" });
        const line = await selected.evaluate((element) => getComputedStyle(element).borderBottomColor);
        await selected.press("ArrowRight");
        await expect(members).toBeFocused();
        await expect(members).toHaveCSS("outline-style", "none");
        await expect(members).toHaveCSS("background-color", colors.background);
        await expect(members).toHaveCSS("color", colors.foreground);
        await expect(selected).toHaveAttribute("aria-selected", "true");
        await expect(selected).toHaveCSS("border-bottom-color", line);
        await members.press("ArrowLeft");
        await expect(selected).toBeFocused();
        await expect(selected).toHaveCSS("background-color", colors.background);
        await expect(selected).toHaveCSS("border-bottom-color", mode === "forced" ? colors.foreground : line);

        const search = page.getByRole("searchbox", { name: "Search synthetic items" });
        const searchFrame = page.locator(".vq-user-search");
        await expect(searchFrame).toHaveCSS("background-color", colors.inputBackground);
        await search.click();
        await expect(search).toBeFocused();
        await expect(searchFrame).toHaveCSS("background-color", colors.inputBackground);
        await expect(searchFrame).toHaveCSS("border-color", fieldBorder);
        await expect(search).toHaveCSS("outline-style", "none");
        await search.press("Tab");
        const firstField = page.getByRole("textbox", { name: "Synthetic name" });
        await expect(firstField).toBeFocused();
        await expect(firstField).toHaveCSS("border-color", fieldBorder);
        for (const label of ["Synthetic name", "Synthetic email", "Synthetic description"]) {
            const field = page.getByRole("textbox", { name: label });
            await expect(field).toHaveCSS("background-color", colors.inputBackground);
            const border = await field.evaluate((element) => getComputedStyle(element).borderWidth);
            await field.click();
            await expect(field).toBeFocused();
            await expect(field).toHaveCSS("background-color", colors.inputBackground);
            await expect(field).toHaveCSS("border-color", fieldBorder);
            await expect(field).toHaveCSS("outline-style", "none");
            await expect(field).toHaveCSS("box-shadow", "none");
            await expect(field).toHaveCSS("border-width", border);
        }

        const selector = page.getByRole("combobox", { name: "Synthetic select" });
        await expect(selector).toHaveCSS("background-color", colors.inputBackground);
        await page.getByRole("button", { name: "Synthetic dropdown" }).press("Tab");
        await expect(selector).toBeFocused();
        await expect(selector).toHaveCSS("background-color", colors.inputBackground);
        await expect(selector).toHaveCSS("border-color", fieldBorder);
        await expect(selector).toHaveCSS("outline-style", "none");
        await selector.press("Enter");
        const popup = page.getByRole("listbox");
        const expandedTrigger = page.locator(".vq-select-trigger[data-state='open']");
        const popupBackground = mode === "dark" ? "rgb(30, 38, 53)" : colors.inputBackground;
        await expect(expandedTrigger).toHaveCSS("background-color", colors.inputBackground);
        await expect(expandedTrigger).toHaveCSS("border-color", fieldBorder);
        await expect(popup).toHaveCSS("background-color", popupBackground);
        const beta = popup.getByRole("option", { name: "Beta" });
        await beta.hover();
        if (mode !== "forced") {
            const hoverFill = mode === "dark" ? "rgba(255, 255, 255, 0.05)" : "rgb(243, 244, 246)";
            await expect(beta).toHaveCSS("background-color", hoverFill);
        }
        await page.keyboard.press("ArrowUp");
        await page.keyboard.press("ArrowDown");
        await expect(beta).toBeFocused();
        await expect(beta).toHaveCSS("background-color", colors.background);
        await page.keyboard.press("Enter");
        await expect(selector).toBeFocused();
        await expect(selector).toContainText("Beta");
        await expect(selector.locator(".vq-dropdown-check")).toHaveCount(0);
        await expect(selector).toHaveCSS("background-color", colors.inputBackground);
        await selector.click();
        await expect(beta.locator(".vq-dropdown-check")).toBeVisible();
        await expect(beta).toHaveCSS("background-color", /^rgba\(\d+, \d+, \d+, 0\)$/);
    });
}

/**
 * 轻度鼠标悬停与键盘焦点使用不同背景，方向键在指针停留于同一选项时仍能恢复清晰的键盘反馈。
 * 测量真实弹层留白、选项间距和触发器高度，保证单行选项与不同尺寸的触发器同高。
 */
for (const type of ["dropdown", "select"] as const) {
    test(`menu focus fill follows keyboard and pointer changes in ${type}`, async ({ page }) => {
        await page.goto("/tests/interaction-fixture.html?focus");
        const trigger = page.getByRole(type === "select" ? "combobox" : "button", { name: `Synthetic ${type}` });
        const role = type === "select" ? "option" : "menuitemcheckbox";
        const alpha = page.getByRole(role, { name: "Alpha" });
        const beta = page.getByRole(role, { name: "Beta" });
        const disabled = page.getByRole(role, { name: "Disabled option" });
        const focus = "rgb(110, 143, 210)";
        const triggerBox = await trigger.boundingBox();
        if (!triggerBox) throw new Error("The closed menu trigger must be visible");
        await trigger.click();
        const popup = page.getByRole(type === "select" ? "listbox" : "menu");
        await expect(popup).toHaveCSS("padding-block-start", "8px");
        await expect(popup).toHaveCSS("padding-block-end", "8px");
        const [menuBox, first, second] = await Promise.all([
            popup.boundingBox(),
            alpha.boundingBox(),
            beta.boundingBox(),
        ]);
        if (!menuBox || !first || !second) throw new Error("The open menu and its options must be visible");
        expect(menuBox.width).toBeGreaterThanOrEqual(triggerBox.width);
        expect(menuBox.width).toBeLessThan(260);
        expect(first.height).toBeCloseTo(triggerBox.height, 1);
        expect(second.height).toBeCloseTo(triggerBox.height, 1);
        expect(second.y - (first.y + first.height)).toBeCloseTo(2, 1);
        await expect(alpha).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        if (type === "select") await expect(alpha.locator(".vq-dropdown-check")).toBeVisible();
        else await expect(alpha).toBeChecked();
        await page.keyboard.press("Escape");
        await trigger.press("Enter");
        await expect(alpha).toBeFocused();
        await expect(alpha).toHaveCSS("background-color", focus);
        await disabled.hover();
        await expect(disabled).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await alpha.hover();
        await expect(alpha).toHaveCSS("background-color", "rgb(243, 244, 246)");
        await beta.hover();
        await expect(beta).toBeFocused();
        await expect(beta).toHaveCSS("background-color", "rgb(243, 244, 246)");
        await expect(beta).toHaveCSS("outline-style", "none");
        await expect(alpha).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await page.keyboard.press("ArrowUp");
        await expect(alpha).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(beta).toBeFocused();
        await expect(beta).toHaveCSS("background-color", focus);
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
    });
}

/**
 * 在独立视图验证工作区单选筛选仍保持成员页尺寸，并用键盘更新可见选值、选中项和稳定的辅助技术名称。
 */
test("workspace list choice filters keep their inline layout and accessible summary in an independent view", async ({
    page,
}) => {
    await page.goto("/tests/interaction-fixture.html?focus");
    const label = page.getByText("Status", { exact: true });
    const trigger = page.getByRole("button", { name: "Status", exact: true });
    await expect(trigger).toHaveText("All");
    await expect(trigger).toHaveAccessibleDescription("All");
    await expect(trigger).toHaveCSS("height", "28px");
    const fontSize = await trigger.evaluate((element) => getComputedStyle(element).fontSize);
    await expect(label).toHaveCSS("font-size", fontSize);
    const [labelBox, triggerBox] = await Promise.all([label.boundingBox(), trigger.boundingBox()]);
    if (!labelBox || !triggerBox) throw new Error("The list filter label and trigger must be visible");
    expect(triggerBox.x - (labelBox.x + labelBox.width)).toBeCloseTo(8, 1);
    expect(triggerBox.y + triggerBox.height / 2).toBeCloseTo(labelBox.y + labelBox.height / 2, 1);

    await trigger.press("Enter");
    const menu = page.getByRole("menu");
    const all = menu.getByRole("menuitemradio", { name: "All", exact: true });
    await expect(all).toBeChecked();
    await expect(all).toHaveCSS("font-size", fontSize);
    const disabled = menu.getByRole("menuitemradio", { name: "Disabled", exact: true });
    await page.keyboard.press("End");
    await expect(disabled).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveText("Disabled");
    await expect(trigger).toHaveAccessibleDescription("Disabled");
    await trigger.click();
    await expect(disabled).toBeChecked();
});

/**
 * 长选项可以把窄触发器展开到更宽的内容区；碰到视口限制后仍可断行，展开菜单和文案均不应横向溢出。
 */
for (const type of ["dropdown", "select"] as const) {
    test(`menu width adapts to long options in ${type}`, async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 800 });
        await page.goto("/tests/interaction-fixture.html?focus=long-menu");
        const trigger = page.getByRole(type === "select" ? "combobox" : "button", { name: `Synthetic ${type}` });
        const popup = page.getByRole(type === "select" ? "listbox" : "menu");
        const item = popup.getByRole(type === "select" ? "option" : "menuitem", { name: /^Long synthetic option / });
        const triggerBox = await trigger.boundingBox();
        await trigger.press("Enter");
        await expect(item).toBeVisible();
        const [menuBox, itemBox] = await Promise.all([popup.boundingBox(), item.boundingBox()]);
        if (!triggerBox || !menuBox || !itemBox) throw new Error("The expanded long option must be measurable");
        expect(menuBox.width).toBeGreaterThan(triggerBox.width);
        expect(menuBox.x).toBeGreaterThanOrEqual(-0.5);
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(360.5);
        expect(itemBox.height).toBeGreaterThan(triggerBox.height);
        expect(await popup.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    });
}

/**
 * 使用实际 Monaco 查找与快捷命令控件验证独立输入外壳和活动列表行都能绘制背景，并保持焦点导航。
 */
test("Monaco uses a focus border on Find and background on the active command", async ({ page }) => {
    await page.goto("/tests/interaction-fixture.html?focus=editor");
    const editor = page.locator(".vq-monaco");
    await editor.locator(".view-lines").click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
    await editor.getByRole("textbox", { name: "Find", exact: true }).click();
    const find = editor.locator(".find-widget .synthetic-focus");
    await expect(find).toHaveCSS("outline-style", "none");
    await expect(find).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(find).toHaveCSS("border-color", "rgb(156, 185, 255)");
    await editor.locator(".view-lines").click();
    await page.keyboard.press("F1");
    const commands = editor.locator(".quick-input-list > .monaco-list");
    await expect(commands).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(commands).toBeFocused();
    const command = commands.locator(".monaco-list-row.focused");
    await expect(command).toHaveCSS("outline-style", "none");
    await expect(command).toHaveCSS("background-color", "rgb(110, 143, 210)");
});

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
 * 顶层值控件跟随字段声明，改变声明只会标记草稿中的不兼容值，切回原声明仍可读到完整的已有内容。
 * 需要改成整数时，用户必须明确替换旧值，并直接在数字控件中输入，不另选类型。
 */
test("dataset row editors follow declared field types and preserve mismatches", async ({ page }) => {
    await page.getByRole("button", { name: "Edit synthetic dataset", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Synthetic dataset", exact: true });
    const rows = drawer.getByRole("table", { name: "Dataset rows", exact: true });
    const type = drawer.getByRole("combobox", { name: "Field type", exact: true });
    const original = rows.getByRole("textbox", { name: "name", exact: true });
    await original.fill("Preserve the original");
    await expect(rows.getByRole("combobox", { name: "name Type", exact: true })).toHaveCount(0);

    await type.click();
    await page.getByRole("option", { name: "integer", exact: true }).click();
    await expect(rows.getByText("Expected integer. Current type is string.", { exact: true })).toBeVisible();
    await type.click();
    await page.getByRole("option", { name: "string", exact: true }).click();
    await expect(original).toHaveValue("Preserve the original");

    await type.click();
    await page.getByRole("option", { name: "integer", exact: true }).click();
    await rows.getByRole("button", { name: "Reset value", exact: true }).click();
    const count = rows.getByRole("spinbutton", { name: "name", exact: true });
    await expect(count).toHaveValue("0");
    await expect(count).toHaveAttribute("step", "1");
    await count.press("ControlOrMeta+a");
    await count.pressSequentially("-12");
    await count.press("Tab");
    await expect(count).toHaveValue("-12");
    await count.fill("1.5");
    await count.press("Tab");
    await expect(count).toHaveValue("-12");
    await count.clear();
    await count.press("Tab");
    await expect(count).toHaveValue("-12");

    await type.click();
    await page.getByRole("option", { name: "number", exact: true }).click();
    await expect(type).toBeFocused();
    await expect(count).toHaveValue("-12");
    await expect(count).toHaveAttribute("step", "any");
    await count.press("ControlOrMeta+a");
    await count.pressSequentially("2e-1");
    await count.press("Tab");
    await expect(count).toHaveJSProperty("valueAsNumber", 0.2);

    await type.click();
    await page.getByRole("option", { name: "string", exact: true }).click();
    await type.click();
    await page.getByRole("option", { name: "number", exact: true }).click();
    await expect(count).toHaveJSProperty("valueAsNumber", 0.2);
});

/**
 * 允许空值的字段显式编辑空值与缺失，布尔控件直接使用复选框；对象内未声明类型的属性仍可选择类型。
 */
test("dataset rows distinguish null, missing and nested JSON types", async ({ page }) => {
    await page.getByRole("button", { name: "Edit synthetic dataset", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Synthetic dataset", exact: true });
    const rows = drawer.getByRole("table", { name: "Dataset rows", exact: true });
    const type = drawer.getByRole("combobox", { name: "Field type", exact: true });
    const setNull = rows.getByRole("button", { name: "Set to null", exact: true });
    await type.click();
    await page.getByRole("option", { name: "boolean", exact: true }).click();
    await rows.getByRole("button", { name: "Reset value", exact: true }).click();
    await rows.getByRole("checkbox", { name: "name", exact: true }).check();
    await expect(setNull).toHaveCount(0);
    const nullable = drawer.getByRole("checkbox", { name: "Nullable", exact: true });
    await nullable.check();
    await setNull.click();
    await expect(rows.getByText("null", { exact: true })).toBeVisible();
    await expect(rows.getByRole("checkbox", { name: "name", exact: true })).toHaveCount(0);
    await nullable.uncheck();
    await expect(rows.getByText("Expected boolean. Current type is null.", { exact: true })).toBeVisible();
    await nullable.check();
    await expect(rows.getByText("null", { exact: true })).toBeVisible();
    await rows.getByRole("button", { name: "Edit value", exact: true }).click();
    await expect(rows.getByRole("checkbox", { name: "name", exact: true })).not.toBeChecked();
    await rows.getByRole("button", { name: "Mark missing", exact: true }).click();
    await expect(rows.getByRole("button", { name: "Set name", exact: true })).toBeVisible();

    await type.click();
    await page.getByRole("option", { name: "object", exact: true }).click();
    await rows.getByRole("button", { name: "Set name", exact: true }).click();
    await rows.getByText("JSON value", { exact: true }).click();
    await expect(rows.getByRole("combobox", { name: "name Type", exact: true })).toHaveCount(0);
    await rows.getByRole("textbox", { name: "name Field name", exact: true }).fill("nested");
    await rows.getByRole("button", { name: "Add field", exact: true }).click();
    const nestedType = rows.getByRole("combobox", { name: "name.nested Type", exact: true });
    await nestedType.click();
    await page.getByRole("listbox").getByRole("option", { name: "number", exact: true }).click();
    await expect(rows.getByRole("spinbutton", { name: "name.nested", exact: true })).toHaveValue("0");

    await type.click();
    await page.getByRole("option", { name: "array", exact: true }).click();
    await rows.getByRole("button", { name: "Reset value", exact: true }).click();
    await rows.getByText("JSON value", { exact: true }).click();
    await rows.getByRole("button", { name: "Add value", exact: true }).click();
    await expect(rows.getByRole("combobox", { name: "name Type", exact: true })).toHaveCount(0);
    const elementType = rows.getByRole("combobox", { name: "name[0] Type", exact: true });
    await expect(elementType.getByText("string", { exact: true })).toBeVisible();
});

/**
 * 数据集字段下拉应在可滚动抽屉中响应普通点击，并允许键盘取消后回到触发控件，下一次选择仍可提交到草稿。
 * 用例同时检查按下退出后抽屉仍开启，防止选项浮层抢占抽屉外的焦点或提前关闭编辑会话。
 */
test("dataset field type opens above the drawer and can be changed or dismissed", async ({ page }) => {
    await page.getByRole("button", { name: "Edit synthetic dataset", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Synthetic dataset", exact: true });
    const type = drawer.getByRole("combobox", { name: "Field type", exact: true });
    await type.click();
    const list = page.getByRole("listbox");
    await expect(list).toBeVisible();
    await expect(list.getByRole("option")).toHaveText(["string", "number", "integer", "boolean", "object", "array"]);
    await expect(list.getByRole("option", { name: "string", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(drawer).toBeVisible();
    await expect(type).toBeFocused();
    await type.click();
    await list.getByRole("option", { name: "number", exact: true }).click();
    await expect(type.getByText("number", { exact: true })).toBeVisible();
    await expect(type).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(list.getByRole("option", { name: "number", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(list.getByRole("option", { name: "integer", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(drawer).toBeVisible();
    await expect(type).toBeFocused();
    await expect(type.getByText("number", { exact: true })).toBeVisible();

    await page.keyboard.press("Enter");
    await expect(list.getByRole("option", { name: "number", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(list.getByRole("option", { name: "integer", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(list).toBeHidden();
    await expect(type.getByText("integer", { exact: true })).toBeVisible();
});

/**
 * 窄抽屉仍把格式与文件控件排在同一行，文本占据下面整行，导入按钮与上一项保留足够的可见间距。
 * 字段表通过实际列宽验证空间倾向名称列，并核对字段区上方不会绘制分隔线。
 */
test("dataset drawer lays out fields and import controls in a narrow sheet", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.getByRole("button", { name: "Edit synthetic dataset", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Synthetic dataset", exact: true });
    const columns = drawer.getByRole("table", { name: "Dataset fields" }).getByRole("columnheader");
    const [name, type, required, nullable] = await columns.evaluateAll((headers) =>
        headers.map((header) => header.getBoundingClientRect().width),
    );
    expect(name).toBeGreaterThan(type * 1.5);
    expect(required).toBeLessThan(type);
    expect(nullable).toBeLessThan(type);
    const heading = drawer.getByRole("heading", { name: "Dataset fields", exact: true });
    await expect(heading.locator("..")).toHaveCSS("border-top-width", "0px");
    const tabs = await drawer.getByRole("tablist", { name: "Dataset editor" }).boundingBox();
    const title = await heading.boundingBox();
    if (!tabs || !title) throw new Error("Dataset fields or editor tabs are not rendered");
    expect(title.y).toBeGreaterThanOrEqual(tabs.y + tabs.height);
    expect(Math.abs(tabs.x - title.x)).toBeLessThan(2);

    const addField = drawer.getByRole("button", { name: "Add field", exact: true });
    const addRow = drawer.getByRole("button", { name: "Add row", exact: true });
    await expect(addField).toHaveText("+Add field");
    await expect(addRow).toHaveText("+Add row");
    const fill = await addField.evaluate((button) => getComputedStyle(button).backgroundColor);
    expect(fill).toBe("rgb(70, 95, 255)");
    await expect(addRow).toHaveCSS("background-color", fill);

    const [format, file, input, preview, apply] = await Promise.all([
        drawer.getByRole("combobox", { name: "Import format" }).boundingBox(),
        drawer.getByRole("button", { name: "Choose import file", exact: true }).boundingBox(),
        drawer.getByRole("textbox", { name: "Import text" }).boundingBox(),
        drawer.getByRole("button", { name: "Preview import" }).boundingBox(),
        drawer.getByRole("button", { name: "Apply import" }).boundingBox(),
    ]);
    if (!format || !file || !input || !preview || !apply) throw new Error("Import controls are not rendered");
    expect(Math.abs(format.y - file.y)).toBeLessThan(2);
    expect(format.x + format.width).toBeLessThan(file.x);
    expect(input.width).toBeGreaterThan(file.width);
    expect(input.y).toBeGreaterThan(file.y + file.height);
    expect(preview.y - (input.y + input.height)).toBeGreaterThanOrEqual(8);
    expect(apply.y - (input.y + input.height)).toBeGreaterThanOrEqual(8);
});

/**
 * 用户在同一个抽屉使用菜单成为 JSON 格式导入，修改文本后旧预检会失效，只有最新预检可写入数据行。
 * 鼠标打开的菜单按退出只关闭自身，文件控件与菜单取值联动，通过公开标签观察变化及最终导入结果。
 */
test("dataset import menu selects a format and applies the current preview", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.getByRole("button", { name: "Edit synthetic dataset", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Synthetic dataset", exact: true });
    const format = drawer.getByRole("combobox", { name: "Import format" });
    await format.click();
    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(drawer).toBeVisible();
    await expect(format).toBeFocused();
    await format.click();
    await expect(menu.getByRole("option")).toHaveText(["CSV", "JSON", "Excel (.xlsx)"]);
    const excelLineCount = await menu.getByRole("option", { name: "Excel (.xlsx)" }).evaluate((option) => {
        const text = document.createTreeWalker(option, NodeFilter.SHOW_TEXT).nextNode();
        if (!text) return 0;
        const range = document.createRange();
        range.selectNodeContents(text);
        return range.getClientRects().length;
    });
    expect(excelLineCount).toBe(1);
    await menu.getByRole("option", { name: "JSON", exact: true }).click();
    await expect(format).toBeFocused();
    await expect(drawer.getByLabel("Import file", { exact: true })).toHaveAttribute("accept", ".json");
    const input = drawer.getByRole("textbox", { name: "Import text" });
    const preview = drawer.getByRole("button", { name: "Preview import" });
    const apply = drawer.getByRole("button", { name: "Apply import" });
    await input.fill(JSON.stringify([{ key: "imported", values: { name: "First value" } }]));
    await preview.click();
    await expect(apply).toBeEnabled();
    await input.fill(JSON.stringify([{ key: "imported", values: { name: "Updated value" } }]));
    await expect(apply).toBeDisabled();
    await preview.click();
    await apply.click();
    await expect(drawer.getByRole("textbox", { name: "Row key", exact: true })).toHaveValue("imported");
    await expect(drawer.getByRole("textbox", { name: "name", exact: true })).toHaveValue("Updated value");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
});

/**
 * 首行界定新字段并选用可识别的编号列，预览期间草稿保持原样，应用时字段与带类型的数据行才一起替换。
 * 编号还保留为文本业务字段，行键使用合法前缀，混合类型字段中的数值文本保持原始字符串。
 */
test("dataset CSV import applies inferred fields and identifier-derived row keys together", async ({ page }) => {
    await page.getByRole("button", { name: "Edit synthetic dataset", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Synthetic dataset", exact: true });
    const fields = drawer.getByRole("table", { name: "Dataset fields", exact: true });
    const records = drawer.getByRole("table", { name: "Dataset rows", exact: true });
    const fieldNames = fields.getByRole("textbox", { name: "Field name", exact: true });
    const rowKeys = records.getByRole("textbox", { name: "Row key", exact: true });
    await drawer.getByLabel("Import file", { exact: true }).setInputFiles({
        name: "synthetic-employees.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
            "employee_code,employee_name,enabled,score,department\n001,Ada,true,2,operations\n010,Bo,false,3.5,42",
        ),
    });
    await drawer.getByRole("button", { name: "Preview import" }).click();
    const mapping = drawer.getByRole("table", { name: "Imported column mapping", exact: true });
    await expect(drawer.getByText("Row key uses column employee_code.", { exact: true })).toBeVisible();
    await expect(mapping.getByRole("row", { name: "employee_code employee_code string" })).toBeVisible();
    await expect(mapping.getByRole("row", { name: "enabled enabled boolean" })).toBeVisible();
    await expect(mapping.getByRole("row", { name: "score score number" })).toBeVisible();
    await expect(mapping.getByRole("row", { name: "department department string" })).toBeVisible();
    await expect(drawer.getByText("The blank starter field name will be removed.", { exact: true })).toBeVisible();
    await expect(fieldNames).toHaveCount(1);
    await expect(fieldNames).toHaveValue("name");
    await expect(rowKeys).toHaveValue("row_1");

    await drawer.getByRole("button", { name: "Apply import" }).click();
    expect(await fieldNames.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual([
        "employee_code",
        "employee_name",
        "enabled",
        "score",
        "department",
    ]);
    await expect(rowKeys.nth(0)).toHaveValue("id_001");
    await expect(rowKeys.nth(1)).toHaveValue("id_010");
    await expect(records.getByRole("textbox", { name: "employee_code", exact: true }).first()).toHaveValue("001");
    await expect(records.getByRole("checkbox", { name: "enabled", exact: true }).first()).toBeChecked();
    await expect(records.getByRole("spinbutton", { name: "score", exact: true }).last()).toHaveValue("3.5");
    await expect(records.getByRole("textbox", { name: "department", exact: true }).last()).toHaveValue("42");
});

/**
 * 用树形草稿验证导入预览公开父键列和自动排序，应用后读取实际输入框，确保父引用和同级顺序写入正确的行。
 */
test("dataset tree import previews parent aliases and applies generated sibling orders", async ({ page }) => {
    await page.getByRole("button", { name: "Edit synthetic tree dataset", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Synthetic tree dataset", exact: true });
    const input = drawer.getByRole("textbox", { name: "Import text" });
    await input.fill("parent,id,dept_code,dept_parent\n,001,A,\n001,003,A1,A\n,002,B,\n001,004,A2,A");
    await drawer.getByRole("button", { name: "Preview import" }).click();
    await expect(drawer.getByText(/Parent key uses column parent\./u)).toBeVisible();
    await expect(
        drawer.getByText(/Sibling order will be generated within each parent group in file order\./u),
    ).toBeVisible();
    await drawer.getByRole("button", { name: "Apply import" }).click();
    const records = drawer.getByRole("table", { name: "Dataset rows", exact: true });
    const parents = records.getByRole("combobox", { name: "Parent node", exact: true });
    const orders = records.getByRole("spinbutton", { name: "Sibling order", exact: true });
    await expect(parents).toHaveCount(4);
    await expect(orders).toHaveCount(4);
    expect(await parents.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual([
        "",
        "id_001",
        "",
        "id_001",
    ]);
    expect(await orders.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual([
        "0",
        "0",
        "1",
        "1",
    ]);
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
    const phrase = page.getByRole("textbox", { name: "Synthetic recovery phrase", exact: true });
    await phrase.fill("edited synthetic phrase");
    await expect(phrase).toHaveValue("edited synthetic phrase");
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
 * 嵌套退出只应影响最上层确认框；可见后先验证确认按钮可操作，再发送退出按键，避免仅凭面板出现判断准备完成。
 * 动作试运行不触发确认业务，且不保证键盘监听已就绪；下方仍须验证外层可编辑及计数不变。
 */
test("Escape dismisses only the nested confirmation", async ({ page }) => {
    await page.getByRole("button", { name: "Edit synthetic resource", exact: true }).click();
    await page.getByRole("button", { name: "Archive synthetic resource", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Archive synthetic resource?", exact: true })).toBeVisible();
    await page
        .getByRole("dialog", { name: "Archive synthetic resource?", exact: true })
        .getByRole("button", { name: "Confirm archive", exact: true })
        .click({ trial: true });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Archive synthetic resource?", exact: true })).toBeHidden();
    await expect(page.getByRole("dialog", { name: "Synthetic resource", exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("Archive confirmations: 0");
    const phrase = page.getByRole("textbox", { name: "Synthetic recovery phrase", exact: true });
    await phrase.fill("still editable");
    await expect(phrase).toHaveValue("still editable");
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
 * 焦点从抽屉关闭按钮先进入输入框，再到其下方的字段帮助，确保实际键盘顺序与界面上显示的顺序一致。
 * 字段本身的原生标签用于寻找帮助按钮，既不绑定问号这个缺陷名称，也不要求新增任何隐藏定位标记。
 * 到达帮助后还必须有语义名称、完整可见正文和描述关系，不能仅把按钮放回顺序而丢失建议内容。
 */
test("Tab reaches meaningful field help and exposes its complete advice", async ({ page }) => {
    await page.getByRole("button", { name: "Edit synthetic resource", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Synthetic resource", exact: true });
    const input = drawer.getByRole("textbox", { name: "Synthetic recovery phrase", exact: true });
    const help = drawer.getByRole("button", { name: "Help for Synthetic recovery phrase", exact: true });
    await page.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(input).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(help).toBeFocused();
    const [inputBox, helpBox] = await Promise.all([input.boundingBox(), help.boundingBox()]);
    if (!inputBox || !helpBox) throw new Error("The field and help button must be visible");
    expect(helpBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height);
    await expect(help).toHaveAccessibleName(/Synthetic recovery phrase/i);
    const advice = "Use a unique synthetic recovery phrase. Store it offline and never reuse an account password.";
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveText(advice);
    await expect(tooltip).toBeVisible();
    await expect(tooltip.getByText(advice, { exact: true })).toHaveCSS("font-size", "10px");
    await expect(help).toHaveAccessibleDescription(advice);
    const tooltipBox = await tooltip.boundingBox();
    if (!tooltipBox) throw new Error("The help text must be visible");
    expect(tooltipBox.y).toBeGreaterThanOrEqual(helpBox.y + helpBox.height);
    expect(await adviceIsUnobscured(page, advice), "Every rendered advice character must be above the drawer").toBe(
        true,
    );
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await expect(help).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(drawer.getByRole("button", { name: "Archive synthetic resource", exact: true })).toBeFocused();
});

/**
 * 显式必填字段和隐式可选字段都要经过浏览器测量，帮助文字放在输入框下方并补充原有读屏描述，而不更改字段名。
 */
for (const { name, hint, description, required } of [
    {
        name: "Synthetic nickname",
        hint: "Shown to synthetic peers.",
        description: "Visible to current members. Shown to synthetic peers.",
        required: true,
    },
    {
        name: "Synthetic initials",
        hint: "Used in the avatar.",
        description: "Used in the avatar.",
        required: false,
    },
]) {
    test(`inline guidance follows the control for ${name}`, async ({ page }) => {
        await page.getByRole("button", { name: "Edit synthetic resource", exact: true }).click();
        const drawer = page.getByRole("dialog", { name: "Synthetic resource", exact: true });
        const caption = drawer.locator("label").filter({ has: page.getByText(name, { exact: true }) });
        const label = caption.getByText(name, { exact: true });
        const advice = drawer.getByText(hint, { exact: true });
        const input = drawer.getByRole("textbox", { name, exact: true });
        const [labelBox, inputBox, adviceBox] = await Promise.all([
            label.boundingBox(),
            input.boundingBox(),
            advice.boundingBox(),
        ]);
        if (!labelBox || !inputBox || !adviceBox) throw new Error("The field, label and advice must be visible");
        expect(inputBox.y).toBeGreaterThanOrEqual(labelBox.y + labelBox.height);
        expect(adviceBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height);
        await expect(advice).toHaveCSS("font-size", "10px");
        await expect(input).toHaveAccessibleDescription(description);
        await expect(input).toHaveJSProperty("required", required);

        const marker = caption.getByText("*", { exact: true });
        if (required) {
            await expect(marker).toHaveCSS("color", "rgb(166, 45, 45)");
            const markerBox = await marker.boundingBox();
            if (!markerBox) throw new Error("The required marker must be visible");
            expect(markerBox.x + markerBox.width).toBeLessThanOrEqual(labelBox.x);
            expect(markerBox.y).toBeLessThan(labelBox.y + labelBox.height);
            expect(markerBox.y + markerBox.height).toBeGreaterThan(labelBox.y);
        } else {
            await expect(marker).toHaveCount(0);
        }
    });
}

/**
 * 窄窗口没有足够的三分之一宽度时仍应容纳字段；以键盘往返切换宽度并关闭，确认草稿和入口焦点都能完整保留。
 */
test("third-width drawer keeps its form usable in a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 800 });
    const trigger = page.getByRole("button", { name: "Edit synthetic resource", exact: true });
    await trigger.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Synthetic resource", exact: true });
    await expect(drawer).toHaveCSS("width", "300px");
    await expect(drawer).toHaveCSS("border-radius", "0px");
    const input = drawer.getByRole("textbox", { name: /Synthetic recovery phrase/ });
    await input.fill("Unsaved synthetic advice");
    await drawer.getByRole("button", { name: "Full width", exact: true }).press("Enter");
    await expect(drawer).toHaveCSS("width", "640px");
    const shrink = drawer.getByRole("button", { name: "One third width", exact: true });
    await expect(shrink).toBeFocused();
    await shrink.press("Enter");
    await expect(drawer).toHaveCSS("width", "300px");
    await expect(input).toHaveValue("Unsaved synthetic advice");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
});

/**
 * 从浏览器读取显式按钮档位的命中区域，确认紧凑行操作和常规按钮保持不同的高度，并为键盘留下同样的操作入口。
 */
test("explicit button sizes provide distinct hit areas", async ({ page }) => {
    const compact = page.getByRole("button", { name: "Compact synthetic action", exact: true });
    const regular = page.getByRole("button", { name: "Regular synthetic action", exact: true });
    await expect(compact).toHaveCSS("height", "28px");
    await expect(regular).toHaveCSS("height", "34px");
    await compact.focus();
    await page.keyboard.press("Tab");
    await expect(regular).toBeFocused();
});

/**
 * 两档视口比较表格正文和分页按钮的实际字号及高度，同时检查长页码完整显示并保持键盘换页和边界禁用。
 */
test("pagination follows table typography and fits wide page numbers", async ({ page }) => {
    await page.goto("/tests/interaction-fixture.html?pagination");
    const row = page.getByRole("cell", { name: "Synthetic member", exact: true });
    const navigation = page.getByRole("navigation", { name: "Synthetic table pages", exact: true });
    const previous = navigation.getByRole("button", { name: "Previous", exact: true });
    const current = navigation.getByRole("button", { name: "10001", exact: true });
    const next = navigation.getByRole("button", { name: "Next", exact: true });
    const heights: number[] = [];
    for (const width of [1280, 1440]) {
        await page.setViewportSize({ width, height: 800 });
        const bodySize = await row.evaluate((cell) => getComputedStyle(cell).fontSize);
        for (const button of [previous, current, next]) {
            await expect(button).toHaveCSS("font-size", bodySize);
        }
        const layout = await current.evaluate((button) => {
            const range = document.createRange();
            range.selectNodeContents(button);
            const text = range.getBoundingClientRect();
            const box = button.getBoundingClientRect();
            return { height: box.height, fits: text.left >= box.left && text.right <= box.right };
        });
        expect(layout.height).toBeLessThan(36);
        expect(layout.fits).toBe(true);
        heights.push(layout.height);
    }
    expect(heights[1]).toBeGreaterThan(heights[0]);
    await expect(current).toHaveAttribute("aria-current", "page");
    await next.press("Enter");
    await expect(navigation.getByRole("button", { name: "10002", exact: true })).toHaveAttribute(
        "aria-current",
        "page",
    );
    await expect(next).toBeDisabled();
});

/**
 * 使用鼠标悬停两种页码并读取实际底色以及文字颜色，随后在鼠标仍停留时用键盘聚焦，确保通用焦点颜色仍可辨认。
 */
for (const [theme, plainHover, plainText, focus] of [
    ["light", "rgb(242, 244, 247)", "rgb(52, 64, 84)", "rgb(110, 143, 210)"],
    ["dark", "rgb(38, 50, 68)", "rgb(208, 213, 221)", "rgb(154, 181, 240)"],
] as const) {
    test(`pagination keeps readable hover and keyboard focus in the ${theme} theme`, async ({ page }) => {
        await page.goto("/tests/interaction-fixture.html?pagination");
        await page.locator("html").evaluate((root, theme) => {
            root.dataset.theme = theme;
        }, theme);
        const navigation = page.getByRole("navigation", { name: "Synthetic table pages", exact: true });
        const plain = navigation.getByRole("button", { name: "10000", exact: true });
        const current = navigation.getByRole("button", { name: "10001", exact: true });
        await plain.hover();
        await expect(plain).toHaveCSS("background-color", plainHover);
        await expect(plain).toHaveCSS("color", plainText);
        await expect(current).toHaveCSS("background-color", "rgb(70, 95, 255)");
        await expect(current).toHaveCSS("color", "rgb(255, 255, 255)");

        await current.hover();
        await expect(current).toHaveCSS("background-color", "rgb(54, 65, 245)");
        await expect(current).toHaveCSS("color", "rgb(255, 255, 255)");

        await plain.focus();
        await page.keyboard.press("Tab");
        await expect(current).toBeFocused();
        expect(await current.evaluate((button) => button.matches(":hover:focus-visible"))).toBe(true);
        await expect(current).toHaveCSS("background-color", focus);
        await expect(current).toHaveCSS("color", "rgb(16, 31, 59)");
    });
}

/**
 * 数据集空态、筛选无匹配和仅导入行键时保留各自的表头，说明必须是真实单元格并跨过当前表头所有列。
 */
test("dataset editor keeps column headers above empty results", async ({ page }) => {
    await page.getByRole("button", { name: "Edit synthetic dataset", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Synthetic dataset", exact: true });
    const fields = drawer.getByRole("table", { name: "Dataset fields", exact: true });
    const rows = drawer.getByRole("table", { name: "Dataset rows", exact: true });
    await rows.getByRole("button", { name: "Remove row", exact: true }).click();
    await expect(rows.getByRole("columnheader", { name: "Row key" })).toBeVisible();
    const empty = rows.getByRole("cell", { name: "No dataset rows.", exact: true });
    await expect(empty).toHaveAttribute("colspan", "3");
    await expect(empty).toHaveCSS("text-align", "center");
    await drawer.getByRole("button", { name: "Add row", exact: true }).click();
    await drawer.getByRole("searchbox", { name: "Search row keys", exact: true }).fill("unmatched-row-key");
    const filtered = rows.getByRole("cell", { name: "No matching rows." });
    await expect(filtered).toHaveAttribute("colspan", "3");
    await expect(filtered).toHaveCSS("text-align", "center");
    await fields.getByRole("button", { name: "Remove field", exact: true }).click();
    await expect(fields.getByRole("columnheader", { name: "Field name" })).toBeVisible();
    await expect(fields.getByRole("cell", { name: "No dataset fields." })).toHaveAttribute("colspan", "5");
    await expect(filtered).toHaveAttribute("colspan", "2");

    const mappings = drawer.getByRole("table", { name: "Imported column mapping", exact: true });
    await expect(mappings).toHaveCount(0);
    await drawer.getByRole("textbox", { name: "Import text", exact: true }).fill("key\nimported_row\n");
    await drawer.getByRole("button", { name: "Preview import", exact: true }).click();
    await expect(mappings.getByRole("columnheader")).toHaveText(["File header", "Dataset field", "Field type"]);
    const unmapped = mappings.getByRole("cell", { name: "No column mappings.", exact: true });
    await expect(unmapped).toHaveAttribute("colspan", "3");
    await expect(unmapped).toHaveCSS("text-align", "center");
    await expect(drawer.getByRole("button", { name: "Apply import", exact: true })).toBeEnabled();
});

/**
 * 真实会话组件通过已授权的运行卡委托跟进，跨会话和重新打开后仅显示当前会话任务，停止跟进保留原运行状态。
 */
test("background following survives reopening and leaves the conversation and run independent", async ({ page }) => {
    test.setTimeout(55_000);
    await page.addInitScript(() => localStorage.setItem("veriq.language", "en"));
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const root = `/api/v1/workspaces/${workspaceId}`;
    const base = `${root}/agent/sessions`;
    const first = {
        id: "00000000-0000-4000-8000-000000000003",
        title: "Release tests",
        archived: false,
        createdAt: "2026-01-01T00:00:00Z",
    };
    const second = { ...first, id: "00000000-0000-4000-8000-000000000004", title: "Another conversation" };
    const thread = `${base}/${first.id}`;
    const otherThread = `${base}/${second.id}`;
    const runId = "00000000-0000-4000-8000-000000000005";
    const taskId = "00000000-0000-4000-8000-000000000006";
    const task = { id: taskId, runId, mode: "MANUAL", state: "FOLLOWING" };
    const turn = {
        id: "00000000-0000-4000-8000-000000000007",
        createdAt: first.createdAt,
        text: "Watch this run",
        status: "COMPLETED",
    };
    const proposal = {
        type: "TRIGGER_PLAN",
        planId: "00000000-0000-4000-8000-000000000009",
        planRevision: 1,
        delegateRun: true,
    };
    let created = false;
    let revoked = false;
    let finished = false;
    let analyzing = false;
    let analysis: { basis: string; suggestions: string[] } | undefined;
    const analysisTask = () => ({
        id: "00000000-0000-4000-8000-000000000008",
        runId,
        mode: "MANUAL",
        state: analysis ? "COMPLETED" : "ANALYZING",
        analysis,
    });
    const submissions: Record<string, unknown>[] = [];
    const requests: string[] = [];
    await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const { pathname, searchParams } = new URL(request.url());
        const data = (value: unknown) => route.fulfill({ json: { data: value } });
        if (pathname === root + "/agent/settings") return data({ providerStatus: "READY" });
        if (pathname === base) return data({ items: searchParams.get("archived") === "false" ? [first, second] : [] });
        if (pathname === thread) return data(first);
        if (pathname === otherThread) return data(second);
        if (pathname === thread + "/turns" && request.method() === "GET")
            return data({ items: [{ ...turn, relatedRunId: runId, proposal }] });
        if (pathname === thread + "/turns" && request.method() === "POST") {
            const body = request.postDataJSON();
            submissions.push(body);
            return data({
                ...turn,
                id: body.requestId,
                text: body.text,
                reply: "Plan confirmed.",
                receipt: { type: "TRIGGER_PLAN", planId: proposal.planId, planRevision: 1, runId, decision: "REUSED" },
            });
        }
        if (pathname === otherThread + "/turns" || pathname === otherThread + "/tasks") return data({ items: [] });
        if (pathname === root + `/runs/${runId}/report`) {
            return data({
                run: { id: runId, workspaceId, state: finished ? "FINISHED" : "RUNNING" },
                cases: [],
                statistics: { caseCount: 0 },
                gateAtExecution: { passed: true },
                gateNow: { passed: true },
            });
        }
        if (pathname.endsWith("/events/stream")) return route.abort();
        if (pathname === thread + "/tasks" && request.method() === "GET") {
            if (revoked) return route.fulfill({ status: 404, json: { code: "AGENT_SESSION_NOT_FOUND" } });
            return data({ items: analyzing ? [analysisTask(), task] : created ? [task] : [] });
        }
        requests.push(pathname);
        if (pathname === thread + "/tasks" && request.method() === "POST") {
            const requestId = expect.stringMatching(/^[a-f0-9-]{36}$/);
            if (created) {
                expect(request.postDataJSON()).toEqual({ runId, requestId, analyze: true });
                analyzing = true;
                return data(analysisTask());
            }
            expect(request.postDataJSON()).toEqual({ runId, requestId });
            created = true;
            return data(task);
        }
        if (pathname === thread + "/turns/stream") {
            const message = request.postDataJSON();
            submissions.push(message);
            const reply = { ...turn, id: message.requestId, text: message.text, reply: "Received" };
            return route.fulfill({
                contentType: "text/event-stream",
                body: `event: done\ndata: ${JSON.stringify(reply)}\n\n`,
            });
        }
        if (pathname === `${thread}/tasks/${taskId}/stop` && request.method() === "POST") {
            expect(request.postData()).toBeNull();
            task.state = "STOPPED";
            return data(task);
        }
        return route.abort();
    });
    await page.goto("/tests/interaction-fixture.html?agent-appearance=wide");
    const choose = (title: string) => page.getByRole("button", { name: new RegExp(title) }).click();
    await choose(first.title);
    const report = page.getByRole("region", { name: "Run status" });
    await report.getByRole("button", { name: "Follow in background" }).click();
    const tasks = page.getByRole("region", { name: "Background tasks" });
    await expect(tasks).toContainText("Following run");
    const mode = page.getByRole("combobox", { name: "Run follow-up" });
    await expect(mode).toHaveValue("AUTO");
    await mode.selectOption("SUBAGENT");
    await page.getByRole("textbox", { name: "Message" }).fill("Describe this run");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Received", { exact: true })).toBeVisible();
    expect(submissions[0]?.delegationMode).toEqual("SUBAGENT");
    await expect(mode).toHaveValue("AUTO");
    await mode.selectOption("MAIN");
    await page.getByRole("textbox", { name: "Message" }).fill("confirm action");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Plan confirmed.", { exact: true })).toBeVisible();
    expect(submissions[1]).toEqual({
        text: "confirm action",
        requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
        expectedProposalId: turn.id,
    });
    await choose(second.title);
    await expect(tasks).toHaveCount(0);
    await page.reload();
    await choose(first.title);
    await tasks.getByRole("button", { name: "Stop following" }).click();
    await expect(tasks).toContainText("Stopped following");
    await expect(report).toContainText("RUNNING");
    expect(requests).toEqual([thread + "/tasks", thread + "/turns/stream", `${thread}/tasks/${taskId}/stop`]);
    finished = true;
    await report.getByRole("button", { name: "Refresh run status" }).click();
    await expect(report).toContainText("FINISHED");
    await report.getByRole("button", { name: "Analyze in background" }).click();
    await expect(tasks).toContainText("Analyzing run");
    await expect(tasks.getByRole("button", { name: "Stop following" })).toBeEnabled();
    analysis = { basis: "The readiness check timed out.", suggestions: ["Review the startup log."] };
    await expect(tasks).toContainText(analysis.basis);
    await expect(tasks.getByText(analysis.suggestions[0], { exact: true })).toBeVisible();
    revoked = true;
    await expect(page.getByRole("alert").filter({ hasText: "AGENT_SESSION_NOT_FOUND" })).toBeVisible({
        timeout: 15_000,
    });
    await expect(tasks).toHaveCount(0);
    await expect(report).toHaveCount(0);
});
