import { connect } from "node:net";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { readPrivate } from "../../apps/runtime/src/offline/config";

/**
 * 一次清理只向已核实档案的固定套接字出示同一个实例凭据，即使原后台在状态查询后退出，新后台也无法接收它的停止命令。
 */
export async function bindAgentControl(profile: string) {
    if ((await realpath(profile)) !== profile) throw new Error("TEST_AGENT_PROFILE_CHANGED");
    const desc = await readPrivate<{ socket: string; nonce: string }>(profile, "desktop-agent.json").catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            throw Object.assign(new Error("TEST_AGENT_DESCRIPTOR_MISSING"), { code: "ENOENT" });
        throw new Error("TEST_AGENT_DESCRIPTOR_INVALID");
    });
    if (
        desc?.socket !== join(profile, "desktop-agent.sock") ||
        typeof desc.nonce !== "string" ||
        !/^[0-9a-f]{64}$/u.test(desc.nonce)
    )
        throw new Error("TEST_AGENT_DESCRIPTOR_INVALID");
    return {
        call(command: { operation: "status" | "stop" }): Promise<{ pid?: number; stopped?: boolean }> {
            return new Promise((resolve, reject) => {
                const socket = connect(desc.socket);
                const parts: Buffer[] = [];
                let bytes = 0;
                const fail = () => {
                    socket.destroy();
                    reject(new Error("TEST_AGENT_CONTROL_FAILED"));
                };
                const deadline = setTimeout(fail, 15000);
                socket.on("connect", () =>
                    socket.write(JSON.stringify({ type: "desktop", nonce: desc.nonce, command }) + "\n"),
                );
                socket.once("end", fail);
                socket.once("error", fail);
                socket.once("close", () => {
                    clearTimeout(deadline);
                    fail();
                });
                socket.on("data", (chunk: Buffer) => {
                    bytes += chunk.length;
                    if (bytes > 32 * 1024 * 1024) return fail();
                    parts.push(chunk);
                    if (!chunk.includes(10)) return;
                    try {
                        const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
                        if (data?.ok !== true || data.value?.ok !== true || !data.value.value) return fail();
                        resolve(data.value.value);
                        socket.destroy();
                    } catch {
                        fail();
                    }
                });
            });
        },
    };
}
