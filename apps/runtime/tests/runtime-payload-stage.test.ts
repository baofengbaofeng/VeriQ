import assert from "node:assert/strict";
import test from "node:test";
import { once as event } from "node:events";
import { mkdtemp, readFile, readdir, lstat, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
    stageMacRuntimePayload,
    assertPayloadEvidenceBudget,
} from "../scripts/runtime-payload-stage.ts";
import type { Ref } from "../scripts/runtime-payload-inputs.ts";
import { verifyMacRuntimeManifestV2 } from "../src/distribution-manifest-v2.ts";
import { fixture, hash } from "./fixtures/runtime-payload.ts";
import { stageModel, rehashStageNpm } from "./fixtures/runtime-payload-stage.ts";

for (const arch of ["x64", "arm64"] as const)
    test(`complete ${arch} candidate verifies actual final path with independent roles and licenses`, async () => {
        const output = await mkdtemp(join(tmpdir(), "veriq-stage-"));
        try {
            await fixture(
                async (f) => {
                    const result = await stageMacRuntimePayload(await f.save(), f.expected, {
                        inputRoot: f.root,
                        outputParent: output,
                        candidateName: "a".repeat(64),
                    });
                    assert.equal(result.committed, true);
                    assert.equal(result.cleanup, "CONFIRMED");
                    assert.equal(result.inventory.root, result.runtimeDirectory);
                    assert.ok(Object.isFrozen(result.inventory.manifest.files));
                    const inventory = await verifyMacRuntimeManifestV2(result.runtimeDirectory, {
                        arch,
                        layout: f.chromeLayout.layout,
                    });
                    assert.equal(inventory.manifestSha256, result.inventory.manifestSha256);
                    const receiptBytes = await readFile(
                        join(result.candidateDirectory, "payload-receipt.json"),
                    );
                    assert.equal(hash(receiptBytes), result.receiptSha256);
                    const receipt = JSON.parse(receiptBytes.toString());
                    assert.equal(receipt.status, "DEVELOPMENT_UNSIGNED_STATIC");
                    for (const descriptor of [
                        "inputs.json",
                        "expected.json",
                        "archive-intake.json",
                    ]) {
                        const ref = receipt.inputReceipts.find(
                            (file: { path: string }) =>
                                file.path === `input-evidence/${descriptor}`,
                        );
                        assert.ok(ref);
                        assert.equal(
                            hash(await readFile(join(result.candidateDirectory, ref.path))),
                            ref.sha256,
                        );
                    }
                    assert.equal(receipt.files.length, inventory.regularFileCount + 1);
                    for (const [kind, prefix] of [
                        ["entries", "entry/"],
                        ["execution", "execution/"],
                        ["dependencies", ""],
                        ["native", "native/"],
                        ["engine", `engines/${f.recipe.target.engineVersion}/`],
                    ] as const)
                        for (const fact of f.inventories[kind].files) {
                            if (
                                kind === "dependencies" &&
                                f.graph.bins.some((bin) => bin.sourceAlias === fact.path)
                            )
                                continue;
                            assert.equal(
                                hash(
                                    await readFile(
                                        join(result.runtimeDirectory, prefix + fact.path),
                                    ),
                                ),
                                fact.sha256,
                            );
                        }
                    assert.equal(
                        await readFile(
                            join(result.runtimeDirectory, "licenses/node/LICENSE"),
                            "utf8",
                        ),
                        "synthetic Node license",
                    );
                    assert.equal(
                        await readFile(
                            join(
                                result.runtimeDirectory,
                                `browser/${f.recipe.chrome.topDirectory}/LICENSE`,
                            ),
                            "utf8",
                        ),
                        "synthetic browser license",
                    );
                    const identities = [];
                    for (const [role, name] of [
                        ["agent", "veriq_agent"],
                        ["cli", "veriq_cli"],
                        ["runner", "veriq_runner"],
                    ]) {
                        const stat = await lstat(
                            join(result.runtimeDirectory, `roles/${role}/${name}`),
                        );
                        assert.equal(stat.nlink, 1);
                        assert.equal(stat.mode & 0o777, 0o755);
                        identities.push(stat.ino);
                    }
                    assert.equal(new Set(identities).size, 3);
                    assert.deepEqual((await readdir(result.candidateDirectory)).sort(), [
                        "input-evidence",
                        "payload-receipt.json",
                        "runtime",
                    ]);
                    assert.deepEqual(await readdir(output), ["a".repeat(64)]);
                },
                await stageModel(arch),
            );
        } finally {
            await rm(output, { recursive: true, force: true });
        }
    });

for (const arch of ["x64", "arm64"] as const)
    test(`actual five-flag ${arch} stage CLI produces complete final candidate JSON`, async () => {
        const { execFileSync } = await import("node:child_process");
        const { writeFile } = await import("node:fs/promises");
        const output = await mkdtemp(join(tmpdir(), "veriq-stage-cli-"));
        try {
            await fixture(
                async (f) => {
                    const inputs = join(output, "inputs.json"),
                        expected = join(output, "expected.json");
                    await writeFile(inputs, await f.save(), { mode: 0o644 });
                    await writeFile(expected, JSON.stringify(f.expected), { mode: 0o644 });
                    const stdout = execFileSync(
                        process.execPath,
                        [
                            "--import",
                            "tsx",
                            "scripts/stage-macos-runtime.mjs",
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
                        ],
                        { encoding: "utf8", maxBuffer: 1024 ** 2 },
                    );
                    const result = JSON.parse(stdout);
                    assert.equal(result.inventory.root, join(output, "candidate/runtime"));
                    assert.equal(result.inventory.arch, arch);
                    assert.equal(result.cleanup, "CONFIRMED");
                    const inventory = await verifyMacRuntimeManifestV2(result.runtimeDirectory, {
                        arch,
                        layout: f.chromeLayout.layout,
                    });
                    assert.equal(inventory.manifestSha256, result.inventory.manifestSha256);
                },
                await stageModel(arch),
            );
        } finally {
            await rm(output, { recursive: true, force: true });
        }
    });

// 每份模式反例仍先经过真实 I 提取，只有 S 消费者拒绝缺少明确 Unix 类型权限的 ZIP；测试只改公开 central 属性并同步绑定归档与独立布局摘要，不把 I 当前可接受的 fallback 模式假称为原始权限证据。
for (const mode of ["DOS", "ZERO"] as const)
    test(`S rejects ${mode} ZIP mode metadata even though fresh intake accepts fallback`, async () => {
        const { zipBytes, tarBytes } = await import("./fixtures/runtime-payload-archives.ts");
        const { intakeRuntimeArchives } = await import("../scripts/runtime-payload-archive.ts");
        const value = await stageModel();
        value.chromeEntries.splice(1, 3);
        value.chromeLayout.layout.allowedLinks = [];
        value.chromeLayout.layout.frameworkRoots = [];
        const zip = zipBytes(value.chromeEntries);
        for (let offset = 0; offset + 46 <= zip.length; offset++)
            if (zip.readUInt32LE(offset) === 0x02014b50) {
                if (mode === "DOS") zip[offset + 5] = 0;
                zip.writeUInt32LE(0, offset + 38);
            }
        value.bind(tarBytes(value.nodeEntries), zip);
        const output = await mkdtemp(join(tmpdir(), "veriq-zip-mode-"));
        try {
            await fixture(async (f) => {
                await intakeRuntimeArchives(await f.save(), f.expected, {
                    inputRoot: f.root,
                    outputParent: output,
                    candidateName: "intake",
                });
                await assert.rejects(
                    stageMacRuntimePayload(await f.save(), f.expected, {
                        inputRoot: f.root,
                        outputParent: output,
                        candidateName: "candidate",
                    }),
                    { code: "PAYLOAD_ARCHIVE_UNSUPPORTED" },
                );
                assert.deepEqual(await readdir(output), ["intake"]);
            }, value);
        } finally {
            await rm(output, { recursive: true, force: true });
        }
    });

// 子 I 的未知写入或关闭事实必须粘住整个 work 父目录，外层独立 final 清理成功也不能擦掉 sentinel；故障发生在实际子事务 initialize 之后，确保测试观察的不是尚未创建工作目录的纯参数拒绝。
for (const outcome of [
    "COMMIT_UNCONFIRMED",
    "THROW_INCOMPLETE",
    "RETURN_INCOMPLETE",
    "UNKNOWN",
] as const)
    test(`nested intake ${outcome} retains work parent and reports incomplete`, async (t) => {
        const { ArchiveTransaction } = await import("../scripts/runtime-payload-transaction.ts");
        const { RuntimePayloadError } = await import("../scripts/runtime-payload-inputs.ts");
        const { writeFile, access } = await import("node:fs/promises");
        const output = await mkdtemp(join(tmpdir(), "veriq-nested-"));
        const initialize = ArchiveTransaction.prototype.initialize,
            publish = ArchiveTransaction.prototype.publish;
        let child = "";
        if (outcome === "RETURN_INCOMPLETE")
            t.mock.method(
                ArchiveTransaction.prototype,
                "publish",
                async function (this: InstanceType<typeof ArchiveTransaction>) {
                    const result = await publish.call(this);
                    if (this.profile === "intake") {
                        child = this.directory;
                        await writeFile(join(child, "sentinel"), "unknown child writer");
                        return "INCOMPLETE" as const;
                    }
                    return result;
                },
            );
        else
            t.mock.method(
                ArchiveTransaction.prototype,
                "initialize",
                async function (this: InstanceType<typeof ArchiveTransaction>) {
                    await initialize.call(this);
                    if (this.profile === "intake") {
                        child = this.scratch;
                        await writeFile(join(child, "sentinel"), "unknown child writer");
                        this.noteCloseFailure();
                        if (outcome === "UNKNOWN") throw new Error("synthetic unknown child fault");
                        throw new RuntimePayloadError(
                            outcome === "COMMIT_UNCONFIRMED"
                                ? "PAYLOAD_COMMIT_UNCONFIRMED"
                                : "PAYLOAD_IO",
                            null,
                            "INCOMPLETE",
                            { phase: "INTAKE", candidateDirectory: this.directory },
                        );
                    }
                },
            );
        try {
            await fixture(
                async (f) => {
                    await assert.rejects(
                        stageMacRuntimePayload(await f.save(), f.expected, {
                            inputRoot: f.root,
                            outputParent: output,
                            candidateName: "candidate",
                        }),
                        (error: unknown) => {
                            assert.ok(error instanceof RuntimePayloadError);
                            assert.equal(error.cleanup, "INCOMPLETE");
                            return true;
                        },
                    );
                    assert.equal(
                        await readFile(join(child, "sentinel"), "utf8"),
                        "unknown child writer",
                    );
                    await access(dirname(dirname(child)));
                    await assert.rejects(access(join(output, "candidate")));
                    assert.ok(
                        (await readdir(output)).some((name) => name.startsWith(".veriq-s-work-")),
                    );
                },
                await stageModel(),
            );
        } finally {
            t.mock.restoreAll();
            await rm(output, { recursive: true, force: true });
        }
    });

// 磁盘故障发生在 S 真正写入角色文件时才替换 FileHandle.write，I 快照和归档提取均保持正常；次要 close 失败在真实关闭后注入不确认结果，第一 ENOSPC 或 EDQUOT 必须保留，工作事务正常收尾不能抹掉 final 的不确定状态。
for (const errno of ["ENOSPC", "EDQUOT"])
    for (const uncertain of [false, true])
        test(`actual S stream ${errno} retains first error with uncertain close ${uncertain}`, async (t) => {
            const { ArchiveTransaction } = await import(
                "../scripts/runtime-payload-transaction.ts"
            );
            const { RuntimePayloadError } = await import("../scripts/runtime-payload-inputs.ts");
            const { open, unlink, mkdir, writeFile } = await import("node:fs/promises");
            type Handle = import("node:fs/promises").FileHandle;
            const output = await mkdtemp(join(tmpdir(), "veriq-stage-write-"));
            const probe = await open(join(output, "probe"), "wx", 0o600),
                prototype = Object.getPrototypeOf(probe) as Handle;
            await probe.close();
            await unlink(join(output, "probe"));
            await mkdir(join(output, "old"));
            await writeFile(join(output, "old/sentinel"), "outside sentinel");
            const write = ArchiveTransaction.prototype.write;
            let faults = 0;
            t.mock.method(
                ArchiveTransaction.prototype,
                "write",
                async function (
                    this: InstanceType<typeof ArchiveTransaction>,
                    path: string,
                    chunks: AsyncIterable<Uint8Array>,
                    ref?: import("../scripts/runtime-payload-inputs.ts").Ref,
                    mode?: number,
                ) {
                    if (this.profile !== "runtime" || !path.startsWith("runtime/roles/"))
                        return write.call(this, path, chunks, ref, mode);
                    const injected = t.mock.method(
                        prototype,
                        "write",
                        async function (this: Handle) {
                            faults++;
                            if (uncertain) {
                                const close = this.close;
                                t.mock.method(this, "close", async () => {
                                    await close.call(this);
                                    throw Object.assign(new Error("secondary synthetic close"), {
                                        code: "EIO",
                                    });
                                });
                            }
                            throw Object.assign(new Error("synthetic stream write"), {
                                code: errno,
                            });
                        },
                    );
                    try {
                        return await write.call(this, path, chunks, ref, mode);
                    } finally {
                        injected.mock.restore();
                    }
                },
            );
            try {
                await fixture(
                    async (f) => {
                        const nodeHash = hash(
                            await readFile(join(f.root, f.recipe.node.file.path)),
                        );
                        await assert.rejects(
                            stageMacRuntimePayload(await f.save(), f.expected, {
                                inputRoot: f.root,
                                outputParent: output,
                                candidateName: "candidate",
                            }),
                            (error: unknown) => {
                                assert.ok(error instanceof RuntimePayloadError);
                                assert.equal(error.code, "PAYLOAD_DISK_INSUFFICIENT");
                                assert.equal(error.causeCode, errno);
                                assert.equal(error.phase, "COPY");
                                assert.equal(error.cleanup, uncertain ? "INCOMPLETE" : "CONFIRMED");
                                return true;
                            },
                        );
                        assert.equal(faults, 1);
                        assert.equal(
                            hash(await readFile(join(f.root, f.recipe.node.file.path))),
                            nodeHash,
                        );
                        assert.equal(
                            await readFile(join(output, "old/sentinel"), "utf8"),
                            "outside sentinel",
                        );
                        const entries = await readdir(output);
                        assert.equal(entries.includes("candidate"), false);
                        assert.equal(
                            entries.some((entry) => entry.startsWith(".veriq-s-work-")),
                            false,
                        );
                        assert.equal(
                            entries.some((entry) => entry.startsWith(".veriq-candidate-")),
                            uncertain,
                        );
                    },
                    await stageModel(),
                );
            } finally {
                t.mock.restoreAll();
                await rm(output, { recursive: true, force: true });
            }
        });

// 最终路径的 D3a 必须真正再读文件，不能只沿用 scratch 库存或把 root 字段改名；在 rename 后 audit 完成与 D3a 开始之间修改候选正文，已提交目录要保留并报告提交不确定，绝不回传成功 JSON 或声称已回滚。
test("actual final D3a detects post-rename content change and retains committed artifact", async (t) => {
    const { ArchiveTransaction } = await import("../scripts/runtime-payload-transaction.ts");
    const { writeFile } = await import("node:fs/promises");
    const output = await mkdtemp(join(tmpdir(), "veriq-stage-final-")),
        audit = ArchiveTransaction.prototype.audit;
    let changed = false;
    t.mock.method(
        ArchiveTransaction.prototype,
        "audit",
        async function (this: InstanceType<typeof ArchiveTransaction>, root = this.scratch) {
            await audit.call(this, root);
            if (this.profile === "runtime" && root === this.directory) {
                await writeFile(join(root, "runtime/npm/bin/npm-cli.js"), "changed after rename");
                changed = true;
            }
        },
    );
    try {
        await fixture(
            async (f) => {
                await assert.rejects(
                    stageMacRuntimePayload(await f.save(), f.expected, {
                        inputRoot: f.root,
                        outputParent: output,
                        candidateName: "candidate",
                    }),
                    { code: "PAYLOAD_COMMIT_UNCONFIRMED", cleanup: "INCOMPLETE", phase: "PUBLISH" },
                );
                assert.equal(changed, true);
                assert.equal(
                    await readFile(join(output, "candidate/runtime/npm/bin/npm-cli.js"), "utf8"),
                    "changed after rename",
                );
            },
            await stageModel(),
        );
    } finally {
        t.mock.restoreAll();
        await rm(output, { recursive: true, force: true });
    }
});

for (const timing of ["before", "after"] as const)
    test(`cancellation ${timing} rename has truthful commit semantics`, async (t) => {
        const { ArchiveTransaction } = await import("../scripts/runtime-payload-transaction.ts");
        const output = await mkdtemp(join(tmpdir(), "veriq-stage-cancel-")),
            controller = new AbortController();
        const publish = ArchiveTransaction.prototype.publishRuntime,
            audit = ArchiveTransaction.prototype.audit;
        if (timing === "before")
            t.mock.method(
                ArchiveTransaction.prototype,
                "publishRuntime",
                async function (
                    this: InstanceType<typeof ArchiveTransaction>,
                    policy: Parameters<typeof publish>[0],
                ) {
                    controller.abort();
                    return publish.call(this, policy);
                },
            );
        else
            t.mock.method(
                ArchiveTransaction.prototype,
                "audit",
                async function (
                    this: InstanceType<typeof ArchiveTransaction>,
                    root = this.scratch,
                ) {
                    await audit.call(this, root);
                    if (this.profile === "runtime" && root === this.directory) controller.abort();
                },
            );
        try {
            await fixture(
                async (f) => {
                    const promise = stageMacRuntimePayload(await f.save(), f.expected, {
                        inputRoot: f.root,
                        outputParent: output,
                        candidateName: "candidate",
                        signal: controller.signal,
                    });
                    if (timing === "before") {
                        await assert.rejects(promise, {
                            code: "PAYLOAD_CANCELLED",
                            cleanup: "CONFIRMED",
                        });
                        assert.deepEqual(await readdir(output), []);
                    } else {
                        const result = await promise;
                        assert.equal(result.committed, true);
                        assert.equal(result.inventory.root, join(output, "candidate/runtime"));
                        assert.deepEqual(await readdir(output), ["candidate"]);
                    }
                },
                await stageModel(),
            );
        } finally {
            t.mock.restoreAll();
            await rm(output, { recursive: true, force: true });
        }
    });

test("replaced final lock preserves successful candidate with cleanup INCOMPLETE", async (t) => {
    const { ArchiveTransaction } = await import("../scripts/runtime-payload-transaction.ts");
    const { rename, writeFile } = await import("node:fs/promises");
    const output = await mkdtemp(join(tmpdir(), "veriq-stage-lock-")),
        cleanup = ArchiveTransaction.prototype.cleanup;
    t.mock.method(
        ArchiveTransaction.prototype,
        "cleanup",
        async function (this: InstanceType<typeof ArchiveTransaction>) {
            if (this.profile === "runtime" && this.committed) {
                await rename(this.lockPath, join(output, "owned-lock"));
                await writeFile(this.lockPath, "outside lock");
            }
            return cleanup.call(this);
        },
    );
    try {
        await fixture(
            async (f) => {
                const result = await stageMacRuntimePayload(await f.save(), f.expected, {
                    inputRoot: f.root,
                    outputParent: output,
                    candidateName: "candidate",
                });
                assert.equal(result.cleanup, "INCOMPLETE");
                assert.equal(result.committed, true);
                assert.equal(
                    await readFile(join(output, ".veriq-candidate.lock"), "utf8"),
                    "outside lock",
                );
                await verifyMacRuntimeManifestV2(result.runtimeDirectory, {
                    arch: "x64",
                    layout: f.chromeLayout.layout,
                });
            },
            await stageModel(),
        );
    } finally {
        t.mock.restoreAll();
        await rm(output, { recursive: true, force: true });
    }
});

// CLI 信号测试用独立已知宿主 Node 进程和 IPC 精确停在 S 角色写入边界，首信号可释放或故意保留 JavaScript 等待；后两种场景仅验证五秒或二次信号的诚实 INCOMPLETE 诊断，不声称能够取消永久卡在内核的 writer。
for (const scenario of ["SIGINT", "SIGTERM", "SECOND", "DEADLINE"] as const)
    test(`actual stage CLI ${scenario} reports controlled cancellation and owned cleanup`, async () => {
        const { spawn } = await import("node:child_process");
        const { writeFile } = await import("node:fs/promises");
        const output = await mkdtemp(join(tmpdir(), "veriq-stage-signal-"));
        try {
            await fixture(
                async (f) => {
                    const inputs = join(output, "inputs.json"),
                        expected = join(output, "expected.json");
                    await writeFile(inputs, await f.save(), { mode: 0o644 });
                    await writeFile(expected, JSON.stringify(f.expected), { mode: 0o644 });
                    const wrapper = `import {ArchiveTransaction} from './scripts/runtime-payload-transaction.ts';
const write=ArchiveTransaction.prototype.write;let waiting=false;process.on('message',()=>{});
ArchiveTransaction.prototype.write=async function(...args){if(this.profile==='runtime'&&!waiting&&args[0].startsWith('runtime/roles/')){waiting=true;process.send('ready');await new Promise(resolve=>{${scenario === "SIGINT" || scenario === "SIGTERM" ? "this.signal.addEventListener('abort',resolve,{once:true})" : "process.on('message',()=>{})"}})}return write.apply(this,args)};
process.argv=['node','stage','--inputs',${JSON.stringify(inputs)},'--expected',${JSON.stringify(expected)},'--input-root',${JSON.stringify(f.root)},'--output-parent',${JSON.stringify(output)},'--candidate','candidate'];
await import('./scripts/stage-macos-runtime.mjs');process.disconnect();`;
                    const child = spawn(
                        process.execPath,
                        ["--import", "tsx", "--input-type=module", "-e", wrapper],
                        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
                    );
                    let stdout = "",
                        stderr = "";
                    child.stdout!.on("data", (chunk: Buffer) => {
                        stdout += chunk.toString();
                    });
                    child.stderr!.on("data", (chunk: Buffer) => {
                        stderr += chunk.toString();
                    });
                    const closed = event(child, "close");
                    try {
                        await Promise.race([
                            event(child, "message"),
                            closed.then(() => {
                                throw new Error(`Child exited before ready: ${stderr}`);
                            }),
                        ]);
                        child.kill(
                            scenario === "SIGTERM" || scenario === "DEADLINE"
                                ? "SIGTERM"
                                : "SIGINT",
                        );
                        if (scenario === "SECOND") {
                            await new Promise<void>((resolve) => {
                                const observe = (chunk: Buffer) => {
                                    if (chunk.toString().includes("PAYLOAD")) {
                                        child.stderr!.removeListener("data", observe);
                                        resolve();
                                    }
                                };
                                child.stderr!.on("data", observe);
                                child.send("probe");
                                setTimeout(() => {
                                    child.kill("SIGINT");
                                    resolve();
                                }, 100);
                            });
                        }
                        const [code, signal] = await closed;
                        assert.equal(
                            code,
                            scenario === "SIGTERM" || scenario === "DEADLINE" ? 143 : 130,
                            JSON.stringify({ code, signal, stderr }),
                        );
                        assert.equal(stdout, "");
                        assert.match(stderr, /PAYLOAD_CANCELLED/);
                        assert.match(
                            stderr,
                            scenario === "SECOND" || scenario === "DEADLINE"
                                ? /cleanup=INCOMPLETE/
                                : /cleanup=CONFIRMED/,
                        );
                        const names = await readdir(output);
                        assert.equal(names.includes("candidate"), false);
                        assert.equal(
                            names.some((name) => name.startsWith(".veriq-")),
                            scenario === "SECOND" || scenario === "DEADLINE",
                        );
                    } finally {
                        if (child.exitCode === null) child.kill("SIGKILL");
                        await closed;
                    }
                },
                await stageModel(),
            );
        } finally {
            await rm(output, { recursive: true, force: true });
        }
    });

test("work cleanup uncertainty after successful publication returns committed incomplete candidate", async (t) => {
    const { ArchiveTransaction } = await import("../scripts/runtime-payload-transaction.ts");
    const output = await mkdtemp(join(tmpdir(), "veriq-stage-work-cleanup-")),
        cleanup = ArchiveTransaction.prototype.cleanup;
    t.mock.method(
        ArchiveTransaction.prototype,
        "cleanup",
        async function (this: InstanceType<typeof ArchiveTransaction>) {
            if (this.profile === "work") this.noteCloseFailure();
            return cleanup.call(this);
        },
    );
    try {
        await fixture(
            async (f) => {
                const result = await stageMacRuntimePayload(await f.save(), f.expected, {
                    inputRoot: f.root,
                    outputParent: output,
                    candidateName: "candidate",
                });
                assert.equal(result.committed, true);
                assert.equal(result.cleanup, "INCOMPLETE");
                assert.ok(
                    (await readdir(output)).some((name) => name.startsWith(".veriq-s-work-")),
                );
                await verifyMacRuntimeManifestV2(result.runtimeDirectory, {
                    arch: "x64",
                    layout: f.chromeLayout.layout,
                });
            },
            await stageModel(),
        );
    } finally {
        t.mock.restoreAll();
        await rm(output, { recursive: true, force: true });
    }
});

test("production native bin cannot publish a shim for a non-executable target", async () => {
    const value = await stageModel();
    const { bytes } = await import("./fixtures/runtime-payload.ts");
    const bin = value.graph.bins[0]!;
    bin.launcher = "native";
    bin.inspection = value.put(
        "evidence/production-bin-native.json",
        bytes({
            schemaVersion: 1,
            kind: "NATIVE_BIN_INSPECTION",
            platform: "darwin",
            arch: "x64",
            path: bin.targetPath,
            sha256: bin.targetSha256,
            minimumOs: "15.0",
            inspectionEvidence: value.recipe.tools[0]!.evidence,
        }),
    );
    const output = await mkdtemp(join(tmpdir(), "veriq-native-bin-mode-"));
    try {
        await fixture(async (f) => {
            await assert.rejects(
                stageMacRuntimePayload(await f.save(), f.expected, {
                    inputRoot: f.root,
                    outputParent: output,
                    candidateName: "candidate",
                }),
                { code: "PAYLOAD_BIN_UNSUPPORTED" },
            );
            assert.deepEqual(await readdir(output), []);
        }, value);
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});

test("final npm aliases are ordinary shims and raw multihop origins preserve unchanged targets", async () => {
    const value = await stageModel(),
        root = value.nodeReceipt.npmRoot;
    const bin = value.nodeReceipt.npmGraph.bins[0]!;
    bin.sourceAlias = bin.aliasPath;
    value.nodeEntries.push(
        { path: `${root}/.bin/npm`, kind: "link", target: "../relay.js" },
        { path: `${root}/relay.js`, kind: "link", target: "bin/npm-cli.js" },
        { path: `${root}/copy.js`, kind: "link", target: "relay.js" },
    );
    rehashStageNpm(value);
    const output = await mkdtemp(join(tmpdir(), "veriq-stage-npm-alias-"));
    try {
        await fixture(async (f) => {
            const result = await stageMacRuntimePayload(await f.save(), f.expected, {
                inputRoot: f.root,
                outputParent: output,
                candidateName: "candidate",
            });
            const receipt = JSON.parse(
                await readFile(join(result.candidateDirectory, "payload-receipt.json"), "utf8"),
            );
            const alias = join(result.runtimeDirectory, "npm/.bin/npm");
            assert.ok((await lstat(alias)).isFile());
            assert.equal((await lstat(alias)).mode & 0o777, 0o755);
            assert.match(await readFile(alias, "utf8"), /roles\/runner\/veriq_runner/);
            assert.equal(
                await readFile(join(result.runtimeDirectory, "npm/bin/npm-cli.js"), "utf8"),
                "export {};\n",
            );
            assert.equal(
                await readFile(join(result.runtimeDirectory, "npm/copy.js"), "utf8"),
                "export {};\n",
            );
            const fact = receipt.files.find(
                (file: { path: string }) => file.path === "npm/.bin/npm",
            );
            assert.ok(
                fact.origins.some(
                    (origin: { sha256: string }) =>
                        origin.sha256 === hash(Buffer.from("../relay.js")),
                ),
            );
            assert.ok(
                fact.origins.some(
                    (origin: { sha256: string }) =>
                        origin.sha256 === hash(Buffer.from("bin/npm-cli.js")),
                ),
            );
            const { BIN_SHIM_TEMPLATE } = await import("../scripts/runtime-payload-bins.ts");
            assert.equal(receipt.templateSha256, hash(Buffer.from(BIN_SHIM_TEMPLATE)));
            assert.ok(
                result.inventory.manifest.links.every((link) => link.path.startsWith("browser/")),
            );
        }, value);
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});

test("same-byte output ownership collision rejects instead of silently merging files", async () => {
    const value = await stageModel(),
        path = "node_modules/peer-lib/index.js";
    value.add(
        "entries",
        path,
        value.data.get("trees/dependencies/entry/node_modules/peer-lib/index.js")!,
    );
    value.receipts.entries.outputs.push({ path, kind: "chunk", imports: [] });
    const output = await mkdtemp(join(tmpdir(), "veriq-stage-collision-"));
    try {
        await fixture(async (f) => {
            await assert.rejects(
                stageMacRuntimePayload(await f.save(), f.expected, {
                    inputRoot: f.root,
                    outputParent: output,
                    candidateName: "candidate",
                }),
                { code: "PAYLOAD_COLLISION" },
            );
            assert.deepEqual(await readdir(output), []);
        }, value);
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});

// 内部 runtime 或 views 容器不应消耗最终逻辑成员的六十四层路径额度，测试只写一个微型普通文件并核实际模式和 audit；默认 intake 的已知前缀缩限不在此测试中放宽，也不伪称已修复其延期解析政策。
for (const profile of ["runtime", "work"] as const)
    test(`${profile} fixed container preserves sixty-four component member budget`, async () => {
        const { ArchiveTransaction } = await import("../scripts/runtime-payload-transaction.ts");
        const output = await mkdtemp(join(tmpdir(), "veriq-stage-budget-"));
        try {
            await fixture(
                async (f) => {
                    const tx = new ArchiveTransaction(
                        f.root,
                        output,
                        "candidate",
                        undefined,
                        profile,
                    );
                    try {
                        await tx.initialize();
                        await tx.plan(1, 65);
                        const path = `${profile === "runtime" ? "runtime" : "views"}/${[...Array<string>(63).fill("a"), "file"].join("/")}`;
                        await tx.write(
                            path,
                            (async function* () {
                                yield Buffer.from("x");
                            })(),
                            undefined,
                            0o644,
                        );
                        assert.equal(await readFile(join(tx.scratch, path), "utf8"), "x");
                        assert.equal((await lstat(join(tx.scratch, path))).mode & 0o777, 0o644);
                        await tx.audit();
                    } finally {
                        assert.equal(await tx.cleanup(), "CONFIRMED");
                    }
                },
                await stageModel(),
            );
        } finally {
            await rm(output, { recursive: true, force: true });
        }
    });

test("actual stage CLI emits complete success JSON and stable incomplete cleanup warning", async () => {
    const { spawnSync } = await import("node:child_process");
    const { writeFile } = await import("node:fs/promises");
    const output = await mkdtemp(join(tmpdir(), "veriq-stage-cli-warning-"));
    try {
        await fixture(
            async (f) => {
                const inputs = join(output, "inputs.json"),
                    expected = join(output, "expected.json");
                await writeFile(inputs, await f.save(), { mode: 0o644 });
                await writeFile(expected, JSON.stringify(f.expected), { mode: 0o644 });
                const wrapper = `import {ArchiveTransaction} from './scripts/runtime-payload-transaction.ts';
const cleanup=ArchiveTransaction.prototype.cleanup;ArchiveTransaction.prototype.cleanup=async function(){if(this.profile==='work')this.noteCloseFailure();return cleanup.call(this)};
process.argv=['node','stage','--inputs',${JSON.stringify(inputs)},'--expected',${JSON.stringify(expected)},'--input-root',${JSON.stringify(f.root)},'--output-parent',${JSON.stringify(output)},'--candidate','candidate'];
await import('./scripts/stage-macos-runtime.mjs');`;
                const child = spawnSync(
                    process.execPath,
                    ["--import", "tsx", "--input-type=module", "-e", wrapper],
                    { encoding: "utf8", maxBuffer: 1024 ** 2 },
                );
                assert.equal(child.status, 0);
                assert.equal(
                    child.stderr,
                    "PAYLOAD_CLEANUP_INCOMPLETE phase=PUBLISH cleanup=INCOMPLETE\n",
                );
                const result = JSON.parse(child.stdout);
                assert.equal(result.committed, true);
                assert.equal(result.cleanup, "INCOMPLETE");
                await verifyMacRuntimeManifestV2(result.runtimeDirectory, {
                    arch: "x64",
                    layout: f.chromeLayout.layout,
                });
                const invalid = spawnSync(
                    process.execPath,
                    ["--import", "tsx", "scripts/stage-macos-runtime.mjs", "--unknown", "value"],
                    { encoding: "utf8" },
                );
                assert.equal(invalid.status, 1);
                assert.equal(invalid.stdout, "");
                assert.match(
                    invalid.stderr,
                    /PAYLOAD_INPUT_INVALID phase=INPUTS cleanup=NOT_NEEDED/,
                );
            },
            await stageModel(),
        );
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});

/** 真实 S 目录写入的 primary chmod 或 sync 错误必须先于随后关闭错误返回，原输入与旧 artifact 不得变化；注入仅覆盖 runtime/browser 实际目录句柄，关闭计数只在真实 close 完成后增加，不把测试故障描述为无法关闭的内核资源。 */
for (const [operation, cause] of [
    ["chmod", "ENOSPC"],
    ["sync", "EDQUOT"],
] as const)
    for (const uncertainClose of [false, true])
        test(`R1 stage directory ${operation} preserves ${cause} with uncertain close ${uncertainClose}`, async (t) => {
            const { ArchiveTransaction } = await import(
                "../scripts/runtime-payload-transaction.ts"
            );
            const { RuntimePayloadError } = await import("../scripts/runtime-payload-inputs.ts");
            const { open, unlink, mkdir, writeFile } = await import("node:fs/promises");
            type Handle = import("node:fs/promises").FileHandle;
            const output = await mkdtemp(join(tmpdir(), "veriq-directory-stage-"));
            const probe = await open(join(output, "probe"), "wx", 0o600),
                prototype = Object.getPrototypeOf(probe) as Handle;
            await probe.close();
            await unlink(join(output, "probe"));
            await mkdir(join(output, "old"));
            await writeFile(join(output, "old/sentinel"), "outside sentinel");
            const mkdirOwned = ArchiveTransaction.prototype.mkdir;
            let realClosed = 0,
                faulted = false;
            t.mock.method(
                ArchiveTransaction.prototype,
                "mkdir",
                async function (this: InstanceType<typeof ArchiveTransaction>, path: string) {
                    if (this.profile !== "runtime" || path !== "runtime/browser" || faulted)
                        return mkdirOwned.call(this, path);
                    const injected = t.mock.method(
                        prototype,
                        operation,
                        async function (this: Handle) {
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
                await fixture(
                    async (f) => {
                        await assert.rejects(
                            stageMacRuntimePayload(await f.save(), f.expected, {
                                inputRoot: f.root,
                                outputParent: output,
                                candidateName: "candidate",
                            }),
                            (error: unknown) => {
                                assert.ok(error instanceof RuntimePayloadError);
                                assert.equal(error.code, "PAYLOAD_DISK_INSUFFICIENT");
                                assert.equal(error.causeCode, cause);
                                assert.equal(error.phase, "COPY");
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
                        assert.equal(
                            names.some((name) => name.startsWith(".veriq-s-work-")),
                            false,
                        );
                        if (uncertainClose) assert.ok(names.includes(".veriq-candidate.lock"));
                        else assert.deepEqual(names, ["old"]);
                    },
                    await stageModel(),
                );
            } finally {
                t.mock.restoreAll();
                await rm(output, { recursive: true, force: true });
            }
        });

/** 完整证据预算使用微型数值 Ref 模型验证边界，不创建六十四 MiB 正文或宣称模型摘要是真实文件来源；配方、独立 expected 和 intake 三份描述必须与普通 copied refs 同额收费，相同 SHA 的不同实际副本也不得去重逃过总额。 */
test("R1 evidence budget includes all three descriptors beyond copied refs", () => {
    const ref = (path: string, sizeBytes: number): Ref => ({
        path,
        sizeBytes,
        sha256: "0".repeat(64),
    });
    const copied = [ref("input-evidence/refs/evidence.json", 64 * 1024 ** 2 - 2)];
    const descriptors = [
        ref("input-evidence/inputs.json", 1),
        ref("input-evidence/expected.json", 1),
        ref("input-evidence/archive-intake.json", 1),
    ];
    assert.doesNotThrow(() => assertPayloadEvidenceBudget(copied));
    assert.throws(() => assertPayloadEvidenceBudget([...copied, ...descriptors]), {
        code: "PAYLOAD_LIMIT",
    });
});

test("R1 evidence budget accepts exact total and rejects one byte above without SHA deduplication", () => {
    const ref = (path: string, sizeBytes: number): Ref => ({
        path,
        sizeBytes,
        sha256: "0".repeat(64),
    });
    assert.doesNotThrow(() => assertPayloadEvidenceBudget([]));
    assert.doesNotThrow(() =>
        assertPayloadEvidenceBudget([ref("first", 32 * 1024 ** 2), ref("second", 32 * 1024 ** 2)]),
    );
    assert.throws(
        () =>
            assertPayloadEvidenceBudget([
                ref("first", 32 * 1024 ** 2),
                ref("second", 32 * 1024 ** 2 + 1),
            ]),
        { code: "PAYLOAD_LIMIT" },
    );
    assert.throws(() => assertPayloadEvidenceBudget([ref("oversize", 64 * 1024 ** 2 + 1)]), {
        code: "PAYLOAD_LIMIT",
    });
});

for (const size of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
    test(`R1 evidence budget rejects invalid size ${String(size)}`, () => {
        assert.throws(
            () =>
                assertPayloadEvidenceBudget([
                    { path: "numeric-model", sizeBytes: size, sha256: "0".repeat(64) },
                ]),
            { code: "PAYLOAD_LIMIT" },
        );
    });

test("R1 evidence budget rejects declarations whose combined integer size would overflow", () => {
    assert.throws(
        () =>
            assertPayloadEvidenceBudget([
                { path: "first", sizeBytes: Number.MAX_SAFE_INTEGER, sha256: "0".repeat(64) },
                { path: "second", sizeBytes: Number.MAX_SAFE_INTEGER, sha256: "0".repeat(64) },
            ]),
        { code: "PAYLOAD_LIMIT" },
    );
});

/** 真实子进程只包装精确 owned 快照的单次关闭回调，实际系统关闭成功后才注入 EIO；父进程等待自然终止并记录保留目录之后才删除自己的夹具，十秒看门狗只能判失败，不能替生产结算。 */
for (const scenario of ["normal", "close-eio"])
    test(`finite ZIP close stage ${scenario}`, async (t) => {
        const { spawnSync } = await import("node:child_process");
        const { mkdtemp, rm, lstat, readdir } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const root = await mkdtemp(join(tmpdir(), "veriq-zip-close-"));
        try {
            const child = spawnSync(
                process.execPath,
                [
                    "--import",
                    "tsx",
                    "--input-type=module",
                    "-e",
                    String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, lstat, readdir, readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { ArchiveTransaction } from "./scripts/runtime-payload-transaction.ts";
import { ArchiveScan, ArchiveBudget, archiveRejectionLine } from "./scripts/runtime-payload-archive.ts";
import { scanZip } from "./scripts/runtime-payload-zip.ts";
import { zipBytes } from "./tests/fixtures/runtime-payload-archives.ts";
import { hash } from "./tests/fixtures/runtime-payload.ts";
const root = process.env.VERIQ_ZIP_CLOSE_ROOT, scenario = process.env.VERIQ_ZIP_CLOSE_CASE;
const output = join(root, "output"), input = join(root, "input");
await mkdir(output, { mode: 0o700 });
await mkdir(input, { mode: 0o700 });
const space = await statfs(root, { bigint: true });
assert.ok(space.bavail * space.bsize > 40n * 1024n ** 2n);
const emit = (event, facts = {}) => console.log(JSON.stringify({ event, scenario, ...facts }));
process.on("unhandledRejection", error => { emit("UNHANDLED_REJECTION", { message: String(error) }); process.exitCode = 91; });
let target, expected, captured, calls = 0, opens = 0, injected = false, primary, tx;
const controller = new AbortController();
const originalOpen = fs.open, originalClose = fs.close, originalRead = fs.read;
const identity = info => ({ dev: String(info.dev), ino: String(info.ino), size: String(info.size), nlink: String(info.nlink) });
const matches = info => info.isFile() && info.dev === expected.dev && info.ino === expected.ino && info.size === expected.size && info.nlink === 1n;
const restore = () => { fs.open = originalOpen; fs.close = originalClose; fs.read = originalRead; syncBuiltinESMExports(); };
const install = (select, occurrence) => {
    fs.open = function(path, ...args) {
        if (!select(String(path)) || ++opens !== occurrence) return originalOpen.call(this, path, ...args);
        target = String(path);
        expected = fs.lstatSync(target, { bigint: true });
        assert.ok(expected.isFile() && expected.nlink === 1n && expected.size <= 1024n ** 2n);
        const callback = args.pop();
        return originalOpen.call(this, path, ...args, (error, fd) => {
            if (error) return callback(error, fd);
            assert.ok(matches(fs.fstatSync(fd, { bigint: true })));
            captured = fd;
            emit("CAPTURE", { path: target, fd, identity: identity(expected) });
            callback(null, fd);
        });
    };
    fs.close = function(fd, callback) {
        if (fd !== captured) return originalClose.call(this, fd, callback);
        assert.equal(++calls, 1);
        assert.ok(matches(fs.fstatSync(fd, { bigint: true })));
        originalClose(fd, error => {
            assert.ifError(error);
            restore();
            emit("ACTUAL_CLOSE", { calls, identity: identity(expected) });
            if (scenario.endsWith("normal")) callback(null);
            else { injected = true; callback(Object.assign(Error("OWNED_CLOSE_FAULT"), { code: "EIO" })); }
        });
    };
    fs.read = function(fd, ...args) {
        if (fd === captured && args[2] === 2018 && !injected && (scenario === "read-eio" || scenario === "cancel-eio")) {
            injected = true;
            if (scenario === "cancel-eio") controller.abort();
            else { queueMicrotask(() => args.at(-1)(Object.assign(Error("OWNED_READ_FAULT"), { code: "EIO" }))); return; }
        }
        return originalRead.call(this, fd, ...args);
    };
    syncBuiltinESMExports();
};
const retain = async () => {
    assert.equal(hash(await readFile(target)), snapshotHash);
    const files = await readdir(output, { recursive: true });
    assert.ok(files.some(path => path.endsWith(".lock")));
    assert.ok(files.some(path => path.endsWith("snapshots/chrome.zip")));
    emit("RETAINED", { target, identity: identity(await lstat(target, { bigint: true })), files });
};
let snapshotHash;

const { fixture } = await import("./tests/fixtures/runtime-payload.ts");
const { stageModel } = await import("./tests/fixtures/runtime-payload-stage.ts");
const { stageMacRuntimePayload } = await import("./scripts/runtime-payload-stage.ts");
await fixture(async f => {
    snapshotHash = f.recipe.chrome.file.sha256;
    install(path => path.startsWith(output + "/") && path.endsWith("/intakes/intake/snapshots/chrome.zip"), 1);
    emit("SETUP_RESOLVED");
    try {
        const result = await stageMacRuntimePayload(await f.save(), f.expected, { inputRoot: f.root, outputParent: output, candidateName: "a".repeat(64) });
        assert.equal(scenario, "normal");
        assert.equal(result.committed, true);
        assert.equal(result.cleanup, "CONFIRMED");
        emit("SETTLED", { outcome: "success", cleanup: result.cleanup });
    } catch (error) {
        assert.equal(scenario, "close-eio");
        assert.equal(error.code, "PAYLOAD_IO");
        assert.equal(error.causeCode, "EIO");
        assert.equal(error.phase, "INTAKE");
        assert.equal(error.cleanup, "INCOMPLETE");
        await retain();
        assert.ok(!(await readdir(output)).includes("a".repeat(64)));
        emit("SETTLED", { outcome: "rejected", code: error.code, causeCode: error.causeCode, phase: error.phase, cleanup: error.cleanup });
    } finally { restore(); }
}, await stageModel());
assert.equal(calls, 1);
`,
                ],
                {
                    encoding: "utf8",
                    timeout: 10000,
                    env: {
                        ...process.env,
                        TMPDIR: root,
                        TSX_DISABLE_CACHE: "1",
                        VERIQ_ZIP_CLOSE_ROOT: root,
                        VERIQ_ZIP_CLOSE_CASE: scenario,
                    },
                },
            );
            const paths = ["", ...(await readdir(root, { recursive: true }))];
            const facts = await Promise.all(
                paths.map(async (path) => {
                    const info = await lstat(join(root, path));
                    return {
                        path,
                        allocatedBytes: info.blocks * 512,
                        ino: info.ino,
                        sizeBytes: info.size,
                    };
                }),
            );
            t.diagnostic(
                JSON.stringify({
                    scenario,
                    status: child.status,
                    signal: child.signal,
                    stdout: child.stdout,
                    stderr: child.stderr,
                    retainedAfterExit: facts,
                }),
            );
            assert.ok(facts.reduce((sum, item) => sum + item.allocatedBytes, 0) <= 2 * 1024 ** 2);
            assert.match(child.stdout, /SETUP_RESOLVED/);
            assert.doesNotMatch(child.stdout + child.stderr, /UNHANDLED_REJECTION/);
            assert.equal(child.status, 0, child.stdout + child.stderr);
            assert.equal(child.signal, null);
            assert.match(child.stdout, /SETTLED/);
            assert.equal(child.stderr, "");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
