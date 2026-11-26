/**
 * 本文件提供 Agent 本机控制通道，通过带 nonce 的 Unix 套接字查询状态或请求停止，完全不经过平台 HTTP。
 */
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import { AttemptBroker } from "../execution/broker.ts";
import type { ClaimLoopState } from "./claim-loop.ts";

interface AgentControlStatus extends ClaimLoopState {
    running: boolean;
    pid: number;
}

/**
 * 只接受已知本机状态字段及其类型，保留旧进程信息并丢弃附加私有数据；无效填充值不能变成真实维护状态。
 */
function agentStatus(value: unknown): AgentControlStatus {
    if (!value || typeof value !== "object") throw new Error("INVALID_AGENT_RESPONSE");
    const { running, pid, pausedReason, scratchCleanupPending } = value as Partial<AgentControlStatus>;
    if (
        typeof running !== "boolean" ||
        typeof pid !== "number" ||
        !Number.isSafeInteger(pid) ||
        pid < 1 ||
        (pausedReason !== undefined &&
            pausedReason !== "RUNTIME_STORAGE_LOW" &&
            pausedReason !== "RUNTIME_STORAGE_UNAVAILABLE") ||
        (scratchCleanupPending !== undefined && typeof scratchCleanupPending !== "boolean")
    ) {
        throw new Error("INVALID_AGENT_RESPONSE");
    }
    return {
        running,
        pid,
        ...(pausedReason === undefined ? {} : { pausedReason }),
        ...(scratchCleanupPending === undefined ? {} : { scratchCleanupPending }),
    };
}

/**
 * 公开函数 serveAgentControl 在配置根下打开带 nonce 的本机控制套接字，供同机 CLI 查询状态或请求停机。写入
 * agent-control.json 前先清除陈旧套接字；
 * 返回的关闭回调会拆除代理并删除控制描述文件。
 */
export async function serveAgentControl(
    root: string,
    stop: () => void,
    state: () => Readonly<ClaimLoopState> = () => ({}),
) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const broker = new AttemptBroker(join(root, "agent.sock"), async (message) => {
        if (message.type === "stop") stop();
        else if (message.type !== "status") throw new Error("INVALID_OPERATION");
        const { pausedReason, scratchCleanupPending } = state();
        return { running: true, pid: process.pid, pausedReason, scratchCleanupPending };
    });
    // 调用方先持有配置目录的运行实例锁，才清理遗留的控制套接字，避免移除另一正在运行的代理的控制入口。
    await unlink(broker.path).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
    });
    await broker.open();
    await writeFile(join(root, "agent-control.json"), JSON.stringify({ socket: broker.path, nonce: broker.nonce }), {
        mode: 0o600,
        flush: true,
    });
    return async () => {
        await broker.close();
        await unlink(join(root, "agent-control.json"));
    };
}
/**
 * 公开函数 agentControl 连接本机 agent-control.json 描述的套接字，发送 stop/status 并校验 nonce 与超时。连接失败、
 * 超时或非 ok 应答一律映射为 AGENT_UNAVAILABLE，
 * 避免把内部错误细节泄漏给调用方。
 */
export async function agentControl(root: string, type: "stop" | "status") {
    const config = JSON.parse(await readFile(join(root, "agent-control.json"), "utf8")) as {
        socket: string;
        nonce: string;
    };
    return new Promise<AgentControlStatus>((resolve, reject) => {
        const socket = connect(config.socket);
        const chunks: Buffer[] = [];
        let bytes = 0;
        socket.on("connect", () => socket.write(JSON.stringify({ type, nonce: config.nonce }) + "\n"));
        socket.on("error", () => reject(new Error("AGENT_UNAVAILABLE")));
        socket.on("end", () => reject(new Error("AGENT_UNAVAILABLE")));
        socket.setTimeout(5000, () => {
            socket.destroy();
            reject(new Error("AGENT_UNAVAILABLE"));
        });
        socket.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 65536) {
                socket.destroy();
                reject(new Error("INVALID_AGENT_RESPONSE"));
                return;
            }
            chunks.push(chunk);
            if (!chunk.includes(10)) return;
            socket.destroy();
            try {
                const reply: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
                if (!reply || typeof reply !== "object" || !("ok" in reply)) throw new Error("INVALID_AGENT_RESPONSE");
                if (reply.ok !== true) throw new Error("AGENT_UNAVAILABLE");
                resolve(agentStatus("value" in reply ? reply.value : undefined));
            } catch (error) {
                reject(
                    new Error(
                        error instanceof Error && error.message === "AGENT_UNAVAILABLE"
                            ? "AGENT_UNAVAILABLE"
                            : "INVALID_AGENT_RESPONSE",
                    ),
                );
            }
        });
    });
}
