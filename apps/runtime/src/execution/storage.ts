/**
 * 本文件监控 Attempt 工作区磁盘与文件数：连同 Chromium 未完成暂存一并计入预算：超限即触发确定性停机（storage/INVALID_STORAGE_LIMIT）。
 */

import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
/**
 * 公开函数 monitorStorage 每百毫秒扫描 Attempt 根目录累计字节与文件数：超限时调用 stop 并停止后续探测。
 * 不跟随符号链接以免扫出树外。
 */
export function monitorStorage(root: string, maxBytes: number, stop: (reason: string) => Promise<void>): {
    close(): void;
} {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw new Error('INVALID_STORAGE_LIMIT');
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scan = async () => {
        let bytes = 0, files = 0;
        const visit = async (path: string): Promise<void> => {
            const info = await lstat(path);
            if (info.isSymbolicLink())
                return; // 不跟随树外符号链接，防止 Singleton 把扫描带到 Attempt 之外。
            if (++files > 10000)
                throw new Error('ATTEMPT_STORAGE_LIMIT');
            if (info.isFile())
                bytes += info.size;
            if (bytes > maxBytes)
                throw new Error('ATTEMPT_STORAGE_LIMIT');
            if (info.isDirectory())
                for (const entry of await readdir(path)) {
                    try {
                        await visit(join(path, entry));
                    }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                            throw error;
                    }
                }
        };
        try {
            await visit(root);
        }
        catch (error) {
            if (closed)
                return;
            closed = true;
            const reason = error instanceof Error && /^ATTEMPT_STORAGE_/.test(error.message) ? error.message : 'ATTEMPT_STORAGE_UNAVAILABLE';
            await stop(reason);
            return;
        }
        if (!closed)
            timer = setTimeout(() => void scan(), 100);
    };
    void scan();
    return { close() { closed = true; clearTimeout(timer); } };
}
