import { connect } from "node:net";
import { join } from "node:path";
import { readPrivate } from "../../../runtime/src/offline/config.ts";

/** 桌面与后台之间每次请求使用独立短连接，连接建立、认证信封、响应上限与断连失败必须在同一个 Promise 中收敛，否则主窗口可能永久等待已退出进程而无法显示真实状态。
 * root 是主进程选定的私有档案目录，并不是 renderer 参数。
 * desktop-agent.json 由持锁后台写入，包含本次后台实例的随机 nonce。
 * 描述文件中的 socket 仍须匹配该档案的固定文件名，不能借配置选择任意端点。
 * nonce 检查只接受六十四位十六进制串，错误描述文件不触发自动进程重启。
 * 每次 call 都重新读取描述文件，因此后台重启后的新 nonce 不会被旧连接缓存覆盖。
 * 客户端不共享 socket，可避免一次长下载阻塞独立的状态查询。
 * 请求按 UTF-8 字节计数，中文正文不能用 JavaScript 字符长度绕过传输上限。
 * 请求正文不得超过 broker 的六十四 KiB 单行边界。
 * 返回最多三十二 MiB，覆盖有界报告与签名资源描述而不成为无界文件通道。
 * 服务端空关闭不是成功响应，必须转成明确的 AGENT_CONNECTION_CLOSED。
 * completed 同时防止 end 和 close 两个事件重复决定请求结果。
 * 接收完整换行帧后立即销毁本次连接，不保留可被后续数据污染的状态。
 * 外层 ok 属于 nonce broker，内层 ok 属于桌面业务派发，两层都成功才返回值。
 * 六十五秒是控制请求等待预算，略大于桌面 broker 的六十秒预算。
 * 等待超时不能说明后台已取消操作，调用方需要查询实际持久状态。
 * 客户端不自动重发带副作用的命令，避免丢回执之后重复下载或创建执行。
 * 连接错误只返回稳定错误码，避免将私有路径或操作系统错误细节带到页面。
 * 这里不实现 TCP 控制端口，也不转发浏览器 Cookie 或设备令牌。
 */
export class DesktopAgentClient {
    /** 客户端只保存主进程已选定的私有档案根，实际 socket 与 nonce 在每次调用时重新读取；重新打开 GUI 可以连接原后台，而 renderer 不会得到可自行复用的认证描述。 */
    constructor(readonly root: string) {}

    /** 每次调用单独建立有界连接并读取一条完整响应，超时、错误或未知格式立即销毁连接；不开放监听 TCP 端口，也不允许调用者传入 socket 路径或认证 nonce。 */
    async call(input: unknown): Promise<unknown> {
        const descriptor = await readPrivate<{ socket: string; nonce: string }>(
            this.root,
            "desktop-agent.json",
        );
        if (
            descriptor.socket !== join(this.root, "desktop-agent.sock") ||
            !/^[0-9a-f]{64}$/.test(descriptor.nonce)
        )
            throw new Error("AGENT_DESCRIPTOR_INVALID");
        const outgoing = JSON.stringify({
            type: "desktop",
            nonce: descriptor.nonce,
            command: input,
        });
        if (Buffer.byteLength(outgoing) > 65535) throw new Error("IPC_PAYLOAD_LIMIT");
        return new Promise((resolve, reject) => {
            const socket = connect(descriptor.socket);
            const chunks: Buffer[] = [];
            let bytes = 0;
            let completed = false;
            const fail = (error: Error) => {
                completed = true;
                socket.destroy();
                reject(error);
            };
            socket.on("end", () => {
                if (!completed) fail(new Error("AGENT_CONNECTION_CLOSED"));
            });
            socket.on("close", () => {
                if (!completed) fail(new Error("AGENT_CONNECTION_CLOSED"));
            });
            socket.on("error", () => fail(new Error("AGENT_UNAVAILABLE")));
            socket.setTimeout(65000, () => fail(new Error("AGENT_REQUEST_TIMEOUT")));
            socket.on("connect", () => socket.write(outgoing + "\n"));
            /** socket 分块不是 Unicode 字符边界，因此先按原始字节累计到换行帧，再一次性严格解码；预算也按原始字节检查，非法 UTF-8 直接失败而不会把替换字符写入业务数据。 */
            socket.on("data", (chunk) => {
                if (completed) return;
                bytes += chunk.length;
                if (bytes > 32 * 1024 * 1024) return fail(new Error("AGENT_RESPONSE_LIMIT"));
                chunks.push(chunk);
                if (!chunk.includes(10)) return;
                completed = true;
                socket.destroy();
                try {
                    const incoming = new TextDecoder("utf-8", { fatal: true }).decode(
                        Buffer.concat(chunks, bytes),
                    );
                    const envelope = JSON.parse(incoming);
                    if (!envelope.ok || !envelope.value?.ok)
                        throw new Error(envelope.value?.error ?? "AGENT_REQUEST_FAILED");
                    resolve(envelope.value.value);
                } catch (error) {
                    reject(error);
                }
            });
        });
    }
}
