import { appI18n } from "../../locale";

// 示例向导把词条挂到既有共享i18next实例的独立命名空间，语言变化沿用应用已经选择的当前语言，状态机错误码、资源kind和真实
// 设备标识保持机器原值而不参与翻译。词条不包含秘密、实际URL或用户数据，错误展示只从固定key选择文本。
// 页面卸载不重置全局语言，避免导入向导改变其它资源编辑器的显示设置。全局语言入口管理同一appI18n实例，资源编辑器和AI页面
// 由其既有桥接同步。
const zh = {
    title: "导入示例 Workspace",
    load: "正在读取安装包内示例…",
    retry: "重新读取",
    close: "关闭",
    summary: "创建可编辑草稿，等待真实 Runtime 编译后发布，并建立执行计划。此向导不自动触发运行。",
    workspace: "当前 Workspace",
    workspaceKey: "新空间标识",
    workspaceName: "新空间名称",
    createWorkspace: "创建或打开空间",
    target: "目标和正常业务身份",
    baseURL: "业务页面地址",
    apiURL: "业务 API 地址",
    fixtureURL: "Fixture 服务地址",
    build: "被测应用 build SHA",
    locale: "浏览器语言",
    timezone: "浏览器时区",
    role: "业务角色标识",
    businessIdentity: "普通业务允许身份",
    fixtureIdentity: "Fixture 允许身份",
    credentials: "凭据版本",
    adapter: "认证适配器",
    newAdapter: "创建 HTTP Bearer 适配器",
    businessRef: "业务凭据引用",
    fixtureRef: "Fixture 凭据引用",
    businessVersion: "已有业务凭据版本",
    fixtureVersion: "已有 Fixture 凭据版本",
    newCredential: "创建新凭据版本",
    businessToken: "新业务令牌",
    fixtureToken: "新 Fixture 令牌",
    tokenHelp: "仅新建凭据需要输入，提交后清空；不写入浏览器存储。已有版本从授权元数据中选择。",
    runtime: "实际执行 Runtime",
    selectRuntime: "选择已授权且在线的设备",
    runtimeHelp: "需 MANAGED 信任、在线能力和单独的空间凭据投递授权；向导不会批准设备。",
    timeout: "每项真实验证等待秒数",
    start: "开始或恢复导入",
    stop: "停止本地导入",
    clear: "清除本地恢复标记",
    stopped: "本地导入已停止。已接受的远端作业可能继续；重新开始将读取真实状态，不会删除草稿。",
    finished: "示例已真实发布并建立计划。尚未触发 Run。",
    plan: "查看执行计划",
    progress: "实际导入进度",
    source: "安装包来源文件数",
    identity: "校验或创建身份版本",
    validating: "等待真实编译",
    published: "版本已发布",
    planPhase: "建立执行计划",
    error: "导入未完成；已创建对象保留，可修正条件后恢复。",
    reloadMetadata: "重新读取设备和凭据元数据",
    metadata: "设备和凭据元数据",
    resetHelp: "只清除本地恢复标记，不删除服务器资源或撤销凭据。配置变化时应使用独立空间。",
    errors: {
        TARGET_ORIGIN_INVALID: "请输入无路径或认证信息的 HTTPS origin；HTTP 仅限本机地址。",
        SAMPLE_PACKAGE_INVALID: "安装包示例清单或 DSL 无效。",
        SELECTION_INVALID: "请选择真实 Workspace 和 Runtime。",
        IMPORT_OPTIONS_CHANGED: "恢复配置或凭据选择已变化；请恢复原参数，或使用独立空间。",
        ADAPTER_INVALID: "所选认证适配器不可用或不是 HTTP Bearer。",
        CREDENTIAL_SELECTION_INVALID: "所选凭据已撤销、引用不符或身份不被允许。",
        CREDENTIAL_INPUT_INVALID: "新凭据需要至少24字符的独立令牌。",
        RESOURCE_CHANGED: "现有示例资源已归档或内容被修改；向导不会覆盖。",
        VALIDATION_TIMEOUT: "真实编译仍未完成；请检查受管理 Runtime 和批准引擎后恢复。",
        VALIDATION_FAILED: "真实编译作业失败；请检查作业诊断。",
        RECEIPT_CHANGED: "编译回执与当前草稿或源哈希不符。",
        PLAN_CHANGED: "原执行计划已归档或修改；向导不会覆盖。",
        CONFIG_INVALID: "请填写有效角色、身份、引用、构建和验证等待时间。",
        WORKSPACE_REQUIRED: "先选择或创建 Workspace。",
        STORAGE_UNAVAILABLE: "无法保存恢复元数据；当前页面内仍可恢复，刷新后需重新读取服务器对象。",
        UNKNOWN: "请求失败。请检查网络、权限和平台诊断，不要重复提交未知业务写入。",
    },
};
const en = {
    title: "Import sample Workspace",
    load: "Loading the installed sample package…",
    retry: "Reload",
    close: "Close",
    summary:
        "Create editable drafts, wait for real Runtime compilation, publish, and create an execution plan. No Run is" +
        " triggered automatically.",
    workspace: "Current Workspace",
    workspaceKey: "New Workspace key",
    workspaceName: "New Workspace name",
    createWorkspace: "Create or open Workspace",
    target: "Target and normal business identity",
    baseURL: "Business page origin",
    apiURL: "Business API origin",
    fixtureURL: "Fixture service origin",
    build: "Target application build SHA",
    locale: "Browser locale",
    timezone: "Browser timezone",
    role: "Business role key",
    businessIdentity: "Allowed business identity",
    fixtureIdentity: "Allowed fixture identity",
    credentials: "Credential versions",
    adapter: "Authentication adapter",
    newAdapter: "Create HTTP Bearer adapter",
    businessRef: "Business secret reference",
    fixtureRef: "Fixture secret reference",
    businessVersion: "Existing business credential version",
    fixtureVersion: "Existing fixture credential version",
    newCredential: "Create new credential version",
    businessToken: "New business token",
    fixtureToken: "New fixture token",
    tokenHelp:
        "Only required when creating credentials. Cleared after submission and never saved in browser storage. Selec" +
        "t existing versions from authorized metadata.",
    runtime: "Actual execution Runtime",
    selectRuntime: "Select an authorized online device",
    runtimeHelp:
        "Requires MANAGED trust, online capability, and separate Workspace credential delivery. This wizard does not" +
        " approve devices.",
    timeout: "Seconds to wait for each actual validation",
    start: "Start or resume import",
    stop: "Stop local import",
    clear: "Clear local resume marker",
    stopped:
        "Local import stopped. Accepted remote jobs may continue. Resume reads actual state and does not delete draf" +
        "ts.",
    finished: "Sample versions published and plan created. No Run has been triggered.",
    plan: "View execution plans",
    progress: "Actual import progress",
    source: "Installed source file count",
    identity: "Check or create identity versions",
    validating: "Waiting for actual compilation",
    published: "Version published",
    planPhase: "Create execution plan",
    error: "Import is incomplete. Created objects are retained; correct the conditions and resume.",
    reloadMetadata: "Reload device and credential metadata",
    metadata: "Device and credential metadata",
    resetHelp:
        "Clears only local resume metadata. It does not delete server resources or revoke credentials. Use a separat" +
        "e Workspace when changing configuration.",
    errors: {
        TARGET_ORIGIN_INVALID:
            "Use an HTTPS origin without path or credentials; HTTP is limited to loopback.",
        SAMPLE_PACKAGE_INVALID: "Installed sample manifest or DSL is invalid.",
        SELECTION_INVALID: "Select an actual Workspace and Runtime.",
        IMPORT_OPTIONS_CHANGED:
            "Resume options or credential selections changed. Restore the original options or use a separate Workspa" +
            "ce.",
        ADAPTER_INVALID: "Selected authentication adapter is unavailable or is not HTTP Bearer.",
        CREDENTIAL_SELECTION_INVALID:
            "Selected credential was revoked, has another reference, or does not allow the identity.",
        CREDENTIAL_INPUT_INVALID:
            "New credentials require separate tokens of at least 24 characters.",
        RESOURCE_CHANGED:
            "An existing sample resource was archived or changed. The wizard will not overwrite it.",
        VALIDATION_TIMEOUT:
            "Actual compilation did not finish. Check the managed Runtime and approved engine, then resume.",
        VALIDATION_FAILED: "Actual compilation failed. Inspect the Job diagnostics.",
        RECEIPT_CHANGED: "The compilation receipt differs from the current draft or source hash.",
        PLAN_CHANGED: "The original plan was archived or edited. The wizard will not overwrite it.",
        CONFIG_INVALID:
            "Provide valid role, identities, references, build, and validation timeout.",
        WORKSPACE_REQUIRED: "Select or create a Workspace first.",
        STORAGE_UNAVAILABLE:
            "Resume metadata could not be saved. This page can resume in memory; after refresh, reload actual server" +
            " objects.",
        UNKNOWN:
            "Request failed. Check network, permissions, and platform diagnostics; do not repeat unknown business wr" +
            "ites.",
    },
};
appI18n.addResourceBundle("zh", "examples", zh, true, true);
appI18n.addResourceBundle("en", "examples", en, true, true);

/**
 * 向导只传入独立namespace的既有i18next实例，不创建第二个语言偏好或静默切换语言；宿主全局入口修改共享实例后，正在显示的
 * 导入进度和错误文案自动同步。
 */
export const exampleTranslationOptions = { i18n: appI18n };
