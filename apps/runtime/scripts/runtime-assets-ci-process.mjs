import { spawn } from "node:child_process";

/**
 * 仅管理一个直接启动的 CLI 及本进程持有的两个管道，保留原始字节并有限等待真正 close；返回的关闭事实不证明 producer 事务
 * 清理，不授权扫描未知 scratch，也不代表任意后代已被内核清空。
 */
export function runBoundedAssetCli({ executable, args, cwd, timeoutMs }) {
    if (
        typeof executable !== "string" ||
        !Array.isArray(args) ||
        !args.every((arg) => typeof arg === "string") ||
        typeof cwd !== "string" ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > 16 * 60000
    )
        throw new TypeError("Invalid bounded CLI invocation");
    return new Promise((resolve) => {
        const stdoutLimit = 65536,
            marker = Buffer.from("\nLOG_TRUNCATED: hash binds this truncated log only\n");
        const stderrLimit = 4 * 1024 ** 2 - marker.length;
        let child,
            timer,
            force,
            deadline,
            settled = false,
            stopping = false;
        let stdout = Buffer.alloc(0),
            stderr = Buffer.alloc(0),
            truncated = false,
            timedOut = false;
        let admitted = false,
            error = null;
        // spawn 事件才表示操作系统已接纳子进程，error 与 close 的先后不能把未准入或关闭未知改写成成功；唯一结算函数负责
        // 清除全部计时器，迟到事件只能被忽略而不能升级先前已返回的事实。
        const finish = (exit, signal, closeConfirmed) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(force);
            clearTimeout(deadline);
            if (!closeConfirmed) {
                child?.stdout?.destroy();
                child?.stderr?.destroy();
                child?.unref();
            }
            if (truncated) stderr = Buffer.concat([stderr, marker]);
            resolve({
                stdout,
                stderr,
                exit,
                signal,
                timedOut,
                truncated,
                closeConfirmed,
                admitted,
                pid: admitted ? child.pid : null,
                error,
            });
        };
        // 首次停止同时覆盖期限和 stdout 溢出，给予 producer 五秒处理首信号，再留一秒观察 SIGKILL 后的 close；六秒外层期
        // 限不随重复数据或错误重置，无法确认时保留未知而不是永久挂起 job。
        const stop = () => {
            if (stopping || settled) return;
            stopping = true;
            child.kill("SIGTERM");
            force = setTimeout(() => {
                if (!settled) child.kill("SIGKILL");
            }, 5000);
            deadline = setTimeout(() => finish(child.exitCode, child.signalCode, false), 6000);
        };
        try {
            child = spawn(executable, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
        } catch (cause) {
            error = typeof cause.code === "string" ? cause.code : "SPAWN_ERROR";
            finish(null, null, false);
            return;
        }
        child.once("spawn", () => {
            admitted = true;
        });
        child.once("error", (cause) => {
            error ??= typeof cause.code === "string" ? cause.code : "SPAWN_ERROR";
            // 失败的准入通常随后仍发 close，因此不在 error 事件直接结算；若事件缺失则同样受固定外层期限限制，且已接纳进
            // 程的 error 从来不能充当关闭确认或事务清理证据。
            if (admitted) stop();
            else {
                clearTimeout(timer);
                deadline ??= setTimeout(
                    () => finish(child.exitCode, child.signalCode, false),
                    6000,
                );
            }
        });
        child.once("close", (exit, signal) => finish(exit, signal, true));
        child.stdout.on("data", (bytes) => {
            if (settled) return;
            const remaining = stdoutLimit - stdout.length;
            if (remaining > 0) stdout = Buffer.concat([stdout, bytes.subarray(0, remaining)]);
            if (bytes.length > remaining) {
                truncated = true;
                stop();
            }
        });
        child.stderr.on("data", (bytes) => {
            if (settled) return;
            const remaining = stderrLimit - stderr.length;
            if (remaining > 0) stderr = Buffer.concat([stderr, bytes.subarray(0, remaining)]);
            if (bytes.length > remaining) truncated = true;
        });
        timer = setTimeout(() => {
            timedOut = true;
            stop();
        }, timeoutMs);
    });
}
