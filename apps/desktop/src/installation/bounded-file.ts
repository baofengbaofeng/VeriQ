import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 安装描述与签名材料只允许有限普通文件，长度预算在实际同一描述符读取时执行而不是仅相信先前 lstat；读取前后核对物理身份与时间，观察到并发变化时拒绝，不把路径存在当成静止字节快照。不创建、不修权限、不跟随最终符号链接，
 * 读取不会触发设备文件或管道等待。realpath 检查原始路径没有链接别名，同 FD 检查仍防止最终文件替换造成身份混淆。一次最多分配六十四 KiB，超预算文件在合并 Buffer 之前失败。
 * 硬链接拒绝避免与包缓存或另一可写位置共享安装政策文件。所有异常向调用方传播，只有外层稳定错误映射可以决定如何呈现诊断。这些观察不是完整目录原子快照，真正来源信任仍由外部签名和审核提供。
 */
export async function readBoundedRegularFile(path: string, limit: number): Promise<Buffer> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024)
        throw new Error("DESKTOP_INPUT_LIMIT_INVALID");
    if ((await realpath(path)) !== resolve(path)) throw new Error("DESKTOP_INPUT_LINK_FORBIDDEN");
    const observed = await lstat(path);
    if (
        !observed.isFile() ||
        observed.isSymbolicLink() ||
        observed.nlink !== 1 ||
        observed.size > limit
    )
        throw new Error("DESKTOP_INPUT_FILE_INVALID");
    const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
        const before = await handle.stat();
        if (
            !before.isFile() ||
            before.nlink !== 1 ||
            before.size > limit ||
            before.dev !== observed.dev ||
            before.ino !== observed.ino
        )
            throw new Error("DESKTOP_INPUT_CHANGED");
        const parts: Buffer[] = [];
        let total = 0;
        for (;;) {
            const buffer = Buffer.alloc(Math.min(65536, limit - total + 1));
            const { bytesRead } = await handle.read(buffer);
            if (!bytesRead) break;
            total += bytesRead;
            if (total > limit) throw new Error("DESKTOP_INPUT_LIMIT");
            parts.push(buffer.subarray(0, bytesRead));
        }
        const after = await handle.stat();
        if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs ||
            total !== before.size
        )
            throw new Error("DESKTOP_INPUT_CHANGED");
        return Buffer.concat(parts, total);
    } finally {
        await handle.close();
    }
}
