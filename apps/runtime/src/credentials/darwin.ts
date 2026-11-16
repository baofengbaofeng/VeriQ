import type { RuntimeDistribution } from "../distribution.ts";
import { VaultHelperBackend } from "./helper.ts";

/**
 * Mac 后端复用既有正式文件型 Keychain helper 与同一有限 V1 协议，辅助程序只能来自严格 Mac 库存授予的私有能力；
 * 业务档案不能指定程序、钥匙串路径、交互解锁或开发故障目标。
 * 原 helper 保留 ACL、锁定、同值恢复和提交不确定语义，构造后端不会立即访问实际钥匙串，真实操作仅在后续明确业务请求中发
 * 生。
 */
export class DarwinVaultBackend extends VaultHelperBackend {
    /**
     * 目标检查先于取有限 helper 能力，非 Mac 宿主无法借本包装选择另一个系统后端；期限和观察回调仍遵守已有五秒上限及无秘
     * 密生命周期输出，失败不自动降级为明文存储。
     * 本函数没有 shell、命令参数或环境搜索入口，也不触发原生钥匙串自测或默认信任修改。
     */
    constructor(
        distribution: RuntimeDistribution,
        options: ConstructorParameters<typeof VaultHelperBackend>[1] = {},
    ) {
        if (process.platform !== "darwin") throw new Error("VAULT_PLATFORM_UNSUPPORTED");
        super(distribution, options);
    }
}
