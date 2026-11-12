// Consumes the live guarded Python/Agent fixture; no intercepted responses or synthetic reports.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
    configFile: false,
    root,
    plugins: [react()],
    server: {
        host: "127.0.0.1",
        port: 5174,
        strictPort: true,
        proxy: {
            "/api": {
                target: "http://127.0.0.1:18889",
                headers: { Origin: "http://127.0.0.1:18889" },
            },
        },
    },
});
await server.listen();
const browser = await chromium.launch({
    executablePath: process.env.VERIQ_TEST_CHROMIUM ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
});
try {
    const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
    });
    const failures = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.goto("http://127.0.0.1:5174/login");
    await page.getByTestId("email").fill("admin@example.com");
    await page.getByTestId("password").fill("Long password 123!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toBeVisible();
    await page.getByRole("link", { name: "Reports", exact: true }).click();
    await page.getByLabel("语言 / Language").selectOption("en");
    await page
        .getByRole("button", { name: /MANAGED_CLOUD|CONNECTED_LOCAL/ })
        .click();
    await expect(page.getByTestId("report-gates")).toBeVisible();
    await page
        .getByRole("button", { name: "Attempt 1 · PASSED", exact: true })
        .click();
    await expect(
        page.getByRole("region", { name: "Attempt details" }),
    ).toContainText("open · goto · PASSED");
    await expect(
        page.getByRole("heading", {
            name: "Visible (visible) · PASSED",
            exact: true,
        }),
    ).toBeVisible();
    await expect(
        page.getByRole("heading", {
            name: "visible · ui textContains · PASSED",
            exact: true,
        }),
    ).toBeVisible();
    await expect(
        page.getByRole("columnheader", { name: "Expected", exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole("columnheader", { name: "Actual", exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole("region", { name: "Attempt details" }),
    ).toContainText("[REDACTED]");
    await expect(
        page.getByRole("button", { name: "Download TRACE", exact: true }),
    ).toBeVisible();
    const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "Download TRACE", exact: true }).click(),
    ]);
    if (await download.failure())
        throw new Error("Actual authorized UI download failed");
    await page.screenshot({
        path: fileURLToPath(
            new URL(
                "../../../.superpowers/sdd/veriq-1/evidence/t12/populated-report-1280.png",
                import.meta.url,
            ),
        ),
        fullPage: true,
    });
    if (failures.length) throw new Error(failures.join("\n"));
    console.log(
        "PASS actual report UI, live stream, redacted assertion, privileged Trace download, 1280px screenshot",
    );
} finally {
    await browser.close();
    await server.close();
}
