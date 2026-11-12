/** Local-only pinned Playwright viewer. A private copy restricts its file-serving root. */
import { spawn } from "node:child_process";
import { mkdtemp, stat, copyFile, chmod, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
export async function openTrace(
  path: string,
  signal: AbortSignal,
): Promise<void> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path))
    throw new Error("LOCAL_TRACE_PATH_REQUIRED");
  const source = resolve(path),
    info = await stat(source);
  if (!info.isFile() || info.size > 32 * 1024 * 1024 || !info.size)
    throw new Error("INVALID_TRACE_FILE");
  const directory = await mkdtemp(join(tmpdir(), "veriq-trace-view-"));
  const copy = join(directory, "trace.zip");
  try {
    await copyFile(source, copy);
    await chmod(copy, 0o600);
    if ((await stat(copy)).size > 32 * 1024 * 1024)
      throw new Error("INVALID_TRACE_FILE");
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
      child.once("error", (error) =>
        signal.aborted ? resolve() : reject(error),
      );
      child.once("exit", (code) =>
        code === 0 || signal.aborted
          ? resolve()
          : reject(new Error("TRACE_VIEWER_FAILED")),
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
