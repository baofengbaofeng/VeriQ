/** 非读取客户端保留真正的 Node 文件描述符，使响应确实留在内核管道而没有 socket 预读；独立 Agent 的关闭测试通过私有事件控制取消发生于未来 I/O 之前，真实宿主退出与清理事实分别记录，不能把超时当成功。 */
import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { closeSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "win32", "Controlled response close requires Windows");
const require = createRequire(import.meta.url);
const schedule = require("../../build/native-tests/veriq_test_schedule.node") as {
    waitPhase(nonce: string, phase: "response-ready" | "close-missed"): Promise<void>;
    releaseResponse(nonce: string): void;
};
const scheduled = fileURLToPath(
    new URL("../../build/native-tests/veriq_response_scheduled.node", import.meta.url),
);
const product = require("../../build/Release/veriq_native.node") as Record<string, unknown>;

/** 测试父进程的期限不会被子进程同步 close 阻塞，计时器到期必须保留失败并进入实际句柄清理；关闭验证沿用三点五秒总预算，准备与 finally 使用既有五秒上限，不通过延迟或重试等待偶然窗口。 */
async function bounded<T>(operation: Promise<T>, timeout = 5000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("NATIVE_TEST_HOST_TIMEOUT")), timeout);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** 实际响应写入后才请求 JavaScript 同步关闭，内核证实同一会话线程取消未命中后放行下一次真实 I/O；客户端此时仍未读取或关闭，服务器必须自行在总期限内返回，而不能靠 finally 的 EOF 才满足首次断言。 */
test("Windows pipe close finishes when cancellation precedes response draining", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "veriq response 中文 "));
    const role = join(root, "veriq_agent.exe");
    const nonce = randomUUID();
    const path = "\\\\.\\pipe\\veriq-close-" + nonce;
    const failures: unknown[] = [];
    let fd: number | undefined;
    let child: ChildProcess | undefined;
    let completed: Promise<{ stdout: string; stderr: string }> | undefined;
    let closed = false;
    try {
        assert.equal(Object.hasOwn(product, "releaseResponse"), false);
        await copyFile(process.execPath, role);
        const script = `const assert=require('node:assert/strict');const native=require(${JSON.stringify(scheduled)});const server=new native.PrivatePipeServer(${JSON.stringify(path)},(frame,reply)=>{assert.equal(frame,'{}\\n');reply('{"ok":true}\\n');});let stopped=false;const stop=()=>{if(stopped)return;stopped=true;server.close();console.log('SERVER_CLOSED');process.stdin.destroy();};process.stdin.once('data',chunk=>{assert.equal(chunk.toString(),'STOP\\n');stop();});process.stdin.once('end',stop);console.log('SERVER_READY');`;
        const operation = promisify(execFile)(role, ["-e", script], {
            cwd: root,
            env: { SystemRoot: process.env.SystemRoot! },
            maxBuffer: 65536,
            windowsHide: true,
        });
        child = operation.child;
        completed = operation;
        void completed.catch(() => {});
        child.once("close", (code, signal) => {
            closed = true;
            context.diagnostic(`Response host closed: ${JSON.stringify({ code, signal })}`);
        });
        const ready = new Promise<void>((resolve, reject) => {
            let output = "";
            child!.stdout!.on("data", (chunk: Buffer) => {
                output += chunk.toString("utf8");
                if (output.includes("SERVER_READY\n") || output.includes("SERVER_READY\r\n"))
                    resolve();
            });
            void operation.then(
                () => reject(new Error("NATIVE_TEST_HOST_ENDED_BEFORE_READY")),
                reject,
            );
        });
        await bounded(ready);
        fd = openSync(path, "r+");
        assert.equal(writeSync(fd, "{}\n"), 3);
        await schedule.waitPhase(nonce, "response-ready");
        const started = performance.now();
        assert(child.stdin);
        child.stdin.write("STOP\n");
        await bounded(schedule.waitPhase(nonce, "close-missed"), 3500);
        context.diagnostic(
            "Same response thread returned actual CancelSynchronousIo ERROR_NOT_FOUND while the client retained all response bytes unread",
        );
        schedule.releaseResponse(nonce);
        const result = await bounded(operation, Math.max(1, 3500 - (performance.now() - started)));
        const elapsedMs = performance.now() - started;
        context.diagnostic(
            `First response close result: ${JSON.stringify({ elapsedMs, ...result })}`,
        );
        assert(elapsedMs < 3500, "Pipe close exceeded the existing total stop budget");
        assert.deepEqual(result.stdout.trim().split(/\r?\n/), ["SERVER_READY", "SERVER_CLOSED"]);
        assert.equal(result.stderr, "");
        assert.equal(child.exitCode, 0);
        assert.equal(child.signalCode, null);
    } catch (error) {
        failures.push(error);
        context.diagnostic(`First response close failed: ${String(error)}`);
    } finally {
        try {
            schedule.releaseResponse(nonce);
        } catch (error) {
            failures.push(error);
        }
        if (fd !== undefined) {
            try {
                closeSync(fd);
                fd = undefined;
                context.diagnostic("Owned nonreading client FD closed for actual cleanup EOF");
            } catch (error) {
                failures.push(error);
            }
        }
        try {
            child?.stdin?.end();
            if (completed) {
                const result = await bounded(completed);
                context.diagnostic(`Response cleanup result: ${JSON.stringify(result)}`);
                assert.equal(child?.exitCode, 0);
                assert.equal(child?.signalCode, null);
            }
            if (child?.pid) assert(closed, "RESPONSE_HOST_EXIT_UNPROVED");
        } catch (error) {
            failures.push(error);
        }
        if (failures.length) {
            context.diagnostic(`Response close evidence retained: ${root}`);
            if (!closed && child) {
                child.unref();
                child.stdin?.destroy();
                child.stdout?.destroy();
                child.stderr?.destroy();
            }
        } else {
            try {
                await rm(root, { recursive: true, force: true });
            } catch (error) {
                failures.push(error);
                context.diagnostic(`Response close removal failed: ${root}`);
            }
        }
    }
    if (failures.length)
        throw new AggregateError(failures, "Windows response close assertion or cleanup failed", {
            cause: failures[0],
        });
});
