import assert from "node:assert/strict";
import test from "node:test";
import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DesktopAgentClient } from "../src/agent/client.ts";
import { AttemptBroker } from "../../runtime/src/execution/broker.ts";
import { updatePrivate } from "../../runtime/src/offline/config.ts";

/** 响应经真实私有 socket 发送，刻意在中文与非 BMP 字符的每个字节后让出 I/O 轮次，接收方必须还原原文；这个边界不允许通过替换原始业务字符串或放宽源码哈希来掩盖传输损坏。 */
test("client preserves fragmented Chinese and non-BMP response bytes", async () => {
    const root = await mkdtemp("/tmp/veriq-unicode-client-");
    const path = join(root, "desktop-agent.sock");
    const sockets = new Set<Socket>();
    const value = "资源中文𠮷🙂\nsource";
    const response = Buffer.from(JSON.stringify({ ok: true, value: { ok: true, value } }) + "\n");
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("data", () => {
            void (async () => {
                for (const byte of response) {
                    socket.write(Buffer.from([byte]));
                    await setImmediate();
                    await setImmediate();
                }
                socket.end();
            })();
        });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
        await updatePrivate(root, "desktop-agent.json", () => ({
            socket: path,
            nonce: "1".repeat(64),
        }));
        assert.equal(await new DesktopAgentClient(root).call({ operation: "status" }), value);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    }
});

/** 请求经实际 AttemptBroker 的认证与帧边界解析，逐字节片段包括四字节 Unicode 和跨行 JSON 转义；超过六十四 KiB 的原始字节必须在业务回调前拒绝，不能改用 JavaScript 字符长度计费。 */
test("broker preserves fragmented input and enforces its raw byte cap", async () => {
    const root = await mkdtemp("/tmp/veriq-unicode-broker-");
    let received: unknown;
    let calls = 0;
    const broker = new AttemptBroker(join(root, "broker.sock"), async (message) => {
        calls++;
        received = message.value;
        return "received";
    });
    await broker.open();
    try {
        const value = "凭证𠮷🙂\n资源";
        const socket = connect(broker.path);
        socket.resume();
        const ended = once(socket, "close");
        await once(socket, "connect");
        const frame = Buffer.from(JSON.stringify({ nonce: broker.nonce, value }) + "\n");
        for (const byte of frame) {
            socket.write(Buffer.from([byte]));
            await setImmediate();
            await setImmediate();
        }
        await ended;
        assert.equal(received, value);
        assert.equal(calls, 1);
        const oversized = connect(broker.path);
        oversized.on("error", () => {});
        oversized.resume();
        const closed = new Promise<void>((resolve) => oversized.once("close", () => resolve()));
        await once(oversized, "connect");
        oversized.end(JSON.stringify({ nonce: broker.nonce, value: "汉".repeat(22000) }) + "\n");
        await closed;
        assert.equal(calls, 1);
    } finally {
        await broker.close();
        await rm(root, { recursive: true, force: true });
    }
});

/** 恶意后台响应即使尚未形成完整 JSON 也受三十二 MiB 原始字节上限约束，达到超限后客户端必须主动断连并返回稳定错误；测试不等待协议超时，也不让本机字符串解码后的长度改变预算。 */
test("client caps raw response bytes before a complete frame", async () => {
    const root = await mkdtemp("/tmp/veriq-unicode-limit-");
    const path = join(root, "desktop-agent.sock");
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("data", () => socket.end(Buffer.alloc(32 * 1024 * 1024 + 1, 0x61)));
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
        await updatePrivate(root, "desktop-agent.json", () => ({
            socket: path,
            nonce: "1".repeat(64),
        }));
        await assert.rejects(
            new DesktopAgentClient(root).call({ operation: "status" }),
            /AGENT_RESPONSE_LIMIT/,
        );
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    }
});
