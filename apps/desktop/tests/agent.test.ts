import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { DesktopAgent } from "../src/agent/service.ts";

/** 后台测试在真实私有临时目录创建持久状态，状态接口必须反映独立 Node 版本与空历史；未知命令及任意文件路径在触及执行引擎之前被拒绝，不依赖模拟浏览器结果。 */
test("independent Node24 agent reports an idle durable profile", async () => {
    const root = await mkdtemp("/tmp/veriq-t19-agent-");
    try {
        const agent = new DesktopAgent(root, {
            origin: "http://127.0.0.1:8888",
            engineDirectory: "/trusted/engine",
            browserExecutable: "/trusted/browser",
        });
        const status = await agent.dispatch({ operation: "status" });
        assert.equal(typeof status, "object");
        assert.equal((status as { node: string }).node, "24.22.1");
        assert.equal((status as { active: unknown }).active, null);
        assert.deepEqual((status as { bundles: unknown[] }).bundles, []);
        assert(!JSON.stringify(status).includes("deviceToken"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("agent refuses arbitrary path and process operations", async () => {
    const root = await mkdtemp("/tmp/veriq-t19-agent-");
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
            await assert.rejects(
                agent.dispatch(value),
                /AGENT_OPERATION_DENIED|IPC_PAYLOAD_INVALID/,
            );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/** 可见模式不能仅凭配置里存在一个路径就启用，真实已安装 headless shell 通过版本探测后仍只能用于无头运行；缺失文件必须返回不可用而不能把宿主路径或异常细节透传到 renderer。 */
test("browser capability distinguishes the installed headless shell from headed distribution", async () => {
    const { probeBrowser } = await import("../src/agent/browser-capability.ts");
    const { resolve } = await import("node:path");
    const binary = resolve(
        "../../.superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell",
    );
    assert.equal((await probeBrowser(binary, false)).available, true);
    assert.equal((await probeBrowser(binary, true)).available, false);
    assert.equal((await probeBrowser(undefined, true)).available, false);
});

/** 自检版本上下文只能来自实际库存核验，缺失发行目录时后台必须拒绝诊断而不能用配置中的版本字符串制造能力；这个失败发生在任何设备注册之前，状态中仍没有设备授权。 */
test("missing production release cannot produce advertised capabilities", async () => {
    const root = await mkdtemp("/tmp/veriq-release-missing-");
    try {
        const agent = new DesktopAgent(root, {
            origin: "http://127.0.0.1:8888",
            engineDirectory: root + "/missing",
            browserExecutable: "/missing/browser",
        });
        await assert.rejects(agent.dispatch({ operation: "doctor" }), { code: "ENOENT" });
        const status = (await agent.dispatch({ operation: "status" })) as { device?: unknown };
        assert.equal(status.device, undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
