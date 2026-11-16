import { createRequire } from "node:module";
import { lstat, realpath } from "node:fs/promises";
import { join, posix, relative as relativePath } from "node:path";
import { DependencyFiles, unsupportedDependency } from "./runtime-dependency-files.ts";
import { decode, fail, limits, relative } from "./runtime-payload-tree.ts";
import type { Edge, PackageInstance, SourceBindingV1 } from "./runtime-payload-inputs.ts";
import type { GeneratedWorkspacePackage } from "./runtime-workspace-packages.ts";

/**
 * 物理布局记录直接复用现有 CI 观察器输出，包实例与文件归属保持原始安装路径而非包名；仅在本次已完成离线冻结安装后读取这
 * 些记录，不能把外部提供的 JSON 记录当作已观察的本地布局。
 */
export type LayoutRecord = {
    kind: string;
    path: string;
    owner?: string | null;
    name?: string;
    version?: string;
    bytes?: number;
    sha256?: string;
    mode?: number;
    target?: string;
};
/**
 * 每个闭包节点同时保存安装物理根、最终根、实际原清单和生成包选择，嵌套 peer 实例不按名称合并；后续复制只能读取该节点的
 * 自有文件，node_modules 子树归属由独立物理实例承担。
 */
export type ClosurePackage = {
    id: string;
    physicalRoot: string;
    root: string;
    manifest: Record<string, unknown>;
    instance: Omit<PackageInstance, "packageJson" | "ownTreeSha256">;
    generated: GeneratedWorkspacePackage | null;
};
/**
 * 声明边与来源消费者维持原包正文语义，optional 覆盖 dependency 而 peerMeta 决定可缺失 peer；重复 alias 的两种声明分别保
 * 留，最终解析证据仍按实际消费者和 specifier 唯一化。
 */
export type ClosureDeclaration = { alias: string; requested: string; kind: Edge["kind"] };

/**
 * 包依赖字段必须为非空字符串映射且不能夹带路径 specifier，普通依赖不会被缺失的 optional 声明代替；此读取结果稍后仍由已
 * 有 verifyPackageContents 针对输出清单逐条交叉核验。
 */
export function dependencyDeclarations(manifest: Record<string, unknown>): ClosureDeclaration[] {
    const read = (key: string) => {
        if (manifest[key] === undefined) return {} as Record<string, string>;
        const value = manifest[key];
        if (!value || typeof value !== "object" || Array.isArray(value))
            fail("PAYLOAD_GRAPH_MISMATCH");
        for (const [alias, requested] of Object.entries(value)) {
            relative(alias);
            if (
                alias.startsWith(".") ||
                typeof requested !== "string" ||
                !requested ||
                Buffer.byteLength(requested) > 2048
            )
                fail("PAYLOAD_GRAPH_MISMATCH");
        }
        return value as Record<string, string>;
    };
    const dependencies = read("dependencies"),
        optional = read("optionalDependencies"),
        peers = read("peerDependencies");
    const meta = manifest.peerDependenciesMeta;
    if (meta !== undefined && (!meta || typeof meta !== "object" || Array.isArray(meta)))
        fail("PAYLOAD_GRAPH_MISMATCH");
    return [
        ...Object.entries({ ...dependencies, ...optional }).map(([alias, requested]) => ({
            alias,
            requested,
            kind: Object.hasOwn(optional, alias) ? ("optional" as const) : ("dependency" as const),
        })),
        ...Object.entries(peers).map(([alias, requested]) => {
            const entry = (meta as Record<string, unknown> | undefined)?.[alias];
            if (
                entry !== undefined &&
                (!entry ||
                    typeof entry !== "object" ||
                    Array.isArray(entry) ||
                    ("optional" in entry && typeof entry.optional !== "boolean"))
            )
                fail("PAYLOAD_GRAPH_MISMATCH");
            return {
                alias,
                requested,
                kind:
                    entry &&
                    typeof entry === "object" &&
                    "optional" in entry &&
                    entry.optional === true
                        ? ("optional-peer" as const)
                        : ("peer" as const),
            };
        }),
    ];
}

/**
 * 固定 pnpm 锁的两级块只提取真实原始 snapshot 键和包平台字段，不实现 YAML 或 exports 的通用解释器；仅接受当前锁生成器的
 * 缩进和标量形式，新的复杂语法立即拒绝而不是猜测或制造同名匹配。
 */
export function lockSections(bytes: Buffer) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const sections = new Map<string, Map<string, string>>();
    let section = "",
        key = "";
    for (const line of text.split("\n")) {
        const top = /^([A-Za-z][A-Za-z0-9]*):\s*$/.exec(line);
        if (top) {
            section = top[1]!;
            sections.set(section, new Map());
            key = "";
            continue;
        }
        if (!["packages", "snapshots"].includes(section)) continue;
        const member = /^ {4}(\S.*?):(?:\s*\{\})?\s*$/.exec(line);
        if (member) {
            const raw = member[1]!;
            key = raw.startsWith('"')
                ? JSON.parse(raw)
                : raw.startsWith("'")
                  ? raw.slice(1, -1).replaceAll("''", "'")
                  : raw;
            if (
                typeof key !== "string" ||
                Buffer.byteLength(key) > 2048 ||
                sections.get(section)!.has(key)
            )
                fail("PAYLOAD_GRAPH_MISMATCH");
            sections.get(section)!.set(key, "");
        } else if (key)
            sections.get(section)!.set(key, sections.get(section)!.get(key)! + line + "\n");
    }
    if (!sections.has("packages") || !sections.has("snapshots")) fail("PAYLOAD_GRAPH_MISMATCH");
    return { text, packages: sections.get("packages")!, snapshots: sections.get("snapshots")! };
}

/**
 * 缺失 optional 必须由同一锁中的精确名称版本以及明确不适用的 os 或 cpu 证明，磁盘未安装本身不足以声称目标排除；无法解析
 * 的范围、别名或新平台元数据形式保持失败，optional peer 则由真实查找缺失单独证
 * 明。
 */
export function targetExcluded(
    lock: ReturnType<typeof lockSections>,
    alias: string,
    requested: string,
    arch: string,
) {
    const key = `${alias}@${requested}`,
        body = lock.packages.get(key);
    if (!body) fail("PAYLOAD_GRAPH_MISMATCH");
    const fields: Record<string, string[]> = {};
    for (const name of ["os", "cpu"]) {
        const row = new RegExp(`^ {8}${name}: \\[([^\\]]*)\\]\\s*$`, "m").exec(body);
        if (row) {
            fields[name] = row[1]!
                .split(",")
                .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
                .filter(Boolean);
            if (fields[name]!.some((item) => !/^!?[a-z0-9_-]+$/i.test(item)))
                fail("PAYLOAD_GRAPH_MISMATCH");
        } else if (new RegExp(`^ {8}${name}:`, "m").test(body)) fail("PAYLOAD_GRAPH_MISMATCH");
    }
    const excluded = (values: string[] | undefined, target: string) =>
        values &&
        (values.includes("!any") ||
            values.includes(`!${target}`) ||
            (values.some((item) => !item.startsWith("!")) &&
                !values.includes("any") &&
                !values.includes(target)));
    if (!excluded(fields.os, "darwin") && !excluded(fields.cpu, arch))
        fail("PAYLOAD_GRAPH_MISMATCH");
    return { lockKey: key, rawPackageMetadata: body, target: { platform: "darwin", arch }, fields };
}

/**
 * 最终根保留已支持的 hoisted 物理嵌套关系，工作区普通目录转换为明确包根而不保留目录链接；如果不同安装域会映射到同一个最
 * 终路径，调用方必须拒绝该布局，不能悄悄去重或把另一个 peer 实例覆盖掉。
 */
function outputRoot(physical: string, generated: GeneratedWorkspacePackage | null) {
    if (generated) return `node_modules/${generated.name}`;
    if (physical.startsWith("node_modules/")) return physical;
    if (physical.startsWith("apps/runtime/node_modules/"))
        return physical.slice("apps/runtime/".length);
    for (const name of ["contracts", "runner-sdk"])
        if (physical.startsWith(`packages/${name}/node_modules/`))
            return `node_modules/@veriq/${name}/${physical.slice(`packages/${name}/`.length)}`;
    fail("PAYLOAD_GRAPH_MISMATCH");
}

/**
 * 实例发现使用 Node 提供的真实包查找路径和物理清单，不解析 exports 推测安装归属；工作区链接仅可指向已绑定的原始工作区根
 * ，最终输出复制真实生成包，任何其它目录链接或越界端点均拒绝。
 */
export async function collectRuntimeDependencyClosure(
    options: Readonly<{
        installation: string;
        source: SourceBindingV1;
        records: readonly LayoutRecord[];
        generated: readonly GeneratedWorkspacePackage[];
        roots: readonly { consumer: string; specifier: string }[];
        files: DependencyFiles;
        lock: ReturnType<typeof lockSections>;
        arch: string;
    }>,
) {
    const { installation, records, generated, files, lock, arch } = options;
    const observed = new Map(
        records
            .filter((record) => record.kind === "package")
            .map((record) => [record.path, record]),
    );
    const packages: ClosurePackage[] = [],
        byPhysical = new Map<string, ClosurePackage>(),
        byOutput = new Map<string, string>();
    const discover = async (alias: string, from: string): Promise<ClosurePackage | null> => {
        const lookup = createRequire(join(installation, from, "package.json")).resolve.paths(alias);
        if (!lookup) fail("PAYLOAD_GRAPH_MISMATCH");
        for (const base of lookup) {
            const candidate = join(base, alias);
            if (!candidate.startsWith(installation + "/")) continue;
            let info;
            try {
                info = await lstat(candidate);
            } catch (error) {
                if (
                    (error as NodeJS.ErrnoException).code === "ENOENT" ||
                    (error as NodeJS.ErrnoException).code === "ENOTDIR"
                )
                    continue;
                throw error;
            }
            const physical = relativePath(installation, await realpath(candidate)).replaceAll(
                "\\",
                "/",
            );
            relative(physical);
            const workspace = generated.find((item) => item.sourceRoot === physical) ?? null;
            if (
                (info.isSymbolicLink() && !workspace) ||
                (!info.isDirectory() && !info.isSymbolicLink()) ||
                !observed.has(physical)
            )
                fail("PAYLOAD_GRAPH_MISMATCH");
            const prior = byPhysical.get(physical);
            if (prior) return prior;
            if (packages.length >= limits.instances) fail("PAYLOAD_LIMIT");
            const manifest = decode(
                await files.read(join(installation, physical, "package.json"), limits.package),
            ) as Record<string, unknown>;
            if (
                !manifest ||
                typeof manifest !== "object" ||
                typeof manifest.name !== "string" ||
                typeof manifest.version !== "string"
            )
                fail("PAYLOAD_GRAPH_MISMATCH");
            const root = outputRoot(physical, workspace),
                collision = byOutput.get(root);
            if (collision && collision !== physical)
                unsupportedDependency("DEPENDENCY_INSTALL_SCOPE_COLLISION");
            byOutput.set(root, physical);
            let snapshot: string;
            if (workspace) {
                snapshot = `link:${posix.relative("apps/runtime", workspace.sourceRoot)}`;
                if (!lock.text.includes(`version: ${snapshot}`)) fail("PAYLOAD_GRAPH_MISMATCH");
            } else {
                const baseKey = `${manifest.name}@${manifest.version}`;
                let candidates = [...lock.snapshots.keys()].filter(
                    (key) => key === baseKey || key.startsWith(baseKey + "("),
                );
                // 多 peer snapshot 以每个真实已安装 peer 的版本消歧，括号文本只作为锁的精确键比较；无法唯一选择时明确失
                // 败，不按名称或第一个候选伪造上下文身份。
                if (candidates.length > 1) {
                    const peers = dependencyDeclarations(manifest).filter(
                        (item) => item.kind === "peer" || item.kind === "optional-peer",
                    );
                    for (const peer of peers) {
                        const paths =
                            createRequire(
                                join(installation, physical, "package.json"),
                            ).resolve.paths(peer.alias) ?? [];
                        let peerVersion: string | null = null;
                        for (const peerBase of paths) {
                            if (!peerBase.startsWith(installation + "/")) continue;
                            try {
                                const resolvedPeer = await realpath(join(peerBase, peer.alias));
                                if (!resolvedPeer.startsWith(installation + "/"))
                                    fail("PAYLOAD_PATH");
                                const body = decode(
                                    await files.read(
                                        join(resolvedPeer, "package.json"),
                                        limits.package,
                                    ),
                                ) as Record<string, unknown>;
                                peerVersion =
                                    typeof body.version === "string" ? body.version : null;
                                break;
                            } catch (error) {
                                if (
                                    (error as NodeJS.ErrnoException).code !== "ENOENT" &&
                                    (error as NodeJS.ErrnoException).code !== "ENOTDIR"
                                )
                                    throw error;
                            }
                        }
                        if (peerVersion)
                            candidates = candidates.filter(
                                (key) =>
                                    key.includes(`(${peer.alias}@${peerVersion})`) ||
                                    key.includes(`(${peer.alias}@${peerVersion}(`),
                            );
                    }
                }
                if (candidates.length !== 1) unsupportedDependency("DEPENDENCY_SNAPSHOT_AMBIGUOUS");
                snapshot = candidates[0]!;
            }
            const id = `p${packages.length + 1}`;
            const item: ClosurePackage = {
                id,
                physicalRoot: physical,
                root,
                manifest,
                generated: workspace,
                instance: {
                    id,
                    root,
                    name: manifest.name,
                    version: manifest.version,
                    lockSnapshot: snapshot,
                },
            };
            packages.push(item);
            byPhysical.set(physical, item);
            return item;
        }
        return null;
    };
    const rootBindings: { consumer: string; specifier: string; to: string }[] = [];
    for (const root of options.roots) {
        const pkg = await discover(packageAlias(root.specifier), "apps/runtime");
        if (!pkg) fail("PAYLOAD_GRAPH_MISMATCH");
        rootBindings.push({ ...root, to: pkg.id });
    }
    const edges: Edge[] = [],
        decisions: {
            from: string;
            alias: string;
            action: "include" | "exclude-target" | "absent-optional-peer";
            detail: unknown;
        }[] = [];
    for (let index = 0; index < packages.length; index++) {
        const pkg = packages[index]!;
        for (const declaration of dependencyDeclarations(pkg.manifest)) {
            if (edges.length >= limits.edges) fail("PAYLOAD_LIMIT");
            const target = await discover(declaration.alias, pkg.physicalRoot);
            if (!target && declaration.kind !== "optional" && declaration.kind !== "optional-peer")
                fail("PAYLOAD_GRAPH_MISMATCH");
            const absence = target
                ? null
                : declaration.kind === "optional"
                  ? "TARGET_NOT_APPLICABLE"
                  : "OPTIONAL_PEER_ABSENT";
            edges.push({ ...declaration, from: pkg.id, to: target?.id ?? null, absence });
            if (declaration.kind === "optional" || declaration.kind === "optional-peer")
                decisions.push({
                    from: pkg.id,
                    alias: declaration.alias,
                    action: target
                        ? "include"
                        : declaration.kind === "optional"
                          ? "exclude-target"
                          : "absent-optional-peer",
                    detail: target
                        ? { physicalRoot: target.physicalRoot }
                        : declaration.kind === "optional"
                          ? targetExcluded(lock, declaration.alias, declaration.requested, arch)
                          : {
                                physicalRoot: pkg.physicalRoot,
                                lookup: "ABSENT_IN_PHYSICAL_INSTALL",
                            },
                });
        }
    }
    return { packages, rootBindings, edges, decisions };
}

/**
 * 根导入允许合法包子路径并提取安装 alias，整个原 specifier 仍保留给目标 Node 解析；这里不重写子路径、条件导出或 npm
 * alias，真实目标包身份稍后从物理清单与解析所有权再次确认。
 */
export function packageAlias(specifier: string) {
    relative(specifier);
    const parts = specifier.split("/");
    return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}
