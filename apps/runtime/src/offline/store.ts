/** Native host persistence; renderer callers never receive SQL or database paths. */
import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { validateSchema, type ExecutionEventV1, type OfflineResultV1 } from '@veriq/contracts';
import type { StopReceipt } from '../execution/processes.ts';
import { privateDirectory } from './config.ts';
export type Ownership = {
    workspaceId: string;
    runId: string;
    attemptId: string;
    state: string;
    generation: number;
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
        const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
        if (version > 2) {
            db.close();
            throw new Error('LOCAL_STORE_VERSION_UNSUPPORTED');
        }
        db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS veriq_local_runs (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_at TEXT NOT NULL,
        state TEXT NOT NULL, result TEXT, upload_state TEXT NOT NULL DEFAULT 'PENDING',
        upload_receipt TEXT, upload_error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS veriq_local_owner (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), run_id TEXT NOT NULL REFERENCES veriq_local_runs(id),
        workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL, state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS veriq_local_events (
        run_id TEXT NOT NULL REFERENCES veriq_local_runs(id), attempt_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(attempt_id, sequence));
      CREATE TABLE IF NOT EXISTS veriq_local_stops (
        attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES veriq_local_runs(id), receipt TEXT NOT NULL);
      `);
        if (!db.prepare("PRAGMA table_info(veriq_local_owner)").all().some(column => column.name === 'generation'))
            db.exec("ALTER TABLE veriq_local_owner ADD COLUMN generation INTEGER NOT NULL DEFAULT 1");
        db.exec("PRAGMA user_version=2");
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
        return this.db.prepare('SELECT workspace_id AS workspaceId, run_id AS runId, attempt_id AS attemptId, state, generation FROM veriq_local_owner WHERE singleton=1').get() as Ownership | undefined;
    }
    private requireOwner(owner: Ownership): Ownership {
        const current = this.active();
        if (!current || current.runId !== owner.runId || current.attemptId !== owner.attemptId || current.generation !== owner.generation || current.state !== owner.state)
            throw new Error('LOCAL_OWNERSHIP_LOST');
        return current;
    }
    ensureOwner(owner: Ownership): void { this.requireOwner(owner); }
    reserve(workspaceId: string, runId: string, attemptId: string, initial?: OfflineResultV1): Ownership {
        return this.transaction(() => {
            if (this.active())
                throw new Error('LOCAL_CAPACITY_HELD');
            this.db.prepare('INSERT INTO veriq_local_runs(id,workspace_id,created_at,state) VALUES(?,?,?,?)').run(runId, workspaceId, new Date().toISOString(), 'RUNNING');
            this.db.prepare('INSERT INTO veriq_local_owner VALUES(1,?,?,?,?,1)').run(runId, workspaceId, attemptId, 'ALLOCATED');
            const owner = this.active()!;
            if (initial)
                this.checkpoint(initial, owner);
            return owner;
        });
    }
    spawning(runId: string, attemptId: string, owner: Ownership): Ownership {
        return this.transaction(() => {
            this.requireOwner(owner);
            if (owner.runId !== runId || owner.attemptId !== attemptId || owner.state !== 'ALLOCATED')
                throw new Error('LOCAL_OWNERSHIP_LOST');
            this.db.prepare("UPDATE veriq_local_owner SET state='SPAWNING' WHERE singleton=1").run();
            return { ...owner, state: 'SPAWNING' };
        });
    }
    claimRecovery(observed: Ownership): Ownership | undefined {
        return this.transaction(() => {
            const state = ['ALLOCATED', 'RECOVERING_UNSPAWNED'].includes(observed.state) ? 'RECOVERING_UNSPAWNED' : 'RECOVERING';
            const changed = this.db.prepare('UPDATE veriq_local_owner SET state=?,generation=generation+1 WHERE run_id=? AND attempt_id=? AND generation=? AND state=?').run(state, observed.runId, observed.attemptId, observed.generation, observed.state);
            return changed.changes ? { ...observed, state, generation: observed.generation + 1 } : undefined;
        });
    }
    nextAttempt(runId: string, attemptId: string, owner: Ownership, initial: OfflineResultV1): Ownership {
        return this.transaction(() => {
            this.requireOwner(owner);
            if (owner.runId !== runId || owner.state !== 'STOPPED')
                throw new Error('LOCAL_CAPACITY_HELD');
            const next = { ...owner, attemptId, state: 'ALLOCATED', generation: owner.generation + 1 };
            this.db.prepare("UPDATE veriq_local_owner SET state='ALLOCATED',attempt_id=?,generation=? WHERE singleton=1").run(attemptId, next.generation);
            this.checkpoint(initial, next);
            return next;
        });
    }
    stopped(runId: string, receipt: StopReceipt, owner: Ownership): Ownership {
        return this.transaction(() => {
            this.requireOwner(owner);
            if (owner.runId !== runId || owner.attemptId !== receipt.attemptId || (receipt.reason === 'NO_PROCESS_SPAWNED' && !['ALLOCATED', 'RECOVERING_UNSPAWNED'].includes(owner.state)))
                throw new Error('LOCAL_OWNERSHIP_LOST');
            this.db.prepare('INSERT INTO veriq_local_stops VALUES(?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET receipt=excluded.receipt').run(receipt.attemptId, runId, JSON.stringify(receipt));
            const next = { ...owner, state: receipt.processStopped ? 'STOPPED' : 'QUARANTINED' };
            this.db.prepare('UPDATE veriq_local_owner SET state=? WHERE singleton=1').run(next.state);
            return next;
        });
    }
    append(runId: string, event: ExecutionEventV1, owner: Ownership) {
        this.transaction(() => {
            this.requireOwner(owner);
            if (owner.runId !== runId || owner.attemptId !== event.attemptId)
                throw new Error('LOCAL_OWNERSHIP_LOST');
            const last = this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence, COUNT(*) AS count FROM veriq_local_events WHERE attempt_id=?').get(event.attemptId)!;
            if (Number(last.sequence) + 1 !== event.sequence || Number(last.count) >= 10000)
                throw new Error('INVALID_LOCAL_EVENT_SEQUENCE');
            if (Buffer.byteLength(JSON.stringify(event)) > 65536)
                throw new Error('LOCAL_EVENT_LIMIT');
            this.db.prepare('INSERT INTO veriq_local_events VALUES(?,?,?,?)').run(runId, event.attemptId, event.sequence, JSON.stringify(event));
            if (event.type === 'ARTIFACT_CREATED') {
                const descriptor = { ...event.payload.file, artifactId: event.payload.artifactId, kind: event.payload.kind };
                if (validateSchema('OfflineArtifactV1', descriptor).length || !/^[-a-zA-Z0-9_.]{1,240}$/.test(descriptor.path))
                    throw new Error('INVALID_LOCAL_ARTIFACT');
                const result = this.result(owner.workspaceId, runId), attempt = result.attempts.find(a => a.attemptId === owner.attemptId);
                if (!attempt || attempt.artifacts.length >= 100 || attempt.artifacts.some(a => a.artifactId === descriptor.artifactId || a.path === descriptor.path))
                    throw new Error('INVALID_LOCAL_ARTIFACT');
                attempt.artifacts.push(descriptor);
                this.checkpoint(result, owner);
            }
        });
    }
    events(workspaceId: string, runId: string, attemptId: string, after = 0, limit = 100): ExecutionEventV1[] {
        this.authorize(workspaceId, runId);
        if (!Number.isSafeInteger(after) || after < 0 || limit < 1 || limit > 10000)
            throw new Error('INVALID_HISTORY_PAGE');
        return this.db.prepare('SELECT document FROM veriq_local_events WHERE run_id=? AND attempt_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(runId, attemptId, after, limit).map(row => JSON.parse(String(row.document)) as ExecutionEventV1);
    }
    checkpoint(result: OfflineResultV1, owner: Ownership) {
        this.authorize(result.workspaceId, result.localRunId);
        this.requireOwner(owner);
        if (owner.runId !== result.localRunId || !result.attempts.some(a => a.attemptId === owner.attemptId))
            throw new Error("LOCAL_OWNERSHIP_LOST");
        this.db.prepare("UPDATE veriq_local_runs SET result=? WHERE id=?").run(JSON.stringify(result), result.localRunId);
    }
    finish(result: OfflineResultV1, owner: Ownership) {
        this.transaction(() => {
            this.authorize(result.workspaceId, result.localRunId);
            this.requireOwner(owner);
            if (owner.runId !== result.localRunId || !["STOPPED", "QUARANTINED"].includes(owner.state))
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
