import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("real CLI enrollment, owner consent, trust and revocation in Runtime UI", async ({
    page,
}) => {
    test.setTimeout(60_000);
    const origin = "http://127.0.0.1:5173";
    const state = (await (await page.request.get("/api/v1/setup")).json()).data;
    const headers = { Origin: origin, "X-CSRF-Token": state.csrfToken };
    if (!state.initialized)
        expect(
            (
                await page.request.post("/api/v1/setup", {
                    headers,
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
    await expect(
        page.getByRole("heading", { name: "Sign in to VeriQ" }),
    ).toBeVisible();
    await page.getByTestId("email").fill("browser-admin@example.com");
    await page.getByTestId("password").fill("Browser password 123!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toBeVisible();
    const session = (
        await (await page.request.get("/api/v1/auth/session")).json()
    ).data;
    headers["X-CSRF-Token"] = session.csrfToken;
    const ws = (
        await (
            await page.request.post("/api/v1/workspaces", {
                headers,
                data: { key: "runtime-browser", name: "Runtime Browser" },
            })
        ).json()
    ).data.id;
    await page.goto("/runtimes");
    await expect(
        page.getByRole("heading", { name: "Runtimes", exact: true }),
    ).toBeVisible();
    await page.getByTestId("runtime-workspace").selectOption(ws);
    await expect(
        page.getByText("No registered Runtimes in this Workspace."),
    ).toBeVisible();
    const directory = await mkdtemp(join(tmpdir(), "veriq-browser-device-"));
    const child = spawn(
        process.execPath,
        [
            "--import",
            "tsx",
            "src/cli.ts",
            "--config-dir",
            directory,
            "login",
            "--server",
            origin,
            "--name",
            "Browser laptop",
            ...(process.env.VERIQ_TEST_CHROMIUM
                ? ["--browser-executable", process.env.VERIQ_TEST_CHROMIUM]
                : []),
        ],
        { cwd: "../runtime", stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (d) => (output += String(d)));
    child.stderr.on("data", (d) => (output += String(d)));
    const exit = new Promise<number | null>((resolve) =>
        child.on("close", resolve),
    );
    try {
        await expect
            .poll(() => /Approval code: ([A-Z2-7]{12})/.exec(output)?.[1])
            .toBeTruthy();
        const code = /Approval code: ([A-Z2-7]{12})/.exec(output)![1]!;
        await page.getByTestId("enrollment-code").fill(code);
        await page.getByTestId("enrollment-inspect").click();
        await expect(page.getByTestId("enrollment-preview")).toContainText(
            "Browser laptop",
        );
        await page.getByTestId("enrollment-approve").click();
        await expect(page.getByTestId("success")).toContainText("Device approved");
        expect(await exit).toBe(0);
        const config = JSON.parse(
            await readFile(join(directory, "device.json"), "utf8"),
        );
        expect(output).not.toContain(config.deviceToken);
        const card = page.getByTestId(`runtime-${config.runnerId}`);
        await expect(card).toContainText("OFFLINE");
        await expect(card).toContainText("USER_REGISTERED");
        await card.getByTestId("share-workspace").check();
        await card.getByTestId("save-grants").click();
        await expect(card.getByRole("status")).toContainText("Sharing updated");
        await card.getByTestId("trust-status").selectOption("MANAGED");
        await card.getByTestId("save-trust").click();
        await expect(card.getByTestId("current-trust")).toContainText("MANAGED");
        await card.getByTestId("credential-delivery").check();
        await card.getByTestId("save-delivery").click();
        await expect(card.getByRole("status")).toContainText(
            "Workspace credential delivery updated",
        );
        await page.screenshot({
            path: "../../.superpowers/sdd/veriq-1/evidence/t08/runtime-managed.png",
            fullPage: true,
        });
        await card.getByTestId("revoke-runtime").click();
        await expect(card.getByTestId("current-trust")).toContainText("REVOKED");
        const rejected = await page.request.get("/internal/v1/runtime", {
            headers: { Authorization: "Bearer " + config.deviceToken },
        });
        expect(rejected.status()).toBe(401);
    } finally {
        child.kill("SIGTERM");
        await rm(directory, { recursive: true, force: true });
    }
});

test("deployment account UI registers a real service Runtime through CLI stdin and logs out", async ({
    page,
}) => {
    test.setTimeout(60_000);
    const origin = "http://127.0.0.1:5173";
    await page.goto("/login");
    await expect(
        page.getByRole("heading", { name: "Sign in to VeriQ" }),
    ).toBeVisible();
    await page.getByTestId("email").fill("browser-admin@example.com");
    await page.getByTestId("password").fill("Browser password 123!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toBeVisible();
    const session = (
        await (await page.request.get("/api/v1/auth/session")).json()
    ).data;
    const ws = (
        await (
            await page.request.post("/api/v1/workspaces", {
                headers: { Origin: origin, "X-CSRF-Token": session.csrfToken },
                data: { key: "runtime-cloud-browser", name: "Cloud Browser" },
            })
        ).json()
    ).data.id;
    await page.goto("/runtimes");
    await expect(
        page.getByRole("heading", { name: "Runtimes", exact: true }),
    ).toBeVisible();
    await page.getByTestId("runtime-workspace").selectOption(ws);
    await page.getByLabel("Name", { exact: true }).fill("Browser deployment");
    await page
        .getByRole("button", { name: "Create service account", exact: true })
        .click();
    const account = page.getByRole("article").filter({
        has: page.getByRole("heading", {
            name: "Browser deployment",
            exact: true,
        }),
    });
    await account.getByRole("button", { name: "Issue enrollment token" }).click();
    const token = await page.getByLabel("One-time enrollment token").inputValue();
    const directory = await mkdtemp(join(tmpdir(), "veriq-cloud-device-"));
    const run = (args: string[], input = "") =>
        new Promise<{ status: number | null; output: string }>((resolve) => {
            const child = spawn(
                process.execPath,
                ["--import", "tsx", "src/cli.ts", "--config-dir", directory, ...args],
                { cwd: "../runtime" },
            );
            let output = "";
            child.stdout.on("data", (d) => (output += String(d)));
            child.stderr.on("data", (d) => (output += String(d)));
            child.on("close", (status) => resolve({ status, output }));
            child.stdin.end(input);
        });
    try {
        const enrolled = await run(
            [
                "enroll-service",
                "--server",
                origin,
                "--name",
                "Cloud browser worker",
                "--share-workspace",
                ...(process.env.VERIQ_TEST_CHROMIUM
                    ? ["--browser-executable", process.env.VERIQ_TEST_CHROMIUM]
                    : []),
            ],
            token,
        );
        expect(enrolled.status).toBe(0);
        expect(enrolled.output).not.toContain(token);
        const config = JSON.parse(
            await readFile(join(directory, "device.json"), "utf8"),
        );
        const status = await run(["status"]);
        expect(status.status).toBe(0);
        expect(status.output).toContain("OFFLINE");
        expect(status.output).toContain("USER_REGISTERED");
        expect(status.output).not.toContain(config.deviceToken);
        expect((await run(["workspace", "list"])).output).toContain(ws);
        expect((await run(["workspace", "use", ws])).status).toBe(0);
        expect(
            (await run(["workspace", "use", "00000000-0000-4000-8000-000000000000"]))
                .status,
        ).toBe(1);
        await page.getByRole("button", { name: "Refresh devices" }).click();
        await expect(page.getByTestId(`runtime-${config.runnerId}`)).toContainText(
            "MANAGED_CLOUD",
        );
        expect((await run(["logout"])).status).toBe(0);
        expect(
            (
                await page.request.get("/internal/v1/runtime", {
                    headers: { Authorization: "Bearer " + config.deviceToken },
                })
            ).status(),
        ).toBe(401);
        await account
            .getByRole("button", { name: "Disable service account" })
            .click();
        await expect(account).toContainText("Disabled");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
