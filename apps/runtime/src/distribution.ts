import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { lstat, readFile, readdir, realpath, open } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import type { ExecutionPaths } from "./execution/paths.ts";
import { loadRelease } from "./execution/release.ts";
import { doctor } from "./doctor.ts";
import { isNode24Version, isIndependentNode24 } from "./node-version.ts";
import {
    verifyMacRuntimeManifestV2,
    type MacChromeLayout,
    type MacRuntimeArch,
} from "./distribution-manifest-v2.ts";

/** 安装发行描述只保存经过物理库存校验后的路径和独立版本，签名来源认证由安装器负责而不是由自报清单代替；运行前仍须载入所选引擎库存并验证真实 Node 与浏览器能力。 */
export interface RuntimeDistribution {
    root: string;
    productVersion: string;
    nodeVersion: string;
    engineVersion: string;
    engineDirectory: string;
    browserExecutable: string;
    agentExecutable: string;
    cliExecutable: string;
    agentEntry: string;
    cliEntry: string;
    execution: ExecutionPaths;
}

const nodeIdentities = new WeakMap<RuntimeDistribution, string>();
const nativeCapabilities = new WeakMap<RuntimeDistribution, string>();
const vaultCapabilities = new WeakMap<RuntimeDistribution, string>();
/** 保险库辅助程序只能从已完整核验的固定发行成员获得执行能力，旧库存仍可只读解析但请求此能力必须明确失败；复制发行对象字段、档案路径或环境变量均不能授权源码与全局程序作为替代入口。 */
export function verifiedVaultHelper(distribution: RuntimeDistribution): string {
    const path = vaultCapabilities.get(distribution);
    if (!path) throw new Error("RUNTIME_VAULT_CAPABILITY_UNVERIFIED");
    return path;
}
/** 原生能力只属于本解析器完整核验后返回的发行对象，不能靠具有相同字段的档案 JSON 或调用者自报路径获得；此取值接口不重新搜索源码、全局模块或配置目录，也不把完整性校验误称为发布签名。 */
export function verifiedNativeAddon(distribution: RuntimeDistribution): string {
    const path = nativeCapabilities.get(distribution);
    if (!path) throw new Error("RUNTIME_NATIVE_CAPABILITY_UNVERIFIED");
    return path;
}

/** Mac 安装入口必须由宿主提供独立取得的完整身份与链接布局，不能从待核清单自行推导期望值；摘要只绑定库存字节，安装器仍需在调用前完成发行来源、签名和目标架构的授权。
 * 本类型不包含可跳过核验的选项，也不允许依赖 Electron 自带 Node 推断执行引擎版本。
 */
export type TrustedMacRuntime = Readonly<{
    arch: MacRuntimeArch;
    layout: MacChromeLayout;
    manifestSha256: string;
    productVersion: string;
    nodeVersion: string;
    engineVersion: string;
}>;

/** Mac 正式路径复用第二版库存对 Framework 有限链接的完整核验，再严格匹配宿主交付的独立身份；只有原始返回对象持有原生与保险库能力，字段副本和静态观察结果不能用来装载 addon。
 * 普通独立角色必须同时匹配真实执行路径及精确 Node 版本，Electron 主进程则在自己的签名和身份核验后显式绑定原生能力。
 * guardian 字段沿用执行路径合同，但 Darwin 停止实现使用受控进程证据而不启动 Linux guardian。
 */
export async function loadMacRuntimeDistribution(
    directory: string,
    trusted: TrustedMacRuntime,
): Promise<RuntimeDistribution> {
    const policy = structuredClone(trusted);
    if (process.platform !== "darwin" || process.arch !== policy.arch)
        throw new Error("RUNTIME_HOST_TARGET_MISMATCH");
    if (!/^[0-9a-f]{64}$/.test(policy.manifestSha256))
        throw new Error("RUNTIME_TRUSTED_IDENTITY_INVALID");
    const inventory = await verifyMacRuntimeManifestV2(directory, {
        arch: policy.arch,
        layout: policy.layout,
    });
    const manifest = inventory.manifest;
    if (
        inventory.manifestSha256 !== policy.manifestSha256 ||
        manifest.productVersion !== policy.productVersion ||
        manifest.nodeVersion !== policy.nodeVersion ||
        manifest.engineVersion !== policy.engineVersion
    )
        throw new Error("RUNTIME_TRUSTED_IDENTITY_MISMATCH");
    const files = new Set(manifest.files.map((file) => file.path));
    const take = (name: string) => {
        if (!files.has(name)) throw new Error("RUNTIME_MEMBER_MISSING");
        return join(inventory.root, name);
    };
    take(`engines/${manifest.engineVersion}/inventory.json`);
    const distribution: RuntimeDistribution = {
        root: inventory.root,
        productVersion: manifest.productVersion,
        nodeVersion: manifest.nodeVersion,
        engineVersion: manifest.engineVersion,
        engineDirectory: join(inventory.root, "engines", manifest.engineVersion),
        browserExecutable: take(manifest.browser.executablePath),
        agentExecutable: take("roles/agent/veriq_agent"),
        cliExecutable: take("roles/cli/veriq_cli"),
        agentEntry: take("entry/agent.js"),
        cliEntry: take("entry/cli.js"),
        execution: {
            runnerExecutable: take("roles/runner/veriq_runner"),
            guardianExecutable: take("roles/runner/veriq_runner"),
            npmCli: take("npm/bin/npm-cli.js"),
            tsx: take("node_modules/tsx/dist/loader.mjs"),
            workerEntry: take("execution/worker.mjs"),
            providerEntry: take("execution/provider.mjs"),
            compileEntry: take("execution/compile-entry.mjs"),
        },
    };
    nodeIdentities.set(distribution, manifest.nodeVersion);
    nativeCapabilities.set(distribution, take("native/veriq_private_files.node"));
    vaultCapabilities.set(distribution, take("native/vault/veriq_agent"));
    const role = basename(process.execPath);
    if (["veriq_agent", "veriq_cli", "veriq_runner"].includes(role)) {
        const wanted =
            role === "veriq_agent"
                ? distribution.agentExecutable
                : role === "veriq_cli"
                  ? distribution.cliExecutable
                  : distribution.execution.runnerExecutable;
        if (
            resolve(process.execPath) !== wanted ||
            !isIndependentNode24(process.versions) ||
            process.versions.node !== manifest.nodeVersion
        )
            throw new Error("RUNTIME_ROLE_MISMATCH");
        const { bindDarwinDistribution } = await import("./native/darwin.ts");
        bindDarwinDistribution(distribution);
    }
    Object.freeze(distribution.execution);
    return Object.freeze(distribution);
}

/** 安装命令行从 Runtime 之外的固定桌面发行描述读取独立 Mac 策略，不能从待核 runtime-manifest 推导链接许可或期望摘要；描述本身的来源认证仍由安装、签名和可信启动路径负责。
 * 非 Mac 保留已有第一版加载合同，缺少桌面描述的 Mac 包明确失败，不退回源码 Node、全局 Chrome 或自报清单。
 */
export async function loadInstalledRuntimeDistribution(
    directory: string,
): Promise<RuntimeDistribution> {
    if (process.platform !== "darwin") return loadRuntimeDistribution(directory);
    const parent = resolve(directory, "..");
    if ((await realpath(parent)) !== parent) throw new Error("RUNTIME_LINK_FORBIDDEN");
    const descriptor = await member(parent, "desktop-release.json");
    const info = await lstat(descriptor, { bigint: true });
    if (info.nlink !== 1n || info.size > 1024n * 1024n)
        throw new Error("RUNTIME_RELEASE_DESCRIPTOR_INVALID");
    const handle = await open(
        descriptor,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
        const opened = await handle.stat({ bigint: true });
        if (
            !opened.isFile() ||
            opened.dev !== info.dev ||
            opened.ino !== info.ino ||
            opened.size !== info.size
        )
            throw new Error("RUNTIME_RELEASE_DESCRIPTOR_CHANGED");
        const buffer = Buffer.alloc(Number(info.size) + 1);
        let position = 0;
        while (position < buffer.length) {
            const result = await handle.read(buffer, position, buffer.length - position, position);
            if (!result.bytesRead) break;
            position += result.bytesRead;
        }
        const settled = await handle.stat({ bigint: true });
        if (
            position !== Number(info.size) ||
            settled.size !== info.size ||
            settled.mtimeNs !== info.mtimeNs ||
            settled.ctimeNs !== info.ctimeNs ||
            settled.mode !== info.mode ||
            settled.nlink !== 1n
        )
            throw new Error("RUNTIME_RELEASE_DESCRIPTOR_CHANGED");
        bytes = buffer.subarray(0, position);
    } finally {
        await handle.close();
    }
    const value = JSON.parse(bytes.toString("utf8")) as { trustedRuntime?: TrustedMacRuntime };
    if (!value?.trustedRuntime) throw new Error("RUNTIME_TRUSTED_IDENTITY_REQUIRED");
    return loadMacRuntimeDistribution(directory, value.trustedRuntime);
}

/** 清单内所有成员必须是可移植的普通相对路径，不能引用父目录、盘符或 NTFS 备用数据流；这条检查在任何宿主上使用同一规则，避免 Linux 生产器认可 Windows 会另行解释的路径。 */
function portable(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 1024 &&
        !/[\\:\x00-\x1f\x7f]/.test(value) &&
        value
            .split("/")
            .every((part) => !!part && part !== "." && part !== ".." && !/[. ]$/.test(part))
    );
}

/** 物理成员逐级拒绝链接并确认中间节点是目录，独立 Node 无法读取 Electron ASAR 内的虚拟资源；最终文件哈希用流计算以避免浏览器和角色二进制把整个内存一次性占满。 */
async function member(root: string, name: string) {
    let path = root;
    const parts = name.split("/");
    for (const [index, part] of parts.entries()) {
        path = join(path, part);
        const info = await lstat(path);
        if (info.isSymbolicLink()) throw new Error("RUNTIME_LINK_FORBIDDEN");
        if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())
            throw new Error("RUNTIME_FILE_MISMATCH");
    }
    return path;
}

/** 运行发行必须完整核对清单中列出的真实文件，所有执行角色及引擎库存也必须属于该列表；未知或缺失目标不能退回开发工作区，校验结果只是完整性事实而不冒充正式发布签名。 */
export async function loadRuntimeDistribution(directory: string): Promise<RuntimeDistribution> {
    const root = resolve(directory);
    if ((await realpath(root)) !== root) throw new Error("RUNTIME_LINK_FORBIDDEN");
    const info = await lstat(root);
    if (info.isSymbolicLink()) throw new Error("RUNTIME_LINK_FORBIDDEN");
    if (!info.isDirectory() || root.split(/[\\/]/).some((part) => part.endsWith(".asar")))
        throw new Error("RUNTIME_DIRECTORY_INVALID");
    const manifestPath = await member(root, "runtime-manifest.json");
    if ((await lstat(manifestPath)).size > 1024 * 1024) throw new Error("RUNTIME_MANIFEST_INVALID");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const version = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
    if (
        manifest.schemaVersion !== 1 ||
        !isNode24Version(manifest.nodeVersion) ||
        manifest.platform !== process.platform ||
        manifest.arch !== process.arch ||
        !version.test(manifest.productVersion ?? "") ||
        !version.test(manifest.engineVersion ?? "") ||
        !Array.isArray(manifest.files) ||
        manifest.files.length > 20000
    )
        throw new Error("RUNTIME_MANIFEST_INVALID");
    const paths = new Map<string, string>();
    for (const entry of manifest.files) {
        if (
            !entry ||
            !portable(entry.path) ||
            paths.has(entry.path) ||
            !Number.isSafeInteger(entry.sizeBytes) ||
            entry.sizeBytes < 0 ||
            entry.sizeBytes > 2 * 1024 * 1024 * 1024 ||
            typeof entry.sha256 !== "string" ||
            !/^[0-9a-f]{64}$/.test(entry.sha256)
        )
            throw new Error("RUNTIME_MANIFEST_INVALID");
        const path = await member(root, entry.path);
        if ((await lstat(path)).size !== entry.sizeBytes) throw new Error("RUNTIME_FILE_MISMATCH");
        const hash = createHash("sha256");
        for await (const bytes of createReadStream(path)) hash.update(bytes);
        if (hash.digest("hex") !== entry.sha256) throw new Error("RUNTIME_FILE_MISMATCH");
        paths.set(entry.path, path);
    }
    /** 目录中多出的代码可能通过 Node 的依赖查找改变执行结果，所以完整性检查不仅验证已列成员，还必须递归拒绝未登记文件；清单本身是唯一例外，目录链接在展开之前立即拒绝。 */
    async function inventory(directory: string, prefix = "") {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const name = prefix + entry.name;
            if (entry.isSymbolicLink()) throw new Error("RUNTIME_LINK_FORBIDDEN");
            if (entry.isDirectory()) await inventory(join(directory, entry.name), name + "/");
            else if (!entry.isFile() || (!paths.has(name) && name !== "runtime-manifest.json"))
                throw new Error("RUNTIME_UNLISTED_MEMBER");
        }
    }
    await inventory(root);
    const take = (name: string) => {
        const path = paths.get(name);
        if (!path) throw new Error("RUNTIME_MEMBER_MISSING");
        return path;
    };
    const suffix = process.platform === "win32" ? ".exe" : "";
    const engineDirectory = join(root, "engines", manifest.engineVersion);
    take(`engines/${manifest.engineVersion}/inventory.json`);
    take("execution/archive.mjs");
    /** Worker 用普通 Node 相对加载同一受审命令闭包，全部运行成员必须先核库存；声明文件只服务类型检查而不属于安装执行依赖，缺失任何 MJS 均不能退回源码目录。 */
    for (const name of [
        "controlled-command.mjs",
        "controlled-child.mjs",
        "controlled-child-protocol.mjs",
        "controlled-child-preload.mjs",
    ])
        take("execution/" + name);
    const distribution: RuntimeDistribution = {
        root,
        productVersion: manifest.productVersion,
        nodeVersion: manifest.nodeVersion,
        engineVersion: manifest.engineVersion,
        engineDirectory,
        browserExecutable: take(
            process.platform === "win32"
                ? "browser/chrome-win64/chrome.exe"
                : "browser/chrome-linux64/chrome",
        ),
        agentExecutable: take(`roles/agent/veriq_agent${suffix}`),
        cliExecutable: take(`roles/cli/veriq_cli${suffix}`),
        agentEntry: take("entry/agent.js"),
        cliEntry: take("entry/cli.js"),
        execution: {
            runnerExecutable: take(`roles/runner/veriq_runner${suffix}`),
            guardianExecutable: take(`native/veriq_runner${suffix}`),
            npmCli: take("npm/bin/npm-cli.js"),
            tsx: take("node_modules/tsx/dist/loader.mjs"),
            workerEntry: take("execution/worker.mjs"),
            providerEntry: take("execution/provider.mjs"),
            compileEntry: take("execution/compile-entry.mjs"),
        },
    };
    /** 具体 Node 身份仅在完整物理库存通过后绑定到原始返回对象，公开版本只供诊断展示；浅复制或手工修改字段不能继承这个能力，后续角色检查仍要求真实进程与该私有版本完全一致。 */
    nodeIdentities.set(distribution, manifest.nodeVersion);
    /** Windows 原生成员必须属于完整库存，真实安装角色还须先匹配物理执行路径才绑定；普通 Node 的只读解析不会装载自报目录中的代码，Electron 则由可信资源入口显式绑定后才读取档案。 */
    if (process.platform === "win32") {
        nativeCapabilities.set(distribution, take("native/veriq_native.node"));
        const role = basename(process.execPath)
            .replace(/\.exe$/i, "")
            .toLowerCase();
        if (["veriq_agent", "veriq_cli", "veriq_runner"].includes(role)) {
            const expected =
                role === "veriq_agent"
                    ? distribution.agentExecutable
                    : role === "veriq_cli"
                      ? distribution.cliExecutable
                      : distribution.execution.runnerExecutable;
            if (
                resolve(process.execPath) !== expected ||
                !isIndependentNode24(process.versions) ||
                process.versions.node !== nodeIdentities.get(distribution)
            )
                throw new Error("RUNTIME_ROLE_MISMATCH");
            const { bindWindowsDistribution } = await import("./native/windows.ts");
            bindWindowsDistribution(distribution);
        }
    }
    const vaultMember = `native/vault/veriq_agent${suffix}`;
    if (["linux", "win32"].includes(process.platform) && paths.has(vaultMember))
        vaultCapabilities.set(distribution, take(vaultMember));
    return Object.freeze(distribution);
}

/** CLI、云端与桌面使用同一发行自检流程，必须先完整装载选定引擎才向已有浏览器探测提供组件版本；只有所有实际检查成功才申报库存 engineVersion，不能把 SDK 包号当成运行发行身份。 */
export async function diagnoseRelease(options: {
    engineDirectory: string;
    engineVersion: string;
    browserExecutable: string;
    server?: string;
    signal?: AbortSignal;
    /** Mac 发行诊断必须显式借用原始库存对象和真实观察器能力，不能通过版本文本推断可执行平台；该上下文只改变已核安装路径的自检分支，来源批准及签名安装仍由外层发行任务负责。
     * 其它平台保留既有行为，未提供上下文的 Darwin 仍按旧路径失败关闭。
     */
    runtime?: RuntimeDistribution;
    darwinSource?: import("./execution/darwin-source.ts").DarwinSourceCapability;
}) {
    const release = await loadRelease(options.engineDirectory, options.engineVersion);
    const result = await doctor({
        executablePath: options.browserExecutable,
        ...(options.server ? { server: options.server } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        distribution: release.entry,
        expectedBrowserVersion: "158.0.8127.18",
        ...(options.runtime ? { runtime: options.runtime } : {}),
        ...(options.darwinSource ? { darwinSource: options.darwinSource } : {}),
    });
    result.checks.push({
        name: "Production engine inventory",
        ok: true,
        detail: release.entry.engineVersion + " " + release.inventoryHash,
    });
    if (result.capabilities) result.capabilities.engineVersion = release.entry.engineVersion;
    return result;
}

/** 已安装的独立入口必须由对应物理角色 Node 执行，不能以 Electron 内置 Node 或另一个同版本系统 Node 冒充；路径校验配合此前库存摘要，失败时不注册设备也不进入工作领取循环。 */
export function assertRuntimeRole(distribution: RuntimeDistribution, role: "agent" | "cli") {
    const wanted = role === "agent" ? distribution.agentExecutable : distribution.cliExecutable;
    if (
        resolve(process.execPath) !== wanted ||
        !isIndependentNode24(process.versions) ||
        process.versions.node !== nodeIdentities.get(distribution)
    )
        throw new Error("RUNTIME_ROLE_MISMATCH");
}
