import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";
import { isNode24Version } from "./node-version.ts";

/** Mac 静态库存只接受调用者明确选择的两种发行架构，不读取宿主平台替调用者猜测目标，也不由架构声明产生可执行能力；实际二进制架构和签名仍须在后续原生发行验收中证明。 */
export type MacRuntimeArch = "x64" | "arm64";
/** 普通文件记录原始相对路径、精确字节数与摘要和十进制权限，只有真实文件树逐项核验后才成为静态事实；字段不能授权执行，也不能代替发布者签名或具体版本的实际运行验证。 */
export type RuntimeFileV2 = Readonly<{
    path: string;
    sizeBytes: number;
    sha256: string;
    mode: number;
}>;
/** 链接条目保留未经规范化的相对目标，核验必须与可信布局以及物理链接逐字相等；目录别名只描述有限结构，不允许通过别名展开重复成员或扩大文件系统读取范围。 */
export type RuntimeLinkV2 = Readonly<{ path: string; target: string }>;
/** Chrome 布局是独立于待验证清单的可信输入，框架根和允许链接必须明确给出且受固定预算约束；合成测试布局不代表真实归档证据，也不允许从清单自举链接授权。 */
export type MacChromeLayout = Readonly<{
    bundlePath: string;
    executablePath: string;
    frameworkRoots: readonly string[];
    allowedLinks: readonly RuntimeLinkV2[];
}>;
/** 第二版清单完整列出物理目录、普通文件和有限链接，三集合互斥且覆盖全部非根成员；这里仅描述 Mac 静态库存，不含角色能力、签名状态或可以启动产品的就绪声明。 */
export type MacRuntimeManifestV2 = {
    schemaVersion: 2;
    platform: "darwin";
    arch: MacRuntimeArch;
    productVersion: string;
    nodeVersion: string;
    engineVersion: string;
    browser: {
        version: "158.0.8127.18";
        revision: "1254";
        bundlePath: string;
        executablePath: string;
    };
    directories: string[];
    files: RuntimeFileV2[];
    links: RuntimeLinkV2[];
};
/** 结果仅记录静止暂存树的一次完整性观察，清单摘要绑定原始字节而不是重序列化内容；深冻结避免调用者误改报告，执行授权、发布信任以及后续消费前复验由其它层负责。 */
export type MacRuntimeStaticInventory = Readonly<{
    kind: "MAC_RUNTIME_STATIC_INVENTORY";
    root: string;
    platform: "darwin";
    arch: MacRuntimeArch;
    manifestSha256: string;
    manifest: Readonly<MacRuntimeManifestV2>;
    regularFileCount: number;
    directoryCount: number;
    linkCount: number;
    totalFileBytes: number;
}>;
/** 固定预算在解析与真实枚举读取时同时执行，调用者不能传参放宽生产边界；大文件声明在分配正文前失败，累计字节仍按实际读取计数，不能靠清单自报大小规避资源限制。 */
export const MAC_RUNTIME_MANIFEST_V2_LIMITS = Object.freeze({
    manifestBytes: 4 * 1024 * 1024,
    totalEntries: 20000,
    links: 256,
    frameworkRoots: 32,
    pathBytes: 1024,
    componentBytes: 255,
    depth: 64,
    linkHops: 32,
    fileBytes: 2 * 1024 * 1024 * 1024,
    totalFileBytes: 16 * 1024 * 1024 * 1024,
});
/** 稳定错误码区分输入合同、物理库存与有限链接的拒绝原因，公开消息不回显清单正文或不受信任文件内容；调用者可以按码诊断失败，但不能把未知异常吞成成功或布尔假值。 */
export type MacRuntimeManifestErrorCode =
    | "MAC_MANIFEST_INVALID"
    | "MAC_MANIFEST_LIMIT"
    | "MAC_MANIFEST_PATH"
    | "MAC_MANIFEST_COLLISION"
    | "MAC_MANIFEST_LAYOUT"
    | "MAC_INVENTORY_ROOT"
    | "MAC_INVENTORY_MISSING"
    | "MAC_INVENTORY_UNLISTED"
    | "MAC_INVENTORY_TYPE"
    | "MAC_INVENTORY_HARDLINK"
    | "MAC_INVENTORY_MODE"
    | "MAC_INVENTORY_HASH"
    | "MAC_INVENTORY_CHANGED"
    | "MAC_LINK_FORBIDDEN"
    | "MAC_LINK_TARGET"
    | "MAC_LINK_CYCLE"
    | "MAC_LINK_LIMIT"
    | "MAC_INVENTORY_IO";
/** 清单错误保留稳定只读分类并使用固定英文消息，后续受控诊断只应包含经过筛选的系统错误分类；特别不能挂载原始 JSON 解析异常，因为其文本可能包含秘密或整个输入片段。 */
export class MacRuntimeManifestError extends Error {
    /** 错误实例在构造时固定分类属性，避免调用者后来改写 code 破坏诊断分支的一致性；受控 cause 由内部 I/O 映射提供，解析入口不保留可能包含清单正文的引擎异常。 */
    constructor(
        public readonly code: MacRuntimeManifestErrorCode,
        options?: ErrorOptions,
    ) {
        super(code, options);
        this.name = "MacRuntimeManifestError";
        Object.defineProperty(this, "code", { writable: false, configurable: false });
    }
}

type Expected = { arch: MacRuntimeArch; layout: MacChromeLayout };
type Policy = Readonly<Expected>;
const L = MAC_RUNTIME_MANIFEST_V2_LIMITS;
const manifestName = "runtime-manifest.json";
const fileModes = new Set([0o444, 0o644, 0o555, 0o755]);
const executableModes = new Set([0o555, 0o755]);

/** 所有拒绝都经过固定分类构造错误，不拼接不受信任的路径、清单正文或异常文本；这样解析失败与物理失败可以稳定诊断，同时避免 JSON 引擎在消息中暴露原始输入片段。 */
function fail(code: MacRuntimeManifestErrorCode): never {
    throw new MacRuntimeManifestError(code);
}

/** 精确对象结构只允许非数组对象和明确列出的自有字段，必需字段缺失也立即拒绝；随后仅复制已经逐项验证的原始值，不能深拷贝未经检查的任意对象或保留调用者可变引用。 */
function object(
    value: unknown,
    keys: readonly string[],
    code: MacRuntimeManifestErrorCode = "MAC_MANIFEST_INVALID",
): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
    const record = value as Record<string, unknown>;
    const names = Object.keys(record);
    if (names.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) fail(code);
    return record;
}

/** 组件只接受可打印 ASCII 并保留原始拼写，大小写碰撞由累计路径注册器另行处理；设备名、ASAR 和各平台危险字符在解析阶段拒绝，NFC 检查不能被当成静默规范化许可。 */
function component(value: string, code: MacRuntimeManifestErrorCode) {
    if (Buffer.byteLength(value) > L.componentBytes) fail("MAC_MANIFEST_LIMIT");
    if (
        !value ||
        value.normalize("NFC") !== value ||
        /[^\x20-\x7e]/.test(value) ||
        /[\\:<>"|?*]/.test(value) ||
        /[. ]$/.test(value) ||
        value === "." ||
        value === ".." ||
        /\.asar$/i.test(value) ||
        /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/i.test(
            value.split(".")[0]!.trimEnd(),
        )
    )
        fail(code);
}

/** 路径预算先检查原始字节和组件数，再逐组件执行保守可移植规则；链接 target 仅额外允许有限点组件，原始目标绝不预先 normalize，后续解析仍需逐步验证同框架根边界。 */
function pathValue(value: unknown, target = false): string {
    const error = target ? "MAC_LINK_TARGET" : "MAC_MANIFEST_PATH";
    if (typeof value !== "string") fail("MAC_MANIFEST_INVALID");
    if (!value) fail(error);
    if (Buffer.byteLength(value) > L.pathBytes) fail("MAC_MANIFEST_LIMIT");
    const parts = value.split("/");
    if (parts.length > L.depth) fail("MAC_MANIFEST_LIMIT");
    for (const part of parts)
        if (!(target && (part === "." || part === ".."))) component(part, error);
    return value;
}

/** 碰撞记录包含每一个累计父组件而不只比较完整文件名，固定根清单也预先保留；因此 A/x 与 a/y、跨集合重复及大小写清单别名都会拒绝，完全相同的共享物理父目录则允许。 */
function collisionRegistry() {
    const prefixes = new Map<string, string>();
    const entries = new Set<string>();
    return (path: string) => {
        if (entries.has(path)) fail("MAC_MANIFEST_COLLISION");
        entries.add(path);
        let prefix = "";
        for (const part of path.split("/")) {
            prefix = prefix ? prefix + "/" + part : part;
            const key = prefix.toLowerCase();
            const prior = prefixes.get(key);
            if (prior !== undefined && prior !== prefix) fail("MAC_MANIFEST_COLLISION");
            prefixes.set(key, prefix);
        }
    };
}

/** 策略验证必须在 verify 首次 await 前完成，所有数组和链接条目都新建并冻结；固定 Chrome 主入口由架构推导，框架名必须为单组件显式根，不允许 Electron 框架或另一个架构混入。 */
function policySnapshot(expected: Expected): Policy {
    const input = object(expected, ["arch", "layout"], "MAC_MANIFEST_LAYOUT");
    if (input.arch !== "x64" && input.arch !== "arm64") fail("MAC_MANIFEST_LAYOUT");
    const source = object(
        input.layout,
        ["bundlePath", "executablePath", "frameworkRoots", "allowedLinks"],
        "MAC_MANIFEST_LAYOUT",
    );
    const bundlePath = `browser/chrome-mac-${input.arch}/Google Chrome for Testing.app`;
    const executablePath = `${bundlePath}/Contents/MacOS/Google Chrome for Testing`;
    if (source.bundlePath !== bundlePath || source.executablePath !== executablePath)
        fail("MAC_MANIFEST_LAYOUT");
    if (!Array.isArray(source.frameworkRoots) || !Array.isArray(source.allowedLinks))
        fail("MAC_MANIFEST_LAYOUT");
    if (source.frameworkRoots.length > L.frameworkRoots || source.allowedLinks.length > L.links)
        fail("MAC_MANIFEST_LIMIT");
    const roots: string[] = [];
    const prefix = `${bundlePath}/Contents/Frameworks/`;
    for (const value of source.frameworkRoots) {
        const root = pathValue(value);
        const name = root.slice(prefix.length);
        if (
            !root.startsWith(prefix) ||
            name.includes("/") ||
            !/^.+\.framework$/.test(name) ||
            roots.some(
                (prior) =>
                    prior.toLowerCase() === root.toLowerCase() ||
                    root.startsWith(prior + "/") ||
                    prior.startsWith(root + "/"),
            )
        )
            fail("MAC_MANIFEST_LAYOUT");
        roots.push(root);
    }
    const seen = collisionRegistry();
    const links: RuntimeLinkV2[] = [];
    for (const value of source.allowedLinks) {
        const link = linkRecord(value);
        seen(link.path);
        if (!roots.some((root) => link.path.startsWith(root + "/"))) fail("MAC_LINK_FORBIDDEN");
        links.push(Object.freeze(link));
    }
    return Object.freeze({
        arch: input.arch,
        layout: Object.freeze({
            bundlePath,
            executablePath,
            frameworkRoots: Object.freeze(roots),
            allowedLinks: Object.freeze(links),
        }),
    });
}

/** 链接记录先验证精确字段与原始路径语法，不能把目标规范化后再比较可信布局；路径预算与普通成员保持一致，点组件的有限含义只在框架内逐组件解析阶段解释。 */
function linkRecord(value: unknown): RuntimeLinkV2 {
    const item = object(value, ["path", "target"]);
    return { path: pathValue(item.path), target: pathValue(item.target, true) };
}

/** 普通版本沿用现有三段数字与可选预发布语义，但全串结束条件拒绝尾随换行且限制长度；独立 Node 仍复用专门的稳定二十四版本谓词，不能用 Electron 内嵌版本或主版本号替代。 */
function version(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length > 128 ||
        !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?![\s\S])/.test(value)
    )
        fail("MAC_MANIFEST_INVALID");
    return value;
}

/** 纯解析仅访问给定字节与已经快照的策略，预算和完整父目录闭包都在任何真实树读取前完成；返回对象由经过验证的值重新构造并逐层冻结，未知字段或数组伪对象不能进入静态报告。 */
function parseWithPolicy(bytes: Uint8Array, policy: Policy): Readonly<MacRuntimeManifestV2> {
    if (!(bytes instanceof Uint8Array)) fail("MAC_MANIFEST_INVALID");
    if (bytes.byteLength > L.manifestBytes) fail("MAC_MANIFEST_LIMIT");
    let decoded: unknown;
    try {
        decoded = JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
        );
    } catch {
        fail("MAC_MANIFEST_INVALID");
    }
    const item = object(decoded, [
        "schemaVersion",
        "platform",
        "arch",
        "productVersion",
        "nodeVersion",
        "engineVersion",
        "browser",
        "directories",
        "files",
        "links",
    ]);
    if (
        item.schemaVersion !== 2 ||
        item.platform !== "darwin" ||
        item.arch !== policy.arch ||
        !isNode24Version(item.nodeVersion)
    )
        fail("MAC_MANIFEST_INVALID");
    const productVersion = version(item.productVersion);
    const engineVersion = version(item.engineVersion);
    const browser = object(item.browser, ["version", "revision", "bundlePath", "executablePath"]);
    if (browser.version !== "158.0.8127.18" || browser.revision !== "1254")
        fail("MAC_MANIFEST_INVALID");
    if (
        browser.bundlePath !== policy.layout.bundlePath ||
        browser.executablePath !== policy.layout.executablePath
    )
        fail("MAC_MANIFEST_LAYOUT");
    if (
        !Array.isArray(item.files) ||
        !Array.isArray(item.directories) ||
        !Array.isArray(item.links)
    )
        fail("MAC_MANIFEST_INVALID");
    if (
        item.files.length + item.directories.length + item.links.length > L.totalEntries ||
        item.links.length > L.links
    )
        fail("MAC_MANIFEST_LIMIT");
    const register = collisionRegistry();
    register(manifestName);
    const directories = item.directories.map((value) => {
        const path = pathValue(value);
        register(path);
        return path;
    });
    let total = 0;
    const files: RuntimeFileV2[] = item.files.map((value) => {
        const file = object(value, ["path", "sizeBytes", "sha256", "mode"]);
        const path = pathValue(file.path);
        register(path);
        if (
            typeof file.sizeBytes !== "number" ||
            file.sizeBytes < 0 ||
            !Number.isInteger(file.sizeBytes)
        )
            fail("MAC_MANIFEST_INVALID");
        if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes > L.fileBytes)
            fail("MAC_MANIFEST_LIMIT");
        total += file.sizeBytes;
        if (total > L.totalFileBytes) fail("MAC_MANIFEST_LIMIT");
        if (
            typeof file.sha256 !== "string" ||
            !/^[0-9a-f]{64}(?![\s\S])/.test(file.sha256) ||
            typeof file.mode !== "number" ||
            !fileModes.has(file.mode)
        )
            fail("MAC_MANIFEST_INVALID");
        return Object.freeze({
            path,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
            mode: file.mode,
        });
    });
    const links = item.links.map((value) => {
        const link = linkRecord(value);
        register(link.path);
        return Object.freeze(link);
    });
    const directorySet = new Set(directories);
    for (const path of [...directories, ...files.map((f) => f.path), ...links.map((l) => l.path)]) {
        const parent = dirname(path);
        if (parent !== "." && !directorySet.has(parent)) fail("MAC_MANIFEST_INVALID");
    }
    for (const root of policy.layout.frameworkRoots)
        if (!directorySet.has(root)) fail("MAC_MANIFEST_LAYOUT");
    const allowed = new Map(policy.layout.allowedLinks.map((link) => [link.path, link.target]));
    for (const link of links) {
        if (!policy.layout.frameworkRoots.some((root) => link.path.startsWith(root + "/")))
            fail("MAC_LINK_FORBIDDEN");
        if (allowed.get(link.path) !== link.target) fail("MAC_MANIFEST_LAYOUT");
    }
    if (links.length !== allowed.size) fail("MAC_MANIFEST_LAYOUT");
    const byPath = new Map(files.map((file) => [file.path, file]));
    const executable = [
        "roles/agent/veriq_agent",
        "roles/cli/veriq_cli",
        "roles/runner/veriq_runner",
        "native/vault/veriq_agent",
        policy.layout.executablePath,
    ];
    const required = [
        "entry/agent.js",
        "entry/cli.js",
        "npm/bin/npm-cli.js",
        "node_modules/tsx/dist/loader.mjs",
        `engines/${engineVersion}/inventory.json`,
        "native/veriq_private_files.node",
        ...[
            "worker",
            "provider",
            "compile-entry",
            "archive",
            "controlled-command",
            "controlled-child",
            "controlled-child-protocol",
            "controlled-child-preload",
        ].map((name) => `execution/${name}.mjs`),
    ];
    for (const path of required) if (!byPath.has(path)) fail("MAC_MANIFEST_INVALID");
    for (const path of executable)
        if (!executableModes.has(byPath.get(path)?.mode ?? 0)) fail("MAC_MANIFEST_INVALID");
    return Object.freeze({
        schemaVersion: 2,
        platform: "darwin",
        arch: policy.arch,
        productVersion,
        nodeVersion: item.nodeVersion,
        engineVersion,
        browser: Object.freeze({
            version: "158.0.8127.18",
            revision: "1254",
            bundlePath: policy.layout.bundlePath,
            executablePath: policy.layout.executablePath,
        }),
        directories: Object.freeze(directories) as unknown as string[],
        files: Object.freeze(files) as unknown as RuntimeFileV2[],
        links: Object.freeze(links) as unknown as RuntimeLinkV2[],
    });
}

/** 公开纯解析接口不会访问操作系统，调用者必须显式提供架构和可信布局而不能从清单中推导政策；字节合同与真实树合同共享相同的有限验证逻辑，返回值不含执行路径能力或签名认证结论。 */
export function parseMacRuntimeManifestV2(
    bytes: Uint8Array,
    expected: Expected,
): Readonly<MacRuntimeManifestV2> {
    return parseWithPolicy(bytes, policySnapshot(expected));
}

/** 只保留受控 errno 分类作为诊断 cause，避免系统异常文本包含路径或业务内容；预期缺失与读取后变化由调用位置区分，未知系统错误也不能直接透传为不稳定或泄密的公开异常。 */
function ioError(
    error: unknown,
    missing: MacRuntimeManifestErrorCode = "MAC_INVENTORY_MISSING",
): never {
    if (error instanceof MacRuntimeManifestError) throw error;
    const raw = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const errno = typeof raw === "string" && /^(?:E[A-Z0-9]+)$/.test(raw) ? raw : "UNKNOWN";
    throw new MacRuntimeManifestError(
        errno === "ENOENT" || errno === "ENOTDIR" ? missing : "MAC_INVENTORY_IO",
        { cause: Object.freeze({ code: errno }) },
    );
}

/** 身份快照同时比较设备、inode、类型权限、链接数、大小与纳秒修改时间，不能仅凭路径仍存在就假定字节未变；这些检查发现被观察到的变化，但不宣称能提供整个树的原子快照或抵抗恶意父目录并发替换。 */
function same(a: BigIntStats, b: BigIntStats): boolean {
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

/** 文件系统必须提供可检查的 POSIX 元数据与真实单链接普通文件，特殊文件在打开之前拒绝；清单自身只允许只读或所有者可写模式，普通成员则必须精确匹配已经验证的十进制权限字段。 */
function regular(info: BigIntStats, mode?: number) {
    if (!info.isFile()) fail("MAC_INVENTORY_TYPE");
    if (info.nlink !== 1n || info.ino === 0n) fail("MAC_INVENTORY_HARDLINK");
    const actual = Number(info.mode & 0o7777n);
    if (mode === undefined ? actual !== 0o444 && actual !== 0o644 : actual !== mode)
        fail("MAC_INVENTORY_MODE");
}

/** 根目录必须为绝对真实目录，逐级 lstat 防止祖先符号链接与 ASAR 虚拟路径被 resolve 隐藏；宿主根组件允许中文和空格，只有成员使用 ASCII 规则，无法证明 POSIX 元数据时明确失败关闭。 */
async function checkRoot(input: string): Promise<{ root: string; info: BigIntStats }> {
    if (
        typeof input !== "string" ||
        !isAbsolute(input) ||
        input.includes("\0") ||
        input
            .split(/[\\/]/)
            .some((part) => part === "." || part === ".." || /\.asar$/i.test(part)) ||
        !constants.O_NOFOLLOW ||
        !constants.O_NONBLOCK
    )
        fail("MAC_INVENTORY_ROOT");
    const root = resolve(input);
    const anchor = parsePath(root).root;
    let current = anchor;
    let info: BigIntStats;
    try {
        info = await lstat(anchor, { bigint: true });
        for (const part of root.slice(anchor.length).split("/").filter(Boolean)) {
            current = join(current, part);
            info = await lstat(current, { bigint: true });
            if (!info.isDirectory() || info.isSymbolicLink()) fail("MAC_INVENTORY_ROOT");
        }
    } catch (error) {
        ioError(error, "MAC_INVENTORY_ROOT");
    }
    if (!info.isDirectory() || info.ino === 0n) fail("MAC_INVENTORY_ROOT");
    if (![0o700, 0o555, 0o755].includes(Number(info.mode & 0o7777n))) fail("MAC_INVENTORY_MODE");
    return { root, info };
}

type Observed = { info: BigIntStats; target?: string };

/** 句柄流始终使用固定小块读取，清单也先核大小再限量积累而不调用无限 readFile；打开后、流结束后与路径回查都比较身份，实际读取字节及全树累计预算独立于清单声明执行。 */
async function readRegular(
    path: string,
    before: BigIntStats,
    options: { manifest: boolean; file?: RuntimeFileV2; addBytes?: (count: number) => void },
): Promise<{ sha256: string; bytes: Buffer | undefined }> {
    regular(before, options.file?.mode);
    const limit = options.manifest ? L.manifestBytes : L.fileBytes;
    if (before.size > BigInt(limit) || before.size < 0n) fail("MAC_MANIFEST_LIMIT");
    if (options.file && before.size !== BigInt(options.file.sizeBytes)) fail("MAC_INVENTORY_HASH");
    const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error) => {
        if (
            error &&
            (error.code === "ELOOP" || error.code === "ENOENT" || error.code === "ENOTDIR")
        )
            fail("MAC_INVENTORY_CHANGED");
        ioError(error);
    });
    try {
        if (!same(before, await handle.stat({ bigint: true }))) fail("MAC_INVENTORY_CHANGED");
        let count = 0;
        const hash = createHash("sha256");
        const chunks: Buffer[] = [];
        for await (const value of handle.createReadStream({
            autoClose: false,
            highWaterMark: 64 * 1024,
        })) {
            const chunk = value as Buffer;
            count += chunk.byteLength;
            if (count > limit) fail("MAC_MANIFEST_LIMIT");
            options.addBytes?.(chunk.byteLength);
            hash.update(chunk);
            if (options.manifest) chunks.push(chunk);
        }
        if (
            !same(before, await handle.stat({ bigint: true })) ||
            !same(
                before,
                await lstat(path, { bigint: true }).catch((error) =>
                    ioError(error, "MAC_INVENTORY_CHANGED"),
                ),
            ) ||
            BigInt(count) !== before.size
        )
            fail("MAC_INVENTORY_CHANGED");
        const sha256 = hash.digest("hex");
        if (options.file && sha256 !== options.file.sha256) fail("MAC_INVENTORY_HASH");
        return { sha256, bytes: options.manifest ? Buffer.concat(chunks, count) : undefined };
    } finally {
        await handle.close();
    }
}

/** 调用位置已经用 lstat 观察到 symlink，随后真实 readlink 的消失或类型替换必须分类为变化；权限及其它系统失败仍经受控 errno 映射，不把一次观察后的丢失误称为初始库存缺成员。 */
async function observedReadlink(path: string): Promise<string> {
    return readlink(path).catch((error) => {
        if (["ENOENT", "ENOTDIR", "ELOOP", "EINVAL"].includes(error?.code))
            fail("MAC_INVENTORY_CHANGED");
        ioError(error);
    });
}

/** 有限链接逐组件消费原始目标，每次展开都重新保持同一显式框架根且计入跳数；检查中间节点必须是物理目录，不能用最终 realpath 前缀掩盖短暂越界、悬空目标或非目录中间成员。 */
function resolveLinks(manifest: Readonly<MacRuntimeManifestV2>, policy: Policy) {
    const directories = new Set(manifest.directories);
    const files = new Set(manifest.files.map((file) => file.path));
    const links = new Map(manifest.links.map((link) => [link.path, link.target]));
    const graph = new Map<string, string[]>([
        [".", []],
        ...manifest.directories.map((path): [string, string[]] => [path, []]),
    ]);
    for (const path of manifest.directories) graph.get(dirname(path))!.push(path);
    for (const link of manifest.links) {
        const root = policy.layout.frameworkRoots.find((root) => link.path.startsWith(root + "/"))!;
        const rootDepth = root.split("/").length;
        let current = dirname(link.path).split("/");
        let pending: (string | { leave: string })[] = [
            ...link.target.split("/"),
            { leave: link.path },
        ];
        let hops = 1;
        const active = new Set([link.path]);
        while (pending.length) {
            const part = pending.shift()!;
            if (typeof part !== "string") {
                active.delete(part.leave);
                continue;
            }
            if (!directories.has(current.join("/"))) fail("MAC_LINK_TARGET");
            if (part === ".") continue;
            if (part === "..") {
                if (current.length <= rootDepth) fail("MAC_LINK_TARGET");
                current.pop();
                continue;
            }
            const candidate = [...current, part].join("/");
            const target = links.get(candidate);
            if (target !== undefined) {
                /** 展开结束标记精确维护当前活动链接，递归目标即使不断增长后缀也会立即识别为环；离开展开后再访问同一别名仍然合法，不能用全程访问集合误拒有限的重复目录跳转。 */
                if (active.has(candidate)) fail("MAC_LINK_CYCLE");
                active.add(candidate);
                if (++hops > L.linkHops) fail("MAC_LINK_LIMIT");
                pending = [...target.split("/"), { leave: candidate }, ...pending];
            } else {
                if (!files.has(candidate) && !directories.has(candidate)) fail("MAC_LINK_TARGET");
                current.push(part);
            }
        }
        const endpoint = current.join("/");
        if (directories.has(endpoint)) graph.get(dirname(link.path))!.push(endpoint);
        else if (!files.has(endpoint)) fail("MAC_LINK_TARGET");
    }
    /** 目录别名即使没有 link 到 link 的解析环也可能返回祖先形成无限虚拟树，因此单独验证物理目录边与目录别名边的联合图；拓扑消除不用递归，图大小受总条目与链接预算约束。 */
    const indegree = new Map([...graph.keys()].map((path) => [path, 0]));
    for (const edges of graph.values())
        for (const path of edges) indegree.set(path, indegree.get(path)! + 1);
    const queue = [...indegree].filter(([, degree]) => degree === 0).map(([path]) => path);
    let visited = 0;
    for (let i = 0; i < queue.length; i++) {
        const path = queue[i]!;
        visited++;
        for (const child of graph.get(path)!) {
            const next = indegree.get(child)! - 1;
            indegree.set(child, next);
            if (!next) queue.push(child);
        }
    }
    if (visited !== graph.size) fail("MAC_LINK_CYCLE");
}

/** 公开核验首先同步快照策略，然后只读取固定根清单和完全枚举的物理成员；目录链接从不展开枚举，结果仅是深冻结的静态库存观察，不能授予旧加载器、原生插件或进程执行能力。 */
export async function verifyMacRuntimeManifestV2(
    rootInput: string,
    expected: Expected,
): Promise<MacRuntimeStaticInventory> {
    const policy = policySnapshot(expected);
    try {
        const { root, info: rootInfo } = await checkRoot(rootInput);
        const manifestPath = join(root, manifestName);
        const manifestInfo = await lstat(manifestPath, { bigint: true });
        const raw = await readRegular(manifestPath, manifestInfo, { manifest: true });
        const manifest = parseWithPolicy(raw.bytes!, policy);
        const files = new Map(manifest.files.map((file) => [file.path, file]));
        const directories = new Set(manifest.directories);
        const links = new Map(manifest.links.map((link) => [link.path, link.target]));
        const observed = new Map<string, Observed>([
            [".", { info: rootInfo }],
            [manifestName, { info: manifestInfo }],
        ]);
        const identities = new Set([`${manifestInfo.dev}:${manifestInfo.ino}`]);
        const register = collisionRegistry();
        register(manifestName);
        let entries = 0;
        let actualTotal = 0;
        let declaredTotal = 0;
        const stack = [""];
        while (stack.length) {
            const prefix = stack.pop()!;
            const directory = await opendir(join(root, prefix)).catch((error) =>
                ioError(error, "MAC_INVENTORY_CHANGED"),
            );
            for await (const entry of directory) {
                if (!prefix && entry.name === manifestName) continue;
                if (++entries > L.totalEntries) fail("MAC_MANIFEST_LIMIT");
                const path = pathValue(prefix ? `${prefix}/${entry.name}` : entry.name);
                register(path);
                const fullPath = join(root, path);
                const info = await lstat(fullPath, { bigint: true }).catch((error) =>
                    ioError(error, "MAC_INVENTORY_CHANGED"),
                );
                if (info.isDirectory()) {
                    if (!directories.has(path)) {
                        if (files.has(path) || links.has(path)) fail("MAC_INVENTORY_TYPE");
                        fail("MAC_INVENTORY_UNLISTED");
                    }
                    if (![0o555, 0o755].includes(Number(info.mode & 0o7777n)))
                        fail("MAC_INVENTORY_MODE");
                    observed.set(path, { info });
                    stack.push(path);
                } else if (info.isSymbolicLink()) {
                    const target = links.get(path);
                    if (target === undefined) {
                        if (files.has(path) || directories.has(path)) fail("MAC_INVENTORY_TYPE");
                        fail("MAC_INVENTORY_UNLISTED");
                    }
                    if ((await observedReadlink(fullPath)) !== target) fail("MAC_LINK_TARGET");
                    observed.set(path, { info, target });
                } else if (info.isFile()) {
                    const file = files.get(path);
                    if (!file) {
                        if (directories.has(path) || links.has(path)) fail("MAC_INVENTORY_TYPE");
                        fail("MAC_INVENTORY_UNLISTED");
                    }
                    regular(info, file.mode);
                    const identity = `${info.dev}:${info.ino}`;
                    if (identities.has(identity)) fail("MAC_INVENTORY_HARDLINK");
                    identities.add(identity);
                    if (info.size > BigInt(L.fileBytes)) fail("MAC_MANIFEST_LIMIT");
                    declaredTotal += Number(info.size);
                    if (declaredTotal > L.totalFileBytes) fail("MAC_MANIFEST_LIMIT");
                    await readRegular(fullPath, info, {
                        manifest: false,
                        file,
                        addBytes: (count) => {
                            actualTotal += count;
                            if (actualTotal > L.totalFileBytes) fail("MAC_MANIFEST_LIMIT");
                        },
                    });
                    observed.set(path, { info });
                } else fail("MAC_INVENTORY_TYPE");
            }
        }
        for (const path of [...directories, ...files.keys(), ...links.keys()])
            if (!observed.has(path)) fail("MAC_INVENTORY_MISSING");
        resolveLinks(manifest, policy);
        for (const [path, value] of observed) {
            const fullPath = path === "." ? root : join(root, path);
            const after = await lstat(fullPath, { bigint: true }).catch((error) =>
                ioError(error, "MAC_INVENTORY_CHANGED"),
            );
            if (
                !same(value.info, after) ||
                (value.target !== undefined && (await observedReadlink(fullPath)) !== value.target)
            )
                fail("MAC_INVENTORY_CHANGED");
        }
        return Object.freeze({
            kind: "MAC_RUNTIME_STATIC_INVENTORY",
            root,
            platform: "darwin",
            arch: policy.arch,
            manifestSha256: raw.sha256,
            manifest,
            regularFileCount: files.size,
            directoryCount: directories.size,
            linkCount: links.size,
            totalFileBytes: actualTotal,
        });
    } catch (error) {
        ioError(error);
    }
}
