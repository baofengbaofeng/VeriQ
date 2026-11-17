import assert from "node:assert/strict";
import test from "node:test";
import {
    chmod,
    cp,
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { canonicalBytes } from "@veriq/contracts";
import { ArchiveTransaction } from "../scripts/runtime-payload-transaction.ts";
import { InputReader, sha } from "../scripts/runtime-payload-tree.ts";
import { document, schemas } from "../scripts/runtime-payload-receipts.ts";
import {
    withEntryInputViews,
    type EntryInputOptions,
    type HostBuildObservation,
} from "../scripts/runtime-payload-entries.ts";
import type {
    EntriesReceipt,
    ExecutionReceipt,
    Ref,
    SourceBindingV1,
    TreeInventory,
} from "../scripts/runtime-payload-inputs.ts";

// 有界 CLI 管理器已通过独立声明文件提供类型，测试仅复用其真实 MJS 实现的准入与关闭观察，
// 不复制实现也不伪造进程结算路径。
import { runBoundedAssetCli } from "../scripts/runtime-assets-ci-process.mjs";

/**
 * 夹具只使用当前仓库声明的宿主构建工具与八份真实执行源码，两个入口和工作区模块另行编写，所有路径放在调用者的私有临时根
 * 中且不会加载构建出来的任何入口代码。
 */
const repository = resolve(import.meta.dirname, "../../.."),
    producer = "apps/runtime/scripts/runtime-payload-entries.ts",
    config = "apps/runtime/runtime.vite.config.mjs",
    names = [
        "worker",
        "provider",
        "compile-entry",
        "archive",
        "controlled-command",
        "controlled-child",
        "controlled-child-protocol",
        "controlled-child-preload",
    ].map((n) => `${n}.mjs`);

/**
 * 每个行为用例独占来源、事务父目录和空构建目录，复制真实配置与执行文件而不修改宿主依赖；测试的最外层拥有清理权，因此生
 * 产函数返回时仍可核实其目录确实尚存。
 */
async function fixture(
    run: (f: {
        root: string;
        sourceRoot: string;
        work: ArchiveTransaction;
        options: EntryInputOptions;
        put(path: string, value: string | Uint8Array): Promise<void>;
    }) => Promise<void>,
    entry = "",
    emitAsset = false,
    extraSources: Record<string, string> = {},
) {
    const root = await mkdtemp(join(tmpdir(), "veriq-entry-"));
    await chmod(root, 0o700);
    const sourceRoot = join(root, "source"),
        parent = join(root, "transactions"),
        buildRoot = join(root, "build");
    for (const path of [sourceRoot, parent, buildRoot]) await mkdir(path, { mode: 0o700 });
    const put = async (path: string, value: string | Uint8Array) => {
        await mkdir(dirname(join(sourceRoot, path)), { recursive: true, mode: 0o755 });
        await writeFile(join(sourceRoot, path), value, { mode: 0o644 });
        await chmod(join(sourceRoot, path), 0o644);
    };
    const files: string[] = [
        producer,
        config,
        "pnpm-lock.yaml",
        "package.json",
        "pnpm-workspace.yaml",
        "apps/desktop/package.json",
        "apps/runtime/package.json",
        "apps/desktop/src/agent/index.ts",
        "apps/runtime/src/cli.ts",
        "packages/contracts/package.json",
        "packages/contracts/src/index.ts",
        "packages/contracts/src/transitive.ts",
        "packages/contracts/schemas/test.json",
        ...names.map((name) => `apps/runtime/src/execution/${name}`),
        ...Object.keys(extraSources),
    ];
    await put(producer, await readFile(join(repository, producer)));
    const configBytes = await readFile(join(repository, config), "utf8");
    await put(
        config,
        emitAsset
            ? configBytes.replace("export default {", "const fixtureConfig = {") +
                  '\nfixtureConfig.plugins.unshift({name:"fixture-json-asset", async generateBundle(){this.emitFile(' +
                  '{type:"asset",fileName:"assets/schema.json",source:await(await import("node:fs/promises")).re' +
                  'adFile(resolve(sourceRoot,"packages/contracts/schemas/test.json"))});}});\nexport default fix' +
                  "tureConfig;\n"
            : configBytes,
    );
    await put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    await put("pnpm-workspace.yaml", "packages:\n  - packages/*\n  - apps/*\n");
    await put("package.json", JSON.stringify({ name: "fixture", private: true, type: "module" }));
    await put(
        "apps/desktop/package.json",
        JSON.stringify({
            name: "@veriq/desktop",
            type: "module",
            devDependencies: { vite: "6.4.5" },
        }),
    );
    await put("apps/runtime/package.json", JSON.stringify({ name: "@veriq/runtime", type: "module" }));
    await put(
        "packages/contracts/package.json",
        JSON.stringify({
            name: "@veriq/contracts",
            version: "1.2.3",
            type: "module",
            exports: "./src/index.ts",
        }),
    );
    await put(
        "packages/contracts/src/index.ts",
        'import schema from "../schemas/test.json"; import { suffix } from "./transitive.js"; export function shared' +
            "(value: string) { return schema.title + value + suffix; }",
    );
    await put("packages/contracts/src/transitive.ts", 'export const suffix: string = "-transitive";');
    await put("packages/contracts/schemas/test.json", '{"title":"bound-schema"}');
    await put(
        "apps/desktop/src/agent/index.ts",
        entry ||
            'import { shared } from "@veriq/contracts"; import external from "fixture-external"; console.log(shared(' +
                '"agent"), external);',
    );
    await put("apps/runtime/src/cli.ts", 'import { shared } from "@veriq/contracts"; console.log(shared("cli"));');
    for (const name of names)
        await put(
            `apps/runtime/src/execution/${name}`,
            await readFile(join(repository, "apps/runtime/src/execution", name)),
        );
    for (const [path, bytes] of Object.entries(extraSources)) await put(path, bytes);
    await mkdir(join(sourceRoot, "node_modules/@veriq"), { recursive: true });
    await symlink("../../packages/contracts", join(sourceRoot, "node_modules/@veriq/contracts"));
    await mkdir(join(sourceRoot, "apps/desktop/node_modules"), { recursive: true });
    await symlink(
        await realpath(join(repository, "apps/desktop/node_modules/vite")),
        join(sourceRoot, "apps/desktop/node_modules/vite"),
    );
    const refs: Ref[] = [];
    for (const path of files) {
        const bytes = await readFile(join(sourceRoot, path));
        refs.push({ path, sizeBytes: bytes.length, sha256: sha(bytes) });
    }
    const source: SourceBindingV1 = {
        schemaVersion: 1,
        kind: "SOURCE_BINDING",
        commit: "1".repeat(40),
        files: refs,
    };
    const build = {
        commit: source.commit,
        sourceBindingSha256: sha(canonicalBytes(source)),
        pnpmLockSha256: refs.find((f) => f.path === "pnpm-lock.yaml")!.sha256,
        target: { platform: "darwin" as const, arch: "arm64" as const },
        producer: refs.find((f) => f.path === producer)!,
        config: refs.find((f) => f.path === config)!,
    };
    const options: EntryInputOptions = {
        source,
        entries: { ...build, toolNames: ["node", "vite"] },
        execution: { ...build, config: build.producer, toolNames: ["node"] },
        buildRoot,
        hostBuild: {
            executable: process.execPath,
            viteCli: join(sourceRoot, "apps/desktop/node_modules/vite/bin/vite.js"),
            timeoutMs: 30000,
            run: runBoundedAssetCli,
        },
    };
    const work = new ArchiveTransaction(sourceRoot, parent, "entry-fixture", undefined, "work");
    await work.initialize();
    try {
        await run({ root, sourceRoot, work, options, put });
    } finally {
        await work.cleanup();
        await rm(root, { recursive: true, force: true });
    }
}

/**
 * 工具权限回归复制真实 Vite 到夹具自有目录并只借用既有依赖解析，改变三个资格文件的权限不会触及宿主安装，后续仍运行真实
 * CLI 并读取最终命令证据，确保测试经过实际文件身份门禁。
 */
async function privateVite(root: string, sourceRoot: string, mode: number) {
    const installed = await realpath(join(repository, "apps/desktop/node_modules/vite")),
        owned = join(root, "host-tools/vite"),
        linked = join(sourceRoot, "apps/desktop/node_modules/vite"),
        paths = ["bin/vite.js", "dist/node/index.js", "package.json"];
    await cp(installed, owned, { recursive: true });
    await symlink(dirname(installed), join(root, "host-tools/node_modules"));
    await rm(linked);
    await symlink(owned, linked);
    for (const path of paths) await chmod(join(owned, path), mode);
    const fixed = await realpath(owned);
    return paths.map((path) => join(fixed, path));
}

/**
 * 真实局部懒加载触发 Vite 预加载改写，编译器声明摘要必须与命令关闭后的独立磁盘读取一致，随后仍由原严格生产器复制核验。
 * 变量导入同时保留运行时动态边；测试只构建并检查产物，不执行入口或借用宿主目标平台资格。
 */
test("real host Vite observes final local dynamic import bytes before strict intake", async () =>
    fixture(
        async ({ work, options }) => {
            const original = options.hostBuild.run;
            let declared: { sources: string[]; outputs: (Ref & { kind: string })[] } | undefined;
            const modified = {
                ...options,
                hostBuild: {
                    ...options.hostBuild,
                    run: async (invocation: Parameters<typeof original>[0]) => {
                        const result = await original(invocation);
                        assert.equal(result.admitted, true);
                        assert.equal(result.closeConfirmed, true);
                        assert.equal(result.exit, 0);
                        declared = JSON.parse(
                            await readFile(join(options.buildRoot, ".veriq-entry-trace.json"), "utf8"),
                        );
                        assert(declared);
                        assert(declared.sources.includes("apps/desktop/src/agent/lazy.ts"));
                        assert(declared.outputs.some((output) => output.kind === "chunk" && /lazy-/.test(output.path)));
                        for (const output of declared.outputs) {
                            const bytes = await readFile(join(options.buildRoot, output.path));
                            assert.equal(bytes.includes(Buffer.from("__VITE_PRELOAD__")), false);
                            assert.deepEqual(
                                { sizeBytes: output.sizeBytes, sha256: output.sha256 },
                                { sizeBytes: bytes.length, sha256: sha(bytes) },
                                output.path,
                            );
                        }
                        return result;
                    },
                },
            };
            let consumed = false;
            await withEntryInputViews(work, modified, async (inputRoot, trees) => {
                assert(declared);
                const reader = new InputReader(inputRoot, undefined, ["entries", "execution"]);
                await reader.initialize();
                const receipt = await document<EntriesReceipt>(reader, trees.entries.buildReceipt, schemas.entries),
                    inventory = await document<TreeInventory>(reader, trees.entries.inventory, schemas.inventory);
                await reader.tree(trees.entries, inventory, "entries");
                for (const output of declared.outputs) {
                    const file = inventory.files.find((file) => file.path === output.path);
                    assert(file);
                    assert.equal(file.sizeBytes, output.sizeBytes);
                    assert.equal(file.sha256, output.sha256);
                    assert.equal(receipt.outputs.find((file) => file.path === output.path)?.kind, output.kind);
                }
                await reader.finish();
                await work.audit();
                consumed = true;
            });
            assert.equal(consumed, true);
            // 消费及最终审计成功后才请求事务清理，同时核实暂存根已消失，避免把回调返回误当成描述符关闭与目录回收证明。
            assert.equal(await work.cleanup(), "CONFIRMED");
            await assert.rejects(lstat(work.scratch), { code: "ENOENT" });
        },
        'import { shared } from "@veriq/contracts"; console.log(shared("agent")); ' +
            'async function load(name: string) { return [await import("./lazy.js"), await import(name)]; } ' +
            'console.log(load("fixture-external"));',
        false,
        { "apps/desktop/src/agent/lazy.ts": 'export const lazy: string = "local-lazy";' },
    ));

test("real host tool qualification preserves private executable mode", async () =>
    fixture(async ({ root, sourceRoot, work, options }) => {
        const paths = await privateVite(root, sourceRoot, 0o700);
        await withEntryInputViews(work, options, async (inputRoot, trees) => {
            const reader = new InputReader(inputRoot, undefined, ["entries", "execution"]);
            await reader.initialize();
            const receipt = await document<EntriesReceipt>(reader, trees.entries.buildReceipt, schemas.entries);
            const command = JSON.parse((await reader.ref(receipt.build.commandEvidence, true)).toString());
            assert.equal(command.observation.exit, 0);
            assert.equal(command.observation.closeConfirmed, true);
            const files = command.tools.find((tool: { name: string }) => tool.name === "vite").files;
            assert.equal(files.length, 3);
            for (const path of paths) {
                const file = files.find((file: { path: string }) => file.path === path);
                assert.equal(file.mode, 0o700);
                assert.equal(file.sha256, sha(await readFile(path)));
                assert.equal(Number((await lstat(path)).mode & 0o7777), 0o700);
            }
            await reader.finish();
        });
    }));

/**
 * 工具文件新增的私有可执行模式不能扩大为通用执行权限掩码，危险写权限与特殊位仍须在真实宿主动作为零次时拒绝，未观察到需
 * 要的只读私有执行模式也继续保持既有拒绝行为。
 */
for (const mode of [0o500, 0o770, 0o777, 0o1700, 0o2700, 0o4700])
    test(`host tool rejects unapproved mode ${mode.toString(8)} before build`, async () =>
        fixture(async ({ root, sourceRoot, work, options }) => {
            await privateVite(root, sourceRoot, mode);
            let invoked = false;
            const modified = {
                ...options,
                hostBuild: {
                    ...options.hostBuild,
                    run: async () => {
                        invoked = true;
                        throw new Error("unexpected host build");
                    },
                },
            };
            await assert.rejects(
                withEntryInputViews(work, modified, async () => assert.fail("consumer called")),
                /PAYLOAD_LIMIT/,
            );
            assert.equal(invoked, false);
        }));

/**
 * 私有执行权限只改变模式准入，工具包的名称与绑定版本仍必须真实匹配；这些用例在自有副本中写入错误元数据，确认宿主构建
 * 没有开始且不会因通过文件权限检查而跳过工具角色校验。
 */
for (const patch of [{ name: "unexpected-tool" }, { version: "0.0.0" }])
    test(`private host tool rejects wrong metadata ${JSON.stringify(patch)}`, async () =>
        fixture(async ({ root, sourceRoot, work, options }) => {
            const paths = await privateVite(root, sourceRoot, 0o700),
                manifest = paths[2];
            assert(manifest);
            const pkg = JSON.parse(await readFile(manifest, "utf8"));
            await writeFile(manifest, JSON.stringify({ ...pkg, ...patch }));
            let invoked = false;
            await assert.rejects(
                withEntryInputViews(
                    work,
                    {
                        ...options,
                        hostBuild: {
                            ...options.hostBuild,
                            run: async () => {
                                invoked = true;
                                throw new Error("unexpected host build");
                            },
                        },
                    },
                    async () => assert.fail("consumer called"),
                ),
                /PAYLOAD_RECEIPT_MISMATCH/,
            );
            assert.equal(invoked, false);
        }));

/**
 * 工具初读时通过私有执行模式并不豁免后置身份复验，真实构建关闭后将模式改为另一已允许值仍必须拒绝，防止只核最终模式集
 * 合而遗失先前观察到的文件身份。
 */
test("private host tool rejects identity change after real build", async () =>
    fixture(async ({ root, sourceRoot, work, options }) => {
        const paths = await privateVite(root, sourceRoot, 0o700),
            cli = paths[0],
            original = options.hostBuild.run;
        assert(cli);
        let changed = false;
        await assert.rejects(
            withEntryInputViews(
                work,
                {
                    ...options,
                    hostBuild: {
                        ...options.hostBuild,
                        run: async (invocation) => {
                            const result = await original(invocation);
                            assert.equal(result.exit, 0);
                            assert.equal(result.closeConfirmed, true);
                            await chmod(cli, 0o600);
                            changed = true;
                            return result;
                        },
                    },
                },
                async () => undefined,
            ),
            /PAYLOAD_SOURCE_CHANGED/,
        );
        assert.equal(changed, true);
    }));

/**
 * 成功用例通过真实 Vite 共享 chunk 和 JSON 导入验证原路径快照、完整库存与严格模式，回调期间独立 reader 再读所有文档与
 * 树，并在返回之后确认目录仍由外部调用者拥有。
 */
test("real host Vite creates live strict entry and exact unchanged execution views", async () =>
    fixture(async ({ work, options, sourceRoot }) => {
        const result = await withEntryInputViews(work, options, async (inputRoot, trees) => {
            assert.equal(inputRoot, join(work.scratch, "views"));
            assert.equal(trees.entries.root, "entries");
            assert.equal(trees.execution.root, "execution");
            const reader = new InputReader(inputRoot, undefined, ["entries", "execution"]);
            await reader.initialize();
            for (const ref of options.source.files) {
                await reader.ref(ref, false, 2 * 1024 ** 3, false);
                assert.equal(Number((await lstat(join(inputRoot, ref.path))).mode & 0o777), 0o644);
            }
            const entries = await document<EntriesReceipt>(reader, trees.entries.buildReceipt, schemas.entries);
            const execution = await document<ExecutionReceipt>(reader, trees.execution.buildReceipt, schemas.execution);
            const command = JSON.parse((await reader.ref(entries.build.commandEvidence, true)).toString());
            assert.equal(command.operation, "VITE_BUILD");
            assert.equal(command.observation.admitted, true);
            assert.equal(command.observation.closeConfirmed, true);
            assert.equal(command.observation.exit, 0);
            assert.equal(command.observation.signal, null);
            assert.equal(command.observation.error, null);
            assert.equal(command.observation.timedOut, false);
            assert.equal(command.observation.truncated, false);
            assert.equal(command.invocation.executable, await realpath(process.execPath));
            assert.equal(command.invocation.cwd, join(sourceRoot, "apps/desktop"));
            assert.equal(command.host.platform, process.platform);
            assert(command.started <= command.finished);
            assert.deepEqual(
                command.tools.map((tool: { name: string }) => tool.name),
                ["node", "vite"],
            );
            assert.equal(command.tools[1].version, "6.4.5");
            assert.equal(command.tools[1].files.length, 3);
            await reader.ref(command.observation.stdout);
            await reader.ref(command.observation.stderr);
            const copied = JSON.parse((await reader.ref(execution.build.commandEvidence, true)).toString());
            assert.equal(copied.operation, "IN_PROCESS_SOURCE_COPY");
            assert.equal(copied.host.pid, process.pid);
            assert.equal("exit" in copied, false);
            assert.deepEqual(entries.entrypoints, { agent: "agent.js", cli: "cli.js" });
            assert(entries.outputs.some((o) => o.kind === "chunk"));
            assert(
                entries.outputs.some((o) =>
                    o.imports.some((i) => i.specifier === "fixture-external" && i.target === "fixture-external"),
                ),
            );
            assert.deepEqual(entries.embeddedWorkspaces, [
                {
                    name: "@veriq/contracts",
                    version: "1.2.3",
                    sourcePaths: [
                        "packages/contracts/schemas/test.json",
                        "packages/contracts/src/index.ts",
                        "packages/contracts/src/transitive.ts",
                    ],
                },
            ]);
            for (const kind of ["entries", "execution"] as const) {
                const inventory = await document<TreeInventory>(reader, trees[kind].inventory, schemas.inventory);
                await reader.tree(trees[kind], inventory, kind);
                assert.deepEqual(inventory.links, []);
                assert(inventory.files.every((f) => f.mode === 0o644));
                await reader.ref((kind === "entries" ? entries : execution).build.commandEvidence);
            }
            assert.deepEqual(execution.members.map((m) => m.path).sort(), [...names].sort());
            for (const member of execution.members) {
                const original = await readFile(join(sourceRoot, member.sourcePath));
                assert.equal(sha(original), member.sha256);
                assert.deepEqual(await readFile(join(inputRoot, "execution", member.path)), original);
            }
            await reader.finish();
            await work.audit();
            return 73;
        });
        assert.equal(result, 73);
        assert((await lstat(join(work.scratch, "views/entries/agent.js"))).isFile());
        assert.equal(work.committed, false);
    }));

/**
 * 源码和锁的变更发生在生产器已观察来源、真实构建刚关闭的边界，不能依赖旧 Ref 或成功退出忽略字节变化；这里直接改真实文
 * 件，回调是否运行由外部变量核实。
 */
for (const path of ["pnpm-lock.yaml", "packages/contracts/src/transitive.ts", "packages/contracts/schemas/test.json"])
    test(`source mutation after build rejects ${path}`, async () =>
        fixture(async ({ options, work, put }) => {
            const original = options.hostBuild.run;
            let mutated = false;
            const modified = {
                ...options,
                hostBuild: {
                    ...options.hostBuild,
                    run: async (invocation: Parameters<typeof original>[0]) => {
                        const result = await original(invocation);
                        assert.equal(result.exit, 0);
                        await put(path, "changed");
                        mutated = true;
                        return result;
                    },
                },
            };
            let consumed = false;
            await assert.rejects(
                withEntryInputViews(work, modified, async () => {
                    consumed = true;
                }),
            );
            assert.equal(consumed, false);
            assert.equal(mutated, true);
        }));

/**
 * 调用者在首个等待后修改数组与标量时只能影响自己持有的原对象，已快照的构建策略和动作身份必须保持原值；测试在真实宿主动
 * 作开始时修改来源数组与目标架构并检查最终收据。
 */
test("caller metadata and action are snapshotted before first await", async () =>
    fixture(async ({ options, work }) => {
        const original = options.hostBuild.run;
        const copied = {
            ...options,
            source: { ...options.source, files: [...options.source.files] },
            entries: { ...options.entries, target: { ...options.entries.target } },
            hostBuild: { ...options.hostBuild, run: original },
        };
        const pending = withEntryInputViews(work, copied, async (inputRoot, trees) => {
            const reader = new InputReader(inputRoot, undefined, ["entries", "execution"]);
            await reader.initialize();
            const receipt = await document<EntriesReceipt>(reader, trees.entries.buildReceipt, schemas.entries);
            assert.equal(receipt.build.target.arch, "arm64");
            await reader.finish();
        });
        copied.source.files.length = 0;
        copied.entries.target.arch = "x64";
        copied.hostBuild.run = async () => {
            throw new Error("late action");
        };
        await pending;
    }));

/**
 * 经由确认不存在的中间名进行两次真实重命名，使大小写不敏感卷也留下与构建观察不同的实际目录拼写，原始观察字节保持不变。
 */
async function mismatchEntryCase(root: string) {
    const tracePath = join(root, ".veriq-entry-trace.json"),
        traceBytes = await readFile(tracePath, "utf8"),
        trace = JSON.parse(traceBytes),
        intermediate = "case-fixture-intermediate.js",
        before = await readdir(root);
    assert.deepEqual(
        trace.outputs
            .filter((output: { path: string }) => output.path.toLowerCase() === "agent.js")
            .map((output: { path: string }) => output.path),
        ["agent.js"],
    );
    assert.deepEqual(
        before.filter((name) => name.toLowerCase() === "agent.js"),
        ["agent.js"],
    );
    assert.equal(before.includes(intermediate), false);
    await rename(join(root, "agent.js"), join(root, intermediate));
    const between = await readdir(root);
    assert.equal(between.includes(intermediate), true);
    assert.deepEqual(
        between.filter((name) => name.toLowerCase() === "agent.js"),
        [],
    );
    await rename(join(root, intermediate), join(root, "Agent.js"));
    const after = await readdir(root);
    assert.deepEqual(
        after.filter((name) => name.toLowerCase() === "agent.js"),
        ["Agent.js"],
    );
    assert.equal(after.includes(intermediate), false);
    assert.equal(await readFile(tracePath, "utf8"), traceBytes);
}

/**
 * 后置篡改用例保留真实 Vite 构建和真实关闭，只在观察前改变磁盘输出或内部观察，缺 chunk、额外文件、链接与大小写冲突均拒
 * 绝消费；隐藏导入使用真实额外资产和对应内部观察。
 */
for (const mutation of [
    "missing-entry",
    "missing-chunk",
    "extra",
    "link",
    "case",
    "case-mismatch",
    "trace-case-collision",
    "hidden-asset",
    "asset-import",
    "modified-entry",
    "unbundled-workspace",
    "escape",
    "empty-directory",
])
    test(`settled output rejects ${mutation}`, async () =>
        fixture(async ({ options, work }) => {
            const original = options.hostBuild.run;
            let mutated = false;
            let expectedCaseCode = mutation === "case-mismatch" ? "PAYLOAD_TREE_MISMATCH" : "PAYLOAD_COLLISION";
            const modified = {
                ...options,
                hostBuild: {
                    ...options.hostBuild,
                    run: async (invocation: Parameters<typeof original>[0]) => {
                        const result = await original(invocation);
                        assert.equal(result.exit, 0);
                        const root = options.buildRoot;
                        if (mutation === "missing-entry") await rm(join(root, "agent.js"));
                        if (mutation === "missing-chunk") {
                            const chunks = await readdir(join(root, "chunks"));
                            await rm(join(root, "chunks", chunks[0]!));
                        }
                        if (mutation === "extra") await writeFile(join(root, "extra.json"), "{}");
                        if (mutation === "link") {
                            await rm(join(root, "agent.js"));
                            await symlink("cli.js", join(root, "agent.js"));
                        }
                        if (mutation === "case") {
                            const trace = JSON.parse(await readFile(join(root, ".veriq-entry-trace.json"), "utf8"));
                            assert.deepEqual(
                                trace.outputs
                                    .filter((output: { path: string }) => output.path.toLowerCase() === "agent.js")
                                    .map((output: { path: string }) => output.path),
                                ["agent.js"],
                            );
                            await copyFile(join(root, "agent.js"), join(root, "Agent.js"));
                            const pair = (await readdir(root)).filter((name) => name.toLowerCase() === "agent.js"),
                                lower = await lstat(join(root, "agent.js"), { bigint: true }),
                                upper = await lstat(join(root, "Agent.js"), { bigint: true });
                            // 目录拼写和文件身份共同决定碰撞或别名，测试分支只采用磁盘事实，不读取产品拒绝结果。
                            if (pair.length === 2) {
                                assert.deepEqual(pair.sort(), ["Agent.js", "agent.js"]);
                                assert.notDeepEqual([lower.dev, lower.ino], [upper.dev, upper.ino]);
                            } else {
                                assert.deepEqual(pair, ["agent.js"]);
                                assert.deepEqual([lower.dev, lower.ino], [upper.dev, upper.ino]);
                                await mismatchEntryCase(root);
                                expectedCaseCode = "PAYLOAD_TREE_MISMATCH";
                            }
                        }
                        if (mutation === "case-mismatch") await mismatchEntryCase(root);
                        if (mutation === "trace-case-collision") {
                            const tracePath = join(root, ".veriq-entry-trace.json"),
                                trace = JSON.parse(await readFile(tracePath, "utf8")),
                                agent = trace.outputs.find((output: { path: string }) => output.path === "agent.js");
                            assert.ok(agent);
                            assert.deepEqual(
                                (await readdir(root)).filter((name) => name.toLowerCase() === "agent.js"),
                                ["agent.js"],
                            );
                            trace.outputs.push({ ...agent, path: "Agent.js" });
                            assert.deepEqual(
                                trace.outputs
                                    .filter((output: { path: string }) => output.path.toLowerCase() === "agent.js")
                                    .map((output: { path: string }) => output.path)
                                    .sort(),
                                ["Agent.js", "agent.js"],
                            );
                            await writeFile(tracePath, JSON.stringify(trace));
                        }
                        if (mutation === "modified-entry")
                            await writeFile(join(root, "agent.js"), "console.log('changed');");
                        if (mutation === "empty-directory") await mkdir(join(root, "empty"));
                        if (mutation === "escape" || mutation === "unbundled-workspace") {
                            const tracePath = join(root, ".veriq-entry-trace.json"),
                                trace = JSON.parse(await readFile(tracePath, "utf8"));
                            if (mutation === "escape") trace.outputs[0].path = "../escaped.js";
                            else {
                                const bytes = Buffer.from('import "@veriq/unbundled";');
                                await writeFile(join(root, "agent.js"), bytes);
                                Object.assign(
                                    trace.outputs.find((output: { path: string }) => output.path === "agent.js"),
                                    { sizeBytes: bytes.length, sha256: sha(bytes) },
                                );
                            }
                            await writeFile(tracePath, JSON.stringify(trace));
                        }
                        if (mutation === "hidden-asset" || mutation === "asset-import") {
                            const bytes = Buffer.from(
                                mutation === "hidden-asset" ? 'import "electron";' : 'import "node:path";',
                            );
                            await writeFile(join(root, "hidden.js"), bytes);
                            const tracePath = join(root, ".veriq-entry-trace.json");
                            const trace = JSON.parse(await readFile(tracePath, "utf8"));
                            trace.outputs.push({
                                path: "hidden.js",
                                kind: "asset",
                                sizeBytes: bytes.length,
                                sha256: sha(bytes),
                            });
                            await writeFile(tracePath, JSON.stringify(trace));
                        }
                        mutated = true;
                        return result;
                    },
                },
            };
            let consumed = false;
            const pending = withEntryInputViews(work, modified, async () => {
                consumed = true;
            });
            if (["case", "case-mismatch", "trace-case-collision"].includes(mutation))
                await assert.rejects(
                    pending,
                    (error: unknown) =>
                        !!error && typeof error === "object" && "code" in error && error.code === expectedCaseCode,
                );
            else await assert.rejects(pending);
            assert.equal(consumed, false);
            assert.equal(mutated, true);
        }));

/**
 * 普通 JSON 导入通常被 Vite 嵌入共享模块，另外的夹具专用插件发出真实 JSON 资产以覆盖资产库存边界；其配置与原 JSON 均先
 * 绑定来源，缺失资产必须在消费前拒绝，不能假称所有 schema 都会落盘。
 */
for (const missing of [false, true])
    test(`real emitted JSON asset is complete: missing=${missing}`, async () =>
        fixture(
            async ({ options, work }) => {
                const original = options.hostBuild.run;
                let built = false,
                    consumed = false;
                const modified = {
                    ...options,
                    hostBuild: {
                        ...options.hostBuild,
                        run: async (invocation: Parameters<typeof original>[0]) => {
                            const result = await original(invocation);
                            assert.equal(result.exit, 0);
                            built = true;
                            if (missing) await rm(join(options.buildRoot, "assets/schema.json"));
                            return result;
                        },
                    },
                };
                const pending = withEntryInputViews(work, modified, async (inputRoot, trees) => {
                    consumed = true;
                    const reader = new InputReader(inputRoot, undefined, ["entries", "execution"]);
                    await reader.initialize();
                    const receipt = await document<EntriesReceipt>(reader, trees.entries.buildReceipt, schemas.entries);
                    assert.deepEqual(
                        receipt.outputs.find((output) => output.path === "assets/schema.json"),
                        { path: "assets/schema.json", kind: "asset", imports: [] },
                    );
                    assert.equal(
                        await readFile(join(inputRoot, "entries/assets/schema.json"), "utf8"),
                        '{"title":"bound-schema"}',
                    );
                    await reader.finish();
                });
                if (missing) await assert.rejects(pending);
                else await pending;
                assert.equal(built, true);
                assert.equal(consumed, !missing);
            },
            "",
            true,
        ));

/**
 * 关闭未知用例来自已真实执行并结算的宿主动作，然后保守降低其关闭事实并替换构建根为不可遍历链接；应先报告 INCOMPLETE 而
 * 不能在该路径扫描后覆盖原始失败或尝试清理目录。
 */
test("unknown close prevents output observation and preserves scratch", async () =>
    fixture(async ({ options, work }) => {
        const original = options.hostBuild.run;
        const modified = {
            ...options,
            hostBuild: {
                ...options.hostBuild,
                run: async (invocation: Parameters<typeof original>[0]): Promise<HostBuildObservation> => {
                    const result = await original(invocation);
                    assert.equal(result.exit, 0);
                    await rm(options.buildRoot, { recursive: true });
                    await symlink("missing-output-root", options.buildRoot);
                    return { ...result, closeConfirmed: false, error: "OBSERVED_CLOSE_UNKNOWN" };
                },
            },
        };
        await assert.rejects(
            withEntryInputViews(work, modified, async () => assert.fail("consumer called")),
            (error: unknown) =>
                !!error &&
                typeof error === "object" &&
                "cleanup" in error &&
                error.cleanup === "INCOMPLETE" &&
                "causeCode" in error &&
                error.causeCode === "OBSERVED_CLOSE_UNKNOWN",
        );
        assert((await lstat(options.buildRoot)).isSymbolicLink());
        assert.deepEqual(await readdir(join(work.scratch, "views")), []);
    }));

/**
 * 真实构建失败与禁止的 Electron 外部导入分别验证进程和图的拒绝点，输入源码保持可解析以免用缺失依赖冒充策略测试；生产器
 * 不应在任一失败路径调用消费回调。
 */
for (const [name, entry] of [
    ["build failure", "export const broken = ;"],
    ["electron external", 'import electron from "electron"; console.log(electron);'],
    ["bare builtin", 'import fs from "fs"; console.log(fs);'],
])
    test(`rejects ${name}`, async () =>
        fixture(async ({ options, work }) => {
            const original = options.hostBuild.run;
            let observed: HostBuildObservation | undefined;
            const modified = {
                ...options,
                hostBuild: {
                    ...options.hostBuild,
                    run: async (invocation: Parameters<typeof original>[0]) => {
                        observed = await original(invocation);
                        return observed;
                    },
                },
            };
            await assert.rejects(
                withEntryInputViews(work, modified, async () => assert.fail("consumer called")),
                (error: unknown) =>
                    !!error &&
                    typeof error === "object" &&
                    "code" in error &&
                    error.code === (name === "build failure" ? "PAYLOAD_IO" : "PAYLOAD_GRAPH_MISMATCH"),
            );
            assert.equal(observed?.admitted, true);
            assert.equal(observed?.closeConfirmed, true);
            assert.equal(observed?.exit, name === "build failure" ? 1 : 0);
            if (name === "build failure") assert(observed!.stderr.length > 0);
        }, entry));

/**
 * 未列入来源绑定的真实工作区模块即使仍可被宿主 Vite 成功解析，也不能从可读路径获得合法来源身份；用例只移除绑定并重算现
 * 有构建头，保持真实模块文件存在以独立触发来源覆盖拒绝。
 */
test("resolved workspace source absent from SourceBinding is rejected", async () =>
    fixture(async ({ options, work }) => {
        const source = {
                ...options.source,
                files: options.source.files.filter((ref) => ref.path !== "packages/contracts/src/transitive.ts"),
            },
            binding = sha(canonicalBytes(source)),
            original = options.hostBuild.run;
        let built = false;
        const modified = {
            ...options,
            source,
            entries: { ...options.entries, sourceBindingSha256: binding },
            execution: { ...options.execution, sourceBindingSha256: binding },
            hostBuild: {
                ...options.hostBuild,
                run: async (invocation: Parameters<typeof original>[0]) => {
                    const result = await original(invocation);
                    assert.equal(result.exit, 0);
                    built = true;
                    return result;
                },
            },
        };
        await assert.rejects(withEntryInputViews(work, modified, async () => assert.fail("consumer called")));
        assert.equal(built, true);
    }));

/**
 * 实际工作区的最近物理清单即使未列入绑定仍参与真实 Vite 导出解析，不能让更远的绑定诱饵取代其名称与版本；两个诱饵分别验
 * 证静默丢弃归属和错误归属都在真实成功构建后被拒绝。
 */
for (const name of ["fixture-decoy", "@veriq/decoy"])
    test(`actual nearest workspace manifest rejects farther bound decoy ${name}`, async () =>
        fixture(async ({ options, work, sourceRoot, put }) => {
            const path = "packages/package.json",
                bytes = Buffer.from(JSON.stringify({ name, version: "9.9.9", type: "module" }));
            await put(path, bytes);
            assert((await lstat(join(sourceRoot, "packages/contracts/package.json"))).isFile());
            const source = {
                    ...options.source,
                    files: [
                        ...options.source.files.filter((ref) => ref.path !== "packages/contracts/package.json"),
                        { path, sizeBytes: bytes.length, sha256: sha(bytes) },
                    ],
                },
                sourceBindingSha256 = sha(canonicalBytes(source)),
                original = options.hostBuild.run;
            let built = false,
                consumed = false;
            const modified = {
                ...options,
                source,
                entries: { ...options.entries, sourceBindingSha256 },
                execution: { ...options.execution, sourceBindingSha256 },
                hostBuild: {
                    ...options.hostBuild,
                    run: async (invocation: Parameters<typeof original>[0]) => {
                        const result = await original(invocation);
                        assert.equal(result.admitted, true);
                        assert.equal(result.closeConfirmed, true);
                        assert.equal(result.exit, 0);
                        built = true;
                        return result;
                    },
                },
            };
            await assert.rejects(
                withEntryInputViews(work, modified, async () => {
                    consumed = true;
                }),
                (error: unknown) =>
                    !!error &&
                    typeof error === "object" &&
                    "code" in error &&
                    error.code === "PAYLOAD_RECEIPT_MISMATCH",
            );
            assert.equal(built, true);
            assert.equal(consumed, false);
        }));

/**
 * 固定视图命名空间在大小写敏感宿主上也必须按可移植规则预留，大小写成对用例保持真实来源文件和正确构建绑定；拒绝必须发生
 * 在宿主动作与消费之前，不能靠后续构建错误碰巧满足断言。
 */
for (const prefix of ["entries", "Entries", "execution", "ExEcUtIoN", "input-evidence", "INPUT-EVIDENCE"])
    test(`reserved view namespace rejects before host action: ${prefix}`, async () =>
        fixture(async ({ options, work, put }) => {
            const path = `${prefix}/extra.ts`,
                bytes = Buffer.from("export const reserved = true;");
            await put(path, bytes);
            const source = {
                    ...options.source,
                    files: [...options.source.files, { path, sizeBytes: bytes.length, sha256: sha(bytes) }],
                },
                sourceBindingSha256 = sha(canonicalBytes(source)),
                original = options.hostBuild.run;
            let admitted = false,
                consumed = false;
            const modified = {
                ...options,
                source,
                entries: { ...options.entries, sourceBindingSha256 },
                execution: { ...options.execution, sourceBindingSha256 },
                hostBuild: {
                    ...options.hostBuild,
                    run: async (invocation: Parameters<typeof original>[0]) => {
                        admitted = true;
                        return original(invocation);
                    },
                },
            };
            await assert.rejects(
                withEntryInputViews(work, modified, async () => {
                    consumed = true;
                }),
                (error: unknown) =>
                    !!error && typeof error === "object" && "code" in error && error.code === "PAYLOAD_PATH",
            );
            assert.equal(admitted, false);
            assert.equal(consumed, false);
        }));

/**
 * 构建目录准入与宿主动作分离，已有内容或覆盖源码和事务的根都应在真实命令开始之前拒绝；测试保留空动作计数，避免把后续构
 * 建失败错误计作所有权验证已经生效。
 */
for (const invalid of ["nonempty", "source", "work"])
    test(`build root ownership rejects ${invalid}`, async () =>
        fixture(async ({ options, work, sourceRoot }) => {
            let admitted = false;
            if (invalid === "nonempty") await writeFile(join(options.buildRoot, "existing"), "owned");
            const modified = {
                ...options,
                buildRoot:
                    invalid === "source"
                        ? sourceRoot
                        : invalid === "work"
                          ? join(work.scratch, "build")
                          : options.buildRoot,
                hostBuild: {
                    ...options.hostBuild,
                    run: async () => {
                        admitted = true;
                        throw new Error("unexpected action");
                    },
                },
            };
            await assert.rejects(withEntryInputViews(work, modified, async () => assert.fail("consumer called")));
            assert.equal(admitted, false);
        }));

/**
 * 错误根目录中的来源副本使用事务既有私有六百权限，严格 reader 必须拒绝；同一规则还要求生产器只在 views 根提供原路径源
 * 码，不能通过放宽 reader 模式掩盖放置错误。
 */
test("a source ref at the private transaction root is rejected", async () =>
    fixture(async ({ work, options }) => {
        const ref = options.source.files.find((r) => r.path === "pnpm-lock.yaml")!;
        await work.observeRefs([ref]);
        await work.snapshot(ref, ref.path);
        const reader = new InputReader(work.scratch, undefined, []);
        await reader.initialize();
        await assert.rejects(reader.ref(ref));
    }));

/**
 * 消费者得到路径后仍处于被观察的存活阶段，篡改生成树或原始来源都必须在返回前被最终 reader 与事务审计发现；不能把回调已
 * 返回当作授权忽略其期间发生的实际内容变化。
 */
for (const source of [false, true])
    test(`mutation during consumer is rejected: source=${source}`, async () =>
        fixture(async ({ work, options, sourceRoot }) => {
            let consumed = false;
            await assert.rejects(
                withEntryInputViews(work, options, async (inputRoot) => {
                    consumed = true;
                    await writeFile(
                        source ? join(sourceRoot, "pnpm-lock.yaml") : join(inputRoot, "entries/agent.js"),
                        "changed",
                    );
                    return "must not escape";
                }),
            );
            assert.equal(consumed, true);
        }));
