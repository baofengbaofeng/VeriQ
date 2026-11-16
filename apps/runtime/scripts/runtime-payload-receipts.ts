import { canonicalBytes, validateSchema, type ApprovedEngineInventoryV1 } from "@veriq/contracts";
import { isNode24Version } from "../src/node-version.ts";
import {
    admitContent,
    contentLimit,
    decode,
    fail,
    freeze,
    limits,
    paths,
    relative,
    sha,
    type InputReader,
} from "./runtime-payload-tree.ts";
import type {
    Recipe,
    ExpectedPayloadInputs,
    SourceBindingV1,
    TreeInventory,
    Build,
    EntriesReceipt,
    ExecutionReceipt,
    DependenciesReceipt,
    NativeReceipt,
    EngineReceipt,
    NodeReceipt,
    ChromeReceipt,
    ChromeLayoutReceipt,
    NativeBinInspection,
    Ref,
    BoundTree,
    TreeKind,
    DependencyGraph,
} from "./runtime-payload-inputs.ts";

/**
 * 校验器仅检查已经有界解码的 JSON 值，不转换类型、不填充默认值或删除未知字段；组合器保持精确字段合同，最终唯一类型断言
 * 只发生在完整结构校验成功之后。
 */
type Check = (value: unknown) => void;
/**
 * 精确对象必须是普通 JSON 对象并拥有规定的全部字段，继承属性和未知字段不能被用来补齐合同；其子校验器仍逐个运行，以防浅
 * 层形状正确却藏有错误的嵌套 Ref。
 */
function object(shape: Record<string, Check>): Check {
    return (value) => {
        if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.getPrototypeOf(value) !== Object.prototype ||
            Object.getOwnPropertySymbols(value).length > 0
        )
            fail("PAYLOAD_INPUT_INVALID");
        const record = value as Record<string, unknown>,
            keys = Object.keys(record);
        if (
            keys.length !== Object.keys(shape).length ||
            Object.keys(shape).some((k) => !Object.hasOwn(record, k))
        )
            fail("PAYLOAD_INPUT_INVALID");
        for (const [key, check] of Object.entries(shape)) {
            const descriptor = Object.getOwnPropertyDescriptor(record, key);
            if (!descriptor || !("value" in descriptor)) fail("PAYLOAD_INPUT_INVALID");
            check(record[key]);
        }
    };
}
/**
 * 数组声明先核固定计数上限再检查成员，避免大列表进入更昂贵的路径或图闭包阶段；可空性由具体语义决定，结构检查不能自动把
 * 缺失字段替换为空数组。
 */
function array(check: Check, max: number = limits.entries): Check {
    return (value) => {
        if (!Array.isArray(value)) fail("PAYLOAD_INPUT_INVALID");
        if (value.length > max) fail("PAYLOAD_LIMIT");
        for (const item of value) check(item);
    };
}
/**
 * 字符串按 UTF8 字节约束而非 JavaScript 字符数量计费，控制字符与空字符串默认拒绝；实际版本、包名和路径另用专门谓词，不
 * 能用通用字符串检查替代相应合同。
 */
function text(max = 2048): Check {
    return (value) => {
        if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value))
            fail("PAYLOAD_INPUT_INVALID");
        if (Buffer.byteLength(value) > max) fail("PAYLOAD_LIMIT");
    };
}
/**
 * 枚举采用严格值比较，布尔值、数字与字符串之间不做转换，null 只在明确列出的可空字段允许；这使所有 kind 与固定平台标记在
 * 解码后仍保持可判别类型。
 */
function one(...values: unknown[]): Check {
    return (value) => {
        if (!values.includes(value)) fail("PAYLOAD_INPUT_INVALID");
    };
}
/**
 * 正则检查仅用于明确的有限标记语法，不承担 JavaScript 导入分析或归档解析；全串锚点拒绝尾随换行，长度预算先执行，防止超
 * 大声明浪费解析与匹配资源。
 */
function match(pattern: RegExp, max = 2048): Check {
    return (value) => {
        text(max)(value);
        if (!pattern.test(value as string)) fail("PAYLOAD_INPUT_INVALID");
    };
}
/**
 * 可空字段必须真实写出 null，不能省略后由程序猜测不存在；非空值仍经过原校验器检查，特别是 native bin inspection 与
 * optional edge 不能借 null 绕过 kind 约束。
 */
function nullable(check: Check): Check {
    return (value) => {
        if (value !== null) check(value);
    };
}
const hash = match(/^[a-f0-9]{64}$/),
    commit = match(/^[a-f0-9]{40}$/),
    version = match(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/, 128),
    id = match(/^p[0-9]{1,4}$/),
    path: Check = (v) => {
        relative(v);
    };
const size: Check = (value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        fail("PAYLOAD_INPUT_INVALID");
    if (value > limits.file) fail("PAYLOAD_LIMIT");
};
const digestShape = { sizeBytes: size, sha256: hash };
const refShape = { path, ...digestShape };
const digest = object(digestShape),
    ref = object(refShape),
    file = object({ ...refShape, mode: one(292, 420, 365, 493) }),
    link = object({
        path,
        target: (v) => {
            relative(v, true);
        },
    });
const toolName = one("node", "pnpm", "tar", "yauzl", "vite", "electron-vite", "node-gyp", "clang"),
    arch = one("x64", "arm64"),
    targetSmall = object({ platform: one("darwin"), arch });
const target = object({
    platform: one("darwin"),
    arch,
    productVersion: version,
    nodeVersion: (v) => {
        if (!isNode24Version(v)) fail("PAYLOAD_INPUT_INVALID");
    },
    engineVersion: version,
});
const buildShape = {
    commit,
    sourceBindingSha256: hash,
    pnpmLockSha256: hash,
    target: targetSmall,
    producer: ref,
    config: ref,
    toolNames: array(toolName, 8),
    commandEvidence: ref,
};
const base = (kind: string) => ({
    schemaVersion: one(1),
    kind: one(kind),
    build: object(buildShape),
    treeInventorySha256: hash,
});
const bin = object({
    owner: id,
    name: path,
    aliasPath: path,
    sourceAlias: nullable(path),
    targetPath: path,
    targetSha256: hash,
    launcher: one("node", "native"),
    inspection: nullable(ref),
});
const graph = object({
    instances: array(
        object({
            id,
            root: path,
            name: text(),
            version,
            lockSnapshot: text(),
            packageJson: digest,
            ownTreeSha256: hash,
        }),
        limits.instances,
    ),
    edges: array(
        object({
            from: id,
            alias: text(),
            kind: one("dependency", "peer", "optional", "optional-peer"),
            requested: text(),
            to: nullable(id),
            absence: one(null, "TARGET_NOT_APPLICABLE", "OPTIONAL_PEER_ABSENT"),
        }),
        limits.edges,
    ),
    rootBindings: array(object({ consumer: path, specifier: text(), to: id }), limits.edges),
    bins: array(bin, limits.bins),
    resolutionProof: object({
        method: one("NODE_RESOLVE"),
        nodeVersion: version,
        nodeExecutableSha256: hash,
        target: targetSmall,
        resolutions: array(
            object({
                from: match(/^(p[0-9]{1,4}|\$root|\$entry|\$execution|\$npm)$/),
                consumer: path,
                specifier: text(),
                resolvedFile: path,
                to: id,
            }),
            limits.edges,
        ),
        evidence: ref,
    }),
});
const archive = object({
    file: ref,
    format: one("tar.gz", "zip"),
    topDirectory: path,
    upstream: object({
        url: (v) => {
            text()(v);
            try {
                const u = new URL(v as string);
                if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash)
                    fail("PAYLOAD_INPUT_INVALID");
            } catch {
                fail("PAYLOAD_INPUT_INVALID");
            }
        },
        version: text(128),
        checksumEvidence: ref,
    }),
    receipt: ref,
});
const bound = object({ root: path, inventory: ref, buildReceipt: ref });
/**
 * 具体 schema 覆盖配方、来源与每种 receipt 的全部必填字段，嵌套对象均拒绝未知成员；图数组只表达静态声明，后续闭包与真实
 * 包正文核验仍在专门模块执行。
 */
export const schemas = {
    expected: object({
        recipeSha256: hash,
        target,
        commit,
        sourceBindingSha256: hash,
        pnpmLockSha256: hash,
        chromeLayoutSha256: hash,
    }),
    recipe: object({
        schemaVersion: one(1),
        kind: one("MAC_RUNTIME_PAYLOAD_INPUTS"),
        target,
        source: object({ commit, archive: ref, binding: ref, pnpmLock: ref }),
        tools: array(
            object({ name: toolName, version: text(128), artifactSha256: hash, evidence: ref }),
            8,
        ),
        node: archive,
        chrome: archive,
        chromeLayout: ref,
        entries: bound,
        execution: bound,
        dependencies: bound,
        native: bound,
        engine: bound,
    }),
    source: object({
        schemaVersion: one(1),
        kind: one("SOURCE_BINDING"),
        commit,
        files: array(ref),
    }),
    inventory: object({
        schemaVersion: one(1),
        kind: one("PAYLOAD_INPUT_TREE"),
        treeKind: one("entries", "execution", "dependencies", "native", "engine"),
        directories: array(path),
        files: array(file),
        links: array(link, limits.links),
    }),
    entries: object({
        ...base("ENTRIES_BUILD"),
        entrypoints: object({ agent: one("agent.js"), cli: one("cli.js") }),
        outputs: array(
            object({
                path,
                kind: one("entry", "chunk", "asset"),
                imports: array(
                    object({
                        specifier: text(),
                        kind: one("relative", "external", "builtin"),
                        target: text(),
                        dynamic: one(true, false),
                    }),
                    limits.edges,
                ),
            }),
        ),
        embeddedWorkspaces: array(
            object({ name: text(), version, sourcePaths: array(path) }),
            limits.instances,
        ),
    }),
    execution: object({
        ...base("EXECUTION_SOURCE_COPY"),
        members: array(object({ path, sourcePath: path, sha256: hash }), 8),
    }),
    dependencies: object({
        ...base("PRODUCTION_DEPENDENCIES"),
        graph,
        linker: object({
            name: one("pnpm"),
            version: one("11.25.0"),
            mode: one("hoisted"),
            sourceLockSha256: hash,
            lockAfterSha256: hash,
            ignoreScripts: one(true),
            offline: one(true),
            frozenLockfile: one(true),
        }),
        optionalDecisions: array(
            object({
                from: id,
                alias: text(),
                action: one("include", "exclude-target", "absent-optional-peer"),
                evidence: ref,
            }),
            limits.edges,
        ),
    }),
    native: object({
        ...base("NATIVE_PRODUCTION_BUILD"),
        outputs: array(
            object({
                path: one("veriq_private_files.node", "vault/veriq_agent"),
                targetName: one("veriq_private_files", "veriq_agent"),
                defines: array(text(), 256),
                sourceFiles: array(ref),
                sha256: hash,
                architecture: one("x86_64", "arm64"),
                minimumOs: one("15.0"),
                sdk: object({ version: text(128), settingsEvidence: ref }),
                inspectionEvidence: ref,
            }),
            2,
        ),
    }),
    engine: object({
        ...base("ENGINE_PAYLOAD"),
        engineVersion: version,
        compilerVersion: version,
        runnerSdkVersion: version,
        inventory: object({ ...digestShape, path: one("inventory.json") }),
        entrySha256: hash,
        files: array(ref, 1000),
        dependencies: array(object({ name: text(), version, integrity: text() }), 1000),
    }),
    node: object({
        schemaVersion: one(1),
        kind: one("NODE_ARCHIVE_INPUT"),
        archiveSha256: hash,
        nodeVersion: version,
        npmVersion: version,
        nodeMember: path,
        npmRoot: path,
        npmPackageJson: digest,
        npmGraph: graph,
        inputLinks: array(link, limits.links),
        inspectionEvidence: ref,
    }),
    chrome: object({
        schemaVersion: one(1),
        kind: one("CHROME_ARCHIVE_INPUT"),
        archiveSha256: hash,
        browserVersion: one("158.0.8127.18"),
        revision: one("1254"),
        playwrightVersion: one("1.65.0"),
        layoutSha256: hash,
        inspectionEvidence: ref,
    }),
    layout: object({
        schemaVersion: one(1),
        kind: one("CHROME_LAYOUT"),
        archiveSha256: hash,
        layout: object({
            bundlePath: path,
            executablePath: path,
            frameworkRoots: array(path, 32),
            allowedLinks: array(link, 256),
        }),
        reviewEvidence: ref,
    }),
    nativeBin: object({
        schemaVersion: one(1),
        kind: one("NATIVE_BIN_INSPECTION"),
        platform: one("darwin"),
        arch,
        path,
        sha256: hash,
        minimumOs: match(/^\d+\.\d+(?:\.\d+)?$/, 128),
        inspectionEvidence: ref,
    }),
};
/**
 * 已有类型唯一转换点先执行完整精确 schema，再冻结解码对象，调用者不能把未经验证的复制品当成解析结果；普通 package.json
 * 刻意不走这个封闭 DTO 入口，因为 npm 允许其它合法字段。
 */
export function checked<T>(value: unknown, check: Check): T {
    check(value);
    return freeze(value) as T;
}
/**
 * 引用文件必须先经过真实逐字节读取与摘要匹配，随后才能作为对应 kind JSON 解码；不同 kind 即使字段相近也无法交换，且过大
 * 的声明在分配正文之前就被拒绝。
 */
export async function document<T>(reader: InputReader, ref: Ref, check: Check): Promise<T> {
    return checked<T>(decode(await reader.ref(ref, true)), check);
}
/**
 * 结构等价使用已有 JCS 实现消除对象键顺序差异，同时保留数组的明确顺序；它仅比较语义内容，不能替代原始文件摘要，特别不能
 * 混淆 engine inventory 与 entry 两种身份。
 */
export const equal = (a: unknown, b: unknown) =>
    a !== undefined &&
    b !== undefined &&
    Buffer.from(canonicalBytes(a)).equals(Buffer.from(canonicalBytes(b)));
/**
 * 集合比较拒绝重复值并忽略工具列表的合法排列顺序，适用于冻结合同规定的精确名称集合；数组里重复同一工具仍然失败，不能靠
 * Set 去重静默修复不合法输入。
 */
export function setEqual(a: readonly string[], b: readonly string[]) {
    return new Set(a).size === a.length && a.length === b.length && a.every((v) => b.includes(v));
}

/**
 * 配方结构核验完成后同步绑定所有独立 expected 字段，树根与证据路径不能重叠或制造自哈希；此步骤完全不做 I/O，适合在
 * verify 首次 await 前固定来源政策。
 */
export function recipePolicy(recipe: Recipe, expected: ExpectedPayloadInputs) {
    if (
        !equal(recipe.target, expected.target) ||
        recipe.source.commit !== expected.commit ||
        recipe.source.binding.sha256 !== expected.sourceBindingSha256 ||
        recipe.source.pnpmLock.sha256 !== expected.pnpmLockSha256 ||
        recipe.chromeLayout.sha256 !== expected.chromeLayoutSha256
    )
        fail("PAYLOAD_EXPECTED_MISMATCH");
    const roots = (["entries", "execution", "dependencies", "native", "engine"] as const).map(
        (k) => recipe[k].root,
    );
    paths(roots);
    for (const a of roots)
        for (const b of roots)
            if (a !== b && (a.startsWith(b + "/") || b.startsWith(a + "/"))) fail("PAYLOAD_PATH");
    if (new Set(roots).size !== 5) fail("PAYLOAD_PATH");
    const tools = recipe.tools;
    if (new Set(tools.map((t) => t.name)).size !== tools.length) fail("PAYLOAD_INPUT_INVALID");
    const versions = {
        tar: "7.5.22",
        yauzl: "3.4.0",
        pnpm: "11.25.0",
        node: recipe.target.nodeVersion,
    };
    for (const [name, v] of Object.entries(versions))
        if (tools.find((t) => t.name === name)?.version !== v) fail("PAYLOAD_RECEIPT_MISMATCH");
    if (
        recipe.node.format !== "tar.gz" ||
        recipe.node.topDirectory !==
            `node-v${recipe.target.nodeVersion}-darwin-${recipe.target.arch}` ||
        recipe.node.upstream.version !== recipe.target.nodeVersion ||
        recipe.chrome.format !== "zip" ||
        recipe.chrome.topDirectory !== `chrome-mac-${recipe.target.arch}` ||
        recipe.chrome.upstream.version !== "158.0.8127.18"
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
}

/**
 * 收据读取与核验共享同一 reader，将来源副本、工具证据和原归档摘要绑定到配方，不能只相信外部自报 hash；opaque evidence
 * 内容只证明真实读取一致，不证明工具实际执行或来源身份。
 */
export async function verifyReceipts(recipe: Recipe, reader: InputReader) {
    const source = await document<SourceBindingV1>(reader, recipe.source.binding, schemas.source);
    if (source.commit !== recipe.source.commit) fail("PAYLOAD_RECEIPT_MISMATCH");
    paths(source.files.map((f) => f.path));
    admitContent(source.files);
    const sourceMap = new Map(source.files.map((f) => [f.path, f]));
    const boundSource = async (ref: Ref) => {
        const declared = sourceMap.get(ref.path);
        if (!declared || !equal(declared, ref)) fail("PAYLOAD_RECEIPT_MISMATCH");
        await reader.ref(ref, false, contentLimit(ref.path), false);
    };
    if (
        !equal(sourceMap.get("pnpm-lock.yaml"), {
            ...recipe.source.pnpmLock,
            path: "pnpm-lock.yaml",
        }) ||
        recipe.source.pnpmLock.path !== "pnpm-lock.yaml"
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
    for (const file of source.files) await reader.ref(file, false, contentLimit(file.path), false);
    await reader.ref(recipe.source.archive, false, limits.file);
    await boundSource(recipe.source.pnpmLock);
    for (const tool of recipe.tools) await reader.ref(tool.evidence);
    for (const archive of [recipe.node, recipe.chrome]) {
        await reader.ref(archive.file, false, limits.file);
        await reader.ref(archive.upstream.checksumEvidence);
    }
    const node = await document<NodeReceipt>(reader, recipe.node.receipt, schemas.node),
        chrome = await document<ChromeReceipt>(reader, recipe.chrome.receipt, schemas.chrome),
        layout = await document<ChromeLayoutReceipt>(reader, recipe.chromeLayout, schemas.layout);
    if (
        node.archiveSha256 !== recipe.node.file.sha256 ||
        node.nodeVersion !== recipe.target.nodeVersion ||
        node.nodeMember !== `${recipe.node.topDirectory}/bin/node` ||
        node.npmRoot !== `${recipe.node.topDirectory}/lib/node_modules/npm`
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
    if (
        chrome.archiveSha256 !== recipe.chrome.file.sha256 ||
        chrome.layoutSha256 !== recipe.chromeLayout.sha256 ||
        layout.archiveSha256 !== recipe.chrome.file.sha256
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
    await reader.ref(node.inspectionEvidence);
    await reader.ref(chrome.inspectionEvidence);
    await reader.ref(layout.reviewEvidence);
    const bundle = `browser/chrome-mac-${recipe.target.arch}/Google Chrome for Testing.app`;
    if (
        layout.layout.bundlePath !== bundle ||
        layout.layout.executablePath !== `${bundle}/Contents/MacOS/Google Chrome for Testing`
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
    paths(layout.layout.frameworkRoots);
    paths(layout.layout.allowedLinks.map((l) => l.path));
    for (const root of layout.layout.frameworkRoots)
        if (
            !root.startsWith(`${bundle}/Contents/Frameworks/`) ||
            root.slice(`${bundle}/Contents/Frameworks/`.length).includes("/") ||
            !root.endsWith(".framework")
        )
            fail("PAYLOAD_RECEIPT_MISMATCH");
    for (const l of layout.layout.allowedLinks)
        if (!layout.layout.frameworkRoots.some((r) => l.path.startsWith(r + "/")))
            fail("PAYLOAD_RECEIPT_MISMATCH");
    const load = async <R>(kind: TreeKind, check: Check) => {
        const tree = recipe[kind],
            inventory = await document<TreeInventory>(reader, tree.inventory, schemas.inventory),
            receipt = await document<R & { build: Build; treeInventorySha256: string }>(
                reader,
                tree.buildReceipt,
                check,
            );
        if (inventory.treeKind !== kind || receipt.treeInventorySha256 !== tree.inventory.sha256)
            fail("PAYLOAD_RECEIPT_MISMATCH");
        const b = receipt.build;
        if (
            b.commit !== recipe.source.commit ||
            b.sourceBindingSha256 !== recipe.source.binding.sha256 ||
            b.pnpmLockSha256 !== recipe.source.pnpmLock.sha256 ||
            !equal(b.target, { platform: "darwin", arch: recipe.target.arch })
        )
            fail("PAYLOAD_RECEIPT_MISMATCH");
        await boundSource(b.producer);
        await boundSource(b.config);
        await reader.ref(b.commandEvidence);
        const counts = {
            fileCount: inventory.files.length,
            directoryCount: inventory.directories.length,
            linkCount: inventory.links.length,
            fileBytes: inventory.files.reduce((n, f) => n + f.sizeBytes, 0),
        };
        return {
            inventory,
            receipt,
            inventorySha256: tree.inventory.sha256,
            receiptSha256: tree.buildReceipt.sha256,
            ...counts,
        };
    };
    const entries = await load<EntriesReceipt>("entries", schemas.entries),
        execution = await load<ExecutionReceipt>("execution", schemas.execution),
        dependencies = await load<DependenciesReceipt>("dependencies", schemas.dependencies),
        native = await load<NativeReceipt>("native", schemas.native),
        engine = await load<EngineReceipt>("engine", schemas.engine);
    // 所有库存声明先统一核总成员、链接和普通内容预算，不能给五棵树各分配一次完整额度；此预检只读取有界 JSON，不会为超额
    // 声明创建目录或等待后面的物理树失败。
    const inventories = [
        entries.inventory,
        execution.inventory,
        dependencies.inventory,
        native.inventory,
        engine.inventory,
    ];
    for (const inventory of inventories) admitContent(inventory.files);
    if (
        inventories.reduce(
            (n, i) => n + i.directories.length + i.files.length + i.links.length,
            0,
        ) > limits.entries ||
        inventories.reduce((n, i) => n + i.links.length, 0) > limits.links ||
        inventories.reduce((n, i) => n + i.files.reduce((sum, f) => sum + f.sizeBytes, 0), 0) >
            limits.total
    )
        fail("PAYLOAD_LIMIT");
    // 先核所有 AST 文件声明与跨树总预算，再读取任何树的正文，避免把大 JS 当四 MiB JSON 或等到分配后才拒绝；asset 中的
    // JS 也需要检查字面导入，不能通过角色标记绕开图完整性。
    const codeOutputs = entries.receipt.outputs.filter(
        (o) => o.kind !== "asset" || /\.(?:js|mjs|cjs)$/.test(o.path),
    );
    reader.planScripts(
        recipe.entries,
        codeOutputs.map((o) => {
            const file = entries.inventory.files.find((f) => f.path === o.path);
            if (!file) fail("PAYLOAD_GRAPH_MISMATCH");
            return file;
        }),
    );
    reader.planScripts(recipe.execution, execution.inventory.files);
    for (const [kind, inspection] of [
        ["entries", entries],
        ["execution", execution],
        ["dependencies", dependencies],
        ["native", native],
        ["engine", engine],
    ] as const)
        await reader.tree(recipe[kind], inspection.inventory, kind);
    const all = [entries, execution, dependencies, native, engine];
    if (
        !setEqual(entries.receipt.build.toolNames, ["node", "vite"]) &&
        !setEqual(entries.receipt.build.toolNames, ["node", "vite", "electron-vite"])
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
    for (const [r, names] of [
        [execution, ["node"]],
        [dependencies, ["node", "pnpm"]],
        [native, ["node", "node-gyp", "clang"]],
        [engine, ["node", "pnpm"]],
    ] as const)
        if (!setEqual(r.receipt.build.toolNames, names)) fail("PAYLOAD_RECEIPT_MISMATCH");
    const names = [
        ...new Set([
            "node",
            "pnpm",
            "tar",
            "yauzl",
            ...all.flatMap((r) => r.receipt.build.toolNames),
        ]),
    ];
    if (
        !setEqual(
            recipe.tools.map((t) => t.name),
            names,
        )
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
    const members = execution.receipt.members,
        executionPaths = [
            "worker",
            "provider",
            "compile-entry",
            "archive",
            "controlled-command",
            "controlled-child",
            "controlled-child-protocol",
            "controlled-child-preload",
        ].map((n) => `${n}.mjs`);
    if (
        !setEqual(
            members.map((m) => m.path),
            executionPaths,
        ) ||
        !setEqual(
            execution.inventory.files.map((f) => f.path),
            executionPaths,
        )
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
    for (const m of members) {
        const f = execution.inventory.files.find((f) => f.path === m.path),
            sourceRef = sourceMap.get(m.sourcePath);
        if (
            m.sourcePath !== `apps/runtime/src/execution/${m.path}` ||
            !f ||
            !sourceRef ||
            f.sha256 !== m.sha256 ||
            sourceRef.sha256 !== m.sha256 ||
            sourceRef.sizeBytes !== f.sizeBytes
        )
            fail("PAYLOAD_RECEIPT_MISMATCH");
    }
    for (const workspace of entries.receipt.embeddedWorkspaces) {
        if (!workspace.sourcePaths.length || !workspace.name.startsWith("@veriq/"))
            fail("PAYLOAD_RECEIPT_MISMATCH");
        for (const p of workspace.sourcePaths)
            if (!sourceMap.has(p)) fail("PAYLOAD_RECEIPT_MISMATCH");
        const manifests = source.files.filter((f) => f.path.endsWith("/package.json"));
        let matched = false;
        for (const manifest of manifests) {
            const pkg = decode(await reader.ref(manifest, true)) as Record<string, unknown>;
            if (
                pkg &&
                pkg.name === workspace.name &&
                pkg.version === workspace.version &&
                workspace.sourcePaths.every((p) => p.startsWith(manifest.path.slice(0, -12)))
            )
                matched = true;
        }
        if (!matched) fail("PAYLOAD_RECEIPT_MISMATCH");
    }
    for (const required of [
        "apps/runtime/native/darwin/binding.gyp",
        "apps/runtime/scripts/build-darwin.mjs",
        "apps/runtime/scripts/build-vault-darwin.mjs",
    ])
        if (!sourceMap.has(required)) fail("PAYLOAD_NATIVE_INPUT_INVALID");
    if (
        !setEqual(
            native.receipt.outputs.map((o) => o.path),
            ["veriq_private_files.node", "vault/veriq_agent"],
        ) ||
        !setEqual(
            native.inventory.files.map((f) => f.path),
            ["veriq_private_files.node", "vault/veriq_agent"],
        )
    )
        fail("PAYLOAD_NATIVE_INPUT_INVALID");
    for (const output of native.receipt.outputs) {
        const f = native.inventory.files.find((f) => f.path === output.path),
            addon = output.path === "veriq_private_files.node";
        const productionSources = addon
            ? ["apps/runtime/native/darwin/addon.cc", "apps/runtime/native/darwin/private-files.h"]
            : [
                  "apps/runtime/native/vault/darwin-vault.mm",
                  "apps/runtime/native/vault/darwin-acl.hpp",
              ];
        if (
            !setEqual(
                output.sourceFiles.map((f) => f.path),
                productionSources,
            ) ||
            !setEqual(output.defines, addon ? ["NAPI_CPP_EXCEPTIONS", "NAPI_VERSION=9"] : []) ||
            !f ||
            (addon ? ![292, 420].includes(f.mode) : ![365, 493].includes(f.mode))
        )
            fail("PAYLOAD_NATIVE_INPUT_INVALID");
        if (
            !f ||
            f.sha256 !== output.sha256 ||
            output.targetName !==
                (output.path === "veriq_private_files.node"
                    ? "veriq_private_files"
                    : "veriq_agent") ||
            output.architecture !== (recipe.target.arch === "x64" ? "x86_64" : "arm64")
        )
            fail("PAYLOAD_NATIVE_INPUT_INVALID");
        paths(output.sourceFiles.map((f) => f.path));
        for (const sourceRef of output.sourceFiles) {
            await boundSource(sourceRef);
        }
        await reader.ref(output.sdk.settingsEvidence);
        await reader.ref(output.inspectionEvidence);
    }
    const er = engine.receipt,
        invFact = engine.inventory.files.find((f) => f.path === "inventory.json");
    if (
        !invFact ||
        !equal(er.inventory, {
            path: invFact.path,
            sizeBytes: invFact.sizeBytes,
            sha256: invFact.sha256,
        }) ||
        er.engineVersion !== recipe.target.engineVersion
    )
        fail("PAYLOAD_ENGINE_INPUT_INVALID");
    const raw = decode(await reader.member(recipe.engine, invFact));
    if (validateSchema("ApprovedEngineInventoryV1", raw).length)
        fail("PAYLOAD_ENGINE_INPUT_INVALID");
    const original = raw as ApprovedEngineInventoryV1,
        matched = original.engines.filter((e) => e.engineVersion === recipe.target.engineVersion);
    if (matched.length !== 1) fail("PAYLOAD_ENGINE_INPUT_INVALID");
    const entry = matched[0]!;
    if (
        entry.compilerVersion !== er.compilerVersion ||
        entry.runnerSdkVersion !== er.runnerSdkVersion ||
        !equal(entry.files, er.files) ||
        !equal(entry.dependencies, er.dependencies) ||
        sha(canonicalBytes(entry)) !== er.entrySha256
    )
        fail("PAYLOAD_ENGINE_INPUT_INVALID");
    paths(er.files.map((f) => f.path));
    let total = 0;
    for (const f of er.files) {
        if (
            !new RegExp(
                "^(package\\.json|package-lock\\.json|dependencies\\.json|engine/compiler\\.tgz|vendor/[a-zA" +
                    "-Z0-9_.-]+\\.tgz)$",
                "",
            ).test(f.path)
        )
            fail("PAYLOAD_ENGINE_INPUT_INVALID");
        total += f.sizeBytes;
        const physical = engine.inventory.files.find((p) => p.path === f.path);
        if (!physical || physical.sizeBytes !== f.sizeBytes || physical.sha256 !== f.sha256)
            fail("PAYLOAD_ENGINE_INPUT_INVALID");
    }
    if (total > 128 * 1024 ** 2) fail("PAYLOAD_LIMIT");
    if (
        !setEqual(
            engine.inventory.files.map((f) => f.path),
            ["inventory.json", ...er.files.map((f) => f.path)],
        ) ||
        ["package.json", "package-lock.json", "dependencies.json", "engine/compiler.tgz"].some(
            (p) => !er.files.some((f) => f.path === p),
        )
    )
        fail("PAYLOAD_ENGINE_INPUT_INVALID");
    const parents = new Set<string>();
    for (const f of engine.inventory.files) {
        let parent = f.path.split("/").slice(0, -1);
        while (parent.length) {
            parents.add(parent.join("/"));
            parent = parent.slice(0, -1);
        }
    }
    if (!setEqual(engine.inventory.directories, [...parents])) fail("PAYLOAD_ENGINE_INPUT_INVALID");
    const deps = engine.inventory.files.find((f) => f.path === "dependencies.json")!;
    if (!equal(decode(await reader.member(recipe.engine, deps)), er.dependencies))
        fail("PAYLOAD_ENGINE_INPUT_INVALID");
    const linker = dependencies.receipt.linker;
    if (
        linker.sourceLockSha256 !== recipe.source.pnpmLock.sha256 ||
        linker.lockAfterSha256 !== recipe.source.pnpmLock.sha256
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
    for (const decision of dependencies.receipt.optionalDecisions)
        await reader.ref(decision.evidence);
    return {
        sourceBinding: source,
        nodeReceipt: node,
        chromeReceipt: chrome,
        chromeLayout: layout,
        trees: { entries, execution, dependencies, native, engine },
    };
}

/**
 * 第三方原生 bin 使用独立检查 DTO，不能冒充 VeriQ 两个正式原生产物；这里绑定真实检查记录、目标摘要和最小系统声明，但不
 * 执行 MachO 或认证外部检查工具的真实性。
 */
export async function nativeBin(
    reader: InputReader,
    ref: Ref,
    recipe: Recipe,
    path: string,
    hash: string,
) {
    const info = await document<NativeBinInspection>(reader, ref, schemas.nativeBin);
    const parts = info.minimumOs.split(".").map(Number);
    if (
        parts.some((n) => !Number.isSafeInteger(n)) ||
        parts[0]! > 15 ||
        (parts[0] === 15 && (parts[1]! > 0 || (parts[2] ?? 0) > 0)) ||
        info.arch !== recipe.target.arch ||
        info.path !== path ||
        info.sha256 !== hash
    )
        fail("PAYLOAD_BIN_UNSUPPORTED");
    await reader.ref(info.inspectionEvidence);
}
