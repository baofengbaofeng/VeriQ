/** 系统密钥后端契约只允许访问本产品档案中指定版本的随机密钥，明确区分缺失、锁定、不可用和提交不确定状态；此文件不提供明文回退、系统调用入口或虚构的生产保险库实现。 */

/** 密钥定位使用稳定档案标识与不可变密钥版本，两项均为规范 UUID；后续系统适配必须验证该有限范围，不能把调用方输入扩展为任意系统属性或其他用户保险库的枚举能力。 */
export type VaultKeyScope = { profileId: string; keyVersion: string };

/** 后端失败只返回不含秘密或原始系统错误的有限状态，缺失必须来自实际查找结果，锁定与服务不可用不能折叠为缺失；未知失败同样不能触发自动创建密钥或选择明文存储。 */
export type VaultBackendFailure = { status: "missing" | "locked" | "unavailable" | "failed" };

/** 系统修改操作若在服务接受后失去完成证据必须报告不确定，调用方不能假称回滚或盲目重试；后续恢复流程需要按同一档案和密钥版本核验实际状态，再决定继续提交或保留日志。 */
export type VaultMutationResult =
    | { status: "ok" }
    | VaultBackendFailure
    | { status: "mutation-unconfirmed" };

/** 有限异步后端仅保存三十二字节随机密钥，读取交付独立拥有的字节副本且写入不得修改调用方缓冲区；每次调用接受取消信号并由适配器执行有界等待，不隐式解锁或打开交互提示。 */
export interface VaultKeyBackend {
    get(
        scope: VaultKeyScope,
        signal: AbortSignal,
    ): Promise<{ status: "ok"; key: Buffer } | VaultBackendFailure>;
    set(scope: VaultKeyScope, key: Buffer, signal: AbortSignal): Promise<VaultMutationResult>;
    delete(scope: VaultKeyScope, signal: AbortSignal): Promise<VaultMutationResult>;
    probe(signal: AbortSignal): Promise<{ status: "ready" } | VaultBackendFailure>;
}
