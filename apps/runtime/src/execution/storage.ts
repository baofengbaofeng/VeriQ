/**
 * 本文件监控 Attempt 工作区磁盘与文件数：连同 Chromium 未完成暂存一并计入预算：
 * 超限即触发确定性停机（storage/INVALID_STORAGE_LIMIT）。
 */

import { lstat, readdir, realpath, mkdir, writeFile } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import type { StopReceipt } from "./processes.ts";
import { basename, dirname, join } from "node:path";
/**
 * 公开函数 monitorStorage 每百毫秒扫描 Attempt 根目录累计字节与文件数：超限时调用 stop 并停止后续探测。
 * 不跟随符号链接以免扫出树外。
 */
export function monitorStorage(
    root: string,
    maxBytes: number,
    stop: (reason: string) => Promise<void>,
): {
    close(): void;
} {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("INVALID_STORAGE_LIMIT");
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scan = async () => {
        let bytes = 0,
            files = 0;
        const visit = async (path: string): Promise<void> => {
            const info = await lstat(path);
            if (info.isSymbolicLink()) return; // 不跟随树外符号链接，防止 Singleton 把扫描带到 Attempt 之外。
            if (++files > 10000) throw new Error("ATTEMPT_STORAGE_LIMIT");
            if (info.isFile()) bytes += info.size;
            if (bytes > maxBytes) throw new Error("ATTEMPT_STORAGE_LIMIT");
            if (info.isDirectory())
                for (const entry of await readdir(path)) {
                    try {
                        await visit(join(path, entry));
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                    }
                }
        };
        try {
            await visit(root);
        } catch (error) {
            if (closed) return;
            closed = true;
            const reason =
                error instanceof Error && /^ATTEMPT_STORAGE_/.test(error.message)
                    ? error.message
                    : "ATTEMPT_STORAGE_UNAVAILABLE";
            await stop(reason);
            return;
        }
        if (!closed) timer = setTimeout(() => void scan(), 100);
    };
    void scan();
    return {
        close() {
            closed = true;
            clearTimeout(timer);
        },
    };
}

interface PhysicalIdentity {
    dev: string;
    ino: string;
    birth: string;
}

/**
 * 日志中的目录身份和所有者标记用于辨认分配现场，历史退休许可字段仍可读取并随日志保存。
 */
export interface TaskAllocation {
    temporaryName: string;
    owner: string;
    work: PhysicalIdentity;
    temporaryParent: PhysicalIdentity;
    temporary: PhysicalIdentity;
    modules: PhysicalIdentity;
    retirementPermit?: PhysicalIdentity;
}
/**
 * 暂存处置状态与业务结果分别记录，历史日志可能包含早期版本写入的已清理状态，当前版本保留现场。
 */
export type DataCleanup = "CLEANED" | "OWNERSHIP_UNCONFIRMED" | "STOP_UNCONFIRMED" | "REPORT_RETAINED";

/**
 * 日志以设备号、物理编号及创建时间记录实际目录，编号或时间无效时无法可靠辨认其代际。
 */
function physicalIdentity(st: BigIntStats): PhysicalIdentity {
    if (st.ino === 0n || st.birthtimeNs <= 0n) throw new Error("TASK_IDENTITY_UNCONFIRMED");
    return { dev: String(st.dev), ino: String(st.ino), birth: String(st.birthtimeNs) };
}

async function directoryIdentity(path: string): Promise<PhysicalIdentity> {
    const st = await lstat(path, { bigint: true });
    if (!st.isDirectory()) throw new Error("TASK_DIRECTORY_UNCONFIRMED");
    return physicalIdentity(st);
}

/**
 * 新任务保留工作目录、依赖目录和临时目录的分配身份，便于事后辨认这次任务留下的现场。
 */
export async function allocateScratch(_root: string, work: string, tmp: string): Promise<TaskAllocation> {
    const owner = randomUUID();
    const modules = join(work, "node_modules");
    await mkdir(modules, { mode: 0o700 });
    for (const dir of [work, tmp]) await writeFile(join(dir, ".veriq-owner"), owner, { mode: 0o600, flag: "wx" });
    return {
        temporaryName: basename(tmp),
        owner,
        work: await directoryIdentity(work),
        temporaryParent: await directoryIdentity(await realpath(dirname(tmp))),
        temporary: await directoryIdentity(tmp),
        modules: await directoryIdentity(modules),
    };
}

/**
 * 先核对实际停止范围，再记录暂存处置状态。可变任务树缺少排他所有权证明，自动处置保留原件。
 */
export async function retireScratch(
    _root: string,
    _temporaryRoot: string,
    record: { work: string; allocation?: TaskAllocation; dataCleanup?: DataCleanup },
    stop: StopReceipt,
): Promise<DataCleanup> {
    if (
        !["linux", "win32", "darwin"].includes(process.platform) ||
        !stop.processStopped ||
        ![
            "NO_PROCESS_SPAWNED",
            process.platform === "darwin" ? "CONTROLLED_WORKER_BROWSER" : "FULL_DESCENDANT_TREE",
        ].includes(stop.processStopScope ?? "")
    )
        return "STOP_UNCONFIRMED";
    if (record.dataCleanup === "REPORT_RETAINED") return record.dataCleanup;
    return "OWNERSHIP_UNCONFIRMED";
}
