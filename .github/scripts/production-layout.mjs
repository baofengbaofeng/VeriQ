import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
    lstat,
    mkdir,
    open,
    opendir,
    readdir,
    readlink,
    statfs,
    writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runBoundedAssetCli } from "../../apps/runtime/scripts/runtime-assets-ci-process.mjs";

// VeriQ 的此工具仅负责受控 CI 的命令结算和物理布局事实，所有默认配额来自已批准生产输入边界；测试可以缩小配额，但不能增加上限、改变进程管理器或把观察结果当作可执行发行物。
const CAPS = Object.freeze({
    instances: 4000,
    members: 40000,
    links: 1024,
    contentBytes: 16 * 1024 ** 3,
    pathBytes: 1024,
    manifestBytes: 1024 ** 2,
    jsonBytes: 4 * 1024 ** 2,
    metadataBytes: 64 * 1024 ** 2,
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code) => {
    throw new Error(code);
};
const same = (a, b) =>
    ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].every((key) => a[key] === b[key]);
const inside = (base, target) => target === base || target.startsWith(base + sep);
const now = () => new Date().toISOString();

/** 只有真实准入、直接子进程关闭确认、零退出且没有信号、错误、期限或截断时才允许阶段通过；这些事实必须同时成立，成功退出码不能覆盖输出溢出或未知关闭，也不证明后代进程及事务已清理。 */
export function classifyCommandResult(result) {
    return result?.admitted === true &&
        result.closeConfirmed === true &&
        result.exit === 0 &&
        result.signal === null &&
        result.error === null &&
        result.timedOut === false &&
        result.truncated === false
        ? "PASS"
        : "FAIL";
}

/** 顺序执行固定阶段并持久化开始和结算事实，首个失败后后续阶段保持未运行；真实命令统一复用已有有界子进程接口，阶段与整体期限取更短者，并在未知关闭后停止所有下一阶段的文件系统观察。 */
export async function runStages({ stages, deadlineMs, onUpdate = async () => {} }) {
    // 阶段列表在任何命令前一次性建立未运行状态，随后每次写日志都保留尚未开始的尾部阶段；即使第一次准入就拒绝，也能区分失败阶段与从未取得执行资格的观察阶段，避免事后按退出码推算执行历史。
    const journal = stages.map(({ name }) => ({ name, status: "NOT_RUN", commands: [] }));
    for (const [index, stage] of stages.entries()) {
        const entry = journal[index];
        entry.status = "STARTED";
        entry.started = now();
        const end = Math.min(deadlineMs, Date.now() + stage.timeoutMs);
        entry.phaseMaximumMs = stage.timeoutMs;
        entry.deadlineMs = end;
        entry.overallDeadlineMs = deadlineMs;
        await onUpdate(journal);
        // 整体截止时间和阶段期限在调用前合并，关闭等待仍由原管理器负责有限结算；剩余时间为零时不会创建新子进程，较短期限也不能由后续命令重置或通过更换工作目录绕过。
        try {
            if (end <= Date.now()) fail("PRODUCER_DEADLINE");
            const command = async (executable, args, cwd) => {
                const remaining = Math.floor(Math.min(end - Date.now(), 16 * 60000));
                if (remaining <= 0) fail("PRODUCER_DEADLINE");
                const item = {
                    executable,
                    args: [...args],
                    cwd,
                    started: now(),
                    timeoutMs: remaining,
                    status: "STARTED",
                };
                entry.commands.push(item);
                await onUpdate(journal);
                const result = await runBoundedAssetCli({
                    executable,
                    args,
                    cwd,
                    timeoutMs: remaining,
                });
                item.result = result;
                item.ended = now();
                item.status = classifyCommandResult(result);
                await onUpdate(journal);
                if (item.status !== "PASS")
                    fail(result.closeConfirmed ? "COMMAND_FAILED" : "COMMAND_CLOSE_UNKNOWN");
                return result;
            };
            await stage.run(command, end, entry);
            if (Date.now() > end) fail("PRODUCER_DEADLINE");
            entry.status = "PASS";
        } catch (error) {
            entry.status = "FAIL";
            entry.error = error.message;
        }
        entry.ended = now();
        await onUpdate(journal);
        if (entry.status !== "PASS") break;
    }
    return journal;
}

// 普通文件始终使用不跟随链接的持有描述符，并在读取前后核验路径身份与描述符身份；分段读取限制内存且观察正文增长，摘要只说明当前静止源字节，不提供敌对父目录替换下的原子整树承诺。
async function inspectFile(path, cap, retain = false, check = () => {}) {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.size > BigInt(cap)) fail("LAYOUT_FILE_LIMIT");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        if (!same(before, await handle.stat({ bigint: true }))) fail("LAYOUT_CHANGED");
        const digest = createHash("sha256"),
            parts = [];
        let bytes = 0;
        for (;;) {
            check();
            const chunk = Buffer.alloc(65536),
                read = await handle.read(chunk, 0, chunk.length, null);
            if (!read.bytesRead) break;
            bytes += read.bytesRead;
            if (bytes > cap || bytes > Number(before.size)) fail("LAYOUT_FILE_LIMIT");
            digest.update(chunk.subarray(0, read.bytesRead));
            if (retain) parts.push(chunk.subarray(0, read.bytesRead));
        }
        if (
            bytes !== Number(before.size) ||
            !same(before, await handle.stat({ bigint: true })) ||
            !same(before, await lstat(path, { bigint: true }))
        )
            fail("LAYOUT_CHANGED");
        return {
            bytes,
            sha256: digest.digest("hex"),
            mode: Number(before.mode & 0o7777n),
            ...(retain ? { data: Buffer.concat(parts) } : {}),
        };
    } finally {
        await handle.close();
    }
}

// 清单 JSON 的原始 UTF8 字节另存完整引用，解析仅提取观察字段且拒绝数组、无效编码和非法声明类型；任何自定义字段仍由原始清单保留，不重序列化成会丢失未知字段或空白的替代文本。
function parseManifest(bytes) {
    let value;
    try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
        fail("LAYOUT_MANIFEST_INVALID");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
        fail("LAYOUT_MANIFEST_INVALID");
    for (const key of [
        "dependencies",
        "peerDependencies",
        "optionalDependencies",
        "peerDependenciesMeta",
    ]) {
        if (
            value[key] !== undefined &&
            (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]))
        )
            fail("LAYOUT_MANIFEST_INVALID");
    }
    for (const key of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        if (
            value[key] &&
            Object.values(value[key]).some((constraint) => typeof constraint !== "string")
        )
            fail("LAYOUT_MANIFEST_INVALID");
    }
    if (
        value.bin !== undefined &&
        typeof value.bin !== "string" &&
        (!value.bin ||
            typeof value.bin !== "object" ||
            Array.isArray(value.bin) ||
            Object.values(value.bin).some((target) => typeof target !== "string"))
    )
        fail("LAYOUT_MANIFEST_INVALID");
    for (const key of ["name", "version"])
        if (value[key] !== undefined && typeof value[key] !== "string")
            fail("LAYOUT_MANIFEST_INVALID");
    return value;
}

// 目录树观察不展开符号链接，包根只按真实 node_modules 位置、根包及显式工作区识别；嵌套同名实例保持独立路径，普通文件归属最近包根，父包不能吞并子包正文或把版本相同当作同一实例。
function isPackageRoot(path, workspacePaths) {
    if (!path || workspacePaths.has(path)) return true;
    const parts = path.split("/"),
        name = parts.at(-1),
        parent = parts.at(-2);
    return (
        (parent === "node_modules" && !name.startsWith(".") && !name.startsWith("@")) ||
        (parts.at(-3) === "node_modules" && parent.startsWith("@") && !name.startsWith("."))
    );
}

/** 从静止的自有源码副本记录完整物理实例、目录、普通文件和原始链接目标，输出有界分块及完整原清单引用；所有配额与身份变化均失败关闭，观察不执行包体、不跟随别名，也不求解依赖边或晋升来源信任。 */
export async function collectLayoutMetadata({
    root,
    evidenceDir,
    workspaceRoots,
    limits = {},
    deadlineMs = Infinity,
}) {
    const caps = { ...CAPS };
    for (const [key, value] of Object.entries(limits)) {
        if (!(key in caps) || !Number.isSafeInteger(value) || value < 0 || value > caps[key])
            fail("LAYOUT_LIMIT_INVALID");
        caps[key] = value;
    }
    root = resolve(root);
    evidenceDir = resolve(evidenceDir);
    if (inside(root, evidenceDir) || inside(evidenceDir, root)) fail("LAYOUT_ROOT_INVALID");
    const rootStat = await lstat(root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("LAYOUT_ROOT_INVALID");
    const workspacePaths = new Map();
    for (const entry of workspaceRoots) {
        if (
            typeof entry.path !== "string" ||
            !entry.path ||
            isAbsolute(entry.path) ||
            !inside(root, resolve(root, entry.path)) ||
            relative(root, resolve(root, entry.path)).split(sep).join("/") !== entry.path ||
            typeof entry.sourcePath !== "string"
        )
            fail("LAYOUT_WORKSPACE_INVALID");
        workspacePaths.set(entry.path, entry.sourcePath);
    }
    await mkdir(evidenceDir, { mode: 0o700 });
    // 主清单第一次读取后保存其完整摘要，稍后的普通文件遍历必须再次匹配同一原始字节；这补上声明事实和正文事实之间的时间窗口，不把两个分别稳定但彼此不同的清单当成同一次观察。
    const primaryManifests = new Map();
    const artifacts = [],
        totals = {
            instances: 0,
            members: 0,
            links: 0,
            contentBytes: 0,
            metadataBytes: 0,
            files: 0,
            directories: 0,
        };
    let chunk = [],
        chunkBytes = 2,
        serial = 0;
    const check = () => {
        if (Date.now() > deadlineMs) fail("PRODUCER_DEADLINE");
    };
    const pathCheck = (path) => {
        if (
            Buffer.byteLength(path, "utf8") > caps.pathBytes ||
            path.includes("\0") ||
            path.includes("\\")
        )
            fail("LAYOUT_PATH_LIMIT");
    };
    const artifact = async (kind, path, bytes) => {
        check();
        if (
            bytes.length > (kind === "manifest" ? caps.manifestBytes : caps.jsonBytes) ||
            totals.metadataBytes + bytes.length > caps.metadataBytes
        )
            fail("LAYOUT_METADATA_LIMIT");
        await writeFile(join(evidenceDir, path), bytes, { flag: "wx", mode: 0o600 });
        totals.metadataBytes += bytes.length;
        const ref = { kind, path, bytes: bytes.length, sha256: hash(bytes) };
        artifacts.push(ref);
        return ref;
    };
    const flush = async () => {
        if (!chunk.length) return;
        await artifact(
            "inventory",
            `inventory-${String(serial++).padStart(5, "0")}.json`,
            Buffer.from(JSON.stringify(chunk)),
        );
        chunk = [];
        chunkBytes = 2;
    };
    const emit = async (record) => {
        const size = Buffer.byteLength(JSON.stringify(record)) + 1;
        if (size + 2 > caps.jsonBytes) fail("LAYOUT_JSON_LIMIT");
        if (chunkBytes + size > caps.jsonBytes) await flush();
        chunk.push(record);
        chunkBytes += size;
    };
    const walk = async (absolute, path, owner) => {
        check();
        pathCheck(path);
        const before = await lstat(absolute, { bigint: true });
        if (path && ++totals.members > caps.members) fail("LAYOUT_MEMBER_LIMIT");
        // 链接先按自身类型分流，读取的只有链接原文，端点比较使用纯词法路径而不调用 realpath；外部毒化文件和目录不会获得读取机会，工作区映射也只是未解析链接事实的注解。
        if (before.isSymbolicLink()) {
            if (++totals.links > caps.links) fail("LAYOUT_LINK_LIMIT");
            const target = new TextDecoder("utf-8", { fatal: true }).decode(
                await readlink(absolute, { encoding: "buffer" }),
            );
            pathCheck(target);
            const endpoint = resolve(dirname(absolute), target);
            const workspaceSource =
                [...workspacePaths].find(([candidate]) =>
                    inside(resolve(root, candidate), endpoint),
                )?.[1] ?? null;
            await emit({
                kind: "link",
                path,
                owner,
                target,
                mode: Number(before.mode & 0o7777n),
                bytes: Number(before.size),
                lexicalEndpoint: endpoint,
                insideRoot: inside(root, endpoint),
                workspaceSource,
                bin: path.split("/").includes(".bin"),
            });
        } else if (before.isDirectory()) {
            totals.directories++;
            // 目录项通过有限缓冲的迭代接口逐个取得，达到成员上限即停止并关闭目录描述符；排序只处理已准入的小集合，避免先把未知巨大目录完整读入内存后才检查预算。
            const children = [];
            const directory = await opendir(absolute, { encoding: "buffer" });
            for await (const child of directory) {
                check();
                if (totals.members + children.length + 1 > caps.members)
                    fail("LAYOUT_MEMBER_LIMIT");
                children.push(new TextDecoder("utf-8", { fatal: true }).decode(child.name));
            }
            children.sort();
            if (totals.members + children.length > caps.members) fail("LAYOUT_MEMBER_LIMIT");
            if (children.includes("package.json") && isPackageRoot(path, workspacePaths)) {
                const manifest = await inspectFile(
                    join(absolute, "package.json"),
                    caps.manifestBytes,
                    true,
                    check,
                );
                const value = parseManifest(manifest.data);
                primaryManifests.set(
                    path ? `${path}/package.json` : "package.json",
                    manifest.sha256,
                );
                if (++totals.instances > caps.instances) fail("LAYOUT_INSTANCE_LIMIT");
                // 包归属在真实包根处切换并随递归参数传递，子包普通文件不会累加到父包的自有正文集合；身份相同但路径不同的实例分别计数，原始清单也各自持有独立完整引用。
                owner = path;
                const ref = await artifact(
                    "manifest",
                    `manifest-${String(totals.instances).padStart(5, "0")}.json`,
                    manifest.data,
                );
                await emit({
                    kind: "package",
                    path,
                    name: value.name ?? null,
                    version: value.version ?? null,
                    manifest: ref,
                    dependencies: value.dependencies ?? {},
                    peers: value.peerDependencies ?? {},
                    optional: value.optionalDependencies ?? {},
                    bin: value.bin ?? null,
                    exports: value.exports ?? null,
                    workspaceSource: workspacePaths.get(path) ?? null,
                });
                if (value.bin !== undefined)
                    await emit({ kind: "bin", path, declaration: value.bin, owner });
            } else if (
                isPackageRoot(path, workspacePaths) &&
                path.split("/").includes("node_modules") &&
                !path.split("/").at(-1).startsWith(".")
            ) {
                fail("LAYOUT_MANIFEST_MISSING");
            }
            await emit({
                kind: "directory",
                path,
                owner,
                mode: Number(before.mode & 0o7777n),
                entries: children.length,
            });
            for (const child of children)
                await walk(join(absolute, child), path ? `${path}/${child}` : child, owner);
        } else if (before.isFile()) {
            const manifest = path.split("/").at(-1) === "package.json";
            const fact = await inspectFile(
                absolute,
                manifest ? caps.manifestBytes : caps.contentBytes - totals.contentBytes,
                manifest,
                check,
            );
            totals.files++;
            totals.contentBytes += fact.bytes;
            if (totals.contentBytes > caps.contentBytes) fail("LAYOUT_CONTENT_LIMIT");
            let auxiliaryManifest = null;
            if (manifest) {
                parseManifest(fact.data);
                if (primaryManifests.has(path) && primaryManifests.get(path) !== fact.sha256)
                    fail("LAYOUT_MANIFEST_CHANGED");
                const primary = (owner ? `${owner}/package.json` : "package.json") === path;
                if (!primary)
                    auxiliaryManifest = await artifact(
                        "manifest",
                        `auxiliary-${String(totals.files).padStart(5, "0")}.json`,
                        fact.data,
                    );
            }
            const { data, ...metadata } = fact;
            await emit({
                kind: "file",
                path,
                owner,
                ...metadata,
                auxiliaryManifest,
                bin: path.split("/").includes(".bin"),
            });
        } else fail("LAYOUT_TYPE_INVALID");
        if (!same(before, await lstat(absolute, { bigint: true }))) fail("LAYOUT_CHANGED");
    };
    await walk(root, "", null);
    await flush();
    return { schemaVersion: 1, totals, artifacts };
}

/** 绑定本次自有前缀内固定版本的工具入口、实现正文与原始包清单身份，保持生产步骤与真实文件系统测试共用同一读取路径；绑定只记录文件事实，不执行包体，也不从兼容入口名称猜测额外信任能力。 */
export async function bindPinnedPnpm({ packageRoot, ownedRoot, deadlineMs = Infinity }) {
    if (
        typeof packageRoot !== "string" ||
        typeof ownedRoot !== "string" ||
        !isAbsolute(packageRoot) ||
        !isAbsolute(ownedRoot)
    )
        fail("PNPM_PACKAGE_BOUNDARY");
    packageRoot = resolve(packageRoot);
    ownedRoot = resolve(ownedRoot);
    if (!inside(ownedRoot, packageRoot)) fail("PNPM_PACKAGE_BOUNDARY");
    const check = () => {
        if (Date.now() > deadlineMs) fail("PRODUCER_DEADLINE");
    };
    const directories = new Map();
    let ancestor = ownedRoot;
    const paths = [ownedRoot];
    for (const part of relative(ownedRoot, packageRoot).split(sep).filter(Boolean)) {
        ancestor = join(ancestor, part);
        paths.push(ancestor);
    }
    paths.push(join(packageRoot, "bin"), join(packageRoot, "dist"));
    // 自有前缀到工具包及两个实际代码父目录逐段核验真实目录，阻止父目录别名绕过文件本身的不跟随链接读取；收尾再次核同一组身份，不宣称对敌对同 UID 并发替换提供原子目录能力。
    for (const path of paths) {
        check();
        const identity = await lstat(path, { bigint: true });
        if (!identity.isDirectory() || identity.isSymbolicLink()) fail("PNPM_PACKAGE_BOUNDARY");
        directories.set(path, identity);
    }
    const packagePath = join(packageRoot, "package.json");
    const { data: packageJson, ...packageMetadata } = await inspectFile(
        packagePath,
        CAPS.manifestBytes,
        true,
        check,
    );
    const manifest = parseManifest(packageJson);
    if (
        manifest.name !== "pnpm" ||
        manifest.version !== "11.25.0" ||
        manifest.type !== "module" ||
        !manifest.bin ||
        typeof manifest.bin !== "object" ||
        manifest.bin.pnpm !== "bin/pnpm.mjs"
    )
        fail("PNPM_PACKAGE_IDENTITY");
    // 固定版本的公开入口和真正加载的实现均按已经核验的 ESM 布局绑定，兼容 CJS shim 的存在不参与推断；完整原始包清单单独交给调用者保留，摘要只绑定这次实际读取的字节而非远端发布者身份。
    const cliPath = join(packageRoot, "bin/pnpm.mjs"),
        implementationPath = join(packageRoot, "dist/pnpm.mjs");
    const cli = { path: cliPath, ...(await inspectFile(cliPath, CAPS.jsonBytes, false, check)) };
    const implementation = {
        path: implementationPath,
        ...(await inspectFile(implementationPath, CAPS.contentBytes, false, check)),
    };
    for (const [path, identity] of directories) {
        check();
        if (!same(identity, await lstat(path, { bigint: true }))) fail("PNPM_PACKAGE_BOUNDARY");
    }
    return {
        version: manifest.version,
        cli,
        implementation,
        package: { path: packagePath, ...packageMetadata },
        packageJson,
    };
}

// CI 环境中的宿主工具只继承必要的平台路径，所有 Node 注入与 npm 凭据覆盖先删除再指向独占缓存；不输出环境或完整配置，不改变真实 HOME 的含义，也不覆盖仓库的 peer、年龄或 overrides 规则。
function sanitizeEnvironment(owned) {
    for (const key of Object.keys(process.env)) {
        if (
            /^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_REPL_EXTERNAL_MODULE|NPM_CONFIG_|npm_config_|PNPM_|COREPACK_|BASH_ENV|ENV$)/i.test(
                key,
            ) ||
            /(TOKEN|PASSWORD|AUTH|CREDENTIAL)/i.test(key)
        )
            delete process.env[key];
    }
    Object.assign(process.env, {
        npm_config_userconfig: join(owned, "user.npmrc"),
        npm_config_globalconfig: join(owned, "global.npmrc"),
        npm_config_cache: join(owned, "npm-cache"),
        npm_config_registry: "https://registry.npmjs.org/",
        XDG_CONFIG_HOME: join(owned, "config"),
        XDG_CACHE_HOME: join(owned, "cache"),
        XDG_DATA_HOME: join(owned, "data"),
        TMPDIR: join(owned, "tmp"),
        TMP: join(owned, "tmp"),
        TEMP: join(owned, "tmp"),
        ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    });
}

// 占用扫描只在所有已启动直接子进程已确认关闭后运行，链接仅计其本身且不展开外部存储；独立复制准入根据实际 store 与准备副本的普通文件长度保守计费，再保留至少四 GiB 空闲。
async function occupancy(path, deadlineMs) {
    let bytes = 0,
        members = 0;
    const walk = async (at) => {
        if (Date.now() > deadlineMs || ++members > 400000) fail("OCCUPANCY_LIMIT");
        const before = await lstat(at, { bigint: true });
        if (before.isDirectory())
            for (const child of await readdir(at)) await walk(join(at, child));
        else if (before.isFile()) bytes += Number(before.size);
        if (!same(before, await lstat(at, { bigint: true }))) fail("OCCUPANCY_CHANGED");
    };
    await walk(path);
    return { bytes, members };
}
const freeSpace = async (path) => {
    const info = await statfs(path, { bigint: true });
    return Number(info.bavail * info.bsize);
};

// 直接入口负责形成固定的自有工作根与已持有证据映射，输出集合只复制这个映射，永远不递归上传源码、store 或未知 writer 目录；失败阶段可留下诊断，但不存在清理成功或目标执行能力的推断。
async function main() {
    const env = process.env,
        source = process.cwd(),
        owned = env.LAYOUT_ROOT;
    if (
        !owned ||
        !isAbsolute(owned) ||
        !env.RUNNER_TEMP ||
        !inside(resolve(env.RUNNER_TEMP), resolve(owned)) ||
        resolve(owned) === resolve(env.RUNNER_TEMP)
    )
        fail("LAYOUT_OWNED_ROOT_INVALID");
    await mkdir(owned, { mode: 0o700 });
    const started = Date.now(),
        deadlineMs = started + 22 * 60000;
    const metadata = join(owned, "metadata"),
        upload = join(owned, "upload"),
        store = join(owned, "store"),
        tools = join(owned, "tools");
    for (const directory of [metadata, store, tools, join(owned, "tmp")])
        await mkdir(directory, { mode: 0o700 });
    // 允许上传的路径从本次执行创建的持有映射产生，路径值由固定前缀或本工具生成的分块名构成；既不枚举工作树来猜测允许集合，也不在未知关闭后从可能活跃的 writer 目录追补日志。
    const held = new Map();
    let heldBytes = 0,
        journal = [],
        binding = null,
        lockSha = null,
        workspaceRoots = [],
        layout = null,
        problem = null;
    const hold = (path, value) => {
        const bytes = Buffer.isBuffer(value)
            ? Buffer.from(value)
            : Buffer.from(JSON.stringify(value));
        if (bytes.length > (path.endsWith(".log") ? 4 * 1024 ** 2 : CAPS.jsonBytes))
            fail("EVIDENCE_ITEM_LIMIT");
        const next = heldBytes - (held.get(path)?.length ?? 0) + bytes.length;
        if (next > CAPS.metadataBytes - CAPS.jsonBytes) fail("EVIDENCE_TOTAL_LIMIT");
        held.set(path, bytes);
        heldBytes = next;
        return { path, bytes: bytes.length, sha256: hash(bytes) };
    };
    // 命令结果里的原始 Buffer 另存有长度和摘要的日志快照，journal 只保留状态与引用以免 JSON 序列化重复膨胀；截断摘要明确只绑定已捕获部分，不能被误解成完整进程输出摘要。
    const onUpdate = async (entries) => {
        journal = entries;
        const snapshot = entries.map((entry, index) => ({
            ...entry,
            sourceBindingSha256: binding ? hash(Buffer.from(JSON.stringify(binding))) : null,
            commands: entry.commands.map((item, commandIndex) => {
                if (!item.result) return item;
                const { stdout, stderr, ...result } = item.result;
                const prefix = `stage-${index}-command-${commandIndex}`;
                return {
                    ...item,
                    result: {
                        ...result,
                        logScope: result.truncated ? "TRUNCATED_CAPTURE_ONLY" : "COMPLETE_CAPTURE",
                        stdout: hold(`${prefix}.stdout.log`, stdout),
                        stderr: hold(`${prefix}.stderr.log`, stderr),
                    },
                };
            }),
        }));
        hold("journal.json", { schemaVersion: 1, stages: snapshot });
    };
    const lock = async (path) =>
        (await inspectFile(join(path, "pnpm-lock.yaml"), CAPS.jsonBytes)).sha256;
    const checkLock = async (path, entry, field) => {
        entry[field] = await lock(path);
        if (entry[field] !== lockSha) fail("SOURCE_LOCK_CHANGED");
    };
    const checkSource = async (copy, entry, field, end) => {
        const observed = [];
        entry[field] = observed;
        for (const expected of binding.files) {
            const file = await inspectFile(join(copy, expected.path), CAPS.jsonBytes, false, () => {
                if (Date.now() > end) fail("PRODUCER_DEADLINE");
            });
            observed.push({ path: expected.path, bytes: file.bytes, sha256: file.sha256 });
            if (file.bytes !== expected.bytes || file.sha256 !== expected.sha256)
                fail("SOURCE_BYTES_CHANGED");
        }
    };
    const preparation = join(owned, "preparation"),
        installation = join(owned, "installation"),
        archive = join(owned, "source.tar");
    let pnpm;
    try {
        journal = await runStages({
            deadlineMs,
            onUpdate,
            stages: [
                {
                    name: "tools",
                    timeoutMs: 4 * 60000,
                    run: async (command, end, entry) => {
                        if (
                            env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
                            env.LAYOUT_PURPOSE !== "production-layout" ||
                            !/^[0-9a-f]{40}$/.test(env.MANUAL_SOURCE ?? "") ||
                            env.MANUAL_SOURCE !== env.GITHUB_SHA ||
                            process.platform !== "darwin" ||
                            process.arch !== env.EXPECTED_ARCH ||
                            process.versions.electron ||
                            !/^v24\./.test(process.version)
                        )
                            fail("SOURCE_HOST_ADMISSION");
                        const head = await command("/usr/bin/git", ["rev-parse", "HEAD"], source);
                        if (head.stdout.toString().trim() !== env.GITHUB_SHA)
                            fail("SOURCE_COMMIT_MISMATCH");
                        const status = await command(
                            "/usr/bin/git",
                            ["status", "--porcelain", "--untracked-files=no"],
                            source,
                        );
                        if (status.stdout.length) fail("SOURCE_DIRTY");
                        const os = await command("/usr/bin/sw_vers", ["-productVersion"], source);
                        const arch = await command("/usr/bin/uname", ["-m"], source);
                        if (
                            os.stdout.toString().split(".")[0] !== "15" ||
                            arch.stdout.toString().trim() !==
                                (env.EXPECTED_ARCH === "x64" ? "x86_64" : "arm64")
                        )
                            fail("SOURCE_HOST_ADMISSION");
                        const tracked = (
                            await command("/usr/bin/git", ["ls-files", "-z"], source)
                        ).stdout
                            .toString()
                            .split("\0")
                            .filter(Boolean);
                        if (tracked.some((path) => path.split("/").includes("node_modules")))
                            fail("SOURCE_CONTAINS_NODE_MODULES");
                        // 来源选择包括所有受 Git 管理的包清单和 npm 配置，而非只取 Runtime 的直接清单；安装前后的同一集合逐项比对，仓库策略和工作区声明不会因宿主工具运行而悄悄改变。
                        const selected = tracked.filter(
                            (path) =>
                                /(^|\/)package\.json$/.test(path) ||
                                /(^|\/)\.npmrc$/.test(path) ||
                                [
                                    "pnpm-lock.yaml",
                                    "pnpm-workspace.yaml",
                                    ".github/workflows/runtime-payload-macos.yml",
                                    ".github/scripts/production-layout.mjs",
                                    "apps/runtime/tests/production-layout-ci.test.mjs",
                                    "apps/runtime/scripts/runtime-assets-ci-process.mjs",
                                ].includes(path),
                        );
                        const files = [];
                        for (const [index, path] of selected.entries()) {
                            const file = await inspectFile(
                                join(source, path),
                                path.endsWith("package.json") ? CAPS.manifestBytes : CAPS.jsonBytes,
                                true,
                            );
                            files.push({
                                path,
                                bytes: file.bytes,
                                sha256: file.sha256,
                                snapshot: hold(`source-${index}.raw`, file.data),
                            });
                            if (
                                /^(apps\/(desktop|runtime|web)|packages\/[^/]+)\/package\.json$/.test(
                                    path,
                                )
                            )
                                workspaceRoots.push({
                                    path: dirname(path),
                                    sourcePath: dirname(path),
                                });
                        }
                        lockSha = files.find((file) => file.path === "pnpm-lock.yaml")?.sha256;
                        if (!lockSha) fail("SOURCE_LOCK_MISSING");
                        const host = await inspectFile(
                            process.execPath,
                            CAPS.contentBytes,
                            false,
                            () => {
                                if (Date.now() > end) fail("PRODUCER_DEADLINE");
                            },
                        );
                        binding = {
                            schemaVersion: 1,
                            source: env.GITHUB_SHA,
                            sourceRef: env.MANUAL_SOURCE,
                            ref: env.GITHUB_REF,
                            workflow: env.GITHUB_WORKFLOW,
                            workflowRef: env.GITHUB_WORKFLOW_REF,
                            workflowSha: env.GITHUB_WORKFLOW_SHA,
                            run: env.GITHUB_RUN_ID,
                            attempt: env.GITHUB_RUN_ATTEMPT,
                            job: env.GITHUB_JOB,
                            os: os.stdout.toString().trim(),
                            arch: process.arch,
                            hostNode: {
                                version: process.version,
                                executable: process.execPath,
                                ...host,
                            },
                            files,
                            workspaceRoots,
                            preparationScope:
                                "All workspace production dependencies from the frozen lock; not Runtime-only",
                            requestedFilter: "@veriq/runtime...",
                            claims: "Physical metadata only; package bodies ephemeral; dependency edges and workspace TypeScript materialization unresolved",
                        };
                        hold("binding.json", binding);
                        entry.initialFreeBytes = await freeSpace(owned);
                        if (entry.initialFreeBytes < 4 * 1024 ** 3)
                            fail("ACQUISITION_DISK_RESERVE");
                        // 工具获取也属于需要空闲空间准入的获取动作，先记实际可用字节再设置私有配置；宿主 npm 的代码来自已选定 Node 安装，新增 pnpm 仅装入本次独占前缀并关闭生命周期脚本。
                        sanitizeEnvironment(owned);
                        await writeFile(join(owned, "user.npmrc"), "", { flag: "wx", mode: 0o600 });
                        await writeFile(join(owned, "global.npmrc"), "", {
                            flag: "wx",
                            mode: 0o600,
                        });
                        const npm = join(
                            dirname(process.execPath),
                            "../lib/node_modules/npm/bin/npm-cli.js",
                        );
                        const npmPackage = join(dirname(npm), "../package.json");
                        const npmManifest = await inspectFile(npmPackage, CAPS.manifestBytes, true);
                        binding.hostNpm = {
                            path: npm,
                            ...(await inspectFile(npm, CAPS.jsonBytes)),
                            version: parseManifest(npmManifest.data).version,
                            package: {
                                path: npmPackage,
                                bytes: npmManifest.bytes,
                                sha256: npmManifest.sha256,
                            },
                        };
                        hold("binding.json", binding);
                        await command(
                            process.execPath,
                            [
                                npm,
                                "install",
                                "--prefix",
                                tools,
                                "pnpm@11.25.0",
                                "--ignore-scripts",
                                "--no-audit",
                                "--no-fund",
                                "--cache",
                                join(owned, "npm-cache"),
                                "--userconfig",
                                join(owned, "user.npmrc"),
                                "--globalconfig",
                                join(owned, "global.npmrc"),
                            ],
                            source,
                        );
                        const { packageJson, ...pnpmBinding } = await bindPinnedPnpm({
                            packageRoot: join(tools, "node_modules/pnpm"),
                            ownedRoot: tools,
                            deadlineMs: end,
                        });
                        pnpm = pnpmBinding.cli.path;
                        binding.pnpm = {
                            ...pnpmBinding,
                            package: {
                                ...pnpmBinding.package,
                                snapshot: hold("pnpm-package.json", packageJson),
                            },
                        };
                        // 版本命令也可能失败，因此先把已经形成的工具绑定冻结成证据快照，保证 STARTED 与失败 journal 的来源摘要始终能在同次上传集合内复核；成功后的再次保存只确认同一对象而不改变来源身份。
                        hold("binding.json", binding);
                        const version = await command(
                            process.execPath,
                            [pnpm, "--version"],
                            source,
                        );
                        if (version.stdout.toString().trim() !== "11.25.0")
                            fail("PNPM_VERSION_MISMATCH");
                        hold("binding.json", binding);
                        await command(
                            "/usr/bin/git",
                            ["archive", "--format=tar", "-o", archive, env.GITHUB_SHA],
                            source,
                        );
                        entry.archive = await inspectFile(archive, CAPS.contentBytes, false, () => {
                            if (Date.now() > end) fail("PRODUCER_DEADLINE");
                        });
                    },
                },
                {
                    name: "fetch",
                    timeoutMs: 12 * 60000,
                    run: async (command, end, entry) => {
                        await mkdir(preparation, { mode: 0o700 });
                        await command("/usr/bin/tar", ["-xf", archive, "-C", preparation], source);
                        await checkLock(preparation, entry, "lockBefore");
                        await checkSource(preparation, entry, "sourceBefore", end);
                        entry.scope = "All frozen workspace production dependencies";
                        entry.freeBytesBeforeAcquisition = await freeSpace(owned);
                        if (entry.freeBytesBeforeAcquisition < 4 * 1024 ** 3)
                            fail("ACQUISITION_DISK_RESERVE");
                        // fetch 不带 Runtime 过滤器，因为冻结工作区锁定义的生产获取范围本来就更宽；任何不支持选项或仓库策略拒绝原样保留为失败，关闭确认前绝不进入锁复核、占用扫描或下一阶段。
                        try {
                            await command(
                                process.execPath,
                                [
                                    pnpm,
                                    "fetch",
                                    "--prod",
                                    "--frozen-lockfile",
                                    "--ignore-scripts",
                                    "--store-dir",
                                    store,
                                ],
                                preparation,
                            );
                        } finally {
                            if (entry.commands.at(-1)?.result?.closeConfirmed === true) {
                                await checkLock(preparation, entry, "lockAfter");
                                await checkSource(preparation, entry, "sourceAfter", end);
                            }
                        }
                        entry.store = await occupancy(store, end);
                        entry.preparation = await occupancy(preparation, end);
                        entry.freeBytes = await freeSpace(owned);
                    },
                },
                {
                    name: "install",
                    timeoutMs: 8 * 60000,
                    run: async (command, end, entry) => {
                        entry.storeBefore = await occupancy(store, end);
                        entry.preparationBefore = await occupancy(preparation, end);
                        entry.freeBytesBefore = await freeSpace(owned);
                        // copy 方法不能依赖共享 inode 的节省来通过磁盘准入，按实际存储加准备副本的普通文件字节预留独立副本；额外四 GiB 缓冲仍单独保留，不通过删除共享缓存或其它候选腾挪空间。
                        entry.independentCopyRequiredBytes =
                            entry.storeBefore.bytes + entry.preparationBefore.bytes;
                        if (
                            entry.freeBytesBefore <
                            entry.independentCopyRequiredBytes + 4 * 1024 ** 3
                        )
                            fail("INDEPENDENT_COPY_DISK_RESERVE");
                        await mkdir(installation, { mode: 0o700 });
                        await command("/usr/bin/tar", ["-xf", archive, "-C", installation], source);
                        await checkLock(installation, entry, "lockBefore");
                        await checkSource(installation, entry, "sourceBefore", end);
                        entry.requestedFilter = "@veriq/runtime...";
                        try {
                            await command(
                                process.execPath,
                                [
                                    pnpm,
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
                                    store,
                                ],
                                installation,
                            );
                        } finally {
                            if (entry.commands.at(-1)?.result?.closeConfirmed === true) {
                                await checkLock(installation, entry, "lockAfter");
                                await checkSource(installation, entry, "sourceAfter", end);
                            }
                        }
                        entry.installation = await occupancy(installation, end);
                        entry.storeAfter = await occupancy(store, end);
                        entry.freeBytesAfter = await freeSpace(owned);
                    },
                },
                {
                    name: "observe",
                    timeoutMs: 4 * 60000,
                    run: async (command, end, entry) => {
                        await checkLock(installation, entry, "lockBefore");
                        await checkSource(installation, entry, "sourceBefore", end);
                        // Workspace 身份发现故意不复用请求过滤器，也不展开依赖树，避免把请求范围误认为真实安装范围；原始模块配置另存供后续审查，物理普通文件与实例仍以独立遍历结果为准。
                        const discovery = await command(
                            process.execPath,
                            [pnpm, "-r", "list", "--depth", "-1", "--json"],
                            installation,
                        );
                        hold("importer-discovery.json", discovery.stdout);
                        entry.importerDiscovery =
                            "All workspace identities, depth minus one; not dependency-edge proof";
                        entry.installMetadata = [];
                        for (const path of [
                            "node_modules/.modules.yaml",
                            "node_modules/.pnpm-workspace-state-v1.json",
                            "node_modules/.pnpm/lock.yaml",
                        ]) {
                            let observed;
                            try {
                                observed = await lstat(join(installation, path));
                            } catch (error) {
                                if (error.code !== "ENOENT") throw error;
                            }
                            if (!observed) {
                                entry.installMetadata.push({ path, status: "ABSENT" });
                                continue;
                            }
                            const file = await inspectFile(
                                join(installation, path),
                                CAPS.jsonBytes,
                                true,
                            );
                            entry.installMetadata.push({
                                path,
                                status: "OBSERVED_RAW",
                                ref: hold(
                                    `install-metadata-${entry.installMetadata.length}.raw`,
                                    file.data,
                                ),
                            });
                        }
                        layout = await collectLayoutMetadata({
                            root: installation,
                            evidenceDir: join(metadata, "layout"),
                            workspaceRoots,
                            limits: {
                                metadataBytes: CAPS.metadataBytes - heldBytes - CAPS.jsonBytes,
                            },
                            deadlineMs: end,
                        });
                        await checkLock(installation, entry, "lockAfter");
                        await checkSource(installation, entry, "sourceAfter", end);
                        for (const ref of layout.artifacts) {
                            const file = await inspectFile(
                                join(metadata, "layout", ref.path),
                                CAPS.jsonBytes,
                                true,
                            );
                            if (file.bytes !== ref.bytes || file.sha256 !== ref.sha256)
                                fail("EVIDENCE_CHANGED");
                            hold(`layout/${ref.path}`, file.data);
                        }
                        hold("layout.json", { ...layout, artifactBase: "layout" });
                        entry.totals = layout.totals;
                    },
                },
            ],
        });
    } catch (error) {
        problem = error.message;
    }
    // 输出根仅接收内存中已经冻结的固定证据与成功观察引用，命令关闭未知时不会再触碰安装树或 store；上传清单本身也计入总预算，任何收集失败都会阻止输出路径标记，避免上传旧目录或残缺成功证据。
    const passed =
        !problem && journal.length === 4 && journal.every((stage) => stage.status === "PASS");
    hold("outcome.json", {
        schemaVersion: 1,
        status: passed ? "PASS" : "FAIL",
        problem,
        source: env.GITHUB_SHA,
        run: env.GITHUB_RUN_ID,
        attempt: env.GITHUB_RUN_ATTEMPT,
        arch: process.arch,
        durationMs: Date.now() - started,
        directChildCloseUnknown: journal.some((stage) =>
            stage.commands.some((item) => item.result?.closeConfirmed === false),
        ),
        stages: journal.map(({ name, status }) => ({ name, status })),
        observed: passed ? (layout?.totals ?? null) : null,
        retention: "Metadata only; bodies require reproduction and revalidation",
        cleanup: "NOT_CLAIMED",
    });
    const files = [...held].map(([path, bytes]) => ({
        path,
        bytes: bytes.length,
        sha256: hash(bytes),
    }));
    const manifest = Buffer.from(
        JSON.stringify({
            schemaVersion: 1,
            source: env.GITHUB_SHA,
            run: env.GITHUB_RUN_ID,
            attempt: env.GITHUB_RUN_ATTEMPT,
            arch: process.arch,
            files,
        }),
    );
    if (heldBytes + manifest.length > CAPS.metadataBytes || manifest.length > CAPS.jsonBytes)
        fail("EVIDENCE_TOTAL_LIMIT");
    await mkdir(upload, { mode: 0o700 });
    for (const [path, bytes] of held) {
        if (path.startsWith("layout/"))
            await mkdir(join(upload, "layout"), { recursive: true, mode: 0o700 });
        await writeFile(join(upload, path), bytes, { flag: "wx", mode: 0o600 });
    }
    await writeFile(join(upload, "manifest.json"), manifest, { flag: "wx", mode: 0o600 });
    if (env.GITHUB_OUTPUT) {
        const output = await open(env.GITHUB_OUTPUT, "a");
        try {
            await output.writeFile(
                `upload_root=${upload}\ncollection=SNAPSHOTTED\nstages=${journal.map(({ name, status }) => `${name}:${status}`).join(",")}\n`,
            );
        } finally {
            await output.close();
        }
    }
    if (!passed) process.exitCode = 1;
}

// 模块被测试或其它 CI 工具导入时绝不启动生产入口，只有真实文件路径匹配直接参数才执行；顶层拒绝只输出固定英文错误类别，不打印命令环境、凭据或未经审查的依赖正文内容。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`Production layout producer failed: ${error.message}`);
        process.exitCode = 1;
    });
}
