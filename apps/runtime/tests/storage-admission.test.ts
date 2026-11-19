import assert from "node:assert/strict";
import type { BigIntStatsFs } from "node:fs";
import fs, { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { claimLoop } from "../src/agent/claim-loop.ts";
import { ExecutionSupervisor } from "../src/execution/supervisor.ts";

const runnerId = "11111111-1111-4111-8111-111111111111";
const clientRequestId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const capabilities = {
    engineVersion: "0.1.0",
    os: "linux",
    arch: "x64",
    browsers: ["chromium"],
} satisfies Parameters<typeof claimLoop>[0]["capabilities"];
const pendingBytes = `${JSON.stringify({ runnerId, clientRequestId, capabilities, availableSlots: 1 }, null, 4)}\n`;
const volume = {
    type: 0n,
    bsize: 4096n,
    blocks: 400000n,
    bfree: 300000n,
    bavail: 131072n,
    files: 90000n,
    ffree: 80000n,
} satisfies BigIntStatsFs;

/**
 * 保留真实监管器、恢复日志和领取文件，只替代操作系统容量值以及远端传输；路径分别记账，以覆盖目录存在时的独立卷查询。
 */
async function fixture(t: TestContext, minimumFreeBytes?: number) {
    const root = await mkdtemp(join(tmpdir(), "vq-disk-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const controller = new AbortController();
    const requests: { path: string; body: unknown }[] = [];
    const client = {
        async request(path: string, _method: string, body: unknown) {
            requests.push({ path, body });
            if (path.endsWith("/claim")) controller.abort();
        },
    } as unknown as Parameters<typeof claimLoop>[0]["client"];
    const supervisor = new ExecutionSupervisor({
        root,
        client,
        releaseDirectory: root,
        browserExecutable: "/unused",
        ...(minimumFreeBytes !== undefined ? { minimumFreeBytes } : {}),
    });
    const states: unknown[] = [];
    return {
        client,
        controller,
        requests,
        root,
        path: join(root, "claim-request.json"),
        work: join(root, "work"),
        supervisor,
        states,
        run: (once = true, observe?: (state: unknown) => void) =>
            claimLoop({
                client,
                supervisor,
                root,
                runnerId,
                capabilities,
                signal: controller.signal,
                once,
                onStateChange: (state: unknown) => {
                    states.push(state);
                    observe?.(state);
                },
            }),
    };
}

for (const target of ["root", "work", "temporary"] as const) {
    test(`an independently full ${target} volume prevents the first claim at the 512 MiB default`, async (t) => {
        const f = await fixture(t);
        await mkdir(f.work);
        const paths = { root: f.root, work: f.work, temporary: tmpdir() };
        t.mock.method(fs, "statfs", async (path: string, options: { bigint: boolean }) => {
            assert.deepEqual(options, { bigint: true });
            return path === paths[target] ? { ...volume, bavail: 131071n } : volume;
        });
        await assert.rejects(f.run(), { message: "RUNTIME_STORAGE_LOW" });
        assert.deepEqual(f.requests, []);
        await assert.rejects(lstat(f.path), { code: "ENOENT" });
    });
}

test("separately observed root, work and temporary volumes admit a claim at the byte threshold", async (t) => {
    const f = await fixture(t);
    await mkdir(f.work);
    const paths: string[] = [];
    t.mock.method(fs, "statfs", async (path: string) => {
        paths.push(path);
        return volume;
    });
    await f.run();
    assert.deepEqual(paths.sort(), [f.root, f.work, tmpdir()].sort());
    assert.equal(f.requests.length, 1);
});

test("a missing work directory uses the existing parent volume without creating work", async (t) => {
    const f = await fixture(t);
    const paths: string[] = [];
    t.mock.method(fs, "statfs", async (path: string) => {
        paths.push(path);
        return volume;
    });
    await f.run();
    assert.deepEqual([...new Set(paths)].sort(), [f.root, tmpdir()].sort());
    assert.equal(f.requests.length, 1);
    await assert.rejects(lstat(f.work), { code: "ENOENT" });
});

test("host minimum is compared as bigint using available blocks at the exact byte boundary", async (t) => {
    const f = await fixture(t, Number.MAX_SAFE_INTEGER);
    const block = 9007199254740990n;
    t.mock.method(fs, "statfs", async () => ({ ...volume, bsize: block, bavail: 1n, bfree: 2n }));
    await assert.rejects(f.run(), { message: "RUNTIME_STORAGE_LOW" });
    assert.deepEqual(f.requests, []);
    t.mock.method(fs, "statfs", async () => ({ ...volume, bsize: block, bavail: 2n }));
    await f.run();
    assert.equal(f.requests.length, 1);
});

for (const minimum of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    test(`host minimum rejects an invalid value: ${minimum}`, () => {
        assert.throws(
            () =>
                new ExecutionSupervisor({
                    root: "/unused",
                    minimumFreeBytes: minimum,
                } as ConstructorParameters<typeof ExecutionSupervisor>[0]),
            { message: "INVALID_MINIMUM_FREE_BYTES" },
        );
    });
}

for (const [name, facts] of [
    ["zero block size", { ...volume, bsize: 0n }],
    ["negative available blocks", { ...volume, bavail: -1n }],
    ["number blocks", { ...volume, bavail: 131072 }],
    ["available blocks beyond volume capacity", { ...volume, bavail: volume.blocks + 1n }],
] as const) {
    test(`capacity cannot be confirmed with ${name}`, async (t) => {
        const f = await fixture(t);
        t.mock.method(fs, "statfs", async () => facts);
        await assert.rejects(f.run(), { message: "RUNTIME_STORAGE_UNAVAILABLE" });
        assert.deepEqual(f.requests, []);
    });
}

for (const target of ["root", "work", "temporary"] as const) {
    test(`an unverified ${target} volume uses a fixed reason and leaves pending request bytes intact`, async (t) => {
        const f = await fixture(t);
        await mkdir(f.work);
        await writeFile(f.path, pendingBytes);
        const paths = { root: f.root, work: f.work, temporary: tmpdir() };
        t.mock.method(fs, "statfs", async (path: string) => {
            if (path === paths[target]) throw new Error("private system mount /sensitive");
            return volume;
        });
        await assert.rejects(f.run(), { message: "RUNTIME_STORAGE_UNAVAILABLE" });
        assert.deepEqual(f.requests, []);
        assert.equal(await readFile(f.path, "utf8"), pendingBytes);
    });
}

test("a disk pause takes priority over reading an invalid pending file", async (t) => {
    const f = await fixture(t);
    const unknown = "unparsed pending data\n";
    await writeFile(f.path, unknown);
    t.mock.method(fs, "statfs", async () => ({ ...volume, bavail: 0n }));
    await assert.rejects(f.run(), { message: "RUNTIME_STORAGE_LOW" });
    assert.deepEqual(f.requests, []);
    assert.equal(await readFile(f.path, "utf8"), unknown);
});

test("a non-directory work parent prevents fallback to the Runtime root volume", async (t) => {
    const f = await fixture(t);
    await writeFile(f.work, "not a directory");
    t.mock.method(fs, "statfs", async () => volume);
    await assert.rejects(f.run(), { message: "RUNTIME_STORAGE_UNAVAILABLE" });
    assert.deepEqual(f.requests, []);
});

test("an acknowledged recovery cannot remove a pending request during a disk pause", async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.root, "attempts"), { mode: 0o700 });
    await writeFile(
        join(f.root, "attempts", `${attemptId}.json`),
        JSON.stringify({
            claimRequestId: clientRequestId,
            state: "ALLOCATED",
            work: f.work,
            claim: { attemptId, fencingToken: 1 },
        }),
        { mode: 0o600 },
    );
    await writeFile(f.path, pendingBytes);
    t.mock.method(fs, "statfs", async () => ({ ...volume, bavail: 0n }));
    await assert.rejects(f.run(), { message: "RUNTIME_STORAGE_LOW" });
    assert.deepEqual(
        f.requests.map(({ path }) => path),
        [`/internal/v1/attempts/${attemptId}/reconcile`],
    );
    assert.equal(await readFile(f.path, "utf8"), pendingBytes);
    assert.equal((f.states.at(-1) as { scratchCleanupPending: boolean }).scratchCleanupPending, true);
});

test("a pending identifier kept through low disk remains on a replay rejected as expired", async (t) => {
    const f = await fixture(t);
    await writeFile(f.path, pendingBytes);
    let low = true;
    t.mock.method(fs, "statfs", async () => (low ? { ...volume, bavail: 0n } : volume));
    const claim = t.mock.method(f.client, "request", async (path: string, method: string, body: unknown) => {
        assert.equal(path, "/internal/v1/jobs/claim");
        assert.equal(method, "POST");
        assert.deepEqual(body, JSON.parse(pendingBytes));
        throw new Error("LEASE_EXPIRED");
    });
    await assert.rejects(f.run(), { message: "RUNTIME_STORAGE_LOW" });
    assert.equal(claim.mock.callCount(), 0);
    low = false;
    await assert.rejects(f.run(), { message: "LEASE_EXPIRED" });
    assert.equal(claim.mock.callCount(), 1);
    assert.equal(await readFile(f.path, "utf8"), pendingBytes);
});

test("unknown stop stays quarantined before any disk query or claim", async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.root, "attempts"), { mode: 0o700 });
    await writeFile(
        join(f.root, "attempts", `${attemptId}.json`),
        JSON.stringify({ state: "RUNNING", work: f.work, claim: { attemptId, fencingToken: 1 } }),
        { mode: 0o600 },
    );
    await writeFile(f.path, pendingBytes);
    const inspect = t.mock.method(fs, "statfs", async () => ({ ...volume, bavail: 0n }));
    await assert.rejects(f.run(), { message: "PROCESS_QUARANTINED" });
    assert.deepEqual(
        f.requests.map(({ path }) => path),
        [`/internal/v1/attempts/${attemptId}/reconcile`],
    );
    assert.equal(inspect.mock.callCount(), 0);
    assert.equal(await readFile(f.path, "utf8"), pendingBytes);
    assert.deepEqual(f.states, [{ scratchCleanupPending: true }]);
});

/**
 * 夹具以可显式释放的事件协调容量采样和业务断言，让虚拟时间只控制重试间隔，不顺便替代真实文件系统调度。
 */
function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, resolve: release };
}

/**
 * 虚拟时钟只控制既有十秒轮询，阻塞第二次容量采样来核对同一低盘状态未重复通知；恢复时发送先前持久的原始请求标识。
 */
test("polling publishes pause transitions once and replays the same pending request after recovery", async (t) => {
    const f = await fixture(t);
    await writeFile(f.path, pendingBytes);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const paused = gate();
    const secondSample = gate();
    const allowSecond = gate();
    let samples = 0;
    t.mock.method(fs, "statfs", async (path: string) => {
        if (path === tmpdir() && ++samples === 2) {
            secondSample.resolve();
            await allowSecond.promise;
        }
        return samples < 3 && path === tmpdir() ? { ...volume, bavail: 0n } : volume;
    });
    const worker = f.run(false, (state) => {
        if ((state as { pausedReason?: string }).pausedReason) paused.resolve();
    });
    try {
        await Promise.race([paused.promise, worker]);
        assert.deepEqual(f.states, [{ pausedReason: "RUNTIME_STORAGE_LOW" }]);
        assert.deepEqual(f.requests, []);
        assert.equal(await readFile(f.path, "utf8"), pendingBytes);
        t.mock.timers.tick(9999);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(samples, 1);
        t.mock.timers.tick(1);
        await Promise.race([secondSample.promise, worker]);
        allowSecond.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(f.states, [{ pausedReason: "RUNTIME_STORAGE_LOW" }]);
        assert.deepEqual(f.requests, []);
        t.mock.timers.tick(10000);
        await worker;
        assert.deepEqual(f.states, [{ pausedReason: "RUNTIME_STORAGE_LOW" }, {}]);
        assert.deepEqual(f.requests, [
            {
                path: "/internal/v1/jobs/claim",
                body: JSON.parse(pendingBytes),
            },
        ]);
    } finally {
        allowSecond.resolve();
        f.controller.abort();
        await worker;
    }
});

test("cancelling a paused loop ends immediately without creating a claim", async (t) => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(fs, "statfs", async () => ({ ...volume, bavail: 0n }));
    await f.run(false, () => {
        if (!f.controller.signal.aborted) setImmediate(() => f.controller.abort());
    });
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.states, [{ pausedReason: "RUNTIME_STORAGE_LOW" }, {}]);
    await assert.rejects(lstat(f.path), { code: "ENOENT" });
});

for (const outcome of ["success", "failure"] as const) {
    /**
     * 首轮发布低盘后把第二轮真实探针的最后一次查询留在未决状态；用事件循环让停止先收敛，再交付迟到的容量结果。
     */
    test(`stopping during a disk recheck ignores a late ${outcome}`, async (t) => {
        const f = await fixture(t);
        await writeFile(f.path, pendingBytes);
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const paused = gate();
        const rechecking = gate();
        const release = gate();
        const settled = gate();
        let samples = 0;
        t.mock.method(fs, "statfs", async (path: string) => {
            if (path !== tmpdir()) return volume;
            if (++samples === 1) return { ...volume, bavail: 0n };
            rechecking.resolve();
            await release.promise;
            try {
                if (outcome === "failure") throw new Error("late operating system read failure");
                return volume;
            } finally {
                settled.resolve();
            }
        });
        const worker = f.run(false, (state) => {
            if ((state as { pausedReason?: string }).pausedReason) paused.resolve();
        });
        try {
            await Promise.race([paused.promise, worker]);
            assert.deepEqual(f.states, [{ pausedReason: "RUNTIME_STORAGE_LOW" }]);
            t.mock.timers.tick(10000);
            await Promise.race([rechecking.promise, worker]);
            assert.equal(samples, 2);
            f.controller.abort();
            const stopped = await Promise.race([
                worker.then(() => true),
                new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
            ]);
            assert.equal(stopped, true, "claim loop must stop before the pending storage query replies");
            assert.deepEqual(f.states, [{ pausedReason: "RUNTIME_STORAGE_LOW" }, {}]);
            assert.deepEqual(f.requests, []);
            assert.equal(await readFile(f.path, "utf8"), pendingBytes);
            release.resolve();
            await settled.promise;
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.deepEqual(f.states, [{ pausedReason: "RUNTIME_STORAGE_LOW" }, {}]);
            assert.deepEqual(f.requests, []);
            assert.equal(await readFile(f.path, "utf8"), pendingBytes);
        } finally {
            f.controller.abort();
            release.resolve();
            await worker;
        }
    });
}

/**
 * 内容下载失败仍经过真实未派生证明和暂存日志收尾，领取失败继续向上传播，同时把独立的处置事实保留在本机可见状态。
 */
test("a real failed attempt publishes scratch cleanup pending before propagating its failure", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "vq-disk-attempt-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const claim = {
        attemptId,
        expiresAt: "2026-01-01T00:01:00Z",
        serverTime: "2026-01-01T00:00:00Z",
        leaseDurationMs: 60000,
    };
    const client = {
        async request(path: string) {
            if (path.endsWith("/claim")) return claim;
        },
        async download() {
            throw new Error("DOWNLOAD_FAILED");
        },
    } as unknown as Parameters<typeof claimLoop>[0]["client"];
    const supervisor = new ExecutionSupervisor({ root, client, releaseDirectory: root, browserExecutable: "/unused" });
    const states: unknown[] = [];
    t.mock.method(fs, "statfs", async () => volume);
    await assert.rejects(
        claimLoop({
            client,
            supervisor,
            root,
            runnerId,
            capabilities,
            signal: new AbortController().signal,
            once: true,
            onStateChange: (state: unknown) => states.push(state),
        }),
        { message: "DOWNLOAD_FAILED" },
    );
    const record = JSON.parse(await readFile(join(root, "attempts", `${attemptId}.json`), "utf8"));
    assert.equal(record.stop.processStopScope, "NO_PROCESS_SPAWNED");
    assert.equal(record.dataCleanup, "OWNERSHIP_UNCONFIRMED");
    const tmp = join(tmpdir(), record.allocation.temporaryName);
    t.after(() => rm(tmp, { recursive: true, force: true }));
    assert.deepEqual(states, [{ scratchCleanupPending: true }]);
});

test("retained scratch status cannot turn a completed business result into a claim failure", async (t) => {
    const f = await fixture(t);
    t.mock.method(fs, "statfs", async () => volume);
    const stop = { attemptId, processStopped: true, reason: "COMPLETED", stoppedAt: "2026-01-01T00:00:00Z" };
    const completion = { businessOutcome: "PASSED" };
    t.mock.method(f.supervisor, "runAttempt", async () => ({
        stop,
        files: [],
        completion,
        dataCleanup: "OWNERSHIP_UNCONFIRMED",
    }));
    t.mock.method(f.client, "request", async () => ({ attemptId }));
    await f.run();
    assert.deepEqual(f.states, [{ scratchCleanupPending: true }]);
    await assert.rejects(lstat(f.path), { code: "ENOENT" });
});
