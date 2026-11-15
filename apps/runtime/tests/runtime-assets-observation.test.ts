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
