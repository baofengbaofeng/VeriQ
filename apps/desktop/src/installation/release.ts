import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readBoundedRegularFile } from "./bounded-file";
import { createPublicKey } from "node:crypto";
import {
    loadRuntimeDistribution,
    loadMacRuntimeDistribution,
    type RuntimeDistribution,
} from "../../../runtime/src/distribution.ts";
import type { MacChromeLayout } from "../../../runtime/src/distribution-manifest-v2.ts";

/**
 * 安装身份由构建命令核对独立期望后随原生安装包一起携带，摘要仅代表字节一致而发布者真实性仍来自安装器签名；普通档案、环境覆盖和业务包都不能替换此处的固定资源成员。
 * candidate 保留不可变候选名，sourceCommit 指向实际源码而非 GUI 自报版本。
 * productVersion 与独立 Node、engineVersion 分别保存，避免更新桌面时偷偷更换引擎。
 * trustedRuntime.layout 来自独立审核输入，不能从待校验的 Mac 清单自举链接政策。
 * 更新公钥只允许 Ed25519，缺少公钥时禁用人工安装更新入口而不尝试在线取得信任。
 * DEVELOPMENT_UNSIGNED 与 AD_HOC 均不表示正式可发布，诊断和交接一直保留这个区别。
 */
export interface DesktopRelease {
    schemaVersion: 1;
    appId: "io.github.baofengbaofeng.veriq";
    productName: "VeriQ";
    candidate: string;
    sourceCommit: string;
    platform: "darwin" | "win32" | "linux";
    arch: "x64" | "arm64";
    productVersion: string;
    signing: { mode: "DEVELOPMENT_UNSIGNED" | "AD_HOC" | "NATIVE_SIGNED"; identity?: string };
    guiInventorySha256: string;
    profileFormat: 2;
    updatePublicKeyPem?: string;
    trustedRuntime: {
        arch: "x64" | "arm64";
        manifestSha256: string;
        productVersion: string;
        nodeVersion: string;
        engineVersion: string;
        layout?: MacChromeLayout;
    };
}

/**
 * 资源描述读取前核对实际普通文件、大小与固定安装身份，再验证目标宿主和版本关系；验证失败直接中止，不能通过已运行 Agent 或开发环境路径绕过这个安装入口的完整性要求。
 * 此函数只解析身份，不装载原生模块，也不运行任何证书或信任库工具。
 * 明确限制 JSON 到一 MiB，拒绝链接和指向其它目录的资源位置。
 * 原生安装包签名负责保护这份描述本身，自签名候选不能借此获得生产来源信任。
 */
export async function readDesktopRelease(resources: string): Promise<DesktopRelease> {
    const root = resolve(resources);
    if ((await realpath(root)) !== root) throw new Error("DESKTOP_RELEASE_PATH_INVALID");
    const file = join(root, "desktop-release.json");
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
        throw new Error("DESKTOP_RELEASE_INVALID");
    return parseDesktopRelease(
        JSON.parse((await readBoundedRegularFile(file, 1024 * 1024)).toString("utf8")),
    );
}

/**
 * 发布描述只允许受支持的四种目标组合并要求 Runtime 身份与桌面版本一致，公钥还必须由标准密码库实际解析；这里不会因为字段存在、文件名正确或自报签名模式就给出正式发行结论。
 * Mac 的两种架构均必须提供独立 Chrome 布局，Windows 与 Ubuntu 只接受 x64。
 * 版本包含可选预发布段，结尾锚定拒绝换行及带路径的任意字符串。
 * 运行时宿主与架构匹配仍由 loadDesktopRuntime 在装载时检查。
 */
export function parseDesktopRelease(input: unknown): DesktopRelease {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("DESKTOP_RELEASE_INVALID");
    const release = input as DesktopRelease;
    const version = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
    const hash = /^[0-9a-f]{64}$/;
    if (
        release.schemaVersion !== 1 ||
        release.appId !== "io.github.baofengbaofeng.veriq" ||
        release.productName !== "VeriQ" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(release.candidate ?? "") ||
        !/^[0-9a-f]{40}$/.test(release.sourceCommit ?? "") ||
        !["darwin", "win32", "linux"].includes(release.platform) ||
        !["x64", "arm64"].includes(release.arch) ||
        (release.platform !== "darwin" && release.arch !== "x64") ||
        !version.test(release.productVersion ?? "") ||
        !hash.test(release.guiInventorySha256 ?? "") ||
        release.profileFormat !== 2 ||
        !["DEVELOPMENT_UNSIGNED", "AD_HOC", "NATIVE_SIGNED"].includes(release.signing?.mode) ||
        (release.signing.mode === "AD_HOC" && release.platform !== "darwin") ||
        !release.trustedRuntime ||
        release.trustedRuntime.arch !== release.arch ||
        release.trustedRuntime.productVersion !== release.productVersion ||
        !hash.test(release.trustedRuntime.manifestSha256 ?? "") ||
        !/^24\.\d+\.\d+$/.test(release.trustedRuntime.nodeVersion ?? "") ||
        !version.test(release.trustedRuntime.engineVersion ?? "") ||
        (release.platform === "darwin" && !release.trustedRuntime.layout)
    )
        throw new Error("DESKTOP_RELEASE_INVALID");
    if (release.updatePublicKeyPem !== undefined) {
        if (
            typeof release.updatePublicKeyPem !== "string" ||
            release.updatePublicKeyPem.length > 4096 ||
            createPublicKey(release.updatePublicKeyPem).asymmetricKeyType !== "ed25519"
        )
            throw new Error("DESKTOP_UPDATE_KEY_INVALID");
    }
    return release;
}

/**
 * 正式宿主始终从资源固定 Runtime 根及同级描述装载，Mac 调用保留外部布局政策的第二版解析器；返回原始核验对象以保留其私有能力品牌，复制字段不能获得 Node、原生插件或保险库辅助程序授权。
 * 这层不自动绑定插件，Electron main 和独立角色在取得对象后各自明确绑定。
 * Windows/Linux 保留既有完整库存检查，另用描述摘要绑定安装器选择的清单身份。
 * 不存在安装材料时应保留失败，不能回落到系统 Node、源码或 Linux 浏览器替代物。
 */
export async function loadDesktopRuntime(runtimeRoot: string): Promise<RuntimeDistribution> {
    const release = await readDesktopRelease(dirname(resolve(runtimeRoot)));
    if (release.platform !== process.platform || release.arch !== process.arch)
        throw new Error("DESKTOP_RELEASE_TARGET_MISMATCH");
    if (process.platform === "darwin") {
        const trusted = release.trustedRuntime;
        if (!trusted.layout) throw new Error("DESKTOP_RELEASE_INVALID");
        return loadMacRuntimeDistribution(runtimeRoot, { ...trusted, layout: trusted.layout });
    }
    const { createHash } = await import("node:crypto");
    const bytes = await readBoundedRegularFile(
        join(runtimeRoot, "runtime-manifest.json"),
        1024 * 1024,
    );
    if (
        bytes.length > 1024 * 1024 ||
        createHash("sha256").update(bytes).digest("hex") !== release.trustedRuntime.manifestSha256
    )
        throw new Error("DESKTOP_RUNTIME_IDENTITY_MISMATCH");
    const distribution = await loadRuntimeDistribution(runtimeRoot);
    if (
        distribution.productVersion !== release.productVersion ||
        distribution.nodeVersion !== release.trustedRuntime.nodeVersion ||
        distribution.engineVersion !== release.trustedRuntime.engineVersion
    )
        throw new Error("DESKTOP_RUNTIME_IDENTITY_MISMATCH");
    return distribution;
}
