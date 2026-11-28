/**
 * 在线历史守卫测试使用生产原生守护和真实持久排空证明，迁移只能观察已有停止事实而不能发送停止请求；内存密钥后端仅隔离当
 * 前主机没有的系统服务，历史内容和业务进程始终由真实代码创建。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalBytes } from "@veriq/contracts";
import { ProcessSupervisor } from "../src/execution/processes.ts";
import { WindowsAttemptJournal, type WindowsAttemptRecord } from "../src/execution/windows-journal.ts";
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

/**
 * 正常历史在 Windows 使用真实原生日志保存原始 Claim 并读回，先经过正式分配提交再推进状态；其它平台仍保留原 JSON
 * 路径，不能把 Windows 明确拒绝的旧记录用作新的可信提交来源。
 */
async function saveAttempt(directory: string, id: string, value: unknown): Promise<void> {
    if (process.platform !== "win32") {
        await updatePrivate(join(directory, "agent/attempts"), `${id}.json`, () => value);
        return;
    }
    const journal = await WindowsAttemptJournal.open(join(directory, "agent"));
    try {
        const record = value as WindowsAttemptRecord;
        if (![...journal.records()].some((saved) => saved.claim.attemptId === id)) {
            const allocated = { ...record, state: "ALLOCATED" as const };
            delete allocated.stop;
            journal.save(allocated);
        }
        journal.save(record);
        assert.deepEqual([...journal.records()], [record]);
    } finally {
        journal.close();
    }
}

/**
 * 负例只在本次已由原生初始化的数据库内替换指定行，模拟保存后的损坏而不要求生产写入器接受非法内容；恢复已知原行
 * 也限于该合成夹具，不给迁移入口增加修复、导入旧 JSON 或放宽校验的能力。
 */
async function replaceAttempt(directory: string, id: string, value: unknown): Promise<void> {
    if (process.platform !== "win32") {
        await updatePrivate(join(directory, "agent/attempts"), `${id}.json`, () => value);
        return;
    }
    const journal = await WindowsAttemptJournal.open(join(directory, "agent"));
    let db: DatabaseSync | undefined;
    try {
        db = new DatabaseSync(join(directory, "agent/journal/veriq-online.sqlite"), { timeout: 3000 });
        db.exec("PRAGMA synchronous=FULL");
        const record = value as WindowsAttemptRecord;
        assert.equal(
            db
                .prepare("UPDATE veriq_online_attempts SET claim=?,document=?,state=? WHERE attempt_id=?")
                .run(Buffer.from(canonicalBytes(record.claim)).toString(), JSON.stringify(record), record.state, id)
                .changes,
            1,
        );
    } finally {
        try {
            db?.close();
        } finally {
            journal.close();
        }
    }
}

/**
 * 观察前后比较 Windows 原始数据库行的 Claim、文档、状态和时间字节，原生只读会话保持父链；其它平台继续比较原
 * JSON 文件，保证迁移守卫没有借只读核验重写历史或补造停止证据。
 */
async function attemptBytes(directory: string, id: string): Promise<Buffer> {
    if (process.platform !== "win32") return readFile(join(directory, "agent/attempts", `${id}.json`));
    const journal = await WindowsAttemptJournal.openExisting(join(directory, "agent"));
    assert(journal);
    let db: DatabaseSync | undefined;
    try {
        assert.equal([...journal.records()].length, 1);
        db = new DatabaseSync(join(directory, "agent/journal/veriq-online.sqlite"), { timeout: 3000, readOnly: true });
        return Buffer.from(
            JSON.stringify(
                db
                    .prepare(
                        "SELECT attempt_id,claim,document,state,updated_at FROM veriq_online_attempts " +
                            "WHERE attempt_id=?",
                    )
                    .get(id),
            ),
        );
    } finally {
        try {
            db?.close();
        } finally {
            journal.close();
        }
    }
}
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
        const records = join(directory, "agent", "processes");
        const processes = new ProcessSupervisor(records);
        await saveAttempt(directory, id, {
            claim: value,
            state: "STOPPED",
            work: join(directory, "agent", "work", id),
        });
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
            const stopped = {
                claim: value,
                state: "STOPPED",
                work: join(directory, "agent", "work", id),
                stop: receipt,
            };
            await saveAttempt(directory, id, stopped);
            const names = [join(records, `${id}.process.json`), join(records, `${id}.drained.json`)];
            const before = [
                await attemptBytes(directory, id),
                ...(await Promise.all(names.map((name) => readFile(name)))),
            ];
            await profile.migrate();
            assert.deepEqual(
                [await attemptBytes(directory, id), ...(await Promise.all(names.map((name) => readFile(name))))],
                before,
            );
            for (const stop of [
                { ...receipt, attemptId: randomUUID() },
                { ...receipt, processStopScope: "NO_PROCESS_SPAWNED" },
                { ...receipt, processStopScope: "CONTROLLED_WORKER_BROWSER" },
                { ...receipt, processStopScope: "UNKNOWN" },
                { ...receipt, processStopped: "true" },
                { ...receipt, stoppedAt: "not-a-timestamp" },
                { ...receipt, extra: true },
            ]) {
                await replaceAttempt(directory, id, {
                    claim: value,
                    state: "STOPPED",
                    work: join(directory, "agent", "work", id),
                    stop,
                });
                await assert.rejects(profile.migrate(), /VAULT_RUNTIME_RECOVERY_REQUIRED/);
            }
            await replaceAttempt(directory, id, stopped);
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
        const records = join(directory, "agent", "processes");
        const record = {
            claim: value,
            state: "ACTIVATED",
            work: join(directory, "agent", "work", id),
        };
        await saveAttempt(directory, id, record);
        await profile.migrate();
        const stop = {
            attemptId: id,
            processStopped: true,
            processStopScope: "NO_PROCESS_SPAWNED",
            reason: "NO_PROCESS_SPAWNED",
            stoppedAt: new Date().toISOString(),
        };
        await saveAttempt(directory, id, { ...record, stop });
        await profile.migrate();
        await replaceAttempt(directory, id, {
            ...record,
            state: "STOPPED",
            stop: { ...stop, processStopScope: "FULL_DESCENDANT_TREE" },
        });
        await assert.rejects(profile.migrate(), /VAULT_RUNTIME_RECOVERY_REQUIRED/);
        await replaceAttempt(directory, id, {
            ...record,
            claim: { attemptId: id },
        });
        await assert.rejects(profile.migrate(), /VAULT_RUNTIME_RECOVERY_REQUIRED/);
        await replaceAttempt(directory, id, record);
        await updatePrivate(records, `${randomUUID()}.process.json`, () => ({ state: "STOPPED" }));
        await assert.rejects(profile.migrate(), /VAULT_RUNTIME_RECOVERY_REQUIRED/);
    }));

/**
 * 文件边界用有限真实私有成员验证严格解析和扫描上限，不依赖源字符串或伪造操作系统结果；过大记录、未知成员和身份错配都必
 * 须让迁移保持拒绝，已有有效历史字节不因观察失败而被修复或丢弃。
 */
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
