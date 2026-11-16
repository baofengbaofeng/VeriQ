/**
 * 夹具搬运测试使用小型真实 ESM 包树验证可搬迁性、复制后的权限隔离与链接边界，不创建账户或挂载；源目录删除后仍须从自有
 * 副本解析依赖，因此通过只说明装载闭包成立，不能代替目标专用 UID 的凭据与卷验收。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    mkdtemp,
    mkdir,
    writeFile,
    readFile,
    lstat,
    rm,
    symlink,
    unlink,
    chmod,
    link,
    readdir,
    readlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
// @ts-expect-error 夹具准备工具由 Node 直接执行而不属于 Runtime 应用的声明接口，测试通过其真实文件与执行边界观察行为；
// 这里保留单行命名空间导入，使 TypeScript 的预期声明缺失标记准确绑定导入位置
// ，不为测试维护第二套生产类型定义。
import * as fixtureStage from "../scripts/restricted-fixture-stage.mjs";
const {
    stageOwnedFixture,
    prepareFixtureDeployment,
    verifyFrozenFixtureDeployment,
    readPreparedFixtureDeployment,
    executeNetworkIsolatedFixture,
} = fixtureStage;

test("owned fixture copy resolves relocated package links without source or writable code", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq-fixture-stage-"));
    const source = join(root, "source"),
        target = join(root, "target");
    try {
        await mkdir(join(source, "node_modules/.pnpm/owned/node_modules/owned"), {
            recursive: true,
        });
        await writeFile(join(source, "package.json"), '{"type":"module"}', { mode: 0o600 });
        await writeFile(
            join(source, "entry.mjs"),
            'import value from "owned"; console.log(value);',
            { mode: 0o600 },
        );
        await writeFile(
            join(source, "node_modules/.pnpm/owned/node_modules/owned/package.json"),
            '{"type":"module","exports":"./index.js"}',
        );
        await writeFile(
            join(source, "node_modules/.pnpm/owned/node_modules/owned/index.js"),
            'export default "owned-relocated";',
        );
        await symlink(".pnpm/owned/node_modules/owned", join(source, "node_modules/owned"));
        const before = await lstat(join(source, "entry.mjs"));
        const result = await stageOwnedFixture(source, target);
        assert.equal(result.files, 4);
        assert.equal(result.links, 1);
        assert(result.bytes > 0);
        assert.match(result.inventorySha256, /^[a-f0-9]{64}$/);
        const after = await lstat(join(source, "entry.mjs"));
        assert.equal(after.mode, before.mode);
        assert.equal(after.ino, before.ino);
        assert.notEqual((await lstat(join(target, "entry.mjs"))).ino, before.ino);
        assert.equal((await lstat(join(target, "entry.mjs"))).mode & 0o777, 0o644);
        assert.equal((await lstat(target)).mode & 0o777, 0o755);
        assert.equal(
            await readFile(join(source, "entry.mjs"), "utf8"),
            await readFile(join(target, "entry.mjs"), "utf8"),
        );
        await assert.rejects(stageOwnedFixture(source, target));
        await rm(source, { recursive: true });
        const child = await promisify(execFile)(process.execPath, [join(target, "entry.mjs")], {
            cwd: target,
            timeout: 5000,
        });
        assert.equal(child.stdout, "owned-relocated\n");
        assert.equal(child.stderr, "");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("owned fixture copy rejects external package links before creating destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq-fixture-stage-denied-"));
    const source = join(root, "source"),
        target = join(root, "target");
    try {
        await mkdir(source);
        await writeFile(join(root, "outside"), "not owned by closure");
        await symlink("../outside", join(source, "external"));
        await assert.rejects(stageOwnedFixture(source, target), /FIXTURE_LINK_OUTSIDE/);
        await assert.rejects(lstat(target), { code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/**
 * 副本拥有者不能从源文件继承而须由实际复制调用者确定，测试逐项读取普通文件、目录与内部链接的真实属性；源包含硬链接和不
 * 同执行权限，确保权限规范化不会通过任何共享 inode 改变源树，也不会把身份摘要混入原有字节库存哈希。
 */
test(
    "owned fixture copy verifies caller ownership separa" +
        "tely from bytes and preserves every source attribute",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "veriq-fixture-ownership-"));
        const source = join(root, "source"),
            target = join(root, "target");
        async function attributes(directory: string, member = ""): Promise<any[]> {
            const path = join(directory, member),
                entry = await lstat(path);
            const current = {
                path: member,
                dev: entry.dev,
                ino: entry.ino,
                nlink: entry.nlink,
                uid: entry.uid,
                gid: entry.gid,
                mode: entry.mode,
                ...(entry.isSymbolicLink()
                    ? { link: await readlink(path) }
                    : entry.isFile()
                      ? {
                            sha256: createHash("sha256")
                                .update(await readFile(path))
                                .digest("hex"),
                        }
                      : { directory: true }),
            };
            const children = entry.isDirectory()
                ? (
                      await Promise.all(
                          (await readdir(path))
                              .sort()
                              .map((name) => attributes(directory, join(member, name))),
                      )
                  ).flat()
                : [];
            return [current, ...children];
        }
        try {
            await mkdir(join(source, "nested"), { recursive: true });
            await writeFile(join(source, "data.json"), '{"fixture":"owned"}\n');
            await chmod(join(source, "data.json"), 0o640);
            await link(join(source, "data.json"), join(source, "alias.json"));
            await writeFile(join(source, "nested/tool.mjs"), 'export const marker = "owned";\n');
            await chmod(join(source, "nested/tool.mjs"), 0o710);
            await symlink("nested/tool.mjs", join(source, "internal"));
            await chmod(join(source, "nested"), 0o700);
            const before = await attributes(source);
            const result = await stageOwnedFixture(source, target);
            const copied = await attributes(target),
                sourceInodes = new Set(before.map((entry) => `${entry.dev}:${entry.ino}`));
            assert.deepEqual(await attributes(source), before);
            for (const entry of copied) {
                assert(
                    !sourceInodes.has(`${entry.dev}:${entry.ino}`),
                    "No copied member may share any source inode",
                );
                if (entry.link) {
                    assert.equal(entry.link, "nested/tool.mjs");
                    continue;
                }
                assert.equal(entry.uid, process.getuid!());
                assert.equal(entry.gid, process.getgid!());
                assert.equal(
                    entry.mode & 0o7777,
                    entry.directory || entry.path === "nested/tool.mjs" ? 0o755 : 0o644,
                );
            }
            assert.deepEqual(result.ownership, {
                uid: process.getuid!(),
                gid: process.getgid!(),
                regularFiles: 3,
                directories: 2,
            });
            assert.equal(
                result.inventorySha256,
                createHash("sha256").update(JSON.stringify(result.inventory)).digest("hex"),
            );
            assert(
                result.inventory.every(
                    (entry: any) => entry.uid === undefined && entry.gid === undefined,
                ),
                "Byte inventory remains independent from copied ownership",
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

test("owned fixture copy refuses a linked target parent before creating or normalizing copied members", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq-fixture-parent-link-"));
    const source = join(root, "source"),
        outside = join(root, "outside"),
        linked = join(root, "linked"),
        target = join(linked, "target");
    try {
        await mkdir(source);
        await mkdir(outside);
        await symlink(outside, linked);
        await writeFile(join(source, "data"), "owned source", { mode: 0o600 });
        await writeFile(join(outside, "sentinel"), "untouched", { mode: 0o600 });
        const before = await lstat(join(source, "data")),
            sentinel = await lstat(join(outside, "sentinel"));
        await assert.rejects(stageOwnedFixture(source, target), /FIXTURE_TARGET_PARENT_LINKED/);
        await assert.rejects(lstat(join(outside, "target")), { code: "ENOENT" });
        assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "untouched");
        assert.equal((await lstat(join(outside, "sentinel"))).mode, sentinel.mode);
        assert.equal((await lstat(join(source, "data"))).mode, before.mode);
        assert.equal((await lstat(join(source, "data"))).ino, before.ino);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/**
 * 小仓库使用完整但微型的真实 manifest、三份锁和可搬迁安装树模拟官方部署的文件接口；故意保留同版本的 peer 后缀与平台可
 * 选边，使单纯比较包名版本或只看派生锁的实现无法通过这些行为断言。
 */
async function graphFixture() {
    const root = await mkdtemp(join(tmpdir(), "veriq-frozen-graph-"));
    const repository = join(root, "repository"),
        source = join(root, "runtime"),
        evidence = join(root, "evidence");
    await mkdir(evidence, { recursive: true });
    const names = ["compiler", "contracts", "runner-sdk"];
    const workspaceId = (name: string) => `@veriq/${name}@file://${repository}/packages/${name}`;
    const deps = Object.fromEntries(names.map((name) => [`@veriq/${name}`, "workspace:*"]));
    const runtime = {
        name: "@veriq/runtime",
        version: "0.1.0",
        type: "module",
        dependencies: { ...deps, unit: "1.0.0" },
        optionalDependencies: { hostonly: "1.0.0" },
    };
    const edge = (specifier: string, version = specifier) => ({ specifier, version });
    const packages: Record<string, any> = {
        "unit@1.0.0": {
            resolution: { integrity: "sha512-unit" },
            peerDependencies: { peer: "1.0.0" },
        },
        "peer@1.0.0": { resolution: { integrity: "sha512-peer" } },
        "hostonly@1.0.0": { resolution: { integrity: "sha512-host" }, os: ["darwin"] },
    };
    const snapshots: Record<string, any> = {
        "unit@1.0.0(peer@1.0.0)": { dependencies: { peer: "1.0.0" } },
        "peer@1.0.0": {},
        "hostonly@1.0.0": { optional: true },
    };
    const importer = {
        dependencies: {
            ...Object.fromEntries(
                names.map((name) => [
                    `@veriq/${name}`,
                    edge("workspace:*", `link:../../packages/${name}`),
                ]),
            ),
            unit: edge("1.0.0", "1.0.0(peer@1.0.0)"),
        },
        optionalDependencies: { hostonly: edge("1.0.0") },
    };
    const rootLock: any = {
        lockfileVersion: "9.0",
        settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
        importers: { "apps/runtime": importer },
        packages,
        snapshots,
    };
    const deployed: any = {
        ...runtime,
        dependencies: {
            ...Object.fromEntries(names.map((name) => [`@veriq/${name}`, workspaceId(name)])),
            unit: "1.0.0",
        },
    };
    const derived: any = structuredClone({
        ...rootLock,
        importers: {
            ".": {
                ...importer,
                dependencies: {
                    ...Object.fromEntries(
                        names.map((name) => [`@veriq/${name}`, edge(workspaceId(name))]),
                    ),
                    unit: edge("1.0.0", "1.0.0(peer@1.0.0)"),
                },
            },
        },
    });
    const manifests = new Map<string, any>([["apps/runtime", runtime]]);
    for (const name of names) {
        const manifest = {
            name: `@veriq/${name}`,
            version: "0.1.0",
            type: "module",
            exports: "./index.js",
            dependencies: { unit: "1.0.0" },
        };
        manifests.set(`packages/${name}`, manifest);
        rootLock.importers[`packages/${name}`] = {
            dependencies: { unit: edge("1.0.0", "1.0.0(peer@1.0.0)") },
        };
        derived.packages[workspaceId(name)] = {
            resolution: {
                directory: relative(source, join(repository, "packages", name)),
                type: "directory",
            },
        };
        derived.snapshots[workspaceId(name)] = { dependencies: { unit: "1.0.0(peer@1.0.0)" } };
    }
    const json = async (path: string, value: any) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(value, null, 4) + "\n");
    };
    await json(join(repository, "package.json"), { name: "veriq", packageManager: "pnpm@11.25.0" });
    await writeFile(
        join(repository, "pnpm-workspace.yaml"),
        "minimumReleaseAge: 1440\nstrictPeerDependencies: true\n",
    );
    for (const [path, manifest] of manifests)
        await json(join(repository, path, "package.json"), manifest);
    await json(join(source, "package.json"), deployed);
    const installed = new Map<string, string>();
    for (const [name, version] of [
        ["unit", "1.0.0"],
        ["peer", "1.0.0"],
        ...names.map((name) => [`@veriq/${name}`, "0.1.0"]),
    ]) {
        const directory = join(
            source,
            "node_modules/.pnpm",
            name!.replace("/", "+"),
            "node_modules",
            name!,
        );
        installed.set(name!, directory);
        const manifest = name!.startsWith("@veriq/")
            ? manifests.get(`packages/${name!.split("/")[1]}`)
            : { name, version, type: "module", exports: "./index.js" };
        await json(join(directory, "package.json"), manifest);
        await writeFile(join(directory, "index.js"), "export const marker = 1;\n");
        await mkdir(dirname(join(source, "node_modules", name!)), { recursive: true });
        await symlink(
            relative(dirname(join(source, "node_modules", name!)), directory),
            join(source, "node_modules", name!),
        );
    }
    const modules: any = {
        included: { dependencies: true, devDependencies: false, optionalDependencies: true },
        packageManager: "pnpm@11.25.0",
        nodeLinker: "isolated",
        virtualStoreDir: ".pnpm",
        skipped: ["hostonly@1.0.0"],
        hoistedDependencies: {},
    };
    const save = async () => {
        await json(join(repository, "pnpm-lock.yaml"), rootLock);
        await json(join(source, "pnpm-lock.yaml"), derived);
        await json(join(source, "node_modules/.pnpm/lock.yaml"), derived);
        await json(join(source, "node_modules/.modules.yaml"), modules);
        await json(join(source, "package.json"), deployed);
    };
    await save();
    return {
        root,
        repository,
        source,
        evidence,
        rootLock,
        derived,
        deployed,
        modules,
        installed,
        json,
        save,
        workspaceId,
    };
}

test("three frozen locks accept only the exact production graph and installed inventory", async () => {
    const fixture = await graphFixture();
    try {
        const proof = await verifyFrozenFixtureDeployment(fixture.repository, fixture.source);
        assert(proof.graph, "Exact graph proof is required");
        assert.equal(proof.graph.registryPackages, 3);
        assert.equal(proof.graph.workspaceSnapshots, 3);
        assert.equal(proof.graph.reachableSnapshots, 6);
        assert.equal(proof.installed.packages.length, 5);
        assert.deepEqual(proof.installed.skipped, ["hostonly@1.0.0"]);
        for (const value of Object.values(proof.hashes))
            assert.match(value as string, /^[a-f0-9]{64}$/);
        assert.match(proof.inventory.inventorySha256, /^[a-f0-9]{64}$/);
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

/**
 * 每个错误输入都落在同一套真实文件边界上，失败来自生产验证器读取并拒绝篡改后的图或库存；特别将 current 锁单独改坏，防
 * 止只验证部署导出锁而遗漏实际已安装包的生产引用和完整性来源。
 */
const graphMutations: Record<
    string,
    (f: Awaited<ReturnType<typeof graphFixture>>) => Promise<void> | void
> = {
    integrity: (f) => {
        f.derived.packages["unit@1.0.0"].resolution.integrity = "sha512-drift";
    },
    version: (f) => {
        f.derived.importers["."].dependencies.unit.version = "2.0.0";
    },
    peerSuffix: (f) => {
        f.derived.snapshots["unit@1.0.0(peer@2.0.0)"] =
            f.derived.snapshots["unit@1.0.0(peer@1.0.0)"];
        delete f.derived.snapshots["unit@1.0.0(peer@1.0.0)"];
    },
    peerDeclaration: (f) => {
        f.derived.packages["unit@1.0.0"].peerDependencies.peer = "2.0.0";
    },
    dependencyEdge: (f) => {
        f.derived.snapshots["unit@1.0.0(peer@1.0.0)"].dependencies.peer = "2.0.0";
    },
    optionalEdge: (f) => {
        delete f.derived.importers["."].optionalDependencies;
    },
    importerSpecifier: (f) => {
        f.derived.importers["."].dependencies.unit.specifier = "^1.0.0";
    },
    workspacePath: (f) => {
        f.derived.packages[f.workspaceId("compiler")].resolution.directory = "../../outside";
    },
    workspaceDependency: (f) => {
        f.derived.snapshots[f.workspaceId("contracts")].dependencies.unit = "2.0.0";
    },
    missingSnapshot: (f) => {
        delete f.derived.snapshots["peer@1.0.0"];
    },
    extraSnapshot: (f) => {
        f.derived.packages["dev@9.0.0"] = { resolution: { integrity: "sha512-dev" } };
        f.derived.snapshots["dev@9.0.0"] = {};
    },
    devImporter: (f) => {
        f.derived.importers["."].devDependencies = {
            dev: { specifier: "9.0.0", version: "9.0.0" },
        };
    },
    devManifest: (f) => {
        f.deployed.devDependencies = { dev: "9.0.0" };
    },
    manifestReference: (f) => {
        f.deployed.dependencies.unit = "2.0.0";
    },
    wrongLockVersion: (f) => {
        f.derived.lockfileVersion = "8.0";
    },
    unknownImporter: (f) => {
        f.derived.importers.other = {};
    },
    incompleteSkipped: (f) => {
        f.modules.skipped = [];
    },
    missingRequired: async (f) => {
        await unlink(join(f.source, "node_modules/unit"));
    },
    platformRequiredSkipped: (f) => {
        f.modules.skipped.push("unit@1.0.0(peer@1.0.0)");
    },
    extraInstalled: async (f) => {
        await f.json(join(f.source, "node_modules/dev/package.json"), {
            name: "dev",
            version: "9.0.0",
        });
    },
    externalLink: async (f) => {
        await writeFile(join(f.root, "outside"), "sentinel");
        await symlink("../outside", join(f.source, "external"));
    },
    installDevEnabled: (f) => {
        f.modules.included.devDependencies = true;
    },
};
for (const [name, mutate] of Object.entries(graphMutations))
    test(`three frozen locks reject ${name}`, async () => {
        const fixture = await graphFixture();
        try {
            await mutate(fixture);
            await fixture.save();
            await assert.rejects(
                verifyFrozenFixtureDeployment(fixture.repository, fixture.source),
                /FIXTURE_/,
            );
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

test("three frozen locks reject actual current lock drift independently of the derived lock", async () => {
    const fixture = await graphFixture();
    try {
        const current = structuredClone(fixture.derived);
        current.packages["peer@1.0.0"].resolution.integrity = "sha512-current-drift";
        await fixture.json(join(fixture.source, "node_modules/.pnpm/lock.yaml"), current);
        await assert.rejects(
            verifyFrozenFixtureDeployment(fixture.repository, fixture.source),
            /FIXTURE_/,
        );
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

for (const [name, content] of Object.entries({
    scalar: "not-a-lock\n",
    sequence: "- not-a-map\n",
    duplicate: "lockfileVersion: '9.0'\nlockfileVersion: '8.0'\n",
    cyclicAlias: "cycle: &cycle { self: *cycle }\n",
    oversized: " ".repeat(4 * 1024 * 1024 + 1),
}))
    test(`three frozen locks reject bounded malformed ${name} input`, async () => {
        const fixture = await graphFixture();
        try {
            await writeFile(join(fixture.source, "pnpm-lock.yaml"), content);
            await assert.rejects(
                verifyFrozenFixtureDeployment(fixture.repository, fixture.source),
                /FIXTURE_/,
            );
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

test("frozen prepare uses bounded exact official argv and binds successful source evidence", async () => {
    const fixture = await graphFixture();
    let deploymentRoot: string | undefined;
    try {
        const calls: any[] = [];
        const execute = async (file: string, args: string[], options: any) => {
            calls.push({ file, args, options });
            if (args[1] === "--version") return { stdout: "11.25.0\n", stderr: "" };
            if (args[1] === "config") {
                assert.deepEqual(args.slice(1, 3), ["config", "get"]);
                assert(["registry", "minimumReleaseAge"].includes(args[3]!));
                return {
                    stdout: args[3] === "registry" ? "https://registry.npmjs.org/\n" : "1440\n",
                    stderr: "",
                };
            }
            deploymentRoot = dirname(args.at(-1)!);
            assert.deepEqual(args.slice(1, -1), [
                "--filter",
                "@veriq/runtime",
                "--config.inject-workspace-packages=true",
                "deploy",
                "--frozen-lockfile",
                "--prod",
                "--ignore-scripts",
                "--package-import-method=copy",
                "--hoist=false",
            ]);
            assert.equal(options.timeout, 120000);
            assert.equal(options.maxBuffer, 1024 * 1024);
            const { cp } = await import("node:fs/promises");
            await cp(fixture.source, args.at(-1)!, { recursive: true, verbatimSymlinks: true });
            const deployed = structuredClone(fixture.derived);
            for (const name of ["compiler", "contracts", "runner-sdk"])
                deployed.packages[fixture.workspaceId(name)].resolution.directory = relative(
                    args.at(-1)!,
                    join(fixture.repository, "packages", name),
                );
            await fixture.json(join(args.at(-1)!, "pnpm-lock.yaml"), deployed);
            await fixture.json(join(args.at(-1)!, "node_modules/.pnpm/lock.yaml"), deployed);
            const state = JSON.parse(
                await readFile(join(fixture.evidence, "restricted-file-deployment.json"), "utf8"),
            );
            assert.equal(await readFile(join(state.root, ".owned"), "utf8"), state.nonce);
            assert.equal((await lstat(state.root)).mode & 0o777, 0o700);
            await assert.rejects(
                lstat(join(fixture.evidence, "restricted-file-deployment-result.json")),
                { code: "ENOENT" },
            );
            return { stdout: "synthetic finite deploy\n", stderr: "" };
        };
        const result = await prepareFixtureDeployment(fixture.evidence, "/finite/pnpm.cjs", {
            repository: fixture.repository,
            temporary: "/dev/shm",
            execute,
        });
        assert.equal(calls.length, 4);
        assert.equal(result.passed, true);
        const state = JSON.parse(
            await readFile(join(fixture.evidence, "restricted-file-deployment.json"), "utf8"),
        );
        assert.equal(result.nonce, state.nonce);
        assert.equal(result.root, state.root);
        assert.equal(result.source, state.source);
        assert.equal(result.verification.graph.reachableSnapshots, 6);
        assert.equal(
            (await readPreparedFixtureDeployment(fixture.evidence, "/dev/shm", fixture.repository))
                .nonce,
            result.nonce,
        );
        const resultPath = join(fixture.evidence, "restricted-file-deployment-result.json");
        for (const key of ["nonce", "source", "uid", "passed"]) {
            const invalid = {
                ...result,
                [key]: key === "uid" ? result.uid + 1 : key === "passed" ? false : "wrong-binding",
            };
            await fixture.json(resultPath, invalid);
            await assert.rejects(
                readPreparedFixtureDeployment(fixture.evidence, "/dev/shm", fixture.repository),
                /FIXTURE_DEPLOY_RESULT_UNBOUND/,
            );
        }
        await fixture.json(resultPath, result);
        await writeFile(join(result.source, "unverified-residue"), "changed");
        await assert.rejects(
            readPreparedFixtureDeployment(fixture.evidence, "/dev/shm", fixture.repository),
            /FIXTURE_DEPLOY_INVENTORY_CHANGED/,
        );
        await runStageCleanup(fixture.evidence, "/dev/shm");
        await assert.rejects(lstat(state.root), { code: "ENOENT" });
    } finally {
        if (deploymentRoot) await rm(deploymentRoot, { recursive: true, force: true });
        await rm(fixture.root, { recursive: true, force: true });
    }
});

for (const policy of ["registry", "minimumReleaseAge"])
    test(`frozen prepare rejects effective ${policy} drift before deployment`, async () => {
        const fixture = await graphFixture();
        let deployed = false,
            deploymentRoot: string | undefined;
        try {
            await assert.rejects(
                prepareFixtureDeployment(fixture.evidence, "/finite/pnpm.cjs", {
                    repository: fixture.repository,
                    temporary: "/dev/shm",
                    execute: async (_file: string, args: string[]) => {
                        const state = JSON.parse(
                            await readFile(
                                join(fixture.evidence, "restricted-file-deployment.json"),
                                "utf8",
                            ),
                        );
                        deploymentRoot = state.root;
                        if (args[1] === "--version") return { stdout: "11.25.0\n", stderr: "" };
                        if (args[1] === "config")
                            return {
                                stdout:
                                    args[3] === policy
                                        ? "policy-drift\n"
                                        : args[3] === "registry"
                                          ? "https://registry.npmjs.org/\n"
                                          : "1440\n",
                                stderr: "",
                            };
                        deployed = true;
                        throw new Error("Unexpected deployment");
                    },
                }),
                /FIXTURE_EFFECTIVE_POLICY/,
            );
            assert.equal(deployed, false);
            await assert.rejects(
                lstat(join(fixture.evidence, "restricted-file-deployment-result.json")),
                { code: "ENOENT" },
            );
            await runStageCleanup(fixture.evidence, "/dev/shm");
        } finally {
            if (deploymentRoot) await rm(deploymentRoot, { recursive: true, force: true });
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

/**
 * 清理只通过真实 CLI 读取先落盘的拥有状态，因此错误 nonce、UID、父路径、符号链接和部分失败目录都能观察到保留或删除结果
 * ；受保护的外部标记始终保持原内容，测试不凭内部函数调用次数推断安全边界。
 */
async function runStageCleanup(evidence: string, temporary: string) {
    return promisify(execFile)(
        process.execPath,
        [join(import.meta.dirname, "../scripts/restricted-fixture-stage.mjs"), "cleanup", evidence],
        { env: { ...process.env, RUNNER_TEMP: temporary }, timeout: 10000, maxBuffer: 1024 * 1024 },
    );
}
for (const reason of ["execute-failure", "timeout", "changed-root-input"])
    test(`frozen prepare records ${reason} without usable success and permits owned cleanup`, async () => {
        const fixture = await graphFixture();
        let root: string | undefined;
        try {
            const execute = async (_file: string, args: string[]) => {
                if (args[1] === "--version") return { stdout: "11.25.0\n", stderr: "" };
                if (args[1] === "config")
                    return {
                        stdout: args[3] === "registry" ? "https://registry.npmjs.org/\n" : "1440\n",
                        stderr: "",
                    };
                const state = JSON.parse(
                    await readFile(
                        join(fixture.evidence, "restricted-file-deployment.json"),
                        "utf8",
                    ),
                );
                root = state.root;
                await mkdir(state.source);
                await writeFile(join(state.source, "residue"), "partial");
                if (reason === "changed-root-input") {
                    await writeFile(
                        join(fixture.repository, "pnpm-workspace.yaml"),
                        "minimumReleaseAge: 0\n",
                    );
                    return { stdout: "", stderr: "" };
                }
                throw Object.assign(new Error(reason), {
                    code: reason === "timeout" ? "ETIMEDOUT" : 1,
                    stdout: "bounded failure",
                    stderr: "synthetic fixture failure",
                });
            };
            await assert.rejects(
                prepareFixtureDeployment(fixture.evidence, "/finite/pnpm.cjs", {
                    repository: fixture.repository,
                    temporary: "/dev/shm",
                    execute,
                }),
            );
            assert(root);
            await assert.rejects(
                lstat(join(fixture.evidence, "restricted-file-deployment-result.json")),
                { code: "ENOENT" },
            );
            await assert.rejects(
                readPreparedFixtureDeployment(fixture.evidence, "/dev/shm", fixture.repository),
                /FIXTURE_JSON_INVALID/,
            );
            assert.equal(
                JSON.parse(
                    await readFile(
                        join(fixture.evidence, "restricted-file-deployment-failure.json"),
                        "utf8",
                    ),
                ).passed,
                false,
            );
            await runStageCleanup(fixture.evidence, "/dev/shm");
            await assert.rejects(lstat(root), { code: "ENOENT" });
        } finally {
            if (root) await rm(root, { recursive: true, force: true });
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

for (const bad of ["nonce", "uid", "parent", "basename", "symlink"])
    test(`deployment cleanup refuses mismatched ${bad} and preserves external sentinel`, async () => {
        const root = await mkdtemp(join(tmpdir(), "veriq-cleanup-test-"));
        const evidence = join(root, "evidence"),
            owned = join(root, "veriq-restricted-deploy-owned"),
            sentinel = join(root, "sentinel");
        await mkdir(evidence);
        await mkdir(owned, { mode: 0o700 });
        await writeFile(sentinel, "untouched");
        await writeFile(join(owned, ".owned"), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
            mode: 0o600,
        });
        const state = {
            root: owned,
            uid: process.getuid!(),
            nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            source: join(owned, "runtime"),
        };
        if (bad === "nonce") state.nonce = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        if (bad === "uid") state.uid++;
        if (bad === "parent") state.root = dirname(root);
        if (bad === "basename") state.root = root;
        if (bad === "symlink") {
            state.root = join(root, "veriq-restricted-deploy-linked");
            await symlink(owned, state.root);
        }
        try {
            await writeFile(
                join(evidence, "restricted-file-deployment.json"),
                JSON.stringify(state),
            );
            await assert.rejects(runStageCleanup(evidence, root));
            assert.equal(await readFile(sentinel, "utf8"), "untouched");
            assert((await lstat(owned)).isDirectory());
            assert.equal(
                JSON.parse(
                    await readFile(
                        join(evidence, "restricted-file-deployment-cleanup.json"),
                        "utf8",
                    ),
                ).removed,
                false,
            );
        } finally {
            await chmod(owned, 0o700);
            await rm(root, { recursive: true, force: true });
        }
    });

test("deployment cleanup without descriptor reports that no owned deployment started", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq-no-deployment-"));
    try {
        await runStageCleanup(root, tmpdir());
        assert.deepEqual(
            JSON.parse(
                await readFile(join(root, "restricted-file-deployment-cleanup.json"), "utf8"),
            ),
            { started: false, removed: false, errors: [] },
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("business child enters a new network namespace before dropping its dedicated identity", async () => {
    let calls = 0;
    const result = await executeNetworkIsolatedFixture(
        "/owned/node",
        1234,
        1235,
        "/owned/staged",
        ["fixture.ts", "closure"],
        async (file: string, args: string[], options: any) => {
            calls++;
            assert.equal(file, "/usr/bin/timeout");
            assert.deepEqual(args, [
                "--signal=TERM",
                "--kill-after=5s",
                "45s",
                "/usr/bin/unshare",
                "--net",
                "--",
                "/usr/bin/setpriv",
                "--reuid",
                "1234",
                "--regid",
                "1235",
                "--clear-groups",
                "--no-new-privs",
                "--",
                "/owned/node",
                "--import",
                "tsx",
                "fixture.ts",
                "closure",
            ]);
            assert.deepEqual(options.env, {
                PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
                LANG: "C.UTF-8",
                TSX_DISABLE_CACHE: "1",
            });
            assert.equal(options.cwd, "/owned/staged");
            assert.equal(options.timeout, 60000);
            assert.equal(options.maxBuffer, 128 * 1024);
            return { stdout: "finite child", stderr: "" };
        },
    );
    assert.equal(calls, 1);
    assert.equal(result.stdout, "finite child");
});
test("unsupported network namespace creation fails without fallback or a second business attempt", async () => {
    let calls = 0;
    await assert.rejects(
        executeNetworkIsolatedFixture(
            "/owned/node",
            1234,
            1235,
            "/owned/staged",
            ["fixture.ts"],
            async () => {
                calls++;
                throw new Error("unshare: operation not permitted");
            },
        ),
        /operation not permitted/,
    );
    assert.equal(calls, 1);
});
