import { test, expect, _electron, chromium } from "../../apps/desktop/tests/fixtures";
import { mkdtemp, rm, appendFile, readFile, mkdir, writeFile, realpath, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { trackFixture, stopFixture } from "./lifecycle";
import { stopTestAgent } from "./agent-owner";
import { closeTestDesktop } from "./desktop-close";
import { selectDesktopWorkspace } from "./desktop-workspace";
import { testEngine } from "./engine";
import { observeHeadedRun, assertHeadedStopped } from "./headed";
import { terminateRenderer } from "./renderer-fault";
import type { RecordingEvent } from "../../apps/desktop/src/shared/recording";
let engine: Awaited<ReturnType<typeof testEngine>>;
test.beforeAll(async () => {
    engine = await testEngine(resolve("../.."));
    const desktopRequire = createRequire(resolve("package.json"));
    Object.assign(applicationEnvironment, {
        VERIQ_TEST_COMPILER_NODE: process.execPath,
        VERIQ_TEST_COMPILER_NPM: await realpath(resolve(dirname(process.execPath), "npm")),
        VERIQ_TEST_COMPILER_TSX: await realpath(desktopRequire.resolve("tsx")),
    });
    await mkdir(resolve("../..", process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19"), {
        recursive: true,
    });
});
type WorkflowFixture = {
    profile: string;
    fixture: string;
    workspaceId: string;
    runtimeId: string;
    caseVersionId: string;
    catalogVersionId: string;
    environmentVersionId: string;
    runId: string;
};
let workflowFixture: WorkflowFixture | undefined;
async function requireWorkflow(): Promise<WorkflowFixture> {
    if (!workflowFixture) {
        const evidence = resolve(
            "../..",
            process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19",
        );
        const recorded = JSON.parse(await readFile(resolve(evidence, "connected-workflow-fixture.json"), "utf8"));
        if (!process.env.VERIQ_DESKTOP_SUITE_ID || recorded.suiteId !== process.env.VERIQ_DESKTOP_SUITE_ID)
            throw new Error("CONNECTED_WORKFLOW_SUITE_MISMATCH");
        if (recorded.engineHash !== engine.hash) throw new Error("CONNECTED_WORKFLOW_ENGINE_MISMATCH");
        workflowFixture = recorded.workflow as WorkflowFixture;
    }
    return workflowFixture;
}

// pw:browser 诊断只属于测试驱动，实际 Electron、控制夹具及组件浏览器使用移除 DEBUG 后的宿主环境；独立 Agent
// 随后继承的是 Electron 的干净环境，不能把驱动日志选项传进业务 SDK。
const applicationEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== "DEBUG",
    ),
);
// 运行模式只由本套件的专属有头档案显式选择，宿主环境残留的模式不能把其它新建档案暗中改成有头。
delete applicationEnvironment.VERIQ_DESKTOP_BROWSER_MODE;

/**
 * 测试清理按后台、窗口、数据库夹具顺序收敛，并在任一步失败后仍尝试关闭其余自有资源；收集到的失败最终统一抛出，
 * 不让一个清理异常跳过释放数据库锁，也不把发送信号或框架返回当作真实进程停止。
 */
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
            if (electron) await closeTestDesktop(electron);
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

/**
 * 最小窗口检查必须启动真实已打包 Electron，并从实际 preload 与独立后台读取状态；浏览器模拟页面、缺失二进制或缺少
 * DISPLAY 都不能代替这个产品行为测试的结果。
 */
test("bundled desktop opens offline with strict renderer and independent Node24", async () => {
    const root = resolve("../.."),
        profile = await realpath(await mkdtemp("/tmp/veriq-t19-gui-"));
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
                ".superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-hea" +
                    "dless-shell",
            ),
        },
    });
    console.log("Electron connected");
    electron.process().stderr?.on("data", (chunk) => void appendFile(log, chunk));
    electron.process().stdout?.on("data", (chunk) => void appendFile(log, chunk));
    let agentPid: number | undefined;
    try {
        const page = await electron.firstWindow({ timeout: 10000 });
        await page.getByLabel("语言 / Language").selectOption("zh");
        console.log("First window connected", page.url());
        const versions = await electron.evaluate(({ BrowserWindow }) => {
            const contents = BrowserWindow.getAllWindows()[0]!.webContents;
            const preferences = Reflect.apply(Reflect.get(contents, "getLastWebPreferences"), contents, []) as {
                sandbox?: boolean;
            };
            return {
                electron: process.versions.electron,
                uiNode: process.versions.node,
                uiChromium: process.versions.chrome,
                sandbox: preferences.sandbox,
            };
        });
        expect(versions.sandbox).toBe(true);
        await appendFile(
            resolve(
                root,
                process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19",
                "gui-runtime-versions.json",
            ),
            JSON.stringify({ ...versions, independentNode: process.versions.node }) + "\n",
        );
        page.on("console", (message) => void appendFile(log, `renderer ${message.type()}: ${message.text()}\n`));
        page.on("pageerror", (error) => void appendFile(log, `page error: ${error.message}\n`));
        await expect(page.getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
        await expect
            .poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.node)
            .toBe(process.versions.node);
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
        await expect(page.getByText("离线 / 未登录", { exact: true })).toBeVisible();
        for (const operation of ["run", "upload", "download"]) {
            await expect(
                page.evaluate((operation) => Reflect.apply(window.veriq.local, undefined, [{ operation }]), operation),
            ).rejects.toThrow("IPC_OPERATION_DENIED");
        }
        await page.getByRole("button", { name: "报告与历史", exact: true }).click();
        await page.getByRole("button", { name: "本机报告 / Local reports", exact: true }).click();
        await expect(page.getByText("尚无本机执行记录", { exact: true })).toBeVisible();
        await page.getByLabel("语言 / Language").selectOption("en");
        await expect(page.getByRole("heading", { name: "Reports & history", exact: true })).toBeVisible();
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
                await Reflect.apply(window.veriq.local, undefined, [{ operation: "spawn", command: "sh" }]);
                return false;
            } catch {
                return true;
            }
        });
        expect(forbidden).toBe(true);
    } catch (error) {
        console.error("Desktop smoke primary failure:", error);
        throw error;
    } finally {
        console.log("Closing UI test process");
        await teardownDesktop(electron, profile, agentPid);
        // 失败时保留完整私有 profile 供诊断；正常退出须等后台描述文件消失后再清理，避免把存活后台的锁和数据库误删，
        // 这个早期空闲冒烟清理不用于证明活动 Run 的生命周期。
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

/**
 * 完整链路只通过真实平台 API 准备业务输入，随后由桌面绑定的独立 Agent 消费生产器候选生成回执；控制平面停止后继续访问业
 * 务站点，报告与回传必须来自实际签名包执行而非注入结果。
 */
test("production candidate completes the real connected desktop workflow", async ({ request }) => {
    test.setTimeout(420000);
    const root = resolve("../..");
    const evidence = resolve(root, process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19");
    const profile = await realpath(await mkdtemp("/tmp/veriq-t19-full-"));
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
                    ".superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome" +
                        "-headless-shell",
                ),
            },
        });
        electron.process().stderr?.on("data", (data) => void appendFile(resolve(evidence, "full-electron.log"), data));
        const page = await electron.firstWindow();
        await page.getByLabel("语言 / Language").selectOption("zh");
        page.on(
            "pageerror",
            (error) => void appendFile(resolve(evidence, "full-electron.log"), `renderer: ${error.message}\n`),
        );
        await expect(page.getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
        await expect
            .poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.node)
            .toBe(process.versions.node);
        agentPid = (await page.evaluate(() => window.veriq.state())).agent?.pid;
        await page.getByLabel("邮箱 / Email").fill("desktop-admin@example.com");
        await page.getByLabel("密码 / Password").fill("Desktop password 123!");
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await expect(
            page.getByLabel("平台工作区 / Platform workspace").locator(`option[value="${workspace.id}"]`),
        ).toHaveCount(1);
        await selectDesktopWorkspace(page, workspace.id);
        console.log("Desktop ordinary login and workspace selected");
        await page.getByLabel("共享给工作区 / Share with workspace").check();
        await page.getByRole("button", { name: "发起绑定 / Enroll", exact: true }).click();
        await expect(page.getByTestId("enrollment-code")).toBeVisible({ timeout: 20000 });
        await page.getByRole("button", { name: "批准并完成绑定 / Approve binding", exact: true }).click();
        await expect
            .poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.device?.workspaceId)
            .toBe(workspace.id);
        const device = (await page.evaluate(() => window.veriq.state())).agent!.device!;
        await api(base + `/runtimes/${device.id}/trust`, "PUT", {
            trustStatus: "MANAGED",
            allowCredentialDelivery: true,
        });
        await page.getByRole("button", { name: "启动在线领取 / Start online worker", exact: true }).click();
        await expect.poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.online).toBe(true);
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
        const recording = await page.evaluate(
            async ({ workspaceId, resourceId, versionId }) => {
                const events: RecordingEvent[] = [];
                Reflect.set(window, "__recordingObservation", events);
                Reflect.set(
                    window,
                    "__stopRecordingObservation",
                    window.veriq.recordingEvents((event) => events.push(event)),
                );
                const { sessionId } = await window.veriq.recordingOpen({
                    workspaceId,
                    resourceId,
                    versionId,
                    target: "/recording",
                });
                await window.veriq.recordingMode(sessionId, "record");
                await window.veriq.recordingBounds(sessionId, { x: 20, y: 70, width: 500, height: 360 });
                return sessionId;
            },
            { workspaceId: workspace.id, resourceId: environment.resource.id, versionId: environment.version.id },
        );
        try {
            await expect
                .poll(() =>
                    electron!.evaluate(({ BrowserWindow }) => {
                        const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0];
                        return view?.getVisible();
                    }),
                )
                .toBe(true);
            const inspect = await electron.evaluate(async ({ BrowserWindow, WebContentsView }) => {
                const owner = BrowserWindow.getAllWindows()[0];
                const view = owner?.contentView.children.find((child) => child instanceof WebContentsView);
                if (!view || !owner) throw new Error("RECORDING_VIEW_MISSING");
                const contents = view.webContents;
                owner.focus();
                contents.focus();
                const preferences = Reflect.apply(Reflect.get(contents, "getLastWebPreferences"), contents, []) as {
                    sandbox?: boolean;
                    nodeIntegration?: boolean;
                };
                const isolated = await contents.executeJavaScript(
                    "[typeof window.veriq, typeof window.process, typeof window.require].join(':')",
                );
                return {
                    isolated,
                    distinctSession: owner.webContents.session !== contents.session,
                    persistent: contents.session.isPersistent(),
                    sandbox: preferences.sandbox,
                    nodeIntegration: preferences.nodeIntegration,
                };
            });
            expect(inspect).toEqual({
                isolated: "undefined:undefined:undefined",
                distinctSession: true,
                persistent: false,
                sandbox: true,
                nodeIntegration: false,
            });
            const click = () =>
                electron!.evaluate(({ BrowserWindow, WebContentsView }) => {
                    const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find(
                        (child) => child instanceof WebContentsView,
                    );
                    if (!view) throw new Error("RECORDING_VIEW_MISSING");
                    view.webContents.focus();
                    for (const type of ["mouseDown", "mouseUp"] as const)
                        view.webContents.sendInputEvent({ type, x: 20, y: 20, button: "left", clickCount: 1 });
                });
            const observed = () =>
                page.evaluate(() => Reflect.get(window, "__recordingObservation") as RecordingEvent[]);
            await click();
            await expect
                .poll(async () => (await observed()).filter((event) => event.type === "click"))
                .toEqual([
                    expect.objectContaining({
                        candidates: expect.arrayContaining([
                            { locator: { by: "veriqId", value: "apply" }, matches: 1 },
                        ]),
                    }),
                ]);
            await page.evaluate((id) => window.veriq.recordingMode(id, "annotate"), recording);
            await expect
                .poll(() =>
                    electron!.evaluate(({ BrowserWindow }) =>
                        BrowserWindow.getAllWindows()[0]?.contentView.children[0]?.getVisible(),
                    ),
                )
                .toBe(true);
            await click();
            const currentTarget = () =>
                observed().then((events) => events.find((event) => event.type === "annotation-target"));
            await expect.poll(async () => (await currentTarget())?.actions).toContain("catalog");
            const target = await currentTarget();
            expect(target?.actions).not.toContain("captureOptions");
            await page.evaluate(
                ({ recording, id }) => window.veriq.recordingAnnotationAction(recording, id, "catalog"),
                {
                    recording,
                    id: target!.id,
                },
            );
            await expect
                .poll(async () =>
                    (await observed()).some(
                        (event) =>
                            event.type === "annotation-action" &&
                            event.targetId === target!.id &&
                            event.action === "catalog",
                    ),
                )
                .toBe(true);
            const activations = await electron.evaluate(({ BrowserWindow, WebContentsView }) => {
                const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find(
                    (child) => child instanceof WebContentsView,
                );
                return view?.webContents.executeJavaScript("globalThis.recordingActivations || 0");
            });
            expect(activations).toBe(1);
            expect(JSON.stringify(await observed())).not.toContain("private-form-marker");
            await expect(
                page.evaluate((id) => window.veriq.recordingNavigate(id, "https://outside.invalid/"), recording),
            ).rejects.toThrow("RECORDING_TARGET_DENIED");
        } finally {
            await page.evaluate(async (id) => {
                await window.veriq.recordingClose(id);
                Reflect.get(window, "__stopRecordingObservation")?.();
            }, recording);
        }
        await test.step("record inside Desktop, trial frozen rows, and launch the published plan", async () => {
            const recordedCatalog = await publish("ELEMENT_CATALOG", "recorded-catalog", {
                schemaVersion: "1.0",
                elements: [{ key: "apply", locator: { by: "veriqId", value: "apply" } }],
            });
            const dataset = await publish("DATASET", "recorded-data", {
                schemaVersion: "1.0",
                columns: { query: "string" },
                rows: [
                    { key: "first", values: { query: "alpha" } },
                    { key: "second", values: { query: "beta" } },
                ],
            });
            const priorRuns = new Set<string>((await api(base + "/runs")).items.map(({ id }: { id: string }) => id));
            await page.getByRole("button", { name: /浏览器测试设计|Browser test design/ }).click();
            const editor = page.getByTestId("recording-workspace");
            await editor.getByTestId("recording-title").fill("Recorded desktop workflow");
            await editor.getByTestId("recording-environment").selectOption(environment.version.id);
            await editor.getByTestId("recording-role").selectOption("reader");
            await editor.getByTestId("recording-catalog").selectOption(recordedCatalog.version.id);
            await editor.getByTestId("recording-tab-data").click();
            await editor.getByTestId("recording-dataset").selectOption(dataset.version.id);
            for (const key of ["first", "second"]) {
                await editor.getByTestId("recording-data-rows").getByRole("checkbox", { name: key }).check();
            }
            await editor.getByTestId("recording-tab-run").click();
            await editor.getByTestId("recording-runtime").selectOption(device.id);
            await editor.getByTestId("recording-browser-open").click();
            await editor.getByTestId("recording-mode-record").click();
            await editor.getByLabel(/Target path/).fill("/recording");
            await editor.getByRole("button", { name: "前往 / Go", exact: true }).click();
            await expect(editor.getByTestId("recording-current-path")).toHaveText("http://127.0.0.1:18891/recording");
            await electron!.evaluate(({ BrowserWindow, WebContentsView }) => {
                const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find(
                    (child) => child instanceof WebContentsView,
                );
                if (!view) throw new Error("RECORDING_VIEW_MISSING");
                view.webContents.focus();
                for (const type of ["mouseDown", "mouseUp"] as const)
                    view.webContents.sendInputEvent({ type, x: 20, y: 20, button: "left", clickCount: 1 });
            });
            await editor.getByTestId("recording-tab-steps").click();
            await expect(editor.locator("summary").filter({ hasText: /\bclick\b/ })).toHaveCount(1);
            await editor.getByTestId("recording-browser-close").click();
            await editor.getByTestId("recording-tab-run").click();
            await editor.getByTestId("recording-save").click();
            await expect(editor.getByTestId("recording-status")).toContainText("Draft saved");
            await editor.getByTestId("recording-trial").click();
            await expect(editor.getByText("2/2 first-pass cases")).toBeVisible({ timeout: 120000 });
            const trial = (await api(base + "/runs")).items.find(
                ({ id, triggerKind }: { id: string; triggerKind: string }) =>
                    !priorRuns.has(id) && triggerKind === "DEBUG",
            );
            expect(trial).toBeDefined();
            const trialReport = await api(base + "/runs/" + trial.id + "/report");
            expect(
                trialReport.cases.map((item: { provenance: { rowKey: string } }) => item.provenance.rowKey).sort(),
            ).toEqual(["first", "second"]);
            await editor.getByTestId("recording-publish").click();
            await expect(editor.getByTestId("recording-suite-version")).toBeVisible({ timeout: 120000 });
            const suiteLabel = await editor.getByTestId("recording-suite-version").innerText();
            const suiteVersionId = suiteLabel.split(" · ").at(-1);
            await editor.getByTestId("recording-launch").click();
            await expect
                .poll(
                    async () => {
                        const runs = await api(base + "/runs");
                        return runs.items.find(
                            ({ id, triggerKind }: { id: string; triggerKind: string }) =>
                                !priorRuns.has(id) && triggerKind === "HTTP_TRIGGER",
                        )?.outcome;
                    },
                    { timeout: 120000 },
                )
                .toBe("PASSED");
            const plans = await api(base + "/execution-plans");
            expect(plans.items).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        suiteVersionId,
                        environmentVersionId: environment.version.id,
                    }),
                ]),
            );
            await page.getByRole("button", { name: "工作台", exact: true }).click();
        });
        const catalog = await publish("ELEMENT_CATALOG", "desktop-catalog", {
            schemaVersion: "1.0",
            elements: [{ key: "ready", locator: { by: "veriqId", value: "ready" } }],
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
        const run = (await page.evaluate(
            async ({ workspaceId, caseVersionId, environmentVersionId, runtimeId }) =>
                window.veriq.cloud({
                    operation: "createRun",
                    idempotencyKey: crypto.randomUUID(),
                    params: { workspaceId },
                    data: {
                        caseVersionIds: [caseVersionId],
                        environmentVersionId,
                        roleKeys: ["reader"],
                        browsers: ["chromium"],
                        runtimeIds: [runtimeId],
                        executionLocation: "CONNECTED_LOCAL",
                        maxRetries: 0,
                    },
                }),
            {
                workspaceId: workspace.id,
                caseVersionId: testcase.version.id,
                environmentVersionId: environment.version.id,
                runtimeId: device.id,
            },
        )) as { id: string };
        await expect
            .poll(async () => (await api(base + `/runs/${run.id}`)).outcome, {
                timeout: 90000,
                intervals: [500, 1000],
            })
            .toBe("PASSED");
        const report = await api(base + `/runs/${run.id}/report`);
        expect(report.run.source).toBe("CONNECTED_LOCAL");
        expect(report.cases[0].attempts[0].facts.processStopped).toBe(true);
        await writeFile(resolve(evidence, "connected-report-summary.json"), JSON.stringify(report, null, 4) + "\n");
        await page.getByRole("button", { name: "报告与历史", exact: true }).click();
        await page.getByRole("button", { name: run.id, exact: true }).click();
        await expect(page.getByRole("region", { name: "运行报告", exact: true })).toBeVisible();
        await page.screenshot({ path: resolve(evidence, "desktop-connected-executed-1280.png"), fullPage: true });
        workflowFixture = {
            profile,
            fixture,
            workspaceId: workspace.id,
            runtimeId: device.id,
            caseVersionId: testcase.version.id,
            catalogVersionId: catalog.version.id,
            environmentVersionId: environment.version.id,
            runId: run.id,
        };
        await writeFile(
            resolve(evidence, "connected-workflow-fixture.json"),
            JSON.stringify(
                { suiteId: process.env.VERIQ_DESKTOP_SUITE_ID, engineHash: engine.hash, workflow: workflowFixture },
                null,
                4,
            ) + "\n",
        );
        console.log("Production candidate completed actual connected Run and retained its platform report");
    } catch (error) {
        console.error("Connected workflow primary failure:", error);
        throw error;
    } finally {
        await teardownDesktop(electron, profile, agentPid, server);
    }
});

/**
 * 恢复场景只复用真实联网 Run 的平台记录，原生报告、界面故障、退出重开和平台取消均观察实际 Agent 与浏览器生命周期。
 * 同 Attempt 的可见窗口和浏览器沙箱仍是硬门禁，当前能力不足必须留下失败证据，不能改用独立浏览器示例代替。
 */
test("connected reports and runs survive UI recovery and preserve stop evidence", async ({ request }) => {
    test.setTimeout(180000);
    const root = resolve("../..");
    const evidence = resolve(root, process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19");
    const saved = await requireWorkflow();
    const { profile, fixture, workspaceId } = saved;
    const { spawn, execFile } = await import("node:child_process");
    const command = (await import("node:util")).promisify(execFile);
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
    server.stdout.on("data", (data) => void appendFile(resolve(evidence, "resume-server.log"), data));
    server.stderr.on("data", (data) => void appendFile(resolve(evidence, "resume-server.log"), data));
    const env = {
        ...applicationEnvironment,
        VERIQ_DESKTOP_PROFILE: profile,
        VERIQ_DESKTOP_NODE: process.execPath,
        VERIQ_DESKTOP_ENGINE: engine.directory,
        VERIQ_DESKTOP_ENGINE_VERSION: engine.version,
        VERIQ_DESKTOP_BROWSER: resolve(
            root,
            ".superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome" +
                "-headless-shell",
        ),
        ...(process.env.VERIQ_TEST_HEADED_BROWSER
            ? { VERIQ_DESKTOP_HEADED_BROWSER: process.env.VERIQ_TEST_HEADED_BROWSER }
            : {}),
    };
    const launch = () =>
        _electron.launch({
            chromiumSandbox: true,
            executablePath: process.env.VERIQ_TEST_ELECTRON!,
            args: [resolve(".")],
            env,
        });
    let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    let agentPid: number | undefined;
    let headedElectron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    let headedProfile: string | undefined;
    let headedAgentPid: number | undefined;
    const release = () => request.post("http://127.0.0.1:18891/__release");
    const failures: unknown[] = [];
    try {
        await expect
            .poll(async () =>
                request.get("http://127.0.0.1:8888/api/v1/setup").then(
                    (r) => r.status(),
                    () => 0,
                ),
            )
            .toBe(200);
        electron = await launch();
        let page = await electron.firstWindow();
        await page.getByLabel("语言 / Language").selectOption("zh");
        await expect.poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.pid).toBeTruthy();
        agentPid = (await page.evaluate(() => window.veriq.state())).agent!.pid;
        await page.getByLabel("邮箱 / Email").fill("desktop-admin@example.com");
        await page.getByLabel("密码 / Password").fill("Desktop password 123!");
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await selectDesktopWorkspace(page, workspaceId);
        const report = (id: string) =>
            page.evaluate(
                ({ workspaceId, id }) =>
                    window.veriq.cloud({ operation: "getRunReport", params: { workspaceId, runId: id } }),
                { workspaceId, id },
            ) as Promise<any>;
        expect((await report(saved.runId)).run.outcome).toBe("PASSED");
        await page.getByRole("button", { name: "报告与历史", exact: true }).click();
        await page.getByRole("button", { name: saved.runId, exact: true }).click();
        await page.getByRole("button", { name: /1 ·/ }).first().click();
        const nativeId = await electron.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.getNativeWindowHandle().readUInt32LE().toString(),
        );
        const viewerOpened = electron.waitForEvent("window");
        await page.getByRole("button", { name: "打开 Trace", exact: true }).click();
        await expect
            .poll(() =>
                command("python", [resolve(root, "tests/e2e/native_confirm.py"), nativeId]).then(
                    () => true,
                    () => false,
                ),
            )
            .toBe(true);
        const viewer = await viewerOpened;
        await expect(viewer.locator("body")).toContainText("127.0.0.1:18891");
        expect(
            await viewer.evaluate(() => ({
                bridge: typeof Reflect.get(window, "veriq"),
                node: typeof Reflect.get(window, "process"),
                require: typeof Reflect.get(window, "require"),
            })),
        ).toEqual({ bridge: "undefined", node: "undefined", require: "undefined" });
        const viewerOrigin = new URL(viewer.url()).origin;
        await viewer.screenshot({ path: resolve(evidence, "native-connected-trace.png") });
        await viewer.close();
        await expect
            .poll(() =>
                request.get(viewerOrigin).then(
                    () => false,
                    () => true,
                ),
            )
            .toBe(true);
        const exportPath = resolve(profile, "exports");
        const priorExports = (await readdir(exportPath)).sort();
        const imageOpened = electron.waitForEvent("window");
        await page.getByRole("button", { name: "预览截图", exact: true }).click();
        await expect
            .poll(() =>
                command("python", [resolve(root, "tests/e2e/native_confirm.py"), nativeId]).then(
                    () => true,
                    () => false,
                ),
            )
            .toBe(true);
        const image = await imageOpened;
        await expect
            .poll(() => image.locator("img").evaluate((element) => (element as HTMLImageElement).naturalWidth))
            .toBeGreaterThan(0);
        expect(
            await image.evaluate(() => ({
                bridge: typeof Reflect.get(window, "veriq"),
                node: typeof Reflect.get(window, "process"),
            })),
        ).toEqual({ bridge: "undefined", node: "undefined" });
        await image.screenshot({ path: resolve(evidence, "native-connected-image.png") });
        await image.close();
        await expect.poll(async () => (await readdir(exportPath)).sort()).toEqual(priorExports);
        await page.getByRole("button", { name: "预览截图", exact: true }).click();
        await expect
            .poll(() =>
                command("python", [resolve(root, "tests/e2e/native_confirm.py"), nativeId, "cancel"]).then(
                    () => true,
                    () => false,
                ),
            )
            .toBe(true);
        expect(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
        expect((await readdir(exportPath)).sort()).toEqual(priorExports);
        expect((await page.evaluate(() => window.veriq.state())).agent!.pid).toBe(agentPid);
        await page.getByRole("button", { name: "工作台", exact: true }).click();
        await page.getByRole("button", { name: "启动在线领取 / Start online worker", exact: true }).click();
        await expect.poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.online).toBe(true);
        const create = () =>
            page.evaluate(
                ({ workspaceId, caseVersionId, environmentVersionId, runtimeId }) =>
                    window.veriq.cloud({
                        operation: "createRun",
                        idempotencyKey: crypto.randomUUID(),
                        params: { workspaceId },
                        data: {
                            caseVersionIds: [caseVersionId],
                            environmentVersionId,
                            roleKeys: ["reader"],
                            browsers: ["chromium"],
                            runtimeIds: [runtimeId],
                            executionLocation: "CONNECTED_LOCAL",
                            maxRetries: 0,
                        },
                    }),
                saved,
            ) as Promise<{ id: string }>;
        const waitForBusiness = () =>
            expect
                .poll(async () => (await (await request.get("http://127.0.0.1:18891/__state")).json()).waiting)
                .toBe(1);
        const signIn = async () => {
            await page.getByLabel("邮箱 / Email").fill("desktop-admin@example.com");
            await page.getByLabel("密码 / Password").fill("Desktop password 123!");
            await page.getByRole("button", { name: "登录", exact: true }).click();
            await selectDesktopWorkspace(page, workspaceId);
        };
        // 故障恢复、退出、取消和有头取证各用独立 Run，释放业务响应后才做后续登录，避免耗尽同一次导航的十秒预算。
        await request.post("http://127.0.0.1:18891/__hold");
        const crashed = await create();
        await waitForBusiness();
        expect((await report(crashed.id)).run.state).toBe("RUNNING");
        await terminateRenderer(electron, profile, evidence);
        await expect.poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.pid).toBe(agentPid);
        await release();
        await signIn();
        await expect.poll(async () => (await report(crashed.id)).run.outcome, { timeout: 30000 }).toBe("PASSED");
        const crashReport = await report(crashed.id);
        expect(crashReport.cases[0].attempts[0].facts.processStopped).toBe(true);
        await request.post("http://127.0.0.1:18891/__hold");
        const quitting = await create();
        await waitForBusiness();
        expect((await report(quitting.id)).run.state).toBe("RUNNING");
        await closeTestDesktop(electron, "quit");
        electron = undefined;
        await release();
        electron = await launch();
        page = await electron.firstWindow();
        await page.getByLabel("语言 / Language").selectOption("zh");
        await expect.poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.pid).toBe(agentPid);
        await signIn();
        await expect.poll(async () => (await report(quitting.id)).run.outcome, { timeout: 30000 }).toBe("PASSED");
        const completed = await report(quitting.id);
        expect(completed.cases[0].attempts[0].facts.processStopped).toBe(true);
        await request.post("http://127.0.0.1:18891/__hold");
        const cancelled = await create();
        await waitForBusiness();
        await page.evaluate(
            ({ workspaceId, id }) =>
                window.veriq.cloud({
                    operation: "cancelRun",
                    params: { workspaceId, runId: id },
                    data: { reason: "Desktop connected cancellation acceptance" },
                }),
            { workspaceId, id: cancelled.id },
        );
        await expect.poll(async () => (await report(cancelled.id)).run.outcome, { timeout: 30000 }).toBe("CANCELLED");
        const stopped = await report(cancelled.id);
        expect(stopped.cases[0].attempts[0].facts.processStopped).toBe(true);
        await release();
        const policyFailures: unknown[] = [];
        if (!process.env.VERIQ_TEST_HEADED_BROWSER) throw new Error("MATCHED_HEADED_BROWSER_REQUIRED");
        const headedBrowser = process.env.VERIQ_TEST_HEADED_BROWSER;
        headedProfile = await realpath(await mkdtemp("/tmp/veriq-connected-headed-"));
        headedElectron = await _electron.launch({
            chromiumSandbox: true,
            executablePath: process.env.VERIQ_TEST_ELECTRON!,
            args: [resolve(".")],
            env: {
                ...env,
                VERIQ_DESKTOP_PROFILE: headedProfile,
                VERIQ_DESKTOP_BROWSER_MODE: "headed",
                VERIQ_DESKTOP_BROWSER: headedBrowser,
                VERIQ_DESKTOP_HEADED_BROWSER: headedBrowser,
            },
        });
        const headedPage = await headedElectron.firstWindow();
        await headedPage.getByLabel("语言 / Language").selectOption("zh");
        await expect.poll(async () => (await headedPage.evaluate(() => window.veriq.state())).agent?.pid).toBeTruthy();
        headedAgentPid = (await headedPage.evaluate(() => window.veriq.state())).agent!.pid;
        await headedPage.getByLabel("邮箱 / Email").fill("desktop-admin@example.com");
        await headedPage.getByLabel("密码 / Password").fill("Desktop password 123!");
        await headedPage.getByRole("button", { name: "登录", exact: true }).click();
        await selectDesktopWorkspace(headedPage, workspaceId);
        await headedPage.getByLabel("共享给工作区 / Share with workspace").check();
        await headedPage.getByRole("button", { name: "发起绑定 / Enroll", exact: true }).click();
        await expect(headedPage.getByTestId("enrollment-code")).toBeVisible({ timeout: 20000 });
        await headedPage.getByRole("button", { name: "批准并完成绑定 / Approve binding", exact: true }).click();
        await expect
            .poll(async () => (await headedPage.evaluate(() => window.veriq.state())).agent?.device?.workspaceId)
            .toBe(workspaceId);
        const headedRuntimeId = (await headedPage.evaluate(() => window.veriq.state())).agent!.device!.id;
        expect(headedRuntimeId).not.toBe(saved.runtimeId);
        await headedPage.evaluate(
            ({ workspaceId, runtimeId }) =>
                window.veriq.cloud({
                    operation: "updateRuntimeTrust",
                    params: { workspaceId, runtimeId },
                    data: { trustStatus: "MANAGED", allowCredentialDelivery: true },
                }),
            { workspaceId, runtimeId: headedRuntimeId },
        );
        await headedPage.getByRole("button", { name: "启动在线领取 / Start online worker", exact: true }).click();
        await expect.poll(async () => (await headedPage.evaluate(() => window.veriq.state())).agent?.online).toBe(true);
        await request.post("http://127.0.0.1:18891/__hold");
        const policyRun = (await headedPage.evaluate(
            ({ workspaceId, caseVersionId, environmentVersionId, runtimeId }) =>
                window.veriq.cloud({
                    operation: "createRun",
                    idempotencyKey: crypto.randomUUID(),
                    params: { workspaceId },
                    data: {
                        caseVersionIds: [caseVersionId],
                        environmentVersionId,
                        roleKeys: ["reader"],
                        browsers: ["chromium"],
                        runtimeIds: [runtimeId],
                        executionLocation: "CONNECTED_LOCAL",
                        maxRetries: 0,
                    },
                }),
            { ...saved, runtimeId: headedRuntimeId },
        )) as { id: string };
        await waitForBusiness();
        const running = await report(policyRun.id);
        const attemptId = running.cases[0].attempts[0].id;
        expect(running.cases[0].attempts[0].runtimeId).toBe(headedRuntimeId);
        const config = await readFile(resolve(headedProfile, "agent/work", attemptId, "playwright.config.mjs"), "utf8");
        const actual = JSON.parse(config.slice("export default ".length, config.lastIndexOf(";")));
        await writeFile(
            resolve(evidence, "online-process-policy.json"),
            JSON.stringify(
                {
                    runId: policyRun.id,
                    attemptId,
                    runtimeId: headedRuntimeId,
                    agentPid: headedAgentPid,
                    use: actual.use,
                },
                null,
                4,
            ) + "\n",
        );
        try {
            expect(actual.use).toMatchObject({ headless: false, launchOptions: { chromiumSandbox: true } });
            expect(actual.use.launchOptions.args ?? []).not.toContain("--no-sandbox");
        } catch (error) {
            console.error("Connected Attempt sandbox acceptance failed:", error);
            policyFailures.push(error);
        }
        let headed: Awaited<ReturnType<typeof observeHeadedRun>> | undefined;
        try {
            headed = await observeHeadedRun(headedProfile, headedAgentPid!, headedBrowser, evidence, "agent");
            expect(headed.attemptId).toBe(attemptId);
        } catch (error) {
            console.error("Same-Attempt headed acceptance failed:", error);
            policyFailures.push(error);
        } finally {
            await release();
        }
        if (headed) {
            await expect.poll(async () => (await report(policyRun.id)).run.outcome, { timeout: 30000 }).toBe("PASSED");
            const policyReport = await report(policyRun.id);
            expect(policyReport.cases[0].attempts[0].id).toBe(headed.attemptId);
            expect(policyReport.cases[0].attempts[0].runtimeId).toBe(headedRuntimeId);
            await writeFile(
                resolve(evidence, "connected-headed-report.json"),
                JSON.stringify(policyReport, null, 4) + "\n",
            );
            await assertHeadedStopped(
                headedProfile,
                headed,
                policyReport.cases[0].attempts[0].facts.processStopped,
                evidence,
                "agent",
            );
        }
        await writeFile(
            resolve(evidence, "connected-recovery-summary.json"),
            JSON.stringify(
                {
                    original: saved.runId,
                    crashed: crashReport,
                    reopened: completed,
                    cancelled: stopped,
                    policyRunId: policyRun.id,
                },
                null,
                4,
            ) + "\n",
        );
        if (policyFailures.length) throw new AggregateError(policyFailures, "CONNECTED_BROWSER_POLICY_NOT_VERIFIED");
    } catch (error) {
        console.error("Connected recovery primary failure:", error);
        failures.push(error);
    } finally {
        try {
            await release();
        } catch (error) {
            console.error("Connected recovery release failed:", error);
            failures.push(error);
        }
        try {
            if (headedProfile) await teardownDesktop(headedElectron, headedProfile, headedAgentPid);
        } catch (error) {
            failures.push(error);
        }
        try {
            await teardownDesktop(electron, profile, agentPid, server);
        } catch (error) {
            failures.push(error);
        }
    }
    if (failures.length) throw new AggregateError(failures, "CONNECTED_DESKTOP_RECOVERY_FAILED");
});

/**
 * 断网只读取明确标识的历史兼容记录，旧通过结果仍显示阻断门禁；跨空间历史、退役写操作、远程页面和重复后台均继续拒绝。
 * 这里的合成旧格式记录只验证授权读取兼容，实际新 Run 证据来自前例真实联网执行，不将夹具数据当作执行或发布回执。
 */
test("retained historical compatibility reports remain read-only while disconnected", async ({ request }) => {
    const root = resolve("../.."),
        evidence = resolve(root, process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19");
    const { profile, workspaceId } = await requireWorkflow();
    await expect(request.get("http://127.0.0.1:8888/api/v1/setup")).rejects.toThrow();
    const { seedHistoricalReports } = await import("./historical-profile");
    const historical = await seedHistoricalReports(profile, workspaceId);
    const env = {
        ...applicationEnvironment,
        VERIQ_DESKTOP_PROFILE: profile,
        VERIQ_DESKTOP_NODE: process.execPath,
        VERIQ_DESKTOP_ENGINE: engine.directory,
        VERIQ_DESKTOP_ENGINE_VERSION: engine.version,
        VERIQ_DESKTOP_BROWSER: resolve(
            root,
            ".superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome" +
                "-headless-shell",
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
        await page.getByLabel("语言 / Language").selectOption("zh");
        const errors: string[] = [],
            assets: { url: string; status: number }[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
        });
        page.on("response", (response) => assets.push({ url: response.url(), status: response.status() }));
        await page.reload();
        await expect.poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.pid).toBeTruthy();
        const state = await page.evaluate(() => window.veriq.state());
        agentPid = state.agent!.pid;
        expect(state.agent!.history.map((item) => item.id)).toContain(historical.runId);
        expect(state.agent!.history.map((item) => item.id)).not.toContain(historical.foreignRunId);
        const local = (await page.evaluate(
            (id) => window.veriq.local({ operation: "report", runId: id }),
            historical.runId,
        )) as any;
        expect(local.reports[0].run.source).toBe("OFFLINE_IMPORT");
        expect(local.reports[0].gateNow).toEqual({
            passed: false,
            reasons: ["OFFLINE_IMPORT", "REVOCATION_UNKNOWN", "RESULT_AUTHENTICITY_UNVERIFIED"],
        });
        await expect(
            page.evaluate((id) => window.veriq.local({ operation: "report", runId: id }), historical.foreignRunId),
        ).rejects.toThrow("LOCAL_RUN_NOT_FOUND");
        await expect(
            page.evaluate(
                (workspaceId) => window.veriq.local({ operation: "select", workspaceId }),
                historical.foreignWorkspaceId,
            ),
        ).rejects.toThrow("LOCAL_WORKSPACE_UNAVAILABLE");
        for (const operation of ["run", "upload", "download"]) {
            await expect(
                page.evaluate((operation) => Reflect.apply(window.veriq.local, undefined, [{ operation }]), operation),
            ).rejects.toThrow("IPC_OPERATION_DENIED");
        }
        await expect(
            page.evaluate(() => Reflect.apply(window.veriq.cloud, undefined, [{ operation: "createBundle" }])),
        ).rejects.toThrow("IPC_OPERATION_DENIED");
        expect((await page.evaluate(() => window.veriq.state())).agent!.history).toEqual(state.agent!.history);
        await page.getByRole("button", { name: "报告与历史", exact: true }).click();
        await page.getByRole("button", { name: "本机报告 / Local reports", exact: true }).click();
        await page.getByRole("button", { name: historical.runId, exact: true }).first().click();
        const report = page.getByRole("region", { name: "运行报告", exact: true });
        await expect(report).toBeVisible();
        await expect(report).toContainText("OFFLINE_IMPORT, REVOCATION_UNKNOWN, RESULT_AUTHENTICITY_UNVERIFIED");
        expect(
            await page.evaluate(() =>
                fetch("https://example.com/").then(
                    () => false,
                    () => true,
                ),
            ),
        ).toBe(true);
        expect(assets.length).toBeGreaterThan(0);
        expect(assets.every((asset) => asset.url.startsWith("veriq://app/") && asset.status === 200)).toBe(true);
        expect(errors.filter((error) => !error.includes("https://example.com/"))).toEqual([]);
        await page.screenshot({ path: resolve(evidence, "desktop-historical-readonly.png"), fullPage: true });
        await writeFile(
            resolve(evidence, "historical-readonly-observation.json"),
            JSON.stringify(
                {
                    source: "explicit historical compatibility fixture",
                    runId: historical.runId,
                    assets,
                    gate: local.reports[0].gateNow,
                },
                null,
                4,
            ) + "\n",
        );
        const { spawn, execFile } = await import("node:child_process");
        const command = (await import("node:util")).promisify(execFile);
        const secondary = spawn(process.env.VERIQ_TEST_ELECTRON!, [resolve(".")], { env, stdio: "ignore" });
        await expect.poll(() => secondary.exitCode).toBe(0);
        expect((await page.evaluate(() => window.veriq.state())).agent!.pid).toBe(agentPid);
        expect(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
        const nativeId = await electron.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.getNativeWindowHandle().readUInt32LE().toString(),
        );
        await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
        await expect
            .poll(() =>
                command("python", [resolve(root, "tests/e2e/native_confirm.py"), nativeId]).then(
                    () => true,
                    () => false,
                ),
            )
            .toBe(true);
        expect(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
        expect(() => process.kill(agentPid!, 0)).not.toThrow();
    } catch (error) {
        console.error("Historical reader primary failure:", error);
        throw error;
    } finally {
        await teardownDesktop(electron, profile, agentPid);
    }
});

/**
 * 联网共享编辑器的创建、JSON 保存、编译与发布均由实际窗口触发，后台继续消费相同生产候选；AI 页面只读取配置和禁用状态，
 * 不配置模型密钥、不调用外部供应商，也不替换实际校验回执。
 */
test("shared cloud editor publishes through the desktop host transport", async ({ request }) => {
    test.setTimeout(120000);
    const root = resolve("../.."),
        evidence = resolve(root, process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19");
    const { profile, fixture } = await requireWorkflow();
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
    server.stdout.on("data", (data) => void appendFile(resolve(evidence, "cloud-editor-server.log"), data));
    server.stderr.on("data", (data) => void appendFile(resolve(evidence, "cloud-editor-server.log"), data));
    let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined, agentPid: number | undefined;
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
                    ".superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome" +
                        "-headless-shell",
                ),
            },
        });
        const page = await electron.firstWindow();
        await page.getByLabel("语言 / Language").selectOption("zh");
        await expect.poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.pid).toBeTruthy();
        agentPid = (await page.evaluate(() => window.veriq.state())).agent!.pid;
        await page.getByLabel("邮箱 / Email").fill("desktop-admin@example.com");
        await page.getByLabel("密码 / Password").fill("Desktop password 123!");
        await page.getByRole("button", { name: "登录", exact: true }).click();
        const workspaceId = (await page.evaluate(() => window.veriq.state())).agent!.device!.workspaceId;
        await expect(
            page.getByLabel("平台工作区 / Platform workspace").locator(`option[value="${workspaceId}"]`),
        ).toHaveCount(1);
        await selectDesktopWorkspace(page, workspaceId);
        await page.getByRole("button", { name: "启动在线领取 / Start online worker", exact: true }).click();
        await expect.poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.online).toBe(true);
        await page.getByLabel("语言 / Language").selectOption("en");
        await page.getByRole("button", { name: "Cloud resources", exact: true }).click();
        const key = "desktop-ui-" + Date.now();
        const create = page
            .locator("form")
            .filter({ has: page.getByRole("button", { name: "Create resource", exact: true }) });
        await create.getByLabel("Key", { exact: true }).fill(key);
        await create.getByLabel("Name", { exact: true }).fill("Actual desktop UI case");
        await create.getByRole("button", { name: "Create resource", exact: true }).click();
        const acknowledge = async (message: string) => {
            const result = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
            await expect(result).toContainText(message);
            await result.getByRole("button", { name: "OK", exact: true }).click();
            await expect(result).toBeHidden();
        };
        await acknowledge("Resource created");
        const article = page.getByRole("article");
        await article.getByRole("button", { name: "JSON source", exact: true }).click();
        const editor = article
            .locator(".vq-monaco")
            .filter({ has: page.getByRole("textbox", { name: "JSON source", exact: true }) });
        const context = editor.locator(".native-edit-context");
        const contextState = () =>
            context.evaluate((element) => {
                const edit = (
                    element as HTMLElement & {
                        editContext: { text: string; selectionStart: number; selectionEnd: number };
                    }
                ).editContext;
                return {
                    text: edit.text,
                    start: edit.selectionStart,
                    end: edit.selectionEnd,
                    focused: document.activeElement === element,
                    documentFocused: document.hasFocus(),
                };
            });
        const nativeWindow = await electron.browserWindow(page);
        await nativeWindow.evaluate((window) => {
            window.show();
            window.focus();
            window.webContents.focus();
        });
        await editor.locator(".view-lines").click();
        await page.keyboard.press("ControlOrMeta+A");
        await expect
            .poll(async () => {
                const selected = await contextState();
                return (
                    selected.text.length > 0 &&
                    selected.focused &&
                    selected.documentFocused &&
                    selected.start === 0 &&
                    selected.end === selected.text.length
                );
            })
            .toBe(true);
        const initialSelection = await contextState();
        console.log("Native editor initial selection:", JSON.stringify(initialSelection));
        await expect
            .poll(() =>
                nativeWindow.evaluate((window) => ({
                    window: window.isFocused(),
                    contents: window.webContents.isFocused(),
                })),
            )
            .toEqual({ window: true, contents: true });
        const text = JSON.stringify(
            {
                kind: "CASE",
                document: {
                    schemaVersion: "1.0",
                    caseKey: key,
                    title: "Actual desktop UI case",
                    kind: "READ",
                    roleKey: "reader",
                    catalogVersionId: (await requireWorkflow()).catalogVersionId,
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
                },
            },
            null,
            4,
        );
        const priorClipboard = await electron.evaluate(({ clipboard }) => clipboard.readText());
        try {
            await electron.evaluate(({ clipboard }, text) => clipboard.writeText(text), text);
            expect(await electron.evaluate(({ clipboard }) => clipboard.readText())).toBe(text);
            await page.keyboard.press("ControlOrMeta+V");
            console.log("Native editor after paste:", JSON.stringify(await contextState()));
            // EditContext 只保留主选区覆盖的行，粘贴后光标收拢不能证明全文；真实重选全部后再核对完整内容及选区。
            await page.keyboard.press("ControlOrMeta+A");
            await expect.poll(contextState).toEqual({
                text,
                start: 0,
                end: text.length,
                focused: true,
                documentFocused: true,
            });
            console.log("Native editor verified full selection:", JSON.stringify(await contextState()));
        } finally {
            await electron.evaluate(({ clipboard }, text) => clipboard.writeText(text), priorClipboard);
        }
        await article.getByRole("button", { name: "Apply JSON", exact: true }).click();
        await expect(page.getByText("Unapplied JSON changes")).toHaveCount(0);
        await article.getByRole("button", { name: "Visual form", exact: true }).click();
        await article.getByRole("button", { name: "Save draft", exact: true }).click();
        await acknowledge("Saved");
        await article.getByRole("button", { name: "Compile and validate", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Operation succeeded", exact: true })).toContainText(
            "Compilation validated",
            { timeout: 45000 },
        );
        await acknowledge("Compilation validated");
        await article.getByRole("button", { name: "Publish version", exact: true }).click();
        await acknowledge("Version published");
        const publicationReceipt = article.getByText(/^v1 · [0-9a-f-]{36} · [0-9a-f]{64}$/);
        await expect(publicationReceipt).toBeVisible();
        const publication = await publicationReceipt.innerText();
        const assets: string[] = [];
        page.on("response", (response) => assets.push(response.url()));
        await article.getByLabel("Retained file", { exact: true }).click();
        await page
            .getByRole("listbox")
            .getByRole("option", { name: /\.ts · / })
            .first()
            .click();
        const generated = article
            .getByRole("heading", { name: "Actual generated TypeScript (read only)", exact: true })
            .locator("..")
            .locator(".vq-monaco");
        await expect(generated).toBeVisible();
        await expect(generated).toContainText("import");
        await expect(generated.locator(".monaco-editor")).toHaveAttribute("data-mode-id", "typescript");
        await expect.poll(() => assets.some((url) => url.includes("ts.worker"))).toBe(true);
        await page.screenshot({ path: resolve(evidence, "desktop-cloud-published.png"), fullPage: true });
        await appendFile(
            resolve(evidence, "cloud-editor-publications.jsonl"),
            JSON.stringify({ key, publication, workspaceId, assets }) + "\n",
        );
        await page
            .getByRole("dialog")
            .filter({ has: article })
            .getByRole("button", { name: "Close", exact: true })
            .click();
        await page.getByRole("button", { name: "AI assistance", exact: true }).click();
        await expect(
            page.getByText("No providers configured. Add your own provider to generate drafts.", { exact: true }),
        ).toBeVisible();
        await expect(
            page.getByText(
                "Deterministic execution works without a model. " +
                    "Disabling a provider or exhausting its budget never blocks Runs.",
                { exact: true },
            ),
        ).toBeVisible();
        await page.getByLabel("语言 / Language").selectOption("zh");
        await page.getByRole("button", { name: "工作台", exact: true }).click();
        await page.getByRole("button", { name: "停止在线领取 / Stop online worker", exact: true }).click();
        await expect.poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.online).toBe(false);
        const retainedCookies = await electron.evaluate(({ session }) =>
            session.fromPartition("persist:veriq-host").cookies.get({ url: "http://127.0.0.1:8888" }),
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
        await expect.poll(async () => (await page.evaluate(() => window.veriq.state())).user).toBeUndefined();
        expect((await page.evaluate(() => window.veriq.state())).agent!.device!.workspaceId).toBe(workspaceId);
        console.log("Copied ordinary Cookie revoked by server after GUI logout; device binding retained");
    } finally {
        await teardownDesktop(electron, profile, agentPid, server);
    }
});

/**
 * 本例仅验证准备中状态的实际 React 渲染与按钮参数，使用明确的组件级 bridge 替身，不宣称后台启动或业务执行成功；
 * 真实门闩与控制器归属由独立 Agent 测试覆盖，避免为了一个状态重跑完整签发链。
 */
test("component-only startup projection cancels its exact reservation", async () => {
    const assets = resolve("out/renderer");
    const browser = await chromium.launch({
        env: applicationEnvironment,
        chromiumSandbox: true,
        channel: "chromium-headless-shell",
        headless: true,
    });
    try {
        const page = await browser.newPage();
        await page.route("**/*", async (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== "https://desktop-component.invalid") return route.abort();
            const path = resolve(assets, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
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
            localStorage.setItem("veriq.language", "zh");
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
                        operation: "onlineStart",
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
        await expect(page.getByText("准备中 / Preparing", { exact: true })).toBeVisible();
        await page.getByLabel("语言 / Language").selectOption("en");
        await expect(page.getByRole("button", { name: "Cancel startup", exact: true })).toBeEnabled();
        await page.getByLabel("语言 / Language").selectOption("zh");
        await page.getByRole("button", { name: "取消启动", exact: true }).click();
        await expect(page.getByRole("button", { name: "取消启动", exact: true })).toBeDisabled();
        expect(await page.evaluate(() => Reflect.get(window, "componentCalls"))).toEqual([
            { operation: "cancel", startupId: "11111111-1111-4111-8111-111111111111" },
        ]);
    } finally {
        await browser.close();
    }
});

/**
 * 真实 Cookie 验收通过生产 main 的保护门闩建立持久 Session，写入公开合成值后关闭所有自有进程再独立读取 SQLite；
 * 重启同一档案必须恢复同一 Cookie，数据库空明文列和实际提供者密文均需成立，不能以
 * safeStorage 可用替代磁盘证据。
 */
test("production Cookie session persists protected rows and restores after restart", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { stat, writeFile } = await import("node:fs/promises");
    const root = resolve("../..");
    const profile = await realpath(await mkdtemp("/tmp/veriq-cookie-gui-"));
    const value = "VeriQ-public-synthetic-cookie-check-2026";
    let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    let agentPid: number | undefined;
    const launch = async () => {
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
                    ".superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome" +
                        "-headless-shell",
                ),
            },
        });
        const page = await electron.firstWindow({ timeout: 10000 });
        await page.getByLabel("语言 / Language").selectOption("zh");
        await expect.poll(async () => (await page.evaluate(() => window.veriq.state())).agent?.pid).toBeGreaterThan(0);
        agentPid = (await page.evaluate(() => window.veriq.state())).agent?.pid;
        return electron;
    };
    try {
        const first = await launch();
        const observation = await first.evaluate(async ({ session, safeStorage }, synthetic) => {
            const target = session.fromPartition("persist:veriq-host");
            await target.cookies.set({
                url: "https://cookie.veriq.invalid/",
                name: "veriq_cookie_protection_test",
                value: synthetic,
                secure: true,
                httpOnly: true,
                sameSite: "strict",
                expirationDate: Math.floor(Date.now() / 1000) + 3600,
            });
            await target.cookies.flushStore();
            const encrypted = await safeStorage.encryptStringAsync("VeriQ public provider probe");
            const decrypted = await safeStorage.decryptStringAsync(encrypted);
            return {
                path: target.storagePath,
                provider: encrypted.subarray(0, 3).toString("ascii"),
                roundtrip: decrypted.result === "VeriQ public provider probe" && !decrypted.shouldReEncrypt,
                backend: safeStorage.getSelectedStorageBackend(),
            };
        }, value);
        expect(observation.path).toBe(resolve(profile, "electron/Partitions/veriq-host"));
        expect(observation.roundtrip).toBe(true);
        expect(["v11", "v12"]).toContain(observation.provider);
        expect(observation.backend).not.toBe("basic_text");
        await teardownDesktop(electron, profile, agentPid);
        electron = undefined;
        agentPid = undefined;
        const databasePath = resolve(observation.path!, "Cookies");
        expect((await stat(databasePath)).size).toBeLessThan(64 * 1024 * 1024);
        const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 3000 });
        let provider: string;
        try {
            const rows = database
                .prepare("SELECT value, encrypted_value FROM cookies WHERE host_key=? AND name=?")
                .all("cookie.veriq.invalid", "veriq_cookie_protection_test");
            expect(rows).toHaveLength(1);
            expect(rows[0]!.value).toBe("");
            const encrypted = Buffer.from(rows[0]!.encrypted_value as Uint8Array);
            provider = encrypted.subarray(0, 3).toString("ascii");
            expect(provider).toBe(observation.provider);
            expect(encrypted.length).toBeGreaterThan(32);
            expect(encrypted.includes(Buffer.from(value))).toBe(false);
        } finally {
            database.close();
        }
        expect((await readFile(databasePath)).includes(Buffer.from(value))).toBe(false);
        const reopened = await launch();
        const restored = await reopened.evaluate(async ({ session }) =>
            session.fromPartition("persist:veriq-host").cookies.get({
                url: "https://cookie.veriq.invalid/",
                name: "veriq_cookie_protection_test",
            }),
        );
        expect(restored).toHaveLength(1);
        expect(restored[0]!.value).toBe(value);
        await writeFile(
            resolve(process.env.VERIQ_DESKTOP_EVIDENCE!, "cookie-database.json"),
            JSON.stringify(
                {
                    provider,
                    backend: observation.backend,
                    probeRoundtrip: true,
                    cookieRows: 1,
                    plaintextColumnEmpty: true,
                    plaintextAbsentFromDatabase: true,
                    restoredAfterRestart: true,
                    source: "production persist:veriq-host session",
                },
                null,
                4,
            ) + "\n",
        );
    } finally {
        await teardownDesktop(electron, profile, agentPid);
    }
    await rm(profile, { recursive: true, force: true });
});
