// 浏览器通过代理访问受管的 Python 与 Agent 夹具，从真实报告界面核对脱敏断言和获准的 Trace 下载。
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
    executablePath: chromium.executablePath(),
    headless: true,
    args: ["--no-sandbox"],
});
try {
    const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
    });
    const failures = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.goto("http://127.0.0.1:5174/login");
    await page.getByRole("textbox", { name: "Email" }).fill("admin@example.com");
    await page.getByLabel("Password").fill("Long password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    await page.getByRole("link", { name: "Reports", exact: true }).click();
    await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("en");
    await page.getByRole("button", { name: /MANAGED_CLOUD|CONNECTED_LOCAL/ }).click();
    await expect(page.getByText("Gate at execution")).toBeVisible();
    await page.getByRole("button", { name: "Attempt 1 · PASSED", exact: true }).click();
    await expect(page.getByRole("region", { name: "Attempt details" })).toContainText("open · goto · PASSED");
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
    await expect(page.getByRole("columnheader", { name: "Expected", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Actual", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Attempt details" })).toContainText("[REDACTED]");
    await expect(page.getByRole("button", { name: "Download TRACE", exact: true })).toBeVisible();
    const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "Download TRACE", exact: true }).click(),
    ]);
    if (await download.failure()) throw new Error("Actual authorized UI download failed");
    await page.screenshot({
        path: fileURLToPath(
            new URL("../../../.superpowers/sdd/veriq-1/evidence/t12/populated-report-1280.png", import.meta.url),
        ),
        fullPage: true,
    });
    if (failures.length) throw new Error(failures.join("\n"));
    console.log("PASS actual report UI, live stream, redacted assertion, privileged Trace download, 1280px screenshot");
} finally {
    await browser.close();
    await server.close();
}
