/**
 * 本文件实现 Attempt 私有 Unix 套接字代理：仅校验一次性 nonce 授权控制消息：绝不向工作进程转发任何设备凭证。
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmod, unlink, mkdtemp, lstat, rmdir } from "node:fs/promises";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { darwinNative, type DarwinPrivateDirectory } from "../native/darwin.ts";
import { windowsNative } from "../native/windows.ts";
/** Mac 业务调用显式申请系统固定短临时根下的独占目录，B 锚点与随机 owner 标记共同约束关闭清理；只删除同一 inode 的自有标记和空目录，陌生成员、路径替换或未关闭 socket 都保留原现场，不静默规范化任何用户配
 * 置路径。 */
export async function createDarwinBrokerDirectory(): Promise<{
    path: string;
    close(): Promise<void>;
}> {
    if (process.platform !== "darwin") throw new Error("DARWIN_NATIVE_PLATFORM_REQUIRED");
    const path = await mkdtemp("/private/tmp/veriq-broker-");
    const directory = darwinNative().openPrivateDirectory(path, false);
    let identity: Awaited<ReturnType<typeof lstat>>;
    const marker = randomBytes(32);
    try {
        identity = await lstat(path);
        directory.replace(".owner", `.${randomUUID()}.tmp`, marker, 64);
    } catch (error) {
        directory.close();
        throw error;
    }
    let closed = false;
    return {
        path,
        async close() {
            if (closed) return;
            closed = true;
            try {
                const current = await lstat(path);
                if (
                    current.dev !== identity.dev ||
                    current.ino !== identity.ino ||
                    !current.isDirectory() ||
                    current.isSymbolicLink()
                )
                    throw new Error("IPC_DIRECTORY_CHANGED");
                const entries = directory.entries(2);
                if (
                    entries.overflow ||
                    entries.names.length !== 1 ||
                    entries.names[0] !== ".owner" ||
                    !directory.read(".owner", 64).equals(marker)
                )
                    throw new Error("IPC_DIRECTORY_CHANGED");
                directory.remove(".owner", 64);
                await rmdir(path);
            } finally {
                directory.close();
            }
        },
    };
}
/**
 * 公开类 AttemptBroker 监听 Attempt 私有 Unix 套接字：用一次性 nonce 授权单行 JSON 控制消息。
 * 超限或失配时销毁连接且不转发设备凭证。
 */
export class AttemptBroker {
    readonly nonce = randomBytes(32).toString("hex");
    private server: Server | undefined;
    private closed = false;
    private sockets = new Set<Socket>();
    private nativeServer: { close(): void } | undefined;
    readonly path: string;
    private parent: DarwinPrivateDirectory | undefined;
    private socketIdentity: { dev: number; ino: number } | undefined;
    constructor(
        path: string,
        private receive: (message: Record<string, unknown>) => Promise<unknown>,
        private readonly socketTimeoutMs = 15000,
    ) {
        if (
            process.platform === "darwin" &&
            (path.includes("\0") || Buffer.byteLength(path, "utf8") >= 104)
        )
            throw new Error("IPC_PATH_INVALID");
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
        if (this.closed) throw new Error("IPC_BROKER_CLOSED");
        /** Windows 服务端由原生适配器创建受保护且禁止远程连接的首实例管道，TypeScript 仍负责一次性 nonce 和有限业务分派；原生传输失败不会回退 TCP 或公共默认 ACL，也不会改写 Linux
         * 的套接字路径。 */
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
        if (process.platform === "darwin")
            this.parent = darwinNative().openPrivateDirectory(dirname(this.path), false);
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
        if (this.parent) {
            const socket = await lstat(this.path);
            if (
                !socket.isSocket() ||
                (socket.mode & 0o777) !== 0o600 ||
                socket.uid !== process.getuid!()
            )
                throw new Error("IPC_SOCKET_UNSAFE");
            this.socketIdentity = { dev: socket.dev, ino: socket.ino };
        }
    }
    /**
     * 公开方法 close 销毁 AttemptBroker 上的活跃连接：关闭监听端点并删除套接字文件：对本不存在的路径错误保持静默。
     */
    async close() {
        if (this.closed) return;
        this.closed = true;
        if (process.platform === "win32") {
            this.nativeServer?.close();
            this.nativeServer = undefined;
            return;
        }
        for (const socket of this.sockets) socket.destroy();
        if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        if (this.parent) {
            try {
                const current = await lstat(this.path).catch((error: NodeJS.ErrnoException) => {
                    if (error.code !== "ENOENT") throw error;
                });
                if (current) {
                    if (
                        !this.socketIdentity ||
                        !current.isSocket() ||
                        current.dev !== this.socketIdentity.dev ||
                        current.ino !== this.socketIdentity.ino
                    )
                        throw new Error("IPC_SOCKET_CHANGED");
                    await unlink(this.path);
                }
            } finally {
                this.parent.close();
                this.parent = undefined;
            }
            return;
        }
        await unlink(this.path).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== "ENOENT") throw e;
        });
    }
}
