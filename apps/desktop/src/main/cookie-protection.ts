/** Cookie 的磁盘加密由 Electron 二进制 fuse 与实际 OS 密钥提供者共同决定，safeStorage 返回可用仍可能使用 Linux 固定密钥回退；此门闩在创建持久 Session 之前分别核验两项事实，并只返回非秘密诊断而不向 renderer 暴露密钥或 Cookie。 */
import { stat } from "node:fs/promises";
import { getCurrentFuseWire, FuseVersion, FuseV1Options } from "@electron/fuses";

/** 保护检查只需要 Electron 成熟异步加解密与 Linux 后端名称接口，不能借此请求任意平台操作；测试可提供有限实现观察失败关闭路径，但正式入口始终传入真实 Electron safeStorage 而非档案或页面数据。 */
export interface CookieSafeStorage {
    /** 异步可用性只表示当前 Electron encryptor 已经初始化，Linux 固定回退密钥也可能得到真值；调用方必须继续检查实际提供者和完整往返，不能仅凭这项结果允许持久 Cookie 会话。 */
    isAsyncEncryptionAvailable(): Promise<boolean>;
    /** Linux 后端名称只作为明确拒绝 basic_text 的补充事实，异步 Portal 与 Secret Service 的实际选择仍由当前版本非秘密探针验证；未知名称不得被单独解释成系统保护已经成立。 */
    getSelectedStorageBackend(): string;
    /** 加密输入始终是此模块固定的公开非秘密探针而非用户 Cookie 或业务凭据，返回值只用于确认成熟 OS 提供者实际参与；调用方不会把探针密文作为认证材料、档案主密钥或通用加密接口返回页面。 */
    encryptStringAsync(value: string): Promise<Buffer>;
    /** 解密只对同一次检查刚得到的探针执行完整往返，错误、内容不同或立即要求重新加密都阻止会话建立；原始平台异常不会被记录或透传为用户诊断，以免夹带系统路径或提供者内部信息。 */
    decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

async function currentFuses(): Promise<Record<string | number, unknown>> {
    if (process.versions.electron !== "45.3.1" || process.versions.chrome !== "156.0.8078.96")
        throw new Error("COOKIE_RUNTIME_UNVERIFIED");
    const executable = process.platform === "linux" ? "/proc/self/exe" : process.execPath;
    const info = await stat(executable);
    if (!info.isFile() || info.size < 1 || info.size > 536870912)
        throw new Error("COOKIE_RUNTIME_UNVERIFIED");
    return getCurrentFuseWire(executable);
}

/** 已锁 Electron45 的异步可用性也会对 POSIX 固定回退密钥返回真，因此检查真实非秘密探针的提供者标签和完整往返；Linux 仅接收当前源码确认的 v11 或 v12，Windows 仅接收 DPAPI 的 v10，未知版本必须重新核验而非自动接受。 */
export async function requireCookieProtection(
    storage: CookieSafeStorage,
    platform: NodeJS.Platform = process.platform,
    readFuses: () => Promise<Record<string | number, unknown>> = currentFuses,
) {
    if (platform !== "linux" && platform !== "win32")
        throw new Error("COOKIE_PLATFORM_UNSUPPORTED");
    try {
        const fuses = await readFuses();
        if (fuses.version !== FuseVersion.V1 || fuses[FuseV1Options.EnableCookieEncryption] !== 49)
            throw new Error("COOKIE_ENCRYPTION_FUSE_REQUIRED");
    } catch {
        throw new Error("COOKIE_ENCRYPTION_FUSE_REQUIRED");
    }
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            (async () => {
                if (!(await storage.isAsyncEncryptionAvailable()))
                    throw new Error("COOKIE_OS_PROTECTION_UNAVAILABLE");
                const backend =
                    platform === "linux" ? storage.getSelectedStorageBackend() : "dpapi";
                if (backend === "basic_text") throw new Error("COOKIE_OS_PROTECTION_REQUIRED");
                const probe = "VeriQ public Cookie protection probe 45.3.1";
                const encoded = await storage.encryptStringAsync(probe);
                if (!Buffer.isBuffer(encoded) || encoded.length < 16 || encoded.length > 1024)
                    throw new Error("COOKIE_OS_PROTECTION_REQUIRED");
                const provider = encoded.subarray(0, 3).toString("ascii");
                if (!(platform === "linux" ? ["v11", "v12"] : ["v10"]).includes(provider))
                    throw new Error("COOKIE_OS_PROTECTION_REQUIRED");
                const decoded = await storage.decryptStringAsync(encoded);
                if (decoded.result !== probe || decoded.shouldReEncrypt)
                    throw new Error("COOKIE_OS_PROTECTION_REQUIRED");
                return { platform, backend, provider, encrypted: true };
            })(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error("COOKIE_OS_PROTECTION_UNAVAILABLE")),
                    5000,
                );
            }),
        ]);
    } catch (error) {
        if (error instanceof Error && error.message === "COOKIE_OS_PROTECTION_REQUIRED")
            throw error;
        throw new Error("COOKIE_OS_PROTECTION_UNAVAILABLE");
    } finally {
        clearTimeout(timer);
    }
}
