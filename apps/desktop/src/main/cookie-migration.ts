/** 旧 Cookie 文件必须在持久 Session 打开前经用户明确确认退役，避免仅启用 fuse 后把未重写的 SQLite 明文历史当作已加密；非秘密重置日志保留中断恢复事实，删除仅限本应用分区的两个已知布局及四个固定成员。 */
import { constants } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { readPrivate, updatePrivate } from "../../../runtime/src/offline/config.ts";

const names = ["Cookies", "Cookies-wal", "Cookies-shm", "Cookies-journal"];
const limit = 64 * 1024 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Linux 逐级打开并持有真实父目录描述符，文件只作同句柄类型、拥有者、权限和大小检查而不读取 Cookie 内容；Windows 交给同等固定用途原生操作，真正不存在才返回 false，符号链接、公开对象与未知失败都不能被略过。 */
async function member(directory: string, name: string, retire: boolean): Promise<boolean> {
    if (!names.includes(name)) throw new Error("COOKIE_MEMBER_INVALID");
    if (process.platform === "win32") {
        const { windowsNative } = await import("../../../runtime/src/native/windows.ts");
        return windowsNative().privateCookieFile(join(directory, name), retire);
    }
    if (process.platform !== "linux") throw new Error("COOKIE_PLATFORM_UNSUPPORTED");
    let parent: FileHandle | undefined;
    try {
        const absolute = resolve(directory);
        const root = parse(absolute).root;
        parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
        for (const part of absolute.slice(root.length).split("/").filter(Boolean)) {
            const next = await open(
                `/proc/self/fd/${parent.fd}/${part}`,
                constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            await parent.close();
            parent = next;
        }
        const directoryInfo = await parent.stat();
        if (directoryInfo.uid !== process.getuid!() || directoryInfo.mode & 0o077)
            throw new Error("COOKIE_STORAGE_NOT_PRIVATE");
        const path = `/proc/self/fd/${parent.fd}/${name}`;
        const file = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
            const info = await file.stat();
            if (
                !info.isFile() ||
                info.uid !== process.getuid!() ||
                info.mode & 0o077 ||
                info.size > limit
            )
                throw new Error("COOKIE_STORAGE_NOT_PRIVATE");
            if (retire) {
                await unlink(path);
                try {
                    await parent.sync();
                } catch {
                    throw new Error("COOKIE_RETIREMENT_UNCONFIRMED");
                }
            }
            return true;
        } finally {
            await file.close();
        }
    } catch (error) {
        if (missing(error)) return false;
        throw error;
    } finally {
        await parent?.close();
    }
}

/** 调用方已验证当前运行二进制 fuse 和 OS 提供者并持有 Electron 单实例所有权，才可准备该档案 Cookie 分区；旧状态需要明确同意重新登录，已记录的重置可继续完成，完成标记不声称介质擦除或跨任意降级版本的保护。 */
export async function prepareCookieStorage(
    profile: string,
    sessionData: string,
    confirmReset: () => Promise<boolean>,
): Promise<void> {
    let state: "active" | "resetting" | undefined;
    try {
        const value = await readPrivate<{ version: number; state: string }>(
            profile,
            "cookie-protection.json",
        );
        if (
            !value ||
            value.version !== 1 ||
            !["active", "resetting"].includes(value.state) ||
            Object.keys(value).length !== 2
        )
            throw new Error("COOKIE_MIGRATION_STATE_INVALID");
        state = value.state as "active" | "resetting";
    } catch (error) {
        if (!missing(error)) throw error;
    }
    if (state === "active") return;
    const partition = join(sessionData, "Partitions/veriq-host");
    const directories = [partition, join(partition, "Network")];
    let present = false;
    for (const directory of directories)
        for (const name of names) present = (await member(directory, name, false)) || present;
    if (present && state !== "resetting") {
        if (!(await confirmReset())) throw new Error("COOKIE_MIGRATION_REQUIRED");
        await updatePrivate(profile, "cookie-protection.json", () => ({
            version: 1,
            state: "resetting",
        }));
    }
    if (present)
        for (const directory of directories)
            for (const name of names) await member(directory, name, true);
    await updatePrivate(profile, "cookie-protection.json", () => ({ version: 1, state: "active" }));
}
