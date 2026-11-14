import { join, basename, dirname } from "node:path";
import { unlink } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { AttemptBroker } from "../../../runtime/src/execution/broker.ts";
import {
    privateDirectory,
    readPrivate,
    updatePrivate,
    removePrivate,
} from "../../../runtime/src/offline/config.ts";
import { loadRuntimeDistribution, assertRuntimeRole } from "../../../runtime/src/distribution.ts";
import { DesktopAgent, type AgentConfiguration } from "./service";

/** 独立 Node24 后台入口只读取宿主已经写入的私有配置，通过现有 nonce broker 提供受限本机命令；锁持有期间才可删除陈旧 socket，防止并发 UI 启动抢占存活后台。 */
async function main() {
    if (process.versions.node !== "24.22.1") throw new Error("INDEPENDENT_NODE24_REQUIRED");
    process.title = "veriq_agent";
    /** 安装根从真实 Agent 角色可执行文件的固定发行布局取得，在任何档案访问前完成库存和原生能力绑定；开发 Node 入口保持原契约，档案中的 distributionRoot 只能与已核验根一致，不能授权装载新代码。 */
    const installed = /^veriq_agent(?:\.exe)?$/i.test(basename(process.execPath))
        ? await loadRuntimeDistribution(dirname(dirname(dirname(process.execPath))))
        : undefined;
    if (installed) assertRuntimeRole(installed, "agent");
    const root = process.argv[2];
    if (!root) throw new Error("AGENT_PROFILE_REQUIRED");
    await privateDirectory(root);
    const owner = join(root, "desktop-owner");
    await privateDirectory(owner);
    const release = await lockfile.lock(owner, { retries: 0 });
    const config = await readPrivate<AgentConfiguration>(root, "desktop-config.json");
    if (config.distributionRoot && config.distributionRoot !== installed?.root)
        throw new Error("RUNTIME_CONFIGURATION_MISMATCH");
    if (installed) {
        config.engineDirectory = installed.engineDirectory;
        config.engineVersion = installed.engineVersion;
        config.browserExecutable = installed.browserExecutable;
        config.headedExecutable = installed.browserExecutable;
    }
    const service = new DesktopAgent(root, config);
    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        try {
            await service.dispatch({ operation: "stop" });
            await broker.close();
        } finally {
            try {
                await removePrivate(root, "desktop-agent.json").catch(
                    (error: NodeJS.ErrnoException) => {
                        if (error.code !== "ENOENT") throw error;
                    },
                );
            } finally {
                await release();
            }
        }
    };
    const broker = new AttemptBroker(
        join(root, "desktop-agent.sock"),
        async (message) => {
            if (
                message.type !== "desktop" ||
                !message.command ||
                typeof message.command !== "object"
            )
                throw new Error("AGENT_OPERATION_DENIED");
            try {
                const value = await service.dispatch(message.command);
                if (JSON.stringify(value).length > 30 * 1024 * 1024)
                    throw new Error("AGENT_RESPONSE_LIMIT");
                if ("operation" in message.command && message.command.operation === "stop")
                    setTimeout(() => void stop(), 30);
                return { ok: true, value };
            } catch (error) {
                return {
                    ok: false,
                    error:
                        error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
                            ? error.message
                            : "AGENT_REQUEST_FAILED",
                };
            }
        },
        60000,
    );
    await unlink(broker.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
    });
    await broker.open();
    await updatePrivate(root, "desktop-agent.json", () => ({
        socket: broker.path,
        nonce: broker.nonce,
    }));
    process.once("SIGTERM", () => void stop());
    process.once("SIGINT", () => void stop());
}
void main().catch((error) => {
    console.error("VeriQ Agent failed:", error instanceof Error ? error.message : "UNKNOWN_ERROR");
    process.exitCode = 1;
});
