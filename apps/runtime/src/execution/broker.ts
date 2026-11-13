/**
 * 本文件实现 Attempt 私有 Unix 套接字代理：仅校验一次性 nonce 授权控制消息：绝不向工作进程转发任何设备凭证。
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { resolve } from "node:path";
import { windowsNative } from "../native/windows.ts";
/**
 * 公开类 AttemptBroker 监听 Attempt 私有 Unix 套接字：用一次性 nonce 授权单行 JSON 控制消息。
 * 超限或失配时销毁连接且不转发设备凭证。
 */
export class AttemptBroker {
    readonly nonce = randomBytes(32).toString("hex");
    private server: Server | undefined;
    private sockets = new Set<Socket>();
    private nativeServer: { close(): void } | undefined;
    readonly path: string;
    constructor(
        path: string,
        private receive: (message: Record<string, unknown>) => Promise<unknown>,
        private readonly socketTimeoutMs = 15000,
    ) {
        this.path =
            process.platform === "win32"
                ? "\\\\.\\pipe\\veriq-" +
                  createHash("sha256")
                      .update(windowsNative().sid + "\0" + resolve(path).toLowerCase())
                      .digest("hex")
                : path;
        if (
            !Number.isSafeInteger(socketTimeoutMs) ||
            socketTimeoutMs < 1 ||
            socketTimeoutMs > 60000
        )
            throw new Error("IPC_TIMEOUT_INVALID");
    }
    /**
     * 公开方法 open 创建 Attempt 私有套接字并开始监听：将文件权限收紧为 0600：只接受以换行结束的单行控制消息。
     */
    async open() {
        /** Windows 服务端由原生适配器创建受保护且禁止远程连接的首实例管道，TypeScript 仍负责一次性 nonce 和有限业务分派；原生传输失败不会回退 TCP 或公共默认 ACL，也不会改写 Linux 的套接字路径。 */
        if (process.platform === "win32") {
            this.nativeServer = new (windowsNative().PrivatePipeServer)(
                this.path,
                (frame, reply) => {
                    void (async () => {
                        let response: string;
                        try {
                            const message = JSON.parse(frame) as Record<string, unknown>;
                            if (message.nonce !== this.nonce) throw new Error("IPC_UNAUTHORIZED");
                            response =
                                JSON.stringify({ ok: true, value: await this.receive(message) }) +
                                "\n";
                        } catch {
                            response =
                                JSON.stringify({ ok: false, error: "ATTEMPT_IPC_FAILED" }) + "\n";
                        }
                        try {
                            reply(response);
                        } catch {
                            /* 原生端已经关闭或响应超过固定字节预算时必须结束当前请求，不能在异步回调外抛出未处理异常，也不能重新连接后把同一业务命令重复发送给不同的监听实例。 */
                        }
                    })();
                },
            );
            return;
        }
        this.server = createServer((socket) => {
            this.sockets.add(socket);
            socket.on("close", () => this.sockets.delete(socket));
            socket.on("error", () => {});
            let bytes = 0;
            const chunks: Buffer[] = [];
            let handled = false;
            /** 单行请求的完整字节帧才是 UTF-8 解码边界，任意 socket 分块可能切开中文或四字节字符；保留既有六十四 KiB 原始上限，并在认证和业务回调之前拒绝非法编码或不完整 JSON。 */
            socket.on("data", (chunk: Buffer) => {
                if (handled) return;
                bytes += chunk.length;
                if (bytes > 65536) {
                    socket.destroy();
                    return;
                }
                chunks.push(chunk);
                if (!chunk.includes(10)) return;
                handled = true;
                void (async () => {
                    try {
                        const frame = Buffer.concat(chunks, bytes);
                        const text = new TextDecoder("utf-8", { fatal: true }).decode(
                            frame.subarray(0, frame.indexOf(10)),
                        );
                        const message = JSON.parse(text) as Record<string, unknown>;
                        if (message.nonce !== this.nonce) throw new Error("IPC_UNAUTHORIZED");
                        const value = await this.receive(message);
                        socket.end(JSON.stringify({ ok: true, value }) + "\n");
                    } catch {
                        socket.end(
                            JSON.stringify({ ok: false, error: "ATTEMPT_IPC_FAILED" }) + "\n",
                        );
                    }
                })();
            });
            socket.setTimeout(this.socketTimeoutMs, () => socket.destroy());
        });
        await new Promise<void>((resolve, reject) => {
            this.server!.once("error", reject);
            this.server!.listen(this.path, resolve);
        });
        await chmod(this.path, 0o600);
    }
    /**
     * 公开方法 close 销毁 AttemptBroker 上的活跃连接：关闭监听端点并删除套接字文件：对本不存在的路径错误保持静默。
     */
    async close() {
        if (process.platform === "win32") {
            this.nativeServer?.close();
            this.nativeServer = undefined;
            return;
        }
        for (const socket of this.sockets) socket.destroy();
        if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        await unlink(this.path).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== "ENOENT") throw e;
        });
    }
}
