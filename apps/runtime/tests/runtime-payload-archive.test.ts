import assert from "node:assert/strict";
import test from "node:test";
import { Pax } from "tar";
import { gunzipSync, gzipSync } from "node:zlib";
import { mkdtemp, rm, readFile, lstat, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    verifyRuntimePayloadInputs,
    RuntimePayloadError,
} from "../scripts/runtime-payload-inputs.ts";
import { intakeRuntimeArchives } from "../scripts/runtime-payload-archive.ts";
import { fixture, hash } from "./fixtures/runtime-payload.ts";
import {
    archiveModel,
    tarBytes,
    zipBytes,
    type ArchiveFixtureEntry,
} from "./fixtures/runtime-payload-archives.ts";

for (const arch of ["x64", "arm64"] as const)
    test(`real ${arch} archives publish private ordinary trees and immutable receipt`, async () => {
        const output = await mkdtemp(join(tmpdir(), "veriq-intake-output-"));
        try {
            await fixture(async (f) => {
                const input = await f.save();
                await verifyRuntimePayloadInputs(input, f.expected, { inputRoot: f.root });
                const result = await intakeRuntimeArchives(input, f.expected, {
                    inputRoot: f.root,
                    outputParent: output,
                    candidateName: "candidate",
                });
                assert.equal(result.committed, true);
                assert.equal(result.cleanup, "CONFIRMED");
                assert.equal(result.directory, join(output, "candidate"));
                assert.ok(Object.isFrozen(result.receipt.archives[0]!.members));
                assert.deepEqual(
                    JSON.parse(
                        await readFile(join(result.directory, "archive-intake.json"), "utf8"),
                    ),
                    result.receipt,
                );
                assert.equal(
                    hash(await readFile(join(result.directory, "archive-intake.json"))),
                    result.receiptSha256,
                );
                for (const kind of ["node", "chrome"] as const) {
                    const snapshot = await lstat(
                        join(
                            result.directory,
                            "snapshots",
                            kind === "node" ? "node.tar.gz" : "chrome.zip",
                        ),
                    );
                    assert.equal(snapshot.nlink, 1);
                    assert.equal(snapshot.mode & 0o777, 0o600);
                    assert.notEqual(
                        snapshot.ino,
                        (await lstat(join(f.root, f.recipe[kind].file.path))).ino,
                    );
                    assert.equal(
                        hash(await readFile(join(f.root, f.recipe[kind].file.path))),
                        f.recipe[kind].file.sha256,
                    );
                    assert.equal(
                        hash(
                            await readFile(
                                join(
                                    result.directory,
                                    "snapshots",
                                    kind === "node" ? "node.tar.gz" : "chrome.zip",
                                ),
                            ),
                        ),
                        f.recipe[kind].file.sha256,
                    );
                    const visit = async (path: string): Promise<void> => {
                        const info = await lstat(path);
                        assert.ok(!info.isSymbolicLink());
                        assert.equal(info.mode & 0o777, info.isDirectory() ? 0o700 : 0o600);
                        if (info.isDirectory())
                            for (const name of await readdir(path)) await visit(join(path, name));
                    };
                    await visit(join(result.directory, "trees", kind));
                    for (const member of result.receipt.archives.find((a) => a.kind === kind)!
                        .members) {
                        if (member.kind === "file")
                            assert.equal(
                                hash(
                                    await readFile(
                                        join(result.directory, "trees", kind, member.path),
                                    ),
                                ),
                                member.sha256,
                            );
                        if (member.kind === "link")
                            await assert.rejects(
                                lstat(join(result.directory, "trees", kind, member.path)),
                                { code: "ENOENT" },
                            );
                    }
                }
                assert.deepEqual(await readdir(output), ["candidate"]);
            }, archiveModel(arch));
        } finally {
            await rm(output, { recursive: true, force: true });
        }
    });

/** 每个拒绝案例独占真实输入和输出目录，并确认没有已发布候选或误删外部哨兵；错误断言接受正式稳定分类集合，避免底层压缩库异常或测试夹具载入失败冒充所需安全行为。 */
async function refuses(
    change: (m: ReturnType<typeof archiveModel>) => void,
    codes: readonly string[],
) {
    const value = archiveModel();
    change(value);
    const outer = await mkdtemp(join(tmpdir(), "veriq-intake-reject-")),
        output = join(outer, "output");
    await mkdir(output, { mode: 0o700 });
    await writeFile(join(outer, "outside-sentinel"), "outside sentinel");
    try {
        await fixture(async (f) => {
            await assert.rejects(
                intakeRuntimeArchives(await f.save(), f.expected, {
                    inputRoot: f.root,
                    outputParent: output,
                    candidateName: "candidate",
                }),
                (e: unknown) => e instanceof RuntimePayloadError && codes.includes(e.code),
            );
            assert.deepEqual(await readdir(output), []);
            assert.equal(
                await readFile(join(outer, "outside-sentinel"), "utf8"),
                "outside sentinel",
            );
        }, value);
    } finally {
        await rm(outer, { recursive: true, force: true });
    }
}
for (const entry of [
    { path: "../escape", body: "outside" },
    { path: "/absolute", body: "outside" },
    { path: "TOP/Case/x", body: "one" },
    { path: "TOP/special", type: "Link", target: "file" },
    { path: "TOP/special", type: "FIFO" },
    { path: "TOP/special", type: "GNUDumpDir" },
    { path: "TOP/special", mode: 0o4755, body: "bad mode" },
] satisfies ArchiveFixtureEntry[])
    test(`tar rejects unsafe entry ${JSON.stringify(entry)}`, () =>
        refuses(
            (m) => {
                const path = entry.path.replace("TOP", m.recipe.node.topDirectory);
                const extra = [{ ...entry, path }];
                if (path.endsWith("/Case/x"))
                    extra.push({ path: path.replace("Case/x", "case/y"), body: "two" });
                m.bind(tarBytes([...m.nodeEntries, ...extra]));
            },
            ["PAYLOAD_PATH", "PAYLOAD_COLLISION", "PAYLOAD_ARCHIVE_UNSUPPORTED"],
        ));
for (const extra of [
    [{ path: "../escape", body: "x" }],
    [{ path: "/absolute", body: "x" }],
    [
        { path: "TOP/A/x", body: "x" },
        { path: "TOP/a/y", body: "y" },
    ],
    [
        { path: "TOP/duplicate", body: "x" },
        { path: "TOP/duplicate", body: "y" },
    ],
    [
        { path: "TOP/a", kind: "link", target: "LICENSE" },
        { path: "TOP/a/file", body: "x" },
    ],
    [{ path: "TOP/special", mode: 0o4755, body: "x" }],
] satisfies ArchiveFixtureEntry[][])
    test(`ZIP rejects unsafe physical paths ${JSON.stringify(extra)}`, () =>
        refuses(
            (m) =>
                m.bind(
                    undefined,
                    zipBytes([
                        ...m.chromeEntries,
                        ...extra.map((e) => ({
                            ...e,
                            path: e.path.replace("TOP", m.recipe.chrome.topDirectory),
                        })),
                    ]),
                ),
            [
                "PAYLOAD_PATH",
                "PAYLOAD_COLLISION",
                "PAYLOAD_ARCHIVE_FORMAT",
                "PAYLOAD_ARCHIVE_UNSUPPORTED",
            ],
        ));
for (const target of ["../../outside", "missing", ".", "../Versions"])
    test(`logical links reject escape dangling and graph cycles ${target}`, () =>
        refuses(
            (m) => {
                const link = m.chromeEntries.find((e) => e.kind === "link")!;
                link.target = target;
                m.chromeLayout.layout.allowedLinks.find(
                    (l) => l.path === `browser/${link.path}`,
                )!.target = target;
                m.bind();
            },
            ["PAYLOAD_ARCHIVE_LINK", "PAYLOAD_PATH"],
        ));
test("all Node links must exactly equal independent inputLinks", () =>
    refuses(
        (m) => {
            m.nodeReceipt.inputLinks = [];
            m.bind();
        },
        ["PAYLOAD_ARCHIVE_LINK"],
    ));
test("tar must reject truncated complete gzip payload and nonzero trailing garbage", async () => {
    await refuses(
        (m) => m.bind(tarBytes(m.nodeEntries, Buffer.alloc(512))),
        ["PAYLOAD_ARCHIVE_FORMAT"],
    );
    await refuses(
        (m) =>
            m.bind(
                tarBytes(m.nodeEntries, Buffer.concat([Buffer.alloc(1024), Buffer.from("junk")])),
            ),
        ["PAYLOAD_ARCHIVE_FORMAT"],
    );
});
test("gzip CRC trailer corruption is consumed and rejected after tar EOF", () =>
    refuses(
        (m) => {
            const data = tarBytes(m.nodeEntries);
            data[data.length - 8]! ^= 1;
            m.bind(data);
        },
        ["PAYLOAD_ARCHIVE_CRC"],
    ));
test("stored ZIP wrong member CRC is rejected on actual content", () =>
    refuses(
        (m) => {
            const data = zipBytes(m.chromeEntries, 0);
            const at = data.indexOf(Buffer.from("synthetic Chrome binary"));
            assert.ok(at > 0);
            data[at]! ^= 1;
            m.bind(undefined, data);
        },
        ["PAYLOAD_ARCHIVE_CRC"],
    ));
test("ZIP local header name and central record must agree", () =>
    refuses(
        (m) => {
            const data = zipBytes(m.chromeEntries);
            data[30]! ^= 1;
            m.bind(undefined, data);
        },
        ["PAYLOAD_ARCHIVE_RANGE"],
    ));
test("directory entries never carry an unchecked body", () =>
    refuses(
        (m) =>
            m.bind(
                undefined,
                zipBytes([
                    ...m.chromeEntries,
                    { path: `${m.recipe.chrome.topDirectory}/body/`, kind: "directory", body: "x" },
                ]),
            ),
        ["PAYLOAD_ARCHIVE_FORMAT"],
    ));

/** PAX 反例通过成熟 Header 编码器生成真实元数据帧，长度数字仍由 Pax.parse 解释而非测试预先替产品校验；这些案例专门证明未知、重复、size 覆盖与静默丢弃记录会失败，不能只靠 raw 关键字过滤假称支持完整 PAX。 */
for (const body of [
    "99 path=ignored\n",
    "14 unknown=x\n",
    "10 size=0\n",
    "12 path=abc\n12 path=abc\n",
    "24 GNU.sparse.size=0\n",
])
    test(`PAX unsupported or dropped record ${JSON.stringify(body)}`, () =>
        refuses(
            (m) =>
                m.bind(
                    tarBytes([
                        { path: "PaxHeader", type: "ExtendedHeader", body },
                        ...m.nodeEntries,
                    ]),
                ),
            ["PAYLOAD_ARCHIVE_UNSUPPORTED"],
        ));
test("tar large metadata declaration rejects before allocating its body", () =>
    refuses(
        (m) =>
            m.bind(
                tarBytes([
                    { path: "PaxHeader", type: "ExtendedHeader", declaredSize: 65537, body: "" },
                ]),
            ),
        ["PAYLOAD_LIMIT"],
    ));
test("tar member larger than fixed limit rejects small declaration-only fixture", () =>
    refuses(
        (m) =>
            m.bind(
                tarBytes([
                    { path: `${m.recipe.node.topDirectory}/huge`, declaredSize: 2 ** 31 + 1 },
                ]),
            ),
        ["PAYLOAD_LIMIT"],
    ));

/** 正常 PAX 和 GNU 元数据必须由成熟 Parser 应用后再核有效成员路径，不能只因严格拒绝所有 meta 就让恶意样本通过测试；单个正常场景还保留 late explicit parent 与多个有限 Framework 别名，保证推导和共享终点不是误判循环。 */
test("supported PAX fields GNU long paths and later explicit parent retain actual facts", async () => {
    const m = archiveModel(),
        first = m.nodeEntries[0]!;
    const pax = new Pax({
        path: first.path,
        uid: 20,
        gid: 30,
        uname: "owner",
        gname: "group",
        mtime: new Date(1000),
        atime: new Date(2000),
        ctime: new Date(3000),
    }).encodeBody();
    const entries = [
        { path: "PaxHeader", type: "ExtendedHeader" as const, body: pax },
        { ...first, path: "placeholder" },
        ...m.nodeEntries.slice(1),
        {
            path: "LongName",
            type: "NextFileHasLongPath" as const,
            body: `${m.recipe.node.topDirectory}/GNU-LICENSE\0`,
        },
        { path: "placeholder", body: "gnu body" },
        { path: `${m.recipe.node.topDirectory}/`, kind: "directory" as const },
    ];
    const alias = m.chromeEntries.find((e) => e.kind === "link")!;
    m.chromeEntries.push({
        path: alias.path.replace("Versions/Current", "AliasA"),
        kind: "link",
        target: "Versions/A",
    });
    m.chromeLayout.layout.allowedLinks.push({
        path: `browser/${m.chromeEntries.at(-1)!.path}`,
        target: "Versions/A",
    });
    m.bind(tarBytes(entries));
    const output = await mkdtemp(join(tmpdir(), "veriq-intake-pax-"));
    try {
        await fixture(async (f) => {
            const result = await intakeRuntimeArchives(await f.save(), f.expected, {
                inputRoot: f.root,
                outputParent: output,
                candidateName: "candidate",
            });
            const members = result.receipt.archives[0]!.members;
            assert.ok(
                members.some((e) => e.path === first.path && e.kind === "file" && e.mode === 0o755),
            );
            assert.ok(members.some((e) => e.path.endsWith("/GNU-LICENSE")));
            assert.equal(members.filter((e) => e.kind === "directory").length, 1);
        }, m);
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});
for (const change of ["overlap", "bounds", "method", "encrypted", "crc-local"] as const)
    test(`ZIP public metadata boundary ${change}`, () =>
        refuses(
            (m) => {
                const data = zipBytes(m.chromeEntries);
                const first = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
                assert.ok(first > 0);
                if (change === "overlap") {
                    const second = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), first + 4);
                    data.writeUInt32LE(0, second + 42);
                }
                if (change === "bounds") data.writeUInt32LE(data.length + 1, first + 20);
                if (change === "method") {
                    data.writeUInt16LE(99, 8);
                    data.writeUInt16LE(99, first + 10);
                }
                if (change === "encrypted") {
                    data.writeUInt16LE(1, 6);
                    data.writeUInt16LE(1, first + 8);
                }
                if (change === "crc-local") data.writeUInt32LE(0, 14);
                m.bind(undefined, data);
            },
            ["PAYLOAD_ARCHIVE_RANGE", "PAYLOAD_ARCHIVE_FORMAT", "PAYLOAD_ARCHIVE_UNSUPPORTED"],
        ));
test("tar checksum sparse truncation and padding are checked independently", async () => {
    await refuses(
        (m) => {
            const data = gunzipSync(tarBytes(m.nodeEntries));
            data[148]! ^= 1;
            m.bind(gzipSync(data));
        },
        ["PAYLOAD_ARCHIVE_FORMAT"],
    );
    await refuses(
        (m) =>
            m.bind(
                tarBytes([{ path: `${m.recipe.node.topDirectory}/sparse`, type: "SparseFile" }]),
            ),
        ["PAYLOAD_ARCHIVE_UNSUPPORTED"],
    );
    await refuses(
        (m) => {
            const data = tarBytes(m.nodeEntries);
            m.bind(data.subarray(0, data.length - 4));
        },
        ["PAYLOAD_ARCHIVE_CRC"],
    );
    await refuses(
        (m) => {
            const data = gunzipSync(tarBytes(m.nodeEntries));
            data[512 + Buffer.byteLength(m.nodeEntries[0]!.body!)] = 1;
            m.bind(gzipSync(data));
        },
        ["PAYLOAD_ARCHIVE_FORMAT"],
    );
});
test("Node physical directory and logical alias graph rejects cycles without expanding aliases", () =>
    refuses(
        (m) => {
            const link = {
                path: `${m.recipe.node.topDirectory}/lib/up`,
                kind: "link" as const,
                target: "..",
            };
            m.nodeEntries.push(link);
            m.nodeReceipt.inputLinks.push({ path: link.path, target: link.target });
            m.bind();
        },
        ["PAYLOAD_ARCHIVE_LINK"],
    ));
test("logical link hops stay bounded even for a chain with an ordinary endpoint", () =>
    refuses(
        (m) => {
            for (let i = 0; i < 34; i++) {
                const link = {
                    path: `${m.recipe.node.topDirectory}/link${i}`,
                    kind: "link" as const,
                    target: i === 33 ? "LICENSE" : `link${i + 1}`,
                };
                m.nodeEntries.push(link);
                m.nodeReceipt.inputLinks.push({ path: link.path, target: link.target });
            }
            m.bind();
        },
        ["PAYLOAD_ARCHIVE_LINK"],
    ));

/** bit3 只表示 local 尺寸可能依赖 descriptor，产品仍以 central 声明和真实内容 CRC 为权威；夹具故意清零 local 副本证明不会误拒该允许标志，同时零正文显式目录也必须走正常解压长度与 CRC 检查路径，未宣称验证 descriptor 全语法。 */
test("ZIP allows bit3 central-authoritative entries and explicit empty directories", async () => {
    const m = archiveModel();
    m.chromeEntries.push({ path: `${m.recipe.chrome.topDirectory}/empty/`, kind: "directory" });
    const zip = zipBytes(m.chromeEntries);
    for (let at = 0; at < zip.length - 4; at++) {
        const sig = zip.readUInt32LE(at);
        if (sig === 0x04034b50) {
            zip.writeUInt16LE(zip.readUInt16LE(at + 6) | 8, at + 6);
            zip.fill(0, at + 14, at + 26);
        }
        if (sig === 0x02014b50) zip.writeUInt16LE(zip.readUInt16LE(at + 8) | 8, at + 8);
    }
    m.bind(undefined, zip);
    const output = await mkdtemp(join(tmpdir(), "veriq-intake-bit3-"));
    try {
        await fixture(async (f) => {
            const result = await intakeRuntimeArchives(await f.save(), f.expected, {
                inputRoot: f.root,
                outputParent: output,
                candidateName: "candidate",
            });
            assert.ok(
                result.receipt.archives[1]!.members.some(
                    (e) => e.path.endsWith("/empty") && e.kind === "directory",
                ),
            );
        }, m);
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});

/** 原归档在首次真实读取前变动仍必须按原配方固定摘要与长度拒绝，不能因为之后能解包就接受更新来源；两种篡改分别保留长度或改变长度，输出父目录必须保持空白，表明错误不会产生可被误认成功的半候选。 */
for (const change of ["hash", "size"] as const)
    test(`original archive ${change} mutation rejects without publishing`, () =>
        refuses(
            (m) => {
                const ref = m.recipe.node.file,
                    data = Buffer.from(m.data.get(ref.path)!);
                if (change === "hash") {
                    data[10]! ^= 1;
                    m.data.set(ref.path, data);
                } else m.data.set(ref.path, Buffer.concat([data, Buffer.from("x")]));
            },
            ["PAYLOAD_TREE_MISMATCH"],
        ));

/** Framework 名称属于独立布局准入政策，实际归档没有任何链接时也必须核验声明根而不能靠遍历链接触发；同一真实微型 ZIP 同时覆盖空 basename 拒绝和合法非空 basename 成功，仍从独立布局及原配方完整重绑开始。 */
for (const basename of [".framework", "Named.framework"])
    test(`fix1 declared Framework root ${basename} is checked without any links`, async () => {
        const value = archiveModel();
        const members = value.chromeEntries
            .filter((e) => e.kind !== "link")
            .map((e) => ({ ...e, path: e.path.replace("Test.framework", basename) }));
        value.chromeEntries.splice(0, value.chromeEntries.length, ...members);
        value.chromeLayout.layout.frameworkRoots = value.chromeLayout.layout.frameworkRoots.map(
            (p) => p.replace("Test.framework", basename),
        );
        value.chromeLayout.layout.allowedLinks = [];
        value.bind();
        const output = await mkdtemp(join(tmpdir(), "veriq-framework-policy-"));
        try {
            await fixture(async (f) => {
                const pending = intakeRuntimeArchives(await f.save(), f.expected, {
                    inputRoot: f.root,
                    outputParent: output,
                    candidateName: "candidate",
                });
                if (basename === ".framework") {
                    await assert.rejects(
                        pending,
                        (e: unknown) =>
                            e instanceof RuntimePayloadError &&
                            e.code === "PAYLOAD_ARCHIVE_LINK" &&
                            e.phase === "INTAKE" &&
                            e.cleanup === "CONFIRMED",
                    );
                    assert.deepEqual(await readdir(output), []);
                } else {
                    const result = await pending;
                    assert.equal(result.committed, true);
                    assert.equal(result.cleanup, "CONFIRMED");
                    assert.ok(result.receipt.archives[1]!.members.every((m) => m.kind !== "link"));
                    assert.ok(
                        (
                            await lstat(
                                join(
                                    result.directory,
                                    "trees/chrome",
                                    value.chromeLayout.layout.frameworkRoots[0]!.slice(
                                        "browser/".length,
                                    ),
                                ),
                            )
                        ).isDirectory(),
                    );
                }
            }, value);
        } finally {
            await rm(output, { recursive: true, force: true });
        }
    });

/** 自包含回归在真正独立的 Node 子进程等待生产 tar 消费者自然结束，父级期限只把卡住分类为失败而不充当完成事件；夹具使用成熟 tar 编码器与真实摘要，每次仅拥有一个小归档并在进程已结束后删除，绝不借私有证据或伪造官方身份。 */
async function naturalTarChild(
    size: number,
    scenario: "ordinary" | "low-compressible" | "cancel" | "member-error" | "zero-tail",
) {
    const { spawnSync } = await import("node:child_process"),
        { statfs } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "veriq-natural-tar-"));
    try {
        const space = await statfs(root, { bigint: true });
        assert.ok(space.bavail * space.bsize > 40n * 1024n ** 2n);
        const moduleUrl = (name: string) => new URL(`../scripts/${name}.ts`, import.meta.url).href;
        const code = `import ${JSON.stringify(moduleUrl("runtime-payload-inputs"))};
import { RuntimePayloadError } from ${JSON.stringify(moduleUrl("runtime-payload-inputs"))};
import { ArchiveTransaction } from ${JSON.stringify(moduleUrl("runtime-payload-transaction"))};
import { ArchiveScan, ArchiveBudget } from ${JSON.stringify(moduleUrl("runtime-payload-archive"))};
import { scanTar } from ${JSON.stringify(moduleUrl("runtime-payload-tar"))};
import { tarBytes } from ${JSON.stringify(new URL("./fixtures/runtime-payload-archives.ts", import.meta.url).href)};
import { createHash } from "node:crypto";
import { mkdir, writeFile, lstat, opendir, readFile } from "node:fs/promises";
import { join } from "node:path";
const root=${JSON.stringify(root)}, size=${size}, scenario=${JSON.stringify(scenario)}, top="node-v24.22.1-darwin-x64";
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const emit=value=>process.stdout.write(JSON.stringify(value)+"\\n");let phase="PREPARE",reported=false;
process.on("beforeExit",()=>{if(!reported){reported=true;emit({event:"BEFORE_EXIT",phase});}});
if(!/^24\\./.test(process.versions.node))throw Error("NODE24_REQUIRED");
let body="a".repeat(size);
if(scenario==="low-compressible"){const chunks=[];for(let i=0,n=0;n<size;i++,n+=64)chunks.push(hash(Buffer.from("veriq-tar-boundary:"+i)));body=chunks.join("").slice(0,size);}
const bodyBytes=Buffer.from(body),archive=tarBytes([{path:top+"/empty/",kind:"directory"},{path:top+"/payload",body},{path:top+"/after",body:"tail"}],Buffer.alloc(scenario==="zero-tail"?1031:1024));
if(bodyBytes.length>1024**2||archive.length>512*1024||(scenario==="low-compressible"&&archive.length<=65536))throw Error("FIXTURE_BOUND");
const input=join(root,"input"),output=join(root,"output");await mkdir(input,{mode:0o700});await mkdir(output,{mode:0o700});await writeFile(join(input,"node.tar.gz"),archive,{mode:0o600});
const controller=new AbortController(),tx=new ArchiveTransaction(input,output,"candidate",controller.signal),ref={path:"node.tar.gz",sizeBytes:archive.length,sha256:hash(archive)};
await tx.initialize();await tx.observeRefs([ref]);await tx.plan(archive.length+bodyBytes.length+4096,4);
phase="SNAPSHOT";await tx.snapshot(ref,"snapshots/node.tar.gz");await tx.audit();emit({event:"SNAPSHOT_DONE",archiveBytes:archive.length,archiveSha256:ref.sha256,node:process.versions.node});
const budget=new ArchiveBudget(),scan=new ArchiveScan("node",top,tx,budget);
if(scenario==="cancel"||scenario==="member-error"){
    const actual=scan.entry.bind(scan);let injected=false;
    scan.entry=(entry,chunks)=>actual(entry,(async function*(){for await(const chunk of chunks){if(!injected&&entry.path===top+"/payload"){injected=true;if(scenario==="cancel")controller.abort();else throw new RuntimePayloadError("PAYLOAD_IO","ENOSPC");}yield chunk;}})());
}
try{
    phase="SCAN";emit({event:"SCAN_BEGIN"});const streamBytes=await scanTar(join(tx.scratch,"snapshots/node.tar.gz"),scan);
    if(scenario==="cancel"||scenario==="member-error")throw Error("EXPECTED_REJECTION");
    const member=scan.members.find(m=>m.path===top+"/payload");
    if(scan.members.length!==3||member?.kind!=="file"||member.sizeBytes!==size||member.sha256!==hash(bodyBytes))throw Error("MEMBER_MISMATCH");
    emit({event:"SCAN_DONE",streamBytes,member});
    phase="SECOND_SCAN";await scanTar(join(tx.scratch,"snapshots/node.tar.gz"),new ArchiveScan("node",top,tx,budget,scan));await tx.audit();
    if(hash(await readFile(join(tx.scratch,"trees/node",top,"payload")))!==hash(bodyBytes))throw Error("SECOND_PASS_MISMATCH");
    let allocated=0;const walk=async path=>{const info=await lstat(path,{bigint:true});allocated+=Number(info.blocks*512n);if(info.isDirectory()){const dir=await opendir(path);for await(const entry of dir)await walk(join(path,entry.name));}};await walk(root);if(allocated>2*1024**2)throw Error("ALLOCATION_BOUND");
    phase="CLEANUP";const cleanup=await tx.cleanup();if(cleanup!=="CONFIRMED")throw Error("CLEANUP_UNCONFIRMED");phase="DONE";emit({event:"RESULT",members:scan.members.length,bodySha256:hash(bodyBytes),bodyBytes:size,archiveBytes:archive.length,allocated,cleanup});
}catch(error){
    const expected=scenario==="cancel"?"PAYLOAD_CANCELLED":scenario==="member-error"?"PAYLOAD_IO":null,cleanup=await tx.cleanup();
    if(error.code!==expected||cleanup!=="CONFIRMED"||(scenario==="member-error"&&error.causeCode!=="ENOSPC"))throw error;
    phase="REJECTED";emit({event:"EXPECTED_REJECT",code:error.code,causeCode:error.causeCode,cleanup});
}
`;
        const environment = { ...process.env };
        delete environment.NODE_TEST_CONTEXT;
        const result = spawnSync(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "-e", code],
            {
                cwd: new URL("../", import.meta.url),
                env: environment,
                encoding: "utf8",
                timeout: 15000,
                maxBuffer: 65536,
            },
        );
        assert.ok(
            !result.error,
            `Parent watchdog or child launch failed: ${result.error?.message}`,
        );
        assert.equal(
            result.status,
            0,
            `Natural child exit=${result.status}\n${result.stdout}\n${result.stderr}`,
        );
        assert.equal(result.signal, null);
        assert.equal(result.stderr, "");
        const records = result.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.ok(records.some((row) => row.event === "SNAPSHOT_DONE"));
        if (scenario === "cancel" || scenario === "member-error")
            assert.ok(
                records.some(
                    (row) => row.event === "EXPECTED_REJECT" && row.cleanup === "CONFIRMED",
                ),
            );
        else {
            assert.ok(records.some((row) => row.event === "SCAN_DONE"));
            assert.ok(
                records.some(
                    (row) =>
                        row.event === "RESULT" &&
                        row.members === 3 &&
                        row.bodyBytes === size &&
                        row.cleanup === "CONFIRMED",
                ),
            );
        }
        assert.equal(
            records.at(-1)?.phase,
            scenario === "cancel" || scenario === "member-error" ? "REJECTED" : "DONE",
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}
for (const size of [0, 1, 16383, 16384, 16385, 65535, 65536, 65537])
    test(`tar natural child boundary ${size}`, async () => naturalTarChild(size, "ordinary"));
test("tar natural child compressed reads cross64KiB", async () =>
    naturalTarChild(524301, "low-compressible"));
for (const scenario of ["cancel", "member-error"] as const)
    test(`tar natural child settles waiting producer ${scenario}`, async () =>
        naturalTarChild(65537, scenario));

test("tar natural child retains permitted partial zero tail", async () =>
    naturalTarChild(16385, "zero-tail"));
