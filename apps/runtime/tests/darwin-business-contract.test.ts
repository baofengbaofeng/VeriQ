/** 可移植回归只验证可信能力拒绝和既有内核后端的合同，不修改 process.platform、不模拟 Mac 文件语义，也不把这组通过数算入真实 Mac 业务；新接口缺省与坏数据都必须在业务下载或受控派生之前保持失败关闭。 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionSupervisor, type SupervisorOptions } from "../src/execution/supervisor.ts";
import { ProcessSupervisor } from "../src/execution/processes.ts";
import { runOffline, type OfflineConfig } from "../src/offline/run.ts";
import { requireDarwinSource, type DarwinSourceCapability } from "../src/execution/darwin-source.ts";
import { updatePrivate, readPrivate } from "../src/offline/config.ts";

test("serialized or asserted source objects cannot enable online or offline business", async () => {
    for (const value of [{}, Object.freeze({ supported: true, platform: "darwin" }), JSON.parse('{"darwinSource":true}')]) {
        const capability = value as DarwinSourceCapability;
        assert.throws(() => requireDarwinSource(capability), /DARWIN_SOURCE_CAPABILITY_REQUIRED/);
        assert.throws(() => new ExecutionSupervisor({ darwinSource: capability } as SupervisorOptions), /DARWIN_SOURCE_CAPABILITY_REQUIRED/);
        await assert.rejects(runOffline({ directory: "must-not-be-read" }, { darwinSource: capability } as OfflineConfig), /DARWIN_SOURCE_CAPABILITY_REQUIRED/);
    }
});

test("private JSON updates retain the one MiB caller cap and previous committed state", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "veriq-config-cap-"));
    try {
        await updatePrivate(root, "config.json", () => ({ value: "retained" }));
        await assert.rejects(updatePrivate(root, "config.json", () => ({ value: "x".repeat(1024 * 1024) })), /CONFIGURATION_LIMIT/);
        assert.deepEqual(await readPrivate(root, "config.json"), { value: "retained" });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("the optional Darwin deadline leaves the actual Linux kernel drain unchanged", { skip: process.platform !== "linux" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq-legacy-deadline-"));
    const processes = new ProcessSupervisor(root);
    try {
        const child = await processes.start("legacy-deadline", { executable: process.execPath, args: ["-e", 'console.log("ready");setInterval(()=>{},1000)'], cwd: root });
        await child.firstLine();
        const stop = await processes.terminateAttempt("legacy-deadline", "TEST_STOP", Number.NaN);
        assert.equal(stop.processStopped, true);
        assert.equal(stop.processStopScope, "FULL_DESCENDANT_TREE");
        await child.exited;
    } finally { await processes.terminateAttempt("legacy-deadline", "TEST_FINALLY"); await rm(root, { recursive: true, force: true }); }
});

/** 诊断等待器使用真实 HTTP 监听对象和 AbortSignal 验证提前完成、拒绝与取消都会返回控制流，finally 必须关闭本次资源并移除监听；这些 Promise 只表示夹具调度结果，不伪造 SDK 用例结果、原生停止证明或浏览器退出事实。 */
for (const scenario of ["fulfilled", "rejected", "cancelled", "ready"] as const) test(`business diagnostic watch releases owned resource after ${scenario}`, async () => {
    const { createServer } = await import("node:http");
    const { default: EventEmitter } = await import("node:events");
    const helper = await import("./fixtures/business-engine.ts");
    const server = createServer((_request, response) => response.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController(), before = EventEmitter.getEventListeners(controller.signal, "abort").length;
    let finish!: (value: number) => void, reject!: (error: Error) => void;
    const running = new Promise<number>((resolve, fail) => { finish = resolve; reject = fail; });
    let watch: { waitFor(ready: Promise<unknown>, phase: "BARRIER" | "STOP"): Promise<void>; result(): Promise<number>; close(): void } | undefined;
    try {
        const factory = Reflect.get(helper, "watchBusinessRun");
        assert.equal(typeof factory, "function", "Business diagnostics need an immediate run completion/rejection observer");
        watch = factory(running, controller.signal);
        const readiness = scenario === "ready" ? Promise.resolve() : new Promise<void>(() => {});
        const observed = watch!.waitFor(readiness, "BARRIER");
        if (scenario === "fulfilled") { finish(7); await assert.rejects(observed, /BUSINESS_RUN_COMPLETED_BEFORE_BARRIER/); }
        if (scenario === "rejected") { reject(new Error("private-unprinted-source")); await assert.rejects(observed, /BUSINESS_RUN_REJECTED_BEFORE_BARRIER/); }
        if (scenario === "cancelled") { controller.abort(new Error("private-unprinted-cancellation")); await assert.rejects(observed, /BUSINESS_TEST_CANCELLED/); }
        if (scenario === "ready") { await observed; finish(7); assert.equal(await watch!.result(), 7); }
    } finally {
        finish(7);
        watch?.close();
        await new Promise<void>((resolve, fail) => server.close((error) => error ? fail(error) : resolve()));
    }
    assert.equal(server.listening, false);
    assert.equal(EventEmitter.getEventListeners(controller.signal, "abort").length, before);
});
