/**
 * 凭据迁移对在线历史只做有限只读核验，不运行网络对账或进程恢复；未派生记录必须满足正式 Claim 契约且没有进程成员，
 * 已派生记录必须具备同一 Attempt 的完整持久身份和真实排空证明，孤立文件一律阻止迁移。
 */
import { join } from "node:path";
import { validateSchema } from "@veriq/contracts";
import { isPreSpawnState } from "./pre-spawn.ts";
import { ProcessRecords, sameSettledAttempt } from "./records.ts";
import { ProcessSupervisor } from "./processes.ts";
import { matchesControlledClaim } from "./darwin-proof.ts";
import type { WindowsAttemptJournal, WindowsAttemptRecord } from "./windows-journal.ts";

/**
 * 可选回执只作为已保存的客户端事实接受严格结构校验，不能取代下方实际进程成员与内核证明；旧回执不补范围，
 * 未派生范围只能配对白名单状态，平台不适用的受控声明也不会变成迁移授权。
 */
function validStop(value: unknown, id: string, state: string): boolean {
    if (value === undefined) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const stop = value as Record<string, unknown>;
    if (
        Object.keys(stop).some(
            (key) => !["attemptId", "processStopped", "processStopScope", "reason", "stoppedAt"].includes(key),
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

/**
 * 调用者持有档案所有权时，一并核查活动和归档的 Attempt 及其进程证明。孤立成员和未经证实的停止仍阻止维护。
 */
export async function requireStoppedHistory(root: string): Promise<void> {
    let archived: ProcessRecords | undefined, attempts: ProcessRecords | undefined, records: ProcessRecords | undefined;
    let windowsJournal: WindowsAttemptJournal | undefined;
    try {
        attempts = await ProcessRecords.open(join(root, "attempts"));
        records = await ProcessRecords.open(join(root, "processes"));
        const attemptNames = (await attempts?.names()) ?? [];
        const processNames = new Set((await records?.names()) ?? []);
        const processes = new ProcessSupervisor(join(root, "processes"));
        const requireAttempt = async (id: string, value: unknown): Promise<void> => {
            const record = value as Record<string, unknown>;
            if (
                !record ||
                typeof record !== "object" ||
                Array.isArray(record) ||
                typeof record.state !== "string" ||
                Object.keys(record).some(
                    (key) =>
                        ![
                            "claim",
                            "runnerId",
                            "claimRequestId",
                            "state",
                            "work",
                            "stop",
                            "allocation",
                            "dataCleanup",
                        ].includes(key),
                ) ||
                (record.runnerId !== undefined && validateSchema("Id", record.runnerId).length) ||
                !validStop(record.stop, id, record.state) ||
                validateSchema("ClaimDTO", record.claim).length ||
                (record.claim as { attemptId: string }).attemptId !== id ||
                record.work !== join(root, "work", id) ||
                (record.claimRequestId !== undefined && validateSchema("Id", record.claimRequestId).length)
            )
                throw new Error("INVALID_ATTEMPT_HISTORY");
            if (isPreSpawnState(record.state, "ONLINE")) {
                if (
                    processNames.has(`${id}.process.json`) ||
                    processNames.has(`${id}.drained.json`) ||
                    processNames.has(`${id}.controlled.json`)
                )
                    throw new Error("UNEXPECTED_PROCESS_HISTORY");
            } else {
                if (
                    !["SPAWNING", "RUNNING", "STOPPED"].includes(String(record.state)) ||
                    !processNames.delete(`${id}.process.json`) ||
                    !processNames.delete(`${id}.${process.platform === "darwin" ? "controlled" : "drained"}.json`) ||
                    !(await processes.confirmStopped(id))
                )
                    throw new Error("UNPROVED_PROCESS_HISTORY");
                /**
                 * Darwin 在线历史必须继续绑定服务端原有 fencingToken，不能让另一个合法私有过程证明替代本次 Claim
                 * 的代际；这里仅观察已经提交的源记录，未接入业务写入流程前不补造 nonc
                 * e 或修改旧代记录。
                 */
                if (process.platform === "darwin") {
                    const processRecord = await records!.read(`${id}.process.json`, 65536);
                    if (!matchesControlledClaim(processRecord, record.claim))
                        throw new Error("UNPROVED_PROCESS_HISTORY");
                }
            }
        };
        if (process.platform === "win32") {
            // Windows 旧 JSON 从未取得新 SQLite 提交权威，因此即使内容声称 ALLOCATED 或已有停止回执也不能借迁移守卫补造
            // 可信历史；任何 legacy、staging 或孤立进程成员保持恢复拒绝
            // ，不自动导入或删除。
            if (attemptNames.length) throw new Error("WINDOWS_LEGACY_JOURNAL_RECOVERY_REQUIRED");
            const { WindowsAttemptJournal } = await import("./windows-journal.ts");
            windowsJournal = await WindowsAttemptJournal.openExisting(root);
            if (windowsJournal) {
                await windowsJournal.requireNoLegacy();
                const active = new Map<string, WindowsAttemptRecord>();
                for (const record of windowsJournal.records()) {
                    await requireAttempt(record.claim.attemptId, record);
                    active.set(record.claim.attemptId, record);
                }
                for await (const record of WindowsAttemptJournal.archived(root)) {
                    const duplicate = active.get(record.claim.attemptId);
                    if (!duplicate) await requireAttempt(record.claim.attemptId, record);
                    else if (!sameSettledAttempt(duplicate, record)) throw new Error("ATTEMPT_ARCHIVE_CONFLICT");
                }
            }
        } else {
            // Linux 与 Darwin 继续只读核原有 JSON 与同一 Attempt 的真实进程证明，不迁移到 Windows 数据库、
            // 不改旧来源或扩大停止范围；公共核验函数只复用原有 Claim、工作路径、状态和已
            // 确认排空条件。
            archived = await ProcessRecords.open(join(root, "settled-attempts"));
            const active = new Set(attemptNames);
            for (const [directory, names] of [
                [attempts, attemptNames],
                [archived, (await archived?.names()) ?? []],
            ] as const) {
                for (const name of names) {
                    if (!/^[a-zA-Z0-9_-]{1,100}\.json$/.test(name)) throw new Error("INVALID_ATTEMPT_HISTORY");
                    const value = (await directory!.read(name, 65536)) as WindowsAttemptRecord;
                    if (directory === archived && active.has(name)) {
                        const original = (await attempts!.read(name, 65536)) as WindowsAttemptRecord;
                        if (!sameSettledAttempt(original, value)) throw new Error("ATTEMPT_ARCHIVE_CONFLICT");
                    } else await requireAttempt(name.slice(0, -5), value);
                }
            }
        }
        if (processNames.size) throw new Error("ORPHAN_PROCESS_HISTORY");
    } catch {
        throw new Error("VAULT_RUNTIME_RECOVERY_REQUIRED");
    } finally {
        try {
            windowsJournal?.close();
        } finally {
            try {
                await records?.close();
            } finally {
                try {
                    await attempts?.close();
                } finally {
                    await archived?.close();
                }
            }
        }
    }
}
