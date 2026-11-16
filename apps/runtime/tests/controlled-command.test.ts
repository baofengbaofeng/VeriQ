import assert from "node:assert/strict";
import test from "node:test";
import fs, {
    closeSync,
    fstatSync,
    mkdtempSync,
    openSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateJournal } from "../src/execution/controlled-child-protocol.mjs";
import type { ObserverBinding } from "../src/execution/controlled-child-protocol.mjs";
import type { ControlledCommandOwner, HeldCommand } from "../src/execution/controlled-command.mjs";

const commandBinding: ObserverBinding = {
    version: 1,
    attemptId: "11111111-1111-1111-1111-111111111111",
    ownerGeneration: 7,
    commandSlot: "22222222-2222-2222-2222-222222222222",
    nonce: "a".repeat(64),
};
const cliBinding: ObserverBinding = {
    ...commandBinding,
    commandSlot: "33333333-3333-3333-3333-333333333333",
};

/** 测试只借用两份本次私有普通文件并保留所有真实子对象，最终清理先等待实际退出再关闭描述符；动态加载让缺少实现的 RED 明
 * 确失败于公开能力而非静态解析。
 */
async function fixture(
    run: (f: {
        owner: ControlledCommandOwner;
        root: string;
        commandFd: number;
        cliFd: number;
        start: (
            role: "npm" | "compiler" | "cli",
            source: string,
            timeoutMs?: number,
            env?: NodeJS.ProcessEnv,
        ) => HeldCommand;
    }) => Promise<void>,
    kind: "TEST" | "VALIDATE" | "CLEANUP" = "TEST",
) {
    const module = await import("../src/execution/controlled-command.mjs").catch((error) => {
        if (error.code === "ERR_MODULE_NOT_FOUND") return {};
        throw error;
    });
    assert.ok(
        "createControlledCommandOwner" in module,
        "direct command ownership must be implemented",
    );
    const root = mkdtempSync(join(tmpdir(), "veriq-c2a2-"));
    const commandFd = openSync(join(root, "commands"), "wx+", 0o600);
    const cliFd = openSync(join(root, "cli"), "wx+", 0o600);
    const held: HeldCommand[] = [];
    try {
        const owner = module.createControlledCommandOwner({
            kind,
            commandBinding,
            cliBinding,
            commandJournalFd: commandFd,
            cliJournalFd: cliFd,
        });
        await run({
            owner,
            root,
            commandFd,
            cliFd,
            start(role, source, timeoutMs = 10000, env = process.env) {
                const script = join(root, role + ".mjs");
                writeFileSync(script, source);
                const command = owner.start(role, { args: [script], cwd: root, env, timeoutMs });
                held.push(command);
                return command;
            },
        });
    } finally {
        for (const command of held) {
            if (
                command.child.pid &&
                command.child.exitCode === null &&
                command.child.signalCode === null
            )
                command.child.kill("SIGKILL");
            if (command.child.pid) await command.exited;
        }
        closeSync(commandFd);
        closeSync(cliFd);
        rmSync(root, { recursive: true, force: true });
    }
}

/** 屏障使用普通本地 socket 而不为受控命令添加额外继承 FD，主体明确报告就绪后才发送取消或故障；测试结束总是关闭连接与监
 * 听器，不用睡眠猜测调度时机。
 */
async function barrier(run: (port: number, ready: Promise<Socket>) => Promise<void>) {
    let accept!: (socket: Socket) => void;
    const ready = new Promise<Socket>((resolve) => {
        accept = resolve;
    });
    const server = createServer((socket) => socket.once("data", () => accept(socket)));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        await run(address.port, ready);
    } finally {
        const socket = await Promise.race([ready, Promise.resolve(undefined)]);
        socket?.destroy();
        server.close();
    }
}
const waiting =
    `import {connect} from 'node:net'; const socket=connect(Number(process.env.TEST_PORT),'127.0.0.1',(` +
    `)=>socket.write('ready')); socket.on('data',()=>socket.end());`;

/** 两个直接命令的主体分别定位读取父日志以证明 INTENT 已经刷新，最终只接受固定顺序与原对象真实退出；命令失败码一仍是业务
 * 事实，不得被当成管理故障。
 */
test("durable intent precedes body and fixed completed prefix seals with real exit", async () => {
    await fixture(async ({ owner, start, root, commandFd }) => {
        const body =
            `import {readFileSync} from 'node:fs'; const frames=readFileSync('commands','utf8').trim().spl` +
            `it('\\n').map(JSON.parse); if(!frames.some(f=>f.type==='INTENT')) process.exit(41);`;
        const first = start("npm", body);
        assert.equal((await first.exited).code, 0);
        assert.equal((await first.result).exitCode, 0);
        assert.equal((await start("compiler", "process.exitCode=1").result).exitCode, 1);
        const result = owner.seal();
        assert.deepEqual(
            result.objects.map((entry) => [entry.slot, entry.exitCode]),
            [
                [1, 0],
                [2, 1],
            ],
        );
        assert.equal(
            validateJournal(readFileSync(join(root, "commands")), commandBinding).objects.length,
            2,
        );
        assert.doesNotThrow(() => fstatSync(commandFd));
        assert.throws(() => start("cli", ""), /CONTROLLED_COMMAND_ADMISSION_CLOSED/);
    });
});

/** 正常 CLI 业务码零和一必须穿过同一个真实 preload 与最终验证器，未授权一百三十和观察专用七十三不能封存；每个用例的 npm
 * 与编译器都是实际 Node 子对象。
 */
for (const code of [0, 1, 130, 73])
    test(`CLI ${code} retains business code only with valid management closure`, async () => {
        await fixture(async ({ owner, start }) => {
            await start("npm", "").result;
            await start("compiler", "").result;
            const cli = start("cli", `process.exitCode=${code}`);
            if (code === 0 || code === 1) {
                assert.equal((await cli.result).exitCode, code);
                assert.equal(owner.seal().objects.length, 3);
            } else {
                await assert.rejects(cli.result, /CONTROLLED_COMMAND_CLI_INVALID/);
                await cli.exited;
                assert.throws(() => owner.seal(), /CONTROLLED_COMMAND/);
            }
        });
    });

/** 取消只接受本代完整绑定，重复有效取消不重复发信号；实际 CLI 先装 SIGINT 处理再经 socket 表示就绪，父侧授权后正常退出
 * 一百三十仍须完整日志核验。
 */
test("live CLI cancellation authorizes before SIGINT and rejects stale identities", async () => {
    await fixture(async ({ owner, start }) => {
        await start("npm", "").result;
        await start("compiler", "").result;
        await barrier(async (port, ready) => {
            const cli = start(
                "cli",
                `process.on('SIGINT',()=>{process.exitCode=130;socket.end()}); ${waiting}`,
                10000,
                { ...process.env, TEST_PORT: String(port) },
            );
            await ready;
            for (const invalid of [
                { ...commandBinding, ownerGeneration: 8 },
                { ...commandBinding, nonce: "b".repeat(64) },
                cliBinding,
                {},
            ]) {
                assert.throws(
                    () => owner.requestStop(invalid as ObserverBinding),
                    /CONTROLLED_COMMAND_CANCELLATION_REJECTED/,
                );
            }
            let signals = 0;
            const kill = cli.child.kill.bind(cli.child);
            cli.child.kill = (signal) => {
                signals++;
                return kill(signal);
            };
            owner.requestStop(commandBinding);
            owner.requestStop(commandBinding);
            assert.equal((await cli.result).exitCode, 130);
            assert.equal(signals, 1);
            assert.equal(owner.seal().objects.length, 3);
            assert.throws(() => start("cli", ""), /CONTROLLED_COMMAND_ADMISSION_CLOSED/);
        });
    });
});

/** 超时只终结管理观察而不会伪造 exit，Promise 回调在真实 exit 事件前检查独立等待器仍挂起；随后实际退出仍保留粘滞故障且
 * 借入 FD 一直由测试拥有。
 */
test("timeout rejection is not actual exit and late exit cannot clear fault", async () => {
    await fixture(async ({ owner, start, commandFd, cliFd }) => {
        await barrier(async (port, ready) => {
            const command = start("npm", waiting, 300, { ...process.env, TEST_PORT: String(port) });
            await ready;
            let exited = false;
            void command.exited.then(() => {
                exited = true;
            });
            await assert.rejects(command.result, /CONTROLLED_COMMAND_TIMEOUT/);
            assert.equal(exited, false);
            assert.doesNotThrow(() => fstatSync(commandFd));
            assert.doesNotThrow(() => fstatSync(cliFd));
            assert.throws(() => owner.seal(), /CONTROLLED_COMMAND/);
            assert.equal((await command.exited).signal, "SIGKILL");
            assert.throws(() => owner.seal(), /CONTROLLED_COMMAND/);
        });
    });
});

/** npm 与编译器只有本代主动取消才允许信号结清，提前取消关闭准入并可封存空前缀；未授权信号或真实 spawn error 都保持未知
 * ，不使用 ENOENT 猜测没有派生。
 */
test("direct cancellation retains signal while unrequested signal and spawn error prevent seal", async () => {
    await fixture(async ({ owner, start }) => {
        await barrier(async (port, ready) => {
            const command = start("npm", waiting, 10000, {
                ...process.env,
                TEST_PORT: String(port),
            });
            await ready;
            owner.requestStop(commandBinding);
            assert.equal((await command.result).signal, "SIGINT");
            assert.equal(owner.seal().objects[0]?.signal, "SIGINT");
        });
    });
    await fixture(async ({ owner, start }) => {
        const command = start("npm", "setInterval(()=>{},1000)");
        command.child.once("spawn", () => command.child.kill("SIGTERM"));
        await assert.rejects(command.result, /CONTROLLED_COMMAND_EXIT_REJECTED/);
        await command.exited;
        assert.throws(() => owner.seal(), /CONTROLLED_COMMAND/);
    });
    await fixture(async ({ owner, root }) => {
        const command = owner.start("npm", {
            args: ["-e", ""],
            cwd: join(root, "absent"),
            env: process.env,
            timeoutMs: 1000,
        });
        let exited = false;
        void command.exited.then(() => {
            exited = true;
        });
        await assert.rejects(command.result, /CONTROLLED_COMMAND_ERROR/);
        await Promise.resolve();
        assert.equal(exited, false);
        assert.throws(() => owner.seal(), /CONTROLLED_COMMAND/);
    });
    await fixture(async ({ owner, start }) => {
        owner.requestStop(commandBinding);
        assert.throws(() => start("npm", ""), /CONTROLLED_COMMAND_ADMISSION_CLOSED/);
        assert.equal(owner.seal().objects.length, 0);
    });
});

/** 固定三角色顺序和 kind 限制在派生前拒绝违规请求，故障关闭同样不再允许新命令；这些测试直接观察私有日志内容，不以产品源
 * 码字符串替代行为。
 */
test("role order, kind limits, pending object and owner faults fail closed", async () => {
    await fixture(async ({ owner, start }) => {
        assert.throws(() => start("compiler", ""), /CONTROLLED_COMMAND_ROLE_REJECTED/);
        assert.equal(owner.seal().objects.length, 0);
    });
    for (const kind of ["VALIDATE", "CLEANUP"] as const)
        await fixture(async ({ owner, start }) => {
            await start("npm", "").result;
            await start("compiler", "").result;
            assert.throws(() => start("cli", ""), /CONTROLLED_COMMAND_ROLE_REJECTED/);
            assert.equal(owner.seal().objects.length, 2);
        }, kind);
    await fixture(async ({ owner, start }) => {
        const command = start("npm", "setInterval(()=>{},1000)");
        assert.throws(() => owner.seal(), /CONTROLLED_COMMAND_UNSETTLED/);
        owner.fail();
        assert.throws(() => start("compiler", ""), /CONTROLLED_COMMAND/);
        command.child.kill("SIGKILL");
        await assert.rejects(command.result, /CONTROLLED_COMMAND/);
        await command.exited;
        assert.throws(() => owner.seal(), /CONTROLLED_COMMAND/);
    });
});

/** npm 与编译器绝不继承激活标记或任一日志文件，检查 dev 与 inode 而非碰巧相同槽号；CLI 的普通 fork 被既有 preload 被动
 * 继承且不能获得日志描述符。
 */
test("direct roles cannot inherit observer marker or either private journal", async () => {
    await fixture(async ({ owner, start, commandFd, cliFd }) => {
        const identities = [fstatSync(commandFd), fstatSync(cliFd)].map((s) => [
            String(s.dev),
            String(s.ino),
        ]);
        const inspect =
            `import {fstatSync} from 'node:fs'; if(process.env.VERIQ_CHILD_OBSERVER)process.exit(42); c` +
            `onst ids=${JSON.stringify(identities)}` +
            `; for(let fd=3;fd<128;fd++){let s;try{s=fstatSync(fd)}catch{continue}if(ids.some(([d,i])=>d===String(s` +
            `.dev)&&i===String(s.ino)))process.exit(43)}`;
        for (const role of ["npm", "compiler"] as const)
            assert.equal(
                (
                    await start(role, inspect, 10000, {
                        ...process.env,
                        VERIQ_CHILD_OBSERVER: "untrusted",
                    }).result
                ).exitCode,
                0,
            );
        assert.equal(owner.seal().objects.length, 2);
    });
});

/** 日志注入只替换测试进程的内建写入或刷新函数，真实文件和真实子对象仍由产品执行；短写可完成而零写入或刷新错误必须永久阻
 * 止封存，生产没有故障开关。
 */
test("partial write completes while zero progress and fsync failure remain sticky", async () => {
    for (const mode of ["partial", "zero", "fsync"] as const)
        await fixture(async ({ owner, start }) => {
            const originalWrite = fs.writeSync;
            const originalSync = fs.fsyncSync;
            try {
                if (mode === "partial")
                    fs.writeSync = ((
                        fd: number,
                        buffer: Uint8Array,
                        offset: number,
                        length: number,
                        position: number,
                    ) =>
                        originalWrite(
                            fd,
                            buffer,
                            offset,
                            Math.min(3, length),
                            position,
                        )) as typeof fs.writeSync;
                if (mode === "zero") fs.writeSync = (() => 0) as typeof fs.writeSync;
                if (mode === "fsync")
                    fs.fsyncSync = () => {
                        throw new Error("test-only");
                    };
                syncBuiltinESMExports();
                if (mode === "partial") {
                    await start("npm", "").result;
                    assert.equal(owner.seal().objects.length, 1);
                } else {
                    assert.throws(() => start("npm", ""), /CONTROLLED_COMMAND_JOURNAL_FAILED/);
                    assert.throws(() => owner.seal(), /CONTROLLED_COMMAND/);
                }
            } finally {
                fs.writeSync = originalWrite;
                fs.fsyncSync = originalSync;
                syncBuiltinESMExports();
            }
        });
});

/** 真实固定 Playwright 公共 CLI 运行失败后更换 worker，全程不启动浏览器；新 owner 的三成员封存必须同时通过 CLI 的实际
 * fork 日志，业务失败码一不能吞成管理成功零。
 */
test("fixed Playwright CLI replacement workers close through new command owner", async () => {
    const require = createRequire(import.meta.url);
    await fixture(async ({ owner, start, root, cliFd }) => {
        await start("npm", "").result;
        await start("compiler", "").result;
        writeFileSync(
            join(root, "playwright.config.cjs"),
            "module.exports={fullyParallel:true,retries:0,timeout:5000,outputDir:'./results'}",
        );
        writeFileSync(
            join(root, "workers.spec.cjs"),
            `const {test,expect}=require(${JSON.stringify(require.resolve("@playwright/test"))});
            test('a failure',()=>expect(1).toBe(2));
            test('b pass',()=>expect(2).toBe(2));
            test('c replacement',()=>expect(3).toBe(3));
            test('d pass',()=>expect(4).toBe(4));`,
        );
        const cli = owner.start("cli", {
            args: [
                require.resolve("@playwright/test/cli"),
                "test",
                "--config=playwright.config.cjs",
                "--workers=1",
                "--reporter=line",
            ],
            cwd: root,
            env: process.env,
            timeoutMs: 30000,
        });
        assert.equal((await cli.result).exitCode, 1);
        assert.equal(owner.seal().objects.length, 3);
        assert.ok(validateJournal(readFileSync(cliFd), cliBinding).objects.length >= 2);
    });
});

/** CLI 缺少封存、真实 signal 或已经退出后才收到取消都不能产生管理成功；prepend exit 回调只让外部监听更早运行，仍不能在
 * 真实退出字段已经可见时补授权一百三十。
 */
test("CLI missing seal, signal and late cancellation cannot become management success", async () => {
    for (const source of [
        "process.removeAllListeners('exit')",
        "process.kill(process.pid,'SIGTERM')",
        "process.exitCode=130",
    ]) {
        await fixture(async ({ owner, start }) => {
            await start("npm", "").result;
            await start("compiler", "").result;
            const cli = start("cli", source);
            if (source.includes("130"))
                cli.child.prependOnceListener("exit", () => owner.requestStop(commandBinding));
            await assert.rejects(cli.result, /CONTROLLED_COMMAND/);
            await cli.exited;
            assert.throws(() => owner.seal(), /CONTROLLED_COMMAND/);
        });
    }
});

/** 两份本代绑定必须结构精确且描述符对应不同空私有文件，调用方后续改写原配置不能移动身份；这些负例直接调用真实 FD 验证器
 * 而不伪造文件状态或复制协议解析规则。
 */
test("configuration rejects reused files and mismatched generation before READY", async () => {
    const { createControlledCommandOwner } = await import(
        "../src/execution/controlled-command.mjs"
    );
    const root = mkdtempSync(join(tmpdir(), "veriq-command-binding-"));
    const commandFd = openSync(join(root, "commands"), "wx+", 0o600);
    const cliFd = openSync(join(root, "cli"), "wx+", 0o600);
    const aliasFd = openSync(join(root, "commands"), "r+");
    const options = {
        kind: "TEST" as const,
        commandBinding,
        cliBinding,
        commandJournalFd: commandFd,
        cliJournalFd: cliFd,
    };
    try {
        for (const patch of [
            { cliJournalFd: commandFd },
            { cliJournalFd: aliasFd },
            { cliBinding: commandBinding },
            { cliBinding: { ...cliBinding, ownerGeneration: 8 } },
            { cliBinding: { ...cliBinding, nonce: "b".repeat(64) } },
        ]) {
            assert.throws(
                () => createControlledCommandOwner({ ...options, ...patch }),
                /CONTROLLED_COMMAND_CONFIGURATION_INVALID/,
            );
            assert.equal(fstatSync(commandFd).size, 0);
        }
        const mutable = { ...commandBinding };
        const owner = createControlledCommandOwner({ ...options, commandBinding: mutable });
        mutable.ownerGeneration = 8;
        owner.requestStop(commandBinding);
        assert.equal(owner.seal().objects.length, 0);
    } finally {
        closeSync(commandFd);
        closeSync(cliFd);
        closeSync(aliasFd);
        rmSync(root, { recursive: true, force: true });
    }
});

/** CLI 显式映射到 fd4 后普通 fork 仍须保持自己的 fd3 IPC，继承 preload 只能处于被动模式；子进程逐个核对两份日志的设备与
 * inode，避免仅验证环境标记而漏掉可写 FD 继承。
 */
test("owner CLI preserves ordinary fork IPC without lending either journal", async () => {
    await fixture(async ({ owner, start, root, commandFd, cliFd }) => {
        await start("npm", "").result;
        await start("compiler", "").result;
        const identities = [fstatSync(commandFd), fstatSync(cliFd)].map((s) => [
            String(s.dev),
            String(s.ino),
        ]);
        writeFileSync(
            join(root, "fork.mjs"),
            `import {fstatSync} from 'node:fs'; let inherited=false;
            for(let fd=3;fd<128;fd++){let s;try{s=fstatSync(fd)}catch{continue}if(${JSON.stringify(identities)}.some` +
                `(([d,i])=>d===String(s.dev)&&i===String(s.ino)))inherited=true;}
            process.send({inherited,marker:process.env.VERIQ_CHILD_OBSERVER??null,imported:process.execArgv.includes` +
                `('--import')});process.disconnect();`,
        );
        const cli = start(
            "cli",
            `import {fork} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=fork('./fork` +
                `.mjs');child.on('message',value=>writeFileSync('fork-result.json',JSON.stringify(value)));`,
        );
        assert.equal((await cli.result).exitCode, 0);
        assert.deepEqual(JSON.parse(readFileSync(join(root, "fork-result.json"), "utf8")), {
            inherited: false,
            marker: null,
            imported: true,
        });
        assert.equal(owner.seal().objects.length, 3);
    });
});

/** 派生已经返回之后的 SPAWNED 刷新失败不能遗失真实对象，管理失败立即拒绝但实际退出仍由原等待器结清；恢复测试刷新函数并
 * 不能恢复这一代所有者的封存资格。
 */
test("spawn-frame flush failure retains actual object and sticky management error", async () => {
    await fixture(async ({ owner, start }) => {
        const originalSync = fs.fsyncSync;
        const command = start("npm", "");
        try {
            fs.fsyncSync = () => {
                throw new Error("test-only");
            };
            syncBuiltinESMExports();
            await assert.rejects(command.result, /CONTROLLED_COMMAND_JOURNAL_FAILED/);
        } finally {
            fs.fsyncSync = originalSync;
            syncBuiltinESMExports();
        }
        assert.equal((await command.exited).code, 0);
        assert.throws(() => owner.seal(), /CONTROLLED_COMMAND_JOURNAL_FAILED/);
    });
});

/** 同步构造异常已经留下 INTENT，所有者必须固定管理故障且只抛出公开稳定码，不能再拒绝调用方根本拿不到的隐藏 promise；此
 * 例用真实 Node 参数检查触发异常而不伪造事件。
 */
test("synchronous spawn exception cannot leak an unobservable rejection or seal intent", async () => {
    await fixture(async ({ owner }) => {
        assert.throws(
            () =>
                owner.start("npm", {
                    args: ["-e", ""],
                    cwd: "\u0000",
                    env: process.env,
                    timeoutMs: 1000,
                }),
            /CONTROLLED_COMMAND_ERROR/,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.doesNotThrow(() => owner.requestStop(commandBinding));
        assert.throws(() => owner.seal(), /CONTROLLED_COMMAND_ERROR/);
    });
});
