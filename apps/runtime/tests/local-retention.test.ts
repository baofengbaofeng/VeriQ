/**
 * 本机保留期回归在独立私有临时档案中使用真实合作锁与数据库，观察拒绝、可信计龄和退休后的公开状态。
 * 未派生回执只能来自实际持久分配状态；日期替身只推进年龄，不替换文件系统、锁或停止确认。
 * 空证据运行的墓碑与实际单文件删除分开验证；这些源码回归不构成原生平台或断电耐久性验收。
 */
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { validateSchema, type OfflineResultV1 } from "@veriq/contracts";
import { acquireDesktopProfileOwner } from "../src/credentials/ownership.ts";
import { VaultFiles } from "../src/credentials/files.ts";
import { updatePrivate } from "../src/offline/config.ts";
import { retireEvidence } from "../src/offline/offline-retention-files.ts";
import { pruneLocalProfile, type LocalRetentionOptions } from "../src/offline/retention.ts";
import { LocalStore } from "../src/offline/store.ts";

const DAY = 86400000;
const empty = {
    examinedRuns: 0,
    rawRetiredRuns: 0,
    metadataRetiredRuns: 0,
    bundlesRetired: 0,
    retained: 0,
    hasMore: false,
};

/**
 * 每个场景在系统临时目录获得独立私有根并在断言失败后同样回收，避免锁目录或合成用户数据污染后续场景。
 * 数据库连接必须在回调内关闭；Linux 可以删除尚打开的数据库，目录清理不能替代连接清理。
 */
async function profile(run: (root: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "veriq-retention-"));
    try {
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

/**
 * 准备与断言回调的整个生命周期都包含在真实数据库连接的关闭边界内，即使分配或报告校验抛错也不泄漏连接。
 * 等待异步回调完成再关闭，使调用方能先提交并关闭准备连接，再独立验证持久容量屏障。
 */
async function withStore<T>(directory: string, run: (store: LocalStore) => T | Promise<T>): Promise<T> {
    const store = await LocalStore.open(directory);
    try {
        return await run(store);
    } finally {
        store.close();
    }
}

/**
 * 持久状态检查通过只读 SQLite 连接读取已经存在的表，不调用可能新建生命周期行或刷新访问时间的产品观察接口。
 * 数据库和记录缺失必须暴露为失败，不能由断言阶段补建；这里不执行建表、写入或日志模式变更。
 */
function persisted(root: string, query: string, ...ids: string[]) {
    const db = new DatabaseSync(join(root, "offline", "veriq.sqlite"), { readOnly: true });
    try {
        return db.prepare(query).get(...ids);
    } finally {
        db.close();
    }
}

/**
 * 合成报告使用契约允许的环境与标识，但初始状态仍未完成且没有停止范围，不能直接作为可删除结果交给维护入口。
 * 创建时立即校验契约，避免无效夹具被保守保留而掩盖真正的年龄或上传策略错误。
 */
function initial(workspaceId: string): OfflineResultV1 {
    const result: OfflineResultV1 = {
        schemaVersion: "1.0",
        workspaceId,
        bundleId: randomUUID(),
        localRunId: randomUUID(),
        deviceId: randomUUID(),
        source: "OFFLINE_IMPORT",
        trustStatus: "USER_REGISTERED",
        dirty: false,
        revocationStatus: "UNKNOWN",
        manifestSha256: "a".repeat(64),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        outcome: "INCOMPLETE",
        actualEnvironment: {
            schemaVersion: "1.0",
            baseURL: "https://synthetic.test",
            apiBaseURL: "https://synthetic.test",
            allowedOrigins: ["https://synthetic.test"],
            locale: "en",
            timezone: "UTC",
            roles: [
                {
                    roleKey: "reader",
                    authAdapterVersionId: randomUUID(),
                    secretRef: "reader",
                    secretVersionId: randomUUID(),
                },
            ],
        },
        attempts: [
            {
                attemptId: randomUUID(),
                caseVersionId: randomUUID(),
                attemptNo: 1,
                outcome: "INCOMPLETE",
                cleanupStatus: "PENDING",
                lastSequence: 0,
                events: [],
                artifacts: [],
            },
        ],
    };
    assert.deepEqual(validateSchema("OfflineResultV1", result), []);
    return result;
}

/**
 * 取消夹具先写入真实初始占用，再让数据库依据未启动状态出具回执，任何测试代码都不自行构造成功停止事实。
 * 停止提交会向检查点写入范围，因此完成报告必须重新读取；直接沿用初始对象会丢失持久停止投影。
 * 上传成功只通过本机公开接口登记合成回执，这不代表真实服务导入或服务端去重已经验证。
 */
function cancelUnspawned(store: LocalStore, workspaceId: string, uploaded = true) {
    const report = initial(workspaceId),
        attemptId = report.attempts[0]!.attemptId;
    const owner = store.reserve(workspaceId, report.localRunId, attemptId, report);
    store.cancel(workspaceId, report.localRunId);
    assert.equal(store.cancelled(report.localRunId), true);
    const receipt = store.unspawnedStop(owner);
    assert.equal(receipt?.processStopScope, "NO_PROCESS_SPAWNED");
    assert.ok(receipt);
    const stopped = store.stopped(report.localRunId, receipt, owner);
    const final = store.result(workspaceId, report.localRunId);
    final.outcome = final.attempts[0]!.outcome = "CANCELLED";
    store.finish(final, stopped);
    if (uploaded) store.uploaded(workspaceId, report.localRunId, { importId: randomUUID() });
    assert.deepEqual(validateSchema("OfflineResultV1", final), []);
    return final;
}

/**
 * 参数验证必须先于任何档案创建，因此每个非法输入都指向尚不存在的子目录，再检查父目录完全没有新增成员。
 * 五个可配置字段逐一覆盖非有限值、小数及越界；合法输入由随后的空闲维护场景覆盖。
 */
test("invalid workspace and policies leave the filesystem untouched", async () =>
    profile(async (root) => {
        const target = join(root, "missing"),
            workspaceId = randomUUID();
        await assert.rejects(pruneLocalProfile(target, { workspaceId: "invalid" }), /WORKSPACE_INVALID/);
        for (const key of ["metadataDays", "bundleDays", "rawSuccessDays", "rawFailureDays", "batchSize"] as const) {
            for (const value of [0, -1, 1.5, NaN, Infinity, key === "batchSize" ? 101 : 3651]) {
                await assert.rejects(pruneLocalProfile(target, { workspaceId, [key]: value }), /POLICY_INVALID/);
            }
        }
        assert.deepEqual(await readdir(root), []);
    }));

/**
 * 空闲档案允许重复维护且返回精确零计数，第二次成功同时证明前次没有遗留桌面或在线合作锁。
 * 随后独立连接实际取得并提交空闲写事务；只读查询成功不能证明维护写锁已经退出。
 */
test("empty maintenance releases every owner and accepts legal policy bounds", async () =>
    profile(async (root) => {
        const workspaceId = randomUUID();
        for (const days of [1, 3650]) {
            assert.deepEqual(
                await pruneLocalProfile(root, {
                    workspaceId,
                    metadataDays: days,
                    bundleDays: days,
                    rawSuccessDays: days,
                    rawFailureDays: days,
                    batchSize: days === 1 ? 1 : 100,
                }),
                empty,
            );
        }
        const store = await LocalStore.open(join(root, "offline"));
        try {
            store.beginRetention()(true);
        } finally {
            store.close();
        }
    }));

/**
 * 外部桌面或在线拥有者持有真实合作锁时维护必须拒绝，并保存预先存在的合成用户数据字节不变。
 * 在线冲突可能发生在维护已经获得桌面锁之后，再次维护成功检验这个中间所有权也已回收。
 * 明确要求 ELOCKED，不能把目录准入或数据库异常误当成正确的忙状态拒绝。
 */
for (const kind of ["desktop", "online"] as const) {
    test(`held ${kind} owner blocks maintenance without losing data`, async () =>
        profile(async (root) => {
            const workspaceId = randomUUID(),
                sentinel = join(root, "synthetic-user-data");
            await writeFile(sentinel, "preserved", { mode: 0o600 });
            let release: () => Promise<void>;
            if (kind === "desktop") release = (await acquireDesktopProfileOwner(root)).release;
            else {
                const files = await VaultFiles.acquire(join(root, "agent-owner"));
                await files.close();
                release = await lockfile.lock(join(root, "agent-owner"), { realpath: false, retries: 0 });
            }
            try {
                await assert.rejects(pruneLocalProfile(root, { workspaceId }), { code: "ELOCKED" });
            } finally {
                await release();
            }
            assert.equal(await readFile(sentinel, "utf8"), "preserved");
            assert.deepEqual(await pruneLocalProfile(root, { workspaceId }), empty);
        }));
}

/**
 * 活动分配、已有启动意图和未知停止隔离均继续占用本机容量，即使没有任何可退休结果也必须阻止整个维护窗口。
 * 准备连接先关闭，排除 SQLite 忙错误遮蔽持久状态屏障；重开后核对原始代际和报告。
 * 隔离夹具只记录 processStopped=false，既不派生进程，也不伪造成功排空事实。
 */
for (const state of ["ALLOCATED", "SPAWNING", "QUARANTINED"] as const) {
    test(`offline ${state} ownership blocks retirement`, async () =>
        profile(async (root) => {
            const workspaceId = randomUUID(),
                report = initial(workspaceId),
                directory = join(root, "offline");
            const owner = await withStore(directory, (store) => {
                let owner = store.reserve(workspaceId, report.localRunId, report.attempts[0]!.attemptId, report);
                if (state !== "ALLOCATED") owner = store.spawning(owner.runId, owner.attemptId, owner);
                if (state === "QUARANTINED")
                    owner = store.stopped(
                        owner.runId,
                        {
                            attemptId: owner.attemptId,
                            processStopped: false,
                            reason: "UNKNOWN_PROCESS",
                            stoppedAt: new Date().toISOString(),
                        },
                        owner,
                    );
                return owner;
            });
            await assert.rejects(pruneLocalProfile(root, { workspaceId }), /LOCAL_RETENTION_ACTIVE/);
            const store = await LocalStore.open(directory);
            try {
                assert.deepEqual({ ...store.active() }, { ...owner });
                assert.equal(store.result(workspaceId, report.localRunId).localRunId, report.localRunId);
            } finally {
                store.close();
            }
        }));
}

/**
 * 进程目录含有孤立成员时不能凭数据库空闲就宣称所有离线执行都已停止，维护应拒绝并保留现场供人工恢复。
 * 文件名采用合法语法进入归属配对检查；内容明确未知，不携带伪造 PID 或成功停止字段。
 * 移除测试自建成员后再次维护，检验这条错误分支退出时也回收事务和合作锁。
 */
test("unknown offline process member blocks maintenance and remains intact", async () =>
    profile(async (root) => {
        const directory = join(root, "offline", "processes"),
            workspaceId = randomUUID();
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const unknown = join(directory, `${randomUUID()}.process.json`);
        await writeFile(unknown, "unknown", { mode: 0o600 });
        await assert.rejects(pruneLocalProfile(root, { workspaceId }), /LOCAL_RETENTION_UNKNOWN_PROCESS/);
        assert.equal(await readFile(unknown, "utf8"), "unknown");
        await rm(unknown);
        assert.deepEqual(await pruneLocalProfile(root, { workspaceId }), empty);
    }));

/**
 * 缓存创建时间和磁盘修改时间即使很旧，也不能替代本机首次可信观察；首次维护只登记年龄并保留实际文件。
 * 合成目录没有签名库存，验签失败也可能保留，因此仅检查目录存在不足以证明可信计龄正确。
 * 必须只读核对已提交的时间并保存索引及成员原字节；该场景不证明正式签名缓存退休。
 */
test("old cache mtime starts ageing at first observation", async () =>
    profile(async (root) => {
        const workspaceId = randomUUID(),
            id = randomUUID(),
            directory = join(root, "bundles", id);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const member = join(directory, "synthetic-member"),
            old = new Date("2000-01-01T00:00:00Z");
        await writeFile(member, "old cache", { mode: 0o600 });
        await utimes(member, old, old);
        await utimes(directory, old, old);
        await updatePrivate(root, "desktop-bundles.json", () => [
            {
                id,
                workspaceId,
                engineVersion: "synthetic",
                createdAt: old.toISOString(),
                debug: false,
            },
        ]);
        const catalog = await readFile(join(root, "desktop-bundles.json")),
            before = Date.now();
        assert.deepEqual(await pruneLocalProfile(root, { workspaceId, bundleDays: 1 }), { ...empty, retained: 1 });
        /**
         * 只读查询必须先确认维护实际提交了生命周期行，查询自身不能补建缺失行，否则会把未保存观察起点误判为成功。
         * 上下界紧贴维护调用采样，之后的查询耗时不能扩大允许的首次观察时间窗口。
         */
        const after = Date.now();
        const observed = persisted(
            root,
            "SELECT first_observed AS firstObserved,last_access AS lastAccess " +
                "FROM veriq_local_cache_lifecycle WHERE workspace_id=? AND bundle_id=?",
            workspaceId,
            id,
        );
        assert.ok(observed);
        assert.ok(Number(observed.firstObserved) >= before);
        assert.ok(Number(observed.firstObserved) <= after);
        assert.equal(observed.lastAccess, observed.firstObserved);
        assert.equal(await readFile(member, "utf8"), "old cache");
        assert.deepEqual(await readFile(join(root, "desktop-bundles.json")), catalog);
    }));

/**
 * 上传完成的真实未派生取消运行按可信年龄退休，批次上限限制每次候选数，元数据退休后仍须保留上传幂等标识。
 * 元数据一期早于原始三日期限，两天时仍需保留；四天时两个期限满足，批次一必须逐运行前进。
 * 同龄未上传和上传失败运行提供对照，不能因取消或到期而丢失报告、重试状态及错误码。
 * 日期替身只启用 Date，测试框架在结束时恢复；每次推进前维护已完整取得并释放真实锁。
 */
test("uploaded unspawned cancellations retire in batches while pending uploads survive", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 1) });
    await profile(async (root) => {
        const workspaceId = randomUUID(),
            directory = join(root, "offline");
        const { uploaded, pending, failed } = await withStore(directory, (store) => {
            const uploaded = [cancelUnspawned(store, workspaceId), cancelUnspawned(store, workspaceId)];
            const pending = cancelUnspawned(store, workspaceId, false),
                failed = cancelUnspawned(store, workspaceId, false);
            store.uploadFailed(workspaceId, failed.localRunId, "UPLOAD_FAILED");
            return { uploaded, pending, failed };
        });
        const options: LocalRetentionOptions = { workspaceId, metadataDays: 1, rawFailureDays: 3, batchSize: 1 };
        t.mock.timers.tick(2 * DAY);
        const young = await pruneLocalProfile(root, options);
        assert.deepEqual(young, { ...empty, examinedRuns: 1, retained: 1, hasMore: true });
        t.mock.timers.tick(2 * DAY);
        for (let index = 0; index < uploaded.length; index++) {
            assert.deepEqual(await pruneLocalProfile(root, options), {
                ...empty,
                examinedRuns: 1,
                rawRetiredRuns: 1,
                metadataRetiredRuns: 1,
                hasMore: true,
            });
        }
        assert.deepEqual(await pruneLocalProfile(root, options), empty);
        const store = await LocalStore.open(directory);
        try {
            /**
             * 完整报告读取应在元数据退休后明确拒绝，运行级原始退休事实继续可查，重复上传不应复活已删除的报告正文。
             * 原始停止表仍需与报告中的范围配对，只有结果对象携带停止声明不足以证明最小事实保留。
             */
            for (const report of uploaded) {
                assert.throws(() => store.result(workspaceId, report.localRunId), /LOCAL_RUN_RETIRED/);
                assert.equal(store.rawRetired(workspaceId, report.localRunId), true);
                assert.equal(store.retentionStops(report)?.[0]?.processStopScope, "NO_PROCESS_SPAWNED");
                store.uploaded(workspaceId, report.localRunId, { importId: "synthetic-repeat" });
                assert.throws(() => store.result(workspaceId, report.localRunId), /LOCAL_RUN_RETIRED/);
            }
            for (const report of [pending, failed]) {
                assert.equal(store.result(workspaceId, report.localRunId).outcome, "CANCELLED");
                assert.equal(store.rawRetired(workspaceId, report.localRunId), false);
            }
            const history = store.history(workspaceId);
            assert.equal(history.length, 2);
            assert.ok(history.every((row) => row.uploadState === "PENDING"));
            assert.equal(history.find((row) => row.id === failed.localRunId)?.uploadError, "UPLOAD_FAILED");
        } finally {
            store.close();
        }
    });
});

/**
 * 两个工作区在同一档案内保存同龄且已上传的取消运行，维护其中一个工作区不得触碰另一个已完全符合年龄的候选。
 * 相同上传、停止及年龄排除其他保留条件遮蔽授权错误；选中工作区实际退休才构成有效对照。
 * 先只读比较另一工作区生命周期、上传状态及原始停止回执，再读报告，避免访问刷新掩盖跨区修改。
 * 这覆盖运行退休授权，不代表签名缓存跨工作区引用已经验收。
 */
test("pruning one workspace preserves another eligible uploaded run", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 1) });
    await profile(async (root) => {
        const workspaceId = randomUUID(),
            otherWorkspace = randomUUID(),
            directory = join(root, "offline");
        const { selected, other } = await withStore(directory, (store) => ({
            selected: cancelUnspawned(store, workspaceId),
            other: cancelUnspawned(store, otherWorkspace),
        }));
        const query =
            "SELECT l.*,r.state,r.upload_state,s.receipt FROM veriq_local_lifecycle l " +
            "JOIN veriq_local_runs r ON r.id=l.run_id JOIN veriq_local_stops s ON s.run_id=r.id " +
            "WHERE r.workspace_id=? AND r.id=?";
        const before = persisted(root, query, otherWorkspace, other.localRunId);
        assert.ok(before);
        t.mock.timers.tick(4 * DAY);
        assert.deepEqual(
            await pruneLocalProfile(root, {
                workspaceId,
                metadataDays: 1,
                rawFailureDays: 1,
            }),
            { ...empty, examinedRuns: 1, rawRetiredRuns: 1, metadataRetiredRuns: 1 },
        );
        const after = persisted(root, query, otherWorkspace, other.localRunId);
        assert.deepEqual(after, before);
        assert.equal(after?.raw_retired, 0);
        assert.equal(after?.metadata_retired, 0);
        assert.equal(after?.upload_state, "COMPLETE");
        await withStore(directory, (store) => {
            assert.throws(() => store.result(workspaceId, selected.localRunId), /LOCAL_RUN_RETIRED/);
            assert.throws(() => store.result(workspaceId, other.localRunId), /LOCAL_RUN_NOT_FOUND/);
            assert.deepEqual(store.result(otherWorkspace, other.localRunId), other);
            assert.equal(store.rawRetired(otherWorkspace, other.localRunId), false);
            assert.equal(store.retentionStops(other)?.[0]?.processStopScope, "NO_PROCESS_SPAWNED");
        });
    });
});

/**
 * 单项证据退休必须核对实际字节和单链接身份，摘要错误与硬链接都应保留原文件，不能在返回失败前先删除内容。
 * 错误摘要保持大小相同，硬链接保持内容相同，分别隔离内容核验与对象共享身份两个拒绝原因。
 * 移除测试自建链接后才允许删除；原路径真实缺失与重复调用共同观察单文件退休和幂等重做。
 * 这里直接验证受限适配器，不伪造带证据的未派生报告，也不替代多文件墓碑恢复测试。
 */
test("evidence retirement rejects changed identity and deletes only verified bytes", async () =>
    profile(async (root) => {
        const attemptId = randomUUID(),
            directory = join(root, "offline", "work", attemptId, "evidence");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, "synthetic.txt"),
            bytes = Buffer.from("synthetic evidence");
        await writeFile(path, bytes, { mode: 0o600 });
        const file = {
            path: "synthetic.txt",
            sizeBytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
        };
        await assert.rejects(retireEvidence(root, attemptId, { ...file, sha256: "0".repeat(64) }), /FILE_CHANGED/);
        assert.deepEqual(await readFile(path), bytes);
        const alias = join(root, "synthetic-link");
        await link(path, alias);
        await assert.rejects(retireEvidence(root, attemptId, file), /FILE_UNSAFE/);
        assert.deepEqual(await readFile(path), bytes);
        assert.equal((await stat(alias)).nlink, 2);
        await rm(alias);
        await retireEvidence(root, attemptId, file);
        await assert.rejects(stat(path), { code: "ENOENT" });
        await retireEvidence(root, attemptId, file);
    }));
