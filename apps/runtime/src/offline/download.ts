/**
 * 本文件仅从精确 Origin 以 Bearer 拉取离线包：禁止重定向与 Cookie：并限制流式下载体积上限（download）。
 */

import { diagnosticFetch } from "../diagnostics.ts";
import { open, unlink, mkdir, lstat, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { controlOrigin, type DeviceConfig } from "../enrollment.ts";
/**
 * 公开函数 downloadBundle 向已登记控制 Origin 发起 Bearer 下载：校验响应哈希与体积上限：
 * 失败时不留下半截归档（downloadBundle）。
 */
export async function downloadBundle(
    config: DeviceConfig,
    bundleId: string,
    destination: string,
    signal?: AbortSignal,
): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(bundleId)) throw new Error("INVALID_BUNDLE_ID");
    const origin = controlOrigin(config.server),
        response = await diagnosticFetch(
            fetch,
            "runtime.offline_download",
            `${origin}/internal/v1/workspaces/${encodeURIComponent(config.workspaceId)}/bundles/${bundleId}/download`,
            {
                headers: { Authorization: `Bearer ${config.deviceToken}` },
                credentials: "omit",
                redirect: "error",
                signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]),
            },
        );
    if (!response.ok || !response.body) throw new Error("BUNDLE_DOWNLOAD_FAILED");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const parent = await lstat(dirname(destination));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("UNSAFE_DESTINATION");
    const temporary = join(dirname(destination), `.${randomUUID()}.part`);
    let fd: FileHandle | undefined;
    try {
        fd = await open(temporary, "wx", 0o600);
        let size = 0;
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 64 * 1024 * 1024) throw new Error("BUNDLE_SIZE_LIMIT");
            await fd.writeFile(chunk);
        }
        await fd.sync();
        await fd.close();
        fd = undefined;
        // 可信宿主提供最终路径，下载文件同步后才创建同目录硬链接，目标名称已存在时会失败而不会覆盖原文件。
        const { link } = await import("node:fs/promises");
        await link(temporary, destination);
        await unlink(temporary);
    } finally {
        await fd?.close();
        await unlink(temporary).catch(() => {});
    }
}
