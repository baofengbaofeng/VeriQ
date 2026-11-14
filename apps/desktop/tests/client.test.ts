import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DesktopAgentClient } from "../src/agent/client.ts";
import { updatePrivate } from "../../runtime/src/offline/config.ts";

/** Agent 可能在命令完成之前退出或主动拒绝连接，宿主必须把真实 socket 关闭转为明确失败；这个测试用本机端点结束无响应连接，避免页面状态调用永久挂起且不以长超时掩盖断连。 */
test("agent client rejects a connection closed without response", { timeout: 1500 }, async () => {
    const root = await mkdtemp("/tmp/veriq-t19-client-");
    const path = join(root, "desktop-agent.sock");
    const server = createServer((socket) => socket.once("data", () => socket.destroy()));
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
        await updatePrivate(root, "desktop-agent.json", () => ({
            socket: path,
            nonce: "1".repeat(64),
        }));
        await assert.rejects(
            new DesktopAgentClient(root).call({ operation: "status" }),
            /AGENT_CONNECTION_CLOSED/,
        );
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    }
});
