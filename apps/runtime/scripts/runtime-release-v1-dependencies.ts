import { constants, type BigIntStats } from "node:fs";
import {
    mkdir,
    lstat,
    open,
    readdir,
    readlink,
    realpath,
    unlink,
    symlink,
    chmod,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, posix, relative as nativeRelative } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalBytes } from "@veriq/contracts";
import { DependencyFiles } from "./runtime-dependency-files.ts";
import { materializeRuntimeWorkspacePackages } from "./runtime-workspace-packages.ts";
import { collectLayoutMetadata } from "./runtime-dependency-layout.mjs";
import {
    dependencyDeclarations,
    lockSections,
    packageAlias,
    type LayoutRecord,
} from "./runtime-dependency-closure.ts";
import { scanRuntimeLiteralImports, classifyRuntimeModuleEdge } from "./runtime-payload-graph.ts";
import { renderBinShim } from "./runtime-payload-bins.ts";
import { limits, relative, sha } from "./runtime-payload-tree.ts";
import type { Bin, FileFact, Ref, SourceBindingV1 } from "./runtime-payload-inputs.ts";
import type { HostBuildInvocation, HostBuildObservation } from "./runtime-payload-entries.ts";
import {
    admitReleaseRoot,
    copyReleaseFile,
    inventoryReleaseTree,
    releaseDirectory,
    writeReleaseBytes,
    writeReleaseJson,
} from "./runtime-release-files.ts";
import { observeRuntimeCommand } from "./runtime-release-builds.ts";
import type { RuntimeV1Material } from "./runtime-release-v1.ts";

/**
 * 原生 v1 依赖准备使用原 pnpm 锁和独立固定工具包，在本轮独占目录真正执行离线冻结生产安装；只输出普通物理布局和实际解析证据，不制造 Darwin 的 DependenciesReceipt 或借本机平台改写 Mac Expe
 * cted。
 * pnpmPackage 完整绑定工具包，compilerImplementation 绑定 C04 发射器真实加载的 TypeScript 实现及清单，store 只提供原锁 integrity 允许的离线包体。
 */
export type RuntimeV1DependencyPreparation = Readonly<{
    pnpmCli: string;
    pnpmPackage: RuntimeV1Material;
    pnpmStore: string;
    compilerImplementation: readonly Ref[];
}>;

/**
 * 依赖准备结果只描述本次真实生成并完整枚举的生产包树以及独立证据引用，不能作为外部材料来源批准；生成树由调用者继续拥有，最终 v1 manifest 和外层审核仍分别处理完整性与发行身份。
 * 文件路径相对 node_modules 根，source/lock/tool 事实和解析结果留在候选外层 evidence，工具缓存与安装临时树不进入产品。
 */
export type RuntimeV1DependencyResult = Readonly<{
    material: RuntimeV1Material;
    evidence: Ref;
    status: "DEPENDENCIES_PRODUCED_UNVERIFIED";
}>;

/**
 * 构建输入观察在 Windows 不套用没有 Unix 意义的 mode 写位，但仍持有无链接普通文件并核设备、inode、链接数、时间、长度和原始摘要；这项适配只供本轮源码、工具和包体，不进入私有凭据或运行时 ACL 路径。
 * Linux 完整沿用 C04 原观察器，Windows 的原生私有文件政策没有被放宽或替代。
 */
class NativeBuildFiles extends DependencyFiles {
    private readonly nativeObserved = new Map<string, { identity: BigIntStats; digest?: string }>();
    override async *chunks(path: string, cap = limits.file): AsyncGenerator<Buffer> {
        if (process.platform !== "win32") {
            yield* super.chunks(path, cap);
            return;
        }
        const before = await lstat(path, { bigint: true });
        if (!before.isFile() || before.size > BigInt(cap))
            throw new Error("RUNTIME_V1_INPUT_FILE_INVALID");
        const previous = this.nativeObserved.get(path);
        if (previous && !same(previous.identity, before))
            throw new Error("RUNTIME_V1_INPUT_CHANGED");
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const digest = createHash("sha256");
        let count = 0;
        try {
            if (!same(before, await handle.stat({ bigint: true })))
                throw new Error("RUNTIME_V1_INPUT_CHANGED");
            while (true) {
                const bytes = Buffer.alloc(65536);
                const { bytesRead } = await handle.read(bytes, 0, bytes.length, count);
                if (!bytesRead) break;
                count += bytesRead;
                if (count > cap || count > Number(before.size))
                    throw new Error("RUNTIME_V1_INPUT_LIMIT");
                digest.update(bytes.subarray(0, bytesRead));
                yield bytes.subarray(0, bytesRead);
            }
            const value = digest.digest("hex");
            if (
                count !== Number(before.size) ||
                !same(before, await handle.stat({ bigint: true })) ||
                !same(before, await lstat(path, { bigint: true })) ||
                (previous?.digest && previous.digest !== value)
            )
                throw new Error("RUNTIME_V1_INPUT_CHANGED");
            this.nativeObserved.set(path, { identity: before, digest: value });
        } finally {
            await handle.close();
        }
    }
    override async fact(path: string, cap = limits.file): Promise<Ref> {
        if (process.platform !== "win32") return super.fact(path, cap);
        let sizeBytes = 0;
        for await (const bytes of this.chunks(path, cap)) sizeBytes += bytes.length;
        return { path, sizeBytes, sha256: this.nativeObserved.get(path)!.digest! };
    }
    override async directory(path: string): Promise<void> {
        if (process.platform !== "win32") return super.directory(path);
        const identity = await lstat(path, { bigint: true }),
            previous = this.nativeObserved.get(path);
        if (!identity.isDirectory() || (previous && !same(previous.identity, identity)))
            throw new Error("RUNTIME_V1_INPUT_DIRECTORY_INVALID");
        this.nativeObserved.set(path, { identity });
    }
    override async finish(): Promise<void> {
        if (process.platform !== "win32") return super.finish();
        for (const [path, observed] of this.nativeObserved) {
            if (!same(observed.identity, await lstat(path, { bigint: true })))
                throw new Error("RUNTIME_V1_INPUT_CHANGED");
            if (observed.digest)
                for await (const _bytes of this.chunks(path, Number(observed.identity.size))) {
                }
        }
    }
}

/**
 * 两次持有观察比较完整文件身份，不能只因摘要相同就接受已经替换的源码或安装材料；本轮工作根由调用者独占，这个检测不宣称同用户恶意并发修改下的原子整树隔离能力。
 * 目录变动只在安装和工作区投影完成后开始记录，正常生产动作不会被误认成外部篡改。
 */
function same(a: BigIntStats, b: BigIntStats): boolean {
    return ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
        (key) => a[key as keyof BigIntStats] === b[key as keyof BigIntStats],
    );
}

/**
 * 原生路径包含关系使用宿主 relative 后转成可移植组件，Windows 盘符、大小写或分隔符不会被固定斜线前缀误判；真实包查找和 observer 归属随后仍要命中实际普通目录与已观察清单。
 * 返回值只服务同一独占根内的路径映射，不成为读取外部文件的能力。
 */
function inside(root: string, path: string): string | null {
    const result = nativeRelative(root, path).replaceAll("\\", "/");
    return result === ".." || result.startsWith("../") || isAbsolute(result) ? null : result;
}

/**
 * 外部工具库存核对全量文件和原始摘要，不能只固定一个转发 CLI 而允许 pnpm dist 实现被替换；完整工具包由独立任务准备，生产步骤只读取且在实际命令结束后再次验证同一事实集合。
 * Unix 执行位不作为 Windows 可信身份，跨平台共同绑定路径、长度与 SHA256，实际 loader 的版本输出也要逐字匹配固定 pnpm 版本。
 */
async function pinnedTool(material: RuntimeV1Material): Promise<void> {
    await admitReleaseRoot(material.root);
    const inventory = await inventoryReleaseTree(material.root, "dependencies");
    const facts = (items: readonly FileFact[]) =>
        [...items]
            .sort((a, b) => a.path.localeCompare(b.path))
            .map(({ path, sizeBytes, sha256 }) => ({ path, sizeBytes, sha256 }));
    if (JSON.stringify(facts(inventory.files)) !== JSON.stringify(facts(material.files)))
        throw new Error("RUNTIME_V1_PNPM_TOOL_MISMATCH");
}

/**
 * 空缺可选包必须由原锁中该精确包版本的 os/cpu 声明证明不适用当前真实目标，不能把安装缺失解释成任意 optional 成功；optional peer 只记录实际物理查找缺失，普通依赖与 required peer 永远不能省
 * 略。
 * 这里只复用 C04 的固定锁块解析，不实现另一个 YAML 或 exports 解释器，遇到不支持的标量结构保持失败。
 */
function excludedOptional(
    lock: ReturnType<typeof lockSections>,
    alias: string,
    requested: string,
): unknown {
    const key = `${alias}@${requested}`,
        body = lock.packages.get(key);
    if (!body) throw new Error("RUNTIME_V1_OPTIONAL_LOCK_MISSING");
    const fields: Record<string, string[]> = {};
    for (const name of ["os", "cpu"]) {
        const row = new RegExp(`^ {8}${name}: \\[([^\\]]*)\\]\\s*$`, "m").exec(body);
        if (row) {
            fields[name] = row[1]!
                .split(",")
                .map((item) => item.trim().replace(/^['"]|['"]$/g, ""));
            if (fields[name]!.some((item) => !/^!?[a-z0-9_-]+$/i.test(item)))
                throw new Error("RUNTIME_V1_OPTIONAL_METADATA_UNSUPPORTED");
        } else if (new RegExp(`^ {8}${name}:`, "m").test(body))
            throw new Error("RUNTIME_V1_OPTIONAL_METADATA_UNSUPPORTED");
    }
    const excluded = (values: string[] | undefined, value: string) =>
        values &&
        (values.includes("!any") ||
            values.includes(`!${value}`) ||
            (values.some((item) => !item.startsWith("!")) &&
                !values.includes("any") &&
                !values.includes(value)));
    if (!excluded(fields.os, process.platform) && !excluded(fields.cpu, process.arch))
        throw new Error("RUNTIME_V1_APPLICABLE_OPTIONAL_MISSING");
    return {
        key,
        rawPackageMetadata: body,
        fields,
        platform: process.platform,
        arch: process.arch,
    };
}

/** v1 输出沿用原 hoisted 安装域映射，嵌套 node_modules 保留物理位置与 peer 上下文，源码工作区别名已在受控安装投影阶段替换为普通生成包；不同原域映射同一目的根时明确拒绝而不按名字或版本去重。
 * 只允许 Runtime 及合同和 SDK 的依赖安装域，其它工作区不能成为独立执行根的隐式依赖来源。
 */
function outputRoot(physical: string): string {
    if (physical.startsWith("node_modules/")) return physical;
    if (physical.startsWith("apps/runtime/node_modules/"))
        return physical.slice("apps/runtime/".length);
    for (const name of ["contracts", "runner-sdk"])
        if (physical.startsWith(`packages/${name}/node_modules/`))
            return `node_modules/@veriq/${name}/${physical.slice(`packages/${name}/`.length)}`;
    throw new Error("RUNTIME_V1_DEPENDENCY_INSTALL_SCOPE_UNSUPPORTED");
}

/**
 * 依赖准备只在真实 Linux/Windows x64 宿主运行，源码、工具与原锁均由外层独立身份固定；安装成功后才生成工作区 JS、采集物理观察、选择可达闭包并在最终无链接布局中实际调用目标 Node 的两种解析器。
 * 任何关闭未知、超时、截断或失败立即停止后续安装树观察，保留本轮自有根，不生成成功收据或把候选包正文执行当作解析证明。
 * 调用者已经构建 entry/execution，因此根导入取真实输出 AST，额外固定根 tsx 与原 C04 一致。
 */
export async function prepareRuntimeV1Dependencies(
    options: Readonly<{
        preparation: RuntimeV1DependencyPreparation;
        sourceRoot: string;
        source: SourceBindingV1;
        runtimeRoot: string;
        workRoot: string;
        evidenceRoot: string;
        executable: string;
        nodeIdentity: Ref;
        nodeVersion: string;
        timeoutMs: number;
        run: (invocation: HostBuildInvocation) => Promise<HostBuildObservation>;
    }>,
): Promise<RuntimeV1DependencyResult> {
    const config = structuredClone(options.preparation),
        source = structuredClone(options.source);
    if (!["linux", "win32"].includes(process.platform) || process.arch !== "x64")
        throw new Error("RUNTIME_V1_DEPENDENCY_HOST_UNSUPPORTED");
    for (const path of [
        config.pnpmCli,
        config.pnpmPackage.root,
        config.pnpmStore,
        options.workRoot,
        options.evidenceRoot,
    ])
        if (!isAbsolute(path)) throw new Error("RUNTIME_ABSOLUTE_PATH_REQUIRED");
    for (const path of [
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "package.json",
        "LICENSE",
        "apps/runtime/package.json",
        "apps/runtime/scripts/runtime-release-v1-dependencies.ts",
        "apps/runtime/scripts/runtime-release-v1.ts",
        "apps/runtime/scripts/runtime-release-files.ts",
        "apps/runtime/scripts/runtime-release-builds.ts",
        "apps/runtime/scripts/runtime-workspace-packages.ts",
        "apps/runtime/scripts/runtime-dependency-files.ts",
        "apps/runtime/scripts/runtime-dependency-layout.mjs",
        "apps/runtime/scripts/runtime-dependency-resolver.mjs",
        "apps/runtime/scripts/runtime-dependency-closure.ts",
        ".github/scripts/production-layout.mjs",
    ])
        if (!source.files.some((file) => file.path === path))
            throw new Error("RUNTIME_V1_DEPENDENCY_SOURCE_MISSING");
    const compilerFiles = new NativeBuildFiles();
    await pinnedTool(config.pnpmPackage);
    const pnpmCli = await realpath(config.pnpmCli),
        toolRelative = inside(config.pnpmPackage.root, pnpmCli);
    if (
        toolRelative !== "bin/pnpm.cjs" ||
        !config.pnpmPackage.files.some((file) => file.path === toolRelative) ||
        !config.pnpmPackage.files.some((file) => file.path === "dist/pnpm.cjs")
    )
        throw new Error("RUNTIME_V1_PNPM_ENTRY_UNBOUND");
    const pnpmManifest = JSON.parse(
        (
            await compilerFiles.read(join(config.pnpmPackage.root, "package.json"), limits.package)
        ).toString(),
    ) as { name?: string; version?: string };
    if (pnpmManifest.name !== "pnpm" || pnpmManifest.version !== "11.25.0")
        throw new Error("RUNTIME_V1_PNPM_PACKAGE_IDENTITY_MISMATCH");
    await admitReleaseRoot(config.pnpmStore);
    await mkdir(options.workRoot, { mode: 0o700 });
    const installation = join(options.workRoot, "installation"),
        generatedRoot = join(options.workRoot, "generated"),
        layoutRoot = join(options.workRoot, "runtime");
    for (const path of [installation, generatedRoot, layoutRoot])
        await mkdir(path, { mode: 0o700 });
    for (const ref of source.files)
        await copyReleaseFile(
            join(options.sourceRoot, ref.path),
            installation,
            ref.path,
            ref,
            0o644,
        );
    // 当前实际宿主实现也必须匹配独立源码绑定，不能只复制一份伪造同形实现到 installation；导入工具及发射器随后继续用 held 输入记录真实执行源码和 TypeScript 文件身份。
    for (const path of source.files.filter(
        (file) =>
            /^apps\/runtime\/scripts\/runtime-(?:release-(?:v1|files|builds)|workspace-packages|dependency-)/.test(
                file.path,
            ) || file.path === ".github/scripts/production-layout.mjs",
    )) {
        const local = path.path.startsWith(".github/")
            ? new URL(`../../../${path.path}`, import.meta.url)
            : new URL(path.path.slice("apps/runtime/scripts/".length), import.meta.url);
        const actual = await compilerFiles.fact(fileURLToPath(local));
        if (actual.sizeBytes !== path.sizeBytes || actual.sha256 !== path.sha256)
            throw new Error("RUNTIME_V1_PRODUCER_SOURCE_CHANGED");
    }
    const commandContext = {
        inputRoot: options.evidenceRoot,
        timeoutMs: options.timeoutMs,
        run: options.run,
    };
    const commands: Ref[] = [];
    const command = async (name: string, args: readonly string[], cwd = installation) => {
        const result = await observeRuntimeCommand(
            commandContext,
            `v1-dependencies-${name}`,
            options.executable,
            args,
            cwd,
        );
        commands.push(result.evidence);
        return result;
    };
    if ((await command("pnpm-version", [pnpmCli, "--version"])).stdout.trim() !== "11.25.0")
        throw new Error("RUNTIME_V1_PNPM_VERSION_MISMATCH");
    await command("install", [
        pnpmCli,
        "--filter",
        "@veriq/runtime...",
        "install",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--prod",
        "--node-linker=hoisted",
        "--package-import-method=copy",
        "--store-dir",
        config.pnpmStore,
    ]);
    const sourceFiles = new NativeBuildFiles();
    for (const ref of source.files) {
        const actual = await sourceFiles.fact(join(installation, ref.path));
        if (actual.sha256 !== ref.sha256 || actual.sizeBytes !== ref.sizeBytes)
            throw new Error("RUNTIME_V1_INSTALL_SOURCE_CHANGED");
    }
    const lockRef = source.files.find((file) => file.path === "pnpm-lock.yaml")!;
    const lock = lockSections(await sourceFiles.read(join(installation, lockRef.path)));
    const generated = await materializeRuntimeWorkspacePackages({
        sourceRoot: options.sourceRoot,
        outputRoot: generatedRoot,
        source,
        files: compilerFiles,
    });
    const compilerIdentities = (
        items: readonly { path: string; sizeBytes: number; sha256: string }[],
    ) =>
        [...items]
            .sort((a, b) => a.path.localeCompare(b.path))
            .map(({ path, sizeBytes, sha256 }) => ({ path, sizeBytes, sha256 }));
    const actualCompiler = generated.compilerImplementation.map(
        ({ absolutePath, ...identity }) => ({ path: absolutePath, ...identity }),
    );
    if (
        JSON.stringify(compilerIdentities(actualCompiler)) !==
        JSON.stringify(compilerIdentities(config.compilerImplementation))
    )
        throw new Error("RUNTIME_V1_TYPESCRIPT_IMPLEMENTATION_MISMATCH");
    const workspaceOrigins = new Map<string, string>(),
        linkEvidence: unknown[] = [];
    // pnpm 在 Windows 使用绝对 junction，旧 observer 只接受可移植链接文本；这里只在已关闭安装的自有投影中移除确指原始绑定工作区的链接并复制普通生成包，原始源码、锁和工具目录从不修改。
    let projectionMembers = 0;
    const normalize = async (path: string, stack: readonly string[] = []): Promise<void> => {
        if (++projectionMembers > 40000 || path.split("/").length > 64)
            throw new Error("RUNTIME_V1_DEPENDENCY_LIMIT");
        const absolute = join(installation, path),
            before = await lstat(absolute);
        if (before.isSymbolicLink()) {
            if (path.split("/").includes(".bin")) return;
            const endpoint = inside(installation, await realpath(absolute));
            const manifest =
                endpoint && source.files.find((file) => file.path === `${endpoint}/package.json`);
            if (
                !endpoint ||
                !manifest ||
                !/^(?:packages|apps)\/[^/]+$/.test(endpoint) ||
                stack.includes(endpoint)
            )
                throw new Error("RUNTIME_V1_INSTALL_LINK_UNSUPPORTED");
            const originalTarget = await readlink(absolute);
            const generation = generated.packages.find((pkg) => pkg.sourceRoot === endpoint);
            const originals = source.files.filter((file) => file.path.startsWith(endpoint + "/"));
            await unlink(absolute);
            await releaseDirectory(installation, path);
            for (const ref of generation?.files ??
                originals.map((file) => ({ ...file, path: file.path.slice(endpoint.length + 1) })))
                await copyReleaseFile(
                    generation
                        ? join(generation.generatedRoot, ref.path)
                        : join(installation, endpoint, ref.path),
                    installation,
                    `${path}/${ref.path}`,
                    ref,
                    0o644,
                );
            workspaceOrigins.set(path, endpoint);
            linkEvidence.push({
                path,
                originalTarget,
                endpoint,
                generated: Boolean(generation),
                originalManifest: manifest,
            });
            const nested = join(installation, endpoint, "node_modules");
            if (
                (
                    await lstat(nested).catch((error: NodeJS.ErrnoException) => {
                        if (error.code !== "ENOENT") throw error;
                        return null;
                    })
                )?.isDirectory()
            ) {
                // 工作区自身安装域的嵌套依赖不能因替换 alias 丢失；逐节点复制该有限子树，已知工作区链接递归投影，循环或未知目录链接明确拒绝而不跟随到外部。
                const cloneBase = `${endpoint}/node_modules`,
                    projectedBase = `${path}/node_modules`;
                const clone = async (
                    from: string,
                    to: string,
                    depth: number,
                    lineage: readonly string[],
                    mappings: readonly (readonly [string, string])[],
                ): Promise<void> => {
                    if (depth > 64 || ++projectionMembers > 40000)
                        throw new Error("RUNTIME_V1_DEPENDENCY_DEPTH");
                    const info = await lstat(join(installation, from));
                    if (info.isSymbolicLink()) {
                        const target = inside(
                            installation,
                            await realpath(join(installation, from)),
                        );
                        if (!target) throw new Error("RUNTIME_V1_INSTALL_LINK_UNSUPPORTED");
                        if (from.split("/").includes(".bin")) {
                            const mapping = [...mappings]
                                .reverse()
                                .find(([prefix]) => target.startsWith(prefix + "/"));
                            const mapped = mapping
                                ? `${mapping[1]}/${target.slice(mapping[0].length + 1)}`
                                : target;
                            await releaseDirectory(installation, posix.dirname(to));
                            await symlink(
                                posix.relative(posix.dirname(to), mapped),
                                join(installation, to),
                                "file",
                            );
                            linkEvidence.push({
                                path: to,
                                originalAlias: from,
                                target: mapped,
                                transform: "OWNED_WORKSPACE_BIN_LINK_PROJECTION",
                            });
                            return;
                        }
                        if (lineage.includes(target))
                            throw new Error("RUNTIME_V1_INSTALL_LINK_UNSUPPORTED");
                        const selected = generated.packages.find(
                            (pkg) => pkg.sourceRoot === target,
                        );
                        if (!selected) throw new Error("RUNTIME_V1_INSTALL_LINK_UNSUPPORTED");
                        await releaseDirectory(installation, to);
                        for (const ref of selected.files)
                            await copyReleaseFile(
                                join(selected.generatedRoot, ref.path),
                                installation,
                                `${to}/${ref.path}`,
                                ref,
                                0o644,
                            );
                        workspaceOrigins.set(to, target);
                        const ownNested = await lstat(
                            join(installation, target, "node_modules"),
                        ).catch((error: NodeJS.ErrnoException) => {
                            if (error.code !== "ENOENT") throw error;
                            return null;
                        });
                        if (ownNested)
                            await clone(
                                `${target}/node_modules`,
                                `${to}/node_modules`,
                                depth + 1,
                                [...lineage, target],
                                [...mappings, [`${target}/node_modules`, `${to}/node_modules`]],
                            );
                    } else if (info.isDirectory()) {
                        await releaseDirectory(installation, to);
                        for (const name of await readdir(join(installation, from)))
                            await clone(
                                `${from}/${name}`,
                                `${to}/${name}`,
                                depth + 1,
                                lineage,
                                mappings,
                            );
                    } else if (info.isFile())
                        await copyReleaseFile(
                            join(installation, from),
                            installation,
                            to,
                            undefined,
                            process.platform === "win32" || !(info.mode & 0o111) ? 0o644 : 0o755,
                        );
                    else throw new Error("RUNTIME_V1_INSTALL_TYPE_UNSUPPORTED");
                };
                await clone(
                    cloneBase,
                    projectedBase,
                    0,
                    [...stack, endpoint],
                    [[cloneBase, projectedBase]],
                );
            }
            return;
        }
        if (before.isDirectory())
            for (const name of await readdir(absolute))
                await normalize(path ? `${path}/${name}` : name, stack);
        else if (!before.isFile()) throw new Error("RUNTIME_V1_INSTALL_TYPE_UNSUPPORTED");
    };
    await normalize("");
    const layout = await collectLayoutMetadata({
        root: installation,
        evidenceDir: join(options.workRoot, "observer"),
        workspaceRoots: source.files
            .filter((file) => /^(?:apps|packages)\/[^/]+\/package\.json$/.test(file.path))
            .map((file) => ({ path: posix.dirname(file.path), sourcePath: file.path })),
    });
    const records: LayoutRecord[] = [];
    const observedFiles = new NativeBuildFiles();
    for (const artifact of layout.artifacts) {
        const bytes = await observedFiles.read(
            join(options.workRoot, "observer", artifact.path),
            limits.json,
        );
        if (bytes.length !== artifact.bytes || sha(bytes) !== artifact.sha256)
            throw new Error("RUNTIME_V1_LAYOUT_CHANGED");
        await writeReleaseBytes(options.evidenceRoot, `dependency-layout/${artifact.path}`, bytes);
        if (artifact.kind === "inventory")
            records.push(...(JSON.parse(bytes.toString()) as LayoutRecord[]));
    }
    const observedPackages = new Map(
        records
            .filter((record) => record.kind === "package")
            .map((record) => [record.path, record]),
    );
    const packages: Array<{
        id: string;
        physical: string;
        root: string;
        manifest: Record<string, unknown>;
        snapshot: string;
    }> = [];
    const byPhysical = new Map<string, (typeof packages)[number]>(),
        byOutput = new Map<string, string>();
    const discover = async (
        alias: string,
        from: string,
    ): Promise<(typeof packages)[number] | null> => {
        for (const base of createRequire(join(installation, from, "package.json")).resolve.paths(
            alias,
        ) ?? []) {
            if (inside(installation, base) === null) continue;
            const candidate = join(base, alias),
                info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
                    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
                    return null;
                });
            if (!info) continue;
            const physical = inside(installation, await realpath(candidate));
            if (!physical || !info.isDirectory() || !observedPackages.has(physical))
                throw new Error("RUNTIME_V1_PACKAGE_UNOBSERVED");
            const previous = byPhysical.get(physical);
            if (previous) return previous;
            if (packages.length >= limits.instances) throw new Error("RUNTIME_V1_DEPENDENCY_LIMIT");
            const manifest = JSON.parse(
                (
                    await observedFiles.read(join(candidate, "package.json"), limits.package)
                ).toString(),
            ) as Record<string, unknown>;
            if (
                !manifest ||
                typeof manifest.name !== "string" ||
                typeof manifest.version !== "string"
            )
                throw new Error("RUNTIME_V1_PACKAGE_IDENTITY_INVALID");
            const root = outputRoot(physical);
            if (byOutput.has(root) && byOutput.get(root) !== physical)
                throw new Error("RUNTIME_V1_INSTALL_SCOPE_COLLISION");
            byOutput.set(root, physical);
            let snapshot: string;
            if (workspaceOrigins.has(physical))
                snapshot = `source-workspace:${workspaceOrigins.get(physical)}`;
            else {
                const key = `${manifest.name}@${manifest.version}`;
                let candidates = [...lock.snapshots.keys()].filter(
                    (item) => item === key || item.startsWith(key + "("),
                );
                for (const peer of dependencyDeclarations(manifest).filter(
                    (item) => item.kind === "peer" || item.kind === "optional-peer",
                )) {
                    if (candidates.length <= 1) break;
                    for (const lookup of createRequire(
                        join(candidate, "package.json"),
                    ).resolve.paths(peer.alias) ?? []) {
                        if (inside(installation, lookup) === null) continue;
                        const peerPath = join(lookup, peer.alias, "package.json");
                        const peerBytes = await observedFiles
                            .read(peerPath, limits.package)
                            .catch((error: NodeJS.ErrnoException) => {
                                if (error.code !== "ENOENT" && error.code !== "ENOTDIR")
                                    throw error;
                                return null;
                            });
                        if (peerBytes) {
                            const version = JSON.parse(peerBytes.toString()).version as string;
                            candidates = candidates.filter(
                                (item) =>
                                    item.includes(`(${peer.alias}@${version})`) ||
                                    item.includes(`(${peer.alias}@${version}(`),
                            );
                            break;
                        }
                    }
                }
                if (candidates.length !== 1) throw new Error("RUNTIME_V1_LOCK_SNAPSHOT_AMBIGUOUS");
                snapshot = candidates[0]!;
            }
            const item = { id: `p${packages.length + 1}`, physical, root, manifest, snapshot };
            packages.push(item);
            byPhysical.set(physical, item);
            return item;
        }
        return null;
    };
    const roots: Array<{ consumer: string; specifier: string; to: string }> = [];
    for (const kind of ["entry", "execution"] as const) {
        const inventory = await inventoryReleaseTree(
            join(options.runtimeRoot, kind),
            kind === "entry" ? "entries" : "execution",
        );
        for (const file of inventory.files) {
            if (kind === "entry" && !/\.(?:js|mjs|cjs)$/.test(file.path)) continue;
            const bytes = await observedFiles.read(
                join(options.runtimeRoot, kind, file.path),
                limits.javascript,
            );
            for (const fact of scanRuntimeLiteralImports(bytes, file.path)) {
                const edge = classifyRuntimeModuleEdge(
                    fact,
                    file.path,
                    inventory.files,
                    kind === "execution",
                );
                if (edge.kind !== "external") continue;
                const target = await discover(packageAlias(edge.specifier), "apps/runtime");
                if (!target) throw new Error("RUNTIME_V1_ROOT_DEPENDENCY_MISSING");
                if (
                    !roots.some(
                        (root) =>
                            root.consumer === `${kind}/${file.path}` &&
                            root.specifier === edge.specifier,
                    )
                )
                    roots.push({
                        consumer: `${kind}/${file.path}`,
                        specifier: edge.specifier,
                        to: target.id,
                    });
            }
        }
    }
    const tsx = await discover("tsx", "apps/runtime");
    if (!tsx || tsx.manifest.version !== "4.23.15") throw new Error("RUNTIME_V1_TSX_ROOT_MISSING");
    roots.push({ consumer: "package.json", specifier: "tsx", to: tsx.id });
    const edges: Array<{
        from: string;
        alias: string;
        kind: string;
        requested: string;
        to: string | null;
        absence: unknown;
    }> = [];
    for (let index = 0; index < packages.length; index++) {
        const pkg = packages[index]!;
        for (const declaration of dependencyDeclarations(pkg.manifest)) {
            if (edges.length >= limits.edges) throw new Error("RUNTIME_V1_DEPENDENCY_LIMIT");
            const target = await discover(declaration.alias, pkg.physical);
            if (!target && declaration.kind !== "optional" && declaration.kind !== "optional-peer")
                throw new Error("RUNTIME_V1_REQUIRED_DEPENDENCY_MISSING");
            edges.push({
                from: pkg.id,
                ...declaration,
                to: target?.id ?? null,
                absence: target
                    ? null
                    : declaration.kind === "optional"
                      ? excludedOptional(lock, declaration.alias, declaration.requested)
                      : "OPTIONAL_PEER_ABSENT",
            });
        }
    }
    const outputFiles: FileFact[] = [];
    for (const pkg of packages) {
        await releaseDirectory(layoutRoot, pkg.root);
        const own = records.filter(
            (record) =>
                record.owner === pkg.physical &&
                record.path.startsWith(pkg.physical + "/") &&
                !record.path
                    .slice(pkg.physical.length + 1)
                    .split("/")
                    .includes("node_modules"),
        );
        if (own.some((record) => record.kind === "link"))
            throw new Error("RUNTIME_V1_PACKAGE_LINK_UNSUPPORTED");
        for (const record of own) {
            const path = `${pkg.root}/${record.path.slice(pkg.physical.length + 1)}`;
            if (record.kind === "directory") await releaseDirectory(layoutRoot, path);
            if (record.kind !== "file") continue;
            outputFiles.push(
                await copyReleaseFile(
                    join(installation, record.path),
                    layoutRoot,
                    path,
                    { path: record.path, sizeBytes: record.bytes!, sha256: record.sha256! },
                    process.platform === "win32" || !(record.mode! & 0o111) ? 0o644 : 0o755,
                ),
            );
        }
    }
    const bins: Bin[] = [];
    for (const pkg of packages) {
        const raw = pkg.manifest.bin;
        if (raw === undefined) continue;
        const declarations =
            typeof raw === "string" ? { [String(pkg.manifest.name).split("/").at(-1)!]: raw } : raw;
        if (!declarations || typeof declarations !== "object" || Array.isArray(declarations))
            throw new Error("RUNTIME_V1_BIN_DECLARATION_INVALID");
        for (const [name, value] of Object.entries(declarations)) {
            relative(name);
            if (
                name.includes("/") ||
                name.toLowerCase() === "node" ||
                typeof value !== "string" ||
                value.startsWith("/") ||
                value.includes("\\")
            )
                throw new Error("RUNTIME_V1_BIN_DECLARATION_INVALID");
            const targetPath = posix.normalize(`${pkg.root}/${value}`),
                target = outputFiles.find((file) => file.path === targetPath);
            if (
                !target ||
                !targetPath.startsWith(pkg.root + "/") ||
                targetPath
                    .slice(pkg.root.length + 1)
                    .split("/")
                    .includes("node_modules")
            )
                throw new Error("RUNTIME_V1_BIN_TARGET_INVALID");
            const header = await observedFiles.header(join(installation, pkg.physical, value));
            const end = header.indexOf(10),
                first = header.subarray(0, end < 0 ? header.length : end).toString();
            const node =
                first === "#!/usr/bin/env node" ||
                first === "#!/usr/bin/node" ||
                (/\.(?:js|cjs|mjs)$/.test(targetPath) && !first.startsWith("#!"));
            let inspection: Ref | null = null;
            if (!node) {
                const elf =
                    header.length >= 20 &&
                    header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
                    header[4] === 2 &&
                    header[5] === 1 &&
                    header.readUInt16LE(18) === 62;
                const peOffset = header.length >= 64 ? header.readUInt32LE(60) : -1;
                const pe =
                    peOffset >= 64 &&
                    peOffset + 6 <= header.length &&
                    header.subarray(0, 2).toString() === "MZ" &&
                    header.subarray(peOffset, peOffset + 4).equals(Buffer.from([80, 69, 0, 0])) &&
                    header.readUInt16LE(peOffset + 4) === 0x8664;
                if (first.startsWith("#!") || (process.platform === "linux" ? !elf : !pe))
                    throw new Error("RUNTIME_V1_NATIVE_BIN_ARCHITECTURE_INVALID");
                inspection = await writeReleaseJson(
                    options.evidenceRoot,
                    `dependency-native-bin-${bins.length}.json`,
                    {
                        kind: "NATIVE_V1_ARCHITECTURE_HEADER",
                        platform: process.platform,
                        arch: process.arch,
                        path: targetPath,
                        sha256: target.sha256,
                        method:
                            process.platform === "linux"
                                ? "HELD_ELF64_X86_64_HEADER"
                                : "HELD_PE_COFF_AMD64_HEADER",
                        boundary:
                            "Architecture header only; no execution, signature or minimum OS acceptance.",
                    },
                );
            }
            const install = pkg.root.lastIndexOf("node_modules/");
            bins.push({
                owner: pkg.id,
                name,
                aliasPath: `${pkg.root.slice(0, install)}node_modules/.bin/${name}`,
                sourceAlias: null,
                targetPath,
                targetSha256: target.sha256,
                launcher: node ? "node" : "native",
                inspection,
            });
            if (bins.length > limits.bins) throw new Error("RUNTIME_V1_BIN_LIMIT");
        }
    }
    const binAliases: unknown[] = [];
    for (const alias of new Set(bins.map((bin) => bin.aliasPath))) {
        const group = bins.filter((bin) => bin.aliasPath === alias),
            actualTargets = new Set<string>();
        const originalAliases = records.filter(
            (record) =>
                (record.kind === "link" || record.kind === "file") &&
                record.path.split("/").includes(".bin") &&
                [
                    "node_modules/",
                    "apps/runtime/node_modules/",
                    "packages/contracts/node_modules/",
                    "packages/runner-sdk/node_modules/",
                ].some((prefix) => record.path.startsWith(prefix)) &&
                outputRoot(record.path) === alias,
        );
        for (const record of originalAliases) {
            if (record.kind === "link")
                actualTargets.add(
                    posix.normalize(posix.join(posix.dirname(record.path), record.target!)),
                );
            else {
                const bytes = await observedFiles.read(
                    join(installation, record.path),
                    limits.package,
                );
                const lines = bytes
                    .toString()
                    .split("\n")
                    .filter((line) => /^\s*exec\s/.test(line));
                for (const line of lines) {
                    const match = new RegExp(
                        '^\\s*exec\\s+(?:(?:"\\$basedir/node(?:\\.exe)?"|node(?:\\.exe)?)\\s+)?"\\$bas' +
                            'edir/([^"\\r\\n]+)"\\s+"\\$@"\\s*$',
                        "",
                    ).exec(line);
                    if (!match) throw new Error("RUNTIME_V1_BIN_SHIM_UNSUPPORTED");
                    actualTargets.add(
                        posix.normalize(posix.join(posix.dirname(record.path), match[1]!)),
                    );
                }
                if (!lines.length) throw new Error("RUNTIME_V1_BIN_SHIM_UNSUPPORTED");
            }
        }
        const winners = group.filter((bin) => {
            const pkg = packages.find((item) => item.id === bin.owner)!;
            return actualTargets.has(
                `${pkg.physical}/${bin.targetPath.slice(pkg.root.length + 1)}`,
            );
        });
        if (winners.length !== 1 || actualTargets.size !== 1)
            throw new Error("RUNTIME_V1_BIN_WINNER_AMBIGUOUS");
        const winner = winners[0]!;
        binAliases.push({
            alias,
            owner: winner.owner,
            originals: originalAliases,
            target: winner.targetPath,
        });
        for (const bin of group) {
            const path =
                bin === winner
                    ? alias
                    : `${posix.dirname(alias)}/.veriq/${sha(Buffer.from(bin.owner))}/${bin.name}`;
            const rendered = renderBinShim({ ...bin, aliasPath: path });
            await writeReleaseBytes(
                layoutRoot,
                path,
                process.platform === "win32"
                    ? Buffer.from(
                          Buffer.from(rendered)
                              .toString()
                              .replaceAll(
                                  "roles/runner/veriq_runner",
                                  "roles/runner/veriq_runner.exe",
                              ),
                      )
                    : rendered,
            );
            if (process.platform === "win32") {
                const base = posix.dirname(path),
                    runner = posix
                        .relative(base, "roles/runner/veriq_runner.exe")
                        .replaceAll("/", "\\"),
                    target = posix.relative(base, bin.targetPath).replaceAll("/", "\\");
                if (/[\x00-\x1f%!^&()]/.test(runner + target))
                    throw new Error("RUNTIME_V1_BIN_CMD_PATH_UNSUPPORTED");
                await writeReleaseBytes(
                    layoutRoot,
                    `${path}.cmd`,
                    Buffer.from(
                        `@echo off\r\n${
                            bin.launcher === "node"
                                ? `@"%~dp0${runner}" "%~dp0${target}"`
                                : `@"%~dp0${target}"`
                        } %*\r\n`,
                    ),
                );
            } else await chmod(join(layoutRoot, path), 0o755);
        }
    }
    // 两种实际 Node 解析都作用于最终普通布局，入口和执行文件只复制原始已构建字节；边 witness 可以尝试真实 bin/package.json 子路径，但所有失败保留，不猜测被 exports 阻止的路径已经成功。
    for (const kind of ["entry", "execution"] as const) {
        const inventory = await inventoryReleaseTree(
            join(options.runtimeRoot, kind),
            kind === "entry" ? "entries" : "execution",
        );
        for (const file of inventory.files)
            await copyReleaseFile(
                join(options.runtimeRoot, kind, file.path),
                layoutRoot,
                `${kind}/${file.path}`,
                file,
                0o644,
            );
    }
    await writeReleaseJson(layoutRoot, "package.json", { private: true, type: "module" });
    const requests: Array<{ consumer: string; specifier: string }> = [];
    const addRequest = (consumer: string, specifier: string) => {
        if (!requests.some((item) => item.consumer === consumer && item.specifier === specifier))
            requests.push({ consumer, specifier });
    };
    for (const root of roots) addRequest(root.consumer, root.specifier);
    for (const edge of edges.filter((edge) => edge.to !== null)) {
        const from = packages.find((pkg) => pkg.id === edge.from)!,
            target = packages.find((pkg) => pkg.id === edge.to)!;
        addRequest(`${from.root}/package.json`, edge.alias);
        for (const bin of bins.filter((bin) => bin.owner === target.id))
            addRequest(
                `${from.root}/package.json`,
                `${edge.alias}/${bin.targetPath.slice(target.root.length + 1)}`,
            );
        addRequest(`${from.root}/package.json`, `${edge.alias}/package.json`);
    }
    const request = await writeReleaseJson(options.workRoot, "resolver-requests.json", requests);
    const resolverRef = source.files.find(
        (file) => file.path === "apps/runtime/scripts/runtime-dependency-resolver.mjs",
    )!;
    const resolverPath = join(options.sourceRoot, resolverRef.path),
        resultPath = join(options.workRoot, "resolver-result.json");
    const resultCommand = await command(
        "node-resolve",
        [
            "--experimental-import-meta-resolve",
            resolverPath,
            layoutRoot,
            join(options.workRoot, request.path),
            resultPath,
        ],
        layoutRoot,
    );
    const resultBytes = await observedFiles.read(resultPath, limits.json),
        announced = JSON.parse(resultCommand.stdout) as Ref;
    if (announced.sizeBytes !== resultBytes.length || announced.sha256 !== sha(resultBytes))
        throw new Error("RUNTIME_V1_RESOLVER_RESULT_CHANGED");
    type Resolution = {
        consumer: string;
        specifier: string;
        import: { path: string | null; error: string | null };
        require: { path: string | null; error: string | null };
    };
    const result = JSON.parse(resultBytes.toString()) as {
        nodeVersion: string;
        executableSha256: string;
        platform: string;
        arch: string;
        resolutions: Resolution[];
    };
    if (
        result.nodeVersion !== options.nodeVersion ||
        result.executableSha256 !== options.nodeIdentity.sha256 ||
        result.platform !== process.platform ||
        result.arch !== process.arch ||
        result.resolutions.length !== requests.length
    )
        throw new Error("RUNTIME_V1_RESOLVER_IDENTITY_MISMATCH");
    const owner = (path: string) =>
        [...packages]
            .sort((a, b) => b.root.length - a.root.length)
            .find(
                (pkg) =>
                    path.startsWith(pkg.root + "/") &&
                    !path
                        .slice(pkg.root.length + 1)
                        .split("/")
                        .includes("node_modules"),
            );
    const resolvedTo = (row: Resolution, id: string, requireImport: boolean): boolean => {
        if (requireImport && !row.import.path) return false;
        const successes = [row.import, row.require].filter((item) => item.path !== null);
        return (
            successes.length > 0 &&
            successes.every(
                (item) =>
                    owner(item.path!)?.id === id &&
                    outputFiles.some((file) => file.path === item.path),
            )
        );
    };
    for (const root of roots) {
        const row = result.resolutions.find(
            (item) => item.consumer === root.consumer && item.specifier === root.specifier,
        );
        if (!row || !resolvedTo(row, root.to, true))
            throw new Error("RUNTIME_V1_LITERAL_ROOT_RESOLUTION_FAILED");
    }
    for (const edge of edges.filter((edge) => edge.to !== null)) {
        const consumer = `${packages.find((pkg) => pkg.id === edge.from)!.root}/package.json`;
        if (
            !result.resolutions.some(
                (row) =>
                    row.consumer === consumer &&
                    packageAlias(row.specifier) === edge.alias &&
                    resolvedTo(row, edge.to!, false),
            )
        )
            throw new Error("RUNTIME_V1_EDGE_RESOLUTION_FAILED");
    }
    await writeReleaseBytes(options.evidenceRoot, "dependency-resolutions.json", resultBytes);
    await pinnedTool(config.pnpmPackage);
    await compilerFiles.finish();
    await sourceFiles.finish();
    await observedFiles.finish();
    const inventory = await inventoryReleaseTree(join(layoutRoot, "node_modules"), "dependencies");
    const generatedRef = await writeReleaseJson(
        options.evidenceRoot,
        "dependency-workspace-generation.json",
        generated,
    );
    const inventoryRef = await writeReleaseJson(
        options.evidenceRoot,
        "dependency-inventory.json",
        inventory,
    );
    const graphRef = await writeReleaseJson(options.evidenceRoot, "dependency-graph.json", {
        packages,
        edges,
        roots,
        bins,
        binAliases,
    });
    const toolRef = await writeReleaseJson(options.evidenceRoot, "dependency-tools.json", {
        node: options.nodeIdentity,
        pnpmPackage: config.pnpmPackage,
        pnpmCli,
        typescriptImplementation: config.compilerImplementation,
    });
    const layoutRef = await writeReleaseJson(
        options.evidenceRoot,
        "dependency-layout.json",
        layout,
    );
    const projectionRef = await writeReleaseJson(
        options.evidenceRoot,
        "dependency-workspace-projection.json",
        linkEvidence,
    );
    const evidence = await writeReleaseJson(options.evidenceRoot, "dependency-production.json", {
        schemaVersion: 1,
        kind: "NATIVE_V1_DEPENDENCY_PRODUCTION",
        platform: process.platform,
        arch: process.arch,
        sourceCommit: source.commit,
        sourceBindingSha256: sha(canonicalBytes(source)),
        sourceLock: lockRef,
        tools: toolRef,
        commands,
        layout: layoutRef,
        generated: generatedRef,
        workspaceProjection: projectionRef,
        graph: graphRef,
        inventory: inventoryRef,
        resolutionEvidence: {
            path: "dependency-resolutions.json",
            sizeBytes: resultBytes.length,
            sha256: sha(resultBytes),
        },
        policy: {
            offline: true,
            frozenLockfile: true,
            ignoreScripts: true,
            nodeLinker: "hoisted",
            packageImportMethod: "copy",
        },
        status: "DEPENDENCIES_PRODUCED_UNVERIFIED",
    });
    return {
        material: { root: join(layoutRoot, "node_modules"), files: inventory.files },
        evidence,
        status: "DEPENDENCIES_PRODUCED_UNVERIFIED",
    };
}
