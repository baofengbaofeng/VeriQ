import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, realpath, symlink } from "node:fs/promises";
import { DesktopAgent } from "../src/agent/service.ts";

/**
 * 后台测试在真实私有临时目录创建持久状态，状态接口必须反映独立 Node 版本与空历史；未知命令及任意文件路径在触及执行引擎
 * 之前被拒绝，不依赖模拟浏览器结果。
 */
test("independent Node24 agent reports an idle durable profile", async () => {
    const root = await realpath(await mkdtemp("/tmp/veriq-t19-agent-"));
    try {
        const agent = new DesktopAgent(root, {
            origin: "http://127.0.0.1:8888",
            engineDirectory: "/trusted/engine",
            browserExecutable: "/trusted/browser",
        });
        const status = await agent.dispatch({ operation: "status" });
        assert.equal(typeof status, "object");
        assert.equal((status as { node: string }).node, process.versions.node);
        assert.equal((status as { active: unknown }).active, null);
        assert.deepEqual((status as { bundles: unknown[] }).bundles, []);
        assert(!JSON.stringify(status).includes("deviceToken"));
        for (const operation of ["run", "upload", "download"])
            await assert.rejects(agent.dispatch({ operation }), /AGENT_OPERATION_DENIED/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("agent refuses arbitrary path and process operations", async () => {
    const root = await realpath(await mkdtemp("/tmp/veriq-t19-agent-"));
    try {
        const agent = new DesktopAgent(root, {
            origin: "http://127.0.0.1:8888",
            engineDirectory: "/trusted/engine",
            browserExecutable: "/trusted/browser",
        });
        for (const value of [
            { operation: "spawn", command: "sh" },
            { operation: "status", path: "/etc/passwd" },
        ])
            await assert.rejects(agent.dispatch(value), /AGENT_OPERATION_DENIED|IPC_PAYLOAD_INVALID/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/**
 * 可见模式不能仅凭配置里存在一个路径就启用，真实已安装 headless shell 通过版本探测后仍只能用于无头运行；缺失文件必须返
 * 回不可用而不能把宿主路径或异常细节透传到 renderer。
 */
test("browser capability distinguishes the installed headless shell from headed distribution", async () => {
    const { probeBrowser } = await import("../src/agent/browser-capability.ts");
    const { registry } = await import("playwright-core/lib/coreBundle");
    const binary = registry.registry.findExecutable("chromium-headless-shell").executablePath();
    assert.equal((await probeBrowser(binary, false)).available, true);
    assert.equal((await probeBrowser(binary, true)).available, false);
    const { chromium } = await import("@playwright/test");
    assert.equal((await probeBrowser(chromium.executablePath(), true)).available, true);
    assert.equal((await probeBrowser(undefined, true)).available, false);
    const aliases = await realpath(await mkdtemp("/tmp/veriq-browser-alias-"));
    try {
        await symlink(binary, aliases + "/chrome");
        assert.equal((await probeBrowser(aliases + "/chrome", true)).available, false);
        await symlink(chromium.executablePath(), aliases + "/chromium");
        assert.equal((await probeBrowser(aliases + "/chromium", true)).available, true);
    } finally {
        await rm(aliases, { recursive: true, force: true });
    }
});

/**
 * 自检版本上下文只能来自实际库存核验，缺失发行目录时后台必须拒绝诊断而不能用配置中的版本字符串制造能力；这个失败发生在
 * 任何设备注册之前，状态中仍没有设备授权。
 */
test("missing production release cannot produce advertised capabilities", async () => {
    const root = await realpath(await mkdtemp("/tmp/veriq-release-missing-"));
    try {
        const agent = new DesktopAgent(root, {
            origin: "http://127.0.0.1:8888",
            engineDirectory: root + "/missing",
            browserExecutable: "/missing/browser",
        });
        await assert.rejects(
            agent.dispatch({ operation: "doctor" }),
            process.platform === "darwin" ? { message: "DARWIN_NATIVE_DISTRIBUTION_REQUIRED" } : { code: "ENOENT" },
        );
        const status = (await agent.dispatch({ operation: "status" })) as { device?: unknown };
        assert.equal(status.device, undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/**
 * 后台投影测试保留真实领取循环、恢复日志、磁盘探测入口和状态请求，只替代浏览器自检、设备会话及操作系统空闲块结果。
 */
test("online disk pause preserves another error and keeps retained scratch visible after stop", async (t) => {
    const { default: fs, mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { DeviceSession } = await import("../../runtime/src/agent/credentials.ts");
    const { AgentClient } = await import("../../runtime/src/agent/transport.ts");
    const root = await realpath(await mkdtemp("/tmp/vq-desktop-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const origin = "http://127.0.0.1:8888";
    const id = "11111111-1111-4111-8111-111111111111";
    const agent = new DesktopAgent(root, { origin, engineDirectory: "/missing/engine", browserExecutable: "/missing" });
    Reflect.set(agent, "lastError", "AGENT_REQUEST_TIMEOUT");
    Reflect.set(agent, "deviceConfig", async () => ({ server: origin, runnerId: id }));
    const capabilities = { engineVersion: "0.1.0", os: "linux", arch: "x64", browsers: ["chromium"] };
    Reflect.set(agent, "diagnose", async () => ({ ok: true, capabilities }));
    const temporary = process.platform === "darwin" ? join(root, "control") : tmpdir();
    if (process.platform === "darwin") {
        const { createDarwinSource } = await import("../../runtime/src/execution/darwin-source.ts");
        await mkdir(temporary, { mode: 0o700 });
        const source = await createDarwinSource({ temporaryDirectory: temporary });
        // 本用例隔离外部安装身份，实际私有日志和观察器仍消费真实源码探针签发的品牌能力，不能用空对象冒充。
        Reflect.set(agent, "darwinExecution", async () => source);
    }
    t.mock.method(DeviceSession.prototype, "open", async () => {});
    t.mock.method(DeviceSession.prototype, "close", async () => {});
    let sampled!: () => void;
    let claimed!: () => void;
    const firstSample = new Promise<void>((resolve) => {
        sampled = resolve;
    });
    const firstClaim = new Promise<void>((resolve) => {
        claimed = resolve;
    });
    let capacity = 0n;
    let claimCount = 0;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(fs, "statfs", async (path: string) => {
        if (path === temporary) sampled();
        return { type: 0n, bsize: 4096n, blocks: 400000n, bfree: capacity, bavail: capacity, files: 1n, ffree: 1n };
    });
    t.mock.method(AgentClient.prototype, "request", async (path: string) => {
        if (path === "/internal/v1/runtime") return { capabilities };
        if (path.endsWith("/reconcile")) return {};
        assert.equal(path, "/internal/v1/jobs/claim");
        claimCount++;
        claimed();
    });
    const attempts = join(root, "agent", "attempts");
    await mkdir(attempts, { recursive: true, mode: 0o700 });
    await writeFile(
        join(attempts, `${id}.json`),
        JSON.stringify({ state: "ALLOCATED", claim: { attemptId: id, fencingToken: 1 }, work: join(root, "work") }),
        { mode: 0o600 },
    );
    const status = () =>
        agent.dispatch({ operation: "status" }) as Promise<{
            online: boolean;
            error?: string;
            pausedReason?: string;
            scratchCleanupPending?: boolean;
        }>;
    try {
        await agent.dispatch({ operation: "onlineStart" });
        await Promise.race([firstSample, firstClaim]);
        const paused = await status();
        assert.equal(paused.online, true);
        assert.equal(paused.pausedReason, "RUNTIME_STORAGE_LOW");
        assert.equal(paused.scratchCleanupPending, true);
        assert.equal(paused.error, "AGENT_REQUEST_TIMEOUT");
        assert.equal(claimCount, 0);
        capacity = 131072n;
        t.mock.timers.tick(10000);
        await firstClaim;
        const resumed = await status();
        assert.equal(resumed.pausedReason, undefined);
        assert.equal(resumed.error, "AGENT_REQUEST_TIMEOUT");
        assert.equal(resumed.scratchCleanupPending, true);
        await agent.dispatch({ operation: "onlineStop" });
        const stopped = await status();
        assert.equal(stopped.online, false);
        assert.equal(stopped.scratchCleanupPending, true);
    } finally {
        await agent.dispatch({ operation: "onlineStop" });
    }
});
