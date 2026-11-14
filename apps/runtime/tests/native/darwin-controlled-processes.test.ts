/** 此 suite 只允许在真实 macOS 执行，固定 Chrome 与 B 原生文件层都必须实际存在；可信夹具隔离 Agent/outer 组件而保留真实 CLI、直接 child、公共浏览器连接和原对象退出，不据此宣称完整业务、安装入口或整个平台已经就绪。 */
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
import { ProcessSupervisor, type OwnedProcess } from "../../src/execution/processes.ts";
import { ProcessRecords } from "../../src/execution/records.ts";
import { requireStoppedHistory } from "../../src/execution/stopped-history.ts";

assert.equal(process.platform, "darwin", "This suite requires actual macOS; Linux is not substitute evidence");
const worker = fileURLToPath(new URL("../fixtures/darwin-controlled-worker.mjs", import.meta.url));

/** 原始 BrowserServer 与实际 Chrome 对象由测试额外保留用于故障后的可靠清理，包装仍执行真实公共 launchServer 且核对 sandbox 与端点约束；finally 仅操作本次所得原对象并等 exit，不扫描 PID 或删除未退出写者仍需的日志。 */
async function fixture(run: (f: { root: string; work: string; processes: ProcessSupervisor; id: string; launch: (scenario?: string, kind?: "TEST" | "VALIDATE" | "CLEANUP", prepare?: (context: any) => Promise<void> | void) => Promise<OwnedProcess>; servers: BrowserServer[] }) => Promise<void>, timeoutMs = 30000) {
    const source = await import("../../src/execution/darwin-source.ts").catch((error) => {
        if (error.code === "ERR_MODULE_NOT_FOUND") return {};
        throw error;
    });
    assert.ok("createDarwinSource" in source, "actual Darwin source ownership capability must be implemented");
    const root = await mkdtemp(join(await realpath(tmpdir()), "veriq-c2b1-"));
    const work = join(root, "work");
    await mkdir(work, { mode: 0o700 });
    const servers: BrowserServer[] = [], exits: Promise<unknown>[] = [];
    const launchServer = chromium.launchServer.bind(chromium);
    chromium.launchServer = async (options) => {
        assert.equal(options?.executablePath, chromium.executablePath());
        assert.equal(options?.chromiumSandbox, true);
        assert.equal(options?.host, "127.0.0.1");
        assert.equal(options?.port, 0);
        assert.ok(!options?.args?.includes("--no-sandbox"));
        for (const key of ["NODE_OPTIONS", "DEBUG", "DYLD_INSERT_LIBRARIES", "VERIQ_AGENT_TEST_SECRET"]) assert.equal(options?.env?.[key], undefined);
        const server = await launchServer(options);
        servers.push(server);
        const child = server.process();
        exits.push(new Promise((resolve) => { child.once("exit", resolve); }));
        return server;
    };
    const id = randomUUID();
    let processes: ProcessSupervisor | undefined;
    try {
        const capability = await source.createDarwinSource({ temporaryDirectory: root, stopTimeoutMs: timeoutMs });
        processes = new ProcessSupervisor(join(root, "processes"), 500, undefined, capability);
        const owned: ChildProcess[] = [];
        await run({ root, work, processes, id, servers, async launch(scenario = "normal", kind = "TEST", prepare) {
            const result = await processes!.start(id, { executable: process.execPath, args: [worker, join(work, "invocation.json")], cwd: work, env: { PATH: "/usr/bin:/bin" } }, {
                kind, ownerGeneration: 7, async prepare(context) {
                    context.publish("invocation.json", Buffer.from(JSON.stringify({ kind, scenario, work, controlled: context.controlled, wsEndpoint: context.wsEndpoint })));
                    await prepare?.(context);
                },
            });
            owned.push(result.child);
            return result;
        } });
        for (const child of owned) assert.ok(child.exitCode !== null || child.signalCode !== null, "fixture must observe outer exit before cleanup");
    } finally {
        await processes?.terminateAttempt(id, "TEST_FINALLY");
        for (const server of servers) {
            const child = server.process();
            if (child.exitCode === null && child.signalCode === null) await server.kill();
        }
        await Promise.all(exits);
        chromium.launchServer = launchServer;
        await rm(root, { recursive: true, force: true });
    }
}

/** 正常路径明确在真实 outer 与 Chrome 仍活着时拒绝证明，随后从日志和实际 exit 生成私有配对，重新构造无启动能力的监督器仍能只读确认；端点只能存在于私有工作配置，不能进入任何过程证明或日志。 */
for (const scenario of ["normal", "business-failure"]) test(`actual native Chrome and controlled CLI ${scenario} commit read-only restart proof`, async () => fixture(async ({ root, processes, id, launch, servers }) => {
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
    await assert.rejects(restarted.start(randomUUID(), { executable: process.execPath, args: [], cwd: root }), /UNSUPPORTED/);
    const forbidden = [servers[0]!.wsEndpoint(), new URL(servers[0]!.wsEndpoint()).pathname];
    for (const file of [join(root, "processes", `${id}.process.json`), join(root, "processes", `${id}.controlled.json`), join(root, "controlled-journals", id, "command.jsonl"), join(root, "controlled-journals", id, "cli.jsonl")]) {
        const bytes = await readFile(file, "utf8");
        for (const secret of forbidden) assert.ok(!bytes.includes(secret));
    }
    assert.deepEqual((await readdir(join(root, "processes"))).sort(), [`${id}.controlled.json`, `${id}.process.json`].sort());
}));

/** 显式无浏览器的两种任务仍运行真实命令前缀且 CLI 原始日志保持空，证明必须保留计划缺席而不是从对象丢失推断缺席；复用已经占用的 Attempt 不得覆盖任何旧身份、日志或已提交停止证明。 */
for (const kind of ["VALIDATE", "CLEANUP"] as const) test(`${kind} records explicit browser absence and empty CLI journal`, async () => fixture(async ({ root, processes, id, launch, servers }) => {
    const owned = await launch("normal", kind);
    owned.send({ type: "START" });
    await owned.exited;
    assert.equal((await processes.terminateAttempt(id, "COMPLETED")).processStopped, true);
    assert.equal(servers.length, 0);
    assert.equal((await readFile(join(root, "controlled-journals", id, "cli.jsonl"))).length, 0);
    assert.equal(JSON.parse(await readFile(join(root, "processes", `${id}.controlled.json`), "utf8")).chrome, null);
    await assert.rejects(launch("normal", kind), /ALREADY|EXISTS/);
}));

/** CLI 自己通过本地 socket 屏障证明已经装好 SIGINT 处理且页面操作完成，随后父层先持久授权再取消并只接受正常一百三十；ACK 的存在不参与停止判断，直接 child、CLI、outer 和 Chrome 都仍须实际退出。 */
test("authorized cancellation closes actual CLI, outer and Chrome before proof", async () => fixture(async ({ work, processes, id, launch }) => {
    let accept!: (socket: Socket) => void;
    const ready = new Promise<Socket>((resolve) => { accept = resolve; });
    const sockets: Socket[] = [];
    const server = createServer((socket) => { sockets.push(socket); socket.once("data", () => accept(socket)); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const owned = await launch("cancel", "TEST", (context) => {
            context.publish("invocation.json", Buffer.from(JSON.stringify({ kind: "TEST", scenario: "cancel", work, controlled: context.controlled, wsEndpoint: context.wsEndpoint, port: address.port })));
        });
        owned.send({ type: "START" });
        await ready;
        const first = processes.terminateAttempt(id, "CANCELLED"), second = processes.terminateAttempt(id, "REPEATED");
        assert.equal(first, second);
        assert.equal((await first).processStopped, true);
        assert.equal((await owned.exited).code, 130);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}));

/** 观察故障的退出码与缺少封存不能被随后真实退出抹除，原始日志会保留用于排查且重启只能得出未确认；这里的故障属于组件边界，不能把同进程夹具当成真实 Agent 操作系统崩溃的验收。 */
for (const scenario of ["missing-seal", "cli-fault", "outer-signal"]) test(`${scenario} remains unknown after actual member exits`, async () => fixture(async ({ root, processes, id, launch }) => {
    const owned = await launch(scenario);
    owned.send({ type: "START" });
    await owned.exited;
    assert.equal((await processes.terminateAttempt(id, "FAULT")).processStopped, false);
    assert.equal(await new ProcessSupervisor(join(root, "processes")).confirmStopped(id), false);
}));

test("missing or stale actual Worker READY cannot register or publish proof", async () => {
    for (const scenario of ["no-ready", "stale-ready"]) await fixture(async ({ root, processes, id, launch }) => {
        await assert.rejects(launch(scenario), /READY|PROTOCOL|TIMEOUT/);
        assert.equal((await processes.terminateAttempt(id, "FAULT")).processStopped, false);
        assert.equal(await new ProcessSupervisor(join(root, "processes")).confirmStopped(id), false);
    }, 1500);
});

/** prepare 的受信发布能力只支持既定两个配置成员，父层取消即使发生于 await 中也必须阻止后来 outer 派生；持久意图与已启动 Chrome 使该路径保持未知，不能因为没有 outer 对象而编造没有任何派生。 */
test("cancellation during preparation closes admission before a late startup can spawn outer", async () => fixture(async ({ processes, id, launch }) => {
    let release!: () => void, entered!: () => void;
    const prepared = new Promise<void>((resolve) => { entered = resolve; });
    const pause = new Promise<void>((resolve) => { release = resolve; });
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

/** 正式历史读取只接受 Darwin 对应的两份提交成员，混入旧平台 proof、孤立成员或不同 fence 都不能通过；观察前后逐字节相同表明迁移不会修复权限、删除 staging 或把不确定历史改成受控停止。 */
test("private history rejects mixed proofs, orphan members and stale claim generation read-only", async () => fixture(async ({ root, processes, id, launch }) => {
    const owned = await launch("normal", "VALIDATE");
    owned.send({ type: "START" });
    await owned.exited;
    assert.equal((await processes.terminateAttempt(id, "COMPLETED")).processStopped, true);
    const attempts = join(root, "attempts");
    await mkdir(attempts, { mode: 0o700 });
    const claim = { jobId: randomUUID(), attemptId: id, jobKind: "TEST", leaseToken: "public-component-history", fencingToken: 7, expiresAt: "2026-11-14T02:00:00Z", serverTime: "2026-11-14T01:59:00Z", leaseDurationMs: 60000, activationRequired: true, snapshotUrl: "https://control.example/snapshot", snapshotSha256: "a".repeat(64) };
    const history = { claim, state: "STOPPED", work: join(root, "work", id) };
    await writeFile(join(attempts, `${id}.json`), JSON.stringify(history), { mode: 0o600 });
    await requireStoppedHistory(root);
    const recordPath = join(root, "processes", `${id}.process.json`), before = await readFile(recordPath);
    await writeFile(join(root, "processes", `${id}.drained.json`), "{}", { mode: 0o600 });
    assert.equal(await processes.confirmStopped(id), false);
    await assert.rejects(requireStoppedHistory(root), /RECOVERY/);
    assert.deepEqual(await readFile(recordPath), before);
    await rm(join(root, "processes", `${id}.drained.json`));
    await writeFile(join(attempts, `${id}.json`), JSON.stringify({ ...history, claim: { ...claim, fencingToken: 8 } }), { mode: 0o600 });
    await assert.rejects(requireStoppedHistory(root), /RECOVERY/);
    const records = await ProcessRecords.open(join(root, "processes"));
    assert.ok(records);
    try { await assert.rejects(records.names(1), /LIMIT/); } finally { await records.close(); }
}));
