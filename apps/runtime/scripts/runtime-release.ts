import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { mkdir, mkdtemp, lstat, realpath } from "node:fs/promises";
import { canonicalBytes } from "@veriq/contracts";
import { ArchiveTransaction } from "./runtime-payload-transaction.ts";
import { withEntryInputViews, type EntryInputOptions } from "./runtime-payload-entries.ts";
import { withDependencyInputViews, type DependencyInputOptions } from "./runtime-payload-dependencies.ts";
import { stageMacRuntimePayload, type PayloadResult } from "./runtime-payload-stage.ts";
import { prepareMacNodeBootstrap } from "./runtime-node-bootstrap.ts";
import { checked, schemas } from "./runtime-payload-receipts.ts";
import { InputReader, sha, limits } from "./runtime-payload-tree.ts";
import type { Recipe, BoundTree, ExpectedPayloadInputs, SourceBindingV1, Ref } from "./runtime-payload-inputs.ts";
import { admitReleaseRoot, copyReleaseFile, mergeReleaseView, writeReleaseJson } from "./runtime-release-files.ts";
import {
    produceMacNativeTree,
    produceMacEngineTree,
    runtimeBuildHeader,
    type RuntimeBuildContext,
} from "./runtime-release-builds.ts";

/**
 * 五树生产任务只接收独立来源材料、真实工具路径和原始资产配方，原配方不包含尚未产生的五树或 Expected；外层必须对本次产出
 * 的配方另行审核，不能将新摘要自动升级为 trusted Expected。seedRoot 保存原始
 * Node/Chrome 归档、工具及来源证据，sourceRoot 是具有冻结依赖和真实构建工具的独占源码工作视图。workParent 必须位于源码
 * 根之外且由调用者独占，构建脚本自身的原生输出及 engineOutput
 * 仍留在明确源码 work 范围内。
 */
export type MacRuntimeProductionJob = Readonly<{
    sourceRoot: string;
    seedRoot: string;
    workParent: string;
    candidateName: string;
    recipe: Omit<Recipe, "entries" | "execution" | "dependencies" | "native" | "engine">;
    hostBuild: Omit<EntryInputOptions["hostBuild"], "run"> &
        Readonly<{
            pnpmCli: string;
            pnpmStore: string;
            headerCache: string;
            engineOutput: string;
        }>;
    targetNode: DependencyInputOptions["targetNode"];
    nodeBootstrapAssets?: Ref;
    nativeSigning?: RuntimeBuildContext["nativeSigning"];
}>;

/**
 * 产出描述只指向真实五树材料、配方原字节和各 producer 的清理结算，状态明确停留在等待独立审核；它不含 Expected 文档、
 * ready、签名或安装完成字段，不能直接充当 desktop 的 trustedRuntime。
 * 失败保留本轮独占根，已有 SDD 证据和其他候选目录均不被覆盖或清理。
 */
export type RuntimeProductionResult = Readonly<{
    kind: "MAC_RUNTIME_INPUTS_PRODUCED";
    inputRoot: string;
    recipe: Ref;
    workDirectory: string;
    producerTransactionsCleanup: "CONFIRMED";
    status: "AWAITING_INDEPENDENT_EXPECTED";
}>;

/**
 * 来源材料从独立绑定读取且在整个生产窗口前后复验，全部源码副本保持原始相对路径；此函数不遍历源码根的 node_modules 或
 * .git，也不把 Git 提交声明解释为已获得发布来源批准。
 * 跨树相同源码只复制一次，最初 seedRoot 若已有副本则由合并过程核字节完全一致而不是覆盖。
 */
async function sourceSnapshot(
    sourceRoot: string,
    inputRoot: string,
    source: SourceBindingV1,
): Promise<() => Promise<void>> {
    const reader = new InputReader(sourceRoot, undefined, []);
    await reader.initialize();
    for (const ref of source.files) {
        await reader.ref(ref, false, limits.file, false);
        const existing = await lstat(join(inputRoot, ref.path)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return null;
        });
        if (!existing) await copyReleaseFile(join(sourceRoot, ref.path), inputRoot, ref.path, ref, 0o644);
        else {
            const duplicate = new InputReader(inputRoot, undefined, []);
            await duplicate.initialize();
            await duplicate.ref(ref, false, limits.file, false);
            await duplicate.finish();
        }
    }
    return async () => {
        for (const ref of source.files) await reader.ref(ref, false, limits.file, false);
        await reader.finish();
    };
}

/**
 * 每个 producer 都有单独事务和单独空构建根，回调只把只读视图复制到调用者第三 intake 根；只有完整返回并完成自己的 reader
 * 收尾后，后续 producer 才能继续修改该 intake，避免 D04
 * 的活视图被自身写入污染。真实进程通过调用者提供的既有有界管理器执行，命令观察不可被预制收据替代，未知关闭时不再读取构
 * 建输出。此函数只生产材料，不调用 stage，因此时间戳和真实构建证据不会被自派生 Expected 的循环信任掩盖。
 */
export async function produceMacRuntimeInputs(
    jobInput: MacRuntimeProductionJob,
    run: RuntimeBuildContext["run"],
): Promise<RuntimeProductionResult> {
    const job = structuredClone(jobInput);
    if (
        job.recipe.target.platform !== "darwin" ||
        process.platform !== "darwin" ||
        process.arch !== job.recipe.target.arch
    )
        throw new Error("RUNTIME_PRODUCTION_HOST_TARGET_MISMATCH");
    const nodeTool = job.recipe.tools.find((tool) => tool.name === "node");
    if (
        !nodeTool ||
        nodeTool.artifactSha256 !== job.targetNode.artifactSha256 ||
        job.targetNode.version !== job.recipe.target.nodeVersion
    )
        throw new Error("RUNTIME_TARGET_NODE_TOOL_IDENTITY_MISMATCH");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(job.candidateName)) throw new Error("RUNTIME_CANDIDATE_NAME_INVALID");
    for (const path of [
        job.sourceRoot,
        job.seedRoot,
        job.workParent,
        job.hostBuild.executable,
        job.hostBuild.viteCli,
        job.hostBuild.pnpmCli,
        job.hostBuild.pnpmStore,
        job.hostBuild.headerCache,
        job.hostBuild.engineOutput,
        job.targetNode.executable,
    ]) {
        if (!isAbsolute(path)) throw new Error("RUNTIME_ABSOLUTE_PATH_REQUIRED");
    }
    for (const root of [job.sourceRoot, job.seedRoot, job.workParent]) await admitReleaseRoot(root);
    for (const root of [job.sourceRoot, job.seedRoot]) {
        const a = resolve(root),
            b = resolve(job.workParent);
        if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/")) throw new Error("RUNTIME_WORK_ROOT_OVERLAP");
    }
    if (
        resolve(job.hostBuild.executable) !== (await realpath(process.execPath)) ||
        process.versions.node !== job.recipe.target.nodeVersion
    )
        throw new Error("RUNTIME_BUILD_NODE_IDENTITY_MISMATCH");
    const seed = new InputReader(job.seedRoot, undefined, []);
    await seed.initialize();
    const sourceBytes = await seed.ref(job.recipe.source.binding, true);
    const source: SourceBindingV1 = checked(JSON.parse(sourceBytes.toString()), schemas.source);
    if (source.commit !== job.recipe.source.commit || sha(canonicalBytes(source)) !== job.recipe.source.binding.sha256)
        throw new Error("RUNTIME_SOURCE_BINDING_MISMATCH");
    const owned = await mkdtemp(join(job.workParent, `.veriq-runtime-${job.candidateName}-`));
    const inputRoot = join(owned, "input"),
        transactions = join(owned, "transactions"),
        entryBuild = join(owned, "entry-build"),
        dependencyBuild = join(owned, "dependency-build"),
        dependencySnapshot = join(owned, "dependency-snapshot");
    for (const root of [inputRoot, transactions, entryBuild, dependencyBuild, dependencySnapshot])
        await mkdir(root, { mode: 0o700 });
    await mergeReleaseView(job.seedRoot, inputRoot);
    const finishSource = await sourceSnapshot(job.sourceRoot, inputRoot, source);
    const context: RuntimeBuildContext = {
        sourceRoot: job.sourceRoot,
        inputRoot,
        source,
        sourceBindingSha256: job.recipe.source.binding.sha256,
        target: job.recipe.target,
        executable: job.hostBuild.executable,
        headerCache: job.hostBuild.headerCache,
        engineOutput: job.hostBuild.engineOutput,
        timeoutMs: job.hostBuild.timeoutMs,
        run,
        ...(job.nativeSigning ? { nativeSigning: job.nativeSigning } : {}),
    };
    // Node/npm bootstrap 单独消费外层独立资产输入，保存原有 UNREVIEWED_SOURCE 和 pending，不把原始树提取结果冒充可执行
    // 布局；正式 stage 稍后仍重新消费原归档及独立 receipt。
    if (job.nodeBootstrapAssets) {
        const assets = await seed.ref(job.nodeBootstrapAssets, true);
        const bootstrapParent = join(owned, "bootstrap");
        await mkdir(bootstrapParent, { mode: 0o700 });
        const bootstrap = await prepareMacNodeBootstrap(assets, {
            inputRoot: job.seedRoot,
            outputParent: bootstrapParent,
            candidateName: "node-source",
        });
        if (bootstrap.cleanup !== "CONFIRMED") throw new Error("RUNTIME_BOOTSTRAP_CLEANUP_INCOMPLETE");
        await writeReleaseJson(inputRoot, "release-evidence/node-bootstrap-result.json", bootstrap);
    }
    let entryTrees: Readonly<{ entries: BoundTree; execution: BoundTree }> | undefined;
    const entryWork = new ArchiveTransaction(job.sourceRoot, transactions, `entry-${randomUUID()}`, undefined, "work");
    await entryWork.initialize();
    await withEntryInputViews(
        entryWork,
        {
            source,
            entries: runtimeBuildHeader(
                context,
                "apps/runtime/scripts/runtime-payload-entries.ts",
                "apps/runtime/runtime.vite.config.mjs",
                ["node", "vite"],
            ),
            execution: runtimeBuildHeader(
                context,
                "apps/runtime/scripts/runtime-payload-entries.ts",
                "apps/runtime/scripts/runtime-payload-entries.ts",
                ["node"],
            ),
            buildRoot: entryBuild,
            hostBuild: { ...job.hostBuild, run },
        },
        async (root, trees) => {
            await mergeReleaseView(root, inputRoot);
            entryTrees = structuredClone(trees);
        },
    );
    if (!entryTrees || (await entryWork.cleanup()) !== "CONFIRMED")
        throw new Error("RUNTIME_ENTRY_LIFETIME_UNCONFIRMED");
    const settledEntries = entryTrees as Readonly<{ entries: BoundTree; execution: BoundTree }>;
    let dependencyTrees: Readonly<{ dependencies: BoundTree }> | undefined;
    const dependencyWork = new ArchiveTransaction(
        job.sourceRoot,
        transactions,
        `dependency-${randomUUID()}`,
        undefined,
        "work",
    );
    await dependencyWork.initialize();
    await withDependencyInputViews(
        dependencyWork,
        {
            source,
            dependencies: runtimeBuildHeader(
                context,
                "apps/runtime/scripts/runtime-payload-dependencies.ts",
                "pnpm-workspace.yaml",
                ["node", "pnpm"],
            ),
            buildRoot: dependencyBuild,
            consumers: { inputRoot, ...settledEntries },
            hostBuild: {
                executable: job.hostBuild.executable,
                pnpmCli: job.hostBuild.pnpmCli,
                pnpmStore: job.hostBuild.pnpmStore,
                timeoutMs: job.hostBuild.timeoutMs,
                run,
            },
            targetNode: job.targetNode,
        },
        async (root, trees) => {
            // 依赖生产器仍持有 consumers reader，因此回调阶段只能写到另一份 snapshot；其收尾完成后才允许把依赖及生成来
            // 源证据合并到第三 intake 根。
            await mergeReleaseView(root, dependencySnapshot, true);
            dependencyTrees = structuredClone(trees);
        },
    );
    if (!dependencyTrees || (await dependencyWork.cleanup()) !== "CONFIRMED")
        throw new Error("RUNTIME_DEPENDENCY_LIFETIME_UNCONFIRMED");
    const settledDependencies = dependencyTrees as Readonly<{ dependencies: BoundTree }>;
    await mergeReleaseView(dependencySnapshot, inputRoot, true);
    const native = await produceMacNativeTree(context),
        engine = await produceMacEngineTree(context);
    await finishSource();
    await seed.finish();
    const recipe = checked<Recipe>(
        { ...job.recipe, ...settledEntries, ...settledDependencies, native, engine },
        schemas.recipe,
    );
    const recipeRef = await writeReleaseJson(inputRoot, "runtime-inputs.json", recipe);
    await writeReleaseJson(inputRoot, "release-evidence/source-delivery.json", {
        kind: "RUNTIME_SOURCE_DELIVERY",
        recipe: recipeRef,
        target: recipe.target,
        status: "AWAITING_INDEPENDENT_EXPECTED",
        source: recipe.source,
        workDirectory: owned,
        boundary:
            "Actual production commands completed; no candidate execution, release promotion, signing or readiness c" +
            "laim.",
    });
    return {
        kind: "MAC_RUNTIME_INPUTS_PRODUCED",
        inputRoot,
        recipe: recipeRef,
        workDirectory: owned,
        producerTransactionsCleanup: "CONFIRMED",
        status: "AWAITING_INDEPENDENT_EXPECTED",
    };
}

/**
 * 独立 stage 调用只接收审核方给出的 Expected 并直接委托原有五树核验器，不生成或修正任何可信值；输出保留原始清理状态，调
 * 用者不能把成功提交但收尾未知的候选标为可发布。
 * 生产输入与 stage 分开使审核者能在所有真实命令证据形成之后批准精确配方摘要，避免生产器同时扮演发行批准者。
 */
export async function stageProducedMacRuntime(
    recipe: Uint8Array,
    expected: ExpectedPayloadInputs,
    inputRoot: string,
    outputParent: string,
    candidateName: string,
): Promise<PayloadResult> {
    return stageMacRuntimePayload(recipe, expected, { inputRoot, outputParent, candidateName });
}
