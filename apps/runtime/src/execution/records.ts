/** 执行历史观察只允许固定目录内的有限私有 JSON 成员，Linux 逐级持有无符号链接目录并在同一文件描述符上检查拥有者与读取字节；Windows 沿用实际原生私有句柄规则，缺失、畸形和超限都不能冒充可信停止证明。 */
import { constants } from "node:fs";
import { open, opendir, type FileHandle } from "node:fs/promises";
import { join, parse, resolve } from "node:path";

/** 只读记录会话不创建或收紧已有目录，不删除历史与临时文件；每个成员必须经过固定字符约束，目录扫描和文件读取各有硬上限，调用方用 finally 关闭持有句柄以明确观察生命周期。 */
export class ProcessRecords {
    private constructor(
        private directory: string,
        private handle?: FileHandle,
    ) {}
    /** 打开只读记录目录时逐级拒绝 Linux 符号链接，最终目录必须属于当前用户且保持七百权限；Windows 使用同一原生当前 SID 政策，不因迁移需要而接受管理员拥有者或重新配置原有访问控制。 */
    static async open(directory: string): Promise<ProcessRecords | undefined> {
        directory = resolve(directory);
        let handle: FileHandle | undefined;
        try {
            if (process.platform === "win32") {
                const { windowsNative } = await import("../native/windows.ts");
                windowsNative().privatePath(directory, false);
                return new ProcessRecords(directory);
            }
            handle = await open(parse(directory).root, constants.O_RDONLY | constants.O_DIRECTORY);
            for (const part of directory
                .slice(parse(directory).root.length)
                .split("/")
                .filter(Boolean)) {
                const next = await open(
                    `/proc/self/fd/${handle.fd}/${part}`,
                    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
                );
                await handle.close();
                handle = next;
            }
            const info = await handle.stat();
            if (info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700)
                throw new Error("PROCESS_RECORD_DIRECTORY_NOT_PRIVATE");
            return new ProcessRecords(directory, handle);
        } catch (error) {
            await handle?.close();
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
        }
    }
    private path(name: string) {
        if (!/^[a-zA-Z0-9_-]{1,100}\.(?:json|process\.json|drained\.json)$/.test(name))
            throw new Error("PROCESS_RECORD_NAME_INVALID");
        return this.handle ? `/proc/self/fd/${this.handle.fd}/${name}` : join(this.directory, name);
    }
    /** 历史枚举至多返回约定数量的普通文件，额外成员、链接或子目录立即阻止观察；不排序后丢弃、不只挑选看似可识别的记录，避免孤立进程日志或未知残留被过滤成可安全迁移的空目录。 */
    async names(limit: number): Promise<string[]> {
        const directory = await opendir(
            this.handle ? `/proc/self/fd/${this.handle.fd}` : this.directory,
        );
        const names: string[] = [];
        try {
            for (;;) {
                const entry = await directory.read();
                if (!entry) return names;
                if (!entry.isFile() || names.length >= limit)
                    throw new Error("PROCESS_RECORD_LIMIT_OR_TYPE");
                this.path(entry.name);
                names.push(entry.name);
            }
        } finally {
            await directory.close();
        }
    }
    /** 私有记录读取固定上限内的严格 UTF8 JSON，Linux 不按检查前的文件路径重新打开或无限读取增长文件；权限、类型、拥有者与长度都在同一描述符核验，Windows 由既有原生有限接口执行同类约束。 */
    async read(name: string, limit: number): Promise<unknown> {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65536)
            throw new Error("PROCESS_RECORD_LIMIT_INVALID");
        let bytes: Buffer;
        if (process.platform === "win32") {
            const { windowsNative } = await import("../native/windows.ts");
            bytes = windowsNative().readPrivateFile(this.path(name), limit);
        } else {
            const handle = await open(
                this.path(name),
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
                const info = await handle.stat();
                if (
                    !info.isFile() ||
                    info.uid !== process.getuid!() ||
                    (info.mode & 0o777) !== 0o600 ||
                    info.size > limit
                )
                    throw new Error("PROCESS_RECORD_NOT_PRIVATE");
                bytes = Buffer.alloc(info.size);
                let offset = 0;
                while (offset < bytes.length) {
                    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
                    if (!result.bytesRead) throw new Error("PROCESS_RECORD_CHANGED");
                    offset += result.bytesRead;
                }
                if ((await handle.stat()).size !== info.size)
                    throw new Error("PROCESS_RECORD_CHANGED");
            } finally {
                await handle.close();
            }
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
    /** 结束会话只释放本次打开的目录描述符，不尝试清理历史或修复访问模式；观察失败后的再次执行必须重新读取实际文件，不能复用已经失效的目录身份或先前解析所得的停止结论。 */
    async close(): Promise<void> {
        await this.handle?.close();
    }
}
