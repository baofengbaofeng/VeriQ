import { test, expect } from "@playwright/test";

test("real Workspace selection, invitation acceptance and member permissions", async ({ page, browser }) => {
    const state = await page.request.get("/api/v1/setup");
    if (!(await state.json()).data.initialized) {
        const csrfToken = (await state.json()).data.csrfToken;
        expect(
            (
                await page.request.post("/api/v1/setup", {
                    headers: {
                        Origin: "http://127.0.0.1:5173",
                        "X-CSRF-Token": csrfToken,
                    },
                    data: {
                        installationSecret: "browser-operator-secret",
                        email: "browser-admin@example.com",
                        displayName: "Browser Administrator",
                        password: "Browser password 123!",
                    },
                })
            ).status(),
        ).toBe(201);
    }
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    // Keep unrelated state present: this test's empty state belongs to a new actor, independently of other feature
    // suites that already created Workspaces.
    const setupSession = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const setupHeaders = {
        Origin: "http://127.0.0.1:5173",
        "X-CSRF-Token": setupSession.csrfToken,
    };
    const unrelated = await page.request.post("/api/v1/workspaces", {
        headers: setupHeaders,
        data: {
            key: "workspace-fixture-unrelated",
            name: "Retained unrelated Workspace",
        },
    });
    expect(unrelated.status(), await unrelated.text()).toBe(201);
    const unrelatedId = (await unrelated.json()).data.id;
    const isolated = await page.request.post("/api/v1/admin/users", {
        headers: setupHeaders,
        data: {
            email: "workspace-operator@example.com",
            displayName: "Workspace test operator",
            password: "Workspace operator password 123!",
            systemAdmin: true,
        },
    });
    expect(isolated.status(), await isolated.text()).toBe(201);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("textbox", { name: "Email" }).fill("workspace-operator@example.com");
    await page.getByLabel("Password").fill("Workspace operator password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toContainText("Workspace test operator");
    expect((await page.request.get("/api/v1/workspaces/" + unrelatedId)).status()).toBe(403);
    await page.getByRole("link", { name: "Workspaces", exact: true }).click();
    await expect(page.getByText("No Workspaces yet.", { exact: true })).toBeVisible();
    await page.getByLabel("Key").fill("browser-alpha");
    await page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Create Workspace", exact: true }) })
        .getByLabel("Name", { exact: true })
        .fill("Browser Alpha");
    await page.getByRole("button", { name: "Create Workspace" }).click();
    await expect(page.getByRole("article")).toContainText("Browser Alpha");
    const alpha = await page.getByLabel("Current Workspace").inputValue();
    await page.getByLabel("Key").fill("browser-beta");
    await page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Create Workspace", exact: true }) })
        .getByLabel("Name", { exact: true })
        .fill("Browser Beta");
    await page.getByRole("button", { name: "Create Workspace" }).click();
    await expect(page.getByRole("article")).toContainText("Browser Beta");
    const beta = await page.getByLabel("Current Workspace").inputValue();
    await page.getByLabel("Current Workspace").selectOption(alpha);
    await expect(page.getByRole("article")).toContainText("Browser Alpha");
    await page.getByLabel("Email").fill("workspace-viewer@example.com");
    await page.locator('select[name="role"]').selectOption("VIEWER");
    await page.getByRole("button", { name: "Create invitation" }).click();
    const invitation = await page.getByLabel("Copy invitation link").inputValue();
    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await viewer.goto(invitation);
    await expect(viewer.getByRole("heading", { name: "Accept Workspace invitation" })).toBeVisible();
    expect(new URL(viewer.url()).hash).toBe("");
    await viewer.getByLabel("Create a new account").check();
    await viewer.getByLabel("Display name").fill("Workspace Viewer");
    await viewer.getByLabel("Password").fill("Viewer password 123!");
    await viewer.getByRole("button", { name: "Accept invitation" }).click();
    await expect(viewer.getByRole("status")).toContainText("Invitation accepted");
    await viewer.goto("/login");
    await expect(viewer.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await viewer.getByRole("textbox", { name: "Email" }).fill("workspace-viewer@example.com");
    await viewer.getByLabel("Password").fill("Viewer password 123!");
    await viewer.getByRole("button", { name: "Sign in" }).click();
    await expect(viewer.locator("dl")).toBeVisible();
    await viewer.getByRole("link", { name: "Workspaces", exact: true }).click();
    await expect(viewer.getByRole("article")).toContainText("Browser Alpha");
    await expect(viewer.getByRole("article")).toContainText("VIEWER");
    await expect(viewer.getByRole("button", { name: "Create invitation" })).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "Rename Workspace" })).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh Workspace" }).click();
    const member = page.getByRole("listitem").filter({ hasText: "workspace-viewer@example.com" });
    await expect(member).toContainText("Workspace Viewer");
    await member.getByRole("combobox", { name: "Role" }).selectOption("EDITOR");
    await member.getByRole("button", { name: "Save member" }).click();
    await expect(page.getByRole("status")).toContainText("Member updated");
    await page.screenshot({
        path: "../../.superpowers/sdd/veriq-1/evidence/t03/workspace-active.png",
        fullPage: true,
        mask: [page.getByLabel("Copy invitation link")],
    });
    // Hold an actual HTTP response so the switch happens with work in flight. The browser must abort the old scoped
    // fetch; its data cannot enter Beta.
    let releaseOld!: () => void;
    let receivedOld!: () => void;
    const oldReceived = new Promise<void>((resolve) => {
        receivedOld = resolve;
    });
    const oldRelease = new Promise<void>((resolve) => {
        releaseOld = resolve;
    });
    const oldPath = `**/api/v1/workspaces/${alpha}/members`;
    await page.route(oldPath, async (route) => {
        const response = await route.fetch();
        receivedOld();
        await oldRelease;
        // The application has aborted this request; forwarding it would attempt
        // to fulfil a route Chromium has already closed.
        await response.dispose();
    });
    const abortedOld = page.waitForEvent("requestfailed", {
        predicate: (request) => request.url().endsWith(`/workspaces/${alpha}/members`),
    });
    await page.getByRole("button", { name: "Refresh Workspace" }).click();
    await oldReceived;
    await page.getByLabel("Current Workspace").selectOption(beta);
    expect((await abortedOld).failure()?.errorText).toContain("ERR_ABORTED");
    releaseOld();
    await page.unroute(oldPath);
    await expect(page.getByRole("article")).toContainText("Browser Beta");
    await expect(member).toHaveCount(0);
    // Existing accounts sign in inline; the token stays in component memory.
    const csrf = (await (await page.request.get("/api/v1/auth/session")).json()).data.csrfToken;
    expect(
        (
            await page.request.post("/api/v1/admin/users", {
                headers: { Origin: "http://127.0.0.1:5173", "X-CSRF-Token": csrf },
                data: {
                    email: "existing-workspace@example.com",
                    displayName: "Existing Member",
                    password: "Existing password 123!",
                    systemAdmin: false,
                },
            })
        ).status(),
    ).toBe(201);
    await page.getByLabel("Email").fill("existing-workspace@example.com");
    await page.getByRole("button", { name: "Create invitation" }).click();
    const existingInvitation = await page.getByLabel("Copy invitation link").inputValue();
    const existingContext = await browser.newContext();
    const existingPage = await existingContext.newPage();
    await existingPage.goto(existingInvitation);
    await expect(existingPage.getByRole("heading", { name: "Accept Workspace invitation" })).toBeVisible();
    expect(new URL(existingPage.url()).hash).toBe("");
    await existingPage.getByRole("textbox", { name: "Email" }).fill("existing-workspace@example.com");
    await existingPage.getByLabel("Password").fill("Existing password 123!");
    await existingPage.getByRole("button", { name: "Accept invitation" }).click();
    await expect(existingPage.getByRole("status")).toContainText("Invitation accepted");
    await existingContext.close();
    await page.getByRole("button", { name: "Archive Workspace" }).click();
    await expect(page.getByRole("article")).toContainText("Archived");
    await expect(page.getByRole("button", { name: "Create invitation" })).toHaveCount(0);
    await page.screenshot({
        path: "../../.superpowers/sdd/veriq-1/evidence/t03/workspace.png",
        fullPage: true,
    });
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await page.getByRole("textbox", { name: "Email" }).fill("workspace-viewer@example.com");
    await page.getByLabel("Password").fill("Viewer password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toContainText("Workspace Viewer");
    await page.getByRole("link", { name: "Workspaces", exact: true }).click();
    await expect(page.getByRole("article")).toContainText("Browser Alpha");
    await expect(page.getByLabel("Current Workspace").getByRole("option", { name: /Browser Beta/ })).toHaveCount(0);
    await viewerContext.close();
});
