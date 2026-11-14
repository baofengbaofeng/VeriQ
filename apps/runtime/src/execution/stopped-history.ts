/** 凭据迁移对在线历史只做有限只读核验，不运行网络对账或进程恢复；未派生记录必须满足正式 Claim 契约且没有进程成员，已派生记录必须具备同一 Attempt 的完整持久身份和真实排空证明，孤立文件一律阻止迁移。 */
import { join } from "node:path";
import { validateSchema } from "@veriq/contracts";
import { isPreSpawnState } from "./pre-spawn.ts";
import { ProcessRecords } from "./records.ts";
import { ProcessSupervisor } from "./processes.ts";

/** 可选回执只作为已保存的客户端事实接受严格结构校验，不能取代下方实际进程成员与内核证明；旧回执不补范围，未派生范围只能配对白名单状态，平台不适用的受控声明也不会变成迁移授权。 */
function validStop(value: unknown, id: string, state: string): boolean {
    if (value === undefined) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const stop = value as Record<string, unknown>;
    if (
        Object.keys(stop).some(
            (key) =>
                ![
                    "attemptId",
                    "processStopped",
                    "processStopScope",
                    "reason",
                    "stoppedAt",
                ].includes(key),
        ) ||
        stop.attemptId !== id ||
        typeof stop.processStopped !== "boolean" ||
        typeof stop.reason !== "string" ||
        !stop.reason ||
        validateSchema("Timestamp", stop.stoppedAt).length
    )
        return false;
    if (stop.processStopScope === undefined) return true;
    if (validateSchema("ProcessStopScope", stop.processStopScope).length) return false;
    const unspawned = isPreSpawnState(state, "ONLINE");
    if (stop.processStopScope === "NO_PROCESS_SPAWNED") return unspawned;
    if (unspawned) return false;
    return stop.processStopScope === "FULL_DESCENDANT_TREE"
        ? ["linux", "win32"].includes(process.platform)
        : process.platform === "darwin";
}

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
                    (key) => !["claim", "claimRequestId", "state", "work", "stop"].includes(key),
                ) ||
                !validStop(record.stop, id, record.state) ||
                validateSchema("ClaimDTO", record.claim).length ||
                (record.claim as { attemptId: string }).attemptId !== id ||
                record.work !== join(root, "work", id) ||
                (record.claimRequestId !== undefined &&
                    validateSchema("Id", record.claimRequestId).length)
            )
                throw new Error("INVALID_ATTEMPT_HISTORY");
            if (isPreSpawnState(record.state, "ONLINE")) {
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
