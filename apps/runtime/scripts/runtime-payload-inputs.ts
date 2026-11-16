import { crc32 } from "node:zlib";
import { isNode24Version } from "../src/node-version.ts";
import { InputReader, decode, fail, freeze, io, limits, sha } from "./runtime-payload-tree.ts";
import { checked, recipePolicy, schemas, verifyReceipts } from "./runtime-payload-receipts.ts";
import { verifyGraph } from "./runtime-payload-graph.ts";
import type { MacChromeLayout } from "../src/distribution-manifest-v2.ts";

/**
 * 深只读映射同时固定对象字段与嵌套数组，避免调用方在等待真实文件读取时修改已经选定的来源策略；它只表达数据不可变性，不
 * 代表执行权限或发行批准。
 */
type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
/**
 * 摘要使用原始字节的十六进制表示，解析阶段严格要求小写六十四位字符；这里不携带签名、信任根或来源认证，不能把摘要匹配解
 * 释为发布者身份已获证明。
 */
export type Sha = string;
/**
 * 相对路径的所属根由字段语境明确指定，不能把源码、运行时与输入树的根混为一谈；解析同时限制可移植组件与深度，真实读取还
 * 需要逐级确认目录身份。
 */
export type Rel = string;
/**
 * 依赖实例编号保留同名同版本包的不同安装根和 peer 上下文，不允许按包名合并；引用闭包在静态图核验时逐条检查，编号本身不
 * 证明真实 Node 解析结果。
 */
export type InstanceId = string;
/**
 * 发行架构由调用者明确选定，只接受 Intel x64 与 Apple Silicon arm64 两种值；核验不会读取 Linux 宿主架构替代该选择，实际
 * 目标二进制装载仍须分别在原生 Mac 完成验收。
 */
export type Arch = "x64" | "arm64";
/**
 * 普通成员权限仅接受只读或所有者可写的数据模式以及对应可执行模式，十进制值与库存字节事实一起绑定；组写、全局写和特殊权
 * 限位在真实读取之前拒绝，不能靠复制时修复掩盖坏输入。
 */
export type Mode = 292 | 420 | 365 | 493;
/**
 * 长度与 SHA256 共同绑定同一份原始字节，声明长度必须是安全非负整数并受固定类别预算限制；摘要相同不能免去长度检查，规范
 * 化 JSON 摘要只在明确要求的 entry 与包自有树位置计算。
 */
export type Digest = Frozen<{ sizeBytes: number; sha256: Sha }>;
/**
 * 证据引用的 path 相对 inputRoot，读取要求单链接普通文件并核对实际长度和摘要；来源副本也遵循相同规则，引用不能藏进任何
 * BoundTree 形成自哈希，也不能借 symlink 跟随读取外部内容。
 */
export type Ref = Digest & Frozen<{ path: Rel }>;
/**
 * 完整树中的普通文件事实在 Ref 基础上额外固定权限，path 此时相对各自树根而不是 inputRoot；物理核验逐项核大小、摘要、模
 * 式及 inode 身份，不能把树内文件记录误当作树外证据引用。
 */
export type FileFact = Ref & Frozen<{ mode: Mode }>;
/**
 * 逻辑链接保留 path 与原始相对 target，两者分别按成员路径及有限点组件语法检查；本片仅依赖树允许明确 bin sourceAlias，读
 * 取 readlink 而不解引用，Chrome 归档链接仍属于待完成工作。
 */
export type LinkFact = Frozen<{ path: Rel; target: string }>;
/**
 * 目标同时固定平台、两种发行架构和产品、独立 Node、引擎版本，版本不会从本机工具或 Electron 推断；expected 与 recipe 必
 * 须逐字段相同，Node 还必须满足已有稳定二十四版本条件。
 */
export type Target = Frozen<{
    platform: "darwin";
    arch: Arch;
    productVersion: string;
    nodeVersion: string;
    engineVersion: string;
}>;
/**
 * 独立期望值绑定配方原始摘要、目标、Git 提交声明、来源绑定、pnpm 锁和 Chrome 布局摘要；调用者必须从外层审核步骤提供，核
 * 验器不会从待核配方自动生成它或因单一 hash 匹配跳过语义比较。
 */
export type ExpectedPayloadInputs = Frozen<{
    recipeSha256: Sha;
    target: Target;
    commit: string;
    sourceBindingSha256: Sha;
    pnpmLockSha256: Sha;
    chromeLayoutSha256: Sha;
}>;
/**
 * 工具记录保留精确名称、实际版本声明、工具资产摘要和真实证据引用，名称集合等于基础工具与五种构建工具并集；证据 hash 通
 * 过只说明读取一致，绝不代表本片运行或认证过该工具。
 */
export type Tool = Frozen<{
    name: "node" | "pnpm" | "tar" | "yauzl" | "vite" | "electron-vite" | "node-gyp" | "clang";
    version: string;
    artifactSha256: Sha;
    evidence: Ref;
}>;
/**
 * 来源记录将提交声明与原始源码归档、来源文件绑定文档和 pnpm 锁分开固定，三类文件都真实读取；本片不展开源码归档，读取
 * inputRoot 中的源码副本只能证明它们符合绑定文档的声明。
 */
export type Source = Frozen<{ commit: string; archive: Ref; binding: Ref; pnpmLock: Ref }>;
/**
 * 来源绑定逐个列出源码相对路径及原字节摘要，并必须包含锁、生产源码、构建配置和实际 producer；其 commit 与配方交叉核对，
 * 外部自报文档本身不能替代 Git 来源认证或真实生产构建证据。
 */
export type SourceBindingV1 = Frozen<{
    schemaVersion: 1;
    kind: "SOURCE_BINDING";
    commit: string;
    files: Ref[];
}>;
/**
 * 原归档引用分别绑定文件、格式、顶层目录、上游身份文本和外部收据，Node 与 Chrome 使用固定格式及命名；URL 只能是无凭据查
 * 询片段的 HTTPS 文本，核验过程绝不据此发起下载或网络请求。
 */
export type Archive = Frozen<{
    file: Ref;
    format: "tar.gz" | "zip";
    topDirectory: Rel;
    upstream: { url: string; version: string; checksumEvidence: Ref };
    receipt: Ref;
}>;
/**
 * 五种树职责分别为构建入口、八个执行成员、生产依赖、产品原生输出和引擎载荷，每种都有独立 kind 收据；该枚举控制链接及工
 * 具规则，不能把同形 JSON 在不同职责之间串换后继续核验。
 */
export type TreeKind = "entries" | "execution" | "dependencies" | "native" | "engine";
/**
 * 树根相对 inputRoot，库存和构建收据则是树外独立 Ref，三者共同建立可复验的输入关系；五个根不得重叠或互为大小写别名，完
 * 整树中没有清单自排除，也没有隐式忽略的额外目录。
 */
export type BoundTree = Frozen<{ root: Rel; inventory: Ref; buildReceipt: Ref }>;
/**
 * 统一配方固定来源、工具、原归档、独立 Chrome 布局以及五个已取得的输入树，是 parse 与 verify 的共同数据合同；它不携带输
 * 出目录、提取选项或可执行能力，后续组装必须重新读取核验全部输入。
 */
export type Recipe = Frozen<{
    schemaVersion: 1;
    kind: "MAC_RUNTIME_PAYLOAD_INPUTS";
    target: Target;
    source: Source;
    tools: Tool[];
    node: Archive;
    chrome: Archive;
    chromeLayout: Ref;
    entries: BoundTree;
    execution: BoundTree;
    dependencies: BoundTree;
    native: BoundTree;
    engine: BoundTree;
}>;
/**
 * 库存明确列出全部物理目录、普通文件和允许的逻辑链接，三集合互斥并要求父目录显式闭合；真实枚举拒绝未列成员和遗漏成员，
 * 五棵树共同消耗固定条目、链接和内容预算，不能分别放宽额度。
 */
export type TreeInventory = Frozen<{
    schemaVersion: 1;
    kind: "PAYLOAD_INPUT_TREE";
    treeKind: TreeKind;
    directories: Rel[];
    files: FileFact[];
    links: LinkFact[];
}>;
/**
 * 通用构建头绑定同一提交、来源绑定、pnpm 锁和 Darwin 架构，并把 producer 与 config 指回来源文件集合；工具名称受各
 * receipt kind 的精确集合限制，commandEvidence 只证明外
 * 部声明的字节身份。
 */
export type Build = Frozen<{
    commit: string;
    sourceBindingSha256: Sha;
    pnpmLockSha256: Sha;
    target: { platform: "darwin"; arch: Arch };
    producer: Ref;
    config: Ref;
    toolNames: Tool["name"][];
    commandEvidence: Ref;
}>;
/**
 * 所有树收据共享 schema、可判别 kind、构建头和库存原始摘要，后续 kind 专属正文在此基础上增加字段；库存摘要必须对应
 * BoundTree 的同一 Ref，不能用重序列化摘要或其它树的库存替换。
 */
export type ReceiptBase<K extends string> = Frozen<{
    schemaVersion: 1;
    kind: K;
    build: Build;
    treeInventorySha256: Sha;
}>;
/**
 * 入口导入边保留字面 specifier、相对外部或内建分类、解析目标以及是否动态导入，必须与真实 AST 一致；相对目标指向入口库存
 * 成员，外部目标等于 specifier，内建仅允许显式 node 白名单。
 */
export type ModuleEdge = Frozen<{
    specifier: string;
    kind: "relative" | "external" | "builtin";
    target: Rel | string;
    dynamic: boolean;
}>;
/**
 * 入口输出列出每个真实文件的角色与静态导入集合，两个固定 entrypoint 之外只能是 chunk 或无导入 asset；输出集合必须恰好覆
 * 盖入口树文件，不能靠收据省略残余 external 或未纳入审核的代码。
 */
export type EntryOutput = Frozen<{
    path: Rel;
    kind: "entry" | "chunk" | "asset";
    imports: ModuleEdge[];
}>;
/**
 * 入口构建收据固定 agent.js 和 cli.js 两个入口，并列出所有产物和已嵌入 Workspace 源码路径；嵌入声明要与真实来源 package
 * 名称版本对应，无法因此豁免仍出现在输出 AST 中的外部依赖。
 */
export type EntriesReceipt = ReceiptBase<"ENTRIES_BUILD"> &
    Frozen<{
        entrypoints: { agent: "agent.js"; cli: "cli.js" };
        outputs: EntryOutput[];
        embeddedWorkspaces: { name: string; version: string; sourcePaths: Rel[] }[];
    }>;
/**
 * 执行源码复制收据必须恰好列出八个固定 MJS，其 sourcePath 必须指向既有 execution 源码位置；成员 hash 同时匹配真实输出和
 * 来源绑定，受控 Attempt 动态文件并不伪装成本片额外物理输入。
 */
export type ExecutionReceipt = ReceiptBase<"EXECUTION_SOURCE_COPY"> &
    Frozen<{ members: { path: Rel; sourcePath: Rel; sha256: Sha }[] }>;
/**
 * 产品原生输出固定目标名称、源码集合、显式宏、目标架构和 macOS15 声明，并保留 SDK 及 inspection 证据；两种正式产物不能
 * 混入故障源码或新增宏，实际 MachO 与编译真实性仍须后续原生验收。
 */
export type NativeOutput = Frozen<{
    path: "veriq_private_files.node" | "vault/veriq_agent";
    targetName: "veriq_private_files" | "veriq_agent";
    defines: string[];
    sourceFiles: Ref[];
    sha256: Sha;
    architecture: "x86_64" | "arm64";
    minimumOs: "15.0";
    sdk: { version: string; settingsEvidence: Ref };
    inspectionEvidence: Ref;
}>;
/**
 * 产品原生构建收据只覆盖私有文件 NodeAPI addon 与独立 file based Keychain helper 两个正式目标；第三方 esbuild 等原生命
 * 令必须使用自身独立检查记录，不能冒充这里的两个 VeriQ
 * 产品输出。
 */
export type NativeReceipt = ReceiptBase<"NATIVE_PRODUCTION_BUILD"> &
    Frozen<{ outputs: NativeOutput[] }>;
/**
 * 依赖实例保持精确安装根、真实 name/version、锁 snapshot 文本、package 正文摘要和自有树规范摘要；同名同版本的不同 peer
 * 上下文必须分别保留实例路径与编号，不能按包名去重而丢失解析边界。
 */
export type PackageInstance = Frozen<{
    id: InstanceId;
    root: Rel;
    name: string;
    version: string;
    lockSnapshot: string;
    packageJson: Digest;
    ownTreeSha256: Sha;
}>;
/**
 * 每条依赖边保留来源实例、安装 alias、四种依赖类别、原 requested 和目标或明确缺失原因；optional 覆盖普通声明，optional
 * peer 由正文 meta 决定，required 边不允许用 null
 * 或任意理由跳过。
 */
export type Edge = Frozen<{
    from: InstanceId;
    alias: string;
    kind: "dependency" | "peer" | "optional" | "optional-peer";
    requested: string;
    to: InstanceId | null;
    absence: "TARGET_NOT_APPLICABLE" | "OPTIONAL_PEER_ABSENT" | null;
}>;
/**
 * 根绑定覆盖真实入口及八个执行文件中的所有外部字面导入，并额外保留生成根 package.json 的固定 tsx；consumer 使用最终
 * runtime 相对路径，只有该生成根例外可以暂时没有物理输入文件。
 */
export type RootBinding = Frozen<{ consumer: Rel; specifier: string; to: InstanceId }>;
/**
 * 命令计划绑定实际 owner、自有 target、安装层 alias、可替换 sourceAlias 与目标摘要，不能把 JS 正文搬到 alias 改变相对引
 * 用；node launcher 的 inspection 必须 n
 * ull，native launcher 则必须给出独立已读检查记录。
 */
export type Bin = Frozen<{
    owner: InstanceId;
    name: string;
    aliasPath: Rel;
    sourceAlias: Rel | null;
    targetPath: Rel;
    targetSha256: Sha;
    launcher: "node" | "native";
    inspection: Ref | null;
}>;
/**
 * 第三方原生命令检查记录把 Darwin 架构、最终 targetPath、目标摘要和不高于 macOS15 的系统要求一起固定；记录和
 * inspectionEvidence 都真实读取，但它们的自报内容不能证明实际 MachO
 * 检查已执行。
 */
export type NativeBinInspection = Frozen<{
    schemaVersion: 1;
    kind: "NATIVE_BIN_INSPECTION";
    platform: "darwin";
    arch: Arch;
    path: Rel;
    sha256: Sha;
    minimumOs: string;
    inspectionEvidence: Ref;
}>;
/**
 * 解析声明逐条保留 from、consumer、specifier、resolvedFile 与 to，目标文件必须属于指定实例自有文件；固定 tsx 使用独立
 * $root 来源，其它来源仍须对应真实入口、执行或包文件，不能泛化
 * 缺失消费者例外。
 */
export type Resolution = Frozen<{
    from: InstanceId | "$root" | "$entry" | "$execution" | "$npm";
    consumer: Rel;
    specifier: string;
    resolvedFile: Rel;
    to: InstanceId;
}>;
/**
 * 静态解析证据保留外部声称的 Node 版本、工具资产摘要、目标平台架构和逐条结果，所有结果必须与边及根绑定闭合；本片只核声
 * 明和物理输入一致，不启动 Node resolve，也不证明外部工具执行来源。
 */
export type GraphProof = Frozen<{
    method: "NODE_RESOLVE";
    nodeVersion: string;
    nodeExecutableSha256: Sha;
    target: { platform: "darwin"; arch: Arch };
    resolutions: Resolution[];
    evidence: Ref;
}>;
/**
 * 依赖图聚合实例、声明边、根消费者、命令归属和解析证据，各数组均受冻结上限与唯一键约束；外层依赖图会核真实包正文，Node
 * 原归档中的 npmGraph 只做有界结构和跨记录引用核验并明确保留 pending。
 */
export type DependencyGraph = Frozen<{
    instances: PackageInstance[];
    edges: Edge[];
    rootBindings: RootBinding[];
    bins: Bin[];
    resolutionProof: GraphProof;
}>;
/**
 * 生产依赖收据将完整图与固定 pnpm hoisted 离线冻结锁策略及 optional 决策证据一起绑定；sourceLock 和 lockAfter 都必须匹
 * 配独立来源锁，每条可选边恰好对应一条实际读取的选择证据。
 */
export type DependenciesReceipt = ReceiptBase<"PRODUCTION_DEPENDENCIES"> &
    Frozen<{
        graph: DependencyGraph;
        linker: {
            name: "pnpm";
            version: "11.25.0";
            mode: "hoisted";
            sourceLockSha256: Sha;
            lockAfterSha256: Sha;
            ignoreScripts: true;
            offline: true;
            frozenLockfile: true;
        };
        optionalDecisions: {
            from: InstanceId;
            alias: string;
            action: "include" | "exclude-target" | "absent-optional-peer";
            evidence: Ref;
        }[];
    }>;
/**
 * Node 原归档收据固定版本、nodeMember、npmRoot、npm 包声明和完整图声明，归档摘要实际读取匹配；本片没有提取 npm 的包正文
 * 、传递依赖或物理链接，因此 schema 通过仍不能清除 npm 内容与图的
 * pending。
 */
export type NodeReceipt = Frozen<{
    schemaVersion: 1;
    kind: "NODE_ARCHIVE_INPUT";
    archiveSha256: Sha;
    nodeVersion: string;
    npmVersion: string;
    nodeMember: Rel;
    npmRoot: Rel;
    npmPackageJson: Digest;
    npmGraph: DependencyGraph;
    inputLinks: LinkFact[];
    inspectionEvidence: Ref;
}>;
/**
 * Chrome 原归档收据固定浏览器版本、revision、Playwright 版本和独立布局摘要，并将归档与 inspection 证据交叉绑定；实际
 * ZIP 成员、CRC 与物理 Framework 尚未检查，不能把此静态
 * 一致性报告标成浏览器可运行。
 */
export type ChromeReceipt = Frozen<{
    schemaVersion: 1;
    kind: "CHROME_ARCHIVE_INPUT";
    archiveSha256: Sha;
    browserVersion: "158.0.8127.18";
    revision: "1254";
    playwrightVersion: "1.65.0";
    layoutSha256: Sha;
    inspectionEvidence: Ref;
}>;
/**
 * Chrome 布局沿用 D3a 的 MacChromeLayout 类型，另绑定原归档摘要与真实 reviewEvidence；bundle、主入口、框架根及允许链接
 * 只进行受控结构核对，不从待核归档自生成布局当作已审核输入。
 */
export type ChromeLayoutReceipt = Frozen<{
    schemaVersion: 1;
    kind: "CHROME_LAYOUT";
    archiveSha256: Sha;
    layout: MacChromeLayout;
    reviewEvidence: Ref;
}>;
/**
 * 引擎依赖逐项保留名称、精确版本与 integrity，必须同时匹配原 inventory 条目和真实 dependencies.json；这些来源声明不会触
 * 发安装，也不能代替发行者对某个引擎版本的批准或签名。
 */
export type EngineDependency = Frozen<{ name: string; version: string; integrity: string }>;
/**
 * 引擎文件使用相对 engine 根的原字节 Ref，只允许现有 release 白名单并强制四个基本成员；它与树外 evidence 的根语境不同，
 * 核验必须从已观察的 engine BoundTree 读取，不能把路径重新解释
 * 为 inputRoot。
 */
export type EngineFile = Ref;
/**
 * 引擎收据区分 inventory.json 原始摘要与所选唯一版本条目的 JCS 摘要，并逐项绑定版本、文件和依赖；原字节保持不变，复用现
 * 有 ApprovedEngineInventoryV1 schema，绝不调用授予批准语
 * 义的装载或晋升流程。
 */
export type EngineReceipt = ReceiptBase<"ENGINE_PAYLOAD"> &
    Frozen<{
        engineVersion: string;
        compilerVersion: string;
        runnerSdkVersion: string;
        inventory: { path: "inventory.json"; sizeBytes: number; sha256: Sha };
        entrySha256: Sha;
        files: EngineFile[];
        dependencies: EngineDependency[];
    }>;
/**
 * 单树检查结果保留已核库存、对应收据、两份原字节摘要及真实文件目录链接数量和内容总量；它是本次只读观察的不可变事实集合
 * ，不能作为下一片组装时绕过来源身份和字节重验的持久能力。
 */
export type TreeInspection<R> = Frozen<{
    inventory: TreeInventory;
    receipt: R;
    inventorySha256: Sha;
    receiptSha256: Sha;
    fileCount: number;
    directoryCount: number;
    linkCount: number;
    fileBytes: number;
}>;
/**
 * 五项待完成边界采用固定有序只读元组，调用者没有开关可省略归档成员、npm 内容图、Chrome 物理布局、执行来源或最终载荷库存
 * ；压缩文件 hash 已通过也不会改变其中任何一项状态。
 */
export type InspectionPending = readonly [
    "ARCHIVE_MEMBERS",
    "NPM_ARCHIVE_CONTENT_AND_GRAPH",
    "CHROME_PHYSICAL_LAYOUT",
    "TARGET_EXECUTION_AND_PROVENANCE",
    "FINAL_PAYLOAD_V2",
];
/**
 * 总报告同时返回冻结配方、来源绑定、归档收据、五树结果和真正读取过的去重证据，并固定静态图状态及所有 pending；成功可以
 * 阻断坏输入，但不能产生 Runtime 候选目录、签名状态或产品 ready 声明。
 */
export type InputInspection = Frozen<{
    kind: "MAC_RUNTIME_INPUT_INSPECTION";
    status: "BOUND_INPUTS_STATIC_VERIFIED_ARCHIVES_PENDING";
    recipeSha256: Sha;
    recipe: Recipe;
    sourceBinding: SourceBindingV1;
    nodeReceipt: NodeReceipt;
    chromeReceipt: ChromeReceipt;
    chromeLayout: ChromeLayoutReceipt;
    checkedEvidence: Ref[];
    trees: {
        entries: TreeInspection<EntriesReceipt>;
        execution: TreeInspection<ExecutionReceipt>;
        dependencies: TreeInspection<DependenciesReceipt>;
        native: TreeInspection<NativeReceipt>;
        engine: TreeInspection<EngineReceipt>;
    };
    graphStatus: "STATIC_REFERENCES_VERIFIED";
    pending: InspectionPending;
}>;
/**
 * 固定错误码覆盖输入与后续载荷阶段的统一拒绝分类，本片实际只在 INPUTS 阶段使用对应子集；公开消息不能动态拼接路径、JSON
 * 或命令，外层只允许受控 errno 进入 causeCode 以供稳定诊断。
 */
export type PayloadErrorCode =
    | "PAYLOAD_INPUT_INVALID"
    | "PAYLOAD_EXPECTED_MISMATCH"
    | "PAYLOAD_LIMIT"
    | "PAYLOAD_PATH"
    | "PAYLOAD_COLLISION"
    | "PAYLOAD_SOURCE_CHANGED"
    | "PAYLOAD_ARCHIVE_HASH"
    | "PAYLOAD_ARCHIVE_FORMAT"
    | "PAYLOAD_ARCHIVE_UNSUPPORTED"
    | "PAYLOAD_ARCHIVE_CRC"
    | "PAYLOAD_ARCHIVE_RANGE"
    | "PAYLOAD_ARCHIVE_LINK"
    | "PAYLOAD_TREE_MISMATCH"
    | "PAYLOAD_RECEIPT_MISMATCH"
    | "PAYLOAD_GRAPH_MISMATCH"
    | "PAYLOAD_BIN_UNSUPPORTED"
    | "PAYLOAD_NATIVE_INPUT_INVALID"
    | "PAYLOAD_ENGINE_INPUT_INVALID"
    | "PAYLOAD_DISK_INSUFFICIENT"
    | "PAYLOAD_DESTINATION_EXISTS"
    | "PAYLOAD_CANCELLED"
    | "PAYLOAD_IO"
    | "PAYLOAD_STATIC_VERIFY_FAILED"
    | "PAYLOAD_COMMIT_UNCONFIRMED";
/**
 * 清理状态沿用载荷统一合同，但本片纯读取默认 NOT_NEEDED 且没有候选目录可删除；CLI 二次信号或关闭期限超时只能明确报告
 * INCOMPLETE，不能把未确认句柄状态伪称已安全关闭。
 */
export type Cleanup = "NOT_NEEDED" | "CONFIRMED" | "INCOMPLETE";
/**
 * 阶段标识保持与后续归档、复制、核验及发布阶段共用的统一合同，本片所有错误恒为 INPUTS；公开类型完整保留未来错误识别兼容
 * 性，但不会导出任何未实现的 intake 或 stage 可调用入口。
 */
export type Phase = "INPUTS" | "INTAKE" | "COPY" | "VERIFY" | "PUBLISH";

/**
 * 核验异常只携带固定英文分类与受控系统错误码，不保留可能包含输入正文的原始异常；所有输入阶段都不创建候选目录，取消超时
 * 只允许显式报告句柄关闭尚未确认。
 */
export class RuntimePayloadError extends Error {
    readonly phase: Phase;
    readonly candidateDirectory: string | null;
    /**
     * 错误构造只保留固定分类、阶段与受控 causeCode，实例随后冻结防止调用方改写诊断分支；没有原始 cause 或任意 message，
     * 末尾上下文复制阶段与候选目录标量，旧调用仍维持输入阶段与空目录，不混淆真实事务的
     * 清理事实。
     */
    constructor(
        public readonly code: PayloadErrorCode,
        public readonly causeCode: string | null = null,
        public readonly cleanup: Cleanup = "NOT_NEEDED",
        context?: Readonly<{ phase: Phase; candidateDirectory: string | null }>,
    ) {
        super(code);
        this.name = "RuntimePayloadError";
        this.phase = context?.phase ?? "INPUTS";
        this.candidateDirectory = context?.candidateDirectory ?? null;
        Object.freeze(this);
    }
}
/**
 * 纯解析在任何异步操作前复制原始字节并独立验证期望字段，摘要匹配后仍逐项核目标与来源政策；返回深冻结配方只表示结构和独
 * 立来源绑定成立，所有引用正文留待真实核验。
 */
export function parseRuntimePayloadInputs(
    bytes: Uint8Array,
    expected: ExpectedPayloadInputs,
): Recipe {
    return admitRuntimePayloadInputs(bytes, expected).recipe;
}
/**
 * 准入函数先复制调用方字节再取得独立期望快照，拒绝访问器及非 JSON 类型，绝不冻结调用方对象；错误策略在首次 await 前固定
 * ，即使调用者随后改写所有原对象也无法替换政策。
 */
export function admitRuntimePayloadInputs(bytes: Uint8Array, expected: ExpectedPayloadInputs) {
    if (!(bytes instanceof Uint8Array)) fail("PAYLOAD_INPUT_INVALID");
    if (bytes.byteLength > limits.json) fail("PAYLOAD_LIMIT");
    const snapshot = Uint8Array.from(bytes);
    schemas.expected(expected);
    const policy = checked<ExpectedPayloadInputs>(
        JSON.parse(JSON.stringify(expected)),
        schemas.expected,
    );
    const digest = sha(snapshot);
    if (digest !== policy.recipeSha256) fail("PAYLOAD_EXPECTED_MISMATCH");
    const recipe = checked<Recipe>(decode(snapshot), schemas.recipe);
    recipePolicy(recipe, policy);
    return { recipe, recipeSha256: digest, bytes: snapshot, expected: policy };
}
/**
 * 核验入口自行准入配方并同步快照输入根与取消信号，再逐字节读取所有引用和完整树，最后回查来源身份；报告保留固定五项
 * pending，不因压缩文件摘要通过而声称已检查展开内容或执行来源。
 */
export async function verifyRuntimePayloadInputs(
    bytes: Uint8Array,
    expected: ExpectedPayloadInputs,
    options: { inputRoot: string; signal?: AbortSignal },
): Promise<InputInspection> {
    const inputRoot = options?.inputRoot,
        signal = options?.signal;
    const { recipe, recipeSha256 } = admitRuntimePayloadInputs(bytes, expected);
    if (typeof inputRoot !== "string" || (signal !== undefined && !(signal instanceof AbortSignal)))
        fail("PAYLOAD_INPUT_INVALID");
    if (!isNode24Version(process.versions.node) || typeof crc32 !== "function")
        fail("PAYLOAD_INPUT_INVALID");
    const reader = new InputReader(inputRoot, signal, [
        recipe.entries.root,
        recipe.execution.root,
        recipe.dependencies.root,
        recipe.native.root,
        recipe.engine.root,
    ]);
    try {
        await reader.initialize();
        const verified = await verifyReceipts(recipe, reader);
        await verifyGraph(recipe, reader, verified.trees, verified.nodeReceipt);
        await reader.finish();
        return freeze({
            kind: "MAC_RUNTIME_INPUT_INSPECTION",
            status: "BOUND_INPUTS_STATIC_VERIFIED_ARCHIVES_PENDING",
            recipeSha256,
            recipe,
            ...verified,
            checkedEvidence: [...reader.checked.values()].sort((a, b) =>
                a.path < b.path ? -1 : 1,
            ),
            graphStatus: "STATIC_REFERENCES_VERIFIED",
            pending: [
                "ARCHIVE_MEMBERS",
                "NPM_ARCHIVE_CONTENT_AND_GRAPH",
                "CHROME_PHYSICAL_LAYOUT",
                "TARGET_EXECUTION_AND_PROVENANCE",
                "FINAL_PAYLOAD_V2",
            ],
        });
    } catch (error) {
        reader.abort();
        io(error);
    }
}
