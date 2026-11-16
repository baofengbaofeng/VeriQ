import { test, expect, type APIResponse, type Page, type Route } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { holdAuthResponse } from "./support/hold-auth-response";

/** 屏障只延迟首个匹配路径及指定方法的真实本机响应，后续请求直接访问后端；持有的状态、头和正文原样交还浏览器，释放操作可
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
        release: async () => {
            releaseResponse();
            if (captured) await done;
            await page.unroute(match, handler);
        },
    };
}

/** 请求屏障在真实后端处理之前暂停首个匹配路径及方法的本机请求，释放时继续发送原始内容而不构造响应；重复释放与 finally
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
        forward: async () => {
            releaseRequest();
            if (captured) await done;
            await page.unroute(match, handler);
        },
    };
}

test("real setup, login, account, administration and one-time reset", async ({
    page,
}, testInfo) => {
    test.setTimeout(30_000);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Set up VeriQ" })).toBeVisible();
    await page.getByTestId("installationSecret").fill("wrong-secret");
    await page.getByTestId("email").fill("browser-admin@example.com");
    await page.getByTestId("displayName").fill("Browser Administrator");
    await page.getByTestId("password").fill("Browser password 123!");
    await page.getByTestId("setup-submit").click();
    await expect(page.getByRole("alert")).toContainText("Installation secret is invalid");
    await page.getByTestId("installationSecret").fill("browser-operator-secret");
    await page.getByTestId("setup-submit").click();
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await page.getByTestId("email").fill("browser-admin@example.com");
    await page.getByTestId("password").fill("incorrect");
    await page.getByTestId("login-submit").click();
    await expect(page.getByRole("alert")).toContainText("Email or password is incorrect");
    await page.getByTestId("password").fill("Browser password 123!");
    const loginNavigations: string[] = [];
    const recordLoginNavigation = (frame: import("@playwright/test").Frame) => {
        if (frame === page.mainFrame()) loginNavigations.push(new URL(frame.url()).pathname);
    };
    page.on("framenavigated", recordLoginNavigation);
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toContainText("Browser Administrator");
    await expect(page.getByTestId("sessions")).toContainText("This session");
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
    await expect(page.getByTestId("sessions-limit")).toBeVisible();
    await page.getByTestId("sessions-limit").selectOption("1");
    await expect(page.getByTestId("sessions").getByRole("listitem")).toHaveCount(1);
    await page.getByTestId("sessions-more").click();
    await expect(page.getByTestId("sessions").getByRole("listitem")).toHaveCount(2);

    await page.getByRole("link", { name: "Users", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
    await page.getByTestId("email").fill("browser-user@example.com");
    await page.getByTestId("displayName").fill("Browser User");
    await page.getByTestId("password").fill("Initial password 123!");
    await page.getByTestId("create-user").click();
    const row = page.getByTestId("user-browser-user@example.com");
    await expect(row).toContainText("Browser User");
    await page.getByTestId("users-limit").selectOption("1");
    await page.getByTestId("users-filter-submit").click();
    await expect(page.getByTestId("users").getByRole("row")).toHaveCount(2);
    await page.getByTestId("users-more").click();
    await expect(page.getByTestId("users").getByRole("row")).toHaveCount(3);
    await page.getByTestId("users-search").fill("browser-user");
    await page.getByTestId("users-filter-submit").click();
    await expect(row).toBeVisible();
    await expect(page.getByTestId("user-browser-admin@example.com")).toHaveCount(0);
    await page.getByTestId("users-disabled").selectOption("true");
    await page.getByTestId("users-filter-submit").click();
    await expect(page.getByText("No users found.", { exact: true })).toBeVisible();
    await page.getByTestId("users-search").fill("");
    await page.getByTestId("users-disabled").selectOption("");
    await page.getByTestId("users-limit").selectOption("25");
    await page.getByTestId("users-filter-submit").click();
    await expect(row).toBeVisible();

    await page
        .getByTestId("user-browser-admin@example.com")
        .getByRole("button", { name: "Disable", exact: true })
        .click();
    await expect(page.getByRole("alert")).toContainText(
        "Create another enabled system administrator first",
    );
    await row.getByRole("button", { name: "Make admin", exact: true }).click();
    await expect(row).toContainText("System administrator");
    await row.getByRole("button", { name: "Remove admin", exact: true }).click();
    await row.getByRole("button", { name: "Disable", exact: true }).click();
    await expect(row).toContainText("Disabled");
    await row.getByRole("button", { name: "Enable", exact: true }).click();
    await row.getByRole("button", { name: "Revoke sessions", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Sessions revoked");
    await row.getByRole("button", { name: "Reset link", exact: true }).click();
    const link = await page.getByTestId("reset-url").inputValue();
    expect(link).toContain("/reset/confirm#token=");
    await page.screenshot({
        path: testInfo.outputPath("admin-users.png"),
        fullPage: true,
        mask: [page.getByTestId("reset-url")],
    });
    await page.getByTestId("logout").click();
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await page.getByTestId("newPassword").fill("Changed password 123!");
    await page.getByTestId("reset-confirm-submit").click();
    await expect(page.getByRole("status")).toContainText("Password updated");
    await page.getByRole("link", { name: "Sign in", exact: true }).last().click();
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await page.getByTestId("email").fill("browser-user@example.com");
    await page.getByTestId("password").fill("Changed password 123!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toContainText("Browser User");
    await expect(page.getByRole("link", { name: "Users", exact: true })).toHaveCount(0);
    await page.goto("/admin/users");
    await expect(page.getByRole("alert")).toContainText("System administrator permission");
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
    await page.getByTestId("currentPassword").fill("Changed password 123!");
    await page.getByTestId("newPassword").fill("Final password 123!");
    const passwordNavigations: string[] = [];
    const recordPasswordNavigation = (frame: import("@playwright/test").Frame) => {
        if (frame === page.mainFrame()) passwordNavigations.push(new URL(frame.url()).pathname);
    };
    page.on("framenavigated", recordPasswordNavigation);
    await page.getByTestId("change-password").click();
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    expect(passwordNavigations.filter((path) => path === "/login")).toHaveLength(1);
    page.off("framenavigated", recordPasswordNavigation);
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
    await page.getByTestId("email").fill("unknown@example.com");
    await page.getByTestId("reset-request-submit").click();
    await expect(page.getByRole("status")).toContainText("If this account is eligible");
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await page.getByTestId("newPassword").fill("Rejected password 123!");
    await page.getByTestId("reset-confirm-submit").click();
    await expect(page.getByRole("alert")).toContainText("Reset link is invalid or expired");
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await page.getByTestId("email").fill("browser-user@example.com");
    await page.getByTestId("password").fill("Final password 123!");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("revoke-own").click();
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await page.goto("/reset/confirm");
    await expect(page.getByRole("alert")).toContainText("missing its token");

    /** 先保留原有安装、重置、改密和撤销闭环，再创建第二位真实管理员，使自降权不会绕过服务端最后管理员保护；随后延迟实际
     * 账户响应验证退出意图优先。
     */
    await page.goto("/login");
    await page.getByTestId("email").fill("browser-admin@example.com");
    await page.getByTestId("password").fill("Browser password 123!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toContainText("Browser Administrator");
    await page.getByRole("link", { name: "Users", exact: true }).click();
    await page.getByTestId("email").fill("browser-second-admin@example.com");
    await page.getByTestId("displayName").fill("Second Administrator");
    await page.getByTestId("password").fill("Second password 123!");
    await page.getByTestId("systemAdmin").check();
    await page.getByTestId("create-user").click();
    await expect(page.getByTestId("user-browser-second-admin@example.com")).toBeVisible();

    /** 查询次数只涵盖已握手的本次交互窗口；非受控草稿必须等 Apply 才生效，More 则继续使用先前提交的查询与游标，不能读取
     * 未提交的输入。
     */
    const userQueries: URL[] = [];
    const recordUsers = (request: import("@playwright/test").Request) => {
        const url = new URL(request.url());
        if (request.method() === "GET" && url.pathname === "/api/v1/admin/users")
            userQueries.push(url);
    };
    page.on("request", recordUsers);
    await page.getByTestId("users-search").fill("browser-");
    await page.getByTestId("users-disabled").selectOption("false");
    await page.getByTestId("users-admin").selectOption("");
    await page.getByTestId("users-limit").selectOption("1");
    expect(userQueries).toHaveLength(0);
    const applied = page.waitForResponse(
        (response) =>
            response.request().method() === "GET" &&
            new URL(response.url()).pathname === "/api/v1/admin/users",
    );
    await page.getByTestId("users-filter-submit").click();
    expect((await applied).status()).toBe(200);
    await expect(page.getByTestId("users").getByRole("row")).toHaveCount(2);
    await expect(page.getByTestId("users-filter-submit")).toBeEnabled();
    expect(userQueries).toHaveLength(1);
    expect(userQueries[0].searchParams.get("cursor")).toBeNull();
    await page.getByTestId("users-search").fill("unsubmitted-draft");
    expect(userQueries).toHaveLength(1);
    const more = page.waitForResponse(
        (response) =>
            response.request().method() === "GET" &&
            new URL(response.url()).pathname === "/api/v1/admin/users",
    );
    await page.getByTestId("users-more").click();
    expect((await more).status()).toBe(200);
    await expect(page.getByTestId("users").getByRole("row")).toHaveCount(3);
    await expect(page.getByTestId("users-more")).toBeEnabled();
    expect(userQueries).toHaveLength(2);
    expect(userQueries[1].searchParams.get("q")).toBe("browser-");
    expect(userQueries[1].searchParams.get("disabled")).toBe("false");
    expect(userQueries[1].searchParams.get("limit")).toBe("1");
    expect(userQueries[1].searchParams.get("cursor")).toBeTruthy();
    page.off("request", recordUsers);
    await page.getByTestId("users-search").fill("");
    await page.getByTestId("users-limit").selectOption("25");
    await page.getByTestId("users-filter-submit").click();
    await expect(page.getByTestId("user-browser-admin@example.com")).toBeVisible();
    await expect(page.getByTestId("users-filter-submit")).toBeEnabled();

    /** 自降权的真实写入先成功但响应尚未到达界面时点击退出，旧操作随后不能抢走退出意图；以原表单恢复可用或真实权限面板出
     * 现作为回调收敛信号，不等待修复后可以省去的账户请求。
     */
    const actorResponse = await page.request.get(`${origin}/api/v1/account`);
    expect(actorResponse.status()).toBe(200);
    const actorId = (await actorResponse.json()).data.id;
    const mutationBarrier = await holdBackendResponse(
        page,
        `/api/v1/admin/users/${actorId}`,
        "PATCH",
    );
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
    try {
        await page
            .getByTestId("user-browser-admin@example.com")
            .getByRole("button", { name: "Remove admin", exact: true })
            .click();
        const heldUpdate = await mutationBarrier.held;
        expect(heldUpdate.status()).toBe(200);
        expect((await heldUpdate.json()).data.systemAdmin).toBe(false);
        logoutIntentEvents.push({ event: "real-self-update-held", status: heldUpdate.status() });
        await expect(page.getByTestId("create-user")).toBeDisabled();
        await page.getByTestId("logout").click();
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
                .locator('[data-testid="create-user"]:enabled')
                .or(page.getByRole("heading", { name: "Access restricted" })),
        ).toBeVisible();
        logoutIntentEvents.push({ event: "old-mutation-callback-ui-settled" });
        const completedLogout = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === "/api/v1/auth/logout",
        );
        await outgoingLogout.forward();
        logoutIntentEvents.push({ event: "logout-forwarded-to-real-backend" });
        expect((await completedLogout).status()).toBe(200);
        await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
        await expect(page.getByTestId("logout")).toHaveCount(0);
        logoutIntentEvents.push({ event: "signed-out-ui-confirmed" });
    } finally {
        await mutationBarrier.release();
        await outgoingLogout.forward();
        page.off("response", recordIntentResponse);
        const eventPath = testInfo.outputPath("logout-intent-events.json");
        await writeFile(eventPath, JSON.stringify(logoutIntentEvents, null, 2));
        await testInfo.attach("logout-intent-events", {
            path: eventPath,
            contentType: "application/json",
        });
    }
    await page.getByTestId("email").fill("browser-second-admin@example.com");
    await page.getByTestId("password").fill("Second password 123!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toContainText("Second Administrator");
    await page.getByRole("link", { name: "Users", exact: true }).click();
    await page
        .getByTestId("user-browser-admin@example.com")
        .getByRole("button", { name: "Make admin", exact: true })
        .click();
    await expect(page.getByTestId("user-browser-admin@example.com")).toContainText(
        "System administrator",
    );
    await page.getByTestId("logout").click();
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await page.getByTestId("email").fill("browser-admin@example.com");
    await page.getByTestId("password").fill("Browser password 123!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toContainText("Browser Administrator");
    await page.getByRole("link", { name: "Users", exact: true }).click();
    await expect(page.getByTestId("user-browser-admin@example.com")).toBeVisible();
    await expect(page.getByTestId("create-user")).toBeEnabled();

    /** 旧账户回写可能短暂跳转账户页后又被真实会话 401 清除，因此记录释放响应到主动登录前的导航窗口，不能只检查最终登录
     * 页而漏掉已经发生的身份复活。
     */
    const staleAccountNavigations: string[] = [];
    const ownershipEvents: { event: string; path?: string; status?: number }[] = [];
    const recordOwnershipResponse = (response: import("@playwright/test").Response) => {
        const path = new URL(response.url()).pathname;
        if (
            [
                "/api/v1/account",
                "/api/v1/account/sessions",
                "/api/v1/auth/logout",
                "/api/v1/auth/session",
            ].includes(path)
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
    try {
        await page
            .getByTestId("user-browser-admin@example.com")
            .getByRole("button", { name: "Remove admin", exact: true })
            .click();
        const held = await accountBarrier.held;
        expect(held.status()).toBe(200);
        expect((await held.json()).data.systemAdmin).toBe(false);
        ownershipEvents.push({ event: "real-demoted-account-held", status: held.status() });
        const logout = page.waitForResponse(
            (response) => new URL(response.url()).pathname === "/api/v1/auth/logout",
        );
        const expired = page.waitForResponse(
            (response) =>
                new URL(response.url()).pathname === "/api/v1/auth/session" &&
                response.status() === 401,
        );
        await page.getByTestId("logout").click();
        expect((await logout).status()).toBe(200);
        await expired;
        await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
        const released = page.waitForResponse(
            (response) => new URL(response.url()).pathname === "/api/v1/account",
        );
        page.on("framenavigated", recordStaleAccount);
        await accountBarrier.release();
        await (await released).finished();
        ownershipEvents.push({ event: "held-account-body-finished" });
        await page.getByTestId("email").click();
        await page.getByTestId("email").fill("browser-user@example.com");
        await page.getByTestId("password").fill("Final password 123!");
        await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
        await expect(page.getByTestId("account-info")).toHaveCount(0);
        await expect(page.getByRole("link", { name: "Users", exact: true })).toHaveCount(0);
        expect(staleAccountNavigations).toHaveLength(0);
        page.off("framenavigated", recordStaleAccount);
        await page.getByTestId("login-submit").click();
        await expect(page.getByTestId("account-info")).toContainText("Browser User");
    } finally {
        page.off("framenavigated", recordStaleAccount);
        page.off("response", recordOwnershipResponse);
        await accountBarrier.release();
        const eventPath = testInfo.outputPath("account-ownership-events.json");
        await writeFile(eventPath, JSON.stringify(ownershipEvents, null, 2));
        await testInfo.attach("account-ownership-events", {
            path: eventPath,
            contentType: "application/json",
        });
    }

    /** 对首个精确会话列表请求只注入一次网络故障，以真实后端重试恢复首屏；随后持有实际分页响应并切换身份，验证旧列表不会
     * 污染新账户或恢复旧游标。
     */
    await page.getByRole("link", { name: "Workspaces", exact: true }).click();
    await page.route(
        (url) =>
            url.origin === origin &&
            url.pathname === "/api/v1/account/sessions" &&
            url.searchParams.get("limit") === "25" &&
            !url.searchParams.has("cursor"),
        (route) => (route.request().method() === "GET" ? route.abort("failed") : route.continue()),
        { times: 1 },
    );
    await page.getByRole("link", { name: "Account", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry sessions" })).toBeVisible();
    await page.getByRole("button", { name: "Retry sessions" }).click();
    await expect(page.getByTestId("sessions").getByRole("listitem")).toHaveCount(1);
    await expect(page.getByTestId("sessions-limit")).toBeEnabled();
    const sessionBarrier = await holdBackendResponse(page, "/api/v1/account/sessions");
    try {
        await page.getByTestId("sessions-limit").selectOption("1");
        expect((await sessionBarrier.held).status()).toBe(200);
        await page.getByTestId("logout").click();
        await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
        await page.getByTestId("email").fill("browser-second-admin@example.com");
        await page.getByTestId("password").fill("Second password 123!");
        await page.getByTestId("login-submit").click();
        await expect(page.getByTestId("account-info")).toContainText("Second Administrator");
        await expect(page.getByTestId("sessions").getByRole("listitem")).toHaveCount(1);
        await sessionBarrier.release();
        await expect(page.getByTestId("sessions-limit")).toHaveValue("25");
        await expect(page.getByTestId("sessions").getByRole("listitem")).toHaveCount(1);
        await expect(page.getByTestId("sessions-more")).toHaveCount(0);
    } finally {
        await sessionBarrier.release();
    }

    /** 输入普通密码字段不会重新探测安装、身份或会话；最后使用当前管理员真实写入恢复原管理员权限，既验证当前 CSRF 可用，
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
    await expect(page.getByTestId("sessions-limit")).toBeEnabled();
    page.on("request", recordIdle);
    await page.getByTestId("currentPassword").fill("Second password 123!");
    await page.getByTestId("newPassword").fill("Unsubmitted password 123!");
    expect(idleReads).toHaveLength(0);
    page.off("request", recordIdle);
    await page.getByRole("link", { name: "Users", exact: true }).click();
    await page
        .getByTestId("user-browser-admin@example.com")
        .getByRole("button", { name: "Make admin", exact: true })
        .click();
    await expect(page.getByTestId("user-browser-admin@example.com")).toContainText(
        "System administrator",
    );
    await page
        .getByTestId("user-browser-second-admin@example.com")
        .getByRole("button", { name: "Remove admin", exact: true })
        .click();
    await expect(page.getByRole("heading", { name: "Access restricted" })).toBeVisible();
    await page.getByTestId("logout").click();
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();

    /** 旧退出已在真实后端成功但响应仍被持有时，让更早的会话读取得到真实401并打开登录页；随后另一账户必须在旧响应释放前
     * 建立可见身份，不能把成功登录静默丢弃或推迟到退出完成。
     */
    await page.getByTestId("email").fill("browser-admin@example.com");
    await page.getByTestId("password").fill("Browser password 123!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toContainText("Browser Administrator");
    await expect(page.getByTestId("sessions")).toContainText("This session");
    await expect(page.getByTestId("sessions-limit")).toBeEnabled();
    const oldRead = await holdOutgoingRequest(page, "/api/v1/account/sessions", "GET");
    const oldLogoutResponse = await holdAuthResponse(page, "/api/v1/auth/logout", "POST");
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
    try {
        await page.getByTestId("sessions-limit").selectOption("1");
        await oldRead.held;
        newerLoginEvents.push({ event: "old-sessions-get-held-before-backend" });
        await page.getByTestId("logout").click();
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
        await page.getByTestId("email").fill("browser-user@example.com");
        await page.getByTestId("password").fill("Final password 123!");
        const cancelledLogout = page.waitForEvent(
            "requestfailed",
            (request) =>
                request.method() === "POST" &&
                new URL(request.url()).pathname === "/api/v1/auth/logout",
        );
        const genuineLogin = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === "/api/v1/auth/login",
        );
        await page.getByTestId("login-submit").click();
        expect((await genuineLogin).status()).toBe(200);
        newerLoginEvents.push({ event: "different-user-login200-before-old-logout-release" });
        await expect(page.getByTestId("account-info")).toContainText("Browser User");
        await expect(page.getByTestId("sessions").getByRole("listitem")).toHaveCount(1);
        await expect(page.getByTestId("sessions-limit")).toBeEnabled();
        newerLoginEvents.push({ event: "new-account-visible-before-old-logout-release" });
        const cancelled = await cancelledLogout;
        expect(cancelled.failure()?.errorText).toMatch(/ABORTED|CANCELLED/i);
        await oldLogoutResponse.release();
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
        await page.getByRole("link", { name: "Workspaces", exact: true }).click();
        await page.getByTestId("workspace-key").fill(`session-owner-${randomUUID()}`);
        await page.getByTestId("workspace-name").fill("Session owner write");
        const creation = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === "/api/v1/workspaces",
        );
        await page.getByTestId("workspace-create").click();
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
    } finally {
        await oldRead.forward();
        await oldLogoutResponse.release();
        page.off("response", recordNewerLogin);
        const eventPath = testInfo.outputPath("newer-login-events.json");
        await writeFile(eventPath, JSON.stringify(newerLoginEvents, null, 2));
        await testInfo.attach("newer-login-events", {
            path: eventPath,
            contentType: "application/json",
        });
    }
});
