import { builtinModules } from "node:module";
import { posix } from "node:path";
import ts from "typescript";
import { canonicalBytes } from "@veriq/contracts";
import { decode, fail, limits, paths, sha, type InputReader } from "./runtime-payload-tree.ts";
import { equal, nativeBin, setEqual } from "./runtime-payload-receipts.ts";
import type {
    Recipe,
    DependencyGraph,
    NodeReceipt,
    PackageInstance,
    TreeInventory,
    EntriesReceipt,
    DependenciesReceipt,
    Ref,
    BoundTree,
    ModuleEdge,
} from "./runtime-payload-inputs.ts";

const builtins = new Set(builtinModules.map((n) => (n.startsWith("node:") ? n : `node:${n}`)));
type ImportFact = { specifier: string; dynamic: boolean };
/** 静态导入分析使用已锁 TypeScript 的语法树处理字面 import、export 与动态 import，避免正则把注释或字符串当成依赖；非字面动态加载保留在固定执行 pending 边界内，不假装穷尽运行期路径。 */
function imports(bytes: Buffer, path: string): ImportFact[] {
    try {
        const sourceText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const result = ts.transpileModule(sourceText, {
            fileName: path,
            reportDiagnostics: true,
            compilerOptions: {
                target: ts.ScriptTarget.ESNext,
                module: ts.ModuleKind.ESNext,
                allowJs: true,
            },
        });
        if (result.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error))
            fail("PAYLOAD_GRAPH_MISMATCH");
        const source = ts.createSourceFile(
                path,
                sourceText,
                ts.ScriptTarget.Latest,
                true,
                ts.ScriptKind.JS,
            ),
            found: ImportFact[] = [];
        const add = (node: ts.Node | undefined, dynamic: boolean) => {
            if (node && ts.isStringLiteralLike(node)) found.push({ specifier: node.text, dynamic });
        };
        const walk = (node: ts.Node) => {
            if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
                add(node.moduleSpecifier, false);
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
                add(node.arguments[0], true);
            ts.forEachChild(node, walk);
        };
        walk(source);
        return [...new Map(found.map((f) => [`${f.dynamic}:${f.specifier}`, f])).values()];
    } catch {
        fail("PAYLOAD_GRAPH_MISMATCH");
    }
}
/** 依赖归属选择最深的明确包实例，并剔除该实例内部 node_modules 与生成 bin 目录；这样嵌套包不能被父包吞并，未列出实例的子树也不会凭路径前缀自动获得所有权。 */
function owner(graph: DependencyGraph, path: string): PackageInstance | undefined {
    const candidates = graph.instances
        .filter((p) => path.startsWith(p.root + "/"))
        .sort((a, b) => b.root.length - a.root.length);
    const first = candidates[0];
    if (!first) return undefined;
    const suffix = path.slice(first.root.length + 1);
    return suffix === "node_modules" ||
        suffix.startsWith("node_modules/") ||
        suffix.split("/").includes(".bin")
        ? undefined
        : first;
}
/** 关系记录的唯一键保留来源实例、消费者和 specifier，不按包名合并 peer 上下文；重复 key 即便内容相同也拒绝，避免后续 Map 覆盖隐藏冲突记录或降低边覆盖要求。 */
function unique<T>(values: readonly T[], key: (v: T) => string) {
    const seen = new Set<string>();
    for (const value of values) {
        const k = key(value);
        if (seen.has(k)) fail("PAYLOAD_GRAPH_MISMATCH");
        seen.add(k);
    }
    return seen;
}
/** 图结构闭包在读取包正文前先验证所有端点、absence 语义与工具目标，npm pending 图也必须满足这些有界声明规则；执行 Node resolve 及归档内真实 npm 文件的检查并不发生在此处。 */
async function graphReferences(
    graph: DependencyGraph,
    recipe: Recipe,
    reader: InputReader,
    npm: NodeReceipt | null,
) {
    unique(graph.instances, (p) => p.id);
    paths(graph.instances.map((p) => p.root));
    unique(graph.edges, (e) => `${e.from}:${e.kind}:${e.alias}`);
    unique(graph.rootBindings, (b) => `${b.consumer}:${b.specifier}`);
    unique(graph.bins, (b) => b.aliasPath);
    unique(graph.resolutionProof.resolutions, (r) => `${r.from}:${r.consumer}:${r.specifier}`);
    const byId = new Map(graph.instances.map((p) => [p.id, p]));
    for (const p of graph.instances) {
        if (!npm && !/^(node_modules|entry\/node_modules|execution\/node_modules)\//.test(p.root))
            fail("PAYLOAD_GRAPH_MISMATCH");
        if (npm) {
            if (p.root !== "npm" && !p.root.startsWith("npm/node_modules/"))
                fail("PAYLOAD_GRAPH_MISMATCH");
            const relative = p.root === "npm" ? "." : p.root.slice(4);
            if (p.lockSnapshot !== `node-archive:${recipe.node.file.sha256}:${relative}`)
                fail("PAYLOAD_GRAPH_MISMATCH");
        }
    }
    for (const e of graph.edges) {
        if (
            !byId.has(e.from) ||
            e.alias.includes("\\") ||
            e.alias.startsWith(".") ||
            e.alias.includes(":")
        )
            fail("PAYLOAD_GRAPH_MISMATCH");
        if (e.to !== null) {
            if (!byId.has(e.to) || e.absence !== null) fail("PAYLOAD_GRAPH_MISMATCH");
        } else if (
            !(
                (e.kind === "optional" && e.absence === "TARGET_NOT_APPLICABLE") ||
                (e.kind === "optional-peer" && e.absence === "OPTIONAL_PEER_ABSENT")
            )
        )
            fail("PAYLOAD_GRAPH_MISMATCH");
    }
    for (const b of graph.rootBindings) if (!byId.has(b.to)) fail("PAYLOAD_GRAPH_MISMATCH");
    // 每个实例都要从显式消费者经已声明的非空依赖边可达，bin 不能自举额外生产根；迭代队列按实例编号保留 peer 上下文，访问集合允许合法循环并受 schema 的实例边数预算约束。
    const reached = new Set(graph.rootBindings.map((b) => b.to)),
        queue = [...reached],
        adjacency = new Map<string, string[]>();
    for (const edge of graph.edges)
        if (edge.to !== null) {
            const list = adjacency.get(edge.from) ?? [];
            list.push(edge.to);
            adjacency.set(edge.from, list);
        }
    for (let index = 0; index < queue.length; index++)
        for (const target of adjacency.get(queue[index]!) ?? [])
            if (!reached.has(target)) {
                reached.add(target);
                queue.push(target);
            }
    if (graph.instances.some((p) => !reached.has(p.id))) fail("PAYLOAD_GRAPH_MISMATCH");
    const proof = graph.resolutionProof;
    if (
        proof.nodeVersion !== recipe.target.nodeVersion ||
        proof.nodeExecutableSha256 !==
            recipe.tools.find((t) => t.name === "node")?.artifactSha256 ||
        !equal(proof.target, { platform: "darwin", arch: recipe.target.arch })
    )
        fail("PAYLOAD_GRAPH_MISMATCH");
    await reader.ref(proof.evidence);
    for (const r of proof.resolutions) {
        const target = byId.get(r.to);
        if (!target || owner(graph, r.resolvedFile)?.id !== target.id)
            fail("PAYLOAD_GRAPH_MISMATCH");
        if (r.from.startsWith("p")) {
            if (
                owner(graph, r.consumer)?.id !== r.from ||
                !graph.edges.some(
                    (e) => e.from === r.from && e.alias === r.specifier && e.to === r.to,
                )
            )
                fail("PAYLOAD_GRAPH_MISMATCH");
        } else if (
            !graph.rootBindings.some(
                (b) => b.consumer === r.consumer && b.specifier === r.specifier && b.to === r.to,
            ) ||
            r.from !==
                (npm
                    ? "$npm"
                    : r.consumer === "package.json"
                      ? "$root"
                      : r.consumer.startsWith("execution/")
                        ? "$execution"
                        : "$entry")
        )
            fail("PAYLOAD_GRAPH_MISMATCH");
    }
    for (const e of graph.edges)
        if (
            e.to !== null &&
            !proof.resolutions.some(
                (r) => r.from === e.from && r.specifier === e.alias && r.to === e.to,
            )
        )
            fail("PAYLOAD_GRAPH_MISMATCH");
    for (const b of graph.rootBindings)
        if (
            !proof.resolutions.some(
                (r) => r.consumer === b.consumer && r.specifier === b.specifier && r.to === b.to,
            )
        )
            fail("PAYLOAD_GRAPH_MISMATCH");
    for (const b of graph.bins) {
        const p = byId.get(b.owner);
        if (
            !p ||
            owner(graph, b.targetPath)?.id !== p.id ||
            b.name.includes("/") ||
            b.name.toLowerCase() === "node"
        )
            fail("PAYLOAD_BIN_UNSUPPORTED");
        const install = p.root.lastIndexOf("node_modules/");
        const alias =
            install >= 0
                ? `${p.root.slice(0, install)}node_modules/.bin/${b.name}`
                : npm && p.root === "npm"
                  ? `npm/.bin/${b.name}`
                  : null;
        if (b.aliasPath !== alias || (b.sourceAlias !== null && b.sourceAlias !== b.aliasPath))
            fail("PAYLOAD_BIN_UNSUPPORTED");
        if (b.launcher === "node") {
            if (b.inspection !== null) fail("PAYLOAD_BIN_UNSUPPORTED");
        } else {
            if (b.inspection === null) fail("PAYLOAD_BIN_UNSUPPORTED");
            await nativeBin(reader, b.inspection, recipe, b.targetPath, b.targetSha256);
        }
    }
    if (npm) {
        const root = graph.instances.filter((p) => p.root === "npm");
        if (
            root.length !== 1 ||
            root[0]!.name !== "npm" ||
            root[0]!.version !== npm.npmVersion ||
            !equal(root[0]!.packageJson, npm.npmPackageJson)
        )
            fail("PAYLOAD_GRAPH_MISMATCH");
        if (
            !graph.rootBindings.some(
                (b) => b.consumer === "npm/bin/npm-cli.js" && b.to === root[0]!.id,
            ) ||
            graph.rootBindings.some((b) => !owner(graph, b.consumer))
        )
            fail("PAYLOAD_GRAPH_MISMATCH");
        paths(npm.inputLinks.map((l) => l.path));
        for (const l of npm.inputLinks) {
            if (!l.path.startsWith(recipe.node.topDirectory + "/")) fail("PAYLOAD_GRAPH_MISMATCH");
        }
    }
}

/** package.json 的依赖字段保持 npm 原始文本，optionalDependencies 覆盖同名普通依赖，peerMeta 决定可空 peer；读取真实正文后逐条覆盖声明，不能让外部 graph 自己证明没有漏边。 */
function declarations(pkg: Record<string, unknown>) {
    const read = (key: string) => {
        const value = pkg[key];
        if (value === undefined) return {} as Record<string, string>;
        if (!value || typeof value !== "object" || Array.isArray(value))
            fail("PAYLOAD_GRAPH_MISMATCH");
        const result: Record<string, string> = {};
        for (const [name, requested] of Object.entries(value)) {
            if (typeof requested !== "string" || !requested || Buffer.byteLength(requested) > 2048)
                fail("PAYLOAD_GRAPH_MISMATCH");
            result[name] = requested;
        }
        return result;
    };
    const deps = read("dependencies"),
        optional = read("optionalDependencies"),
        peers = read("peerDependencies"),
        meta = pkg.peerDependenciesMeta;
    const output: { alias: string; kind: string; requested: string }[] = [];
    for (const [alias, requested] of Object.entries({ ...deps, ...optional }))
        output.push({
            alias,
            requested,
            kind: Object.hasOwn(optional, alias) ? "optional" : "dependency",
        });
    if (meta !== undefined && (!meta || typeof meta !== "object" || Array.isArray(meta)))
        fail("PAYLOAD_GRAPH_MISMATCH");
    for (const [alias, requested] of Object.entries(peers)) {
        const value = (meta as Record<string, unknown> | undefined)?.[alias];
        if (
            value !== undefined &&
            (!value ||
                typeof value !== "object" ||
                Array.isArray(value) ||
                ("optional" in value && typeof value.optional !== "boolean"))
        )
            fail("PAYLOAD_GRAPH_MISMATCH");
        output.push({
            alias,
            requested,
            kind:
                value && typeof value === "object" && "optional" in value && value.optional === true
                    ? "optional-peer"
                    : "peer",
        });
    }
    return output;
}
/** 自有树摘要使用合同规定的 JCS 文件事实，路径改为包内相对并按 ASCII 排序，剔除嵌套 node_modules 与 generated bin；真实 package 正文的 name/version 和精确摘要也必须同时匹配实例声明。 */
export async function verifyPackageContents(
    graph: DependencyGraph,
    inventory: TreeInventory,
    tree: BoundTree,
    reader: InputReader,
) {
    const manifestMap = new Map<string, Record<string, unknown>>();
    for (const p of graph.instances) {
        const fact = inventory.files.find((f) => f.path === `${p.root}/package.json`);
        if (
            !fact ||
            fact.sizeBytes !== p.packageJson.sizeBytes ||
            fact.sha256 !== p.packageJson.sha256
        )
            fail("PAYLOAD_GRAPH_MISMATCH");
        const raw = decode(await reader.member(tree, fact, limits.package));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("PAYLOAD_GRAPH_MISMATCH");
        const pkg = raw as Record<string, unknown>;
        if (pkg.name !== p.name || pkg.version !== p.version) fail("PAYLOAD_GRAPH_MISMATCH");
        manifestMap.set(p.id, pkg);
        const own = (path: string) => owner(graph, path)?.id === p.id;
        const sort = (a: { path: string }, b: { path: string }) =>
            a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
        const files = inventory.files
            .filter((f) => own(f.path))
            .map((f) => ({ ...f, path: f.path.slice(p.root.length + 1) }))
            .sort(sort);
        const directories = inventory.directories
            .filter(
                (d) =>
                    own(d) &&
                    d !== p.root &&
                    !d
                        .slice(p.root.length + 1)
                        .split("/")
                        .includes("node_modules"),
            )
            .map((d) => d.slice(p.root.length + 1))
            .sort();
        if (sha(canonicalBytes({ directories, files })) !== p.ownTreeSha256)
            fail("PAYLOAD_GRAPH_MISMATCH");
        // 包声明的每个命令都必须保留明确 bin 计划，不能删掉整个列表来跳过入口归属检查；字符串缩写按 npm 的无 scope 包名展开，对象形式则逐个保留原命令名称与相对目标声明。
        const bins = pkg.bin;
        if (bins !== undefined) {
            const names =
                typeof bins === "string"
                    ? [p.name.split("/").pop()!]
                    : bins && typeof bins === "object" && !Array.isArray(bins)
                      ? Object.keys(bins)
                      : fail("PAYLOAD_BIN_UNSUPPORTED");
            if (
                !setEqual(
                    graph.bins.filter((b) => b.owner === p.id).map((b) => b.name),
                    names,
                )
            )
                fail("PAYLOAD_BIN_UNSUPPORTED");
        } else if (graph.bins.some((b) => b.owner === p.id)) fail("PAYLOAD_BIN_UNSUPPORTED");
        const declared = declarations(pkg),
            edges = graph.edges.filter((e) => e.from === p.id);
        if (
            declared.length !== edges.length ||
            declared.some(
                (d) =>
                    !edges.some(
                        (e) =>
                            e.alias === d.alias && e.kind === d.kind && e.requested === d.requested,
                    ),
            )
        )
            fail("PAYLOAD_GRAPH_MISMATCH");
    }
    for (const f of inventory.files)
        if (!owner(graph, f.path) && !graph.bins.some((b) => b.sourceAlias === f.path))
            fail("PAYLOAD_GRAPH_MISMATCH");
    for (const link of inventory.links)
        if (!graph.bins.some((b) => b.sourceAlias === link.path)) fail("PAYLOAD_BIN_UNSUPPORTED");
    for (const r of graph.resolutionProof.resolutions) {
        if (
            !inventory.files.some((f) => f.path === r.resolvedFile) ||
            (r.from.startsWith("p") && !inventory.files.some((f) => f.path === r.consumer))
        )
            fail("PAYLOAD_GRAPH_MISMATCH");
    }
    for (const b of graph.bins) {
        const pkg = manifestMap.get(b.owner)!;
        let declared = pkg.bin;
        if (typeof declared === "string")
            declared = { [String(pkg.name).split("/").pop()!]: declared };
        if (!declared || typeof declared !== "object" || Array.isArray(declared))
            fail("PAYLOAD_BIN_UNSUPPORTED");
        const target = (declared as Record<string, unknown>)[b.name];
        if (
            typeof target !== "string" ||
            target.startsWith("/") ||
            target.includes("\\") ||
            posix.normalize(`${graph.instances.find((p) => p.id === b.owner)!.root}/${target}`) !==
                b.targetPath
        )
            fail("PAYLOAD_BIN_UNSUPPORTED");
        const fact = inventory.files.find((f) => f.path === b.targetPath);
        if (!fact || fact.sha256 !== b.targetSha256) fail("PAYLOAD_BIN_UNSUPPORTED");
        const existing =
            inventory.files.find((f) => f.path === b.aliasPath) ||
            inventory.links.find((l) => l.path === b.aliasPath);
        if (Boolean(existing) !== (b.sourceAlias !== null)) fail("PAYLOAD_BIN_UNSUPPORTED");
        const link = inventory.links.find((l) => l.path === b.sourceAlias);
        if (
            link &&
            posix.normalize(posix.join(posix.dirname(link.path), link.target)) !== b.targetPath
        )
            fail("PAYLOAD_BIN_UNSUPPORTED");
        if (b.launcher === "node") {
            if (!/\.(?:mjs|cjs|js)$/.test(b.targetPath)) fail("PAYLOAD_BIN_UNSUPPORTED");
            const content = await reader.header(tree, fact);
            if (content.subarray(0, 2).toString() === "#!") {
                const end = content.indexOf(10),
                    line = content.subarray(0, end < 0 ? content.length : end).toString();
                if (line !== "#!/usr/bin/env node" && line !== "#!/usr/bin/node")
                    fail("PAYLOAD_BIN_UNSUPPORTED");
            }
        }
    }
}

/** 导入分类保持 runtime 相对消费者与树内真实文件的边界，node 内建只允许当前锁定 Node24 的显式 node 前缀白名单；相对目标必须存在，受控 compiler Attempt 路径只有既有固定例外。 */
function edgeFor(
    fact: ImportFact,
    consumer: string,
    files: readonly Ref[],
    execution = false,
): ModuleEdge {
    const specifier = fact.specifier;
    if (!specifier || Buffer.byteLength(specifier) > 2048 || /[\x00-\x1f\x7f]/.test(specifier))
        fail("PAYLOAD_GRAPH_MISMATCH");
    if (specifier.startsWith("node:")) {
        if (!builtins.has(specifier)) fail("PAYLOAD_GRAPH_MISMATCH");
        return { ...fact, kind: "builtin", target: specifier };
    }
    if (specifier.startsWith(".")) {
        const target = posix.normalize(posix.join(posix.dirname(consumer), specifier));
        if (
            !files.some((f) => f.path === target) &&
            !(
                execution &&
                consumer === "compile-entry.mjs" &&
                specifier === "./engine/compiler/src/index.ts"
            )
        )
            fail("PAYLOAD_GRAPH_MISMATCH");
        return { ...fact, kind: "relative", target };
    }
    if (
        specifier.startsWith("/") ||
        specifier.includes(":") ||
        specifier.includes("\\") ||
        specifier === "electron" ||
        specifier.startsWith("electron/") ||
        specifier.startsWith("@veriq/desktop") ||
        builtins.has(`node:${specifier}`)
    )
        fail("PAYLOAD_GRAPH_MISMATCH");
    return { ...fact, kind: "external", target: specifier };
}
/** 最终静态图把真实输出 AST、包正文、边与归属串为同一输入观察，npm 原归档图则只完成声明闭包并保持 pending；返回值不包含 resolver 能力，也不会加载或执行任何输入模块。 */
export async function verifyGraph(
    recipe: Recipe,
    reader: InputReader,
    trees: {
        entries: { inventory: TreeInventory; receipt: EntriesReceipt };
        execution: { inventory: TreeInventory };
        dependencies: { inventory: TreeInventory; receipt: DependenciesReceipt };
    },
    node: NodeReceipt,
) {
    const graph = trees.dependencies.receipt.graph;
    await graphReferences(graph, recipe, reader, null);
    await graphReferences(node.npmGraph, recipe, reader, node);
    await verifyPackageContents(graph, trees.dependencies.inventory, recipe.dependencies, reader);
    const optional = graph.edges.filter((e) => e.kind === "optional" || e.kind === "optional-peer"),
        decisions = trees.dependencies.receipt.optionalDecisions;
    unique(decisions, (d) => `${d.from}:${d.alias}`);
    if (optional.length !== decisions.length) fail("PAYLOAD_GRAPH_MISMATCH");
    for (const e of optional) {
        const action =
            e.to !== null
                ? "include"
                : e.kind === "optional"
                  ? "exclude-target"
                  : "absent-optional-peer";
        if (!decisions.some((d) => d.from === e.from && d.alias === e.alias && d.action === action))
            fail("PAYLOAD_GRAPH_MISMATCH");
    }
    const required: { consumer: string; specifier: string }[] = [
        { consumer: "package.json", specifier: "tsx" },
    ];
    const outputs = trees.entries.receipt.outputs;
    unique(outputs, (o) => o.path);
    if (
        !setEqual(
            outputs.map((o) => o.path),
            trees.entries.inventory.files.map((f) => f.path),
        ) ||
        !setEqual(
            outputs.filter((o) => o.kind === "entry").map((o) => o.path),
            ["agent.js", "cli.js"],
        )
    )
        fail("PAYLOAD_GRAPH_MISMATCH");
    for (const output of outputs) {
        if (output.kind === "asset") {
            if (output.imports.length) fail("PAYLOAD_GRAPH_MISMATCH");
            if (/\.(?:js|mjs|cjs)$/.test(output.path)) {
                const file = trees.entries.inventory.files.find((f) => f.path === output.path)!;
                if (imports(await reader.script(recipe.entries, file), file.path).length)
                    fail("PAYLOAD_GRAPH_MISMATCH");
            }
            continue;
        }
        const file = trees.entries.inventory.files.find((f) => f.path === output.path)!;
        const actual = imports(await reader.script(recipe.entries, file), file.path).map((f) =>
            edgeFor(f, file.path, trees.entries.inventory.files),
        );
        unique(output.imports, (e) => `${e.dynamic}:${e.specifier}`);
        if (
            actual.length !== output.imports.length ||
            actual.some((a) => !output.imports.some((e) => equal(a, e)))
        )
            fail("PAYLOAD_GRAPH_MISMATCH");
        for (const edge of actual)
            if (edge.kind === "external")
                required.push({ consumer: `entry/${file.path}`, specifier: edge.specifier });
    }
    for (const file of trees.execution.inventory.files) {
        for (const edge of imports(await reader.script(recipe.execution, file), file.path).map(
            (f) => edgeFor(f, file.path, trees.execution.inventory.files, true),
        ))
            if (edge.kind === "external")
                required.push({ consumer: `execution/${file.path}`, specifier: edge.specifier });
    }
    const uniqueRequired = [
        ...new Map(required.map((b) => [`${b.consumer}:${b.specifier}`, b])).values(),
    ];
    if (
        uniqueRequired.length !== graph.rootBindings.length ||
        uniqueRequired.some(
            (b) =>
                !graph.rootBindings.some(
                    (r) => r.consumer === b.consumer && r.specifier === b.specifier,
                ),
        )
    )
        fail("PAYLOAD_GRAPH_MISMATCH");
    const tsx = graph.rootBindings.find(
        (b) => b.consumer === "package.json" && b.specifier === "tsx",
    );
    if (
        !tsx ||
        !graph.instances.some(
            (p) =>
                p.id === tsx.to &&
                p.name === "tsx" &&
                p.version === "4.23.15" &&
                p.root === "node_modules/tsx",
        ) ||
        !graph.resolutionProof.resolutions.some(
            (r) =>
                r.from === "$root" &&
                r.consumer === "package.json" &&
                r.specifier === "tsx" &&
                r.to === tsx.to &&
                r.resolvedFile === "node_modules/tsx/dist/loader.mjs",
        )
    )
        fail("PAYLOAD_GRAPH_MISMATCH");
}
