import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
/** Detection-and-stop budget, including Chromium's unfinished staging files. */
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
                return; // Do not follow Chromium Singleton links outside this tree.
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
