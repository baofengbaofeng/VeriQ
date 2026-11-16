import {
    RuntimePayloadError,
    type Arch,
    type Ref,
    type Cleanup,
} from "./runtime-payload-inputs.ts";
import { canonicalBytes } from "@veriq/contracts";
import { createHash } from "node:crypto";
import { constants, open as openFd } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, basename, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { fromFdPromise, type Entry, type ZipFile } from "yauzl";
import {
    InputReader,
    decode,
    fail,
    freeze,
    relative,
    sha,
    limits,
} from "./runtime-payload-tree.ts";
import { ArchiveTransaction, controlledIoFailure } from "./runtime-payload-transaction.ts";
import {
    ArchiveScan,
    ArchiveBudget,
    transferArchiveRejection,
    type StageOptions,
    type ArchiveMember,
} from "./runtime-payload-archive.ts";
import { scanTar } from "./runtime-payload-tar.ts";
import { scanZip, trackZipClosure, closeUntransferredZipFd } from "./runtime-payload-zip.ts";

/**
 * 固定版本描述只表示本次开发观察的有限下载约束，Node 原摘要来自保存的 HTTPS 校验文本而 Chrome 只有观察长度；这里不接收
 * 镜像、版本及信任覆盖，任何来源变化必须重新取得证据并独立审阅。
 */
export const OFFICIAL_ASSETS = freeze({
    checksum: {
        url: "https://nodejs.org/dist/v24.22.1/SHASUMS256.txt",
        sizeBytes: 3171,
        sha256: "fdfbffc969c0f604beff0124d409b33a43b53f5c681d6220f80023e0d6df9dc4",
    },
    x64: {
        nodeBytes: 54382566,
        nodeSha: "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035",
        chromeBytes: 212863194,
    },
    arm64: {
        nodeBytes: 53062778,
        nodeSha: "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
        chromeBytes: 199683801,
    },
});
const entry = new URL(import.meta.resolve("@veriq/contracts"));
/**
 * 十九项来源按实际模块 URL 定位真实宿主字节，contracts 必须跟随本次实际解析入口而非猜测工作区副本；键名保持仓库语境，比
 * 较只证明受控 checkout 一致性，不认证已加载机器码或第三方依赖来源。
 */
export const ASSET_SOURCES = freeze([
    ...[
        "runtime-assets-observation.ts",
        "runtime-assets-acquisition.ts",
        "observe-macos-runtime-assets.mjs",
        "acquire-macos-runtime-assets.mjs",
        ...["archive", "tar", "zip", "transaction", "inputs", "tree", "receipts", "graph"].map(
            (n) => `runtime-payload-${n}.ts`,
        ),
    ].map((n) => ({ path: `apps/runtime/scripts/${n}`, url: new URL(n, import.meta.url).href })),
    ...["distribution-manifest-v2", "node-version"].map((n) => ({
        path: `apps/runtime/src/${n}.ts`,
        url: new URL(`../src/${n}.ts`, import.meta.url).href,
    })),
    { path: "packages/contracts/src/index.ts", url: entry.href },
    { path: "packages/contracts/src/validators.ts", url: new URL("validators.ts", entry).href },
    {
        path: "packages/contracts/schemas/platform-v1.schema.json",
        url: new URL("../schemas/platform-v1.schema.json", entry).href,
    },
    { path: "pnpm-lock.yaml", url: new URL("../../../pnpm-lock.yaml", import.meta.url).href },
    {
        path: ".github/workflows/runtime-payload-macos.yml",
        url: new URL("../../../.github/workflows/runtime-payload-macos.yml", import.meta.url).href,
    },
]);
/**
 * 来源观察保存声明的提交和证据引用，提交与真实 CI checkout 的关联必须由工作流及外部审核佐证；证据必须是固定输入根内普通
 * 文件，JSON 自报提交绝不因此成为 Git 来源认证或后续执行许可。
 */
export type SourceObservation = Readonly<{ commit: string; evidence: Ref }>;
/**
 * 来源事实逐字绑定本次十九个实际宿主文件并记录 CI 运行与工具观察，所有字段必填且不允许额外属性；这些值供外部 CI 事实交
 * 叉核对，不能仅凭一份 JSON 宣称运行身份或发布者真实性已经验证。
 */
export type SourceFacts = Readonly<{
    schemaVersion: 1;
    kind: "ASSET_OBSERVER_SOURCE";
    commit: string;
    runId: string;
    runAttempt: number;
    arch: Arch;
    osVersion: string;
    nodeVersion: "24.22.1";
    nodeSha256: string;
    files: readonly Ref[];
}>;
/**
 * 单次跳转事实仅保存批准 URL、状态、显式位置和长度，空值仍必须真实出现以避免省略语义；响应头袋、凭据、错误正文与任意远
 * 端消息都不会进入成功获取记录或稳定诊断。
 */
export type Hop = Readonly<{
    url: string;
    status: 200 | 301 | 302 | 303 | 307 | 308;
    location: string | null;
    contentLength: number | null;
}>;
/**
 * 获取事实中的 body 引用始终以获取 artifact 根解释，即使记录随后复制到 observer 目录也不更改历史语境；真实快照对应关系
 * 由 observation.archives 的固定 node、chrome 顺序另
 * 行明确记录。
 */
export type FetchFact = Readonly<{ requestedUrl: string; hops: readonly Hop[]; body: Ref }>;
/**
 * 获取证据永久保留未审来源和未验签标签，Node 仅与固定 HTTPS 文本及原摘要匹配，Chrome 仅记录真实正文摘要；成功下载和流校
 * 验都不能把这些有限观察自动晋升成发布、布局或 Runtime 授信。
 */
export type FetchEvidence = Readonly<{
    schemaVersion: 1;
    kind: "OFFICIAL_ASSET_FETCH_EVIDENCE";
    arch: Arch;
    sourceStatus: "UNREVIEWED_SOURCE";
    nodeChecksumText: FetchFact;
    node: FetchFact;
    chrome: FetchFact;
    nodeCheck: "MATCHED_PINNED_HTTPS_TEXT";
    chromeCheck: "BODY_HASH_OBSERVED_ONLY";
    publisherSignature: "NOT_VERIFIED";
}>;
/**
 * 观察输入只允许固定版本和固定证据路径，两份归档引用必须随后与获取证据逐字一致；它不包含独立 Expected、允许链接政策或
 * Runtime 配方，因此通过解析绝不意味着目标已经可执行或可安装。
 */
export type AssetsObservationInput = Readonly<{
    schemaVersion: 1;
    kind: "MAC_RUNTIME_ASSETS_OBSERVATION_INPUT";
    arch: Arch;
    nodeVersion: "24.22.1";
    chromeVersion: "158.0.8127.18";
    playwrightVersion: "1.65.0";
    revision: "1254";
    source: SourceObservation;
    node: Ref;
    chrome: Ref;
    fetchEvidence: Ref;
}>;
/**
 * 原 ZIP 权限事实保留公开 metadata 中未经合成的宿主、external 属性和高位模式，状态只区分真实 Unix 类型与缺失或 DOS 情况
 * ；该分类不是权限安全批准，成员类型仍由已有归档扫描政策决定。
 */
export type RawZipMode = Readonly<{
    path: string;
    host: number;
    externalFileAttributes: number;
    rawMode: number;
    state: "EXPLICIT_UNIX" | "MISSING_OR_DOS";
}>;
/**
 * 成员文档保留成熟扫描器给出的真实归档顺序，隐式父目录只计有效条目而不伪造原成员；文档只含有界路径、类型、权限与内容摘
 * 要或链接目标，没有普通成员落地正文及执行能力。
 */
export type MemberFacts = Readonly<{
    schemaVersion: 1;
    kind: "ASSET_ARCHIVE_MEMBER_FACTS";
    archive: "node" | "chrome";
    members: readonly ArchiveMember[];
}>;
/**
 * 原模式文档单独保存逐项 ZIP metadata 以支持审核 fallback 情形，不能把扫描器合成的默认权限记为归档原值；每个 metadata
 * 条目都要与真实扫描成员一对一匹配并受相同数量及头部预算限制。
 */
export type ZipModeFacts = Readonly<{
    schemaVersion: 1;
    kind: "ASSET_ZIP_MODE_FACTS";
    entries: readonly RawZipMode[];
}>;
/**
 * 单份归档统计明确区分显式成员和合并父目录后的有效路径，压缩流与展开字节也分别记录；CRC 和 ZIP 范围只声明当前成熟解析器
 * 实际证明的部分，不把这些静态事实扩写为全语法或链接闭包批准。
 */
export type ArchiveObservation = Readonly<{
    kind: "node" | "chrome";
    snapshot: Ref;
    topDirectory: string;
    members: Ref;
    explicitEntries: number;
    effectiveEntries: number;
    fileCount: number;
    directoryCount: number;
    linkCount: number;
    expandedBytes: number;
    streamBytes: number;
    maxDepth: number;
    maxPathBytes: number;
    crc: "GZIP_STREAM" | "ZIP_EACH_ENTRY";
    zipLocalDataRanges: "CHECKED" | "NOT_APPLICABLE";
    modeEvidence: Ref | null;
}>;
/**
 * Chrome 布局只列出实际观察到的 bundle、可执行文件、Framework 根和链接候选，缺少对象或出现外链仍可形成完整待审事实；这
 * 些候选不会进入 D3a 授信或生成独立 Expected，后续人工布局及链接审核仍不可
 * 省略。
 */
export type LayoutObservation = Readonly<{
    bundlePath: string;
    executablePath: string;
    bundleDirectoryObserved: boolean;
    executableFileObserved: boolean;
    frameworkRootsObserved: readonly string[];
    allowedLinksCandidate: readonly Readonly<{ path: string; target: string }>[];
    outsideFrameworkLinks: readonly string[];
    missingOrDosModeEntries: number;
    status: "REQUIRES_LAYOUT_REVIEW";
}>;
const pending = [
    "SOURCE_REVIEW",
    "LINK_POLICY_AND_LAYOUT_REVIEW",
    "ARCHIVE_EXTRACTION",
    "NPM_CONTENT_AND_GRAPH",
    "TARGET_EXECUTION",
    "RUNTIME_STAGE",
] as const;
/**
 * 最终观察聚合两份只读快照与证据的真实引用，固定顺序和待办清单防止调用方误读为 Runtime 完成；来源与签名标签永不因扫描成
 * 功改变，输出本身不包含自摘要而由外层 Result 绑定原字节。
 */
export type AssetsObservation = Readonly<{
    schemaVersion: 1;
    kind: "MAC_RUNTIME_ASSETS_OBSERVATION";
    inputSha256: string;
    arch: Arch;
    nodeVersion: "24.22.1";
    chromeVersion: "158.0.8127.18";
    playwrightVersion: "1.65.0";
    revision: "1254";
    source: SourceObservation;
    sourceStatus: "UNREVIEWED_SOURCE";
    publisherSignature: "NOT_VERIFIED";
    fetchEvidence: Ref;
    archives: readonly [ArchiveObservation, ArchiveObservation];
    chromeLayout: LayoutObservation;
    pending: typeof pending;
}>;
/**
 * 观察结果只在最终路径真实 audit 之后报告 committed，清理状态仍独立保留锁及句柄收尾不确定性；该返回类型明确标记来源未审
 * 与布局待审，不会使用 ready、安装成功或 Runtime 验收等更强语义。
 */
export type AssetsObservationResult = Readonly<{
    kind: "MAC_RUNTIME_ASSETS_OBSERVATION_RESULT";
    directory: string;
    observation: Ref;
    status: "UNREVIEWED_SOURCE_REQUIRES_LAYOUT_REVIEW";
    committed: true;
    cleanup: Cleanup;
}>;
/**
 * 获取结果只绑定真实写入的输入 JSON 和最终候选目录，cleanup 不能被 committed 字段掩盖；获取六文件仍是未审来源证据，后续
 * 观察、布局复核、真实目标执行与 Runtime 组装均未因此完成。
 */
export type AssetsAcquisitionResult = Readonly<{
    kind: "MAC_RUNTIME_ASSETS_ACQUISITION_RESULT";
    directory: string;
    input: Ref;
    status: "UNREVIEWED_SOURCE";
    committed: true;
    cleanup: Cleanup;
}>;

/**
 * 严格对象检查拒绝访问器、继承属性、符号及所有未知字段，调用者可变对象只能在校验之后复制；此小组合器不接受校验器注入，
 * 固定 DTO 的每一层都由本模块显式列出字段与语义限制。
 */
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length
    )
        fail("PAYLOAD_INPUT_INVALID");
    const record = value as Record<string, unknown>;
    if (
        Object.keys(record).sort().join(",") !== [...keys].sort().join(",") ||
        Object.values(Object.getOwnPropertyDescriptors(record)).some((d) => !("value" in d))
    )
        fail("PAYLOAD_INPUT_INVALID");
    return record;
}
/**
 * 精确标量比较不做字符串和数字之间的隐式转换，版本、标签与路径因而不能通过近似拼写被接受；失败只返回固定英文错误码，不
 * 把原 JSON 或底层库诊断泄漏进日志及错误正文。
 */
function equal(a: unknown, b: unknown) {
    if (a !== b) fail("PAYLOAD_INPUT_INVALID");
}
/**
 * 非负安全整数检查同时适用于长度和运行编号，正整数另由使用位置约束，避免巨大声明溢出累计预算；所有真正文件大小仍需由
 * held FD 与流长度重新证明，声明校验并不代替实际内容核验。
 */
function integer(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        fail("PAYLOAD_INPUT_INVALID");
    return value;
}
/**
 * 有限标记先核类型与完全匹配语法，不接受尾随换行或隐式大小写归一化，摘要只能使用小写十六进制；表达式只用于固定小标量，
 * 路径、文件身份及压缩语法仍分别交给现有成熟逻辑。
 */
function pattern(value: unknown, regex: RegExp): string {
    if (
        typeof value !== "string" ||
        value.length > 1024 ||
        !regex.test(value) ||
        /[\r\n]/.test(value)
    )
        fail("PAYLOAD_INPUT_INVALID");
    return value;
}
/**
 * 严格 Ref 只复制三个基础字段并采用现有可移植路径政策，固定单文件预算在首次等待之前执行；路径、长度和摘要三者随后一起参
 * 与真实原字节比对，不能只核哈希后忽略声明文件角色。
 */
export function assetRef(value: unknown): Ref {
    const r = object(value, ["path", "sizeBytes", "sha256"]),
        sizeBytes = integer(r.sizeBytes);
    if (sizeBytes > limits.file) fail("PAYLOAD_LIMIT");
    return freeze({
        path: relative(r.path),
        sizeBytes,
        sha256: pattern(r.sha256, /^[a-f0-9]{64}$/),
    });
}
/**
 * 来源外层始终使用固定证据路径及完整提交字串，实际证据大小再套一 MiB 上限以保护早期来源校验；本解析会生成深冻结的新对象
 * ，调用者不能在首次异步等待之后改写来源或引用声明。
 */
export function parseSourceObservation(value: unknown): SourceObservation {
    const r = object(value, ["commit", "evidence"]),
        evidence = assetRef(r.evidence);
    equal(evidence.path, "evidence/source.json");
    if (evidence.sizeBytes > 1024 ** 2) fail("PAYLOAD_LIMIT");
    return freeze({ commit: pattern(r.commit, /^[a-f0-9]{40}$/), evidence });
}
/**
 * 核心 options 只接收固定三个路径标量与可选取消信号，未知字段不能变成传输或信任覆盖；根必须绝对且互不覆盖，候选名在首次
 * 等待前检查可移植拼写，真实祖先目录仍由 reader 与事务重新观察。
 */
export function assetOptions(value: StageOptions): StageOptions {
    const keys = [
        "inputRoot",
        "outputParent",
        "candidateName",
        ...(value && Object.hasOwn(value, "signal") ? ["signal"] : []),
    ];
    const r = object(value, keys);
    if (
        typeof r.inputRoot !== "string" ||
        !isAbsolute(r.inputRoot) ||
        typeof r.outputParent !== "string" ||
        !isAbsolute(r.outputParent) ||
        typeof r.candidateName !== "string" ||
        (r.signal !== undefined && !(r.signal instanceof AbortSignal))
    )
        fail("PAYLOAD_INPUT_INVALID");
    relative(r.candidateName);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.candidateName)) fail("PAYLOAD_PATH");
    return Object.freeze({
        inputRoot: r.inputRoot,
        outputParent: r.outputParent,
        candidateName: r.candidateName,
        ...(r.signal ? { signal: r.signal as AbortSignal } : {}),
    });
}
/**
 * 输入解析同步复制原始字节并逐层拒绝未知字段，官方固定身份不因内部微型 helper 测试而放宽；归档摘要与版本在这里就核对冻
 * 结约束，真实文件和获取记录仍在异步观察入口继续独立核验。
 */
export function parseAssetsObservationInput(bytes: Uint8Array): AssetsObservationInput {
    const r = object(decode(Buffer.from(bytes)), [
        "schemaVersion",
        "kind",
        "arch",
        "nodeVersion",
        "chromeVersion",
        "playwrightVersion",
        "revision",
        "source",
        "node",
        "chrome",
        "fetchEvidence",
    ]);
    equal(r.schemaVersion, 1);
    equal(r.kind, "MAC_RUNTIME_ASSETS_OBSERVATION_INPUT");
    const arch = assetArch(r.arch);
    equal(r.nodeVersion, "24.22.1");
    equal(r.chromeVersion, "158.0.8127.18");
    equal(r.playwrightVersion, "1.65.0");
    equal(r.revision, "1254");
    const node = assetRef(r.node),
        chrome = assetRef(r.chrome),
        fetchEvidence = assetRef(r.fetchEvidence);
    equal(node.path, "archives/node.tar.gz");
    equal(chrome.path, "archives/chrome.zip");
    equal(fetchEvidence.path, "evidence/fetch.json");
    if (
        node.sizeBytes !== OFFICIAL_ASSETS[arch].nodeBytes ||
        node.sha256 !== OFFICIAL_ASSETS[arch].nodeSha ||
        chrome.sizeBytes !== OFFICIAL_ASSETS[arch].chromeBytes
    )
        fail("PAYLOAD_ARCHIVE_HASH");
    if (fetchEvidence.sizeBytes > limits.json) fail("PAYLOAD_LIMIT");
    return freeze({
        schemaVersion: 1,
        kind: "MAC_RUNTIME_ASSETS_OBSERVATION_INPUT",
        arch,
        nodeVersion: "24.22.1",
        chromeVersion: "158.0.8127.18",
        playwrightVersion: "1.65.0",
        revision: "1254",
        source: parseSourceObservation(r.source),
        node,
        chrome,
        fetchEvidence,
    });
}
/**
 * 架构只接受两个冻结的原生 Mac 目标，任何其它平台或别名都不能悄悄切换成替代归档；该同步检查同时服务获取与观察入口，使首
 * 次等待之前的身份准入保持相同且没有环境默认行为。
 */
export function assetArch(value: unknown): Arch {
    if (value !== "x64" && value !== "arm64") fail("PAYLOAD_INPUT_INVALID");
    return value;
}
/**
 * 元数据读取使用现有支持六百权限的 held FD input，再独立比较原字节摘要和长度，不能调用较窄权限的 ref；reader 被拥有者一
 * 直保留到最终身份复验，初次观察不会被后来一次成功读取覆盖。
 */
export async function readAssetMetadata(
    reader: InputReader,
    ref: Ref,
    maximum: number,
): Promise<Buffer> {
    if (ref.sizeBytes > maximum) fail("PAYLOAD_LIMIT");
    const bytes = await reader.input(ref.path);
    if (bytes.length > maximum) fail("PAYLOAD_LIMIT");
    if (bytes.length !== ref.sizeBytes || sha(bytes) !== ref.sha256) fail("PAYLOAD_SOURCE_CHANGED");
    return bytes;
}
/**
 * 固定来源记录先验证全部元数据、十九项键集合及提交和架构关系，再逐个读取真实宿主字节；返回收尾动作继续持有首次 reader
 * 的身份事实，任何请求之前与最后发布之前都要复核，绝不重试到偶然一致。
 */
export async function bindAssetSources(
    reader: InputReader,
    source: SourceObservation,
    arch: Arch,
): Promise<Readonly<{ finish: () => Promise<void> }>> {
    const r = object(decode(await readAssetMetadata(reader, source.evidence, 1024 ** 2)), [
        "schemaVersion",
        "kind",
        "commit",
        "runId",
        "runAttempt",
        "arch",
        "osVersion",
        "nodeVersion",
        "nodeSha256",
        "files",
    ]);
    equal(r.schemaVersion, 1);
    equal(r.kind, "ASSET_OBSERVER_SOURCE");
    pattern(r.commit, /^[a-f0-9]{40}$/);
    pattern(r.runId, /^[0-9]+$/);
    pattern(r.osVersion, /^15\.[0-9]+(?:\.[0-9]+)?$/);
    pattern(r.nodeSha256, /^[a-f0-9]{64}$/);
    if (!integer(r.runAttempt)) fail("PAYLOAD_INPUT_INVALID");
    equal(r.nodeVersion, "24.22.1");
    if (r.commit !== source.commit || r.arch !== arch) fail("PAYLOAD_RECEIPT_MISMATCH");
    if (!Array.isArray(r.files) || r.files.length !== 19) fail("PAYLOAD_RECEIPT_MISMATCH");
    const refs = r.files.map(assetRef);
    if (
        new Set(refs.map((f) => f.path)).size !== 19 ||
        ASSET_SOURCES.some((s) => !refs.some((f) => f.path === s.path))
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
    const hosts: { reader: InputReader; ref: Ref }[] = [];
    for (const host of ASSET_SOURCES) {
        const full = fileURLToPath(host.url),
            ref = { ...refs.find((f) => f.path === host.path)!, path: basename(full) };
        const input = new InputReader(dirname(full), reader.signal, []);
        await input.initialize();
        await readAssetMetadata(input, ref, limits.json);
        hosts.push({ reader: input, ref });
    }
    const finish = async () => {
        await reader.finish();
        for (const host of hosts) {
            await host.reader.finish();
            await readAssetMetadata(host.reader, host.ref, limits.json);
            await host.reader.finish();
        }
    };
    await finish();
    return Object.freeze({ finish });
}
/**
 * 批准 URL 仅由冻结架构和版本拼接而来，CDN 的唯一重定向目标也在此显式列出；调用者不能传入不同端口、凭据、查询或片段，记
 * 录解析和真实 HTTPS 获取共用同一来源图来避免两套宽窄政策。
 */
export function assetUrls(arch: Arch) {
    return freeze({
        node: `https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-${arch}.tar.gz`,
        chrome: `https://cdn.playwright.dev/builds/cft/158.0.8127.18/mac-${arch}/chrome-mac-${arch}.zip`,
        chromeRedirect:
            `https://storage.googleapis.com/chrome-for-testing-public/158.0.8127.18/mac-${arch}` +
            `/chrome-mac-${arch}.zip`,
    });
}
/**
 * 获取记录的跳转图、固定长度及 body 引用都逐字段核验，原 checksum 文本必须匹配冻结原字节；复制后的历史 body 仍保留获取
 * 根语境，观察使用两份快照另行绑定而不会按这些 Ref 再打开错误位置。
 */
function parseFetch(bytes: Uint8Array, input: AssetsObservationInput): FetchEvidence {
    const r = object(decode(bytes), [
        "schemaVersion",
        "kind",
        "arch",
        "sourceStatus",
        "nodeChecksumText",
        "node",
        "chrome",
        "nodeCheck",
        "chromeCheck",
        "publisherSignature",
    ]);
    equal(r.schemaVersion, 1);
    equal(r.kind, "OFFICIAL_ASSET_FETCH_EVIDENCE");
    equal(r.arch, input.arch);
    equal(r.sourceStatus, "UNREVIEWED_SOURCE");
    equal(r.nodeCheck, "MATCHED_PINNED_HTTPS_TEXT");
    equal(r.chromeCheck, "BODY_HASH_OBSERVED_ONLY");
    equal(r.publisherSignature, "NOT_VERIFIED");
    const urls = assetUrls(input.arch);
    const check = (
        value: unknown,
        url: string,
        expected: Ref,
        redirect: string | null,
    ): FetchFact => {
        const f = object(value, ["requestedUrl", "hops", "body"]);
        equal(f.requestedUrl, url);
        const body = assetRef(f.body);
        if (
            body.path !== expected.path ||
            body.sizeBytes !== expected.sizeBytes ||
            body.sha256 !== expected.sha256
        )
            fail("PAYLOAD_ARCHIVE_HASH");
        if (!Array.isArray(f.hops) || !f.hops.length || f.hops.length > (redirect ? 2 : 1))
            fail("PAYLOAD_INPUT_INVALID");
        const hopsInput = f.hops;
        const hops = hopsInput.map((value, index): Hop => {
            const h = object(value, ["url", "status", "location", "contentLength"]),
                final = index === hopsInput.length - 1;
            equal(h.url, index ? redirect : url);
            if (h.contentLength !== null) integer(h.contentLength);
            if (final) {
                equal(h.status, 200);
                equal(h.location, null);
                equal(h.contentLength, body.sizeBytes);
            } else {
                if (![301, 302, 303, 307, 308].includes(Number(h.status)))
                    fail("PAYLOAD_INPUT_INVALID");
                equal(h.location, redirect);
            }
            return {
                url: h.url as string,
                status: h.status as Hop["status"],
                location: h.location as string | null,
                contentLength: h.contentLength as number | null,
            };
        });
        return { requestedUrl: url, hops, body };
    };
    const checksum = {
        path: "evidence/SHASUMS256.txt",
        sizeBytes: OFFICIAL_ASSETS.checksum.sizeBytes,
        sha256: OFFICIAL_ASSETS.checksum.sha256,
    };
    return freeze({
        schemaVersion: 1,
        kind: "OFFICIAL_ASSET_FETCH_EVIDENCE",
        arch: input.arch,
        sourceStatus: "UNREVIEWED_SOURCE",
        nodeChecksumText: check(r.nodeChecksumText, OFFICIAL_ASSETS.checksum.url, checksum, null),
        node: check(r.node, urls.node, input.node, null),
        chrome: check(r.chrome, urls.chrome, input.chrome, urls.chromeRedirect),
        nodeCheck: "MATCHED_PINNED_HTTPS_TEXT",
        chromeCheck: "BODY_HASH_OBSERVED_ONLY",
        publisherSignature: "NOT_VERIFIED",
    });
}
/**
 * 校验文本必须是已固定摘要的严格 UTF8 原字节，两种 Darwin 目标记录都恰好出现一次并逐字匹配；实现不会从文本中选择其它版
 * 本或新摘要，HTTPS 文本一致也不被解释为 GPG 或发布者签名已验证。
 */
export function checkNodeChecksum(bytes: Uint8Array) {
    if (
        bytes.length !== OFFICIAL_ASSETS.checksum.sizeBytes ||
        sha(bytes) !== OFFICIAL_ASSETS.checksum.sha256
    )
        fail("PAYLOAD_ARCHIVE_HASH");
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        fail("PAYLOAD_INPUT_INVALID");
    }
    for (const arch of ["x64", "arm64"] as const) {
        const name = `node-v24.22.1-darwin-${arch}.tar.gz`,
            lines = text.split("\n").filter((l) => l.endsWith(`  ${name}`));
        if (lines.length !== 1 || lines[0] !== `${OFFICIAL_ASSETS[arch].nodeSha}  ${name}`)
            fail("PAYLOAD_ARCHIVE_HASH");
    }
}
/**
 * 单块生成器让所有小证据也经过真实事务写入、摘要和 audit，没有绕过输出登记的文件系统写路径；调用前应先有界序列化正文，
 * 巨大归档始终交 snapshot 或下载流，不能通过这里引入大缓存副本。
 */
export async function* assetBytes(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
    yield bytes;
}
/**
 * 规范文档在交给事务之前检查四 MiB 实际字节上限，所有成员与模式证据仍由原扫描预算逐条计费；返回 Ref 绑定真实写入字节而
 * 非对象重编码猜测，发布后可独立重新读取并计算完整摘要。
 */
export async function writeAssetJson(
    tx: ArchiveTransaction,
    path: string,
    value: unknown,
): Promise<Ref> {
    const bytes = canonicalBytes(value);
    if (bytes.length > limits.json) tx.fail("PAYLOAD_LIMIT");
    return tx.write(path, assetBytes(bytes));
}
/**
 * ZIP 第二遍只走公开 lazyEntries metadata 不再解压，先核快照 held FD 摘要再逐项对照原扫描成员；所有等待都监听取消与关闭
 * ，未确认句柄关闭会标记事务保留，原模式从不采用已有扫描器的权限 fallb
 * ack。
 */
async function zipModes(
    tx: ArchiveTransaction,
    snapshot: Ref,
    members: readonly ArchiveMember[],
): Promise<RawZipMode[]> {
    const handle = await open(
        join(tx.scratch, snapshot.path),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let zip: ZipFile | undefined,
        closure: ReturnType<typeof trackZipClosure> | undefined,
        primary: unknown,
        fd: number | undefined;
    let handleClosed = false;
    const abort = () => closure?.request();
    try {
        const hash = createHash("sha256");
        let size = 0;
        for await (const chunk of handle.createReadStream({
            autoClose: false,
            highWaterMark: 65536,
        })) {
            tx.check();
            size += chunk.length;
            if (size > snapshot.sizeBytes) tx.fail("PAYLOAD_SOURCE_CHANGED");
            hash.update(chunk);
        }
        if (size !== snapshot.sizeBytes || hash.digest("hex") !== snapshot.sha256)
            tx.fail("PAYLOAD_SOURCE_CHANGED");
        await handle.close();
        handleClosed = true;
        fd = await new Promise<number>((resolve, reject) =>
            openFd(
                join(tx.scratch, snapshot.path),
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
                (error, value) => (error ? reject(error) : resolve(value)),
            ),
        );
        zip = await fromFdPromise(fd, {
            autoClose: false,
            lazyEntries: true,
            strictFileNames: true,
            validateEntrySizes: true,
        });
        fd = undefined;
        closure = trackZipClosure(zip, tx);
        tx.signal?.addEventListener("abort", abort, { once: true });
        const modes: RawZipMode[] = [];
        let metadata = 0;
        while (true) {
            tx.check();
            const next = await new Promise<Entry | null>((resolve, reject) => {
                const clear = () => {
                    zip!.off("entry", entry);
                    zip!.off("end", end);
                    zip!.off("error", error);
                    zip!.off("close", close);
                };
                const entry = (value: Entry) => {
                        clear();
                        resolve(value);
                    },
                    end = () => {
                        clear();
                        resolve(null);
                    },
                    error = () => {
                        clear();
                        reject(new RuntimePayloadError("PAYLOAD_ARCHIVE_FORMAT"));
                    },
                    close = () => {
                        clear();
                        reject(
                            new RuntimePayloadError(
                                tx.signal?.aborted ? "PAYLOAD_CANCELLED" : "PAYLOAD_ARCHIVE_FORMAT",
                            ),
                        );
                    };
                zip!
                    .once("entry", entry)
                    .once("end", end)
                    .once("error", error)
                    .once("close", close);
                zip!.readEntry();
            });
            if (!next) break;
            tx.check();
            metadata += next.fileNameLength + next.extraFieldLength + next.fileCommentLength;
            if (
                modes.length >= 40000 ||
                next.fileNameLength + next.extraFieldLength + next.fileCommentLength > 65536 ||
                metadata > limits.json
            )
                tx.fail("PAYLOAD_LIMIT");
            const path = next.fileName.endsWith("/") ? next.fileName.slice(0, -1) : next.fileName;
            if (members[modes.length]?.path !== path) tx.fail("PAYLOAD_SOURCE_CHANGED");
            const host = next.versionMadeBy >>> 8,
                rawMode = next.externalFileAttributes >>> 16,
                type = rawMode & 0o170000;
            modes.push({
                path,
                host,
                externalFileAttributes: next.externalFileAttributes,
                rawMode,
                state:
                    host === 3 && rawMode !== 0 && [0o100000, 0o040000, 0o120000].includes(type)
                        ? "EXPLICIT_UNIX"
                        : "MISSING_OR_DOS",
            });
        }
        if (closure.failure() || modes.length !== members.length) tx.fail("PAYLOAD_ARCHIVE_FORMAT");
        return modes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    } catch (error) {
        primary = error;
        if (error instanceof RuntimePayloadError) throw error;
        return tx.fail("PAYLOAD_ARCHIVE_FORMAT");
    } finally {
        tx.signal?.removeEventListener("abort", abort);
        try {
            if (closure) await closure.settle();
            if (!handleClosed) await handle.close();
            if (fd !== undefined) await closeUntransferredZipFd(fd, tx);
        } catch (error) {
            tx.noteCloseFailure();
            if (!primary) throw error;
        }
    }
}
/**
 * 顶层观察实际调用此扫描段，内部测试只提供已经由真实事务写入并核摘要的微型 owned 快照；一次共享空预算扫描原成员，不提取
 * 、不闭合链接政策、不读取来源或发布，因此不能被用作官方身份的替代准入接口。
 */
export async function scanObservedSnapshots(
    tx: ArchiveTransaction,
    arch: Arch,
    snapshots: readonly [Ref, Ref],
): Promise<{
    archives: [ArchiveObservation, ArchiveObservation];
    chromeLayout: LayoutObservation;
}> {
    assetArch(arch);
    equal(snapshots[0].path, "snapshots/node.tar.gz");
    equal(snapshots[1].path, "snapshots/chrome.zip");
    await tx.audit();
    const budget = new ArchiveBudget(),
        scans = [
            new ArchiveScan("node", `node-v24.22.1-darwin-${arch}`, tx, budget),
            new ArchiveScan("chrome", `chrome-mac-${arch}`, tx, budget),
        ] as const;
    const streamBytes = await scanTar(join(tx.scratch, snapshots[0].path), scans[0]);
    await scanZip(join(tx.scratch, snapshots[1].path), scans[1], snapshots[1].sizeBytes);
    const modes = await zipModes(tx, snapshots[1], scans[1].members);
    const modeEvidence = await writeAssetJson(tx, "evidence/zip-modes.json", {
        schemaVersion: 1,
        kind: "ASSET_ZIP_MODE_FACTS",
        entries: modes,
    });
    const archives: ArchiveObservation[] = [];
    for (const [index, scan] of scans.entries()) {
        const members = await writeAssetJson(tx, `members/${scan.kind}.json`, {
            schemaVersion: 1,
            kind: "ASSET_ARCHIVE_MEMBER_FACTS",
            archive: scan.kind,
            members: scan.members,
        });
        const effective = [...scan.effective];
        archives.push({
            kind: scan.kind,
            snapshot: snapshots[index]!,
            topDirectory: scan.top,
            members,
            explicitEntries: scan.members.length,
            effectiveEntries: effective.length,
            fileCount: effective.filter(([, m]) => m.kind === "file").length,
            directoryCount: effective.filter(([, m]) => m.kind === "directory").length,
            linkCount: effective.filter(([, m]) => m.kind === "link").length,
            expandedBytes: scan.expandedBytes,
            streamBytes: index ? snapshots[1].sizeBytes : streamBytes,
            maxDepth: Math.max(...effective.map(([p]) => p.split("/").length)),
            maxPathBytes: Math.max(...effective.map(([p]) => Buffer.byteLength(p))),
            crc: index ? "ZIP_EACH_ENTRY" : "GZIP_STREAM",
            zipLocalDataRanges: index ? "CHECKED" : "NOT_APPLICABLE",
            modeEvidence: index ? modeEvidence : null,
        });
    }
    const chrome = scans[1],
        bundle = `${chrome.top}/Google Chrome for Testing.app`,
        executable = `${bundle}/Contents/MacOS/Google Chrome for Testing`,
        prefix = `${bundle}/Contents/Frameworks/`;
    const roots = [...chrome.effective]
        .filter(
            ([p, m]) =>
                m.kind === "directory" &&
                p.startsWith(prefix) &&
                /^.+\.framework$/.test(p.slice(prefix.length)) &&
                !p.slice(prefix.length).includes("/"),
        )
        .map(([p]) => p)
        .sort();
    const links = chrome.members.filter(
        (m): m is Extract<ArchiveMember, { kind: "link" }> => m.kind === "link",
    );
    return freeze({
        archives: archives as [ArchiveObservation, ArchiveObservation],
        chromeLayout: {
            bundlePath: `browser/${bundle}`,
            executablePath: `browser/${executable}`,
            bundleDirectoryObserved: chrome.effective.get(bundle)?.kind === "directory",
            executableFileObserved: chrome.effective.get(executable)?.kind === "file",
            frameworkRootsObserved: roots.map((p) => `browser/${p}`),
            allowedLinksCandidate: links
                .filter((l) => roots.some((r) => l.path.startsWith(r + "/")))
                .map((l) => ({ path: `browser/${l.path}`, target: l.target }))
                .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
            outsideFrameworkLinks: links
                .filter((l) => !roots.some((r) => l.path.startsWith(r + "/")))
                .map((l) => `browser/${l.path}`)
                .sort(),
            missingOrDosModeEntries: modes.filter((m) => m.state === "MISSING_OR_DOS").length,
            status: "REQUIRES_LAYOUT_REVIEW",
        },
    });
}
/**
 * 失败出口保留首个正式分类并结合真实事务清理状态，不把后续系统异常或未知关闭误报为安全回滚；输入阶段尚未创建事务时保持
 * 原 INPUTS 语义，下载扫描和发布失败则绑定本次候选与实际阶段。
 */
export async function assetFailure(tx: ArchiveTransaction, error: unknown): Promise<never> {
    const cleanup = await tx.cleanup(),
        known = controlledIoFailure(error);
    if (error instanceof RuntimePayloadError)
        throw transferArchiveRejection(
            error,
            new RuntimePayloadError(
                error.code,
                error.causeCode,
                cleanup === "NOT_NEEDED" ? error.cleanup : cleanup,
                { phase: tx.phase, candidateDirectory: tx.directory },
            ),
        );
    tx.fail(known?.code ?? "PAYLOAD_IO", cleanup, known?.causeCode ?? null);
}
/**
 * 真实观察入口先同步固定全部声明，再使用原 reader 读取小证据和真实宿主来源，巨大归档只经事务快照流核；共享扫描段写成员
 * 与原模式后完成来源、输出及最终路径复验，永久保留所有未审及下游待办标签。
 */
export async function observeMacRuntimeAssets(
    bytes: Uint8Array,
    options: StageOptions,
): Promise<AssetsObservationResult> {
    const copy = Buffer.from(bytes),
        input = parseAssetsObservationInput(copy),
        o = assetOptions(options);
    const tx = new ArchiveTransaction(o.inputRoot, o.outputParent, o.candidateName, o.signal);
    tx.phase = "INPUTS";
    const reader = new InputReader(o.inputRoot, o.signal, []);
    try {
        await reader.initialize();
        const source = await bindAssetSources(reader, input.source, input.arch);
        const fetch = parseFetch(
            await readAssetMetadata(reader, input.fetchEvidence, limits.json),
            input,
        );
        const checksum = fetch.nodeChecksumText.body;
        checkNodeChecksum(await readAssetMetadata(reader, checksum, 65536));
        await tx.initialize();
        tx.phase = "INTAKE";
        const refs = [
            input.node,
            input.chrome,
            input.source.evidence,
            input.fetchEvidence,
            checksum,
        ];
        await tx.observeRefs(refs);
        await reader.finish();
        await tx.plan(refs.reduce((n, r) => n + r.sizeBytes, 0) + 12 * 1024 ** 2, 12);
        await tx.snapshot(input.node, "snapshots/node.tar.gz");
        await tx.snapshot(input.chrome, "snapshots/chrome.zip");
        for (const ref of refs.slice(2)) await tx.snapshot(ref, ref.path);
        const scanned = await scanObservedSnapshots(tx, input.arch, [
            { ...input.node, path: "snapshots/node.tar.gz" },
            { ...input.chrome, path: "snapshots/chrome.zip" },
        ]);
        await reader.finish();
        await source.finish();
        await tx.finishSources();
        await tx.audit();
        const observation: AssetsObservation = {
            schemaVersion: 1,
            kind: "MAC_RUNTIME_ASSETS_OBSERVATION",
            inputSha256: sha(copy),
            arch: input.arch,
            nodeVersion: input.nodeVersion,
            chromeVersion: input.chromeVersion,
            playwrightVersion: input.playwrightVersion,
            revision: input.revision,
            source: input.source,
            sourceStatus: "UNREVIEWED_SOURCE",
            publisherSignature: "NOT_VERIFIED",
            fetchEvidence: input.fetchEvidence,
            archives: scanned.archives,
            chromeLayout: scanned.chromeLayout,
            pending,
        };
        const ref = await writeAssetJson(tx, "observation.json", observation);
        await reader.finish();
        await source.finish();
        await tx.finishSources();
        tx.phase = "PUBLISH";
        const cleanup = await tx.publish();
        return freeze({
            kind: "MAC_RUNTIME_ASSETS_OBSERVATION_RESULT",
            directory: tx.directory,
            observation: ref,
            status: "UNREVIEWED_SOURCE_REQUIRES_LAYOUT_REVIEW",
            committed: true,
            cleanup,
        });
    } catch (error) {
        return assetFailure(tx, error);
    }
}
