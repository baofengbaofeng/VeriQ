/**
 * Windows 在线 Claim 日志使用与离线宿主相同的 Node24 SQLite 技术，但原始认领与围栏另存专用私有数据库；提交权威来自
 * FULL/WAL 事务而非目录刷新，原生会话持续持有祖先链并核验数据库及辅助文件，
 * 缺少该能力不授予派生许可。
 */
import { readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { canonicalBytes, validateSchema, type PlatformComponents } from "@veriq/contracts";
import type { DataCleanup, TaskAllocation } from "./storage.ts";
import type { Claim } from "../agent/transport.ts";
import type { StopReceipt } from "./processes.ts";
import { windowsNative } from "../native/windows.ts";
import { ProcessRecords, sameSettledAttempt } from "./records.ts";

/**
 * 日志记录保存服务端原始 Claim 而不重建租约或增加有效期，work 只接受当前 Agent 根下同一 Attempt 的固定路径；
 * 状态与停止回执同一事务保存，恢复不得用丢失内存句柄推导没有产生过进程。
 */
export interface WindowsAttemptRecord {
    allocation?: TaskAllocation;
    dataCleanup?: DataCleanup;
    runnerId?: string;
    claimRequestId?: string;
    claim: Claim;
    state: "ALLOCATED" | "ACTIVATING" | "ACTIVATED" | "SPAWNING" | "RUNNING" | "STOPPED";
    work: string;
    stop?: StopReceipt;
}
const states = ["ALLOCATED", "ACTIVATING", "ACTIVATED", "SPAWNING", "RUNNING", "STOPPED"];
const LIMIT = 4096;

/**
 * 这项有限能力只锁住 SQLite 所在真实祖先目录并核验四个固定数据库成员，不提供任意 NT 操作或伪造目录刷新；SQLite
 * 必须在会话关闭之前关闭，原生装载、权限和关闭错误均直接阻止开始执行。
 */
interface SqliteDirectory {
    validate(): void;
    close(): void;
}

/**
 * 记录解析同时检查共享 Claim 契约、状态、请求幂等标识、停止范围与固定工作区路径；磁盘内容损坏或未知字段保持失败，
 * 尤其旧 JSON 的前置状态不能通过这个新数据库解析器取得未派生授权。
 */
function checked(root: string, value: unknown): WindowsAttemptRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WINDOWS_JOURNAL_CORRUPT");
    const record = value as WindowsAttemptRecord;
    if (
        Object.keys(record).some(
            (key) =>
                !["claim", "runnerId", "claimRequestId", "state", "work", "stop", "allocation", "dataCleanup"].includes(
                    key,
                ),
        ) ||
        validateSchema("ClaimDTO", record.claim).length ||
        (record.runnerId !== undefined && validateSchema("Id", record.runnerId).length > 0) ||
        !states.includes(record.state) ||
        record.work !== join(root, "work", record.claim.attemptId) ||
        (record.claimRequestId !== undefined && validateSchema("Id", record.claimRequestId).length)
    )
        throw new Error("WINDOWS_JOURNAL_CORRUPT");
    if (
        record.stop !== undefined &&
        (!record.stop ||
            typeof record.stop !== "object" ||
            Array.isArray(record.stop) ||
            Object.keys(record.stop).some(
                (key) => !["attemptId", "processStopped", "processStopScope", "reason", "stoppedAt"].includes(key),
            ) ||
            record.stop.attemptId !== record.claim.attemptId ||
            typeof record.stop.processStopped !== "boolean" ||
            typeof record.stop.reason !== "string" ||
            record.stop.reason.length > 120 ||
            validateSchema("Timestamp", record.stop.stoppedAt).length ||
            (record.stop.processStopScope !== undefined &&
                !["FULL_DESCENDANT_TREE", "NO_PROCESS_SPAWNED"].includes(record.stop.processStopScope)))
    )
        throw new Error("WINDOWS_JOURNAL_CORRUPT");
    return record;
}

/**
 * v1 仅含 Attempt 表，v2 增加待定认领。迁移前核对已有列类型和主键，并拒绝未知表、视图或触发器。
 */
function requireSchema(db: DatabaseSync, version: number): void {
    const initializing = version === 0;
    const entries = db.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 3").all();
    if (initializing && entries.length === 0) return;
    const tables = version === 2 ? ["veriq_online_attempts", "veriq_claim_requests"] : ["veriq_online_attempts"];
    if (
        entries.length !== tables.length ||
        entries.some((entry) => entry.type !== "table" || !tables.includes(String(entry.name)))
    )
        throw new Error("WINDOWS_JOURNAL_SCHEMA_UNSUPPORTED");
    if (version === 2) {
        const columns = db.prepare("PRAGMA table_info(veriq_claim_requests)").all();
        if (
            columns.length !== 2 ||
            columns[0]?.name !== "key" ||
            columns[1]?.name !== "document" ||
            columns.some((column, i) => column.type !== "TEXT" || Number(column.pk) !== (i === 0 ? 1 : 0))
        )
            throw new Error("WINDOWS_JOURNAL_SCHEMA_UNSUPPORTED");
    }
    const columns = db.prepare("PRAGMA table_info(veriq_online_attempts)").all();
    const names = ["attempt_id", "claim", "document", "state", "updated_at"];
    if (
        columns.length !== names.length ||
        columns.some(
            (column, index) =>
                column.name !== names[index] || column.type !== "TEXT" || Number(column.pk) !== (index === 0 ? 1 : 0),
        )
    )
        throw new Error("WINDOWS_JOURNAL_SCHEMA_UNSUPPORTED");
    if (initializing && Number(db.prepare("SELECT count(*) AS count FROM veriq_online_attempts").get()!.count) !== 0)
        throw new Error("WINDOWS_JOURNAL_SCHEMA_UNSUPPORTED");
}

function archiveKey(record: WindowsAttemptRecord): string {
    return record.claim.attemptId.replaceAll("-", "").toLowerCase();
}

function journalDirectory(root: string, archivePrefix?: string): string {
    if (archivePrefix === undefined) return join(root, "journal");
    if (!/^[0-9a-f]{2,32}$/.test(archivePrefix)) throw new Error("WINDOWS_ARCHIVE_INVALID");
    return join(root, "settled-journals", archivePrefix);
}

/**
 * SQLite 会话每次读写均保持原生私有父链，所有状态推进用 BEGIN IMMEDIATE 串行化且保留第一次 Claim 的确切字节；同名不同
 * fence 或请求标识拒绝覆盖，终态不能重新回到启动阶段。
 */
export class WindowsAttemptJournal {
    private constructor(
        private root: string,
        private db: DatabaseSync,
        private directory: SqliteDirectory,
    ) {}

    /**
     * 打开只发生在真实 Windows 上且必须取得已安装或源码固定原生模块的有限会话，数据库结构只在 FULL/WAL 验证后初始化；
     * 异常先关闭 SQLite 再关闭原生链，不吞掉提交或关闭不确定性。
     */
    static async open(root: string, archivePrefix?: string): Promise<WindowsAttemptJournal> {
        if (process.platform !== "win32") throw new Error("WINDOWS_NATIVE_PLATFORM_REQUIRED");
        const native = windowsNative();
        if (typeof native.openPrivateSqliteDirectory !== "function")
            throw new Error("WINDOWS_PRIVATE_SQLITE_UNAVAILABLE");
        const path = journalDirectory(root, archivePrefix);
        const directory = native.openPrivateSqliteDirectory(path, "veriq-online.sqlite");
        return this.connect(root, path, directory);
    }

    private static connect(root: string, path: string, directory: SqliteDirectory): WindowsAttemptJournal {
        let db: DatabaseSync | undefined;
        try {
            directory.validate();
            db = new DatabaseSync(join(path, "veriq-online.sqlite"), { timeout: 3000 });
            db.exec(
                "PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON",
            );
            if (
                String(db.prepare("PRAGMA journal_mode").get()!.journal_mode).toLowerCase() !== "wal" ||
                Number(db.prepare("PRAGMA synchronous").get()!.synchronous) !== 2
            )
                throw new Error("WINDOWS_JOURNAL_DURABILITY_UNAVAILABLE");
            const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
            if (version !== 0 && version !== 1 && version !== 2) throw new Error("WINDOWS_JOURNAL_VERSION_UNSUPPORTED");
            requireSchema(db, version);
            db.exec(`BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS veriq_online_attempts (
                attempt_id TEXT PRIMARY KEY, claim TEXT NOT NULL CHECK(length(claim)<=65536),
                document TEXT NOT NULL CHECK(length(document)<=65536), state TEXT NOT NULL,
                updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS veriq_claim_requests (
                    key TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(length(document)<=65536));
                PRAGMA user_version=2; COMMIT;`);
            requireSchema(db, 2);
            if (db.prepare("PRAGMA quick_check(1)").get()!.quick_check !== "ok")
                throw new Error("WINDOWS_JOURNAL_CORRUPT");
            directory.validate();
            return new WindowsAttemptJournal(root, db, directory);
        } catch (error) {
            try {
                db?.close();
            } finally {
                directory.close();
            }
            throw error;
        }
    }

    /**
     * 迁移与维护守卫只观察已经存在的数据库，原生不会创建目录或本体且拒绝孤立辅助文件，SQLite 使用 readOnly
     * 连接并不执行建表或变更 PRAGMA；真实完全缺失才返回空值，格式、权限、版本与关闭不确定仍阻止维护
     * 。
     */
    static async openExisting(root: string, archivePrefix?: string): Promise<WindowsAttemptJournal | undefined> {
        if (process.platform !== "win32") throw new Error("WINDOWS_NATIVE_PLATFORM_REQUIRED");
        const path = journalDirectory(root, archivePrefix);
        let directory: SqliteDirectory;
        try {
            directory = windowsNative().openPrivateSqliteDirectory(path, "veriq-online.sqlite", false);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        let db: DatabaseSync | undefined;
        try {
            db = new DatabaseSync(join(path, "veriq-online.sqlite"), {
                timeout: 3000,
                readOnly: true,
            });
            const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
            if (archivePrefix && version === 0 && !db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()) {
                db.close();
                directory.close();
                return;
            }
            if (
                (version !== 1 && version !== 2) ||
                String(db.prepare("PRAGMA journal_mode").get()!.journal_mode).toLowerCase() !== "wal" ||
                db.prepare("PRAGMA quick_check(1)").get()!.quick_check !== "ok"
            )
                throw new Error("WINDOWS_JOURNAL_CORRUPT");
            requireSchema(db, version);
            directory.validate();
            return new WindowsAttemptJournal(root, db, directory);
        } catch (error) {
            try {
                db?.close();
            } finally {
                directory.close();
            }
            throw error;
        }
    }
    /**
     * 恢复按主键分页读取，允许每页读完后归档，不因删除前一页成员而跳过剩余记录；SQL 中重复保存的 Claim
     * 与状态必须匹配完整文档，防止局部损坏被解析成可释放容量的前置状态。
     */
    *records(): Generator<WindowsAttemptRecord> {
        this.directory.validate();
        const query = this.db.prepare(
            "SELECT attempt_id,claim,document,state FROM veriq_online_attempts " +
                "WHERE (? IS NULL OR attempt_id > ?) ORDER BY attempt_id LIMIT 128",
        );
        let cursor: string | null = null;
        for (;;) {
            const rows: ReturnType<typeof query.all> = query.all(cursor, cursor);
            if (!rows.length) return;
            for (const row of rows) {
                if (Buffer.byteLength(String(row.document)) > 65536 || Buffer.byteLength(String(row.claim)) > 65536)
                    throw new Error("WINDOWS_JOURNAL_LIMIT");
                const record = checked(this.root, JSON.parse(String(row.document)));
                if (
                    record.claim.attemptId !== row.attempt_id ||
                    record.state !== row.state ||
                    Buffer.from(canonicalBytes(record.claim)).toString("utf8") !== row.claim
                )
                    throw new Error("WINDOWS_JOURNAL_CORRUPT");
                cursor = record.claim.attemptId;
                yield record;
            }
        }
    }

    static async *archived(root: string): AsyncGenerator<WindowsAttemptRecord> {
        const path = join(root, "settled-journals");
        try {
            windowsNative().privatePath(path, false);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        for (const entry of await readdir(path, { withFileTypes: true })) {
            if (!entry.isDirectory()) throw new Error("WINDOWS_ARCHIVE_INVALID");
            const bucket = await this.openExisting(root, entry.name);
            // 首次归档可能在创建私有目录后、提交首条记录前中断，此时活动记录仍在，下一次恢复会继续复制。
            if (!bucket) continue;
            try {
                for (const record of bucket.records()) {
                    if (!record.stop?.processStopped || !archiveKey(record).startsWith(entry.name))
                        throw new Error("WINDOWS_ARCHIVE_INVALID");
                    yield record;
                }
            } finally {
                bucket.close();
            }
        }
    }

    // 每个归档库最多容纳二百五十六条记录，已满时延长标识前缀选库，同一认领重试仍能找到先前的提交。
    async archive(record: WindowsAttemptRecord): Promise<void> {
        if (!record.stop?.processStopped) throw new Error("WINDOWS_JOURNAL_CONFLICT");
        const key = archiveKey(record);
        const claim = Buffer.from(canonicalBytes(record.claim)).toString("utf8");
        for (let length = 2; length <= key.length; length++) {
            const bucket = await WindowsAttemptJournal.open(this.root, key.slice(0, length));
            let copied = false;
            try {
                const previous = bucket.db
                    .prepare("SELECT claim, document FROM veriq_online_attempts WHERE attempt_id=?")
                    .get(record.claim.attemptId);
                if (previous) {
                    const saved = checked(this.root, JSON.parse(String(previous.document)));
                    if (previous.claim !== claim || !sameSettledAttempt(record, saved))
                        throw new Error("WINDOWS_ARCHIVE_CONFLICT");
                    copied = true;
                } else if (
                    Number(bucket.db.prepare("SELECT count(*) AS n FROM veriq_online_attempts").get()!.n) < 256
                ) {
                    bucket.db
                        .prepare("INSERT INTO veriq_online_attempts VALUES(?,?,?,?,?)")
                        .run(
                            record.claim.attemptId,
                            claim,
                            JSON.stringify(record),
                            record.state,
                            new Date().toISOString(),
                        );
                    copied = true;
                }
                bucket.directory.validate();
            } finally {
                bucket.close();
            }
            if (!copied) continue;
            // 归档库完整提交并关闭之后才删除活动行，因此中断后两份记录可能并存，恢复将重新核对并完成退休。
            const result = this.db
                .prepare("DELETE FROM veriq_online_attempts WHERE attempt_id=? AND claim=? AND document=?")
                .run(record.claim.attemptId, claim, JSON.stringify(record));
            if (result.changes !== 1) throw new Error("WINDOWS_JOURNAL_CONFLICT");
            this.directory.validate();
            return;
        }
        throw new Error("WINDOWS_ARCHIVE_CONFLICT");
    }

    /**
     * 持久化在同一个事务内核对旧 Claim 与状态，只有原始认领的合法状态推进才提交；失败后的 ROLLBACK
     * 也可能报错并保持不确定，调用方不得因为旧对象仍在内存而继续派生或发未派生成功回执。
     */
    save(value: WindowsAttemptRecord): void {
        const record = checked(this.root, value),
            document = JSON.stringify(record),
            claim = Buffer.from(canonicalBytes(record.claim)).toString("utf8");
        if (Buffer.byteLength(document) > 65536) throw new Error("WINDOWS_JOURNAL_LIMIT");
        this.directory.validate();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const previous = this.db
                .prepare("SELECT claim,document,state FROM veriq_online_attempts WHERE attempt_id=?")
                .get(record.claim.attemptId);
            if (previous) {
                const old = checked(this.root, JSON.parse(String(previous.document)));
                if (
                    Buffer.from(canonicalBytes(old.claim)).toString("utf8") !== previous.claim ||
                    old.state !== previous.state ||
                    previous.claim !== claim ||
                    old.claimRequestId !== record.claimRequestId ||
                    (old.runnerId !== undefined && old.runnerId !== record.runnerId) ||
                    (states.indexOf(record.state) < states.indexOf(String(previous.state)) &&
                        !(record.state === "STOPPED"))
                )
                    throw new Error("WINDOWS_JOURNAL_CONFLICT");
            } else if (record.state !== "ALLOCATED") throw new Error("WINDOWS_JOURNAL_CONFLICT");
            this.db
                .prepare(
                    `INSERT INTO veriq_online_attempts VALUES(?,?,?,?,?)
                ON CONFLICT(attempt_id) DO UPDATE SET document=excluded.document,state=excluded.state,updated_at=exc` +
                        `luded.updated_at`,
                )
                .run(record.claim.attemptId, claim, document, record.state, new Date().toISOString());
            this.directory.validate();
            this.db.exec("COMMIT");
            this.directory.validate();
        } catch (error) {
            if (this.db.isTransaction) this.db.exec("ROLLBACK");
            throw error;
        }
    }

    pendingRequest(): PlatformComponents["schemas"]["ClaimRequest"] | undefined {
        const row = this.db.prepare("SELECT document FROM veriq_claim_requests WHERE key='active'").get();
        if (!row) return;
        const request = JSON.parse(String(row.document));
        if (validateSchema("ClaimRequest", request).length) throw new Error("CLAIM_REQUEST_RECOVERY_REQUIRED");
        return request;
    }

    publishRequest(request: PlatformComponents["schemas"]["ClaimRequest"], legacy = false): void {
        const document = JSON.stringify(request);
        this.db.exec("BEGIN IMMEDIATE");
        try {
            if (legacy) {
                const imported = this.db.prepare("SELECT document FROM veriq_claim_requests WHERE key='legacy'").get();
                if (imported && imported.document !== document) throw new Error("CLAIM_REQUEST_ARCHIVE_CONFLICT");
                if (imported) {
                    this.db.exec("COMMIT");
                    return;
                }
                this.db.prepare("INSERT INTO veriq_claim_requests VALUES('legacy',?)").run(document);
            }
            this.db.prepare("INSERT INTO veriq_claim_requests VALUES('active',?)").run(document);
            this.db.exec("COMMIT");
        } catch (error) {
            if (this.db.isTransaction) this.db.exec("ROLLBACK");
            throw error;
        }
    }

    clearRequest(foreign?: PlatformComponents["schemas"]["ClaimRequest"]): void {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            if (foreign) {
                const saved = this.db
                    .prepare(
                        "INSERT INTO veriq_claim_requests SELECT ?, document FROM veriq_claim_requests " +
                            "WHERE key='active' AND document=?",
                    )
                    .run(foreign.clientRequestId, JSON.stringify(foreign));
                if (saved.changes !== 1) throw new Error("CLAIM_REQUEST_ARCHIVE_CONFLICT");
            }
            const removed = this.db.prepare("DELETE FROM veriq_claim_requests WHERE key='active'").run();
            if (removed.changes !== 1) throw new Error("CLAIM_REQUEST_RECOVERY_REQUIRED");
            this.db.exec("COMMIT");
        } catch (error) {
            if (this.db.isTransaction) this.db.exec("ROLLBACK");
            throw error;
        }
    }

    /**
     * 旧 JSON 与 staging 从未得到新的 SQLite 提交证明，所以恢复前只要有任何遗留成员便保持隔离；不导入看似 ALLOCATED
     * 的旧正文、不删除未知成员，也不把缺失数据库当作旧进程从未产生。
     */
    async requireNoLegacy(): Promise<void> {
        const legacy = await ProcessRecords.open(join(this.root, "attempts"));
        if (!legacy) return;
        try {
            const { names, interrupted } = await legacy.journalNames(LIMIT);
            if (names.length || interrupted.size) throw new Error("WINDOWS_LEGACY_JOURNAL_RECOVERY_REQUIRED");
        } finally {
            await legacy.close();
        }
    }

    /**
     * 关闭顺序使 SQLite 完成自身 WAL 生命周期之后才释放不共享删除的祖先句柄，任一关闭异常都向上传播；这里不会补做
     * Windows 目录 fsync，也不会把文件可见性当作 Job 排空证明。
     */
    close(): void {
        try {
            this.db.close();
        } finally {
            this.directory.close();
        }
    }
}
