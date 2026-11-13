/**
 * 本文件是离线宿主的受限私有配置访问缝：渲染进程不得获得路径、令牌或密钥：读写均施加字节与模式约束（config/UNSAFE_CONFIGURATION）。
 */

import { mkdir, lstat, chmod, open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { windowsNative } from "../native/windows.ts";
/**
 * 私有目录用于宿主持久配置而不是 renderer 文件操作，Windows 在创建时使用当前 SID 可继承保护 DACL 并拒绝祖先重解析；Linux 保留目录类型检查和 0700 权限收紧，不把两种权限模型互相替代。
 */
export async function privateDirectory(directory: string) {
    if (process.platform === "win32") {
        windowsNative().privatePath(directory, true);
        return;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const st = await lstat(directory);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("UNSAFE_CONFIGURATION");
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
    /** Windows 私有读取由实际原生文件句柄贯穿授权与读取，不能在验证 DACL 后再调用 Node 按路径重新打开；未受限的公开包读取保留既有库存校验流程，Linux 的描述符与权限合同也保持不变。 */
    if (restricted && process.platform === "win32")
        return windowsNative().readPrivateFile(path, limit);
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
            const { bytesRead } = await fd.read(result, offset, result.length - offset, offset);
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
export async function readPrivate<T>(directory: string, name: string): Promise<T> {
    if (process.platform === "win32")
        return JSON.parse(
            windowsNative()
                .readPrivateFile(join(directory, name), 1024 * 1024)
                .toString("utf8"),
        ) as T;
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077)
        throw new Error("UNSAFE_CONFIGURATION");
    return JSON.parse(
        (await readBoundedFile(join(directory, name), 1024 * 1024, true)).toString("utf8"),
    ) as T;
}
/**
 * 私有 JSON 更新在合作锁内读取上一代并只执行一次调用方回调，内容超限或回调失败不提交；Windows 使用原生句柄原子替换并保留提交不确定性，Linux 保持既有私有临时文件刷新与 rename 流程。
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
    const temporaryName = `.${randomUUID()}.tmp`;
    const tmp = join(directory, temporaryName);
    try {
        let old: T | undefined;
        try {
            old = await readPrivate<T>(directory, name);
        } catch (e) {
            if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
        }
        const value = JSON.stringify(update(old));
        if (Buffer.byteLength(value) > 1024 * 1024) throw new Error("CONFIGURATION_LIMIT");
        /** Windows 提交使用原生持有的父目录与临时文件句柄完成，刷新失败的不确定性直接返回调用方；回调只执行一次，后续 finally 仅释放合作锁，不按旧临时字符串删除可能已经更换的文件。 */
        if (process.platform === "win32") {
            windowsNative().replacePrivate(directory, name, temporaryName, value);
            return;
        }
        const fd = await open(tmp, "wx", 0o600);
        try {
            await fd.writeFile(value);
            await fd.sync();
        } finally {
            await fd.close();
        }
        await rename(tmp, join(directory, name));
    } finally {
        if (process.platform !== "win32") await unlink(tmp).catch(() => {});
        await release();
    }
}
