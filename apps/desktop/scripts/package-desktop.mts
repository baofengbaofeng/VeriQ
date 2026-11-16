import { build, Platform, Arch } from "electron-builder";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    cp,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    realpath,
    rm,
    statfs,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readBoundedRegularFile } from "../src/installation/bounded-file.ts";
import { parseDesktopRelease, type DesktopRelease } from "../src/installation/release.ts";
import { loadRuntimeDistribution } from "../../runtime/src/distribution.ts";
import { verifyMacRuntimeManifestV2 } from "../../runtime/src/distribution-manifest-v2.ts";
import { desktopInventory } from "./desktop-inventory.mjs";
import { desktopBuilderConfiguration } from "../electron-builder.config.mjs";

type Expected = DesktopRelease & { runtimeReceiptSha256: string };

/** 打包入口只消费操作者显式提供的已构建 GUI、真实 Runtime 和独立期望文件，拒绝任何隐式最新目录或仅凭文件名的成功；这不
 * 是另一个引擎生产器，所有执行字节沿用 Runtime 已有库存合同。目标由期望指定并与宿主完全匹配，
 * Mac 两架构必须分别在真实目标构建。每个参数只能出现一次，不接受环境变量偷偷覆盖候选根或签名模式。签名选择和外部批准内
 * 容必须一致，未配置证书时保留候选失败而不降级。CLI 没有 publish、跳过库存和生成 expected
 * 的开关。
 */
function argumentsOf(args: string[]): Map<string, string> {
    /** 参数名集合故意不提供跳过验证、自动挑选候选或执行发布选项，缺少任一核心位置都必须在读取大资源之前失败；额外签名参
     * 数仅用于明确的原生签名模式，不会让 JSON 内的自报状态改变操作范围。每次循环消费一个键值对，
     * 奇数长度或第二个开关当值都会拒绝。Map 保留是否已经出现的事实，重复参数不能悄悄覆盖前一个来源。核心五个文件位置全
     * 部要求绝对路径，签名模式则必须是显式文本。不从 process.env 补齐这些材料，
     * 后续资源核验仍会检查真实物理根。
     */
    const permitted = [
        "--expected",
        "--runtime",
        "--receipt",
        "--gui",
        "--output",
        "--signing",
        "--identity",
        "--installer-identity",
    ];
    const flags = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index]!,
            value = args[index + 1];
        if (!permitted.includes(key) || flags.has(key) || !value || value.startsWith("--"))
            throw new Error("DESKTOP_PACKAGE_ARGUMENT_INVALID");
        flags.set(key, value);
    }
    for (const key of permitted.slice(0, 6))
        if (!flags.has(key)) throw new Error("DESKTOP_PACKAGE_ARGUMENT_MISSING");
    for (const key of permitted.slice(0, 5))
        if (!isAbsolute(flags.get(key)!)) throw new Error("DESKTOP_PACKAGE_PATH_INVALID");
    return flags;
}

/** 外部身份和回执是有界普通 JSON 文件，符号链接及非规范祖先直接拒绝；不从待核验 Runtime 中寻找期望，也不让一个无限增长
 * 的回执在 JSON 解析之前耗尽内存。上层还会核对回执原始摘要，而不重新序列化后宣称绑定同一材料。
 * 真实运行结果与静态组装回执严格区分，后者不会被本入口提升为验收完成。
 */
async function bounded(path: string): Promise<Buffer> {
    return readBoundedRegularFile(path, 16 * 1024 * 1024);
}

/** 清单摘要首先与独立期望精确相同，再调用原有全树验证器核对所有真实成员；Mac 保留受信布局的有限 Framework 链接规则，
 * Windows 与 Linux 沿用拒绝所有链接及额外文件的第一版完整库存。核验不会调用浏览器、
 * Agent、Keychain 或开发入口，不把静态完整性当成目标执行验收。产品、独立 Node 与引擎三个版本逐项相等，防止组合其它候选
 * 的库存与资源。builder 复制后的实际资源树还会再次执行本函数，
 * 避免只核对源目录却漏掉打包变换。
 */
async function verifyRuntime(root: string, expected: Expected): Promise<void> {
    /** 原始清单摘要必须先匹配外部身份，随后全树验证器才解释成员与目标，避免拿其它合法发行的清单拼接当前候选；这里不重新
     * 生成 inventory，也不把包内新增文件忽略为诊断材料。同一个 verifier 同时服务输入副本和
     * builder 已暂存输出。Mac 的有限 Framework 链接必须来自外部 layout，不能从 manifest 扩张许可。Windows 和 Linux 保
     * 持原版本清单对额外文件与链接的拒绝语义。具体 Node
     * 版本与产品和引擎版本分开比较，兼容主版本不能替代精确身份。
     */
    const bytes = await bounded(join(root, "runtime-manifest.json"));
    if (createHash("sha256").update(bytes).digest("hex") !== expected.trustedRuntime.manifestSha256)
        throw new Error("DESKTOP_RUNTIME_IDENTITY_MISMATCH");
    if (expected.platform === "darwin") {
        const inventory = await verifyMacRuntimeManifestV2(root, {
            arch: expected.arch,
            layout: expected.trustedRuntime.layout!,
        });
        const manifest = inventory.manifest;
        if (
            manifest.productVersion !== expected.productVersion ||
            manifest.nodeVersion !== expected.trustedRuntime.nodeVersion ||
            manifest.engineVersion !== expected.trustedRuntime.engineVersion
        )
            throw new Error("DESKTOP_RUNTIME_VERSION_MISMATCH");
    } else {
        const distribution = await loadRuntimeDistribution(root);
        if (
            distribution.productVersion !== expected.productVersion ||
            distribution.nodeVersion !== expected.trustedRuntime.nodeVersion ||
            distribution.engineVersion !== expected.trustedRuntime.engineVersion
        )
            throw new Error("DESKTOP_RUNTIME_VERSION_MISMATCH");
    }
}

/** 独立 Runtime 的依赖树必须已经物理闭合，GUI 宿主复用同一份受核字节而不从开发 node_modules 查找第三方包；顶层版本由真
 * 实 package.json 读取，避免 pnpm工作区链接进入安装包或触发第二次在线解析。
 * 本步骤只生成 Electron 应用的依赖声明，不重新安装、解析版本范围或执行包脚本。工作区代码已经由现有 Vite 入口编译进宿主
 * 产物，所以不把 workspace 协议交给安装器。原生依赖保持目标产物，不让
 * electron-builder 根据宿主猜测后自动重编。
 */
async function dependencies(root: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const packages = join(root, "node_modules");
    async function item(name: string) {
        if (name.startsWith("@veriq/")) return;
        const file = join(packages, name, "package.json");
        const manifest = JSON.parse((await bounded(file)).toString("utf8"));
        if (manifest.name !== name || typeof manifest.version !== "string")
            throw new Error("DESKTOP_DEPENDENCY_INVALID");
        result[name] = manifest.version;
    }
    for (const entry of await readdir(packages, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink())
            throw new Error("DESKTOP_DEPENDENCY_INVALID");
        if (entry.name.startsWith("@"))
            for (const child of await readdir(join(packages, entry.name)))
                await item(entry.name + "/" + child);
        else await item(entry.name);
    }
    return result;
}

/** 外部期望只允许位于候选和 GUI 树之外，回执必须绑定真实来源提交、目标和清单摘要；完成后仍标记 PACKAGED_UNVERIFIED，安
 * 装器签名与全部发布门禁不能由一次打包返回值替代。GUI 和 Runtime
 * 均先复制到本次自有临时目录再复验，未知旧输出不覆盖。输出父目录要求已经存在且没有链接，本候选目录独占创建，失败现场保
 * 留供后续排查。临时目录只由本次命令拥有，finally 不删除调用者输入、旧候选或外置用户数据。发布器永不运行，
 * Electron 获取能力仍受调用者环境与已有缓存约束。
 */
async function main(): Promise<void> {
    const flags = argumentsOf(process.argv.slice(2));
    /** 独立期望由操作者在前置审核阶段提供而本命令只读取，运行时解析检查固定产品身份与四种目标组合；没有期望文件时不能扫
     * 描目录后自动把所见字节提升为可安装授权。本层不会检查 Git 工作区是否干净，更不会修改根锁或并发实现者的源码。
     * sourceCommit 只是外层审批绑定的身份，真实来源字节必须已由 Runtime 准入链证明。Runtime 外部 receipt 和 GUI 摘要在
     * 后续分别核验，不以单一版本字符串替代。包装成安装器后仍保留
     * PACKAGED_UNVERIFIED，执行验收与发布保持独立。
     */
    const expectedPath = flags.get("--expected")!;
    const expected = JSON.parse((await bounded(expectedPath)).toString("utf8")) as Expected;
    const release = parseDesktopRelease(expected);
    if (process.platform !== release.platform || process.arch !== release.arch)
        throw new Error("DESKTOP_NATIVE_TARGET_REQUIRED");
    if (flags.get("--signing") !== release.signing.mode)
        throw new Error("DESKTOP_SIGNING_MODE_MISMATCH");
    /** 签名模式必须与独立期望相同且原生身份必须逐字匹配，Mac 应用证书与 pkg Installer 证书分别提供；Linux 没有这个原生
     * 签名协议，所以明确要求独立清单签名而不生成误导的 native-signed 状态。
     * 未签名或 ad-hoc 候选拒绝额外 identity 参数，避免意外使用生产证书。不接收证书密码参数，不从输出打印任何签名环境变
     * 量。两种 Mac 架构各自在原生宿主执行，不借跨架构配置掩盖未完成目标构建。这些检查只决定
     * builder 配置，不能替代最终安装器原生签名验收。
     */
    const identity = flags.get("--identity"),
        installerIdentity = flags.get("--installer-identity");
    if (
        release.signing.mode === "NATIVE_SIGNED" &&
        (!identity ||
            identity !== release.signing.identity ||
            (release.platform === "darwin" && !installerIdentity))
    )
        throw new Error("DESKTOP_SIGNING_IDENTITY_REQUIRED");
    if (release.signing.mode === "NATIVE_SIGNED" && release.platform === "linux")
        throw new Error("DESKTOP_LINUX_DETACHED_SIGNING_REQUIRED");
    if (release.signing.mode !== "NATIVE_SIGNED" && (identity || installerIdentity))
        throw new Error("DESKTOP_SIGNING_MODE_MISMATCH");
    const runtime = flags.get("--runtime")!,
        gui = flags.get("--gui")!;
    /** expected 必须位于候选父树和 GUI 树之外，路径关系用组件计算而不是容易误判的字符串前缀；这不能自动证明审核者身份，
     * 却能拒绝把候选自产文件直接作为它自己的政策来源。candidate 名称还必须等于 Runtime
     * 的实际父目录名，旧目录不会被新身份复用。runtime-manifest 的摘要另行比较，目录命名符合不能成为库存成功依据。外部
     * 回执可以位于候选旁边，因为它只是材料而不是自举授权来源。
     * 这份位置限制不会删除或移动调用者提供的任何输入。
     */
    for (const tree of [dirname(runtime), gui]) {
        const path = relative(resolve(tree), resolve(expectedPath));
        if (path === "" || (!path.startsWith("..") && !isAbsolute(path)))
            throw new Error("DESKTOP_INDEPENDENT_EXPECTED_REQUIRED");
    }
    if (basename(dirname(runtime)) !== expected.candidate)
        throw new Error("DESKTOP_CANDIDATE_MISMATCH");
    /** 回执必须绑定原始字节摘要后再逐项匹配目标、来源和清单，额外的生产命令证据仍保留在外部材料中；不把一次 JSON 解析成
     * 功、路径存在或自报 committed 当作完整发行真实性。Mac 沿用已有
     * payload-receipt，不重写历史准入字段。Windows/Linux 使用原生产者同形合同，不能给 Mac 回执换平台标签冒充真实材料。
     * 每个版本字段都参与比较，回执和 Runtime 不能混合两个候选。本入口没有
     * issuer 配置，也没有引擎晋升或正式 release 授权动作。
     */
    const receiptBytes = await bounded(flags.get("--receipt")!);
    if (
        !/^[0-9a-f]{64}$/.test(expected.runtimeReceiptSha256 ?? "") ||
        createHash("sha256").update(receiptBytes).digest("hex") !== expected.runtimeReceiptSha256
    )
        throw new Error("DESKTOP_RECEIPT_IDENTITY_MISMATCH");
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    if (
        receipt.target?.platform !== expected.platform ||
        receipt.target?.arch !== expected.arch ||
        receipt.target?.productVersion !== expected.productVersion ||
        receipt.target?.nodeVersion !== expected.trustedRuntime.nodeVersion ||
        receipt.target?.engineVersion !== expected.trustedRuntime.engineVersion ||
        receipt.source?.commit !== expected.sourceCommit ||
        receipt.runtimeManifestSha256 !== expected.trustedRuntime.manifestSha256
    )
        throw new Error("DESKTOP_RECEIPT_IDENTITY_MISMATCH");
    await verifyRuntime(runtime, expected);
    if ((await desktopInventory(gui)).sha256 !== expected.guiInventorySha256)
        throw new Error("DESKTOP_GUI_IDENTITY_MISMATCH");
    const output = resolve(flags.get("--output")!);
    if ((await realpath(dirname(output))) !== dirname(output))
        throw new Error("DESKTOP_OUTPUT_PATH_INVALID");
    await mkdir(output);
    /** 可用空间按真实清单大小提高最低预算，并分别检查输出与临时文件系统，不能把压缩包标称尺寸当成安装空间承诺；不足时保
     * 留明确失败，绝不清理旧候选、共享缓存或用户档案换取空间。源码材料在前一步已经过完整清单验证，
     * 累计大小不信任未校验输入。四倍 Runtime 预算覆盖角色副本、安装器暂存和应用依赖副本的主要开销。两 GiB 额外空间为
     * Electron、GUI 和工具暂存留余量，实际验收还要记录峰值。输出目录独占创建，
     * 不允许复用未知旧目录掩盖先前失败。
     */
    const runtimeManifest = JSON.parse(
        (await bounded(join(runtime, "runtime-manifest.json"))).toString("utf8"),
    );
    const runtimeBytes = runtimeManifest.files.reduce(
        (total: number, file: { sizeBytes: number }) => total + file.sizeBytes,
        0,
    );
    const reserve = BigInt(
        Math.max(12 * 1024 * 1024 * 1024, runtimeBytes * 4 + 2 * 1024 * 1024 * 1024),
    );
    for (const path of [output, await realpath(tmpdir())]) {
        const disk = await statfs(path, { bigint: true });
        if (disk.bavail * disk.bsize < reserve)
            throw new Error("DESKTOP_PACKAGE_DISK_RESERVE_REQUIRED");
    }
    const temporary = await mkdtemp(join(await realpath(tmpdir()), "veriq-desktop-"));
    try {
        const appDirectory = join(temporary, "app"),
            runtimeDirectory = join(temporary, "runtime"),
            releaseFile = join(temporary, "desktop-release.json");
        await mkdir(appDirectory);
        /** 本次独有临时目录只承载真实已审核输入的副本，复制完成后复验目标位置而不是沿用源目录结果；GUI 的所有本地
         * worker 与资源进入同一库存，Runtime 则保持原始 POSIX 模式和有限链接布局。Mac
         * 临时根先 realpath，避免系统 /var 或 /tmp 别名破坏严格无链接路径合同。cp 不对 Runtime 做 dereference，合法
         * Framework 链接要保留原始 target。
         * 复制后全树检查会发现文件变化、缺少模式或多余成员，不能凭 copy 返回就成功。临时目录和用户输出不同，finally 只
         * 清理本次 mkdtemp 的拥有物。
         */
        await cp(gui, join(appDirectory, "out"), { recursive: true, dereference: false });
        await cp(runtime, runtimeDirectory, {
            recursive: true,
            dereference: false,
            preserveTimestamps: true,
        });
        await verifyRuntime(runtimeDirectory, expected);
        if (
            (await desktopInventory(join(appDirectory, "out"))).sha256 !==
            expected.guiInventorySha256
        )
            throw new Error("DESKTOP_GUI_IDENTITY_MISMATCH");
        /** GUI 主进程所需第三方包复用已核 Runtime 的物理生产依赖，不让 builder 解析开发工作区软链接或自行安装；
         * @electron/fuses 已由现有 Vite 配置内联，GUI 专用
         * React资源也已打入本地 renderer。root package.json 只为 Electron 描述应用入口与真实依赖版本，不携带开发脚本。
         * 产品 LICENSE 和 NOTICE 由 GUI stage
         * 复制并参与先前摘要，打包后仍保留原文本。不将独立 Agent 的执行根换成 ASAR，后台仍从原 resources/runtime 工作
         * 。后续独立验收必须检查动态解析闭包，而不能仅看依赖目录数量。
         */
        await cp(join(runtimeDirectory, "node_modules"), join(appDirectory, "node_modules"), {
            recursive: true,
            dereference: false,
        });
        await writeFile(
            join(appDirectory, "package.json"),
            JSON.stringify(
                {
                    name: "veriq",
                    productName: "VeriQ",
                    version: expected.productVersion,
                    description: "VeriQ desktop workspace",
                    author: "VeriQ contributors",
                    homepage: "https://github.com/baofengbaofeng/VeriQ",
                    license: "AGPL-3.0-only",
                    type: "module",
                    main: "out/main/index.js",
                    dependencies: await dependencies(runtimeDirectory),
                },
                null,
                4,
            ) + "\n",
        );
        const { runtimeReceiptSha256: _receipt, ...installedRelease } = expected;
        await writeFile(releaseFile, JSON.stringify(installedRelease, null, 4) + "\n");
        const config = desktopBuilderConfiguration({
            appDirectory,
            runtimeDirectory,
            releaseFile,
            outputDirectory: output,
            release,
            signing: {
                mode: release.signing.mode,
                ...(identity ? { identity } : {}),
                ...(installerIdentity ? { installerIdentity } : {}),
            },
        });
        /** 每个 builder 阶段都定位实际应用内的 Runtime 资源并复用原 expected，签名工具若改写任何 Node、原生或 Chrome 字
         * 节就失败；这里不采用
         * afterSign重新出清单的方式给改变后的文件自动授权。Mac 真实技术包名由小写 executableName 推导为 veriq.app，显
         * 示名另设 VeriQ。Windows 与 Linux 的
         * resources 位置按 builder 标准布局取得。signIgnore 保持 Runtime 自己的签名，GUI fuse 与主壳签名不进入这个库存
         * 。真实安装资源和最终归档仍要在目标验收再次核对，hook
         * 不是正式通过报告。
         */
        const checkPackaged = async (context: { appOutDir: string }) => {
            const resources =
                expected.platform === "darwin"
                    ? join(context.appOutDir, "veriq.app", "Contents/Resources")
                    : join(context.appOutDir, "resources");
            await verifyRuntime(join(resources, "runtime"), expected);
        };
        const platform =
            expected.platform === "darwin"
                ? Platform.MAC
                : expected.platform === "win32"
                  ? Platform.WINDOWS
                  : Platform.LINUX;
        /** 未签名模式不能因构建机偶然设置 CSC_LINK 而动用生产凭据，所以先保存有限环境键并在调用期间显式清除；所有模式关
         * 闭自动证书发现，只允许命令行已经匹配的身份参与签名。密码和证书内容绝不进入日志或结果文件。
         * finally 恢复原环境值，失败也不会污染这个进程中后续清理步骤。NATIVE_SIGNED 保留显式配置的证书存储能力，但本命
         * 令不申请或导入证书。builder 始终 publish=never，
         * 完成安装器也不会启动发布器。
         */
        const signingNames = [
            "CSC_LINK",
            "WIN_CSC_LINK",
            "CSC_KEY_PASSWORD",
            "WIN_CSC_KEY_PASSWORD",
            "CSC_NAME",
            "CSC_IDENTITY_AUTO_DISCOVERY",
        ];
        const signingEnvironment = new Map(signingNames.map((name) => [name, process.env[name]]));
        if (release.signing.mode !== "NATIVE_SIGNED")
            for (const name of signingNames) delete process.env[name];
        process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
        let artifacts: string[];
        try {
            artifacts = await build({
                targets: platform.createTarget(
                    undefined,
                    expected.arch === "arm64" ? Arch.arm64 : Arch.x64,
                ),
                config: { ...config, afterPack: checkPackaged, afterSign: checkPackaged },
                publish: "never",
            });
        } finally {
            for (const [name, value] of signingEnvironment) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
        /** 返回列表必须含当前目标真正的安装器且每个产物都是本次输出根内的普通文件，再流式计算最终摘要；空目录、其它平台
         * 扩展名或指向外部的链接不能产生形式上成功的包装结果。NSIS 可能另有附属产物，
         * 所以保留全部真实返回文件的摘要和大小。输出清单只描述当前字节，不把签名模式字段当成系统验签结论。status 固定
         * 未验收，测试、安装、可信来源和发布许可都不能从这里推导。未知错误只输出稳定英文分类，
         * 避免泄露私有路径或原始签名工具消息。
         */
        const extension =
            expected.platform === "darwin"
                ? ".pkg"
                : expected.platform === "win32"
                  ? ".exe"
                  : ".deb";
        if (!artifacts.some((file) => file.endsWith(extension)))
            throw new Error("DESKTOP_INSTALLER_OUTPUT_MISSING");
        const files = [];
        for (const file of artifacts) {
            const path = relative(output, resolve(file));
            const info = await lstat(file);
            if (
                path.startsWith("..") ||
                isAbsolute(path) ||
                !info.isFile() ||
                info.isSymbolicLink()
            )
                throw new Error("DESKTOP_INSTALLER_OUTPUT_INVALID");
            const hash = createHash("sha256");
            for await (const bytes of createReadStream(file)) hash.update(bytes);
            files.push({
                name: basename(file),
                sizeBytes: (await lstat(file)).size,
                sha256: hash.digest("hex"),
            });
        }
        await writeFile(
            join(output, "desktop-package-result.json"),
            JSON.stringify(
                {
                    schemaVersion: 1,
                    status: "PACKAGED_UNVERIFIED",
                    candidate: expected.candidate,
                    sourceCommit: expected.sourceCommit,
                    platform: expected.platform,
                    arch: expected.arch,
                    signingMode: expected.signing.mode,
                    runtimeReceiptSha256: expected.runtimeReceiptSha256,
                    runtimeManifestSha256: expected.trustedRuntime.manifestSha256,
                    guiInventorySha256: expected.guiInventorySha256,
                    files,
                },
                null,
                4,
            ) + "\n",
        );
        process.stdout.write(
            JSON.stringify({ status: "PACKAGED_UNVERIFIED", output, artifacts: files.length }) +
                "\n",
        );
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}
main().catch((error: unknown) => {
    process.stderr.write(
        `VeriQ desktop packaging failed: ${
            error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
                ? error.message
                : "DESKTOP_PACKAGE_FAILED"
        }\n`,
    );
    process.exitCode = 1;
});
