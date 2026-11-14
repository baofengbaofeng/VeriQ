import type { ChildProcess } from "node:child_process";

const exits = new WeakMap<
    ChildProcess,
    Promise<{ code: number | null; signal: NodeJS.Signals | null }>
>();

/** 在创建测试子进程的同一同步阶段登记 close 事件，保存真实退出及标准流关闭的共同边界；后续失败清理即使发生在进程已经退出之后也能等待同一事实，不以一次 SIGTERM 返回值推断数据库锁已经释放。 */
export function trackFixture<T extends ChildProcess>(child: T): T {
    let spawnError: Error | undefined;
    child.once("error", (error) => {
        spawnError = error;
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) =>
            child.once("close", (code, signal) =>
                spawnError ? reject(spawnError) : resolve({ code, signal }),
            ),
    );
    void closed.catch(() => {});
    exits.set(child, closed);
    return child;
}

/** 停止操作只针对测试直接创建并登记的子进程，SIGTERM 请求与真实 close 是两个不同阶段；等待失败必须给出诊断且保留所属进程，不强制解锁、不重启数据库夹具，也不扩大到无关系统进程。 */
export async function stopFixture(child: ChildProcess): Promise<void> {
    const closed = exits.get(child);
    if (!closed) throw new Error("UNTRACKED_FIXTURE");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            closed,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                `FIXTURE_STOP_TIMEOUT pid=${child.pid} code=${child.exitCode} signal=${child.signalCode}`,
                            ),
                        ),
                    15000,
                );
            }),
        ]);
        if (result.code !== 0 && result.signal !== "SIGTERM")
            throw new Error(`FIXTURE_EXIT_FAILED code=${result.code} signal=${result.signal}`);
        console.log(
            "Owned fixture exited and streams closed",
            child.pid,
            result.code,
            result.signal,
        );
    } finally {
        if (timer) clearTimeout(timer);
    }
}
