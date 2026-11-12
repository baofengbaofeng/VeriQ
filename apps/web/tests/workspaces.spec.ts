import { test, expect } from "@playwright/test";

test("real Workspace selection, invitation acceptance and member permissions", async ({
    page,
    browser,
}) => {
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
    await expect(
        page.getByRole("heading", { name: "Sign in to VeriQ" }),
    ).toBeVisible();
    await page.getByTestId("email").fill("browser-admin@example.com");
    await page.getByTestId("password").fill("Browser password 123!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toBeVisible();
    // Keep unrelated state present: this test's empty state belongs to a new actor,
    // independently of other feature suites that already created Workspaces.
    const setupSession = (
        await (await page.request.get("/api/v1/auth/session")).json()
    ).data;
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
    await page.getByTestId("logout").click();
    await page.getByTestId("email").fill("workspace-operator@example.com");
    await page.getByTestId("password").fill("Workspace operator password 123!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toContainText(
        "Workspace test operator",
    );
    expect(
        (await page.request.get("/api/v1/workspaces/" + unrelatedId)).status(),
    ).toBe(403);
    await page.getByRole("link", { name: "Workspaces", exact: true }).click();
    await expect(
        page.getByText("No Workspaces yet.", { exact: true }),
    ).toBeVisible();
    await page.getByTestId("workspace-key").fill("browser-alpha");
    await page.getByTestId("workspace-name").fill("Browser Alpha");
    await page.getByTestId("workspace-create").click();
    await expect(page.getByTestId("workspace-detail")).toContainText(
        "Browser Alpha",
    );
    const alpha = await page.getByTestId("workspace-selector").inputValue();
    await page.getByTestId("workspace-key").fill("browser-beta");
    await page.getByTestId("workspace-name").fill("Browser Beta");
    await page.getByTestId("workspace-create").click();
    await expect(page.getByTestId("workspace-detail")).toContainText(
        "Browser Beta",
    );
    const beta = await page.getByTestId("workspace-selector").inputValue();
    await page.getByTestId("workspace-selector").selectOption(alpha);
    await expect(page.getByTestId("workspace-detail")).toContainText(
        "Browser Alpha",
    );
    await page.getByTestId("invite-email").fill("workspace-viewer@example.com");
    await page.getByTestId("invite-role").selectOption("VIEWER");
    await page.getByTestId("invite-create").click();
    const invitation = await page.getByTestId("invitation-url").inputValue();
    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await viewer.goto(invitation);
    await expect(
        viewer.getByRole("heading", { name: "Accept Workspace invitation" }),
    ).toBeVisible();
    expect(new URL(viewer.url()).hash).toBe("");
    await viewer.getByTestId("invite-new-account").check();
    await viewer.getByTestId("displayName").fill("Workspace Viewer");
    await viewer.getByTestId("password").fill("Viewer password 123!");
    await viewer.getByTestId("invite-accept").click();
    await expect(viewer.getByRole("status")).toContainText("Invitation accepted");
    await viewer.goto("/login");
    await expect(
        viewer.getByRole("heading", { name: "Sign in to VeriQ" }),
    ).toBeVisible();
    await viewer.getByTestId("email").fill("workspace-viewer@example.com");
    await viewer.getByTestId("password").fill("Viewer password 123!");
    await viewer.getByTestId("login-submit").click();
    await expect(viewer.getByTestId("account-info")).toBeVisible();
    await viewer.getByRole("link", { name: "Workspaces", exact: true }).click();
    await expect(viewer.getByTestId("workspace-detail")).toContainText(
        "Browser Alpha",
    );
    await expect(viewer.getByTestId("workspace-detail")).toContainText("VIEWER");
    await expect(viewer.getByTestId("invite-create")).toHaveCount(0);
    await expect(viewer.getByTestId("workspace-rename")).toHaveCount(0);
    await page.getByTestId("workspace-refresh").click();
    const member = page.getByTestId("member-workspace-viewer@example.com");
    await expect(member).toContainText("Workspace Viewer");
    await member.getByTestId("member-role").selectOption("EDITOR");
    await member.getByRole("button", { name: "Save member" }).click();
    await expect(page.getByRole("status")).toContainText("Member updated");
    await page.screenshot({
        path: "../../.superpowers/sdd/veriq-1/evidence/t03/workspace-active.png",
        fullPage: true,
        mask: [page.getByTestId("invitation-url")],
    });
    // Hold an actual HTTP response so the switch happens with work in flight.
    // The browser must abort the old scoped fetch; its data cannot enter Beta.
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
        predicate: (request) =>
            request.url().endsWith(`/workspaces/${alpha}/members`),
    });
    await page.getByTestId("workspace-refresh").click();
    await oldReceived;
    await page.getByTestId("workspace-selector").selectOption(beta);
    expect((await abortedOld).failure()?.errorText).toContain("ERR_ABORTED");
    releaseOld();
    await page.unroute(oldPath);
    await expect(page.getByTestId("workspace-detail")).toContainText(
        "Browser Beta",
    );
    await expect(member).toHaveCount(0);
    // Existing accounts sign in inline; the token stays in component memory.
    const csrf = (await (await page.request.get("/api/v1/auth/session")).json())
        .data.csrfToken;
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
    await page.getByTestId("invite-email").fill("existing-workspace@example.com");
    await page.getByTestId("invite-create").click();
    const existingInvitation = await page
        .getByTestId("invitation-url")
        .inputValue();
    const existingContext = await browser.newContext();
    const existingPage = await existingContext.newPage();
    await existingPage.goto(existingInvitation);
    await expect(
        existingPage.getByRole("heading", { name: "Accept Workspace invitation" }),
    ).toBeVisible();
    expect(new URL(existingPage.url()).hash).toBe("");
    await existingPage
        .getByTestId("email")
        .fill("existing-workspace@example.com");
    await existingPage.getByTestId("password").fill("Existing password 123!");
    await existingPage.getByTestId("invite-accept").click();
    await expect(existingPage.getByRole("status")).toContainText(
        "Invitation accepted",
    );
    await existingContext.close();
    await page.getByTestId("workspace-archive").click();
    await expect(page.getByTestId("workspace-detail")).toContainText("Archived");
    await expect(page.getByTestId("invite-create")).toHaveCount(0);
    await page.screenshot({
        path: "../../.superpowers/sdd/veriq-1/evidence/t03/workspace.png",
        fullPage: true,
    });
    await page.getByTestId("logout").click();
    await expect(
        page.getByRole("heading", { name: "Sign in to VeriQ" }),
    ).toBeVisible();
    await page.getByTestId("email").fill("workspace-viewer@example.com");
    await page.getByTestId("password").fill("Viewer password 123!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toContainText(
        "Workspace Viewer",
    );
    await page.getByRole("link", { name: "Workspaces", exact: true }).click();
    await expect(page.getByTestId("workspace-detail")).toContainText(
        "Browser Alpha",
    );
    await expect(
        page
            .getByTestId("workspace-selector")
            .getByRole("option", { name: /Browser Beta/ }),
    ).toHaveCount(0);
    await viewerContext.close();
});
