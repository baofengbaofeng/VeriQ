import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessSupervisor } from "../../src/execution/processes.ts";
import { AttemptBroker } from "../../src/execution/broker.ts";
import { windowsNative } from "../../src/native/windows.ts";
import { expectedPipeResponse } from "../support/pipe-response.ts";
import { withWindowsOwnership } from "../support/windows-ownership.ts";

/** 本文件只由真实 Windows 原生验证任务执行，错误平台直接失败而不跳过；首轮在现有 Linux 专用实现上观察行为失败，随后同一用例必须通过实际 Job 与私有管道实现，不能用编译成功代替。 */
assert.equal(process.platform, "win32", "Native Windows acceptance requires Windows");
const addonPath = fileURLToPath(new URL("../../build/Release/veriq_native.node", import.meta.url));

/** 清理阶段只等待有限时间并保留原始断言与清理异常，超时并不代表底层资源已经释放；无法证明停止时必须留下该测试的私有目录，由目标任务日志记录位置而不能删除日志伪装排空成功。 */
async function boundedCleanup<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            Promise.resolve().then(operation),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("NATIVE_TEST_CLEANUP_TIMEOUT")), 5000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** 真实角色 Node 副本必须在 Job 分配完成后运行，并把 Unicode、空格和引号参数原样传给业务代码；停止回执只能在根进程与实际派生后代都退出后成功，不能仅依赖当前 PID 或进程标题。 */
test("Windows guardian contains renamed role Node and drains its detached descendant", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "veriq native 中文 "));
    const role = join(root, "角色 binaries", "veriq_runner.exe");
    const processes = new ProcessSupervisor(join(root, "processes"));
    const arguments_ = ["with spaces", 'quote"inside', "trailing\\", "汉字😀"];
    const previousToken = process.env.VERIQ_DEVICE_TOKEN;
    process.env.VERIQ_DEVICE_TOKEN = "synthetic-parent-secret-must-not-inherit";
    const failures: unknown[] = [];
    try {
        await mkdir(join(root, "角色 binaries"));
        await copyFile(process.execPath, role);
        const script = `const native=require(${JSON.stringify(addonPath)});const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(JSON.stringify({execPath:process.execPath,args:process.argv.slice(1),child:c.pid,sid:native.identity(process.pid).sid,secret:process.env.VERIQ_DEVICE_TOKEN??null}));setInterval(()=>{},1000);`;
        let owned!: Awaited<ReturnType<ProcessSupervisor["start"]>>;
        await assert.doesNotReject(async () => {
            owned = await processes.start("windows-tree", {
                executable: role,
                args: ["-e", script, ...arguments_],
                cwd: root,
                env: {
                    SystemRoot: process.env.SystemRoot!,
                    PATH: join(process.env.SystemRoot!, "System32"),
                },
            });
        }, "a supported Windows worker must start under native containment");
        assert(owned);
        const observed = JSON.parse(await owned.firstLine());
        assert.equal(observed.execPath, role);
        assert.deepEqual(observed.args, arguments_);
        assert.equal(observed.secret, null);
        assert.equal(observed.sid, windowsNative().sid);
        const journal = JSON.parse(
            await readFile(join(root, "processes/windows-tree.process.json"), "utf8"),
        );
        assert.equal(typeof journal.startTime, "string");
        assert.match(journal.startTime, /^[0-9]+$/);
        assert.equal(typeof journal.guardianStartTime, "string");
        const stopped = await processes.terminateAttempt("windows-tree", "NATIVE_TEST_FINISHED");
        assert.equal(stopped.processStopped, true);
        assert.equal(await processes.isRunning(owned.pid), false);
        assert.equal(await processes.isRunning(observed.child), false);
    } catch (error) {
        failures.push(error);
    } finally {
        if (previousToken === undefined) delete process.env.VERIQ_DEVICE_TOKEN;
        else process.env.VERIQ_DEVICE_TOKEN = previousToken;
        try {
            const receipt = await boundedCleanup(() =>
                processes.terminateAttempt("windows-tree", "NATIVE_TEST_FINALLY"),
            );
            assert.equal(receipt.processStopped, true, `Unproved cleanup: ${receipt.reason}`);
            await boundedCleanup(() => rm(root, { recursive: true, force: true }));
        } catch (error) {
            failures.push(error);
            context.diagnostic(`Native process cleanup unproved; preserve profile: ${root}`);
        }
    }
    if (failures.length) {
        throw new AggregateError(failures, "Windows lifecycle assertion or cleanup failed", {
            cause: failures[0],
        });
    }
});

/** 已启动业务持续处理磁盘挑战并返回新值，用真实工作进度证明错误 nonce 的拒绝不能关闭守护控制流；测试恢复原始日志后才请求合法排空，所有失败和未知清理均保留原始证据目录。 */
test("Windows denied stop preserves worker progress until authentic ownership is restored", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "veriq ownership 中文 "));
    const processes = new ProcessSupervisor(join(root, "processes"));
    const journalPath = join(root, "processes/ownership.process.json");
    const challengePath = join(root, "challenge.json");
    const progressPath = join(root, "progress.json");
    const failures: unknown[] = [];
    let authenticJournal: string | undefined;
    try {
        const role = join(root, "veriq_runner.exe");
        await copyFile(process.execPath, role);
        await writeFile(challengePath, "initial");
        const script = `const fs=require('node:fs');let sequence=0;setInterval(()=>{const challenge=fs.readFileSync(${JSON.stringify(challengePath)},'utf8');fs.writeFileSync(${JSON.stringify(progressPath)},JSON.stringify({challenge,sequence:++sequence}));},20);console.log('READY');`;
        const owned = await processes.start("ownership", {
            executable: role,
            args: ["-e", script],
            cwd: root,
            env: { SystemRoot: process.env.SystemRoot! },
        });
        assert.equal(await owned.firstLine(), "READY");
        authenticJournal = await readFile(journalPath, "utf8");
        const journal = JSON.parse(authenticJournal);
        await writeFile(journalPath, JSON.stringify({ ...journal, nonce: randomUUID() }));
        const denied = await processes.terminateAttempt("ownership", "DENIED_OWNERSHIP_TEST");
        assert.equal(denied.processStopped, false);
        assert.equal(denied.reason, "PROCESS_IDENTITY_UNKNOWN");
        const challenge = randomUUID();
        await writeFile(challengePath, challenge);
        let firstSequence: number | undefined;
        let lastSequence = 0;
        const deadline = performance.now() + 2000;
        while (performance.now() < deadline) {
            let progress: { challenge: string; sequence: number } | undefined;
            try {
                progress = JSON.parse(await readFile(progressPath, "utf8"));
            } catch (error) {
                if (
                    !(error instanceof SyntaxError) &&
                    (error as NodeJS.ErrnoException).code !== "ENOENT"
                )
                    throw error;
            }
            if (progress?.challenge === challenge) {
                firstSequence ??= progress.sequence;
                lastSequence = progress.sequence;
                if (lastSequence - firstSequence >= 25) break;
            }
            await delay(10);
        }
        context.diagnostic(
            `Denied-stop worker progress: ${JSON.stringify({ firstSequence, lastSequence })}`,
        );
        assert(
            firstSequence !== undefined && lastSequence - firstSequence >= 25,
            "denied ownership must preserve sustained fresh worker progress after the stop attempt",
        );
        assert.deepEqual(processes.active(), ["ownership"]);
        await writeFile(journalPath, authenticJournal);
        const stopped = await processes.terminateAttempt("ownership", "AUTHENTIC_OWNERSHIP_TEST");
        assert.equal(stopped.processStopped, true);
        assert.equal(await processes.isRunning(owned.pid), false);
        const proof = JSON.parse(
            await readFile(join(root, "processes/ownership.drained.json"), "utf8"),
        );
        assert.equal(proof.state, "DRAINED");
        assert.equal(proof.nonce, journal.nonce);
        assert.equal(proof.workerStartTime, journal.startTime);
        assert.equal(proof.guardianStartTime, journal.guardianStartTime);
    } catch (error) {
        failures.push(error);
    } finally {
        try {
            if (authenticJournal) await writeFile(journalPath, authenticJournal);
            const receipt = await boundedCleanup(() =>
                processes.terminateAttempt("ownership", "OWNERSHIP_TEST_FINALLY"),
            );
            assert.equal(receipt.processStopped, true, `Unproved cleanup: ${receipt.reason}`);
            await boundedCleanup(() => rm(root, { recursive: true, force: true }));
        } catch (error) {
            failures.push(error);
            context.diagnostic(`Native ownership cleanup unproved; preserve profile: ${root}`);
        }
    }
    if (failures.length) {
        throw new AggregateError(failures, "Windows ownership assertion or cleanup failed", {
            cause: failures[0],
        });
    }
});

/** 角色 Agent 在没有相邻 node.exe 的独立目录中实际装载同一个 Node-API 模块，验证 node-gyp 延迟加载钩子能解析重命名宿主导出；测试工具设置真实进程超时，结果不能由原始 Node 宿主代跑。 */
test("Windows Node-API loads under the isolated renamed Agent executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq agent 中文 "));
    try {
        const role = join(root, "veriq_agent.exe");
        await copyFile(process.execPath, role);
        const script = `const native=require(${JSON.stringify(addonPath)});console.log(JSON.stringify({path:process.execPath,sid:native.sid,identity:native.identity(process.pid)}));`;
        const { stdout } = await promisify(execFile)(role, ["-e", script], {
            cwd: root,
            timeout: 5000,
            env: { SystemRoot: process.env.SystemRoot! },
        });
        const observed = JSON.parse(stdout);
        assert.equal(observed.path, role);
        assert.equal(observed.sid, windowsNative().sid);
        assert.equal(observed.identity.running, true);
        assert.match(observed.identity.startTime, /^[0-9]+$/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/** 当前用户通过真实本机管道发送原始 UTF8 字节，只有正确 nonce 的有限请求可以到达业务处理器；接收测试不引入 TCP 替代通道，关闭时等待实际监听与连接资源释放后再清理私有目录。 */
test("Windows private broker serves a bounded Unicode request through a named pipe", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "veriq pipe 中文 "));
    const broker = new AttemptBroker(join(root, "attempt.sock"), async (message) => ({
        text: message.text,
    }));
    const failures: unknown[] = [];
    const clientEvents: Array<Record<string, string | number | boolean>> = [];
    const recordClient = (event: Record<string, string | number | boolean>) => {
        if (clientEvents.length === 64) clientEvents.shift();
        clientEvents.push(event);
    };
    try {
        await assert.doesNotReject(async () => {
            await broker.open();
        }, "a private Windows broker must open without POSIX socket chmod");
        assert.match(broker.path, /^\\\\\.\\pipe\\veriq-/);
        const expected = { ok: true, value: { text: "中文😀" } };
        const response = await expectedPipeResponse(
            broker.path,
            JSON.stringify({ nonce: broker.nonce, text: "中文😀" }) + "\n",
            expected,
            recordClient,
        );
        assert.deepEqual(response, { ok: true, value: { text: "中文😀" } });
        assert.deepEqual(
            JSON.parse(
                await windowsNative().request(
                    broker.path,
                    JSON.stringify({ nonce: "wrong", text: "rejected" }) + "\n",
                ),
            ),
            { ok: false, error: "ATTEMPT_IPC_FAILED" },
        );
        assert.deepEqual(
            JSON.parse(
                await windowsNative().request(
                    broker.path,
                    JSON.stringify({ nonce: broker.nonce, text: "原生客户端😀" }) + "\n",
                ),
            ),
            { ok: true, value: { text: "原生客户端😀" } },
        );
        assert.throws(
            () => new (windowsNative().PrivatePipeServer)(broker.path, () => {}),
            /NATIVE_PIPE_LISTEN_FAILED/,
        );
    } catch (error) {
        failures.push(error);
    } finally {
        try {
            await boundedCleanup(() => broker.close());
            await boundedCleanup(() => rm(root, { recursive: true, force: true }));
        } catch (error) {
            failures.push(error);
            context.diagnostic(`Native broker cleanup unproved; preserve profile: ${root}`);
        }
        try {
            context.diagnostic(`Raw pipe client events: ${JSON.stringify(clientEvents)}`);
            context.diagnostic(
                `Native pipe diagnostics: ${JSON.stringify(windowsNative().takePipeDiagnostics())}`,
            );
        } catch (error) {
            failures.push(error);
        }
    }
    if (failures.length) {
        throw new AggregateError(failures, "Windows broker assertion or cleanup failed", {
            cause: failures[0],
        });
    }
});

/** 原生测试服务在收到请求后不写任何响应就关闭私有管道，实际 Windows 客户端必须把帧前 EPIPE 保留为失败；此用例使用独立随机端点且不发送凭证，验证完整帧修正没有变成无条件忽略断开错误。 */
test("Windows raw client rejects a native forced disconnect before any response frame", async (context) => {
    let server: { close(): void } | undefined;
    try {
        const path = "\\\\.\\pipe\\veriq-framing-" + randomUUID();
        server = new (windowsNative().PrivatePipeServer)(path, () => server!.close());
        await assert.rejects(
            expectedPipeResponse(path, "{}\n", { ok: true }),
            (error: NodeJS.ErrnoException) => error.code === "EPIPE",
        );
    } finally {
        await boundedCleanup(async () => server?.close());
        context.diagnostic(
            `Preframe rejection native events: ${JSON.stringify(windowsNative().takePipeDiagnostics())}`,
        );
    }
});

/** 服务已经返回完整帧后关闭仍须释放真实管道实例，即使 JavaScript 保留旧服务器和回复函数也不能占用端点；新服务器必须重新取得首实例并成功响应，证明关闭完成不是仅设置内存标志或断开连接。 */
test("Windows private pipe close releases the endpoint while old callbacks remain reachable", async (context) => {
    const path = "\\\\.\\pipe\\veriq-rebind-" + randomUUID();
    const servers: Array<{ close(): void }> = [];
    const replies: Array<(frame: string) => void> = [];
    const failures: unknown[] = [];
    try {
        const first = new (windowsNative().PrivatePipeServer)(path, (_frame, reply) => {
            replies.push(reply);
            reply('{"generation":1}\n');
        });
        servers.push(first);
        assert.deepEqual(await expectedPipeResponse(path, "{}\n", { generation: 1 }), {
            generation: 1,
        });
        await boundedCleanup(async () => first.close());
        const second = new (windowsNative().PrivatePipeServer)(path, (_frame, reply) => {
            reply('{"generation":2}\n');
        });
        servers.push(second);
        replies[0]!('{"generation":0}\n');
        assert.deepEqual(await expectedPipeResponse(path, "{}\n", { generation: 2 }), {
            generation: 2,
        });
        assert.equal(replies.length, 1);
    } catch (error) {
        failures.push(error);
    } finally {
        for (const server of servers) {
            try {
                await boundedCleanup(async () => server.close());
            } catch (error) {
                failures.push(error);
            }
        }
        context.diagnostic(
            `Pipe rebind native events: ${JSON.stringify(windowsNative().takePipeDiagnostics())}`,
        );
    }
    if (failures.length) {
        throw new AggregateError(failures, "Windows pipe rebind assertion or cleanup failed", {
            cause: failures[0],
        });
    }
});

/** 日志中的守护 PID 指向已经真实退出且经原生查询证实未运行的测试进程时，负回执不能关闭实际活跃守护的控制流；内核可以保留已退出进程对象，业务持续进度与原始日志排空才是这里需要核验的事实。 */
test("Windows nonrunning journal guardian cannot close the actual live guardian", async (context) => {
    await withWindowsOwnership(context, ["exited-guardian"], async (scenario) => {
        const probe = promisify(execFile)(scenario.role, ["-e", ""], {
            timeout: 5000,
            env: { SystemRoot: process.env.SystemRoot! },
        });
        const exitedPid = probe.child.pid;
        await probe;
        assert(exitedPid);
        const observed = windowsNative().identity(exitedPid);
        context.diagnostic(
            `Exited guardian probe identity: ${JSON.stringify({ pid: exitedPid, observed })}`,
        );
        assert(
            observed === null || observed.running === false,
            "The replacement guardian must actually be nonrunning",
        );
        await scenario.replaceJournal("exited-guardian", { guardianPid: exitedPid });
        const denied = await scenario.processes.terminateAttempt(
            "exited-guardian",
            "NONRUNNING_GUARDIAN_TEST",
        );
        assert.equal(denied.processStopped, false);
        assert.equal(denied.reason, "CONTAINMENT_LOST");
        await scenario.requireProgress(["exited-guardian"]);
    });
});

/** 工作进程创建时间发生合法十进制篡改时，守护身份仍然真实也不足以授权停止该 Attempt；必须先核验完整拥有关系再发送信号，测试通过拒绝后的持续新进度验证业务没有被误停。 */
test("Windows changed worker creation time cannot authorize stopping its live job", async (context) => {
    await withWindowsOwnership(context, ["worker-time"], async (scenario) => {
        const original = scenario.journals.get("worker-time")!;
        assert.equal(typeof original.startTime, "string");
        await scenario.replaceJournal("worker-time", {
            startTime: (BigInt(original.startTime as string) + 1n).toString(),
        });
        const denied = await scenario.processes.terminateAttempt(
            "worker-time",
            "CHANGED_WORKER_TIME_TEST",
        );
        assert.equal(denied.processStopped, false);
        await scenario.requireProgress(["worker-time"]);
    });
});

/** 两个真实 Attempt 的 nonce 与守护身份不能交叉拼接成停止权限，来自第二个日志的有效 nonce 不得影响任一业务树；两个工作进程分别接受新挑战并独立报告进度，清理恢复各自精确原始日志。 */
test("Windows guardian identity and another attempt nonce cannot stop either job", async (context) => {
    await withWindowsOwnership(context, ["nonce-a", "nonce-b"], async (scenario) => {
        const first = scenario.journals.get("nonce-a")!;
        const second = scenario.journals.get("nonce-b")!;
        assert.notEqual(first.nonce, second.nonce);
        await scenario.replaceJournal("nonce-a", { nonce: second.nonce });
        const denied = await scenario.processes.terminateAttempt(
            "nonce-a",
            "CROSS_ATTEMPT_NONCE_TEST",
        );
        assert.equal(denied.processStopped, false);
        await scenario.requireProgress(["nonce-a", "nonce-b"]);
    });
});
