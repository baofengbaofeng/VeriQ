/** 帧边界测试使用真实本机传输和测试自有临时端点，Windows 直接运行命名管道而 Linux 运行 Unix 套接字；故障服务只发送无凭证的固定测试字节，验证客户端不能把截断、非法编码或无换行内容当作成功响应。 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expectedPipeResponse } from "./support/pipe-response.ts";

const expected = { ok: true, value: { text: "中文😀" } };
async function withServer(write: (socket: Socket) => void, run: (path: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "veriq-frame-"));
    const path =
        process.platform === "win32"
            ? "\\\\.\\pipe\\veriq-framing-" + randomUUID()
            : join(root, "test.sock");
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => sockets.delete(socket));
        socket.once("data", () => write(socket));
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(path, resolve);
        });
        await run(path);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(root, { recursive: true, force: true });
    }
}

/** 完整正确响应到达时服务端不主动结束连接，客户端必须先完成严格结构断言再自行关闭；此用例使依赖 EOF 的旧实现无法通过，同时保证 Unicode 字节与一次性帧边界都由真实流事件触发。 */
test("pipe client validates its expected frame without waiting for server EOF", async () => {
    const events: string[] = [];
    await withServer(
        (socket) => socket.write(JSON.stringify(expected) + "\n"),
        async (path) => {
            assert.deepEqual(
                await expectedPipeResponse(path, "{}\n", expected, (event) =>
                    events.push(String(event.event)),
                ),
                expected,
            );
        },
    );
    assert(events.includes("frame.validated"));
    assert(events.includes("close"));
});

const rejected: Array<{ name: string; bytes: Buffer; error: RegExp }> = [
    { name: "preframe EOF", bytes: Buffer.alloc(0), error: /TEST_PIPE_INCOMPLETE_RESPONSE/ },
    {
        name: "truncated JSON",
        bytes: Buffer.from('{"ok":true'),
        error: /TEST_PIPE_INCOMPLETE_RESPONSE/,
    },
    {
        name: "missing newline",
        bytes: Buffer.from(JSON.stringify(expected)),
        error: /TEST_PIPE_INCOMPLETE_RESPONSE/,
    },
    {
        name: "malformed UTF8",
        bytes: Buffer.from([0xc3, 0x28, 10]),
        error: /encoded data was not valid/,
    },
    { name: "malformed JSON", bytes: Buffer.from("not-json\n"), error: /Unexpected token/ },
    {
        name: "oversized response",
        bytes: Buffer.alloc(65537, 97),
        error: /TEST_PIPE_RESPONSE_LIMIT/,
    },
    {
        name: "unexpected valid JSON",
        bytes: Buffer.from('{"ok":true,"value":{"text":"wrong"}}\n'),
        error: /Expected values to be strictly deep-equal/,
    },
    {
        name: "extra frame data",
        bytes: Buffer.from(JSON.stringify(expected) + "\n{}\n"),
        error: /TEST_PIPE_EXTRA_FRAME_DATA/,
    },
];
for (const fixture of rejected) {
    test(`pipe client rejects ${fixture.name}`, async () => {
        await withServer(
            (socket) => socket.end(fixture.bytes),
            async (path) => {
                await assert.rejects(expectedPipeResponse(path, "{}\n", expected), fixture.error);
            },
        );
    });
}
