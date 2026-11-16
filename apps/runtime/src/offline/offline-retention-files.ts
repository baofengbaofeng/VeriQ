/** 保留期文件适配只接收已核验报告或包清单，Linux 以持有目录描述符锚定所有操作，Windows/Darwin 交给固定用途原生入口；所有文件先核同一实体的大小和流式摘要再退休，未知权限、链接、名称或关闭错误保持失败，不提供任
 * 意根目录 rm。 */
import { constants } from "node:fs";
import { open, opendir, lstat, rename, unlink, rmdir, type FileHandle } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { createHash } from "node:crypto";
import { safePath } from "./verify.ts";

/** 文件描述符只包含相对清单名、精确长度与 SHA256，宿主不将绝对目录或文件系统操作能力交给 renderer；证据单项最大三十二 MiB，缓存整份清单至多四千零九十八文件和一百二十八 MiB。 */
export interface RetentionFile {
    path: string;
    sizeBytes: number;
    sha256: string;
}
const MAX_FILE = 32 * 1024 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Linux 私有根从卷根逐级拒绝符号链接并保留最终原始目录 fd，后续通过 proc 引用操作这个对象；最终七百模式、当前 uid 与目录类型不能由 chmod 修复，缓存只读子树必须另经隔离授权才允许改变权限。 */
async function parent(directory: string): Promise<FileHandle> {
    directory = resolve(directory);
    let handle = await open(parse(directory).root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
        for (const part of directory
            .slice(parse(directory).root.length)
            .split("/")
            .filter(Boolean)) {
            const child = await open(
                `/proc/self/fd/${handle.fd}/${part}`,
                constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            await handle.close();
            handle = child;
        }
        const info = await handle.stat();
        if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o7777) !== 0o700)
            throw new Error("LOCAL_RETENTION_DIRECTORY_UNSAFE");
        return handle;
    } catch (error) {
        await handle.close();
        throw error;
    }
}
const pathAt = (directory: FileHandle, name: string) => `/proc/self/fd/${directory.fd}/${name}`;

/** 描述符限额与严格路径语法在接触文件系统前检查，成员不能携带根、父目录、反斜杠或深层路径；清单累计额度独立检查，不因为每项合法就允许无限总字节、重复别名或无限递归深度。 */
function checked(files: RetentionFile[]): void {
    if (files.length > 4098) throw new Error("LOCAL_RETENTION_INVENTORY_LIMIT");
    let bytes = 0;
    const names = new Set<string>();
    for (const file of files) {
        if (
            !safePath(file.path) ||
            file.path.split("/").length > 16 ||
            names.has(file.path.toLowerCase()) ||
            !Number.isSafeInteger(file.sizeBytes) ||
            file.sizeBytes < 0 ||
            file.sizeBytes > MAX_FILE ||
            !/^[0-9a-f]{64}$/.test(file.sha256)
        )
            throw new Error("LOCAL_RETENTION_INVENTORY_INVALID");
        names.add(file.path.toLowerCase());
        bytes += file.sizeBytes;
    }
    if (bytes > 128 * 1024 * 1024) throw new Error("LOCAL_RETENTION_INVENTORY_LIMIT");
}

/** 同一普通单链接文件在流式摘要前后都检查 inode、时间、模式与长度，再核父目录当前同名 inode 后 unlink；已退休成员的真实 ENOENT 可供重做，任何其他错误都保留失败，必要目录刷新或文件关闭也不能被当作清理成
 * 功吞掉。 */
async function retireFile(
    directory: FileHandle,
    name: string,
    expected: RetentionFile,
    isolated: boolean,
): Promise<void> {
    let file: FileHandle;
    try {
        file = await open(
            pathAt(directory, name),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
    } catch (error) {
        if (missing(error)) return;
        throw error;
    }
    try {
        const before = await file.stat();
        if (
            !before.isFile() ||
            before.uid !== process.getuid!() ||
            before.nlink !== 1 ||
            before.size !== expected.sizeBytes ||
            !((before.mode & 0o7777) === 0o600 || (isolated && (before.mode & 0o7777) === 0o400))
        )
            throw new Error("LOCAL_RETENTION_FILE_UNSAFE");
        const digest = createHash("sha256"),
            buffer = Buffer.alloc(65536);
        let offset = 0;
        while (offset < before.size) {
            const { bytesRead } = await file.read(
                buffer,
                0,
                Math.min(buffer.length, before.size - offset),
                offset,
            );
            if (!bytesRead) throw new Error("LOCAL_RETENTION_FILE_CHANGED");
            digest.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
        }
        const tail = await file.read(buffer, 0, 1, before.size),
            after = await file.stat(),
            named = await lstat(pathAt(directory, name));
        if (
            tail.bytesRead ||
            digest.digest("hex") !== expected.sha256 ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs ||
            before.mode !== after.mode ||
            before.uid !== after.uid ||
            after.nlink !== 1 ||
            named.dev !== before.dev ||
            named.ino !== before.ino ||
            named.isSymbolicLink()
        )
            throw new Error("LOCAL_RETENTION_FILE_CHANGED");
        await unlink(pathAt(directory, name));
        await directory.sync();
    } finally {
        await file.close();
    }
}

/** 原始证据退休仅由可信报告描述符选择一段文件名，并固定在本档案 offline/work/Attempt/evidence 下；每个平台实际核验摘要与大小，不递归工作目录、不删除凭据、不跟随链接，也不从文件 mtime 推导保留
 * 年龄。 */
export async function retireEvidence(
    profile: string,
    attemptId: string,
    file: RetentionFile,
    metadata = false,
): Promise<void> {
    checked([file]);
    if (!/^[0-9a-f-]{36}$/i.test(attemptId) || !/^[-a-zA-Z0-9_.]{1,240}$/.test(file.path))
        throw new Error("LOCAL_RETENTION_INVENTORY_INVALID");
    if (metadata && file.path !== "report-display.json")
        throw new Error("LOCAL_RETENTION_INVENTORY_INVALID");
    const directory = join(
            profile,
            "offline",
            "work",
            attemptId,
            metadata ? "metadata" : "evidence",
        ),
        path = join(directory, file.path);
    try {
        if (process.platform === "win32") {
            (await import("../native/windows.ts"))
                .windowsNative()
                .retirePrivateEvidence(path, file);
            return;
        }
        if (process.platform === "darwin") {
            (await import("../native/darwin.ts")).darwinNative().retirePrivateEvidence(path, file);
            return;
        }
        if (process.platform !== "linux") throw new Error("LOCAL_RETENTION_PLATFORM_UNSUPPORTED");
        const held = await parent(directory);
        try {
            await retireFile(held, file.path, file, false);
        } finally {
            await held.close();
        }
    } catch (error) {
        if (!missing(error)) throw error;
    }
}

/** 缓存删除只接受 profile/bundles 下已核验 UUID 的完整有限清单，先隔离到对应退休名称再改变只读目录；任何未知成员导致保留现场，重启使用已经提交的清单重做缺失成员，绝不按 renderer 路径或任意目录递归
 * 清空。 */
export async function retireInventory(
    profile: string,
    bundleId: string,
    files: RetentionFile[],
): Promise<void> {
    checked(files);
    if (!/^[0-9a-f-]{36}$/.test(bundleId)) throw new Error("LOCAL_RETENTION_INVENTORY_INVALID");
    const directory = join(profile, "bundles"),
        retiring = `.veriq-retiring-${bundleId}`;
    if (process.platform === "win32") {
        (await import("../native/windows.ts"))
            .windowsNative()
            .retirePrivateInventory(directory, bundleId, retiring, files);
        return;
    }
    if (process.platform === "darwin") {
        (await import("../native/darwin.ts"))
            .darwinNative()
            .retirePrivateInventory(directory, bundleId, retiring, files);
        return;
    }
    if (process.platform !== "linux") throw new Error("LOCAL_RETENTION_PLATFORM_UNSUPPORTED");
    const held = await parent(directory);
    let tree: FileHandle | undefined;
    try {
        const original = await lstat(pathAt(held, bundleId)).catch((error) => {
            if (!missing(error)) throw error;
        });
        const old = await lstat(pathAt(held, retiring)).catch((error) => {
            if (!missing(error)) throw error;
        });
        if (original && old) throw new Error("LOCAL_RETENTION_NAMESPACE_CONFLICT");
        if (!original && !old) return;
        const name = original ? bundleId : retiring;
        tree = await open(
            pathAt(held, name),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        const owned = await tree.stat(),
            observed = original ?? old!;
        if (
            owned.uid !== process.getuid!() ||
            !owned.isDirectory() ||
            owned.ino !== observed.ino ||
            owned.dev !== observed.dev ||
            ![0o500, 0o700].includes(owned.mode & 0o7777)
        )
            throw new Error("LOCAL_RETENTION_DIRECTORY_UNSAFE");
        if (original) {
            await rename(pathAt(held, bundleId), pathAt(held, retiring));
            await held.sync();
        }
        const isolated = await lstat(pathAt(held, retiring));
        if (isolated.dev !== owned.dev || isolated.ino !== owned.ino)
            throw new Error("LOCAL_RETENTION_DIRECTORY_CHANGED");
        const inventory = new Map(files.map((file) => [file.path, file])),
            directories = new Set<string>();
        for (const file of files) {
            const parts = file.path.split("/");
            for (let index = 1; index < parts.length; index++)
                directories.add(parts.slice(0, index).join("/"));
        }
        let count = 0;
        const walk = async (
            current: FileHandle,
            relative: string,
            remove: boolean,
        ): Promise<void> => {
            const info = await current.stat();
            if (
                info.uid !== process.getuid!() ||
                !info.isDirectory() ||
                ![0o500, 0o700].includes(info.mode & 0o7777)
            )
                throw new Error("LOCAL_RETENTION_DIRECTORY_UNSAFE");
            if (remove) await current.chmod(0o700);
            const cursor = await opendir(`/proc/self/fd/${current.fd}`),
                names: string[] = [];
            try {
                for (;;) {
                    const entry = await cursor.read();
                    if (!entry) break;
                    if (++count > 8192 || !safePath(entry.name))
                        throw new Error("LOCAL_RETENTION_UNKNOWN_MEMBER");
                    names.push(entry.name);
                }
            } finally {
                await cursor.close();
            }
            for (const name of names) {
                const path = relative ? `${relative}/${name}` : name,
                    item = await lstat(pathAt(current, name));
                if (item.isDirectory() && directories.has(path)) {
                    const child = await open(
                        pathAt(current, name),
                        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
                    );
                    try {
                        const childInfo = await child.stat();
                        if (childInfo.dev !== item.dev || childInfo.ino !== item.ino)
                            throw new Error("LOCAL_RETENTION_DIRECTORY_CHANGED");
                        await walk(child, path, remove);
                        if (remove) {
                            const actual = await lstat(pathAt(current, name));
                            if (actual.dev !== childInfo.dev || actual.ino !== childInfo.ino)
                                throw new Error("LOCAL_RETENTION_DIRECTORY_CHANGED");
                            await rmdir(pathAt(current, name));
                            await current.sync();
                        }
                    } finally {
                        await child.close();
                    }
                } else {
                    const expected = inventory.get(path);
                    if (
                        !expected ||
                        !item.isFile() ||
                        item.isSymbolicLink() ||
                        item.uid !== process.getuid!() ||
                        item.nlink !== 1 ||
                        item.size !== expected.sizeBytes ||
                        ![0o400, 0o600].includes(item.mode & 0o7777)
                    )
                        throw new Error("LOCAL_RETENTION_UNKNOWN_MEMBER");
                    if (remove) await retireFile(current, name, expected, true);
                }
            }
        };
        await walk(tree, "", false);
        count = 0;
        await walk(tree, "", true);
        const actual = await lstat(pathAt(held, retiring));
        if (actual.dev !== owned.dev || actual.ino !== owned.ino)
            throw new Error("LOCAL_RETENTION_DIRECTORY_CHANGED");
        await rmdir(pathAt(held, retiring));
        await held.sync();
    } finally {
        try {
            await tree?.close();
        } finally {
            await held.close();
        }
    }
}
