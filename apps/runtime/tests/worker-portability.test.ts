import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { offlineWorkerEnvironment } from "../src/offline/worker-environment.ts";

/**
 * 本例实际启动既有 worker 并提供带空格与中文路径的 npm JavaScript 入口，检查它通过当前角色 Node 执行而不误用系统 shell
 * 或相邻 npm 脚本；随后缺失编译归档应停在提取阶段。
 */
test("worker executes the supplied npm JavaScript with its role Node", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq npm 中文 "));
    try {
        const cli = join(root, "npm cli.cjs");
        await mkdir(join(root, "tmp"));
        await writeFile(
            cli,
            "require('fs').writeFileSync('npm-observed.json', JSON.stringify({execPath:process.execPath,args:process" +
                ".argv.slice(2)}));",
        );
        await writeFile(
            join(root, "invocation.json"),
            JSON.stringify({ kind: "TEST", work: root, tmp: join(root, "tmp"), npmCli: cli }),
        );
        const child = fork(
            fileURLToPath(new URL("../src/execution/worker.mjs", import.meta.url)),
            [join(root, "invocation.json")],
            { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] },
        );
        const exit = new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", resolve);
        });
        child.send({ type: "START" });
        assert.equal(await exit, 1);
        const result = await readFile(join(root, "npm-observed.json"), "utf8").catch(() => "null");
        assert.notEqual(result, "null", "the supplied npm CLI must run before archive extraction");
        const observed = JSON.parse(result);
        assert.equal(observed.execPath, process.execPath);
        assert.deepEqual(observed.args.slice(0, 3), ["ci", "--offline", "--ignore-scripts"]);
        assert.equal(
            JSON.parse(await readFile(join(root, "worker-failure.json"), "utf8")).failureCode,
            "COMPILER_EXTRACTION_FAILED",
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/**
 * Windows 环境构造在任何开发宿主上都可验证纯路径和白名单规则，真正系统进程及 ACL 验收仍属于后续目标机器；该检查防止复
 * 用 Linux 冒号 PATH 或复制设备令牌到业务子进程。
 */
test("Windows worker environment uses bounded native paths without host secrets", () => {
    const result = offlineWorkerEnvironment(
        "C:\\工作\\tmp",
        "C:\\工作\\provider.mjs",
        true,
        { SystemRoot: "C:\\Windows", VERIQ_DEVICE_TOKEN: "secret", PATH: "unsafe" },
        { platform: "win32", runnerExecutable: "C:\\Program Files\\VeriQ\\veriq_runner.exe" },
    );
    assert.equal(result.PATH, "C:\\Program Files\\VeriQ;C:\\Windows\\System32");
    assert.equal(result.TEMP, "C:\\工作\\tmp");
    assert.equal(result.SystemRoot, "C:\\Windows");
    assert.equal(result.VERIQ_DEVICE_TOKEN, undefined);
    assert.throws(
        () =>
            offlineWorkerEnvironment(
                "C:\\tmp",
                "C:\\provider.mjs",
                true,
                { SystemRoot: "relative" },
                { platform: "win32", runnerExecutable: "C:\\veriq_runner.exe" },
            ),
        /WINDOWS_SYSTEM_ROOT_INVALID/,
    );
});

/**
 * 受控 Worker 夹具仅提供几字节 npm、编译桥与归档，实际入口仍运行受审 worker 和新命令所有者；父进程保留两份普通私有 FD
 * ，始终等外层真实退出再读取及关闭日志。
 */
async function controlledWorker(
    cliSource: string,
    run: (value: {
        child: import("node:child_process").ChildProcess;
        exit: Promise<number | null>;
        root: string;
        binding: import("../src/execution/controlled-child-protocol.mjs").ObserverBinding;
        commands: import("node:fs/promises").FileHandle;
        message: (type: string) => Promise<unknown>;
    }) => Promise<void>,
    options: { npmSource?: string; preloadSource?: string; componentScenario?: string } = {},
) {
    const { open } = await import("node:fs/promises");
    const { create } = await import("tar");
    const root = await mkdtemp(join(tmpdir(), "veriq-controlled-worker-"));
    await mkdir(join(root, "engine"));
    await mkdir(join(root, "tmp"));
    await mkdir(join(root, "node_modules/@playwright/test"), { recursive: true });
    await writeFile(join(root, "marker"), "compiler fixture");
    await create({ cwd: root, file: join(root, "engine/compiler.tgz"), gzip: true }, ["marker"]);
    await writeFile(join(root, "loader.mjs"), "");
    await writeFile(join(root, "npm.mjs"), options.npmSource ?? "");
    if (options.preloadSource)
        await writeFile(join(root, "test-preload.mjs"), options.preloadSource);
    await writeFile(
        join(root, "compile-entry.mjs"),
        "import {writeFileSync} from 'node:fs'; writeFileSync('worker-result.json',JSON.stringify({kind:'READY'}));",
    );
    await writeFile(join(root, "node_modules/@playwright/test/cli.js"), cliSource);
    const binding = {
        version: 1 as const,
        attemptId: "11111111-1111-1111-1111-111111111111",
        ownerGeneration: 7,
        commandSlot: "22222222-2222-2222-2222-222222222222",
        nonce: "a".repeat(64),
    };
    const commands = await open(join(root, "commands"), "wx+", 0o600);
    const cli = await open(join(root, "cli-journal"), "wx+", 0o600);
    let child: import("node:child_process").ChildProcess | undefined;
    let exit: Promise<number | null> | undefined;
    try {
        await writeFile(
            join(root, "invocation.json"),
            JSON.stringify({
                kind: options.componentScenario ? "VALIDATE" : "TEST",
                scenario: options.componentScenario,
                work: root,
                tmp: join(root, "tmp"),
                npmCli: join(root, "npm.mjs"),
                tsx: join(root, "loader.mjs"),
                controlled: {
                    commandBinding: binding,
                    cliBinding: { ...binding, commandSlot: "33333333-3333-3333-3333-333333333333" },
                    commandJournalFd: 5,
                    cliJournalFd: 4,
                },
            }),
        );
        child = fork(
            fileURLToPath(
                new URL(
                    options.componentScenario
                        ? "./fixtures/darwin-controlled-worker.mjs"
                        : "../src/execution/worker.mjs",
                    import.meta.url,
                ),
            ),
            [join(root, "invocation.json")],
            {
                execArgv: options.preloadSource ? ["--import", join(root, "test-preload.mjs")] : [],
                stdio: ["ignore", "ignore", "ignore", "ipc", cli.fd, commands.fd],
            },
        );
        exit = new Promise((resolve, reject) => {
            child!.once("exit", resolve);
            child!.once("error", reject);
        });
        /**
         * 实际 READY 与测试 preload 的门消息可能在同一 IPC 批次到达，因此从 spawn 后立即建立有界按类型队列；消费 READY
         * 不会丢弃紧随其后的测试屏障，真实退出而缺少目标帧则明确失败，不改变
         * 任何原有超时或取消断言。
         */
        const buffered: unknown[] = [];
        const waiting = new Map<string, ((value: unknown) => void)[]>();
        child.on("message", (value) => {
            const type = String((value as { type?: unknown })?.type);
            const consume = waiting.get(type)?.shift();
            if (consume) consume(value);
            else {
                assert.ok(
                    buffered.length < 16,
                    "Worker control message buffer must remain bounded",
                );
                buffered.push(value);
            }
        });
        const message = (type: string): Promise<unknown> => {
            const index = buffered.findIndex(
                (value) => (value as { type?: unknown })?.type === type,
            );
            if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
            return new Promise((resolve, reject) => {
                const consumers = waiting.get(type) ?? [];
                consumers.push(resolve);
                waiting.set(type, consumers);
                void exit!.then(() => reject(new Error("TEST_CONTROL_FRAME_MISSING")), reject);
            });
        };
        assert.deepEqual(await message("CONTROLLED_READY"), {
            type: "CONTROLLED_READY",
            binding,
            pid: child.pid,
        });
        await run({ child, exit, root, binding, commands, message });
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exit;
        await commands.close();
        await cli.close();
        await rm(root, { recursive: true, force: true });
    }
}

/**
 * 真实 CLI 正常业务失败必须保留失败码一且正常封存三命令，异常七十三则写固定管理故障并禁止 SEAL；这区分业务结果与观察完
 * 整性，不能继续用空 catch 隐藏 CLI 异常。
 */
test("controlled worker distinguishes CLI business failure from management fault", async () => {
    const { validateJournal } = await import("../src/execution/controlled-child-protocol.mjs");
    await controlledWorker("process.exitCode=1", async ({ child, exit, root, binding }) => {
        child.send({ type: "START" });
        assert.equal(await exit, 1);
        assert.equal(
            validateJournal(await readFile(join(root, "commands")), binding).objects.length,
            3,
        );
        await assert.rejects(readFile(join(root, "worker-failure.json")), { code: "ENOENT" });
    });
    await controlledWorker(
        "throw new Error('third party secret')",
        async ({ child, exit, root }) => {
            child.send({ type: "START" });
            assert.equal(await exit, 73);
            assert.deepEqual(
                JSON.parse(await readFile(join(root, "worker-failure.json"), "utf8")),
                { failureCode: "CONTROLLED_COMMAND_MANAGEMENT_FAILED" },
            );
            assert.ok(!(await readFile(join(root, "commands"), "utf8")).includes('"type":"SEAL"'));
        },
    );
});

/**
 * 可信取消可以先于 START 到达，Worker 先关闭本代准入才 ACK 并在 START 后封存空前缀；ACK 只证明控制请求被接受，最终日志
 * 仍须等外层实际退出后由父侧验证。
 */
test("controlled worker accepts generation-bound cancellation before START", async () => {
    const { validateJournal } = await import("../src/execution/controlled-child-protocol.mjs");
    await controlledWorker(
        "process.exitCode=0",
        async ({ child, exit, root, binding, message }) => {
            const ack = message("CANCEL_ACK");
            child.send({ type: "CANCEL", binding });
            assert.deepEqual(await ack, { type: "CANCEL_ACK", binding });
            child.send({ type: "START" });
            assert.equal(await exit, 130);
            assert.equal(
                validateJournal(await readFile(join(root, "commands")), binding).objects.length,
                0,
            );
        },
    );
});

/**
 * Mac 组件夹具必须保留生产 Worker 的独立 START 闸门，取消 ACK 后仍能实际查询到门未释放，只有下一条 START 才进入空前缀退
 * 出；这在普通 Node 上验证夹具语义，不把它当成 Darwin 文件层或 C
 * hrome 所有权证据。
 */
test("Darwin component fixture keeps cancellation ACK separate from START release", async () => {
    await controlledWorker(
        "",
        async ({ child, exit, root, binding, message }) => {
            const ack = message("CANCEL_ACK");
            child.send({ type: "CANCEL", binding });
            assert.deepEqual(await ack, { type: "CANCEL_ACK", binding });
            const status = message("TEST_GATE_STATUS");
            child.send({ type: "TEST_GATE_STATUS" }, () => {});
            const actual = await Promise.race([
                status.catch(() => "EXITED"),
                exit.then(() => "EXITED"),
            ]);
            assert.deepEqual(actual, {
                type: "TEST_GATE_STATUS",
                released: false,
                cancelled: true,
            });
            child.send({ type: "START" });
            assert.equal(await exit, 130);
            const frames = (await readFile(join(root, "gate.jsonl"), "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line).type);
            assert.deepEqual(frames, [
                "CANCEL_INSTALLED",
                "ACK_SENT",
                "START_RECEIVED",
                "GATE_RELEASED",
            ]);
        },
        { componentScenario: "gate-inspection" },
    );
});

/**
 * 桌面 staging 在隔离的小目录中复制真实源码并计算摘要，两个目标均用普通 Node 加载所有者并激活真实 preload；此测试不安
 * 装依赖、不使用 checkout TypeScript loader 或展开发行引擎。
 */
test("desktop stages and hashes the complete ordinary Node command closure twice", async () => {
    const { copyFile } = await import("node:fs/promises");
    const { execFileSync } = await import("node:child_process");
    const { createHash } = await import("node:crypto");
    const root = await mkdtemp(join(tmpdir(), "veriq-stage-closure-"));
    const names = [
        "worker.mjs",
        "provider.mjs",
        "compile-entry.mjs",
        "archive.mjs",
        "controlled-command.mjs",
        "controlled-child.mjs",
        "controlled-child-protocol.mjs",
        "controlled-child-preload.mjs",
    ];
    try {
        await mkdir(join(root, "runtime/src/execution"), { recursive: true });
        await mkdir(join(root, "runtime/build"));
        await mkdir(join(root, "desktop"));
        for (const name of names)
            await copyFile(
                fileURLToPath(new URL("../src/execution/" + name, import.meta.url)),
                join(root, "runtime/src/execution", name),
            );
        await writeFile(join(root, "runtime/build/veriq_runner"), "stage fixture");
        execFileSync(
            process.execPath,
            [fileURLToPath(new URL("../../desktop/scripts/stage-runtime.mjs", import.meta.url))],
            { cwd: join(root, "desktop"), timeout: 10000 },
        );
        const inventory = JSON.parse(
            await readFile(join(root, "desktop/out/runtime-files.json"), "utf8"),
        ) as { path: string; sha256: string }[];
        for (const target of ["out/main", "out/execution"]) {
            for (const name of names) {
                const bytes = await readFile(join(root, "desktop", target, name));
                assert.equal(
                    inventory.find((entry) => entry.path === target + "/" + name)?.sha256,
                    createHash("sha256").update(bytes).digest("hex"),
                );
            }
            const entry = join(root, "desktop", target, "controlled-command.mjs");
            const output = execFileSync(
                process.execPath,
                [
                    "--input-type=module",
                    "-e",
                    `
                import {openSync,closeSync} from 'node:fs';
                const m=await import(${JSON.stringify(new URL("file://" + entry).href)});
                const commandFd=openSync(${JSON.stringify(join(root, target.replaceAll("/", "-") + "-commands"))},'w` +
                        `x+',0o600);
                const cliFd=openSync(${JSON.stringify(join(root, target.replaceAll("/", "-") + "-cli"))},'wx+',0o600);
                const binding={version:1,attemptId:'11111111-1111-1111-1111-111111111111',ownerGeneration:7,commandS` +
                        `lot:'22222222-2222-2222-2222-222222222222',nonce:'a'.repeat(64)};
                const owner=m.createControlledCommandOwner({kind:'TEST',commandBinding:binding,cliBinding:{...bindin` +
                        `g,commandSlot:'33333333-3333-3333-3333-333333333333'},commandJournalFd:commandFd,cliJournalF` +
                        `d:cliFd});
                for(const role of ['npm','compiler','cli'])await owner.start(role,{args:['-e',''],cwd:process.cwd(),` +
                        `env:process.env,timeoutMs:10000}).result;
                console.log(owner.seal().objects.length);closeSync(commandFd);closeSync(cliFd);
            `,
                ],
                { cwd: root, encoding: "utf8", timeout: 10000 },
            );
            assert.equal(output.trim(), "3");
            const preload = join(root, "desktop", target, "controlled-child-preload.mjs");
            assert.equal(
                execFileSync(
                    process.execPath,
                    ["--import", preload, "-e", "console.log('passive')"],
                    { cwd: root, encoding: "utf8", timeout: 10000 },
                ).trim(),
                "passive",
            );
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/**
 * 期限注入只在真实 Worker 的测试 preload 中缩短调度并暂扣同一子对象的 KILL，管理超时通知后外层必须仍等待实际 exit；释
 * 放屏障才发送真实 KILL，避免以 timeout promise 冒充退出。
 */
test("controlled worker waits for actual command exit after timeout observation fails", async () => {
    const preloadSource =
        `
        import {ChildProcess} from 'node:child_process';
        const originalTimer=globalThis.setTimeout;
        globalThis.setTimeout=(fn,ms,...args)=>originalTimer(fn,ms===45000?200:ms,...args);
        const originalKill=ChildProcess.prototype.kill;
        let held;
        ChildProcess.prototype.kill=function(signal){
            if(signal==='SIGKILL'){held=this;process.send({type:'TEST_TIMEOUT_SIGNAL'});return true;}
            return originalKill.call(this,signal);
        };
        process.on('message',message=>{if(message.type==='TEST_RELEASE')originalKill.call(held,'SIGKILL');});
        process.on('newListener',event=>{if(event==='message')queueMicrotask(()=>process.send({type:'TEST_GATE_READY` +
        `'}));});
    `;
    await controlledWorker(
        "",
        async ({ child, exit, root, message }) => {
            let exited = false;
            void exit.then(() => {
                exited = true;
            });
            const gate = message("TEST_GATE_READY");
            assert.deepEqual(await gate, { type: "TEST_GATE_READY" });
            const timeoutSignal = message("TEST_TIMEOUT_SIGNAL");
            child.send({ type: "START" });
            assert.deepEqual(await timeoutSignal, { type: "TEST_TIMEOUT_SIGNAL" });
            assert.equal(exited, false);
            assert.equal(child.exitCode, null);
            assert.ok(!(await readFile(join(root, "commands"), "utf8")).includes('"type":"SEAL"'));
            child.send({ type: "TEST_RELEASE" });
            assert.equal(await exit, 73);
            assert.deepEqual(
                JSON.parse(await readFile(join(root, "worker-failure.json"), "utf8")),
                { failureCode: "CONTROLLED_COMMAND_MANAGEMENT_FAILED" },
            );
        },
        { npmSource: "setInterval(()=>{},1000)", preloadSource },
    );
});
