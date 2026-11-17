import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    realpath,
    rm,
    statfs,
    writeFile,
    appendFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { release } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { runBoundedAssetCli } from "../../apps/runtime/scripts/runtime-assets-ci-process.mjs";

const JSON_LIMIT = 4 * 1024 ** 2,
    ARTIFACT_LIMIT = 2 * 1024 ** 2;
// 已交付构建与安装脚本只保留 Git 对象身份，不参与入口来源或执行；选择和最终完整清单共用冻结的精确排序集合，新增邻近钩子
// 仍应拒绝，不能从目录扫描或当前执行位自动扩张此政策。
const EXECUTABLE_EXCLUSIONS = Object.freeze([
    "build.sh",
    "deploy/desktop/linux/before-install.sh",
    "deploy/desktop/linux/before-remove.sh",
    "deploy/desktop/macos/scripts/preinstall",
    "deploy/install.sh",
    "deploy/start.sh",
]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const refFor = (path, bytes) => ({ path, sizeBytes: bytes.length, sha256: hash(bytes) });
const now = () => new Date().toISOString();
const fail = (code) => {
    throw new Error(code);
};
const equal = (a, b) => {
    try {
        assert.deepEqual(a, b);
        return true;
    } catch {
        return false;
    }
};
const commandPass = (v) =>
    v?.admitted === true &&
    v.closeConfirmed === true &&
    v.exit === 0 &&
    v.signal === null &&
    v.error === null &&
    v.timedOut === false &&
    v.truncated === false;
const same = (a, b) =>
    ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every((k) => a[k] === b[k]);
const contained = (a, b) => b === a || b.startsWith(a + sep);

// 路径在 Git、来源和保留副本三个边界共用有限可移植规则，逐级大小写冲突另由清单检查；禁止先规范化点组件，
// 否则非法原始路径可能被消除后悄悄取得一个合法文件的身份。
function portable(path, code) {
    if (
        typeof path !== "string" ||
        !path ||
        Buffer.byteLength(path) > 1024 ||
        path.split("/").length > 64 ||
        path
            .split("/")
            .some(
                (v) =>
                    !v ||
                    v === "." ||
                    v === ".." ||
                    v.length > 255 ||
                    /[^\x20-\x7e]|[\\:<>"|?*]|[. ]$/.test(v) ||
                    /\.asar$/i.test(v) ||
                    /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/i.test(v.split(".")[0]),
            )
    )
        fail(code);
    return path;
}

/**
 * 原生准入同时绑定人工用途、完整已审阅提交、真实 Darwin 内核和当前进程架构，声明的目标不能覆盖宿主事实；Linux
 * 单元测试只调用显式事实样本，正式入口始终从系统与 CI 环境重新取得这些字段。
 */
export function admitEntryRun(value) {
    if (
        value.event !== "workflow_dispatch" ||
        value.purpose !== "entry-inputs" ||
        !/^[a-f0-9]{40}$/.test(value.source ?? "") ||
        value.source !== value.commit ||
        value.platform !== "darwin" ||
        !["x64", "arm64"].includes(value.arch) ||
        value.arch !== value.expectedArch ||
        !/^24\.\d+\.\d+$/.test(value.release ?? "") ||
        value.nodeVersion !== "v24.22.1"
    )
        fail("ENTRY_ADMISSION");
    return Object.freeze({ ...value });
}

/**
 * 来源选择依据完整提交树的原始 Git 模式而非当前执行位，只排除六个已批准脚本；保留每个对象身份与排除原因，链接、
 * 子模块、新执行文件、重复路径及父目录大小写碰撞全部拒绝。
 */
export function selectGitInventory(raw) {
    if (!Buffer.isBuffer(raw) || raw.length > JSON_LIMIT || !raw.length || raw.at(-1) !== 0)
        fail("ENTRY_GIT");
    const rows = new TextDecoder("utf-8", { fatal: true }).decode(raw).split("\0").slice(0, -1);
    if (rows.length > 40000) fail("ENTRY_GIT");
    const selected = [],
        excluded = [],
        seen = new Set(),
        prefixes = new Map();
    for (const row of rows) {
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
        if (!match) fail("ENTRY_GIT");
        const [, mode, gitBlob, path] = match;
        portable(path, "ENTRY_GIT");
        if (seen.has(path)) fail("ENTRY_GIT");
        seen.add(path);
        let prefix = "";
        for (const part of path.split("/")) {
            prefix = prefix ? `${prefix}/${part}` : part;
            const old = prefixes.get(prefix.toLowerCase());
            if (old && old !== prefix) fail("ENTRY_GIT");
            prefixes.set(prefix.toLowerCase(), prefix);
        }
        if (mode === "100644") selected.push({ path, mode, gitBlob });
        else {
            if (!EXECUTABLE_EXCLUSIONS.includes(path)) fail("ENTRY_GIT");
            excluded.push({ path, mode, gitBlob, reason: "TRACKED_EXECUTABLE" });
        }
    }
    return {
        selected: selected.sort((a, b) => a.path.localeCompare(b.path)),
        excluded: excluded.sort((a, b) => a.path.localeCompare(b.path)),
    };
}

// 从真实根到文件父目录逐级记录普通目录身份，根以上只允许平台的普通路径；文件读取前后复核祖先，拒绝观察到的替换，
// 但不宣称同 UID 对手无法在两次观察间实施不可见竞争。
async function ancestors(root, path, code) {
    if (!isAbsolute(root) || resolve(root) !== root || (await realpath(root)) !== root) fail(code);
    const observations = [];
    for (let parent = dirname(join(root, path)); ; parent = dirname(parent)) {
        const info = await lstat(parent, { bigint: true });
        if (
            !info.isDirectory() ||
            (Number(info.mode & 0o22n) !== 0 && parent !== "/tmp" && parent !== "/dev/shm")
        )
            fail(code);
        observations.push([parent, info]);
        if (parent === dirname(parent)) break;
    }
    return async () => {
        for (const [path, before] of observations)
            if (!same(before, await lstat(path, { bigint: true }))) fail(code);
    };
}

/**
 * 每个来源文件必须物理单链接且权限恰为四百四十四或六百四十四，提交模式不能代替实际属性；持有描述符读前读后比较身份与预
 * 期字节，不会 chmod、重写或把私有副本包装成合格来源。
 */
export async function readSourceFile(root, ref) {
    portable(ref.path, "ENTRY_SOURCE");
    const finish = await ancestors(root, ref.path, "ENTRY_SOURCE"),
        path = join(root, ref.path),
        before = await lstat(path, { bigint: true });
    if (
        !before.isFile() ||
        before.nlink !== 1n ||
        ![0o444, 0o644].includes(Number(before.mode & 0o7777n)) ||
        before.size > BigInt(ref.path.endsWith(".json") ? JSON_LIMIT : 16 * 1024 ** 2)
    )
        fail("ENTRY_SOURCE");
    const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
        if (!same(before, await handle.stat({ bigint: true }))) fail("ENTRY_SOURCE");
        const bytes = await handle.readFile();
        if (
            !same(before, await handle.stat({ bigint: true })) ||
            !same(before, await lstat(path, { bigint: true })) ||
            bytes.length !== ref.sizeBytes ||
            hash(bytes) !== ref.sha256
        )
            fail("ENTRY_SOURCE");
        await finish();
        return bytes;
    } finally {
        await handle.close();
    }
}

/**
 * 默认环境文件即使被 Git 跟踪仍不准进入构建，包与配置候选则必须具有同路径来源绑定；检查覆盖每个来源祖先和仓库以外的祖
 * 先，缺失只接受 ENOENT，权限或链接错误不能伪装成不存在。
 */
export async function qualifyAmbientInputs(root, refs) {
    const bound = new Set(refs.map((v) => v.path)),
        absent = [],
        present = [];
    const check = async (path, allowed) => {
        try {
            const info = await lstat(path);
            if (!allowed || !info.isFile() || info.isSymbolicLink()) fail("ENTRY_AMBIENT");
            present.push(relative(root, path));
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            absent.push(relative(root, path));
        }
    };
    for (const name of [".env", ".env.local", ".env.production", ".env.production.local"])
        await check(join(root, name), false);
    const dirs = new Set([""]);
    for (const ref of refs)
        for (let parent = dirname(ref.path); parent !== "."; parent = dirname(parent))
            dirs.add(parent);
    if (dirs.size > 40000) fail("ENTRY_AMBIENT");
    for (const dir of [...dirs].sort())
        for (const name of ["package.json", "tsconfig.json", "jsconfig.json"]) {
            const path = dir ? `${dir}/${name}` : name;
            await check(join(root, path), bound.has(path));
        }
    for (let dir = dirname(root), count = 0; ; dir = dirname(dir)) {
        if (++count > 64) fail("ENTRY_AMBIENT");
        for (const name of ["package.json", "tsconfig.json", "jsconfig.json"])
            await check(join(dir, name), false);
        if (dir === dirname(dir)) break;
    }
    return { absent: absent.sort(), present: present.sort() };
}

// 保留区只复制已持有并核过摘要的元数据，消费者引用完整保留在独立映射而不是改写生产收据；固定两 MiB 总量比既有六十四
// MiB 更紧，避免失败日志使上传目录失控或误带源码正文。
function metadataPlan(documents) {
    if (!Array.isArray(documents) || documents.length > 128) fail("ENTRY_METADATA");
    const seen = new Set();
    let total = 0;
    return documents.map(({ ref, bytes }, index) => {
        portable(ref?.path, "ENTRY_METADATA");
        if (
            !Buffer.isBuffer(bytes) ||
            bytes.length > JSON_LIMIT ||
            !equal(ref, refFor(ref.path, bytes)) ||
            seen.has(ref.path.toLowerCase())
        )
            fail("ENTRY_METADATA");
        seen.add(ref.path.toLowerCase());
        total += bytes.length;
        if (total > ARTIFACT_LIMIT - 65536) fail("ENTRY_METADATA");
        return {
            path: `${String(index).padStart(3, "0")}-${ref.path.split("/").at(-1)}`,
            consumerRef: { ...ref },
            sizeBytes: bytes.length,
            sha256: hash(bytes),
            bytes: Buffer.from(bytes),
        };
    });
}

/**
 * 调用者提供尚不存在的独占保留根，所有文档在创建目录之前一次性检查并复制持有；清单只描述本次有限副本，
 * 收据原路径与摘要不变，最终使用者能够据此区分原消费命名空间和下载元数据位置。
 */
export async function sealMetadata(root, documents) {
    const planned = metadataPlan(documents);
    const manifest = {
        format: "VERIQ_ENTRY_CI_METADATA_V1",
        files: planned.map(({ bytes: _bytes, ...item }) => item),
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest) + "\n");
    if (
        manifestBytes.length > JSON_LIMIT ||
        manifestBytes.length + planned.reduce((n, v) => n + v.sizeBytes, 0) > ARTIFACT_LIMIT
    )
        fail("ENTRY_METADATA");
    await mkdir(root, { mode: 0o700 });
    for (const item of planned)
        await writeFile(join(root, item.path), item.bytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(root, "manifest.json"), manifestBytes, {
        flag: "wx",
        mode: 0o600,
    });
    await verifyMetadata(root);
    return manifest;
}

/**
 * 下载或上传前独立核查保留根、清单以及恰好这些普通单链接副本，额外文件和链接一律拒绝；这里核的是元数据副本自身字节，
 * 绝不根据下载后的收据声称已重新哈希未保留的入口或依赖正文。
 */
export async function verifyMetadata(root) {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o7777) !== 0o700)
        fail("ENTRY_METADATA");
    const read = async (path) => {
        const info = await lstat(join(root, path), { bigint: true });
        if (
            !info.isFile() ||
            info.nlink !== 1n ||
            info.size > BigInt(JSON_LIMIT) ||
            (info.mode & 0o7777n) !== 0o600n
        )
            fail("ENTRY_METADATA");
        const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            if (!same(info, await handle.stat({ bigint: true }))) fail("ENTRY_METADATA");
            const chunks = [];
            let size = 0;
            for await (const bytes of handle.createReadStream({ autoClose: false })) {
                size += bytes.length;
                if (size > Number(info.size)) fail("ENTRY_METADATA");
                chunks.push(bytes);
            }
            if (
                !same(info, await handle.stat({ bigint: true })) ||
                !same(info, await lstat(join(root, path), { bigint: true }))
            )
                fail("ENTRY_METADATA");
            return Buffer.concat(chunks);
        } finally {
            await handle.close();
        }
    };
    const manifestBytes = await read("manifest.json");
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
    if (
        manifest.format !== "VERIQ_ENTRY_CI_METADATA_V1" ||
        !Array.isArray(manifest.files) ||
        manifest.files.length > 128
    )
        fail("ENTRY_METADATA");
    const names = await readdir(root);
    if (!equal(names.sort(), ["manifest.json", ...manifest.files.map((v) => v.path)].sort()))
        fail("ENTRY_METADATA");
    let total = manifestBytes.length;
    const refs = new Set();
    for (const item of manifest.files) {
        portable(item.path, "ENTRY_METADATA");
        portable(item.consumerRef?.path, "ENTRY_METADATA");
        if (item.path.includes("/") || refs.has(item.consumerRef.path.toLowerCase()))
            fail("ENTRY_METADATA");
        refs.add(item.consumerRef.path.toLowerCase());
        const bytes = await read(item.path);
        total += bytes.length;
        if (
            total > ARTIFACT_LIMIT ||
            !equal(item.consumerRef, refFor(item.consumerRef.path, bytes)) ||
            item.sizeBytes !== bytes.length ||
            item.sha256 !== hash(bytes)
        )
            fail("ENTRY_METADATA");
    }
    return manifest;
}

/**
 * 生产回调完成仍只是暂定结果，实际命令观察必须在返回生产器之前先记入调用者日志；未知关闭或事务不完整立即禁止最终扫描和
 * 清理，普通失败则保留首错并在已确认关闭后释放调用者资源。
 */
export async function runEntryOperation({ journal, produce, verifyFinal, cleanup }) {
    let first,
        value,
        unknown = false;
    const command = async (invocation) => {
        const item = { invocation: structuredClone(invocation), started: now() };
        journal.commands.push(item);
        let result;
        try {
            result = await runBoundedAssetCli(invocation);
        } catch (error) {
            unknown = true;
            throw error;
        }
        item.finished = now();
        const { stdout, stderr, ...observation } = result;
        item.observation = observation;
        item.stdout = Buffer.from(stdout);
        item.stderr = Buffer.from(stderr);
        if (result.closeConfirmed !== true) unknown = true;
        return result;
    };
    try {
        value = await produce(command);
        if (unknown) fail("ENTRY_UNKNOWN_CLOSE");
        if (journal.commands.some((item) => !commandPass(item.observation)))
            fail("ENTRY_COMMAND_FAILED");
        await verifyFinal();
    } catch (error) {
        first = error;
        unknown ||= error.cleanup === "INCOMPLETE";
        for (const name of Object.keys(journal.stages ?? {}))
            if (journal.stages[name] === "STARTED")
                journal.stages[name] = unknown ? "INCOMPLETE" : "FAILED";
    }
    if (!unknown)
        try {
            await cleanup();
        } catch (error) {
            first ??= error;
            journal.cleanupError = error.code ?? error.message ?? "ENTRY_CLEANUP_FAILED";
            unknown = true;
        }
    const result = {
        status: unknown ? "INCOMPLETE" : first ? "FAILED" : "PASS",
        error: first ? (first.code ?? first.message ?? "ENTRY_FAILED") : null,
    };
    journal.final = result;
    return { ...result, value };
}

/**
 * 已安装 TypeScript 负责解析真实 JSONC 与 extends，读取钩子只允许完整来源绑定中的配置字节；配置结果不写入制品，
 * 记录仅含路径和摘要，并用空目录枚举避免无关源码 glob 扩大资格检查范围。
 */
export function qualifyTypeScriptConfigs(root, refs, ts) {
    const bound = new Map(refs.map((v) => [resolve(root, v.path), v])),
        reads = new Map();
    const read = (path) => {
        const absolute = resolve(path),
            ref = bound.get(absolute);
        if (!ref || !contained(root, absolute)) fail("ENTRY_CONFIG");
        const text = ts.sys.readFile(absolute);
        if (text === undefined) fail("ENTRY_CONFIG");
        const bytes = Buffer.from(text);
        if (!equal(ref, refFor(ref.path, bytes))) fail("ENTRY_CONFIG");
        reads.set(ref.path, ref);
        return text;
    };
    const host = {
        useCaseSensitiveFileNames: true,
        getCurrentDirectory: () => root,
        readDirectory: () => [],
        fileExists: (path) => {
            const present = ts.sys.fileExists(path);
            if (present && !bound.has(resolve(path))) fail("ENTRY_CONFIG");
            return present;
        },
        readFile: read,
        onUnRecoverableConfigFileDiagnostic: () => fail("ENTRY_CONFIG"),
    };
    for (const ref of refs.filter((v) =>
        /(^|\/)(?:tsconfig|jsconfig)(?:[.][^/]*)?\.json$/.test(v.path),
    )) {
        const parsed = ts.getParsedCommandLineOfConfigFile(join(root, ref.path), {}, host);
        if (!parsed || parsed.errors.some((v) => ![18002, 18003].includes(v.code)))
            fail("ENTRY_CONFIG");
    }
    return { reads: [...reads.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

// 此私有错误只承载由固定环境门禁构造的有限诊断，仍保留原有 ENTRY_ENVIRONMENT 消息与失败退出；
// 序列化在构造时固定且不接受
// 底层错误正文，CLI 只渲染这个类，避免任意异常伪造同名属性泄漏输入值。
class EntryEnvironmentError extends Error {
    constructor(diagnostic) {
        super("ENTRY_ENVIRONMENT");
        Object.defineProperty(this, "diagnostic", { value: Object.freeze(diagnostic) });
        Object.defineProperty(this, "serializedDiagnostic", { value: JSON.stringify(diagnostic) });
    }
}

/**
 * 正式进程只接收工作流显式传入的最小环境，启动 Node 与注册 tsx 之前已由 env 清空继承值；这里再次验证键集合与生产模式，
 * 不打印环境值、凭据或配置正文；此谓词始终严格，批准的 Mac 元数据删除只能在上游启动边界完成。
 */
export function checkCleanEnvironment(env) {
    const allowed = new Set([
        "PATH",
        "HOME",
        "LANG",
        "CI",
        "NODE_ENV",
        "NODE_DISABLE_COMPILE_CACHE",
        "TMPDIR",
        "TSX_TMPDIR",
        "XDG_CACHE_HOME",
        "ELECTRON_SKIP_BINARY_DOWNLOAD",
        "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
        "GITHUB_EVENT_NAME",
        "GITHUB_SHA",
        "GITHUB_WORKSPACE",
        "GITHUB_RUN_ID",
        "GITHUB_RUN_ATTEMPT",
        "GITHUB_OUTPUT",
        "ENTRY_PURPOSE",
        "MANUAL_SOURCE",
        "EXPECTED_ARCH",
        "ENTRY_OWNED_ROOT",
        "npm_config_userconfig",
        "npm_config_globalconfig",
        "npm_config_cache",
        "npm_config_registry",
    ]);
    const unexpected = Object.keys(env)
            .filter((key) => !allowed.has(key))
            .sort(),
        productionModeMatch = env.NODE_ENV === "production",
        compileCacheDisabled = env.NODE_DISABLE_COMPILE_CACHE === "1";
    if (unexpected.length || !productionModeMatch || !compileCacheDisabled) {
        // 键名仅截取排序后的前十六项，合法 ASCII 环境名最长九十六字符，空白、换行或非 ASCII 一律替换固定占位；
        // 加上固定字段后序列化小于四 KiB，实际环境值从未进入诊断对象。
        const names = unexpected
            .slice(0, 16)
            .map((key) =>
                /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
                    ? key.slice(0, 96)
                    : "INVALID_ENVIRONMENT_NAME",
            )
            .sort();
        throw new EntryEnvironmentError({
            phase: "INITIAL",
            unexpectedNamePresent: unexpected.length > 0,
            productionModeMatch,
            compileCacheDisabled,
            unexpectedNameCount: unexpected.length,
            unexpectedNames: Object.freeze(names),
        });
    }
    return {
        allowedNames: Object.keys(env).sort(),
        nodeEnv: "production",
        inheritedInjection: false,
    };
}

/**
 * 启动边界先核完整原生资格，再丢弃唯一批准的自有元数据键并执行原严格门禁；宿主样本仅供便携测试。
 * 正式入口只传实际进程事实。不合格调用不修改环境，先保留原严格诊断再拒绝；丢弃结果只记录布尔值，
 * 不声称框架内部状态或子进程环境已被重置。
 */
export function qualifyEntryStartup(env, host) {
    let admission;
    try {
        admission = admitEntryRun({
            event: env.GITHUB_EVENT_NAME,
            purpose: env.ENTRY_PURPOSE,
            source: env.MANUAL_SOURCE,
            commit: env.GITHUB_SHA,
            platform: host.platform,
            arch: host.arch,
            expectedArch: env.EXPECTED_ARCH,
            release: host.release,
            nodeVersion: host.nodeVersion,
        });
        if (env.CI !== "true" || host.electron || host.argumentCount !== 2) fail("ENTRY_ADMISSION");
    } catch (error) {
        checkCleanEnvironment(env);
        throw error;
    }
    let macTextEncodingDiscarded = false;
    try {
        macTextEncodingDiscarded = Object.hasOwn(env, "__CF_USER_TEXT_ENCODING");
        if (macTextEncodingDiscarded && !Reflect.deleteProperty(env, "__CF_USER_TEXT_ENCODING"))
            fail("ENTRY_ENVIRONMENT");
        if (Object.hasOwn(env, "__CF_USER_TEXT_ENCODING")) fail("ENTRY_ENVIRONMENT");
    } catch {
        throw new EntryEnvironmentError({ phase: "MAC_METADATA", invariant: "ABSENCE_UNCONFIRMED" });
    }
    return { admission, qualification: checkCleanEnvironment(env), macTextEncodingDiscarded };
}

/**
 * 后置环境检查保留原主函数的九项固定路径与下载标志比较，并在同一创建目录之后的位置调用；独立导出仅为逐项验证真实拒绝边
 * 界，不接受调用者提供期望映射，也不修改现有环境、命令顺序或允许集合。
 */
export function checkOwnedEnvironment(env, owned) {
    for (const [key, expected] of Object.entries({
        TMPDIR: join(owned, "tmp"),
        TSX_TMPDIR: join(owned, "tmp"),
        XDG_CACHE_HOME: join(owned, "toolcache"),
        npm_config_userconfig: join(owned, "user.npmrc"),
        npm_config_globalconfig: join(owned, "global.npmrc"),
        npm_config_cache: join(owned, "npm-cache"),
        npm_config_registry: "https://registry.npmjs.org/",
        ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    }))
        if (env[key] !== expected)
            throw new EntryEnvironmentError({ phase: "OWNED_PATHS", invariant: key });
}

// 工具不属于来源树，允许 pnpm 安装的真实链接与工具执行权限，但固定真实路径并流式读取有界文件；只保留身份、模式、
// 链接数和摘要，不把本机可执行内容或整份依赖包上传为所谓载荷证据。
async function toolIdentity(path) {
    const fixed = await realpath(path),
        before = await lstat(fixed, { bigint: true });
    if (
        !before.isFile() ||
        before.nlink < 1n ||
        before.size > 256n * 1024n ** 2n ||
        ![0o400, 0o600, 0o444, 0o644, 0o555, 0o755].includes(Number(before.mode & 0o7777n))
    )
        fail("ENTRY_TOOL");
    const handle = await open(fixed, constants.O_RDONLY | constants.O_NOFOLLOW),
        digest = createHash("sha256");
    let sizeBytes = 0;
    try {
        if (!same(before, await handle.stat({ bigint: true }))) fail("ENTRY_TOOL");
        for await (const bytes of handle.createReadStream({ autoClose: false })) {
            sizeBytes += bytes.length;
            if (sizeBytes > Number(before.size)) fail("ENTRY_TOOL");
            digest.update(bytes);
        }
        if (
            !same(before, await handle.stat({ bigint: true })) ||
            !same(before, await lstat(fixed, { bigint: true })) ||
            (await realpath(path)) !== fixed ||
            sizeBytes !== Number(before.size)
        )
            fail("ENTRY_TOOL");
    } finally {
        await handle.close();
    }
    return {
        path: fixed,
        sizeBytes,
        sha256: digest.digest("hex"),
        mode: Number(before.mode & 0o7777n),
        links: Number(before.nlink),
    };
}

// 完整 Git 清单按一百个路径分批读取，避免现有进程管理器六十四 KiB stdout 限制；对象正文经原生 Git 和系统 shasum
// 的有界管道流过，不落盘或上传，工作字节摘要与对象摘要独立取得后逐项相等。
async function bindCheckout(root, commit, command) {
    const invoke = async (args) => {
        const result = await command({
            executable: "/usr/bin/git",
            args,
            cwd: root,
            timeoutMs: 5 * 60000,
        });
        if (!commandPass(result)) fail("ENTRY_GIT");
        return result.stdout;
    };
    if ((await invoke(["rev-parse", "HEAD"])).toString().trim() !== commit) fail("ENTRY_GIT");
    if ((await invoke(["status", "--porcelain", "--untracked-files=no"])).length) fail("ENTRY_GIT");
    const names = (await invoke(["ls-tree", "-r", "-z", "--name-only", commit]))
        .toString()
        .split("\0")
        .slice(0, -1);
    if (!names.length || names.length > 40000) fail("ENTRY_GIT");
    const rows = [],
        sizes = new Map();
    for (let index = 0; index < names.length; index += 100) {
        const bytes = await invoke([
            "ls-tree",
            "-r",
            "-l",
            "-z",
            commit,
            "--",
            ...names.slice(index, index + 100),
        ]);
        for (const row of bytes.toString().split("\0").slice(0, -1)) {
            const match = /^(\d+) blob ([a-f0-9]{40})\s+(\d+)\t(.+)$/.exec(row);
            if (!match) fail("ENTRY_GIT");
            sizes.set(match[4], Number(match[3]));
            rows.push(`${match[1]} blob ${match[2]}\t${match[4]}\0`);
        }
    }
    const inventory = selectGitInventory(Buffer.from(rows.join("")));
    if (
        inventory.selected.length + inventory.excluded.length !== names.length ||
        !equal(inventory.excluded.map((v) => v.path).sort(), EXECUTABLE_EXCLUSIONS)
    )
        fail("ENTRY_GIT");
    const pipeline =
        'set -euo pipefail; for oid in "$@"; do /usr/bin/git cat-file blob "$oid" | /usr/bin/shasum -a 256; done';
    const hashes = await command({
        executable: "/bin/bash",
        args: [
            "--noprofile",
            "--norc",
            "-c",
            pipeline,
            "git-blob-digests",
            ...inventory.selected.map((v) => v.gitBlob),
        ],
        cwd: root,
        timeoutMs: 5 * 60000,
    });
    if (!commandPass(hashes)) fail("ENTRY_GIT");
    const digestLines = hashes.stdout.toString().trimEnd().split("\n");
    if (digestLines.length !== inventory.selected.length) fail("ENTRY_GIT");
    const files = [],
        physical = [];
    for (const [index, item] of inventory.selected.entries()) {
        if (!/^[a-f0-9]{64}  -$/.test(digestLines[index])) fail("ENTRY_GIT");
        const ref = {
            path: item.path,
            sizeBytes: sizes.get(item.path),
            sha256: digestLines[index].slice(0, 64),
        };
        await readSourceFile(root, ref);
        const info = await lstat(join(root, item.path));
        files.push(ref);
        physical.push({
            ...item,
            ...ref,
            mode: info.mode & 0o7777,
            gitMode: item.mode,
            links: info.nlink,
        });
    }
    return {
        source: { schemaVersion: 1, kind: "SOURCE_BINDING", commit, files },
        inventory: {
            selected: physical,
            excluded: inventory.excluded,
            tracked: names.length,
            selectedCount: files.length,
        },
    };
}

// 原始日志来自已结算管理器观察，持有副本不会重新访问未知构建目录；单份日志若超过保留预算则明确保存有限前缀及原始全长摘
// 要，日志清单也会注明截断，禁止把前缀摘要冒充完整原始日志身份。
function journalDocuments(journal) {
    const documents = [],
        serial = { ...journal, commands: [] };
    for (const [index, item] of journal.commands.entries()) {
        const { stdout, stderr, ...rest } = item,
            logs = {};
        for (const [kind, bytes] of [
            ["stdout", stdout],
            ["stderr", stderr],
        ])
            if (bytes) {
                const held = bytes.subarray(0, 65536),
                    path = `ci/command-${index}.${kind}`,
                    ref = refFor(path, held);
                documents.push({ ref, bytes: held });
                logs[kind] = {
                    retainedRef: ref,
                    originalSizeBytes: bytes.length,
                    originalSha256: hash(bytes),
                    retainedTruncated: held.length !== bytes.length,
                };
            }
        serial.commands.push({ ...rest, logs });
    }
    const bytes = Buffer.from(JSON.stringify(serial) + "\n");
    documents.push({ ref: refFor("ci/journal.json", bytes), bytes });
    return documents;
}

// 消费窗口只读取生产器已经登记的两个树，文档复用正式 schema 与 reader，正文另外从树根读取；原始来源快照、实际 trace、
// 完整库存和字面导入都在窗口内核验，返回的保留物只含元数据而无源代码或入口正文。
async function verifyLiveViews({
    inputRoot,
    trees,
    source,
    builds,
    modules,
    retain,
    journal,
    tools,
}) {
    const {
        InputReader,
        contentLimit,
        document,
        schemas,
        scanRuntimeLiteralImports,
        classifyRuntimeModuleEdge,
    } = modules;
    assert.equal(trees.entries.root, "entries");
    assert.equal(trees.execution.root, "execution");
    const reader = new InputReader(inputRoot, undefined, ["entries", "execution"]);
    await reader.initialize();
    const keep = async (ref) => {
        const bytes = await reader.ref(ref, true);
        retain(ref, bytes);
        return bytes;
    };
    const fixed = async (name) => {
        const path = `input-evidence/${name}`,
            raw = await readFile(join(inputRoot, path));
        if (raw.length > JSON_LIMIT) fail("ENTRY_METADATA");
        const ref = refFor(path, raw);
        await keep(ref);
        return { ref, value: JSON.parse(raw.toString()) };
    };
    const sourceDocument = await fixed("source-binding.json");
    assert.deepEqual(await document(reader, sourceDocument.ref, schemas.source), source);
    const trace = (await fixed("vite-observation.json")).value;
    if (
        !Array.isArray(trace.sources) ||
        !Array.isArray(trace.outputs) ||
        trace.sources.length > 40000 ||
        trace.outputs.length > 40000
    )
        fail("ENTRY_TRACE");
    const sources = new Map(source.files.map((v) => [v.path, v]));
    for (const ref of source.files) await reader.ref(ref, false, contentLimit(ref.path), false);
    for (const path of trace.sources) if (!sources.has(path)) fail("ENTRY_TRACE");
    for (const required of ["apps/desktop/src/agent/index.ts", "apps/runtime/src/cli.ts"])
        if (!trace.sources.includes(required)) fail("ENTRY_TRACE");
    const verified = {},
        receipts = {};
    for (const kind of ["entries", "execution"]) {
        const bound = trees[kind],
            inventory = await document(reader, bound.inventory, schemas.inventory),
            receipt = await document(reader, bound.buildReceipt, schemas[kind]);
        await keep(bound.inventory);
        await keep(bound.buildReceipt);
        const { commandEvidence, ...build } = receipt.build;
        assert.deepEqual(build, builds[kind]);
        assert.equal(receipt.treeInventorySha256, bound.inventory.sha256);
        assert.deepEqual(inventory.links, []);
        assert.ok(inventory.files.every((v) => v.mode === 0o644));
        const facts = await reader.tree(bound, inventory, kind);
        await keep(commandEvidence);
        const bodyReader = new InputReader(join(inputRoot, bound.root), undefined, []);
        await bodyReader.initialize();
        const bodies = [];
        for (const file of inventory.files) {
            const bytes = await bodyReader.ref(
                file,
                true,
                /\.(?:js|mjs|cjs)$/.test(file.path) ? 16 * 1024 ** 2 : contentLimit(file.path),
                false,
            );
            const physical = await lstat(join(inputRoot, bound.root, file.path));
            assert.equal(physical.mode & 0o7777, file.mode);
            assert.equal(physical.nlink, 1);
            bodies.push({
                ...refFor(file.path, bytes),
                mode: physical.mode & 0o7777,
                links: physical.nlink,
            });
            const imports = /\.(?:js|mjs|cjs)$/.test(file.path)
                ? scanRuntimeLiteralImports(bytes, file.path).map((edge) =>
                      classifyRuntimeModuleEdge(
                          edge,
                          file.path,
                          inventory.files,
                          kind === "execution",
                      ),
                  )
                : [];
            if (kind === "entries") {
                const output = receipt.outputs.find((v) => v.path === file.path),
                    actual = trace.outputs.find((v) => v.path === file.path);
                assert.ok(output && actual);
                assert.deepEqual(output.imports, imports);
                assert.equal(actual.kind, output.kind);
                assert.equal(actual.sizeBytes, bytes.length);
                assert.equal(actual.sha256, hash(bytes));
                if (output.kind === "asset") assert.deepEqual(imports, []);
                assert.ok(
                    imports.every(
                        (v) => v.kind !== "external" || !v.specifier.startsWith("@veriq/"),
                    ),
                );
            }
        }
        await bodyReader.finish();
        receipts[kind] = receipt;
        verified[kind] = { ...facts, files: bodies };
        if (kind === "entries") {
            assert.deepEqual(receipt.entrypoints, { agent: "agent.js", cli: "cli.js" });
            assert.deepEqual(
                receipt.outputs.map((v) => v.path).sort(),
                inventory.files.map((v) => v.path).sort(),
            );
            assert.deepEqual(
                trace.outputs.map((v) => v.path).sort(),
                inventory.files.map((v) => v.path).sort(),
            );
            const cmd = JSON.parse((await reader.ref(commandEvidence, true)).toString()),
                observed = journal.commands.at(-1);
            assert.equal(cmd.operation, "VITE_BUILD");
            const { timeoutMs: requestedTimeout, ...requestedCommand } = cmd.invocation;
            const { timeoutMs: actualTimeout, ...actualCommand } = observed.invocation;
            assert.deepEqual(requestedCommand, actualCommand);
            assert.ok(actualTimeout > 0 && actualTimeout <= requestedTimeout);
            assert.equal(cmd.host.platform, "darwin");
            assert.equal(cmd.host.arch, process.arch);
            const { stdout, stderr, ...settlement } = cmd.observation;
            assert.ok(commandPass(settlement));
            assert.deepEqual(settlement, observed.observation);
            assert.deepEqual(await keep(stdout), observed.stdout);
            assert.deepEqual(await keep(stderr), observed.stderr);
            assert.ok(cmd.started <= observed.started && observed.finished <= cmd.finished);
            assert.deepEqual(
                cmd.tools.map((v) => v.name),
                ["node", "vite"],
            );
            for (const identity of cmd.tools.flatMap((v) => v.files)) {
                assert.deepEqual(await toolIdentity(identity.path), identity);
                assert.ok(
                    tools.some(({ requestedPath: _requestedPath, ...bound }) =>
                        equal(bound, identity),
                    ),
                );
            }
        } else {
            const names = [
                "worker",
                "provider",
                "compile-entry",
                "archive",
                "controlled-command",
                "controlled-child",
                "controlled-child-protocol",
                "controlled-child-preload",
            ].map((v) => `${v}.mjs`);
            assert.deepEqual(receipt.members.map((v) => v.path).sort(), names.sort());
            assert.deepEqual(inventory.files.map((v) => v.path).sort(), names.sort());
            for (const member of receipt.members) {
                assert.equal(member.sourcePath, `apps/runtime/src/execution/${member.path}`);
                assert.equal(sources.get(member.sourcePath)?.sha256, member.sha256);
                assert.equal(
                    inventory.files.find((v) => v.path === member.path)?.sha256,
                    member.sha256,
                );
            }
            const copy = JSON.parse((await reader.ref(commandEvidence, true)).toString());
            assert.equal(copy.operation, "IN_PROCESS_SOURCE_COPY");
            assert.equal(copy.host.pid, process.pid);
            assert.equal(copy.host.platform, "darwin");
            assert.equal(copy.host.arch, process.arch);
            assert.equal("exit" in copy, false);
            assert.deepEqual(copy.members.slice().sort(), names.sort());
            assert.deepEqual(copy.producer, builds.execution.producer);
            assert.ok(copy.started <= copy.finished);
            assert.deepEqual(await toolIdentity(copy.node.files[0].path), copy.node.files[0]);
            assert.equal(copy.node.name, "node");
            assert.equal(copy.node.version, process.version);
        }
    }
    await reader.finish();
    journal.callback = {
        status: "VERIFIED_PROVISIONAL",
        trees,
        sourceSnapshots: source.files.length,
        originalLock: sources.get("pnpm-lock.yaml"),
        verified,
    };
    return { reader, receipts };
}

// 入口函数在显式执行时才加载 tsx 和 TypeScript 产品模块，全部安装及命令仍经现有有界管理器；独占父根内的事务和构建目录互
// 为兄弟，最终来源、配置与工具复核成功后才把回调暂定结果升级为输入物化通过。
async function main() {
    const env = process.env,
        { admission, qualification, macTextEncodingDiscarded } = qualifyEntryStartup(env, {
            platform: process.platform,
            arch: process.arch,
            release: release(),
            nodeVersion: process.version,
            electron: process.versions.electron,
            argumentCount: process.argv.length,
        });
    const sourceRoot = await realpath(env.GITHUB_WORKSPACE),
        owned = resolve(env.ENTRY_OWNED_ROOT);
    if (
        !isAbsolute(env.ENTRY_OWNED_ROOT) ||
        contained(sourceRoot, owned) ||
        contained(owned, sourceRoot) ||
        owned !== env.ENTRY_OWNED_ROOT
    )
        fail("ENTRY_OWNERSHIP");
    await mkdir(owned, { mode: 0o700 });
    for (const name of ["tmp", "toolcache", "tools", "transaction", "build"])
        await mkdir(join(owned, name), { mode: 0o700 });
    for (const name of ["user.npmrc", "global.npmrc"])
        await writeFile(join(owned, name), "", { flag: "wx", mode: 0o600 });
    checkOwnedEnvironment(env, owned);
    const documents = [],
        heldPaths = new Set(),
        retain = (ref, bytes) => {
            if (heldPaths.has(ref.path)) {
                const old = documents.find((v) => v.ref.path === ref.path);
                if (!equal(old.ref, ref) || !old.bytes.equals(bytes)) fail("ENTRY_METADATA");
                return;
            }
            documents.push({ ref: { ...ref }, bytes: Buffer.from(bytes) });
            heldPaths.add(ref.path);
        };
    const keepJson = (path, value) => {
        const bytes = Buffer.from(JSON.stringify(value) + "\n");
        retain(refFor(path, bytes), bytes);
    };
    const journal = {
        admission,
        environment: qualification,
        macTextEncodingDiscarded,
        run: env.GITHUB_RUN_ID,
        attempt: env.GITHUB_RUN_ATTEMPT,
        started: now(),
        commands: [],
        stages: Object.fromEntries(
            ["source", "tooling", "install", "guards", "build", "final", "cleanup"].map((name) => [
                name,
                "NOT_RUN",
            ]),
        ),
    };
    let active,
        work,
        before,
        tools = [],
        ts,
        callback,
        unregister;
    journal.tools = tools;
    const rememberTool = async (path) => ({ ...(await toolIdentity(path)), requestedPath: path });
    const buildRoot = join(owned, "build"),
        buildIdentity = await lstat(buildRoot, { bigint: true }),
        deadline = Date.now() + 23 * 60000;
    const stage = (name) => {
        active = name;
        journal.stages[name] = "STARTED";
    };
    const result = await runEntryOperation({
        journal,
        produce: async (rawCommand) => {
            const command = async (invocation) => {
                const timeoutMs = Math.min(invocation.timeoutMs, deadline - Date.now(), 16 * 60000);
                if (timeoutMs <= 0) fail("ENTRY_DEADLINE");
                return rawCommand({ ...invocation, timeoutMs });
            };
            const checkedCommand = async (
                executable,
                args,
                cwd = sourceRoot,
                timeoutMs = 5 * 60000,
            ) => {
                const observed = await command({ executable, args, cwd, timeoutMs });
                if (!commandPass(observed)) fail("ENTRY_COMMAND_FAILED");
                return observed;
            };
            stage("source");
            before = await bindCheckout(sourceRoot, admission.commit, command);
            keepJson("ci/git-before.json", before.inventory);
            keepJson("ci/source-binding.json", before.source);
            keepJson(
                "ci/ambient-before.json",
                await qualifyAmbientInputs(sourceRoot, before.source.files),
            );
            journal.stages.source = "PASS";
            const available = await statfs(owned, { bigint: true });
            journal.diskAvailableBefore = String(available.bavail * available.bsize);
            if (available.bavail * available.bsize < 512n * 1024n ** 2n) fail("ENTRY_DISK");
            stage("tooling");
            const npm = resolve(
                    dirname(process.execPath),
                    "../lib/node_modules/npm/bin/npm-cli.js",
                ),
                npmPackage = resolve(dirname(npm), "../package.json");
            tools.push(
                await rememberTool(process.execPath),
                await rememberTool(npm),
                await rememberTool(npmPackage),
            );
            await checkedCommand(
                process.execPath,
                [
                    npm,
                    "install",
                    "--prefix",
                    join(owned, "tools"),
                    "pnpm@11.25.0",
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                ],
                sourceRoot,
                5 * 60000,
            );
            const pnpmRoot = join(owned, "tools/node_modules/pnpm"),
                pnpm = join(pnpmRoot, "bin/pnpm.mjs"),
                pkg = JSON.parse(await readFile(join(pnpmRoot, "package.json"), "utf8"));
            if (
                pkg.name !== "pnpm" ||
                pkg.version !== "11.25.0" ||
                pkg.bin?.pnpm !== "bin/pnpm.mjs"
            )
                fail("ENTRY_TOOL");
            for (const path of [
                pnpm,
                join(pnpmRoot, "dist/pnpm.mjs"),
                join(pnpmRoot, "package.json"),
            ])
                tools.push(await rememberTool(path));
            const pnpmVersion = await checkedCommand(process.execPath, [pnpm, "--version"]);
            if (pnpmVersion.stdout.toString().trim() !== "11.25.0") fail("ENTRY_TOOL");
            journal.stages.tooling = "PASS";
            stage("install");
            await checkedCommand(
                process.execPath,
                [
                    pnpm,
                    "install",
                    "--frozen-lockfile",
                    "--ignore-scripts",
                    "--ignore-pnpmfile",
                    "--prod=false",
                    "--store-dir",
                    join(owned, "store"),
                ],
                sourceRoot,
                10 * 60000,
            );
            journal.stages.install = "PASS";
            // 工具版本同时与已绑定包清单的精确声明核对，tsx 注册 API、实际 loader、Vite CLI 与模块以及 TypeScript
            // 实现都各有身份；这只说明本次构建工具资格，并不认证完整传递依赖闭包。
            const runtimePackage = JSON.parse(
                    await readSourceFile(
                        sourceRoot,
                        before.source.files.find((v) => v.path === "apps/runtime/package.json"),
                    ),
                ),
                desktopPackage = JSON.parse(
                    await readSourceFile(
                        sourceRoot,
                        before.source.files.find((v) => v.path === "apps/desktop/package.json"),
                    ),
                );
            const viteRoot = join(sourceRoot, "apps/desktop/node_modules/vite"),
                tsxRoot = join(sourceRoot, "apps/runtime/node_modules/tsx"),
                tsRoot = join(sourceRoot, "apps/runtime/node_modules/typescript");
            for (const [root, name, version, members] of [
                [
                    viteRoot,
                    "vite",
                    desktopPackage.devDependencies.vite,
                    ["bin/vite.js", "dist/node/index.js"],
                ],
                [
                    tsxRoot,
                    "tsx",
                    runtimePackage.dependencies.tsx,
                    ["dist/loader.mjs", "dist/esm/api/index.mjs"],
                ],
                [
                    tsRoot,
                    "typescript",
                    runtimePackage.devDependencies.typescript,
                    ["lib/typescript.js"],
                ],
            ]) {
                const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
                if (manifest.name !== name || manifest.version !== version) fail("ENTRY_TOOL");
                for (const path of ["package.json", ...members])
                    tools.push(await rememberTool(join(root, path)));
            }
            keepJson("ci/tools-before.json", tools);
            ts = (await import(pathToFileURL(join(tsRoot, "lib/typescript.js")).href)).default;
            keepJson(
                "ci/config-before.json",
                qualifyTypeScriptConfigs(sourceRoot, before.source.files, ts),
            );
            await qualifyAmbientInputs(sourceRoot, before.source.files);
            for (const ref of before.source.files) await readSourceFile(sourceRoot, ref);
            stage("guards");
            await checkedCommand(
                process.execPath,
                [
                    "--import",
                    join(tsxRoot, "dist/loader.mjs"),
                    "--test",
                    "apps/runtime/tests/runtime-entries-ci.test.mjs",
                    "apps/runtime/tests/runtime-payload-entries.test.ts",
                    "apps/runtime/tests/runtime-payload-graph.test.ts",
                ],
                sourceRoot,
                3 * 60000,
            );
            journal.stages.guards = "PASS";
            const api = await import(pathToFileURL(join(tsxRoot, "dist/esm/api/index.mjs")).href);
            unregister = api.register();
            const load = (path) => import(pathToFileURL(join(sourceRoot, path)).href);
            const [
                { withEntryInputViews },
                { ArchiveTransaction },
                tree,
                receipts,
                graph,
                { canonicalBytes },
            ] = await Promise.all([
                load("apps/runtime/scripts/runtime-payload-entries.ts"),
                load("apps/runtime/scripts/runtime-payload-transaction.ts"),
                load("apps/runtime/scripts/runtime-payload-tree.ts"),
                load("apps/runtime/scripts/runtime-payload-receipts.ts"),
                load("apps/runtime/scripts/runtime-payload-graph.ts"),
                load("packages/contracts/src/index.ts"),
            ]);
            const source = before.source,
                find = (path) => {
                    const ref = source.files.find((v) => v.path === path);
                    if (!ref) fail("ENTRY_SOURCE");
                    return ref;
                },
                binding = {
                    commit: admission.commit,
                    sourceBindingSha256: hash(canonicalBytes(source)),
                    pnpmLockSha256: find("pnpm-lock.yaml").sha256,
                    target: { platform: "darwin", arch: admission.arch },
                    producer: find("apps/runtime/scripts/runtime-payload-entries.ts"),
                };
            const builds = {
                entries: {
                    ...binding,
                    config: find("apps/runtime/runtime.vite.config.mjs"),
                    toolNames: ["node", "vite"],
                },
                execution: { ...binding, config: binding.producer, toolNames: ["node"] },
            };
            stage("build");
            work = new ArchiveTransaction(
                sourceRoot,
                join(owned, "transaction"),
                "entry-inputs",
                undefined,
                "work",
            );
            await work.initialize();
            await withEntryInputViews(
                work,
                {
                    source,
                    ...builds,
                    buildRoot,
                    hostBuild: {
                        executable: process.execPath,
                        viteCli: join(viteRoot, "bin/vite.js"),
                        timeoutMs: Math.min(10 * 60000, deadline - Date.now()),
                        run: command,
                    },
                },
                async (inputRoot, trees) => {
                    callback = await verifyLiveViews({
                        inputRoot,
                        trees,
                        source,
                        builds,
                        modules: { ...tree, ...receipts, ...graph },
                        retain,
                        journal,
                        tools,
                    });
                },
            );
            journal.stages.build = "PASS";
            stage("final");
            const after = await bindCheckout(sourceRoot, admission.commit, command);
            assert.deepEqual(after, before);
            keepJson("ci/git-after.json", after.inventory);
            keepJson("ci/ambient-after.json", await qualifyAmbientInputs(sourceRoot, source.files));
            keepJson(
                "ci/config-after.json",
                qualifyTypeScriptConfigs(sourceRoot, source.files, ts),
            );
            for (const { requestedPath, ...identity } of tools)
                assert.deepEqual(await toolIdentity(requestedPath), identity);
            keepJson("ci/tools-after.json", tools);
        },
        verifyFinal: async () => {
            if (!callback || journal.stages.final !== "STARTED") fail("ENTRY_FINAL");
            await callback.reader.finish();
            await work.audit();
            journal.callback.status = "VERIFIED_FINAL";
            journal.stages.final = "PASS";
        },
        cleanup: async () => {
            stage("cleanup");
            if (work && !["CONFIRMED", "NOT_NEEDED"].includes(await work.cleanup()))
                fail("ENTRY_CLEANUP_INCOMPLETE");
            const current = await lstat(buildRoot, { bigint: true });
            if (!["dev", "ino", "mode"].every((key) => current[key] === buildIdentity[key]))
                fail("ENTRY_OWNERSHIP");
            await rm(buildRoot, { recursive: true });
            if (unregister) await unregister();
            journal.stages.cleanup = "PASS";
        },
    });
    if (active && journal.stages[active] === "STARTED") journal.stages[active] = result.status;
    journal.finished = now();
    journal.claim =
        "Two-tree entry input materialization only; no Runtime readiness, candidate execution, installed or MVP acce" +
            "ptance.";
    // 失败和未知关闭都只汇总早已持有的观察与元数据，不再扫描工作或构建目录；独立保留根经完整清单读回后才公开上传路径，
    // 后续工作流只允许上传这个根，工具缓存和源码目录绝不混入制品。
    documents.push(...journalDocuments(journal));
    await sealMetadata(join(owned, "metadata"), documents);
    await appendFile(
        env.GITHUB_OUTPUT,
        `collection=SNAPSHOTTED\nupload_root=${join(owned, "metadata")}\nmaterialization=${result.status}\n`,
    );
    console.log(`Entry input materialization: ${result.status}`);
    if (result.status !== "PASS") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        if (error instanceof EntryEnvironmentError)
            console.error(`Entry environment rejection: ${error.serializedDiagnostic}`);
        console.error(
            `Entry CI failed: ` +
                `${
                    /^[A-Z][A-Z0-9_]+$/.test(error.code ?? error.message) ? (
                        error.code ?? error.message) : "ENTRY_FAILURE"}`,
        );
        process.exitCode = 1;
    });
}
