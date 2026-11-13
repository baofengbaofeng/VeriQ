import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { ProcessSupervisor } from "../../src/execution/processes.ts";
import { AttemptBroker } from "../../src/execution/broker.ts";

/** 本文件只由真实 Windows 原生验证任务执行，错误平台直接失败而不跳过；首轮在现有 Linux 专用实现上观察行为失败，随后同一用例必须通过实际 Job 与私有管道实现，不能用编译成功代替。 */
assert.equal(process.platform, "win32", "Native Windows acceptance requires Windows");

/** 真实角色 Node 副本必须在 Job 分配完成后运行，并把 Unicode、空格和引号参数原样传给业务代码；停止回执只能在根进程与实际派生后代都退出后成功，不能仅依赖当前 PID 或进程标题。 */
test("Windows guardian contains renamed role Node and drains its detached descendant", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq native 中文 "));
    const role = join(root, "角色 binaries", "veriq_runner.exe");
    const processes = new ProcessSupervisor(join(root, "processes"));
    const arguments_ = ["with spaces", 'quote"inside', "trailing\\", "汉字😀"];
    const previousToken = process.env.VERIQ_DEVICE_TOKEN;
    process.env.VERIQ_DEVICE_TOKEN = "synthetic-parent-secret-must-not-inherit";
    let started = false;
    try {
        await mkdir(join(root, "角色 binaries"));
        await copyFile(process.execPath, role);
        const script =
            "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(JSON.stringify({execPath:process.execPath,args:process.argv.slice(1),child:c.pid,secret:process.env.VERIQ_DEVICE_TOKEN??null}));setInterval(()=>{},1000);";
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
            started = true;
        }, "a supported Windows worker must start under native containment");
        assert(owned);
        const observed = JSON.parse(await owned.firstLine());
        assert.equal(observed.execPath, role);
        assert.deepEqual(observed.args, arguments_);
        assert.equal(observed.secret, null);
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
    } finally {
        if (previousToken === undefined) delete process.env.VERIQ_DEVICE_TOKEN;
        else process.env.VERIQ_DEVICE_TOKEN = previousToken;
        if (started) await processes.terminateAttempt("windows-tree", "NATIVE_TEST_FINALLY");
        await rm(root, { recursive: true, force: true });
    }
});

/** 当前用户通过真实本机管道发送原始 UTF8 字节，只有正确 nonce 的有限请求可以到达业务处理器；接收测试不引入 TCP 替代通道，关闭时等待实际监听与连接资源释放后再清理私有目录。 */
test("Windows private broker serves a bounded Unicode request through a named pipe", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq pipe 中文 "));
    const broker = new AttemptBroker(join(root, "attempt.sock"), async (message) => ({
        text: message.text,
    }));
    let opened = false;
    try {
        await assert.doesNotReject(async () => {
            await broker.open();
            opened = true;
        }, "a private Windows broker must open without POSIX socket chmod");
        assert.match(broker.path, /^\\\\\.\\pipe\\veriq-/);
        const response = await new Promise<string>((resolve, reject) => {
            const socket = connect(broker.path);
            const chunks: Buffer[] = [];
            socket.on("connect", () =>
                socket.end(JSON.stringify({ nonce: broker.nonce, text: "中文😀" }) + "\n"),
            );
            socket.on("data", (chunk) => chunks.push(chunk));
            socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            socket.on("error", reject);
            socket.setTimeout(5000, () => socket.destroy(new Error("TEST_PIPE_TIMEOUT")));
        });
        assert.deepEqual(JSON.parse(response), { ok: true, value: { text: "中文😀" } });
    } finally {
        if (opened) await broker.close();
        await rm(root, { recursive: true, force: true });
    }
});
