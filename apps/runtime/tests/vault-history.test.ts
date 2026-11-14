/** 在线历史守卫测试使用生产原生守护和真实持久排空证明，迁移只能观察已有停止事实而不能发送停止请求；内存密钥后端仅隔离当前主机没有的系统服务，历史内容和业务进程始终由真实代码创建。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ProcessSupervisor } from "../src/execution/processes.ts";
import { CredentialProfile } from "../src/credentials/profile.ts";
import { privateDirectory, updatePrivate } from "../src/offline/config.ts";
import type { VaultKeyBackend, VaultKeyScope } from "../src/credentials/backend.ts";

const claim = () => ({
    jobId: randomUUID(),
    attemptId: randomUUID(),
    jobKind: "TEST",
    leaseToken: "synthetic-public-history-lease",
    fencingToken: 1,
    expiresAt: "2026-11-14T02:00:00Z",
    serverTime: "2026-11-14T01:59:00Z",
    leaseDurationMs: 60000,
    activationRequired: true,
    snapshotUrl: "https://control.example/snapshot",
    snapshotSha256: "a".repeat(64),
});
async function fixture(run: (directory: string, profile: CredentialProfile) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "veriq-history-"));
    const directory = join(root, "profile");
    const keys = new Map<string, Buffer>();
    const backend: VaultKeyBackend = {
        async get(scope: VaultKeyScope) {
            const key = keys.get(JSON.stringify(scope));
            return key ? { status: "ok", key: Buffer.from(key) } : { status: "missing" };
        },
        async set(scope: VaultKeyScope, key: Buffer) {
            keys.set(JSON.stringify(scope), Buffer.from(key));
            return { status: "ok" };
        },
        async delete(scope: VaultKeyScope) {
            return { status: keys.delete(JSON.stringify(scope)) ? "ok" : "missing" };
        },
        async probe() {
            return { status: "ready" };
        },
    };
    try {
        await privateDirectory(directory);
        await run(directory, new CredentialProfile(directory, { backend }));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("migration observes a real drained history without signaling a live worker or changing records", async () =>
    fixture(async (directory, profile) => {
        const value = claim(),
            id = value.attemptId;
        const attempts = join(directory, "agent", "attempts"),
            records = join(directory, "agent", "processes");
        const processes = new ProcessSupervisor(records);
        await updatePrivate(attempts, `${id}.json`, () => ({
            claim: value,
            state: "STOPPED",
            work: join(directory, "agent", "work", id),
        }));
        try {
            const child = await processes.start(id, {
                executable: process.execPath,
                args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
                cwd: directory,
                env:
                    process.platform === "win32"
                        ? { SystemRoot: process.env.SystemRoot!, PATH: process.env.PATH! }
                        : {},
            });
            assert.equal(await child.firstLine(), "ready");
            await assert.rejects(profile.migrate(), /VAULT_RUNTIME_RECOVERY_REQUIRED/);
            assert.equal(await processes.isRunning(child.pid), true);
            const receipt = await processes.terminateAttempt(id, "TEST_STOP");
            assert.equal(receipt.processStopped, true);
            await updatePrivate(attempts, `${id}.json`, () => ({
                claim: value, state: "STOPPED", work: join(directory, "agent", "work", id), stop: receipt,
            }));
            const names = [
                join(attempts, `${id}.json`),
                join(records, `${id}.process.json`),
                join(records, `${id}.drained.json`),
            ];
            const before = await Promise.all(names.map((name) => readFile(name)));
            await profile.migrate();
            assert.deepEqual(await Promise.all(names.map((name) => readFile(name))), before);
            for (const stop of [
                { ...receipt, attemptId: randomUUID() },
                { ...receipt, processStopScope: "NO_PROCESS_SPAWNED" },
                { ...receipt, processStopScope: "CONTROLLED_WORKER_BROWSER" },
                { ...receipt, processStopScope: "UNKNOWN" },
                { ...receipt, processStopped: "true" },
                { ...receipt, stoppedAt: "not-a-timestamp" },
                { ...receipt, extra: true },
            ]) {
                await updatePrivate(attempts, `${id}.json`, () => ({
                    claim: value, state: "STOPPED", work: join(directory, "agent", "work", id), stop,
                }));
                await assert.rejects(profile.migrate(), /VAULT_RUNTIME_RECOVERY_REQUIRED/);
            }
            await updatePrivate(attempts, `${id}.json`, () => ({
                claim: value, state: "STOPPED", work: join(directory, "agent", "work", id), stop: receipt,
            }));
            const proof = JSON.parse(before[2]!.toString());
            await updatePrivate(records, `${id}.drained.json`, () => ({
                ...proof,
                nonce: randomUUID(),
            }));
            await assert.rejects(profile.migrate(), /VAULT_RUNTIME_RECOVERY_REQUIRED/);
        } finally {
            await processes.terminateAttempt(id, "TEST_FINALLY");
        }
    }));

test("migration accepts valid pre-spawn history but rejects a process orphan and malformed claims", async () =>
    fixture(async (directory, profile) => {
        const value = claim(),
            id = value.attemptId;
        const attempts = join(directory, "agent", "attempts"),
            records = join(directory, "agent", "processes");
        const record = {
            claim: value,
            state: "ACTIVATED",
            work: join(directory, "agent", "work", id),
        };
        await updatePrivate(attempts, `${id}.json`, () => record);
        await profile.migrate();
        const stop = { attemptId: id, processStopped: true, processStopScope: "NO_PROCESS_SPAWNED",
            reason: "NO_PROCESS_SPAWNED", stoppedAt: new Date().toISOString() };
        await updatePrivate(attempts, `${id}.json`, () => ({ ...record, stop }));
        await profile.migrate();
        await updatePrivate(attempts, `${id}.json`, () => ({ ...record, state: "STOPPED",
            stop: { ...stop, processStopScope: "FULL_DESCENDANT_TREE" } }));
        await assert.rejects(profile.migrate(), /VAULT_RUNTIME_RECOVERY_REQUIRED/);
        await updatePrivate(attempts, `${id}.json`, () => ({
            ...record,
            claim: { attemptId: id },
        }));
        await assert.rejects(profile.migrate(), /VAULT_RUNTIME_RECOVERY_REQUIRED/);
        await updatePrivate(attempts, `${id}.json`, () => record);
        await updatePrivate(records, `${randomUUID()}.process.json`, () => ({ state: "STOPPED" }));
        await assert.rejects(profile.migrate(), /VAULT_RUNTIME_RECOVERY_REQUIRED/);
    }));

/** 文件边界用有限真实私有成员验证严格解析和扫描上限，不依赖源字符串或伪造操作系统结果；过大记录、未知成员和身份错配都必须让迁移保持拒绝，已有有效历史字节不因观察失败而被修复或丢弃。 */
test("history observation rejects oversized records, mismatched identity and unknown members", async () =>
    fixture(async (directory, profile) => {
        const { ProcessRecords } = await import("../src/execution/records.ts");
        const value = claim(),
            id = value.attemptId;
        const attempts = join(directory, "agent", "attempts");
        const record = {
            claim: value,
            state: "ALLOCATED",
            work: join(directory, "agent", "work", id),
        };
        await updatePrivate(attempts, `${id}.json`, () => ({ ...record, work: "x".repeat(65536) }));
        await assert.rejects(profile.migrate(), /VAULT_RUNTIME_RECOVERY_REQUIRED/);
        await updatePrivate(attempts, `${id}.json`, () => ({
            ...record,
            claim: { ...value, attemptId: randomUUID() },
        }));
        await assert.rejects(profile.migrate(), /VAULT_RUNTIME_RECOVERY_REQUIRED/);
        await updatePrivate(attempts, `${id}.json`, () => record);
        await privateDirectory(join(attempts, "unknown"));
        await assert.rejects(profile.migrate(), /VAULT_RUNTIME_RECOVERY_REQUIRED/);
        await rm(join(attempts, "unknown"), { recursive: true });
        await updatePrivate(attempts, `${randomUUID()}.json`, () => record);
        const observed = await ProcessRecords.open(attempts);
        assert(observed);
        try {
            await assert.rejects(observed.names(1), /PROCESS_RECORD_LIMIT_OR_TYPE/);
        } finally {
            await observed.close();
        }
    }));
