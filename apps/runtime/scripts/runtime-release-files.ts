import { constants, type BigIntStats } from "node:fs";
import { open, lstat, mkdir, readdir, readlink, symlink, chmod } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute, parse, relative as relativePath } from "node:path";
import { createHash } from "node:crypto";
import { canonicalBytes } from "@veriq/contracts";
import { InputReader, limits, relative, sha } from "./runtime-payload-tree.ts";
import type { Ref, FileFact, TreeInventory, TreeKind } from "./runtime-payload-inputs.ts";

/** 文件复制在已持有描述符上比较完整身份，任何观察到的长度、权限或时间变化都会拒绝；此处复用发行预算而不宣称普通 Node 能抵抗同用户在两个观察边界之间替换父目录的竞态。
 * 目录必须由调用者独占拥有，调用者负责保留关闭未知时的现场，本模块不执行递归删除。
 */
function same(a: BigIntStats, b: BigIntStats): boolean {
    return ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
        (key) => a[key as keyof BigIntStats] === b[key as keyof BigIntStats],
    );
}

/** 独立输入根和输出根都先经过既有 reader 的逐级无链接检查，目录创建仅发生在已由本轮拥有的根内；允许已存在父目录是为了合并同一来源副本，不允许已有非目录或链接充当路径组件。
 * 此入口不接受相对宿主路径，也不创建根本身，以免把错误配置静默变成新的发行目录。
 */
export async function admitReleaseRoot(root: string): Promise<void> {
    if (process.platform === "win32") {
        if (!isAbsolute(root) || root.includes("\0") || root.split(/[\\/]/).some((part) => /\.asar$/i.test(part)))
            throw new Error("RELEASE_ROOT_INVALID");
        let current = parse(root).root;
        for (const part of resolve(root).slice(current.length).split(/[\\/]/).filter(Boolean)) {
            current = join(current, part);
            const info = await lstat(current);
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("RELEASE_DIRECTORY_INVALID");
        }
        return;
    }
    const reader = new InputReader(root, undefined, []);
    await reader.initialize();
    await reader.finish();
}

/** 路径创建逐级确认已有目录身份且保持明确可移植组件，最终权限只设置在本轮新建目录；不会改变既有输入目录权限，源树与输出树的权限语义在复制时明确区分。
 * 文件生成必须先调用此函数建立受控父目录，根目录由上层先行准入。
 */
export async function releaseDirectory(root: string, name: string): Promise<void> {
    if (!name || name === ".") return;
    relative(name);
    let current = root;
    for (const part of name.split("/")) {
        current = join(current, part);
        const before = await lstat(current).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return null;
        });
        if (before) {
            if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("RELEASE_DIRECTORY_INVALID");
        } else {
            await mkdir(current, { mode: 0o755 });
            await chmod(current, 0o755);
        }
    }
}

/** 原始文件始终通过 O_NOFOLLOW 描述符分块读取并核对结束身份，单链接与大小预算在分配正文前拒绝；调用者提供的期望值独立匹配原始字节，不能由复制后的文件反向推导可信输入。
 * 摘要和字节数同时返回供库存使用，输出创建独占并刷新，任何 close 错误继续上抛而不伪称已安全删除。
 */
export async function copyReleaseFile(
    source: string,
    root: string,
    name: string,
    expected?: Ref,
    requestedMode?: number,
): Promise<FileFact> {
    relative(name);
    const before = await lstat(source, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limits.file))
        throw new Error("RELEASE_FILE_INVALID");
    const mode = requestedMode ?? (Number(before.mode & 0o111n) ? 0o755 : 0o644);
    if (![0o444, 0o644, 0o555, 0o755].includes(mode)) throw new Error("RELEASE_MODE_INVALID");
    await releaseDirectory(root, dirname(name).split("\\").join("/"));
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let output: Awaited<ReturnType<typeof open>> | undefined;
    let primary: unknown;
    const digest = createHash("sha256");
    let sizeBytes = 0;
    try {
        if (!same(before, await input.stat({ bigint: true }))) throw new Error("RELEASE_SOURCE_CHANGED");
        output = await open(join(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const buffer = Buffer.alloc(65536);
        while (true) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, sizeBytes);
            if (!bytesRead) break;
            sizeBytes += bytesRead;
            if (sizeBytes > limits.file) throw new Error("RELEASE_FILE_LIMIT");
            const bytes = buffer.subarray(0, bytesRead);
            digest.update(bytes);
            let position = 0;
            while (position < bytes.length) {
                const result = await output.write(bytes, position, bytes.length - position);
                if (!result.bytesWritten) throw new Error("RELEASE_WRITE_INCOMPLETE");
                position += result.bytesWritten;
            }
        }
        const sha256 = digest.digest("hex");
        if (sizeBytes !== Number(before.size) || (expected && (sizeBytes !== expected.sizeBytes || sha256 !== expected.sha256)))
            throw new Error("RELEASE_INPUT_MISMATCH");
        if (!same(before, await input.stat({ bigint: true })) || !same(before, await lstat(source, { bigint: true })))
            throw new Error("RELEASE_SOURCE_CHANGED");
        await output.chmod(mode);
        await output.sync();
        return { path: name, sizeBytes, sha256, mode: mode as FileFact["mode"] };
    } catch (error) {
        primary = error;
        throw error;
    } finally {
        // 两个拥有者分别只尝试一次关闭，次要关闭错误不覆盖正文复制的首错；上层失败始终保留自有目录，因此不会在未知关闭后扫描或递归删除仍可能持有的材料。
        let closeError: unknown;
        try { await input.close(); } catch (error) { closeError = error; }
        try { await output?.close(); } catch (error) { closeError ??= error; }
        if (!primary && closeError) throw closeError;
    }
}

/** 合并视图时只允许完全相同的重复普通文件，先核对已有目标的原始字节再跳过；依赖树链接可显式保留但必须为留在原根内的相对链接，最终配方核验仍逐项核链接清单和归属。
 * 此函数只复制到第三方自有 intake 根，绝不写入仍由 entry 或 dependency producer 持有 reader 的视图。
 * 输入目录身份在枚举后复验，数量、深度和总字节沿用现有 Runtime 固定预算。
 */
export async function mergeReleaseView(source: string, destination: string, allowLinks = false): Promise<void> {
    await admitReleaseRoot(source);
    await admitReleaseRoot(destination);
    let entries = 0;
    let total = 0;
    const walk = async (prefix: string): Promise<void> => {
        const full = join(source, prefix);
        const before = await lstat(full, { bigint: true });
        for (const name of (await readdir(full)).sort()) {
            relative(name);
            const path = prefix ? `${prefix}/${name}` : name;
            if (++entries > limits.entries || path.split("/").length > 64) throw new Error("RELEASE_TREE_LIMIT");
            const item = await lstat(join(source, path), { bigint: true });
            if (item.isDirectory()) {
                await releaseDirectory(destination, path);
                await walk(path);
            } else if (item.isSymbolicLink()) {
                if (!allowLinks) throw new Error("RELEASE_LINK_FORBIDDEN");
                const target = await readlink(join(source, path));
                relative(target, true);
                const resolved = relativePath(source, resolve(dirname(join(source, path)), target));
                if (resolved === ".." || resolved.startsWith("../") || resolved.startsWith("..\\")) throw new Error("RELEASE_LINK_ESCAPE");
                await symlink(target, join(destination, path));
                if (!same(item, await lstat(join(source, path), { bigint: true }))) throw new Error("RELEASE_SOURCE_CHANGED");
            } else {
                total += Number(item.size);
                if (total > limits.total) throw new Error("RELEASE_TREE_LIMIT");
                const existing = await lstat(join(destination, path)).catch((error: NodeJS.ErrnoException) => {
                    if (error.code !== "ENOENT") throw error;
                    return null;
                });
                if (existing) {
                    const a = new InputReader(source, undefined, []), b = new InputReader(destination, undefined, []);
                    await a.initialize(); await b.initialize();
                    const bytes = await a.input(path);
                    await b.ref({ path, sizeBytes: bytes.length, sha256: sha(bytes) }, false, limits.file, false);
                    await a.finish(); await b.finish();
                } else await copyReleaseFile(join(source, path), destination, path);
            }
        }
        if (!same(before, await lstat(full, { bigint: true }))) throw new Error("RELEASE_SOURCE_CHANGED");
    };
    await walk("");
}

/** 新文档使用独占文件创建和规范 JSON 字节，引用只绑定原始内容且位于所有 BoundTree 外；此辅助函数不授予 Expected、来源批准或已通过验证的发行身份。
 * 路径重复即失败，避免覆盖此前产生的证据或以新数据掩盖失败记录。
 */
export async function writeReleaseJson(root: string, name: string, value: unknown): Promise<Ref> {
    relative(name);
    await releaseDirectory(root, dirname(name).split("\\").join("/"));
    const bytes = canonicalBytes(value);
    if (bytes.length > limits.json) throw new Error("RELEASE_DOCUMENT_LIMIT");
    const handle = await open(join(root, name), "wx", 0o644);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    return { path: name, sizeBytes: bytes.length, sha256: sha(bytes) };
}

/** 有界命令日志以原始字节独立保存，不转成 Base64 填入 JSON 造成四 MiB 上限被编码膨胀击穿；返回的 Ref 与正式收据使用同一原始摘要语义，内容可能包含工具诊断因此仍位于调用者自有证据根。
 * 文件只独占创建、刷新和关闭一次，未知异常不覆盖既有日志或伪造成功的命令观察。
 */
export async function writeReleaseBytes(root: string, name: string, bytes: Uint8Array): Promise<Ref> {
    relative(name);
    if (bytes.byteLength > limits.json) throw new Error("RELEASE_DOCUMENT_LIMIT");
    await releaseDirectory(root, dirname(name).split("\\").join("/"));
    const handle = await open(join(root, name), "wx", 0o644);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    return { path: name, sizeBytes: bytes.byteLength, sha256: sha(bytes) };
}

/** 签名工具身份只流式记录真实普通文件的原始摘要与长度，不把整个系统工具目录当来源库存或把工具本体打入产品；同一描述符和路径结束身份必须与开始相同，错误或未知关闭都不能生成成功的签名证据。
 * 本函数没有执行能力，实际 signer 路径由正式 native producer 固定，摘要仅描述本轮真实观察而非自动认证签名者信任。
 */
export async function releaseFileIdentity(path: string): Promise<Ref> {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limits.file))
        throw new Error("RELEASE_FILE_INVALID");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const digest = createHash("sha256"), buffer = Buffer.alloc(65536);
    let sizeBytes = 0;
    let primary: unknown;
    try {
        if (!same(before, await handle.stat({ bigint: true }))) throw new Error("RELEASE_SOURCE_CHANGED");
        while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, sizeBytes);
            if (!bytesRead) break;
            sizeBytes += bytesRead;
            if (sizeBytes > limits.file) throw new Error("RELEASE_FILE_LIMIT");
            digest.update(buffer.subarray(0, bytesRead));
        }
        if (sizeBytes !== Number(before.size) || !same(before, await handle.stat({ bigint: true })) ||
            !same(before, await lstat(path, { bigint: true }))) throw new Error("RELEASE_SOURCE_CHANGED");
        return { path, sizeBytes, sha256: digest.digest("hex") };
    } catch (error) { primary = error; throw error; }
    finally {
        try { await handle.close(); } catch (error) { if (!primary) throw error; }
    }
}

/** 新树库存枚举全部目录与普通文件并以 held reader 核原始字节，生成阶段拒绝链接和特殊类型；依赖链接由 C04 自身库存负责，这里只服务本轮正式 native、engine 与非 Mac 完整库存。
 * 总字节和成员数在遍历中递增核验，任何超限都会留下失败现场而不是输出不完整的成功清单。
 */
export async function inventoryReleaseTree(root: string, treeKind: TreeKind): Promise<TreeInventory> {
    await admitReleaseRoot(root);
    const directories: string[] = [], files: FileFact[] = [];
    let total = 0;
    const walk = async (prefix: string): Promise<void> => {
        const directoryBefore = await lstat(join(root, prefix), { bigint: true });
        for (const name of (await readdir(join(root, prefix))).sort()) {
            relative(name);
            const path = prefix ? `${prefix}/${name}` : name;
            if (directories.length + files.length >= limits.entries) throw new Error("RELEASE_TREE_LIMIT");
            const item = await lstat(join(root, path));
            if (item.isDirectory()) { directories.push(path); await walk(path); }
            else {
                if (!item.isFile() || item.nlink !== 1 || item.size > limits.file) throw new Error("RELEASE_FILE_INVALID");
                // 二进制也通过流式 Ref 路径核验，摘要计算单独使用 held 文件复制相同的固定块大小，避免把 Chrome 主文件或动态库整块装入内存。
                const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
                const before = await handle.stat({ bigint: true });
                const digest = createHash("sha256"), buffer = Buffer.alloc(65536);
                let position = 0;
                try {
                    while (true) {
                        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
                        if (!bytesRead) break;
                        position += bytesRead; digest.update(buffer.subarray(0, bytesRead));
                        if (position > limits.file) throw new Error("RELEASE_FILE_LIMIT");
                    }
                    if (!same(before, await handle.stat({ bigint: true })) || position !== item.size)
                        throw new Error("RELEASE_SOURCE_CHANGED");
                } finally { await handle.close(); }
                const mode = process.platform === "win32" ?
                    (/\.(?:exe|dll|node)$/i.test(path) ? 0o755 : 0o644) : item.mode & 0o7777;
                if (![0o444, 0o644, 0o555, 0o755].includes(mode)) throw new Error("RELEASE_MODE_INVALID");
                const fact = { path, sizeBytes: position, sha256: digest.digest("hex"), mode: mode as FileFact["mode"] };
                if (!same(before, await lstat(join(root, path), { bigint: true })))
                    throw new Error("RELEASE_SOURCE_CHANGED");
                total += position;
                if (total > limits.total) throw new Error("RELEASE_TREE_LIMIT");
                files.push(fact);
            }
        }
        if (!same(directoryBefore, await lstat(join(root, prefix), { bigint: true })))
            throw new Error("RELEASE_SOURCE_CHANGED");
    };
    await walk("");
    return { schemaVersion: 1, kind: "PAYLOAD_INPUT_TREE", treeKind, directories, files, links: [] };
}
