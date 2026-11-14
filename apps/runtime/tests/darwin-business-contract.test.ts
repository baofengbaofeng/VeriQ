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
