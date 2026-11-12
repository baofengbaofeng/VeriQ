/** Native host persistence; renderer callers never receive SQL or database paths. */
import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionEventV1, OfflineResultV1 } from '@veriq/contracts';
import type { StopReceipt } from '../execution/processes.ts';
import { privateDirectory } from './config.ts';
type Ownership = {
    workspaceId: string;
    runId: string;
    attemptId: string;
    state: string;
};
export class LocalStore {
    private constructor(readonly directory: string, private db: DatabaseSync) { }
    static async open(directory: string): Promise<LocalStore> {
        await privateDirectory(directory);
        const path = join(directory, 'veriq.sqlite');
        try {
            const st = await lstat(path);
            if (!st.isFile() || st.isSymbolicLink())
                throw new Error('UNSAFE_LOCAL_STORE');
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                throw e;
        }
        const db = new DatabaseSync(path);
        await chmod(path, 0o600);
        db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS veriq_local_runs (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_at TEXT NOT NULL,
        state TEXT NOT NULL, result TEXT, upload_state TEXT NOT NULL DEFAULT 'PENDING',
        upload_receipt TEXT, upload_error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS veriq_local_owner (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), run_id TEXT NOT NULL REFERENCES veriq_local_runs(id),
        workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS veriq_local_events (
        run_id TEXT NOT NULL REFERENCES veriq_local_runs(id), attempt_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(attempt_id, sequence));
      CREATE TABLE IF NOT EXISTS veriq_local_stops (
        attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES veriq_local_runs(id), receipt TEXT NOT NULL);
      PRAGMA user_version=1;`);
        return new LocalStore(directory, db);
    }
    close() { this.db.close(); }
    private transaction<T>(fn: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const value = fn();
            this.db.exec('COMMIT');
            return value;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    active(): Ownership | undefined {
        return this.db.prepare('SELECT workspace_id AS workspaceId, run_id AS runId, attempt_id AS attemptId, state FROM veriq_local_owner WHERE singleton=1').get() as Ownership | undefined;
    }
    reserve(workspaceId: string, runId: string, attemptId: string, initial?: OfflineResultV1) {
        this.transaction(() => {
            if (this.active())
                throw new Error('LOCAL_CAPACITY_HELD');
            this.db.prepare('INSERT INTO veriq_local_runs(id,workspace_id,created_at,state) VALUES(?,?,?,?)').run(runId, workspaceId, new Date().toISOString(), 'RUNNING');
            this.db.prepare('INSERT INTO veriq_local_owner VALUES(1,?,?,?,?)').run(runId, workspaceId, attemptId, 'ALLOCATED');
            if (initial) this.checkpoint(initial);
        });
    }
    spawning(runId: string, attemptId: string) {
        const result = this.db.prepare("UPDATE veriq_local_owner SET state='SPAWNING' WHERE run_id=? AND attempt_id=? AND state='ALLOCATED'").run(runId, attemptId);
        if (!result.changes)
            throw new Error('LOCAL_OWNERSHIP_LOST');
    }
    nextAttempt(runId: string, attemptId: string) {
        const result = this.db.prepare("UPDATE veriq_local_owner SET state='ALLOCATED', attempt_id=? WHERE run_id=? AND state='STOPPED'").run(attemptId, runId);
        if (!result.changes)
            throw new Error('LOCAL_CAPACITY_HELD');
    }
    stopped(runId: string, receipt: StopReceipt) {
        this.transaction(() => {
            const owner = this.active();
            if (!owner || owner.runId !== runId || owner.attemptId !== receipt.attemptId)
                throw new Error('LOCAL_OWNERSHIP_LOST');
            this.db.prepare('INSERT INTO veriq_local_stops VALUES(?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET receipt=excluded.receipt').run(receipt.attemptId, runId, JSON.stringify(receipt));
            this.db.prepare('UPDATE veriq_local_owner SET state=? WHERE singleton=1').run(receipt.processStopped ? 'STOPPED' : 'QUARANTINED');
        });
    }
    append(runId: string, event: ExecutionEventV1) {
        this.transaction(() => {
            const last = this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence, COUNT(*) AS count FROM veriq_local_events WHERE attempt_id=?').get(event.attemptId)!;
            if (Number(last.sequence) + 1 !== event.sequence || Number(last.count) >= 10000)
                throw new Error('INVALID_LOCAL_EVENT_SEQUENCE');
            if (Buffer.byteLength(JSON.stringify(event)) > 65536)
                throw new Error('LOCAL_EVENT_LIMIT');
            this.db.prepare('INSERT INTO veriq_local_events VALUES(?,?,?,?)').run(runId, event.attemptId, event.sequence, JSON.stringify(event));
        });
    }
    events(workspaceId: string, runId: string, attemptId: string, after = 0, limit = 100): ExecutionEventV1[] {
        this.authorize(workspaceId, runId);
        if (!Number.isSafeInteger(after) || after < 0 || limit < 1 || limit > 10000)
            throw new Error('INVALID_HISTORY_PAGE');
        return this.db.prepare('SELECT document FROM veriq_local_events WHERE run_id=? AND attempt_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(runId, attemptId, after, limit).map(row => JSON.parse(String(row.document)) as ExecutionEventV1);
    }
    checkpoint(result: OfflineResultV1) {
        this.authorize(result.workspaceId, result.localRunId);
        if (this.active()?.runId !== result.localRunId)
            throw new Error("LOCAL_OWNERSHIP_LOST");
        this.db.prepare("UPDATE veriq_local_runs SET result=? WHERE id=?").run(JSON.stringify(result), result.localRunId);
    }
    finish(result: OfflineResultV1) {
        this.transaction(() => {
            this.authorize(result.workspaceId, result.localRunId);
            const owner = this.active();
            if (!owner || owner.runId !== result.localRunId)
                throw new Error('LOCAL_OWNERSHIP_LOST');
            const state = owner.state === 'STOPPED' ? 'FINISHED' : 'QUARANTINED';
            this.db.prepare('UPDATE veriq_local_runs SET result=?,state=? WHERE id=?').run(JSON.stringify(result), state, result.localRunId);
            if (state === 'FINISHED')
                this.db.prepare('DELETE FROM veriq_local_owner WHERE run_id=?').run(result.localRunId);
        });
    }
    private authorize(workspaceId: string, runId: string) {
        const row = this.db.prepare('SELECT * FROM veriq_local_runs WHERE id=? AND workspace_id=?').get(runId, workspaceId);
        if (!row)
            throw new Error('LOCAL_RUN_NOT_FOUND');
        return row;
    }
    result(workspaceId: string, runId: string): OfflineResultV1 {
        const row = this.authorize(workspaceId, runId);
        if (!row.result)
            throw new Error('LOCAL_RUN_UNFINISHED');
        return JSON.parse(String(row.result)) as OfflineResultV1;
    }
    history(workspaceId: string, limit = 100) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
            throw new Error('INVALID_HISTORY_PAGE');
        return this.db.prepare('SELECT id, created_at AS createdAt, state, upload_state AS uploadState, upload_error AS uploadError FROM veriq_local_runs WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(workspaceId, limit);
    }
    cancel(workspaceId: string, runId: string) { this.authorize(workspaceId, runId); this.db.prepare('UPDATE veriq_local_runs SET cancel_requested=1 WHERE id=?').run(runId); }
    cancelled(runId: string) { return this.db.prepare('SELECT cancel_requested FROM veriq_local_runs WHERE id=?').get(runId)?.cancel_requested === 1; }
    uploaded(workspaceId: string, runId: string, receipt: unknown) { this.authorize(workspaceId, runId); this.db.prepare("UPDATE veriq_local_runs SET upload_state='COMPLETE',upload_receipt=?,upload_error=NULL WHERE id=?").run(JSON.stringify(receipt), runId); }
    uploadFailed(workspaceId: string, runId: string, code: string) { this.authorize(workspaceId, runId); this.db.prepare("UPDATE veriq_local_runs SET upload_state='PENDING',upload_error=? WHERE id=?").run(/^[A-Z_]{1,80}$/.test(code) ? code : 'UPLOAD_FAILED', runId); }
}
