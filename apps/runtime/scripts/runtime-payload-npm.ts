import { constants, type BigIntStats } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { dirname, join, posix } from "node:path";
import { canonicalBytes } from "@veriq/contracts";
import {
    RuntimePayloadError,
    type InputInspection,
    type Ref,
    type FileFact,
    type TreeInventory,
    type BoundTree,
} from "./runtime-payload-inputs.ts";
import type { ArchiveMember, IntakeResult } from "./runtime-payload-archive.ts";
import { ArchiveTransaction } from "./runtime-payload-transaction.ts";
import { InputReader, relative, freeze, sha, limits } from "./runtime-payload-tree.ts";
import { verifyPackageContents } from "./runtime-payload-graph.ts";
import { nativeBin } from "./runtime-payload-receipts.ts";
import type { Origin } from "./runtime-payload-manifest.ts";

/**
 * npm 投影结果完整保留逻辑库存、真实树外证据与每个普通正文的原始来源，source.path 仍指本次 intake 的物理成员；临时链接
 * 只供核验，最终复制者按精确 sourceAlias 跳过并另外生成受控 shim。
 */
export type NpmProjection = Readonly<{
    inventory: TreeInventory;
    tree: BoundTree;
    files: readonly Readonly<{ fact: FileFact; source: Ref; origins: readonly Origin[] }>[];
}>;

/**
 * 安全权限只保留只读或拥有者可写以及原执行位意图，归档组写和其它写权限不会直接进入 Runtime；独立 package 自有树摘要仍须
 * 与投影事实吻合，不能为了通过摘要而把实际落盘权限伪装成别的模式。
 */
export function safeMode(mode: number): FileFact["mode"] {
    return mode & 0o111 ? (mode & 0o200 ? 0o755 : 0o555) : mode & 0o200 ? 0o644 : 0o444;
}

/**
 * 单个已核普通文件通过 held FD 顺序流入事务独占文件，源和目标都不使用 hardlink 或跟随最后一级符号链接；每个父目录及文件
 * 身份在复制前后复核，关闭不确认必须持久记录到拥有者以阻止虚假清理成功。
 */
export async function copyPayloadFile(
    tx: ArchiveTransaction,
    sourceRoot: string,
    source: Ref,
    destination: string,
    mode?: number,
) {
    relative(source.path);
    tx.check();
    const parents = new Map<string, BigIntStats>();
    let current = sourceRoot;
    for (const part of ["", ...source.path.split("/").slice(0, -1)]) {
        if (part) current = join(current, part);
        const info = await lstat(current, { bigint: true });
        tx.check();
        if (!info.isDirectory() || info.isSymbolicLink()) tx.fail("PAYLOAD_PATH");
        parents.set(current, info);
    }
    const full = join(sourceRoot, source.path),
        before = await lstat(full, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(source.sizeBytes))
        tx.fail("PAYLOAD_SOURCE_CHANGED");
    const handle = await open(
        full,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let primary: unknown;
    try {
        if (!same(before, await handle.stat({ bigint: true }))) tx.fail("PAYLOAD_SOURCE_CHANGED");
        tx.check();
        const stream = handle.createReadStream({
            autoClose: false,
            highWaterMark: 64 * 1024,
            ...(tx.signal ? { signal: tx.signal } : {}),
        });
        const closed = finished(stream);
        closed.catch(() => {});
        try {
            await tx.write(destination, stream, source, mode);
            await closed;
        } finally {
            if (!stream.readableEnded) stream.destroy();
            await closed.catch(() => {});
        }
        if (
            !same(before, await handle.stat({ bigint: true })) ||
            !same(before, await lstat(full, { bigint: true }))
        )
            tx.fail("PAYLOAD_SOURCE_CHANGED");
        for (const [path, info] of parents)
            if (!same(info, await lstat(path, { bigint: true }))) tx.fail("PAYLOAD_SOURCE_CHANGED");
        tx.check();
    } catch (error) {
        primary = error;
        throw error;
    } finally {
        try {
            await handle.close();
        } catch (error) {
            tx.noteCloseFailure();
            if (!primary) throw error;
        }
    }
}

/**
 * 来源文件复制需要完整纳秒身份相等，目录检查同样覆盖读取期间新增或替换子项的变化；比较不依赖文件内容恰好相同，因此同字
 * 节替换也不能在本次观察边界内悄悄取得原来源身份。
 */
function same(a: BigIntStats, b: BigIntStats) {
    return (
        a.dev === b.dev &&
        a.ino === b.ino &&
        a.mode === b.mode &&
        a.nlink === b.nlink &&
        a.size === b.size &&
        a.mtimeNs === b.mtimeNs &&
        a.ctimeNs === b.ctimeNs
    );
}

/**
 * npm 链接只解析本次 intake 已核原始成员，每跳保持树内并受三十二跳和循环上限；终点只能为普通文件，目录 alias 永远不能展
 * 开成重复目录，返回 Origins 同时保留每个原 raw target 的 UTF8 摘
 * 要。
 */
export function npmLinkSource(
    path: string,
    members: readonly ArchiveMember[],
    root: string,
): { file: Extract<ArchiveMember, { kind: "file" }>; origins: Origin[] } {
    const map = new Map(members.map((member) => [member.path, member]));
    const seen = new Set<string>(),
        origins: Origin[] = [];
    let current = path;
    while (true) {
        const member = map.get(current);
        if (!member || !current.startsWith(root + "/"))
            throw new RuntimePayloadError("PAYLOAD_ARCHIVE_LINK");
        if (member.kind === "file") {
            origins.push({
                input: "node",
                path: member.path,
                sha256: member.sha256,
                transform: seen.size ? "file-link-copy-v1" : "copy",
            });
            return { file: member, origins };
        }
        if (member.kind !== "link" || seen.has(current) || seen.size >= 32)
            throw new RuntimePayloadError("PAYLOAD_ARCHIVE_LINK");
        seen.add(current);
        origins.push({
            input: "node",
            path: member.path,
            sha256: sha(Buffer.from(member.target)),
            transform: "file-link-copy-v1",
        });
        current = posix.normalize(posix.join(posix.dirname(current), member.target));
    }
}

/**
 * npm 投影先完整复制真实正文和受限临时 bin alias，再以独立 reader 核物理库存与共享 package 内容规则；原输入 native
 * inspection 始终使用另一个 reader，所有 reader 都
 * 在生成 shim 或其它目录变换前完成身份收尾。
 */
export async function projectNpm(
    report: InputInspection,
    intake: IntakeResult,
    tx: ArchiveTransaction,
): Promise<NpmProjection> {
    const node = report.nodeReceipt;
    const members = intake.receipt.archives.find((archive) => archive.kind === "node")!.members;
    const inventory: {
        schemaVersion: 1;
        kind: "PAYLOAD_INPUT_TREE";
        treeKind: "dependencies";
        directories: string[];
        files: FileFact[];
        links: { path: string; target: string }[];
    } = {
        schemaVersion: 1,
        kind: "PAYLOAD_INPUT_TREE",
        treeKind: "dependencies",
        directories: [],
        files: [],
        links: [],
    };
    const files: { fact: FileFact; source: Ref; origins: Origin[] }[] = [],
        directories = new Set<string>(["npm"]);
    const addParents = (path: string) => {
        for (let parent = dirname(path); parent !== "."; parent = dirname(parent))
            directories.add(parent);
    };
    for (const member of members) {
        if (member.path !== node.npmRoot && !member.path.startsWith(node.npmRoot + "/")) continue;
        const path =
            member.path === node.npmRoot
                ? "npm"
                : `npm/${member.path.slice(node.npmRoot.length + 1)}`;
        if (member.kind === "directory") {
            directories.add(path);
            addParents(path);
            continue;
        }
        const bin = node.npmGraph.bins.find((b) => b.sourceAlias === path);
        addParents(path);
        if (member.kind === "link" && bin) {
            const resolved = npmLinkSource(member.path, members, node.npmRoot);
            if (
                resolved.file.path !== `${node.npmRoot}/${bin.targetPath.slice(4)}` ||
                resolved.file.sha256 !== bin.targetSha256
            )
                tx.fail("PAYLOAD_BIN_UNSUPPORTED");
            inventory.links.push({ path, target: posix.relative(dirname(path), bin.targetPath) });
            continue;
        }
        const resolved = npmLinkSource(member.path, members, node.npmRoot);
        const fact: FileFact = {
            path,
            sizeBytes: resolved.file.sizeBytes,
            sha256: resolved.file.sha256,
            mode: safeMode(resolved.file.mode),
        };
        const source = {
            path: `trees/node/${resolved.file.path}`,
            sizeBytes: fact.sizeBytes,
            sha256: fact.sha256,
        };
        inventory.files.push(fact);
        files.push({ fact, source, origins: resolved.origins });
    }
    inventory.directories = [...directories].sort();
    inventory.files.sort((a, b) => (a.path < b.path ? -1 : 1));
    inventory.links.sort((a, b) => (a.path < b.path ? -1 : 1));
    const bytes = files.reduce((n, file) => n + file.fact.sizeBytes, 0);
    const inventoryBytes = canonicalBytes(inventory),
        receiptBytes = canonicalBytes(node);
    if (inventoryBytes.length > limits.json || receiptBytes.length > limits.json)
        tx.fail("PAYLOAD_LIMIT");
    await tx.plan(
        bytes + inventoryBytes.length + receiptBytes.length,
        inventory.directories.length + files.length + inventory.links.length + 2,
    );
    for (const directory of inventory.directories) await tx.mkdir(`views/${directory}`);
    for (const file of files)
        await copyPayloadFile(
            tx,
            intake.directory,
            file.source,
            `views/${file.fact.path}`,
            file.fact.mode,
        );
    await tx.createProjectionBinAliases(node, members);
    const inventoryRef = await tx.write(
        "projection-evidence/npm-inventory.json",
        once(inventoryBytes),
    );
    const receiptRef = await tx.write("projection-evidence/node-receipt.json", once(receiptBytes));
    const tree: BoundTree = { root: "views", inventory: inventoryRef, buildReceipt: receiptRef };
    const reader = new InputReader(tx.scratch, tx.signal, [tree.root]);
    await reader.initialize();
    await reader.ref(inventoryRef, true);
    await reader.ref(receiptRef, true);
    await reader.tree(tree, inventory, "dependencies");
    await verifyPackageContents(node.npmGraph, inventory, tree, reader);
    for (const resolution of node.npmGraph.resolutionProof.resolutions)
        if (!inventory.files.some((file) => file.path === resolution.consumer))
            tx.fail("PAYLOAD_GRAPH_MISMATCH");
    await reader.finish();
    const evidence = new InputReader(tx.inputRoot, tx.signal, []);
    await evidence.initialize();
    for (const bin of node.npmGraph.bins)
        if (bin.launcher === "native") {
            const target = inventory.files.find((file) => file.path === bin.targetPath);
            if (!target || !bin.inspection || ![0o555, 0o755].includes(target.mode))
                tx.fail("PAYLOAD_BIN_UNSUPPORTED");
            await nativeBin(evidence, bin.inspection, report.recipe, bin.targetPath, target.sha256);
        }
    await evidence.finish();
    return freeze({ inventory, tree, files });
}

/**
 * 小型已核 JSON 或固定生成字节以单块异步源进入同一事务写入器，仍经过独占写入和摘要权限审计；普通输入正文另走顺序流复制
 * ，不能借此辅助函数把整个 Node 或 Chrome 大文件装进内存。
 */
export async function* once(bytes: Uint8Array) {
    yield bytes;
}
