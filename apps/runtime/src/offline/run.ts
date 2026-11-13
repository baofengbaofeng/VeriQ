/**
 * 本文件驱动断网宿主执行离线包：不经 AgentClient、租约或平台传输：并支持显式恢复与取消时隔离未知进程（run）。
 */

/** Disconnected host execution. No AgentClient, lease or platform transport is involved. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, readdir, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
    canonicalBytes,
    validateSchema,
    type AssetSnapshotV1,
    type ExecutionSnapshotV1,
    type EnvironmentV1,
    type OfflineResultV1,
    type OfflineAttemptV1,
    type CompiledAssetBundle,
    type Browser,
    type Outcome,
} from "@veriq/contracts";
import type { CaseResult } from "@veriq/runner-sdk";
import { ProcessSupervisor, type StopReceipt, type OwnedProcess } from "../execution/processes.ts";
import { AttemptBroker } from "../execution/broker.ts";
import { executionEvent, sdkFact, type Fact, type SdkEvent } from "../execution/events.ts";
import { loadRelease, sha256 } from "../execution/release.ts";
import { monitorStorage } from "../execution/storage.ts";
import { type SecretStore, SecretResolver } from "../credentials/store.ts";
import { LocalStore, type Ownership } from "./store.ts";
import { reverifyInstalled, type VerifiedBundle } from "./verify.ts";
import type { TrustStore } from "./trust.ts";
import { readBoundedFile } from "./config.ts";
import {
    developmentExecutionPaths,
    containedPath,
    type ExecutionPaths,
} from "../execution/paths.ts";
import { offlineWorkerEnvironment } from "./worker-environment.ts";
/**
 * 公开接口 OfflineConfig 描述断网执行所需的本机目录、浏览器与发行配置：不含任何平台租约字段（OfflineConfig）。
 */
export interface OfflineConfig {
    root: string;
    trust: TrustStore;
    secrets: SecretStore;
    releaseDirectory: string;
    browserExecutable: string;
    /** 离线宿主从完整发行清单选择执行角色及辅助模块路径，签名包仅选择受支持引擎版本而不携带可执行路径；源码开发调用可缺省，已安装入口必须显式提供已验证配置。 */
    execution?: ExecutionPaths;
    deviceId: string;
    debug?: boolean;
    /** 桌面宿主可以明确选择可见浏览器，默认仍保持无头执行；此字段只影响当前启动配置，不修改签名业务快照，宿主必须先证明安装的浏览器具备所选择的显示能力。 */
    headless?: boolean;
    signal?: AbortSignal;
    browsers?: Browser[];
    retry?: boolean;
    /** A trusted native host explicitly authorizes each public routing override. */
    overrides?: {
        baseURL?: string;
        apiBaseURL?: string;
        fixtureBaseURL?: string;
    };
    authorizeOverride?: (field: string, value: string) => boolean;
}
type Checked = Awaited<ReturnType<typeof reverifyInstalled>>;
const variantKey = (execution: ExecutionSnapshotV1) =>
    sha256(
        canonicalBytes([
            execution.caseVersionId,
            execution.suiteEntryIndex ?? 0,
            execution.roleKey,
            execution.browser,
            execution.datasetVersionId ?? null,
            execution.dataRow?.key ?? null,
        ]),
    );
const code = (error: unknown) =>
    error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
        ? error.message
        : "OFFLINE_EXECUTION_ERROR";
const aggregate = (outcomes: string[]): Outcome =>
    (
        ["ERROR", "INCOMPLETE", "FAILED", "CANCELLED", "UNSTABLE", "SKIPPED", "PASSED"] as Outcome[]
    ).find((o) => outcomes.includes(o)) ?? "INCOMPLETE";
function selectedSuite(checked: Checked): string | undefined {
    const selection = JSON.parse(checked.contents.get("selection.json")!.toString()) as {
        suiteVersionId?: string;
    };
    return (
        selection.suiteVersionId ??
        (checked.dslOnly &&
        checked.snapshot.assets.some(
            (a) =>
                a.versionId === checked.snapshot.validationTarget?.versionId && a.kind === "SUITE",
        )
            ? checked.snapshot.validationTarget!.versionId
            : undefined)
    );
}
function compilationRoot(checked: Checked, caseVersionId: string): string {
    return selectedSuite(checked) ?? caseVersionId;
}
function variants(checked: Checked, runId: string, config: OfflineConfig): ExecutionSnapshotV1[] {
    const source = checked.snapshot;
    const selection = JSON.parse(checked.contents.get("selection.json")!.toString()) as {
        environmentVersionId: string;
        suiteVersionId?: string;
        caseVersionIds?: string[];
    };
    const environment = structuredClone(
        source.assets.find((a) => a.versionId === selection.environmentVersionId)?.document,
    ) as unknown as EnvironmentV1;
    if (!environment) throw new Error("BUNDLE_ENVIRONMENT_MISSING");
    for (const [field, value] of Object.entries(config.overrides ?? {})) {
        if (
            !["baseURL", "apiBaseURL", "fixtureBaseURL"].includes(field) ||
            !config.authorizeOverride?.(field, value)
        )
            throw new Error("ENVIRONMENT_OVERRIDE_UNAUTHORIZED");
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
            throw new Error("INVALID_ENVIRONMENT_OVERRIDE");
        (environment as unknown as Record<string, unknown>)[field] = value;
        if (!environment.allowedOrigins.includes(url.origin))
            environment.allowedOrigins.push(url.origin);
    }
    const suiteId = selectedSuite(checked);
    const suite = suiteId ? source.assets.find((a) => a.versionId === suiteId) : undefined;
    type Entry = {
        versionId: string;
        roleKeys?: string[];
        browsers?: Browser[];
        datasetVersionId?: string;
    };
    const entries: Entry[] = suite
        ? (
              suite.document as unknown as {
                  cases: Entry[];
              }
          ).cases
        : (selection.caseVersionIds ?? source.entryCaseVersionIds).map((versionId) => ({
              versionId,
          }));
    const executions: ExecutionSnapshotV1[] = [];
    for (const [index, entry] of entries.entries()) {
        const asset = source.assets.find(
            (a) => a.versionId === entry.versionId && a.kind === "CASE",
        );
        if (!asset) throw new Error("BUNDLE_CASE_MISSING");
        const document = asset.document as unknown as {
            roleKey: string;
            datasetVersionId?: string;
            fixtureVersionId?: string;
        };
        const datasetId = entry.datasetVersionId ?? document.datasetVersionId;
        const rows = datasetId
            ? (
                  source.assets.find((a) => a.versionId === datasetId)?.document as unknown as {
                      rows: ExecutionSnapshotV1["dataRow"][];
                  }
              )?.rows
            : [undefined];
        if (!rows) throw new Error("BUNDLE_DATASET_MISSING");
        const original = checked.dslOnly
            ? (JSON.parse(checked.contents.get("draft/source.json")!.toString()) as AssetSnapshotV1)
            : (JSON.parse(
                  checked.contents
                      .get(`provenance/${compilationRoot(checked, entry.versionId)}/source.json`)!
                      .toString(),
              ) as AssetSnapshotV1);
        for (const roleKey of entry.roleKeys ?? [document.roleKey])
            for (const browser of entry.browsers ?? config.browsers ?? ["chromium"])
                for (const dataRow of rows) {
                    const role = environment.roles.find((r) => r.roleKey === roleKey);
                    if (!role) throw new Error("ROLE_UNAVAILABLE");
                    const identities = [
                        role,
                        ...(document.fixtureVersionId && environment.fixtureIdentity
                            ? [environment.fixtureIdentity]
                            : []),
                    ];
                    if (document.fixtureVersionId && !environment.fixtureIdentity)
                        throw new Error("FIXTURE_IDENTITY_REQUIRED");
                    const caseExecutionId = randomUUID();
                    const execution: ExecutionSnapshotV1 = {
                        schemaVersion: "1.0",
                        workspaceId: source.workspaceId,
                        runId,
                        caseExecutionId,
                        caseVersionId: entry.versionId,
                        assetSourceHash: original.sourceHash,
                        environmentVersionId: selection.environmentVersionId,
                        environment,
                        roleKey,
                        browser,
                        variables: {},
                        secretVersions: identities.map((r) => ({
                            secretRef: r.secretRef,
                            versionId: r.secretVersionId,
                        })),
                        authAdapters: source.authAdapters ?? [],
                        namespace: "attempt_" + caseExecutionId.replaceAll("-", ""),
                        attemptNo: 1,
                        suiteEntryIndex: index,
                        ...(dataRow ? { dataRow, datasetVersionId: datasetId! } : {}),
                    };
                    if (validateSchema("ExecutionSnapshotV1", execution).length)
                        throw new Error("INVALID_EXECUTION_SNAPSHOT");
                    executions.push(execution);
                    if (executions.length > 1000) throw new Error("MATRIX_LIMIT");
                }
    }
    if (!executions.length) throw new Error("EMPTY_EXECUTION_MATRIX");
    return executions;
}
async function attempt(
    checked: Checked,
    execution: ExecutionSnapshotV1,
    attemptId: string,
    config: OfflineConfig,
    store: LocalStore,
    processes: ProcessSupervisor,
    ownership: Ownership,
): Promise<{
    result: OfflineAttemptV1;
    owner: Ownership;
}> {
    let owner = ownership;
    const runId = execution.runId,
        work = join(config.root, "work", attemptId),
        artifacts: OfflineAttemptV1["artifacts"] = [];
    let diagnostics: OfflineAttemptV1["diagnostics"];
    let sequence = 0,
        caseResult: CaseResult | undefined,
        child: OwnedProcess | undefined,
        broker: AttemptBroker | undefined,
        tmp: string | undefined,
        stop: StopReceipt | undefined,
        failure: string | undefined,
        spawning = false;
    let monitor: ReturnType<typeof monitorStorage> | undefined;
    const controller = new AbortController(),
        abort = () => controller.abort();
    config.signal?.addEventListener("abort", abort, { once: true });
    if (config.signal?.aborted) abort();
    const append = (fact: Fact) =>
        store.append(runId, executionEvent(attemptId, ++sequence, fact), owner);
    const resolver = new SecretResolver(config.secrets);
    const context = {
        issuerId: checked.manifest.issuerId,
        workspaceId: execution.workspaceId,
        secretVersions: execution.secretVersions,
    };
    const add = async (
        path: string,
        kind: NonNullable<OfflineAttemptV1["artifacts"][number]["kind"]>,
        name: string,
    ) => {
        const bytes = await readBoundedFile(path, 32 * 1024 * 1024);
        await mkdir(join(work, "evidence"), { recursive: true, mode: 0o700 });
        await writeFile(join(work, "evidence", name), bytes, {
            mode: 0o600,
            flag: "wx",
            flush: true,
        });
        const file = {
            path: name,
            sha256: sha256(bytes),
            sizeBytes: bytes.length,
            sensitivity: "CREDENTIAL_RESTRICTED" as const,
        };
        const artifactId = randomUUID();
        artifacts.push({ ...file, kind, artifactId });
        append({ type: "ARTIFACT_CREATED", payload: { artifactId, kind, file } });
    };
    try {
        append({
            type: "ATTEMPT_STARTED",
            payload: {
                engineVersion: checked.manifest.engineVersion,
                sourceHash: execution.assetSourceHash,
            },
        });
        if (controller.signal.aborted || store.cancelled(runId)) throw new Error("USER_CANCELLED");
        // Fail explicitly before launching; secrets stay in this host and private IPC only.
        for (const pin of execution.secretVersions)
            await resolver.resolve(
                { ...context, secretRef: pin.secretRef, versionId: pin.versionId },
                context,
            );
        const release = await loadRelease(config.releaseDirectory, checked.manifest.engineVersion);
        await mkdir(work, { recursive: true, mode: 0o700 });
        tmp = await mkdtemp(join(tmpdir(), "veriq-o-"));
        const write = async (path: string, bytes: Uint8Array) => {
            await mkdir(dirname(join(work, path)), { recursive: true, mode: 0o700 });
            await writeFile(join(work, path), bytes, { mode: 0o600, flag: "wx" });
        };
        if (checked.dslOnly) {
            for (const [path, bytes] of Object.entries(release.files)) await write(path, bytes);
            await write("source/asset-snapshot.json", checked.contents.get("draft/source.json")!);
        } else {
            const descriptor = JSON.parse(
                checked.contents
                    .get(
                        `provenance/${compilationRoot(checked, execution.caseVersionId)}/descriptor.json`,
                    )!
                    .toString(),
            ) as CompiledAssetBundle;
            await write("bundle.json", canonicalBytes(descriptor));
            for (const file of descriptor.files)
                await write(
                    file.path,
                    checked.contents.get(
                        `compiled/${compilationRoot(checked, execution.caseVersionId)}/${file.path}`,
                    )!,
                );
            for (const [path, bytes] of Object.entries(release.files)) {
                if (path === "engine/compiler.tgz") await write(path, bytes);
                else if (sha256(await readFile(join(work, path))) !== sha256(bytes))
                    throw new Error("UNAPPROVED_ENGINE_BYTES");
            }
        }
        await write("execution.json", canonicalBytes(execution));
        await write("release.json", canonicalBytes(release.entry));
        broker = new AttemptBroker(join(tmp, "control.sock"), async (message) => {
            if (message.type === "status")
                return { cancelled: controller.signal.aborted || store.cancelled(runId) };
            if (message.type === "credential") {
                if (controller.signal.aborted || store.cancelled(runId))
                    throw new Error("ATTEMPT_STOPPING");
                return resolver.resolve(
                    {
                        ...(message.reference as {
                            workspaceId: string;
                            secretRef: string;
                            versionId: string;
                        }),
                        issuerId: checked.manifest.issuerId,
                    },
                    context,
                );
            }
            if (message.type === "event") {
                const event = message.event as SdkEvent;
                append(sdkFact(event));
                if (event.type === "CASE_FINISHED") caseResult = event.result;
                return {};
            }
            if (message.type === "restricted") {
                const evidence = message.evidence as {
                    kind: string;
                    path: string;
                    sensitivity: string;
                };
                if (
                    evidence.kind !== "DOWNLOAD" ||
                    evidence.sensitivity !== "CREDENTIAL_RESTRICTED" ||
                    !containedPath(tmp!, resolve(evidence.path))
                )
                    throw new Error("UNSAFE_EVIDENCE");
                await add(evidence.path, "DOWNLOAD", `download-${artifacts.length}.bin`);
                return {};
            }
            throw new Error("INVALID_IPC_OPERATION");
        });
        await broker.open();
        const executionPaths = config.execution ?? developmentExecutionPaths();
        const invocation = {
            kind: "TEST",
            work,
            tmp,
            socket: broker.path,
            nonce: broker.nonce,
            downloads: join(tmp, "downloads"),
            downloadLimit: 16 * 1024 * 1024,
            npmCli: executionPaths.npmCli,
            tsx: executionPaths.tsx,
            localDraftCompile: checked.dslOnly,
        };
        await mkdir(invocation.downloads, { mode: 0o700 });
        await write("invocation.json", canonicalBytes(invocation));
        for (const file of ["provider.mjs", "compile-entry.mjs"])
            await copyFile(
                file === "provider.mjs"
                    ? executionPaths.providerEntry
                    : executionPaths.compileEntry,
                join(work, file),
            );
        const pw = {
            testDir: "./cases",
            testMatch: `${execution.caseVersionId}.test.ts`,
            workers: 1,
            retries: 0,
            reporter: [
                ["json", { outputFile: join(tmp, "playwright.json") }],
                ["junit", { outputFile: join(tmp, "junit.xml") }],
                ["html", { outputFolder: join(tmp, "html"), open: "never" }],
            ],
            outputDir: join(tmp, "test-results"),
            use: {
                headless: config.headless ?? true,
                browserName: execution.browser,
                locale: execution.environment.locale,
                timezoneId: execution.environment.timezone,
                serviceWorkers: "block",
                trace: "on",
                launchOptions: {
                    executablePath: config.browserExecutable,
                    args: ["--no-sandbox"],
                    downloadsPath: invocation.downloads,
                },
            },
        };
        await write("playwright.config.mjs", Buffer.from(`export default ${JSON.stringify(pw)};`));
        if (controller.signal.aborted || store.cancelled(runId)) throw new Error("USER_CANCELLED");
        const environment = offlineWorkerEnvironment(
            tmp,
            join(work, "provider.mjs"),
            config.headless ?? true,
            process.env,
            { runnerExecutable: executionPaths.runnerExecutable },
        );
        owner = store.spawning(runId, attemptId, owner);
        spawning = true;
        child = await processes.start(attemptId, {
            executable: executionPaths.runnerExecutable,
            args: [executionPaths.workerEntry, join(work, "invocation.json")],
            cwd: work,
            env: environment,
        });
        store.ensureOwner(owner);
        monitor = monitorStorage(tmp, 64 * 1024 * 1024, async (why) => {
            failure = why;
            controller.abort();
            await processes.terminateAttempt(attemptId, why);
        });
        child.send({ type: "START" });
        let exited = false;
        void child.exited.then(() => {
            exited = true;
        });
        while (!exited && !controller.signal.aborted && !store.cancelled(runId))
            await Promise.race([child.exited, delay(100)]);
        if (!exited) {
            controller.abort();
            failure ??= "USER_CANCELLED";
            await Promise.race([child.exited, delay(1000)]);
        }
        stop = await processes.terminateAttempt(attemptId, failure ?? "COMPLETED");
        if (!stop.processStopped) throw new Error("PROCESS_STOP_UNCONFIRMED");
        if (!caseResult) {
            try {
                const worker = JSON.parse(await readFile(join(work, "worker-result.json"), "utf8"));
                failure ??= worker.failureCode;
                diagnostics = worker.diagnostics;
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            }
            failure ??= "MISSING_CASE_RESULT";
        }
        for (const [path, name, kind] of [
            ["junit.xml", "junit.xml", "JUNIT"],
            ["html/index.html", "report.html", "HTML"],
            ["screenshot.png", "screenshot.png", "SCREENSHOT"],
        ] as const) {
            try {
                await add(join(tmp, path), kind, name);
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            }
        }
        const traces: string[] = [];
        async function visit(path: string): Promise<void> {
            for (const entry of await readdir(path, { withFileTypes: true })) {
                if (entry.isDirectory()) await visit(join(path, entry.name));
                else if (entry.name === "trace.zip") traces.push(join(path, entry.name));
            }
        }
        await visit(tmp);
        for (const path of traces) await add(path, "TRACE", `trace-${artifacts.length}.zip`);
        if (caseResult && !traces.length) failure ??= "REQUIRED_EVIDENCE_MISSING";
    } catch (error) {
        failure ??= code(error);
    } finally {
        monitor?.close();
        config.signal?.removeEventListener("abort", abort);
        await broker?.close();
        stop ??= spawning
            ? await processes.terminateAttempt(attemptId, failure ?? "EXECUTION_ERROR")
            : {
                  attemptId,
                  processStopped: true,
                  reason: "NO_PROCESS_SPAWNED",
                  stoppedAt: new Date().toISOString(),
              };
        owner = store.stopped(runId, stop, owner);
        if (stop.processStopped) {
            if (tmp) await rm(tmp, { recursive: true, force: true });
            await rm(join(work, "node_modules"), { recursive: true, force: true });
        }
    }
    if (!caseResult) {
        append({
            type: "CLEANUP_RESULT",
            payload: { cleanupStatus: spawning ? "PENDING" : "NOT_REQUIRED" },
        });
        append({
            type: "ATTEMPT_FINISHED",
            payload: {
                outcome: failure === "USER_CANCELLED" ? "CANCELLED" : "ERROR",
                cleanupStatus: spawning ? "PENDING" : "NOT_REQUIRED",
            },
        });
    }
    const outcome = failure
        ? failure === "USER_CANCELLED"
            ? "CANCELLED"
            : failure === "REQUIRED_EVIDENCE_MISSING"
              ? "INCOMPLETE"
              : "ERROR"
        : (caseResult?.outcome ?? "INCOMPLETE");
    return {
        owner,
        result: {
            attemptId,
            caseVersionId: execution.caseVersionId,
            attemptNo: execution.attemptNo,
            outcome,
            cleanupStatus: caseResult?.cleanupStatus ?? (spawning ? "PENDING" : "NOT_REQUIRED"),
            lastSequence: sequence,
            events: store.events(execution.workspaceId, runId, attemptId, 0, 10000),
            artifacts,
            execution,
            processStopped: stop.processStopped,
            retrySafety: caseResult?.retrySafety ?? "UNKNOWN",
            sourceKind: checked.dslOnly ? "DRAFT_DEBUG" : "PUBLISHED",
            variantKey: variantKey(execution),
            ...((failure ?? caseResult?.errorCode)
                ? { failureCode: (failure ?? caseResult?.errorCode)! }
                : {}),
            ...(diagnostics ? { diagnostics } : {}),
        },
    };
}
/**
 * 公开函数 runOffline 校验包后在本机监督器中执行离线用例：结果写入 LocalStore：全程不创建 AgentClient。
 */
export async function runOffline(
    bundle: Pick<VerifiedBundle, "directory">,
    config: OfflineConfig,
): Promise<OfflineResultV1> {
    if (config.headless !== undefined && typeof config.headless !== "boolean")
        throw new Error("INVALID_BROWSER_MODE");
    const checked = await reverifyInstalled(bundle.directory, {
        trust: config.trust,
        ...(config.debug !== undefined ? { debug: config.debug } : {}),
    });
    const choices = { browsers: config.browsers ?? ["chromium"] };
    if (validateSchema("OfflineExecutionChoicesV1", choices).length)
        throw new Error("INVALID_EXECUTION_CHOICES");
    const executionChoices = choices as NonNullable<OfflineResultV1["executionChoices"]>;
    const runId = randomUUID(),
        executions = variants(checked, runId, config),
        attempts: OfflineAttemptV1[] = [];
    const store = await LocalStore.open(config.root),
        processes = new ProcessSupervisor(
            join(config.root, "processes"),
            500,
            config.execution?.guardianExecutable,
        );
    const startedAt = new Date().toISOString();
    let attemptId = randomUUID();
    try {
        const initial = (execution: ExecutionSnapshotV1): OfflineResultV1 => {
            const pending: OfflineResultV1["attempts"] = [
                {
                    attemptId,
                    caseVersionId: execution.caseVersionId,
                    attemptNo: execution.attemptNo,
                    outcome: "INCOMPLETE",
                    cleanupStatus: "PENDING",
                    lastSequence: 0,
                    events: [],
                    artifacts: [],
                    execution,
                    variantKey: variantKey(execution),
                    processStopped: false,
                },
            ];
            // Keep retry ordering while atomically handing ownership to its durable checkpoint.
            pending.unshift(...attempts);
            return {
                schemaVersion: "1.0",
                workspaceId: checked.manifest.workspaceId,
                bundleId: checked.manifest.bundleId,
                localRunId: runId,
                deviceId: config.deviceId,
                source: "OFFLINE_IMPORT",
                trustStatus: "USER_REGISTERED",
                dirty: checked.debug || Object.keys(config.overrides ?? {}).length > 0,
                revocationStatus: "UNKNOWN",
                manifestSha256: sha256(checked.manifestRaw),
                startedAt,
                finishedAt: startedAt,
                outcome: "INCOMPLETE",
                executionChoices,
                actualEnvironment: executions[0]!.environment,
                attempts: pending,
            };
        };
        let owner = store.reserve(
            checked.manifest.workspaceId,
            runId,
            attemptId,
            initial(executions[0]!),
        );
        for (const execution of executions) {
            if (attempts.length) {
                attemptId = randomUUID();
                owner = store.nextAttempt(runId, attemptId, owner, initial(execution));
            }
            store.checkpoint(initial(execution), owner);
            const firstRun = await attempt(
                checked,
                execution,
                attemptId,
                config,
                store,
                processes,
                owner,
            );
            owner = firstRun.owner;
            const first = firstRun.result;
            attempts.push(first);
            if (!first.processStopped || store.cancelled(runId) || config.signal?.aborted) break;
            if (
                config.retry &&
                ["FAILED", "ERROR"].includes(first.outcome) &&
                (await safeRetry(checked, first, config.root))
            ) {
                attemptId = randomUUID();
                const retriedExecution = {
                    ...execution,
                    attemptNo: 2,
                    namespace: "attempt_" + randomUUID().replaceAll("-", ""),
                };
                owner = store.nextAttempt(runId, attemptId, owner, initial(retriedExecution));
                const secondRun = await attempt(
                    checked,
                    retriedExecution,
                    attemptId,
                    config,
                    store,
                    processes,
                    owner,
                );
                owner = secondRun.owner;
                const second = secondRun.result;
                attempts.push(second);
                if (!second.processStopped) break;
            }
        }
        const caseOutcomes = executions.map((e) => {
            const rows = attempts.filter((a) => a.execution?.caseExecutionId === e.caseExecutionId);
            return rows.length === 2 && rows[1]!.outcome === "PASSED"
                ? "UNSTABLE"
                : (rows.at(-1)?.outcome ?? "CANCELLED");
        });
        const result: OfflineResultV1 = {
            schemaVersion: "1.0",
            workspaceId: checked.manifest.workspaceId,
            bundleId: checked.manifest.bundleId,
            localRunId: runId,
            deviceId: config.deviceId,
            source: "OFFLINE_IMPORT",
            trustStatus: "USER_REGISTERED",
            dirty: checked.debug || Object.keys(config.overrides ?? {}).length > 0,
            revocationStatus: "UNKNOWN",
            manifestSha256: sha256(checked.manifestRaw),
            startedAt,
            finishedAt: new Date().toISOString(),
            outcome: aggregate(caseOutcomes),
            executionChoices,
            actualEnvironment: executions[0]!.environment,
            attempts: attempts as OfflineResultV1["attempts"],
        };
        if (validateSchema("OfflineResultV1", result).length)
            throw new Error("INVALID_OFFLINE_RESULT");
        store.finish(result, owner);
        return result;
    } finally {
        store.close();
    }
}
/**
 * 公开函数 recoverOffline 由原生宿主显式触发恢复或取消：对未知进程隔离容量：绝不自动释放未排空进程（recoverOffline/LOCAL_OWNERSHIP_CHANGED）。
 */
export async function recoverOffline(root: string): Promise<StopReceipt | undefined> {
    const store = await LocalStore.open(root);
    try {
        let owner: Ownership | undefined;
        for (let tries = 0; tries < 3 && !owner; tries++) {
            const observed = store.active();
            if (!observed) return;
            owner = store.claimRecovery(observed);
        }
        if (!owner) throw new Error("LOCAL_OWNERSHIP_CHANGED");
        const stop =
            owner.state === "RECOVERING_UNSPAWNED"
                ? {
                      attemptId: owner.attemptId,
                      processStopped: true,
                      reason: "NO_PROCESS_SPAWNED",
                      stoppedAt: new Date().toISOString(),
                  }
                : await new ProcessSupervisor(join(root, "processes")).terminateAttempt(
                      owner.attemptId,
                      "LOCAL_RECOVERY",
                  );
        owner = store.stopped(owner.runId, stop, owner);
        const result = store.result(owner.workspaceId, owner.runId);
        result.outcome = "INCOMPLETE";
        result.finishedAt = new Date().toISOString();
        for (const attempt of result.attempts) {
            if (attempt.attemptId !== owner.attemptId) continue;
            attempt.events = store.events(
                owner.workspaceId,
                owner.runId,
                attempt.attemptId,
                0,
                10000,
            );
            attempt.lastSequence = attempt.events.length;
            attempt.processStopped = stop.processStopped;
            attempt.outcome = "INCOMPLETE";
            attempt.failureCode = "LOCAL_RECOVERY";
        }
        store.finish(result, owner);
        return stop;
    } finally {
        store.close();
    }
}
async function safeRetry(
    checked: Checked,
    attempt: OfflineAttemptV1,
    root: string,
): Promise<boolean> {
    const asset = checked.snapshot.assets.find((a) => a.versionId === attempt.caseVersionId);
    const fixture = (
        asset?.document as
            | {
                  fixtureVersionId?: string;
              }
            | undefined
    )?.fixtureVersionId;
    if (fixture && attempt.cleanupStatus === "SUCCEEDED") return true;
    if (attempt.retrySafety !== "READ_ONLY_OBSERVED") return false;
    try {
        const raw = await readBoundedFile(
            join(root, "work", attempt.attemptId, "metadata/expected-plans.json"),
            1024 * 1024,
        );
        const plan = (
            JSON.parse(raw.toString()) as {
                cases: {
                    caseVersionId: string;
                    hasPotentialWrites?: boolean;
                }[];
            }
        ).cases.find((p) => p.caseVersionId === attempt.caseVersionId);
        return plan?.hasPotentialWrites === false;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}
