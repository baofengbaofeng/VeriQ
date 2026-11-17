import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Arch, Ref, Cleanup } from "./runtime-payload-inputs.ts";
import { ArchiveBudget, ArchiveScan, type StageOptions, type ArchiveMember } from "./runtime-payload-archive.ts";
import { ArchiveTransaction } from "./runtime-payload-transaction.ts";
import { InputReader, decode, freeze, limits, relative, sha } from "./runtime-payload-tree.ts";
import { scanTar } from "./runtime-payload-tar.ts";
import {
    assetArch,
    assetRef,
    assetOptions,
    assetFailure,
    bindAssetSources,
    parseAssetsObservationInput,
    writeAssetJson,
    type MemberFacts,
    type SourceObservation,
} from "./runtime-assets-observation.ts";

/**
 * 包实例只指向本 artifact 中真正提取的物理目录及原始 manifest 字节，重复名称和版本仍保存不同根；这里不生成依赖图、不猜
 * 测解析结果，也不把静态来源材料变成可执行 Node 布局或批准收据。
 */
export type NpmPackageSource = Readonly<{ root: string; packageJson: Ref }>;
const pending = [
    "SOURCE_REVIEW",
    "NPM_GRAPH_AND_TARGET_RESOLUTION",
    "EXECUTABLE_NODE_LAYOUT",
    "CHROME_LAYOUT_AND_EXTRACTION",
    "FULL_RUNTIME_STAGE",
] as const;
/**
 * 回执只绑定 Node 原归档、原成员和完整物理包实例材料，来源未审与后续待办始终保留；Chrome 字段不在本入口消费，后续提取及
 * 集成仍待完成，已有独立布局观察不会被本回执重新声称验证。
 */
export type NodeBootstrapReceipt = Readonly<{
    schemaVersion: 1;
    kind: "NODE_NPM_SOURCE_TREE";
    inputSha256: string;
    arch: Arch;
    nodeVersion: "24.22.1";
    source: SourceObservation;
    sourceStatus: "UNREVIEWED_SOURCE";
    archive: Ref;
    members: Ref;
    nodeMember: string;
    npmRoot: string;
    npmPackages: readonly NpmPackageSource[];
    producerFiles: readonly Ref[];
    pending: typeof pending;
}>;
/**
 * 结果只有在事务完成最终路径 audit 后才返回 committed，cleanup 直接沿用真实事务关闭和锁收尾事实；回执摘要放在外层 Ref
 * 而不写自摘要，成功不代表 Node 可执行、来源已审或完整 Runtime 已交
 * 付。
 */
export type NodeBootstrapResult = Readonly<{
    kind: "NODE_NPM_SOURCE_TREE_RESULT";
    directory: string;
    receipt: Ref;
    committed: true;
    cleanup: Cleanup;
}>;
const extractedReaders = new WeakMap<ArchiveTransaction, { finish: () => Promise<void> }>();
const metadataReserve = 2 * limits.json + 2 * limits.json;

/**
 * 身份比较覆盖设备、inode、长度、模式、链接数和纳秒时间，读取与收尾都保持第一次观察而不重试；此处只检测已观察变化，不承
 * 诺抵抗恶意同 UID 对父路径并发替换的原子整树能力。
 */
function same(a: BigIntStats, b: BigIntStats) {
    return (
        a.dev === b.dev &&
        a.ino === b.ino &&
        a.size === b.size &&
        a.mode === b.mode &&
        a.nlink === b.nlink &&
        a.mtimeNs === b.mtimeNs &&
        a.ctimeNs === b.ctimeNs
    );
}

/**
 * 位置读取把 FD 的生命周期留在本模块唯一拥有者内，每块六十四 KiB 且显式偏移从零开始；不会积累完整大包或让重复创建的
 * ReadStream 隐式参与 close，producer 复制也复用相同有界读取。
 */
async function* fileChunks(tx: ArchiveTransaction, handle: FileHandle): AsyncGenerator<Buffer> {
    const buffer = Buffer.alloc(65536);
    let position = 0;
    while (true) {
        tx.check();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        tx.check();
        if (!bytesRead) return;
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
    }
}

/**
 * 大快照通过独立 held FD 以六十四 KiB 块核原始长度和摘要，拒绝 whole-buffer 读取及单独路径断言；close 只尝试一次，无法
 * 确认时通知事务保留 scratch，绝不重试可能已经复用的数字 FD。
 */
async function holdFile(tx: ArchiveTransaction, path: string, expected?: Ref, maximum = limits.file) {
    tx.check();
    const before = await lstat(path, { bigint: true });
    tx.check();
    if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size > BigInt(maximum) ||
        ![0o400, 0o600, 0o444, 0o644].includes(Number(before.mode & 0o7777n))
    )
        tx.fail("PAYLOAD_PATH");
    let handle: FileHandle | undefined, primary: unknown;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const held = handle;
        let reference = expected;
        const check = async () => {
            tx.check();
            if (!same(before, await held.stat({ bigint: true })) || !same(before, await lstat(path, { bigint: true })))
                tx.fail("PAYLOAD_SOURCE_CHANGED");
            const digest = createHash("sha256");
            let size = 0;
            for await (const chunk of fileChunks(tx, held)) {
                tx.check();
                size += chunk.length;
                if (size > maximum || size > Number(before.size)) tx.fail("PAYLOAD_SOURCE_CHANGED");
                digest.update(chunk);
            }
            const actual = {
                path: reference?.path ?? "producer",
                sizeBytes: size,
                sha256: digest.digest("hex"),
            };
            if (
                size !== Number(before.size) ||
                (reference && (actual.sizeBytes !== reference.sizeBytes || actual.sha256 !== reference.sha256))
            )
                tx.fail("PAYLOAD_SOURCE_CHANGED");
            if (!same(before, await held.stat({ bigint: true })) || !same(before, await lstat(path, { bigint: true })))
                tx.fail("PAYLOAD_SOURCE_CHANGED");
            tx.check();
            reference ??= freeze(actual);
        };
        await check();
        let closed = false;
        const close = async () => {
            if (closed) return;
            closed = true;
            try {
                await held.close();
            } catch (error) {
                tx.noteCloseFailure();
                throw error;
            }
        };
        if (!reference) tx.fail("PAYLOAD_SOURCE_CHANGED");
        return { ref: reference, check, close, handle: held };
    } catch (error) {
        primary = error;
        throw error;
    } finally {
        if (primary && handle) {
            try {
                await handle.close();
            } catch {
                tx.noteCloseFailure();
            }
        }
    }
}

/**
 * 提取 manifest 的读取由当前事务唯一拥有 FD 及关闭状态，根准入仍复用 InputReader 而不调用其无法转交 close 状态的 input
 * ；每个父目录与文件保留初始身份，完整有界正文独立核原成员摘要，发布前
 * finish 继续核相同观察。
 */
async function extractedManifestReader(tx: ArchiveTransaction) {
    const root = join(tx.scratch, "trees/node"),
        admission = new InputReader(root, tx.signal, []);
    await admission.initialize();
    const observations = new Map<string, BigIntStats>();
    const observe = async (path: string, directory: boolean) => {
        tx.check();
        const info = await lstat(path, { bigint: true });
        tx.check();
        if (
            directory
                ? !info.isDirectory() || ![0o700, 0o755, 0o555].includes(Number(info.mode & 0o7777n))
                : !info.isFile() ||
                  info.ino === 0n ||
                  info.nlink !== 1n ||
                  ![0o400, 0o600, 0o444, 0o644].includes(Number(info.mode & 0o7777n))
        )
            tx.fail("PAYLOAD_TREE_MISMATCH");
        const prior = observations.get(path);
        if (prior && !same(prior, info)) tx.fail("PAYLOAD_SOURCE_CHANGED");
        observations.set(path, info);
    };
    const finish = async () => {
        await admission.finish();
        for (const [path, before] of observations) {
            tx.check();
            if (!same(before, await lstat(path, { bigint: true }))) tx.fail("PAYLOAD_SOURCE_CHANGED");
        }
        tx.check();
    };
    const read = async (value: Ref) => {
        const ref = assetRef(value);
        relative(ref.path);
        if (ref.sizeBytes > limits.package) tx.fail("PAYLOAD_LIMIT");
        let parent = root;
        await observe(parent, true);
        for (const part of ref.path.split("/").slice(0, -1)) {
            parent = join(parent, part);
            await observe(parent, true);
        }
        const full = join(root, ref.path);
        await observe(full, false);
        let held: Awaited<ReturnType<typeof holdFile>> | undefined;
        try {
            held = await holdFile(tx, full, ref, limits.package);
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of fileChunks(tx, held.handle)) {
                size += chunk.length;
                if (size > ref.sizeBytes || size > limits.package) tx.fail("PAYLOAD_LIMIT");
                chunks.push(Buffer.from(chunk));
            }
            const bytes = Buffer.concat(chunks, size);
            if (size !== ref.sizeBytes || sha(bytes) !== ref.sha256) tx.fail("PAYLOAD_SOURCE_CHANGED");
            await held.check();
            await held.close();
            held = undefined;
            return bytes;
        } finally {
            // 只有确认关闭才从成功路径返回；失败路径保留最早的读取、身份或摘要拒绝，次要关闭不确定由唯一拥有者先通知事
            // 务，防止 assetFailure 在未知 FD 尚存时递归删除 scratch 或锁。
            if (held) {
                try {
                    await held.close();
                } catch {
                    tx.noteCloseFailure();
                }
            }
        }
    };
    return Object.freeze({ read, finish });
}

/**
 * 包根发现只沿实例自身的 node_modules 和可选 scope 两级边界推进，目录名允许 npm alias 而不要求等于 manifest.name；空目
 * 录、非目录包根及影响发现的链接都失败关闭，普通文件链接仍仅保留在
 * 成员事实。
 */
function packageRoots(scan: ArchiveScan, npm: string): string[] {
    const children = new Map<string, string[]>();
    for (const path of scan.effective.keys()) {
        const parent = path.slice(0, path.lastIndexOf("/"));
        const list = children.get(parent) ?? [];
        list.push(path);
        children.set(parent, list);
    }
    const roots = [npm];
    const directory = (path: string) => {
        const kind = scan.effective.get(path)?.kind;
        if (kind === "link") scan.tx.fail("PAYLOAD_ARCHIVE_LINK");
        if (kind !== "directory") scan.tx.fail("PAYLOAD_INPUT_INVALID");
    };
    directory(npm);
    for (let index = 0; index < roots.length; index++) {
        const modules = `${roots[index]}/node_modules`;
        if (!scan.effective.has(modules)) continue;
        directory(modules);
        const entries = children.get(modules) ?? [];
        if (!entries.length) scan.tx.fail("PAYLOAD_INPUT_INVALID");
        for (const entry of entries) {
            directory(entry);
            const name = entry.slice(modules.length + 1);
            if (name.startsWith("@")) {
                if (!/^@[a-zA-Z0-9_~-][a-zA-Z0-9._~-]*$/.test(name)) scan.tx.fail("PAYLOAD_INPUT_INVALID");
                const scoped = children.get(entry) ?? [];
                if (!scoped.length) scan.tx.fail("PAYLOAD_INPUT_INVALID");
                for (const pkg of scoped) {
                    directory(pkg);
                    if (!/^[a-zA-Z0-9_~-][a-zA-Z0-9._~-]*$/.test(pkg.slice(entry.length + 1)))
                        scan.tx.fail("PAYLOAD_INPUT_INVALID");
                    roots.push(pkg);
                }
            } else {
                if (!/^[a-zA-Z0-9_~-][a-zA-Z0-9._~-]*$/.test(name)) scan.tx.fail("PAYLOAD_INPUT_INVALID");
                roots.push(entry);
            }
            if (roots.length > limits.instances) scan.tx.fail("PAYLOAD_LIMIT");
        }
    }
    return roots.sort();
}

/**
 * 内部接缝消费真实事务拥有的固定 Node 快照，两遍仍使用同一成熟扫描器和活的第一遍成员表；返回原始成员及物理包 manifest
 * 引用，不允许覆盖官方入口描述或伪造依赖图及目标解析证明。
 */
export async function extractNodeSourceSnapshot(
    tx: ArchiveTransaction,
    arch: Arch,
    snapshot: Ref,
): Promise<{
    members: MemberFacts;
    nodeMember: string;
    npmRoot: string;
    npmPackages: readonly NpmPackageSource[];
}> {
    const selectedArch = assetArch(arch),
        ref = assetRef(snapshot);
    if (ref.path !== "snapshots/node.tar.gz") tx.fail("PAYLOAD_PATH");
    const top = `node-v24.22.1-darwin-${selectedArch}`,
        npm = `${top}/lib/node_modules/npm`;
    let held: Awaited<ReturnType<typeof holdFile>> | undefined;
    try {
        await tx.audit();
        held = await holdFile(tx, join(tx.scratch, ref.path), ref);
        const budget = new ArchiveBudget(),
            first = new ArchiveScan("node", top, tx, budget);
        await scanTar(join(tx.scratch, ref.path), first);
        first.links(first.members.filter((m): m is Extract<ArchiveMember, { kind: "link" }> => m.kind === "link"));
        const files = new Map(
            first.members
                .filter((m): m is Extract<ArchiveMember, { kind: "file" }> => m.kind === "file")
                .map((m) => [m.path, m]),
        );
        const roots = packageRoots(first, npm);
        for (const path of [`${top}/bin/node`, `${top}/LICENSE`, `${npm}/package.json`, `${npm}/bin/npm-cli.js`]) {
            if (!files.has(path))
                tx.fail(first.effective.get(path)?.kind === "link" ? "PAYLOAD_ARCHIVE_LINK" : "PAYLOAD_INPUT_INVALID");
        }
        for (const root of roots) {
            const manifest = files.get(`${root}/package.json`);
            if (!manifest) tx.fail("PAYLOAD_INPUT_INVALID");
            if (manifest.sizeBytes > limits.package) tx.fail("PAYLOAD_LIMIT");
        }
        await held.check();
        await tx.finishSources();
        // plan 会重置剩余量，所以必须包含全部尚未写入正文、有效条目及成员与回执和两个 producer 的有界上限；快照已经落盘
        // 不再计费，第二遍也不再次消费 ArchiveBudget 的逻辑成员费用。
        await tx.plan(
            [...files.values()].reduce((n, f) => n + f.sizeBytes, 0) + metadataReserve,
            first.effective.size + 12,
        );
        await scanTar(join(tx.scratch, ref.path), new ArchiveScan("node", top, tx, budget, first));
        await held.check();
        await tx.audit();
        const reader = await extractedManifestReader(tx);
        const packages: NpmPackageSource[] = [];
        for (const root of roots) {
            const member = files.get(`${root}/package.json`);
            if (!member) tx.fail("PAYLOAD_INPUT_INVALID");
            const local = { path: member.path, sizeBytes: member.sizeBytes, sha256: member.sha256 };
            const manifest = decode(await reader.read(local));
            if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) tx.fail("PAYLOAD_INPUT_INVALID");
            const record = manifest as Record<string, unknown>;
            if (
                typeof record.name !== "string" ||
                !/^(?:@[a-zA-Z0-9_~-][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9_~-][a-zA-Z0-9._~-]*$/.test(record.name) ||
                typeof record.version !== "string" ||
                !record.version.trim() ||
                record.version.length > 1024 ||
                Array.from(record.version).some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
            )
                tx.fail("PAYLOAD_INPUT_INVALID");
            packages.push({
                root: `trees/node/${root}`,
                packageJson: { ...local, path: `trees/node/${local.path}` },
            });
        }
        await reader.finish();
        extractedReaders.set(tx, reader);
        await tx.finishSources();
        await held.check();
        const result = freeze({
            members: {
                schemaVersion: 1,
                kind: "ASSET_ARCHIVE_MEMBER_FACTS",
                archive: "node",
                members: first.members,
            },
            nodeMember: `trees/node/${top}/bin/node`,
            npmRoot: `trees/node/${npm}`,
            npmPackages: packages,
        } as const);
        await held.close();
        held = undefined;
        return result;
    } finally {
        // 成功路径必须先确认 close 才能返回，进入这里时只可能已有首错或 close 本身已失败；次要关闭异常由 close 标记事务
        // 保留，不能覆盖原始扫描拒绝，也不会重试已经尝试的系统 FD。
        if (held) {
            try {
                await held.close();
            } catch {
                tx.noteCloseFailure();
            }
        }
    }
}

/**
 * 生产入口在首次等待之前独占输入原字节及选项，只消费声明中的 Node 与来源字段并固定未审标签；源码十九项保持原绑定，两份
 * 新 producer 另行 held FD 保存，最终来源与树收尾成功后才允许事务发布。
 */
export async function prepareMacNodeBootstrap(
    bytes: Uint8Array,
    options: StageOptions,
): Promise<Readonly<NodeBootstrapResult>> {
    const copy = Buffer.from(bytes),
        input = parseAssetsObservationInput(copy),
        o = assetOptions(options),
        inputSha256 = sha(copy);
    const tx: ArchiveTransaction = new ArchiveTransaction(o.inputRoot, o.outputParent, o.candidateName, o.signal);
    tx.phase = "INPUTS";
    const reader = new InputReader(o.inputRoot, o.signal, []);
    const producers: Awaited<ReturnType<typeof holdFile>>[] = [];
    let primary: unknown;
    try {
        await reader.initialize();
        const source = await bindAssetSources(reader, input.source, input.arch);
        await tx.initialize();
        tx.phase = "INTAKE";
        await tx.observeRefs([input.node, input.source.evidence]);
        await reader.finish();
        for (const name of ["runtime-node-bootstrap.ts", "prepare-macos-node-bootstrap.mjs"]) {
            producers.push(await holdFile(tx, fileURLToPath(new URL(name, import.meta.url)), undefined, limits.json));
        }
        await tx.plan(input.node.sizeBytes + input.source.evidence.sizeBytes + metadataReserve, 12);
        await tx.snapshot(input.node, "snapshots/node.tar.gz");
        await tx.snapshot(input.source.evidence, "evidence/source.json");
        const archive = freeze({ ...input.node, path: "snapshots/node.tar.gz" });
        const extracted = await extractNodeSourceSnapshot(tx, input.arch, archive);
        const members = await writeAssetJson(tx, "members/node.json", extracted.members);
        const producerFiles: Ref[] = [];
        for (const [index, name] of ["runtime-node-bootstrap.ts", "prepare-macos-node-bootstrap.mjs"].entries()) {
            const producer = producers[index];
            if (!producer) tx.fail("PAYLOAD_SOURCE_CHANGED");
            await producer.check();
            producerFiles.push(
                await tx.write(`evidence/producer/${name}`, fileChunks(tx, producer.handle), producer.ref),
            );
            await producer.check();
        }
        const receipt: NodeBootstrapReceipt = {
            schemaVersion: 1,
            kind: "NODE_NPM_SOURCE_TREE",
            inputSha256,
            arch: input.arch,
            nodeVersion: input.nodeVersion,
            source: input.source,
            sourceStatus: "UNREVIEWED_SOURCE",
            archive,
            members,
            nodeMember: extracted.nodeMember,
            npmRoot: extracted.npmRoot,
            npmPackages: extracted.npmPackages,
            producerFiles,
            pending,
        };
        const receiptRef = await writeAssetJson(tx, "node-bootstrap.json", receipt);
        await reader.finish();
        await source.finish();
        const extractedReader = extractedReaders.get(tx);
        if (!extractedReader) tx.fail("PAYLOAD_SOURCE_CHANGED");
        await extractedReader.finish();
        for (const producer of producers) await producer.check();
        for (const producer of producers) await producer.close();
        await tx.finishSources();
        await tx.audit();
        const cleanup = await tx.publish();
        return freeze({
            kind: "NODE_NPM_SOURCE_TREE_RESULT",
            directory: tx.directory,
            receipt: receiptRef,
            committed: true,
            cleanup,
        });
    } catch (error) {
        primary = error;
        for (const producer of producers)
            try {
                await producer.close();
            } catch {
                tx.noteCloseFailure();
            }
        return assetFailure(tx, primary);
    }
}
