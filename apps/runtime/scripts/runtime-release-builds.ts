import { join } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { canonicalBytes, validateSchema } from "@veriq/contracts";
import type { HostBuildInvocation, HostBuildObservation } from "./runtime-payload-entries.ts";
import type { SourceBindingV1, Build, BoundTree, Ref, NativeOutput, NativeReceipt, EngineReceipt, Target } from "./runtime-payload-inputs.ts";
import { InputReader, decode, sha, limits } from "./runtime-payload-tree.ts";
import { checked, schemas } from "./runtime-payload-receipts.ts";
import { copyReleaseFile, inventoryReleaseTree, releaseDirectory, writeReleaseJson, writeReleaseBytes, releaseFileIdentity } from "./runtime-release-files.ts";

/** 构建上下文明确区分源码根、独占证据根和实际宿主 Node，真实命令统一交给已有有界管理器；没有可注入成功收据或预制二进制的字段，关闭未知时本轮根始终保留供后续人工处理。
 * target 的 Darwin 类型仅用于旧 Mac 配方，跨平台构建使用单独命令入口，不能改写平台字符串冒充相同收据。
 */
export type RuntimeBuildContext = Readonly<{
    sourceRoot: string;
    inputRoot: string;
    source: SourceBindingV1;
    sourceBindingSha256: string;
    target: Target;
    executable: string;
    headerCache: string;
    engineOutput: string;
    timeoutMs: number;
    run: (invocation: HostBuildInvocation) => Promise<HostBuildObservation>;
    /** 可选签名只作用于本次新构建的两项正式 native 输出，操作员明确选择身份、受源码绑定的 entitlements 和时间戳策略；签名发生在最终库存及 receipt 摘要之前，原 Node/Chrome 归档绝不重签或改写。
     * 实际 signer 工具身份和每条命令单独进入不透明 commandEvidence，既有公共 Tool 枚举保持原构建工具语义，签名不自动晋升候选状态。
     */
    nativeSigning?: Readonly<{
        identity: string;
        entitlements?: Ref;
        timestamp?: "secure" | "none";
    }>;
}>;

/** 命令结算在实际调用边界记录开始结束、宿主身份和全部原始有限输出，所有不完整关闭、信号、超时或截断都拒绝；本函数仅证明直接子进程的观察，不声称任意编译后代均已清理。
 * stdout 与 stderr 单独形成证据引用，JSON 不会把 Buffer 转成失去语义的数字数组，也不把命令日志解释成发行通过结论。
 */
export async function observeRuntimeCommand(
    context: Pick<RuntimeBuildContext, "inputRoot" | "run" | "timeoutMs">,
    name: string,
    executable: string,
    args: readonly string[],
    cwd: string,
): Promise<{ evidence: Ref; stdout: string }> {
    const invocation = { executable, args: [...args], cwd, timeoutMs: context.timeoutMs };
    const started = new Date().toISOString();
    const result = await context.run(invocation);
    const finished = new Date().toISOString();
    const success = result.closeConfirmed === true && result.admitted === true && result.exit === 0 &&
        result.signal === null && result.error === null && !result.timedOut && !result.truncated;
    const bounded = Buffer.isBuffer(result.stdout) && Buffer.isBuffer(result.stderr) &&
        result.stdout.length <= 65536 && result.stderr.length <= limits.json;
    // 失败观察也必须留下事实而不是生成成功的领域收据；在关闭未知时只写到独立证据根，绝不遍历仍可能由子进程写入的构建根。
    const stdout = bounded ? await writeReleaseBytes(context.inputRoot, `release-evidence/${name}.stdout`, result.stdout) : null;
    const stderr = bounded ? await writeReleaseBytes(context.inputRoot, `release-evidence/${name}.stderr`, result.stderr) : null;
    const evidence = await writeReleaseJson(context.inputRoot, `release-evidence/${name}.json`, {
        operation: "BOUNDED_BUILD_COMMAND", invocation, started, finished,
        host: { platform: process.platform, arch: process.arch, node: process.versions.node },
        observation: { ...result, stdout, stderr },
    });
    if (!success || !bounded || !Number.isSafeInteger(result.pid) || result.pid! <= 0)
        throw new Error(result.closeConfirmed ? "RUNTIME_BUILD_COMMAND_FAILED" : "RUNTIME_BUILD_CLOSE_UNCONFIRMED");
    return { evidence, stdout: result.stdout.toString("utf8") };
}

/** Build 头只引用独立来源绑定中已有的真实 producer 与配置文件，锁摘要同样来自原始绑定；找不到任何必须文件立即拒绝，不自动补写来源文档以适应本轮产物。
 * commandEvidence 在真实动作完成后单独加入，避免把尚未执行的计划伪装成已运行收据。
 */
export function runtimeBuildHeader(
    context: RuntimeBuildContext,
    producer: string,
    config: string,
    toolNames: Build["toolNames"],
): Omit<Build, "commandEvidence"> {
    const find = (path: string) => {
        const ref = context.source.files.find((file) => file.path === path);
        if (!ref) throw new Error("RUNTIME_SOURCE_BINDING_MISSING");
        return ref;
    };
    return {
        commit: context.source.commit,
        sourceBindingSha256: context.sourceBindingSha256,
        pnpmLockSha256: find("pnpm-lock.yaml").sha256,
        target: { platform: "darwin", arch: context.target.arch },
        producer: find(producer), config: find(config), toolNames,
    };
}

/** Mac 正式原生产物复用已有两个构建脚本，随后用系统 lipo 与 otool 检查本轮真实文件的架构及最低系统声明；SDK 路径和版本来自真实 xcrun，测试开关、故障宏和测试二进制从未进入命令参数。
 * node-gyp 使用调用者明确提供的缓存，生产脚本自身的工具及头文件准备仍属于后续受控构建环境责任。
 * 本函数不执行 addon、Keychain helper 或任何真实凭据操作，静态构建证据不代表业务能力验收。
 */
export async function produceMacNativeTree(context: RuntimeBuildContext): Promise<BoundTree> {
    if (process.platform !== "darwin" || process.arch !== context.target.arch)
        throw new Error("RUNTIME_NATIVE_HOST_TARGET_MISMATCH");
    const command = (name: string, executable: string, args: readonly string[]) =>
        observeRuntimeCommand(context, name, executable, args, context.sourceRoot);
    const signing = context.nativeSigning ? structuredClone(context.nativeSigning) : undefined;
    if (signing && (typeof signing.identity !== "string" || !signing.identity.trim() ||
        signing.identity.length > 1024 || /[\x00-\x1f\x7f]/.test(signing.identity) ||
        (signing.timestamp !== undefined && !["secure", "none"].includes(signing.timestamp))))
        throw new Error("RUNTIME_NATIVE_SIGNING_ARGUMENT_INVALID");
    if (signing?.entitlements && !context.source.files.some((file) => file.path === signing.entitlements!.path &&
        file.sizeBytes === signing.entitlements!.sizeBytes && file.sha256 === signing.entitlements!.sha256))
        throw new Error("RUNTIME_NATIVE_ENTITLEMENTS_UNBOUND");
    const signer = signing ? await releaseFileIdentity(await realpath("/usr/bin/codesign")) : undefined;
    const signingCommands: Ref[] = [];
    const addon = await command("native-addon-build", context.executable,
        [join(context.sourceRoot, "apps/runtime/scripts/build-darwin.mjs"), context.headerCache]);
    const vault = await command("native-vault-build", context.executable,
        [join(context.sourceRoot, "apps/runtime/scripts/build-vault-darwin.mjs")]);
    await copyReleaseFile(join(context.sourceRoot, "apps/runtime/build/vault-darwin/build-facts.json"),
        context.inputRoot, "release-evidence/native-vault-build-facts.json", undefined, 0o644);
    const sdkPath = (await command("native-sdk-path", "/usr/bin/xcrun", ["--show-sdk-path"])).stdout.trim();
    const sdkVersion = (await command("native-sdk-version", "/usr/bin/xcrun", ["--show-sdk-version"])).stdout.trim();
    if (!/^\d+(?:\.\d+){0,2}$/.test(sdkVersion) || !sdkPath.startsWith("/") || /[\r\n]/.test(sdkPath))
        throw new Error("RUNTIME_SDK_IDENTITY_INVALID");
    const settings = new InputReader(await realpath(sdkPath), undefined, []);
    await settings.initialize();
    const settingsBytes = await settings.input("SDKSettings.json");
    await settings.finish();
    const settingsEvidence = await writeReleaseJson(context.inputRoot, "release-evidence/native-sdk-settings.json", {
        sdkPath, sdkVersion, settingsSha256: sha(settingsBytes), settings: decode(settingsBytes),
    });
    await releaseDirectory(context.inputRoot, "native");
    const outputs: NativeOutput[] = [];
    for (const item of [
        { path: "veriq_private_files.node" as const, source: "apps/runtime/build/darwin/veriq_private_files.node",
            targetName: "veriq_private_files" as const, defines: ["NAPI_CPP_EXCEPTIONS", "NAPI_VERSION=9"],
            sourceFiles: ["apps/runtime/native/darwin/addon.cc", "apps/runtime/native/darwin/private-files.h"] },
        { path: "vault/veriq_agent" as const, source: "apps/runtime/build/vault-darwin/veriq_agent",
            targetName: "veriq_agent" as const, defines: [],
            sourceFiles: ["apps/runtime/native/vault/darwin-vault.mm", "apps/runtime/native/vault/darwin-acl.hpp"] },
    ]) {
        const original = join(context.sourceRoot, item.source);
        let unsigned: Ref | undefined;
        if (signing && signer) {
            unsigned = await releaseFileIdentity(original);
            const args = ["--force", "--sign", signing.identity, "--options", "runtime",
                signing.timestamp === "none" ? "--timestamp=none" : "--timestamp",
                ...(signing.entitlements ? ["--entitlements", join(context.sourceRoot, signing.entitlements.path)] : []), original];
            signingCommands.push((await command(`native-${item.targetName}-sign`, signer.path, args)).evidence);
            signingCommands.push((await command(`native-${item.targetName}-signature-verify`, signer.path,
                ["--verify", "--strict", "--verbose=2", original])).evidence);
            signingCommands.push((await command(`native-${item.targetName}-signature-display`, signer.path,
                ["--display", "--verbose=4", original])).evidence);
        }
        const arch = await command(`native-${item.targetName}-arch`, "/usr/bin/lipo", ["-archs", original]);
        const load = await command(`native-${item.targetName}-load`, "/usr/bin/otool", ["-l", original]);
        const links = await command(`native-${item.targetName}-links`, "/usr/bin/otool", ["-L", original]);
        const architecture = context.target.arch === "arm64" ? "arm64" : "x86_64";
        if (arch.stdout.trim() !== architecture || !/\bminos 15\.0(?:\.0)?\b/.test(load.stdout))
            throw new Error("RUNTIME_NATIVE_BINARY_IDENTITY_MISMATCH");
        const fact = await copyReleaseFile(original, join(context.inputRoot, "native"), item.path,
            undefined, item.targetName === "veriq_agent" ? 0o755 : 0o644);
        const inspectionEvidence = await writeReleaseJson(context.inputRoot,
            `release-evidence/native-${item.targetName}-inspection.json`, {
                architecture, minimumOs: "15.0", sha256: fact.sha256,
                commands: [arch.evidence, load.evidence, links.evidence],
                ...(unsigned ? { unsignedBuildOutput: unsigned, signingRequested: true } : {}),
            });
        outputs.push({ path: item.path, targetName: item.targetName, defines: item.defines,
            sourceFiles: item.sourceFiles.map((path) => {
                const ref = context.source.files.find((file) => file.path === path);
                if (!ref) throw new Error("RUNTIME_NATIVE_SOURCE_MISSING");
                return ref;
            }), sha256: fact.sha256, architecture, minimumOs: "15.0",
            sdk: { version: sdkVersion, settingsEvidence }, inspectionEvidence });
    }
    const inventory = await inventoryReleaseTree(join(context.inputRoot, "native"), "native");
    const inventoryRef = await writeReleaseJson(context.inputRoot, "release-evidence/native-inventory.json", inventory);
    const signerAfter = signer ? await releaseFileIdentity(signer.path) : undefined;
    if (signer && (signerAfter?.sha256 !== signer.sha256 || signerAfter.sizeBytes !== signer.sizeBytes))
        throw new Error("RUNTIME_NATIVE_SIGNER_CHANGED");
    const commandEvidence = await writeReleaseJson(context.inputRoot, "release-evidence/native-build.json", {
        operation: "NATIVE_PRODUCTION_BUILD", commands: [addon.evidence, vault.evidence], outputs,
        signing: signing ? { requested: true, identity: signing.identity,
            entitlements: signing.entitlements ?? null, timestamp: signing.timestamp ?? "secure",
            signerBefore: signer, signerAfter, commands: signingCommands } : { requested: false },
    });
    const receipt: NativeReceipt = checked({ schemaVersion: 1, kind: "NATIVE_PRODUCTION_BUILD",
        build: { ...runtimeBuildHeader(context, "apps/runtime/scripts/build-darwin.mjs",
            "apps/runtime/native/darwin/binding.gyp", ["node", "node-gyp", "clang"]), commandEvidence },
        treeInventorySha256: inventoryRef.sha256, outputs }, schemas.native);
    return { root: "native", inventory: inventoryRef,
        buildReceipt: await writeReleaseJson(context.inputRoot, "release-evidence/native-receipt.json", receipt) };
}

/** 引擎材料必须由既有生产编译器真实生成，而不是接收外部填充的 ENGINE_PAYLOAD 收据；已存在输出路径拒绝覆盖，原 inventory 使用现有 Schema 并单独核唯一目标条目和所有真实文件。
 * 编译器包含原始 TS 源、SDK 与合同编译后的 JS、离线 vendor 包及冻结 npm 锁，版本和完整性由原 producer 决定。
 * candidate 没有签发者或晋升入口，ApprovedEngineInventoryV1 是现有文档格式名而非本次获得的批准结论。
 */
export async function produceMacEngineTree(context: RuntimeBuildContext): Promise<BoundTree> {
    const existing = await lstat(context.engineOutput).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
    });
    if (existing) throw new Error("RUNTIME_ENGINE_OUTPUT_EXISTS");
    const command = await observeRuntimeCommand(context, "engine-build", context.executable,
        [join(context.sourceRoot, "scripts/build_engine.mts"), context.target.engineVersion, context.engineOutput], context.sourceRoot);
    const original = await inventoryReleaseTree(context.engineOutput, "engine");
    await releaseDirectory(context.inputRoot, "engine");
    for (const file of original.files)
        await copyReleaseFile(join(context.engineOutput, file.path), join(context.inputRoot, "engine"), file.path, file, 0o644);
    const inventory = await inventoryReleaseTree(join(context.inputRoot, "engine"), "engine");
    const reader = new InputReader(join(context.inputRoot, "engine"), undefined, []);
    await reader.initialize();
    const raw = await reader.input("inventory.json");
    const document = decode(raw) as { engines: Array<{
        engineVersion: string; compilerVersion: string; runnerSdkVersion: string;
        files: Ref[]; dependencies: EngineReceipt["dependencies"];
    }> };
    if (validateSchema("ApprovedEngineInventoryV1", document).length)
        throw new Error("RUNTIME_ENGINE_INVENTORY_INVALID");
    const matches = document.engines.filter((entry) => entry.engineVersion === context.target.engineVersion);
    if (matches.length !== 1) throw new Error("RUNTIME_ENGINE_VERSION_MISMATCH");
    const entry = matches[0]!;
    for (const file of entry.files) await reader.ref(file, false, limits.file, false);
    await reader.finish();
    const inventoryRef = await writeReleaseJson(context.inputRoot, "release-evidence/engine-inventory.json", inventory);
    const receipt: EngineReceipt = checked({ schemaVersion: 1, kind: "ENGINE_PAYLOAD",
        build: { ...runtimeBuildHeader(context, "scripts/build_engine.mts", "scripts/build_engine.mts", ["node", "pnpm"]),
            commandEvidence: command.evidence }, treeInventorySha256: inventoryRef.sha256,
        engineVersion: entry.engineVersion, compilerVersion: entry.compilerVersion,
        runnerSdkVersion: entry.runnerSdkVersion,
        inventory: { path: "inventory.json", sizeBytes: raw.length, sha256: sha(raw) },
        entrySha256: sha(canonicalBytes(entry)), files: entry.files, dependencies: entry.dependencies }, schemas.engine);
    return { root: "engine", inventory: inventoryRef,
        buildReceipt: await writeReleaseJson(context.inputRoot, "release-evidence/engine-receipt.json", receipt) };
}
