import type { PlatformComponents, ResourceDocumentV1 } from "@veriq/contracts";

/**
 * 示例导入只接受固定七类资产和明确的版本别名，HTTP清单由安装包提供，跨空间重写只能使用当前空间真实发布返回的UUID，不能
 * 把模板标识直接当作生产版本引用。
 */
export const sampleOrder = ["catalog", "dataset", "fixture", "flow", "case", "suite", "environment"] as const;
export type SampleKey = (typeof sampleOrder)[number];
export type Schemas = PlatformComponents["schemas"];

/**
 * 经过本地结构检查的安装包清单保留原始字节散列用于来源比较，不代表编译或发行信任已经通过；每次HTTP读取仍要求当前员工会
 * 话，包数据不包含业务密码或机器配置。
 */
export interface SamplePackage {
    schemaVersion: "1.0";
    manifest: { schemaVersion: "1.0"; order: SampleKey[]; versionAliases: Record<string, string> };
    assets: Record<SampleKey, ResourceDocumentV1>;
    sourceInventory: Record<string, string>;
}

/**
 * 导入配置只保存可公开的目标origin、构建、角色和授权设备选择，密码由独立短命参数传入而不进入此对象，防止进度恢复或组件
 * 状态持久化时无意把秘密写入浏览器存储。
 */
export interface ImportOptions {
    workspaceId: string;
    baseURL: string;
    apiBaseURL: string;
    fixtureBaseURL: string;
    buildSha: string;
    locale: string;
    timezone: string;
    roleKey: string;
    businessIdentity: string;
    fixtureIdentity: string;
    businessRef: string;
    fixtureRef: string;
    runtimeId: string;
    validationTimeout: number;
}

/**
 * 每种业务凭据绑定固定secretRef与实际版本，allowedIdentityIds会由服务端再次核对；此类型没有明文token，允许与当前员工及
 * 空间绑定的非秘密进度一起保存用于恢复。
 */
export interface CredentialBinding {
    secretRef: string;
    versionId: string;
}

/**
 * 短命导入参数中的token只用于正常凭据创建API，不写入进度、查询缓存、事件或错误；已有版本选择优先，提交后组件会清空字段
 * ，模块不提供日志或序列化整个输入的入口。
 */
export interface ImportSecrets {
    businessToken: string;
    fixtureToken: string;
    businessVersion: string;
    fixtureVersion: string;
    adapterVersion: string;
}

/**
 * 恢复状态绑定当前员工控制的空间和模板来源，只保留公开配置、不可变版本及当前作业标识，真实状态始终重新读取服务器，记录
 * 存在不能替代权限、回执或源哈希的再次验证。
 */
export interface ImportProgress {
    fingerprint: string;
    workspaceId: string;
    adapterVersion?: string;
    business?: CredentialBinding;
    fixture?: CredentialBinding;
    versions: Partial<Record<SampleKey, string>>;
    planId?: string;
}

/**
 * 导入事件只包含固定阶段、样例资产键和真实作业状态，机器标识不参与翻译或成为 veriqId；UI按这些事实显示进
 * 度，不从请求接受推导编译或发布成功。
 */
export interface ImportEvent {
    phase: "identity" | "validating" | "published" | "plan";
    asset?: SampleKey;
    jobId?: string;
    state?: string;
    waitReason?: string;
}
