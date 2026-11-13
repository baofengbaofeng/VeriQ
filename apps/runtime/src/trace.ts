/**
 * 本文件把本机 Trace zip 复制进 mode-0600 临时目录：再用钉选 Playwright CLI 本机查看（trace）。
 * 禁止远程 URL。
 */

/** Local-only pinned Playwright viewer. A private copy restricts its file-serving root. */
import { spawn } from "node:child_process";
import { mkdtemp, stat, copyFile, chmod, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
/**
 * 公开函数 openTrace 校验本地 Trace 后复制到私有临时目录：启动钉选 Playwright 查看器并限制服务根（openTrace）。
 * 结束后强制删除临时副本。
 */
export async function openTrace(
    path: string,
    signal: AbortSignal,
    ready?: (url: string, pid: number) => void | Promise<void>,
): Promise<void> {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) throw new Error("LOCAL_TRACE_PATH_REQUIRED");
    const source = resolve(path),
        info = await stat(source);
    if (!info.isFile() || info.size > 32 * 1024 * 1024 || !info.size)
        throw new Error("INVALID_TRACE_FILE");
    const directory = await mkdtemp(join(tmpdir(), "veriq-trace-view-"));
    const copy = join(directory, "trace.zip");
    try {
        await copyFile(source, copy);
        await chmod(copy, 0o600);
        if ((await stat(copy)).size > 32 * 1024 * 1024) throw new Error("INVALID_TRACE_FILE");
        if (ready) {
            const require = createRequire(import.meta.url);
            const version = require("playwright-core/package.json").version;
            const api = require("playwright-core/lib/coreBundle").server;
            if (
                version !== "1.65.0" ||
                typeof api?.startTraceViewerServer !== "function" ||
                typeof api?.traceViewerPath !== "function"
            )
                throw new Error("TRACE_VIEWER_INTERFACE_MISMATCH");
            const server = await api.startTraceViewerServer({
                host: "127.0.0.1",
                port: 0,
                allowedFileRoots: () => [directory],
            });
            try {
                if (
                    !["stop", "rootUrl", "urlPrefix"].every(
                        (name) => typeof server[name] === "function",
                    )
                )
                    throw new Error("TRACE_VIEWER_INTERFACE_MISMATCH");
                const origin = new URL(server.rootUrl("precise"));
                const prefix = new URL(server.urlPrefix("precise"));
                if (
                    origin.hostname !== "127.0.0.1" ||
                    origin.protocol !== "http:" ||
                    !origin.port ||
                    prefix.origin !== origin.origin ||
                    !/^\/[0-9a-f]{32}$/.test(prefix.pathname)
                )
                    throw new Error("TRACE_VIEWER_INTERFACE_MISMATCH");
                const address =
                    server.urlPrefix("precise") +
                    api.traceViewerPath("file?path=" + encodeURIComponent(copy), {});
                signal.throwIfAborted();
                await ready(address, process.pid);
                if (!signal.aborted)
                    await new Promise<void>((resolve) =>
                        signal.addEventListener("abort", () => resolve(), { once: true }),
                    );
            } finally {
                await server.stop();
            }
            return;
        }
        const child = spawn(
            process.execPath,
            [
                createRequire(import.meta.url).resolve("@playwright/test/cli"),
                "show-trace",
                copy,
                "--host",
                "127.0.0.1",
                "--port",
                "0",
            ],
            { cwd: directory, stdio: "inherit", signal },
        );
        await new Promise<void>((resolve, reject) => {
            child.once("error", (error) => {
                if (!signal.aborted || !child.pid) reject(error);
            });
            child.once("exit", (code) =>
                code === 0 || signal.aborted ? resolve() : reject(new Error("TRACE_VIEWER_FAILED")),
            );
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
