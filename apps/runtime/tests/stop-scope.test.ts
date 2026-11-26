import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ExecutionSupervisor } from "../src/execution/supervisor.ts";
import { LocalStore } from "../src/offline/store.ts";
import { LocalReports } from "../src/offline/reports.ts";
import { recoverOffline } from "../src/offline/run.ts";
import type { AgentClient, Claim } from "../src/agent/transport.ts";
import type { ExecutionEventV1, OfflineResultV1 } from "@veriq/contracts";
import { canonicalBytes, validateSchema } from "@veriq/contracts";
import { sha256 } from "../src/execution/release.ts";
import { developmentExecutionPaths } from "../src/execution/paths.ts";
import { ProcessSupervisor, type StopReceipt } from "../src/execution/processes.ts";
import { retireScratch, type TaskAllocation } from "../src/execution/storage.ts";

/**
 * 每个用例使用独立的真实 SQLite 档案及最小历史结果，范围声明必须由被测停止路径生成；夹具自身不提前填写停止字段，也不借
 * 默认平台或业务成功补造历史中的停止事实。
 */
function initial(): OfflineResultV1 {
    return {
        schemaVersion: "1.0",
        workspaceId: randomUUID(),
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
            baseURL: "https://business.test",
            apiBaseURL: "https://business.test",
            allowedOrigins: ["https://business.test"],
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
}

for (const spawning of [false, true]) {
    test(`offline recovery preserves actual scope and quarantine: spawning=${spawning}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vq-scope-")),
            result = initial();
        try {
            const store = await LocalStore.open(root);
            let owner = store.reserve(result.workspaceId, result.localRunId, result.attempts[0]!.attemptId, result);
            if (spawning) owner = store.spawning(owner.runId, owner.attemptId, owner);
            store.close();
            const receipt = await recoverOffline(root);
            assert.equal(receipt?.processStopped, !spawning);
            assert.equal(receipt?.processStopScope, spawning ? undefined : "NO_PROCESS_SPAWNED");
            const reopened = await LocalStore.open(root);
            const recovered = reopened.result(result.workspaceId, result.localRunId);
            assert.equal(recovered.attempts[0]!.processStopScope, receipt?.processStopScope);
            assert.equal(reopened.active()?.state, spawning ? "QUARANTINED" : undefined);
            reopened.close();
            const report = await new LocalReports(root, () => false).snapshot(result.workspaceId, result.localRunId);
            const facts = report.reports[0]!.cases[0]!.attempts[0]!.facts as Record<string, unknown>;
            assert.equal(facts.processStopScope, receipt?.processStopScope);
            assert.equal(facts.processStopped, !spawning);
            assert.equal(report.reports[0]!.gateNow.passed, false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("scope cannot bypass durable owner state or generation by changing the receipt reason", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-scope-owner-")),
        result = initial();
    const store = await LocalStore.open(root);
    try {
        const allocated = store.reserve(result.workspaceId, result.localRunId, result.attempts[0]!.attemptId, result);
        const spawning = store.spawning(allocated.runId, allocated.attemptId, allocated);
        assert.equal(store.unspawnedStop(spawning), undefined);
        assert.throws(() => store.unspawnedStop({ ...spawning, state: "ALLOCATED" }), /LOCAL_OWNERSHIP_LOST/);
        const receipt = {
            attemptId: spawning.attemptId,
            processStopped: true,
            processStopScope: "NO_PROCESS_SPAWNED" as const,
            reason: "RENAMED_FAILURE",
            stoppedAt: new Date().toISOString(),
        };
        assert.throws(() => store.stopped(spawning.runId, receipt, spawning), /LOCAL_OWNERSHIP_LOST/);
        assert.throws(
            () => store.stopped(spawning.runId, receipt, { ...spawning, state: "ALLOCATED" }),
            /LOCAL_OWNERSHIP_LOST/,
        );
        const recovering = store.claimRecovery(spawning)!;
        assert.throws(() => store.stopped(spawning.runId, receipt, spawning), /LOCAL_OWNERSHIP_LOST/);
        assert.throws(() => store.stopped(recovering.runId, receipt, recovering), /LOCAL_OWNERSHIP_LOST/);
        assert.equal(store.active()?.state, "RECOVERING");
    } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("offline stop atomically checkpoints scope before the host can finalize the result", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-scope-checkpoint-")),
        result = initial();
    try {
        const store = await LocalStore.open(root);
        const allocated = store.reserve(result.workspaceId, result.localRunId, result.attempts[0]!.attemptId, result);
        const receipt = store.unspawnedStop(allocated)!;
        store.stopped(allocated.runId, receipt, allocated);
        store.close();
        const reopened = await LocalStore.open(root);
        assert.equal(reopened.active()?.state, "STOPPED");
        assert.equal(
            reopened.result(result.workspaceId, result.localRunId).attempts[0]!.processStopScope,
            "NO_PROCESS_SPAWNED",
        );
        reopened.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a declared scope on an unconfirmed stop preserves quarantine and denies retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-scope-false-")),
        result = initial();
    const store = await LocalStore.open(root);
    try {
        let owner = store.reserve(result.workspaceId, result.localRunId, result.attempts[0]!.attemptId, result);
        owner = store.spawning(owner.runId, owner.attemptId, owner);
        owner = store.stopped(
            owner.runId,
            {
                attemptId: owner.attemptId,
                processStopped: false,
                processStopScope: "CONTROLLED_WORKER_BROWSER",
                reason: "UNCONFIRMED",
                stoppedAt: new Date().toISOString(),
            },
            owner,
        );
        assert.equal(owner.state, "QUARANTINED");
        assert.throws(() => store.nextAttempt(owner.runId, randomUUID(), owner, result), /LOCAL_CAPACITY_HELD/);
        const saved = store.result(result.workspaceId, result.localRunId);
        assert.equal(saved.attempts[0]!.processStopScope, "CONTROLLED_WORKER_BROWSER");
        assert.equal(saved.attempts[0]!.processStopped, false);
        const report = await new LocalReports(root, () => false).snapshot(result.workspaceId, result.localRunId);
        const facts = report.reports[0]!.cases[0]!.attempts[0]!.facts as Record<string, unknown>;
        assert.equal(facts.processStopped, false);
        assert.equal(facts.processStopScope, "CONTROLLED_WORKER_BROWSER");
        assert.equal(report.reports[0]!.gateNow.passed, false);
    } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("legacy offline JSON remains undeclared when read and projected", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-scope-old-")),
        result = initial();
    const store = await LocalStore.open(root);
    try {
        let owner = store.reserve(result.workspaceId, result.localRunId, result.attempts[0]!.attemptId, result);
        owner = store.stopped(
            owner.runId,
            {
                attemptId: owner.attemptId,
                processStopped: true,
                reason: "NO_PROCESS_SPAWNED",
                stoppedAt: new Date().toISOString(),
            },
            owner,
        );
        store.finish(result, owner);
        assert.deepEqual(store.result(result.workspaceId, result.localRunId), result);
        const report = await new LocalReports(root, () => false).snapshot(result.workspaceId, result.localRunId);
        assert.equal(Object.hasOwn(report.reports[0]!.cases[0]!.attempts[0]!.facts!, "processStopScope"), false);
    } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
    }
});

for (const state of ["ALLOCATED", "ACTIVATING", "ACTIVATED", "SPAWNING", "RUNNING", "STOPPED", "UNKNOWN"]) {
    test(`online recovery derives scope from explicit committed state: ${state}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vq-online-scope-"));
        const bodies: Record<string, unknown>[] = [],
            attemptId = randomUUID();
        const client = {
            request: async (_path: string, _method: string, body: Record<string, unknown>) => {
                bodies.push(body);
            },
        } as unknown as AgentClient;
        try {
            await mkdir(join(root, "attempts"), { mode: 0o700 });
            await writeFile(
                join(root, "attempts", `${attemptId}.json`),
                JSON.stringify({
                    claim: { attemptId, fencingToken: 1 },
                    work: root,
                    state,
                }),
                { mode: 0o600 },
            );
            const supervisor = new ExecutionSupervisor({ root, client } as ConstructorParameters<
                typeof ExecutionSupervisor
            >[0]);
            const [receipt] = await supervisor.recover();
            const unspawned = ["ALLOCATED", "ACTIVATING", "ACTIVATED"].includes(state);
            assert.equal(receipt?.processStopped, unspawned);
            assert.equal(receipt?.processStopScope, unspawned ? "NO_PROCESS_SPAWNED" : undefined);
            assert.equal(bodies[0]!.processStopScope, receipt?.processStopScope);
            const journal = JSON.parse(await readFile(join(root, "attempts", `${attemptId}.json`), "utf8"));
            assert.deepEqual(journal.stop, receipt);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("online journal requires the renamed parent directory to be durably flushed", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "vq-online-sync-"));
    const handle = await open(root, "r"),
        prototype = Object.getPrototypeOf(handle);
    const original = prototype.sync;
    await handle.close();
    let observed = false;
    context.mock.method(prototype, "sync", async function (this: Awaited<ReturnType<typeof open>>) {
        if ((await this.stat()).isDirectory()) {
            observed = true;
            throw new Error("DIRECTORY_SYNC_FAILED");
        }
        return original.call(this);
    });
    try {
        const supervisor = new ExecutionSupervisor({ root } as ConstructorParameters<typeof ExecutionSupervisor>[0]);
        const journal = Reflect.get(supervisor, "journal").bind(supervisor);
        await assert.rejects(
            journal({ claim: { attemptId: randomUUID() } as Claim, state: "SPAWNING", work: root }),
            /DIRECTORY_SYNC_FAILED/,
        );
        assert.equal(observed, true);
    } finally {
        context.mock.restoreAll();
        await rm(root, { recursive: true, force: true });
    }
});

test("a pre-spawn online record cannot hide a durable native spawn intent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-online-intent-")),
        attemptId = randomUUID();
    const processes = new ProcessSupervisor(join(root, "processes"));
    try {
        const child = await processes.start(attemptId, {
            executable: process.execPath,
            args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
            cwd: root,
        });
        await child.firstLine();
        await mkdir(join(root, "attempts"), { mode: 0o700 });
        await writeFile(
            join(root, "attempts", `${attemptId}.json`),
            JSON.stringify({
                claim: { attemptId, fencingToken: 1 },
                state: "ALLOCATED",
                work: root,
            }),
            { mode: 0o600 },
        );
        const client = { request: async () => ({}) } as unknown as AgentClient;
        const [receipt] = await new ExecutionSupervisor({ root, client } as ConstructorParameters<
            typeof ExecutionSupervisor
        >[0]).recover();
        assert.equal(receipt?.processStopped, true);
        assert.equal(receipt?.processStopScope, "FULL_DESCENDANT_TREE");
        assert.equal(await processes.isRunning(child.pid), false);
    } finally {
        await processes.terminateAttempt(attemptId, "TEST_FINALLY");
        await rm(root, { recursive: true, force: true });
    }
});

test("online recovery rejects linked pre-spawn journal bytes before reconciling capacity", async () => {
    const { symlink } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "vq-online-linked-")),
        attemptId = randomUUID();
    let reconciled = false;
    try {
        await mkdir(join(root, "attempts"), { mode: 0o700 });
        await writeFile(
            join(root, "outside.json"),
            JSON.stringify({
                claim: { attemptId, fencingToken: 1 },
                state: "ALLOCATED",
                work: root,
            }),
            { mode: 0o600 },
        );
        await symlink(join(root, "outside.json"), join(root, "attempts", `${attemptId}.json`));
        const client = {
            request: async () => {
                reconciled = true;
            },
        } as unknown as AgentClient;
        await assert.rejects(
            new ExecutionSupervisor({ root, client } as ConstructorParameters<typeof ExecutionSupervisor>[0]).recover(),
        );
        assert.equal(reconciled, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

interface OnlineOptions {
    observeRequest?: (path: string, attemptId: string) => Promise<void>;
    observeUpload?: (path: string) => void;
    attachEvidence?: boolean;
}

interface OnlineUpload {
    path: string;
    bytes: Uint8Array;
}

/**
 * 在线探针使用真实原生守护和一个等待 START 的小型执行进程，私有发行清单与下载内容仍走正式校验。
 * 执行进程产生最小 CLEANUP 结果，可经现有私有代理附上一份合成文件供证据上传次序测试。
 */
async function online(root: string, options: OnlineOptions = {}) {
    const attemptId = randomUUID(),
        workspaceId = randomUUID(),
        fixtureVersionId = randomUUID();
    const release = join(root, "release");
    await mkdir(join(release, "engine"), { recursive: true });
    const files = ["package.json", "package-lock.json", "dependencies.json", "engine/compiler.tgz"];
    for (const path of files) await writeFile(join(release, path), "{}");
    await writeFile(
        join(release, "inventory.json"),
        canonicalBytes({
            schemaVersion: "1.0",
            engines: [
                {
                    engineVersion: "0.1.0",
                    compilerVersion: "0.1.0",
                    runnerSdkVersion: "0.1.0",
                    dependencies: [],
                    files: files.map((path) => ({
                        path,
                        sizeBytes: 2,
                        sha256: sha256(Buffer.from("{}")),
                    })),
                },
            ],
        }),
    );
    const source = canonicalBytes({
        workspaceId,
        namespace: "scope_probe",
        fixtureVersionId,
        caseExecutionId: randomUUID(),
        attemptNo: 1,
        environment: { fixtureIdentity: { secretRef: "fixture", secretVersionId: "v1" } },
        secretVersions: [{ secretRef: "fixture", versionId: "v1" }],
    });
    const manifest = canonicalBytes({
        schemaVersion: "1.0",
        kind: "CLEANUP",
        workspaceId,
        jobId: randomUUID(),
        snapshotSha256: sha256(source),
        engineVersion: "0.1.0",
        fixtureVersionId,
        namespace: "scope_probe",
        maintenanceId: randomUUID(),
        cleanupRef: "probe",
    });
    assert.deepEqual(validateSchema("JobManifestV1", JSON.parse(Buffer.from(manifest).toString())), []);
    const claim: Claim = {
        jobId: JSON.parse(Buffer.from(manifest).toString()).jobId,
        jobKind: "CLEANUP",
        attemptId,
        snapshotUrl: "/manifest",
        snapshotSha256: sha256(manifest),
        fencingToken: 1,
        leaseToken: "probe-lease",
        activationRequired: true,
        leaseDurationMs: 60000,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        serverTime: new Date().toISOString(),
    };
    const worker = join(root, "probe.mjs");
    await writeFile(
        worker,
        String.raw`import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { text } from "node:stream/consumers";

process.once("message", async () => {
    if (${options.attachEvidence === true}) {
        const { tmp, socket, nonce } = JSON.parse(readFileSync(process.argv[2], "utf8"));
        const path = join(tmp, "original-evidence.bin");
        writeFileSync(path, "original evidence bytes", { flag: "wx", mode: 0o600 });
        const channel = connect(socket);
        const reply = text(channel);
        channel.write(JSON.stringify({
            type: "restricted",
            nonce,
            evidence: { kind: "DOWNLOAD", path, sensitivity: "CREDENTIAL_RESTRICTED" },
        }) + "\n");
        if (!JSON.parse(await reply).ok) {
            throw new Error("EVIDENCE_ATTACHMENT_FAILED");
        }
    }
    writeFileSync(join(process.cwd(), "worker-result.json"), JSON.stringify({
        kind: "CLEANUP", businessOutcome: "PASSED", cleanupStatus: "SUCCEEDED",
    }));
    process.exit(0);
});
setInterval(() => {}, 1000);
`,
    );
    const bodies: { path: string; body: Record<string, unknown> }[] = [];
    const uploads: OnlineUpload[] = [];
    const client = {
        binary: async (path: string, _claim: Claim, _signal: AbortSignal, bytes?: Uint8Array) => {
            assert(bytes);
            options.observeUpload?.(path);
            uploads.push({ path, bytes: Uint8Array.from(bytes) });
            return new Uint8Array();
        },
        download: async (path: string) => (path === "/manifest" ? manifest : source),
        request: async (path: string, _method: string, body: Record<string, unknown>) => {
            bodies.push({ path, body });
            await options.observeRequest?.(path, attemptId);
            if (path.endsWith("/artifact-uploads")) {
                return { artifactId: randomUUID(), uploadUrl: `/uploads/${body.filename}` };
            }
            if (path.endsWith("/events")) {
                const last = (body.events as ExecutionEventV1[]).at(-1);
                assert(last);
                return { acceptedThrough: last.sequence };
            }
            return {};
        },
    } as unknown as AgentClient;
    const supervisor = new ExecutionSupervisor({
        root,
        client,
        releaseDirectory: release,
        browserExecutable: "/unused",
        execution: { ...developmentExecutionPaths(), workerEntry: worker },
    });
    const run = () =>
        supervisor.runAttempt(
            { claim, requestStarted: performance.now(), responseReceived: performance.now() },
            new AbortController().signal,
        );
    return { supervisor, claim, run, bodies, uploads };
}

test("online completion copies the actual kernel scope and persists its stop receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-online-completion-"));
    try {
        const fixture = await online(root),
            result = await fixture.run();
        assert.equal(result.stop.processStopped, true);
        assert.equal(result.stop.processStopScope, "FULL_DESCENDANT_TREE", JSON.stringify(result.stop));
        assert(result.completion, JSON.stringify(result.stop));
        assert.equal(result.completion.processStopScope, result.stop.processStopScope);
        const journal = JSON.parse(await readFile(join(root, "attempts", `${fixture.claim.attemptId}.json`), "utf8"));
        assert.deepEqual(journal.stop, result.stop);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("online completion preserves original scratch and a replacement written during finish", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-online-retirement-"));
    let bytesAtFinish: string | undefined;
    try {
        const fixture = await online(root, {
            async observeRequest(path, id) {
                const file = join(root, "work", id, "node_modules", "copy");
                if (path.endsWith("/activate")) await writeFile(file, "original bytes");
                if (path.endsWith("/finish")) {
                    bytesAtFinish = await readFile(file, "utf8");
                    await rename(file, `${file}-old`);
                    await writeFile(file, "operator replacement bytes");
                }
            },
        });
        const result = await fixture.run();
        assert.equal(bytesAtFinish, "original bytes");
        assert.equal(result.completion?.businessOutcome, "PASSED", JSON.stringify(result.stop));
        assert.equal(result.stop.processStopped, true);
        assert.equal(result.stop.processStopScope, "FULL_DESCENDANT_TREE");
        const id = fixture.claim.attemptId;
        const modules = join(root, "work", id, "node_modules");
        assert.equal(await readFile(join(modules, "copy"), "utf8"), "operator replacement bytes");
        assert.equal(await readFile(join(modules, "copy-old"), "utf8"), "original bytes");
        assert.deepEqual((await readdir(modules)).sort(), ["copy", "copy-old"]);
        const journal = JSON.parse(await readFile(join(root, "attempts", `${id}.json`), "utf8"));
        assert.equal(journal.dataCleanup, "OWNERSHIP_UNCONFIRMED");
        assert.deepEqual(journal.stop, result.stop);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

interface OnlineJournal {
    state: string;
    stop?: StopReceipt;
    dataCleanup?: string;
    allocation?: TaskAllocation;
}

interface JournalSyncFault {
    state: "ACTIVATING" | "SPAWNING" | "STOPPED";
    dataCleanup: boolean;
    stopScope?: StopReceipt["processStopScope"];
    observe?: () => void;
}

/**
 * 在本次尝试的临时日志文件刷新时按状态和可选字段选中故障，正式日志及其他进程证明仍使用真实文件操作。
 */
async function failJournalSync(context: TestContext, root: string, attemptId: string, faults: JournalSyncFault[]) {
    const stagedPrefix = join(await realpath(root), "attempts", `${attemptId}.json.`);
    const handle = await open(root, "r");
    const original = handle.sync;
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    let injected = 0;
    context.mock.method(prototype, "sync", async function (this: Awaited<ReturnType<typeof open>>) {
        const fault = faults[injected];
        if (fault) {
            const descriptor = `/proc/self/fd/${this.fd}`;
            const path = await realpath(descriptor);
            if (path.startsWith(stagedPrefix)) {
                const staged: OnlineJournal = JSON.parse(await readFile(descriptor, "utf8"));
                if (
                    staged.state === fault.state &&
                    Object.hasOwn(staged, "dataCleanup") === fault.dataCleanup &&
                    (fault.stopScope === undefined || staged.stop?.processStopScope === fault.stopScope)
                ) {
                    injected += 1;
                    fault.observe?.();
                    const error: NodeJS.ErrnoException = new Error("JOURNAL_SYNC_FAILED");
                    error.code = "EIO";
                    error.syscall = "fsync";
                    throw error;
                }
            }
        }
        return original.call(this);
    });
    return () => injected;
}

test("R08 optional journal failure preserves the committed online completion and original bytes", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "vq-online-cleanup-"));
    let journalAtFinish: Buffer | undefined;
    let proofAtFinish: Buffer | undefined;
    let uploadsAtFinish = 0;
    let finishesAtFault = 0;
    let uploadedEvidenceAtFault: OnlineUpload | undefined;
    try {
        const fixture = await online(root, {
            attachEvidence: true,
            async observeRequest(path, id) {
                if (path.endsWith("/activate")) {
                    await writeFile(join(root, "work", id, "node_modules", "copy"), "original work bytes");
                }
                if (path.endsWith("/finish")) {
                    uploadsAtFinish = fixture.uploads.length;
                    journalAtFinish = await readFile(join(root, "attempts", `${id}.json`));
                    proofAtFinish = await readFile(join(root, "processes", `${id}.drained.json`));
                }
            },
        });
        const { attemptId, fencingToken, leaseToken, snapshotSha256 } = fixture.claim;
        const url = `/internal/v1/attempts/${attemptId}`;
        const count = await failJournalSync(context, root, attemptId, [
            {
                state: "STOPPED",
                dataCleanup: true,
                observe() {
                    finishesAtFault = fixture.bodies.filter((item) => item.path === `${url}/finish`).length;
                    uploadedEvidenceAtFault = fixture.uploads[0];
                },
            },
        ]);
        const result = await fixture.run();
        const outcomes = fixture.bodies.filter(({ path }) => path === `${url}/finish` || path === `${url}/reconcile`);
        assert.equal(count(), 1);
        assert.equal(uploadedEvidenceAtFault?.path, "/uploads/download-0.bin?offset=0");
        assert.deepEqual(
            outcomes.map(({ path }) => path),
            [`${url}/finish`],
            JSON.stringify(result.stop),
        );
        assert.equal(finishesAtFault, 1);
        assert.equal(uploadsAtFinish, 2);
        assert.equal(result.stop.processStopped, true);
        assert.equal(result.stop.processStopScope, "FULL_DESCENDANT_TREE");
        assert.equal(result.stop.reason, "COMPLETED");
        assert.equal(result.dataCleanup, "OWNERSHIP_UNCONFIRMED");
        assert(journalAtFinish);
        const journal: OnlineJournal = JSON.parse(journalAtFinish.toString());
        assert.equal(journal.state, "STOPPED");
        assert.equal(Object.hasOwn(journal, "dataCleanup"), false);
        assert.deepEqual(journal.stop, result.stop);
        assert.deepEqual(await readFile(join(root, "attempts", `${attemptId}.json`)), journalAtFinish);
        assert.deepEqual(await readdir(join(root, "attempts")), [`${attemptId}.json`]);
        assert(proofAtFinish);
        assert.deepEqual(await readFile(join(root, "processes", `${attemptId}.drained.json`)), proofAtFinish);
        assert.equal(await fixture.supervisor.processes.confirmStopped(attemptId), true);

        const [evidence, uploadedManifest] = fixture.uploads;
        assert(evidence && uploadedManifest);
        assert.equal(evidence.path, "/uploads/download-0.bin?offset=0");
        assert.equal(Buffer.from(evidence.bytes).toString(), "original evidence bytes");
        assert.equal(uploadedManifest.path, "/uploads/completion.json?offset=0");
        const completion = result.completion;
        assert(completion?.kind === "CLEANUP");
        assert.equal(completion.businessOutcome, "PASSED");
        assert.equal(completion.cleanupStatus, "SUCCEEDED");
        assert.equal(completion.attemptId, attemptId);
        assert.equal(completion.jobManifestSha256, snapshotSha256);
        assert.equal(completion.processStopped, true);
        assert.equal(completion.processStopScope, result.stop.processStopScope);
        assert.deepEqual(validateSchema("CompletionManifestV1", completion), []);
        assert.deepEqual(uploadedManifest.bytes, Uint8Array.from(canonicalBytes(completion)));
        assert.deepEqual(completion.evidence, [
            {
                path: "download-0.bin",
                sha256: sha256(evidence.bytes),
                sizeBytes: evidence.bytes.length,
                sensitivity: "CREDENTIAL_RESTRICTED",
            },
        ]);
        const events = fixture.bodies
            .slice(
                0,
                fixture.bodies.findIndex(({ path }) => path === `${url}/finish`),
            )
            .filter(({ path }) => path === `${url}/events`)
            .flatMap(({ body }) => body.events as ExecutionEventV1[]);
        assert.deepEqual(
            events.map(({ sequence }) => sequence),
            [1, 2, 3, 4],
        );
        assert.deepEqual(
            events.map(({ type }) => type),
            ["ATTEMPT_STARTED", "CLEANUP_RESULT", "ATTEMPT_FINISHED", "ARTIFACT_CREATED"],
        );
        const artifact = events.find((event) => event.type === "ARTIFACT_CREATED");
        assert.deepEqual(artifact?.payload.file, completion.evidence[0]);
        assert.deepEqual(outcomes[0]?.body, {
            leaseToken,
            fencingToken,
            kind: "CLEANUP",
            outcome: "PASSED",
            manifestSha256: sha256(uploadedManifest.bytes),
            lastSequence: 4,
            cleanupStatus: "SUCCEEDED",
        });
        assert.deepEqual(validateSchema("FinishRequest", outcomes[0]?.body), []);
        const work = join(root, "work", attemptId);
        assert.equal(await readFile(join(work, "node_modules", "copy"), "utf8"), "original work bytes");
        assert.equal(await readFile(join(work, "download-0.bin"), "utf8"), "original evidence bytes");
        assert(journal.allocation);
        const scratch = join(tmpdir(), journal.allocation.temporaryName);
        assert.equal(await readFile(join(scratch, "original-evidence.bin"), "utf8"), "original evidence bytes");
        assert.equal((await readdir(scratch)).includes(".veriq-retired"), false);
    } finally {
        context.mock.restoreAll();
        await rm(root, { recursive: true, force: true });
    }
});

test("R08 first stopped journal failure still blocks online completion", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "vq-online-stop-commit-"));
    try {
        const fixture = await online(root, { attachEvidence: true });
        const { attemptId, fencingToken } = fixture.claim;
        const count = await failJournalSync(context, root, attemptId, [{ state: "STOPPED", dataCleanup: false }]);
        const result = await fixture.run();
        assert.equal(count(), 1);
        assert.equal(result.completion, undefined);
        assert.equal(result.stop.reason, "JOURNAL_SYNC_FAILED");
        assert.equal(result.stop.processStopped, true);
        assert.equal(result.stop.processStopScope, "FULL_DESCENDANT_TREE");
        assert.equal(await fixture.supervisor.processes.confirmStopped(attemptId), true);
        assert.deepEqual(fixture.uploads, []);
        assert.equal(
            fixture.bodies.some(({ path }) => path.endsWith("/finish")),
            false,
        );
        assert.deepEqual(
            fixture.bodies.filter(({ path }) => path.endsWith("/reconcile")).map(({ body }) => body),
            [
                {
                    fencingToken,
                    processStopped: true,
                    processStopScope: "FULL_DESCENDANT_TREE",
                    cleanupStatus: "PENDING",
                    stoppedAt: result.stop.stoppedAt,
                },
            ],
        );
    } finally {
        context.mock.restoreAll();
        await rm(root, { recursive: true, force: true });
    }
});

test("R08 optional journal failure preserves the original failed evidence upload result", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "vq-online-upload-failure-"));
    const rejected: string[] = [];
    try {
        const fixture = await online(root, {
            attachEvidence: true,
            observeUpload(path) {
                rejected.push(path);
                throw new Error("EVIDENCE_UPLOAD_FAILED");
            },
        });
        const { attemptId, fencingToken } = fixture.claim;
        const count = await failJournalSync(context, root, attemptId, [{ state: "STOPPED", dataCleanup: true }]);
        const result = await fixture.run();
        assert.equal(count(), 1);
        assert.deepEqual(rejected, ["/uploads/download-0.bin?offset=0"]);
        assert.deepEqual(fixture.uploads, []);
        assert.equal(result.completion, undefined);
        assert.equal(result.stop.reason, "EVIDENCE_UPLOAD_FAILED");
        assert.equal(result.stop.processStopped, true);
        assert.equal(result.stop.processStopScope, "FULL_DESCENDANT_TREE");
        assert.equal(result.dataCleanup, "OWNERSHIP_UNCONFIRMED");
        assert.equal(
            fixture.bodies.some(({ path }) => path.endsWith("/finish")),
            false,
        );
        assert.deepEqual(
            fixture.bodies.filter(({ path }) => path.endsWith("/reconcile")).map(({ body }) => body),
            [
                {
                    fencingToken,
                    processStopped: true,
                    processStopScope: "FULL_DESCENDANT_TREE",
                    cleanupStatus: "PENDING",
                    stoppedAt: result.stop.stoppedAt,
                },
            ],
        );
        const journal: OnlineJournal = JSON.parse(await readFile(join(root, "attempts", `${attemptId}.json`), "utf8"));
        assert.equal(journal.state, "STOPPED");
        assert.equal(Object.hasOwn(journal, "dataCleanup"), false);
        assert.deepEqual(journal.stop, result.stop);
    } finally {
        context.mock.restoreAll();
        await rm(root, { recursive: true, force: true });
    }
});

test("R08 optional journal failure preserves quarantine when the stop is unknown", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "vq-online-unknown-stop-"));
    try {
        const fixture = await online(root);
        const { attemptId, fencingToken } = fixture.claim;
        const count = await failJournalSync(context, root, attemptId, [
            { state: "SPAWNING", dataCleanup: false },
            { state: "SPAWNING", dataCleanup: true },
        ]);
        const result = await fixture.run();
        assert.equal(count(), 2);
        assert.equal(result.completion, undefined);
        assert.equal(result.stop.reason, "UNKNOWN_PROCESS");
        assert.equal(result.stop.processStopped, false);
        assert.equal(Object.hasOwn(result.stop, "processStopScope"), false);
        assert.equal(result.dataCleanup, "STOP_UNCONFIRMED");
        assert.equal(
            fixture.bodies.some(({ path }) => path.endsWith("/finish")),
            false,
        );
        assert.deepEqual(
            fixture.bodies.filter(({ path }) => path.endsWith("/reconcile")).map(({ body }) => body),
            [{ fencingToken, processStopped: false, cleanupStatus: "NOT_REQUIRED", stoppedAt: result.stop.stoppedAt }],
        );
        const journal: OnlineJournal = JSON.parse(await readFile(join(root, "attempts", `${attemptId}.json`), "utf8"));
        assert.equal(journal.state, "SPAWNING");
        assert.equal(Object.hasOwn(journal, "dataCleanup"), false);
        assert.deepEqual(journal.stop, result.stop);
        await assert.rejects(readFile(join(root, "processes", `${attemptId}.drained.json`)), { code: "ENOENT" });
    } finally {
        context.mock.restoreAll();
        await rm(root, { recursive: true, force: true });
    }
});

test("R08 optional cleanup never republishes an unconfirmed stop journal", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "vq-online-unconfirmed-commit-"));
    let journalAtActivation: Buffer | undefined;
    try {
        const fixture = await online(root, {
            async observeRequest(path, id) {
                if (path.endsWith("/activate")) {
                    journalAtActivation = await readFile(join(root, "attempts", `${id}.json`));
                    throw new Error("ACTIVATION_REJECTED");
                }
            },
        });
        const { attemptId, fencingToken } = fixture.claim;
        const count = await failJournalSync(context, root, attemptId, [
            { state: "ACTIVATING", dataCleanup: false, stopScope: "NO_PROCESS_SPAWNED" },
        ]);
        const result = await fixture.run();
        assert.equal(count(), 1);
        assert.equal(result.completion, undefined);
        assert.equal(result.stop.reason, "JOURNAL_COMMIT_UNCONFIRMED");
        assert.equal(result.stop.processStopped, false);
        assert.equal(Object.hasOwn(result.stop, "processStopScope"), false);
        assert.equal(result.dataCleanup, "STOP_UNCONFIRMED");
        assert.equal(
            fixture.bodies.some(({ path }) => path.endsWith("/finish")),
            false,
        );
        assert.deepEqual(
            fixture.bodies.filter(({ path }) => path.endsWith("/reconcile")).map(({ body }) => body),
            [{ fencingToken, processStopped: false, cleanupStatus: "NOT_REQUIRED", stoppedAt: result.stop.stoppedAt }],
        );
        assert(journalAtActivation);
        assert.deepEqual(await readFile(join(root, "attempts", `${attemptId}.json`)), journalAtActivation);
        assert.deepEqual(await readdir(join(root, "attempts")), [`${attemptId}.json`]);
        await assert.rejects(readFile(join(root, "processes", `${attemptId}.process.json`)), { code: "ENOENT" });
    } finally {
        context.mock.restoreAll();
        await rm(root, { recursive: true, force: true });
    }
});

test("scratch retention status requires confirmed stop with the platform scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-scratch-scope-"));
    const stop: StopReceipt = {
        attemptId: randomUUID(),
        processStopped: true,
        processStopScope: "FULL_DESCENDANT_TREE",
        reason: "TEST_STOP",
        stoppedAt: new Date().toISOString(),
    };
    const record = { work: join(root, "work", stop.attemptId) };
    const report = { ...record, dataCleanup: "REPORT_RETAINED" as const };
    const invalidStops: StopReceipt[] = [
        { ...stop, processStopped: false },
        { ...stop, processStopScope: "CONTROLLED_WORKER_BROWSER" },
        { attemptId: stop.attemptId, processStopped: true, reason: stop.reason, stoppedAt: stop.stoppedAt },
    ];
    try {
        assert.equal(await retireScratch(root, root, record, stop), "OWNERSHIP_UNCONFIRMED");
        assert.equal(await retireScratch(root, root, report, stop), "REPORT_RETAINED");
        for (const invalid of invalidStops) {
            assert.equal(await retireScratch(root, root, record, invalid), "STOP_UNCONFIRMED");
            assert.equal(await retireScratch(root, root, report, invalid), "STOP_UNCONFIRMED");
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

for (const phase of ["ACTIVATING", "ACTIVATED", "SPAWNING"]) {
    test(`online ${phase} directory commit failure never grants unspawned scope`, async (context) => {
        const root = await mkdtemp(join(tmpdir(), "vq-online-fault-"));
        const fixture = await online(root),
            handle = await open(root, "r");
        const prototype = Object.getPrototypeOf(handle),
            original = prototype.sync;
        await handle.close();
        let injected = false;
        context.mock.method(prototype, "sync", async function (this: Awaited<ReturnType<typeof open>>) {
            if (!injected && (await realpath("/proc/self/fd/" + this.fd)) === join(root, "attempts")) {
                const journal = JSON.parse(
                    await readFile(join(root, "attempts", `${fixture.claim.attemptId}.json`), "utf8"),
                );
                if (journal.state === phase) {
                    injected = true;
                    throw new Error("DIRECTORY_SYNC_FAILED");
                }
            }
            return original.call(this);
        });
        try {
            const result = await fixture.run();
            assert.equal(injected, true);
            assert.equal(result.stop.processStopped, false);
            assert.equal(result.stop.processStopScope, undefined);
            const reconcile = fixture.bodies.find((item) => item.path.endsWith("/reconcile"))!.body;
            assert.equal(reconcile.processStopped, false);
            assert.equal(Object.hasOwn(reconcile, "processStopScope"), false);
            await assert.rejects(readFile(join(root, "processes", `${fixture.claim.attemptId}.process.json`)), {
                code: "ENOENT",
            });
        } finally {
            context.mock.restoreAll();
            await rm(root, { recursive: true, force: true });
        }
    });
}
