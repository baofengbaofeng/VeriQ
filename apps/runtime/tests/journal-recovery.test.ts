import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ExecutionSupervisor } from "../src/execution/supervisor.ts";
import { ProcessSupervisor } from "../src/execution/processes.ts";
import { ProcessRecords } from "../src/execution/records.ts";
import type { AgentClient } from "../src/agent/transport.ts";
import { allocateScratch, retireScratch } from "../src/execution/storage.ts";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";

/**
 * 恢复夹具把正式日志和未发布临时对象真实写入同一私有目录，transport只记录对账声明；进程存在时仍由真实原生守护排空，任
 * 何临时成员都不能自行提供停止成功或未派生证明。
 */
async function fixture(root: string) {
    const directory = join(root, "attempts"),
        bodies: Record<string, unknown>[] = [];
    await mkdir(directory, { mode: 0o700 });
    const client = {
        request: async (_path: string, _method: string, body: Record<string, unknown>) => {
            bodies.push(body);
        },
    } as unknown as AgentClient;
    const options = { root, client, releaseDirectory: root, browserExecutable: process.execPath };
    const supervisor = new ExecutionSupervisor(options);
    const record = (attemptId: string, state = "ALLOCATED") => ({
        claim: { attemptId, fencingToken: 1 },
        state,
        work: root,
    });
    const committed = async (id: string, state = "ALLOCATED") =>
        writeFile(join(directory, `${id}.json`), JSON.stringify(record(id, state)), {
            mode: 0o600,
        });
    const stage = async (id: string, bytes = JSON.stringify(record(id, "SPAWNING"))) => {
        const path = join(directory, `${id}.json.${randomUUID()}`);
        await writeFile(path, bytes, { mode: 0o600 });
        return path;
    };
    return { directory, bodies, supervisor, options, record, committed, stage };
}

for (const bytes of ["SPAWNING", '{"claim":']) {
    const name = `interrupted journal staging quarantines only its attempt and preserves other recovery: ${bytes}`;
    test(name, async () => {
        const root = await mkdtemp(join(tmpdir(), "vq-journal-stage-")),
            affected = randomUUID(),
            healthy = randomUUID();
        const f = await fixture(root),
            processes = new ProcessSupervisor(join(root, "processes"));
        try {
            await f.committed(affected);
            await f.committed(healthy, "RUNNING");
            const staged = await f.stage(
                affected,
                bytes === "SPAWNING" ? JSON.stringify(f.record(affected, "SPAWNING")) : bytes,
            );
            const before = await readFile(staged);
            const worker = await processes.start(healthy, {
                executable: process.execPath,
                args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
                cwd: root,
            });
            await worker.firstLine();
            const receipts = await f.supervisor.recover();
            assert.equal(receipts.find((item) => item.attemptId === affected)?.processStopped, false);
            assert.equal(receipts.find((item) => item.attemptId === affected)?.processStopScope, undefined);
            assert.equal(receipts.find((item) => item.attemptId === healthy)?.processStopScope, "FULL_DESCENDANT_TREE");
            assert.equal(await processes.isRunning(worker.pid), false);
            assert.equal(f.bodies.length, 2);
            assert.deepEqual(await readFile(staged), before);
            const strict = await ProcessRecords.open(f.directory);
            assert(strict);
            try {
                await assert.rejects(strict.names(4096), /PROCESS_RECORD_NAME_INVALID/);
                await assert.rejects(strict.read(staged.split("/").at(-1)!, 65536), /PROCESS_RECORD_NAME_INVALID/);
                await assert.rejects(strict.journalNames(1), /PROCESS_RECORD_LIMIT_OR_TYPE/);
            } finally {
                await strict.close();
            }
        } finally {
            await processes.terminateAttempt(healthy, "TEST_FINALLY");
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("orphan journal staging returns explicit uncertainty while another pre-spawn attempt reconciles", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-journal-orphan-")),
        orphan = randomUUID(),
        healthy = randomUUID();
    const f = await fixture(root);
    try {
        await f.stage(orphan);
        await f.committed(healthy);
        const receipts = await f.supervisor.recover();
        assert.equal(receipts.find((item) => item.attemptId === orphan)?.processStopped, false);
        assert.equal(receipts.find((item) => item.attemptId === orphan)?.reason, "JOURNAL_STAGING_UNCONFIRMED");
        assert.equal(receipts.find((item) => item.attemptId === healthy)?.processStopScope, "NO_PROCESS_SPAWNED");
        assert.equal(f.bodies.length, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("actual writer exit after staging flush preserves uncertainty without blocking another attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-journal-crash-")),
        affected = randomUUID(),
        healthy = randomUUID();
    const f = await fixture(root);
    try {
        await f.committed(affected);
        await f.committed(healthy);
        const script =
            `import {open} from 'node:fs/promises';import {ExecutionSupervisor} from './src/execution/su` +
            `pervisor.ts';const root=process.argv[1],record=JSON.parse(process.argv[2]),handle=await open(root,'r')` +
            `,prototype=Object.getPrototypeOf(handle),sync=prototype.sync;await handle.close();prototype.sync=async` +
            ` function(){await sync.call(this);if((await this.stat()).isFile())process.exit(0);};const supervisor=n` +
            `ew ExecutionSupervisor({root,client:{}});await supervisor.journal(record);throw new Error('INTERRUPTIO` +
            `N_NOT_REACHED');`;
        const child = spawnSync(
            process.execPath,
            [
                "--import",
                "tsx",
                "--input-type=module",
                "-e",
                script,
                root,
                JSON.stringify(f.record(affected, "SPAWNING")),
            ],
            { encoding: "utf8", timeout: 10000 },
        );
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, child.stderr);
        const stages = (await readdir(f.directory)).filter((name) => name.includes(".json."));
        assert.equal(stages.length, 1);
        assert.equal(JSON.parse(await readFile(join(f.directory, stages[0]!), "utf8")).state, "SPAWNING");
        const receipts = await f.supervisor.recover();
        assert.equal(receipts.find((receipt) => receipt.attemptId === affected)?.processStopped, false);
        assert.equal(receipts.find((receipt) => receipt.attemptId === affected)?.processStopScope, undefined);
        assert.equal(receipts.find((receipt) => receipt.attemptId === healthy)?.processStopScope, "NO_PROCESS_SPAWNED");
        assert.equal(f.bodies.length, 2);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

for (const invalid of ["unknown", "malformed-name", "link", "mode", "oversize", "malformed-committed"]) {
    test(`journal staging does not relax private and malformed member rejection: ${invalid}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vq-journal-invalid-")),
            id = randomUUID();
        const f = await fixture(root);
        try {
            await f.committed(id);
            if (invalid === "unknown") await writeFile(join(f.directory, "unknown.tmp"), "{}", { mode: 0o600 });
            if (invalid === "malformed-name")
                await writeFile(join(f.directory, `${id}.json.not-a-uuid`), "{}", { mode: 0o600 });
            if (invalid === "link")
                await symlink(join(f.directory, `${id}.json`), join(f.directory, `${id}.json.${randomUUID()}`));
            if (invalid === "mode") await chmod(await f.stage(id), 0o644);
            if (invalid === "oversize") await f.stage(id, "x".repeat(65537));
            if (invalid === "malformed-committed") await writeFile(join(f.directory, `${id}.json`), "{");
            await assert.rejects(f.supervisor.recover());
            assert.equal(f.bodies.length, 0);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

for (const failure of ["write", "rename"]) {
    test(`journal ${failure} failure removes only the temporary inode created by this call`, async (context) => {
        const root = await mkdtemp(join(tmpdir(), "vq-journal-cleanup-")),
            id = randomUUID();
        const f = await fixture(root),
            journal = Reflect.get(f.supervisor, "journal").bind(f.supervisor);
        const older = await f.stage(id),
            before = await readFile(older);
        try {
            if (failure === "write") {
                const pathWrite = fs.writeFile;
                context.mock.method(
                    fs,
                    "writeFile",
                    async (
                        path: Parameters<typeof fs.writeFile>[0],
                        data: Parameters<typeof fs.writeFile>[1],
                        options: Parameters<typeof fs.writeFile>[2],
                    ) => {
                        if (String(path).includes(".json.") && !String(path).endsWith(older.split("/").at(-1)!)) {
                            await pathWrite(path, "{", options);
                            throw new Error("JOURNAL_WRITE_FAILED");
                        }
                        return pathWrite(path, data, options);
                    },
                );
                syncBuiltinESMExports();
                const handle = await open(root, "r"),
                    prototype = Object.getPrototypeOf(handle);
                const original = prototype.writeFile;
                await handle.close();
                context.mock.method(
                    prototype,
                    "writeFile",
                    async function (this: Awaited<ReturnType<typeof open>>, ...args: unknown[]) {
                        const path = await import("node:fs/promises").then((fs) =>
                            fs.readlink(`/proc/self/fd/${this.fd}`),
                        );
                        if (path.startsWith(f.directory + "/") && path !== older) {
                            await this.write("{");
                            throw new Error("JOURNAL_WRITE_FAILED");
                        }
                        return original.apply(this, args);
                    },
                );
                await assert.rejects(journal(f.record(id)), /JOURNAL_WRITE_FAILED/);
            } else {
                await mkdir(join(f.directory, `${id}.json`));
                await assert.rejects(journal(f.record(id)), (error) =>
                    ["EISDIR", "ENOTDIR", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""),
                );
                assert.equal((await lstat(join(f.directory, `${id}.json`))).isDirectory(), true);
            }
            assert.deepEqual(
                (await readdir(f.directory)).filter((name) => name.includes(".json.")),
                [older.split("/").at(-1)],
            );
            assert.deepEqual(await readFile(older), before);
        } finally {
            context.mock.restoreAll();
            syncBuiltinESMExports();
            await rm(root, { recursive: true, force: true });
        }
    });
}

/**
 * 夹具使用新分配的真实目录和所有者标记，以便恢复入口从持久日志判断停止状态，并直接检查两棵树里的文件字节。
 */
async function scratchFixture(root: string, tmp: string) {
    const f = await fixture(root);
    const id = randomUUID();
    const work = join(root, "work", id);
    await mkdir(work, { recursive: true, mode: 0o700 });
    const allocation = await allocateScratch(root, work, tmp);
    return {
        f,
        id,
        work,
        allocation,
        journal: join(f.directory, `${id}.json`),
        modules: join(work, "node_modules"),
    };
}

for (const condition of ["owned", "replaced-work", "linked-work", "unknown", "historical", "relocated-tmp"]) {
    test(`scratch recovery keeps ordinary task files: ${condition}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vq-data-recover-"));
        const tmp = await mkdtemp(join(tmpdir(), "veriq-a-"));
        try {
            const { f, id, work, allocation, journal, modules } = await scratchFixture(root, tmp);
            const outside = join(root, "outside");
            await mkdir(outside);
            await writeFile(join(outside, "keep"), "external sentinel bytes");
            await writeFile(join(modules, "copy"), "original dependency bytes");
            await writeFile(join(tmp, "copy"), "original scratch bytes");
            const state = condition === "unknown" ? "RUNNING" : "ALLOCATED";
            const record = { ...f.record(id, state), work, ...(condition === "historical" ? {} : { allocation }) };
            await writeFile(journal, JSON.stringify(record), { mode: 0o600 });

            const movedWork = join(root, "moved-work");
            const movedTmp = join(outside, "moved-tmp");
            if (condition === "replaced-work" || condition === "linked-work") {
                await fs.rename(work, movedWork);
                if (condition === "replaced-work") {
                    await mkdir(join(work, "node_modules"), { recursive: true });
                    await writeFile(join(modules, "copy"), "replacement dependency bytes");
                } else {
                    await symlink(outside, work);
                }
            }
            if (condition === "relocated-tmp") {
                await fs.rename(tmp, movedTmp);
                await mkdir(tmp);
                await writeFile(join(tmp, "copy"), "replacement scratch bytes");
            }

            const [receipt] = await f.supervisor.recover();
            const stopped = condition !== "unknown";
            assert.equal(receipt?.processStopped, stopped);
            assert.equal(receipt?.processStopScope, stopped ? "NO_PROCESS_SPAWNED" : undefined);
            const persisted = JSON.parse(await readFile(journal, "utf8"));
            assert.equal(persisted.dataCleanup, stopped ? "OWNERSHIP_UNCONFIRMED" : "STOP_UNCONFIRMED");
            const originalModules =
                condition === "replaced-work" || condition === "linked-work"
                    ? join(movedWork, "node_modules")
                    : modules;
            const originalTmp = condition === "relocated-tmp" ? movedTmp : tmp;
            assert.equal(await readFile(join(originalModules, "copy"), "utf8"), "original dependency bytes");
            assert.equal(await readFile(join(originalTmp, "copy"), "utf8"), "original scratch bytes");
            assert.deepEqual(await readdir(originalModules), ["copy"]);
            assert.deepEqual((await readdir(originalTmp)).sort(), [".veriq-owner", "copy"]);
            assert.equal(await readFile(join(outside, "keep"), "utf8"), "external sentinel bytes");
            if (condition === "replaced-work") {
                assert.equal(await readFile(join(modules, "copy"), "utf8"), "replacement dependency bytes");
            }
            if (condition === "linked-work") assert.equal(await fs.readlink(work), outside);
            if (condition === "relocated-tmp") {
                assert.equal(await readFile(join(tmp, "copy"), "utf8"), "replacement scratch bytes");
            }
            assert(!JSON.stringify(persisted).includes("original scratch bytes"));

            if (condition === "owned") {
                assert.equal(Object.hasOwn(allocation, "retirementPermit"), false);
                await assert.rejects(lstat(join(root, "scratch-retirements")), { code: "ENOENT" });
                await writeFile(join(tmp, "operator-copy"), "later operator bytes");
                const [again] = await new ExecutionSupervisor(f.options).recover();
                assert.equal(again?.processStopScope, "NO_PROCESS_SPAWNED");
                assert.equal(JSON.parse(await readFile(journal, "utf8")).dataCleanup, "OWNERSHIP_UNCONFIRMED");
                assert.equal(await readFile(join(tmp, "copy"), "utf8"), "original scratch bytes");
                assert.equal(await readFile(join(tmp, "operator-copy"), "utf8"), "later operator bytes");
            }
        } finally {
            await rm(tmp, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        }
    });
}

for (const formerState of ["ready", "missing", "replaced", "interrupted", "receipts", "markers-removed"]) {
    test(`recovery preserves legacy scratch and retirement artifacts: ${formerState}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vq-legacy-retirement-"));
        const tmp = await mkdtemp(join(tmpdir(), "veriq-a-"));
        try {
            const { f, id, work, allocation, journal, modules } = await scratchFixture(root, tmp);
            const permitDirectory = join(root, "scratch-retirements");
            const permit = join(permitDirectory, allocation.owner);
            const oldPermit = `${permit}-old`;
            const ready = ["ready", "missing", "replaced"].includes(formerState);
            const permitBytes = ready ? "READY\n" : "READY\nSTARTED\n";
            await mkdir(permitDirectory, { recursive: true, mode: 0o700 });
            await writeFile(permit, permitBytes, { mode: 0o600 });
            const identity = await lstat(permit, { bigint: true });
            const historicalAllocation = {
                ...allocation,
                retirementPermit: {
                    dev: String(identity.dev),
                    ino: String(identity.ino),
                    birth: String(identity.birthtimeNs),
                },
            };
            if (formerState === "missing" || formerState === "replaced") await fs.rename(permit, oldPermit);
            if (formerState === "replaced") await writeFile(permit, "READY\n", { mode: 0o600 });
            const record = { ...f.record(id), work, allocation: historicalAllocation };
            await writeFile(journal, JSON.stringify(record), { mode: 0o600 });

            const inventory = ".veriq-retirement-inventory";
            const done = ".veriq-retired";
            const receiptBytes = `${allocation.owner}:${"abcd".repeat(16)}`;
            const dependencyMarkers: string[] = [];
            const temporaryMarkers: string[] = [];
            const trees = [
                [modules, dependencyMarkers],
                [tmp, temporaryMarkers],
            ] as const;
            if (formerState === "interrupted") {
                dependencyMarkers.push(inventory);
                await writeFile(join(modules, "already-truncated"), "");
            }
            if (formerState === "receipts") {
                dependencyMarkers.push(done, inventory);
                temporaryMarkers.push(done, inventory);
            }
            for (const [dir, markers] of trees) {
                if (formerState === "markers-removed") {
                    await writeFile(join(dir, "previous-copy"), "bytes written after the old pass");
                }
                for (const marker of markers) {
                    await writeFile(join(dir, marker), receiptBytes, { mode: 0o600 });
                }
                await writeFile(join(dir, "copy"), "intact task bytes");
            }
            const expectedModules = (await readdir(modules)).sort();
            const expectedTmp = (await readdir(tmp)).sort();

            for (const supervisor of [f.supervisor, new ExecutionSupervisor(f.options)]) {
                const [receipt] = await supervisor.recover();
                assert.equal(receipt?.processStopScope, "NO_PROCESS_SPAWNED");
                const persisted = JSON.parse(await readFile(journal, "utf8"));
                assert.equal(persisted.dataCleanup, "OWNERSHIP_UNCONFIRMED");
                assert.deepEqual(persisted.allocation, historicalAllocation);
                for (const [dir, markers] of trees) {
                    assert.equal(await readFile(join(dir, "copy"), "utf8"), "intact task bytes");
                    for (const marker of markers) {
                        assert.equal(await readFile(join(dir, marker), "utf8"), receiptBytes);
                    }
                    if (formerState === "markers-removed") {
                        assert.equal(
                            await readFile(join(dir, "previous-copy"), "utf8"),
                            "bytes written after the old pass",
                        );
                    }
                }
                assert.deepEqual((await readdir(modules)).sort(), expectedModules);
                assert.deepEqual((await readdir(tmp)).sort(), expectedTmp);
                if (formerState === "interrupted") {
                    assert.equal(await readFile(join(modules, "already-truncated"), "utf8"), "");
                }
                if (formerState === "missing") {
                    await assert.rejects(lstat(permit), { code: "ENOENT" });
                } else {
                    assert.equal(await readFile(permit, "utf8"), permitBytes);
                }
                if (formerState === "missing" || formerState === "replaced") {
                    assert.equal(await readFile(oldPermit, "utf8"), "READY\n");
                }
            }
        } finally {
            await rm(tmp, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        }
    });
}

/**
 * 直接验证暂存处置时使用对应真实分配的已有未派生回执形状，另外的恢复测试覆盖从日志与进程记录推导停止证明。
 */
function unspawnedReceipt(attemptId: string) {
    return {
        attemptId,
        processStopped: true,
        processStopScope: "NO_PROCESS_SPAWNED" as const,
        reason: "NO_PROCESS_SPAWNED",
        stoppedAt: new Date().toISOString(),
    };
}

test("retirement keeps both physical targets of a changed operating system temporary alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-tmp-alias-"));
    const original = join(root, "original");
    const replacement = join(root, "replacement");
    const alias = join(root, "os-tmp");
    try {
        await mkdir(original);
        await mkdir(replacement);
        await symlink(original, alias, "junction");
        const tmp = await mkdtemp(join(alias, "veriq-a-"));
        const { id, work, allocation, modules } = await scratchFixture(root, tmp);
        const originalTmp = join(original, allocation.temporaryName);
        const replacementTmp = join(replacement, allocation.temporaryName);
        await mkdir(replacementTmp);
        await writeFile(join(originalTmp, "copy"), "original scratch bytes");
        await writeFile(join(replacementTmp, "copy"), "replacement scratch bytes");
        await writeFile(join(modules, "copy"), "original dependency bytes");
        for (const target of [replacement, original]) {
            await fs.unlink(alias);
            await symlink(target, alias, "junction");
            const status = await retireScratch(root, alias, { work, allocation }, unspawnedReceipt(id));
            assert.equal(status, "OWNERSHIP_UNCONFIRMED");
            assert.equal(await readFile(join(originalTmp, "copy"), "utf8"), "original scratch bytes");
            assert.equal(await readFile(join(replacementTmp, "copy"), "utf8"), "replacement scratch bytes");
            assert.equal(await readFile(join(modules, "copy"), "utf8"), "original dependency bytes");
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

for (const memberType of ["file", "directory"]) {
    test(`retirement keeps relocated and replacement nested ${memberType} bytes`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vq-scratch-replaced-"));
        try {
            const tmp = await mkdtemp(join(root, "veriq-a-"));
            const { id, work, allocation } = await scratchFixture(root, tmp);
            const nested = join(tmp, "nested");
            await mkdir(nested);
            const original = join(nested, "member");
            const relocated = join(root, "relocated");
            if (memberType === "directory") await mkdir(original);
            const originalFile = memberType === "directory" ? join(original, "child") : original;
            const relocatedFile = memberType === "directory" ? join(relocated, "child") : relocated;
            await writeFile(originalFile, "original member bytes");
            await fs.rename(original, relocated);
            if (memberType === "directory") await mkdir(original);
            await writeFile(originalFile, "replacement member bytes");
            const status = await retireScratch(root, root, { work, allocation }, unspawnedReceipt(id));
            assert.equal(status, "OWNERSHIP_UNCONFIRMED");
            assert.equal(await readFile(originalFile, "utf8"), "replacement member bytes");
            assert.equal(await readFile(relocatedFile, "utf8"), "original member bytes");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("retirement keeps multiple hardlinks, symlinks and ordinary siblings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-scratch-links-"));
    try {
        const tmp = await mkdtemp(join(root, "veriq-a-"));
        const { id, work, allocation } = await scratchFixture(root, tmp);
        const foreign = join(root, "outside");
        const owned = join(tmp, "owned");
        const hardlinks = [join(tmp, "hardlink-a"), join(tmp, "hardlink-b")];
        const link = join(tmp, "symlink");
        await writeFile(foreign, "external bytes");
        for (const hardlink of hardlinks) {
            await fs.link(foreign, hardlink);
        }
        await fs.symlink(foreign, link);
        await writeFile(owned, "original data");
        const record = { work, allocation };
        const stop = unspawnedReceipt(id);
        assert.equal(await retireScratch(root, root, record, stop), "OWNERSHIP_UNCONFIRMED");
        assert.equal(await readFile(owned, "utf8"), "original data");
        await writeFile(owned, "later operator bytes");
        assert.equal(await retireScratch(root, root, record, stop), "OWNERSHIP_UNCONFIRMED");
        assert.equal(await readFile(owned, "utf8"), "later operator bytes");
        for (const name of [foreign, ...hardlinks, link]) {
            assert.equal(await readFile(name, "utf8"), "external bytes");
        }
        assert.equal((await lstat(foreign)).nlink, 3);
        assert.equal(await fs.readlink(link), foreign);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("retirement keeps undecodable and valid sibling names with distinct bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-scratch-names-"));
    const tmp = await mkdtemp(join(root, "veriq-a-"));
    const undecodable = Buffer.concat([Buffer.from(`${tmp}/`), Buffer.from([255])]);
    try {
        const { id, work, allocation } = await scratchFixture(root, tmp);
        const valid = join(tmp, "�");
        await writeFile(undecodable, "undecodable name bytes");
        await writeFile(valid, "valid name bytes");
        const status = await retireScratch(root, root, { work, allocation }, unspawnedReceipt(id));
        assert.equal(status, "OWNERSHIP_UNCONFIRMED");
        assert.equal(await readFile(undecodable, "utf8"), "undecodable name bytes");
        assert.equal(await readFile(valid, "utf8"), "valid name bytes");
    } finally {
        try {
            await fs.unlink(undecodable);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }
});
