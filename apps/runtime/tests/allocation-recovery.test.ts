import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PlatformComponents } from "@veriq/contracts";
import { claimLoop, type ClaimLoopState } from "../src/agent/claim-loop.ts";
import type { AgentClient, Claim } from "../src/agent/transport.ts";
import type { StopReceipt } from "../src/execution/processes.ts";
import type { DataCleanup, TaskAllocation } from "../src/execution/storage.ts";
import { ExecutionSupervisor } from "../src/execution/supervisor.ts";

type Schemas = PlatformComponents["schemas"];
type ControlResponse = Claim | Schemas["ReconcileDTO"];
interface Journal {
    claim: Claim;
    claimRequestId?: string;
    state: string;
    work: string;
    allocation?: TaskAllocation;
    stop?: StopReceipt;
    dataCleanup?: DataCleanup;
}

const claim: Claim = {
    jobId: "11111111-1111-4111-8111-111111111111",
    jobKind: "VALIDATE",
    attemptId: "22222222-2222-4222-8222-222222222222",
    leaseToken: "original-test-lease-token",
    fencingToken: 47,
    snapshotUrl: "https://control.invalid/snapshot",
    snapshotSha256: "a".repeat(64),
    serverTime: "2026-11-19T12:00:00.000Z",
    expiresAt: "2026-11-19T12:01:00.000Z",
    leaseDurationMs: 60000,
    activationRequired: true,
};
const pending: Schemas["ClaimRequest"] = {
    runnerId: "33333333-3333-4333-8333-333333333333",
    clientRequestId: "44444444-4444-4444-8444-444444444444",
    capabilities: { engineVersion: "0.1.0", os: "linux", arch: "x64", browsers: ["chromium"] },
    availableSlots: 1,
};
const pendingBytes = `${JSON.stringify(pending, null, 4)}\n`;
const claimPath = "/internal/v1/jobs/claim";
const reconcilePath = `/internal/v1/attempts/${claim.attemptId}/reconcile`;
const auditId = "55555555-5555-4555-8555-555555555555";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function fixture(t: TestContext) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vq-allocation-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const temporary = join(root, "tmp");
    const attempts = join(root, "attempts");
    const pendingPath = join(root, "claim-request.json");
    await mkdir(temporary, { mode: 0o700 });
    await writeFile(pendingPath, pendingBytes, { mode: 0o600 });
    return {
        root,
        temporary,
        pendingPath,
        attempts,
        journal: join(attempts, `${claim.attemptId}.json`),
        work: join(root, "work", claim.attemptId),
    };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function readJournal(path: string): Promise<Journal> {
    return JSON.parse(await readFile(path, "utf8")) as Journal;
}

function originalJournal(f: Fixture): Journal {
    return { claim, claimRequestId: pending.clientRequestId, state: "ALLOCATED", work: f.work };
}

/**
 * 子进程从真实领取入口开始，只在可观察的文件系统或传输边界中断；重启前由父进程直接检查已经写下的文件。
 */
function runChild(f: Fixture, phase: "work" | "second-staging" | "journal-error" | "download") {
    const script = `
        import assert from "node:assert/strict";
        import fs from "node:fs/promises";
        import { syncBuiltinESMExports } from "node:module";
        import { join } from "node:path";

        const { root, work, attempts, claim, pending, phase } = JSON.parse(process.argv[1]);
        if (phase === "work") {
            const mkdir = fs.mkdir;
            fs.mkdir = async function (path, options) {
                const result = await mkdir(path, options);
                if (path === work && !options?.recursive) process.exit(0);
                return result;
            };
            syncBuiltinESMExports();
        }
        if (phase === "second-staging") {
            const directory = await fs.open(root, "r");
            const prototype = Object.getPrototypeOf(directory);
            const sync = prototype.sync;
            await directory.close();
            const stagePrefix = join(attempts, claim.attemptId + ".json.");
            prototype.sync = async function () {
                await sync.call(this);
                const descriptor = "/proc/self/fd/" + this.fd;
                if ((await fs.readlink(descriptor)).startsWith(stagePrefix)) {
                    const staged = JSON.parse(await fs.readFile(descriptor, "utf8"));
                    if (staged.state === "ALLOCATED" && staged.allocation) process.exit(0);
                }
            };
        }
        const { claimLoop } = await import("./src/agent/claim-loop.ts");
        const { ExecutionSupervisor } = await import("./src/execution/supervisor.ts");
        const client = {
            async request(path, method, body) {
                assert.equal(path, "/internal/v1/jobs/claim");
                assert.equal(method, "POST");
                assert.deepEqual(body, pending);
                if (phase === "journal-error") {
                    await fs.writeFile(attempts, "blocked journal directory", { mode: 0o600 });
                }
                return claim;
            },
            async download(path, hash, proof) {
                assert.equal(phase, "download");
                assert.equal(path, claim.snapshotUrl);
                assert.equal(hash, claim.snapshotSha256);
                assert.deepEqual(proof, claim);
                process.exit(0);
            },
        };
        const supervisor = new ExecutionSupervisor({ root, client, releaseDirectory: root, minimumFreeBytes: 1 });
        supervisor.processes.start = () => assert.fail("Worker start before the test interruption");
        await claimLoop({
            root, client, supervisor, runnerId: pending.runnerId, capabilities: pending.capabilities,
            signal: new AbortController().signal, once: true,
        });
        assert.fail("Allocation interruption was not reached");
    `;
    const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify({ ...f, claim, pending, phase })],
        {
            cwd: new URL("..", import.meta.url),
            env: { ...process.env, TMPDIR: f.temporary, TSX_DISABLE_CACHE: "1" },
            encoding: "utf8",
            timeout: 10000,
        },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    return child;
}

/**
 * 重启仍使用真实监管器，传输只提供类型化的远端响应并记录请求；监管器的启动调用由观察器核对。
 */
function restart(
    t: TestContext,
    f: Fixture,
    respond: (path: string, body: unknown) => ControlResponse | undefined | Promise<ControlResponse | undefined>,
) {
    const requests: { path: string; body: unknown }[] = [];
    const transport: Pick<AgentClient, "request" | "download"> = {
        async request<T>(path: string, method?: string, body?: unknown): Promise<T> {
            assert.equal(method, "POST");
            requests.push({ path, body });
            return (await respond(path, body)) as T;
        },
        async download() {
            assert.fail("Snapshot download during startup recovery");
        },
    };
    const client = transport as AgentClient;
    const root = f.root;
    const supervisor = new ExecutionSupervisor({
        root,
        client,
        releaseDirectory: root,
        browserExecutable: process.execPath,
        minimumFreeBytes: 1,
    });
    const start = t.mock.method(supervisor.processes, "start");
    t.after(() => assert.equal(start.mock.callCount(), 0));
    const states: ClaimLoopState[] = [];
    return {
        requests,
        states,
        supervisor,
        run: () =>
            claimLoop({
                root,
                client,
                supervisor,
                runnerId: pending.runnerId,
                capabilities: pending.capabilities,
                signal: new AbortController().signal,
                once: true,
                onStateChange: (state) => states.push(state),
            }),
    };
}

function assertReconcile(body: unknown, stop: StopReceipt, expectedScope?: "NO_PROCESS_SPAWNED") {
    assert.equal(stop.attemptId, claim.attemptId);
    assert.equal(stop.processStopped, expectedScope !== undefined);
    assert.equal(stop.processStopScope, expectedScope);
    assert(Number.isFinite(Date.parse(stop.stoppedAt)));
    assert.deepEqual(body, {
        fencingToken: claim.fencingToken,
        processStopped: expectedScope !== undefined,
        ...(expectedScope ? { processStopScope: expectedScope } : {}),
        cleanupStatus: "PENDING",
        stoppedAt: stop.stoppedAt,
    } satisfies Schemas["ReconcileRequest"]);
}

test("crash after exclusive work mkdir reconciles the original fence before claiming with a fresh UUID", async (t) => {
    const f = await fixture(t);
    const crashed = runChild(f, "work");
    assert.equal(crashed.status, 0, crashed.stderr);
    assert((await lstat(f.work)).isDirectory());
    assert.deepEqual(await readdir(f.work), []);
    assert.deepEqual(await readdir(f.temporary), []);
    assert.equal(await readFile(f.pendingPath, "utf8"), pendingBytes);
    const before = await readJournal(f.journal).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
    });
    const retained = join(f.work, "retained.txt");
    await writeFile(retained, "operator evidence");
    const fresh = restart(t, f, async (path, body) => {
        if (path === reconcilePath) {
            assert.equal(await readFile(f.pendingPath, "utf8"), pendingBytes);
            return { attemptId: claim.attemptId, capacityReleased: true, auditId };
        }
        assert.equal(path, claimPath);
        assert.deepEqual(body, JSON.parse(await readFile(f.pendingPath, "utf8")));
        if ((body as Schemas["ClaimRequest"]).clientRequestId === pending.clientRequestId) {
            return { ...claim, fencingToken: 48, leaseToken: "rotated-test-lease-token" };
        }
        return undefined;
    });

    await fresh.run();

    assert.deepEqual(before, originalJournal(f));
    assert.deepEqual(
        fresh.requests.map(({ path }) => path),
        [reconcilePath, claimPath],
    );
    const newRequest = fresh.requests[1]?.body as Schemas["ClaimRequest"];
    assert(newRequest.clientRequestId);
    assert.match(newRequest.clientRequestId, uuid);
    assert.notEqual(newRequest.clientRequestId, pending.clientRequestId);
    assert.deepEqual(newRequest, { ...pending, clientRequestId: newRequest.clientRequestId });
    const record = await readJournal(f.journal);
    assert.equal(record.stop?.reason, "NO_PROCESS_SPAWNED");
    assert(record.stop);
    assertReconcile(fresh.requests[0]?.body, record.stop, "NO_PROCESS_SPAWNED");
    assert.deepEqual(record, { ...originalJournal(f), stop: record.stop, dataCleanup: "OWNERSHIP_UNCONFIRMED" });
    assert.deepEqual(fresh.states, [{ scratchCleanupPending: true }]);
    assert.equal(await readFile(retained, "utf8"), "operator evidence");
    await assert.rejects(lstat(f.pendingPath), { code: "ENOENT" });
    await assert.rejects(lstat(join(f.root, "processes")), { code: "ENOENT" });
});

test("a first journal error leaves pending bytes and does not allocate work or temporary storage", async (t) => {
    const f = await fixture(t);
    const child = runChild(f, "journal-error");
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /EEXIST: file already exists, mkdir .*attempts/);
    assert.equal(await readFile(f.attempts, "utf8"), "blocked journal directory");
    assert.equal(await readFile(f.pendingPath, "utf8"), pendingBytes);
    assert.deepEqual(
        { rootEntries: (await readdir(f.root)).sort(), temporaryCount: (await readdir(f.temporary)).length },
        { rootEntries: ["attempts", "claim-request.json", "tmp"], temporaryCount: 0 },
    );
});

test("completed allocation persists physical identities and the full original claim before download", async (t) => {
    const f = await fixture(t);
    const child = runChild(f, "download");
    assert.equal(child.status, 0, child.stderr);
    const record = await readJournal(f.journal);
    const { allocation, ...initial } = record;
    assert.deepEqual(initial, originalJournal(f));
    assert(allocation);
    assert.deepEqual(await readdir(f.temporary), [allocation.temporaryName]);
    assert.match(allocation.temporaryName, /^veriq-a-/);
    const temporary = join(f.temporary, allocation.temporaryName);
    for (const [identity, path] of [
        [allocation.work, f.work],
        [allocation.temporaryParent, f.temporary],
        [allocation.temporary, temporary],
        [allocation.modules, join(f.work, "node_modules")],
    ] as const) {
        const stat = await lstat(path, { bigint: true });
        assert(stat.isDirectory());
        assert.deepEqual(identity, { dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) });
    }
    assert.match(allocation.owner, uuid);
    assert.equal(await readFile(join(f.work, ".veriq-owner"), "utf8"), allocation.owner);
    assert.equal(await readFile(join(temporary, ".veriq-owner"), "utf8"), allocation.owner);
    assert.deepEqual(await readdir(f.attempts), [`${claim.attemptId}.json`]);
    assert.equal(await readFile(f.pendingPath, "utf8"), pendingBytes);
    await assert.rejects(lstat(join(f.root, "processes")), { code: "ENOENT" });
});

test("a legacy committed ALLOCATED record without allocation or work still reconciles", async (t) => {
    const f = await fixture(t);
    await mkdir(f.attempts, { mode: 0o700 });
    await writeFile(f.journal, JSON.stringify({ claim, state: "ALLOCATED", work: f.work }), { mode: 0o600 });
    const fresh = restart(t, f, (path) => {
        assert.equal(path, reconcilePath);
        return { attemptId: claim.attemptId, capacityReleased: true, auditId };
    });
    const cleanups: DataCleanup[] = [];
    const receipts = await fresh.supervisor.recover((cleanup) => cleanups.push(cleanup));

    const record = await readJournal(f.journal);
    assert(record.stop);
    assertReconcile(fresh.requests[0]?.body, record.stop, "NO_PROCESS_SPAWNED");
    assert.deepEqual(receipts, [record.stop]);
    assert.deepEqual(cleanups, ["OWNERSHIP_UNCONFIRMED"]);
    assert.equal(record.claimRequestId, undefined);
    assert.equal(record.allocation, undefined);
    assert.deepEqual(record.claim, claim);
    assert.equal(await readFile(f.pendingPath, "utf8"), pendingBytes);
    await assert.rejects(lstat(f.work), { code: "ENOENT" });
});

test("interruption while staging the allocation supplement quarantines before reusing the pending UUID", async (t) => {
    const f = await fixture(t);
    const child = runChild(f, "second-staging");
    assert.equal(child.status, 0, child.stderr);
    const stages = (await readdir(f.attempts)).filter((name) => name.startsWith(`${claim.attemptId}.json.`));
    assert.equal(stages.length, 1);
    const [stage] = stages;
    assert(stage);
    const stagePath = join(f.attempts, stage);
    const stagedBytes = await readFile(stagePath, "utf8");
    const { allocation, ...staged } = JSON.parse(stagedBytes) as Journal;
    assert.deepEqual(staged, originalJournal(f));
    assert(allocation);
    const temporary = join(f.temporary, allocation.temporaryName);
    assert.equal(await readFile(join(f.work, ".veriq-owner"), "utf8"), allocation.owner);
    assert.equal(await readFile(join(temporary, ".veriq-owner"), "utf8"), allocation.owner);
    const fresh = restart(t, f, (path) => {
        assert.equal(path, reconcilePath);
        return { attemptId: claim.attemptId, capacityReleased: false, auditId };
    });

    await assert.rejects(fresh.run(), { message: "PROCESS_QUARANTINED" });

    assert.deepEqual(
        fresh.requests.map(({ path }) => path),
        [reconcilePath],
    );
    const record = await readJournal(f.journal);
    assert(record.stop);
    assert.equal(record.stop.reason, "JOURNAL_STAGING_UNCONFIRMED");
    assertReconcile(fresh.requests[0]?.body, record.stop);
    assert.deepEqual(record, { ...originalJournal(f), stop: record.stop, dataCleanup: "STOP_UNCONFIRMED" });
    assert.deepEqual(fresh.states, [{ scratchCleanupPending: true }]);
    assert.equal(await readFile(stagePath, "utf8"), stagedBytes);
    assert.equal(await readFile(join(temporary, ".veriq-owner"), "utf8"), allocation.owner);
    assert.equal(await readFile(f.pendingPath, "utf8"), pendingBytes);
});

test("an existing work tree produces EEXIST and retains its original members", async (t) => {
    const f = await fixture(t);
    await mkdir(f.work, { recursive: true, mode: 0o700 });
    const retained = join(f.work, "unknown-source.txt");
    await writeFile(retained, "historical bytes");
    const fresh = restart(t, f, (path, body) => {
        assert.equal(path, claimPath);
        assert.deepEqual(body, pending);
        return claim;
    });

    await assert.rejects(fresh.run(), { code: "EEXIST", path: f.work });

    assert.deepEqual(
        fresh.requests.map(({ path }) => path),
        [claimPath],
    );
    assert.deepEqual(await readdir(f.work), ["unknown-source.txt"]);
    assert.equal(await readFile(retained, "utf8"), "historical bytes");
    assert.equal(await readFile(f.pendingPath, "utf8"), pendingBytes);
});
