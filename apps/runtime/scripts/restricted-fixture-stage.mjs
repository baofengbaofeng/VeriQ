/** 专用账户夹具的依赖先由原 CI 账户通过官方冻结部署联网准备，再核对完整三锁生产图与实际库存；root 只消费成功证据并复制独立包树，权限调整仅作用于新副本，业务阶段通过单独网络命名空间证明离网装载和凭据文件行为。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    chmod,
    cp,
    lstat,
    readdir,
    readlink,
    realpath,
    statfs,
    mkdtemp,
    readFile,
    writeFile,
    rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, dirname, basename } from "node:path";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const contained = (root, path) => {
    const part = relative(root, path);
    return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
};
async function inspect(root, normalize = false) {
    const entries = [];
    const attributes = [];
    let bytes = 0;
    async function visit(directory) {
        const current = await lstat(directory);
        assert(current.isDirectory() && !current.isSymbolicLink(), "FIXTURE_DIRECTORY_INVALID");
        attributes.push({
            path: relative(root, directory),
            dev: current.dev,
            ino: current.ino,
            mode: current.mode,
            uid: current.uid,
        });
        if (normalize) await chmod(directory, 0o755);
        for (const name of (await readdir(directory)).sort()) {
            const path = join(directory, name),
                entry = await lstat(path),
                member = relative(root, path);
            assert(entries.length < 50000, "FIXTURE_ENTRY_LIMIT");
            if (entry.isSymbolicLink()) {
                const link = await readlink(path);
                assert(
                    !isAbsolute(link) && contained(root, await realpath(path)),
                    "FIXTURE_LINK_OUTSIDE",
                );
                entries.push({ path: member, link });
            } else if (entry.isDirectory()) {
                entries.push({ path: member, directory: true });
                await visit(path);
            } else {
                assert(entry.isFile(), "FIXTURE_FILE_TYPE_INVALID");
                bytes += entry.size;
                assert(bytes <= 1024 * 1024 * 1024, "FIXTURE_SIZE_LIMIT");
                const hash = createHash("sha256");
                for await (const chunk of createReadStream(path)) hash.update(chunk);
                const executable = !!(entry.mode & 0o111);
                attributes.push({
                    path: member,
                    dev: entry.dev,
                    ino: entry.ino,
                    mode: entry.mode,
                    uid: entry.uid,
                });
                entries.push({
                    path: member,
                    sizeBytes: entry.size,
                    sha256: hash.digest("hex"),
                    executable,
                });
                if (normalize) await chmod(path, executable ? 0o755 : 0o644);
            }
        }
    }
    await visit(root);
    return { entries, bytes, attributes };
}

/** 输入必须是 pnpm 冻结导出的完整目录，所有包链接均在该目录内；复制前后逐文件哈希相等且实际 inode 独立才返回可启动副本，并记录容量与库存摘要，原目录的权限、身份与内容都不能被副本的权限规范化影响。 */
export async function stageOwnedFixture(source, target) {
    assert(isAbsolute(source) && isAbsolute(target), "FIXTURE_ABSOLUTE_PATH_REQUIRED");
    assert.equal(await realpath(source), resolve(source), "FIXTURE_SOURCE_LINKED");
    assert(!contained(source, target) && !contained(target, source), "FIXTURE_COPY_OVERLAP");
    await assert.rejects(lstat(target), { code: "ENOENT" });
    const before = await inspect(source);
    const space = await statfs(dirname(target), { bigint: true });
    assert(
        space.bavail * space.bsize >= BigInt(before.bytes) + 8n * 1024n * 1024n,
        "FIXTURE_COPY_BUDGET",
    );
    await cp(source, target, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
    });
    const after = await inspect(target, true);
    assert.deepEqual(after.entries, before.entries, "FIXTURE_COPY_CHANGED");
    assert.equal(after.bytes, before.bytes, "FIXTURE_COPY_CHANGED");
    const copied = new Map(after.attributes.map((entry) => [entry.path, entry]));
    for (const entry of before.attributes) {
        const targetEntry = copied.get(entry.path);
        assert(
            targetEntry && (targetEntry.dev !== entry.dev || targetEntry.ino !== entry.ino),
            "FIXTURE_COPY_SHARED_INODE",
        );
    }
    assert.deepEqual(await inspect(source), before, "FIXTURE_SOURCE_CHANGED");
    return {
        files: before.entries.filter((entry) => entry.sha256).length,
        links: before.entries.filter((entry) => entry.link).length,
        bytes: before.bytes,
        availableBytes: String(space.bavail * space.bsize),
        inventorySha256: digest(JSON.stringify(before.entries)),
        inventory: before.entries,
    };
}

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const mapFields = new Set([
    "dependencies",
    "optionalDependencies",
    "devDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const empty = (value) => value === undefined || (object(value) && Object.keys(value).length === 0);
const normalize = (value) =>
    Array.isArray(value)
        ? value.map(normalize)
        : object(value)
          ? Object.fromEntries(
                Object.entries(value)
                    .filter(([key, member]) => !mapFields.has(key) || !empty(member))
                    .map(([key, member]) => [key, normalize(member)]),
            )
          : value;
const equal = (actual, expected, message) =>
    assert.deepEqual(normalize(actual), normalize(expected), message);
const sorted = (value) => [...value].sort();
const packageName = (name) =>
    typeof name === "string" && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name);
const fields = ["dependencies", "optionalDependencies"];
const workspaceNames = ["compiler", "contracts", "runner-sdk"];

/** 业务子进程先在 timeout 监督下创建新的网络命名空间，再仅对本次进程执行专用 UID 和 GID 降权；严格重建环境并关闭 tsx 缓存，避免继承 HOME 或外部模块路径，命名空间权限不足时原样失败而不回退到宿主网络。 */
export async function executeNetworkIsolatedFixture(
    node,
    uid,
    gid,
    cwd,
    args,
    execute = promisify(execFile),
) {
    assert(
        isAbsolute(node) &&
            isAbsolute(cwd) &&
            Number.isSafeInteger(uid) &&
            uid > 0 &&
            Number.isSafeInteger(gid) &&
            gid > 0 &&
            Array.isArray(args),
        "FIXTURE_CHILD_ARGUMENTS",
    );
    return execute(
        "/usr/bin/timeout",
        [
            "--signal=TERM",
            "--kill-after=5s",
            "45s",
            "/usr/bin/unshare",
            "--net",
            "--",
            "/usr/bin/setpriv",
            "--reuid",
            String(uid),
            "--regid",
            String(gid),
            "--clear-groups",
            "--no-new-privs",
            "--",
            node,
            "--import",
            "tsx",
            ...args,
        ],
        {
            cwd,
            timeout: 60000,
            maxBuffer: 128 * 1024,
            encoding: "utf8",
            env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", TSX_DISABLE_CACHE: "1" },
        },
    );
}

/** YAML 只属于原账户准备工具的开发依赖，先从 contracts 已声明的生成工具公共入口确定 require 边界，再加载其已声明的 js-yaml 公共入口；业务副本与 root 复制验证均不调用这里，缺失版本或模块立即失败而不搜索私有存储路径。 */
function yamlParser() {
    const contracts = createRequire(join(repositoryRoot, "packages/contracts/package.json"));
    assert.equal(
        contracts("./package.json").devDependencies["json-schema-to-typescript"],
        "15.0.4",
        "FIXTURE_PARSER_DECLARATION",
    );
    const generator = createRequire(contracts.resolve("json-schema-to-typescript"));
    assert.equal(generator("js-yaml/package.json").version, "4.3.2", "FIXTURE_PARSER_VERSION");
    return generator("js-yaml");
}
async function bytes(path, limit = 4 * 1024 * 1024) {
    const entry = await lstat(path);
    assert(
        entry.isFile() && !entry.isSymbolicLink() && entry.size <= limit,
        "FIXTURE_INPUT_INVALID",
    );
    const value = await readFile(path);
    assert(value.length <= limit, "FIXTURE_INPUT_LIMIT");
    return value;
}
async function document(path, yaml) {
    let value;
    try {
        value = yaml.load((await bytes(path)).toString("utf8"), { schema: yaml.JSON_SCHEMA });
    } catch (error) {
        throw new Error("FIXTURE_DOCUMENT_INVALID", { cause: error });
    }
    let count = 0;
    const seen = new Set();
    function check(member, depth) {
        assert(++count <= 100000 && depth <= 40, "FIXTURE_DOCUMENT_LIMIT");
        if (member === null || typeof member !== "object") {
            assert(
                ["string", "number", "boolean"].includes(typeof member) || member === null,
                "FIXTURE_DOCUMENT_VALUE",
            );
            if (typeof member === "string")
                assert(member.length <= 16384, "FIXTURE_DOCUMENT_STRING_LIMIT");
            return;
        }
        assert(!seen.has(member), "FIXTURE_DOCUMENT_ALIAS");
        seen.add(member);
        for (const [key, child] of Object.entries(member)) {
            assert(
                !["__proto__", "constructor", "prototype"].includes(key),
                "FIXTURE_DOCUMENT_KEY",
            );
            check(child, depth + 1);
        }
    }
    check(value, 0);
    assert(object(value), "FIXTURE_DOCUMENT_MAP");
    return value;
}
async function json(path) {
    try {
        const value = JSON.parse((await bytes(path)).toString("utf8"));
        assert(object(value));
        return value;
    } catch (error) {
        throw new Error("FIXTURE_JSON_INVALID", { cause: error });
    }
}
async function inputHashes(repository) {
    const paths = [
        "package.json",
        "pnpm-workspace.yaml",
        "pnpm-lock.yaml",
        "apps/runtime/package.json",
        ...workspaceNames.map((name) => `packages/${name}/package.json`),
    ];
    return Object.fromEntries(
        await Promise.all(
            paths.map(async (path) => [path, digest(await bytes(join(repository, path)))]),
        ),
    );
}
function manifestEdges(manifest, importer) {
    for (const field of fields) {
        const expected = Object.fromEntries(
            Object.entries(importer[field] ?? {}).map(([name, edge]) => [name, edge.specifier]),
        );
        equal(manifest[field] ?? {}, expected, "FIXTURE_MANIFEST_EDGES");
    }
}

/** 生产闭包从根 runtime 的全部必需和可选边逐项推导，registry 保留完整 peer 后缀及元数据，workspace 仅接受三个真实仓库目录；输出是有限的期望部署图，不能用版本集合、包名集合或宽松路径规范化取代任何声明与依赖边。 */
async function expectedGraph(repository, source, root) {
    assert(
        String(root.lockfileVersion) === "9.0" &&
            object(root.importers) &&
            object(root.packages) &&
            object(root.snapshots),
        "FIXTURE_ROOT_LOCK_SHAPE",
    );
    assert(
        Object.keys(root.snapshots).length <= 10000 && Object.keys(root.packages).length <= 10000,
        "FIXTURE_ROOT_GRAPH_LIMIT",
    );
    const workspaces = new Map();
    for (const name of workspaceNames) {
        const path = join(repository, "packages", name),
            manifest = await json(join(path, "package.json"));
        assert.equal(await realpath(path), path, "FIXTURE_WORKSPACE_LINKED");
        assert.equal(manifest.name, `@veriq/${name}`, "FIXTURE_WORKSPACE_NAME");
        const importer = root.importers[`packages/${name}`];
        assert(object(importer), "FIXTURE_WORKSPACE_IMPORTER");
        manifestEdges(manifest, importer);
        workspaces.set(manifest.name, {
            path,
            manifest,
            importer,
            id: `${manifest.name}@${pathToFileURL(path).href}`,
        });
    }
    const packages = {},
        snapshots = {},
        identities = new Map();
    const reference = (name, version, owner) => {
        assert(packageName(name) && typeof version === "string", "FIXTURE_REFERENCE_INVALID");
        if (version.startsWith("link:")) {
            const workspace = workspaces.get(name);
            assert(
                workspace && resolve(repository, owner, version.slice(5)) === workspace.path,
                "FIXTURE_WORKSPACE_REFERENCE",
            );
            return workspace.id;
        }
        assert(
            !workspaces.has(name) && /^[0-9][^\s/:]*$/.test(version),
            "FIXTURE_REGISTRY_REFERENCE",
        );
        return `${name}@${version}`;
    };
    const importerEdges = (importer, owner, specifiers) =>
        Object.fromEntries(
            fields.map((field) => [
                field,
                Object.fromEntries(
                    Object.entries(importer[field] ?? {}).map(([name, edge]) => {
                        assert(
                            object(edge) && typeof edge.specifier === "string",
                            "FIXTURE_IMPORTER_EDGE",
                        );
                        const id = reference(name, edge.version, owner);
                        return [
                            name,
                            specifiers
                                ? {
                                      ...edge,
                                      specifier: workspaces.has(name) ? id : edge.specifier,
                                      version: workspaces.has(name) ? id : edge.version,
                                  }
                                : workspaces.has(name)
                                  ? id
                                  : edge.version,
                        ];
                    }),
                ),
            ]),
        );
    const runtime = root.importers["apps/runtime"];
    assert(object(runtime), "FIXTURE_RUNTIME_IMPORTER");
    const runtimeManifest = await json(join(repository, "apps/runtime/package.json"));
    assert.equal(runtimeManifest.name, "@veriq/runtime", "FIXTURE_RUNTIME_NAME");
    manifestEdges(runtimeManifest, runtime);
    const importer = importerEdges(runtime, "apps/runtime", true);
    const visit = (id) => {
        if (Object.hasOwn(snapshots, id)) return;
        assert(Object.keys(snapshots).length < 1024, "FIXTURE_PRODUCTION_GRAPH_LIMIT");
        const workspace = [...workspaces.values()].find((entry) => entry.id === id);
        if (workspace) {
            packages[id] = {
                resolution: { directory: relative(source, workspace.path), type: "directory" },
            };
            snapshots[id] = importerEdges(
                workspace.importer,
                `packages/${workspace.manifest.name.split("/")[1]}`,
                false,
            );
            identities.set(id, {
                name: workspace.manifest.name,
                version: workspace.manifest.version,
            });
        } else {
            assert(Object.hasOwn(root.snapshots, id), "FIXTURE_ROOT_SNAPSHOT_MISSING");
            const base = id.split("(", 1)[0],
                metadata = root.packages[base],
                split = base.lastIndexOf("@");
            assert(
                object(metadata) && typeof metadata.resolution?.integrity === "string" && split > 0,
                "FIXTURE_REGISTRY_METADATA",
            );
            const name = base.slice(0, split),
                version = base.slice(split + 1);
            assert(packageName(name) && /^[0-9][^\s/:]*$/.test(version), "FIXTURE_REGISTRY_ID");
            packages[base] = metadata;
            snapshots[id] = root.snapshots[id];
            identities.set(id, { name, version });
        }
        for (const field of fields)
            for (const [name, version] of Object.entries(snapshots[id][field] ?? {})) {
                const next = [...workspaces.values()].find(
                    (entry) => entry.id === version && entry.manifest.name === name,
                );
                visit(next ? next.id : reference(name, version, ""));
            }
    };
    for (const field of fields)
        for (const [name, edge] of Object.entries(importer[field]))
            visit(
                workspaces.has(name) ? edge.version : reference(name, edge.version, "apps/runtime"),
            );
    return { packages, snapshots, importer, workspaces, identities, runtimeManifest };
}
function verifyLock(actual, expected, root) {
    assert(String(actual.lockfileVersion) === "9.0", "FIXTURE_LOCK_VERSION");
    equal(actual.settings, root.settings, "FIXTURE_LOCK_SETTINGS");
    equal(actual.importers, { ".": expected.importer }, "FIXTURE_LOCK_IMPORTERS");
    equal(actual.packages, expected.packages, "FIXTURE_LOCK_PACKAGES");
    equal(actual.snapshots, expected.snapshots, "FIXTURE_LOCK_SNAPSHOTS");
}
function compatible(values, actual) {
    if (values === undefined) return true;
    assert(
        Array.isArray(values) && values.every((value) => typeof value === "string"),
        "FIXTURE_PLATFORM_CONDITION",
    );
    return (
        !values.includes(`!${actual}`) &&
        (!values.some((value) => !value.startsWith("!")) ||
            values.includes(actual) ||
            values.includes("any"))
    );
}

/** 安装库存同时核对实际目录、manifest 身份和每条依赖链接，不能仅相信 current 锁中的声明；可选缺包必须由锁的操作系统或架构条件与 modules 的 skipped 双重解释，所有实际包根目录都须属于刚才走过的生产图，额外开发包会被拒绝。 */
async function installedGraph(source, expected, modules, inventory) {
    assert.equal(modules.packageManager, "pnpm@11.25.0", "FIXTURE_MODULES_MANAGER");
    assert.equal(modules.nodeLinker, "isolated", "FIXTURE_MODULES_LINKER");
    assert.equal(modules.virtualStoreDir, ".pnpm", "FIXTURE_MODULES_STORE");
    equal(
        modules.included,
        { dependencies: true, devDependencies: false, optionalDependencies: true },
        "FIXTURE_MODULES_INCLUDED",
    );
    assert(empty(modules.hoistedDependencies), "FIXTURE_MODULES_HOIST");
    assert(
        Array.isArray(modules.skipped) &&
            modules.skipped.length <= 1024 &&
            new Set(modules.skipped).size === modules.skipped.length,
        "FIXTURE_MODULES_SKIPPED",
    );
    const declaredSkipped = new Set(modules.skipped),
        skipped = new Set(),
        installed = new Map(),
        pathIds = new Map();
    const resolvePackage = async (consumer, name) => {
        let directory = consumer;
        while (contained(source, directory)) {
            const candidate = join(directory, "node_modules", name);
            try {
                return await realpath(candidate);
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
            if (directory === source) break;
            directory = dirname(directory);
        }
        return undefined;
    };
    const visit = async (consumer, name, id, optional) => {
        const identity = expected.identities.get(id);
        assert(identity && identity.name === name, "FIXTURE_INSTALL_REFERENCE");
        const path = await resolvePackage(consumer, name);
        if (!path) {
            const metadata = expected.packages[id.split("(", 1)[0]];
            assert(
                optional &&
                    declaredSkipped.has(id) &&
                    metadata &&
                    (!compatible(metadata.os, process.platform) ||
                        !compatible(metadata.cpu, process.arch)),
                "FIXTURE_REQUIRED_PACKAGE_MISSING",
            );
            skipped.add(id);
            return;
        }
        assert(contained(source, path), "FIXTURE_INSTALL_OUTSIDE");
        assert(!declaredSkipped.has(id), "FIXTURE_INSTALLED_MARKED_SKIPPED");
        const manifest = await json(join(path, "package.json"));
        assert.equal(manifest.name, identity.name, "FIXTURE_INSTALLED_NAME");
        assert.equal(manifest.version, identity.version, "FIXTURE_INSTALLED_VERSION");
        if (installed.has(id)) {
            assert.equal(installed.get(id), path, "FIXTURE_SNAPSHOT_DUPLICATED");
            return;
        }
        assert(!pathIds.has(path) || pathIds.get(path) === id, "FIXTURE_PEER_PATH_COLLISION");
        installed.set(id, path);
        pathIds.set(path, id);
        for (const field of fields)
            for (const [child, version] of Object.entries(expected.snapshots[id][field] ?? {})) {
                const next = expected.identities.has(version) ? version : `${child}@${version}`;
                await visit(path, child, next, field === "optionalDependencies");
            }
    };
    for (const field of fields)
        for (const [name, edge] of Object.entries(expected.importer[field] ?? {}))
            await visit(
                source,
                name,
                expected.identities.has(edge.version) ? edge.version : `${name}@${edge.version}`,
                field === "optionalDependencies",
            );
    equal(sorted(skipped), sorted(declaredSkipped), "FIXTURE_SKIPPED_UNEXPLAINED");
    equal(
        sorted([...installed.keys(), ...skipped]),
        sorted(Object.keys(expected.snapshots)),
        "FIXTURE_INSTALL_GRAPH_INCOMPLETE",
    );
    for (const entry of inventory.entries) {
        const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/.][^/]*)\/package\.json$/.exec(
            entry.path,
        );
        if (match && entry.sha256)
            assert(
                pathIds.has(join(source, dirname(entry.path))),
                "FIXTURE_EXTRA_INSTALLED_PACKAGE",
            );
    }
    return {
        packages: [...installed]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, path]) => ({ id, path: relative(source, path) })),
        skipped: sorted(skipped),
        platform: process.platform,
        arch: process.arch,
    };
}
function inventoryProof(inventory) {
    return {
        files: inventory.entries.filter((entry) => entry.sha256).length,
        links: inventory.entries.filter((entry) => entry.link).length,
        bytes: inventory.bytes,
        inventorySha256: digest(JSON.stringify(inventory.entries)),
        inventory: inventory.entries,
    };
}

/** 原账户准备完成后必须同时证明根锁、派生锁和实际 current 锁的完整生产图，并检查可选平台跳过与实际链接库存；此公开工具只读取有限文件，返回可持久化的哈希与精确图证据，任何不匹配都不生成可供专用账户使用的成功结果。 */
export async function verifyFrozenFixtureDeployment(repository, source) {
    assert(isAbsolute(repository) && isAbsolute(source), "FIXTURE_ABSOLUTE_PATH_REQUIRED");
    assert.equal(await realpath(repository), repository, "FIXTURE_REPOSITORY_LINKED");
    assert.equal(await realpath(source), source, "FIXTURE_SOURCE_LINKED");
    const yaml = yamlParser(),
        lock = join(repository, "pnpm-lock.yaml"),
        derivedPath = join(source, "pnpm-lock.yaml"),
        currentPath = join(source, "node_modules/.pnpm/lock.yaml");
    const root = await document(lock, yaml),
        derived = await document(derivedPath, yaml),
        current = await document(currentPath, yaml);
    const expected = await expectedGraph(repository, source, root);
    verifyLock(derived, expected, root);
    verifyLock(current, expected, root);
    const manifest = await json(join(source, "package.json"));
    assert.equal(manifest.name, expected.runtimeManifest.name, "FIXTURE_DEPLOYED_NAME");
    assert.equal(manifest.version, expected.runtimeManifest.version, "FIXTURE_DEPLOYED_VERSION");
    assert(empty(manifest.devDependencies), "FIXTURE_DEPLOYED_DEV_DEPENDENCIES");
    manifestEdges(manifest, expected.importer);
    const inventory = await inspect(source);
    const installed = await installedGraph(
        source,
        expected,
        await document(join(source, "node_modules/.modules.yaml"), yaml),
        inventory,
    );
    return {
        hashes: {
            rootLockSha256: digest(await bytes(lock)),
            derivedLockSha256: digest(await bytes(derivedPath)),
            currentLockSha256: digest(await bytes(currentPath)),
            manifestSha256: digest(await bytes(join(source, "package.json"))),
        },
        inputs: await inputHashes(repository),
        graph: {
            registryPackages: Object.keys(expected.packages).length - expected.workspaces.size,
            registrySnapshots: Object.keys(expected.snapshots).length - expected.workspaces.size,
            workspaceSnapshots: expected.workspaces.size,
            reachableSnapshots: Object.keys(expected.snapshots).length,
            packages: expected.packages,
            snapshots: expected.snapshots,
            importer: expected.importer,
        },
        installed,
        inventory: inventoryProof(inventory),
    };
}
async function save(evidence, name, value) {
    await writeFile(join(evidence, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
async function ownedState(state, temporary, uid) {
    assert(
        isAbsolute(temporary) && (await realpath(temporary)) === temporary,
        "FIXTURE_TEMPORARY_INVALID",
    );
    assert(
        object(state) &&
            isAbsolute(state.root) &&
            dirname(state.root) === temporary &&
            /^veriq-restricted-deploy-[A-Za-z0-9]+$/.test(basename(state.root)),
        "FIXTURE_DEPLOY_ROOT_INVALID",
    );
    assert.equal(state.source, join(state.root, "runtime"), "FIXTURE_DEPLOY_SOURCE_INVALID");
    assert(
        Number.isSafeInteger(state.uid) && state.uid > 0 && state.uid === uid,
        "FIXTURE_DEPLOY_UID_INVALID",
    );
    assert(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(state.nonce),
        "FIXTURE_DEPLOY_NONCE_INVALID",
    );
    const root = await lstat(state.root);
    assert(
        root.isDirectory() &&
            !root.isSymbolicLink() &&
            root.uid === uid &&
            (root.mode & 0o777) === 0o700,
        "FIXTURE_DEPLOY_ROOT_UNOWNED",
    );
    assert.equal(await realpath(state.root), state.root, "FIXTURE_DEPLOY_ROOT_LINKED");
    const marker = await lstat(join(state.root, ".owned"));
    assert(
        marker.isFile() &&
            !marker.isSymbolicLink() &&
            marker.uid === uid &&
            (marker.mode & 0o777) === 0o600,
        "FIXTURE_DEPLOY_MARKER_INVALID",
    );
    assert.equal(
        (await bytes(join(state.root, ".owned"), 128)).toString("utf8"),
        state.nonce,
        "FIXTURE_DEPLOY_MARKER_MISMATCH",
    );
}

/** root 只能消费带独立成功结果的部署描述，必须再次匹配原账户 UID、随机拥有标记、精确源路径及所有文件库存哈希；这个读取接口不加载开发 YAML 工具，缺结果、错误身份或失败后残树均在复制前关闭，避免把准备意图误认成可启动证据。 */
export async function readPreparedFixtureDeployment(
    evidence,
    temporary,
    repository = repositoryRoot,
) {
    const state = await json(join(evidence, "restricted-file-deployment.json"));
    await ownedState(state, temporary, state.uid);
    const result = await json(join(evidence, "restricted-file-deployment-result.json"));
    assert(
        result.passed === true &&
            result.nonce === state.nonce &&
            result.root === state.root &&
            result.source === state.source &&
            result.uid === state.uid,
        "FIXTURE_DEPLOY_RESULT_UNBOUND",
    );
    assert.equal(await realpath(state.source), state.source, "FIXTURE_DEPLOY_SOURCE_LINKED");
    equal(
        inventoryProof(await inspect(state.source)),
        result.verification?.inventory,
        "FIXTURE_DEPLOY_INVENTORY_CHANGED",
    );
    equal(
        await inputHashes(repository),
        result.verification?.inputs,
        "FIXTURE_DEPLOY_INPUTS_CHANGED",
    );
    return { ...state, result };
}

/** 联网准备只运行固定版本的官方非 legacy frozen 部署，并先保存独占目录和拥有标记以支持失败后的 always 清理；执行器缝只供有限小仓库验证参数与失败路径，生产默认始终使用受超时及输出上限约束的真实 Node 子进程，成功证据最后才落盘。 */
export async function prepareFixtureDeployment(
    evidence,
    pnpm,
    {
        repository = repositoryRoot,
        temporary = process.env.RUNNER_TEMP,
        execute = promisify(execFile),
    } = {},
) {
    assert.equal(process.platform, "linux");
    assert(
        process.getuid() > 0 && isAbsolute(evidence) && isAbsolute(pnpm),
        "FIXTURE_PREPARE_ARGUMENTS",
    );
    temporary = await realpath(temporary);
    const descriptor = join(evidence, "restricted-file-deployment.json"),
        resultPath = join(evidence, "restricted-file-deployment-result.json");
    await assert.rejects(lstat(descriptor), { code: "ENOENT" });
    await assert.rejects(lstat(resultPath), { code: "ENOENT" });
    const root = await mkdtemp(join(temporary, "veriq-restricted-deploy-"));
    await chmod(root, 0o700);
    const state = {
        root,
        nonce: randomUUID(),
        uid: process.getuid(),
        source: join(root, "runtime"),
    };
    await writeFile(join(root, ".owned"), state.nonce, { mode: 0o600, flag: "wx" });
    await save(evidence, "restricted-file-deployment.json", state);
    try {
        const available = await statfs(root, { bigint: true }),
            availableBytes = available.bavail * available.bsize;
        assert(availableBytes >= 2n * 1024n * 1024n * 1024n, "FIXTURE_DEPLOY_BUDGET");
        const before = await inputHashes(repository);
        const version = await execute(process.execPath, [pnpm, "--version"], {
            cwd: repository,
            timeout: 10000,
            maxBuffer: 1024 * 1024,
            encoding: "utf8",
        });
        assert.equal(version.stdout.trim(), "11.25.0", "FIXTURE_PNPM_VERSION");
        const args = [
            pnpm,
            "--filter",
            "@veriq/runtime",
            "--config.inject-workspace-packages=true",
            "deploy",
            "--frozen-lockfile",
            "--prod",
            "--ignore-scripts",
            "--package-import-method=copy",
            "--hoist=false",
            state.source,
        ];
        const config = await document(join(repository, "pnpm-workspace.yaml"), yamlParser());
        assert.equal(config.minimumReleaseAge, 1440, "FIXTURE_RELEASE_AGE_POLICY");
        /** 工作区文件哈希只能证明声明未改，不能排除原账户环境或 npmrc 覆盖，因此通过同一 pnpm 的公开 config get 分别读取实际 registry 与 age；每个查询独立限制时长和输出，拒绝任何偏离既定政策的值，绝不转储其它配置或凭据。 */
        const effective = {};
        for (const key of ["registry", "minimumReleaseAge"]) {
            const value = await execute(process.execPath, [pnpm, "config", "get", key], {
                cwd: repository,
                timeout: 10000,
                maxBuffer: 16384,
                encoding: "utf8",
            });
            effective[key] = value.stdout.trim();
        }
        assert(
            effective.registry === "https://registry.npmjs.org/" &&
                effective.minimumReleaseAge === "1440",
            "FIXTURE_EFFECTIVE_POLICY",
        );
        const output = await execute(process.execPath, args, {
            cwd: repository,
            timeout: 120000,
            maxBuffer: 1024 * 1024,
            encoding: "utf8",
        });
        equal(await inputHashes(repository), before, "FIXTURE_INPUTS_CHANGED");
        const verification = await verifyFrozenFixtureDeployment(repository, state.source);
        equal(verification.inputs, before, "FIXTURE_VERIFICATION_INPUTS_CHANGED");
        const result = {
            ...state,
            passed: true,
            availableBytes: String(availableBytes),
            requiredAvailableBytes: String(2n * 1024n * 1024n * 1024n),
            pnpmVersion: version.stdout.trim(),
            sourceCommit: process.env.GITHUB_SHA ?? null,
            command: {
                file: process.execPath,
                args,
                cwd: repository,
                timeout: 120000,
                maxBuffer: 1024 * 1024,
            },
            policy: {
                minimumReleaseAge: Number(effective.minimumReleaseAge),
                registry: effective.registry,
                network: "original CI account; online preparation",
            },
            verification,
            stdout: output.stdout,
            stderr: output.stderr,
        };
        await save(evidence, "restricted-file-deployment-result.json", result);
        return result;
    } catch (error) {
        await save(evidence, "restricted-file-deployment-failure.json", {
            ...state,
            passed: false,
            name: error?.name,
            code: error?.code,
            message: String(error?.message ?? "UNKNOWN_ERROR").slice(0, 2048),
            stdout: String(error?.stdout ?? "").slice(0, 16384),
            stderr: String(error?.stderr ?? "").slice(0, 16384),
        });
        throw error;
    }
}

/** 部署目录清理只依赖先行写入的创建意图，严格核对临时父目录、随机 basename、原账户 UID 和 marker 后才递归删除；没有 descriptor 时明确记录未开始，任何身份或路径异常都保留现场并返回失败，绝不靠强制清理把失败残树变成成功证据。 */
async function cleanupDeployment(evidence) {
    const temporary = await realpath(process.env.RUNNER_TEMP);
    let state;
    try {
        state = await json(join(evidence, "restricted-file-deployment.json"));
    } catch (error) {
        if (error.cause?.code !== "ENOENT") throw error;
        await save(evidence, "restricted-file-deployment-cleanup.json", {
            started: false,
            removed: false,
            errors: [],
        });
        return;
    }
    const errors = [];
    let removed = false;
    try {
        await ownedState(state, temporary, process.getuid());
        await rm(state.root, { recursive: true });
        await assert.rejects(lstat(state.root), { code: "ENOENT" });
        removed = true;
    } catch (error) {
        errors.push(String(error.message).slice(0, 2048));
    }
    await save(evidence, "restricted-file-deployment-cleanup.json", {
        started: true,
        removed,
        errors,
    });
    assert.deepEqual(errors, [], "FIXTURE_DEPLOY_CLEANUP_FAILED");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [mode, evidence, pnpm] = process.argv.slice(2);
    assert(
        ["prepare", "cleanup"].includes(mode) && isAbsolute(evidence),
        "FIXTURE_STAGE_ARGUMENTS",
    );
    if (mode === "prepare") await prepareFixtureDeployment(evidence, pnpm);
    else await cleanupDeployment(evidence);
}
