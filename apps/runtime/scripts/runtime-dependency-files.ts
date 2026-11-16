import { constants, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, opendir, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { canonicalBytes } from "@veriq/contracts";
import { assetBytes } from "./runtime-assets-observation.ts";
import { ArchiveTransaction } from "./runtime-payload-transaction.ts";
import { contentLimit, fail, limits, relative } from "./runtime-payload-tree.ts";
import { RuntimePayloadError, type Ref } from "./runtime-payload-inputs.ts";

/** 不支持的真实布局使用固定英文原因附在既有错误合同上，不能通过扩大成功定义掩盖 peer、条件或 bin 归属冲突；这些原因只用于定位待支持边界，不拼接安装路径、包正文或不受信任的工具诊断。 */
export function unsupportedDependency(reason: "DEPENDENCY_SNAPSHOT_AMBIGUOUS" | "DEPENDENCY_INSTALL_SCOPE_COLLISION" |
    "DEPENDENCY_CONDITIONAL_INSTANCE_SPLIT" | "DEPENDENCY_BIN_WINNER_ABSENT_OR_AMBIGUOUS" | "DEPENDENCY_BIN_SHIM_UNSUPPORTED") : never {
    throw new RuntimePayloadError("PAYLOAD_GRAPH_MISMATCH", reason);
}

/** 文件观察同时绑定设备、inode、模式、长度和纳秒时间，后续收尾使用同一身份集合复查实际来源；这里只报告观察窗口内的变化，不声称抵抗恶意同用户修改父目录的原子文件系统能力。 */
export class DependencyFiles {
    private readonly observed = new Map<string, BigIntStats>();
    private readonly digests = new Map<string, string>();

    /** 单个路径只允许普通真实文件并通过不跟随链接的描述符读取，读取前后均比较身份与长度；安装工具的共享硬链接可以读取，最终载荷始终写成独立文件，原始文件不会被 chmod 或修改。 */
    async read(path: string, cap = limits.file): Promise<Buffer> {
        const chunks: Buffer[] = [];
        for await (const chunk of this.chunks(path, cap)) chunks.push(chunk);
        return Buffer.concat(chunks);
    }

    /** 大型包体和工具文件分块读取并在自然结束时登记完整摘要，提前停止的消费者不能留下成功观察记录；每块只分配六十四 KiB，最终复制和收尾哈希不需要把可能达到单文件预算的大型二进制全部驻留内存。 */
    async *chunks(path: string, cap = limits.file): AsyncGenerator<Buffer> {
        const before = await lstat(path, { bigint: true });
        if (!before.isFile() || before.size > BigInt(cap) || Number(before.mode & 0o7022n))
            fail("PAYLOAD_TREE_MISMATCH");
        this.remember(path, before);
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            if (!same(before, await handle.stat({ bigint: true }))) fail("PAYLOAD_SOURCE_CHANGED");
            const digest = createHash("sha256");
            let count = 0;
            for (;;) {
                const chunk = Buffer.alloc(64 * 1024);
                const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
                if (!bytesRead) break;
                count += bytesRead;
                if (count > Number(before.size) || count > cap) fail("PAYLOAD_LIMIT");
                const content = chunk.subarray(0, bytesRead);
                digest.update(content);
                yield content;
            }
            if (count !== Number(before.size) ||
                !same(before, await handle.stat({ bigint: true })) ||
                !same(before, await lstat(path, { bigint: true }))) fail("PAYLOAD_SOURCE_CHANGED");
            const value = digest.digest("hex"), previous = this.digests.get(path);
            if (previous && previous !== value) fail("PAYLOAD_SOURCE_CHANGED");
            this.digests.set(path, value);
        } finally {
            await handle.close();
        }
    }

    /** 工具身份只需要长度和摘要而不需要完整二进制正文，复用分块读取登记的真实事实可避免 Node 可执行文件造成额外内存峰值；返回的路径仍是工具绝对位置，不会被当作树内相对 Ref 使用。 */
    async fact(path: string, cap = limits.file) {
        let sizeBytes = 0;
        for await (const chunk of this.chunks(path, cap)) sizeBytes += chunk.length;
        return { path, sizeBytes, sha256: this.digests.get(path)! };
    }

    /** bin 分类只保留前二百五十六字节并对完整正文继续流式核摘要，超长首行不能伪装成允许的解释器；分类不读取环境、不执行目标，也不因目标文件较大而跳过真实身份收尾。 */
    async header(path: string) {
        let prefix = Buffer.alloc(0);
        for await (const chunk of this.chunks(path))
            if (prefix.length < 256) prefix = Buffer.concat([prefix, chunk.subarray(0, 256 - prefix.length)]);
        return prefix;
    }

    /** 目录身份在任何递归或写入前记录，符号链接与特殊节点不会被当作目录继续跟随；调用方只在安装和生成完成后观察目录，正常的受控构建写入不应与静止材料的收尾窗口混合。 */
    async directory(path: string) {
        const info = await lstat(path, { bigint: true });
        if (!info.isDirectory() || Number(info.mode & 0o7022n)) fail("PAYLOAD_PATH");
        this.remember(path, info);
    }

    /** 身份集合一旦建立便不能以第二次观察覆盖旧值，否则先替换后收尾会掩盖来源变化；每次读取的完整摘要另行保存，后续 finish 同时重新读取正文，避免只依赖可恢复的时间戳。 */
    private remember(path: string, info: BigIntStats) {
        const previous = this.observed.get(path);
        if (previous && !same(previous, info)) fail("PAYLOAD_SOURCE_CHANGED");
        this.observed.set(path, info);
    }

    /** 收尾重新检查全部文件与目录身份并重读已经绑定的普通文件摘要，回调期间发生的变化同样拒绝；只有确认过的本次观察可以继续消费，不把目录路径作为可跨进程持久化的授权凭据。 */
    async finish() {
        for (const [path, before] of this.observed) {
            if (!same(before, await lstat(path, { bigint: true }))) fail("PAYLOAD_SOURCE_CHANGED");
            if (this.digests.has(path)) for await (const _chunk of this.chunks(path, Number(before.size))) { }
        }
    }
}

/** 身份比较保留链接数和权限变化，不能仅比较内容摘要后接受已经换过 inode 的来源；该内部谓词供持有文件读取和独占目录准入共用，不参与包名或版本的逻辑去重。 */
function same(a: BigIntStats, b: BigIntStats) {
    return ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]
        .every((key) => a[key as keyof BigIntStats] === b[key as keyof BigIntStats]);
}

/** 独占工作根必须是绝对规范路径、真实七百权限空目录，并与源码和事务根互不包含；逐级父组件拒绝链接，避免把词法上的临时目录误当成实际位于外部状态的安装位置。 */
export async function admitDependencyBuildRoot(work: ArchiveTransaction, root: string) {
    if (!isAbsolute(root) || resolve(root) !== root) fail("PAYLOAD_PATH");
    for (const other of [work.inputRoot, work.outputParent])
        if (root === other || root.startsWith(other + "/") || other.startsWith(root + "/"))
            fail("PAYLOAD_PATH");
    for (let current = root; ; current = dirname(current)) {
        if (!(await lstat(current)).isDirectory()) fail("PAYLOAD_PATH");
        if (current === dirname(current)) break;
    }
    const identity = await lstat(root, { bigint: true });
    if (Number(identity.mode & 0o7777n) !== 0o700) fail("PAYLOAD_PATH");
    const directory = await opendir(root);
    try {
        if (await directory.read()) fail("PAYLOAD_PATH");
    } finally {
        await directory.close();
    }
    return async () => {
        const after = await lstat(root, { bigint: true });
        if (identity.dev !== after.dev || identity.ino !== after.ino || identity.mode !== after.mode)
            fail("PAYLOAD_SOURCE_CHANGED");
    };
}

/** 来源路径只能在本次独占安装根中逐级创建，内容先由来源绑定核验再使用排他写入；所有包清单和锁保留原始字节，不通过重新序列化或 pnpm 命令参数替换原始源码声明。 */
export async function writeDependencySource(root: string, path: string, bytes: Buffer) {
    relative(path);
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(root, path), bytes, { flag: "wx", mode: 0o600 });
}

/** 事务中的真实依赖文件以独立写入保留来源摘要，views 前缀只在返回消费者引用时移除；可执行位由实际文件事实显式传入，证据文件则固定为普通六百四十四模式而不伪装成执行产物。 */
export async function writeDependencyView(
    work: ArchiveTransaction,
    path: string,
    bytes: Buffer,
    mode = 0o644,
): Promise<Ref> {
    const ref = await work.write(`views/${relative(path)}`, assetBytes(bytes), undefined, mode);
    return { ...ref, path };
}

/** 树外 JSON 统一使用既有 JCS 编码并受固定文档预算限制，摘要绑定的就是实际写入字节；该函数只负责材料写入，不接受预制成功收据或为未执行的命令生成通过状态。 */
export async function writeDependencyJson(work: ArchiveTransaction, path: string, value: unknown) {
    const bytes = canonicalBytes(value);
    if (bytes.length > limits.json) fail("PAYLOAD_LIMIT");
    return writeDependencyView(work, path, bytes);
}

/** 普通文件复制使用已绑定来源的真实字节并遵循当前路径类别预算，不能从别名路径意外解引用工作区；最终树权限独立于安装缓存权限，允许的执行位仍由本次物理观察决定而不是修复非法输入。 */
export async function copyDependencyView(
    work: ArchiveTransaction,
    files: DependencyFiles,
    source: string,
    destination: string,
    expected?: Ref & { mode?: number },
) {
    const mode = Number((await lstat(source)).mode & 0o7777);
    if (expected?.mode !== undefined && expected.mode !== mode) fail("PAYLOAD_SOURCE_CHANGED");
    if (![0o400, 0o600, 0o444, 0o644, 0o500, 0o700, 0o555, 0o755].includes(mode))
        fail("PAYLOAD_TREE_MISMATCH");
    const outputMode = mode & 0o111 ? 0o755 : 0o644;
    const ref = await work.write(`views/${relative(destination)}`, files.chunks(source, contentLimit(destination)), expected, outputMode);
    return { ...ref, path: destination, mode: outputMode };
}

/** 解析暂存树也从同一持有来源分块复制，不执行包正文、不创建工作区目录链接，也不利用缓存硬链接共享可变 inode；每个目标使用排他描述符写入，发生短写或来源变化时终止而不产生可接受解析证据。 */
export async function copyDependencySourceFile(root: string, path: string, source: string, files: DependencyFiles) {
    relative(path);
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    const handle = await open(join(root, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
        for await (const chunk of files.chunks(source, contentLimit(path))) {
            let offset = 0;
            while (offset < chunk.length) {
                const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
                if (!bytesWritten) fail("PAYLOAD_IO");
                offset += bytesWritten;
            }
        }
        await handle.sync();
    } finally {
        await handle.close();
    }
}
