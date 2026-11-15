import "../scripts/runtime-payload-inputs.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
    parseAssetsObservationInput,
    scanObservedSnapshots,
    ASSET_SOURCES,
} from "../scripts/runtime-assets-observation.ts";
import { ArchiveTransaction } from "../scripts/runtime-payload-transaction.ts";
import { assetsFixture, tinyAssets, fact } from "./fixtures/runtime-assets.ts";

/** 这些正例只调用顶层实际使用的扫描段并输入独立摘要的微型快照，因此检验真实 CRC、布局和原模式而不会声称官方准入通过；默认事务中的普通成员目录必须为空，证明扫描没有隐式提取或创建链接。 */
async function* once(bytes: Uint8Array) {
    yield bytes;
}
for (const arch of ["x64", "arm64"] as const)
    test(`production snapshot helper observes ${arch} layout without extraction`, async () =>
        assetsFixture(async (f) => {
            const tx = new ArchiveTransaction(f.root, f.output, "scan");
            await tx.initialize();
            try {
                const [node, chrome] = tinyAssets(arch);
                const refs = [
                    await tx.write("snapshots/node.tar.gz", once(node)),
                    await tx.write("snapshots/chrome.zip", once(chrome)),
                ] as const;
                const result = await scanObservedSnapshots(tx, arch, refs);
                assert.equal(result.archives[0].snapshot.sha256, fact("node", node).sha256);
                assert.equal(result.archives[0].fileCount, 1);
                assert.equal(result.archives[1].linkCount, 2);
                assert.equal(result.chromeLayout.bundleDirectoryObserved, true);
                assert.equal(result.chromeLayout.executableFileObserved, true);
                assert.equal(result.chromeLayout.allowedLinksCandidate.length, 1);
                assert.equal(result.chromeLayout.outsideFrameworkLinks.length, 1);
                assert.equal(result.chromeLayout.status, "REQUIRES_LAYOUT_REVIEW");
                const modes = JSON.parse(
                    await readFile(join(tx.scratch, "evidence/zip-modes.json"), "utf8"),
                );
                assert.equal(modes.entries.length, 5);
                assert.equal(
                    modes.entries.every((e: { state: string }) => e.state === "EXPLICIT_UNIX"),
                    true,
                );
                assert.deepEqual(await readdir(join(tx.scratch, "trees/chrome")), []);
                assert.deepEqual(await readdir(join(tx.scratch, "trees/node")), []);
                await tx.audit();
            } finally {
                assert.equal(await tx.cleanup(), "CONFIRMED");
            }
        }));
test("source manifest has exactly nineteen unique actual host keys", () => {
    assert.equal(ASSET_SOURCES.length, 19);
    assert.equal(new Set(ASSET_SOURCES.map((s) => s.path)).size, 19);
});
for (const bytes of [
    Buffer.from("{}"),
    Buffer.from("null"),
    Buffer.from([0xff]),
    Buffer.from('{"schemaVersion":1,"extra":true}'),
])
    test(`strict observation input rejects malformed ${bytes.toString("hex")}`, () =>
        assert.throws(() => parseAssetsObservationInput(bytes)));
for (const args of [
    [],
    ["--assets", "relative"],
    ["--unknown", "/tmp/input"],
    ["--assets", "/tmp/input", "--assets", "/tmp/again"],
])
    test(`observer CLI rejects flags ${JSON.stringify(args)}`, () => {
        const child = spawnSync(
            process.execPath,
            ["--import", "tsx", "scripts/observe-macos-runtime-assets.mjs", ...args],
            { encoding: "utf8" },
        );
        assert.equal(child.status, 1);
        assert.equal(child.stdout, "");
        assert.match(child.stderr, /PAYLOAD_INPUT_INVALID phase=INPUTS cleanup=NOT_NEEDED/);
    });

/** 元数据回归使用真实六百权限输入和独立 Ref 摘要，初次读取后再原子替换文件时旧 reader 必须保留早期身份并拒绝；快照仍通过实际事务复制，不能通过重新打开新路径后得到同字节就覆盖来源变化证据。 */
test("private metadata binds independent Ref then snapshots and detects replacement", async () =>
    assetsFixture(async (f) => {
        const { InputReader } = await import("../scripts/runtime-payload-tree.ts"),
            { readAssetMetadata } = await import("../scripts/runtime-assets-observation.ts"),
            { writeFile, rename } = await import("node:fs/promises");
        const reader = new InputReader(f.root, undefined, []);
        await reader.initialize();
        const bytes = await readAssetMetadata(reader, f.source.evidence, 1024 ** 2);
        const tx = new ArchiveTransaction(f.root, f.output, "metadata");
        await tx.initialize();
        try {
            await tx.observeRefs([f.source.evidence]);
            await tx.snapshot(f.source.evidence, "evidence/source.json");
            await reader.finish();
            await tx.finishSources();
            await tx.audit();
            await writeFile(join(f.root, "evidence/replacement"), bytes, { mode: 0o600 });
            await rename(
                join(f.root, "evidence/replacement"),
                join(f.root, "evidence/source.json"),
            );
            await assert.rejects(reader.finish(), { code: "PAYLOAD_SOURCE_CHANGED" });
            await assert.rejects(tx.finishSources(), { code: "PAYLOAD_SOURCE_CHANGED" });
        } finally {
            await tx.cleanup();
        }
    }));

/** 初读和事务登记之间的替换不能让后来的新身份被默认为最早来源，reader 的原观察必须与事务新登记一起收尾；即便新文件具有完全相同字节、长度与摘要，也须因原 inode 及父目录变化拒绝来源一致性。 */
test("metadata replacement between initial read and registration remains rejected", async () =>
    assetsFixture(async (f) => {
        const { InputReader } = await import("../scripts/runtime-payload-tree.ts"),
            { readAssetMetadata } = await import("../scripts/runtime-assets-observation.ts"),
            { writeFile, rename } = await import("node:fs/promises");
        const reader = new InputReader(f.root, undefined, []);
        await reader.initialize();
        const bytes = await readAssetMetadata(reader, f.source.evidence, 1024 ** 2);
        await writeFile(join(f.root, "evidence/replacement"), bytes, { mode: 0o600 });
        await rename(join(f.root, "evidence/replacement"), join(f.root, "evidence/source.json"));
        const tx = new ArchiveTransaction(f.root, f.output, "replace");
        await tx.initialize();
        try {
            await tx.observeRefs([f.source.evidence]);
            await assert.rejects(reader.finish(), { code: "PAYLOAD_SOURCE_CHANGED" });
        } finally {
            await tx.cleanup();
        }
    }));

/** DOS 与缺失类型字段必须保留其原始公开数值而不能记录为默认 Unix 权限，损坏 CRC 则应当在真实成员读取中拒绝；此处仅修改微型 ZIP 的公开测试头部以构造拒绝及 fallback 事实，不在产品里新造 ZIP parser。 */
for (const scenario of ["dos", "missing", "crc", "path", "outside"] as const)
    test(`snapshot scanner concrete ${scenario} observation`, async () =>
        assetsFixture(async (f) => {
            const { zipBytes, tarBytes } = await import("./fixtures/runtime-payload-archives.ts");
            const tx = new ArchiveTransaction(f.root, f.output, "modes");
            await tx.initialize();
            try {
                let [node, chrome] = tinyAssets();
                if (scenario === "dos" || scenario === "missing") {
                    chrome = zipBytes([{ path: "chrome-mac-x64/LICENSE", body: "tiny" }]);
                    const central = chrome.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
                    if (scenario === "dos") chrome[central + 5] = 0;
                    chrome.writeUInt32LE(0, central + 38);
                }
                if (scenario === "crc") {
                    chrome = zipBytes([{ path: "chrome-mac-x64/LICENSE", body: "tiny" }], 0);
                    const body = chrome.indexOf(Buffer.from("tiny"));
                    chrome[body] = 0x58;
                }
                if (scenario === "path") node = tarBytes([{ path: "../escape", body: "tiny" }]);
                if (scenario === "outside")
                    chrome = zipBytes([{ path: "chrome-mac-x64/LICENSE", body: "tiny" }]);
                const refs = [
                    await tx.write("snapshots/node.tar.gz", once(node)),
                    await tx.write("snapshots/chrome.zip", once(chrome)),
                ] as const;
                if (scenario === "crc" || scenario === "path")
                    await assert.rejects(scanObservedSnapshots(tx, "x64", refs), {
                        code: scenario === "crc" ? "PAYLOAD_ARCHIVE_CRC" : "PAYLOAD_PATH",
                    });
                else {
                    const result = await scanObservedSnapshots(tx, "x64", refs);
                    assert.equal(result.chromeLayout.bundleDirectoryObserved, false);
                    assert.equal(result.chromeLayout.executableFileObserved, false);
                    assert.equal(
                        result.chromeLayout.missingOrDosModeEntries,
                        scenario === "outside" ? 0 : 1,
                    );
                    const raw = JSON.parse(
                        await readFile(join(tx.scratch, "evidence/zip-modes.json"), "utf8"),
                    );
                    if (scenario !== "outside") {
                        assert.equal(raw.entries[0].rawMode, 0);
                        assert.equal(raw.entries[0].state, "MISSING_OR_DOS");
                    }
                }
            } finally {
                await tx.cleanup();
            }
        }));

/** 固定官方输入的纯解析正例仅检验声明合同与深冻结，不读或伪造任何官方归档正文；每个负例只改变一个声明以证明未知字段、旧版本、错误路径和摘要在进入异步文件读取之前已经被明确拒绝。 */
test("official input declaration strictly parses and freezes without archive success claim", async () => {
    const { OFFICIAL_ASSETS } = await import("../scripts/runtime-assets-observation.ts");
    const input = {
        schemaVersion: 1,
        kind: "MAC_RUNTIME_ASSETS_OBSERVATION_INPUT",
        arch: "x64",
        nodeVersion: "24.22.1",
        chromeVersion: "158.0.8127.18",
        playwrightVersion: "1.65.0",
        revision: "1254",
        source: {
            commit: "a".repeat(40),
            evidence: { path: "evidence/source.json", sizeBytes: 1, sha256: "a".repeat(64) },
        },
        node: {
            path: "archives/node.tar.gz",
            sizeBytes: OFFICIAL_ASSETS.x64.nodeBytes,
            sha256: OFFICIAL_ASSETS.x64.nodeSha,
        },
        chrome: {
            path: "archives/chrome.zip",
            sizeBytes: OFFICIAL_ASSETS.x64.chromeBytes,
            sha256: "b".repeat(64),
        },
        fetchEvidence: { path: "evidence/fetch.json", sizeBytes: 1, sha256: "c".repeat(64) },
    };
    const parsed = parseAssetsObservationInput(Buffer.from(JSON.stringify(input)));
    assert.ok(Object.isFrozen(parsed));
    assert.ok(Object.isFrozen(parsed.node));
    for (const changed of [
        { ...input, extra: true },
        { ...input, nodeVersion: "24.0.0" },
        { ...input, node: { ...input.node, sha256: "0".repeat(64) } },
        { ...input, source: { ...input.source, extra: true } },
        { ...input, node: { ...input.node, path: "snapshots/node.tar.gz" } },
    ])
        assert.throws(() => parseAssetsObservationInput(Buffer.from(JSON.stringify(changed))));
});

/** 发布回归在真实扫描段之后直接消费原事务发布边界，注入最终路径 audit 失败和已提交锁收尾不确定两种事实；测试不调用顶层官方成功入口，仍要求完整保留已提交内容并明确区分 COMMIT_UNCONFIRMED 与 committed 加 INCOMPLETE。 */
for (const scenario of ["final-audit", "cleanup"] as const)
    test(`observed tiny snapshots retain uncertain publication ${scenario}`, async () =>
        assetsFixture(async (f) => {
            const tx = new ArchiveTransaction(f.root, f.output, "publish");
            await tx.initialize();
            const [node, chrome] = tinyAssets();
            const refs = [
                await tx.write("snapshots/node.tar.gz", once(node)),
                await tx.write("snapshots/chrome.zip", once(chrome)),
            ] as const;
            await scanObservedSnapshots(tx, "x64", refs);
            const original = tx.audit.bind(tx);
            if (scenario === "final-audit")
                tx.audit = async (root) => {
                    if (root === tx.directory) tx.fail("PAYLOAD_SOURCE_CHANGED");
                    return original(root);
                };
            else {
                const publish = tx.publish.bind(tx);
                tx.publish = async () => {
                    tx.noteCloseFailure();
                    return publish();
                };
            }
            if (scenario === "final-audit")
                await assert.rejects(tx.publish(), {
                    code: "PAYLOAD_COMMIT_UNCONFIRMED",
                    cleanup: "INCOMPLETE",
                });
            else assert.equal(await tx.publish(), "INCOMPLETE");
            assert.equal(tx.committed, true);
            assert.ok((await readdir(tx.directory)).includes("snapshots"));
            assert.equal(await tx.cleanup(), "INCOMPLETE");
        }));

/** 回归直接执行成熟 YAML 解析器提取出的生产 inline Node 收集段，检查真实 GITHUB_OUTPUT、最终文件集合和摘要而不模拟上传服务；稀疏上限夹具一次只在本测试拥有的目录中创建，实际分配先核预算且所有资源关闭之后才 finally 删除。 */
for (const scenario of [
    "normal",
    "normal-truncated-log",
    "metadata-limit",
    "logs-limit",
    "manifest-limit",
    "read-failure",
    "prefix-write-failure",
    "manifest-write-failure",
    "close-failure",
    "symlink",
    "fallback-failure",
    "existing-upload",
] as const)
    test(`production inline evidence collector ${scenario}`, async () => {
        const { mkdtemp, mkdir, writeFile, open, lstat, statfs, rm, symlink } = await import(
            "node:fs/promises"
        );
        const { tmpdir } = await import("node:os"),
            { createHash } = await import("node:crypto"),
            { assetWorkflowSteps } = await import("./fixtures/runtime-assets.ts");
        const base = await mkdtemp(join(tmpdir(), "veriq-collector-")),
            root = join(base, "assets"),
            meta = join(root, "metadata"),
            output = join(base, "github-output");
        await mkdir(root, { mode: 0o700 });
        await mkdir(meta, { mode: 0o700 });
        await writeFile(output, "", { mode: 0o600 });
        try {
            const free = await statfs(base, { bigint: true });
            assert.ok(free.bavail * free.bsize > 40n * 1024n ** 2n);
            await writeFile(join(meta, "status.json"), JSON.stringify({ status: "OBSERVED" }), {
                mode: 0o600,
            });
            await writeFile(join(meta, "pnpm-install.log"), "small setup log", { mode: 0o600 });
            const existingSteps = Buffer.from(
                JSON.stringify([
                    {
                        step: "ACQUIRE",
                        status: "PASS",
                        code: null,
                        cleanup: "CONFIRMED",
                        actualBytes: null,
                    },
                    {
                        step: "OBSERVE",
                        status: "PASS",
                        code: null,
                        cleanup: "CONFIRMED",
                        actualBytes: null,
                    },
                ]),
            );
            await writeFile(join(meta, "steps.json"), existingSteps, { mode: 0o600 });
            if (scenario === "normal" || scenario === "normal-truncated-log") {
                await mkdir(join(meta, "nested/deep"), { recursive: true, mode: 0o700 });
                await writeFile(
                    join(meta, "nested/deep/source.json"),
                    "small committed source evidence",
                    { mode: 0o600 },
                );
            }
            const sparse = async (name: string, bytes: number) => {
                const file = join(meta, name),
                    fd = await open(file, "wx", 0o600);
                try {
                    await fd.truncate(bytes);
                } finally {
                    await fd.close();
                }
                assert.ok((await lstat(file, { bigint: true })).blocks * 512n <= 65536n);
            };
            if (scenario === "metadata-limit") {
                await sparse("a.json", 9 * 1024 ** 2);
                await sparse("b.json", 9 * 1024 ** 2);
            }
            if (scenario === "logs-limit") {
                await sparse("a.log", 4 * 1024 ** 2 + 1);
                await sparse("b.log", 4 * 1024 ** 2 + 1);
            }
            if (scenario === "manifest-limit") {
                await rm(join(meta, "status.json"));
                await sparse("large.json", 16 * 1024 ** 2 - 1 - existingSteps.length);
            }
            if (scenario === "normal-truncated-log") {
                await rm(join(meta, "pnpm-install.log"));
                await sparse("pnpm-install.log", 1024 ** 2);
            }
            if (scenario === "existing-upload")
                await writeFile(join(root, "upload"), "outside sentinel", { mode: 0o600 });
            if (scenario === "prefix-write-failure") {
                await rm(join(meta, "pnpm-install.log"));
                await sparse("pnpm-install.log", 1024 ** 2);
            }
            if (scenario === "symlink" || scenario === "fallback-failure")
                await symlink(join(base, "outside-unread"), join(meta, "foreign.json"));
            const steps = assetWorkflowSteps(join(base, "uv-cache"));
            const collector = steps.find(
                (step) =>
                    step.id === "collect" ||
                    step.name === "Bound dependency logs and preserve setup failures",
            );
            assert.equal(typeof collector?.run, "string");
            const code = (collector!.run as string).match(
                /node --input-type=module <<'JS'\n([\s\S]*?)\nJS/,
            )?.[1];
            assert.ok(code);
            const prefix = `import fixIO from "node:fs"; import { syncBuiltinESMExports as fixSync } from "node:module";
const fixOpen = fixIO.promises.open; let fixUsed = false; const fixSourceOpens = []; const fixSourceReads = {};
process.on("exit",()=>process.stdout.write(JSON.stringify({sourceOpens:fixSourceOpens,sourceReads:fixSourceReads})+"\\n"));
fixIO.promises.open = async (path, ...args) => {
    const name = String(path); if (name.startsWith(process.env.ASSET_ROOT+"/metadata/")) fixSourceOpens.push(name);
    if (${JSON.stringify(scenario)} === "fallback-failure" && name.includes(".upload-build-")) throw Object.assign(Error("CONTROLLED_IO"), {code:"EIO"});
    if (${JSON.stringify(scenario)} === "manifest-write-failure" && name.endsWith("/manifest.json") && !fixUsed) { fixUsed=true; throw Object.assign(Error("CONTROLLED_IO"), {code:"EIO"}); }
    const handle = await fixOpen(path,...args);
    if (name.startsWith(process.env.ASSET_ROOT+"/metadata/")) { const read = handle.read.bind(handle); handle.read=async(...values)=>{fixSourceReads[name]=(fixSourceReads[name]??0)+values[2];return read(...values);}; }
    if (${JSON.stringify(scenario)} === "read-failure" && name.endsWith("/metadata/status.json")) handle.read=async()=>{throw Object.assign(Error("CONTROLLED_READ"),{code:"EIO"});};
    if (${JSON.stringify(scenario)} === "prefix-write-failure" && name.includes(".upload-build-") && name.endsWith("/pnpm-install.log")) handle.write=async()=>{throw Object.assign(Error("CONTROLLED_PREFIX_WRITE"),{code:"EIO"});};
    if (${JSON.stringify(scenario)} === "close-failure" && name.endsWith("/metadata/status.json")) { const close = handle.close.bind(handle); handle.close=async()=>{await close();throw Object.assign(Error("CONTROLLED_CLOSE"),{code:"EIO"});}; }
    return handle;
}; fixSync();\n`;
            const result = spawnSync(process.execPath, ["--input-type=module"], {
                input: prefix + code,
                encoding: "utf8",
                timeout: 15000,
                maxBuffer: 65536,
                env: {
                    ...process.env,
                    ASSET_ROOT: root,
                    GITHUB_OUTPUT: output,
                    GITHUB_SHA: "a".repeat(40),
                    EXPECTED_ARCH: "x64",
                    BIND_OUTCOME: "success",
                    NODE_SETUP_OUTCOME: "success",
                    DEPENDENCIES_OUTCOME: "success",
                    ORCHESTRATION_OUTCOME: "success",
                },
            });
            const markers = await readFile(output, "utf8");
            if (scenario === "fallback-failure" || scenario === "existing-upload") {
                assert.notEqual(result.status, 0);
                assert.equal(markers, "");
                if (scenario === "existing-upload")
                    assert.equal(await readFile(join(root, "upload"), "utf8"), "outside sentinel");
                else await assert.rejects(lstat(join(root, "upload")), { code: "ENOENT" });
                return;
            }
            const trace = JSON.parse(result.stdout.trim()) as {
                sourceOpens: string[];
                sourceReads: Record<string, number>;
            };
            if (scenario === "metadata-limit" || scenario === "logs-limit")
                assert.deepEqual(trace.sourceOpens, []);
            assert.match(markers, /^ready=true$/m, result.stderr);
            assert.match(markers, new RegExp(`^upload_root=${root}/upload$`, "m"));
            const uploaded = join(root, "upload"),
                names = await readdir(uploaded),
                manifest = JSON.parse(await readFile(join(uploaded, "manifest.json"), "utf8")) as {
                    files: { path: string; sizeBytes: number; sha256: string }[];
                };
            let metadataBytes = 0,
                logBytes = 0;
            const walk = async (dir: string) => {
                for (const name of await readdir(dir)) {
                    const path = join(dir, name),
                        info = await lstat(path);
                    assert.ok(!info.isSymbolicLink());
                    if (info.isDirectory()) await walk(path);
                    else {
                        assert.ok(info.isFile());
                        const bytes = await readFile(path);
                        if (name.endsWith(".log")) logBytes += bytes.length;
                        else metadataBytes += bytes.length;
                    }
                }
            };
            await walk(uploaded);
            assert.ok(metadataBytes <= 16 * 1024 ** 2);
            assert.ok(logBytes <= 8 * 1024 ** 2);
            for (const file of manifest.files) {
                const bytes = await readFile(join(uploaded, file.path));
                assert.equal(bytes.length, file.sizeBytes);
                assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
            }
            const upload = steps.find((step) => step.id === "metadata_upload");
            assert.equal(
                upload?.if,
                "always() && steps.collect.outputs.ready == 'true' && steps.collect.outputs.upload_root == format('{0}/upload', env.ASSET_ROOT)",
            );
            assert.equal(
                (upload?.with as Record<string, unknown>)?.path,
                "${{ env.ASSET_ROOT }}/upload/",
            );
            assert.equal((upload?.with as Record<string, unknown>)?.["if-no-files-found"], "error");
            assert.match(
                markers,
                new RegExp(
                    `^manifest_sha256=${createHash("sha256")
                        .update(await readFile(join(uploaded, "manifest.json")))
                        .digest("hex")}$`,
                    "m",
                ),
            );
            if (scenario === "normal" || scenario === "normal-truncated-log") {
                assert.equal(result.status, 0, result.stderr);
                assert.ok(names.includes("status.json"));
                assert.match(markers, /^collection=FULL$/m);
                assert.deepEqual(names.sort(), [
                    "manifest.json",
                    "nested",
                    "pnpm-install.log",
                    "status.json",
                    "steps.json",
                ]);
                assert.deepEqual(manifest.files.map((f) => f.path).sort(), [
                    "nested/deep/source.json",
                    "pnpm-install.log",
                    "status.json",
                    "steps.json",
                ]);
                assert.deepEqual(await readFile(join(uploaded, "steps.json")), existingSteps);
                if (scenario === "normal-truncated-log") {
                    assert.equal(trace.sourceReads[join(meta, "pnpm-install.log")], 32700);
                    const log = await readFile(join(uploaded, "pnpm-install.log"), "utf8");
                    assert.match(log, /LOG_TRUNCATED: hash binds retained prefix only/);
                    assert.equal((await lstat(join(meta, "pnpm-install.log"))).size, 1024 ** 2);
                }
            } else {
                assert.notEqual(result.status, 0);
                assert.deepEqual(names.sort(), ["failure.json", "manifest.json"]);
                const failure = JSON.parse(await readFile(join(uploaded, "failure.json"), "utf8"));
                assert.equal(failure.status, "FAIL");
                assert.equal(
                    failure.cleanup,
                    scenario === "close-failure" ? "INCOMPLETE" : "CONFIRMED",
                );
                assert.equal(
                    failure.code,
                    scenario.endsWith("limit")
                        ? "ARTIFACT_LIMIT"
                        : scenario === "symlink"
                          ? "ARTIFACT_BOUNDARY"
                          : "ARTIFACT_IO",
                );
                assert.equal(failure.steps[0].status, "FAIL");
                assert.equal(failure.steps[1].status, "NOT_RUN");
                assert.match(markers, /^collection=FAILURE$/m);
            }
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

/** 新场景执行实际工作流中的同一收集器，分别模拟安装失败、空证据根、已开始但缺步骤与已有正式步骤；只有真实工作流明确证明编排未运行时才允许合成 NOT_RUN，所有新字节均须在最终集合、清单摘要和固定预算中可独立观察。 */
for (const scenario of [
    "setup-logs-only",
    "setup-empty",
    "setup-bind-failure",
    "setup-node-failure",
    "missing-unknown",
    "missing-started",
    "missing-cancelled",
    "missing-skipped-no-failure",
    "invalid-existing",
    "existing-valid",
    "setup-added-quota",
] as const)
    test(`production setup evidence collector ${scenario}`, async () => {
        const { mkdtemp, mkdir, writeFile, lstat, statfs, open, rm } = await import(
            "node:fs/promises"
        );
        const { tmpdir } = await import("node:os"),
            { createHash } = await import("node:crypto"),
            { assetWorkflowSteps } = await import("./fixtures/runtime-assets.ts");
        const base = await mkdtemp(join(tmpdir(), "veriq-setup-evidence-")),
            root = join(base, "assets"),
            meta = join(root, "metadata"),
            output = join(base, "outputs");
        await mkdir(root, { mode: 0o700 });
        await mkdir(meta, { mode: 0o700 });
        await writeFile(output, "", { mode: 0o600 });
        try {
            const space = await statfs(base, { bigint: true });
            assert.ok(space.bavail * space.bsize > 40n * 1024n ** 2n);
            const originalSteps = Buffer.from(
                ' [\n  {"step":"ACQUIRE","status":"FAIL","code":"PAYLOAD_IO","cleanup":"INCOMPLETE","actualBytes":3},\n  {"step":"OBSERVE","status":"NOT_RUN","code":null,"cleanup":null,"actualBytes":null}\n ]\n',
            );
            if (scenario === "setup-logs-only") {
                await writeFile(join(meta, "pnpm-install.log"), "installation failed", {
                    mode: 0o600,
                });
                await writeFile(join(meta, "os.log"), "ProductVersion: 15.7", { mode: 0o600 });
            }
            if (scenario === "invalid-existing")
                await writeFile(join(meta, "steps.json"), "[]", { mode: 0o600 });
            if (scenario === "existing-valid")
                await writeFile(join(meta, "steps.json"), originalSteps, { mode: 0o600 });
            if (scenario === "setup-added-quota") {
                const path = join(meta, "large.json"),
                    fd = await open(path, "wx", 0o600);
                try {
                    await fd.truncate(16 * 1024 ** 2 - 1);
                } finally {
                    await fd.close();
                }
                assert.ok((await lstat(path, { bigint: true })).blocks * 512n <= 65536n);
            }
            const outcomes = {
                BIND_OUTCOME: "success",
                NODE_SETUP_OUTCOME: "success",
                DEPENDENCIES_OUTCOME: "failure",
                ORCHESTRATION_OUTCOME: "skipped",
            };
            if (scenario === "setup-empty" || scenario === "setup-bind-failure")
                Object.assign(outcomes, {
                    BIND_OUTCOME: "failure",
                    NODE_SETUP_OUTCOME: "skipped",
                    DEPENDENCIES_OUTCOME: "skipped",
                });
            if (scenario === "setup-node-failure")
                Object.assign(outcomes, {
                    NODE_SETUP_OUTCOME: "failure",
                    DEPENDENCIES_OUTCOME: "skipped",
                });
            if (scenario === "missing-unknown")
                Object.assign(outcomes, {
                    BIND_OUTCOME: "",
                    NODE_SETUP_OUTCOME: "",
                    DEPENDENCIES_OUTCOME: "",
                    ORCHESTRATION_OUTCOME: "",
                });
            if (scenario === "missing-started" || scenario === "existing-valid")
                Object.assign(outcomes, {
                    DEPENDENCIES_OUTCOME: "success",
                    ORCHESTRATION_OUTCOME: "failure",
                });
            if (scenario === "missing-cancelled")
                Object.assign(outcomes, {
                    DEPENDENCIES_OUTCOME: "success",
                    ORCHESTRATION_OUTCOME: "cancelled",
                });
            if (scenario === "missing-skipped-no-failure")
                Object.assign(outcomes, { DEPENDENCIES_OUTCOME: "success" });
            const steps = assetWorkflowSteps(join(base, "uv-cache")),
                collector = steps.find((step) => step.id === "collect");
            const code = (collector!.run as string).match(
                /node --input-type=module <<'JS'\n([\s\S]*?)\nJS/,
            )?.[1];
            assert.ok(code);
            const trace = `import setupIO from "node:fs"; import {syncBuiltinESMExports as setupSync} from "node:module"; const setupOpen=setupIO.promises.open;let setupSourceOpens=0;setupIO.promises.open=async(path,...args)=>{if(String(path).startsWith(process.env.ASSET_ROOT+"/metadata/"))setupSourceOpens++;return setupOpen(path,...args);};setupSync();process.on("exit",()=>process.stdout.write(JSON.stringify({sourceOpens:setupSourceOpens})+"\\n"));\n`;
            const result = spawnSync(process.execPath, ["--input-type=module"], {
                input: trace + code,
                encoding: "utf8",
                timeout: 15000,
                maxBuffer: 65536,
                env: {
                    ...process.env,
                    ...outcomes,
                    ASSET_ROOT: root,
                    GITHUB_OUTPUT: output,
                    GITHUB_SHA: "a".repeat(40),
                    EXPECTED_ARCH: "x64",
                },
            });
            const markers = await readFile(output, "utf8");
            assert.match(markers, /^ready=true$/m, result.stderr);
            assert.match(markers, new RegExp(`^upload_root=${root}/upload$`, "m"));
            const uploaded = join(root, "upload"),
                manifestBytes = await readFile(join(uploaded, "manifest.json")),
                manifest = JSON.parse(manifestBytes.toString("utf8")) as {
                    files: { path: string; sizeBytes: number; sha256: string }[];
                };
            let metadataBytes = manifestBytes.length,
                logBytes = 0;
            for (const file of manifest.files) {
                const bytes = await readFile(join(uploaded, file.path));
                assert.equal(bytes.length, file.sizeBytes);
                assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
                if (file.path.endsWith(".log")) logBytes += bytes.length;
                else metadataBytes += bytes.length;
            }
            assert.ok(metadataBytes <= 16 * 1024 ** 2);
            assert.ok(logBytes <= 8 * 1024 ** 2);
            assert.match(
                markers,
                new RegExp(
                    `^manifest_sha256=${createHash("sha256").update(manifestBytes).digest("hex")}$`,
                    "m",
                ),
            );
            if (
                scenario.startsWith("missing-") ||
                scenario === "invalid-existing" ||
                scenario === "setup-added-quota"
            ) {
                assert.notEqual(result.status, 0);
                assert.match(markers, /^collection=FAILURE$/m);
                assert.deepEqual((await readdir(uploaded)).sort(), [
                    "failure.json",
                    "manifest.json",
                ]);
                const failure = JSON.parse(await readFile(join(uploaded, "failure.json"), "utf8"));
                assert.equal(failure.status, "FAIL");
                assert.ok(
                    failure.steps.every(
                        (s: { step: string }) => s.step !== "ACQUIRE" && s.step !== "OBSERVE",
                    ),
                );
                if (scenario === "setup-added-quota") {
                    assert.equal(failure.code, "ARTIFACT_LIMIT");
                    assert.equal(JSON.parse(result.stdout).sourceOpens, 0);
                } else assert.equal(failure.reason, "MISSING_EXECUTION_EVIDENCE");
            } else {
                assert.equal(result.status, 0, result.stderr);
                assert.match(markers, /^collection=FULL$/m);
                const bytes = await readFile(join(uploaded, "steps.json"));
                assert.ok(
                    manifest.files.some(
                        (file) => file.path === "steps.json" && file.sizeBytes === bytes.length,
                    ),
                );
                if (scenario === "existing-valid") {
                    assert.deepEqual(bytes, originalSteps);
                    assert.deepEqual(await readFile(join(meta, "steps.json")), originalSteps);
                } else {
                    const facts = JSON.parse(bytes.toString("utf8"));
                    assert.deepEqual(
                        facts.map((s: { step: string; status: string }) => [s.step, s.status]),
                        [
                            ["SETUP", "FAIL"],
                            ["ACQUIRE", "NOT_RUN"],
                            ["OBSERVE", "NOT_RUN"],
                        ],
                    );
                    assert.equal(facts[0].code, "PAYLOAD_IO");
                    assert.equal(facts[0].cleanup, "NOT_NEEDED");
                    assert.equal(facts[1].code, null);
                    assert.equal(facts[2].code, null);
                    await assert.rejects(lstat(join(meta, "steps.json")), { code: "ENOENT" });
                }
            }
            const env = collector!.env as Record<string, string>;
            assert.equal(env.ORCHESTRATION_OUTCOME, "${{ steps.observe.outcome }}");
            assert.equal(env.BIND_OUTCOME, "${{ steps.bind.outcome }}");
            assert.equal(env.NODE_SETUP_OUTCOME, "${{ steps.node_setup.outcome }}");
            assert.equal(env.DEPENDENCIES_OUTCOME, "${{ steps.dependencies.outcome }}");
            assert.ok(steps.some((step) => step.id === "bind"));
            assert.ok(steps.some((step) => step.id === "node_setup"));
            assert.ok(steps.some((step) => step.id === "dependencies"));
            const upload = steps.find((step) => step.id === "metadata_upload");
            assert.equal(
                upload!.if,
                "always() && steps.collect.outputs.ready == 'true' && steps.collect.outputs.upload_root == format('{0}/upload', env.ASSET_ROOT)",
            );
            assert.equal(
                (upload!.with as Record<string, unknown>).path,
                "${{ env.ASSET_ROOT }}/upload/",
            );
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

/** 归一化回归先让真实快照扫描产生带头事实的拒绝，再交正式失败出口清理事务并更换异常对象；仅被选中的首错诊断可随新对象保留，公开双参数入口和原错误字段不能因诊断扩展而改变。 */
test("archive rejection normalization follows real cleanup without public API changes", async () => {
    const { mkdtemp, mkdir, rm, statfs } = await import("node:fs/promises"),
        { tmpdir } = await import("node:os"),
        { RuntimePayloadError } = await import("../scripts/runtime-payload-inputs.ts"),
        { assetFailure, observeMacRuntimeAssets } = await import(
            "../scripts/runtime-assets-observation.ts"
        ),
        { archiveRejectionLine } = await import("../scripts/runtime-payload-archive.ts"),
        { tarBytes } = await import("./fixtures/runtime-payload-archives.ts");
    const base = await mkdtemp(join(tmpdir(), "veriq-normalized-rejection-"));
    const input = join(base, "input"),
        output = join(base, "output");
    await mkdir(input, { mode: 0o700 });
    await mkdir(output, { mode: 0o700 });
    const tx = new ArchiveTransaction(input, output, "observed");
    try {
        const free = await statfs(base);
        assert.ok(free.bavail * free.bsize > 40 * 1024 ** 2);
        await tx.initialize();
        tx.phase = "INTAKE";
        const [, chrome] = tinyAssets();
        const refs = [
            await tx.write(
                "snapshots/node.tar.gz",
                once(tarBytes([{ path: "node-v24.22.1-darwin-x64/item", type: "FIFO" }])),
            ),
            await tx.write("snapshots/chrome.zip", once(chrome)),
        ] as const;
        let original: InstanceType<typeof RuntimePayloadError> | undefined;
        await assert.rejects(scanObservedSnapshots(tx, "x64", refs), (error: unknown) => {
            assert.ok(error instanceof RuntimePayloadError);
            original = error;
            return true;
        });
        assert.ok(original);
        const selected = original;
        const line = archiveRejectionLine(selected);
        assert.ok(line);
        await assert.rejects(assetFailure(tx, selected), (normalized: unknown) => {
            assert.ok(normalized instanceof RuntimePayloadError);
            assert.notEqual(normalized, selected);
            assert.equal(normalized.code, selected.code);
            assert.equal(normalized.causeCode, selected.causeCode);
            assert.equal(normalized.cleanup, "CONFIRMED");
            assert.equal(normalized.phase, "INTAKE");
            assert.equal(archiveRejectionLine(normalized), line);
            assert.deepEqual(Object.keys(normalized), Object.keys(selected));
            return true;
        });
        assert.deepEqual(await readdir(output), []);
        assert.equal(observeMacRuntimeAssets.length, 2);
    } finally {
        await tx.cleanup();
        await rm(base, { recursive: true, force: true });
    }
});

/** 输出回归在独立宿主 Node 子进程调用 CLI 实际使用的有限报告函数，并以关闭管道和异步写错误验证首错退出码；子进程没有官方来源伪装或目标程序，观察仅限原公共行顺序、单事件与空标准输出。 */
for (const failure of ["none", "sync", "async"] as const) {
    test(`archive rejection CLI emitter preserves primary outcome on ${failure} output`, () => {
        const source = `
import { RuntimePayloadError } from "./scripts/runtime-payload-inputs.ts";
import { attachArchiveRejection, emitArchiveFailure } from "./scripts/runtime-payload-archive.ts";
const error = new RuntimePayloadError("PAYLOAD_ARCHIVE_UNSUPPORTED", null, "CONFIRMED", { phase: "INTAKE", candidateDirectory: null });
attachArchiveRejection(error, { archive: "node", stage: "TAR_FRAME", reason: "TAR_ENTRY_TYPE" });
if (${JSON.stringify(failure)} === "sync") process.stderr.write = () => { throw Error("CLOSED_PIPE"); };
if (${JSON.stringify(failure)} === "async") process.stderr.write = () => { queueMicrotask(() => process.stderr.emit("error", Error("CLOSED_PIPE"))); return false; };
emitArchiveFailure(error, 17);
`;
        const child = spawnSync(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "-e", source],
            { encoding: "utf8" },
        );
        assert.equal(child.status, 17);
        assert.equal(child.stdout, "");
        if (failure === "none") {
            const lines = child.stderr.trim().split("\n");
            assert.equal(lines.length, 2);
            assert.equal(lines[0], "PAYLOAD_ARCHIVE_UNSUPPORTED phase=INTAKE cleanup=CONFIRMED");
            assert.equal(JSON.parse(lines[1]!).reason, "TAR_ENTRY_TYPE");
        } else assert.equal(child.stderr, "");
    });
}

/** 实际观察助手先完成 Node 快照再读取带原始选项位的 Stored Chrome 成员，正文摘要与原模式必须来自成熟扫描结果；微型布局只得到原有待审状态，不能借兼容修正宣称官方来源或完整 Runtime 已通过验收。 */
test("production snapshot helper observes stored options without rewriting flags", async () =>
    assetsFixture(async (f) => {
        const { statfs, lstat } = await import("node:fs/promises"),
            { tarBytes, zipBytes } = await import("./fixtures/runtime-payload-archives.ts"),
            { crc32 } = await import("node:zlib");
        const free = await statfs(f.output);
        assert.ok(free.bavail * free.bsize > 40 * 1024 ** 2);
        const body = "s".repeat(2018),
            memberPath =
                "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            node = tarBytes([{ path: "node-v24.22.1-darwin-x64/bin/node", body: "tiny Node" }]),
            chrome = zipBytes([{ path: memberPath, body }], 0),
            central = chrome.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        chrome.writeUInt16LE(4, 6);
        chrome.writeUInt16LE(4, central + 8);
        const original = Buffer.from(chrome);
        assert.ok(node.length <= 1024 ** 2 && chrome.length <= 1024 ** 2);
        assert.equal(chrome.readUInt32LE(central + 16), crc32(Buffer.from(body)));
        const tx = new ArchiveTransaction(f.root, f.output, "stored-scan");
        await tx.initialize();
        try {
            const refs = [
                await tx.write("snapshots/node.tar.gz", once(node)),
                await tx.write("snapshots/chrome.zip", once(chrome)),
            ] as const;
            const result = await scanObservedSnapshots(tx, "x64", refs);
            assert.equal(result.archives[0].fileCount, 1);
            assert.equal(result.archives[0].snapshot.sha256, fact("node", node).sha256);
            assert.equal(result.archives[1].fileCount, 1);
            assert.equal(result.archives[1].expandedBytes, body.length);
            assert.equal(result.archives[1].crc, "ZIP_EACH_ENTRY");
            assert.equal(result.archives[1].zipLocalDataRanges, "CHECKED");
            assert.equal(result.chromeLayout.status, "REQUIRES_LAYOUT_REVIEW");
            assert.equal(result.chromeLayout.executableFileObserved, true);
            const members = JSON.parse(
                await readFile(join(tx.scratch, "members/chrome.json"), "utf8"),
            );
            assert.deepEqual(members.members, [
                {
                    path: memberPath,
                    kind: "file",
                    mode: 0o644,
                    sizeBytes: body.length,
                    sha256: fact("body", Buffer.from(body)).sha256,
                },
            ]);
            const modes = JSON.parse(
                await readFile(join(tx.scratch, "evidence/zip-modes.json"), "utf8"),
            );
            assert.equal(modes.entries.length, 1);
            assert.equal(modes.entries[0].state, "EXPLICIT_UNIX");
            assert.equal(modes.entries[0].host, 3);
            assert.equal(modes.entries[0].rawMode, 0o100644);
            const snapshot = await readFile(join(tx.scratch, refs[1].path));
            assert.deepEqual(snapshot, original);
            assert.equal(snapshot.readUInt16LE(6), 4);
            assert.equal(snapshot.readUInt16LE(central + 8), 4);
            assert.deepEqual(await readdir(join(tx.scratch, "trees/chrome")), []);
            assert.deepEqual(await readdir(join(tx.scratch, "trees/node")), []);
            await tx.audit();
            const allocated = async (path: string): Promise<number> => {
                const info = await lstat(path);
                let total = info.blocks * 512;
                if (info.isDirectory())
                    for (const name of await readdir(path))
                        total += await allocated(join(path, name));
                return total;
            };
            assert.ok((await allocated(f.root)) + (await allocated(f.output)) <= 2 * 1024 ** 2);
        } finally {
            assert.equal(await tx.cleanup(), "CONFIRMED");
        }
    }));
