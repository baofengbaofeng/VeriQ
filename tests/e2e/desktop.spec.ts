import { test, expect, _electron, chromium } from "../../apps/desktop/tests/fixtures";
import { mkdtemp, rm, appendFile, readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { trackFixture, stopFixture } from "./lifecycle";
import { stopTestAgent } from "./agent-owner";
import { testEngine } from "./engine";
import { observeHeadedRun, assertHeadedStopped } from "./headed";
let engine: Awaited<ReturnType<typeof testEngine>>;
test.beforeAll(async () => {
    engine = await testEngine(resolve("../.."));
    await mkdir(
        resolve(
            "../..",
            process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19",
        ),
        { recursive: true },
    );
});
let workflowFixture: { profile: string; fixture: string } | undefined;

// pw:browser 诊断只属于测试驱动，实际 Electron、控制夹具及组件浏览器使用移除 DEBUG 后的宿主环境；独立 Agent 随后继承的是 Electron 的干净环境，不能把驱动日志选项传进业务 SDK。
const applicationEnvironment = { ...process.env };
delete applicationEnvironment.DEBUG;

/** 测试清理按后台、窗口、数据库夹具顺序收敛，并在任一步失败后仍尝试关闭其余自有资源；收集到的失败最终统一抛出，不让一个清理异常跳过释放数据库锁，也不把发送信号或框架返回当作真实进程停止。 */
async function teardownDesktop(
    electron: Awaited<ReturnType<typeof _electron.launch>> | undefined,
    profile: string,
    agentPid: number | undefined,
    server?: import("node:child_process").ChildProcess,
) {
    const failures: unknown[] = [];
    for (const step of [
        async () => {
            if (agentPid) await stopTestAgent(profile, agentPid);
        },
        async () => {
            if (electron) await electron.close();
        },
        async () => {
            if (server) await stopFixture(server);
        },
    ]) {
        try {
            await step();
        } catch (error) {
            console.error("Owned fixture teardown failed:", error);
            failures.push(error);
        }
    }
    if (failures.length) throw new AggregateError(failures, "DESKTOP_TEARDOWN_FAILED");
}

/** 最小窗口检查必须启动真实已打包 Electron，并从实际 preload 与独立后台读取状态；浏览器模拟页面、缺失二进制或缺少 DISPLAY 都不能代替这个产品行为测试的结果。 */
test("bundled desktop opens offline with strict renderer and independent Node24", async () => {
    const root = resolve("../.."),
        profile = await mkdtemp("/tmp/veriq-t19-gui-");
    const log = resolve(
        root,
        process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19",
        "gui-window-diagnostics.log",
    );
    console.log("Launching real desktop");
    const electron = await _electron.launch({
        chromiumSandbox: true,
        executablePath: process.env.VERIQ_TEST_ELECTRON!,
        args: [resolve(".")],
        env: {
            ...applicationEnvironment,
            VERIQ_DESKTOP_PROFILE: profile,
            VERIQ_DESKTOP_NODE: process.execPath,
            VERIQ_DESKTOP_ENGINE: engine.directory,
            VERIQ_DESKTOP_ENGINE_VERSION: engine.version,
            VERIQ_DESKTOP_BROWSER: resolve(
                root,
                ".superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell",
            ),
        },
    });
    console.log("Electron connected");
    electron.process().stderr?.on("data", (chunk) => void appendFile(log, chunk));
    electron.process().stdout?.on("data", (chunk) => void appendFile(log, chunk));
    let agentPid: number | undefined;
    try {
        const page = await electron.firstWindow({ timeout: 10000 });
        console.log("First window connected", page.url());
        const versions = await electron.evaluate(({ BrowserWindow }) => ({
            electron: process.versions.electron,
            uiNode: process.versions.node,
            uiChromium: process.versions.chrome,
            sandbox: BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences().sandbox,
        }));
        expect(versions.sandbox).toBe(true);
        await appendFile(
            resolve(
                root,
                process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19",
                "gui-runtime-versions.json",
            ),
            JSON.stringify({ ...versions, independentNode: process.versions.node }) + "\n",
        );
        page.on(
            "console",
            (message) => void appendFile(log, `renderer ${message.type()}: ${message.text()}\n`),
        );
        page.on("pageerror", (error) => void appendFile(log, `page error: ${error.message}\n`));
        await expect(page.getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
        await expect
            .poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.node)
            .toBe("24.22.1");
        expect(
            await page.evaluate(() => ({
                process: typeof Reflect.get(window, "process"),
                require: typeof Reflect.get(window, "require"),
            })),
        ).toEqual({ process: "undefined", require: "undefined" });
        const state = await page.evaluate(() => window.veriq.state());
        agentPid = state.agent?.pid;
        expect(await electron.evaluate(() => process.env.DEBUG)).toBeUndefined();
        if (agentPid)
            expect(
                (await readFile(`/proc/${agentPid}/environ`, "utf8"))
                    .split("\0")
                    .some((value) => value.startsWith("DEBUG=")),
            ).toBe(false);
        expect(state.agent?.pid).not.toBe(electron.process().pid);
        await expect(page.getByText("Offline / signed out", { exact: true })).toHaveCount(0);
        await page.getByRole("button", { name: "本机缓存", exact: true }).click();
        await expect(
            page.getByText("尚未下载资源包。 / No downloaded packages yet."),
        ).toBeVisible();
        await page.getByLabel("语言 / Language").selectOption("en");
        await expect(page.getByRole("heading", { name: "Local cache", exact: true })).toBeVisible();
        await page.screenshot({
            path: resolve(
                root,
                process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19",
                "desktop-initial-1280.png",
            ),
            fullPage: true,
        });
        const forbidden = await page.evaluate(async () => {
            try {
                await Reflect.apply(window.veriq.local, undefined, [
                    { operation: "spawn", command: "sh" },
                ]);
                return false;
            } catch {
                return true;
            }
        });
        expect(forbidden).toBe(true);
    } finally {
        console.log("Closing UI test process");
        await teardownDesktop(electron, profile, agentPid);
        // 失败时保留完整私有 profile 供诊断；正常退出须等后台描述文件消失后再清理，避免把存活后台的锁和数据库误删，这个早期空闲冒烟清理不用于证明活动 Run 的生命周期。
        if (agentPid) {
            await expect
                .poll(async () =>
                    readFile(resolve(profile, "desktop-agent.json")).then(
                        () => false,
                        () => true,
                    ),
                )
                .toBe(true);
            await rm(profile, { recursive: true, force: true });
        }
    }
});

/** 完整链路只通过真实平台 API 准备业务输入，随后由桌面绑定的独立 Agent 消费生产器候选生成回执；控制平面停止后继续访问业务站点，报告与回传必须来自实际签名包执行而非注入结果。 */
test("production candidate completes the real desktop offline workflow", async ({ request }) => {
    test.setTimeout(300000);
    const root = resolve("../..");
    const evidence = resolve(
        root,
        process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19",
    );
    const profile = await mkdtemp("/tmp/veriq-t19-full-");
    const fixture = await mkdtemp(resolve(evidence, "service-"));
    const { spawn } = await import("node:child_process");
    const server = trackFixture(
        spawn(
            "flock",
            [
                "-n",
                "-F",
                "/tmp/veriq-t12-db.lock",
                resolve(root, "apps/srv/.venv/bin/python"),
                resolve(root, "tests/e2e/desktop_server.py"),
                fixture,
            ],
            { cwd: root, env: applicationEnvironment, stdio: ["ignore", "pipe", "pipe"] },
        ),
    );
    server.stdout.on("data", (data) => void appendFile(resolve(evidence, "full-server.log"), data));
    server.stderr.on("data", (data) => void appendFile(resolve(evidence, "full-server.log"), data));
    let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    let agentPid: number | undefined;
    const origin = "http://127.0.0.1:8888";
    let csrf = "";
    async function api(path: string, method = "GET", data?: unknown) {
        const response = await request.fetch(origin + "/api/v1" + path, {
            method,
            headers: { Origin: origin, "X-CSRF-Token": csrf },
            ...(data === undefined ? {} : { data }),
        });
        expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
        return (await response.json()).data;
    }
    try {
        await expect
            .poll(
                async () =>
                    request.get(origin + "/api/v1/setup").then(
                        (r) => r.status(),
                        () => 0,
                    ),
                { timeout: 30000 },
            )
            .toBe(200);
        csrf = (await api("/setup")).csrfToken;
        await api("/setup", "POST", {
            installationSecret: "browser-operator-secret",
            email: "desktop-admin@example.com",
            displayName: "Desktop Administrator",
            password: "Desktop password 123!",
        });
        csrf = (
            await api("/auth/login", "POST", {
                email: "desktop-admin@example.com",
                password: "Desktop password 123!",
            })
        ).csrfToken;
        const workspace = await api("/workspaces", "POST", {
            key: "desktop-actual",
            name: "Desktop actual workflow",
        });
        const base = `/workspaces/${workspace.id}`;
        electron = await _electron.launch({
            chromiumSandbox: true,
            executablePath: process.env.VERIQ_TEST_ELECTRON!,
            args: [resolve(".")],
            env: {
                ...applicationEnvironment,
                VERIQ_DESKTOP_PROFILE: profile,
                VERIQ_DESKTOP_NODE: process.execPath,
                VERIQ_DESKTOP_ENGINE: engine.directory,
                VERIQ_DESKTOP_ENGINE_VERSION: engine.version,
                VERIQ_DESKTOP_BROWSER: resolve(
                    root,
                    ".superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell",
                ),
            },
        });
        electron
            .process()
            .stderr?.on(
                "data",
                (data) => void appendFile(resolve(evidence, "full-electron.log"), data),
            );
        const page = await electron.firstWindow();
        page.on(
            "pageerror",
            (error) =>
                void appendFile(
                    resolve(evidence, "full-electron.log"),
                    `renderer: ${error.message}\n`,
                ),
        );
        await expect(page.getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
        await expect
            .poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.node)
            .toBe("24.22.1");
        agentPid = (await page.evaluate(() => window.veriq.state())).agent?.pid;
        await page.getByLabel("邮箱 / Email").fill("desktop-admin@example.com");
        await page.getByLabel("密码 / Password").fill("Desktop password 123!");
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await expect(
            page
                .getByLabel("平台工作区 / Platform workspace")
                .locator(`option[value="${workspace.id}"]`),
        ).toHaveCount(1);
        await page.getByLabel("平台工作区 / Platform workspace").selectOption(workspace.id);
        console.log("Desktop ordinary login and workspace selected");
        await page.getByLabel("共享给工作区 / Share with workspace").check();
        await page.getByRole("button", { name: "发起绑定 / Enroll", exact: true }).click();
        await expect(page.getByTestId("enrollment-code")).toBeVisible({ timeout: 20000 });
        await page
            .getByRole("button", { name: "批准并完成绑定 / Approve binding", exact: true })
            .click();
        await expect
            .poll(
                async () =>
                    (await page.evaluate(() => window.veriq.state())).agent?.device?.workspaceId,
            )
            .toBe(workspace.id);
        const device = (await page.evaluate(() => window.veriq.state())).agent!.device!;
        await api(base + `/runtimes/${device.id}/trust`, "PUT", {
            trustStatus: "MANAGED",
            allowCredentialDelivery: true,
        });
        await page
            .getByRole("button", { name: "启动在线领取 / Start online worker", exact: true })
            .click();
        await expect
            .poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.online)
            .toBe(true);
        console.log("Desktop device enrolled and actual Node24 Agent claiming");
        async function publish(kind: string, key: string, document: unknown) {
            const resource = await api(base + "/resources", "POST", {
                kind,
                key,
                name: key,
                content: { kind, document },
            });
            const path = base + `/resources/${resource.id}`;
            const preview = await api(path + "/validation-preview");
            const job = await api(path + "/validate", "POST", {
                revision: preview.revision,
                sourceHash: preview.sourceHash,
            });
            await expect
                .poll(async () => (await api(base + `/jobs/${job.id}`)).state, {
                    timeout: 90000,
                    intervals: [500, 1000],
                })
                .toBe("FINISHED");
            expect((await api(base + `/jobs/${job.id}`)).outcome).toBe("PASSED");
            const receipt = await api(base + `/jobs/${job.id}/validation-receipt`);
            expect(receipt.engineVersion).toBe(engine.version);
            const version = await api(path + "/publish", "POST", {
                revision: preview.revision,
                validationReceiptId: receipt.id,
            });
            return { resource, version };
        }
        const secret = await api(base + "/credentials", "POST", {
            secretRef: "reader",
            value: { token: "synthetic-desktop-secret" },
            allowedIdentityIds: ["reader"],
        });
        const adapter = await api(base + "/auth-adapters", "POST", {
            configuration: { kind: "HTTP_BEARER", identityPath: "/me", identityPointer: "/id" },
        });
        const environment = await publish("ENVIRONMENT", "desktop-env", {
            schemaVersion: "1.0",
            baseURL: "http://127.0.0.1:18891",
            apiBaseURL: "http://127.0.0.1:18891",
            allowedOrigins: ["http://127.0.0.1:18891"],
            locale: "en",
            timezone: "UTC",
            roles: [
                {
                    roleKey: "reader",
                    authAdapterVersionId: adapter.versionId,
                    secretRef: "reader",
                    secretVersionId: secret.versionId,
                    allowedIdentityIds: ["reader"],
                },
            ],
        });
        const catalog = await publish("ELEMENT_CATALOG", "desktop-catalog", {
            schemaVersion: "1.0",
            elements: [{ key: "ready", locator: { by: "testId", value: "ready" } }],
        });
        const testcase = await publish("CASE", "desktop-case", {
            schemaVersion: "1.0",
            caseKey: "desktop-case",
            title: "Desktop actual browser",
            kind: "READ",
            roleKey: "reader",
            catalogVersionId: catalog.version.id,
            steps: [
                {
                    id: "open",
                    action: "goto",
                    path: "/",
                    afterAssertions: [
                        {
                            id: "visible",
                            type: "ui",
                            severity: "BLOCK",
                            expectedSource: "Desktop business contract",
                            target: "ready",
                            operator: "visible",
                            expected: true,
                        },
                    ],
                },
            ],
        });
        console.log("Production candidate published actual immutable resource versions");
        await page
            .getByRole("button", { name: "停止在线领取 / Stop online worker", exact: true })
            .click();
        await expect
            .poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.online)
            .toBe(false);
        await page.getByRole("button", { name: "下载与导出", exact: true }).click();
        await page.getByTestId("bundle-resource").selectOption(testcase.resource.id);
        await page.getByTestId("bundle-version").selectOption(testcase.version.id);
        await page.getByTestId("bundle-add-case").click();
        await page.getByTestId("bundle-environment").selectOption(environment.resource.id);
        await page.getByTestId("bundle-environment-version").selectOption(environment.version.id);
        await page.getByTestId("bundle-export").focus();
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("bundle-item")).toHaveCount(1);
        const issuer = JSON.parse(await readFile(resolve(fixture, "issuer-public.json"), "utf8"));
        await page.getByRole("button", { name: "设置与诊断", exact: true }).click();
        await page.getByLabel("公钥 JSON / Public issuer JSON").fill(JSON.stringify(issuer));
        await page
            .getByLabel("已核对的 SHA256 指纹 / Verified fingerprint")
            .fill(issuer.keys[0].fingerprint);
        await page.getByRole("button", { name: "建立信任 / Trust issuer", exact: true }).click();
        await page.getByRole("button", { name: "下载与导出", exact: true }).click();
        await page.getByTestId("bundle-download").click();
        await expect
            .poll(
                async () => (await page.evaluate(() => window.veriq.state())).agent?.bundles.length,
                { timeout: 30000 },
            )
            .toBe(1);
        const bundle = (await page.evaluate(() => window.veriq.state())).agent!.bundles[0]!;
        await page.getByRole("button", { name: "本机缓存", exact: true }).click();
        await page.getByLabel("本机资源包 / Local package").selectOption(bundle.id);
        await page
            .getByLabel("JSON 凭证 / JSON credential")
            .fill(JSON.stringify({ token: "synthetic-desktop-secret" }));
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await expect(
            page.getByText("凭证已保存 / Credential saved", { exact: true }),
        ).toBeVisible();
        server.kill("SIGUSR1");
        await expect
            .poll(async () =>
                request.get(origin + "/api/v1/setup").then(
                    (r) => r.status(),
                    () => 0,
                ),
            )
            .toBe(0);
        await page.getByRole("button", { name: "独立执行", exact: true }).click();
        await expect
            .poll(
                async () =>
                    (await page.evaluate(() => window.veriq.state())).agent?.history[0]?.state,
                { timeout: 90000, intervals: [500, 1000] },
            )
            .toBe("FINISHED");
        await page.screenshot({
            path: resolve(evidence, "desktop-offline-executed-1280.png"),
            fullPage: true,
        });
        workflowFixture = { profile, fixture };
        console.log("Actual production candidate executed while control platform was offline");
    } finally {
        await teardownDesktop(electron, profile, agentPid, server);
    }
});

/** 后半验收复用前一真实链生成的持久包、数据库和报告，重启仅恢复同一隔离控制平面；本测试必须显式提供已有 profile 与签发者目录，绝不重建已发布资源或代写测试结果来掩盖恢复失败。 */
test("resume durable desktop evidence and upload acceptance", async ({ request }) => {
    test.skip(
        !process.env.VERIQ_T19_RESUME_PROFILE && !workflowFixture,
        "Requires the recorded real workflow profile",
    );
    test.setTimeout(180000);
    const root = resolve("../.."),
        evidence = resolve(
            root,
            process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19",
        );
    const profile = process.env.VERIQ_T19_RESUME_PROFILE ?? workflowFixture!.profile;
    const fixture = process.env.VERIQ_T19_RESUME_FIXTURE ?? workflowFixture!.fixture;
    const { spawn, execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const command = promisify(execFile);
    const server = trackFixture(
        spawn(
            "flock",
            [
                "-n",
                "-F",
                "/tmp/veriq-t12-db.lock",
                resolve(root, "apps/srv/.venv/bin/python"),
                resolve(root, "tests/e2e/desktop_server.py"),
                fixture,
                "--resume",
            ],
            { cwd: root, env: applicationEnvironment, stdio: ["ignore", "pipe", "pipe"] },
        ),
    );
    server.stdout.on(
        "data",
        (data) => void appendFile(resolve(evidence, "resume-server.log"), data),
    );
    server.stderr.on(
        "data",
        (data) => void appendFile(resolve(evidence, "resume-server.log"), data),
    );
    let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined,
        agentPid: number | undefined;
    try {
        await expect
            .poll(async () =>
                request.get("http://127.0.0.1:8888/api/v1/setup").then(
                    (r) => r.status(),
                    () => 0,
                ),
            )
            .toBe(200);
        electron = await _electron.launch({
            chromiumSandbox: true,
            executablePath: process.env.VERIQ_TEST_ELECTRON!,
            args: [resolve(".")],
            env: {
                ...applicationEnvironment,
                VERIQ_DESKTOP_PROFILE: profile,
                VERIQ_DESKTOP_NODE: process.execPath,
                ...(process.env.VERIQ_TEST_HEADED_BROWSER
                    ? { VERIQ_DESKTOP_HEADED_BROWSER: process.env.VERIQ_TEST_HEADED_BROWSER }
                    : {}),
                VERIQ_DESKTOP_ENGINE: engine.directory,
                VERIQ_DESKTOP_ENGINE_VERSION: engine.version,
                VERIQ_DESKTOP_BROWSER: resolve(
                    root,
                    ".superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell",
                ),
            },
        });
        electron
            .process()
            .stderr?.on(
                "data",
                (data) => void appendFile(resolve(evidence, "resume-electron.log"), data),
            );
        const page = await electron.firstWindow();
        page.on(
            "pageerror",
            (error) =>
                void appendFile(
                    resolve(evidence, "resume-electron.log"),
                    `renderer: ${error.message}\n`,
                ),
        );
        await expect
            .poll(
                async () =>
                    (await page.evaluate(() => window.veriq.state())).agent?.history.length ?? 0,
            )
            .toBeGreaterThan(0);
        const state = await page.evaluate(() => window.veriq.state());
        agentPid = state.agent!.pid;
        const original =
            state.agent!.history.find((item) => item.uploadState === "COMPLETE") ??
            state.agent!.history.at(-1)!;
        const runId = original.id;
        const snapshot: any = await page.evaluate(
            (id) => window.veriq.local({ operation: "report", runId: id }),
            runId,
        );
        expect(snapshot.reports[0].run.outcome).toBe("PASSED");
        expect(snapshot.reports[0].cases[0].attempts[0].facts.processStopped).toBe(true);
        expect(snapshot.reports[0].gateNow.passed).toBe(false);
        await appendFile(resolve(evidence, "actual-report-summary.json"), JSON.stringify(snapshot));
        await page.getByRole("button", { name: "报告与历史", exact: true }).click();
        await page.getByRole("button", { name: runId, exact: true }).click();
        await expect(page.getByTestId("report-gates")).toContainText("BLOCKED");
        await expect(
            page.getByText("OFFLINE_IMPORT, REVOCATION_UNKNOWN, RESULT_AUTHENTICITY_UNVERIFIED", {
                exact: true,
            }),
        ).toBeVisible();
        await page.getByRole("button", { name: /1 · PASSED/ }).click();
        await expect(
            page.getByRole("button", { name: "打开 Trace / Open Trace", exact: true }),
        ).toBeVisible();
        const nativeId = await electron.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.getNativeWindowHandle().readUInt32LE().toString(),
        );
        const nextWindow = electron.waitForEvent("window", { timeout: 20000 });
        await page.getByRole("button", { name: "打开 Trace / Open Trace", exact: true }).click();
        await command("import", ["-window", "root", resolve(evidence, "native-trace-confirm.png")]);
        await expect
            .poll(async () =>
                command("python", [resolve(root, "tests/e2e/native_confirm.py"), nativeId]).then(
                    () => true,
                    () => false,
                ),
            )
            .toBe(true);
        console.log("Owned native confirmation accepted");
        const viewer = await nextWindow;
        console.log("Native viewer attached", new URL(viewer.url()).origin);
        await viewer.screenshot({ path: resolve(evidence, "native-trace-attached.png") });
        await expect(viewer.locator("body")).toContainText("127.0.0.1:18891", { timeout: 20000 });
        expect(new URL(viewer.url()).hostname).toBe("127.0.0.1");
        expect(
            await viewer.evaluate(() => ({
                bridge: typeof Reflect.get(window, "veriq"),
                node: typeof Reflect.get(window, "process"),
                require: typeof Reflect.get(window, "require"),
            })),
        ).toEqual({ bridge: "undefined", node: "undefined", require: "undefined" });
        await viewer.screenshot({ path: resolve(evidence, "native-trace-loaded.png") });
        const children = await command("ps", ["--ppid", String(agentPid), "-o", "comm="]).then(
            (value) => value.stdout,
            (error) => {
                if (error.code === 1) return String(error.stdout ?? "");
                throw error;
            },
        );
        expect(children.trim()).toBe("");
        const viewerOrigin = new URL(viewer.url()).origin;
        await viewer.close();
        await expect
            .poll(async () =>
                request.get(viewerOrigin).then(
                    () => false,
                    () => true,
                ),
            )
            .toBe(true);
        expect((await page.evaluate(() => window.veriq.state())).agent?.pid).toBe(agentPid);
        console.log(
            "Real native Trace loaded and owned server reclaimed; Agent remained available without an OS viewer child",
        );
        if (original.uploadState !== "COMPLETE") {
            server.kill("SIGUSR1");
            await expect
                .poll(async () =>
                    request.get("http://127.0.0.1:8888/api/v1/setup").then(
                        () => false,
                        () => true,
                    ),
                )
                .toBe(true);
            await page.getByRole("button", { name: "回传结果", exact: true }).click();
            await expect
                .poll(
                    async () =>
                        (await page.evaluate(() => window.veriq.state())).agent?.history[0]
                            ?.uploadError,
                )
                .toBeTruthy();
            expect(
                (await page.evaluate(() => window.veriq.state())).agent!.history[0]!.uploadState,
            ).toBe("PENDING");
            server.kill("SIGUSR2");
            await expect
                .poll(async () =>
                    request.get("http://127.0.0.1:8888/api/v1/setup").then(
                        (r) => r.status(),
                        () => 0,
                    ),
                )
                .toBe(200);
            await page.getByRole("button", { name: "回传结果", exact: true }).click();
            await expect
                .poll(
                    async () =>
                        (await page.evaluate(() => window.veriq.state())).agent?.history[0]
                            ?.uploadState,
                    { timeout: 30000 },
                )
                .toBe("COMPLETE");
        } else
            console.log(
                "Original upload already completed; continuing its stable receipt and lifecycle checks",
            );
        const first = await page.evaluate(
            (id) => window.veriq.local({ operation: "upload", runId: id }),
            runId,
        );
        const second = await page.evaluate(
            (id) => window.veriq.local({ operation: "upload", runId: id }),
            runId,
        );
        expect(first).toEqual(second);
        await appendFile(resolve(evidence, "actual-upload-receipt.json"), JSON.stringify(first));
        await page.screenshot({
            path: resolve(evidence, "desktop-report-uploaded.png"),
            fullPage: true,
        });
        console.log("Offline upload failure persisted and recovered with stable receipt");
        await page.getByRole("button", { name: "本机缓存", exact: true }).click();
        await page
            .getByLabel("本机资源包 / Local package")
            .selectOption(state.agent!.bundles[0]!.id);
        if (process.env.VERIQ_TEST_HEADED_BROWSER) {
            await page.getByLabel("可见浏览器 / Visible browser", { exact: true }).check();
        }
        await request.post("http://127.0.0.1:18891/__hold");
        await page.getByRole("button", { name: "独立执行", exact: true }).click();
        await expect
            .poll(
                async () =>
                    (await (await request.get("http://127.0.0.1:18891/__state")).json()).waiting,
                { timeout: 30000 },
            )
            .toBe(1);
        const active = (await page.evaluate(() => window.veriq.state())).agent!.active!;
        expect(active.runId).not.toBe(runId);
        const headed = process.env.VERIQ_TEST_HEADED_BROWSER
            ? await observeHeadedRun(
                  profile,
                  agentPid!,
                  process.env.VERIQ_TEST_HEADED_BROWSER,
                  evidence,
              )
            : undefined;
        await electron.evaluate(async ({ BrowserWindow }) => {
            const windows = BrowserWindow.getAllWindows();
            const contents = windows[0]!.webContents;
            // 诊断保留原先选择首个窗口的语义，只记录有限窗口身份来区分目标选错、崩溃事件未到达和恢复加载失败；URL 不记录查询、片段或私有查看器路径，不能借观测泄露 Trace 入口能力。
            const location = (raw: string): string => {
                if (!raw) return "empty";
                const url = new URL(raw);
                return url.protocol === "veriq:" && url.hostname === "app"
                    ? "veriq://app/" + (url.pathname === "/index.html" ? "index.html" : "other")
                    : url.protocol + "//" + url.hostname;
            };
            let count = 0;
            const observe = (event: string, detail: Record<string, unknown> = {}) => {
                if (count++ >= 24) return;
                console.error(
                    "Renderer recovery observation",
                    JSON.stringify({
                        event,
                        at: Date.now(),
                        webContentsId: contents.id,
                        rendererPid: contents.isDestroyed() ? null : contents.getOSProcessId(),
                        loading: contents.isDestroyed() ? null : contents.isLoading(),
                        ...detail,
                    }),
                );
            };
            observe("before-crash", {
                selectedWindowId: windows[0]!.id,
                windowCount: windows.length,
                windows: windows.slice(0, 8).map((window) => ({
                    id: window.id,
                    webContentsId: window.webContents.id,
                    rendererPid: window.webContents.getOSProcessId(),
                    location: location(window.webContents.getURL()),
                })),
            });
            // 被动监听最多输出二十四条元数据，不覆盖 loadURL、不处理异常、不重载窗口，也不改变正式测试预算；did-fail-load 仅保留错误码和主 frame 标志，错误描述及实际导航地址不进入日志。
            contents.on("render-process-gone", (_event, details) =>
                observe("render-process-gone", {
                    reason: details.reason,
                    exitCode: details.exitCode,
                }),
            );
            contents.on("did-start-loading", () => observe("did-start-loading"));
            contents.on("did-finish-load", () => observe("did-finish-load"));
            contents.on("did-stop-loading", () => observe("did-stop-loading"));
            contents.on("destroyed", () => observe("destroyed"));
            contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) =>
                observe("did-fail-load", { code, mainFrame }),
            );
            const restored = new Promise<void>((resolve) =>
                contents.once("did-finish-load", () => resolve()),
            );
            contents.forcefullyCrashRenderer();
            await restored;
        });
        await expect
            .poll(() =>
                electron!.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(
                        "document.querySelector('h1')?.textContent",
                    ),
                ),
            )
            .toBe("工作台");
        const crashState = await electron.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript("window.veriq.state()"),
        );
        expect(crashState.agent.active.runId).toBe(active.runId);
        const recoveredImage = await electron.evaluate(async ({ BrowserWindow }) =>
            (await BrowserWindow.getAllWindows()[0]!.capturePage()).toPNG().toString("base64"),
        );
        await (
            await import("node:fs/promises")
        ).writeFile(
            resolve(evidence, "desktop-renderer-recovered.png"),
            Buffer.from(recoveredImage, "base64"),
        );
        const previous = electron;
        const quitNativeId = await previous.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.getNativeWindowHandle().readUInt32LE().toString(),
        );
        await previous.evaluate(async ({ BrowserWindow }) => {
            const contents = BrowserWindow.getAllWindows()[0]!.webContents;
            const point = await contents.executeJavaScript(
                "(() => { const r = [...document.querySelectorAll('button')].find(b => b.textContent === '退出界面').getBoundingClientRect(); return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)}; })()",
            );
            contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
            contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
        });
        await expect
            .poll(async () =>
                command("python", [
                    resolve(root, "tests/e2e/native_confirm.py"),
                    quitNativeId,
                ]).then(
                    () => true,
                    () => false,
                ),
            )
            .toBe(true);
        await expect.poll(() => previous.process().exitCode).toBe(0);
        expect(() => process.kill(agentPid!, 0)).not.toThrow();
        electron = await _electron.launch({
            chromiumSandbox: true,
            executablePath: process.env.VERIQ_TEST_ELECTRON!,
            args: [resolve(".")],
            env: {
                ...applicationEnvironment,
                VERIQ_DESKTOP_PROFILE: profile,
                VERIQ_DESKTOP_NODE: process.execPath,
                ...(process.env.VERIQ_TEST_HEADED_BROWSER
                    ? { VERIQ_DESKTOP_HEADED_BROWSER: process.env.VERIQ_TEST_HEADED_BROWSER }
                    : {}),
                VERIQ_DESKTOP_ENGINE: engine.directory,
                VERIQ_DESKTOP_ENGINE_VERSION: engine.version,
                VERIQ_DESKTOP_BROWSER: resolve(
                    root,
                    ".superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell",
                ),
            },
        });
        const reopened = await electron.firstWindow();
        await expect
            .poll(async () => (await reopened.evaluate(() => window.veriq.state())).agent?.pid)
            .toBe(agentPid);
        expect((await reopened.evaluate(() => window.veriq.state())).agent!.active!.runId).toBe(
            active.runId,
        );
        await request.post("http://127.0.0.1:18891/__release");
        await expect
            .poll(
                async () =>
                    (await reopened.evaluate(() => window.veriq.state())).agent?.history.find(
                        (item) => item.id === active.runId,
                    )?.state,
                { timeout: 30000 },
            )
            .toBe("FINISHED");
        const restoredReport: any = await reopened.evaluate(
            (id) => window.veriq.local({ operation: "report", runId: id }),
            active.runId,
        );
        expect(restoredReport.reports[0].run.outcome).toBe("PASSED");
        if (headed) {
            expect(restoredReport.reports[0].cases[0].attempts[0].id).toBe(headed.attemptId);
            await assertHeadedStopped(
                profile,
                headed,
                restoredReport.reports[0].cases[0].attempts[0].facts.processStopped,
                evidence,
            );
        }
        console.log("Active run survived actual renderer crash and confirmed UI quit/reopen");
        await reopened.getByRole("button", { name: "本机缓存", exact: true }).click();
        await reopened
            .getByLabel("本机资源包 / Local package")
            .selectOption(state.agent!.bundles[0]!.id);
        await request.post("http://127.0.0.1:18891/__hold");
        await reopened.getByRole("button", { name: "独立执行", exact: true }).click();
        await expect
            .poll(
                async () =>
                    (await reopened.evaluate(() => window.veriq.state())).agent?.active?.runId,
                { timeout: 30000 },
            )
            .not.toBeUndefined();
        const cancelled = (await reopened.evaluate(() => window.veriq.state())).agent!.active!
            .runId;
        await reopened.getByRole("button", { name: "取消执行", exact: true }).click();
        await expect
            .poll(
                async () =>
                    (await reopened.evaluate(() => window.veriq.state())).agent?.history.find(
                        (item) => item.id === cancelled,
                    )?.state,
                { timeout: 30000 },
            )
            .toBe("FINISHED");
        const cancellation: any = await reopened.evaluate(
            (id) => window.veriq.local({ operation: "report", runId: id }),
            cancelled,
        );
        expect(cancellation.reports[0].run.outcome).toBe("CANCELLED");
        expect(cancellation.reports[0].cases[0].attempts[0].facts.processStopped).toBe(true);
        await request.post("http://127.0.0.1:18891/__release");
        await reopened.getByRole("button", { name: "工作台", exact: true }).click();
        const stopNativeId = await electron.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.getNativeWindowHandle().readUInt32LE().toString(),
        );
        await reopened.getByRole("button", { name: "停止后台", exact: true }).click();
        await expect
            .poll(async () =>
                command("python", [
                    resolve(root, "tests/e2e/native_confirm.py"),
                    stopNativeId,
                ]).then(
                    () => true,
                    () => false,
                ),
            )
            .toBe(true);
        await expect
            .poll(async () =>
                readFile(resolve(profile, "desktop-agent.json")).then(
                    () => false,
                    () => true,
                ),
            )
            .toBe(true);
        if (agentPid) await stopTestAgent(profile, agentPid);
        agentPid = undefined;
        await previous.close();
        console.log(
            "Cancellation has a positive stop receipt and explicit native Agent stop completed",
        );
    } catch (error) {
        console.error("Native continuation failed:", error);
        throw error;
    } finally {
        await teardownDesktop(electron, profile, agentPid, server);
    }
});

/** 控制服务不运行时仍从已验签包打开共享资源页及实际生成的 TypeScript，监控加载的本地产物与 CSP 错误；本例同时确认第二实例不会新建后台，普通关闭窗口不会终止执行服务。 */
test("offline shared resource assets and single instance remain local", async ({ request }) => {
    test.skip(
        !process.env.VERIQ_T19_RESUME_PROFILE && !workflowFixture,
        "Requires the recorded real workflow profile",
    );
    const root = resolve("../.."),
        evidence = resolve(
            root,
            process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19",
        );
    const profile = process.env.VERIQ_T19_RESUME_PROFILE ?? workflowFixture!.profile;
    await expect(request.get("http://127.0.0.1:8888/api/v1/setup")).rejects.toThrow();
    const env = {
        ...applicationEnvironment,
        VERIQ_DESKTOP_PROFILE: profile,
        VERIQ_DESKTOP_NODE: process.execPath,
        VERIQ_DESKTOP_ENGINE: engine.directory,
        VERIQ_DESKTOP_ENGINE_VERSION: engine.version,
        VERIQ_DESKTOP_BROWSER: resolve(
            root,
            ".superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell",
        ),
    };
    const electron = await _electron.launch({
        chromiumSandbox: true,
        executablePath: process.env.VERIQ_TEST_ELECTRON!,
        args: [resolve(".")],
        env,
    });
    let agentPid: number | undefined;
    try {
        const page = await electron.firstWindow();
        const errors: string[] = [],
            assets: { url: string; status: number }[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
        });
        page.on("response", (response) =>
            assets.push({ url: response.url(), status: response.status() }),
        );
        await expect
            .poll(
                async () =>
                    (await page.evaluate(() => window.veriq.state())).agent?.bundles.length ?? 0,
            )
            .toBeGreaterThan(0);
        const state = await page.evaluate(() => window.veriq.state());
        agentPid = state.agent!.pid;
        await page.getByRole("button", { name: "本机缓存", exact: true }).click();
        await page
            .getByLabel("本机资源包 / Local package")
            .selectOption(state.agent!.bundles[0]!.id);
        await expect(
            page.getByLabel("可见浏览器 / Visible browser", { exact: true }),
        ).toBeDisabled();
        await page.getByTestId("resource-open-desktop-case").click();
        const version = await page
            .getByTestId("resource-version")
            .locator("option")
            .nth(1)
            .getAttribute("value");
        await page.getByTestId("resource-version").selectOption(version!);
        await expect(page.getByTestId("case.generated-file").locator("option")).not.toHaveCount(1);
        const file = await page
            .getByTestId("case.generated-file")
            .locator("option")
            .nth(1)
            .getAttribute("value");
        await page.getByTestId("case.generated-file").selectOption(file!);
        await expect(
            page.getByTestId("case.generated-source").locator(".monaco-editor"),
        ).toBeVisible();
        await expect(page.getByTestId("case.generated-source")).toContainText("import");
        await expect(page.getByTestId("case.generated-source")).toHaveAttribute(
            "data-mode-id",
            "typescript",
        );
        await expect.poll(() => assets.some((asset) => asset.url.includes("ts.worker"))).toBe(true);
        await page.screenshot({
            path: resolve(evidence, "desktop-offline-source.png"),
            fullPage: true,
        });
        expect(
            await page.evaluate(() =>
                fetch("https://example.com/").then(
                    () => false,
                    () => true,
                ),
            ),
        ).toBe(true);
        expect(
            assets.every((asset) => asset.url.startsWith("veriq://app/") && asset.status === 200),
        ).toBe(true);
        expect(
            errors.filter(
                (error) =>
                    !error.includes("https://example.com/") && !error.includes("Failed to fetch"),
            ),
        ).toEqual([]);
        await appendFile(
            resolve(evidence, "offline-assets.jsonl"),
            JSON.stringify({ assets, errors, file, version }) + "\n",
        );
        const original = state.agent!.history.find((item) => item.uploadState === "COMPLETE")!;
        await page.getByRole("button", { name: "报告与历史", exact: true }).click();
        await page.getByRole("button", { name: original.id, exact: true }).click();
        await page.getByRole("button", { name: /1 · PASSED/ }).click();
        const files = await import("node:fs/promises");
        const exportPath = resolve(profile, "exports");
        const priorExports = (await files.readdir(exportPath)).sort();
        const imageWindow = electron.waitForEvent("window");
        await page
            .getByRole("button", { name: "预览截图 / Preview screenshot", exact: true })
            .click();
        const nativeId = await electron.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
                .find((window) => window.webContents.getURL().startsWith("veriq://"))!
                .getNativeWindowHandle()
                .readUInt32LE()
                .toString(),
        );
        const { execFile } = await import("node:child_process");
        const command = (await import("node:util")).promisify(execFile);
        await expect
            .poll(async () =>
                command("python", [resolve(root, "tests/e2e/native_confirm.py"), nativeId]).then(
                    () => true,
                    () => false,
                ),
            )
            .toBe(true);
        const image = await imageWindow;
        await expect
            .poll(() =>
                image
                    .locator("img")
                    .evaluate((element) => (element as HTMLImageElement).naturalWidth),
            )
            .toBeGreaterThan(0);
        expect(
            await image.evaluate(() => ({
                bridge: typeof Reflect.get(window, "veriq"),
                node: typeof Reflect.get(window, "process"),
            })),
        ).toEqual({ bridge: "undefined", node: "undefined" });
        await image.screenshot({ path: resolve(evidence, "native-image-loaded.png") });
        await image.close();
        await expect
            .poll(async () => (await files.readdir(exportPath)).sort())
            .toEqual(priorExports);
        await page
            .getByRole("button", { name: "预览截图 / Preview screenshot", exact: true })
            .click();
        await expect
            .poll(async () =>
                command("python", [
                    resolve(root, "tests/e2e/native_confirm.py"),
                    nativeId,
                    "cancel",
                ]).then(
                    () => true,
                    () => false,
                ),
            )
            .toBe(true);
        expect(
            await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
        ).toBe(1);
        expect((await files.readdir(exportPath)).sort()).toEqual(priorExports);
        expect((await page.evaluate(() => window.veriq.state())).agent!.pid).toBe(agentPid);
        const { spawn } = await import("node:child_process");
        const secondary = spawn(process.env.VERIQ_TEST_ELECTRON!, [resolve(".")], {
            env,
            stdio: "ignore",
        });
        await expect.poll(() => secondary.exitCode).toBe(0);
        expect((await page.evaluate(() => window.veriq.state())).agent!.pid).toBe(agentPid);
        expect(
            await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
        ).toBe(1);
        await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
        expect(
            await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
        ).toBe(1);
        expect(() => process.kill(agentPid!, 0)).not.toThrow();
    } finally {
        await teardownDesktop(electron, profile, agentPid);
    }
});

/** 联网共享编辑器的创建、JSON 保存、编译与发布均由实际窗口触发，后台继续消费相同生产候选；AI 页面只读取配置和禁用状态，不配置模型密钥、不调用外部供应商，也不替换实际校验回执。 */
test("shared cloud editor publishes through the desktop host transport", async ({ request }) => {
    test.skip(
        !process.env.VERIQ_T19_RESUME_PROFILE && !workflowFixture,
        "Requires the recorded real workflow profile",
    );
    test.setTimeout(120000);
    const root = resolve("../.."),
        evidence = resolve(
            root,
            process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19",
        );
    const profile = process.env.VERIQ_T19_RESUME_PROFILE ?? workflowFixture!.profile;
    const fixture = process.env.VERIQ_T19_RESUME_FIXTURE ?? workflowFixture!.fixture;
    const { spawn } = await import("node:child_process");
    const server = trackFixture(
        spawn(
            "flock",
            [
                "-n",
                "-F",
                "/tmp/veriq-t12-db.lock",
                resolve(root, "apps/srv/.venv/bin/python"),
                resolve(root, "tests/e2e/desktop_server.py"),
                fixture,
                "--resume",
            ],
            { cwd: root, env: applicationEnvironment, stdio: ["ignore", "pipe", "pipe"] },
        ),
    );
    server.stdout.on(
        "data",
        (data) => void appendFile(resolve(evidence, "cloud-editor-server.log"), data),
    );
    server.stderr.on(
        "data",
        (data) => void appendFile(resolve(evidence, "cloud-editor-server.log"), data),
    );
    let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined,
        agentPid: number | undefined;
    try {
        await expect
            .poll(async () =>
                request.get("http://127.0.0.1:8888/api/v1/setup").then(
                    (r) => r.status(),
                    () => 0,
                ),
            )
            .toBe(200);
        electron = await _electron.launch({
            chromiumSandbox: true,
            executablePath: process.env.VERIQ_TEST_ELECTRON!,
            args: [resolve(".")],
            env: {
                ...applicationEnvironment,
                VERIQ_DESKTOP_PROFILE: profile,
                VERIQ_DESKTOP_NODE: process.execPath,
                VERIQ_DESKTOP_ENGINE: engine.directory,
                VERIQ_DESKTOP_ENGINE_VERSION: engine.version,
                VERIQ_DESKTOP_BROWSER: resolve(
                    root,
                    ".superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell",
                ),
            },
        });
        const page = await electron.firstWindow();
        await expect
            .poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.pid)
            .toBeTruthy();
        agentPid = (await page.evaluate(() => window.veriq.state())).agent!.pid;
        await page.getByLabel("邮箱 / Email").fill("desktop-admin@example.com");
        await page.getByLabel("密码 / Password").fill("Desktop password 123!");
        await page.getByRole("button", { name: "登录", exact: true }).click();
        const workspaceId = (await page.evaluate(() => window.veriq.state())).agent!.device!
            .workspaceId;
        await expect(
            page
                .getByLabel("平台工作区 / Platform workspace")
                .locator(`option[value="${workspaceId}"]`),
        ).toHaveCount(1);
        await page.getByLabel("平台工作区 / Platform workspace").selectOption(workspaceId);
        await page
            .getByRole("button", { name: "启动在线领取 / Start online worker", exact: true })
            .click();
        await expect
            .poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.online)
            .toBe(true);
        await page.getByRole("button", { name: "云端资源", exact: true }).click();
        const key = "desktop-ui-" + Date.now();
        await page.getByTestId("resource-kind").selectOption("ELEMENT_CATALOG");
        await page.getByTestId("resource-key").fill(key);
        await page.getByTestId("resource-name").fill("Actual desktop UI catalog");
        await page.getByTestId("resource-create").click();
        await page.getByTestId("resource-json-tab").click();
        const input = page.getByTestId("resource-json").locator("textarea");
        await input.focus();
        await input.press("ControlOrMeta+a");
        await page.keyboard.insertText(
            JSON.stringify(
                {
                    kind: "ELEMENT_CATALOG",
                    document: {
                        schemaVersion: "1.0",
                        elements: [
                            { key: "actual", locator: { by: "testId", value: "actual-ui" } },
                        ],
                    },
                },
                null,
                4,
            ),
        );
        await page.getByTestId("resource-json-apply").click();
        await page.getByTestId("resource-save").click();
        await expect(page.getByText("已保存", { exact: true })).toBeVisible();
        await page.getByTestId("case.validate").click();
        await expect(page.getByTestId("case.publish")).toBeEnabled({ timeout: 45000 });
        await page.getByTestId("case.publish").click();
        await expect(page.getByTestId("case.published-version")).toContainText("v1");
        await page.screenshot({
            path: resolve(evidence, "desktop-cloud-published.png"),
            fullPage: true,
        });
        const publication = await page.getByTestId("case.published-version").innerText();
        await appendFile(
            resolve(evidence, "cloud-editor-publications.jsonl"),
            JSON.stringify({ key, publication, workspaceId }) + "\n",
        );
        await page.getByRole("button", { name: "AI 辅助", exact: true }).click();
        await expect(page.getByTestId("ai-empty")).toBeVisible();
        await expect(page.getByTestId("ai-execution-independent")).toBeVisible();
        await page.getByRole("button", { name: "工作台", exact: true }).click();
        await page
            .getByRole("button", { name: "停止在线领取 / Stop online worker", exact: true })
            .click();
        await expect
            .poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.online)
            .toBe(false);
        const retainedCookies = await electron.evaluate(({ session }) =>
            session
                .fromPartition("persist:veriq-host")
                .cookies.get({ url: "http://127.0.0.1:8888" }),
        );
        const oldSession = retainedCookies.find((cookie) => cookie.name === "veriq_session");
        expect(oldSession).toBeDefined();
        const retainedCookie = `${oldSession!.name}=${oldSession!.value}`;
        expect(
            (
                await request.get("http://127.0.0.1:8888/api/v1/auth/session", {
                    headers: { Cookie: retainedCookie },
                })
            ).status(),
        ).toBe(200);
        await page.getByRole("button", { name: "退出登录", exact: true }).click();
        await expect
            .poll(async () =>
                (
                    await request.get("http://127.0.0.1:8888/api/v1/auth/session", {
                        headers: { Cookie: retainedCookie },
                    })
                ).status(),
            )
            .toBe(401);
        await expect
            .poll(async () => (await page.evaluate(() => window.veriq.state())).user)
            .toBeUndefined();
        expect((await page.evaluate(() => window.veriq.state())).agent!.device!.workspaceId).toBe(
            workspaceId,
        );
        console.log(
            "Copied ordinary Cookie revoked by server after GUI logout; device binding retained",
        );
    } finally {
        await teardownDesktop(electron, profile, agentPid, server);
    }
});

/** 本例仅验证准备中状态的实际 React 渲染与按钮参数，使用明确的组件级 bridge 替身，不宣称后台启动或业务执行成功；真实门闩与控制器归属由独立 Agent 测试覆盖，避免为了一个状态重跑完整签发链。 */
test("component-only startup projection cancels its exact reservation", async () => {
    const root = resolve("../.."),
        assets = resolve("out/renderer");
    const browser = await chromium.launch({
        env: applicationEnvironment,
        chromiumSandbox: true,
        executablePath: resolve(
            root,
            ".superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell",
        ),
        headless: true,
    });
    try {
        const page = await browser.newPage();
        await page.route("**/*", async (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== "https://desktop-component.invalid") return route.abort();
            const path = resolve(
                assets,
                "." + (url.pathname === "/" ? "/index.html" : url.pathname),
            );
            if (!path.startsWith(assets + "/")) return route.abort();
            await route.fulfill({
                body: await readFile(path),
                contentType: path.endsWith(".js")
                    ? "text/javascript"
                    : path.endsWith(".css")
                      ? "text/css"
                      : "text/html",
            });
        });
        await page.addInitScript(() => {
            const calls: unknown[] = [];
            const value = {
                origin: "https://platform.example",
                tray: false,
                version: "component-test",
                agent: {
                    node: "24.22.1",
                    pid: 1,
                    active: null,
                    online: false,
                    bundles: [],
                    history: [],
                    headedAvailable: false,
                    browser: { available: true, source: "Component fixture" },
                    preparing: {
                        id: "11111111-1111-4111-8111-111111111111",
                        operation: "run",
                        cancelling: false,
                    },
                },
            };
            Object.defineProperty(window, "componentCalls", { value: calls });
            Object.defineProperty(window, "veriq", {
                value: {
                    state: async () => structuredClone(value),
                    local: async (command: unknown) => {
                        calls.push(command);
                        value.agent.preparing.cancelling = true;
                        return { requested: true };
                    },
                },
            });
        });
        await page.goto("https://desktop-component.invalid/");
        await page.getByRole("button", { name: "本机缓存", exact: true }).click();
        await expect(
            page.getByText("正在准备执行 / Preparing execution", { exact: false }),
        ).toBeVisible();
        await page.getByRole("button", { name: "取消启动 / Cancel startup", exact: true }).click();
        await expect(
            page.getByRole("button", { name: "取消启动 / Cancel startup", exact: true }),
        ).toBeDisabled();
        expect(await page.evaluate(() => Reflect.get(window, "componentCalls"))).toEqual([
            { operation: "cancel", startupId: "11111111-1111-4111-8111-111111111111" },
        ]);
    } finally {
        await browser.close();
    }
});
