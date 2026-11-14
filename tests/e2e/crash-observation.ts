import { _electron } from "../../apps/desktop/tests/fixtures";
import { readFile, appendFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, basename } from "node:path";

type Desktop = Awaited<ReturnType<typeof _electron.launch>>;
const command = promisify(execFile);

/** 崩溃诊断只读取测试启动进程的身份和内核状态，旧 PID 消失或被复用均不再读取其详细信息；不发送信号、不调整 core 策略，也不把原始 proc 内容或命令行写入共享证据。 */
async function identity(pid: number) {
    try {
        const raw = await readFile(`/proc/${pid}/stat`, "utf8");
        const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
        return { pid, uid: (await stat(`/proc/${pid}`)).uid, start: fields[19], state: fields[0] };
    } catch (error) {
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
        throw error;
    }
}

/** 在原崩溃动作外安装不会处理异常的 monitor，并由驱动独立执行一次有界失败现场采集；十秒只是观测触发点，不解除原恢复等待、不增加业务预算，也不把截图存在当恢复成功。 */
export async function observeCrashFailure(electron: Desktop, evidence: string) {
    const cleanup = await electron.evaluateHandle(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0]!.webContents;
        let records = 0;
        const token = (value: unknown, max: number) =>
            typeof value === "string" && value.length <= max && /^[A-Za-z0-9_.<>-]+$/.test(value)
                ? value
                : "unknown";
        const monitor = (error: Error & { code?: unknown }, origin: string) => {
            if (records++ >= 4) return;
            const frames = (
                typeof error.stack === "string" ? error.stack.split("\n").slice(1, 9) : []
            ).map((line) => {
                const symbol = /^\s*at\s+(?:new\s+)?([A-Za-z0-9_.<>-]+)\s+\(/.exec(line)?.[1];
                const position = /:(\d{1,8}):(\d{1,8})\)?$/.exec(line);
                return {
                    symbol: token(symbol, 80),
                    line: position ? Number(position[1]) : null,
                    column: position ? Number(position[2]) : null,
                };
            });
            console.error(
                "Renderer exception monitor",
                JSON.stringify({
                    at: Date.now(),
                    name: token(error.name, 48),
                    code: token(error.code, 64),
                    origin: token(origin, 32),
                    frames,
                }),
            );
        };
        let goneRecords = 0;
        const gone = (_event: unknown, details: { reason: string; exitCode: number }) => {
            if (goneRecords++ >= 4) return;
            console.error(
                "Renderer first gone observation",
                JSON.stringify({
                    at: Date.now(),
                    reason: token(details.reason, 32),
                    exitCode: details.exitCode,
                }),
            );
        };
        const remove = () => {
            process.removeListener("uncaughtExceptionMonitor", monitor);
            contents.removeListener("render-process-gone", gone);
            contents.removeListener("did-finish-load", remove);
            contents.removeListener("destroyed", remove);
        };
        const defaultHandlerCount = process.listenerCount("uncaughtException");
        process.on("uncaughtExceptionMonitor", monitor);
        contents.prependListener("render-process-gone", gone);
        console.error(
            "Renderer exception monitor installed",
            JSON.stringify({
                defaultHandlerCount,
                afterInstallDefaultHandlerCount: process.listenerCount("uncaughtException"),
            }),
        );
        contents.once("did-finish-load", remove);
        contents.once("destroyed", remove);
        return remove;
    });
    const pids = await electron.evaluate(({ BrowserWindow }) => ({
        main: process.pid,
        renderer: BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId(),
    }));
    const owners = await Promise.all([identity(pids.main), identity(pids.renderer)]);
    if (owners.some((owner) => !owner || owner.uid !== process.getuid?.()))
        throw new Error("CRASH_OBSERVATION_OWNER_MISMATCH");
    const log = (record: unknown) =>
        appendFile(join(evidence, "crash-failure-observation.log"), JSON.stringify(record) + "\n");
    let pending: Promise<void> | undefined;
    const timer = setTimeout(() => {
        pending = (async () => {
            const processes = await Promise.all(
                owners.map(async (owner) => {
                    if (!owner) throw new Error("CRASH_OBSERVATION_OWNER_MISMATCH");
                    const current = await identity(owner.pid);
                    if (!current || current.uid !== owner.uid || current.start !== owner.start)
                        return { pid: owner.pid, sameIdentity: false };
                    const status = await readFile(`/proc/${owner.pid}/status`, "utf8").catch(
                        (error) => {
                            if (
                                ["ENOENT", "ESRCH"].includes(
                                    (error as NodeJS.ErrnoException).code ?? "",
                                )
                            )
                                return "";
                            throw error;
                        },
                    );
                    const after = await identity(owner.pid);
                    if (!after || after.uid !== owner.uid || after.start !== owner.start)
                        return { pid: owner.pid, sameIdentity: false };
                    return {
                        ...current,
                        sameIdentity: true,
                        coreDumping: status.match(/^CoreDumping:\s*(\d+)/m)?.[1] ?? null,
                        tracerPid: status.match(/^TracerPid:\s*(\d+)/m)?.[1] ?? null,
                    };
                }),
            );
            const pattern = (await readFile("/proc/sys/kernel/core_pattern", "utf8")).trim();
            const helper = pattern.startsWith("|")
                ? basename(pattern.slice(1).trim().split(/\s+/)[0] ?? "")
                : undefined;
            await log({
                at: Date.now(),
                processes,
                corePattern: pattern.startsWith("|") ? "pipe" : "file",
                helper: helper && /^[A-Za-z0-9_.-]{1,64}$/.test(helper) ? helper : "unknown",
            });
            // 私有显示器只包含本轮合成验收窗口；截图命令最多运行三秒且输出限制在一 MiB，失败只记稳定诊断状态，不改主测试的等待结果或关闭任何窗口。
            const image = await command(
                "import",
                ["-window", "root", "-resize", "1280x800>", "-depth", "8", "png:-"],
                { encoding: "buffer", maxBuffer: 1024 * 1024, timeout: 3000 },
            );
            await (
                await import("node:fs/promises")
            ).writeFile(join(evidence, "crash-failure-root.png"), image.stdout);
            await log({ screenshotBytes: image.stdout.length });
        })().catch(async () => {
            await log({ diagnosticFailed: true });
        });
    }, 10000);
    return async () => {
        clearTimeout(timer);
        if (pending) await pending;
        // 正常恢复、窗口销毁和测试 finally 都撤销本人 monitor；不安装普通 uncaughtException，因此 Electron 默认 errorBox 行为及 listenerCount 判断不变。
        const removal = cleanup.evaluate((remove) => remove()).finally(() => cleanup.dispose());
        // 若主线程正在默认 errorBox 内停顿，诊断自身不得无限等待；迟到 Promise 仍有拒绝处理，三秒只表示撤监听请求尚未确认，不能冒充 Agent、窗口或业务进程停止。
        void removal.catch(() => {});
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                removal,
                new Promise<never>((_resolve, reject) => {
                    deadline = setTimeout(
                        () => reject(new Error("CRASH_OBSERVATION_CLEANUP_PENDING")),
                        3000,
                    );
                }),
            ]);
        } catch (error) {
            await log({
                cleanup:
                    error instanceof Error && error.message === "CRASH_OBSERVATION_CLEANUP_PENDING"
                        ? "PENDING"
                        : "FAILED",
            });
            throw error;
        } finally {
            if (deadline) clearTimeout(deadline);
        }
    };
}
