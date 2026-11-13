import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "../../apps/desktop/tests/fixtures";
import { DesktopAgentClient } from "../../apps/desktop/src/agent/client";

/** 测试后台身份来自实际认证状态，Linux 进程观察同时保留 uid、启动时钟和退出状态；PID 消失、启动时钟改变或已成为僵尸只证明原进程退出，不能把僵尸当作仍在运行的独立后台。 */
async function identity(pid: number) {
    try {
        const raw = await readFile(`/proc/${pid}/stat`, "utf8");
        const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
        return { uid: (await stat(`/proc/${pid}`)).uid, state: fields[0], start: fields[19] };
    } catch (error) {
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? ""))
            return undefined;
        throw error;
    }
}

/** 测试清理通过同一档案的认证协议请求停止并等待真实进程退出与描述文件撤销，不能只发 SIGTERM 就把档案交给下一场景；身份不符时失败保留诊断，不杀未知 PID 或删除尚被拥有的数据库。 */
export async function stopTestAgent(profile: string, pid: number): Promise<void> {
    const before = await identity(pid);
    if (before && before.uid !== process.getuid?.()) throw new Error("TEST_AGENT_OWNER_MISMATCH");
    if (before && before.state !== "Z") {
        const client = new DesktopAgentClient(profile);
        try {
            const state = await client.call({ operation: "status" });
            if (!state || typeof state !== "object" || !("pid" in state) || state.pid !== pid)
                throw new Error("TEST_AGENT_IDENTITY_MISMATCH");
            await client.call({ operation: "stop" });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    await expect
        .poll(
            async () => {
                const current = await identity(pid);
                return !current || current.state === "Z" || current.start !== before?.start;
            },
            { timeout: 15000, message: "Owned test Agent must exit before profile reuse" },
        )
        .toBe(true);
    await expect
        .poll(
            async () => {
                try {
                    await readFile(join(profile, "desktop-agent.json"));
                    return false;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
                    throw error;
                }
            },
            { timeout: 15000, message: "Agent descriptor must be revoked before profile reuse" },
        )
        .toBe(true);
    console.log("Owned test Agent exited and descriptor removed", pid, before?.start);
}
