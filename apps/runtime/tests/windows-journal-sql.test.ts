import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { canonicalBytes, type PlatformComponents } from "@veriq/contracts";
import { WindowsAttemptJournal, type WindowsAttemptRecord } from "../src/execution/windows-journal.ts";

test("SQLite upgrades the old journal, resumes claim IDs and durably rotates settled rows", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "vq-sql-archive-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const active = join(root, "journal");
    if (process.platform === "win32") {
        const { windowsNative } = await import("../src/native/windows.ts");
        windowsNative().privatePath(active, true);
    } else {
        await mkdir(active);
        // 在其他平台上使用临时目录替代专用原生访问控制句柄，仍用真实磁盘数据库验证与平台无关的事务及恢复逻辑。
        t.mock.method(WindowsAttemptJournal, "open", async (base: string, prefix?: string) => {
            const path = prefix ? join(base, "settled-journals", prefix) : join(base, "journal");
            await mkdir(path, { recursive: true });
            return Reflect.get(WindowsAttemptJournal, "connect")(base, path, { validate() {}, close() {} });
        });
    }
    const db = new DatabaseSync(join(active, "veriq-online.sqlite"));
    const baseClaim = {
        jobId: randomUUID(),
        jobKind: "VALIDATE",
        leaseToken: "original-test-lease-token",
        fencingToken: 1,
        snapshotUrl: "https://control.invalid/snapshot",
        snapshotSha256: "a".repeat(64),
        serverTime: "2026-11-19T12:00:00Z",
        expiresAt: "2026-11-19T12:01:00Z",
        leaseDurationMs: 60000,
        activationRequired: true,
    } as const;
    const makeRecord = (n: number): WindowsAttemptRecord => {
        const attemptId = "11111111-1111-4111-8111-" + n.toString(16).padStart(12, "0");
        return { claim: { ...baseClaim, attemptId }, state: "ALLOCATED", work: join(root, "work", attemptId) };
    };
    try {
        db.exec(`PRAGMA journal_mode=WAL; PRAGMA user_version=1;
            CREATE TABLE veriq_online_attempts(attempt_id TEXT PRIMARY KEY, claim TEXT NOT NULL,
                document TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL); BEGIN;`);
        const insert = db.prepare("INSERT INTO veriq_online_attempts VALUES(?,?,?,?,?)");
        for (let n = 0; n < 4096; n++) {
            const record = makeRecord(n);
            insert.run(
                record.claim.attemptId,
                Buffer.from(canonicalBytes(record.claim)).toString(),
                JSON.stringify(record),
                record.state,
                baseClaim.serverTime,
            );
        }
        db.exec("COMMIT");
    } finally {
        db.close();
    }
    const legacy: PlatformComponents["schemas"]["ClaimRequest"] = {
        runnerId: randomUUID(),
        clientRequestId: randomUUID(),
        capabilities: {
            engineVersion: "1.0.0",
            os: "win32",
            arch: "x64",
            browsers: ["chromium"],
        },
        availableSlots: 1,
    };
    let journal = await WindowsAttemptJournal.open(root);
    try {
        journal.save(makeRecord(4096));
        assert.equal(Array.from(journal.records()).length, 4097);
        journal.publishRequest(legacy, true);
        journal.close();
        journal = await WindowsAttemptJournal.open(root);
        assert.deepEqual(journal.pendingRequest(), legacy);
        journal.clearRequest(legacy);
        journal.publishRequest(legacy, true);
        assert.equal(journal.pendingRequest(), undefined);
        const next = { ...legacy, runnerId: randomUUID(), clientRequestId: randomUUID() };
        journal.publishRequest(next);
        assert.deepEqual(journal.pendingRequest(), next);
        journal.clearRequest();

        const record = makeRecord(1);
        record.stop = {
            attemptId: record.claim.attemptId,
            processStopped: true,
            processStopScope: "NO_PROCESS_SPAWNED",
            stoppedAt: baseClaim.serverTime,
            reason: "NO_PROCESS_SPAWNED",
        };
        journal.save(record);
        await journal.archive(record);
        // 模拟归档已提交、活动记录仍在时的恢复点，再次处理仍只保留同一原始认领，其他活动记录不会被误删。
        const duplicate = makeRecord(1);
        journal.save(duplicate);
        journal.save(record);
        await journal.archive(record);
        assert.equal(Array.from(journal.records()).length, 4096);
        const bucket = await WindowsAttemptJournal.open(root, "11");
        try {
            assert.deepEqual(Array.from(bucket.records()), [record]);
        } finally {
            bucket.close();
        }
    } finally {
        journal.close();
    }
});
