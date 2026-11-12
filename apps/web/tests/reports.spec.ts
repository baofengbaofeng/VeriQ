import { test, expect } from "@playwright/test";
test("reports show real Workspace history and clear scope on switch", async ({
    page,
}) => {
    const state = (await (await page.request.get("/api/v1/setup")).json()).data;
    if (!state.initialized)
        expect(
            (
                await page.request.post("/api/v1/setup", {
                    headers: {
                        Origin: "http://127.0.0.1:5173",
                        "X-CSRF-Token": state.csrfToken,
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
    await page.goto("/login");
    await page.getByTestId("email").fill("browser-admin@example.com");
    await page.getByTestId("password").fill("Browser password 123!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toBeVisible();
    const session = (
        await (await page.request.get("/api/v1/auth/session")).json()
    ).data;
    const headers = {
        Origin: "http://127.0.0.1:5173",
        "X-CSRF-Token": session.csrfToken,
    };
    const a = await page.request.post("/api/v1/workspaces", {
        headers,
        data: { key: "reports-a", name: "Reports A" },
    });
    const b = await page.request.post("/api/v1/workspaces", {
        headers,
        data: { key: "reports-b", name: "Reports B" },
    });
    expect(a.status()).toBe(201);
    expect(b.status()).toBe(201);
    await page.getByRole("link", { name: "Reports", exact: true }).click();
    await page.getByLabel("语言 / Language").selectOption("en");
    await expect(
        page.getByRole("heading", { name: "Reports", exact: true }),
    ).toBeVisible();
    await page
        .getByLabel("Report Workspace")
        .selectOption((await a.json()).data.id);
    await expect(
        page.getByText("No runs in this Workspace.", { exact: true }),
    ).toBeVisible();
    await page
        .getByLabel("Report Workspace")
        .selectOption((await b.json()).data.id);
    await expect(
        page.getByText("No runs in this Workspace.", { exact: true }),
    ).toBeVisible();
    await expect(
        page.getByText("Select a run to inspect its report.", { exact: true }),
    ).toBeVisible();
});
