/**
 * 本文件实现 Attempt 私有 Unix 套接字代理：仅校验一次性 nonce 授权控制消息：绝不向工作进程转发任何设备凭证。
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
/**
 * 公开类 AttemptBroker 监听 Attempt 私有 Unix 套接字：用一次性 nonce 授权单行 JSON 控制消息。
 * 超限或失配时销毁连接且不转发设备凭证。
 */
export class AttemptBroker {
    readonly nonce = randomBytes(32).toString("hex");
    private server: Server | undefined;
    private sockets = new Set<Socket>();
    constructor(
        readonly path: string,
        private receive: (message: Record<string, unknown>) => Promise<unknown>,
        private readonly socketTimeoutMs = 15000,
    ) {
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
        this.server = createServer((socket) => {
            this.sockets.add(socket);
            socket.on("close", () => this.sockets.delete(socket));
            socket.on("error", () => {});
            let bytes = 0,
                buffer = "";
            let handled = false;
            socket.on("data", (chunk: Buffer) => {
                if (handled) return;
                bytes += chunk.length;
                if (bytes > 65536) {
                    socket.destroy();
                    return;
                }
                buffer += chunk.toString();
                if (!buffer.includes("\n")) return;
                handled = true;
                void (async () => {
                    try {
                        const message = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Record<
                            string,
                            unknown
                        >;
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
        for (const socket of this.sockets) socket.destroy();
        if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        await unlink(this.path).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== "ENOENT") throw e;
        });
    }
}
