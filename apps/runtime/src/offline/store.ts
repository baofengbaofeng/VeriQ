/**
 * 本文件是离线宿主的本机 SQLite 持久化层：渲染调用方永不接触 SQL 或数据库路径：仅暴露受控 Ownership API。
 */

/**
 * SQLite 连接仅由独立宿主创建并保存在受限档案中，渲染进程只能取得经过作用域筛选的状态投影；数据库路径、SQL
 * 与连接能力不通过桌面协议暴露，执行所有权变化必须使用下方事务接口。
 */
import { DatabaseSync } from "node:sqlite";
import { chmod, lstat } from "node:fs/promises";
import { join } from "node:path";
import { validateSchema, type ExecutionEventV1, type OfflineResultV1 } from "@veriq/contracts";
import { isPreSpawnState } from "../execution/pre-spawn.ts";
import type { StopReceipt } from "../execution/processes.ts";
import { privateDirectory } from "./config.ts";
/**
 * 公开类型 Ownership 表示一次离线占用的代际令牌：含工作区、Run/Attempt 与世代：
 * 防止陈旧恢复抢占（Ownership/UNSAFE_LOCAL_STORE）。
 */
export type Ownership = {
    workspaceId: string;
    runId: string;
    attemptId: string;
    state: string;
    generation: number;
};
/**
 * 公开类 LocalStore 管理本机 Run/事件/上传状态：所有写路径都校验 Ownership 代际：关闭后释放数据库锁。
 */
export class LocalStore {
    private constructor(
        readonly directory: string,
        private db: DatabaseSync,
        private nativeDirectory?: { validate(): void; close(): void },
    ) {}
    static async open(directory: string): Promise<LocalStore> {
        await privateDirectory(directory);
        const nativeDirectory =
            process.platform === "win32"
                ? (await import("../native/windows.ts"))
                      .windowsNative()
                      .openPrivateSqliteDirectory(directory, "veriq.sqlite")
                : undefined;
        const path = join(directory, "veriq.sqlite");
        try {
            const st = await lstat(path);
            if (!st.isFile() || st.isSymbolicLink()) throw new Error("UNSAFE_LOCAL_STORE");
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
                nativeDirectory?.close();
                throw e;
            }
        }
        /**
         * 首次读取版本和切换日志模式也可能遇到另一进程持有的真实数据库锁，因此在创建连接时就设置既有三秒忙等待预算；
         * 后续所有权事务沿用同一预算，不增加重试或改变升级判断。
         */
        let db: DatabaseSync;
        try {
            db = new DatabaseSync(path, { timeout: 3000 });
        } catch (error) {
            nativeDirectory?.close();
            throw error;
        }
        try {
            if (process.platform !== "win32") await chmod(path, 0o600);
            const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
            if (version > 2) {
                throw new Error("LOCAL_STORE_VERSION_UNSUPPORTED");
            }
            db.exec(
                `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
                CREATE TABLE IF NOT EXISTS veriq_local_runs (
                    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_at TEXT NOT NULL,
                    state TEXT NOT NULL, result TEXT, upload_state TEXT NOT NULL DEFAULT 'PENDING',
                    upload_receipt TEXT, upload_error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS veriq_local_owner (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1), run_id TEXT NOT NULL REFERENCES veriq_local_ru` +
                    `ns(id),
                    workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL, state TEXT NOT NULL, generation INTEGER NO` +
                    `T NULL DEFAULT 1);
                CREATE TABLE IF NOT EXISTS veriq_local_events (
                    run_id TEXT NOT NULL REFERENCES veriq_local_runs(id), attempt_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(attempt_id, sequence));
                CREATE TABLE IF NOT EXISTS veriq_local_stops (
                    attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES veriq_local_runs(id), receipt TEXT ` +
                    `NOT NULL);
                CREATE TABLE IF NOT EXISTS veriq_local_lifecycle (
                    run_id TEXT PRIMARY KEY REFERENCES veriq_local_runs(id), first_observed INTEGER NOT NULL,
                    last_access INTEGER NOT NULL, raw_retired INTEGER NOT NULL DEFAULT 0, metadata_retired INTEGER N` +
                    `OT NULL DEFAULT 0, last_checked INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS veriq_local_artifact_retirements (
                    run_id TEXT NOT NULL REFERENCES veriq_local_runs(id),attempt_id TEXT NOT NULL,path TEXT NOT NULL,
                    sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL,PRIMARY KEY(run_id,attempt_id,path));
                CREATE TABLE IF NOT EXISTS veriq_local_cache_lifecycle (
                    bundle_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, first_observed INTEGER NOT NULL,
                    last_access INTEGER NOT NULL, retirement TEXT, retired_at INTEGER);
                CREATE TABLE IF NOT EXISTS veriq_local_retention_clock (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1), high_water INTEGER NOT NULL);
                `,
            );
            if (
                !db
                    .prepare("PRAGMA table_info(veriq_local_owner)")
                    .all()
                    .some((column) => column.name === "generation")
            )
                db.exec("ALTER TABLE veriq_local_owner ADD COLUMN generation INTEGER NOT NULL DEFAULT 1");
            db.exec("PRAGMA user_version=2");
            nativeDirectory?.validate();
            return new LocalStore(directory, db, nativeDirectory);
        } catch (error) {
            try {
                db.close();
            } finally {
                nativeDirectory?.close();
            }
            throw error;
        }
    }
    /**
     * 公开方法 close 关闭底层 SQLite 连接：之后任何查询都应失败：避免宿主退出后文件锁残留（
     * close/LOCAL_OWNERSHIP_LOST）。
     */
    close() {
        try {
            this.db.close();
        } finally {
            this.nativeDirectory?.close();
        }
    }
    private transaction<T>(fn: () => T): T {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const value = fn();
            this.nativeDirectory?.validate();
            this.db.exec("COMMIT");
            this.nativeDirectory?.validate();
            return value;
        } catch (error) {
            if (this.db.isTransaction) this.db.exec("ROLLBACK");
            throw error;
        }
    }
    /**
     * 公开方法 active 返回当前占用中的 Ownership：若无活跃离线执行则得到 undefined（active/LOCAL_OWNERSHIP_LOST）。
     */
    active(): Ownership | undefined {
        return this.db
            .prepare(
                "SELECT workspace_id AS workspaceId, run_id AS runId, attempt_id AS attemptId, state, generation FRO" +
                    "M veriq_local_owner WHERE singleton=1",
            )
            .get() as Ownership | undefined;
    }
    /**
     * 凭据迁移持有真实 SQLite 写事务期间必须没有任何持久执行占用，包含未知停止、准备与恢复状态；
     * 同库其他连接或进程无法插入新所有权，调用方只在迁移完成或失败后释放，不能把一次只读检查当作持续空闲证明。
     */
    holdIdle(): () => void {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            if (this.active()) throw new Error("VAULT_RUNTIME_RECOVERY_REQUIRED");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
        let held = true;
        return () => {
            if (!held) throw new Error("LOCAL_IDLE_GUARD_RELEASED");
            this.db.exec("ROLLBACK");
            held = false;
        };
    }
    private requireOwner(owner: Ownership): Ownership {
        const current = this.active();
        if (
            !current ||
            current.workspaceId !== owner.workspaceId ||
            current.runId !== owner.runId ||
            current.attemptId !== owner.attemptId ||
            current.generation !== owner.generation ||
            current.state !== owner.state
        )
            throw new Error("LOCAL_OWNERSHIP_LOST");
        return current;
    }
    /**
     * 公开方法 ensureOwner 校验调用方代际令牌仍拥有该 Run：防止陈旧代际写入新状态（ensureOwner/LOCAL_CAPACITY_HELD）。
     */
    ensureOwner(owner: Ownership): void {
        this.requireOwner(owner);
    }
    /**
     * 公开方法 reserve 为离线 Run 预留本机占用：写入初始结果骨架：冲突时拒绝抢占他人代际（
     * reserve/LOCAL_CAPACITY_HELD）。
     */
    reserve(workspaceId: string, runId: string, attemptId: string, initial?: OfflineResultV1): Ownership {
        return this.transaction(() => {
            if (this.active()) throw new Error("LOCAL_CAPACITY_HELD");
            this.db
                .prepare("INSERT INTO veriq_local_runs(id,workspace_id,created_at,state) VALUES(?,?,?,?)")
                .run(runId, workspaceId, new Date().toISOString(), "RUNNING");
            this.db
                .prepare("INSERT INTO veriq_local_owner VALUES(1,?,?,?,?,1)")
                .run(runId, workspaceId, attemptId, "ALLOCATED");
            const owner = this.active()!;
            const observed = Date.now();
            this.db
                .prepare("INSERT INTO veriq_local_lifecycle(run_id,first_observed,last_access) VALUES(?,?,?)")
                .run(runId, observed, observed);
            if (initial) this.checkpoint(initial, owner);
            return owner;
        });
    }
    /**
     * 公开方法 spawning 把占用状态推进到进程拉起中：供崩溃恢复区分尚未产生排空证明的阶段（
     * spawning/LOCAL_OWNERSHIP_LOST）。
     */
    spawning(runId: string, attemptId: string, owner: Ownership): Ownership {
        return this.transaction(() => {
            this.requireOwner(owner);
            if (owner.runId !== runId || owner.attemptId !== attemptId || owner.state !== "ALLOCATED")
                throw new Error("LOCAL_OWNERSHIP_LOST");
            this.db.prepare("UPDATE veriq_local_owner SET state='SPAWNING' WHERE singleton=1").run();
            return { ...owner, state: "SPAWNING" };
        });
    }
    /**
     * 启动准入只接受当前 SQLite 已提交的 SPAWNING 所有权，事务提交后才返回 RUNNING 令牌；代际沿用实际 LAUNCH 而不递增，
     * 旧状态与旧代际均失败关闭，调用方必须更新令牌后才能写事件、检查所有权或
     * 保存停止回执。
     */
    running(runId: string, attemptId: string, owner: Ownership): Ownership {
        return this.transaction(() => {
            this.requireOwner(owner);
            if (owner.runId !== runId || owner.attemptId !== attemptId || owner.state !== "SPAWNING")
                throw new Error("LOCAL_OWNERSHIP_LOST");
            const changed = this.db
                .prepare(
                    "UPDATE veriq_local_owner SET state='RUNNING' WHERE run_id=? AND attempt_id=? AND generation=? A" +
                        "ND state='SPAWNING'",
                )
                .run(runId, attemptId, owner.generation);
            if (changed.changes !== 1) throw new Error("LOCAL_OWNERSHIP_LOST");
            return { ...owner, state: "RUNNING" };
        });
    }
    /**
     * 公开方法 claimRecovery 在恢复路径声明代际所有权：拒绝过期或旁路代际接管存活执行（
     * claimRecovery/LOCAL_CAPACITY_HELD）。
     */
    claimRecovery(observed: Ownership): Ownership | undefined {
        return this.transaction(() => {
            const state = isPreSpawnState(observed.state, "OFFLINE") ? "RECOVERING_UNSPAWNED" : "RECOVERING";
            const changed = this.db
                .prepare(
                    "UPDATE veriq_local_owner SET state=?,generation=generation+1 WHERE run_id=? AND attempt_id=? AN" +
                        "D generation=? AND state=?",
                )
                .run(state, observed.runId, observed.attemptId, observed.generation, observed.state);
            return changed.changes ? { ...observed, state, generation: observed.generation + 1 } : undefined;
        });
    }
    /**
     * 公开方法 nextAttempt 在同一 Run 下登记新的 Attempt 代际：保留历史结果：
     * 供显式重试使用（nextAttempt/LOCAL_CAPACITY_HELD）。
     */
    nextAttempt(runId: string, attemptId: string, owner: Ownership, initial: OfflineResultV1): Ownership {
        return this.transaction(() => {
            this.requireOwner(owner);
            if (owner.runId !== runId || owner.state !== "STOPPED") throw new Error("LOCAL_CAPACITY_HELD");
            const next = {
                ...owner,
                attemptId,
                state: "ALLOCATED",
                generation: owner.generation + 1,
            };
            this.db
                .prepare("UPDATE veriq_local_owner SET state='ALLOCATED',attempt_id=?,generation=? WHERE singleton=1")
                .run(attemptId, next.generation);
            this.checkpoint(initial, next);
            return next;
        });
    }
    /**
     * 未派生回执必须在事务内重新核验持久所有权及代际，调用方修改对象中的状态不能改变数据库事实；
     * 启动中与一般恢复状态均不具备此权限，缺少有效白名单时返回空值并要求调用真实停止。
     */
    unspawnedStop(owner: Ownership): StopReceipt | undefined {
        return this.transaction(() => {
            const current = this.requireOwner(owner);
            if (!isPreSpawnState(current.state, "OFFLINE")) return;
            return {
                attemptId: current.attemptId,
                processStopped: true,
                processStopScope: "NO_PROCESS_SPAWNED",
                reason: "NO_PROCESS_SPAWNED",
                stoppedAt: new Date().toISOString(),
            };
        });
    }
    /**
     * 公开方法 stopped 记录停机回执并释放或隔离占用：processStopped=false
     * 时保留隔离语义（stopped/LOCAL_OWNERSHIP_LOST）。
     */
    stopped(runId: string, receipt: StopReceipt, owner: Ownership): Ownership {
        return this.transaction(() => {
            const current = this.requireOwner(owner);
            if (
                current.runId !== runId ||
                current.attemptId !== receipt.attemptId ||
                ((receipt.processStopScope === "NO_PROCESS_SPAWNED" || receipt.reason === "NO_PROCESS_SPAWNED") &&
                    !isPreSpawnState(current.state, "OFFLINE"))
            )
                throw new Error("LOCAL_OWNERSHIP_LOST");
            this.db
                .prepare(
                    "INSERT INTO veriq_local_stops VALUES(?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET receipt=exclu" +
                        "ded.receipt",
                )
                .run(receipt.attemptId, runId, JSON.stringify(receipt));
            /**
             * 停止回执和报告检查点同事务提交，避免宿主恰在停机后崩溃时只保存释放状态却丢失范围；
             * 旧记录没有声明时不补值，本次失败回执也不沿用先前结果中的成功范围。
             */
            const row = this.authorize(current.workspaceId, runId);
            if (row.result) {
                const result = JSON.parse(String(row.result)) as OfflineResultV1;
                const attempt = result.attempts.find((item) => item.attemptId === receipt.attemptId);
                if (!attempt) throw new Error("LOCAL_OWNERSHIP_LOST");
                attempt.processStopped = receipt.processStopped;
                if (receipt.processStopScope !== undefined) attempt.processStopScope = receipt.processStopScope;
                else delete attempt.processStopScope;
                this.checkpoint(result, current);
            }
            const next = { ...current, state: receipt.processStopped ? "STOPPED" : "QUARANTINED" };
            this.db.prepare("UPDATE veriq_local_owner SET state=? WHERE singleton=1").run(next.state);
            return next;
        });
    }
    /**
     * 公开方法 append 在归属校验后追加执行事件：供本机报告与后续上传使用（append/LOCAL_OWNERSHIP_LOST）。
     */
    append(runId: string, event: ExecutionEventV1, owner: Ownership) {
        this.transaction(() => {
            this.requireOwner(owner);
            if (owner.runId !== runId || owner.attemptId !== event.attemptId) throw new Error("LOCAL_OWNERSHIP_LOST");
            const last = this.db
                .prepare(
                    "SELECT COALESCE(MAX(sequence),0) AS sequence, COUNT(*) AS count FROM veriq_local_events WHERE a" +
                        "ttempt_id=?",
                )
                .get(event.attemptId)!;
            if (Number(last.sequence) + 1 !== event.sequence || Number(last.count) >= 10000)
                throw new Error("INVALID_LOCAL_EVENT_SEQUENCE");
            if (Buffer.byteLength(JSON.stringify(event)) > 65536) throw new Error("LOCAL_EVENT_LIMIT");
            this.db
                .prepare("INSERT INTO veriq_local_events VALUES(?,?,?,?)")
                .run(runId, event.attemptId, event.sequence, JSON.stringify(event));
            if (event.type === "ARTIFACT_CREATED") {
                const descriptor = {
                    ...event.payload.file,
                    artifactId: event.payload.artifactId,
                    kind: event.payload.kind,
                };
                if (
                    validateSchema("OfflineArtifactV1", descriptor).length ||
                    !/^[-a-zA-Z0-9_.]{1,240}$/.test(descriptor.path)
                )
                    throw new Error("INVALID_LOCAL_ARTIFACT");
                const result = this.result(owner.workspaceId, runId),
                    attempt = result.attempts.find((a) => a.attemptId === owner.attemptId);
                if (
                    !attempt ||
                    attempt.artifacts.length >= 100 ||
                    attempt.artifacts.some((a) => a.artifactId === descriptor.artifactId || a.path === descriptor.path)
                )
                    throw new Error("INVALID_LOCAL_ARTIFACT");
                attempt.artifacts.push(descriptor);
                this.checkpoint(result, owner);
            }
        });
    }
    /**
     * 公开方法 events 按工作区授权分页读取已持久化的执行事件：after/limit
     * 防止一次载入过量（events/INVALID_HISTORY_PAGE）。
     */
    events(workspaceId: string, runId: string, attemptId: string, after = 0, limit = 100): ExecutionEventV1[] {
        this.authorize(workspaceId, runId);
        if (!Number.isSafeInteger(after) || after < 0 || limit < 1 || limit > 10000)
            throw new Error("INVALID_HISTORY_PAGE");
        return this.db
            .prepare(
                "SELECT document FROM veriq_local_events WHERE run_id=? AND attempt_id=? AND sequence>? ORDER BY seq" +
                    "uence LIMIT ?",
            )
            .all(runId, attemptId, after, limit)
            .map((row) => JSON.parse(String(row.document)) as ExecutionEventV1);
    }
    /**
     * 公开方法 checkpoint 持久化中间结果快照：崩溃后可继续投影报告：不表示正式完成（checkpoint/LOCAL_OWNERSHIP_LOST）。
     */
    checkpoint(result: OfflineResultV1, owner: Ownership) {
        this.authorize(result.workspaceId, result.localRunId);
        this.requireOwner(owner);
        if (owner.runId !== result.localRunId || !result.attempts.some((a) => a.attemptId === owner.attemptId))
            throw new Error("LOCAL_OWNERSHIP_LOST");
        this.db
            .prepare("UPDATE veriq_local_runs SET result=? WHERE id=?")
            .run(JSON.stringify(result), result.localRunId);
    }
    /**
     * 公开方法 finish 写入终态离线结果并结束占用：之后仅允许上传与只读投影（finish/LOCAL_OWNERSHIP_LOST）。
     */
    finish(result: OfflineResultV1, owner: Ownership) {
        this.transaction(() => {
            this.authorize(result.workspaceId, result.localRunId);
            this.requireOwner(owner);
            if (owner.runId !== result.localRunId || !["STOPPED", "QUARANTINED"].includes(owner.state))
                throw new Error("LOCAL_OWNERSHIP_LOST");
            const state = owner.state === "STOPPED" ? "FINISHED" : "QUARANTINED";
            this.touch(result.localRunId);
            this.db
                .prepare("UPDATE veriq_local_runs SET result=?,state=? WHERE id=?")
                .run(JSON.stringify(result), state, result.localRunId);
            if (state === "FINISHED")
                this.db.prepare("DELETE FROM veriq_local_owner WHERE run_id=?").run(result.localRunId);
        });
    }
    private authorize(workspaceId: string, runId: string) {
        const row = this.db
            .prepare("SELECT * FROM veriq_local_runs WHERE id=? AND workspace_id=?")
            .get(runId, workspaceId);
        if (!row) throw new Error("LOCAL_RUN_NOT_FOUND");
        return row;
    }
    /**
     * 公开方法 result 在工作区授权下读取 OfflineResultV1：缺失则失败关闭（result/LOCAL_RUN_UNFINISHED）。
     */
    result(workspaceId: string, runId: string): OfflineResultV1 {
        const row = this.authorize(workspaceId, runId);
        if (row.state === "RETIRED") throw new Error("LOCAL_RUN_RETIRED");
        if (!row.result) throw new Error("LOCAL_RUN_UNFINISHED");
        this.touch(runId);
        return JSON.parse(String(row.result)) as OfflineResultV1;
    }
    /**
     * 公开方法 history 列出工作区内最近的本机 Run 摘要：供宿主历史页展示（history/INVALID_HISTORY_PAGE）。
     */
    history(workspaceId: string, limit = 100) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("INVALID_HISTORY_PAGE");
        return this.db
            .prepare(
                "SELECT id, created_at AS createdAt, state, upload_state AS uploadState, upload_error AS uploadError" +
                    " FROM veriq_local_runs WHERE workspace_id=? AND state<>'RETIRED' ORDER BY created_at DESC,id DE" +
                    "SC LIMIT ?",
            )
            .all(workspaceId, limit);
    }
    /**
     * 公开方法 cancel 标记 Run 取消请求：执行循环必须在检查点读取该标志并停机（cancel），说明 cancel 在 store
     * 中的专属行为。
     */
    cancel(workspaceId: string, runId: string) {
        this.authorize(workspaceId, runId);
        this.db.prepare("UPDATE veriq_local_runs SET cancel_requested=1 WHERE id=?").run(runId);
    }
    /**
     * 公开方法 cancelled 查询 Run 是否已被标记取消：供执行循环在动作间隙轮询，标注导出符号 cancelled。
     */
    cancelled(runId: string) {
        return (
            this.db.prepare("SELECT cancel_requested FROM veriq_local_runs WHERE id=?").get(runId)?.cancel_requested ===
            1
        );
    }
    /**
     * 访问时间只由当前宿主实际读取记录时更新，历史首次观察绝不反推文件 mtime 或导入时间；已退休标志保持单调，
     * 不因一次查询、重复上传或重启重新授予已删除原始证据的可用性。
     */
    private touch(runId: string): void {
        const now = Date.now();
        this.db
            .prepare(
                `INSERT INTO veriq_local_lifecycle(run_id,first_observed,last_access) VALUES(?,?,?)
            ON CONFLICT(run_id) DO UPDATE SET last_access=MAX(last_access,excluded.last_access)`,
            )
            .run(runId, now, now);
    }
    /**
     * 原始证据退休事实按 Run 保存于同一 SQLite 中，报告与读取都查询这个有界布尔投影；未知旧记录继续认为尚未退休，
     * 不能因没有生命周期行而把磁盘文件缺失伪造为成功清理。
     */
    rawRetired(workspaceId: string, runId: string): boolean {
        this.authorize(workspaceId, runId);
        return (
            this.db.prepare("SELECT raw_retired FROM veriq_local_lifecycle WHERE run_id=?").get(runId)?.raw_retired ===
            1
        );
    }
    /**
     * 保留期事务持有真正 SQLite 写锁并拒绝任何离线所有权，直到调用方完成有限文件退休后才提交；
     * 在线与桌面合作锁仍由外层保持，崩溃回滚只会留下下次可幂等重做的删除，不会释放未知执行占用。
     */
    beginRetention(): (commit: boolean) => void {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            if (this.active()) throw new Error("LOCAL_RETENTION_ACTIVE");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
        let held = true;
        return (commit) => {
            if (!held) throw new Error("LOCAL_RETENTION_GUARD_RELEASED");
            try {
                this.nativeDirectory?.validate();
                this.db.exec(commit ? "COMMIT" : "ROLLBACK");
                held = false;
                this.nativeDirectory?.validate();
            } catch (error) {
                if (this.db.isTransaction) this.db.exec("ROLLBACK");
                held = false;
                throw error;
            }
        };
    }
    /**
     * 维护时钟使用持久最高水位拒绝回拨后的年龄推导，首次观察的旧结果从当前时间开始计龄；每次只登记有限旧记录，未完成、
     * 待上传、未知停止或超大未核验文档始终保留，SQL 不用文件 mtime 猜测历史。
     */
    retentionRuns(workspaceId: string, now: number, batch: number) {
        if (
            !this.db.isTransaction ||
            !Number.isSafeInteger(now) ||
            !Number.isSafeInteger(batch) ||
            batch < 1 ||
            batch > 100
        )
            throw new Error("LOCAL_RETENTION_GUARD_REQUIRED");
        const previous = Number(
            this.db.prepare("SELECT high_water FROM veriq_local_retention_clock WHERE singleton=1").get()?.high_water ??
                now,
        );
        if (now < previous) throw new Error("LOCAL_RETENTION_CLOCK_ROLLBACK");
        this.db
            .prepare(
                "INSERT INTO veriq_local_retention_clock VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET high_water" +
                    "=excluded.high_water",
            )
            .run(now);
        this.db
            .prepare(
                `INSERT OR IGNORE INTO veriq_local_lifecycle(run_id,first_observed,last_access)
            SELECT id,?,? FROM veriq_local_runs WHERE workspace_id=? AND id NOT IN (SELECT run_id FROM veriq_local_l` +
                    `ifecycle) ORDER BY id LIMIT ?`,
            )
            .run(now, now, workspaceId, batch);
        const rows = this.db
            .prepare(
                `SELECT r.id,r.result,l.first_observed AS firstObserved,l.last_access AS lastAccess,
            l.raw_retired AS rawRetired,l.metadata_retired AS metadataRetired FROM veriq_local_runs r
            JOIN veriq_local_lifecycle l ON l.run_id=r.id WHERE r.workspace_id=? AND r.state='FINISHED'
            AND r.upload_state='COMPLETE' AND r.result IS NOT NULL AND length(r.result)<=8388608
            ORDER BY l.last_checked,r.id LIMIT ?`,
            )
            .all(workspaceId, batch);
        for (const row of rows)
            this.db.prepare("UPDATE veriq_local_lifecycle SET last_checked=? WHERE run_id=?").run(now, row.id!);
        return rows;
    }
    /**
     * 进程历史成员只有在同一库确有匹配 Run 的强范围停止回执时才可进入只读物理确认，未派生回执不能授权任何现存进程成
     * 员；结果已退休仍保留这份最小事实，孤立、损坏或旧范围未知记录一律返回拒绝。
     */
    knownStoppedAttempt(attemptId: string): boolean {
        const row = this.db
            .prepare(
                "SELECT s.receipt FROM veriq_local_stops s JOIN veriq_local_runs r ON r.id=s.run_id WHERE s.attempt_" +
                    "id=? AND r.state IN ('FINISHED','RETIRED')",
            )
            .get(attemptId);
        try {
            if (!row) return false;
            const stop = JSON.parse(String(row.receipt)) as StopReceipt;
            return (
                stop.attemptId === attemptId &&
                stop.processStopped === true &&
                stop.processStopScope ===
                    (process.platform === "darwin" ? "CONTROLLED_WORKER_BROWSER" : "FULL_DESCENDANT_TREE") &&
                validateSchema("Timestamp", stop.stoppedAt).length === 0
            );
        } catch {
            return false;
        }
    }
    /**
     * 报告必须同时拥有每个 Attempt 的原始停止回执且范围与当前平台一致，旧结果缺字段或回执缺失均保留；这里只验证本机
     * SQL 事实，外层仍使用现有进程证明读取器核验真正停止，不能把结果 outcome 当作进程退出证
     * 据。
     */
    retentionStops(result: OfflineResultV1): StopReceipt[] | undefined {
        const receipts: StopReceipt[] = [];
        for (const attempt of result.attempts) {
            const row = this.db
                .prepare("SELECT receipt FROM veriq_local_stops WHERE attempt_id=? AND run_id=?")
                .get(attempt.attemptId, result.localRunId);
            try {
                if (!row) return;
                const stop = JSON.parse(String(row.receipt)) as StopReceipt;
                if (
                    stop.attemptId !== attempt.attemptId ||
                    stop.processStopped !== true ||
                    attempt.processStopped !== true ||
                    !stop.processStopScope ||
                    stop.processStopScope !== attempt.processStopScope ||
                    validateSchema("Timestamp", stop.stoppedAt).length ||
                    (stop.processStopScope !== "NO_PROCESS_SPAWNED" &&
                        stop.processStopScope !==
                            (process.platform === "darwin" ? "CONTROLLED_WORKER_BROWSER" : "FULL_DESCENDANT_TREE"))
                )
                    return;
                receipts.push(stop);
            } catch {
                return;
            }
        }
        return receipts;
    }
    /**
     * 大报告按有限证据批次前进，每份退休墓碑绑定 Run、Attempt、相对名称和原摘要及长度，下一次只重做尚未完成成员；
     * 运行级原始证据标志只在全部清单完成时设置，不能因本次额度耗尽而把剩余文件标为已删除。
     */
    artifactRetired(
        workspaceId: string,
        runId: string,
        attemptId: string,
        file: { path: string; sha256: string; sizeBytes: number },
    ): boolean {
        this.authorize(workspaceId, runId);
        const row = this.db
            .prepare(
                "SELECT sha256,size_bytes FROM veriq_local_artifact_retirements WHERE run_id=? AND attempt_id=? AND " +
                    "path=?",
            )
            .get(runId, attemptId, file.path);
        return !!row && row.sha256 === file.sha256 && row.size_bytes === file.sizeBytes;
    }
    /**
     * 单项退休仅在持续空闲的 SQLite 写事务中登记，摘要冲突不得覆盖旧墓碑；崩溃前已经删除却未提交的文件下次通过真实缺失
     * 幂等重做，成功登记不会改变业务 outcome、上传幂等键或停止证明。
     */
    retireArtifact(
        workspaceId: string,
        runId: string,
        attemptId: string,
        file: { path: string; sha256: string; sizeBytes: number },
    ): void {
        if (!this.db.isTransaction || this.active()) throw new Error("LOCAL_RETENTION_GUARD_REQUIRED");
        const row = this.authorize(workspaceId, runId);
        if (row.state !== "FINISHED" || row.upload_state !== "COMPLETE") throw new Error("LOCAL_RETENTION_ACTIVE");
        const previous = this.db
            .prepare(
                "SELECT sha256,size_bytes FROM veriq_local_artifact_retirements WHERE run_id=? AND attempt_id=? AND " +
                    "path=?",
            )
            .get(runId, attemptId, file.path);
        if (previous && (previous.sha256 !== file.sha256 || previous.size_bytes !== file.sizeBytes))
            throw new Error("LOCAL_RETENTION_ARTIFACT_CONFLICT");
        this.db
            .prepare("INSERT OR IGNORE INTO veriq_local_artifact_retirements VALUES(?,?,?,?,?)")
            .run(runId, attemptId, file.path, file.sha256, file.sizeBytes);
    }
    /**
     * 只有同一维护事务里已经通过停止、上传及年龄核验的结果能够进入退休，事件正文与完整结果在元数据期限后移除；Run
     * 标识、Workspace、上传幂等回执和每个 Attempt 停止证明继续保留，重复维护不会复用旧 Run
     * 或 fence。
     */
    retireRun(workspaceId: string, runId: string, metadata: boolean): void {
        if (!this.db.isTransaction) throw new Error("LOCAL_RETENTION_GUARD_REQUIRED");
        const row = this.authorize(workspaceId, runId);
        if (row.state !== "FINISHED" || row.upload_state !== "COMPLETE" || this.active())
            throw new Error("LOCAL_RETENTION_ACTIVE");
        this.db
            .prepare("UPDATE veriq_local_lifecycle SET raw_retired=1,metadata_retired=? WHERE run_id=?")
            .run(metadata ? 1 : 0, runId);
        this.db.prepare("DELETE FROM veriq_local_artifact_retirements WHERE run_id=?").run(runId);
        if (metadata) {
            this.db.prepare("DELETE FROM veriq_local_events WHERE run_id=?").run(runId);
            this.db
                .prepare("UPDATE veriq_local_runs SET state='RETIRED',result=NULL,upload_error=NULL WHERE id=?")
                .run(runId);
        }
    }
    /**
     * 缓存生命周期只登记受信任宿主列出的包标识，不接受目录路径或下载文件自报年龄；仍由任何未退休结果引用的包不可退休，
     * 缺少历史生命周期的包本次只开始计龄，不根据包创建时间或磁盘修改时间补造到期事实。
     */
    observeCache(workspaceId: string, bundleId: string, now: number, access = false) {
        this.db
            .prepare(
                `INSERT INTO veriq_local_cache_lifecycle(bundle_id,workspace_id,first_observed,last_access) VALUES(?,` +
                    `?,?,?)
            ON CONFLICT(bundle_id) DO NOTHING`,
            )
            .run(bundleId, workspaceId, now, now);
        if (access)
            this.db
                .prepare(
                    "UPDATE veriq_local_cache_lifecycle SET last_access=MAX(last_access,?) WHERE bundle_id=? AND wor" +
                        "kspace_id=?",
                )
                .run(now, bundleId, workspaceId);
        return this.db
            .prepare(
                "SELECT first_observed AS firstObserved,last_access AS lastAccess,retirement FROM veriq_local_cache_" +
                    "lifecycle WHERE bundle_id=? AND workspace_id=?",
            )
            .get(bundleId, workspaceId);
    }
    /**
     * 缓存引用检查在持有维护写锁时逐条使用已有共享结果契约，损坏或尚无结果的记录一律阻止删除；不会只依赖当前 GUI
     * 选择，也不删除引擎、源码或凭据，已上传但仍保留的报告同样继续持有包引用。
     */
    cacheReferenced(bundleId: string): boolean {
        const rows = this.db
            .prepare("SELECT result,state FROM veriq_local_runs WHERE state<>'RETIRED' LIMIT 4097")
            .all();
        if (rows.length > 4096) return true;
        return rows.some((row) => {
            if (!row.result || String(row.result).length > 8388608) return true;
            try {
                const value = JSON.parse(String(row.result)) as OfflineResultV1;
                return validateSchema("OfflineResultV1", value).length > 0 || value.bundleId === bundleId;
            } catch {
                return true;
            }
        });
    }
    /**
     * 每次访问受信任包时刷新本机 SQLite 的实际访问时间，而不是重写已签名只读清单；操作与维护共享数据库写锁，
     * 因此正在读取包或准备执行的宿主应先持有现有桌面和 Agent 所有权门闩。
     */
    touchCache(workspaceId: string, bundleId: string): void {
        if (validateSchema("Id", workspaceId).length || validateSchema("Id", bundleId).length)
            throw new Error("INVALID_BUNDLE_ID");
        const now = Date.now(),
            observed = this.observeCache(workspaceId, bundleId, now);
        if (observed?.retirement && observed.retirement !== "COMPLETE")
            throw new Error("LOCAL_BUNDLE_RETIREMENT_PENDING");
        if (observed?.retirement === "COMPLETE")
            this.db
                .prepare(
                    "UPDATE veriq_local_cache_lifecycle SET first_observed=?,last_access=?,retirement=NULL WHERE bun" +
                        "dle_id=? AND workspace_id=?",
                )
                .run(now, now, bundleId, workspaceId);
        else this.observeCache(workspaceId, bundleId, now, true);
    }
    /**
     * 退休命名保存在 SQLite 中以支持中途崩溃后只重试同一个隔离目录，名字由包 UUID 确定且保持固定有限语法；
     * 恢复不会按重试时的新目录路径重新选择对象，也不会把文件缺失当成已核验年龄。
     */
    cacheRetirement(workspaceId: string, bundleId: string, inventory: string): void {
        if (!this.db.isTransaction || Buffer.byteLength(inventory) > 2 * 1024 * 1024)
            throw new Error("LOCAL_RETENTION_GUARD_REQUIRED");
        this.db
            .prepare("UPDATE veriq_local_cache_lifecycle SET retirement=? WHERE bundle_id=? AND workspace_id=?")
            .run(inventory, bundleId, workspaceId);
    }
    /**
     * 未完成的缓存退休意图即使目录已经隔离或界面索引已更新也继续可列举，下一次只重做原清单而不重新选择任意目录；
     * 完成标志保留最小包幂等墓碑，调用方必须先成功退休实际有限库存再写入 COMPLETE。
     */
    pendingCacheRetirements(workspaceId: string, batch: number) {
        return this.db
            .prepare(
                "SELECT bundle_id AS bundleId,retirement FROM veriq_local_cache_lifecycle WHERE workspace_id=? AND r" +
                    "etirement IS NOT NULL AND retirement<>'COMPLETE' ORDER BY bundle_id LIMIT ?",
            )
            .all(workspaceId, batch);
    }
    /**
     * 缓存完成只接受已经存在的退休意图，并在同一维护写锁内保存幂等完成墓碑；不删除历史 firstObserved
     * 或允许将同包名自动复用成另一份清单，GUI 索引移除仍由外层私有配置原子更新完成。
     */
    completeCacheRetirement(workspaceId: string, bundleId: string): void {
        if (!this.db.isTransaction) throw new Error("LOCAL_RETENTION_GUARD_REQUIRED");
        this.db
            .prepare(
                "UPDATE veriq_local_cache_lifecycle SET retirement='COMPLETE',retired_at=? WHERE bundle_id=? AND wor" +
                    "kspace_id=? AND retirement IS NOT NULL",
            )
            .run(Date.now(), bundleId, workspaceId);
    }
    /**
     * 公开方法 uploaded 记录上传成功回执并把 upload_state 标为 COMPLETE（uploaded）。
     */
    uploaded(workspaceId: string, runId: string, receipt: unknown) {
        this.authorize(workspaceId, runId);
        this.db
            .prepare(
                "UPDATE veriq_local_runs SET upload_state='COMPLETE',upload_receipt=?,upload_error=NULL WHERE id=?",
            )
            .run(JSON.stringify(receipt), runId);
    }
    /**
     * 公开方法 uploadFailed 记录上传错误码并保持 PENDING：便于显式重试上传（uploadFailed）。
     */
    uploadFailed(workspaceId: string, runId: string, code: string) {
        this.authorize(workspaceId, runId);
        this.db
            .prepare("UPDATE veriq_local_runs SET upload_state='PENDING',upload_error=? WHERE id=?")
            .run(/^[A-Z_]{1,80}$/.test(code) ? code : "UPLOAD_FAILED", runId);
    }
}
