import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalBytes } from "@veriq/contracts";
import type {
    Arch,
    Recipe,
    Ref,
    TreeInventory,
    EntriesReceipt,
    ExecutionReceipt,
    DependenciesReceipt,
    NativeReceipt,
    EngineReceipt,
    NodeReceipt,
    ChromeReceipt,
    ChromeLayoutReceipt,
    SourceBindingV1,
    ExpectedPayloadInputs,
    DependencyGraph,
} from "../../scripts/runtime-payload-inputs.ts";

/** 测试模型允许定向篡改每一层冻结合同，但只在测试准备阶段使用可写映射；产品入口仍接收正式只读类型，测试不会通过 any 或忽略类型检查绕过公开字段约束。 */
export type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
/** 合成字节摘要由测试独立使用 Node 密码库计算，不能从核验器的返回记录自举期望值；归档和原生文件都明确是普通测试文本，测试不会把它们作为程序执行。 */
export const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
/** 测试编码保留普通 JSON 原始字节，与引擎条目的 JCS 摘要故意采用不同编码；这可以发现错误实现混淆 inventory 原始摘要与所选 entry 规范摘要的情况。 */
export const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2));
/** 稳定八个执行成员由 fixture 与产品各自列出，测试仅复制明确合成的 JavaScript 字节；真实源码和编译结果的来源真实性仍由后续目标平台验收建立。 */
export const executionNames = [
    "worker",
    "provider",
    "compile-entry",
    "archive",
    "controlled-command",
    "controlled-child",
    "controlled-child-protocol",
    "controlled-child-preload",
].map((n) => `${n}.mjs`);

/** 完整微型模型包含五棵树、独立来源文件、所有工具证据和两个同名同版本但不同 peer 上下文的包；每个引用都指向真实小文件，避免用只有 DTO 的测试冒充文件输入验收。 */
export function model(arch: Arch = "x64") {
    const data = new Map<string, Buffer>();
    const docs = new Map<string, unknown>();
    const digest = (value: Buffer) => ({ sizeBytes: value.length, sha256: hash(value) });
    const put = (path: string, value: Buffer | string): Mutable<Ref> => {
        const content = typeof value === "string" ? Buffer.from(value) : value;
        data.set(path, content);
        return { path, ...digest(content) };
    };
    const doc = (path: string, value: unknown) => {
        docs.set(path, value);
        return put(path, bytes(value));
    };
    const opaque = put(
        "evidence/opaque.txt",
        "synthetic external inspection and command evidence\n",
    );
    const producer = put("apps/runtime/scripts/producer.mjs", "export const synthetic = true;\n");
    const config = put("apps/runtime/config.json", "{}\n");
    const nativeSources = [
        "apps/runtime/native/darwin/addon.cc",
        "apps/runtime/native/darwin/private-files.h",
        "apps/runtime/native/vault/darwin-vault.mm",
        "apps/runtime/native/vault/darwin-acl.hpp",
    ].map((path) => put(path, "// synthetic bound production source\n"));
    const nativeBuildSources = [
        "apps/runtime/native/darwin/binding.gyp",
        "apps/runtime/scripts/build-darwin.mjs",
        "apps/runtime/scripts/build-vault-darwin.mjs",
    ].map((path) => put(path, "// synthetic production build configuration\n"));
    const lock = put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const sourceFiles = [producer, config, ...nativeSources, ...nativeBuildSources, lock];
    for (const name of executionNames)
        sourceFiles.push(
            put(
                `apps/runtime/src/execution/${name}`,
                name === "provider.mjs" ? 'import "peer-lib";\n' : 'import "node:fs";\n',
            ),
        );
    const sourceBinding: Mutable<SourceBindingV1> = {
        schemaVersion: 1,
        kind: "SOURCE_BINDING",
        commit: "a".repeat(40),
        files: sourceFiles,
    };
    const binding = doc("evidence/source-binding.json", sourceBinding);
    const sourceArchive = put(
        "archives/source.tar.gz",
        "synthetic source archive, not extracted\n",
    );
    const nodeArchive = put("archives/node.tar.gz", "synthetic node archive, not extracted\n");
    const chromeArchive = put("archives/chrome.zip", "synthetic chrome archive, not extracted\n");
    const target = {
        platform: "darwin" as const,
        arch,
        productVersion: "1.0.0-dev",
        nodeVersion: "24.22.1",
        engineVersion: "1.0.0",
    };
    const inventory = (treeKind: TreeInventory["treeKind"]): Mutable<TreeInventory> => ({
        schemaVersion: 1,
        kind: "PAYLOAD_INPUT_TREE",
        treeKind,
        directories: [],
        files: [],
        links: [],
    });
    const inventories = {
        entries: inventory("entries"),
        execution: inventory("execution"),
        dependencies: inventory("dependencies"),
        native: inventory("native"),
        engine: inventory("engine"),
    };
    const add = (
        kind: keyof typeof inventories,
        path: string,
        value: string | Buffer,
        mode: 420 | 493 = 420,
    ) => {
        const ref = put(`trees/${kind}/${path}`, value),
            inventory = inventories[kind];
        let parent = dirname(path);
        while (parent !== ".") {
            if (!inventory.directories.includes(parent)) inventory.directories.push(parent);
            parent = dirname(parent);
        }
        inventory.files.push({ ...ref, path, mode });
        return inventory.files[inventory.files.length - 1]!;
    };
    add("entries", "agent.js", 'import "peer-lib";\n');
    add("entries", "cli.js", 'import "node:fs";\n');
    for (const name of executionNames)
        add("execution", name, data.get(`apps/runtime/src/execution/${name}`)!);
    add("native", "veriq_private_files.node", "synthetic Node-API bytes\n");
    add("native", "vault/veriq_agent", "synthetic keychain helper bytes\n", 493);
    const packageDefs = [
        {
            id: "p1",
            root: "node_modules/tsx",
            name: "tsx",
            version: "4.23.15",
            peer: "",
            body: { name: "tsx", version: "4.23.15", bin: { tsx: "dist/loader.mjs" } },
        },
        {
            id: "p2",
            root: "entry/node_modules/peer-lib",
            name: "peer-lib",
            version: "1.0.0",
            peer: "(host@1.0.0)",
            body: { name: "peer-lib", version: "1.0.0", peerDependencies: { host: "*" } },
        },
        {
            id: "p3",
            root: "execution/node_modules/peer-lib",
            name: "peer-lib",
            version: "1.0.0",
            peer: "(host@2.0.0)",
            body: { name: "peer-lib", version: "1.0.0", peerDependencies: { host: "*" } },
        },
        {
            id: "p4",
            root: "entry/node_modules/host",
            name: "host",
            version: "1.0.0",
            peer: "",
            body: { name: "host", version: "1.0.0" },
        },
        {
            id: "p5",
            root: "execution/node_modules/host",
            name: "host",
            version: "2.0.0",
            peer: "",
            body: { name: "host", version: "2.0.0" },
        },
    ];
    const instances = packageDefs.map((p) => {
        const manifest = add("dependencies", `${p.root}/package.json`, bytes(p.body));
        add(
            "dependencies",
            `${p.root}/${p.id === "p1" ? "dist/loader.mjs" : "index.js"}`,
            "export const synthetic = true;\n",
        );
        const files = inventories.dependencies.files
            .filter((f) => f.path.startsWith(p.root + "/"))
            .map((f) => ({ ...f, path: f.path.slice(p.root.length + 1) }))
            .sort((a, b) => (a.path < b.path ? -1 : 1));
        return {
            id: p.id,
            root: p.root,
            name: p.name,
            version: p.version,
            lockSnapshot: `${p.name}@${p.version}${p.peer}`,
            packageJson: { sizeBytes: manifest.sizeBytes, sha256: manifest.sha256 },
            ownTreeSha256: hash(
                canonicalBytes({
                    directories: inventories.dependencies.directories
                        .filter((d) => d.startsWith(p.root + "/"))
                        .map((d) => d.slice(p.root.length + 1))
                        .sort(),
                    files,
                }),
            ),
        };
    });
    const graph: Mutable<DependencyGraph> = {
        instances,
        edges: [
            { from: "p2", alias: "host", kind: "peer", requested: "*", to: "p4", absence: null },
            { from: "p3", alias: "host", kind: "peer", requested: "*", to: "p5", absence: null },
        ],
        rootBindings: [
            { consumer: "entry/agent.js", specifier: "peer-lib", to: "p2" },
            { consumer: "execution/provider.mjs", specifier: "peer-lib", to: "p3" },
            { consumer: "package.json", specifier: "tsx", to: "p1" },
        ],
        bins: [
            {
                owner: "p1",
                name: "tsx",
                aliasPath: "node_modules/.bin/tsx",
                sourceAlias: null,
                targetPath: "node_modules/tsx/dist/loader.mjs",
                targetSha256: inventories.dependencies.files.find(
                    (f) => f.path === "node_modules/tsx/dist/loader.mjs",
                )!.sha256,
                launcher: "node",
                inspection: null,
            },
        ],
        resolutionProof: {
            method: "NODE_RESOLVE",
            nodeVersion: target.nodeVersion,
            nodeExecutableSha256: "b".repeat(64),
            target: { platform: "darwin", arch },
            resolutions: [
                {
                    from: "p2",
                    consumer: "entry/node_modules/peer-lib/package.json",
                    specifier: "host",
                    resolvedFile: "entry/node_modules/host/index.js",
                    to: "p4",
                },
                {
                    from: "p3",
                    consumer: "execution/node_modules/peer-lib/package.json",
                    specifier: "host",
                    resolvedFile: "execution/node_modules/host/index.js",
                    to: "p5",
                },
                {
                    from: "$entry",
                    consumer: "entry/agent.js",
                    specifier: "peer-lib",
                    resolvedFile: "entry/node_modules/peer-lib/index.js",
                    to: "p2",
                },
                {
                    from: "$execution",
                    consumer: "execution/provider.mjs",
                    specifier: "peer-lib",
                    resolvedFile: "execution/node_modules/peer-lib/index.js",
                    to: "p3",
                },
                {
                    from: "$root",
                    consumer: "package.json",
                    specifier: "tsx",
                    resolvedFile: "node_modules/tsx/dist/loader.mjs",
                    to: "p1",
                },
            ],
            evidence: opaque,
        },
    };
    const build = (toolNames: Mutable<EntriesReceipt>["build"]["toolNames"]) => ({
        commit: sourceBinding.commit,
        sourceBindingSha256: binding.sha256,
        pnpmLockSha256: lock.sha256,
        target: { platform: "darwin" as const, arch },
        producer,
        config,
        toolNames,
        commandEvidence: opaque,
    });
    const base = (kind: string, toolNames: Mutable<EntriesReceipt>["build"]["toolNames"]) => ({
        schemaVersion: 1 as const,
        kind,
        build: build(toolNames),
        treeInventorySha256: "0".repeat(64),
    });
    const entries: Mutable<EntriesReceipt> = {
        ...base("ENTRIES_BUILD", ["node", "vite"]),
        kind: "ENTRIES_BUILD",
        entrypoints: { agent: "agent.js", cli: "cli.js" },
        outputs: [
            {
                path: "agent.js",
                kind: "entry",
                imports: [
                    { specifier: "peer-lib", kind: "external", target: "peer-lib", dynamic: false },
                ],
            },
            {
                path: "cli.js",
                kind: "entry",
                imports: [
                    { specifier: "node:fs", kind: "builtin", target: "node:fs", dynamic: false },
                ],
            },
        ],
        embeddedWorkspaces: [],
    };
    const execution: Mutable<ExecutionReceipt> = {
        ...base("EXECUTION_SOURCE_COPY", ["node"]),
        kind: "EXECUTION_SOURCE_COPY",
        members: executionNames.map((path) => ({
            path,
            sourcePath: `apps/runtime/src/execution/${path}`,
            sha256: data.has(`apps/runtime/src/execution/${path}`)
                ? hash(data.get(`apps/runtime/src/execution/${path}`)!)
                : "",
        })),
    };
    const dependencies: Mutable<DependenciesReceipt> = {
        ...base("PRODUCTION_DEPENDENCIES", ["node", "pnpm"]),
        kind: "PRODUCTION_DEPENDENCIES",
        graph,
        linker: {
            name: "pnpm",
            version: "11.25.0",
            mode: "hoisted",
            sourceLockSha256: lock.sha256,
            lockAfterSha256: lock.sha256,
            ignoreScripts: true,
            offline: true,
            frozenLockfile: true,
        },
        optionalDecisions: [],
    };
    const native: Mutable<NativeReceipt> = {
        ...base("NATIVE_PRODUCTION_BUILD", ["node", "node-gyp", "clang"]),
        kind: "NATIVE_PRODUCTION_BUILD",
        outputs: inventories.native.files.map((f) => ({
            path: f.path as "veriq_private_files.node" | "vault/veriq_agent",
            targetName:
                f.path === "veriq_private_files.node" ? "veriq_private_files" : "veriq_agent",
            defines:
                f.path === "veriq_private_files.node"
                    ? ["NAPI_CPP_EXCEPTIONS", "NAPI_VERSION=9"]
                    : [],
            sourceFiles:
                f.path === "veriq_private_files.node"
                    ? nativeSources.slice(0, 2)
                    : nativeSources.slice(2),
            sha256: f.sha256,
            architecture: arch === "x64" ? "x86_64" : "arm64",
            minimumOs: "15.0",
            sdk: { version: "15.0", settingsEvidence: opaque },
            inspectionEvidence: opaque,
        })),
    };
    const engineDependencies = [
        { name: "synthetic-engine-dependency", version: "1.0.0", integrity: "sha512-synthetic" },
    ];
    const engineFiles = [
        add("engine", "package.json", '{"name":"synthetic-engine","version":"1.0.0"}\n'),
        add("engine", "package-lock.json", "{}\n"),
        add("engine", "dependencies.json", bytes(engineDependencies)),
        add("engine", "engine/compiler.tgz", "synthetic compiler archive\n"),
    ].map(({ path, sizeBytes, sha256 }) => ({ path, sizeBytes, sha256 }));
    const entry = {
        engineVersion: "1.0.0",
        compilerVersion: "1.0.0",
        runnerSdkVersion: "1.0.0",
        files: engineFiles,
        dependencies: engineDependencies,
    };
    const engineInventory = { schemaVersion: "1.0", engines: [entry] };
    const engineInventoryFile = add("engine", "inventory.json", bytes(engineInventory));
    const engine: Mutable<EngineReceipt> = {
        ...base("ENGINE_PAYLOAD", ["node", "pnpm"]),
        kind: "ENGINE_PAYLOAD",
        engineVersion: "1.0.0",
        compilerVersion: "1.0.0",
        runnerSdkVersion: "1.0.0",
        inventory: {
            path: "inventory.json",
            sizeBytes: engineInventoryFile.sizeBytes,
            sha256: engineInventoryFile.sha256,
        },
        entrySha256: hash(canonicalBytes(entry)),
        files: engineFiles,
        dependencies: engineDependencies,
    };
    const npmGraph: Mutable<DependencyGraph> = {
        instances: [
            {
                id: "p1",
                root: "npm",
                name: "npm",
                version: "11.0.0",
                lockSnapshot: `node-archive:${nodeArchive.sha256}:.`,
                packageJson: { sizeBytes: 2, sha256: hash(Buffer.from("{}")) },
                ownTreeSha256: "c".repeat(64),
            },
        ],
        edges: [],
        rootBindings: [{ consumer: "npm/bin/npm-cli.js", specifier: "npm", to: "p1" }],
        bins: [],
        resolutionProof: {
            method: "NODE_RESOLVE",
            nodeVersion: target.nodeVersion,
            nodeExecutableSha256: "b".repeat(64),
            target: { platform: "darwin", arch },
            resolutions: [
                {
                    from: "$npm",
                    consumer: "npm/bin/npm-cli.js",
                    specifier: "npm",
                    resolvedFile: "npm/bin/npm-cli.js",
                    to: "p1",
                },
            ],
            evidence: opaque,
        },
    };
    const nodeReceipt: Mutable<NodeReceipt> = {
        schemaVersion: 1,
        kind: "NODE_ARCHIVE_INPUT",
        archiveSha256: nodeArchive.sha256,
        nodeVersion: target.nodeVersion,
        npmVersion: "11.0.0",
        nodeMember: `node-v${target.nodeVersion}-darwin-${arch}/bin/node`,
        npmRoot: `node-v${target.nodeVersion}-darwin-${arch}/lib/node_modules/npm`,
        npmPackageJson: npmGraph.instances[0]!.packageJson,
        npmGraph,
        inputLinks: [],
        inspectionEvidence: opaque,
    };
    const bundlePath = `browser/chrome-mac-${arch}/Google Chrome for Testing.app`;
    const chromeLayout: Mutable<ChromeLayoutReceipt> = {
        schemaVersion: 1,
        kind: "CHROME_LAYOUT",
        archiveSha256: chromeArchive.sha256,
        layout: {
            bundlePath,
            executablePath: `${bundlePath}/Contents/MacOS/Google Chrome for Testing`,
            frameworkRoots: [],
            allowedLinks: [],
        },
        reviewEvidence: opaque,
    };
    const layoutRef = doc("evidence/chrome-layout.json", chromeLayout);
    const chromeReceipt: Mutable<ChromeReceipt> = {
        schemaVersion: 1,
        kind: "CHROME_ARCHIVE_INPUT",
        archiveSha256: chromeArchive.sha256,
        browserVersion: "158.0.8127.18",
        revision: "1254",
        playwrightVersion: "1.65.0",
        layoutSha256: layoutRef.sha256,
        inspectionEvidence: opaque,
    };
    const receipts = { entries, execution, dependencies, native, engine };
    const trees = Object.fromEntries(
        Object.entries(inventories).map(([kind, inventory]) => [
            kind,
            {
                root: `trees/${kind}`,
                inventory: doc(`evidence/${kind}-inventory.json`, inventory),
                buildReceipt: doc(
                    `evidence/${kind}-receipt.json`,
                    receipts[kind as keyof typeof receipts],
                ),
            },
        ]),
    ) as Pick<Mutable<Recipe>, "entries" | "execution" | "dependencies" | "native" | "engine">;
    const tools = (["node", "pnpm", "tar", "yauzl", "vite", "node-gyp", "clang"] as const).map(
        (name) => ({
            name,
            version: {
                node: "24.22.1",
                pnpm: "11.25.0",
                tar: "7.5.22",
                yauzl: "3.4.0",
                vite: "6.4.0",
                "node-gyp": "12.4.0",
                clang: "17.0.0",
            }[name],
            artifactSha256: name === "node" ? "b".repeat(64) : "d".repeat(64),
            evidence: opaque,
        }),
    );
    const recipe: Mutable<Recipe> = {
        schemaVersion: 1,
        kind: "MAC_RUNTIME_PAYLOAD_INPUTS",
        target,
        source: { commit: sourceBinding.commit, archive: sourceArchive, binding, pnpmLock: lock },
        tools,
        node: {
            file: nodeArchive,
            format: "tar.gz",
            topDirectory: `node-v${target.nodeVersion}-darwin-${arch}`,
            upstream: {
                url: "https://nodejs.org/dist/node.tar.gz",
                version: target.nodeVersion,
                checksumEvidence: opaque,
            },
            receipt: doc("evidence/node-receipt.json", nodeReceipt),
        },
        chrome: {
            file: chromeArchive,
            format: "zip",
            topDirectory: `chrome-mac-${arch}`,
            upstream: {
                url: "https://storage.example.test/chrome.zip",
                version: "158.0.8127.18",
                checksumEvidence: opaque,
            },
            receipt: doc("evidence/chrome-receipt.json", chromeReceipt),
        },
        chromeLayout: layoutRef,
        ...trees,
    };
    const expected: Mutable<ExpectedPayloadInputs> = {
        recipeSha256: "0".repeat(64),
        target: structuredClone(target),
        commit: sourceBinding.commit,
        sourceBindingSha256: binding.sha256,
        pnpmLockSha256: lock.sha256,
        chromeLayoutSha256: layoutRef.sha256,
    };
    const seal = () => {
        for (const [path, value] of docs) put(path, bytes(value));
        for (const kind of Object.keys(inventories) as (keyof typeof inventories)[]) {
            const body = data.get(recipe[kind].inventory.path)!;
            Object.assign(recipe[kind].inventory, digest(body));
            receipts[kind].treeInventorySha256 = hash(body);
            if (docs.get(recipe[kind].buildReceipt.path) === receipts[kind])
                put(recipe[kind].buildReceipt.path, bytes(receipts[kind]));
        }
        for (const ref of [
            recipe.source.binding,
            recipe.chromeLayout,
            recipe.node.receipt,
            recipe.chrome.receipt,
            ...Object.values(trees).map((t) => t.buildReceipt),
        ])
            Object.assign(ref, digest(data.get(ref.path)!));
        const recipeBytes = bytes(recipe);
        expected.recipeSha256 = hash(recipeBytes);
        return recipeBytes;
    };
    seal();
    return {
        recipe,
        expected,
        data,
        docs,
        inventories,
        receipts,
        sourceBinding,
        nodeReceipt,
        chromeReceipt,
        chromeLayout,
        engineInventory,
        graph,
        seal,
        put,
        add,
    };
}

/** 每个场景创建独占中文空格临时根并在 finally 删除其自有内容，绝不扫描或清理其它任务目录；可重复保存只用于准备新的输入声明，实际核验过程中不会自动修复篡改。 */
export async function fixture(
    run: (
        value: ReturnType<typeof model> & { root: string; save: () => Promise<Buffer> },
    ) => Promise<unknown>,
    value = model(),
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "veriq payload 中文 "));
    const save = async () => {
        const recipeBytes = value.seal();
        for (const [kind, inventory] of Object.entries(value.inventories)) {
            for (const path of ["", ...inventory.directories]) {
                await mkdir(join(root, `trees/${kind}`, path), { recursive: true });
                await chmod(join(root, `trees/${kind}`, path), 0o755);
            }
        }
        for (const [path, content] of value.data) {
            await mkdir(dirname(join(root, path)), { recursive: true });
            await writeFile(join(root, path), content);
            const kind = Object.keys(value.inventories).find((k) =>
                path.startsWith(`trees/${k}/`),
            ) as keyof typeof value.inventories | undefined;
            const fact = kind
                ? value.inventories[kind].files.find((f) => `trees/${kind}/${f.path}` === path)
                : undefined;
            await chmod(join(root, path), fact?.mode ?? 0o644);
        }
        return recipeBytes;
    };
    try {
        await save();
        await run({ ...value, root, save });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

/** 测试修改真实包正文后独立重算对应的 package 摘要和自有树摘要，使反例能够越过无关 hash 门槛；它不修改图中的依赖边或解析记录，关系错误仍由产品逐条核验发现。 */
export function rehashPackages(value: ReturnType<typeof model>) {
    const inventory = value.inventories.dependencies;
    for (const p of value.graph.instances) {
        const own = (path: string) =>
            path.startsWith(p.root + "/") &&
            !path
                .slice(p.root.length + 1)
                .split("/")
                .includes("node_modules") &&
            !path
                .slice(p.root.length + 1)
                .split("/")
                .includes(".bin");
        for (const f of inventory.files.filter((f) => own(f.path))) {
            const body = value.data.get(`trees/dependencies/${f.path}`)!;
            f.sizeBytes = body.length;
            f.sha256 = hash(body);
        }
        const pkg = inventory.files.find((f) => f.path === `${p.root}/package.json`)!;
        p.packageJson = { sizeBytes: pkg.sizeBytes, sha256: pkg.sha256 };
        p.ownTreeSha256 = hash(
            canonicalBytes({
                directories: inventory.directories
                    .filter((d) => own(d))
                    .map((d) => d.slice(p.root.length + 1))
                    .sort(),
                files: inventory.files
                    .filter((f) => own(f.path))
                    .map((f) => ({ ...f, path: f.path.slice(p.root.length + 1) }))
                    .sort((a, b) => (a.path < b.path ? -1 : 1)),
            }),
        );
    }
}
