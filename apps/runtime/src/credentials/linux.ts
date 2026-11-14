/** Linux 平台入口复用已验证的有限 helper 传输与退出所有权实现，平台检查仍在取得能力之前完成；实际密钥语义继续由原正式 libsecret 程序处理，提取共享宿主逻辑不引入明文回退或另一种系统后端。 */
import type { RuntimeDistribution } from "../distribution.ts";
import { VaultHelperBackend } from "./helper.ts";
export type { VaultHelperObservation } from "./helper.ts";

/** Linux 后端构造只接受发行库存能力与原有有界期限和非秘密观察选项，其他平台不能借用此入口选择不同程序；所有公开密钥操作继承同一固定协议，不提供任意命令、路径或系统凭据枚举接口。 */
export class LinuxVaultBackend extends VaultHelperBackend {
    constructor(
        distribution: RuntimeDistribution,
        options: ConstructorParameters<typeof VaultHelperBackend>[1] = {},
    ) {
        if (process.platform !== "linux") throw new Error("VAULT_PLATFORM_UNSUPPORTED");
        super(distribution, options);
    }
}
