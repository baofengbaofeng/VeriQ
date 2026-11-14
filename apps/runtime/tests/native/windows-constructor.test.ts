/** 显式线程构造故障分别检查实际首实例管道释放和 TSFN 对事件循环的引用释放，避免一个失败掩盖另一个资源事实；测试只启动独立自有 Agent 角色进程，故障注入不是自然 Windows 资源耗尽或正式构建行为。 */
import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "win32", "Native constructor fault tests require Windows");
const fault = fileURLToPath(
    new URL("../../build/native-tests/veriq_constructor_fault.node", import.meta.url),
);
const product = fileURLToPath(new URL("../../build/Release/veriq_native.node", import.meta.url));

/** 两个独立场景都要求捕获精确注入标记并自然退出，首实例场景还必须在没有强制 GC 的情况下立即重新绑定同一端点；execFile 的既有五秒保护只清理该自有子进程，发生超时或强制结束仍是测试失败。 */
for (const scenario of [
    { name: "Windows failed pipe constructor releases its first instance before GC", rebind: true },
    {
        name: "Windows failed pipe constructor releases its TSFN and permits normal host exit",
        rebind: false,
    },
]) {
    test(scenario.name, async (context) => {
        const root = await mkdtemp(join(tmpdir(), "veriq constructor 中文 "));
        const role = join(root, "veriq_agent.exe");
        const path = "\\\\.\\pipe\\veriq-constructor-" + randomUUID();
        const failures: unknown[] = [];
        let child: ChildProcess | undefined;
        let closed = false;
        try {
            await copyFile(process.execPath, role);
            const script = `const assert=require('node:assert/strict');const fault=require(${JSON.stringify(fault)});try{new fault.PrivatePipeServer(${JSON.stringify(path)},()=>{});throw new Error('FAULT_NOT_REACHED');}catch(error){assert.match(error.message,/^NATIVE_TEST_THREAD_CREATION_FAILURE/);console.log('THREAD_CONSTRUCTION_FAULT_OBSERVED');}${scenario.rebind ? `const product=require(${JSON.stringify(product)});const server=new product.PrivatePipeServer(${JSON.stringify(path)},()=>{});server.close();console.log('ENDPOINT_REBOUND_AND_CLOSED');` : ""}console.log('SCRIPT_COMPLETED');`;
            const operation = promisify(execFile)(role, ["-e", script], {
                cwd: root,
                env: { SystemRoot: process.env.SystemRoot! },
                timeout: 5000,
                maxBuffer: 65536,
                windowsHide: true,
            });
            child = operation.child;
            child.once("close", (code, signal) => {
                closed = true;
                context.diagnostic(`Constructor host closed: ${JSON.stringify({ code, signal })}`);
            });
            const { stdout, stderr } = await operation;
            assert.equal(stderr, "");
            assert.deepEqual(
                stdout.trim().split(/\r?\n/),
                scenario.rebind
                    ? [
                          "THREAD_CONSTRUCTION_FAULT_OBSERVED",
                          "ENDPOINT_REBOUND_AND_CLOSED",
                          "SCRIPT_COMPLETED",
                      ]
                    : ["THREAD_CONSTRUCTION_FAULT_OBSERVED", "SCRIPT_COMPLETED"],
            );
            assert.equal(child.exitCode, 0);
            assert.equal(child.signalCode, null);
        } catch (error) {
            const observed = error as Error & {
                code?: unknown;
                signal?: unknown;
                killed?: boolean;
                stdout?: string;
                stderr?: string;
            };
            context.diagnostic(
                `Constructor fault result: ${JSON.stringify({ code: observed.code, signal: observed.signal, killed: observed.killed, stdout: observed.stdout, stderr: observed.stderr })}`,
            );
            failures.push(error);
        } finally {
            if (child?.pid && !closed) failures.push(new Error("CONSTRUCTOR_HOST_EXIT_UNPROVED"));
            if (failures.length) context.diagnostic(`Constructor fault evidence retained: ${root}`);
            else {
                try {
                    /** 已独立证明自有宿主自然退出并通过全部资源断言后，文件系统仍可能短暂拒绝删除角色映像；仅用 Node 文档化的有限清理重试处理 EBUSY 等删除状态，不延长产品关闭预算或把重试当作进程退出证据。 */
                    await rm(root, {
                        recursive: true,
                        force: true,
                        maxRetries: 3,
                        retryDelay: 100,
                    });
                } catch (error) {
                    failures.push(error);
                    context.diagnostic(`Constructor profile removal failed: ${root}`);
                }
            }
        }
        if (failures.length)
            throw new AggregateError(failures, "Windows constructor resource lifetime failed", {
                cause: failures[0],
            });
    });
}
