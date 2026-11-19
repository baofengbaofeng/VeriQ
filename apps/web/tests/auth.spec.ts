import { profileButton, signOut } from "./support/console-controls";
import { test, expect, type APIResponse, type Page, type Route } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { holdAuthResponse } from "./support/hold-auth-response";
import { withCleanup } from "./support/case-profile-cleanup";
import { restoreTestAdmin, type TestAdminRecovery } from "./support/restore-test-admin";

const ownedCleanups = new Set<() => Promise<void>>();
let pendingAdminRecovery: TestAdminRecovery | undefined;

/**
 * 屏障清理注册为单一可等待的承诺，正常 finally 与超时后的钩子复用同一结算，不能重复转发同一个已处理请求。
 * 完成的任务立即退注册；失败仍原样抛出，不靠忽略路由错误或重试请求制造页面取消、退出或角色恢复的成功。
 */
function ownCleanup(action: () => Promise<void>): () => Promise<void> {
    let completion: Promise<void> | undefined;
    const cleanup = () => {
        completion ??= action().finally(() => ownedCleanups.delete(cleanup));
        return completion;
    };
    ownedCleanups.add(cleanup);
    return cleanup;
}

/**
 * 每项清理都须得到自己的执行机会，先前失败经既有结算器与后续失败合并，保留原始对象、顺序与首因而不覆盖正文异常。
 * 这里仅串行释放测试自己的屏障和证据任务，不清空其它处理器，也不把任何真实后端失败降级为可忽略结果。
 */
async function settleCleanups(...actions: (() => Promise<void>)[]): Promise<void> {
    const [next, ...remaining] = actions;
    if (next) await withCleanup(next, () => settleCleanups(...remaining));
}

test.beforeEach(() => {
    ownedCleanups.clear();
    pendingAdminRecovery = undefined;
});

/**
 * 失败恢复使用原生测试结束钩子的独立结算阶段，正文超时也不能跳过；正常 GUI 路径成功时不通过 API 替代角色恢复。
 * 先释放并等待当前测试拥有的屏障，再用已经创建的备用管理员恢复已知目标；框架保留正文错误，辅助函数保留恢复与释放错误。
 */
test.afterEach(async ({ page: _page }, testInfo) => {
    const recovery = pendingAdminRecovery;
    pendingAdminRecovery = undefined;
    await withCleanup(
        () => settleCleanups(...ownedCleanups),
        async () => {
            if (testInfo.status !== testInfo.expectedStatus && recovery) await restoreTestAdmin(recovery);
        },
    );
});

/**
 * 屏障只延迟首个匹配路径及指定方法的真实本机响应，后续请求直接访问后端；持有的状态、头和正文原样交还浏览器，释放操作可
 * 重复调用以覆盖失败清理路径。
 */
async function holdBackendResponse(page: Page, pathname: string, method = "GET") {
    let resolveHeld!: (response: APIResponse) => void;
    let releaseResponse!: () => void;
    let complete!: () => void;
    let captured = false;
    const held = new Promise<APIResponse>((resolve) => {
        resolveHeld = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        releaseResponse = resolve;
    });
    const done = new Promise<void>((resolve) => {
        complete = resolve;
    });
    const match = (url: URL) => url.origin === "http://127.0.0.1:5173" && url.pathname === pathname;
    const handler = async (route: Route) => {
        if (captured || route.request().method() !== method) {
            await route.continue();
            return;
        }
        captured = true;
        try {
            const response = await route.fetch();
            resolveHeld(response);
            await gate;
            await route.fulfill({ response });
        } finally {
            complete();
        }
    };
    await page.route(match, handler);
    return {
        held,
        release: ownCleanup(async () => {
            releaseResponse();
            if (captured) await done;
            await page.unroute(match, handler);
        }),
    };
}

/**
 * 请求屏障在真实后端处理之前暂停首个匹配路径及方法的本机请求，释放时继续发送原始内容而不构造响应；重复释放与 finally
 * 清理均等待请求确实离开处理器，避免悬挂路由。
 */
async function holdOutgoingRequest(page: Page, pathname = "/api/v1/auth/logout", method = "POST") {
    let resolveHeld!: () => void;
    let releaseRequest!: () => void;
    let complete!: () => void;
    let captured = false;
    const held = new Promise<void>((resolve) => {
        resolveHeld = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        releaseRequest = resolve;
    });
    const done = new Promise<void>((resolve) => {
        complete = resolve;
    });
    const match = (url: URL) => url.origin === "http://127.0.0.1:5173" && url.pathname === pathname;
    const handler = async (route: Route) => {
        if (captured || route.request().method() !== method) {
            await route.continue();
            return;
        }
        captured = true;
        resolveHeld();
        try {
            await gate;
            await route.continue();
        } finally {
            complete();
        }
    };
    await page.route(match, handler);
    return {
        held,
        forward: ownCleanup(async () => {
            releaseRequest();
            if (captured) await done;
            await page.unroute(match, handler);
        }),
    };
}

test("real setup, login, account, administration and one-time reset", async ({ page }, testInfo) => {
    test.setTimeout(30_000);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Set up VeriQ" })).toBeVisible();
    await page.getByLabel(/^Installation secret/).fill("wrong-secret");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByRole("textbox", { name: /^Display name/ }).fill("Browser Administrator");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Create administrator" }).click();
    await expect(page.getByRole("alert")).toContainText("Installation secret is invalid");
    await page.getByLabel(/^Installation secret/).fill("browser-operator-secret");
    await page.getByRole("button", { name: "Create administrator" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("incorrect");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("Email or password is incorrect");
    await page.getByLabel("Password").fill("Browser password 123!");
    const loginNavigations: string[] = [];
    const recordLoginNavigation = (frame: import("@playwright/test").Frame) => {
        if (frame === page.mainFrame()) loginNavigations.push(new URL(frame.url()).pathname);
    };
    page.on("framenavigated", recordLoginNavigation);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toContainText("Browser Administrator");
    await expect(page.getByRole("list")).toContainText("This session");
    expect(loginNavigations.filter((path) => path === "/account")).toHaveLength(1);
    page.off("framenavigated", recordLoginNavigation);
    const otherContext = await page.context().browser()!.newContext();
    const origin = "http://127.0.0.1:5173";
    const otherSetup = await otherContext.request.get(origin + "/api/v1/setup");
    const otherLogin = await otherContext.request.post(origin + "/api/v1/auth/login", {
        headers: {
            Origin: origin,
            "X-CSRF-Token": (await otherSetup.json()).data.csrfToken,
        },
        data: {
            email: "browser-admin@example.com",
            password: "Browser password 123!",
        },
    });
    expect(otherLogin.status()).toBe(200);
    await otherContext.close();
    await expect(page.getByLabel("Sessions per page")).toBeVisible();
    await page.getByLabel("Sessions per page").selectOption("1");
    await expect(page.getByRole("list").getByRole("listitem")).toHaveCount(1);
    await page.getByRole("button", { name: "Load more sessions" }).click();
    await expect(page.getByRole("list").getByRole("listitem")).toHaveCount(2);

    await page.getByRole("link", { name: "Users", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Email" }).fill("browser-user@example.com");
    await page.getByRole("textbox", { name: /^Display name/ }).fill("Browser User");
    await page.getByLabel("Password").fill("Initial password 123!");
    await page.getByRole("button", { name: "Create user" }).click();
    const row = page.getByRole("row", { name: "browser-user@example.com" });
    await expect(row).toContainText("Browser User");
    await page.getByLabel("Users per page").selectOption("1");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByRole("table").getByRole("row")).toHaveCount(2);
    await page.getByRole("button", { name: "Load more users" }).click();
    await expect(page.getByRole("table").getByRole("row")).toHaveCount(3);
    await page.getByLabel("Search email or display name").fill("browser-user");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(row).toBeVisible();
    await expect(page.getByRole("row", { name: "browser-admin@example.com" })).toHaveCount(0);
    await page.getByLabel("Account status").selectOption("true");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByText("No users found.", { exact: true })).toBeVisible();
    await page.getByLabel("Search email or display name").fill("");
    await page.getByLabel("Account status").selectOption("");
    await page.getByLabel("Users per page").selectOption("25");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(row).toBeVisible();

    await page
        .getByRole("row", { name: "browser-admin@example.com" })
        .getByRole("button", { name: "Disable", exact: true })
        .click();
    await expect(page.getByRole("alert")).toContainText("Create another enabled system administrator first");
    await row.getByRole("button", { name: "Make admin", exact: true }).click();
    await expect(row).toContainText("System administrator");
    await row.getByRole("button", { name: "Remove admin", exact: true }).click();
    await row.getByRole("button", { name: "Disable", exact: true }).click();
    await expect(row).toContainText("Disabled");
    await row.getByRole("button", { name: "Enable", exact: true }).click();
    await row.getByRole("button", { name: "Revoke sessions", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Sessions revoked");
    await row.getByRole("button", { name: "Reset link", exact: true }).click();
    const link = await page.getByLabel("Reset link").inputValue();
    expect(link).toContain("/reset/confirm#token=");
    await page.screenshot({
        path: testInfo.outputPath("admin-users.png"),
        fullPage: true,
        mask: [page.getByLabel("Reset link")],
    });
    await signOut(page);
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await page.getByLabel(/^New password \(at least 12 characters\)/).fill("Changed password 123!");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByRole("status")).toContainText("Password updated");
    await page.getByRole("link", { name: "Sign in", exact: true }).last().click();
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await page.getByRole("textbox", { name: "Email" }).fill("browser-user@example.com");
    await page.getByLabel("Password").fill("Changed password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toContainText("Browser User");
    await expect(page.getByRole("link", { name: "Users", exact: true })).toHaveCount(0);
    await page.goto("/admin/users");
    await expect(page.getByRole("alert")).toContainText("System administrator permission");
    await page.goto("/account");
    await expect(page.getByRole("heading", { level: 1, name: "Profile", exact: true })).toBeVisible();
    await page.getByLabel("Current password").fill("Changed password 123!");
    await page.getByLabel(/^New password \(at least 12 characters\)/).fill("Final password 123!");
    const passwordNavigations: string[] = [];
    const recordPasswordNavigation = (frame: import("@playwright/test").Frame) => {
        if (frame === page.mainFrame()) passwordNavigations.push(new URL(frame.url()).pathname);
    };
    page.on("framenavigated", recordPasswordNavigation);
    await page.getByRole("button", { name: "Change password and sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    expect(passwordNavigations.filter((path) => path === "/login")).toHaveLength(1);
    page.off("framenavigated", recordPasswordNavigation);
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
    await page.getByRole("textbox", { name: "Email" }).fill("unknown@example.com");
    await page.getByRole("button", { name: "Request password reset" }).click();
    await expect(page.getByRole("status")).toContainText("If this account is eligible");
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await page.getByLabel(/^New password \(at least 12 characters\)/).fill("Rejected password 123!");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByRole("alert")).toContainText("Reset link is invalid or expired");
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await page.getByRole("textbox", { name: "Email" }).fill("browser-user@example.com");
    await page.getByLabel("Password").fill("Final password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: "Revoke all sessions and sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await page.goto("/reset/confirm");
    await expect(page.getByRole("alert")).toContainText("missing its token");

    /**
     * 先保留原有安装、重置、改密和撤销闭环，再创建第二位真实管理员，使自降权不会绕过服务端最后管理员保护；随后延迟实际
     * 账户响应验证退出意图优先。
     */
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toContainText("Browser Administrator");
    await page.getByRole("link", { name: "Users", exact: true }).click();
    await page.getByRole("textbox", { name: "Email" }).fill("browser-second-admin@example.com");
    await page.getByRole("textbox", { name: /^Display name/ }).fill("Second Administrator");
    await page.getByLabel("Password").fill("Second password 123!");
    await page.getByRole("checkbox", { name: "System administrator", exact: true }).check();
    await page.getByRole("button", { name: "Create user" }).click();
    await expect(page.getByRole("row", { name: "browser-second-admin@example.com" })).toBeVisible();
    await expect(page.getByRole("row", { name: "browser-second-admin@example.com" })).toContainText(
        "System administrator",
    );

    /**
     * 查询次数只涵盖已握手的本次交互窗口；非受控草稿必须等 Apply 才生效，More 则继续使用先前提交的查询与游标，不能读取
     * 未提交的输入。
     */
    const userQueries: URL[] = [];
    const recordUsers = (request: import("@playwright/test").Request) => {
        const url = new URL(request.url());
        if (request.method() === "GET" && url.pathname === "/api/v1/admin/users") userQueries.push(url);
    };
    page.on("request", recordUsers);
    await page.getByLabel("Search email or display name").fill("browser-");
    await page.getByLabel("Account status").selectOption("false");
    await page.getByRole("combobox", { name: "Permission", exact: true }).selectOption("");
    await page.getByLabel("Users per page").selectOption("1");
    expect(userQueries).toHaveLength(0);
    const applied = page.waitForResponse(
        (response) =>
            response.request().method() === "GET" && new URL(response.url()).pathname === "/api/v1/admin/users",
    );
    await page.getByRole("button", { name: "Apply filters" }).click();
    expect((await applied).status()).toBe(200);
    await expect(page.getByRole("table").getByRole("row")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Apply filters" })).toBeEnabled();
    expect(userQueries).toHaveLength(1);
    expect(userQueries[0].searchParams.get("cursor")).toBeNull();
    await page.getByLabel("Search email or display name").fill("unsubmitted-draft");
    expect(userQueries).toHaveLength(1);
    const more = page.waitForResponse(
        (response) =>
            response.request().method() === "GET" && new URL(response.url()).pathname === "/api/v1/admin/users",
    );
    await page.getByRole("button", { name: "Load more users" }).click();
    expect((await more).status()).toBe(200);
    await expect(page.getByRole("table").getByRole("row")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Load more users" })).toBeEnabled();
    expect(userQueries).toHaveLength(2);
    expect(userQueries[1].searchParams.get("q")).toBe("browser-");
    expect(userQueries[1].searchParams.get("disabled")).toBe("false");
    expect(userQueries[1].searchParams.get("limit")).toBe("1");
    expect(userQueries[1].searchParams.get("cursor")).toBeTruthy();
    page.off("request", recordUsers);
    await page.getByLabel("Search email or display name").fill("");
    await page.getByLabel("Users per page").selectOption("25");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByRole("row", { name: "browser-admin@example.com" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply filters" })).toBeEnabled();

    /**
     * 自降权的真实写入先成功但响应尚未到达界面时点击退出，旧操作随后不能抢走退出意图；以原表单恢复可用或真实权限面板出
     * 现作为回调收敛信号，不等待修复后可以省去的账户请求。
     */
    const actorResponse = await page.request.get(`${origin}/api/v1/account`);
    expect(actorResponse.status()).toBe(200);
    const actorId = (await actorResponse.json()).data.id;
    const recoveryOptions: TestAdminRecovery = {
        origin,
        targetId: actorId,
        targetEmail: "browser-admin@example.com",
        backupEmail: "browser-second-admin@example.com",
        backupPassword: "Second password 123!",
    };
    const mutationBarrier = await holdBackendResponse(page, `/api/v1/admin/users/${actorId}`, "PATCH");
    const outgoingLogout = await holdOutgoingRequest(page);
    const logoutIntentEvents: { event: string; path?: string; status?: number }[] = [];
    const recordIntentResponse = (response: import("@playwright/test").Response) => {
        const path = new URL(response.url()).pathname;
        if (
            [
                `/api/v1/admin/users/${actorId}`,
                "/api/v1/auth/logout",
                "/api/v1/auth/session",
                "/api/v1/account",
            ].includes(path)
        )
            logoutIntentEvents.push({ event: "response", path, status: response.status() });
    };
    page.on("response", recordIntentResponse);
    const verifyLogoutIntent = async () => {
        pendingAdminRecovery = recoveryOptions;
        await page
            .getByRole("row", { name: "browser-admin@example.com" })
            .getByRole("button", { name: "Remove admin", exact: true })
            .click();
        const heldUpdate = await mutationBarrier.held;
        expect(heldUpdate.status()).toBe(200);
        expect((await heldUpdate.json()).data.systemAdmin).toBe(false);
        logoutIntentEvents.push({ event: "real-self-update-held", status: heldUpdate.status() });
        const createUserForm = page.locator("form").filter({
            has: page.getByRole("checkbox", { name: "System administrator", exact: true }),
        });
        const createUserSubmit = createUserForm.getByRole("button");
        await expect(createUserSubmit).toHaveText("Working…");
        await expect(createUserSubmit).toBeDisabled();
        await signOut(page);
        await outgoingLogout.held;
        logoutIntentEvents.push({ event: "outgoing-logout-held-before-backend" });
        const updateDelivered = page.waitForResponse(
            (response) =>
                response.request().method() === "PATCH" &&
                new URL(response.url()).pathname === `/api/v1/admin/users/${actorId}`,
        );
        await mutationBarrier.release();
        await (await updateDelivered).finished();
        await expect(
            page
                .getByRole("button", { name: "Create user", disabled: false })
                .or(page.getByRole("heading", { name: "Access restricted" })),
        ).toBeVisible();
        logoutIntentEvents.push({ event: "old-mutation-callback-ui-settled" });
        const completedLogout = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/auth/logout",
        );
        await outgoingLogout.forward();
        logoutIntentEvents.push({ event: "logout-forwarded-to-real-backend" });
        expect((await completedLogout).status()).toBe(200);
        await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
        await expect(profileButton(page)).toHaveCount(0);
        logoutIntentEvents.push({ event: "signed-out-ui-confirmed" });
    };
    await withCleanup(verifyLogoutIntent, async () => {
        await settleCleanups(mutationBarrier.release, outgoingLogout.forward, async () => {
            page.off("response", recordIntentResponse);
            const eventPath = testInfo.outputPath("logout-intent-events.json");
            await writeFile(eventPath, JSON.stringify(logoutIntentEvents, null, 2));
            await testInfo.attach("logout-intent-events", {
                path: eventPath,
                contentType: "application/json",
            });
        });
    });
    await page.getByRole("textbox", { name: "Email" }).fill("browser-second-admin@example.com");
    await page.getByLabel("Password").fill("Second password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toContainText("Second Administrator");
    await page.getByRole("link", { name: "Users", exact: true }).click();
    await page
        .getByRole("row", { name: "browser-admin@example.com" })
        .getByRole("button", { name: "Make admin", exact: true })
        .click();
    await expect(page.getByRole("row", { name: "browser-admin@example.com" })).toContainText("System administrator");
    pendingAdminRecovery = undefined;
    await signOut(page);
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toContainText("Browser Administrator");
    await page.getByRole("link", { name: "Users", exact: true }).click();
    await expect(page.getByRole("row", { name: "browser-admin@example.com" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create user" })).toBeEnabled();

    /**
     * 旧账户回写可能短暂跳转账户页后又被真实会话 401 清除，因此记录释放响应到主动登录前的导航窗口，不能只检查最终登录
     * 页而漏掉已经发生的身份复活。
     */
    const staleAccountNavigations: string[] = [];
    const ownershipEvents: { event: string; path?: string; status?: number }[] = [];
    const recordOwnershipResponse = (response: import("@playwright/test").Response) => {
        const path = new URL(response.url()).pathname;
        if (
            ["/api/v1/account", "/api/v1/account/sessions", "/api/v1/auth/logout", "/api/v1/auth/session"].includes(
                path,
            )
        )
            ownershipEvents.push({ event: "response", path, status: response.status() });
    };
    page.on("response", recordOwnershipResponse);
    const recordStaleAccount = (frame: import("@playwright/test").Frame) => {
        if (frame === page.mainFrame() && new URL(frame.url()).pathname === "/account")
            staleAccountNavigations.push(frame.url());
        if (frame === page.mainFrame())
            ownershipEvents.push({ event: "navigation", path: new URL(frame.url()).pathname });
    };
    const accountBarrier = await holdBackendResponse(page, "/api/v1/account");
    const verifyAccountOwnership = async () => {
        pendingAdminRecovery = recoveryOptions;
        await page
            .getByRole("row", { name: "browser-admin@example.com" })
            .getByRole("button", { name: "Remove admin", exact: true })
            .click();
        const held = await accountBarrier.held;
        expect(held.status()).toBe(200);
        expect((await held.json()).data.systemAdmin).toBe(false);
        ownershipEvents.push({ event: "real-demoted-account-held", status: held.status() });
        const logout = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/auth/logout");
        const expired = page.waitForResponse(
            (response) => new URL(response.url()).pathname === "/api/v1/auth/session" && response.status() === 401,
        );
        await signOut(page);
        expect((await logout).status()).toBe(200);
        await expired;
        await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
        const released = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/account");
        page.on("framenavigated", recordStaleAccount);
        await accountBarrier.release();
        await (await released).finished();
        ownershipEvents.push({ event: "held-account-body-finished" });
        await page.getByRole("textbox", { name: "Email" }).click();
        await page.getByRole("textbox", { name: "Email" }).fill("browser-user@example.com");
        await page.getByLabel("Password").fill("Final password 123!");
        await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
        await expect(page.locator("dl")).toHaveCount(0);
        await expect(page.getByRole("link", { name: "Users", exact: true })).toHaveCount(0);
        expect(staleAccountNavigations).toHaveLength(0);
        page.off("framenavigated", recordStaleAccount);
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.locator("dl")).toContainText("Browser User");
    };
    await withCleanup(verifyAccountOwnership, async () => {
        page.off("framenavigated", recordStaleAccount);
        page.off("response", recordOwnershipResponse);
        await settleCleanups(accountBarrier.release, async () => {
            const eventPath = testInfo.outputPath("account-ownership-events.json");
            await writeFile(eventPath, JSON.stringify(ownershipEvents, null, 2));
            await testInfo.attach("account-ownership-events", {
                path: eventPath,
                contentType: "application/json",
            });
        });
    });

    /**
     * 对首个精确会话列表请求只注入一次网络故障，以真实后端重试恢复首屏；随后持有实际分页响应并切换身份，验证旧列表不会
     * 污染新账户或恢复旧游标。
     */
    await page.getByRole("link", { name: "Workspace settings", exact: true }).click();
    await page.route(
        (url) =>
            url.origin === origin &&
            url.pathname === "/api/v1/account/sessions" &&
            url.searchParams.get("limit") === "25" &&
            !url.searchParams.has("cursor"),
        (route) => (route.request().method() === "GET" ? route.abort("failed") : route.continue()),
        { times: 1 },
    );
    await page.getByRole("button", { name: "Browser User", exact: true }).click();
    await page.getByRole("menuitem", { name: "Account settings", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry sessions" })).toBeVisible();
    await page.getByRole("button", { name: "Retry sessions" }).click();
    await expect(page.getByRole("list").getByRole("listitem")).toHaveCount(1);
    await expect(page.getByLabel("Sessions per page")).toBeEnabled();
    const sessionBarrier = await holdBackendResponse(page, "/api/v1/account/sessions");
    const verifySessionOwnership = async () => {
        await page.getByLabel("Sessions per page").selectOption("1");
        expect((await sessionBarrier.held).status()).toBe(200);
        await signOut(page);
        await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
        await page.getByRole("textbox", { name: "Email" }).fill("browser-second-admin@example.com");
        await page.getByLabel("Password").fill("Second password 123!");
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.locator("dl")).toContainText("Second Administrator");
        await expect(page.getByRole("list").getByRole("listitem")).toHaveCount(1);
        await sessionBarrier.release();
        await expect(page.getByLabel("Sessions per page")).toHaveValue("25");
        await expect(page.getByRole("list").getByRole("listitem")).toHaveCount(1);
        await expect(page.getByRole("button", { name: "Load more sessions" })).toHaveCount(0);
    };
    await withCleanup(verifySessionOwnership, async () => {
        await sessionBarrier.release();
    });

    /**
     * 输入普通密码字段不会重新探测安装、身份或会话；最后使用当前管理员真实写入恢复原管理员权限，既验证当前 CSRF 可用，
     * 也恢复本测试拥有的账户状态。
     */
    const idleReads: string[] = [];
    const recordIdle = (request: import("@playwright/test").Request) => {
        const path = new URL(request.url()).pathname;
        if (
            request.method() === "GET" &&
            ["/api/v1/setup", "/api/v1/auth/session", "/api/v1/account/sessions"].includes(path)
        )
            idleReads.push(path);
    };
    await expect(page.getByLabel("Sessions per page")).toBeEnabled();
    page.on("request", recordIdle);
    await page.getByLabel("Current password").fill("Second password 123!");
    await page.getByLabel(/^New password \(at least 12 characters\)/).fill("Unsubmitted password 123!");
    expect(idleReads).toHaveLength(0);
    page.off("request", recordIdle);
    await page.getByRole("link", { name: "Users", exact: true }).click();
    await page
        .getByRole("row", { name: "browser-admin@example.com" })
        .getByRole("button", { name: "Make admin", exact: true })
        .click();
    await expect(page.getByRole("row", { name: "browser-admin@example.com" })).toContainText("System administrator");
    pendingAdminRecovery = undefined;
    await page
        .getByRole("row", { name: "browser-second-admin@example.com" })
        .getByRole("button", { name: "Remove admin", exact: true })
        .click();
    await expect(page.getByRole("heading", { name: "Access restricted" })).toBeVisible();
    await signOut(page);
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();

    /**
     * 旧退出已在真实后端成功但响应仍被持有时，让更早的会话读取得到真实401并打开登录页；随后另一账户必须在旧响应释放前
     * 建立可见身份，不能把成功登录静默丢弃或推迟到退出完成。
     */
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toContainText("Browser Administrator");
    await expect(page.getByRole("list")).toContainText("This session");
    await expect(page.getByLabel("Sessions per page")).toBeEnabled();
    const oldRead = await holdOutgoingRequest(page, "/api/v1/account/sessions", "GET");
    const oldLogoutResponse = await holdAuthResponse(page, "/api/v1/auth/logout", "POST");
    const releaseOldLogout = ownCleanup(oldLogoutResponse.release);
    const newerLoginEvents: { event: string; path?: string; status?: number }[] = [];
    const recordNewerLogin = (response: import("@playwright/test").Response) => {
        const path = new URL(response.url()).pathname;
        if (
            [
                "/api/v1/account/sessions",
                "/api/v1/auth/logout",
                "/api/v1/auth/login",
                "/api/v1/auth/session",
                "/api/v1/account",
            ].includes(path)
        )
            newerLoginEvents.push({ event: "response", path, status: response.status() });
    };
    page.on("response", recordNewerLogin);
    const verifyNewerLogin = async () => {
        await page.getByLabel("Sessions per page").selectOption("1");
        await oldRead.held;
        newerLoginEvents.push({ event: "old-sessions-get-held-before-backend" });
        await signOut(page);
        const realLogout = await oldLogoutResponse.held;
        expect(realLogout.status).toBe(200);
        newerLoginEvents.push({
            event: "old-logout-real200-held-after-revocation",
            status: realLogout.status,
        });
        const realExpiredRead = page.waitForResponse(
            (response) =>
                response.request().method() === "GET" &&
                new URL(response.url()).pathname === "/api/v1/account/sessions" &&
                response.status() === 401,
        );
        await oldRead.forward();
        expect((await realExpiredRead).status()).toBe(401);
        await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
        newerLoginEvents.push({ event: "real-sessions401-opened-signin-old-logout-still-held" });
        await page.getByRole("textbox", { name: "Email" }).fill("browser-user@example.com");
        await page.getByLabel("Password").fill("Final password 123!");
        const cancelledLogout = page.waitForEvent(
            "requestfailed",
            (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/auth/logout",
        );
        const genuineLogin = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/auth/login",
        );
        await page.getByRole("button", { name: "Sign in" }).click();
        expect((await genuineLogin).status()).toBe(200);
        newerLoginEvents.push({ event: "different-user-login200-before-old-logout-release" });
        await expect(page.locator("dl")).toContainText("Browser User");
        await expect(page.getByRole("list").getByRole("listitem")).toHaveCount(1);
        await expect(page.getByLabel("Sessions per page")).toBeEnabled();
        newerLoginEvents.push({ event: "new-account-visible-before-old-logout-release" });
        const cancelled = await cancelledLogout;
        expect(cancelled.failure()?.errorText).toMatch(/ABORTED|CANCELLED/i);
        await releaseOldLogout();
        newerLoginEvents.push({
            event: "old-logout-cancelled-before-new-login-held-response-settled",
        });
        const currentSession = await page.evaluate(async () => {
            const path = "/src/api.ts";
            const { api } = await import(/* @vite-ignore */ path);
            return (await api.session()).user.email;
        });
        expect(currentSession).toBe("browser-user@example.com");
        // 继续执行真实界面写入以同时验证新身份 Cookie、内存 CSRF 和 Origin，不能只点击密码输入框便宣称会话仍有效；写入
        // 完成后再次使用当前传输读取会话确认身份。
        await page.getByRole("link", { name: "Workspace settings", exact: true }).click();
        await page.getByRole("button", { name: "Add workspace", exact: true }).click();
        await page.getByLabel("Key").fill(`session-owner-${randomUUID()}`);
        await page.getByLabel("Name").first().fill("Session owner write");
        const creation = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/workspaces",
        );
        await page.getByRole("button", { name: "Create Workspace" }).click();
        const created = await creation;
        expect(created.status()).toBe(201);
        expect((await created.json()).data.role).toBe("OWNER");
        expect(
            await page.evaluate(async () => {
                const path = "/src/api.ts";
                const { api } = await import(/* @vite-ignore */ path);
                return (await api.session()).user.email;
            }),
        ).toBe("browser-user@example.com");
    };
    await withCleanup(verifyNewerLogin, async () => {
        await settleCleanups(oldRead.forward, releaseOldLogout, async () => {
            page.off("response", recordNewerLogin);
            const eventPath = testInfo.outputPath("newer-login-events.json");
            await writeFile(eventPath, JSON.stringify(newerLoginEvents, null, 2));
            await testInfo.attach("newer-login-events", {
                path: eventPath,
                contentType: "application/json",
            });
        });
    });
});
