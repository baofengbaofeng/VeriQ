/** 此 suite 只允许在真实 macOS 执行，固定 Chrome 与 B 原生文件层都必须实际存在；可信夹具隔离 Agent/outer 组件而保留真实
 * CLI、直接 child、公共浏览器连接和原对象退出，不据此宣称完整业
 * 务、安装入口或整个平台已经就绪。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { chromium, type BrowserServer } from "playwright-core";
import type { ChildProcess } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { ProcessSupervisor, type OwnedProcess } from "../../src/execution/processes.ts";
import { ProcessRecords } from "../../src/execution/records.ts";
import { requireStoppedHistory } from "../../src/execution/stopped-history.ts";
import {
    darwinNative,
    type DarwinPrivateDirectory,
    type DarwinPrivateFile,
} from "../../src/native/darwin.ts";

assert.equal(
    process.platform,
    "darwin",
    "This suite requires actual macOS; Linux is not substitute evidence",
);
const worker = fileURLToPath(new URL("../fixtures/darwin-controlled-worker.mjs", import.meta.url));

/** 原生成员方法可能具有不可写属性，故测试只用普通对象委托并绑定真实 B 接收者，不修改 NAPI 实例；每个读写、刷新和关闭仍
 * 执行实际原生实现，有限覆写只用于观察真实 File 生命周期或在真实发布之后注入不确定结果。
 */
function delegateDirectory(
    directory: DarwinPrivateDirectory,
    overrides: Partial<DarwinPrivateDirectory>,
): DarwinPrivateDirectory {
    return {
        read: directory.read.bind(directory),
        entries: directory.entries.bind(directory),
        createExclusive: directory.createExclusive.bind(directory),
        replace: directory.replace.bind(directory),
        remove: directory.remove.bind(directory),
        close: directory.close.bind(directory),
        ...overrides,
    };
}

/**
 * 原始 BrowserServer 与实际 Chrome 对象由测试额外保留用于故障后的可靠清理，包装仍执行真实公共 launchServer 且核对
 * sandbox 与端点约束；finally 仅操作本次所得原对象并等 exi
 * t，不扫描 PID 或删除未退出写者仍需的日志。
 */
async function fixture(
    run: (f: {
        root: string;
        work: string;
        processes: ProcessSupervisor;
        id: string;
        launch: (
            scenario?: string,
            kind?: "TEST" | "VALIDATE" | "CLEANUP",
            prepare?: (context: any) => Promise<void> | void,
        ) => Promise<OwnedProcess>;
        servers: BrowserServer[];
    }) => Promise<void>,
    timeoutMs = 30000,
) {
    const source = await import("../../src/execution/darwin-source.ts").catch((error) => {
        if (error.code === "ERR_MODULE_NOT_FOUND") return {};
        throw error;
    });
    assert.ok(
        "createDarwinSource" in source,
        "actual Darwin source ownership capability must be implemented",
    );
    const root = await mkdtemp(join(await realpath(tmpdir()), "veriq-c2b1-"));
    const work = join(root, "work");
    await mkdir(work, { mode: 0o700 });
    const servers: BrowserServer[] = [],
        exits: Promise<unknown>[] = [];
    const previousSecret = process.env.VERIQ_AGENT_TEST_SECRET;
    process.env.VERIQ_AGENT_TEST_SECRET = "public-fixture-agent-only-secret";
    const children: { child: ChildProcess; exited: Promise<void> }[] = [];
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = ((...args: any[]) => {
        const child = (originalSpawn as (...args: any[]) => ChildProcess)(...args);
        if (child.pid)
            children.push({
                child,
                exited: new Promise<void>((resolve) => {
                    child.once("exit", () => resolve());
                }),
            });
        return child;
    }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    const launchServer = chromium.launchServer.bind(chromium);
    chromium.launchServer = async (options) => {
        assert.equal(options?.executablePath, chromium.executablePath());
        assert.equal(options?.chromiumSandbox, true);
        assert.equal(options?.host, "127.0.0.1");
        assert.equal(options?.port, 0);
        assert.ok(!options?.args?.includes("--no-sandbox"));
        for (const key of [
            "NODE_OPTIONS",
            "DEBUG",
            "DYLD_INSERT_LIBRARIES",
            "VERIQ_AGENT_TEST_SECRET",
        ])
            assert.equal(options?.env?.[key], undefined);
        assert.deepEqual(Object.keys(options!.env!).sort(), ["HOME", "LANG", "PATH", "TMPDIR"]);
        assert.ok(options!.env!.HOME!.startsWith(root + "/"));
        assert.ok(options!.env!.TMPDIR!.startsWith(root + "/"));
        const server = await launchServer(options);
        servers.push(server);
        const child = server.process();
        exits.push(
            new Promise((resolve) => {
                if (child.exitCode !== null || child.signalCode !== null) resolve(undefined);
                else child.once("exit", resolve);
            }),
        );
        return server;
    };
    const id = randomUUID();
    let processes: ProcessSupervisor | undefined;
    try {
        const capability = await source.createDarwinSource({
            temporaryDirectory: root,
            stopTimeoutMs: timeoutMs,
        });
        processes = new ProcessSupervisor(join(root, "processes"), 500, undefined, capability);
        const owned: ChildProcess[] = [];
        await run({
            root,
            work,
            processes,
            id,
            servers,
            async launch(scenario = "normal", kind = "TEST", prepare) {
                const result = await processes!.start(
                    id,
                    {
                        executable: process.execPath,
                        args: [worker, join(work, "invocation.json")],
                        cwd: work,
                        env: { PATH: "/usr/bin:/bin" },
                    },
                    {
                        kind,
                        ownerGeneration: 7,
                        async prepare(context) {
                            context.publish(
                                "invocation.json",
                                Buffer.from(
                                    JSON.stringify({
                                        kind,
                                        scenario,
                                        work,
                                        controlled: context.controlled,
                                        wsEndpoint: context.wsEndpoint,
                                    }),
                                ),
                            );
                            await prepare?.(context);
                        },
                    },
                );
                owned.push(result.child);
                return result;
            },
        });
        for (const child of owned)
            assert.ok(
                child.exitCode !== null || child.signalCode !== null,
                "fixture must observe outer exit before cleanup",
            );
    } finally {
        await processes?.terminateAttempt(id, "TEST_FINALLY");
        for (const server of servers) {
            const child = server.process();
            if (child.exitCode === null && child.signalCode === null) await server.kill();
        }
        for (const { child } of children)
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await Promise.all(children.map(({ exited }) => exited));
        await Promise.all(exits);
        chromium.launchServer = launchServer;
        childProcess.spawn = originalSpawn;
        syncBuiltinESMExports();
        if (previousSecret === undefined) delete process.env.VERIQ_AGENT_TEST_SECRET;
        else process.env.VERIQ_AGENT_TEST_SECRET = previousSecret;
        await rm(root, { recursive: true, force: true });
    }
}

/** 正常路径明确在真实 outer 与 Chrome 仍活着时拒绝证明，随后从日志和实际 exit 生成私有配对，重新构造无启动能力的监督器
 * 仍能只读确认；端点只能存在于私有工作配置，不能进入任何过程证明或日志。
 */
for (const scenario of ["normal", "business-failure"])
    test(`actual native Chrome and controlled CLI ${scenario} commit read-only restart proof`, async () =>
        fixture(async ({ root, processes, id, launch, servers }) => {
            const owned = await launch(scenario);
            await assert.rejects(owned.firstLine(), /PROCESS_NO_OUTPUT/);
            assert.equal(await processes.confirmStopped(id), false);
            assert.equal(await processes.isRunning(owned.pid), true);
            assert.equal(servers.length, 1);
            owned.send({ type: "START" });
            assert.equal((await owned.exited).code, scenario === "normal" ? 0 : 1);
            const receipt = await processes.terminateAttempt(id, "COMPLETED");
            assert.equal(receipt.processStopped, true);
            assert.equal(receipt.processStopScope, "CONTROLLED_WORKER_BROWSER");
            const restarted = new ProcessSupervisor(join(root, "processes"));
            assert.equal(await restarted.confirmStopped(id), true);
            await assert.rejects(restarted.isRunning(owned.pid), /UNKNOWN/);
            await assert.rejects(
                restarted.start(randomUUID(), {
                    executable: process.execPath,
                    args: [],
                    cwd: root,
                }),
                /UNSUPPORTED/,
            );
            const forbidden = [
                servers[0]!.wsEndpoint(),
                new URL(servers[0]!.wsEndpoint()).pathname,
            ];
            for (const file of [
                join(root, "processes", `${id}.process.json`),
                join(root, "processes", `${id}.controlled.json`),
                join(root, "controlled-journals", id, "command.jsonl"),
                join(root, "controlled-journals", id, "cli.jsonl"),
            ]) {
                const bytes = await readFile(file, "utf8");
                for (const secret of forbidden) assert.ok(!bytes.includes(secret));
            }
            assert.deepEqual(
                (await readdir(join(root, "processes"))).sort(),
                [`${id}.controlled.json`, `${id}.process.json`].sort(),
            );
        }));

/** 显式无浏览器的两种任务仍运行真实命令前缀且 CLI 原始日志保持空，证明必须保留计划缺席而不是从对象丢失推断缺席；复用已
 * 经占用的 Attempt 不得覆盖任何旧身份、日志或已提交停止证明。
 */
for (const kind of ["VALIDATE", "CLEANUP"] as const)
    test(`${kind} records explicit browser absence and empty CLI journal`, async () =>
        fixture(async ({ root, processes, id, launch, servers }) => {
            const owned = await launch("normal", kind);
            owned.send({ type: "START" });
            await owned.exited;
            assert.equal((await processes.terminateAttempt(id, "COMPLETED")).processStopped, true);
            assert.equal(servers.length, 0);
            assert.equal(
                (await readFile(join(root, "controlled-journals", id, "cli.jsonl"))).length,
                0,
            );
            assert.equal(
                JSON.parse(await readFile(join(root, "processes", `${id}.controlled.json`), "utf8"))
                    .chrome,
                null,
            );
            await assert.rejects(launch("normal", kind), /ALREADY|EXISTS/);
        }));

/** CLI 自己通过本地 socket 屏障证明已经装好 SIGINT 处理且页面操作完成，随后父层先持久授权再取消并只接受正常一百三十；
 * ACK 的存在不参与停止判断，直接 child、CLI、outer 和 Chrome 都仍须
 * 实际退出。
 */
test("authorized cancellation closes actual CLI, outer and Chrome before proof", async () =>
    fixture(async ({ work, processes, id, launch }) => {
        let accept!: (socket: Socket) => void;
        const ready = new Promise<Socket>((resolve) => {
            accept = resolve;
        });
        const sockets: Socket[] = [];
        const server = createServer((socket) => {
            sockets.push(socket);
            socket.once("data", () => accept(socket));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const address = server.address();
            assert.ok(address && typeof address !== "string");
            const owned = await launch("cancel", "TEST", (context) => {
                context.publish(
                    "invocation.json",
                    Buffer.from(
                        JSON.stringify({
                            kind: "TEST",
                            scenario: "cancel",
                            work,
                            controlled: context.controlled,
                            wsEndpoint: context.wsEndpoint,
                            port: address.port,
                        }),
                    ),
                );
            });
            owned.send({ type: "START" });
            await ready;
            const first = processes.terminateAttempt(id, "CANCELLED"),
                second = processes.terminateAttempt(id, "REPEATED");
            assert.equal(first, second);
            assert.equal((await first).processStopped, true);
            assert.equal((await owned.exited).code, 130);
        } finally {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }));

/** 尚未公开 START 的真实 outer 已经装好控制监听，停止必须先取得匹配取消 ACK 才能私下释放闸门进入取消分支；该测试若收到
 * 业务 START 或执行任一命令就无法得到预期的空前缀封存，且 ACK 自身不能替代真实退出
 * 。
 */
test("bound cancellation before business START seals empty prefix and actually exits", async () =>
    fixture(async ({ root, processes, id, launch }) => {
        const owned = await launch();
        const stopped = processes.terminateAttempt(id, "CANCELLED_BEFORE_START");
        assert.throws(() => owned.send({ type: "START" }), /STOPPING/);
        assert.equal((await stopped).processStopped, true);
        assert.equal((await owned.exited).code, 130);
        const value = JSON.parse(
            await readFile(join(root, "processes", `${id}.controlled.json`), "utf8"),
        );
        assert.equal(value.journals.commands.count, 0);
        assert.equal(value.journals.cli.bytes, 0);
        const trace = (await readFile(join(root, "work", "gate.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line).type);
        assert.deepEqual(trace, [
            "CANCEL_INSTALLED",
            "ACK_SENT",
            "START_RECEIVED",
            "GATE_RELEASED",
        ]);
    }));

/** 错误或缺少 ACK 不能释放已经取消的 START 闸门，夹具与生产 Worker 一样只在独立 START 消息后继续；期限不延长且只用真实
 * 所持对象清理，不能凭 ACK、outer 最终被强停或空 CLI 日志获得停止正证明
 * 。
 */
for (const scenario of ["missing-ack", "stale-ack"])
    test(`${scenario} keeps the actual pre-START gate closed`, async () =>
        fixture(async ({ root, processes, id, launch }) => {
            const owned = await launch(scenario, "VALIDATE");
            assert.equal(
                (await processes.terminateAttempt(id, "CANCELLED_BEFORE_START")).processStopped,
                false,
            );
            await owned.exited;
            const trace = (await readFile(join(root, "work", "gate.jsonl"), "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line).type);
            assert.ok(trace.includes("CANCEL_INSTALLED"));
            assert.ok(!trace.includes("START_RECEIVED"));
            assert.ok(!trace.includes("GATE_RELEASED"));
            const commands = await readFile(
                join(root, "controlled-journals", id, "command.jsonl"),
                "utf8",
            );
            assert.ok(!commands.includes('"type":"INTENT"'));
            assert.ok(!commands.includes('"type":"SEAL"'));
        }, 1500));

/** 这个组件故障夹具由测试父进程实际持有一个继承同一 CLI 日志 fd4 的 Node 写者，并让已登记 outer 在未封存时退出；它验证
 * 未知写者尚活时原 B File 不能被回收，明确不冒充真实 outer 到 CLI 的孤
 * 儿祖先链或 Agent 操作系统崩溃。
 */
test("unsealed outer exit retains the original CLI File while an inherited writer is alive", async () => {
    const native = darwinNative(),
        open = native.openPrivateDirectory.bind(native);
    let original: DarwinPrivateFile | undefined,
        closeCalls = 0;
    native.openPrivateDirectory = (path, create) => {
        const directory = open(path, create);
        if (!path.includes("/controlled-journals/") || !create) return directory;
        return delegateDirectory(directory, {
            createExclusive(name) {
                const file = directory.createExclusive(name);
                if (name !== "cli.jsonl") return file;
                original = file;
                return {
                    get fd() {
                        return file.fd;
                    },
                    read: file.read.bind(file),
                    close() {
                        closeCalls++;
                        file.close();
                    },
                };
            },
        });
    };
    try {
        await fixture(async ({ processes, id, launch, root }) => {
            const outer = await launch("normal", "VALIDATE");
            assert.ok(original);
            const writer = childProcess.spawn(
                process.execPath,
                [
                    "--input-type=module",
                    "-e",
                    "import {writeSync,fsyncSync} from 'node:fs'; process.on('message', message => { if(message.type" +
                        " === 'APPEND') {writeSync(4,'live-writer\\n'); fsyncSync(4); process.send({type:'APPENDED'}" +
                        ");}}); process.send({type:'WRITER_READY'});",
                ],
                { stdio: ["ignore", "ignore", "ignore", "ipc", original.fd] },
            );
            const writerExit = new Promise<void>((resolve) => writer.once("exit", () => resolve()));
            const ready = new Promise<unknown>((resolve) => writer.once("message", resolve));
            try {
                assert.deepEqual(await ready, { type: "WRITER_READY" });
                outer.child.kill("SIGTERM");
                await outer.exited;
                assert.equal(
                    (await processes.terminateAttempt(id, "OUTER_LOST")).processStopped,
                    false,
                );
                const appended = new Promise<unknown>((resolve) => writer.once("message", resolve));
                writer.send({ type: "APPEND" });
                assert.deepEqual(await appended, { type: "APPENDED" });
                assert.equal(writer.exitCode, null);
                assert.equal(
                    closeCalls,
                    0,
                    "Agent must retain the original parent File owner while CLI writer is unknown",
                );
                assert.equal(original.read(1048576).toString(), "live-writer\n");
                assert.equal(await processes.confirmStopped(id), false);
                assert.ok(
                    (
                        await readFile(join(root, "controlled-journals", id, "cli.jsonl"), "utf8")
                    ).includes("live-writer"),
                );
            } finally {
                if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
                await writerExit;
                original.close();
            }
        });
    } finally {
        native.openPrivateDirectory = open;
    }
});

/** 观察故障的退出码与缺少封存不能被随后真实退出抹除，原始日志会保留用于排查且重启只能得出未确认；这里的故障属于组件边界
 * ，不能把同进程夹具当成真实 Agent 操作系统崩溃的验收。
 */
for (const scenario of ["missing-seal", "cli-fault", "outer-signal"])
    test(`${scenario} remains unknown after actual member exits`, async () =>
        fixture(async ({ root, processes, id, launch }) => {
            const owned = await launch(scenario);
            owned.send({ type: "START" });
            await owned.exited;
            assert.equal((await processes.terminateAttempt(id, "FAULT")).processStopped, false);
            assert.equal(
                await new ProcessSupervisor(join(root, "processes")).confirmStopped(id),
                false,
            );
        }));

test("missing or stale actual Worker READY cannot register or publish proof", async () => {
    for (const scenario of ["no-ready", "stale-ready"])
        await fixture(async ({ root, processes, id, launch }) => {
            await assert.rejects(launch(scenario, "VALIDATE"), /READY|PROTOCOL|TIMEOUT/);
            assert.equal((await processes.terminateAttempt(id, "FAULT")).processStopped, false);
            assert.equal(
                await new ProcessSupervisor(join(root, "processes")).confirmStopped(id),
                false,
            );
        }, 1500);
});

/** prepare 的受信发布能力只支持既定两个配置成员，父层取消即使发生于 await 中也必须阻止后来 outer 派生；持久意图与已启动
 * Chrome 使该路径保持未知，不能因为没有 outer 对象而编造没有任何派生。
 */
test("cancellation during preparation closes admission before a late startup can spawn outer", async () =>
    fixture(async ({ processes, id, launch }) => {
        let release!: () => void, entered!: () => void;
        const prepared = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const pause = new Promise<void>((resolve) => {
            release = resolve;
        });
        const pending = launch("normal", "TEST", async (context) => {
            assert.throws(() => context.publish("arbitrary.json", Buffer.from("{}")), /MEMBER/);
            assert.throws(() => context.publish("invocation.json", Buffer.alloc(65537)), /LIMIT/);
            entered();
            await pause;
        });
        await prepared;
        const stopped = processes.terminateAttempt(id, "CANCELLED");
        release();
        await assert.rejects(pending, /STOPPING|CLOSED/);
        assert.equal((await stopped).processStopped, false);
    }));

/** Chrome 只有经过持久停止授权后的实际退出才能进入正证明，先前公共 server.kill 造成的异常消失必须保持故障；准备失败同样
 * 不能因为缺少 outer 句柄而返回未派生，这两种路径的测试仍持有实际 server 负责
 * finally 清理。
 */
test("unexpected actual Chrome exit and preparation failure stay quarantined", async () => {
    await fixture(async ({ processes, id, launch, servers }) => {
        const owned = await launch();
        await servers[0]!.kill();
        await new Promise<void>((resolve) => {
            const child = servers[0]!.process();
            if (child.exitCode !== null || child.signalCode !== null) resolve();
            else child.once("exit", () => resolve());
        });
        assert.equal((await processes.terminateAttempt(id, "CHROME_LOST")).processStopped, false);
        await owned.exited;
    });
    await fixture(async ({ processes, id, launch }) => {
        await assert.rejects(
            launch("normal", "TEST", () => {
                throw new Error("TEST_PREPARE_FAILED");
            }),
            /START_FAILED/,
        );
        assert.equal(
            (await processes.terminateAttempt(id, "PREPARE_FAILED")).processStopped,
            false,
        );
    });
});

/** 公共 launchServer 可能已经派生 Chrome 却在返回句柄以前拒绝，组件此时必须保守保持未知而不能自行扫描补领对象；测试包装
 * 仍保留真实 server 供 finally 清理，这只验证公开 API 部分失败边界，
 * 不伪装后端实际取得了所有权。
 */
test("public browser launch rejection after actual spawn never claims no process", async () =>
    fixture(async ({ processes, id, launch }) => {
        const trackedLaunch = chromium.launchServer;
        chromium.launchServer = async (options) => {
            await trackedLaunch(options);
            throw new Error("TEST_LAUNCH_REJECTED_AFTER_SPAWN");
        };
        try {
            await assert.rejects(launch(), /START_FAILED/);
            const receipt = await processes.terminateAttempt(id, "LAUNCH_UNKNOWN");
            assert.equal(receipt.processStopped, false);
            assert.equal(receipt.processStopScope, undefined);
        } finally {
            chromium.launchServer = trackedLaunch;
        }
    }));

/** 提交故障在真实 B 已经发布并刷新 proof 后抛出不确定结果，不替换原生文件行为或伪造 OS 退出；过程记录必须继续停在
 * RUNNING，使随后只读恢复拒绝这个半配对，即使完整 proof 字节已经在目录中可见也不能释放容
 * 量。
 */
test("proof publication uncertainty leaves restart history unconfirmed", async () => {
    const native = darwinNative(),
        open = native.openPrivateDirectory.bind(native);
    let publications = 0;
    native.openPrivateDirectory = (path, create) => {
        const directory = open(path, create);
        if (path.endsWith("/processes") && create) {
            const descriptor = Object.getOwnPropertyDescriptor(
                Object.getPrototypeOf(directory),
                "replace",
            );
            console.log(
                JSON.stringify({
                    boundary: "native-directory-replace-attributes",
                    writable: descriptor?.writable ?? null,
                    configurable: descriptor?.configurable ?? null,
                }),
            );
            return delegateDirectory(directory, {
                replace(name, temporary, bytes, limit) {
                    directory.replace(name, temporary, bytes, limit);
                    if (name.endsWith(".controlled.json")) {
                        publications++;
                        throw Object.assign(new Error("TEST_COMMIT_UNCONFIRMED"), {
                            code: "COMMIT_UNCONFIRMED",
                        });
                    }
                },
            });
        }
        return directory;
    };
    try {
        await fixture(async ({ root, processes, id, launch }) => {
            const owned = await launch("normal", "VALIDATE");
            owned.send({ type: "START" });
            await owned.exited;
            assert.equal((await processes.terminateAttempt(id, "COMPLETED")).processStopped, false);
            assert.equal(
                publications,
                1,
                "fault must occur after actual controlled proof publication",
            );
            assert.equal(
                JSON.parse(await readFile(join(root, "processes", `${id}.controlled.json`), "utf8"))
                    .state,
                "CONTROLLED_STOPPED",
            );
            assert.equal(
                JSON.parse(await readFile(join(root, "processes", `${id}.process.json`), "utf8"))
                    .state,
                "RUNNING",
            );
            assert.equal(
                await new ProcessSupervisor(join(root, "processes")).confirmStopped(id),
                false,
            );
        });
    } finally {
        native.openPrivateDirectory = open;
    }
});

/** 正式历史读取只接受 Darwin 对应的两份提交成员，混入旧平台 proof、孤立成员或不同 fence 都不能通过；观察前后逐字节相同
 * 表明迁移不会修复权限、删除 staging 或把不确定历史改成受控停止。
 */
test("private history rejects mixed proofs, orphan members and stale claim generation read-only", async () =>
    fixture(async ({ root, processes, id, launch }) => {
        const owned = await launch("normal", "VALIDATE");
        owned.send({ type: "START" });
        await owned.exited;
        assert.equal((await processes.terminateAttempt(id, "COMPLETED")).processStopped, true);
        const attempts = join(root, "attempts");
        await mkdir(attempts, { mode: 0o700 });
        const claim = {
            jobId: randomUUID(),
            attemptId: id,
            jobKind: "VALIDATE",
            leaseToken: "public-component-history",
            fencingToken: 7,
            expiresAt: "2026-11-14T02:00:00Z",
            serverTime: "2026-11-14T01:59:00Z",
            leaseDurationMs: 60000,
            activationRequired: true,
            snapshotUrl: "https://control.example/snapshot",
            snapshotSha256: "a".repeat(64),
        };
        const history = { claim, state: "STOPPED", work: join(root, "work", id) };
        await writeFile(join(attempts, `${id}.json`), JSON.stringify(history), { mode: 0o600 });
        await requireStoppedHistory(root);
        await writeFile(
            join(attempts, `${id}.json`),
            JSON.stringify({ ...history, claim: { ...claim, jobKind: "TEST" } }),
            { mode: 0o600 },
        );
        await assert.rejects(requireStoppedHistory(root), /RECOVERY/);
        await writeFile(join(attempts, `${id}.json`), JSON.stringify(history), { mode: 0o600 });
        assert.throws(
            () => new ProcessSupervisor(join(root, "other-processes"), 500, undefined, {} as any),
            /CAPABILITY/,
        );
        const otherId = randomUUID(),
            otherIntent = join(root, "processes", `${otherId}.process.json`);
        await writeFile(otherIntent, JSON.stringify({ state: "SPAWNING", attemptId: otherId }), {
            mode: 0o600,
        });
        assert.equal(
            await processes.confirmStopped(id),
            true,
            "another recognized active intent cannot invalidate the selected committed proof",
        );
        await assert.rejects(requireStoppedHistory(root), /RECOVERY/);
        await rm(otherIntent);
        const wrongRole = join(root, "processes", "unexpected.json");
        await writeFile(wrongRole, "{}", { mode: 0o600 });
        assert.equal(await processes.confirmStopped(id), false);
        await assert.rejects(requireStoppedHistory(root), /RECOVERY/);
        await rm(wrongRole);
        const recordPath = join(root, "processes", `${id}.process.json`),
            before = await readFile(recordPath);
        await writeFile(join(root, "processes", `${id}.drained.json`), "{}", { mode: 0o600 });
        assert.equal(await processes.confirmStopped(id), false);
        await assert.rejects(requireStoppedHistory(root), /RECOVERY/);
        assert.deepEqual(await readFile(recordPath), before);
        await rm(join(root, "processes", `${id}.drained.json`));
        await writeFile(
            join(attempts, `${id}.json`),
            JSON.stringify({ ...history, claim: { ...claim, fencingToken: 8 } }),
            { mode: 0o600 },
        );
        await assert.rejects(requireStoppedHistory(root), /RECOVERY/);
        const records = await ProcessRecords.open(join(root, "processes"));
        assert.ok(records);
        try {
            await assert.rejects(records.names(1), /LIMIT/);
        } finally {
            await records.close();
        }
    }));
