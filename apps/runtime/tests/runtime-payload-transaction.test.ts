import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
    mkdtemp,
    rm,
    mkdir,
    writeFile,
    readdir,
    readFile,
    rename,
    unlink,
    open,
    type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveTransaction } from "../scripts/runtime-payload-transaction.ts";
import { ArchiveBudget, ArchiveScan } from "../scripts/runtime-payload-archive.ts";
import { ZipRanges } from "../scripts/runtime-payload-zip.ts";
import { RuntimePayloadError, type Ref } from "../scripts/runtime-payload-inputs.ts";
import { intakeRuntimeArchives } from "../scripts/runtime-payload-archive.ts";
import { fixture, hash } from "./fixtures/runtime-payload.ts";
import { archiveModel } from "./fixtures/runtime-payload-archives.ts";

for (const name of ["candidate", ".veriq-candidate.lock"])
    test(`existing ${name} remains untouched and blocks intake`, async () => {
        const output = await mkdtemp(join(tmpdir(), "veriq-transaction-"));
        try {
            await writeFile(join(output, name), "outside sentinel");
            await fixture(async (f) => {
                await assert.rejects(
                    intakeRuntimeArchives(await f.save(), f.expected, {
                        inputRoot: f.root,
                        outputParent: output,
                        candidateName: "candidate",
                    }),
                    (e: unknown) =>
                        e instanceof RuntimePayloadError && e.code === "PAYLOAD_DESTINATION_EXISTS",
                );
                assert.equal(await readFile(join(output, name), "utf8"), "outside sentinel");
                assert.deepEqual(await readdir(output), [name]);
            }, archiveModel());
        } finally {
            await rm(output, { recursive: true, force: true });
        }
    });
test("input/output root overlap rejects before scratch creation", async () =>
    fixture(async (f) => {
        const output = join(f.root, "nested-output");
        await mkdir(output, { mode: 0o700 });
        await assert.rejects(
            intakeRuntimeArchives(await f.save(), f.expected, {
                inputRoot: f.root,
                outputParent: output,
                candidateName: "candidate",
            }),
            (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_PATH",
        );
        assert.deepEqual(await readdir(output), []);
    }, archiveModel()));
test("pre-aborted signal and unsafe candidate never publish", async () => {
    const output = await mkdtemp(join(tmpdir(), "veriq-transaction-"));
    try {
        await fixture(async (f) => {
            const controller = new AbortController();
            controller.abort();
            await assert.rejects(
                intakeRuntimeArchives(await f.save(), f.expected, {
                    inputRoot: f.root,
                    outputParent: output,
                    candidateName: "candidate",
                    signal: controller.signal,
                }),
                (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_CANCELLED",
            );
            for (const candidateName of ["../outside", "/absolute", "é", "CON", "a".repeat(65)])
                await assert.rejects(
                    intakeRuntimeArchives(await f.save(), f.expected, {
                        inputRoot: f.root,
                        outputParent: output,
                        candidateName,
                    }),
                    (e: unknown) =>
                        e instanceof RuntimePayloadError &&
                        ["PAYLOAD_PATH", "PAYLOAD_LIMIT"].includes(e.code),
                );
            assert.deepEqual(await readdir(output), []);
        }, archiveModel());
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});
test("intake snapshots caller bytes expected options before first await", async () => {
    const output = await mkdtemp(join(tmpdir(), "veriq-transaction-"));
    try {
        await fixture(async (f) => {
            const bytes = await f.save(),
                expected = structuredClone(f.expected),
                options = { inputRoot: f.root, outputParent: output, candidateName: "candidate" };
            const pending = intakeRuntimeArchives(bytes, expected, options);
            bytes.fill(0);
            expected.target.arch = "arm64";
            options.candidateName = "changed";
            options.inputRoot = "/missing";
            const result = await pending;
            assert.equal(result.directory, join(output, "candidate"));
            assert.deepEqual(await readdir(output), ["candidate"]);
        }, archiveModel());
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});

/** 事务故障使用当前实现真实消费的内部原语注入明确失败，不提供生产测试分支或可覆盖预算选项；外部哨兵与输出目录的实际结果共同证明取消、磁盘、提交前后和归属替换语义，而不是只断言调用次数或源码文本。 */
for (const scenario of [
    "disk",
    "copy",
    "before-publish",
    "after-commit",
    "final-audit",
    "lock-replaced",
    "root-replaced",
    "source-replaced",
] as const)
    test(`transaction observable failure semantics: ${scenario}`, async (t) => {
        const output = await mkdtemp(join(tmpdir(), "veriq-transaction-fault-"));
        const controller = new AbortController();
        const originalPublish = ArchiveTransaction.prototype.publish,
            originalAudit = ArchiveTransaction.prototype.audit,
            originalSnapshot = ArchiveTransaction.prototype.snapshot,
            originalWrite = ArchiveTransaction.prototype.write;
        if (scenario === "disk")
            t.mock.method(
                ArchiveTransaction.prototype,
                "checkSpace",
                async function (this: ArchiveTransaction) {
                    this.fail("PAYLOAD_DISK_INSUFFICIENT");
                },
            );
        if (scenario === "copy")
            t.mock.method(
                ArchiveTransaction.prototype,
                "write",
                async function (
                    this: ArchiveTransaction,
                    path: string,
                    chunks: AsyncIterable<Uint8Array>,
                    expected?: Ref,
                ) {
                    const failing = async function* () {
                        for await (const chunk of chunks) {
                            yield chunk;
                            throw Object.assign(new Error("SYNTHETIC_COPY"), { code: "EIO" });
                        }
                    };
                    return originalWrite.call(this, path, failing(), expected);
                },
            );
        if (scenario === "before-publish")
            t.mock.method(
                ArchiveTransaction.prototype,
                "publish",
                async function (this: ArchiveTransaction) {
                    controller.abort();
                    return originalPublish.call(this);
                },
            );
        if (scenario === "after-commit" || scenario === "final-audit")
            t.mock.method(
                ArchiveTransaction.prototype,
                "audit",
                async function (this: ArchiveTransaction, root?: string) {
                    if (root) {
                        if (scenario === "after-commit") controller.abort();
                        else this.fail("PAYLOAD_SOURCE_CHANGED");
                    }
                    return originalAudit.call(this, root);
                },
            );
        if (scenario === "lock-replaced" || scenario === "root-replaced")
            t.mock.method(
                ArchiveTransaction.prototype,
                "publish",
                async function (this: ArchiveTransaction) {
                    if (scenario === "lock-replaced") {
                        await rename(this.lockPath, join(output, "owned-lock-preserved"));
                        await writeFile(this.lockPath, "outside sentinel");
                    } else {
                        await rename(this.scratch, join(output, "owned-root-preserved"));
                        await mkdir(this.scratch, { mode: 0o700 });
                        await writeFile(join(this.scratch, "sentinel"), "outside sentinel");
                    }
                    this.fail("PAYLOAD_CANCELLED");
                },
            );
        if (scenario === "source-replaced")
            t.mock.method(
                ArchiveTransaction.prototype,
                "snapshot",
                async function (this: ArchiveTransaction, ref: Ref, path: string) {
                    const full = join(this.inputRoot, ref.path),
                        body = await readFile(full);
                    await unlink(full);
                    await writeFile(full, body, { mode: 0o644 });
                    return originalSnapshot.call(this, ref, path);
                },
            );
        try {
            await fixture(async (f) => {
                const pending = intakeRuntimeArchives(await f.save(), f.expected, {
                    inputRoot: f.root,
                    outputParent: output,
                    candidateName: "candidate",
                    signal: controller.signal,
                });
                if (scenario === "after-commit") {
                    const result = await pending;
                    assert.equal(result.committed, true);
                    assert.equal(result.cleanup, "CONFIRMED");
                    assert.ok((await readdir(output)).includes("candidate"));
                } else {
                    const expected =
                        scenario === "disk"
                            ? "PAYLOAD_DISK_INSUFFICIENT"
                            : scenario === "copy"
                              ? "PAYLOAD_IO"
                              : scenario === "final-audit"
                                ? "PAYLOAD_COMMIT_UNCONFIRMED"
                                : scenario === "source-replaced"
                                  ? "PAYLOAD_SOURCE_CHANGED"
                                  : "PAYLOAD_CANCELLED";
                    await assert.rejects(
                        pending,
                        (e: unknown) =>
                            e instanceof RuntimePayloadError &&
                            e.code === expected &&
                            (["final-audit", "lock-replaced", "root-replaced"].includes(scenario)
                                ? e.cleanup === "INCOMPLETE"
                                : e.cleanup === "CONFIRMED"),
                    );
                    if (scenario === "final-audit")
                        assert.ok((await readdir(output)).includes("candidate"));
                    else if (scenario === "lock-replaced")
                        assert.equal(
                            await readFile(join(output, ".veriq-candidate.lock"), "utf8"),
                            "outside sentinel",
                        );
                    else if (scenario === "root-replaced") {
                        const scratch = (await readdir(output)).find(
                            (p) => p.startsWith(".veriq-candidate-") && !p.endsWith(".lock"),
                        )!;
                        assert.equal(
                            await readFile(join(output, scratch, "sentinel"), "utf8"),
                            "outside sentinel",
                        );
                    } else assert.deepEqual(await readdir(output), []);
                }
            }, archiveModel());
        } finally {
            t.mock.restoreAll();
            await rm(output, { recursive: true, force: true });
        }
    });

test("shared member link and body limits accumulate across archive admissions", () => {
    const budget = new ArchiveBudget();
    budget.add(39999, 1023, 16 * 1024 ** 3 - 1);
    budget.add(1, 1, 1);
    for (const values of [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
    ] as const)
        assert.throws(
            () => budget.add(values[0], values[1], values[2]),
            (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_LIMIT",
        );
    const ranges = new ZipRanges();
    ranges.add(0, 30, 40, 100);
    ranges.add(40, 70, 80, 100);
    for (const [start, data, end] of [
        [0, 30, 40],
        [20, 50, 60],
        [80, 90, 101],
        [80, 79, 90],
    ])
        assert.throws(
            () => ranges.add(start!, data!, end!, 100),
            (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_ARCHIVE_RANGE",
        );
});

/** prepare 通过真实 Node 子进程消费独立文件并输出完整结果，不执行夹具归档里的任何成员；严格 flags 与成功 JSON 分别观察 stdout、stderr 和退出码，所有输入在本测试临时根内，子进程只运行本仓库
* 构建工具代码。 */
test("prepare CLI consumes exactly five explicit flags and rejects malformed arguments", async () => {
    const output = await mkdtemp(join(tmpdir(), "veriq-prepare-cli-"));
    try {
        await fixture(async (f) => {
            const inputs = join(f.root, "inputs.json"),
                expected = join(f.root, "expected.json");
            await writeFile(inputs, await f.save());
            await writeFile(expected, JSON.stringify(f.expected));
            const flags = [
                "--inputs",
                inputs,
                "--expected",
                expected,
                "--input-root",
                f.root,
                "--output-parent",
                output,
                "--candidate",
                "candidate",
            ];
            const invoke = async (args: string[]) => {
                const child = spawn(
                    process.execPath,
                    ["--import", "tsx", "scripts/prepare-macos-runtime-archives.mjs", ...args],
                    { stdio: ["ignore", "pipe", "pipe"] },
                );
                let stdout = "",
                    stderr = "";
                child.stdout!.on("data", (v) => (stdout += v));
                child.stderr!.on("data", (v) => (stderr += v));
                const [code] = await once(child, "close");
                return { code, stdout, stderr };
            };
            for (const args of [
                flags.slice(0, -2),
                [...flags, "--unknown", "x"],
                [...flags, "--candidate", "again"],
                ["--inputs", "relative.json", ...flags.slice(2)],
            ]) {
                const result = await invoke(args);
                assert.equal(result.code, 1);
                assert.equal(result.stdout, "");
                assert.match(
                    result.stderr,
                    /^PAYLOAD_INPUT_INVALID phase=INPUTS cleanup=NOT_NEEDED\n$/,
                );
            }
            const result = await invoke(flags);
            assert.equal(result.code, 0);
            assert.equal(result.stderr, "");
            const report = JSON.parse(result.stdout);
            assert.equal(report.committed, true);
            assert.equal(report.directory, join(output, "candidate"));
            const warningFlags = [...flags.slice(0, -1), "warning"];
            const wrapper = `import {ArchiveTransaction} from './scripts/runtime-payload-transaction.ts';
import {rename,writeFile} from 'node:fs/promises';
const cleanup=ArchiveTransaction.prototype.cleanup;
ArchiveTransaction.prototype.cleanup=async function(){if(this.committed){await rename(this.lockPath,this.lockPath+'.` +
`preserved');await writeFile(this.lockPath,'outside sentinel')}return cleanup.call(this)};
process.argv=['node','prepare',...JSON.parse(process.env.VERIQ_TEST_FLAGS)];await import('./scripts/prepare-macos-ru` +
`ntime-archives.mjs');`;
            const warningChild = spawn(
                process.execPath,
                ["--import", "tsx", "--input-type=module", "-e", wrapper],
                {
                    env: { ...process.env, VERIQ_TEST_FLAGS: JSON.stringify(warningFlags) },
                    stdio: ["ignore", "pipe", "pipe"],
                },
            );
            let warningOut = "",
                warningErr = "";
            warningChild.stdout.on("data", (v) => (warningOut += v));
            warningChild.stderr.on("data", (v) => (warningErr += v));
            const [warningCode] = await once(warningChild, "close");
            assert.equal(warningCode, 0);
            assert.equal(JSON.parse(warningOut).cleanup, "INCOMPLETE");
            assert.equal(
                warningErr,
                "PAYLOAD_CLEANUP_INCOMPLETE phase=PUBLISH cleanup=INCOMPLETE\n",
            );
            assert.equal(
                await readFile(join(output, ".veriq-warning.lock"), "utf8"),
                "outside sentinel",
            );
        }, archiveModel());
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});

/** 信号测试只在隔离子进程暂停内部快照准入，不改变产品源码或为产品加入测试分支；父进程等待明确 IPC ready 后才发送实际 POSIX 信号，分别观察首信号清理、二次退出及五秒关闭期限，不靠固定启动延时猜测监听是否建立。 */
for (const scenario of ["SIGINT", "SIGTERM", "second", "deadline"] as const)
    test(`prepare actual signal lifecycle ${scenario}`, async () => {
        const output = await mkdtemp(join(tmpdir(), "veriq-prepare-signal-"));
        try {
            await fixture(async (f) => {
                const inputs = join(f.root, "inputs.json"),
                    expected = join(f.root, "expected.json");
                await writeFile(inputs, await f.save());
                await writeFile(expected, JSON.stringify(f.expected));
                const flags = [
                    "--inputs",
                    inputs,
                    "--expected",
                    expected,
                    "--input-root",
                    f.root,
                    "--output-parent",
                    output,
                    "--candidate",
                    "candidate",
                ];
                const script = `import {ArchiveTransaction} from './scripts/runtime-payload-transaction.ts';
const keepalive=()=>{};process.on('message',keepalive);
const original=ArchiveTransaction.prototype.snapshot;
ArchiveTransaction.prototype.snapshot=async function(...args){process.on('SIGINT',()=>process.send('first'));process` +
`.send('ready');await new Promise(resolve=>{` +
    `${
    scenario === "SIGINT" || scenario === "SIGTERM" ? "this.signal.addEventListener" +
        "('abort',resolve,{once:true})" : "process.on('message',()=>{})"}});return original.apply(this,args)};
process.argv=['node','prepare',...JSON.parse(process.env.VERIQ_TEST_FLAGS)];
await import('./scripts/prepare-macos-runtime-archives.mjs');process.removeListener('message',keepalive);process.dis` +
`connect();`;
                const child = spawn(
                    process.execPath,
                    ["--import", "tsx", "--input-type=module", "-e", script],
                    {
                        env: { ...process.env, VERIQ_TEST_FLAGS: JSON.stringify(flags) },
                        stdio: ["ignore", "pipe", "pipe", "ipc"],
                    },
                );
                let stdout = "",
                    stderr = "";
                child.stdout!.on("data", (v) => (stdout += v));
                child.stderr!.on("data", (v) => (stderr += v));
                const closed = once(child, "close");
                try {
                    await once(child, "message");
                    child.kill(scenario === "SIGTERM" ? "SIGTERM" : "SIGINT");
                    if (scenario === "second") {
                        await once(child, "message");
                        child.kill("SIGTERM");
                    }
                    const [code, signal] = await closed;
                    assert.equal(signal, null, stderr);
                    assert.equal(code, scenario === "SIGTERM" ? 143 : 130, stderr);
                    assert.equal(stdout, "");
                    assert.match(
                        stderr,
                        new RegExp(
                            `PAYLOAD_CANCELLED phase=INTAKE cleanup=` +
                                `${scenario === "second" || scenario === "deadline" ? "INCOMPLETE" : "CONFIRMED"}`,
                        ),
                    );
                    if (scenario === "SIGINT" || scenario === "SIGTERM")
                        assert.deepEqual(await readdir(output), []);
                    else
                        assert.ok(
                            (await readdir(output)).some((name) =>
                                name.startsWith(".veriq-candidate-"),
                            ),
                        );
                } finally {
                    if (child.exitCode === null) child.kill("SIGKILL");
                    await closed;
                }
            }, archiveModel());
        } finally {
            await rm(output, { recursive: true, force: true });
        }
    });

/** 关闭故障在真实 held FD 完成系统关闭后注入不可确认结果，产品仍必须保守保留 scratch 与锁而非假报清理成功；测试补丁只影响当前快照的第二个关闭调用，避免把前置 b1a reader 或测试 finally 本身变
* 成故障来源。 */
test("snapshot reader close failure retains owned artifact with incomplete cleanup", async (t) => {
    const output = await mkdtemp(join(tmpdir(), "veriq-close-failure-"));
    const probe = await open(join(output, "probe"), "wx", 0o600),
        prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    await unlink(join(output, "probe"));
    const createReadStream = prototype.createReadStream,
        snapshot = ArchiveTransaction.prototype.snapshot;
    let inject = false;
    t.mock.method(
        prototype,
        "createReadStream",
        function (this: FileHandle, options: Parameters<FileHandle["createReadStream"]>[0]) {
            if (inject) {
                inject = false;
                const close = this.close;
                t.mock.method(this, "close", async () => {
                    await close.call(this);
                    throw Object.assign(new Error("SYNTHETIC_CLOSE"), { code: "EIO" });
                });
            }
            return createReadStream.call(this, options);
        },
    );
    t.mock.method(
        ArchiveTransaction.prototype,
        "snapshot",
        async function (this: ArchiveTransaction, ref: Ref, destination: string) {
            inject = true;
            return snapshot.call(this, ref, destination);
        },
    );
    try {
        await fixture(async (f) => {
            await assert.rejects(
                intakeRuntimeArchives(await f.save(), f.expected, {
                    inputRoot: f.root,
                    outputParent: output,
                    candidateName: "candidate",
                }),
                (e: unknown) =>
                    e instanceof RuntimePayloadError &&
                    e.code === "PAYLOAD_IO" &&
                    e.cleanup === "INCOMPLETE",
            );
            assert.ok((await readdir(output)).includes(".veriq-candidate.lock"));
            assert.ok(!(await readdir(output)).includes("candidate"));
        }, archiveModel());
    } finally {
        t.mock.restoreAll();
        await rm(output, { recursive: true, force: true });
    }
});

/** 回执四 MiB 上限必须在扫描实际成员时消费，不能先提取数千文件再序列化出巨大 JSON 才拒绝；内部 collector 用真实空正文和合法长路径触发累计限制，不创建大型归档、正文或磁盘资源，路径与成员数仍严格低于各自独立上
* 限。 */
test("receipt member accumulation remains bounded before any extraction writes", async () => {
    const tx = new ArchiveTransaction("/unused-input", "/unused-output", "candidate"),
        scan = new ArchiveScan("node", "top", tx, new ArchiveBudget());
    const empty = async function* () {
        yield Buffer.alloc(0);
    };
    await assert.rejects(
        async () => {
            for (let i = 0; i < 5000; i++)
                await scan.entry(
                    {
                        path: `top/${"a".repeat(230)}/${"b".repeat(230)}/${"c".repeat(230)}/${"d".repeat(180)}${i}`,
                        kind: "file",
                        mode: 0o644,
                        size: 0,
                    },
                    empty(),
                );
        },
        (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_LIMIT",
    );
});

test("actual statfs plan rejects unavailable declared writes without allocating them", async () => {
    const output = await mkdtemp(join(tmpdir(), "veriq-disk-plan-"));
    try {
        await fixture(async (f) => {
            const tx = new ArchiveTransaction(f.root, output, "candidate");
            await tx.initialize();
            try {
                await assert.rejects(
                    tx.plan(16 * 1024 ** 3, 0),
                    (e: unknown) =>
                        e instanceof RuntimePayloadError && e.code === "PAYLOAD_DISK_INSUFFICIENT",
                );
            } finally {
                assert.equal(await tx.cleanup(), "CONFIRMED");
            }
            assert.deepEqual(await readdir(output), []);
        }, archiveModel());
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});

/** 两个实际 collector 顺序使用同一个已消费预算，第二份归档不能因切换格式或顶层名字重置空间；测试以真实一字节异步正文到达共享边界，另外推导父目录也会登记成员，避免只测预算类算术而漏掉扫描器调用接缝。 */
test("both archive collectors consume the same actual content and inferred-path budget", async () => {
    const tx = new ArchiveTransaction("/unused-input", "/unused-output", "candidate"),
        budget = new ArchiveBudget();
    budget.add(39995, 0, 16 * 1024 ** 3 - 1);
    const one = new ArchiveScan("node", "node", tx, budget),
        two = new ArchiveScan("chrome", "chrome", tx, budget);
    const body = async function* () {
        yield Buffer.from("x");
    };
    await one.entry({ path: "node/bin/file", kind: "file", size: 1, mode: 0o644 }, body());
    await assert.rejects(
        two.entry({ path: "chrome/file", kind: "file", size: 1, mode: 0o644 }, body()),
        (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_LIMIT",
    );
});

test("committed result remains successful when only replaced lock cleanup is incomplete", async (t) => {
    const output = await mkdtemp(join(tmpdir(), "veriq-commit-cleanup-")),
        cleanup = ArchiveTransaction.prototype.cleanup;
    t.mock.method(
        ArchiveTransaction.prototype,
        "cleanup",
        async function (this: ArchiveTransaction) {
            if (this.committed) {
                await rename(this.lockPath, join(output, "owned-lock"));
                await writeFile(this.lockPath, "outside sentinel");
            }
            return cleanup.call(this);
        },
    );
    try {
        await fixture(async (f) => {
            const result = await intakeRuntimeArchives(await f.save(), f.expected, {
                inputRoot: f.root,
                outputParent: output,
                candidateName: "candidate",
            });
            assert.equal(result.committed, true);
            assert.equal(result.cleanup, "INCOMPLETE");
            assert.equal(
                await readFile(join(output, ".veriq-candidate.lock"), "utf8"),
                "outside sentinel",
            );
            assert.equal(
                (await readFile(join(result.directory, "archive-intake.json"))).length > 0,
                true,
            );
        }, archiveModel());
    } finally {
        t.mock.restoreAll();
        await rm(output, { recursive: true, force: true });
    }
});

/** 提取故障只在实际树输出期间替换真实 FileHandle.write，避免快照复制先失败而漏过 tar 与 ZIP 适配器错误分支；次要 close 故障在完成真实关闭后注入不确认结果，首个磁盘错误及受控 errno 必须保留
* ，外部旧候选和源归档始终不变。 */
for (const [kind, code] of [
    ["node", "ENOSPC"],
    ["chrome", "EDQUOT"],
] as const)
    for (const uncertainClose of [false, true])
        test(`fix1 actual ${kind} extraction ${code} retains first cause with close uncertainty ${uncertainClose}`,
            async (t) => {
            const output = await mkdtemp(join(tmpdir(), "veriq-extraction-fault-"));
            const probe = await open(join(output, "probe"), "wx", 0o600),
                prototype = Object.getPrototypeOf(probe) as FileHandle;
            await probe.close();
            await unlink(join(output, "probe"));
            await mkdir(join(output, "old"), { mode: 0o700 });
            await writeFile(join(output, "old/sentinel"), "outside sentinel");
            const write = ArchiveTransaction.prototype.write;
            let faults = 0;
            t.mock.method(
                ArchiveTransaction.prototype,
                "write",
                async function (
                    this: ArchiveTransaction,
                    path: string,
                    chunks: AsyncIterable<Uint8Array>,
                    expected?: Ref,
                ) {
                    if (!path.startsWith(`trees/${kind}/`))
                        return write.call(this, path, chunks, expected);
                    const injected = t.mock.method(
                        prototype,
                        "write",
                        async function (this: FileHandle) {
                            faults++;
                            if (uncertainClose) {
                                const close = this.close;
                                t.mock.method(this, "close", async () => {
                                    await close.call(this);
                                    throw Object.assign(new Error("SYNTHETIC_CLOSE_DETAIL"), {
                                        code: "EIO",
                                    });
                                });
                            }
                            throw Object.assign(new Error("SYNTHETIC_WRITE_DETAIL"), { code });
                        },
                    );
                    try {
                        return await write.call(this, path, chunks, expected);
                    } finally {
                        injected.mock.restore();
                    }
                },
            );
            try {
                await fixture(async (f) => {
                    const bytes = await f.save();
                    await assert.rejects(
                        intakeRuntimeArchives(bytes, f.expected, {
                            inputRoot: f.root,
                            outputParent: output,
                            candidateName: "candidate",
                        }),
                        (e: unknown) => {
                            assert.ok(e instanceof RuntimePayloadError);
                            assert.equal(e.code, "PAYLOAD_DISK_INSUFFICIENT");
                            assert.equal(e.causeCode, code);
                            assert.equal(e.phase, "INTAKE");
                            assert.equal(e.cleanup, uncertainClose ? "INCOMPLETE" : "CONFIRMED");
                            assert.equal(e.message, "PAYLOAD_DISK_INSUFFICIENT");
                            assert.ok(Object.isFrozen(e));
                            return true;
                        },
                    );
                    assert.equal(faults, 1);
                    assert.equal(
                        await readFile(join(output, "old/sentinel"), "utf8"),
                        "outside sentinel",
                    );
                    for (const archive of ["node", "chrome"] as const)
                        assert.equal(
                            hash(await readFile(join(f.root, f.recipe[archive].file.path))),
                            f.recipe[archive].file.sha256,
                        );
                    const names = await readdir(output);
                    assert.ok(!names.includes("candidate"));
                    if (uncertainClose) assert.ok(names.includes(".veriq-candidate.lock"));
                    else assert.deepEqual(names, ["old"]);
                }, archiveModel());
            } finally {
                t.mock.restoreAll();
                await rm(output, { recursive: true, force: true });
            }
        });

/** 目录错误回归只在真实 intake 的新 Node 顶层目录句柄上注入 chmod 或 sync 磁盘故障，close 始终先真实完成再按场景报告 EIO；外部旧目录和原归档保持不变，测试不模拟永久内核 writer 或实际写
* 满文件系统。 */
for (const [operation, cause] of [
    ["chmod", "ENOSPC"],
    ["sync", "EDQUOT"],
] as const)
    for (const uncertainClose of [false, true])
        test(`R1 intake directory ${operation} preserves ${cause} with uncertain close ${uncertainClose}`, async (
            t) => {
            const output = await mkdtemp(join(tmpdir(), "veriq-directory-intake-"));
            const probe = await open(join(output, "probe"), "wx", 0o600),
                prototype = Object.getPrototypeOf(probe) as FileHandle;
            await probe.close();
            await unlink(join(output, "probe"));
            await mkdir(join(output, "old"));
            await writeFile(join(output, "old/sentinel"), "outside sentinel");
            const value = archiveModel(),
                target = `trees/node/${value.recipe.node.topDirectory}`,
                mkdirOwned = ArchiveTransaction.prototype.mkdir;
            let realClosed = 0,
                faulted = false;
            t.mock.method(
                ArchiveTransaction.prototype,
                "mkdir",
                async function (this: ArchiveTransaction, path: string) {
                    if (this.profile !== "intake" || path !== target || faulted)
                        return mkdirOwned.call(this, path);
                    const injected = t.mock.method(
                        prototype,
                        operation,
                        async function (this: FileHandle) {
                            assert.equal((await this.stat()).isDirectory(), true);
                            faulted = true;
                            const close = this.close;
                            t.mock.method(this, "close", async () => {
                                await close.call(this);
                                realClosed++;
                                if (uncertainClose)
                                    throw Object.assign(new Error("secondary directory close"), {
                                        code: "EIO",
                                    });
                            });
                            throw Object.assign(new Error("primary directory operation"), {
                                code: cause,
                            });
                        },
                    );
                    try {
                        return await mkdirOwned.call(this, path);
                    } finally {
                        injected.mock.restore();
                    }
                },
            );
            try {
                await fixture(async (f) => {
                    await assert.rejects(
                        intakeRuntimeArchives(await f.save(), f.expected, {
                            inputRoot: f.root,
                            outputParent: output,
                            candidateName: "candidate",
                        }),
                        (error: unknown) => {
                            assert.ok(error instanceof RuntimePayloadError);
                            assert.equal(error.code, "PAYLOAD_DISK_INSUFFICIENT");
                            assert.equal(error.causeCode, cause);
                            assert.equal(error.phase, "INTAKE");
                            assert.equal(
                                error.cleanup,
                                uncertainClose ? "INCOMPLETE" : "CONFIRMED",
                            );
                            return true;
                        },
                    );
                    assert.equal(realClosed, 1);
                    assert.equal(
                        await readFile(join(output, "old/sentinel"), "utf8"),
                        "outside sentinel",
                    );
                    for (const kind of ["node", "chrome"] as const)
                        assert.equal(
                            hash(await readFile(join(f.root, f.recipe[kind].file.path))),
                            f.recipe[kind].file.sha256,
                        );
                    const names = await readdir(output);
                    assert.equal(names.includes("candidate"), false);
                    if (uncertainClose) assert.ok(names.includes(".veriq-candidate.lock"));
                    else assert.deepEqual(names, ["old"]);
                }, value);
            } finally {
                t.mock.restoreAll();
                await rm(output, { recursive: true, force: true });
            }
        });

/** 没有 chmod 或 sync 首错时，唯一关闭异常仍必须抛出并记录 INCOMPLETE，不能因为新增首错保护而吞掉真实收尾问题；两个 profile 都在初始化完成后写微型真实目录，先真实关闭句柄再注入 EIO，仅清理本场
* 景独占根。 */
for (const profile of ["intake", "runtime"] as const)
    test(`R1 directory close-only ${profile} remains observable and incomplete`, async (t) => {
        const output = await mkdtemp(join(tmpdir(), "veriq-directory-close-only-"));
        const probe = await open(join(output, "probe"), "wx", 0o600),
            prototype = Object.getPrototypeOf(probe) as FileHandle;
        await probe.close();
        await unlink(join(output, "probe"));
        let realClosed = 0;
        try {
            await fixture(async (f) => {
                const tx = new ArchiveTransaction(f.root, output, "candidate", undefined, profile);
                try {
                    await tx.initialize();
                    const sync = prototype.sync;
                    t.mock.method(prototype, "sync", async function (this: FileHandle) {
                        await sync.call(this);
                        assert.equal((await this.stat()).isDirectory(), true);
                        const close = this.close;
                        t.mock.method(this, "close", async () => {
                            await close.call(this);
                            realClosed++;
                            throw Object.assign(new Error("only directory close"), { code: "EIO" });
                        });
                    });
                    await assert.rejects(
                        tx.mkdir(profile === "runtime" ? "runtime/probe" : "trees/node/probe"),
                        { code: "EIO" },
                    );
                    assert.equal(realClosed, 1);
                } finally {
                    t.mock.restoreAll();
                    assert.equal(await tx.cleanup(), "INCOMPLETE");
                }
            }, archiveModel());
        } finally {
            t.mock.restoreAll();
            await rm(output, { recursive: true, force: true });
        }
    });

/** 新的来源入口只登记有限普通 Ref 并复用旧观察集合，私有六百文件须能真实快照而无需 chmod；异步等待后修改调用数组不得改变已复制声明，重复路径和过量引用必须在读取前直接失败关闭。 */
test("observeRefs accepts private source and snapshots original bytes", async () => {
    const base = await mkdtemp(join(tmpdir(), "veriq-refs-")),
        input = join(base, "input"),
        output = join(base, "output");
    await mkdir(input, { mode: 0o700 });
    await mkdir(output, { mode: 0o700 });
    const content = Buffer.from("private source evidence");
    await writeFile(join(input, "source.json"), content, { mode: 0o600 });
    const tx = new ArchiveTransaction(input, output, "refs");
    try {
        await tx.initialize();
        await tx.observeRefs([
            { path: "source.json", sizeBytes: content.length, sha256: hash(content) },
        ]);
        await tx.snapshot(
            { path: "source.json", sizeBytes: content.length, sha256: hash(content) },
            "evidence/source.json",
        );
        await tx.finishSources();
        await tx.audit();
        assert.deepEqual(await readFile(join(tx.scratch, "evidence/source.json")), content);
    } finally {
        await tx.cleanup();
        await rm(base, { recursive: true, force: true });
    }
});

/** 有限 Ref 的权限和声明边界只作用于新入口，测试逐项使用真实普通文件、链接及重复声明观察拒绝；旧五树场景继续由同文件既有完整回归覆盖，新入口不会降低 snapshot 的真实摘要要求或增加权限修复操作。 */
for (const scenario of [
    "400",
    "444",
    "644",
    "mode",
    "hardlink",
    "symlink",
    "size",
    "duplicate",
    "count",
    "unknown",
    "hash",
    "parent",
] as const)
    test(`bounded observeRefs ${scenario}`, async () => {
        const base = await mkdtemp(join(tmpdir(), "veriq-bounded-refs-")),
            input = join(base, "input"),
            output = join(base, "output");
        await mkdir(input, { mode: 0o700 });
        await mkdir(output, { mode: 0o700 });
        await mkdir(join(input, "nested"), { mode: 0o700 });
        const bytes = Buffer.from("bounded source");
        await writeFile(join(input, "nested/file"), bytes, { mode: 0o600 });
        const { chmod, link, symlink } = await import("node:fs/promises");
        if (["400", "444", "644", "mode"].includes(scenario))
            await chmod(
                join(input, "nested/file"),
                scenario === "mode" ? 0o755 : parseInt(scenario, 8),
            );
        if (scenario === "hardlink") await link(join(input, "nested/file"), join(input, "other"));
        if (scenario === "symlink") {
            await unlink(join(input, "nested/file"));
            await symlink("../other", join(input, "nested/file"));
        }
        const tx = new ArchiveTransaction(input, output, "bounded");
        try {
            await tx.initialize();
            const ref = { path: "nested/file", sizeBytes: bytes.length, sha256: hash(bytes) };
            if (scenario === "size") ref.sizeBytes++;
            if (scenario === "hash") ref.sha256 = "0".repeat(64);
            let refs: readonly Ref[] = [ref];
            if (scenario === "duplicate") refs = [ref, ref];
            if (scenario === "count")
                refs = Array.from({ length: 9 }, (_, i) => ({ ...ref, path: `file${i}` }));
            if (scenario === "unknown") refs = [{ ...ref, extra: true } as Ref];
            if (
                ["mode", "hardlink", "symlink", "size", "duplicate", "count", "unknown"].includes(
                    scenario,
                )
            )
                await assert.rejects(tx.observeRefs(refs));
            else {
                await tx.observeRefs(refs);
                if (scenario === "hash")
                    await assert.rejects(tx.snapshot(ref, "snapshots/source"), {
                        code: "PAYLOAD_SOURCE_CHANGED",
                    });
                else if (scenario === "parent") {
                    await rename(join(input, "nested"), join(input, "moved"));
                    await mkdir(join(input, "nested"), { mode: 0o700 });
                    await assert.rejects(tx.finishSources(), { code: "PAYLOAD_SOURCE_CHANGED" });
                } else {
                    await tx.snapshot(ref, "snapshots/source");
                    await tx.finishSources();
                    await tx.audit();
                }
            }
        } finally {
            await tx.cleanup();
            await rm(base, { recursive: true, force: true });
        }
    });
