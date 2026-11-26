import fs from "node:fs/promises";

/**
 * 准入失败只向本机状态交付两种固定原因，路径和系统错误留在宿主边界内，调用方据此选择复查或退出。
 */
export type StoragePauseReason = "RUNTIME_STORAGE_LOW" | "RUNTIME_STORAGE_UNAVAILABLE";

/**
 * 独立挂载的工作目录需要单独观察；只有明确不存在时才复用已核对的 Runtime 根卷，其他失败保留未知状态。
 */
async function workDirectory(path: string) {
    try {
        return await fs.lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
    }
}

/**
 * 领取前对实际写入父目录测量普通用户可用块数；这里只读目录元数据，观察结果不预留字节，也不授权回收。
 */
export async function storagePauseReason(
    root: string,
    work: string,
    temporary: string,
    minimumBytes: bigint,
): Promise<StoragePauseReason | undefined> {
    try {
        const currentWork = await workDirectory(work);
        if (currentWork && !currentWork.isDirectory()) return "RUNTIME_STORAGE_UNAVAILABLE";
        if (!(await fs.stat(root)).isDirectory() || !(await fs.stat(temporary)).isDirectory()) {
            return "RUNTIME_STORAGE_UNAVAILABLE";
        }

        let low = false;
        /**
         * 即使根卷已低于界限，仍核验其余卷；任何探测无法确认时优先报告容量未知，否则报告已经测得的空间不足。
         */
        for (const path of new Set(currentWork ? [root, work, temporary] : [root, temporary])) {
            const { blocks, bsize, bavail } = await fs.statfs(path, { bigint: true });
            if (
                typeof blocks !== "bigint" ||
                typeof bsize !== "bigint" ||
                typeof bavail !== "bigint" ||
                blocks <= 0n ||
                bsize <= 0n ||
                bavail < 0n ||
                bavail > blocks
            ) {
                return "RUNTIME_STORAGE_UNAVAILABLE";
            }
            if (bsize * bavail < minimumBytes) low = true;
        }
        return low ? "RUNTIME_STORAGE_LOW" : undefined;
    } catch {
        return "RUNTIME_STORAGE_UNAVAILABLE";
    }
}
