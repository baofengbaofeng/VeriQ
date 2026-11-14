import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ExecutionSupervisor } from "../src/execution/supervisor.ts";
import { LocalStore } from "../src/offline/store.ts";
import { LocalReports } from "../src/offline/reports.ts";
import { recoverOffline } from "../src/offline/run.ts";
import type { AgentClient, Claim } from "../src/agent/transport.ts";
import type { OfflineResultV1 } from "@veriq/contracts";
import { canonicalBytes, validateSchema } from "@veriq/contracts";
import { sha256 } from "../src/execution/release.ts";
import { developmentExecutionPaths } from "../src/execution/paths.ts";
import { ProcessSupervisor } from "../src/execution/processes.ts";

/** 每个用例使用独立的真实 SQLite 档案及最小历史结果，范围声明必须由被测停止路径生成；夹具自身不提前填写停止字段，也不借默认平台或业务成功补造历史中的停止事实。 */
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
            let owner = store.reserve(
                result.workspaceId,
                result.localRunId,
                result.attempts[0]!.attemptId,
                result,
            );
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
            const report = await new LocalReports(root, () => false).snapshot(
                result.workspaceId,
                result.localRunId,
            );
            const facts = report.reports[0]!.cases[0]!.attempts[0]!.facts as Record<
                string,
                unknown
            >;
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
        const allocated = store.reserve(
            result.workspaceId,
            result.localRunId,
            result.attempts[0]!.attemptId,
            result,
        );
        const spawning = store.spawning(allocated.runId, allocated.attemptId, allocated);
        assert.equal(store.unspawnedStop(spawning), undefined);
        assert.throws(
            () => store.unspawnedStop({ ...spawning, state: "ALLOCATED" }),
            /LOCAL_OWNERSHIP_LOST/,
        );
        const receipt = {
            attemptId: spawning.attemptId,
            processStopped: true,
            processStopScope: "NO_PROCESS_SPAWNED" as const,
            reason: "RENAMED_FAILURE",
            stoppedAt: new Date().toISOString(),
        };
        assert.throws(
            () => store.stopped(spawning.runId, receipt, spawning),
            /LOCAL_OWNERSHIP_LOST/,
        );
        assert.throws(
            () => store.stopped(spawning.runId, receipt, { ...spawning, state: "ALLOCATED" }),
            /LOCAL_OWNERSHIP_LOST/,
        );
        const recovering = store.claimRecovery(spawning)!;
        assert.throws(
            () => store.stopped(spawning.runId, receipt, spawning),
            /LOCAL_OWNERSHIP_LOST/,
        );
        assert.throws(
            () => store.stopped(recovering.runId, receipt, recovering),
            /LOCAL_OWNERSHIP_LOST/,
        );
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
        const allocated = store.reserve(
            result.workspaceId,
            result.localRunId,
            result.attempts[0]!.attemptId,
            result,
        );
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
        let owner = store.reserve(
            result.workspaceId,
            result.localRunId,
            result.attempts[0]!.attemptId,
            result,
        );
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
        assert.throws(
            () => store.nextAttempt(owner.runId, randomUUID(), owner, result),
            /LOCAL_CAPACITY_HELD/,
        );
        const saved = store.result(result.workspaceId, result.localRunId);
        assert.equal(saved.attempts[0]!.processStopScope, "CONTROLLED_WORKER_BROWSER");
        assert.equal(saved.attempts[0]!.processStopped, false);
        const report = await new LocalReports(root, () => false).snapshot(
            result.workspaceId,
            result.localRunId,
        );
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
        let owner = store.reserve(
            result.workspaceId,
            result.localRunId,
            result.attempts[0]!.attemptId,
            result,
        );
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
        const report = await new LocalReports(root, () => false).snapshot(
            result.workspaceId,
            result.localRunId,
        );
        assert.equal(
            Object.hasOwn(report.reports[0]!.cases[0]!.attempts[0]!.facts!, "processStopScope"),
            false,
        );
    } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
    }
});

for (const state of [
    "ALLOCATED",
    "ACTIVATING",
    "ACTIVATED",
    "SPAWNING",
    "RUNNING",
    "STOPPED",
    "UNKNOWN",
]) {
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
            const journal = JSON.parse(
                await readFile(join(root, "attempts", `${attemptId}.json`), "utf8"),
            );
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
        const supervisor = new ExecutionSupervisor({ root } as ConstructorParameters<
            typeof ExecutionSupervisor
        >[0]);
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
            new ExecutionSupervisor({ root, client } as ConstructorParameters<
                typeof ExecutionSupervisor
            >[0]).recover(),
        );
        assert.equal(reconciled, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/** 在线探针使用真实原生守护和一个等待 START 的小型执行进程，私有发行清单与下载内容仍走正式校验；业务夹具只产生最小 CLEANUP 结果，测试目标是提交门、退出证明与完成清单的范围传递。 */
async function online(root: string) {
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
    assert.deepEqual(
        validateSchema("JobManifestV1", JSON.parse(Buffer.from(manifest).toString())),
        [],
    );
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
        `import {writeFileSync} from 'node:fs';import {join} from 'node:path';process.once('message',()=>{writeFileSync(join(process.cwd(),'worker-result.json'),JSON.stringify({kind:'CLEANUP',businessOutcome:'PASSED',cleanupStatus:'SUCCEEDED'}));process.exit(0);});setInterval(()=>{},1000);`,
    );
    const bodies: { path: string; body: Record<string, unknown> }[] = [];
    const client = {
        binary: async () => ({}),
        download: async (path: string) => (path === "/manifest" ? manifest : source),
        request: async (path: string, _method: string, body: Record<string, unknown>) => {
            bodies.push({ path, body });
            if (path.endsWith("/artifact-uploads"))
                return { artifactId: randomUUID(), uploadUrl: "/uploads" };
            if (path.endsWith("/events"))
                return {
                    acceptedThrough: (body.events as { sequence: number }[]).at(-1)!.sequence,
                };
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
    return { supervisor, claim, run, bodies };
}

test("online completion copies the actual kernel scope and persists its stop receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-online-completion-"));
    try {
        const fixture = await online(root),
            result = await fixture.run();
        assert.equal(result.stop.processStopped, true);
        assert.equal(
            result.stop.processStopScope,
            "FULL_DESCENDANT_TREE",
            JSON.stringify(result.stop),
        );
        assert(result.completion, JSON.stringify(result.stop));
        assert.equal(result.completion.processStopScope, result.stop.processStopScope);
        const journal = JSON.parse(
            await readFile(join(root, "attempts", `${fixture.claim.attemptId}.json`), "utf8"),
        );
        assert.deepEqual(journal.stop, result.stop);
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
        context.mock.method(
            prototype,
            "sync",
            async function (this: Awaited<ReturnType<typeof open>>) {
                if (!injected && (await this.stat()).isDirectory()) {
                    const journal = JSON.parse(
                        await readFile(
                            join(root, "attempts", `${fixture.claim.attemptId}.json`),
                            "utf8",
                        ),
                    );
                    if (journal.state === phase) {
                        injected = true;
                        throw new Error("DIRECTORY_SYNC_FAILED");
                    }
                }
                return original.call(this);
            },
        );
        try {
            const result = await fixture.run();
            assert.equal(injected, true);
            assert.equal(result.stop.processStopped, false);
            assert.equal(result.stop.processStopScope, undefined);
            const reconcile = fixture.bodies.find((item) => item.path.endsWith("/reconcile"))!.body;
            assert.equal(reconcile.processStopped, false);
            assert.equal(Object.hasOwn(reconcile, "processStopScope"), false);
            await assert.rejects(
                readFile(join(root, "processes", `${fixture.claim.attemptId}.process.json`)),
                { code: "ENOENT" },
            );
        } finally {
            context.mock.restoreAll();
            await rm(root, { recursive: true, force: true });
        }
    });
}
