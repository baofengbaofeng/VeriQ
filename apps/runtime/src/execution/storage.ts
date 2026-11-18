/**
 * 本文件监控 Attempt 工作区磁盘与文件数：连同 Chromium 未完成暂存一并计入预算：
 * 超限即触发确定性停机（storage/INVALID_STORAGE_LIMIT）。
 */

import { lstat, readdir, realpath, rmdir, unlink, open, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { readBoundedFile } from "../offline/config.ts";
import type { StopReceipt } from "./processes.ts";
import { basename, dirname, join, resolve } from "node:path";
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

interface DirectoryIdentity {
    dev: string;
    ino: string;
    birth: string;
}

/**
 * Attempt 只记录自身目录的文件系统身份和随机标记；工作目录、临时根及可退休成员均由宿主重建，日志不能指定任意清理路径。
 */
export interface TaskAllocation {
    temporaryName: string;
    owner: string;
    work: DirectoryIdentity;
    temporaryParent: DirectoryIdentity;
    temporary: DirectoryIdentity;
    modules: DirectoryIdentity;
}
export type DataCleanup = "CLEANED" | "OWNERSHIP_UNCONFIRMED" | "STOP_UNCONFIRMED" | "REPORT_RETAINED";

/**
 * 读取时拒绝目录链接与平台无效文件标识，创建时间额外区分删除后恰好复用相同 inode 的不同代际。
 */
async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
    const st = await lstat(path, { bigint: true });
    if (!st.isDirectory() || st.ino === 0n || st.birthtimeNs <= 0n) throw new Error("TASK_DIRECTORY_UNCONFIRMED");
    return { dev: String(st.dev), ino: String(st.ino), birth: String(st.birthtimeNs) };
}

/**
 * 只有新建的 Attempt 才能签发清理身份，包安装缓存和控制面投影使用不同目录，崩溃后无需读取业务内容来辨认它们。
 */
export async function allocateScratch(work: string, tmp: string): Promise<TaskAllocation> {
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
 * 清理前同时复核真实对象、宿主签发的独立标记和实际停止范围；旧日志缺少物理身份时保留原件，由操作者处理。
 */
export async function retireScratch(
    root: string,
    temporaryRoot: string,
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
    // 旧平台的路径 API 无法把递归清理绑定到已打开的对象；保留文件和可重试状态。
    if (process.platform !== "linux") return "OWNERSHIP_UNCONFIRMED";
    const a = record.allocation,
        work = join(root, "work", stop.attemptId);
    if (
        !a ||
        record.work !== work ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(stop.attemptId) ||
        !/^veriq-a-[a-zA-Z0-9]{6}$/.test(a.temporaryName) ||
        !/^[0-9a-f-]{36}$/.test(a.owner)
    )
        return "OWNERSHIP_UNCONFIRMED";
    const handles: Awaited<ReturnType<typeof open>>[] = [];
    try {
        const check = async (path: string, id: DirectoryIdentity, marked: boolean) => {
            const current = await directoryIdentity(path);
            if (current.dev !== id.dev || current.ino !== id.ino || current.birth !== id.birth)
                throw new Error("TASK_DIRECTORY_CHANGED");
            if (marked && (await readBoundedFile(join(path, ".veriq-owner"), 36, true)).toString() !== a.owner)
                throw new Error("TASK_DIRECTORY_CHANGED");
        };
        const parent = async (path: string) => {
            if ((await realpath(path)) !== resolve(path)) throw new Error("TASK_PARENT_CHANGED");
            const held = await open(path, constants.O_DIRECTORY | constants.O_RDONLY | constants.O_NOFOLLOW);
            handles.push(held);
            const anchor = "/proc/self/fd/" + held.fd;
            if ((await realpath(anchor)) !== resolve(path)) throw new Error("TASK_PARENT_CHANGED");
            return anchor;
        };
        const heldWork = await parent(work);
        await check(heldWork + "/.", a.work, true);
        const heldTmp = await parent(await realpath(temporaryRoot));
        await check(heldTmp + "/.", a.temporaryParent, false);
        const targets = [];
        for (const [base, name, id, marked] of [
            [heldWork, "node_modules", a.modules, false],
            [heldTmp, a.temporaryName, a.temporary, true],
        ] as const) {
            const path = join(base, name);
            const child = await open(path, constants.O_DIRECTORY | constants.O_RDONLY | constants.O_NOFOLLOW);
            handles.push(child);
            const anchor = "/proc/self/fd/" + child.fd;
            await check(anchor + "/.", id, marked);
            const finished = (await readdir(anchor)).includes(".veriq-retired");
            if (record.dataCleanup === "CLEANED" && !finished) throw new Error("TASK_DIRECTORY_CHANGED");
            if (finished) {
                if ((await readBoundedFile(join(anchor, ".veriq-retired"), 36, true)).toString() !== a.owner)
                    throw new Error("TASK_DIRECTORY_CHANGED");
                const entries = await readdir(anchor);
                if (entries.some((entry) => entry !== ".veriq-retired" && !(marked && entry === ".veriq-owner")))
                    throw new Error("TASK_DIRECTORY_CHANGED");
            }
            targets.push({ path, anchor, child, id, marked, finished });
        }
        // 顶层任务目录始终保留为已验证的空目录；Linux 没有按打开的目录句柄删除它自身的接口。
        // 所有子目录逐层打开后通过自己的 fd 遍历，不经由可被替换的字符串路径进行递归删除。
        const mountId = async (fd: number) => {
            const info = await readFile("/proc/self/fdinfo/" + fd, "utf8");
            const id = /^mnt_id:\s*(\d+)$/mu.exec(info)?.[1];
            if (!id) throw new Error("TASK_MOUNT_UNCONFIRMED");
            return id;
        };
        const empty = async (anchor: string, mount: string, marked: boolean, verifyRoot: () => Promise<void>) => {
            for (const name of await readdir(anchor)) {
                if (marked && name === ".veriq-owner") continue;
                await verifyRoot();
                const path = join(anchor, name),
                    before = await lstat(path, { bigint: true });
                if (before.isDirectory()) {
                    const child = await open(path, constants.O_DIRECTORY | constants.O_RDONLY | constants.O_NOFOLLOW);
                    try {
                        const current = await child.stat({ bigint: true });
                        if (
                            current.ino !== before.ino ||
                            current.dev !== before.dev ||
                            (await mountId(child.fd)) !== mount
                        )
                            throw new Error("TASK_DIRECTORY_CHANGED");
                        const verifyChild = async () => {
                            await verifyRoot();
                            const named = await lstat(path, { bigint: true });
                            if (named.ino !== current.ino || named.dev !== current.dev)
                                throw new Error("TASK_DIRECTORY_CHANGED");
                        };
                        await empty("/proc/self/fd/" + child.fd, mount, false, verifyChild);
                        await verifyChild();
                        await rmdir(path);
                    } finally {
                        await child.close();
                    }
                } else {
                    await unlink(path);
                }
            }
        };
        for (const target of targets) {
            const verifyRoot = () => check(target.path, target.id, target.marked);
            if (target.finished) continue;
            await empty(target.anchor, await mountId(target.child.fd), target.marked, verifyRoot);
            await verifyRoot();
            const remaining = await readdir(target.anchor);
            if (remaining.some((name) => !target.marked || name !== ".veriq-owner"))
                throw new Error("TASK_DIRECTORY_CHANGED");
            const marker = await open(join(target.anchor, ".veriq-retired"), "wx", 0o600);
            try {
                await marker.writeFile(a.owner);
                await marker.sync();
            } finally {
                await marker.close();
            }
            await target.child.sync();
        }
        for (const target of targets) {
            await check(target.path, target.id, target.marked);
            const remaining = await readdir(target.anchor);
            if (
                !remaining.includes(".veriq-retired") ||
                remaining.some((name) => name !== ".veriq-retired" && !(target.marked && name === ".veriq-owner"))
            )
                throw new Error("TASK_DIRECTORY_CHANGED");
        }
        return "CLEANED";
    } catch {
        return "OWNERSHIP_UNCONFIRMED";
    } finally {
        for (const held of handles) await held.close();
    }
}
