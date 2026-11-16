import assert from "node:assert/strict";
import { test } from "node:test";
import {
    readFile,
    lstat,
    readdir,
    writeFile,
    mkdir,
    rename,
    open,
    unlink,
    type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import {
    extractNodeSourceSnapshot,
    prepareMacNodeBootstrap,
} from "../scripts/runtime-node-bootstrap.ts";
import { ArchiveTransaction } from "../scripts/runtime-payload-transaction.ts";
import { RuntimePayloadError } from "../scripts/runtime-payload-inputs.ts";
import { assetFailure, OFFICIAL_ASSETS } from "../scripts/runtime-assets-observation.ts";
import { sha } from "../scripts/runtime-payload-tree.ts";
import { tarBytes } from "./fixtures/runtime-payload-archives.ts";
import { assetsFixture, fact } from "./fixtures/runtime-assets.ts";
import { nodeSourceEntries, nodeSourceFixture } from "./fixtures/runtime-node-bootstrap.ts";

/** 两个架构必须通过同一真实事务发布后逐字读取正文、引用和权限，同名包实例不能被全局去重；原始执行模式只保留成员事实，普通链接和无关文档 manifest 均不能被误当实际包实例。 */
for (const arch of ["x64", "arm64"] as const)
    test(`published ${arch} original bodies and physical npm instances`, async () => {
        const entries = nodeSourceEntries(arch);
        await nodeSourceFixture(async ({ tx, snapshot }) => {
            const result = await extractNodeSourceSnapshot(tx, arch, snapshot);
            assert.equal(result.npmPackages.length, 4);
            assert.deepEqual(
                result.npmPackages.map((p) => p.root),
                [...result.npmPackages.map((p) => p.root)].sort(),
            );
            assert.equal(result.members.kind, "ASSET_ARCHIVE_MEMBER_FACTS");
            assert.ok(Object.isFrozen(result.npmPackages));
            await tx.finishSources();
            assert.equal(await tx.publish(), "CONFIRMED");
            for (const p of result.npmPackages) {
                assert.equal(p.packageJson.path, `${p.root}/package.json`);
                const bytes = await readFile(join(tx.directory, p.packageJson.path));
                assert.equal(sha(bytes), p.packageJson.sha256);
                assert.equal(bytes.length, p.packageJson.sizeBytes);
                assert.deepEqual(JSON.parse(bytes.toString()).extra, { untouched: true });
            }
            for (const entry of entries.filter((e) => !e.kind)) {
                const path = join(tx.directory, "trees/node", entry.path);
                assert.equal(await readFile(path, "utf8"), entry.body);
                assert.equal((await lstat(path)).mode & 0o777, 0o600);
            }
            assert.equal(
                (
                    await lstat(
                        join(
                            tx.directory,
                            "trees/node",
                            `node-v24.22.1-darwin-${arch}/include/empty`,
                        ),
                    )
                ).mode & 0o777,
                0o700,
            );
            await assert.rejects(
                lstat(join(tx.directory, "trees/node", `node-v24.22.1-darwin-${arch}/bin/npm`)),
                { code: "ENOENT" },
            );
            assert.equal(
                result.members.members.find((m) => m.path.endsWith("/bin/node"))?.mode,
                0o755,
            );
            assert.equal(result.nodeMember, `trees/node/node-v24.22.1-darwin-${arch}/bin/node`);
            await assert.rejects(lstat(join(tx.directory, result.npmRoot, "bin/npm-alt.js")), {
                code: "ENOENT",
            });
            assert.equal(result.members.members.filter((m) => m.kind === "link").length, 2);
        }, entries);
    });

/** helper 的公开引用不是输出能力，必须独立核固定路径、完整 Ref 字段和实际快照正文；错误声明不能因事务已经 audit 过另一个真实 Ref 而通过，所有失败都发生在第二遍正文写入之前。 */
for (const field of ["path", "sha256", "sizeBytes", "extra"] as const)
    test(`helper rejects snapshot ${field} mismatch`, async () =>
        nodeSourceFixture(async ({ tx, snapshot }) => {
            const bad = {
                ...snapshot,
                ...(field === "path"
                    ? { path: "snapshots/other.tar.gz" }
                    : field === "sha256"
                      ? { sha256: "0".repeat(64) }
                      : field === "sizeBytes"
                        ? { sizeBytes: snapshot.sizeBytes + 1 }
                        : { extra: true }),
            };
            await assert.rejects(
                extractNodeSourceSnapshot(tx, "x64", bad),
                (e: unknown) => e instanceof RuntimePayloadError,
            );
            assert.deepEqual(await readdir(join(tx.scratch, "trees/node")), []);
        }));

/** 实例边界采用有限物理目录政策，缺失或无效 manifest、空依赖目录及目录别名都必须明确拒绝；每个案例仅改变真实 tar 的布局事实，不能通过伪造成员报告或源码字符串匹配替代产品行为。 */
for (const scenario of [
    "missing-required",
    "missing-manifest",
    "invalid-manifest",
    "oversize-manifest",
    "empty-modules",
    "bad-scope",
    "package-file",
    "alias-package",
    "alias-modules",
    "alias-scope",
    "alias-root",
] as const)
    test(`physical instance rejects ${scenario}`, async () => {
        let entries = nodeSourceEntries();
        const npm = "node-v24.22.1-darwin-x64/lib/node_modules/npm";
        const aliasManifest = entries.find((e) => e.path.endsWith("alias/package.json"));
        assert.ok(aliasManifest);
        if (scenario === "missing-required")
            entries = entries.filter((e) => !e.path.endsWith("/LICENSE"));
        if (scenario === "missing-manifest")
            entries = entries.filter((e) => !e.path.endsWith("alias/package.json"));
        if (scenario === "invalid-manifest")
            aliasManifest.body = '{"name":"duplicate","version":0}';
        if (scenario === "oversize-manifest") aliasManifest.body = " ".repeat(1024 ** 2 + 1);
        if (scenario === "empty-modules")
            entries.push({ path: `${npm}/node_modules/alias/node_modules`, kind: "directory" });
        if (scenario === "bad-scope")
            entries.push({ path: `${npm}/node_modules/@empty`, kind: "directory" });
        if (scenario === "package-file")
            entries.push({ path: `${npm}/node_modules/bad`, body: "not a directory" });
        if (scenario === "alias-package")
            entries.push({ path: `${npm}/node_modules/linked`, kind: "link", target: "alias" });
        if (scenario === "alias-modules")
            entries.push({
                path: `${npm}/node_modules/alias/node_modules`,
                kind: "link",
                target: "..",
            });
        if (scenario === "alias-scope")
            entries.push({ path: `${npm}/node_modules/@linked`, kind: "link", target: "@scope" });
        if (scenario === "alias-root") {
            entries = entries.filter(
                (e) => !e.path.startsWith(`${npm}/`) && !e.path.endsWith("/bin/npm"),
            );
            entries.push({ path: npm, kind: "link", target: "../../include" });
        }
        await nodeSourceFixture(async ({ tx, snapshot }) => {
            await assert.rejects(
                extractNodeSourceSnapshot(tx, "x64", snapshot),
                (e: unknown) =>
                    e instanceof RuntimePayloadError &&
                    (!scenario.startsWith("alias-") || e.code === "PAYLOAD_ARCHIVE_LINK"),
            );
        }, entries);
    });

/** 第二遍必须使用第一遍活对象逐成员比较，源快照在两遍之间发生实际字节替换时不得发布；这里通过事务重新计划边界注入完整可解析但不同正文，不以替换加密函数伪造摘要通过。 */
test("second-pass changed body is rejected", async (t) =>
    nodeSourceFixture(async ({ tx, snapshot }) => {
        const plan = tx.plan.bind(tx);
        t.mock.method(tx, "plan", async (bytes: number, entries: number) => {
            await plan(bytes, entries);
            const altered = nodeSourceEntries();
            assert.ok(altered[0]);
            altered[0].body = "changed Node body";
            await writeFile(join(tx.scratch, snapshot.path), tarBytes(altered));
        });
        await assert.rejects(extractNodeSourceSnapshot(tx, "x64", snapshot), {
            code: "PAYLOAD_SOURCE_CHANGED",
        });
    }));

/** 原来源必须在快照复制及发布前持续复验，原子替换不会因新文件字节相同被遗忘；该案例使用真实私有元数据、原 inode 与父目录观察，不替换生产的来源绑定算法。 */
test("original archive replacement remains detected after extraction", async () =>
    nodeSourceFixture(async ({ tx, root, snapshot }) => {
        const bytes = await readFile(join(tx.scratch, snapshot.path));
        await mkdir(join(root, "archives"), { mode: 0o700 });
        await writeFile(join(root, "archives/node.tar.gz"), bytes, { mode: 0o600 });
        await tx.observeRefs([fact("archives/node.tar.gz", bytes)]);
        await extractNodeSourceSnapshot(tx, "x64", snapshot);
        await writeFile(join(root, "archives/replacement"), bytes, { mode: 0o600 });
        await rename(join(root, "archives/replacement"), join(root, "archives/node.tar.gz"));
        await assert.rejects(tx.finishSources(), { code: "PAYLOAD_SOURCE_CHANGED" });
    }));

/** 固定官方输入不允许小归档冒充真实顶层成功，预先取消及首次等待后的 options 改写都通过真实入口观察；这组拒绝结果同时验证原候选哨兵没有被覆盖或当作旧临时目录清理。 */
test("pre-abort and owned input/options retain candidate sentinel", async () =>
    assetsFixture(async (f) => {
        const input = Buffer.from(
            JSON.stringify({
                schemaVersion: 1,
                kind: "MAC_RUNTIME_ASSETS_OBSERVATION_INPUT",
                arch: "x64",
                nodeVersion: "24.22.1",
                chromeVersion: "158.0.8127.18",
                playwrightVersion: "1.65.0",
                revision: "1254",
                source: f.source,
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
                fetchEvidence: {
                    path: "evidence/fetch.json",
                    sizeBytes: 1,
                    sha256: "c".repeat(64),
                },
            }),
        );
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            prepareMacNodeBootstrap(input, {
                inputRoot: f.root,
                outputParent: f.output,
                candidateName: "candidate",
                signal: controller.signal,
            }),
            { code: "PAYLOAD_CANCELLED" },
        );
        await mkdir(join(f.output, "candidate"), { mode: 0o700 });
        await writeFile(join(f.output, "candidate/sentinel"), "old", { mode: 0o600 });
        const options = { inputRoot: f.root, outputParent: f.output, candidateName: "candidate" };
        const pending = prepareMacNodeBootstrap(input, options);
        input.fill(0);
        options.candidateName = "changed";
        options.inputRoot = "/absent";
        await assert.rejects(pending, { code: "PAYLOAD_DESTINATION_EXISTS" });
        assert.equal(await readFile(join(f.output, "candidate/sentinel"), "utf8"), "old");
        assert.deepEqual(await readdir(f.output), ["candidate"]);
    }));

/** CLI 参数必须完整且各一次，所有宿主路径均显式绝对，失败 stdout 不能混入成功材料；子进程只运行本工具校验无效输入，不执行归档内容或调用真实网络获取。 */
for (const args of [
    [],
    ["--assets", "/a", "--assets", "/b"],
    ["--assets", "relative", "--input-root", "/a", "--output-parent", "/b", "--candidate", "c"],
    ["--unknown", "/a"],
])
    test(`CLI rejects flags ${JSON.stringify(args)}`, () => {
        const child = spawnSync(
            process.execPath,
            ["--import", "tsx", "scripts/prepare-macos-node-bootstrap.mjs", ...args],
            { encoding: "utf8" },
        );
        assert.equal(child.status, 1);
        assert.equal(child.stdout, "");
        assert.match(child.stderr, /PAYLOAD_INPUT_INVALID phase=INPUTS cleanup=NOT_NEEDED/);
    });

/** 真实事务 writer 的系统调用在写树正文时注入磁盘或配额错误，原始失败分类必须穿过新接缝及共同失败出口；这些是明确标记的 syscall 注入，不代表测试机器真的耗尽空间或运行了官方大归档。 */
for (const errno of ["ENOSPC", "EDQUOT"] as const)
    test(`injected real writer ${errno} preserves primary rejection`, async (t) =>
        nodeSourceFixture(async ({ tx, snapshot, base }) => {
            const probe = await open(join(base, "probe"), "wx", 0o600),
                prototype = Object.getPrototypeOf(probe) as FileHandle;
            await probe.close();
            await unlink(join(base, "probe"));
            const write = prototype.write,
                txWrite = tx.write.bind(tx);
            let injecting = false;
            t.mock.method(
                prototype,
                "write",
                async function (this: FileHandle, ...args: Parameters<FileHandle["write"]>) {
                    if (injecting)
                        throw Object.assign(new Error("INJECTED_WRITE_FAILURE"), { code: errno });
                    return write.apply(this, args);
                },
            );
            t.mock.method(tx, "write", async (...args: Parameters<ArchiveTransaction["write"]>) => {
                injecting = args[0].startsWith("trees/node/");
                try {
                    return await txWrite(...args);
                } finally {
                    injecting = false;
                }
            });
            try {
                await assert.rejects(
                    (async () => {
                        try {
                            await extractNodeSourceSnapshot(tx, "x64", snapshot);
                        } catch (error) {
                            return assetFailure(tx, error);
                        }
                    })(),
                    (e: unknown) =>
                        e instanceof RuntimePayloadError &&
                        e.code === "PAYLOAD_DISK_INSUFFICIENT" &&
                        e.causeCode === errno &&
                        e.cleanup === "CONFIRMED",
                );
                await assert.rejects(lstat(tx.scratch), { code: "ENOENT" });
                await assert.rejects(lstat(tx.directory), { code: "ENOENT" });
            } finally {
                t.mock.restoreAll();
            }
        }));

/** 独立快照读取器真实 close 后注入不确定结果，接缝必须先通知事务再进入清理；未确认状态保留本次 scratch 与锁并继续报告 INCOMPLETE，不能因为真实 syscall 已返回就偷偷重试或假报安全删除。 */
test("injected helper close uncertainty retains scratch and lock", async (t) =>
    nodeSourceFixture(async ({ tx, snapshot, base }) => {
        const probe = await open(join(base, "probe"), "wx", 0o600),
            prototype = Object.getPrototypeOf(probe) as FileHandle;
        await probe.close();
        await unlink(join(base, "probe"));
        const read = prototype.read;
        let patched = false,
            closeCount = 0;
        t.mock.method(
            prototype,
            "read",
            function (this: FileHandle, ...args: Parameters<FileHandle["read"]>) {
                // 现有 audit 使用成熟 stream，而接缝的位置读取通过公开 FileHandle.read 进入；故障只绑定首个独立读取对象一次，避免影响事务清理自身新开的句柄或夹具 finally 的回收。
                if (!patched && (args as unknown[])[3] === 0) {
                    patched = true;
                    const close = this.close;
                    t.mock.method(this, "close", async () => {
                        closeCount++;
                        await close.call(this);
                        throw Object.assign(new Error("INJECTED_CLOSE_UNCONFIRMED"), {
                            code: "EIO",
                        });
                    });
                }
                return read.apply(this, args);
            },
        );
        try {
            await assert.rejects(
                (async () => {
                    try {
                        await extractNodeSourceSnapshot(tx, "x64", snapshot);
                    } catch (error) {
                        return assetFailure(tx, error);
                    }
                })(),
                (e: unknown) =>
                    e instanceof RuntimePayloadError &&
                    e.code === "PAYLOAD_IO" &&
                    e.cleanup === "INCOMPLETE",
            );
            assert.equal(closeCount, 1);
            assert.ok((await lstat(tx.scratch)).isDirectory());
            assert.ok((await lstat(tx.lockPath)).isFile());
        } finally {
            t.mock.restoreAll();
        }
    }));

/** 最终路径 audit 失去确认时必须保留已经 rename 的真实目录及锁，发布异常不能被后续普通清理改写为成功；这里在真实发布后的最终 audit 注入 EIO，不伪造已提交结果，也不删除旧候选以换取通过。 */
test("injected final audit uncertainty preserves committed material", async (t) =>
    nodeSourceFixture(async ({ tx, snapshot }) => {
        await extractNodeSourceSnapshot(tx, "x64", snapshot);
        const audit = tx.audit.bind(tx);
        t.mock.method(tx, "audit", async (root?: string) => {
            if (root === tx.directory)
                throw Object.assign(new Error("INJECTED_FINAL_AUDIT_FAILURE"), { code: "EIO" });
            return audit(root);
        });
        try {
            await assert.rejects(
                (async () => {
                    try {
                        await tx.publish();
                    } catch (error) {
                        return assetFailure(tx, error);
                    }
                })(),
                (e: unknown) =>
                    e instanceof RuntimePayloadError &&
                    e.code === "PAYLOAD_COMMIT_UNCONFIRMED" &&
                    e.cleanup === "INCOMPLETE" &&
                    e.phase === "PUBLISH",
            );
            assert.ok((await lstat(tx.directory)).isDirectory());
            assert.ok((await lstat(tx.lockPath)).isFile());
        } finally {
            t.mock.restoreAll();
        }
    }));

/** 原快照在打开前被换成不安全权限或硬链接时不得进入扫描，两次独立身份核验不能只比较摘要；这些案例仅触及测试新建的小文件，真实生产源码、共享依赖与历史证据的模式和 inode 均保持不变。 */
for (const scenario of ["mode", "hardlink", "missing"] as const)
    test(`helper rejects snapshot physical ${scenario}`, async () =>
        nodeSourceFixture(async ({ tx, snapshot, base }) => {
            const { chmod, link } = await import("node:fs/promises");
            const path = join(tx.scratch, snapshot.path);
            if (scenario === "mode") await chmod(path, 0o666);
            if (scenario === "hardlink") await link(path, join(base, "extra-link"));
            if (scenario === "missing") await unlink(path);
            await assert.rejects(extractNodeSourceSnapshot(tx, "x64", snapshot));
            assert.deepEqual(await readdir(join(tx.scratch, "trees/node")), []);
        }));

/** 有效包实例数量必须先于正文落盘执行固定四千上限，微型高压夹具只写压缩快照而不制造数千落地目录；这证明新增消费者没有按名称去重来绕过实例限额，也没有把 metadata 预算留到发布时才补核。 */
test("physical npm instance limit rejects before extraction", async () => {
    const entries = nodeSourceEntries(),
        npm = "node-v24.22.1-darwin-x64/lib/node_modules/npm";
    for (let i = 0; i < 4000; i++)
        entries.push({
            path: `${npm}/node_modules/p${i}/package.json`,
            body: '{"name":"same","version":"1.0.0"}',
        });
    await nodeSourceFixture(async ({ tx, snapshot }) => {
        await assert.rejects(extractNodeSourceSnapshot(tx, "x64", snapshot), {
            code: "PAYLOAD_LIMIT",
        });
        assert.deepEqual(await readdir(join(tx.scratch, "trees/node")), []);
    }, entries);
});

/** 信号测试在外层 JSON 的真实 held FD 读取前建立可观察阻塞，只把测试读取延迟而不改产品接口；首信号可释放并正常取消，二次信号及五秒期限则必须报告未知阶段和未确认清理，绝不借旧 INTAKE 常量猜测事务。 */
for (const mode of ["normal", "second", "deadline"] as const)
    test(`CLI ${mode} signal termination is finite and truthful`, { timeout: 12000 }, async () =>
        nodeSourceFixture(async ({ root }) => {
            const assets = join(root, "assets.json"),
                hook = join(root, "signal-hook.mjs");
            await writeFile(assets, "{}", { mode: 0o600 });
            await writeFile(
                hook,
                `
import { open } from "node:fs/promises";
const probe = await open(new URL("assets.json", import.meta.url), "r");
const prototype = Object.getPrototypeOf(probe), target = (await probe.stat()).ino;
await probe.close();
const read = prototype.read;
let blocked = false, release;
const keepAlive = setTimeout(() => {}, 11000);
prototype.read = async function (...args) {
    if (!blocked && (await this.stat()).ino === target) {
        blocked = true;
        process.stderr.write("TEST_READER_BLOCKED\\n");
        await new Promise(resolve => { release = resolve; });
    }
    return read.apply(this, args);
};
process.on("SIGINT", () => {
    clearTimeout(keepAlive);
    process.stderr.write("TEST_SIGNAL_SEEN\\n");
    ${mode === "normal" ? "release?.();" : ""}
});
`,
                { mode: 0o600 },
            );
            const child = spawn(
                process.execPath,
                [
                    "--import",
                    "tsx",
                    "--import",
                    hook,
                    "scripts/prepare-macos-node-bootstrap.mjs",
                    "--assets",
                    assets,
                    "--input-root",
                    root,
                    "--output-parent",
                    "/unused",
                    "--candidate",
                    "candidate",
                ],
                { stdio: ["ignore", "pipe", "pipe"] },
            );
            let stdout = "",
                stderr = "",
                signalSent = false,
                secondSent = false;
            child.stdout.on("data", (chunk) => {
                stdout += chunk;
            });
            child.stderr.on("data", (chunk) => {
                stderr += chunk;
                if (!signalSent && stderr.includes("TEST_READER_BLOCKED")) {
                    signalSent = true;
                    child.kill("SIGINT");
                }
                if (mode === "second" && !secondSent && stderr.includes("TEST_SIGNAL_SEEN")) {
                    secondSent = true;
                    child.kill("SIGTERM");
                }
            });
            const emergency = setTimeout(() => child.kill("SIGKILL"), 10000);
            try {
                const status = await new Promise<number | null>((resolve, reject) => {
                    child.once("error", reject);
                    child.once("close", resolve);
                });
                assert.equal(status, 130, stderr);
                assert.equal(stdout, "");
                assert.match(
                    stderr,
                    mode === "normal"
                        ? /PAYLOAD_CANCELLED phase=INPUTS cleanup=NOT_NEEDED/
                        : /PAYLOAD_CANCELLED phase=UNKNOWN cleanup=INCOMPLETE/,
                );
            } finally {
                clearTimeout(emergency);
                if (child.exitCode === null) child.kill("SIGKILL");
            }
        }),
    );

/** 接缝在首次异步 audit 前复制引用对象，调用者等待期间改写路径或摘要不会改变已经选定快照；这与官方入口固定摘要是不同的不变量，测试仍通过真实 helper 提取和原事务发布来观察字节结果。 */
test("helper owns snapshot Ref before first await", async () =>
    nodeSourceFixture(async ({ tx, snapshot }) => {
        const argument = { ...snapshot },
            promise = extractNodeSourceSnapshot(tx, "x64", argument);
        argument.path = "snapshots/changed";
        argument.sha256 = "0".repeat(64);
        argument.sizeBytes = 0;
        const result = await promise;
        await tx.publish();
        assert.equal(
            await readFile(join(tx.directory, result.nodeMember), "utf8"),
            "synthetic Node body",
        );
    }));

/** 来源元数据初读和事务登记之间的同字节原子替换必须由原 reader 的身份收尾拒绝，不能用较晚登记的新 inode 盖掉原事实；这里组合新增消费者实际采用的公开 reader 与 source binding，不下载或伪造官方
 * 大包。 */
test("source metadata replacement before registration remains rejected", async () =>
    assetsFixture(async (f) => {
        const { InputReader } = await import("../scripts/runtime-payload-tree.ts");
        const { bindAssetSources } = await import("../scripts/runtime-assets-observation.ts");
        const reader = new InputReader(f.root, undefined, []);
        await reader.initialize();
        const bound = await bindAssetSources(reader, f.source, "x64");
        const original = await readFile(join(f.root, f.source.evidence.path));
        await writeFile(join(f.root, "evidence/replacement"), original, { mode: 0o600 });
        await rename(join(f.root, "evidence/replacement"), join(f.root, f.source.evidence.path));
        const tx = new ArchiveTransaction(f.root, f.output, "replaced-source");
        try {
            await tx.initialize();
            await tx.observeRefs([f.source.evidence]);
            await assert.rejects(reader.finish(), { code: "PAYLOAD_SOURCE_CHANGED" });
            await assert.rejects(bound.finish(), { code: "PAYLOAD_SOURCE_CHANGED" });
            assert.equal(await tx.cleanup(), "CONFIRMED");
        } finally {
            await tx.cleanup();
        }
    }));

/** 完整四参数调用必须把真实私有输入文件交给核心严格准入，官方摘要与来源证据错误不能通过 CLI 包装变成成功结果；测试只构造小 JSON 和真实十九项来源事实，既不生成官方 tar 替身也不核不存在的 Chrome 正文。 */
for (const scenario of ["input", "official-hash", "source-ref"] as const)
    test(`CLI actual ${scenario} rejection preserves INPUTS phase`, async () =>
        assetsFixture(async (f) => {
            const value = {
                schemaVersion: 1,
                kind: "MAC_RUNTIME_ASSETS_OBSERVATION_INPUT",
                arch: "x64",
                nodeVersion: "24.22.1",
                chromeVersion: "158.0.8127.18",
                playwrightVersion: "1.65.0",
                revision: "1254",
                source: { ...f.source, evidence: { ...f.source.evidence, sha256: "0".repeat(64) } },
                node: {
                    path: "archives/node.tar.gz",
                    sizeBytes: OFFICIAL_ASSETS.x64.nodeBytes,
                    sha256:
                        scenario === "official-hash" ? "0".repeat(64) : OFFICIAL_ASSETS.x64.nodeSha,
                },
                chrome: {
                    path: "archives/chrome.zip",
                    sizeBytes: OFFICIAL_ASSETS.x64.chromeBytes,
                    sha256: "b".repeat(64),
                },
                fetchEvidence: {
                    path: "evidence/fetch.json",
                    sizeBytes: 1,
                    sha256: "c".repeat(64),
                },
            };
            const path = join(f.root, "assets.json");
            await writeFile(path, JSON.stringify(scenario === "input" ? {} : value), {
                mode: 0o600,
            });
            const child = spawnSync(
                process.execPath,
                [
                    "--import",
                    "tsx",
                    "scripts/prepare-macos-node-bootstrap.mjs",
                    "--assets",
                    path,
                    "--input-root",
                    f.root,
                    "--output-parent",
                    f.output,
                    "--candidate",
                    "candidate",
                ],
                { encoding: "utf8" },
            );
            assert.equal(child.status, 1);
            assert.equal(child.stdout, "");
            const code =
                scenario === "input"
                    ? "PAYLOAD_INPUT_INVALID"
                    : scenario === "official-hash"
                      ? "PAYLOAD_ARCHIVE_HASH"
                      : "PAYLOAD_SOURCE_CHANGED";
            assert.equal(child.stderr, `${code} phase=INPUTS cleanup=NOT_NEEDED\n`);
            assert.deepEqual(await readdir(f.output), []);
        }));

/** 提取 manifest 的真实 held inode 与快照及 audit 读取分开定位，close 在真实系统关闭后注入无法确认结果；普通成功读取和较早身份拒绝都必须仅关闭一次、保留 scratch 与锁，并且较早错误不能被
 *  EIO 覆盖。 */
for (const primaryReadFailure of [false, true])
    test(
        `extracted manifest inode close uncertainty preserves ` +
            `${primaryReadFailure ? "primary read rejection" : "valid read"}`,
        async (t) =>
            nodeSourceFixture(async ({ tx, snapshot, base, output }) => {
                const old = join(output, "old-candidate");
                await mkdir(old, { mode: 0o700 });
                await writeFile(join(old, "sentinel"), "untouched old candidate", { mode: 0o600 });
                const probe = await open(join(base, "probe"), "wx", 0o600),
                    prototype = Object.getPrototypeOf(probe) as FileHandle;
                await probe.close();
                await unlink(join(base, "probe"));
                const stat = prototype.stat,
                    stream = prototype.createReadStream,
                    audit = tx.audit.bind(tx);
                const injected = new WeakSet<FileHandle>(),
                    streamErrors: string[] = [];
                // 旧 manifest ReadStream 在真实 FileHandle 关闭事件后还会尝试关闭并发出次要错误，测试只记录该已注入对象的事件以便继续观察真实 assetFailure；事件内容完整进入诊
                // 断，原拒
                // 绝和清理断言均不放宽。
                t.mock.method(
                    prototype,
                    "createReadStream",
                    function (
                        this: FileHandle,
                        options: Parameters<FileHandle["createReadStream"]>[0],
                    ) {
                        const result = stream.call(this, options);
                        if (injected.has(this))
                            result.on("error", (error) => {
                                streamErrors.push(error.message);
                            });
                        return result;
                    },
                );
                let auditCount = 0,
                    target: { ino: bigint; dev: bigint } | undefined,
                    armed = false,
                    bound = false,
                    closeCount = 0;
                t.mock.method(tx, "audit", async (root?: string) => {
                    await audit(root);
                    auditCount++;
                    if (auditCount === 2) {
                        target = await lstat(
                            join(
                                tx.scratch,
                                "trees/node/node-v24.22.1-darwin-x64/lib/node_modules/npm/package.json",
                            ),
                            { bigint: true },
                        );
                        armed = true;
                    }
                });
                t.mock.method(
                    prototype,
                    "stat",
                    async function (this: FileHandle, ...args: Parameters<FileHandle["stat"]>) {
                        const info = await stat.apply(this, args);
                        if (
                            armed &&
                            !bound &&
                            info.ino === target?.ino &&
                            info.dev === target.dev
                        ) {
                            bound = true;
                            injected.add(this);
                            const close = this.close;
                            t.mock.method(this, "close", async () => {
                                closeCount++;
                                await close.call(this);
                                throw Object.assign(
                                    new Error("INJECTED_MANIFEST_CLOSE_UNCONFIRMED"),
                                    {
                                        code: "EIO",
                                    },
                                );
                            });
                            if (primaryReadFailure)
                                return { ...info, size: BigInt(info.size) + 1n };
                        }
                        return info;
                    },
                );
                let rejection: unknown;
                try {
                    try {
                        await extractNodeSourceSnapshot(tx, "x64", snapshot);
                        assert.fail("Manifest close uncertainty must reject");
                    } catch (error) {
                        try {
                            await assetFailure(tx, error);
                        } catch (failure) {
                            rejection = failure;
                        }
                    }
                    t.diagnostic(
                        JSON.stringify({
                            injectedStreamErrors: streamErrors,
                            closeCount,
                            rejection:
                                rejection instanceof RuntimePayloadError
                                    ? {
                                          code: rejection.code,
                                          causeCode: rejection.causeCode,
                                          cleanup: rejection.cleanup,
                                      }
                                    : "unknown",
                            retainedOutput: await readdir(output),
                            oldSentinel: await readFile(join(old, "sentinel"), "utf8"),
                        }),
                    );
                    assert.ok(bound, "The extracted manifest inode must reach its consumer");
                    assert.equal(closeCount, 1);
                    assert.ok(rejection instanceof RuntimePayloadError);
                    assert.equal(
                        rejection.code,
                        primaryReadFailure ? "PAYLOAD_SOURCE_CHANGED" : "PAYLOAD_IO",
                    );
                    assert.equal(rejection.causeCode, primaryReadFailure ? null : "EIO");
                    assert.equal(rejection.cleanup, "INCOMPLETE");
                    assert.ok((await lstat(tx.scratch)).isDirectory());
                    assert.ok((await lstat(tx.lockPath)).isFile());
                    assert.equal(
                        await readFile(join(old, "sentinel"), "utf8"),
                        "untouched old candidate",
                    );
                } finally {
                    t.mock.restoreAll();
                }
            }),
    );

/** 关闭确认并不结束来源身份保护，manifest 读完后到 helper 收尾之间的同字节文件替换或父目录变动仍必须拒绝；这些真实小文件变更专门检查新 reader 的保留观察，避免只修 close 却丢掉原 InputRead
 * er.finish 的变化检测。 */
for (const mutation of ["file", "parent"] as const)
    test(`extracted manifest finish rejects later ${mutation} mutation`, async (t) =>
        nodeSourceFixture(async ({ tx, snapshot }) => {
            const manifest = join(
                tx.scratch,
                "trees/node/node-v24.22.1-darwin-x64/lib/node_modules/npm/package.json",
            );
            const probe = await open(join(tx.scratch, snapshot.path), "r");
            const prototype = Object.getPrototypeOf(probe) as FileHandle;
            await probe.close();
            const stat = prototype.stat,
                audit = tx.audit.bind(tx);
            let target: { ino: bigint; dev: bigint } | undefined,
                count = 0,
                changed = false;
            t.mock.method(tx, "audit", async (root?: string) => {
                await audit(root);
                if (++count === 2) target = await lstat(manifest, { bigint: true });
            });
            t.mock.method(
                prototype,
                "stat",
                async function (this: FileHandle, ...args: Parameters<FileHandle["stat"]>) {
                    const info = await stat.apply(this, args);
                    if (!changed && info.ino === target?.ino && info.dev === target.dev) {
                        changed = true;
                        const close = this.close;
                        t.mock.method(this, "close", async () => {
                            await close.call(this);
                            const extra = join(manifest, "..", "replacement");
                            if (mutation === "file") {
                                await writeFile(extra, await readFile(manifest), { mode: 0o600 });
                                await rename(extra, manifest);
                            } else await writeFile(extra, "new sibling", { mode: 0o600 });
                        });
                    }
                    return info;
                },
            );
            try {
                await assert.rejects(extractNodeSourceSnapshot(tx, "x64", snapshot), {
                    code: "PAYLOAD_SOURCE_CHANGED",
                });
                assert.ok(changed);
            } finally {
                t.mock.restoreAll();
            }
        }));
