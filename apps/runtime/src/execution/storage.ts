/**
 * 本文件监控 Attempt 工作区磁盘与文件数：连同 Chromium 未完成暂存一并计入预算：
 * 超限即触发确定性停机（storage/INVALID_STORAGE_LIMIT）。
 */

import { lstat, readdir, realpath, open, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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
            targets.push({ path, child, id, marked });
        }
        let complete = true;
        for (const target of targets) {
            const verifyRoot = () => check(target.path, target.id, target.marked);
            try {
                const retired = await retireContents(
                    target.child,
                    a.owner,
                    target.marked,
                    record.dataCleanup === "CLEANED",
                    verifyRoot,
                );
                if (!retired) complete = false;
            } catch {
                complete = false;
            }
        }
        for (const target of targets) await check(target.path, target.id, target.marked);
        return complete ? "CLEANED" : "OWNERSHIP_UNCONFIRMED";
    } catch {
        return "OWNERSHIP_UNCONFIRMED";
    } finally {
        for (const held of handles) await held.close();
    }
}

/**
 * 清点把整个任务树的原始名字和物理身份绑定为摘要；日志不写文件名。每个普通文件只通过已验证的独占 inode 描述符截断，
 * 目录名、文件名和链接均不删除。未知类型或已退休文件发生变化时保留内容并返回未确认状态。
 */
async function retireContents(
    root: Awaited<ReturnType<typeof open>>,
    owner: string,
    marked: boolean,
    previouslyCleaned: boolean,
    verifyRoot: () => Promise<void>,
): Promise<boolean> {
    const anchor = "/proc/self/fd/" + root.fd;
    const mount = async (fd: number) => {
        const info = await readFile("/proc/self/fdinfo/" + fd, "utf8");
        const id = /^mnt_id:\s*(\d+)$/mu.exec(info)?.[1];
        if (!id) throw new Error("TASK_MOUNT_UNCONFIRMED");
        return id;
    };
    const rootMount = await mount(root.fd);
    const snapshot = new Map<string, string>();
    const markerName = ".veriq-retirement-inventory",
        doneName = ".veriq-retired";
    const rootNames = await readdir(anchor);
    const finished = rootNames.includes(doneName);
    if ((previouslyCleaned || finished) && !rootNames.includes(markerName)) throw new Error("TASK_INVENTORY_MISSING");
    const scan = async (phase: "discover" | "truncate" | "verify") => {
        const digest = createHash("sha256");
        let safe = true;
        const walk = async (dir: string, relative: string, verifyParent: () => Promise<void>) => {
            const names = await readdir(dir, { encoding: "buffer" });
            const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
            for (const name of names.map((bytes) => decoder.decode(bytes)).sort()) {
                if (!relative && (name === markerName || name === doneName || (marked && name === ".veriq-owner")))
                    continue;
                const key = relative + "/" + name,
                    path = join(dir, name);
                const before = await lstat(path, { bigint: true });
                const identity = [before.dev, before.ino, before.birthtimeNs, before.mode, before.nlink].join(":");
                digest.update(JSON.stringify([key, identity]) + "\n");
                if (phase === "discover") snapshot.set(key, identity);
                else if (snapshot.get(key) !== identity) throw new Error("TASK_MEMBER_CHANGED");
                if (!(before.ino && before.birthtimeNs > 0n && before.uid === BigInt(process.getuid!()))) {
                    safe = false;
                    continue;
                }
                const verifyMember = async () => {
                    await verifyParent();
                    const current = await lstat(path, { bigint: true });
                    if (
                        current.ino !== before.ino ||
                        current.dev !== before.dev ||
                        current.birthtimeNs !== before.birthtimeNs ||
                        current.nlink !== before.nlink
                    )
                        throw new Error("TASK_MEMBER_CHANGED");
                };
                if (before.isDirectory()) {
                    const child = await open(path, constants.O_DIRECTORY | constants.O_RDONLY | constants.O_NOFOLLOW);
                    try {
                        const held = await child.stat({ bigint: true });
                        if (held.ino !== before.ino || held.dev !== before.dev || (await mount(child.fd)) !== rootMount)
                            throw new Error("TASK_MEMBER_CHANGED");
                        await walk("/proc/self/fd/" + child.fd, key, verifyMember);
                        await verifyMember();
                    } finally {
                        await child.close();
                    }
                } else if (!before.isFile() || before.nlink !== 1n) safe = false;
                else if (phase === "verify" || (phase === "truncate" && before.size)) {
                    const access = phase === "truncate" ? constants.O_WRONLY : constants.O_RDONLY;
                    const flags = access | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY;
                    const file = await open(path, flags);
                    try {
                        const held = await file.stat({ bigint: true });
                        if (
                            !held.isFile() ||
                            held.nlink !== 1n ||
                            held.dev !== before.dev ||
                            held.ino !== before.ino ||
                            held.birthtimeNs !== before.birthtimeNs ||
                            (await mount(file.fd)) !== rootMount
                        )
                            throw new Error("TASK_MEMBER_CHANGED");
                        if (phase === "truncate") {
                            await verifyMember();
                            await file.truncate(0);
                            await file.sync();
                            await verifyMember();
                        } else if (held.size) safe = false;
                    } finally {
                        await file.close();
                    }
                }
            }
        };
        await walk(anchor, "", verifyRoot);
        await verifyRoot();
        return { digest: digest.digest("hex"), safe };
    };
    const inventory = await scan("discover");
    const receipt = owner + ":" + inventory.digest;
    const marker = async (name: string, exists: boolean) => {
        if (exists) {
            if ((await readBoundedFile(join(anchor, name), receipt.length, true)).toString() !== receipt)
                throw new Error("TASK_INVENTORY_CHANGED");
            return;
        }
        const file = await open(join(anchor, name), "wx", 0o600);
        try {
            await file.writeFile(receipt);
            await file.sync();
        } finally {
            await file.close();
        }
        await root.sync();
    };
    await marker(markerName, rootNames.includes(markerName));
    if (finished) await marker(doneName, true);
    else if (!rootNames.includes(markerName)) {
        if (previouslyCleaned) return false;
        if ((await scan("truncate")).digest !== inventory.digest) return false;
    }
    const verified = await scan("verify");
    if (!verified.safe || verified.digest !== inventory.digest) return false;
    if (!finished) await marker(doneName, false);
    return true;
}
