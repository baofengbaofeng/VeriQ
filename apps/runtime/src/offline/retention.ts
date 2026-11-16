/** 本机保留期维护复用桌面档案所有权、在线 Agent 合作锁与离线 SQLite 写锁，只有已上传、确知停止且超过可信本机观察期的对
 * 象才能退休；清理保留最小幂等墓碑和停止事实，不扫描任意磁盘目录、不猜测旧 mtime，也不删除引
 * 擎或凭据。
 */
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import { validateSchema, type OfflineResultV1 } from "@veriq/contracts";
import {
    acquireDesktopProfileOwner,
    ownsDesktopProfile,
    type DesktopProfileOwner,
} from "../credentials/ownership.ts";
import { VaultFiles } from "../credentials/files.ts";
import { requireStoppedHistory } from "../execution/stopped-history.ts";
import { ProcessRecords } from "../execution/records.ts";
import { ProcessSupervisor } from "../execution/processes.ts";
import { LocalStore } from "./store.ts";
import { readPrivate, updatePrivate, readBoundedFile } from "./config.ts";
import { reverifyInstalled, safePath } from "./verify.ts";
import { TrustStore } from "./trust.ts";
import { retireEvidence, retireInventory, type RetentionFile } from "./offline-retention-files.ts";

/** 维护参数只允许工作区与有限天数、批量额度，不接收任意路径或 renderer 文件能力；桌面可复用当前进程实际持有的不透明所有
 * 权对象，CLI 缺省获取独立真实锁，伪造或跨档案能力直接拒绝。
 */
export interface LocalRetentionOptions {
    workspaceId: string;
    metadataDays?: number;
    bundleDays?: number;
    rawSuccessDays?: number;
    rawFailureDays?: number;
    batchSize?: number;
    desktopOwner?: DesktopProfileOwner;
}
/** 结果只暴露有限计数和是否还有后续批次，不包含路径、凭据或无限错误数组；retained 计入尚未到期、缺少可信年龄、
 * 未知停止或文件核验不确定的候选，不能将其解释为所有缓存已经删除。
 */
export interface LocalRetentionResult {
    examinedRuns: number;
    rawRetiredRuns: number;
    metadataRetiredRuns: number;
    bundlesRetired: number;
    retained: number;
    hasMore: boolean;
}
type CachedBundle = {
    id: string;
    workspaceId: string;
    engineVersion: string;
    createdAt: string;
    debug: boolean;
};
const DAY = 86400000,
    MAX_FILES = 4098,
    MAX_BYTES = 128 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** 输入边界只接受一至三千六百五十天以及一至一百项，避免误传零、负数、NaN 或无穷触发大批删除；默认值来自首发保留策略，
 * 真实年龄始终从 SQLite 实际首次观察和访问时间计算。
 */
function budget(value: number | undefined, fallback: number, maximum: number): number {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum)
        throw new Error("LOCAL_RETENTION_POLICY_INVALID");
    return selected;
}

/** 离线进程历史必须能与本机原始停止回执逐项配对，任何孤立或未知进程成员都会阻止整个维护窗口；既有原生确认器只读取真实停
 * 止证明而不发信号，Windows/Linux 继续要求全后代排空，Darwin 保持受控范围。
 */
async function requireOfflineStopped(root: string, store: LocalStore): Promise<void> {
    const records = await ProcessRecords.open(join(root, "processes"));
    if (!records) return;
    try {
        const names = await records.names(8192),
            ids = new Set<string>();
        for (const name of names) {
            const match = /^([a-zA-Z0-9_-]{1,100})\.(?:process|drained|controlled)\.json$/.exec(
                name,
            );
            if (!match) throw new Error("LOCAL_RETENTION_UNKNOWN_PROCESS");
            ids.add(match[1]!);
        }
        const processes = new ProcessSupervisor(join(root, "processes"));
        for (const id of ids) {
            if (!store.knownStoppedAttempt(id) || !(await processes.confirmStopped(id)))
                throw new Error("LOCAL_RETENTION_UNKNOWN_PROCESS");
        }
    } finally {
        await records.close();
    }
}

/** 缓存索引只是受限宿主目录白名单而非年龄或签名证明，因此先严格校验有限结构再按选定工作区处理；真实包签名和库存仍由
 * reverifyInstalled 检查，未知旧索引、额外字段或超额成员保持失败而不重建一个空目录列表。
 */
async function catalog(profile: string): Promise<CachedBundle[]> {
    let value: unknown;
    try {
        value = await readPrivate<unknown>(profile, "desktop-bundles.json");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    if (!Array.isArray(value) || value.length > 1000)
        throw new Error("LOCAL_RETENTION_CATALOG_INVALID");
    const ids = new Set<string>();
    for (const item of value as CachedBundle[]) {
        if (
            !item ||
            typeof item !== "object" ||
            Object.keys(item).some(
                (key) =>
                    !["id", "workspaceId", "engineVersion", "createdAt", "debug"].includes(key),
            ) ||
            validateSchema("Id", item.id).length ||
            validateSchema("Id", item.workspaceId).length ||
            ids.has(item.id) ||
            typeof item.engineVersion !== "string" ||
            item.engineVersion.length > 80 ||
            validateSchema("Timestamp", item.createdAt).length ||
            typeof item.debug !== "boolean"
        )
            throw new Error("LOCAL_RETENTION_CATALOG_INVALID");
        ids.add(item.id);
    }
    return value as CachedBundle[];
}

/** 退休意图包含已经核验的完整有限库存，重启只接受同一 Bundle UUID 的确定退休名并重新核验每个实际文件的摘要；
 * 部分删除后的清单允许真实缺失，未识别 JSON 或其他路径保持拒绝，不把未知临时目录当作自有清理目标。
 */
function inventory(value: string, bundleId: string): RetentionFile[] {
    const parsed = JSON.parse(value) as { bundleId: string; files: RetentionFile[] };
    if (
        parsed.bundleId !== bundleId ||
        !Array.isArray(parsed.files) ||
        parsed.files.length > MAX_FILES ||
        parsed.files.some(
            (file) =>
                !file ||
                !safePath(file.path) ||
                file.path.split("/").length > 16 ||
                !Number.isSafeInteger(file.sizeBytes) ||
                file.sizeBytes < 0 ||
                file.sizeBytes > 32 * 1024 * 1024 ||
                !/^[0-9a-f]{64}$/.test(file.sha256),
        )
    )
        throw new Error("LOCAL_RETENTION_INTENT_INVALID");
    return parsed.files;
}

/**
 * 一次维护窗口先封住真实桌面和在线拥有者，再持续持有 SQLite 空闲事务，只有缓存隔离前的意图提交需要短暂重开同一写锁；
 * 重新加锁后若发现新离线占用立即停止，尚未执行任何文件删除，不能把一次只读 idle 查询当作长期执行许可
 * 。
 */
export async function pruneLocalProfile(
    profileRoot: string,
    options: LocalRetentionOptions,
): Promise<LocalRetentionResult> {
    const profile = resolve(profileRoot),
        workspace = options.workspaceId;
    if (validateSchema("Id", workspace).length)
        throw new Error("LOCAL_RETENTION_WORKSPACE_INVALID");
    const policy = {
        metadata: budget(options.metadataDays, 90, 3650),
        bundle: budget(options.bundleDays, 14, 3650),
        success: budget(options.rawSuccessDays, 14, 3650),
        failure: budget(options.rawFailureDays, 30, 3650),
        batch: budget(options.batchSize, 50, 100),
    };
    const result: LocalRetentionResult = {
        examinedRuns: 0,
        rawRetiredRuns: 0,
        metadataRetiredRuns: 0,
        bundlesRetired: 0,
        retained: 0,
        hasMore: false,
    };
    let desktopRelease: (() => Promise<void>) | undefined,
        onlineRelease: (() => Promise<void>) | undefined;
    let owner: VaultFiles | undefined,
        store: LocalStore | undefined,
        end: ((commit: boolean) => void) | undefined;
    let usedFiles = 0,
        usedBytes = 0;
    const fits = (files: RetentionFile[]) =>
        usedFiles + files.length <= MAX_FILES &&
        usedBytes + files.reduce((sum, file) => sum + file.sizeBytes, 0) <= MAX_BYTES;
    const charge = (files: RetentionFile[]) => {
        usedFiles += files.length;
        usedBytes += files.reduce((sum, file) => sum + file.sizeBytes, 0);
    };
    try {
        if (options.desktopOwner) {
            if (!ownsDesktopProfile(options.desktopOwner, profile))
                throw new Error("LOCAL_RETENTION_OWNER_INVALID");
        } else desktopRelease = (await acquireDesktopProfileOwner(profile)).release;
        owner = await VaultFiles.acquire(join(profile, "agent-owner"));
        onlineRelease = await lockfile.lock(join(profile, "agent-owner"), {
            realpath: false,
            retries: 0,
        });
        await requireStoppedHistory(join(profile, "agent"));
        store = await LocalStore.open(join(profile, "offline"));
        end = store.beginRetention();
        await requireOfflineStopped(join(profile, "offline"), store);
        const now = Date.now(),
            rows = store.retentionRuns(workspace, now, policy.batch);
        result.hasMore = rows.length === policy.batch;
        const processes = new ProcessSupervisor(join(profile, "offline", "processes"));
        for (const row of rows) {
            result.examinedRuns++;
            let document: OfflineResultV1;
            try {
                document = JSON.parse(String(row.result)) as OfflineResultV1;
            } catch {
                result.retained++;
                continue;
            }
            const receipts = validateSchema("OfflineResultV1", document).length
                ? undefined
                : store.retentionStops(document);
            const age = now - Math.max(Number(row.firstObserved), Number(row.lastAccess));
            if (
                !receipts ||
                document.workspaceId !== workspace ||
                document.localRunId !== row.id ||
                !Number.isFinite(age) ||
                age < 0 ||
                !Number.isFinite(Date.parse(document.finishedAt)) ||
                Date.parse(document.finishedAt) > now
            ) {
                result.retained++;
                continue;
            }
            let stopped = true;
            for (const receipt of receipts) {
                if (
                    receipt.processStopScope !== "NO_PROCESS_SPAWNED" &&
                    !(await processes.confirmStopped(receipt.attemptId))
                )
                    stopped = false;
            }
            if (!stopped) {
                result.retained++;
                continue;
            }
            const rawDays = document.outcome === "PASSED" ? policy.success : policy.failure;
            const metadata = age >= policy.metadata * DAY;
            if (age < rawDays * DAY) {
                result.retained++;
                continue;
            }
            if (row.rawRetired !== 1) {
                let complete = true;
                artifacts: for (const attempt of document.attempts)
                    for (const file of attempt.artifacts) {
                        if (
                            store.artifactRetired(
                                workspace,
                                document.localRunId,
                                attempt.attemptId,
                                file,
                            )
                        )
                            continue;
                        if (!fits([file])) {
                            complete = false;
                            result.hasMore = true;
                            break artifacts;
                        }
                        charge([file]);
                        try {
                            await retireEvidence(profile, attempt.attemptId, file);
                        } catch {
                            complete = false;
                            break artifacts;
                        }
                        store.retireArtifact(
                            workspace,
                            document.localRunId,
                            attempt.attemptId,
                            file,
                        );
                    }
                if (!complete) {
                    result.retained++;
                    continue;
                }
                store.retireRun(workspace, String(row.id), false);
                result.rawRetiredRuns++;
            } else if (!metadata) {
                result.retained++;
                continue;
            }
            if (metadata) {
                try {
                    for (const attempt of document.attempts) {
                        let bytes: Buffer;
                        try {
                            bytes = await readBoundedFile(
                                join(
                                    profile,
                                    "offline",
                                    "work",
                                    attempt.attemptId,
                                    "metadata",
                                    "report-display.json",
                                ),
                                1024 * 1024,
                                true,
                            );
                        } catch (error) {
                            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
                            throw error;
                        }
                        if (
                            validateSchema("ReportDisplayV1", JSON.parse(bytes.toString("utf8")))
                                .length
                        )
                            throw new Error("INVALID_REPORT_DISPLAY");
                        const file = {
                            path: "report-display.json",
                            sizeBytes: bytes.length,
                            sha256: digest(bytes),
                        };
                        if (!fits([file])) {
                            result.hasMore = true;
                            throw new Error("LOCAL_RETENTION_BATCH_LIMIT");
                        }
                        charge([file]);
                        await retireEvidence(profile, attempt.attemptId, file, true);
                    }
                } catch {
                    result.retained++;
                    continue;
                }
                store.retireRun(workspace, String(row.id), true);
                result.metadataRetiredRuns++;
            }
        }
        const bundles = await catalog(profile),
            candidates = new Map<string, RetentionFile[]>();
        for (const pending of store.pendingCacheRetirements(workspace, policy.batch)) {
            candidates.set(
                String(pending.bundleId),
                inventory(String(pending.retirement), String(pending.bundleId)),
            );
        }
        for (const item of bundles.filter((item) => item.workspaceId === workspace)) {
            const lifecycle = store.observeCache(workspace, item.id, now);
            if (!lifecycle || lifecycle.retirement === "COMPLETE" || candidates.has(item.id))
                continue;
            const age =
                now - Math.max(Number(lifecycle.firstObserved), Number(lifecycle.lastAccess));
            if (
                age < policy.bundle * DAY ||
                age < 0 ||
                !Number.isFinite(age) ||
                store.cacheReferenced(item.id)
            ) {
                result.retained++;
                continue;
            }
            if (candidates.size >= policy.batch) {
                result.hasMore = true;
                break;
            }
            try {
                const checked = await reverifyInstalled(join(profile, "bundles", item.id), {
                    trust: new TrustStore(profile),
                    workspaceId: workspace,
                    debug: true,
                });
                if (checked.manifest.bundleId !== item.id)
                    throw new Error("BUNDLE_WORKSPACE_MISMATCH");
                const files: RetentionFile[] = [
                    ...checked.manifest.files,
                    {
                        path: "manifest.json",
                        sizeBytes: checked.manifestRaw.length,
                        sha256: digest(checked.manifestRaw),
                    },
                    {
                        path: "manifest.sig",
                        sizeBytes: 64,
                        sha256: digest(
                            await readBoundedFile(
                                join(profile, "bundles", item.id, "manifest.sig"),
                                64,
                            ),
                        ),
                    },
                ];
                if (!fits(files)) {
                    result.retained++;
                    result.hasMore = true;
                    continue;
                }
                store.cacheRetirement(
                    workspace,
                    item.id,
                    JSON.stringify({ bundleId: item.id, files }),
                );
                candidates.set(item.id, files);
            } catch {
                result.retained++;
            }
        }
        /** 清单意图必须先得到真实 FULL 提交才可能隔离缓存，提交之后再取得写锁并重新检查所有离线占用；
         * 这段窗口从不删除文件，异常保留持久意图让下次在相同所有权边界下重做。
         */
        if (candidates.size) {
            const release = end;
            end = undefined;
            release(true);
            end = store.beginRetention();
            await requireOfflineStopped(join(profile, "offline"), store);
            for (const [bundleId, files] of candidates) {
                if (store.cacheReferenced(bundleId) || !fits(files)) {
                    result.retained++;
                    result.hasMore = true;
                    continue;
                }
                charge(files);
                try {
                    await retireInventory(profile, bundleId, files);
                } catch {
                    result.retained++;
                    continue;
                }
                await updatePrivate<CachedBundle[]>(profile, "desktop-bundles.json", (old) =>
                    (old ?? []).filter(
                        (item) => item.id !== bundleId || item.workspaceId !== workspace,
                    ),
                );
                store.completeCacheRetirement(workspace, bundleId);
                result.bundlesRetired++;
            }
        }
        const release = end;
        end = undefined;
        release(true);
        return result;
    } finally {
        try {
            end?.(false);
        } finally {
            try {
                store?.close();
            } finally {
                try {
                    await onlineRelease?.();
                } finally {
                    try {
                        await owner?.close();
                    } finally {
                        await desktopRelease?.();
                    }
                }
            }
        }
    }
}
