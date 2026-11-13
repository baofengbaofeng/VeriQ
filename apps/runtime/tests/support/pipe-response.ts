/** 原始管道测试客户端按单行 JSON 契约完成请求，严格限制字节数并校验 UTF8 和预期结构后立即关闭自有连接；传输 EOF 或 EPIPE 都不能代替完整响应，诊断只记录事件及字节数量而不输出帧内容。 */
import assert from "node:assert/strict";
import { connect } from "node:net";

/** 测试辅助器发送一帧并返回通过完整预期值断言的响应，五秒套接字空闲时限沿用目标测试原值；所有失败都会销毁该客户端并等待 close，只有已验证的完整帧可以在服务端强制断开之前完成请求。 */
export async function expectedPipeResponse(
    path: string,
    request: string,
    expected: unknown,
    record: (event: Record<string, string | number | boolean>) => void = () => {},
): Promise<unknown> {
    const socket = connect(path);
    let totalBytes = 0,
        complete = false,
        settled = false;
    const chunks: Buffer[] = [];
    const closed = new Promise<void>((resolve) =>
        socket.once("close", (hadError) => {
            record({ event: "close", hadError });
            resolve();
        }),
    );
    try {
        return await new Promise<unknown>((resolve, reject) => {
            const fail = (error: unknown) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                reject(error);
            };
            socket.on("connect", () => {
                record({ event: "connect" });
                record({ event: "write.submitted", bytes: Buffer.byteLength(request) });
                socket.end(request, () => record({ event: "write.completed" }));
            });
            socket.on("data", (chunk: Buffer) => {
                if (settled) return;
                totalBytes += chunk.length;
                if (totalBytes > 65536) {
                    record({ event: "limit", totalBytes });
                    fail(new Error("TEST_PIPE_RESPONSE_LIMIT"));
                    return;
                }
                chunks.push(chunk);
                const frame = Buffer.concat(chunks, totalBytes);
                complete = frame.includes(10);
                record({
                    event: "data",
                    bytes: chunk.length,
                    totalBytes,
                    newlineComplete: complete,
                });
                if (!complete) return;
                try {
                    if (frame.indexOf(10) !== frame.length - 1)
                        throw new Error("TEST_PIPE_EXTRA_FRAME_DATA");
                    const text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
                    const value: unknown = JSON.parse(text);
                    assert.deepEqual(value, expected);
                    settled = true;
                    record({ event: "frame.validated", totalBytes });
                    socket.destroy();
                    resolve(value);
                } catch (error) {
                    fail(error);
                }
            });
            socket.on("end", () => {
                record({ event: "end", totalBytes, newlineComplete: complete });
                fail(new Error("TEST_PIPE_INCOMPLETE_RESPONSE"));
            });
            socket.on("error", (error: NodeJS.ErrnoException) => {
                record({
                    event: "error",
                    code: /^[A-Z0-9_]+$/.test(error.code ?? "") ? error.code! : "UNKNOWN_ERROR",
                    totalBytes,
                    newlineComplete: complete,
                });
                fail(error);
            });
            socket.on("close", () => fail(new Error("TEST_PIPE_INCOMPLETE_RESPONSE")));
            socket.setTimeout(5000, () => fail(new Error("TEST_PIPE_TIMEOUT")));
        });
    } finally {
        socket.destroy();
        await closed;
    }
}
