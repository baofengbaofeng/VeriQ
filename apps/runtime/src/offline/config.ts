/**
 * 本文件是离线宿主的受限私有配置访问缝：渲染进程不得获得路径、令牌或密钥：读写均施加字节与模式约束（config/UNSAFE_CONFIGURATION）。
 */

/** Restricted native config seam. Renderer never receives paths, tokens, or secrets. */
import { mkdir, lstat, chmod, open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
/**
 * 公开函数 privateDirectory 解析并创建 mode-0700 私有配置目录：供宿主侧持久化信任根与本机密钥。
 */
export async function privateDirectory(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const st = await lstat(directory);
    if (!st.isDirectory() || st.isSymbolicLink())
        throw new Error("UNSAFE_CONFIGURATION");
    await chmod(directory, 0o700);
}
/**
 * 公开函数 readBoundedFile 在字节上限内读取文件：超限或非常规文件立即失败：避免把巨型对象载入内存（readBoundedFile/UNSAFE_CONFIGURATION）。
 */
export async function readBoundedFile(
    path: string,
    limit: number,
    restricted = false,
): Promise<Buffer> {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > limit)
        throw new Error("UNSAFE_CONFIGURATION");
    const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const st = await fd.stat();
        if (
            !st.isFile() ||
            st.size > limit ||
            (restricted && process.platform !== "win32" && st.mode & 0o077)
        )
            throw new Error("UNSAFE_CONFIGURATION");
        const result = Buffer.alloc(st.size);
        let offset = 0;
        while (offset < result.length) {
            const { bytesRead } = await fd.read(
                result,
                offset,
                result.length - offset,
                offset,
            );
            if (!bytesRead) throw new Error("FILE_CHANGED");
            offset += bytesRead;
        }
        if ((await fd.stat()).size !== st.size) throw new Error("FILE_CHANGED");
        return result;
    } finally {
        await fd.close();
    }
}
/**
 * 公开函数 readPrivate 从私有目录读取命名 JSON 配置：供信任根与本机密钥等宿主状态使用（readPrivate/UNSAFE_CONFIGURATION）。
 */
export async function readPrivate<T>(
    directory: string,
    name: string,
): Promise<T> {
    const parent = await lstat(directory);
    if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        (process.platform !== "win32" && parent.mode & 0o077)
    )
        throw new Error("UNSAFE_CONFIGURATION");
    return JSON.parse(
        (await readBoundedFile(join(directory, name), 1024 * 1024, true)).toString(
            "utf8",
        ),
    ) as T;
}
/**
 * 公开函数 updatePrivate 原子更新私有 JSON 配置：经临时文件替换并保持 0600 权限：防止半写状态被渲染层读到。
 */
export async function updatePrivate<T>(
    directory: string,
    name: string,
    update: (old: T | undefined) => T,
): Promise<void> {
    await privateDirectory(directory);
    const release = await lockfile.lock(directory, {
        realpath: false,
        retries: 0,
    });
    const tmp = join(directory, `.${randomUUID()}.tmp`);
    try {
        let old: T | undefined;
        try {
            old = await readPrivate<T>(directory, name);
        } catch (e) {
            if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
        }
        const value = JSON.stringify(update(old));
        if (Buffer.byteLength(value) > 1024 * 1024)
            throw new Error("CONFIGURATION_LIMIT");
        const fd = await open(tmp, "wx", 0o600);
        try {
            await fd.writeFile(value);
            await fd.sync();
        } finally {
            await fd.close();
        }
        await rename(tmp, join(directory, name));
    } finally {
        await unlink(tmp).catch(() => {});
        await release();
    }
}
