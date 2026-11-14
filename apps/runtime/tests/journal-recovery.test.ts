import { test } from "node:test";
import assert from "node:assert/strict";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    open,
    readFile,
    readdir,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ExecutionSupervisor } from "../src/execution/supervisor.ts";
import { ProcessSupervisor } from "../src/execution/processes.ts";
import { ProcessRecords } from "../src/execution/records.ts";
import type { AgentClient } from "../src/agent/transport.ts";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";

/** 恢复夹具把正式日志和未发布临时对象真实写入同一私有目录，transport只记录对账声明；进程存在时仍由真实原生守护排空，任何临时成员都不能自行提供停止成功或未派生证明。 */
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
    test(`interrupted journal staging quarantines only its attempt and preserves other recovery: ${bytes}`, async () => {
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
            assert.equal(
                receipts.find((item) => item.attemptId === affected)?.processStopped,
                false,
            );
            assert.equal(
                receipts.find((item) => item.attemptId === affected)?.processStopScope,
                undefined,
            );
            assert.equal(
                receipts.find((item) => item.attemptId === healthy)?.processStopScope,
                "FULL_DESCENDANT_TREE",
            );
            assert.equal(await processes.isRunning(worker.pid), false);
            assert.equal(f.bodies.length, 2);
            assert.deepEqual(await readFile(staged), before);
            const strict = await ProcessRecords.open(f.directory);
            assert(strict);
            try {
                await assert.rejects(strict.names(4096), /PROCESS_RECORD_NAME_INVALID/);
                await assert.rejects(
                    strict.read(staged.split("/").at(-1)!, 65536),
                    /PROCESS_RECORD_NAME_INVALID/,
                );
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
        assert.equal(
            receipts.find((item) => item.attemptId === orphan)?.reason,
            "JOURNAL_STAGING_UNCONFIRMED",
        );
        assert.equal(
            receipts.find((item) => item.attemptId === healthy)?.processStopScope,
            "NO_PROCESS_SPAWNED",
        );
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
        const script = `import {open} from 'node:fs/promises';import {ExecutionSupervisor} from './src/execution/supervisor.ts';const root=process.argv[1],record=JSON.parse(process.argv[2]),handle=await open(root,'r'),prototype=Object.getPrototypeOf(handle),sync=prototype.sync;await handle.close();prototype.sync=async function(){await sync.call(this);if((await this.stat()).isFile())process.exit(0);};const supervisor=new ExecutionSupervisor({root,client:{}});await supervisor.journal(record);throw new Error('INTERRUPTION_NOT_REACHED');`;
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
        assert.equal(
            JSON.parse(await readFile(join(f.directory, stages[0]!), "utf8")).state,
            "SPAWNING",
        );
        const receipts = await f.supervisor.recover();
        assert.equal(
            receipts.find((receipt) => receipt.attemptId === affected)?.processStopped,
            false,
        );
        assert.equal(
            receipts.find((receipt) => receipt.attemptId === affected)?.processStopScope,
            undefined,
        );
        assert.equal(
            receipts.find((receipt) => receipt.attemptId === healthy)?.processStopScope,
            "NO_PROCESS_SPAWNED",
        );
        assert.equal(f.bodies.length, 2);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

for (const invalid of [
    "unknown",
    "malformed-name",
    "link",
    "mode",
    "oversize",
    "malformed-committed",
]) {
    test(`journal staging does not relax private and malformed member rejection: ${invalid}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vq-journal-invalid-")),
            id = randomUUID();
        const f = await fixture(root);
        try {
            await f.committed(id);
            if (invalid === "unknown")
                await writeFile(join(f.directory, "unknown.tmp"), "{}", { mode: 0o600 });
            if (invalid === "malformed-name")
                await writeFile(join(f.directory, `${id}.json.not-a-uuid`), "{}", { mode: 0o600 });
            if (invalid === "link")
                await symlink(
                    join(f.directory, `${id}.json`),
                    join(f.directory, `${id}.json.${randomUUID()}`),
                );
            if (invalid === "mode") await chmod(await f.stage(id), 0o644);
            if (invalid === "oversize") await f.stage(id, "x".repeat(65537));
            if (invalid === "malformed-committed")
                await writeFile(join(f.directory, `${id}.json`), "{");
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
                        if (
                            String(path).includes(".json.") &&
                            !String(path).endsWith(older.split("/").at(-1)!)
                        ) {
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
                    ["EISDIR", "ENOTDIR", "EEXIST"].includes(
                        (error as NodeJS.ErrnoException).code ?? "",
                    ),
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
