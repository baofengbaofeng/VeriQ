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
    const supervisor = new ExecutionSupervisor({ root, client } as ConstructorParameters<
        typeof ExecutionSupervisor
    >[0]);
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
    return { directory, bodies, supervisor, record, committed, stage };
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

for (const condition of ["owned", "replacement", "symlink", "unknown", "historical", "relocated"]) {
    test("scratch recovery verifies ownership and physical stop: " + condition, async () => {
        const root = await mkdtemp(join(tmpdir(), "vq-data-recover-"));
        const f = await fixture(root),
            id = randomUUID(),
            work = join(root, "work", id);
        const tmp = await mkdtemp(join(tmpdir(), "veriq-a-"));
        const outside = await mkdtemp(join(tmpdir(), "vq-data-other-"));
        try {
            await mkdir(work, { mode: 0o700, recursive: true });
            const modules = join(work, "node_modules");
            const allocation = await allocateScratch(work, tmp);
            const record = {
                ...f.record(id, condition === "unknown" ? "RUNNING" : "ALLOCATED"),
                work,
                ...(condition === "historical" ? {} : { allocation }),
            };
            const journal = join(f.directory, id + ".json");
            await writeFile(journal, JSON.stringify(record), { mode: 0o600 });
            await writeFile(join(tmp, "old-copy"), "synthetic old data");
            await writeFile(join(outside, "keep"), "belongs to another task");
            if (condition === "replacement" || condition === "symlink") {
                await fs.rename(work, work + "-old");
                if (condition === "replacement") await mkdir(work, { mode: 0o700 });
                else await symlink(outside, work);
            }
            if (condition === "relocated") await fs.rename(tmp, join(outside, "relocated"));
            await f.supervisor.recover();
            const persisted = JSON.parse(await readFile(journal, "utf8"));
            assert.equal(persisted.dataCleanup, condition === "unknown" ? "STOP_UNCONFIRMED" : "OWNERSHIP_UNCONFIRMED");
            if (condition === "owned") {
                assert.deepEqual((await readdir(tmp)).sort(), [
                    ".veriq-owner",
                    ".veriq-retired",
                    ".veriq-retirement-inventory",
                    "old-copy",
                ]);
                assert.equal(await readFile(join(tmp, "old-copy"), "utf8"), "");
                assert.deepEqual((await readdir(modules)).sort(), [".veriq-retired", ".veriq-retirement-inventory"]);
                await writeFile(join(tmp, "operator-copy"), "keep");
                await f.supervisor.recover();
                assert.equal(JSON.parse(await readFile(journal, "utf8")).dataCleanup, "OWNERSHIP_UNCONFIRMED");
                assert.equal(await readFile(join(tmp, "operator-copy"), "utf8"), "keep");
                assert((await lstat(work)).isDirectory());
            } else {
                const source = condition === "relocated" ? join(outside, "relocated") : tmp;
                assert.equal(await readFile(join(source, "old-copy"), "utf8"), "synthetic old data");
            }
            assert.equal(await readFile(join(outside, "keep"), "utf8"), "belongs to another task");
            assert(!JSON.stringify(persisted).includes("synthetic old data"));
        } finally {
            for (const dir of [tmp, outside, root]) await rm(dir, { recursive: true, force: true });
        }
    });
}

test("recovery verifies the original physical target of the operating system temporary alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-tmp-alias-")),
        id = randomUUID(),
        work = join(root, "work", id),
        alias = join(root, "os-tmp");
    try {
        await mkdir(work, { recursive: true });
        for (const name of ["original", "replacement"]) await mkdir(join(root, name));
        await symlink(join(root, "original"), alias, "junction");
        const tmp = await mkdtemp(join(alias, "veriq-a-"));
        const record = { work, allocation: await allocateScratch(work, tmp) };
        const stop = {
            attemptId: id,
            processStopped: true,
            processStopScope: "NO_PROCESS_SPAWNED" as const,
            reason: "NO_PROCESS_SPAWNED",
            stoppedAt: new Date().toISOString(),
        };
        await fs.unlink(alias);
        await symlink(join(root, "replacement"), alias, "junction");
        assert.equal(await retireScratch(root, alias, record, stop), "OWNERSHIP_UNCONFIRMED");
        assert((await lstat(join(work, "node_modules"))).isDirectory());
        await fs.unlink(alias);
        await symlink(join(root, "original"), alias, "junction");
        assert.equal(await retireScratch(root, alias, record, stop), "OWNERSHIP_UNCONFIRMED");
        assert.deepEqual((await readdir(tmp)).sort(), [
            ".veriq-owner",
            ".veriq-retired",
            ".veriq-retirement-inventory",
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

for (const layer of ["top", "nested"])
    test("destructive traversal preserves a replaced " + layer + " directory", async (context) => {
        const root = await mkdtemp(join(tmpdir(), "vq-boundary-"));
        const id = randomUUID(),
            work = join(root, "work", id),
            tmp = await mkdtemp(join(root, "veriq-a-"));
        try {
            await mkdir(work, { recursive: true });
            const allocation = await allocateScratch(work, tmp);
            const target = layer === "top" ? tmp : join(tmp, "nested");
            if (layer === "nested") await mkdir(target);
            await writeFile(join(target, "owned"), "owned");
            let swapped = false,
                enumerations = 0;
            const realReaddir = fs.readdir;
            context.mock.method(fs, "readdir", async (path: string, options: Parameters<typeof fs.readdir>[1]) => {
                if (!swapped && (await fs.realpath(path)) === target && ++enumerations === (layer === "top" ? 2 : 1)) {
                    await fs.rename(target, join(root, "relocated"));
                    await mkdir(target);
                    await writeFile(join(target, "foreign"), "keep");
                    swapped = true;
                }
                return realReaddir(path, options);
            });
            syncBuiltinESMExports();
            const result = await retireScratch(
                root,
                root,
                { work, allocation },
                {
                    attemptId: id,
                    processStopped: true,
                    processStopScope: "NO_PROCESS_SPAWNED",
                    reason: "NO_PROCESS_SPAWNED",
                    stoppedAt: new Date().toISOString(),
                },
            );
            assert(swapped);
            assert.equal(await readFile(join(target, "foreign"), "utf8"), "keep");
            assert.equal(await readFile(join(root, "relocated/owned"), "utf8"), "owned");
            assert.equal(result, "OWNERSHIP_UNCONFIRMED");
        } finally {
            context.mock.restoreAll();
            syncBuiltinESMExports();
            await rm(root, { recursive: true, force: true });
        }
    });

for (const targetType of ["file", "directory"]) {
    test("last name mutation cannot remove or overwrite a foreign " + targetType, async (context) => {
        const root = await mkdtemp(join(tmpdir(), "vq-last-operation-")),
            id = randomUUID(),
            work = join(root, "work", id),
            tmp = await mkdtemp(join(root, "veriq-a-"));
        try {
            await mkdir(work, { recursive: true });
            const allocation = await allocateScratch(work, tmp),
                target = join(tmp, "victim");
            if (targetType === "file") await writeFile(target, "old-data");
            else await mkdir(target);
            let swapped = false;
            const swap = async () => {
                await fs.rename(target, join(root, "old"));
                if (targetType === "file") await writeFile(target, "foreign");
                else await mkdir(target);
                swapped = true;
            };
            for (const method of ["unlink", "rmdir"] as const) {
                const original = fs[method];
                context.mock.method(fs, method, async (path: string) => {
                    if (!swapped && (await fs.realpath(path)) === target) await swap();
                    return original(path);
                });
            }
            const probe = await open(join(tmp, "fixture-fd"), "w"),
                proto = Object.getPrototypeOf(probe);
            await probe.close();
            const truncate = proto.truncate;
            context.mock.method(proto, "truncate", async function (this: typeof probe, size: number) {
                if (!swapped && targetType === "file" && (await fs.realpath("/proc/self/fd/" + this.fd)) === target)
                    await swap();
                return truncate.call(this, size);
            });
            syncBuiltinESMExports();
            const status = await retireScratch(
                root,
                root,
                { work, allocation },
                {
                    attemptId: id,
                    processStopped: true,
                    processStopScope: "NO_PROCESS_SPAWNED",
                    reason: "NO_PROCESS_SPAWNED",
                    stoppedAt: new Date().toISOString(),
                },
            );
            if (targetType === "directory") assert((await lstat(target)).isDirectory());
            else {
                assert(swapped);
                assert.equal(await readFile(target, "utf8"), "foreign");
                assert.equal(await readFile(join(root, "old"), "utf8"), "");
            }
            assert.equal(status, "OWNERSHIP_UNCONFIRMED");
        } finally {
            context.mock.restoreAll();
            syncBuiltinESMExports();
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("partial retirement preserves hardlinks, symlinks and later writes to an already retired member", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-partial-")),
        id = randomUUID();
    const work = join(root, "work", id),
        tmp = await mkdtemp(join(root, "veriq-a-"));
    try {
        await mkdir(work, { recursive: true });
        const allocation = await allocateScratch(work, tmp);
        const foreign = join(root, "outside"),
            owned = join(tmp, "owned");
        await writeFile(foreign, "external bytes");
        await fs.link(foreign, join(tmp, "hardlink"));
        await fs.symlink(foreign, join(tmp, "symlink"));
        await writeFile(owned, "original data");
        const stop = {
            attemptId: id,
            processStopped: true,
            processStopScope: "NO_PROCESS_SPAWNED" as const,
            reason: "NO_PROCESS_SPAWNED",
            stoppedAt: new Date().toISOString(),
        };
        assert.equal(await retireScratch(root, root, { work, allocation }, stop), "OWNERSHIP_UNCONFIRMED");
        assert.equal(await readFile(owned, "utf8"), "");
        await writeFile(owned, "later operator bytes");
        assert.equal(await retireScratch(root, root, { work, allocation }, stop), "OWNERSHIP_UNCONFIRMED");
        assert.equal(await readFile(owned, "utf8"), "later operator bytes");
        assert.equal(await readFile(foreign, "utf8"), "external bytes");
        assert.equal(await fs.readlink(join(tmp, "symlink")), foreign);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("undecodable and valid sibling names cannot alias a retirement proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "vq-name-proof-")),
        id = randomUUID();
    const work = join(root, "work", id),
        tmp = await mkdtemp(join(root, "veriq-a-"));
    try {
        await mkdir(work, { recursive: true });
        const allocation = await allocateScratch(work, tmp);
        const candidate = Buffer.concat([Buffer.from(tmp + "/"), Buffer.from([255])]);
        await writeFile(candidate, "preserve");
        await writeFile(join(tmp, "\uFFFD"), "different");
        const result = await retireScratch(
            root,
            root,
            { work, allocation },
            {
                attemptId: id,
                processStopped: true,
                processStopScope: "NO_PROCESS_SPAWNED",
                reason: "NO_PROCESS_SPAWNED",
                stoppedAt: new Date().toISOString(),
            },
        );
        assert.equal(result, "OWNERSHIP_UNCONFIRMED");
        assert.equal(await readFile(candidate, "utf8"), "preserve");
    } finally {
        await fs.unlink(Buffer.concat([Buffer.from(tmp + "/"), Buffer.from([255])])).catch(() => {});
        await rm(root, { recursive: true, force: true });
    }
});

test("separate retirement receipts cannot prove both mutable trees empty at the same time", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "vq-cross-root-"));
    const id = randomUUID(),
        work = join(root, "work", id),
        tmp = await mkdtemp(join(root, "veriq-a-"));
    try {
        await mkdir(work, { recursive: true });
        const allocation = await allocateScratch(work, tmp);
        const modules = join(work, "node_modules"),
            first = join(modules, "original"),
            second = join(tmp, "original");
        await writeFile(first, "known modules bytes");
        await writeFile(second, "known scratch bytes");
        const probe = await open(second, "r"),
            proto = Object.getPrototypeOf(probe),
            truncate = proto.truncate;
        await probe.close();
        context.mock.method(proto, "truncate", async function (this: typeof probe, size: number) {
            if ((await fs.realpath("/proc/self/fd/" + this.fd)) === second) {
                assert((await lstat(join(modules, ".veriq-retired"))).isFile());
                await writeFile(join(modules, "new-foreign-file"), "preserve these later bytes");
            }
            return truncate.call(this, size);
        });
        const result = await retireScratch(
            root,
            root,
            { work, allocation },
            {
                attemptId: id,
                processStopped: true,
                processStopScope: "NO_PROCESS_SPAWNED",
                reason: "NO_PROCESS_SPAWNED",
                stoppedAt: new Date().toISOString(),
            },
        );
        assert.equal(await readFile(first, "utf8"), "");
        assert.equal(await readFile(second, "utf8"), "");
        assert.equal(await readFile(join(modules, "new-foreign-file"), "utf8"), "preserve these later bytes");
        for (const dir of [modules, tmp])
            assert.equal(
                await readFile(join(dir, ".veriq-retired"), "utf8"),
                await readFile(join(dir, ".veriq-retirement-inventory"), "utf8"),
            );
        assert.equal(result, "OWNERSHIP_UNCONFIRMED");
    } finally {
        context.mock.restoreAll();
        await rm(root, { recursive: true, force: true });
    }
});
