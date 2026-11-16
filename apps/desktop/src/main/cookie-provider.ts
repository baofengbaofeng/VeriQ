/** Cookie 提供者契约只描述固定公开探针需要的有限异步能力，平台标签必须结合已锁 Electron 与 Chromium 策略解释；该模块不初始化 Electron、不检查签名或 fuse，也不表示目标系统已经完成安装验收。 */
export interface CookieSafeStorage {
    /** 异步可用性只表示当前 Electron encryptor 已经初始化，Linux 固定回退密钥也可能得到真值；调用方必须继续检查实际提供者和完整往返，不能仅凭这项结果允许持久 Cookie 会话。 */
    isAsyncEncryptionAvailable(): Promise<boolean>;
    /** 后端名称只在 Linux 的 Electron 接口存在，其他平台对象可以完全省略此方法；提供者策略不得在 Mac 或 Windows 调用它，也不得把 Linux 缺少方法解释成已获得系统保护。 */
    getSelectedStorageBackend?(): string;
    /** 加密输入始终是此模块固定的公开非秘密探针而非用户 Cookie 或业务凭据，返回值只用于确认成熟 OS 提供者实际参与；调用方不会把探针密文作为认证材料或通用加密接口返回页面。 */
    encryptStringAsync(value: string): Promise<Buffer>;
    /** 解密只对同一次检查刚得到的探针执行完整往返，错误、内容不同或立即要求重新加密都阻止保护成立；原始平台异常不会被记录或透传为用户诊断，以免夹带系统路径或提供者内部信息。 */
    decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

/** 提供者检查只验证已锁 Electron45 的非秘密异步探针策略，调用者仍须先检查正式平台入口、bundle 与 fuse；Mac 的合成单元契约不能替代签名身份、真实 Keychain 或 Cookie 重启读回验收。 */
export async function probeCookieProvider(storage: CookieSafeStorage, platform: NodeJS.Platform) {
    if (platform !== "linux" && platform !== "win32" && platform !== "darwin")
        throw new Error("COOKIE_PLATFORM_UNSUPPORTED");
    /** 政策拒绝使用本次调用独有的错误对象识别，不能根据原生异常的文字决定错误类别；这样即使系统错误恰好含有同名代码，也只会得到统一的不可用诊断，不会混入平台内部消息。 */
    const required = new Error("COOKIE_OS_PROTECTION_REQUIRED");
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            (async () => {
                if (!(await storage.isAsyncEncryptionAvailable()))
                    throw new Error("COOKIE_OS_PROTECTION_UNAVAILABLE");
                let backend: string;
                if (platform === "linux") {
                    const readBackend = storage.getSelectedStorageBackend;
                    if (typeof readBackend !== "function")
                        throw new Error("COOKIE_OS_PROTECTION_UNAVAILABLE");
                    backend = readBackend.call(storage);
                    if (typeof backend !== "string")
                        throw new Error("COOKIE_OS_PROTECTION_UNAVAILABLE");
                } else {
                    backend = platform === "darwin" ? "keychain" : "dpapi";
                }
                if (backend === "basic_text") throw required;
                const probe = "VeriQ public Cookie protection probe 45.3.1";
                const encoded = await storage.encryptStringAsync(probe);
                if (!Buffer.isBuffer(encoded) || encoded.length < 16 || encoded.length > 1024)
                    throw required;
                /**
                 * 相同 v10 字节在 Mac、Windows 与 Linux 的含义不同，必须按显式平台策略核验；使用 UTF8 解码避免 ASCII 高位屏蔽把错误前缀折叠成合法标签，可用性本身不构成保护证据
                 * 。
                 */
                const provider = encoded.subarray(0, 3).toString("utf8");
                if (!(platform === "linux" ? ["v11", "v12"] : ["v10"]).includes(provider))
                    throw required;
                const decoded = await storage.decryptStringAsync(encoded);
                if (decoded.result !== probe || decoded.shouldReEncrypt !== false) throw required;
                return { platform, backend, provider, encrypted: true as const };
            })(),
            /** 期限只结束调用者等待，不能取消已经进入系统的操作或权限对话框；超时后异步操作仍可能完成，锁定 Keychain 也不保证立即撤销已缓存密钥，后续不得据此改用同步接口或宣称实时撤销。 */
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error("COOKIE_OS_PROTECTION_UNAVAILABLE")),
                    5000,
                );
            }),
        ]);
    } catch (error) {
        if (error === required) throw required;
        throw new Error("COOKIE_OS_PROTECTION_UNAVAILABLE");
    } finally {
        clearTimeout(timer);
    }
}
