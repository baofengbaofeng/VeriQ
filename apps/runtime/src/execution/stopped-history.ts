/** 凭据迁移对在线历史只做有限只读核验，不运行网络对账或进程恢复；未派生记录必须满足正式 Claim 契约且没有进程成员，已派生记录必须具备同一 Attempt 的完整持久身份和真实排空证明，孤立文件一律阻止迁移。 */
import { join } from "node:path";
import { validateSchema } from "@veriq/contracts";
import { ProcessRecords } from "./records.ts";
import { ProcessSupervisor } from "./processes.ts";

/** 此守卫由持有桌面与在线 Agent 排他所有权的调用者执行，最多检查四千零九十六次 Attempt 及各自两份进程证明；超过边界明确要求恢复处理，绝不删除历史、推断 PID 消失等于排空或对未知进程发送信号。 */
export async function requireStoppedHistory(root: string): Promise<void> {
    let attempts: ProcessRecords | undefined, records: ProcessRecords | undefined;
    try {
        attempts = await ProcessRecords.open(join(root, "attempts"));
        records = await ProcessRecords.open(join(root, "processes"));
        const attemptNames = (await attempts?.names(4096)) ?? [];
        const processNames = new Set((await records?.names(8192)) ?? []);
        const processes = new ProcessSupervisor(join(root, "processes"));
        for (const name of attemptNames) {
            if (!/^[a-zA-Z0-9_-]{1,100}\.json$/.test(name))
                throw new Error("INVALID_ATTEMPT_HISTORY");
            const id = name.slice(0, -5);
            const record = (await attempts!.read(name, 65536)) as Record<string, unknown>;
            if (
                !record ||
                typeof record !== "object" ||
                Array.isArray(record) ||
                typeof record.state !== "string" ||
                Object.keys(record).some(
                    (key) => !["claim", "claimRequestId", "state", "work"].includes(key),
                ) ||
                validateSchema("ClaimDTO", record.claim).length ||
                (record.claim as { attemptId: string }).attemptId !== id ||
                record.work !== join(root, "work", id) ||
                (record.claimRequestId !== undefined &&
                    validateSchema("Id", record.claimRequestId).length)
            )
                throw new Error("INVALID_ATTEMPT_HISTORY");
            if (["ALLOCATED", "ACTIVATING", "ACTIVATED"].includes(String(record.state))) {
                if (
                    processNames.has(`${id}.process.json`) ||
                    processNames.has(`${id}.drained.json`)
                )
                    throw new Error("UNEXPECTED_PROCESS_HISTORY");
            } else {
                if (
                    !["SPAWNING", "RUNNING", "STOPPED"].includes(String(record.state)) ||
                    !processNames.delete(`${id}.process.json`) ||
                    !processNames.delete(`${id}.drained.json`) ||
                    !(await processes.confirmStopped(id))
                )
                    throw new Error("UNPROVED_PROCESS_HISTORY");
            }
        }
        if (processNames.size) throw new Error("ORPHAN_PROCESS_HISTORY");
    } catch {
        throw new Error("VAULT_RUNTIME_RECOVERY_REQUIRED");
    } finally {
        try {
            await records?.close();
        } finally {
            await attempts?.close();
        }
    }
}
