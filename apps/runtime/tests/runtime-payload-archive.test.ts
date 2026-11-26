import assert from "node:assert/strict";
import test from "node:test";
import { Header, Pax } from "tar";
import { crc32, gunzipSync, gzipSync } from "node:zlib";
import { mkdtemp, rm, readFile, lstat, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRuntimePayloadInputs, RuntimePayloadError } from "../scripts/runtime-payload-inputs.ts";
import { intakeRuntimeArchives } from "../scripts/runtime-payload-archive.ts";
import { fixture, hash } from "./fixtures/runtime-payload.ts";
import { archiveModel, tarBytes, zipBytes, type ArchiveFixtureEntry } from "./fixtures/runtime-payload-archives.ts";

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
                    JSON.parse(await readFile(join(result.directory, "archive-intake.json"), "utf8")),
                    result.receipt,
                );
                assert.equal(hash(await readFile(join(result.directory, "archive-intake.json"))), result.receiptSha256);
                for (const kind of ["node", "chrome"] as const) {
                    const snapshot = await lstat(
                        join(result.directory, "snapshots", kind === "node" ? "node.tar.gz" : "chrome.zip"),
                    );
                    assert.equal(snapshot.nlink, 1);
                    assert.equal(snapshot.mode & 0o777, 0o600);
                    assert.notEqual(snapshot.ino, (await lstat(join(f.root, f.recipe[kind].file.path))).ino);
                    assert.equal(
                        hash(await readFile(join(f.root, f.recipe[kind].file.path))),
                        f.recipe[kind].file.sha256,
                    );
                    assert.equal(
                        hash(
                            await readFile(
                                join(result.directory, "snapshots", kind === "node" ? "node.tar.gz" : "chrome.zip"),
                            ),
                        ),
                        f.recipe[kind].file.sha256,
                    );
                    const visit = async (path: string): Promise<void> => {
                        const info = await lstat(path);
                        assert.ok(!info.isSymbolicLink());
                        assert.equal(info.mode & 0o777, info.isDirectory() ? 0o700 : 0o600);
                        if (info.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
                    };
                    await visit(join(result.directory, "trees", kind));
                    for (const member of result.receipt.archives.find((a) => a.kind === kind)!.members) {
                        if (member.kind === "file")
                            assert.equal(
                                hash(await readFile(join(result.directory, "trees", kind, member.path))),
                                member.sha256,
                            );
                        if (member.kind === "link")
                            await assert.rejects(lstat(join(result.directory, "trees", kind, member.path)), {
                                code: "ENOENT",
                            });
                    }
                }
                assert.deepEqual(await readdir(output), ["candidate"]);
            }, archiveModel(arch));
        } finally {
            await rm(output, { recursive: true, force: true });
        }
    });

/**
 * 每个拒绝案例独占真实输入和输出目录，并确认没有已发布候选或误删外部哨兵；错误断言接受正式稳定分类集合，避免底层压缩库
 * 异常或测试夹具载入失败冒充所需安全行为。
 */
async function refuses(change: (m: ReturnType<typeof archiveModel>) => void, codes: readonly string[]) {
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
            assert.equal(await readFile(join(outer, "outside-sentinel"), "utf8"), "outside sentinel");
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
                if (path.endsWith("/Case/x")) extra.push({ path: path.replace("Case/x", "case/y"), body: "two" });
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
            ["PAYLOAD_PATH", "PAYLOAD_COLLISION", "PAYLOAD_ARCHIVE_FORMAT", "PAYLOAD_ARCHIVE_UNSUPPORTED"],
        ));
for (const target of ["../../outside", "missing", ".", "../Versions"])
    test(`logical links reject escape dangling and graph cycles ${target}`, () =>
        refuses(
            (m) => {
                const link = m.chromeEntries.find((e) => e.kind === "link")!;
                link.target = target;
                m.chromeLayout.layout.allowedLinks.find((l) => l.path === `browser/${link.path}`)!.target = target;
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
    await refuses((m) => m.bind(tarBytes(m.nodeEntries, Buffer.alloc(512))), ["PAYLOAD_ARCHIVE_FORMAT"]);
    await refuses(
        (m) => m.bind(tarBytes(m.nodeEntries, Buffer.concat([Buffer.alloc(1024), Buffer.from("junk")]))),
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

/**
 * PAX 反例通过成熟 Header 编码器生成真实元数据帧，长度数字仍由 Pax.parse 解释而非测试预先替产品校验；这些案例专门证明
 * 未知、重复、size 覆盖与静默丢弃记录会失败，不能只靠 raw 关键字过滤假称支持完整
 * PAX。
 */
for (const body of [
    "99 path=ignored\n",
    "14 unknown=x\n",
    "10 size=0\n",
    "12 path=abc\n12 path=abc\n",
    "24 GNU.sparse.size=0\n",
])
    test(`PAX unsupported or dropped record ${JSON.stringify(body)}`, () =>
        refuses(
            (m) => m.bind(tarBytes([{ path: "PaxHeader", type: "ExtendedHeader", body }, ...m.nodeEntries])),
            ["PAYLOAD_ARCHIVE_UNSUPPORTED"],
        ));
test("tar large metadata declaration rejects before allocating its body", () =>
    refuses(
        (m) => m.bind(tarBytes([{ path: "PaxHeader", type: "ExtendedHeader", declaredSize: 65537, body: "" }])),
        ["PAYLOAD_LIMIT"],
    ));
test("tar member larger than fixed limit rejects small declaration-only fixture", () =>
    refuses(
        (m) => m.bind(tarBytes([{ path: `${m.recipe.node.topDirectory}/huge`, declaredSize: 2 ** 31 + 1 }])),
        ["PAYLOAD_LIMIT"],
    ));

/**
 * 正常 PAX 和 GNU 元数据必须由成熟 Parser 应用后再核有效成员路径，不能只因严格拒绝所有 meta 就让恶意样本通过测试；单个
 * 正常场景还保留 late explicit parent 与多个有限 Framewor
 * k 别名，保证推导和共享终点不是误判循环。
 */
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
            assert.ok(members.some((e) => e.path === first.path && e.kind === "file" && e.mode === 0o755));
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
        (m) => m.bind(tarBytes([{ path: `${m.recipe.node.topDirectory}/sparse`, type: "SparseFile" }])),
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

/**
 * bit3 只表示 local 尺寸可能依赖 descriptor，产品仍以 central 声明和真实内容 CRC 为权威；夹具故意清零 local 副本证明不
 * 会误拒该允许标志，同时零正文显式目录也必须走正常解压长度与 CRC
 * 检查路径，未宣称验证 descriptor 全语法。
 */
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
                result.receipt.archives[1]!.members.some((e) => e.path.endsWith("/empty") && e.kind === "directory"),
            );
        }, m);
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});

/**
 * 原归档在首次真实读取前变动仍必须按原配方固定摘要与长度拒绝，不能因为之后能解包就接受更新来源；两种篡改分别保留长度或
 * 改变长度，输出父目录必须保持空白，表明错误不会产生可被误认成功的半候选。
 */
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

/**
 * Framework 名称属于独立布局准入政策，实际归档没有任何链接时也必须核验声明根而不能靠遍历链接触发；同一真实微型 ZIP 同
 * 时覆盖空 basename 拒绝和合法非空 basename 成功，仍从独立布局及原配方完整重绑
 * 开始。
 */
for (const basename of [".framework", "Named.framework"])
    test(`fix1 declared Framework root ${basename} is checked without any links`, async () => {
        const value = archiveModel();
        const members = value.chromeEntries
            .filter((e) => e.kind !== "link")
            .map((e) => ({ ...e, path: e.path.replace("Test.framework", basename) }));
        value.chromeEntries.splice(0, value.chromeEntries.length, ...members);
        value.chromeLayout.layout.frameworkRoots = value.chromeLayout.layout.frameworkRoots.map((p) =>
            p.replace("Test.framework", basename),
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
                                    value.chromeLayout.layout.frameworkRoots[0]!.slice("browser/".length),
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

/**
 * 自包含回归在真正独立的 Node 子进程等待生产 tar 消费者自然结束，父级期限只把卡住分类为失败而不充当完成事件；夹具使用
 * 成熟 tar 编码器与真实摘要，每次仅拥有一个小归档并在进程已结束后删除，绝不借私有证据或伪造官方身
 * 份。
 */
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
        const code =
            `import ${JSON.stringify(moduleUrl("runtime-payload-inputs"))};
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
if(scenario==="low-compressible"){const chunks=[];for(let i=0,n=0;n<size;i++,n+=64)chunks.push(hash(Buffer.from("ver` +
            `iq-tar-boundary:"+i)));body=chunks.join("").slice(0,size);}
const bodyBytes=Buffer.from(body),archive=tarBytes([{path:top+"/empty/",kind:"directory"},{path:top+"/payload",body}` +
            `,{path:top+"/after",body:"tail"}],Buffer.alloc(scenario==="zero-tail"?1031:1024));
if(bodyBytes.length>1024**2||archive.length>512*1024||(scenario==="low-compressible"&&archive.length<=65536))throw E` +
            `rror("FIXTURE_BOUND");
const input=join(root,"input"),output=join(root,"output");await mkdir(input,{mode:0o700});await mkdir(output,{mode:0` +
            `o700});await writeFile(join(input,"node.tar.gz"),archive,{mode:0o600});
const controller=new AbortController(),tx=new ArchiveTransaction(input,output,"candidate",controller.signal),ref={pa` +
            `th:"node.tar.gz",sizeBytes:archive.length,sha256:hash(archive)};
await tx.initialize();await tx.observeRefs([ref]);await tx.plan(archive.length+bodyBytes.length+4096,4);
phase="SNAPSHOT";await tx.snapshot(ref,"snapshots/node.tar.gz");await tx.audit();emit({event:"SNAPSHOT_DONE",archive` +
            `Bytes:archive.length,archiveSha256:ref.sha256,node:process.versions.node});
const budget=new ArchiveBudget(),scan=new ArchiveScan("node",top,tx,budget);
if(scenario==="cancel"||scenario==="member-error"){
    const actual=scan.entry.bind(scan);let injected=false;
    scan.entry=(entry,chunks)=>actual(entry,(async function*(){for await(const chunk of chunks){if(!injected&&entry.` +
            `path===top+"/payload"){injected=true;if(scenario==="cancel")controller.abort();else ` +
            `throw new RuntimePayloadError("PAYLOAD_IO","ENOSPC");}yield chunk;}})());
}
try{
    phase="SCAN";emit({event:"SCAN_BEGIN"});const streamBytes=await scanTar(join(tx.scratch,"snapshots/node.tar.gz")` +
            `,scan);
    if(scenario==="cancel"||scenario==="member-error")throw Error("EXPECTED_REJECTION");
    const member=scan.members.find(m=>m.path===top+"/payload");
    if(scan.members.length!==3||member?.kind!=="file"||member.sizeBytes!==size||member.sha256!==hash(bodyBytes))thro` +
            `w Error("MEMBER_MISMATCH");
    emit({event:"SCAN_DONE",streamBytes,member});
    phase="SECOND_SCAN";await scanTar(join(tx.scratch,"snapshots/node.tar.gz"),new ArchiveScan("node",top,tx,budget,` +
            `scan));await tx.audit();
    if(hash(await readFile(join(tx.scratch,"trees/node",top,"payload")))!==hash(bodyBytes))throw Error("SECOND_PASS_` +
            `MISMATCH");
    let allocated=0;const walk=async path=>{const info=await lstat(path,{bigint:true});allocated+=Number(info.blocks` +
            `*512n);if(info.isDirectory()){const dir=await opendir(path);` +
            `for await(const entry of dir)await walk(join(path,en` +
            `try.name));}};await walk(root);if(allocated>2*1024**2)throw Error("ALLOCATION_BOUND");
    phase="CLEANUP";const cleanup=await tx.cleanup();if(cleanup!=="CONFIRMED")throw Error("CLEANUP_UNCONFIRMED");pha` +
            `se="DONE";emit({event:"RESULT",members:scan.members.length,bodySha256:hash(bodyBytes),bodyBytes:size,` +
            `archiveByte` +
            `s:archive.length,allocated,cleanup});
}catch(error){
    const expected=scenario==="cancel"?"PAYLOAD_CANCELLED":scenario==="member-error"?"PAYLOAD_IO":null,cleanup=await` +
            ` tx.cleanup();
    if(error.code!==expected||cleanup!=="CONFIRMED"||(scenario==="member-error"&&error.causeCode!=="ENOSPC"))throw e` +
            `rror;
    phase="REJECTED";emit({event:"EXPECTED_REJECT",code:error.code,causeCode:error.causeCode,cleanup});
}
`;
        const environment = { ...process.env };
        delete environment.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
            cwd: new URL("../", import.meta.url),
            env: environment,
            encoding: "utf8",
            timeout: 15000,
            maxBuffer: 65536,
        });
        assert.ok(!result.error, `Parent watchdog or child launch failed: ${result.error?.message}`);
        assert.equal(result.status, 0, `Natural child exit=${result.status}\n${result.stdout}\n${result.stderr}`);
        assert.equal(result.signal, null);
        assert.equal(result.stderr, "");
        const records = result.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.ok(records.some((row) => row.event === "SNAPSHOT_DONE"));
        if (scenario === "cancel" || scenario === "member-error")
            assert.ok(records.some((row) => row.event === "EXPECTED_REJECT" && row.cleanup === "CONFIRMED"));
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
        assert.equal(records.at(-1)?.phase, scenario === "cancel" || scenario === "member-error" ? "REJECTED" : "DONE");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}
for (const size of [0, 1, 16383, 16384, 16385, 65535, 65536, 65537])
    test(`tar natural child boundary ${size}`, async () => naturalTarChild(size, "ordinary"));
test("tar natural child compressed reads cross64KiB", async () => naturalTarChild(524301, "low-compressible"));
for (const scenario of ["cancel", "member-error"] as const)
    test(`tar natural child settles waiting producer ${scenario}`, async () => naturalTarChild(65537, scenario));

test("tar natural child retains permitted partial zero tail", async () => naturalTarChild(16385, "zero-tail"));

/**
 * 新诊断回归只给真实事务写入一个微型归档，再消费实际 tar 或 ZIP 扫描器的失败对象；空间与分配均在独占目录核验，最后先确
 * 认事务关闭再删除夹具，不借用官方身份或执行任何归档成员。
 */
async function rejectionFixture(
    archive: Buffer,
    kind: "node" | "chrome",
    inspect: (error: RuntimePayloadError) => void,
) {
    const { statfs } = await import("node:fs/promises"),
        { ArchiveTransaction } = await import("../scripts/runtime-payload-transaction.ts"),
        { ArchiveScan, ArchiveBudget } = await import("../scripts/runtime-payload-archive.ts"),
        { scanTar } = await import("../scripts/runtime-payload-tar.ts"),
        { scanZip } = await import("../scripts/runtime-payload-zip.ts");
    const base = await mkdtemp(join(tmpdir(), "veriq-rejection-"));
    const root = join(base, "input"),
        output = join(base, "output");
    await mkdir(root, { mode: 0o700 });
    await mkdir(output, { mode: 0o700 });
    const tx = new ArchiveTransaction(root, output, "candidate");
    try {
        const free = await statfs(base);
        assert.ok(free.bavail * free.bsize > 40 * 1024 ** 2);
        assert.ok(archive.length <= 1024 ** 2);
        await tx.initialize();
        tx.phase = "INTAKE";
        const stream = async function* () {
            yield archive;
        };
        const ref = await tx.write("snapshots/input", stream());
        await tx.audit();
        const scan = new ArchiveScan(kind, "top", tx, new ArchiveBudget());
        await assert.rejects(
            kind === "node"
                ? scanTar(join(tx.scratch, ref.path), scan)
                : scanZip(join(tx.scratch, ref.path), scan, ref.sizeBytes),
            (error: unknown) => {
                assert.ok(error instanceof RuntimePayloadError);
                assert.equal(error.code, "PAYLOAD_ARCHIVE_UNSUPPORTED");
                inspect(error);
                return true;
            },
        );
        const allocated = async (path: string): Promise<number> => {
            const info = await lstat(path);
            let bytes = info.blocks * 512;
            if (info.isDirectory()) for (const name of await readdir(path)) bytes += await allocated(join(path, name));
            return bytes;
        };
        assert.ok((await allocated(base)) <= 2 * 1024 ** 2);
    } finally {
        assert.equal(await tx.cleanup(), "CONFIRMED");
        await rm(base, { recursive: true, force: true });
    }
}

/**
 * 三个首要反例分别经过真实 tar 类型拒绝、ZIP 来源类型拒绝及共用权限拒绝，先断言原分类再要求真实错误携带诊断；读取函数
 * 的空实现因此是行为缺失红灯，不是导入或测试装载失败。
 */
for (const scenario of ["tar", "zip", "shared"] as const) {
    test(`archive rejection evidence initial ${scenario}`, async () => {
        const { archiveRejectionLine } = await import("../scripts/runtime-payload-archive.ts");
        const archive =
            scenario === "tar"
                ? tarBytes([{ path: "top/item", type: "FIFO" }])
                : zipBytes([
                      {
                          path: "top/item",
                          body: "tiny",
                          mode: scenario === "shared" ? 0o4755 : 0o644,
                      },
                  ]);
        if (scenario === "zip") {
            const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
            archive[central + 5] = 7;
        }
        await rejectionFixture(archive, scenario === "tar" ? "node" : "chrome", (error) => {
            const line = archiveRejectionLine(error);
            assert.ok(line, "real unsupported error must carry first-rejection evidence");
            const event = JSON.parse(line);
            assert.equal(event.kind, "ASSET_ARCHIVE_REJECTION");
            assert.equal(
                event.reason,
                scenario === "tar" ? "TAR_ENTRY_TYPE" : scenario === "zip" ? "ZIP_HOST_TYPE" : "ENTRY_MODE_SIZE",
            );
            assert.equal(event.memberIndex, scenario === "tar" ? null : 1);
        });
    });
}

/**
 * 每个元数据反例保留成熟编码器生成的真实头和精确正文，并将实际拒绝事件与这些独立字节核对；PAX 值与往返边界使用合法长度
 * 记录，不能用损坏校验和或通用格式错误替代目标拒绝。
 */
const rejectionTarCases = [
    {
        name: "empty metadata",
        entry: { path: "meta", type: "ExtendedHeader", body: "" },
        reason: "TAR_META_EMPTY",
    },
    {
        name: "special mode",
        entry: { path: "top/item", mode: 0o4755 },
        reason: "TAR_HEADER_MODE",
        flag: "modeHigh",
    },
    {
        name: "negative mode",
        entry: { path: "top/item", mode: -1 },
        reason: "TAR_HEADER_MODE",
        flag: "modeNegative",
    },
    {
        name: "missing newline",
        entry: { path: "meta", type: "ExtendedHeader", body: "12 path=abc" },
        reason: "TAR_PAX_TEXT",
        flag: "missingNewline",
    },
    {
        name: "non ASCII",
        entry: { path: "meta", type: "ExtendedHeader", body: "12 path=é\n" },
        reason: "TAR_PAX_TEXT",
        flag: "nonAscii",
    },
    {
        name: "unknown key",
        entry: { path: "meta", type: "ExtendedHeader", body: "14 unknown=x\n" },
        reason: "TAR_PAX_RECORD",
        flag: "malformedOrUnknown",
    },
    {
        name: "duplicate key",
        entry: { path: "meta", type: "ExtendedHeader", body: "12 path=abc\n12 path=abc\n" },
        reason: "TAR_PAX_RECORD",
        flag: "duplicate",
    },
    {
        name: "missing parsed value",
        entry: { path: "meta", type: "ExtendedHeader", body: "99 path=ignored\n" },
        reason: "TAR_PAX_VALUE",
        flag: "missing",
    },
    {
        name: "invalid date",
        entry: {
            path: "meta",
            type: "ExtendedHeader",
            body: new Pax({ uname: "invalid" }).encodeField("uname").replace("uname", "mtime"),
        },
        reason: "TAR_PAX_VALUE",
        flag: "invalidDate",
    },
    {
        name: "negative parsed number",
        entry: { path: "meta", type: "ExtendedHeader", body: new Pax({ uid: -1 }).encodeBody() },
        reason: "TAR_PAX_VALUE",
        flag: "invalidNumber",
    },
    {
        name: "empty parsed string",
        entry: { path: "meta", type: "ExtendedHeader", body: new Pax({ path: "" }).encodeBody() },
        reason: "TAR_PAX_VALUE",
        flag: "emptyString",
    },
    {
        name: "date roundtrip",
        entry: {
            path: "meta",
            type: "ExtendedHeader",
            body: new Pax({ uname: "1.0011" }).encodeField("uname").replace("uname", "mtime"),
        },
        reason: "TAR_PAX_ROUNDTRIP",
        flag: "dateMismatch",
    },
    {
        name: "GNU empty",
        entry: { path: "meta", type: "NextFileHasLongPath", body: "\0" },
        reason: "TAR_GNU_TEXT",
        flag: "empty",
    },
    {
        name: "GNU non ASCII",
        entry: { path: "meta", type: "NextFileHasLongLinkpath", body: "é\0" },
        reason: "TAR_GNU_TEXT",
        flag: "nonAscii",
    },
    {
        name: "GNU length",
        entry: { path: "meta", type: "NextFileHasLongPath", body: "x".repeat(1025) },
        reason: "TAR_GNU_TEXT",
        flag: "tooLong",
    },
] satisfies { name: string; entry: ArchiveFixtureEntry; reason: string; flag?: string }[];
for (const scenario of rejectionTarCases) {
    test(`archive rejection evidence tar ${scenario.name}`, async () => {
        const { archiveRejectionLine } = await import("../scripts/runtime-payload-archive.ts");
        const bytes = tarBytes([scenario.entry]),
            raw = gunzipSync(bytes);
        await rejectionFixture(bytes, "node", (error) => {
            const event = JSON.parse(archiveRejectionLine(error)!);
            assert.equal(event.reason, scenario.reason);
            assert.equal(event.headerIndex, 1);
            assert.equal(event.header.sha256, hash(raw.subarray(0, 512)));
            assert.deepEqual(Buffer.from(event.header.base64, "base64"), raw.subarray(0, 512));
            assert.equal(event.path.sha256, hash(Buffer.from(scenario.entry.path)));
            if (scenario.flag) assert.equal(event.details[scenario.flag], true);
            if (scenario.name === "unknown key")
                assert.equal(event.details.unknownKeySha256, hash(Buffer.from("unknown")));
            assert.equal(event.details.checksumValid, true);
            if (event.stage === "TAR_METADATA") {
                const body = Buffer.from(scenario.entry.body!);
                assert.equal(event.metadata.sha256, hash(body));
                assert.deepEqual(Buffer.from(event.metadata.base64, "base64"), body);
            }
        });
    });
}

/**
 * ZIP 复合条件分别改变公开 central 与 local 字段，并保持原有范围一致性前置检查通过；事件必须保存实际原模式、方法与来源
 * 主机，不能由测试期望填入诊断或把缺失模式伪装为 Unix 权限。
 */
for (const scenario of [
    "method",
    "flags",
    "storedOptionsAndUnknownFlag",
    "host",
    "type",
    "dosMode",
    "directoryType",
    "fileType",
    "dosDirectory",
] as const) {
    test(`archive rejection evidence ZIP ${scenario}`, async () => {
        const { archiveRejectionLine } = await import("../scripts/runtime-payload-archive.ts");
        const directory = scenario === "directoryType";
        const bytes = zipBytes(
            [
                {
                    path: directory ? "top/item/" : "top/item",
                    body: "",
                    kind: directory ? "directory" : "file",
                },
            ],
            0,
        );
        const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        if (scenario === "method") {
            bytes.writeUInt16LE(99, 8);
            bytes.writeUInt16LE(99, central + 10);
        }
        if (scenario === "flags" || scenario === "storedOptionsAndUnknownFlag") {
            const value = scenario === "flags" ? 0x10 : 0x12;
            bytes.writeUInt16LE(value, 6);
            bytes.writeUInt16LE(value, central + 8);
        }
        if (scenario === "host" || scenario === "dosMode") bytes[central + 5] = scenario === "host" ? 7 : 0;
        if (scenario === "type") bytes.writeUInt32LE((0o010644 << 16) >>> 0, central + 38);
        if (scenario === "directoryType") bytes.writeUInt32LE((0o100644 << 16) >>> 0, central + 38);
        if (scenario === "fileType") bytes.writeUInt32LE((0o040755 << 16) >>> 0, central + 38);
        if (scenario === "dosDirectory") bytes.writeUInt32LE(((0o100644 << 16) | 0x10) >>> 0, central + 38);
        await rejectionFixture(bytes, "chrome", (error) => {
            const event = JSON.parse(archiveRejectionLine(error)!);
            assert.equal(
                event.reason,
                ["method", "flags", "storedOptionsAndUnknownFlag"].includes(scenario)
                    ? "ZIP_METHOD_FLAGS"
                    : ["host", "type"].includes(scenario)
                      ? "ZIP_HOST_TYPE"
                      : "ZIP_DIRECTORY_MODE",
            );
            const flag =
                scenario === "method"
                    ? "methodUnsupported"
                    : scenario === "flags" || scenario === "storedOptionsAndUnknownFlag"
                      ? "flagsUnsupported"
                      : scenario === "host"
                        ? "hostUnsupported"
                        : scenario === "type"
                          ? "typeUnsupported"
                          : scenario;
            assert.equal(event.details[flag], true);
            if (scenario === "storedOptionsAndUnknownFlag") {
                assert.equal(event.details.storedFlags, true);
                assert.equal(event.details.flags, 0x12);
                assert.equal(event.details.localFlags, 0x12);
            }
            assert.equal(event.headerIndex, 1);
            assert.equal(event.memberIndex, 1);
            assert.equal(event.rawMode.value, bytes.readUInt32LE(central + 38) >>> 16);
            assert.equal(event.details.externalFileAttributes, bytes.readUInt32LE(central + 38));
            assert.equal(event.details.host, bytes[central + 5]);
            assert.equal(event.path.encoding, "ZIP_RAW_BYTES");
        });
    });
}

/**
 * 共用条目检查在读取正文前拒绝权限与长度边界，因此直接提供真实扫描对象即可定位非有限数等压缩头无法合法编码的输入；断言
 * 仍检查原异常分类和未消费正文，不把这些微型内部案例当成官方归档事实。
 */
for (const scenario of [
    { mode: NaN, size: 0, flag: "modeNotInteger", numberKind: "NAN" },
    { mode: -1, size: 0, flag: "modeNegative", numberKind: "SAFE_INTEGER" },
    { mode: 0o4755, size: 0, flag: "modeHigh", numberKind: "SAFE_INTEGER" },
    { mode: 0o644, size: 0.5, flag: "sizeNotInteger", numberKind: "FINITE_NON_SAFE_INTEGER" },
    { mode: 0o644, size: -1, flag: "sizeNegative", numberKind: "SAFE_INTEGER" },
    { mode: 0o644, size: NaN, flag: "sizeNotInteger", numberKind: "NAN" },
    { mode: Infinity, size: 0, flag: "modeNotInteger", numberKind: "POSITIVE_INFINITY" },
]) {
    test(`archive rejection evidence shared ${scenario.flag} ${scenario.numberKind}`, async () => {
        const { ArchiveScan, ArchiveBudget, archiveRejectionLine } = await import(
                "../scripts/runtime-payload-archive.ts"
            ),
            { ArchiveTransaction } = await import("../scripts/runtime-payload-transaction.ts");
        const tx = new ArchiveTransaction("/unused-input", "/unused-output", "candidate");
        const scan = new ArchiveScan("node", "top", tx, new ArchiveBudget());
        let consumed = false;
        const chunks = async function* () {
            consumed = true;
            yield Buffer.from("unused");
        };
        await assert.rejects(
            scan.entry({ path: "top/item", kind: "file", mode: scenario.mode, size: scenario.size }, chunks()),
            (error: unknown) => {
                assert.ok(error instanceof RuntimePayloadError);
                assert.equal(error.code, "PAYLOAD_ARCHIVE_UNSUPPORTED");
                const event = JSON.parse(archiveRejectionLine(error)!);
                assert.equal(event.reason, "ENTRY_MODE_SIZE");
                assert.equal(event.details[scenario.flag], true);
                assert.equal(
                    (scenario.flag.startsWith("mode") ? event.effectiveMode : event.declaredSize).kind,
                    scenario.numberKind,
                );
                assert.equal(event.headerIndex, null);
                return true;
            },
        );
        assert.equal(consumed, false);
        assert.equal(await tx.cleanup(), "NOT_NEEDED");
    });
}

/**
 * 私有捕获的上限按完整 JSON 与 base64 膨胀核验，合法最大元数据和头样本仍能保存原 SHA；超限与捕获异常只丢弃可选事件，不
 * 改变冻结错误，也不允许后来修改缓冲或第二个事件覆盖首份事实。
 */
test("archive rejection evidence capture bounds ownership and failure isolation", async () => {
    const { attachArchiveRejection, archiveRejectionLine, transferArchiveRejection } = await import(
        "../scripts/runtime-payload-archive.ts"
    );
    const error = new RuntimePayloadError("PAYLOAD_ARCHIVE_UNSUPPORTED"),
        header = Buffer.alloc(512, 1),
        metadata = Buffer.alloc(65536, 2);
    const before = JSON.stringify(error),
        metadataHash = hash(metadata);
    const facts = {
        archive: "node",
        stage: "TAR_METADATA",
        reason: "TAR_PAX_TEXT",
        header,
        metadata,
        path: "top/item",
    } as const;
    attachArchiveRejection(error, facts);
    const line = archiveRejectionLine(error)!;
    assert.ok(Buffer.byteLength(line) <= 96 * 1024);
    assert.ok(Buffer.byteLength(line) > 65536);
    assert.equal(JSON.parse(line).metadata.sha256, metadataHash);
    header.fill(0);
    metadata.fill(0);
    attachArchiveRejection(error, { ...facts, reason: "TAR_GNU_TEXT" });
    assert.equal(archiveRejectionLine(error), line);
    assert.equal(JSON.stringify(error), before);
    assert.ok(Object.isFrozen(error));
    const unrelated = new RuntimePayloadError("PAYLOAD_ARCHIVE_FORMAT");
    attachArchiveRejection(unrelated, facts);
    assert.equal(archiveRejectionLine(unrelated), null);
    assert.equal(archiveRejectionLine(new RuntimePayloadError("PAYLOAD_ARCHIVE_UNSUPPORTED")), null);
    assert.equal(archiveRejectionLine({}), null);
    const cases = [
        { ...facts, header: Buffer.alloc(513) },
        { ...facts, metadata: Buffer.alloc(65537) },
        { ...facts, path: "é".repeat(40000) },
        {
            ...facts,
            details: Object.fromEntries(Array.from({ length: 32 }, (_, n) => [`key${n}`, "\0".repeat(128)])),
        },
    ];
    for (const value of cases) {
        const rejected = new RuntimePayloadError("PAYLOAD_ARCHIVE_UNSUPPORTED");
        assert.doesNotThrow(() => attachArchiveRejection(rejected, value));
        assert.equal(archiveRejectionLine(rejected), null);
        assert.equal(rejected.code, "PAYLOAD_ARCHIVE_UNSUPPORTED");
    }
    const failing = {
        ...facts,
        get metadata(): Buffer {
            throw new Error("CAPTURE_FAILURE");
        },
    };
    const captureError = new RuntimePayloadError("PAYLOAD_ARCHIVE_UNSUPPORTED");
    assert.doesNotThrow(() => attachArchiveRejection(captureError, failing));
    assert.equal(archiveRejectionLine(captureError), null);
    const other = new RuntimePayloadError("PAYLOAD_ARCHIVE_UNSUPPORTED");
    attachArchiveRejection(other, { ...facts, reason: "TAR_GNU_TEXT" });
    const otherLine = archiveRejectionLine(other);
    assert.equal(transferArchiveRejection(error, other), other);
    assert.equal(archiveRejectionLine(other), otherLine);
    assert.equal(transferArchiveRejection(error, unrelated), unrelated);
    assert.equal(archiveRejectionLine(unrelated), null);
});

/**
 * 缺失权限字段用成熟 Header 在新缓冲直接编码，避免手工修补校验和影响待观察的实际 guard；另一个声明超限同时带坏权限的案
 * 例证明原先限额优先选择没有被诊断重新分类。
 */
test("archive rejection evidence missing raw mode and unchanged limit priority", async () => {
    const { ArchiveScan, ArchiveBudget, archiveRejectionLine } = await import("../scripts/runtime-payload-archive.ts"),
        { ArchiveTransaction } = await import("../scripts/runtime-payload-transaction.ts");
    const header = Buffer.alloc(512);
    new Header({ path: "top/item", type: "File", size: 0 }).encode(header);
    await rejectionFixture(gzipSync(Buffer.concat([header, Buffer.alloc(1024)])), "node", (error) => {
        const event = JSON.parse(archiveRejectionLine(error)!);
        assert.equal(event.reason, "TAR_HEADER_MODE");
        assert.equal(event.details.modeMissing, true);
        assert.deepEqual(event.rawMode, { value: null, kind: "UNDEFINED" });
    });
    const tx = new ArchiveTransaction("/unused-input", "/unused-output", "candidate");
    const scan = new ArchiveScan("node", "top", tx, new ArchiveBudget());
    const chunks = async function* () {
        yield Buffer.alloc(0);
    };
    await assert.rejects(
        scan.entry({ path: "top/item", kind: "file", mode: NaN, size: 2 ** 31 + 1 }, chunks()),
        (error: unknown) => {
            assert.ok(error instanceof RuntimePayloadError);
            assert.equal(error.code, "PAYLOAD_LIMIT");
            assert.equal(archiveRejectionLine(error), null);
            return true;
        },
    );
    assert.equal(await tx.cleanup(), "NOT_NEEDED");
});

/**
 * Stored 兼容案例只在成熟编码器生成的单成员微型归档中改变原始选项位，事务快照与双遍扫描始终消费同一字节；每例独占目录
 * 并在确认关闭后清理，同时核验实际磁盘分配和剩余空间。
 */
async function storedFixture(
    bytes: Buffer,
    inspect: (
        tx: import("../scripts/runtime-payload-transaction.ts").ArchiveTransaction,
        path: string,
    ) => Promise<void>,
) {
    const { statfs } = await import("node:fs/promises"),
        { ArchiveTransaction } = await import("../scripts/runtime-payload-transaction.ts");
    const base = await mkdtemp(join(tmpdir(), "veriq-stored-options-")),
        input = join(base, "input"),
        output = join(base, "output");
    await mkdir(input, { mode: 0o700 });
    await mkdir(output, { mode: 0o700 });
    const tx = new ArchiveTransaction(input, output, "scan");
    try {
        const free = await statfs(base);
        assert.ok(free.bavail * free.bsize > 40 * 1024 ** 2);
        assert.ok(bytes.length <= 1024 ** 2);
        await tx.initialize();
        tx.phase = "INTAKE";
        const content = async function* () {
            yield bytes;
        };
        const ref = await tx.write("snapshots/chrome.zip", content());
        const path = join(tx.scratch, ref.path);
        await tx.audit();
        await inspect(tx, path);
        assert.deepEqual(await readFile(path), bytes);
        const allocated = async (path: string): Promise<number> => {
            const info = await lstat(path);
            let total = info.blocks * 512;
            if (info.isDirectory()) for (const name of await readdir(path)) total += await allocated(join(path, name));
            return total;
        };
        assert.ok((await allocated(base)) <= 2 * 1024 ** 2);
    } finally {
        assert.equal(await tx.cleanup(), "CONFIRMED");
        await rm(base, { recursive: true, force: true });
    }
}

/**
 * 四种方法专属选项位均保持原值传入成熟 Stored 解码器，声明长度与 CRC 来自真实头部并由实际正文完成校验；第二遍必须得到
 * 相同成员摘要和完整正文，快照原字节不能被清零或重写。
 */
for (const flags of [0, 2, 4, 6]) {
    test(`stored option bits ${flags} preserve exact body through two scans`, async () => {
        const { ArchiveScan, ArchiveBudget } = await import("../scripts/runtime-payload-archive.ts"),
            { scanZip } = await import("../scripts/runtime-payload-zip.ts");
        const body = "s".repeat(2018),
            bytes = zipBytes([{ path: "top/item", body }], 0),
            central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        bytes.writeUInt16LE(flags, 6);
        bytes.writeUInt16LE(flags, central + 8);
        const original = Buffer.from(bytes);
        assert.equal(bytes.readUInt32LE(18), body.length);
        assert.equal(bytes.readUInt32LE(22), body.length);
        assert.equal(bytes.readUInt32LE(central + 20), body.length);
        assert.equal(bytes.readUInt32LE(central + 24), body.length);
        assert.equal(bytes.readUInt32LE(14), crc32(Buffer.from(body)));
        assert.equal(bytes.readUInt32LE(central + 16), crc32(Buffer.from(body)));
        await storedFixture(bytes, async (tx, path) => {
            const budget = new ArchiveBudget(),
                first = new ArchiveScan("chrome", "top", tx, budget);
            await scanZip(path, first, bytes.length);
            assert.deepEqual(first.members, [
                {
                    path: "top/item",
                    kind: "file",
                    mode: 0o644,
                    sizeBytes: body.length,
                    sha256: hash(Buffer.from(body)),
                },
            ]);
            assert.equal(first.expandedBytes, body.length);
            await tx.plan(body.length, first.effective.size);
            const second = new ArchiveScan("chrome", "top", tx, budget, first);
            await scanZip(path, second, bytes.length);
            assert.deepEqual(second.members, first.members);
            assert.equal(second.expandedBytes, body.length);
            assert.equal(await readFile(join(tx.scratch, "trees/chrome/top/item"), "utf8"), body);
            const snapshot = await readFile(path);
            assert.equal(snapshot.readUInt16LE(6), flags);
            assert.equal(snapshot.readUInt16LE(central + 8), flags);
            assert.deepEqual(snapshot, original);
            await tx.audit();
        });
        assert.deepEqual(bytes, original);
    });
}

/**
 * 放行 Stored 方法不解释的选项位不能影响其它拒绝边界，以下每次只破坏真实微型 ZIP 的一个条件；加密输入允许先被成熟解析
 * 器判为格式错误，不能把更早的诚实失败伪装成诊断守卫命中。
 */
for (const scenario of [
    "local0central4",
    "local4central0",
    "method",
    "unknown",
    "encrypted",
    "strongEncryption",
    "crc",
    "storedSize",
] as const) {
    test(`stored option boundary still rejects ${scenario}`, async () => {
        const { ArchiveScan, ArchiveBudget } = await import("../scripts/runtime-payload-archive.ts"),
            { scanZip } = await import("../scripts/runtime-payload-zip.ts");
        const bytes = zipBytes([{ path: "top/item", body: "s".repeat(2018) }], 0),
            central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        const flags =
            scenario === "unknown" ? 0x14 : scenario === "encrypted" ? 5 : scenario === "strongEncryption" ? 0x45 : 4;
        bytes.writeUInt16LE(scenario === "local0central4" ? 0 : flags, 6);
        bytes.writeUInt16LE(scenario === "local4central0" ? 0 : flags, central + 8);
        if (scenario === "method") {
            bytes.writeUInt16LE(99, 8);
            bytes.writeUInt16LE(99, central + 10);
        }
        if (scenario === "crc") bytes[30 + bytes.readUInt16LE(26)]! ^= 1;
        if (scenario === "storedSize") {
            bytes.writeUInt32LE(2019, 22);
            bytes.writeUInt32LE(2019, central + 24);
        }
        const expected = scenario.startsWith("local")
            ? "PAYLOAD_ARCHIVE_RANGE"
            : scenario === "crc"
              ? "PAYLOAD_ARCHIVE_CRC"
              : scenario === "storedSize" || scenario === "encrypted" || scenario === "strongEncryption"
                ? "PAYLOAD_ARCHIVE_FORMAT"
                : "PAYLOAD_ARCHIVE_UNSUPPORTED";
        await storedFixture(bytes, async (tx, path) => {
            const scan = new ArchiveScan("chrome", "top", tx, new ArchiveBudget());
            await assert.rejects(scanZip(path, scan, bytes.length), (error: unknown) => {
                assert.ok(error instanceof RuntimePayloadError);
                assert.equal(error.code, expected);
                return true;
            });
            assert.deepEqual(await readdir(join(tx.scratch, "trees/chrome")), []);
        });
    });
}

/**
 * 真实子进程只包装精确 owned 快照的单次关闭回调，实际系统关闭成功后才注入 EIO；父进程等待自然终止并记录保留目录之后才
 * 删除自己的夹具，十秒看门狗只能判失败，不能替生产结算。
 */
for (const scenario of [
    "normal",
    "close-eio",
    "crc-eio",
    "parser-eio",
    "init-eio",
    "unsupported-eio",
    "cancel-eio",
    "read-eio",
    "crc-normal",
    "parser-normal",
])
    test(`finite ZIP close archive ${scenario}`, async (t) => {
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
process.on("unhandledRejection", error => { emit("UNHANDLED_REJECTION", { message: String(error) }); process.exitCod` +
                        `e = 91; });
let target, expected, captured, calls = 0, opens = 0, injected = false, primary, tx;
const controller = new AbortController();
const originalOpen = fs.open, originalClose = fs.close, originalRead = fs.read;
const identity = info => ({ dev: String(info.dev), ino: String(info.ino), size: String(info.size), nlink: String(inf` +
                        `o.nlink) });
const matches = info => info.isFile() && info.dev === expected.dev && info.ino === expected.ino && info.size === exp` +
                        `ected.size && info.nlink === 1n;
const restore = () => { fs.open = originalOpen; fs.close = originalClose; fs.read = originalRead; syncBuiltinESMExpo` +
                        `rts(); };
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
        if (fd === captured && args[2] === 2018 && !injected && (scenario === "read-eio" || scenario === "cancel-eio` +
                        `")) {
            injected = true;
            if (scenario === "cancel-eio") controller.abort();
            else { queueMicrotask(() => args.at(-1)(Object.assign(Error("OWNED_READ_FAULT"), { code: "EIO" }))); ret` +
                        `urn; }
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

const body = "s".repeat(2018), top = "chrome-mac-x64";
const bytes = zipBytes([{ path: top + "/item", body }], 0);
if (scenario === "crc-eio" || scenario === "crc-normal") bytes[30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28) ` +
                        `+ 5] ^= 1;
if (scenario === "parser-eio" || scenario === "parser-normal") bytes.writeUInt32LE(0, bytes.indexOf(Buffer.from([0x5` +
                        `0, 0x4b, 0x01, 0x02])));
if (scenario === "init-eio") bytes.writeUInt32LE(0, bytes.length - 22);
if (scenario === "unsupported-eio") { bytes.writeUInt16LE(9, 8); bytes.writeUInt16LE(9, bytes.indexOf(Buffer.from([0` +
                        `x50, 0x4b, 0x01, 0x02])) + 10); }
assert.ok(bytes.length <= 1024 ** 2);
tx = new ArchiveTransaction(input, output, "candidate", controller.signal);
await tx.initialize();
const ref = await tx.write("snapshots/chrome.zip", (async function*() { yield bytes; })());
await tx.audit();
snapshotHash = ref.sha256;
const fail = tx.fail.bind(tx);
tx.fail = (...args) => { try { return fail(...args); } catch (error) { primary ??= error; throw error; } };
const scan = new ArchiveScan("chrome", top, tx, new ArchiveBudget());
const entry = scan.entry.bind(scan);
scan.entry = async (...args) => {
    try { return await entry(...args); }
    catch (error) { if (scenario === "cancel-eio") primary ??= error; throw error; }
};
const destination = join(tx.scratch, ref.path);
install(path => path === destination, 1);
emit("SETUP_RESOLVED");
const started = performance.now();
try {
    await scanZip(destination, scan, ref.sizeBytes);
    assert.equal(scenario, "normal");
    assert.equal(scan.members[0].sha256, hash(Buffer.from(body)));
    assert.equal(await tx.cleanup(), "CONFIRMED");
    emit("SETTLED", { outcome: "success", cleanup: "CONFIRMED" });
} catch (error) {
    assert.notEqual(scenario, "normal");
    if (scenario === "parser-eio") assert.ok(performance.now() - started >= 4900);
    const code = scenario.startsWith("crc") ? "PAYLOAD_ARCHIVE_CRC" : scenario === "cancel-eio" ? "PAYLOAD_CANCELLED` +
                        `" : scenario === "unsupported-eio" ? ` +
                        `"PAYLOAD_ARCHIVE_UNSUPPORTED" : scenario === "close-eio" ? "PAYLOAD_IO" : "` +
                        `PAYLOAD_ARCHIVE_FORMAT";
    assert.equal(error.code, code);
    assert.equal(error, primary);
    assert.equal(error.phase, scenario === "cancel-eio" ? "INPUTS" : "INTAKE");
    assert.equal(error.causeCode, scenario === "close-eio" ? "EIO" : null);
    const diagnostic = archiveRejectionLine(error);
    if (scenario === "unsupported-eio") assert.ok(diagnostic?.includes("ZIP_METHOD_FLAGS"));
    const cleanup = await tx.cleanup();
    assert.equal(cleanup, scenario.endsWith("normal") ? "CONFIRMED" : "INCOMPLETE");
    if (cleanup === "INCOMPLETE") await retain();
    emit("SETTLED", { outcome: "rejected", code: error.code, causeCode: error.causeCode, phase: error.phase, cleanup` +
                        `, diagnostic, samePrimary: error === primary });
} finally { restore(); }
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

/**
 * 公开事件顺序测试只检验共享结算器的记忆和终态粘性，不冒充真实文件描述符证据；提前 close、先读错后确认、关闭重入及迟到
 * 重复事件均使用真实事务 cleanup 判断是否错误释放了所属目录。
 */
for (const order of ["already-closed", "read-error-confirmed", "error-late-close", "duplicate-error"])
    test(`finite ZIP lifecycle ${order}`, async () => {
        const { EventEmitter } = await import("node:events");
        const { ArchiveTransaction } = await import("../scripts/runtime-payload-transaction.ts");
        const { trackZipClosure } = await import("../scripts/runtime-payload-zip.ts");
        const root = await mkdtemp(join(tmpdir(), "veriq-close-order-"));
        const input = join(root, "input"),
            output = join(root, "output");
        await mkdir(input);
        await mkdir(output);
        const tx = new ArchiveTransaction(input, output, "candidate");
        await tx.initialize();
        const first = Object.assign(new Error("FIRST_CLOSE_ERROR"), { code: "EIO" });
        let calls = 0;
        const zip = Object.assign(new EventEmitter(), {
            isOpen: true,
            close() {
                calls++;
                this.isOpen = false;
                zip.emit(order.endsWith("confirmed") ? "close" : "error", first);
            },
        });
        const closure = trackZipClosure(zip, tx);
        try {
            if (order === "already-closed") zip.emit("close");
            if (order === "read-error-confirmed") zip.emit("error", first);
            if (order === "already-closed" || order === "read-error-confirmed") {
                await closure.settle();
                assert.equal(await tx.cleanup(), "CONFIRMED");
                assert.equal(calls, order === "already-closed" ? 0 : 1);
            } else {
                closure.request();
                if (order === "duplicate-error")
                    zip.emit("error", Object.assign(new Error("SECOND_ERROR"), { code: "EBADF" }));
                await assert.rejects(closure.settle(), { code: "PAYLOAD_IO", causeCode: "EIO" });
                assert.equal(closure.failure(), first);
                assert.equal(await tx.cleanup(), "INCOMPLETE");
                zip.emit("close");
                zip.emit("error", new Error("LATE_ERROR"));
                await assert.rejects(closure.settle(), { code: "PAYLOAD_IO", causeCode: "EIO" });
                assert.equal(await tx.cleanup(), "INCOMPLETE");
                await lstat(tx.scratch);
                assert.equal(calls, 1);
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
