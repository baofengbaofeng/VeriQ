import { test, expect } from "@playwright/test";

test("MVP exposes connected runtime only", async ({ page }) => {
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
    await expect(page.getByRole("link", { name: "Runtimes", exact: true })).toBeVisible();
    await expect(page.locator('a[href="/bundles"]')).toHaveCount(0);
    await page.goto("/bundles");
    await expect(page.getByText("Page not found", { exact: false })).toBeVisible();
});
