/**
 * 用例发布浏览器测试的正文和清理必须分别结算，避免清理异常覆盖原始业务错误；本模块仅处理测试恢复目录及有限停止摘要，不
 * 启动、终止或模拟任何 Runtime 进程。
 */
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * JavaScript 允许直接抛出 undefined，因此错误存在性由独立布尔字段表达；正文和清理都失败时保留两项原始对象及主因，单项
 * 失败则原样抛出，绝不在 finally 中改变控制流。
 */
export async function withCleanup(body: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
    let bodyFailed = false;
    let bodyError: unknown;
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
        await body();
    } catch (error) {
        bodyFailed = true;
        bodyError = error;
    }
    // 清理必须执行一次，即使正文抛出了非 Error 值；不通过 truthy 判断或重新构造 Error 对象判断主因，这样调用方仍能区分
    // 原始断言失败与停止结算失败。
    try {
        await cleanup();
    } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
    }
    if (bodyFailed && cleanupFailed)
        throw new AggregateError([bodyError, cleanupError], "Test body and profile cleanup failed", {
            cause: bodyError,
        });
    if (bodyFailed) throw bodyError;
    if (cleanupFailed) throw cleanupError;
}

/**
 * 私有恢复目录只能在每份已有进程日志均明确 STOPPED、有限摘要成功写入之后删除；目录确实不存在可视为没有日志，读取失败、
 * 格式异常、写入失败及未知停止状态都保留现场并失败关闭。
 */
export async function cleanupCaseProfile(profile: string, evidencePath: string): Promise<void> {
    let entries: string[];
    try {
        entries = await readdir(join(profile, "agent/processes"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        entries = [];
    }
    const stops: { attemptId: string; state: string; workerPid?: number; guardianPid?: number }[] = [];
    for (const name of entries.filter((entry) => entry.endsWith(".process.json"))) {
        const source = await readFile(join(profile, "agent/processes", name), "utf8");
        let journal: unknown;
        try {
            journal = JSON.parse(source);
        } catch {
            // JSON.parse 的默认错误可能引用原文，不能把恢复文件中的敏感字段写入测试日志；这里仅给出私有目录位置，原始文
            // 件留在该目录供获授权的操作者核对。
            throw new Error("Invalid Agent process journal; private profile retained at " + profile);
        }
        if (
            journal === null ||
            typeof journal !== "object" ||
            !("attemptId" in journal) ||
            typeof journal.attemptId !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(journal.attemptId) ||
            !("state" in journal) ||
            typeof journal.state !== "string" ||
            !["SPAWNING", "RUNNING", "STOPPED"].includes(journal.state)
        )
            throw new Error("Invalid Agent stop metadata; private profile retained at " + profile);
        // 白名单摘要只保留标识、有限状态和整数 PID，不复制 nonce、凭证、租约或业务日志；未知状态不能被解释为 STOPPED，
        // PID 缺失也不能被伪造为真实进程事实。
        stops.push({
            attemptId: journal.attemptId,
            state: journal.state,
            ...("pid" in journal && typeof journal.pid === "number" && Number.isSafeInteger(journal.pid)
                ? { workerPid: journal.pid }
                : {}),
            ...("guardianPid" in journal &&
            typeof journal.guardianPid === "number" &&
            Number.isSafeInteger(journal.guardianPid)
                ? { guardianPid: journal.guardianPid }
                : {}),
        });
    }
    await writeFile(evidencePath, JSON.stringify(stops, null, 2));
    if (!stops.every((stop) => stop.state === "STOPPED"))
        throw new Error("Agent stop is unconfirmed; private profile retained at " + profile);
    await rm(profile, { recursive: true, force: true });
}
