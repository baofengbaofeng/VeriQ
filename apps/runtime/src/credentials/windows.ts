/** Windows 平台入口通过可信库存中的真实 veriq_agent 辅助进程访问当前用户 Credential Manager，沿用有界私有管道和实际退出证据；系统 API 不进入宿主事件循环，也不改变进程令牌、拥有者规则或交互登录策略。 */
import type { RuntimeDistribution } from "../distribution.ts";
import { VaultHelperBackend } from "./helper.ts";

/** Windows 后端只允许固定平台和经过验证的 helper 能力，缺失能力或错误平台立即拒绝；同值恢复、冲突拒绝与不确定修改仍由固定协议表达，调用方不能通过选项注入 DLL、程序路径或任意原生操作。 */
export class WindowsVaultBackend extends VaultHelperBackend {
    constructor(
        distribution: RuntimeDistribution,
        options: ConstructorParameters<typeof VaultHelperBackend>[1] = {},
    ) {
        if (process.platform !== "win32") throw new Error("VAULT_PLATFORM_UNSUPPORTED");
        super(distribution, options);
    }
}
