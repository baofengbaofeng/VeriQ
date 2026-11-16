import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalBytes } from "@veriq/contracts";
import { collectLayoutMetadata, classifyCommandResult } from "./runtime-dependency-layout.mjs";
import { ArchiveTransaction } from "./runtime-payload-transaction.ts";
import {
    InputReader,
    contentLimit,
    decode,
    fail,
    freeze,
    limits,
    paths,
    sha,
} from "./runtime-payload-tree.ts";
import { checked, document, equal, schemas, setEqual } from "./runtime-payload-receipts.ts";
import {
    scanRuntimeLiteralImports,
    classifyRuntimeModuleEdge,
    verifyPackageContents,
} from "./runtime-payload-graph.ts";
import {
    DependencyFiles,
    admitDependencyBuildRoot,
    copyDependencySourceFile,
    copyDependencyView,
    unsupportedDependency,
    writeDependencyJson,
    writeDependencySource,
    writeDependencyView,
} from "./runtime-dependency-files.ts";
import { isNode24Version } from "../src/node-version.ts";
import {
    collectRuntimeDependencyClosure,
    lockSections,
    type LayoutRecord,
} from "./runtime-dependency-closure.ts";
import {
    materializeRuntimeWorkspacePackages,
    type WorkspaceGenerationEvidence,
} from "./runtime-workspace-packages.ts";
import type { HostBuildInvocation, HostBuildObservation } from "./runtime-payload-entries.ts";
import type {
    Bin,
    BoundTree,
    Build,
    DependenciesReceipt,
    DependencyGraph,
    FileFact,
    LinkFact,
    NativeBinInspection,
    PackageInstance,
    Ref,
    Resolution,
    SourceBindingV1,
    TreeInventory,
} from "./runtime-payload-inputs.ts";
import { RuntimePayloadError } from "./runtime-payload-inputs.ts";

/**
 * 依赖生产输入固定源码、真实消费者和独占离线安装位置，宿主动作沿用已有有界进程接口；调用者提供的是工具路径而不是依赖收
 * 据或 NODE_RESOLVE 声明，所有成功事实都必须来自本次实际动作及物理读取。
 */
export type DependencyInputOptions = Readonly<{
    source: SourceBindingV1;
    dependencies: Omit<Build, "commandEvidence">;
    buildRoot: string;
    consumers: Readonly<{ inputRoot: string; entries: BoundTree; execution: BoundTree }>;
    hostBuild: Readonly<{
        executable: string;
        pnpmCli: string;
        pnpmStore: string;
        timeoutMs: number;
        run: (invocation: HostBuildInvocation) => Promise<HostBuildObservation>;
    }>;
    targetNode: Readonly<{ executable: string; version: string; artifactSha256: string }>;
}>;

const producer = "apps/runtime/scripts/runtime-payload-dependencies.ts";
const requiredSources = [
    producer,
    "apps/runtime/scripts/runtime-workspace-packages.ts",
    "apps/runtime/scripts/runtime-dependency-files.ts",
    "apps/runtime/scripts/runtime-dependency-closure.ts",
    "apps/runtime/scripts/runtime-dependency-resolver.mjs",
    "apps/runtime/scripts/runtime-dependency-layout.mjs",
    ".github/scripts/production-layout.mjs",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    "apps/runtime/package.json",
    "LICENSE",
];
type CommandFact = {
    invocation: HostBuildInvocation;
    started: string;
    ended: string;
    observation: Omit<HostBuildObservation, "stdout" | "stderr">;
    stdout: Ref;
    stderr: Ref;
};
type ResolverRow = {
    consumer: string;
    specifier: string;
    import: { path: string | null; error: string | null };
    require: { path: string | null; error: string | null };
};

/**
 * 来源策略绑定当前生产器及冻结锁原文，不接受与来源绑定无关的 config 或任意工具集合；源文件不能占用依赖树与证据前缀，预
 * 算在复制前执行，生成包的来源和输出因此不会互相覆盖。
 */
function sourcePolicy(source: SourceBindingV1, build: Omit<Build, "commandEvidence">) {
    checked(source, schemas.source);
    paths(source.files.map((ref) => ref.path));
    if (
        source.files.length > limits.entries ||
        source.files.reduce((sum, ref) => sum + ref.sizeBytes, 0) > limits.total
    )
        fail("PAYLOAD_LIMIT");
    for (const ref of source.files)
        if (
            ["dependencies", "input-evidence"].includes(ref.path.split("/")[0]!) ||
            ref.sizeBytes > contentLimit(ref.path)
        )
            fail("PAYLOAD_PATH");
    for (const path of requiredSources)
        if (!source.files.some((ref) => ref.path === path)) fail("PAYLOAD_RECEIPT_MISMATCH");
    const lock = source.files.find((ref) => ref.path === "pnpm-lock.yaml")!;
    if (
        build.commit !== source.commit ||
        build.sourceBindingSha256 !== sha(canonicalBytes(source)) ||
        build.pnpmLockSha256 !== lock.sha256 ||
        build.target.platform !== "darwin" ||
        !["x64", "arm64"].includes(build.target.arch) ||
        !setEqual(build.toolNames, ["node", "pnpm"]) ||
        build.producer.path !== producer ||
        build.config.path !== "pnpm-workspace.yaml"
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
    for (const ref of [build.producer, build.config])
        if (
            !equal(
                source.files.find((file) => file.path === ref.path),
                ref,
            )
        )
            fail("PAYLOAD_RECEIPT_MISMATCH");
}

/**
 * 原始安装布局由既有 CI 观察器真实采集，再逐个读取它刚写出的有界片段并核对摘要；观察器记录完整安装事实，最终依赖树只选
 * 择真实消费者可达闭包，未选择的包不会因位于同一 node_modules 就获得运行时根身份。
 */
async function observeInstallation(
    installation: string,
    evidenceDir: string,
    source: SourceBindingV1,
    files: DependencyFiles,
) {
    const workspaceRoots = source.files
        .filter((ref) => /^(?:apps|packages)\/[^/]+\/package\.json$/.test(ref.path))
        .map((ref) => ({ path: dirname(ref.path), sourcePath: ref.path }));
    const layout = await collectLayoutMetadata({ root: installation, evidenceDir, workspaceRoots });
    const records: LayoutRecord[] = [];
    const artifacts: { path: string; bytes: Buffer }[] = [];
    for (const artifact of layout.artifacts) {
        const bytes = await files.read(join(evidenceDir, artifact.path), limits.json);
        if (bytes.length !== artifact.bytes || sha(bytes) !== artifact.sha256)
            fail("PAYLOAD_SOURCE_CHANGED");
        artifacts.push({ path: artifact.path, bytes });
        if (artifact.kind === "inventory") {
            const value = decode(bytes);
            if (!Array.isArray(value)) fail("PAYLOAD_TREE_MISMATCH");
            records.push(...(value as LayoutRecord[]));
        }
    }
    if (records.length > limits.entries * 3) fail("PAYLOAD_LIMIT");
    return { layout, records, artifacts };
}

/**
 * 消费者需求直接从已经完成的入口和执行树字节分析，并保留实际 Runtime 相对路径；独立 tsx 根显式加入，内建和相对边仍由已
 * 有分类器检查，不从包清单把所有 Runtime 声明误当成实际入口根。
 */
async function readConsumers(
    options: DependencyInputOptions["consumers"],
    signal: AbortSignal | undefined,
) {
    const reader = new InputReader(options.inputRoot, signal, [
        options.entries.root,
        options.execution.root,
    ]);
    await reader.initialize();
    const roots = [{ consumer: "package.json", specifier: "tsx" }];
    const members: { path: string; bytes: Buffer }[] = [];
    for (const [kind, tree] of [
        ["entry", options.entries],
        ["execution", options.execution],
    ] as const) {
        const inventory = await document<TreeInventory>(reader, tree.inventory, schemas.inventory);
        if (inventory.treeKind !== (kind === "entry" ? "entries" : "execution"))
            fail("PAYLOAD_TREE_MISMATCH");
        await reader.tree(tree, inventory, inventory.treeKind);
        reader.planScripts(
            tree,
            inventory.files.filter((file) => /\.(?:mjs|cjs|js)$/.test(file.path)),
        );
        for (const file of inventory.files) {
            const bytes = await reader.member(tree, file, contentLimit(file.path));
            members.push({ path: `${kind}/${file.path}`, bytes });
            if (!/\.(?:mjs|cjs|js)$/.test(file.path)) continue;
            for (const fact of scanRuntimeLiteralImports(bytes, file.path)) {
                const edge = classifyRuntimeModuleEdge(
                    fact,
                    file.path,
                    inventory.files,
                    kind === "execution",
                );
                if (edge.kind === "external")
                    roots.push({ consumer: `${kind}/${file.path}`, specifier: edge.specifier });
            }
        }
    }
    await reader.finish();
    return {
        reader,
        members,
        roots: [
            ...new Map(roots.map((root) => [`${root.consumer}:${root.specifier}`, root])).values(),
        ],
    };
}

/**
 * 包自有目录只从实际目录记录或真实生成文件父路径建立，嵌套 node_modules 由其它实例负责；父目录在最终完整库存中显式闭合
 * ，空目录也保留，不能只复制文件后忽略安装树的其它普通成员。
 */
function parents(path: string, directories: Set<string>) {
    for (let current = posix.dirname(path); current !== "."; current = posix.dirname(current))
        directories.add(current);
}

/**
 * 单个 bin 声明保持原始目标正文和包路径，字符串简写按 npm 无 scope 名称展开；命令 alias 在最终 runtime 中重新生成，所以
 * 原安装 shim 仅留原始布局证据，不复制成改变相对查找语义的伪造可执行正文
 * 。
 */
function binDeclarations(pkg: Record<string, unknown>) {
    if (pkg.bin === undefined) return [] as [string, string][];
    const raw =
        typeof pkg.bin === "string" ? { [String(pkg.name).split("/").pop()!]: pkg.bin } : pkg.bin;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("PAYLOAD_BIN_UNSUPPORTED");
    return Object.entries(raw).map(([name, target]) => {
        if (
            typeof target !== "string" ||
            !target ||
            target.startsWith("/") ||
            target.includes("\\") ||
            name.includes("/") ||
            name.toLowerCase() === "node"
        )
            fail("PAYLOAD_BIN_UNSUPPORTED");
        return [name, target] as [string, string];
    });
}

/**
 * 原安装域的 bin 目录只能映射到与包根相同的有限 Runtime 安装域，Desktop 或其它工作区的命令不得意外获得公共胜者身份；这
 * 里处理路径归属，不分析 exports 或执行任意安装脚本正文。
 */
function runtimeAliasPath(path: string): string | null {
    if (path.startsWith("node_modules/")) return path;
    if (path.startsWith("apps/runtime/node_modules/")) return path.slice("apps/runtime/".length);
    for (const name of ["contracts", "runner-sdk"])
        if (path.startsWith(`packages/${name}/node_modules/`))
            return `node_modules/@veriq/${name}/${path.slice(`packages/${name}/`.length)}`;
    return null;
}

/**
 * 依赖输入在调用者持有的单独 work 事务内生产，真正安装、编译、复制和目标解析完成后才进入回调；路径仅在这次所有权窗口内
 * 可消费，返回后继续核来源、工具、布局和视图，既不发布也不生成 Expected 或 ready。
 */
export async function withDependencyInputViews<T>(
    work: ArchiveTransaction,
    options: DependencyInputOptions,
    consume: (
        inputRoot: string,
        trees: Readonly<{ dependencies: BoundTree }>,
        generated: WorkspaceGenerationEvidence,
    ) => Promise<T>,
): Promise<T> {
    const metadata = freeze(
        structuredClone({
            source: options.source,
            dependencies: options.dependencies,
            consumers: options.consumers,
            targetNode: options.targetNode,
        }),
    );
    const host = Object.freeze({ ...options.hostBuild }),
        buildRoot = options.buildRoot;
    sourcePolicy(metadata.source, metadata.dependencies);
    if (!isNode24Version(metadata.targetNode.version)) fail("PAYLOAD_RECEIPT_MISMATCH");
    if (
        work.profile !== "work" ||
        work.committed ||
        typeof consume !== "function" ||
        typeof host.run !== "function" ||
        !Number.isSafeInteger(host.timeoutMs) ||
        host.timeoutMs < 1 ||
        host.timeoutMs > 16 * 60000
    )
        fail("PAYLOAD_INPUT_INVALID");
    await work.audit();
    if ((await readdir(join(work.scratch, "views"))).length) fail("PAYLOAD_PATH");
    await work.plan(limits.evidence, 1024);
    const finishRoot = await admitDependencyBuildRoot(work, buildRoot),
        files = new DependencyFiles();
    const installation = join(buildRoot, "installation"),
        generatedRoot = join(buildRoot, "generated"),
        resolutionRoot = join(buildRoot, "resolution");
    await mkdir(installation, { mode: 0o700 });
    await mkdir(generatedRoot, { mode: 0o700 });
    await mkdir(resolutionRoot, { mode: 0o700 });
    const source = new InputReader(work.inputRoot, work.signal, []);
    await source.initialize();
    for (const ref of metadata.source.files) {
        const bytes = await source.ref(ref, true, contentLimit(ref.path), false);
        await writeDependencySource(installation, ref.path, bytes);
    }
    // 新生产器和观察器必须同时匹配当前执行源码，不能只把一个自报 SourceBinding 复制到安装目录；模块 URL 固定相对当前生
    // 产器，调用者无法替换宿主代码路径选择另一份生成实现。
    for (const path of requiredSources.filter(
        (path) => path.endsWith(".ts") || path.endsWith(".mjs"),
    )) {
        const expected = metadata.source.files.find((ref) => ref.path === path)!;
        const url = path.startsWith(".github/")
            ? new URL(`../../../${path}`, import.meta.url)
            : new URL(path.slice("apps/runtime/scripts/".length), import.meta.url);
        const bytes = await files.read(fileURLToPath(url), contentLimit(path));
        if (bytes.length !== expected.sizeBytes || sha(bytes) !== expected.sha256)
            fail("PAYLOAD_SOURCE_CHANGED");
    }
    const toolFacts: { path: string; sizeBytes: number; sha256: string }[] = [];
    for (const tool of [host.executable, host.pnpmCli, metadata.targetNode.executable]) {
        if (!isAbsolute(tool)) fail("PAYLOAD_PATH");
        const fixed = await realpath(tool);
        toolFacts.push(await files.fact(fixed));
    }
    if (!isAbsolute(host.pnpmStore) || resolve(host.pnpmStore) !== host.pnpmStore)
        fail("PAYLOAD_PATH");
    for (let current = host.pnpmStore; ; current = dirname(current)) {
        if (!(await lstat(current)).isDirectory()) fail("PAYLOAD_PATH");
        if (current === dirname(current)) break;
    }
    const commands: CommandFact[] = [];
    const deadline = Date.now() + 32 * 60000;
    const run = async (executable: string, args: readonly string[], cwd = installation) => {
        work.check();
        const timeoutMs = Math.min(host.timeoutMs, deadline - Date.now());
        if (timeoutMs < 1) fail("PAYLOAD_LIMIT");
        const invocation = freeze({ executable, args: [...args], cwd, timeoutMs });
        const started = new Date().toISOString(),
            observed = await host.run(invocation),
            ended = new Date().toISOString();
        if (classifyCommandResult(observed) !== "PASS")
            throw new RuntimePayloadError(
                "PAYLOAD_IO",
                observed.error ?? "DEPENDENCY_HOST_COMMAND_FAILED",
                observed.closeConfirmed === true ? "NOT_NEEDED" : "INCOMPLETE",
            );
        if (
            !Buffer.isBuffer(observed.stdout) ||
            !Buffer.isBuffer(observed.stderr) ||
            observed.stdout.length > 65536 ||
            observed.stderr.length > limits.json ||
            !Number.isSafeInteger(observed.pid) ||
            observed.pid! <= 0
        )
            fail("PAYLOAD_INPUT_INVALID");
        const result = {
            ...observed,
            stdout: Buffer.from(observed.stdout),
            stderr: Buffer.from(observed.stderr),
        };
        const index = commands.length;
        const stdout = await writeDependencyView(
            work,
            `input-evidence/dependencies-command-${index}.stdout`,
            result.stdout,
        );
        const stderr = await writeDependencyView(
            work,
            `input-evidence/dependencies-command-${index}.stderr`,
            result.stderr,
        );
        const { stdout: _stdout, stderr: _stderr, ...observation } = result;
        commands.push({ invocation, started, ended, observation, stdout, stderr });
        return result;
    };
    const pnpmVersion = await run(host.executable, [host.pnpmCli, "--version"]);
    if (pnpmVersion.stdout.toString().trim() !== "11.25.0") fail("PAYLOAD_RECEIPT_MISMATCH");
    const lockRef = metadata.source.files.find((ref) => ref.path === "pnpm-lock.yaml")!;
    const originalLock = await source.ref(lockRef, true, limits.javascript, false);
    const lock = lockSections(originalLock);
    await run(host.executable, [
        host.pnpmCli,
        "--filter",
        "@veriq/runtime...",
        "install",
        "--frozen-lockfile",
        "--offline",
        "--ignore-scripts",
        "--prod",
        "--node-linker=hoisted",
        "--package-import-method=copy",
        "--store-dir",
        host.pnpmStore,
    ]);
    // 原始来源和锁在安装动作之后全部逐字复核，安装留下的元数据由独立观察器采集；生产生成包只写另一个目录，绝不会通过改
    // 原始 manifests 或锁文件使冻结安装看起来成功。
    for (const ref of metadata.source.files) {
        const bytes = await files.read(join(installation, ref.path), contentLimit(ref.path));
        if (bytes.length !== ref.sizeBytes || sha(bytes) !== ref.sha256)
            fail("PAYLOAD_SOURCE_CHANGED");
    }
    const observed = await observeInstallation(
        installation,
        join(buildRoot, "layout"),
        metadata.source,
        files,
    );
    for (const artifact of observed.artifacts)
        await writeDependencyView(
            work,
            `input-evidence/dependencies-layout/${artifact.path}`,
            artifact.bytes,
        );
    const layoutRef = await writeDependencyJson(
        work,
        "input-evidence/dependencies-layout.json",
        observed.layout,
    );
    const generated = await materializeRuntimeWorkspacePackages({
        sourceRoot: work.inputRoot,
        outputRoot: generatedRoot,
        source: metadata.source,
        files,
    });
    const consumers = await readConsumers(metadata.consumers, work.signal);
    const closure = await collectRuntimeDependencyClosure({
        installation,
        source: metadata.source,
        records: observed.records,
        generated: generated.packages,
        roots: consumers.roots,
        files,
        lock,
        arch: metadata.dependencies.target.arch,
    });
    const selected = new Set(
        closure.packages.filter((pkg) => !pkg.generated).map((pkg) => pkg.physicalRoot),
    );
    const selectedFiles = observed.records.filter(
        (record) =>
            record.kind === "file" &&
            selected.has(record.owner ?? "") &&
            !record.path
                .slice((record.owner?.length ?? 0) + 1)
                .split("/")
                .includes("node_modules"),
    );
    const generatedFiles = closure.packages.flatMap((pkg) => pkg.generated?.files ?? []);
    const dependencyBytes =
        selectedFiles.reduce((sum, record) => sum + record.bytes!, 0) +
        generatedFiles.reduce((sum, ref) => sum + ref.sizeBytes, 0);
    if (dependencyBytes > limits.total) fail("PAYLOAD_LIMIT");
    await work.plan(
        dependencyBytes +
            metadata.source.files.reduce((sum, ref) => sum + ref.sizeBytes, 0) +
            limits.evidence,
        selectedFiles.length + generatedFiles.length + metadata.source.files.length + 4096,
    );
    const directories = new Set<string>(),
        inventoryFiles: FileFact[] = [],
        instances: PackageInstance[] = [];
    const fileSources = new Map<string, string>();
    await work.mkdir("views/dependencies");
    for (const pkg of closure.packages) {
        await files.directory(join(installation, pkg.physicalRoot));
        if (pkg.generated) await files.directory(pkg.generated.generatedRoot);
        directories.add(pkg.root);
        parents(pkg.root, directories);
        const ownRecords = observed.records.filter(
            (record) =>
                record.owner === pkg.physicalRoot &&
                record.path.startsWith(pkg.physicalRoot + "/") &&
                !record.path
                    .slice(pkg.physicalRoot.length + 1)
                    .split("/")
                    .includes("node_modules"),
        );
        if (!pkg.generated && ownRecords.some((record) => record.kind === "link"))
            fail("PAYLOAD_GRAPH_MISMATCH");
        const ownFiles = pkg.generated
            ? pkg.generated.files.map((ref) => ({
                  path: ref.path,
                  source: join(pkg.generated!.generatedRoot, ref.path),
                  expected: ref,
              }))
            : ownRecords
                  .filter(
                      (record) =>
                          record.kind === "file" && !record.path.split("/").includes(".bin"),
                  )
                  .map((record) => ({
                      path: record.path.slice(pkg.physicalRoot.length + 1),
                      source: join(installation, record.path),
                      expected: {
                          path: record.path,
                          sizeBytes: record.bytes!,
                          sha256: record.sha256!,
                          mode: record.mode!,
                      },
                  }));
        for (const item of ownFiles) {
            const path = `${pkg.root}/${item.path}`;
            if (fileSources.has(path)) fail("PAYLOAD_COLLISION");
            fileSources.set(path, item.source);
            parents(path, directories);
            const ref = await copyDependencyView(
                work,
                files,
                item.source,
                `dependencies/${path}`,
                item.expected,
            );
            inventoryFiles.push({ ...ref, path, mode: ref.mode as FileFact["mode"] });
            await copyDependencySourceFile(resolutionRoot, path, item.source, files);
        }
        for (const record of ownRecords)
            if (
                !pkg.generated &&
                record.kind === "directory" &&
                !record.path.split("/").includes(".bin")
            ) {
                await files.directory(join(installation, record.path));
                const path = `${pkg.root}/${record.path.slice(pkg.physicalRoot.length + 1)}`;
                directories.add(path);
                parents(path, directories);
            }
        const own = inventoryFiles
            .filter(
                (file) =>
                    file.path.startsWith(pkg.root + "/") &&
                    !file.path
                        .slice(pkg.root.length + 1)
                        .split("/")
                        .includes("node_modules"),
            )
            .map((file) => ({ ...file, path: file.path.slice(pkg.root.length + 1) }))
            .sort((a, b) => (a.path < b.path ? -1 : 1));
        const ownDirectories = [...directories]
            .filter(
                (path) =>
                    path.startsWith(pkg.root + "/") &&
                    !path
                        .slice(pkg.root.length + 1)
                        .split("/")
                        .includes("node_modules"),
            )
            .map((path) => path.slice(pkg.root.length + 1))
            .sort();
        const manifest = own.find((file) => file.path === "package.json");
        if (!manifest) fail("PAYLOAD_GRAPH_MISMATCH");
        instances.push({
            ...pkg.instance,
            packageJson: { sizeBytes: manifest.sizeBytes, sha256: manifest.sha256 },
            ownTreeSha256: sha(canonicalBytes({ directories: ownDirectories, files: own })),
        });
    }
    for (const directory of [...directories].sort())
        await work.mkdir(`views/dependencies/${directory}`);
    for (const member of consumers.members)
        await writeDependencySource(resolutionRoot, member.path, member.bytes);
    await writeDependencySource(
        resolutionRoot,
        "package.json",
        canonicalBytes({ type: "module", dependencies: { tsx: "4.23.15" } }),
    );
    const bins: Bin[] = [],
        inventoryLinks: LinkFact[] = [];
    const aliasEvidence: unknown[] = [];
    for (const pkg of closure.packages)
        for (const [name, declaredTarget] of binDeclarations(pkg.manifest)) {
            const targetPath = posix.normalize(`${pkg.root}/${declaredTarget}`),
                target = inventoryFiles.find((file) => file.path === targetPath);
            if (
                !target ||
                !targetPath.startsWith(pkg.root + "/") ||
                targetPath
                    .slice(pkg.root.length + 1)
                    .split("/")
                    .includes("node_modules")
            )
                fail("PAYLOAD_BIN_UNSUPPORTED");
            const install = pkg.root.lastIndexOf("node_modules/"),
                aliasPath = `${pkg.root.slice(0, install)}node_modules/.bin/${name}`;
            if (bins.length >= limits.bins) fail("PAYLOAD_BIN_UNSUPPORTED");
            const bytes = await files.header(fileSources.get(targetPath)!),
                end = bytes.indexOf(10),
                header = bytes.subarray(0, end < 0 ? bytes.length : end).toString();
            const node =
                header === "#!/usr/bin/env node" ||
                header === "#!/usr/bin/node" ||
                (/\.(?:mjs|cjs|js)$/.test(targetPath) && !header.startsWith("#!"));
            let inspection: Ref | null = null;
            if (!node) {
                if (bytes.subarray(0, 2).toString() === "#!") fail("PAYLOAD_BIN_UNSUPPORTED");
                const arch = await run("/usr/bin/lipo", ["-archs", fileSources.get(targetPath)!]);
                const load = await run("/usr/bin/otool", ["-l", fileSources.get(targetPath)!]);
                const targetArch = metadata.dependencies.target.arch === "x64" ? "x86_64" : "arm64";
                if (arch.stdout.toString().trim() !== targetArch) fail("PAYLOAD_BIN_UNSUPPORTED");
                const text = load.stdout.toString(),
                    versions = [
                        ...text.matchAll(/^\s*(?:minos|version)\s+(\d+\.\d+(?:\.\d+)?)\s*$/gm),
                    ].map((row) => row[1]!);
                if (
                    versions.length !== 1 ||
                    Number(versions[0]!.split(".")[0]) > 15 ||
                    (Number(versions[0]!.split(".")[0]) === 15 &&
                        versions[0]!
                            .split(".")
                            .slice(1)
                            .some((part) => Number(part) !== 0))
                )
                    fail("PAYLOAD_BIN_UNSUPPORTED");
                const raw = await writeDependencyJson(
                    work,
                    `input-evidence/dependencies-native-bin-${bins.length}-commands.json`,
                    {
                        path: targetPath,
                        sha256: target.sha256,
                        commands: commands.slice(-2),
                    },
                );
                const record: NativeBinInspection = {
                    schemaVersion: 1,
                    kind: "NATIVE_BIN_INSPECTION",
                    platform: "darwin",
                    arch: metadata.dependencies.target.arch,
                    path: targetPath,
                    sha256: target.sha256,
                    minimumOs: versions[0]!,
                    inspectionEvidence: raw,
                };
                inspection = await writeDependencyJson(
                    work,
                    `input-evidence/dependencies-native-bin-${bins.length}.json`,
                    record,
                );
            }
            bins.push({
                owner: pkg.id,
                name,
                aliasPath,
                sourceAlias: null,
                targetPath,
                targetSha256: target.sha256,
                launcher: node ? "node" : "native",
                inspection,
            });
        }
    // 公共 alias 的胜者必须来自持有的真实安装链接或固定 pnpm shim 的 exec 目标，不能按包遍历顺序选一个覆盖其它声明；其
    // 余命令保留完整正文并使用 owner 摘要派生的私有命名空间，使每个声明都有唯一可检查的启
    // 动路径。
    const aliasGroups = new Map<string, Bin[]>();
    for (const bin of bins)
        aliasGroups.set(bin.aliasPath, [...(aliasGroups.get(bin.aliasPath) ?? []), bin]);
    for (const [alias, group] of aliasGroups) {
        const sourcePaths = observed.records
            .filter(
                (record) =>
                    (record.kind === "file" || record.kind === "link") &&
                    runtimeAliasPath(record.path) === alias,
            )
            .map((record) => record.path)
            .sort();
        const actualTargets = new Set<string>();
        for (const sourcePath of sourcePaths) {
            const record = observed.records.find(
                (entry) =>
                    entry.path === sourcePath && (entry.kind === "file" || entry.kind === "link"),
            );
            if (!record) continue;
            if (record.kind === "link") {
                if (!record.target || posix.isAbsolute(record.target))
                    fail("PAYLOAD_BIN_UNSUPPORTED");
                actualTargets.add(
                    posix.normalize(posix.join(posix.dirname(sourcePath), record.target)),
                );
            } else {
                const bytes = await files.read(join(installation, sourcePath), limits.javascript);
                if (record.bytes !== bytes.length || record.sha256 !== sha(bytes))
                    fail("PAYLOAD_SOURCE_CHANGED");
                const lines = bytes
                    .toString()
                    .split("\n")
                    .filter((line) => /^\s*exec\s/.test(line));
                if (!lines.length) unsupportedDependency("DEPENDENCY_BIN_SHIM_UNSUPPORTED");
                for (const line of lines) {
                    const node =
                        /^\s*exec\s+(?:"\$basedir\/node"|node)\s+"\$basedir\/([^"\r\n]+)"\s+"\$@"\s*$/.exec(
                            line,
                        );
                    const native = /^\s*exec\s+"\$basedir\/([^"\r\n]+)"\s+"\$@"\s*$/.exec(line);
                    const target = node?.[1] ?? native?.[1];
                    if (!target) unsupportedDependency("DEPENDENCY_BIN_SHIM_UNSUPPORTED");
                    actualTargets.add(
                        posix.normalize(posix.join(posix.dirname(sourcePath), target)),
                    );
                }
            }
        }
        const winners = group.filter((bin) => {
            const pkg = closure.packages.find((item) => item.id === bin.owner)!;
            return actualTargets.has(
                `${pkg.physicalRoot}/${bin.targetPath.slice(pkg.root.length + 1)}`,
            );
        });
        if (winners.length !== 1 || actualTargets.size !== 1)
            unsupportedDependency("DEPENDENCY_BIN_WINNER_ABSENT_OR_AMBIGUOUS");
        const winner = winners[0]!,
            originalAlias = sourcePaths[0]!;
        const originalRecord = observed.records.find((record) => record.path === originalAlias)!;
        (winner as { sourceAlias: string | null }).sourceAlias = alias;
        parents(alias, directories);
        if (originalRecord.kind === "link") {
            inventoryLinks.push({
                path: alias,
                target: posix.relative(posix.dirname(alias), winner.targetPath),
            });
        } else {
            const copied = await copyDependencyView(
                work,
                files,
                join(installation, originalAlias),
                `dependencies/${alias}`,
                {
                    path: originalAlias,
                    sizeBytes: originalRecord.bytes!,
                    sha256: originalRecord.sha256!,
                },
            );
            inventoryFiles.push({ ...copied, path: alias, mode: copied.mode as FileFact["mode"] });
        }
        aliasEvidence.push({
            alias,
            winner: winner.owner,
            originalAlias,
            originalTarget: originalRecord.target ?? null,
            targetPath: winner.targetPath,
            targetSha256: winner.targetSha256,
            candidates: group.map((bin) => bin.owner),
        });
        for (const bin of group)
            if (bin !== winners[0])
                (bin as { aliasPath: string }).aliasPath =
                    `${posix.dirname(alias)}/.veriq/${sha(Buffer.from(bin.owner))}/${bin.name}`;
    }
    for (const directory of [...directories].sort())
        await work.mkdir(`views/dependencies/${directory}`);
    await work.createDependencyInputLinks(bins, inventoryLinks);
    const requests = [
        ...closure.rootBindings.map((binding) => ({
            consumer: binding.consumer,
            specifier: binding.specifier,
        })),
        ...closure.edges.map((edge) => ({
            consumer: `${instances.find((pkg) => pkg.id === edge.from)!.root}/package.json`,
            specifier: edge.alias,
        })),
    ];
    const baseRequests = [
        ...new Map(
            requests.map((request) => [`${request.consumer}:${request.specifier}`, request]),
        ).values(),
    ];
    const witnesses = new Map<string, string[]>();
    for (const edge of closure.edges) {
        if (edge.to === null) continue;
        const target = closure.packages.find((pkg) => pkg.id === edge.to)!;
        const consumer = `${instances.find((pkg) => pkg.id === edge.from)!.root}/package.json`;
        const ownBins = inventoryFiles
            .filter((file) => file.path.startsWith(`${target.root}/bin/`))
            .map((file) => file.path.slice(target.root.length + 1))
            .slice(0, 32);
        const declaredBins = binDeclarations(target.manifest).map(([, path]) =>
            posix.normalize(path),
        );
        const specifiers = [
            ...new Set([
                edge.alias,
                ...declaredBins.map((path) => `${edge.alias}/${path}`),
                ...ownBins.map((path) => `${edge.alias}/${path}`),
                `${edge.alias}/package.json`,
            ]),
        ];
        witnesses.set(`${consumer}:${edge.alias}`, specifiers);
        for (const specifier of specifiers) requests.push({ consumer, specifier });
    }
    const uniqueRequests = [
        ...new Map(
            requests.map((request) => [`${request.consumer}:${request.specifier}`, request]),
        ).values(),
    ];
    if (uniqueRequests.length > limits.edges) fail("PAYLOAD_LIMIT");
    await writeDependencySource(
        buildRoot,
        "resolver-requests.json",
        canonicalBytes(uniqueRequests),
    );
    const resolverPath = join(installation, "apps/runtime/scripts/runtime-dependency-resolver.mjs");
    const resolverResultPath = join(buildRoot, "resolver-result.json");
    const actualResolution = await run(
        metadata.targetNode.executable,
        [
            "--experimental-import-meta-resolve",
            resolverPath,
            resolutionRoot,
            join(buildRoot, "resolver-requests.json"),
            resolverResultPath,
        ],
        resolutionRoot,
    );
    const resolverDigest = decode(actualResolution.stdout) as { sizeBytes: number; sha256: string };
    const resolverBytes = await files.read(resolverResultPath, limits.json);
    if (
        resolverDigest.sizeBytes !== resolverBytes.length ||
        resolverDigest.sha256 !== sha(resolverBytes)
    )
        fail("PAYLOAD_GRAPH_MISMATCH");
    const resolved = decode(resolverBytes) as {
        nodeVersion: string;
        electronVersion: string | null;
        executableSha256: string;
        platform: string;
        arch: string;
        resolutions: ResolverRow[];
    };
    if (
        resolved.electronVersion !== null ||
        resolved.nodeVersion !== metadata.targetNode.version ||
        resolved.executableSha256 !== metadata.targetNode.artifactSha256 ||
        resolved.platform !== "darwin" ||
        resolved.arch !== metadata.dependencies.target.arch ||
        !Array.isArray(resolved.resolutions) ||
        resolved.resolutions.length !== uniqueRequests.length
    )
        fail("PAYLOAD_GRAPH_MISMATCH");
    const owner = (path: string) =>
        instances
            .filter((pkg) => path.startsWith(pkg.root + "/"))
            .sort((a, b) => b.root.length - a.root.length)
            .find(
                (pkg) =>
                    !path
                        .slice(pkg.root.length + 1)
                        .split("/")
                        .includes("node_modules"),
            );
    const resolutions: Resolution[] = [];
    for (const request of baseRequests) {
        const candidates = witnesses.get(`${request.consumer}:${request.specifier}`) ?? [
            request.specifier,
        ];
        const rows = candidates.map((specifier) => {
            const matching = resolved.resolutions.filter(
                (row) => row.consumer === request.consumer && row.specifier === specifier,
            );
            if (matching.length !== 1) fail("PAYLOAD_GRAPH_MISMATCH");
            return matching[0]!;
        });
        // 部分真实平台包只有 bin/esbuild 这样的子路径而没有可导入的包根，优先使用实际 bin 再回退可导出的 package.json；
        // 所有候选都交给真实 Node，不能自己解释 exports 或把文件存在等同于
        // 已解析成功。
        const row =
            rows.find(
                (candidate) => candidate.import.path !== null || candidate.require.path !== null,
            ) ?? rows[0]!;
        const choices = [row.import.path, row.require.path].filter(
            (path): path is string => path !== null,
        );
        const from =
            owner(request.consumer)?.id ??
            (request.consumer === "package.json"
                ? "$root"
                : request.consumer.startsWith("entry/")
                  ? "$entry"
                  : "$execution");
        const edge = closure.edges.find(
            (item) => item.from === from && item.alias === request.specifier,
        );
        const binding = closure.rootBindings.find(
            (item) => item.consumer === request.consumer && item.specifier === request.specifier,
        );
        const expected = edge?.to ?? binding?.to ?? null;
        if (expected === null) {
            if (choices.length) fail("PAYLOAD_GRAPH_MISMATCH");
            continue;
        }
        if (new Set(choices.map((path) => owner(path)?.id)).size > 1)
            unsupportedDependency("DEPENDENCY_CONDITIONAL_INSTANCE_SPLIT");
        if (
            !choices.length ||
            choices.some(
                (path) =>
                    owner(path)?.id !== expected ||
                    !inventoryFiles.some((file) => file.path === path),
            )
        )
            fail("PAYLOAD_GRAPH_MISMATCH");
        resolutions.push({
            from,
            consumer: request.consumer,
            specifier: row.specifier,
            resolvedFile: choices[0]!,
            to: expected,
        });
    }
    const proofEvidence = await writeDependencyJson(
        work,
        "input-evidence/dependencies-resolver.json",
        { requests: uniqueRequests, actual: resolved, command: commands[commands.length - 1] },
    );
    const graph: DependencyGraph = {
        instances,
        edges: closure.edges,
        rootBindings: closure.rootBindings,
        bins,
        resolutionProof: {
            method: "NODE_RESOLVE",
            nodeVersion: resolved.nodeVersion,
            nodeExecutableSha256: resolved.executableSha256,
            target: metadata.dependencies.target,
            resolutions,
            evidence: proofEvidence,
        },
    };
    const inventory: TreeInventory = checked(
        {
            schemaVersion: 1,
            kind: "PAYLOAD_INPUT_TREE",
            treeKind: "dependencies",
            directories: [...directories].sort(),
            files: inventoryFiles.sort((a, b) => (a.path < b.path ? -1 : 1)),
            links: inventoryLinks,
        },
        schemas.inventory,
    );
    paths(
        [
            ...inventory.directories,
            ...inventory.files.map((file) => file.path),
            ...inventory.links.map((link) => link.path),
        ],
        inventory.directories,
    );
    const inventoryRef = await writeDependencyJson(
        work,
        "input-evidence/dependencies-inventory.json",
        inventory,
    );
    const optionalDecisions: DependenciesReceipt["optionalDecisions"][number][] = [];
    for (const [index, decision] of closure.decisions.entries()) {
        const { detail, ...fact } = decision;
        optionalDecisions.push({
            ...fact,
            evidence: await writeDependencyJson(
                work,
                `input-evidence/dependencies-optional-${index}.json`,
                {
                    ...decision,
                    resolverEvidence: proofEvidence,
                    layoutEvidence: layoutRef,
                    sourceLock: lockRef,
                },
            ),
        });
    }
    const sourceBinding = await writeDependencyJson(
        work,
        "input-evidence/dependencies-source-binding.json",
        metadata.source,
    );
    for (const ref of metadata.source.files)
        await copyDependencyView(work, files, join(work.inputRoot, ref.path), ref.path, ref);
    const generationRef = await writeDependencyJson(
        work,
        "input-evidence/dependencies-workspace-generation.json",
        generated,
    );
    const commandEvidence = await writeDependencyJson(
        work,
        "input-evidence/dependencies-command.json",
        {
            schemaVersion: 1,
            kind: "DEPENDENCIES_PRODUCTION_COMMANDS",
            commands,
            toolFacts,
            sourceBinding,
            layout: layoutRef,
            generation: generationRef,
            resolution: proofEvidence,
            aliases: aliasEvidence,
            sourceLockSha256: sha(originalLock),
            lockAfterSha256: sha(
                await files.read(join(installation, "pnpm-lock.yaml"), limits.javascript),
            ),
            aliasPolicy:
                "Actual public alias winner retained; other declared commands use owner SHA256 private aliases; all " +
                "target bodies remain unchanged",
        },
    );
    const receipt: DependenciesReceipt = checked(
        {
            schemaVersion: 1,
            kind: "PRODUCTION_DEPENDENCIES",
            build: { ...metadata.dependencies, commandEvidence },
            treeInventorySha256: inventoryRef.sha256,
            graph,
            linker: {
                name: "pnpm",
                version: "11.25.0",
                mode: "hoisted",
                sourceLockSha256: lockRef.sha256,
                lockAfterSha256: lockRef.sha256,
                ignoreScripts: true,
                offline: true,
                frozenLockfile: true,
            },
            optionalDecisions,
        },
        schemas.dependencies,
    );
    const tree: BoundTree = {
        root: "dependencies",
        inventory: inventoryRef,
        buildReceipt: await writeDependencyJson(
            work,
            "input-evidence/dependencies-receipt.json",
            receipt,
        ),
    };
    const viewRoot = join(work.scratch, "views"),
        view = new InputReader(viewRoot, work.signal, ["dependencies"]);
    await view.initialize();
    await view.tree(tree, inventory, "dependencies");
    await verifyPackageContents(graph, inventory, tree, view);
    await view.ref(commandEvidence);
    await view.ref(proofEvidence);
    for (const decision of optionalDecisions) await view.ref(decision.evidence);
    const finish = async () => {
        await source.finish();
        await consumers.reader.finish();
        await files.finish();
        await view.finish();
        await finishRoot();
        await work.audit();
    };
    await finish();
    const value = await consume(viewRoot, freeze({ dependencies: tree }), generated);
    await finish();
    return value;
}
