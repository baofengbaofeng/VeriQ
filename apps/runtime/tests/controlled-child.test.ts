import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs, { closeSync, fchmodSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trackObservedCli } from "../src/execution/controlled-child.ts";
import { validateJournal } from "../src/execution/controlled-child-protocol.mjs";

const preload = fileURLToPath(new URL("../src/execution/controlled-child-preload.mjs", import.meta.url));
const binding = {
    version: 1 as const,
    attemptId: "11111111-1111-1111-1111-111111111111",
    ownerGeneration: 7,
    commandSlot: "22222222-2222-2222-2222-222222222222",
    nonce: "a".repeat(64),
};

/** 本辅助器只持有本次真实 CLI 与私有普通文件，在断言失败后也等待同一对象退出再关闭借入描述符，避免失败测试遗留写者或把后续槽号复用误认为原日志。 */
async function withCli(
    source: string,
    run: (fixture: { child: ChildProcess; fd: number; root: string; exit: Promise<number | null> }) => Promise<void>,
    options: { marker?: string | null; setup?: (root: string) => string[]; args?: string[]; cwd?: string; advancedOffset?: boolean; readOnly?: boolean; mode?: number; prefill?: string } = {},
): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "veriq-c1-"));
    let fd = openSync(join(root, "journal"), "wx+", 0o600);
    if (options.readOnly) {
        closeSync(fd);
        fd = openSync(join(root, "journal"), "r");
    }
    if (options.advancedOffset) {
        writeSync(fd, "offset-was-not-zero");
        ftruncateSync(fd, 0);
    }
    if (options.mode !== undefined) fchmodSync(fd, options.mode);
    if (options.prefill !== undefined) writeSync(fd, options.prefill, 0);
    let child: ChildProcess | undefined;
    let exit: Promise<number | null> | undefined;
    try {
        const fixture = join(root, "cli.mjs");
        writeFileSync(fixture, source);
        const args = options.setup?.(root) ?? [];
        const env = { ...process.env };
        delete env.VERIQ_CHILD_OBSERVER;
        if (options.marker !== null) env.VERIQ_CHILD_OBSERVER = options.marker ?? JSON.stringify({ ...binding, fd: 4 });
        child = spawn(process.execPath, [...args, "--import", preload, ...(options.args ?? [fixture])], {
            cwd: options.cwd ?? root,
            env,
            stdio: ["ignore", "pipe", "pipe", "ipc", fd],
        });
        exit = new Promise((resolve, reject) => {
            child!.once("exit", resolve);
            child!.once("error", reject);
        });
        await run({ child, fd, root, exit });
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exit;
        closeSync(fd);
        rmSync(root, { recursive: true, force: true });
    }
}

/** 本例要求原生 Node 在 CLI 主体之前观察真实子对象并同步持久化意图，主体随后在 spawn 返回时定位读取日志，因此漏订阅或延迟写入都会产生可见失败。 */
test("native preload persists intent before spawn returns and seals actual exit", async () => {
    await withCli(`
        import { spawn } from 'node:child_process';
        import { fstatSync, readSync } from 'node:fs';
        const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {stdio:'ignore'});
        const bytes = Buffer.alloc(fstatSync(4).size);
        readSync(4, bytes, 0, bytes.length, 0);
        if (!bytes.toString().includes('"type":"INTENT"')) process.exit(41);
        child.once('exit', (code) => { if (code !== 0) process.exitCode = 42; });
    `, async ({ exit, root }) => {
        assert.equal(await exit, 0);
        const records = readFileSync(join(root, "journal"), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
        assert.deepEqual(records.map((record) => record.type), ["OBSERVER_READY", "INTENT", "SPAWNED", "EXITED", "SEAL"]);
        assert.equal(records[3].exitCode, 0);
    });
});

/** 本组在调用父侧组合接口之后才让真实 CLI 退出，以同一个对象的 exit 驱动最终验证；各业务码独立保留，授权取消则必须精确匹配当前 Attempt 和代际绑定。 */
for (const [code, authorized, ok] of [[0, false, true], [1, false, true], [130, true, true], [130, false, false], [73, false, false]] as const) {
    test(`actual CLI ${code}, authorized=${authorized}, verified=${ok}`, async () => {
        await withCli(`process.on('message', () => { process.disconnect(); process.exitCode = ${code}; });`, async ({ child, fd }) => {
            const observation = trackObservedCli(child, {
                journalFd: fd,
                expectedBinding: binding,
                ...(authorized ? { authorizedCancellation: binding } : {}),
            });
            child.send("finish");
            const result = await observation.verifyFinal();
            assert.equal(result.ok, ok);
            if (result.ok) assert.equal(result.exitCode, code);
        });
    });
}

/** 无激活标记时同一 preload 必须完全被动，本例让真实 fd3 IPC 往返并让 fork 自动继承 --import，子进程检查标记已消费且日志 inode 没有成为可写继承描述符。 */
test("passive preload preserves fd3 IPC and ordinary fork has no journal descriptor", async () => {
    await withCli(`process.on('message', value => { process.send(value); process.disconnect(); });`, async ({ child, exit, root }) => {
        const message = new Promise((resolve) => child.once("message", resolve));
        child.send("ipc-is-live");
        assert.equal(await message, "ipc-is-live");
        assert.equal(await exit, 0);
        assert.equal(readFileSync(join(root, "journal")).length, 0);
    }, { marker: null });
    await withCli(`
        import { fork } from 'node:child_process';
        import { fstatSync, writeFileSync } from 'node:fs';
        const identity = fstatSync(4);
        writeFileSync('fork.mjs', \`import { fstatSync } from 'node:fs';
            let inherited = false;
            for (let fd = 4; fd < 128; fd++) {
                try { const s = fstatSync(fd); if (String(s.dev) === process.env.JDEV && String(s.ino) === process.env.JINO) inherited = true; } catch {}
            }
            process.send({marker: process.env.VERIQ_CHILD_OBSERVER ?? null, inherited, imported: process.execArgv.includes('--import')});
            process.disconnect();\`);
        const child = fork('./fork.mjs', [], {env:{...process.env,JDEV:String(identity.dev),JINO:String(identity.ino)}});
        child.on('message', value => { process.send(value); process.disconnect(); });
    `, async ({ child, fd }) => {
        const observation = trackObservedCli(child, { journalFd: fd, expectedBinding: binding });
        const message = new Promise((resolve) => child.once("message", resolve));
        assert.deepEqual(await message, { marker: null, inherited: false, imported: true });
        assert.equal((await observation.verifyFinal()).ok, true);
    });
});

/** 这里分别触发构造后 error、CLI 信号退出和 seal 后构造，断言观察器采用同步专用失败码或父侧拒绝；不能用 close 或临时文件 EOF 代替真实退出结论。 */
test("ENOENT and late exit-handler spawn fail synchronously, including closed journal", async () => {
    for (const source of [
        `import {spawn} from 'node:child_process'; spawn('/veriq-no-such-command-c1', [], {stdio:'ignore'}).on('error',()=>{});`,
        `import {spawn} from 'node:child_process'; process.on('exit',()=>spawn(process.execPath,['-e','process.exit(0)']));`,
        `import {spawn} from 'node:child_process'; import {closeSync} from 'node:fs'; process.on('exit',()=>{closeSync(4); spawn(process.execPath,['-e','process.exit(0)']);});`,
    ]) await withCli(source, async ({ exit }) => { assert.equal(await exit, 73); });
    await withCli(`process.on('message',()=>process.kill(process.pid,'SIGTERM'));`, async ({ child, fd }) => {
        const observation = trackObservedCli(child, { journalFd: fd, expectedBinding: binding });
        child.send("finish");
        assert.equal((await observation.verifyFinal()).ok, false);
    });
});

/** 受观察子对象的信号退出仍是实在退出事实，父 CLI 的正常退出则必须等待这些对象全部结束；本例以子 IPC 就绪为闸门发送终止而不依赖碰巧足够长的延时。 */
test("child signal exit is recorded on the actual object", async () => {
    await withCli(`
        import {spawn} from 'node:child_process';
        const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(()=>{},1000)"], {stdio:['ignore','ignore','ignore','ipc']});
        child.once('message',()=>child.kill('SIGTERM'));
    `, async ({ child, fd }) => {
        const observation = trackObservedCli(child, { journalFd: fd, expectedBinding: binding });
        const result = await observation.verifyFinal();
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.objects[0]?.signal, "SIGTERM");
    });
});

/** 标记必须是精确字段和严格类型的 JSON，错误激活不能悄悄恢复为无观察运行；业务主体的 sentinel 只在错误未关闭时出现，测试据此区分正常业务退出与明确故障。 */
test("malformed activation fails closed before CLI body", async () => {
    const markers = ["", "null", "{}", JSON.stringify({ ...binding, fd: 3 }), JSON.stringify({ ...binding, fd: 4, extra: true }),
        JSON.stringify({ ...binding, fd: 4, nonce: "a".repeat(63) }), JSON.stringify({ ...binding, fd: 4, ownerGeneration: 0 }),
        JSON.stringify({ ...binding, fd: 4, attemptId: binding.attemptId.toUpperCase().replace("111", "AAA") })];
    for (const marker of markers) await withCli(`process.exit(44)`, async ({ exit }) => { assert.equal(await exit, 73); }, { marker });
});

/** 手工构造的独立合法帧用于验证严格协议拒绝歧义和不完整状态，预期值没有调用生产编码器；每一个负例都覆盖可能把不可信尾巴或未结清意图误认成封存日志的分支。 */
test("strict protocol rejects binding, sequence, encoding, roster and tail defects", () => {
    const ready = JSON.stringify({ version: 1, seq: 0, type: "OBSERVER_READY", attemptId: binding.attemptId, ownerGeneration: 7, commandSlot: binding.commandSlot, nonce: binding.nonce });
    const intent = '{"version":1,"seq":1,"type":"INTENT","slot":1}';
    const spawned = '{"version":1,"seq":2,"type":"SPAWNED","slot":1,"pid":123}';
    const exited = '{"version":1,"seq":3,"type":"EXITED","slot":1,"exitCode":0,"signal":null}';
    const seal = '{"version":1,"seq":4,"type":"SEAL"}';
    const good = `${ready}\n${intent}\n${spawned}\n${exited}\n${seal}\n`;
    assert.equal(validateJournal(Buffer.from(good), binding).objects.length, 1);
    const bad = [
        good.replace('"seq":2', '"seq":9'), good.replace('"slot":1,"pid"', '"slot":2,"pid"'), good.replace('"pid":123', '"pid":0'),
        good.replace('"exitCode":0,"signal":null', '"exitCode":0,"signal":"SIGTERM"'), good.replace('"ownerGeneration":7', '"ownerGeneration":8'),
        good.replace('"version":1', '"version":1,"version":1'), good.replace('"type":"INTENT"', '"type":"INTENT","secret":"bad"'),
        good.replace('"seq":1', '"seq":1.0'), good.replace('"seq":1', '"seq": 1'), good.replace('INTENT', '\\u0049NTENT'),
        good.replaceAll('\n', '\r\n'), `\ufeff${good}`, `${good}\n`, good.slice(0, -1), `${good}x`,
        `${ready}\n${intent}\n${seal.replace('"seq":4', '"seq":2')}\n`, `${ready}\n${spawned}\n`, `${good}${seal}\n`,
        good.replace(`${exited}\n`, ''), good.replace(`${ready}\n`, ''), `${ready}\n${" ".repeat(4096)}\n`, "x".repeat(1024 * 1024 + 1),
    ];
    for (const bytes of bad) assert.throws(() => validateJournal(Buffer.from(bytes), binding));
    assert.throws(() => validateJournal(Buffer.from([0xff, 0x0a]), binding));
});

/** 即使 CLI 主体已经看见 READY 和最后 SEAL，父侧仍必须等待真实 exit；本例手写合法无子对象日志并通过 IPC 保活，再以超时证明接口不会提前返回成功。 */
test("parent never accepts a seal before actual CLI exit and keeps borrowed fd open", async () => {
        const ready = JSON.stringify({ seq: 0, type: "OBSERVER_READY", ...binding });
    const bytes = `${ready}\n{"version":1,"seq":1,"type":"SEAL"}\n`;
    await withCli(`import {writeSync} from 'node:fs'; writeSync(4,${JSON.stringify(bytes)},0); process.on('message',()=>process.disconnect());`, async ({ child, fd }) => {
        const observation = trackObservedCli(child, { journalFd: fd, expectedBinding: binding, timeoutMs: 100 });
        const result = await observation.verifyFinal();
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, "CLI_TIMEOUT");
        assert.doesNotThrow(() => readFileSync(fd));
        child.send("finish");
    }, { marker: null });
});

/** 普通文件初始为空并不保证共享偏移为零，本例先写后截断保留非零偏移，随后要求 preload 显式定位写入且父侧定位读取成功，防止隐含游标制造稀疏前缀或读到假 EOF。 */
test("writer and final reader ignore a nonzero shared descriptor offset", async () => {
    await withCli(`process.on('message',()=>process.disconnect())`, async ({ child, fd }) => {
        const observation = trackObservedCli(child, { journalFd: fd, expectedBinding: binding });
        child.send("finish");
        assert.equal((await observation.verifyFinal()).ok, true);
    }, { advancedOffset: true });
});

/** 短写适配仍把每段真实写入同一普通文件，零进展和实际 EBADF 则确定性触发专用失败；这里不伪造 ChildProcess 事件，也不通过任意延时等待偶发磁盘错误。 */
test("real partial writes complete, zero progress, closed fsync and readonly writes fail", async () => {
    const injections = [
        { body: `const write = fs.writeSync; fs.writeSync=(fd,buf,off,len,pos)=>write(fd,buf,off,Math.min(len,3),pos);`, want: 0 },
        { body: `fs.writeSync=()=>0;`, want: 73 },
        { body: `const sync = fs.fsyncSync; fs.fsyncSync=(fd)=>{fs.closeSync(fd); return sync(fd);};`, want: 73 },
    ];
    for (const injection of injections) await withCli(``, async ({ exit }) => {
        assert.equal(await exit, injection.want);
    }, { setup(root) {
        const shim = join(root, "inject.mjs");
        writeFileSync(shim, `import fs from 'node:fs'; ${injection.body}`);
        return ["--import", shim];
    } });
    await withCli(`process.exit(44)`, async ({ exit }) => { assert.equal(await exit, 73); }, { readOnly: true });
});

/** 固定 Playwright 公共 CLI 使用两个并发 worker 并在失败后替换工作进程，测试不请求任何浏览器；父侧仍须保留真实业务失败码一，同时核验所有已构造对象都得到实际退出记录。 */
test("fixed Playwright public CLI closes concurrent and replacement worker roster without browsers", async () => {
    const require = createRequire(import.meta.url);
    const cli = require.resolve("@playwright/test/cli");
    await withCli(``, async ({ child, fd }) => {
        const observation = trackObservedCli(child, { journalFd: fd, expectedBinding: binding, timeoutMs: 30000 });
        const result = await observation.verifyFinal();
        assert.equal(result.ok, true, JSON.stringify(result));
        if (result.ok) {
            assert.equal(result.exitCode, 1);
            assert.ok(result.objects.length >= 3, `expected replacement workers, saw ${result.objects.length}`);
            assert.ok(result.objects.every((object) => object.pid > 0 && (object.exitCode !== null || object.signal !== null)));
        }
    }, { args: [cli, "test", "--config=playwright.config.cjs", "--workers=2", "--reporter=line"], setup(root) {
        const modulePath = require.resolve("@playwright/test");
        writeFileSync(join(root, "playwright.config.cjs"), "module.exports={fullyParallel:true,retries:0,timeout:5000,outputDir:'./results'};");
        writeFileSync(join(root, "workers.spec.cjs"), `const {test,expect}=require(${JSON.stringify(modulePath)});
            test('a failure replaces worker',()=>expect(1).toBe(2));
            test('b passes',()=>expect(2).toBe(2));
            test('c passes in replacement',()=>expect(3).toBe(3));
            test('d passes',()=>expect(4).toBe(4));`);
        return [];
    } });
});

/** 能力自检必须真正运行所给 Node 的公开通道与普通文件刷新路径，并确认被动继承和 late spawn 闸门；只校验版本字符串或复用本测试的预制成功对象都会使本例失败。 */
test("concrete Node capability selftest exercises real constructor, fork, flush and late gate", async () => {
    const { runControlledChildCapability } = await import("../src/execution/controlled-child-capability.ts");
    const result = await runControlledChildCapability({ nodeExecutable: process.execPath, temporaryDirectory: tmpdir() });
    assert.equal(result.supported, true, JSON.stringify(result));
});

/** 构造但从未 spawn 的对象仍有未结清意图，且错误权限与非空文件都必须在主体执行前被拒绝；这些真实 FD 负例防止观察器仅检查描述符存在就把原有数据当作全新日志。 */
test("unspawned constructor, nonempty file and unsafe mode cannot produce clean seal", async () => {
    await withCli(`import {ChildProcess} from 'node:child_process'; new ChildProcess();`, async ({ exit }) => { assert.equal(await exit, 73); });
    for (const options of [{ mode: 0o640 }, { mode: 0o4600 }, { prefill: "old" }]) {
        await withCli(`process.exit(44)`, async ({ exit }) => { assert.equal(await exit, 73); }, options);
    }
});

/** CLI 业务失败码一只有在正常退出时才允许进入完整日志核验，未捕获异常即使碰巧使用同一码也必须置观察故障；这避免运行时崩溃被表面完整封存覆盖而冒充可信业务失败。 */
test("uncaught CLI exception cannot be mistaken for normal business code one", async () => {
    await withCli(`throw new Error('fixture crash')`, async ({ exit }) => { assert.equal(await exit, 73); });
});

/** 取消授权只有完全匹配当前代际才允许正常码一百三十进入日志核验，迟到注册和缺 READY 则分别拒绝；这里通过真实子对象事件而不是调用者提供的退出数字驱动父接口。 */
test("parent rejects stale cancellation, missed actual exit, spawn error and missing observer", async () => {
    await withCli(`process.on('message',()=>{process.disconnect();process.exitCode=130;})`, async ({ child, fd }) => {
        const observed = trackObservedCli(child, { journalFd: fd, expectedBinding: binding, authorizedCancellation: { ...binding, ownerGeneration: 8 } });
        child.send("finish");
        assert.equal((await observed.verifyFinal()).ok, false);
    });
    await withCli(``, async ({ child, fd, exit }) => {
        await exit;
        const observed = trackObservedCli(child, { journalFd: fd, expectedBinding: binding });
        assert.deepEqual(await observed.verifyFinal(), { ok: false, reason: "CLI_ALREADY_EXITED" });
    });
    await withCli(`process.on('message',()=>process.disconnect())`, async ({ child, fd }) => {
        const observed = trackObservedCli(child, { journalFd: fd, expectedBinding: binding });
        child.send("finish");
        assert.deepEqual(await observed.verifyFinal(), { ok: false, reason: "JOURNAL_INVALID" });
    }, { marker: null });
    const child = spawn("/veriq-no-such-node-c1", [], { stdio: "ignore" });
    const observed = trackObservedCli(child, { journalFd: -1, expectedBinding: binding });
    assert.deepEqual(await observed.verifyFinal(), { ok: false, reason: "CLI_ERROR" });
});

/** 最终读取期间发生增长、截断或原位重写都必须被拒绝，注入仅在真实定位读取返回后改变同一普通文件；不改造 ChildProcess 生命周期，因此仍要求先等到实际 CLI 退出。 */
test("final snapshot rejects actual growth, truncation and same-size rewrite during read", async () => {
    for (const mutation of ["grow", "truncate", "rewrite"] as const) {
        await withCli(`process.on('message',()=>process.disconnect())`, async ({ child, fd }) => {
            const observed = trackObservedCli(child, { journalFd: fd, expectedBinding: binding });
            const original = fs.readSync;
            let changed = false;
            fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
                const result = Reflect.apply(original, fs, args) as number;
                if (args[0] === fd && !changed) {
                    changed = true;
                    if (mutation === "grow") writeSync(fd, "x", null);
                    else if (mutation === "truncate") ftruncateSync(fd, 1);
                    else writeSync(fd, "x", 0);
                }
                return result;
            }) as typeof fs.readSync;
            syncBuiltinESMExports();
            try {
                child.send("finish");
                assert.equal((await observed.verifyFinal()).ok, false);
                assert.equal(changed, true);
            } finally {
                fs.readSync = original;
                syncBuiltinESMExports();
            }
        });
    }
});

/** 对象数上限覆盖整个构造历史而非同时存活数，测试独立生成严格递增并已退出的对象帧，确保大量替换不能绕过有限 roster；额外对象即使最终退出也必须拒绝。 */
test("strict protocol bounds lifetime object count", () => {
    const frames: object[] = [{ ...binding, seq: 0, type: "OBSERVER_READY" }];
    for (let slot = 1; slot <= 1025; slot++) {
        frames.push({ version: 1, seq: frames.length, type: "INTENT", slot });
        frames.push({ version: 1, seq: frames.length, type: "SPAWNED", slot, pid: 1000 + slot });
        frames.push({ version: 1, seq: frames.length, type: "EXITED", slot, exitCode: 0, signal: null });
    }
    frames.push({ version: 1, seq: frames.length, type: "SEAL" });
    assert.throws(() => validateJournal(Buffer.from(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n"), binding));
});

/** Linux 专属一次性 owner 收养故意遗留的测试子对象并用 pidfd 清理，实际 CLI 观察仍在 Node 驱动中持原始 ChildProcess；此负例证明主动退出不能覆盖活 roster，并不构成 Mac 验收。 */
test("Linux fixture owner reaps a live child after CLI active exit is rejected", { skip: process.platform !== "linux" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "veriq-c1-owner-"));
    const require = createRequire(import.meta.url);
    const ownerPath = fileURLToPath(new URL("./fixtures/controlled-child-owner.py", import.meta.url));
    let owner: ChildProcess | undefined;
    let exit: Promise<number | null> | undefined;
    try {
        writeFileSync(join(root, "living.mjs"), "process.send('ready');setTimeout(()=>process.exit(0),10000);");
        writeFileSync(join(root, "cli.mjs"), `import {fork} from 'node:child_process';
            const child=fork(${JSON.stringify(join(root, "living.mjs"))},[],{stdio:['ignore','ignore','ignore','ipc']});
            child.once('message',()=>{process.send({fixturePid:child.pid});process.exit(0);});`);
        writeFileSync(join(root, "driver.mjs"), `import {spawn} from 'node:child_process';
            import {openSync,closeSync} from 'node:fs';
            import {trackObservedCli} from ${JSON.stringify(new URL("../src/execution/controlled-child.ts", import.meta.url).href)};
            const binding=${JSON.stringify(binding)};
            const fd=openSync(${JSON.stringify(join(root, "journal"))},'wx+',0o600);
            const child=spawn(process.execPath,['--import',${JSON.stringify(preload)},${JSON.stringify(join(root, "cli.mjs"))}],{
                env:{...process.env,VERIQ_CHILD_OBSERVER:JSON.stringify({...binding,fd:4})},stdio:['ignore','ignore','ignore','ipc',fd]});
            let fixturePid;
            child.once('message',value=>{fixturePid=value.fixturePid;});
            const observed=trackObservedCli(child,{journalFd:fd,expectedBinding:binding,timeoutMs:5000});
            try { const result=await observed.verifyFinal();const exit=await observed.exited;
                console.log(JSON.stringify({fixturePid,verified:result.ok,cliCode:exit.code}));
            } finally {if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}closeSync(fd);}`);
        owner = spawn("python3", [ownerPath, process.execPath, "--import", require.resolve("tsx"), join(root, "driver.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let errors = "";
        owner.stdout!.on("data", (bytes) => { output += bytes.toString(); });
        owner.stderr!.on("data", (bytes) => { errors += bytes.toString(); });
        exit = new Promise((resolve, reject) => { owner!.once("exit", resolve); owner!.once("error", reject); });
        assert.equal(await exit, 0, errors);
        assert.deepEqual(JSON.parse(output), { cliCode: 73, verified: false, aliveAfterCliExit: true, reaped: true });
    } finally {
        await exit;
        rmSync(root, { recursive: true, force: true });
    }
});
