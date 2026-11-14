/** 宿主凭据工厂只接收完整发行解析器颁发的能力对象，业务档案、工作区和环境不能选择系统辅助程序；默认明确使用操作系统保险库，缺失支持或库存成员时在读取任何私有凭据前失败而不自动降级。 */
import type { RuntimeDistribution } from "../distribution.ts";
import { LinuxVaultBackend } from "./linux.ts";
import type { CredentialOptions } from "./profile.ts";

/** 安装宿主构造凭据上下文时直接验证对应平台的有限执行能力，调用者随后把同一上下文交给设备与业务消费者；未支持的平台返回固定错误，不能在这里搜索全局二进制、开发输出或退回明文配置。 */
export function installedCredentials(distribution: RuntimeDistribution): CredentialOptions {
    if (process.platform === "linux") return { backend: new LinuxVaultBackend(distribution) };
    throw new Error("VAULT_PLATFORM_UNAVAILABLE");
}
