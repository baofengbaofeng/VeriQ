import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { finished as finishedStream } from "node:stream/promises";
import { canonicalBytes } from "@veriq/contracts";
import { ArchiveTransaction } from "./runtime-payload-transaction.ts";
import {
    InputReader,
    contentLimit,
    decode,
    fail,
    freeze,
    io,
    limits,
    paths,
    relative,
    sha,
} from "./runtime-payload-tree.ts";
import { checked, document, equal, schemas, setEqual } from "./runtime-payload-receipts.ts";
import { assetBytes, writeAssetJson } from "./runtime-assets-observation.ts";
import { scanRuntimeLiteralImports, classifyRuntimeModuleEdge } from "./runtime-payload-graph.ts";
import {
    RuntimePayloadError,
    type BoundTree,
    type Build,
    type EntriesReceipt,
    type ExecutionReceipt,
    type FileFact,
    type Ref,
    type SourceBindingV1,
    type TreeInventory,
} from "./runtime-payload-inputs.ts";

/**
 * 宿主动作只接收已固定的真实命令参数，调用者应原样交给既有 runBoundedAssetCli，不能通过这个接口取得任意事务写入权；开始
 * 与结束时刻由生产器在实际调用边界记录而不是预先声明成功。
 */
export type HostBuildInvocation = Readonly<{
    executable: string;
    args: readonly string[];
    cwd: string;
    timeoutMs: number;
}>;
/**
 * 观察保留既有有界进程管理器的全部结算事实和原始输出，关闭未知、信号、错误、超时或截断都不能成为成功；直接子进程的
 * close 不代表任意后代清空，调用者仍拥有实际子进程与构建目录生命周期。
 */
export type HostBuildObservation = Readonly<{
    stdout: Buffer;
    stderr: Buffer;
    exit: number | null;
    signal: string | null;
    timedOut: boolean;
    truncated: boolean;
    closeConfirmed: boolean;
    admitted: boolean;
    pid: number | null;
    error: string | null;
}>;
/**
 * 输入沿用现有来源和构建字段，独立空目录由调用者持有且不能位于源码或事务内；动作身份与所有元数据会在首次等待前复制，宿
 * 主工具仅用于本地构建，Darwin 目标声明绝不冒充本机平台事实。
 */
export type EntryInputOptions = Readonly<{
    source: SourceBindingV1;
    entries: Omit<Build, "commandEvidence">;
    execution: Omit<Build, "commandEvidence">;
    buildRoot: string;
    hostBuild: Readonly<{
        executable: string;
        viteCli: string;
        timeoutMs: number;
        run: (invocation: HostBuildInvocation) => Promise<HostBuildObservation>;
    }>;
}>;

const producerPath = "apps/runtime/scripts/runtime-payload-entries.ts",
    configPath = "apps/runtime/runtime.vite.config.mjs",
    tracePath = ".veriq-entry-trace.json",
    executionNames = [
        "worker",
        "provider",
        "compile-entry",
        "archive",
        "controlled-command",
        "controlled-child",
        "controlled-child-protocol",
        "controlled-child-preload",
    ].map((name) => `${name}.mjs`);
type Output = {
    path: string;
    kind: "entry" | "chunk" | "asset";
    sizeBytes: number;
    sha256: string;
};
type Observation = { sources: string[]; outputs: Output[] };

/**
 * 固定前缀只在事务引用转换为消费者引用时移除一次，长度与摘要完全保留；原始来源路径因此仍与 SourceBinding 一致，不能把树
 * 内文件或错误根目录的六百权限副本包装成合格的证据引用。
 */
function consumerRef(ref: Ref): Ref {
    if (!ref.path.startsWith("views/")) fail("PAYLOAD_PATH");
    return { ...ref, path: ref.path.slice("views/".length) };
}

/**
 * held 文件比较记录 inode、设备、权限、链接数、长度和纳秒时间，复制前后都要匹配；这里仅检测实际观察到的变化，不宣称普通
 * JavaScript 能阻止恶意同用户在两个观察边界之间替换父目录。
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
 * 来源和结算后的输出统一经单链接普通文件描述符流入现有事务，预期来源继续交给 write 核大小和摘要；每块大小沿用系统流限额
 * ，关闭失败保留首错并登记在事务上，避免错误的安全清理声明。
 */
async function copyFile(work: ArchiveTransaction, full: string, destination: string, expected?: Ref) {
    const before = await lstat(full, { bigint: true });
    if (
        !before.isFile() ||
        before.nlink !== 1n ||
        ![0o400, 0o600, 0o444, 0o644].includes(Number(before.mode & 0o7777n))
    )
        fail("PAYLOAD_TREE_MISMATCH");
    if (before.size > BigInt(contentLimit(destination))) fail("PAYLOAD_LIMIT");
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let primary: unknown;
    let closeError: unknown;
    let result: Ref;
    try {
        if (!same(before, await handle.stat({ bigint: true }))) fail("PAYLOAD_SOURCE_CHANGED");
        const stream = handle.createReadStream({
            autoClose: false,
            highWaterMark: 64 * 1024,
            signal: work.signal,
        });
        const closed = finishedStream(stream);
        closed.catch(() => {});
        try {
            const ref = await work.write(destination, stream, expected);
            await closed;
            if (
                !same(before, await handle.stat({ bigint: true })) ||
                !same(before, await lstat(full, { bigint: true }))
            )
                fail("PAYLOAD_SOURCE_CHANGED");
            result = consumerRef(ref);
        } finally {
            if (!stream.readableEnded) stream.destroy();
            await closed.catch(() => {});
        }
    } catch (error) {
        primary = error;
        throw error;
    } finally {
        try {
            await handle.close();
        } catch (error) {
            work.noteCloseFailure();
            if (!primary) closeError = error;
        }
    }
    if (closeError !== undefined) throw closeError;
    return result;
}

/**
 * 构建目录只接受真实绝对路径与固定七百权限，首次准入必须为空并与源码和整个事务父根互不覆盖；初始化 reader 复用逐级无链
 * 接检查，结算后只比较同一根身份而允许已授权的 Vite 新增内容。
 */
async function admitBuildRoot(work: ArchiveTransaction, root: string) {
    if (!isAbsolute(root) || resolve(root) !== root) fail("PAYLOAD_PATH");
    for (const other of [work.inputRoot, work.outputParent]) {
        const fixed = resolve(other);
        if (root === fixed || root.startsWith(fixed + "/") || fixed.startsWith(root + "/")) fail("PAYLOAD_PATH");
    }
    const reader = new InputReader(root, work.signal, []);
    await reader.initialize();
    const info = await lstat(root, { bigint: true });
    if (Number(info.mode & 0o7777n) !== 0o700) fail("PAYLOAD_PATH");
    const directory = await opendir(root);
    try {
        if (await directory.read()) fail("PAYLOAD_PATH");
    } finally {
        await directory.close();
    }
    await reader.finish();
    return info;
}

/**
 * 来源文件必须全部保持原路径，不能占用两树或元数据前缀；完整来源声明先按固定内容与总额预算准入，生产和配置引用只允许相
 * 同 SourceBinding 中的真实引用，不从自报名称推导信任。
 */
function sourcePolicy(
    source: SourceBindingV1,
    entries: Omit<Build, "commandEvidence">,
    execution: Omit<Build, "commandEvidence">,
) {
    checked(source, schemas.source);
    paths(source.files.map((file) => file.path));
    let bytes = 0;
    for (const ref of source.files) {
        if (["entries", "execution", "input-evidence"].includes(ref.path.split("/")[0]!.toLowerCase()))
            fail("PAYLOAD_PATH");
        if (ref.sizeBytes > contentLimit(ref.path)) fail("PAYLOAD_LIMIT");
        bytes += ref.sizeBytes;
    }
    if (source.files.length > limits.entries || bytes > limits.total) fail("PAYLOAD_LIMIT");
    const sourceBytes = canonicalBytes(source);
    if (sourceBytes.length > limits.json) fail("PAYLOAD_LIMIT");
    const binding = sha(sourceBytes),
        lock = source.files.find((ref) => ref.path === "pnpm-lock.yaml");
    for (const build of [entries, execution]) {
        if (
            !lock ||
            build.commit !== source.commit ||
            build.sourceBindingSha256 !== binding ||
            build.pnpmLockSha256 !== lock.sha256 ||
            build.target.platform !== "darwin" ||
            !["arm64", "x64"].includes(build.target.arch)
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
    if (
        !equal(entries.target, execution.target) ||
        !setEqual(entries.toolNames, ["node", "vite"]) ||
        !setEqual(execution.toolNames, ["node"]) ||
        entries.producer.path !== producerPath ||
        entries.config.path !== configPath ||
        execution.producer.path !== producerPath ||
        execution.config.path !== producerPath
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
    for (const path of [
        "apps/desktop/src/agent/index.ts",
        "apps/runtime/src/cli.ts",
        "apps/desktop/package.json",
        ...executionNames.map((name) => `apps/runtime/src/execution/${name}`),
    ])
        if (!source.files.some((file) => file.path === path)) fail("PAYLOAD_RECEIPT_MISMATCH");
}

/**
 * 内部 trace 的字段集合和输出角色严格有界，不能因它不是公共收据就接受额外协议字段、重复路径或路径逃逸；来源列表只是待交
 * 叉核验的真实模块观察，稍后还要逐项匹配已持有来源及工作区清单。
 */
function observation(value: unknown): Observation {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "outputs,sources"
    )
        fail("PAYLOAD_INPUT_INVALID");
    const trace = value as Observation;
    if (
        !Array.isArray(trace.sources) ||
        !Array.isArray(trace.outputs) ||
        trace.sources.length > limits.entries ||
        trace.outputs.length > limits.entries
    )
        fail("PAYLOAD_LIMIT");
    for (const source of trace.sources) relative(source);
    paths(trace.sources);
    for (const output of trace.outputs) {
        if (
            !output ||
            Object.keys(output).sort().join(",") !== "kind,path,sha256,sizeBytes" ||
            !["entry", "chunk", "asset"].includes(output.kind) ||
            !Number.isSafeInteger(output.sizeBytes) ||
            output.sizeBytes < 0 ||
            !/^[a-f0-9]{64}$/.test(output.sha256)
        )
            fail("PAYLOAD_INPUT_INVALID");
        relative(output.path);
        if (output.path === tracePath) fail("PAYLOAD_COLLISION");
    }
    paths(trace.outputs.map((output) => output.path));
    if (
        !setEqual(
            trace.outputs.filter((output) => output.kind === "entry").map((output) => output.path),
            ["agent.js", "cli.js"],
        )
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
    return trace;
}

/**
 * 结算后的实际文件系统必须与 Rollup 观察完全对应，普通目录也逐个列入库存且不接受额外空目录；扫描只在已确认成功关闭后运
 * 行，链接、硬链接、特殊文件与危险权限不能通过归一化后复制混入树。
 */
async function outputFiles(work: ArchiveTransaction, root: string, trace: Observation) {
    const files: string[] = [],
        directories: string[] = [];
    const observations = new Map<string, BigIntStats>();
    let bytes = 0,
        count = 0;
    const walk = async (path: string): Promise<void> => {
        work.check();
        if (++count > limits.entries) fail("PAYLOAD_LIMIT");
        if (path) relative(path);
        const full = join(root, path),
            info = await lstat(full, { bigint: true });
        observations.set(full, info);
        if (info.isDirectory()) {
            if (path && ![0o700, 0o755, 0o555].includes(Number(info.mode & 0o7777n))) fail("PAYLOAD_TREE_MISMATCH");
            if (path) directories.push(path);
            const directory = await opendir(full);
            for await (const entry of directory) await walk(path ? `${path}/${entry.name}` : entry.name);
        } else {
            if (
                !info.isFile() ||
                info.nlink !== 1n ||
                ![0o400, 0o600, 0o444, 0o644].includes(Number(info.mode & 0o7777n))
            )
                fail("PAYLOAD_TREE_MISMATCH");
            if (info.size > BigInt(contentLimit(path))) fail("PAYLOAD_LIMIT");
            bytes += Number(info.size);
            if (bytes > limits.total) fail("PAYLOAD_LIMIT");
            files.push(path);
        }
    };
    await walk("");
    paths([...directories, ...files], directories);
    if (!setEqual(files, [tracePath, ...trace.outputs.map((output) => output.path)])) fail("PAYLOAD_TREE_MISMATCH");
    const parents = new Set<string>();
    for (const file of files)
        for (let parent = dirname(file); parent !== "."; parent = dirname(parent)) parents.add(parent);
    if (!setEqual(directories, [...parents])) fail("PAYLOAD_TREE_MISMATCH");
    const finish = async () => {
        for (const [path, before] of observations)
            if (!same(before, await lstat(path, { bigint: true }))) fail("PAYLOAD_SOURCE_CHANGED");
    };
    return { directories: directories.sort(), finish };
}

/**
 * 工具文件通过持有的真实安装文件描述符流式核身份与字节，Vite CLI、实际 Node 模块及包清单都单独绑定；允许 pnpm 已安装工
 * 具的硬链接与私有权限，但不把这种宿主资格提升为载荷规则或传递依赖认证。
 */
async function hostTools(work: ArchiveTransaction, source: SourceBindingV1, host: EntryInputOptions["hostBuild"]) {
    if (
        !Number.isSafeInteger(host.timeoutMs) ||
        host.timeoutMs <= 0 ||
        host.timeoutMs > 16 * 60000 ||
        typeof host.run !== "function"
    )
        fail("PAYLOAD_INPUT_INVALID");
    const executable = await realpath(host.executable),
        nodePath = await realpath(process.execPath),
        cli = await realpath(host.viteCli);
    if (executable !== nodePath || host.viteCli !== join(work.inputRoot, "apps/desktop/node_modules/vite/bin/vite.js"))
        fail("PAYLOAD_RECEIPT_MISMATCH");
    const observations = new Map<string, BigIntStats>();
    const read = async (full: string, collect: boolean) => {
        const fixed = await realpath(full);
        const info = await lstat(fixed, { bigint: true });
        if (
            !info.isFile() ||
            info.nlink < 1n ||
            ![0o400, 0o600, 0o444, 0o644, 0o555, 0o755].includes(Number(info.mode & 0o7777n)) ||
            info.size > BigInt(collect ? limits.package : limits.file)
        )
            fail("PAYLOAD_LIMIT");
        // 宿主 Node 通常大于普通脚本预算，实际身份读取采用固定文件上限且流式计算摘要；工具本身不是来源快照，不复制到输
        // 入视图，避免把本机可执行文件冒充发行载荷。
        const handle = await open(fixed, constants.O_RDONLY | constants.O_NOFOLLOW);
        const digest = createHash("sha256"),
            chunks: Buffer[] = [];
        let count = 0;
        try {
            if (!same(info, await handle.stat({ bigint: true }))) fail("PAYLOAD_SOURCE_CHANGED");
            for await (const chunk of handle.createReadStream({
                autoClose: false,
                highWaterMark: 64 * 1024,
            })) {
                work.check();
                count += chunk.length;
                if (count > Number(info.size)) fail("PAYLOAD_SOURCE_CHANGED");
                digest.update(chunk);
                if (collect) chunks.push(chunk);
            }
            if (
                count !== Number(info.size) ||
                !same(info, await handle.stat({ bigint: true })) ||
                !same(info, await lstat(fixed, { bigint: true }))
            )
                fail("PAYLOAD_SOURCE_CHANGED");
        } finally {
            await handle.close();
        }
        observations.set(fixed, info);
        return {
            identity: {
                path: fixed,
                sizeBytes: count,
                sha256: digest.digest("hex"),
                mode: Number(info.mode & 0o7777n),
                links: Number(info.nlink),
            },
            bytes: collect ? Buffer.concat(chunks) : Buffer.alloc(0),
        };
    };
    const node = await read(executable, false),
        vite = await read(cli, false),
        packageFile = await read(resolve(dirname(cli), "../package.json"), true),
        module = await read(resolve(dirname(cli), "../dist/node/index.js"), false);
    const pkg = decode(packageFile.bytes) as { name?: unknown; version?: unknown };
    const declaredRef = source.files.find((ref) => ref.path === "apps/desktop/package.json")!;
    const sourceReader = new InputReader(work.inputRoot, work.signal, []);
    await sourceReader.initialize();
    const declared = decode(await sourceReader.ref(declaredRef, true)) as {
        devDependencies?: Record<string, unknown>;
    };
    if (pkg.name !== "vite" || typeof pkg.version !== "string" || declared.devDependencies?.vite !== pkg.version)
        fail("PAYLOAD_RECEIPT_MISMATCH");
    const finish = async () => {
        await sourceReader.finish();
        for (const [path, before] of observations)
            if (!same(before, await lstat(path, { bigint: true }))) fail("PAYLOAD_SOURCE_CHANGED");
    };
    return {
        finish,
        executable,
        cli,
        tools: [
            { name: "node", version: process.version, files: [node.identity] },
            {
                name: "vite",
                version: pkg.version,
                files: [vite.identity, module.identity, packageFile.identity],
            },
        ],
    };
}

/**
 * 工作区归属从真实已解析模块寻找最近物理清单并要求同路径的绑定引用，不能从绑定列表挑更远诱饵；名称和版本只从该清单原始
 * 字节读出，所有模块仍须属于受控来源，JSON 与转译前 TypeScript 同样记录。
 */
async function embedded(
    source: SourceBindingV1,
    reader: InputReader,
    trace: Observation,
): Promise<EntriesReceipt["embeddedWorkspaces"]> {
    const refs = new Map(source.files.map((ref) => [ref.path, ref])),
        groups = new Map<string, { name: string; version: string; sourcePaths: string[] }>();
    for (const path of trace.sources) {
        if (!refs.has(path) || path.split("/").includes("node_modules")) fail("PAYLOAD_RECEIPT_MISMATCH");
        await reader.ref(refs.get(path)!, false, contentLimit(path), false);
        let manifest: Ref | undefined;
        // 清单存在性由真实来源目录决定，存在但未绑定的最近清单必须立即拒绝而不能回退；上面的模块读取已观察所有父目录，
        // 后来增删更近清单也会在这些目录的身份收尾被发现，避免只核被选清单的字节。
        for (let parent = dirname(path); ; parent = dirname(parent)) {
            const candidate = parent === "." ? "package.json" : `${parent}/package.json`;
            let present = false;
            try {
                await lstat(join(reader.root, candidate));
                present = true;
            } catch (error) {
                if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) io(error);
            }
            if (present) {
                manifest = refs.get(candidate);
                if (!manifest) fail("PAYLOAD_RECEIPT_MISMATCH");
                break;
            }
            if (parent === ".") break;
        }
        if (!manifest) fail("PAYLOAD_RECEIPT_MISMATCH");
        const pkg = decode(await reader.ref(manifest, true, limits.package, false)) as {
            name?: unknown;
            version?: unknown;
        };
        if (typeof pkg.name !== "string") fail("PAYLOAD_RECEIPT_MISMATCH");
        if (!pkg.name.startsWith("@veriq/") || pkg.name === "@veriq/desktop" || pkg.name === "@veriq/runtime") continue;
        if (typeof pkg.version !== "string") fail("PAYLOAD_RECEIPT_MISMATCH");
        const group = groups.get(manifest.path) ?? {
            name: pkg.name,
            version: pkg.version,
            sourcePaths: [],
        };
        group.sourcePaths.push(path);
        groups.set(manifest.path, group);
    }
    if (
        !trace.sources.includes("apps/desktop/src/agent/index.ts") ||
        !trace.sources.includes("apps/runtime/src/cli.ts")
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
    return [...groups.values()]
        .map((group) => ({ ...group, sourcePaths: group.sourcePaths.sort() }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 临时入口视图只在调用者已初始化且独占的 work 事务中存活，固定使用 views 根及两棵现有 BoundTree；本函数不会发布、清理、
 * 设置运行政策或生成 Expected，回调返回后路径是否继续有效仍由外部拥有者负责。
 */
export async function withEntryInputViews<T>(
    work: ArchiveTransaction,
    options: EntryInputOptions,
    consume: (inputRoot: string, trees: Readonly<{ entries: BoundTree; execution: BoundTree }>) => Promise<T>,
): Promise<T> {
    const metadata = freeze(
            structuredClone({
                source: options.source,
                entries: options.entries,
                execution: options.execution,
            }),
        ),
        buildRoot = options.buildRoot,
        host = Object.freeze({
            executable: options.hostBuild.executable,
            viteCli: options.hostBuild.viteCli,
            timeoutMs: options.hostBuild.timeoutMs,
            run: options.hostBuild.run,
        });
    sourcePolicy(metadata.source, metadata.entries, metadata.execution);
    if (work.profile !== "work" || work.committed || typeof consume !== "function") fail("PAYLOAD_INPUT_INVALID");
    work.check();
    await work.audit();
    if ((await readdir(join(work.scratch, "views"))).length) fail("PAYLOAD_PATH");
    const rootIdentity = await admitBuildRoot(work, buildRoot),
        source = new InputReader(work.inputRoot, work.signal, []);
    await source.initialize();
    for (const ref of metadata.source.files) await source.ref(ref, false, contentLimit(ref.path), false);
    const tools = await hostTools(work, metadata.source, host);
    const invocation = freeze({
        executable: tools.executable,
        args: [
            tools.cli,
            "build",
            "--config",
            join(work.inputRoot, configPath),
            "--configLoader",
            "native",
            "--outDir",
            buildRoot,
        ],
        cwd: join(work.inputRoot, "apps/desktop"),
        timeoutMs: host.timeoutMs,
    });
    const started = new Date().toISOString(),
        observed = await host.run(invocation),
        finished = new Date().toISOString();
    // 未确认关闭时绝不再读取构建目录或审计输出，错误码保留动作的真实首错；观察仅由调用者负责提供，不将其直接子进程关闭
    // 提升为任意后代清理，也不在失败路径替调用者删除 scratch。
    if (
        observed.closeConfirmed !== true ||
        observed.admitted !== true ||
        observed.exit !== 0 ||
        observed.signal !== null ||
        observed.error !== null ||
        observed.timedOut !== false ||
        observed.truncated !== false
    )
        throw new RuntimePayloadError(
            "PAYLOAD_IO",
            observed.error ?? "HOST_BUILD_FAILED",
            observed.closeConfirmed === true ? "NOT_NEEDED" : "INCOMPLETE",
        );
    if (
        !Buffer.isBuffer(observed.stdout) ||
        !Buffer.isBuffer(observed.stderr) ||
        observed.stdout.length > 65536 ||
        observed.stderr.length > limits.json
    )
        fail("PAYLOAD_LIMIT");
    if (!Number.isSafeInteger(observed.pid) || observed.pid! <= 0) fail("PAYLOAD_INPUT_INVALID");
    const result = {
        ...observed,
        stdout: Buffer.from(observed.stdout),
        stderr: Buffer.from(observed.stderr),
    };
    const settledRoot = await lstat(buildRoot, { bigint: true });
    if (
        !settledRoot.isDirectory() ||
        settledRoot.dev !== rootIdentity.dev ||
        settledRoot.ino !== rootIdentity.ino ||
        settledRoot.mode !== rootIdentity.mode
    )
        fail("PAYLOAD_SOURCE_CHANGED");
    for (const ref of metadata.source.files) await source.ref(ref, false, contentLimit(ref.path), false);
    const outputReader = new InputReader(buildRoot, work.signal, []);
    await outputReader.initialize();
    const trace = observation(decode(await outputReader.input(tracePath))),
        observedOutputs = await outputFiles(work, buildRoot, trace),
        directories = observedOutputs.directories,
        workspaces = await embedded(metadata.source, source, trace);
    await work.plan(
        metadata.source.files.reduce((sum, ref) => sum + ref.sizeBytes, 0) +
            trace.outputs.reduce((sum, output) => sum + output.sizeBytes, 0) +
            executionNames.reduce(
                (sum, name) =>
                    sum +
                    metadata.source.files.find((ref) => ref.path === `apps/runtime/src/execution/${name}`)!.sizeBytes,
                0,
            ),
        metadata.source.files.length + trace.outputs.length + executionNames.length,
    );
    const entryFiles: FileFact[] = [],
        executionFiles: FileFact[] = [];
    await work.mkdir("views/entries");
    await work.mkdir("views/execution");
    for (const directory of directories) await work.mkdir(`views/entries/${directory}`);
    for (const output of trace.outputs) {
        const ref = await copyFile(work, join(buildRoot, output.path), `views/entries/${output.path}`, output),
            file = { ...ref, path: output.path, mode: 0o644 as const };
        entryFiles.push(file);
    }
    // 原始文件快照保留绑定中的完整相对路径，全部位于两树之外；八份执行文件另行记录真实进程内复制的开始和结束，固定复制
    // 策略就在此 producer 中而不是伪称由 Vite 配置执行。
    const copyStarted = new Date().toISOString();
    for (const name of executionNames) {
        const ref = metadata.source.files.find((file) => file.path === `apps/runtime/src/execution/${name}`)!;
        const copied = await copyFile(work, join(work.inputRoot, ref.path), `views/execution/${name}`, ref);
        executionFiles.push({ ...copied, path: name, mode: 0o644 });
    }
    const copyFinished = new Date().toISOString();
    for (const ref of metadata.source.files)
        await copyFile(work, join(work.inputRoot, ref.path), `views/${ref.path}`, ref);
    const json = async (path: string, value: unknown) =>
        consumerRef(await writeAssetJson(work, `views/input-evidence/${path}`, value));
    const stdout = consumerRef(await work.write("views/input-evidence/vite.stdout", assetBytes(result.stdout))),
        stderr = consumerRef(await work.write("views/input-evidence/vite.stderr", assetBytes(result.stderr)));
    const command = await json("entries-command.json", {
        operation: "VITE_BUILD",
        invocation,
        started,
        finished,
        host: { platform: process.platform, arch: process.arch },
        tools: tools.tools,
        observation: { ...result, stdout, stderr },
    });
    const copy = await json("execution-copy.json", {
        operation: "IN_PROCESS_SOURCE_COPY",
        started: copyStarted,
        finished: copyFinished,
        host: { platform: process.platform, arch: process.arch, pid: process.pid },
        node: tools.tools[0],
        producer: metadata.execution.producer,
        members: executionNames,
    });
    const sourceBindingRef = await json("source-binding.json", metadata.source),
        traceRef = await json("vite-observation.json", trace);
    const entryInventory: TreeInventory = checked(
            {
                schemaVersion: 1,
                kind: "PAYLOAD_INPUT_TREE",
                treeKind: "entries",
                directories,
                files: entryFiles.sort((a, b) => a.path.localeCompare(b.path)),
                links: [],
            },
            schemas.inventory,
        ),
        executionInventory: TreeInventory = checked(
            {
                schemaVersion: 1,
                kind: "PAYLOAD_INPUT_TREE",
                treeKind: "execution",
                directories: [],
                files: executionFiles.sort((a, b) => a.path.localeCompare(b.path)),
                links: [],
            },
            schemas.inventory,
        );
    const inventoryRefs = {
        entries: await json("entries-inventory.json", entryInventory),
        execution: await json("execution-inventory.json", executionInventory),
    };
    const viewRoot = join(work.scratch, "views"),
        view = new InputReader(viewRoot, work.signal, ["entries", "execution"]);
    // 输出导入从真实已复制字节重新分析，所有 JS 资产同样受固定脚本预算约束；先复用原分类器，再额外拒绝未嵌入的 VeriQ 工
    // 作区外部边，外部普通包的 target 始终保持原 specifier。
    const scripts = trace.outputs.filter((output) => output.kind !== "asset" || /\.(?:js|mjs|cjs)$/.test(output.path));
    if (
        scripts.some((output) => output.sizeBytes > limits.javascript) ||
        scripts.reduce((sum, output) => sum + output.sizeBytes, 0) > limits.javascriptTotal
    )
        fail("PAYLOAD_LIMIT");
    const outputs: EntriesReceipt["outputs"][number][] = [];
    // 所有后续文档写入完成前不初始化整份视图 reader，先用只覆盖已完成入口子树的 reader 分析复制后字节；最终 reader 在完
    // 整写入后重新核树与所有外部证据，避免把自身正常的元数据新增误判为来源变化。
    const codeReader = new InputReader(join(viewRoot, "entries"), work.signal, []);
    await codeReader.initialize();
    for (const output of trace.outputs) {
        const file = entryFiles.find((file) => file.path === output.path)!;
        const code = scripts.includes(output) ? await codeReader.ref(file, true, limits.javascript, false) : undefined;
        const imports = code
            ? scanRuntimeLiteralImports(code, output.path).map((fact) =>
                  classifyRuntimeModuleEdge(fact, output.path, entryFiles),
              )
            : [];
        if (
            (output.kind === "asset" && imports.length) ||
            imports.some((edge) => edge.kind === "external" && edge.specifier.startsWith("@veriq/"))
        )
            fail("PAYLOAD_GRAPH_MISMATCH");
        outputs.push({ path: output.path, kind: output.kind, imports });
    }
    const entriesReceipt: EntriesReceipt = checked(
            {
                schemaVersion: 1,
                kind: "ENTRIES_BUILD",
                build: { ...metadata.entries, commandEvidence: command },
                treeInventorySha256: inventoryRefs.entries.sha256,
                entrypoints: { agent: "agent.js", cli: "cli.js" },
                outputs,
                embeddedWorkspaces: workspaces,
            },
            schemas.entries,
        ),
        executionReceipt: ExecutionReceipt = checked(
            {
                schemaVersion: 1,
                kind: "EXECUTION_SOURCE_COPY",
                build: { ...metadata.execution, commandEvidence: copy },
                treeInventorySha256: inventoryRefs.execution.sha256,
                members: executionNames.map((name) => ({
                    path: name,
                    sourcePath: `apps/runtime/src/execution/${name}`,
                    sha256: executionFiles.find((file) => file.path === name)!.sha256,
                })),
            },
            schemas.execution,
        );
    const trees = freeze({
        entries: {
            root: "entries",
            inventory: inventoryRefs.entries,
            buildReceipt: await json("entries-receipt.json", entriesReceipt),
        },
        execution: {
            root: "execution",
            inventory: inventoryRefs.execution,
            buildReceipt: await json("execution-receipt.json", executionReceipt),
        },
    });
    await work.audit();
    await view.initialize();
    view.planScripts(
        trees.entries,
        scripts.map((output) => entryFiles.find((file) => file.path === output.path)!),
    );
    view.planScripts(trees.execution, executionFiles);
    if (!equal(await document(view, sourceBindingRef, schemas.source), metadata.source))
        fail("PAYLOAD_RECEIPT_MISMATCH");
    await view.ref(traceRef);
    for (const ref of metadata.source.files) await view.ref(ref, false, contentLimit(ref.path), false);
    for (const [kind, inventory, receipt, schema] of [
        ["entries", entryInventory, entriesReceipt, schemas.entries],
        ["execution", executionInventory, executionReceipt, schemas.execution],
    ] as const) {
        if (
            !equal(await document(view, trees[kind].inventory, schemas.inventory), inventory) ||
            !equal(await document(view, trees[kind].buildReceipt, schema), receipt)
        )
            fail("PAYLOAD_RECEIPT_MISMATCH");
        await view.tree(trees[kind], inventory, kind);
        await view.ref(receipt.build.commandEvidence);
    }
    for (const output of scripts) {
        const file = entryFiles.find((file) => file.path === output.path)!,
            actual = scanRuntimeLiteralImports(await view.script(trees.entries, file), file.path).map((fact) =>
                classifyRuntimeModuleEdge(fact, file.path, entryFiles),
            );
        if (!equal(actual, outputs.find((item) => item.path === file.path)!.imports)) fail("PAYLOAD_GRAPH_MISMATCH");
    }
    for (const file of executionFiles)
        for (const fact of scanRuntimeLiteralImports(await view.script(trees.execution, file), file.path))
            classifyRuntimeModuleEdge(fact, file.path, executionFiles, true);
    await view.ref(stdout);
    await view.ref(stderr);
    await observedOutputs.finish();
    await outputReader.finish();
    await source.finish();
    await tools.finish();
    await view.finish();
    const value = await consume(viewRoot, trees);
    // 回调仅在活的所有权窗口内使用输入，返回值不携带持久发布能力；消费者结束后再核来源、工具、构建输出和视图全部身份，
    // 并最后审计事务，从而拒绝消费期间发生的任何已观察替换或字节变更。
    for (const ref of metadata.source.files) await source.ref(ref, false, contentLimit(ref.path), false);
    await source.finish();
    await outputReader.finish();
    await observedOutputs.finish();
    await codeReader.finish();
    await tools.finish();
    await view.finish();
    await work.audit();
    return value;
}
