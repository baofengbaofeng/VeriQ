/**
 * 管理页用真实账户、会话与授权工作区数据检查分页替换、筛选全量可见摘要以及空表布局，不伪造服务端游标。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { acknowledgeOperation, editorScope } from "../editor-fixture";
import { chooseLanguage } from "../support/console-controls";
import { installed } from "../support/install-console";

/**
 * 通过共享下拉的可访问选项设置每页数量，后续用例用真实的列表响应和可见结果验证新设置。
 */
async function choosePageSize(page: Page, label: string, size: string) {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: size, exact: true }).click();
}

const fixtureAdmin = { email: "browser-admin@example.com", password: "Browser password 123!" };

/**
 * 通过正常账户路由测量密码表单，只提供合成账号的读取响应，不发出改密请求或写入任何真实账户。
 */
test("password submit aligns to the inputs and stacks on compact screens", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => localStorage.setItem("veriq.language", "en"));
    const user = {
        id: randomUUID(),
        email: `password-layout-${randomUUID()}@example.test`,
        displayName: "Password layout account",
        createdAt: "2026-01-01T00:00:00Z",
        systemAdmin: false,
        disabled: false,
    };
    await page.route("**/api/v1/**", async (route) => {
        expect(route.request().method()).toBe("GET");
        const { pathname } = new URL(route.request().url());
        const empty = { items: [], nextCursor: null };
        const response: Record<string, unknown> = {
            "/api/v1/setup": { initialized: true },
            "/api/v1/auth/session": { user, csrfToken: "synthetic" },
            "/api/v1/account": user,
        };
        await route.fulfill({ json: { code: "OK", data: response[pathname] ?? empty } });
    });
    await page.goto("/account");
    await page.getByRole("button", { name: "Change password", exact: true }).click();
    const current = page.locator('input[name="currentPassword"]');
    const next = page.locator('input[name="newPassword"]');
    const submit = page.getByRole("button", { name: "Change password and sign out", exact: true });
    await expect(current).toHaveAccessibleName("Current password");
    await expect(next).toHaveAccessibleName("New password (at least 12 characters)");
    await expect(current).toHaveAccessibleDescription("Enter the password you currently use to sign in.");
    await expect(next).toHaveAccessibleDescription(/12 characters/);
    const positions = async () => {
        const [currentBox, nextBox, submitBox] = await Promise.all([
            current.boundingBox(),
            next.boundingBox(),
            submit.boundingBox(),
        ]);
        if (!currentBox || !nextBox || !submitBox) throw new Error("Expected visible password form controls");
        return { currentBox, nextBox, submitBox };
    };
    for (const theme of ["light", "dark"] as const) {
        await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
        const { currentBox, nextBox, submitBox } = await positions();
        expect(currentBox.width).toBe(320);
        expect(nextBox.width).toBe(currentBox.width);
        expect(nextBox.x).toBeGreaterThan(currentBox.x + currentBox.width);
        expect(submitBox.x).toBeGreaterThan(nextBox.x + nextBox.width);
        expect(submitBox.height).toBe(currentBox.height);
        expect(Math.abs(nextBox.y - currentBox.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(submitBox.y - currentBox.y)).toBeLessThanOrEqual(1);
    }
    await page.setViewportSize({ width: 640, height: 800 });
    const { currentBox, nextBox, submitBox } = await positions();
    expect(nextBox.y).toBeGreaterThan(currentBox.y + currentBox.height);
    expect(submitBox.y).toBeGreaterThan(nextBox.y + nextBox.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(640);
});

/**
 * 创建动作从用户目录打开抽屉，并在真实服务拒绝重复邮箱时保留输入，让管理员可以直接更正后重新提交。
 * 保存成功和每次权限变化都核对服务回读，再检查用户可见的结果提示和焦点恢复。
 */
test("user creation and changes are acknowledged from the directory", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installed(page);
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill(fixtureAdmin.email);
    await page.getByLabel("Password").fill(fixtureAdmin.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Personal information", exact: true })).toBeVisible();
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const headers = { Origin: new URL(page.url()).origin, "X-CSRF-Token": session.csrfToken };
    const displayName = `Directory user ${randomUUID()}`;
    const email = `user-drawer-${randomUUID()}@example.test`;
    const duplicate = `duplicate-${randomUUID()}@example.test`;
    const password = "Synthetic drawer password 123!";
    const existing = await page.request.post("/api/v1/admin/users", {
        headers,
        data: { email: duplicate, displayName: "Existing account", password, systemAdmin: false },
    });
    expect(existing.status()).toBe(201);
    await page.goto("/admin/users");
    const table = page.getByRole("table", { name: "All users", exact: true });
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "User", exact: true })).toHaveCSS("font-size", "12px");
    const filters = page.getByRole("form", { name: "User list filters" });
    await expect(filters.getByRole("searchbox", { name: "Search email or display name" })).toHaveAttribute(
        "placeholder",
        "Search email or display name",
    );
    await expect(filters.getByRole("button", { name: /^Help for/ })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Email", exact: true })).toHaveCount(0);
    const create = page.getByRole("button", { name: "Create user", exact: true });
    await create.click();
    const drawer = page.getByRole("dialog", { name: "Create user", exact: true });
    await expect(drawer).toHaveCSS("width", "480px");
    await expect(drawer).toHaveCSS("border-radius", "0px");
    const emailField = drawer.getByRole("textbox", { name: "Email", exact: true });
    await emailField.fill(duplicate);
    await drawer.getByRole("textbox", { name: "Display name", exact: true }).fill(displayName);
    await drawer.getByLabel("Initial password (at least 12 characters)").fill(password);
    const submit = drawer.getByRole("button", { name: "Create user", exact: true });
    const conflict = page.waitForResponse(
        (response) => response.request().method() === "POST" && response.url().endsWith("/api/v1/admin/users"),
    );
    await submit.click();
    expect((await conflict).status()).toBe(409);
    await acknowledgeOperation(page, "Account already exists", "failed");
    await expect(emailField).toHaveValue(duplicate);
    await emailField.fill(email);
    await submit.click();
    await acknowledgeOperation(page, "User created.");
    await expect(drawer).toHaveCount(0);
    await expect(create).toBeFocused();

    /**
     * 相同邮箱始终从真正的目录查询定位；每次写入后继续操作该行，确认按钮和访问标记由重新读取的状态驱动。
     */
    await page.getByLabel("Search email or display name").fill(email);
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    const row = table.getByRole("row", { name: new RegExp(displayName) });
    await row.getByRole("button", { name: "Disable", exact: true }).click();
    await acknowledgeOperation(page, "User disabled.");
    await expect(row.getByRole("button", { name: "Reset link", exact: true })).toBeDisabled();
    await row.getByRole("button", { name: "Enable", exact: true }).click();
    await acknowledgeOperation(page, "User enabled.");
    await expect(row.getByRole("button", { name: "Reset link", exact: true })).toBeEnabled();
    await row.getByRole("button", { name: "Make admin", exact: true }).click();
    await acknowledgeOperation(page, "System administrator permission granted.");
    await row.getByRole("button", { name: "Remove admin", exact: true }).click();
    await acknowledgeOperation(page, "System administrator permission removed.");
    await expect(row.getByRole("button", { name: "Make admin", exact: true })).toBeEnabled();

    /**
     * 在窄视口中切换暗色主题并读取真实列宽，确保长邮箱和操作列只在目录滚动区内扩展，页面本身不出现横向滚动。
     */
    await page.getByRole("banner").getByRole("button", { name: "Dark mode", pressed: false }).click();
    await chooseLanguage(page, "zh");
    const localizedTable = page.getByRole("table", { name: "全部用户", exact: true });
    await expect(localizedTable).toBeVisible();
    await expect(page.getByRole("button", { name: "创建用户", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 900, height: 760 });
    await expect
        .poll(() =>
            localizedTable.evaluate((element) => {
                const scroller = element.parentElement;
                if (!scroller) return false;
                return (
                    scroller.scrollWidth > scroller.clientWidth &&
                    document.documentElement.scrollWidth === document.documentElement.clientWidth
                );
            }),
        )
        .toBe(true);
});

test("administrator filters apply to the complete result and next page replaces the rows", async ({ page }) => {
    await installed(page);
    const { headers } = await editorScope(page, `user-table-${randomUUID()}`);
    const nickname = `User filter ${randomUUID()}`;
    for (let index = 0; index < 2; index++) {
        const response = await page.request.post("/api/v1/admin/users", {
            headers,
            data: {
                email: `user-table-${randomUUID()}@example.test`,
                displayName: `${nickname} ${index}`,
                password: "Page fixture password 123!",
                systemAdmin: false,
            },
        });
        expect(response.status()).toBe(201);
    }
    await page.goto("/admin/users");
    await page.getByLabel("Search email or display name").fill(nickname);
    await choosePageSize(page, "Users per page", "1");
    await page.getByRole("button", { name: "Apply filters" }).click();
    const rows = page.getByRole("table").locator("tbody tr");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(nickname);
    const user = rows.first().getByRole("cell", { name: /User filter/ });
    await expect(user).toHaveCSS("white-space", "nowrap");
    await expect(user.getByText(/@example\.test$/)).toHaveCSS("display", "inline");
    const first = (await rows.first().textContent()) ?? "";
    const firstEmail = await rows.first().locator("small").innerText();
    const pages = page.getByRole("navigation", { name: "User table pagination" });
    const nextResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/v1/admin/users" && url.searchParams.has("cursor");
    });
    await pages.getByRole("button", { name: "Next" }).click();
    expect((await nextResponse).status()).toBe(200);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(nickname);
    await expect(rows.first()).not.toHaveText(first);
    await expect(page.getByText("Showing 2 to 2 of 2 entries", { exact: true })).toBeVisible();
    const currentEmail = await rows.first().locator("small").innerText();
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const download = await downloading;
    const csv = await readFile(await download.path(), "utf8");
    expect(csv).toContain('"Display name","Email","Access"');
    expect(csv).toContain(currentEmail);
    expect(csv).not.toContain(firstEmail);
    await pages.getByRole("button", { name: "Previous" }).click();
    await expect(rows.first()).toHaveText(first);
});

test("account sessions can be searched, paginated and revoked individually", async ({ page, browser, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installed(page);
    await editorScope(page, `session-table-${randomUUID()}`);
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";
    const other = await browser.newContext({ baseURL, userAgent });
    try {
        const setup = await other.request.get("/api/v1/setup");
        const response = await other.request.post("/api/v1/auth/login", {
            headers: {
                Origin: new URL(setup.url()).origin,
                "X-CSRF-Token": (await setup.json()).data.csrfToken,
                "User-Agent": userAgent,
            },
            data: fixtureAdmin,
        });
        expect(response.status()).toBe(200);
        await page.goto("/account");
        const search = page.getByRole("searchbox", { name: "Search sessions" });
        const revoke = page.getByRole("button", { name: "Revoke all sessions and sign out" });
        const table = page.getByRole("table", { name: "Active sessions" });
        await expect(table).toBeVisible();
        const [searchBox, revokeBox, tableBox] = await Promise.all([
            search.locator("..").boundingBox(),
            revoke.boundingBox(),
            table.boundingBox(),
        ]);
        if (!searchBox || !revokeBox || !tableBox) throw new Error("Expected visible session controls");
        expect(Math.abs(searchBox.y + searchBox.height / 2 - (revokeBox.y + revokeBox.height / 2))).toBeLessThan(1);
        expect(searchBox.x + searchBox.width).toBeLessThan(revokeBox.x);
        expect(revokeBox.x + revokeBox.width).toBeLessThanOrEqual(tableBox.x + tableBox.width);
        await revoke.click();
        const confirmation = page.getByRole("dialog", { name: "Revoke all sessions and sign out" });
        await expect(confirmation).toBeVisible();
        await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(confirmation).toHaveCount(0);
        await choosePageSize(page, "Sessions per page", "1");
        const rows = table.locator("tbody tr");
        const pager = page.getByRole("navigation", { name: "Session table pagination" });
        await expect(rows).toHaveCount(1);
        await pager.getByRole("button", { name: "Next" }).click();
        await expect(pager.locator('[aria-current="page"]')).toHaveText("2");
        await search.fill("This session");
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText("This session");
        await expect(pager.getByRole("button", { name: "Next" })).toBeDisabled();
        await expect(rows.first().getByRole("button", { name: "Revoke session", exact: true })).toHaveCount(0);
        await search.fill("Firefox / Windows");
        const target = rows.filter({ hasText: "Firefox / Windows" });
        await expect(target.locator("time")).toHaveCount(3);
        const revokeTarget = target.getByRole("button", { name: "Revoke session", exact: true });
        const revokeDialog = page.getByRole("dialog", { name: "Revoke session", exact: true });
        await revokeTarget.click();
        await expect(revokeDialog).toContainText("Firefox / Windows");
        await revokeDialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(revokeTarget).toBeFocused();
        expect((await other.request.get("/api/v1/auth/session")).status()).toBe(200);
        await revokeTarget.click();
        await revokeDialog.getByRole("button", { name: "Revoke session", exact: true }).click();
        await acknowledgeOperation(page, "Session revoked.");
        await expect(target).toHaveCount(0);
        expect((await other.request.get("/api/v1/auth/session")).status()).toBe(401);
        expect((await page.request.get("/api/v1/auth/session")).status()).toBe(200);
        await search.fill("This session");
        await expect(rows.first()).toContainText("This session");
        await expect(page).toHaveURL("/account");
    } finally {
        await other.close();
    }
});

test("workspace identity tables search across pages without displaying credential values", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `identity-tables-${randomUUID()}`);
    const workspace = `/api/v1/workspaces/${workspaceId}`;
    for (let index = 0; index < 11; index++) {
        const adapter = await page.request.post(`${workspace}/auth-adapters`, {
            headers,
            data: { configuration: { kind: "HTTP_BEARER", identityPath: `/me${index}`, identityPointer: "/id" } },
        });
        expect(adapter.status()).toBe(201);
        const credential = await page.request.post(`${workspace}/credentials`, {
            headers,
            data: { secretRef: `sample_${index}`, allowedIdentityIds: ["reader"], value: { token: "private-fixture" } },
        });
        expect(credential.status()).toBe(201);
    }
    await page.goto(`/workspaces?tab=auth-credentials&workspaceId=${workspaceId}`);
    const adapterTable = page.getByRole("table", { name: "Authentication adapter versions" });
    await expect(adapterTable.locator("tbody tr")).toHaveCount(10);
    const adapterPages = page.getByRole("navigation", { name: "Adapter table pagination" });
    await adapterPages.getByRole("button", { name: "Next" }).click();
    await expect(adapterTable.locator("tbody tr")).toHaveCount(1);
    await page.getByRole("searchbox", { name: "Search adapter versions" }).fill("/me10");
    await expect(adapterTable.getByRole("cell", { name: "/me10", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Credential versions", exact: true }).click();
    const credentials = page.getByRole("table", { name: "Credential version list" });
    await expect(credentials.locator("tbody tr")).toHaveCount(10);
    const credentialPages = page.getByRole("navigation", { name: "Credential table pagination" });
    await credentialPages.getByRole("button", { name: "Next" }).click();
    await expect(credentials.locator("tbody tr")).toHaveCount(1);
    const credentialSearch = page.getByRole("searchbox", { name: "Search credential versions" });
    await credentialSearch.fill("sample_10");
    await expect(credentialPages.locator('[aria-current="page"]')).toHaveText("1");
    await expect(credentials.locator("tbody tr")).toHaveCount(1);
    await expect(credentials.getByRole("cell", { name: "sample_10", exact: true })).toBeVisible();
    await expect(credentials).not.toContainText("private-fixture");
    const download = page.waitForEvent("download");
    await page
        .getByRole("tabpanel", { name: "Credential versions", exact: true })
        .getByRole("button", { name: "Download", exact: true })
        .click();
    const path = await (await download).path();
    if (!path) throw new Error("Credential metadata CSV was not downloaded");
    const csv = await readFile(path, "utf8");
    expect(csv).toContain('"sample_10"');
    expect(csv).not.toContain('"sample_0"');
    expect(csv).not.toContain("private-fixture");
    await credentialSearch.fill("private-fixture");
    await expect(credentials).toContainText("No matching credential versions.");
});

/**
 * 从可写的真实工作区切到归档状态，通过原有管理权限读取两份版本摘要和详情，确认归档后只剩读取入口。
 */
test("archived workspace shows authentication and credential versions read-only", async ({ page }) => {
    await installed(page);
    const { workspaceId, headers } = await editorScope(page, `identity-archive-${randomUUID()}`);
    const base = `/api/v1/workspaces/${workspaceId}`;
    const configuration = {
        kind: "HTTP_SESSION",
        identityPath: "/identity-archive",
        identityPointer: "/id",
        loginPath: "/archive-test-login",
    };
    const adapter = await page.request.post(`${base}/auth-adapters`, { headers, data: { configuration } });
    expect(adapter.status()).toBe(201);
    const adapterId: string = (await adapter.json()).data.versionId;
    const syntheticToken = "archive-table-synthetic-test-value";
    const credential = await page.request.post(`${base}/credentials`, {
        headers,
        data: { secretRef: "archived_example", allowedIdentityIds: ["reader"], value: { token: syntheticToken } },
    });
    expect(credential.status()).toBe(201);
    const credentialId: string = (await credential.json()).data.versionId;

    await page.goto(`/workspaces?tab=auth-credentials&workspaceId=${workspaceId}`);
    const outerTab = page.getByRole("tab", { name: "Authentication and credentials", exact: true });
    const identity = page.getByRole("tabpanel", { name: "Authentication and credentials", exact: true });
    await expect(identity.getByRole("button", { name: "Create adapter version" })).toBeVisible();
    await expect(identity.getByRole("button", { name: "Revoke", exact: true })).toBeVisible();
    const credentialTab = identity.getByRole("tab", { name: "Credential versions", exact: true });
    await credentialTab.click();
    await expect(identity.getByRole("combobox", { name: "Operation", exact: true })).toBeVisible();
    await expect(identity.getByRole("button", { name: "Save credential version" })).toBeVisible();
    await expect(identity.getByRole("button", { name: "Revoke", exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Basic information", exact: true }).click();
    await page.getByRole("button", { name: "Archive Workspace", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Archive Workspace", exact: true });
    await confirm.getByRole("button", { name: "Archive Workspace", exact: true }).click();
    await acknowledgeOperation(page, "Workspace archived");
    const rejected = await page.request.post(`${base}/auth-adapters`, { headers, data: { configuration } });
    expect(rejected.status()).toBe(409);
    expect((await rejected.json()).code).toBe("WORKSPACE_ARCHIVED");

    /**
     * 保存了实际返回的版本号，归档后必须观察到重新读取并查看同一版本，避免旧缓存掩盖失败的查询。
     */
    const read = (name: string) =>
        page.waitForResponse(
            (response) =>
                response.request().method() === "GET" && new URL(response.url()).pathname === `${base}/${name}`,
        );
    const adapterRead = read("auth-adapters");
    const credentialRead = read("credentials");
    await outerTab.click();
    await expect(identity).toContainText("Archived Workspaces are read-only.");
    const adapters = identity.getByRole("table", { name: "Authentication adapter versions" });
    await expect(adapters.getByRole("cell", { name: adapterId, exact: true })).toBeVisible();
    expect((await adapterRead).status()).toBe(200);
    const credentialPage = await credentialRead;
    expect(credentialPage.status()).toBe(200);
    expect(JSON.stringify(await credentialPage.json())).not.toContain(syntheticToken);
    await expect(identity.getByRole("button", { name: "Create adapter version" })).toHaveCount(0);
    await expect(identity.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);
    await expect(identity.getByRole("navigation", { name: "Adapter table pagination" })).toBeVisible();
    await identity.getByRole("searchbox", { name: "Search adapter versions" }).fill(adapterId);
    await adapters.getByRole("button", { name: `Adapter details for ${adapterId}` }).click();
    const adapterDetails = page.getByRole("dialog", { name: "Authentication adapter details" });
    await expect(adapterDetails).toContainText("/archive-test-login");
    await adapterDetails.getByRole("button", { name: "Close" }).click();

    await credentialTab.click();
    const credentials = identity.getByRole("table", { name: "Credential version list" });
    await expect(credentials.getByRole("cell", { name: "archived_example", exact: true })).toBeVisible();
    await expect(identity.getByRole("combobox", { name: "Operation", exact: true })).toHaveCount(0);
    await expect(identity.getByRole("button", { name: "Save credential version" })).toHaveCount(0);
    await expect(identity.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);
    await expect(identity.getByRole("navigation", { name: "Credential table pagination" })).toBeVisible();
    await identity.getByRole("searchbox", { name: "Search credential versions" }).fill("reader");
    await credentials.getByRole("button", { name: `Credential details for ${credentialId}` }).click();
    const credentialDetails = page.getByRole("dialog", { name: "Credential version details" });
    await expect(credentialDetails).toContainText("reader");
    await expect(credentialDetails).not.toContainText(syntheticToken);
});
