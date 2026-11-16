/** Cookie 的磁盘加密由 Electron 二进制 fuse 与实际 OS 密钥提供者共同决定，safeStorage 返回可用仍可能使用 Linux 固定密钥回退；此门闩在创建持久 Session 之前分别核验两项事实，并只返回非秘密诊断而不向 renderer 暴露密钥或 Cookie。 */
import { stat } from "node:fs/promises";
import { getCurrentFuseWire, FuseVersion, FuseV1Options } from "@electron/fuses";
import { requireMacDesktopIdentity, type DesktopHostIdentity } from "../installation/host-identity";
import { probeCookieProvider, type CookieSafeStorage } from "./cookie-provider.ts";

/** 继续从原保护模块导出有限存储类型，已有调用者无需为模块抽取改变导入路径；Linux 专属后端方法现在可选，正式入口仍必须先通过平台及 fuse 门闩，不能靠类型兼容提前开放 Mac 会话。 */
export type { CookieSafeStorage } from "./cookie-provider.ts";

async function currentFuses(): Promise<Record<string | number, unknown>> {
    if (process.versions.electron !== "45.3.1" || process.versions.chrome !== "156.0.8078.96")
        throw new Error("COOKIE_RUNTIME_UNVERIFIED");
    const executable = process.platform === "linux" ? "/proc/self/exe" : process.execPath;
    const info = await stat(executable);
    if (!info.isFile() || info.size < 1 || info.size > 536870912)
        throw new Error("COOKIE_RUNTIME_UNVERIFIED");
    return getCurrentFuseWire(executable);
}

/** 正式持久会话先验证平台与 Mac 原始宿主身份能力，再核验当前二进制的 Cookie fuse，最后执行有限提供者探针；Mac 安装、签名和最低系统检查缺一不可，源码交付不会把真实 Cookie 或 Keychain 验收标为通过。 */
export async function requireCookieProtection(
    storage: CookieSafeStorage,
    platform: NodeJS.Platform = process.platform,
    readFuses: () => Promise<Record<string | number, unknown>> = currentFuses,
    hostIdentity?: DesktopHostIdentity,
) {
    if (platform !== "linux" && platform !== "win32" && platform !== "darwin")
        throw new Error("COOKIE_PLATFORM_UNSUPPORTED");
    if (platform === "darwin") requireMacDesktopIdentity(hostIdentity);
    try {
        const fuses = await readFuses();
        if (fuses.version !== FuseVersion.V1 || fuses[FuseV1Options.EnableCookieEncryption] !== 49)
            throw new Error("COOKIE_ENCRYPTION_FUSE_REQUIRED");
    } catch {
        throw new Error("COOKIE_ENCRYPTION_FUSE_REQUIRED");
    }
    return probeCookieProvider(storage, platform);
}
