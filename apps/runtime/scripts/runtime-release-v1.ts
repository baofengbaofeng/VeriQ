import { join, isAbsolute } from "node:path";
import { mkdir, mkdtemp, lstat, realpath, readFile, chmod } from "node:fs/promises";
import { canonicalBytes, validateSchema } from "@veriq/contracts";
import { isIndependentNode24 } from "../src/node-version.ts";
import type { FileFact, Ref, SourceBindingV1 } from "./runtime-payload-inputs.ts";
import type { HostBuildInvocation, HostBuildObservation } from "./runtime-payload-entries.ts";
import { checked, schemas } from "./runtime-payload-receipts.ts";
import {
    admitReleaseRoot,
    copyReleaseFile,
    inventoryReleaseTree,
    releaseDirectory,
    writeReleaseJson,
} from "./runtime-release-files.ts";
import { observeRuntimeCommand } from "./runtime-release-builds.ts";
import { sha } from "./runtime-payload-tree.ts";
import {
    prepareRuntimeV1Dependencies,
    type RuntimeV1DependencyPreparation,
} from "./runtime-release-v1-dependencies.ts";

/**
 * 第一版材料以调用者独立提供的完整普通文件库存为准，平台原始归档的受控提取由现有来源工具完成；Windows 与 Linux 不复用 Mac 的归档名称、Chrome Framework 链接政策或 Darwin Build 收据。
 * 每棵树的根目录由调用者独占保持，任何额外文件、链接或缺失文件都会拒绝，不接受待核树自行生成的 Expected。
 */
export type RuntimeV1Material = Readonly<{ root: string; files: readonly FileFact[] }>;

/**
 * 非 Mac 生产任务保留已有 schemaVersion1 发行合同，Node、npm 与浏览器来自独立库存，生产依赖可显式选择独立材料或内置真实准备阶段；本入口真实构建入口、原生进程/helper 与版本化引擎，不把平台差异隐藏在
 * Mac 配方字段中。
 * 内置阶段运行原锁离线 hoisted 安装、C04 工作区 JavaScript 发射、原生目标条件闭包和真实 Node 解析，外部依赖材料则必须已包含同等生成及 optional/peer/bin 产物并另附来源证据。
 * 所有主机构建工具路径都显式给出，不下载工具、SDK、Chrome 或目标 Node，也不在安装时编译。
 */
export type RuntimeV1ProductionJob = Readonly<{
    platform: "linux" | "win32";
    arch: "x64";
    productVersion: string;
    nodeVersion: string;
    engineVersion: string;
    sourceRoot: string;
    source: SourceBindingV1;
    sourceBindingSha256: string;
    workParent: string;
    candidateName: string;
    node: RuntimeV1Material;
    npm: RuntimeV1Material;
    browser: RuntimeV1Material;
    dependencies?: RuntimeV1Material;
    dependencyPreparation?: RuntimeV1DependencyPreparation;
    materialEvidence: RuntimeV1Material;
    hostBuild: Readonly<{
        executable: string;
        nodeIdentity: Ref;
        viteCli: string;
        headerCache: string;
        engineOutput: string;
        timeoutMs: number;
    }>;
}>;

/**
 * 材料拷贝先检查完整集合与每个独立摘要，再逐个通过 held 描述符复制并在结束后再次枚举；现有 v1 loader 禁止任何链接，因此不会解引用 pnpm 链接来伪造物理实例或静默省略平台相关包。
 * 空目录不影响 v1 模块解析，但文件集合必须完全一致，目录中的未知二进制同样不能进入候选。
 */
async function copyMaterial(material: RuntimeV1Material, destination: string): Promise<void> {
    await admitReleaseRoot(material.root);
    const expected = [...material.files].sort((a, b) => a.path.localeCompare(b.path));
    const before = await inventoryReleaseTree(material.root, "dependencies");
    const identity = (files: readonly FileFact[]) =>
        [...files]
            .sort((a, b) => a.path.localeCompare(b.path))
            .map(({ path, sha256, sizeBytes }) => ({ path, sha256, sizeBytes }));
    if (JSON.stringify(identity(before.files)) !== JSON.stringify(identity(expected)))
        throw new Error("RUNTIME_V1_MATERIAL_INVENTORY_MISMATCH");
    for (const file of expected)
        await copyReleaseFile(
            join(material.root, file.path),
            destination,
            file.path,
            file,
            file.mode,
        );
    const after = await inventoryReleaseTree(material.root, "dependencies");
    if (JSON.stringify(before) !== JSON.stringify(after))
        throw new Error("RUNTIME_V1_MATERIAL_CHANGED");
}

/**
 * 第一版生产路径在真实目标主机运行原有 Vite、node-gyp 或 Linux C 构建脚本，并只收集明确正式成员；成功产出的只是候选和完整库存，独立工具/来源审核、签名、已安装执行及 release decision 均保留后续
 * 门禁。
 * sourceRoot 必须为独占构建视图，失败现场不自动删除，也不会覆盖现有 candidate 或源仓库的历史证据。
 * Node 角色是原始固定二进制的独立普通文件副本，复制不改变引擎版本或进程命名策略。
 */
export async function produceRuntimeV1(
    input: RuntimeV1ProductionJob,
    run: (invocation: HostBuildInvocation) => Promise<HostBuildObservation>,
): Promise<{
    kind: "RUNTIME_V1_CANDIDATE";
    candidateDirectory: string;
    runtimeDirectory: string;
    manifestSha256: string;
    receipt: Ref;
    status: "UNVERIFIED";
}> {
    const job = structuredClone(input);
    if (Boolean(job.dependencies) === Boolean(job.dependencyPreparation))
        throw new Error("RUNTIME_V1_DEPENDENCY_INPUT_EXCLUSIVE");
    if (
        !["linux", "win32"].includes(job.platform) ||
        job.arch !== "x64" ||
        process.platform !== job.platform ||
        process.arch !== job.arch ||
        !isIndependentNode24(process.versions) ||
        process.versions.node !== job.nodeVersion
    )
        throw new Error("RUNTIME_V1_HOST_TARGET_MISMATCH");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(job.candidateName))
        throw new Error("RUNTIME_CANDIDATE_NAME_INVALID");
    for (const value of [job.productVersion, job.engineVersion])
        if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value))
            throw new Error("RUNTIME_VERSION_INVALID");
    for (const path of [
        job.sourceRoot,
        job.workParent,
        job.hostBuild.executable,
        job.hostBuild.viteCli,
        job.hostBuild.headerCache,
        job.hostBuild.engineOutput,
    ])
        if (!isAbsolute(path)) throw new Error("RUNTIME_ABSOLUTE_PATH_REQUIRED");
    for (const root of [job.sourceRoot, job.workParent]) await admitReleaseRoot(root);
    if ((await realpath(job.hostBuild.executable)) !== (await realpath(process.execPath)))
        throw new Error("RUNTIME_BUILD_NODE_IDENTITY_MISMATCH");
    const source: SourceBindingV1 = checked(job.source, schemas.source);
    if (sha(canonicalBytes(source)) !== job.sourceBindingSha256)
        throw new Error("RUNTIME_SOURCE_BINDING_MISMATCH");
    for (const path of [
        "pnpm-lock.yaml",
        "apps/runtime/runtime.vite.config.mjs",
        "scripts/build_engine.mts",
        ...(job.platform === "linux"
            ? [
                  "apps/runtime/scripts/build-launcher.mjs",
                  "apps/runtime/scripts/build-vault-linux.mjs",
                  "apps/runtime/native/linux-runner.c",
                  "apps/runtime/native/vault/linux-vault.c",
              ]
            : [
                  "apps/runtime/scripts/build-windows.mjs",
                  "apps/runtime/native/binding.gyp",
                  "apps/runtime/native/windows-addon.cc",
                  "apps/runtime/native/windows-guardian.cc",
                  "apps/runtime/native/vault/windows-vault.cc",
              ]),
    ])
        if (!source.files.some((file) => file.path === path))
            throw new Error("RUNTIME_SOURCE_BINDING_MISSING");
    const owned = await mkdtemp(join(job.workParent, `.veriq-v1-${job.candidateName}-`));
    const runtime = join(owned, "runtime"),
        evidence = join(owned, "evidence"),
        build = join(owned, "entry-build");
    for (const root of [runtime, evidence, build]) await mkdir(root, { mode: 0o700 });
    await chmod(runtime, 0o755);
    const sourceSnapshot = join(evidence, "source");
    await mkdir(sourceSnapshot, { mode: 0o700 });
    for (const ref of source.files)
        await copyReleaseFile(join(job.sourceRoot, ref.path), sourceSnapshot, ref.path, ref, 0o644);
    await copyReleaseFile(
        job.hostBuild.executable,
        evidence,
        "tools/node",
        job.hostBuild.nodeIdentity,
        0o755,
    );
    const context = { inputRoot: evidence, timeoutMs: job.hostBuild.timeoutMs, run };
    const command = (name: string, args: readonly string[]) =>
        observeRuntimeCommand(context, name, job.hostBuild.executable, args, job.sourceRoot);
    const entry = await command("entries-vite-build", [
        job.hostBuild.viteCli,
        "build",
        "--config",
        join(job.sourceRoot, "apps/runtime/runtime.vite.config.mjs"),
        "--configLoader",
        "native",
        "--outDir",
        build,
    ]);
    // 原有配置生成的观察文件是构建证据而不是运行成员，完整枚举其余实际产物；两个固定入口必须存在，未知链接和特殊文件在 inventoryReleaseTree 中直接失败。
    const entryInventory = await inventoryReleaseTree(build, "entries");
    if (
        !["agent.js", "cli.js", ".veriq-entry-trace.json"].every((name) =>
            entryInventory.files.some((file) => file.path === name),
        )
    )
        throw new Error("RUNTIME_V1_ENTRY_OUTPUT_MISSING");
    await releaseDirectory(runtime, "entry");
    for (const file of entryInventory.files.filter(
        (file) => file.path !== ".veriq-entry-trace.json",
    ))
        await copyReleaseFile(
            join(build, file.path),
            join(runtime, "entry"),
            file.path,
            file,
            0o644,
        );
    await copyReleaseFile(
        join(build, ".veriq-entry-trace.json"),
        evidence,
        "entry-observation.json",
    );
    const traceFile = entryInventory.files.find((file) => file.path === ".veriq-entry-trace.json")!;
    if (traceFile.sizeBytes > 4 * 1024 * 1024) throw new Error("RUNTIME_ENTRY_OBSERVATION_LIMIT");
    const trace = JSON.parse(await readFile(join(evidence, "entry-observation.json"), "utf8")) as {
        sources: string[];
        outputs: Array<{ path: string; sizeBytes: number; sha256: string }>;
    };
    if (
        !Array.isArray(trace.sources) ||
        !Array.isArray(trace.outputs) ||
        trace.sources.some((path) => !source.files.some((file) => file.path === path)) ||
        trace.outputs.length !== entryInventory.files.length - 1 ||
        trace.outputs.some(
            (output) =>
                !entryInventory.files.some(
                    (file) =>
                        file.path === output.path &&
                        file.sizeBytes === output.sizeBytes &&
                        file.sha256 === output.sha256,
                ),
        )
    )
        throw new Error("RUNTIME_ENTRY_OBSERVATION_MISMATCH");
    await releaseDirectory(runtime, "execution");
    for (const name of [
        "worker",
        "provider",
        "compile-entry",
        "archive",
        "controlled-command",
        "controlled-child",
        "controlled-child-protocol",
        "controlled-child-preload",
    ]) {
        const path = `apps/runtime/src/execution/${name}.mjs`;
        const ref = source.files.find((file) => file.path === path);
        if (!ref) throw new Error("RUNTIME_EXECUTION_SOURCE_MISSING");
        await copyReleaseFile(
            join(job.sourceRoot, path),
            join(runtime, "execution"),
            `${name}.mjs`,
            ref,
            0o644,
        );
    }
    for (const [name, material] of [
        ["npm", job.npm],
        ["browser", job.browser],
    ] as const) {
        await releaseDirectory(runtime, name);
        await copyMaterial(material, join(runtime, name));
    }
    const preparedDependencies = job.dependencyPreparation
        ? await prepareRuntimeV1Dependencies({
              preparation: job.dependencyPreparation,
              sourceRoot: job.sourceRoot,
              source,
              runtimeRoot: runtime,
              workRoot: join(owned, "dependency-build"),
              evidenceRoot: evidence,
              executable: job.hostBuild.executable,
              nodeIdentity: job.hostBuild.nodeIdentity,
              nodeVersion: job.nodeVersion,
              timeoutMs: job.hostBuild.timeoutMs,
              run,
          })
        : undefined;
    const dependencyMaterial = preparedDependencies?.material ?? job.dependencies;
    if (!dependencyMaterial) throw new Error("RUNTIME_V1_DEPENDENCIES_MISSING");
    await releaseDirectory(runtime, "node_modules");
    await copyMaterial(dependencyMaterial, join(runtime, "node_modules"));
    await releaseDirectory(evidence, "materials");
    await copyMaterial(job.materialEvidence, join(evidence, "materials"));
    const suffix = job.platform === "win32" ? ".exe" : "";
    const nodeName = `node${suffix}`;
    if (job.node.files.length !== 1 || job.node.files[0]?.path !== nodeName)
        throw new Error("RUNTIME_V1_NODE_MATERIAL_INVALID");
    await releaseDirectory(evidence, "original-node");
    await copyMaterial(job.node, join(evidence, "original-node"));
    for (const [role, processName] of [
        ["agent", "veriq_agent"],
        ["cli", "veriq_cli"],
        ["runner", "veriq_runner"],
    ]) {
        await releaseDirectory(runtime, `roles/${role}`);
        await copyReleaseFile(
            join(evidence, "original-node", nodeName),
            runtime,
            `roles/${role}/${processName}${suffix}`,
            job.node.files[0],
            0o755,
        );
    }
    const nativeCommands: Ref[] = [];
    if (job.platform === "linux") {
        nativeCommands.push(
            (
                await command("native-linux-launcher", [
                    join(job.sourceRoot, "apps/runtime/scripts/build-launcher.mjs"),
                ])
            ).evidence,
        );
        nativeCommands.push(
            (
                await command("native-linux-vault", [
                    join(job.sourceRoot, "apps/runtime/scripts/build-vault-linux.mjs"),
                ])
            ).evidence,
        );
        await copyReleaseFile(
            join(job.sourceRoot, "apps/runtime/build/veriq_runner"),
            runtime,
            "native/veriq_runner",
            undefined,
            0o755,
        );
        await copyReleaseFile(
            join(job.sourceRoot, "apps/runtime/build/vault/veriq_agent"),
            runtime,
            "native/vault/veriq_agent",
            undefined,
            0o755,
        );
    } else {
        nativeCommands.push(
            (
                await command("native-windows-build", [
                    join(job.sourceRoot, "apps/runtime/scripts/build-windows.mjs"),
                    job.hostBuild.headerCache,
                ])
            ).evidence,
        );
        await copyReleaseFile(
            join(job.sourceRoot, "apps/runtime/build/Release/veriq_native.node"),
            runtime,
            "native/veriq_native.node",
            undefined,
            0o644,
        );
        // 现有 v1 ExecutionPaths 的 guardian 名称固定为 veriq_runner.exe，真实产品构建名为 veriq_guardian.exe；这里只复制同一正式 guardian 原字节，绝不使
        // 用角色 Node 或测试 guardian 替代。
        await copyReleaseFile(
            join(job.sourceRoot, "apps/runtime/build/Release/veriq_guardian.exe"),
            runtime,
            "native/veriq_runner.exe",
            undefined,
            0o755,
        );
        await copyReleaseFile(
            join(job.sourceRoot, "apps/runtime/build/vault/veriq_agent.exe"),
            runtime,
            "native/vault/veriq_agent.exe",
            undefined,
            0o755,
        );
    }
    const exists = await lstat(job.hostBuild.engineOutput).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
    });
    if (exists) throw new Error("RUNTIME_ENGINE_OUTPUT_EXISTS");
    const engine = await command("engine-build", [
        join(job.sourceRoot, "scripts/build_engine.mts"),
        job.engineVersion,
        job.hostBuild.engineOutput,
    ]);
    const engineInventory = await inventoryReleaseTree(job.hostBuild.engineOutput, "engine");
    const engineInventoryFile = engineInventory.files.find(
        (file) => file.path === "inventory.json",
    );
    if (
        !engineInventoryFile ||
        engineInventoryFile.sizeBytes > 4 * 1024 * 1024 ||
        validateSchema(
            "ApprovedEngineInventoryV1",
            JSON.parse(await readFile(join(job.hostBuild.engineOutput, "inventory.json"), "utf8")),
        ).length
    )
        throw new Error("RUNTIME_ENGINE_INVENTORY_INVALID");
    await releaseDirectory(runtime, `engines/${job.engineVersion}`);
    await copyMaterial(
        { root: job.hostBuild.engineOutput, files: engineInventory.files },
        join(runtime, "engines", job.engineVersion),
    );
    // 根 package.json 明确选择 ESM，避免 Vite 入口和生成 Workspace 包因宿主目录中其他 package.json 而被解释成 CommonJS；依赖输入已经单独核全量文件，生成根不承载或修改锁定依赖
    // 声明。
    await writeReleaseJson(runtime, "package.json", { private: true, type: "module" });
    const inventory = await inventoryReleaseTree(runtime, "entries");
    const required = [
        "entry/agent.js",
        "entry/cli.js",
        "npm/bin/npm-cli.js",
        "node_modules/tsx/dist/loader.mjs",
        `engines/${job.engineVersion}/inventory.json`,
        job.platform === "win32"
            ? "browser/chrome-win64/chrome.exe"
            : "browser/chrome-linux64/chrome",
    ];
    if (required.some((name) => !inventory.files.some((file) => file.path === name)))
        throw new Error("RUNTIME_V1_REQUIRED_MEMBER_MISSING");
    const manifest = {
        schemaVersion: 1,
        platform: job.platform,
        arch: job.arch,
        productVersion: job.productVersion,
        nodeVersion: job.nodeVersion,
        engineVersion: job.engineVersion,
        files: inventory.files.map(({ path, sizeBytes, sha256 }) => ({ path, sizeBytes, sha256 })),
    };
    const manifestRef = await writeReleaseJson(runtime, "runtime-manifest.json", manifest);
    const after = join(evidence, "source-after");
    await mkdir(after, { mode: 0o700 });
    for (const ref of source.files)
        await copyReleaseFile(join(job.sourceRoot, ref.path), after, ref.path, ref, 0o644);
    await copyReleaseFile(
        job.hostBuild.executable,
        evidence,
        "tools/node-after",
        job.hostBuild.nodeIdentity,
        0o755,
    );
    const receipt = await writeReleaseJson(owned, "payload-receipt.json", {
        schemaVersion: 1,
        kind: "RUNTIME_V1_PAYLOAD_CANDIDATE",
        target: {
            platform: job.platform,
            arch: job.arch,
            productVersion: job.productVersion,
            nodeVersion: job.nodeVersion,
            engineVersion: job.engineVersion,
        },
        source: { commit: source.commit, sourceBindingSha256: job.sourceBindingSha256 },
        runtimeManifestSha256: manifestRef.sha256,
        entriesCommand: entry.evidence,
        nativeCommands,
        engineCommand: engine.evidence,
        materials: job.materialEvidence.files,
        dependencyProduction: preparedDependencies?.evidence ?? null,
        status: "UNVERIFIED",
        pending: [
            "INDEPENDENT_SOURCE_AND_INPUT_REVIEW",
            "INSTALLED_EXECUTION",
            "SIGNING_AND_RELEASE_APPROVAL",
        ],
    });
    return {
        kind: "RUNTIME_V1_CANDIDATE",
        candidateDirectory: owned,
        runtimeDirectory: runtime,
        manifestSha256: manifestRef.sha256,
        receipt,
        status: "UNVERIFIED",
    };
}
