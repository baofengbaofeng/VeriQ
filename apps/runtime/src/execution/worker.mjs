/**
 * 本文件是 Attempt 业务工作进程入口，保持 START 闸门与既有 Linux、Windows 外部强监督；可选受信控制配置另外管理直接命令
 * 日志，但不开放 Darwin 入口或发布停止证明。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { extractCompiler } from "./archive.mjs";
import { createControlledCommandOwner } from "./controlled-command.mjs";
process.title = "veriq_runner";
const invocation = JSON.parse(await readFile(process.argv[2], "utf8"));
let owner;
let managementFailed = false;
let cancelled = false;
let disconnecting = false;
let active;
if (invocation.controlled !== undefined) {
    try {
        if (invocation.controlled.commandJournalFd !== 5 || invocation.controlled.cliJournalFd !== 4) throw new Error();
        owner = createControlledCommandOwner({ ...invocation.controlled, kind: invocation.kind });
    } catch {
        managementFailed = true;
    }
}

/**
 * 断连或未捕获异常必须先置粘滞管理故障，不能在普通 finally 路径补封存；原始子对象仍由 active 保留，
 * 外层最终退出也必须由父 Agent 另外实际观察。
 */
function failManagement() {
    managementFailed = true;
    owner?.fail();
    process.exitCode = 73;
}
if (invocation.controlled !== undefined) {
    process.on("disconnect", () => {
        if (!disconnecting) failManagement();
    });
    process.on("uncaughtExceptionMonitor", failManagement);
}

/**
 * START 与取消监听同时安装，使取消先于业务开始仍能关闭准入；只有完整本代绑定被所有者接受后才 ACK，错误代际不授权、
 * 不发信号，也不能改变业务取消状态。
 */
await new Promise((resolve) => {
    process.on("message", (message) => {
        if (message?.type === "START") resolve();
        if (message?.type === "CANCEL" && owner) {
            try {
                owner.requestStop(message.binding);
                cancelled = true;
                process.send?.({ type: "CANCEL_ACK", binding: invocation.controlled.commandBinding }, (error) => {
                    if (error) failManagement();
                });
            } catch {
                failManagement();
            }
        }
    });
    // 父 Agent 必须实际观察已经安装 START 与取消监听的同一个 outer 对象，才能持久登记后交还启动能力；
    // 此消息不表示任何命令已经退出，发送失败保持管理故障且不能由后续业务结果恢复。
    if (owner && !managementFailed)
        process.send?.(
            {
                type: "CONTROLLED_READY",
                binding: invocation.controlled.commandBinding,
                pid: process.pid,
            },
            (error) => {
                if (error) failManagement();
            },
        );
});

/**
 * 受控路径显式保留管理结果与实际退出两个等待器，超时或 error 只使管理失败而不能解除原对象等待；无实际 exit 的 spawn
 * error 保持挂起，交给后续 Agent 总期限隔离。
 */
async function command(role, args, timeout) {
    if (owner) {
        active = owner.start(role, {
            args,
            cwd: invocation.work,
            env: process.env,
            timeoutMs: timeout,
        });
        let result;
        try {
            result = await active.result;
        } catch {
            failManagement();
            await active.exited;
            throw new Error("CONTROLLED_COMMAND_MANAGEMENT_FAILED");
        }
        await active.exited;
        active = undefined;
        if (cancelled) throw new Error("WORKER_CANCELLED");
        if (role !== "cli" && (result.exitCode !== 0 || result.signal !== null))
            throw new Error("WORKER_COMMAND_FAILED");
        return result.exitCode;
    }
    return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
            cwd: invocation.work,
            env: process.env,
            stdio: "ignore",
        });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("WORKER_COMMAND_TIMEOUT"));
        }, timeout);
        child.once("error", () => {
            clearTimeout(timer);
            reject(new Error("WORKER_COMMAND_FAILED"));
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            if (code === 0 || (role === "cli" && code === 1)) resolve(code);
            else reject(new Error("WORKER_COMMAND_FAILED"));
        });
    });
}
let stage = "INSTALL_FAILED";
try {
    if (managementFailed) throw new Error("CONTROLLED_COMMAND_MANAGEMENT_FAILED");
    if (cancelled) throw new Error("WORKER_CANCELLED");
    await command(
        "npm",
        [
            invocation.npmCli,
            "ci",
            "--offline",
            "--ignore-scripts",
            "--audit=false",
            "--fund=false",
            "--update-notifier=false",
            "--cache",
            join(invocation.tmp, "npm-cache"),
        ],
        45000,
    );
    stage = "COMPILER_EXTRACTION_FAILED";
    await mkdir(join(invocation.work, "engine/compiler"), { recursive: true });
    // 编译归档已经在激活前与运维固定库存逐项匹配，此处只解压该受信成员且继续沿用原有编译桥与结果路径，
    // 不增加业务输入可选择的新加载器或执行文件入口。
    await extractCompiler(join(invocation.work, "engine/compiler.tgz"), join(invocation.work, "engine/compiler"));
    if (cancelled) throw new Error("WORKER_CANCELLED");
    stage = "COMPILER_PROCESS_FAILED";
    await command(
        "compiler",
        ["--import", pathToFileURL(invocation.tsx).href, join(invocation.work, "compile-entry.mjs")],
        45000,
    );
    const result = JSON.parse(await readFile(join(invocation.work, "worker-result.json"), "utf8"));
    if (result.kind === "READY") {
        if (invocation.kind === "TEST") {
            stage = "PLAYWRIGHT_PROCESS_FAILED";
            process.exitCode = await command(
                "cli",
                [
                    join(invocation.work, "node_modules/@playwright/test/cli.js"),
                    "test",
                    "--config",
                    join(invocation.work, "playwright.config.mjs"),
                ],
                240000,
            );
        } else {
            const { cleanupFixture } = await import(
                pathToFileURL(join(invocation.work, "node_modules/@veriq/runner-sdk/src/index.js"))
            );
            const { contact } = await import(pathToFileURL(join(invocation.work, "provider.mjs")));
            const subject = JSON.parse(await readFile(join(invocation.work, "subject.json"), "utf8"));
            await cleanupFixture({
                fixture: subject.fixture,
                context: {
                    execution: subject,
                    signal: AbortSignal.timeout(30000),
                    credentials: {
                        resolve: (reference) => contact({ type: "credential", reference }),
                    },
                },
            });
            await writeFile(
                join(invocation.work, "worker-result.json"),
                JSON.stringify({
                    kind: "CLEANUP",
                    businessOutcome: "PASSED",
                    cleanupStatus: "SUCCEEDED",
                }),
                { mode: 0o600 },
            );
        }
    }
} catch {
    if (managementFailed) {
        await writeFile(
            join(invocation.work, "worker-failure.json"),
            JSON.stringify({ failureCode: "CONTROLLED_COMMAND_MANAGEMENT_FAILED" }),
            { mode: 0o600 },
        );
        process.exitCode = 73;
    } else if (cancelled) {
        process.exitCode = 130;
    } else {
        await writeFile(join(invocation.work, "worker-failure.json"), JSON.stringify({ failureCode: stage }), {
            mode: 0o600,
        });
        // 第三方调用可能把凭据写入异常或原始输出，跨越 Worker 边界只保存这里选定的稳定英文阶段码，
        // 业务报告仍由原有结果文件承载，不复制异常消息或第三方日志。
        if (invocation.kind === "CLEANUP")
            await writeFile(
                join(invocation.work, "worker-result.json"),
                JSON.stringify({
                    kind: "CLEANUP",
                    businessOutcome: "ERROR",
                    cleanupStatus: "FAILED",
                }),
                { mode: 0o600 },
            );
        else process.exitCode = 1;
    }
} finally {
    if (owner && !managementFailed) {
        try {
            owner.seal();
        } catch {
            failManagement();
            await writeFile(
                join(invocation.work, "worker-failure.json"),
                JSON.stringify({ failureCode: "CONTROLLED_COMMAND_MANAGEMENT_FAILED" }),
                { mode: 0o600 },
            );
        }
    }
    disconnecting = true;
    if (process.connected) process.disconnect();
}
