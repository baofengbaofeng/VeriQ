import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { DesktopAgentClient } from "../src/agent/client.ts";
import { updatePrivate } from "../../runtime/src/offline/config.ts";

/**
 * Agent 可能在命令完成之前退出或主动拒绝连接，宿主必须把真实 socket 关闭转为明确失败；这个测试用本机端点结束无响应连接
 * ，避免页面状态调用永久挂起且不以长超时掩盖断连。
 */
test("agent client rejects a connection closed without response", async (t) => {
    const root = await realpath(await mkdtemp("/tmp/veriq-t19-client-"));
    const path = join(root, "desktop-agent.sock");
    const server = createServer((socket) => socket.once("data", () => socket.destroy()));
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
        await updatePrivate(root, "desktop-agent.json", () => ({
            socket: path,
            nonce: "1".repeat(64),
        }));
        // 首次原生模块装载和配置写入属于夹具准备，保持断连请求自身的一千五百毫秒预算，避免并发编译耗时占用它。
        await t.test("closed socket rejects within the request budget", { timeout: 1500 }, async () => {
            await assert.rejects(new DesktopAgentClient(root).call({ operation: "status" }), /AGENT_CONNECTION_CLOSED/);
        });
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    }
});

test("the source workbench reports installed-only operations before reading a runtime profile", async () => {
    const client = new DesktopAgentClient("/unused-source-workbench-profile", false);
    await assert.rejects(client.call({ operation: "status" }), /INSTALLED_RUNTIME_REQUIRED/);
});
