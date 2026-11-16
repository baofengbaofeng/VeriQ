<a id="adr-0008-fixture-lifecycle-pinned-identities-and-restricted-evidence"></a>
# 0008 Fixtures Business Identity

状态：T07 已接受；范围遵循已批准的完整 VeriQ 规格。

用例将 `fixtureInput` 声明为显式绑定对象，省略表示 `{}`。输入从所选数据行及初始变量解析，必须在认证或 fixture 副作用前验证。`CaseDslV1.initialVariables?: ParameterTypes` 声明初始变量名及既有 ValueType 类型；值只存于冻结的 `ExecutionSnapshot.variables`，不进入源码。认证前，已声明键必须以自有属性存在且类型正确，即使未使用 fixture。额外执行变量保持兼容，但不能充当 fixture-input 绑定符号。fixture 输出名称冲突以 `DUPLICATE_VARIABLE` 失败。编译使用 Ajv 完整检查字面/数据输入，对动态输入检查声明类型及独立无条件约束；完整的值相关约束在冷组装和 SDK 副作用前执行。fixture 输出赋值前验证，清理令牌与普通变量、源码分离。Prepare 使用 POST，query 使用 GET，cleanup 使用 POST 或 DELETE 并带 JSON 正文；清理令牌绝不进入 URL。幂等性绑定 Workspace、用例执行与 Attempt 序号；清理时持久关闭命名空间，包括未知或部分准备的空间。业务提交必须原子重查命名空间状态；客户端取消不能证明服务端已回滚。

Environment 的可选 `fixtureBaseURL` 与 `fixtureIdentity` 必须同时出现。fixture 身份单独固定版本，并显式声明允许身份，不继承业务角色凭据或浏览器会话。内置 `HTTP_BEARER`、`HTTP_SESSION` 适配器使用固定相对登录/身份路径及 RFC6901 身份指针。配置不可变、归 Workspace 所有且可吊销；它不是第九种资产，也不接受上传代码。Bearer 请求头限制在精确 API 来源内，覆盖逐跳浏览器重定向与 SDK HTTP 调用；会话 Cookie 仅在身份验证后转入业务 Context，fixture 会话始终隔离。

`AuthAdapterVersionV1` 冻结 `{workspaceId,versionId,contentHash,configuration}`，contentHash 为 SHA256(JCS(configuration))。真正包含 Environment 资产的 AssetSnapshot 在可选 `authAdapters` 中保留精确适配器闭包。其源码摘要投影仅在字段存在时纳入它，并按 versionId 排序，保持历史缺失字段时的摘要兼容。普通编译 CASE 源码仍可跨环境复用，其独立 ExecutionSnapshot 保留所选角色/fixture 适配器闭包。编译器组装检查 Workspace、配置摘要、精确适配器与秘密固定版本、重复及多余条目；所选 Environment 保留在源码中时也一并比较。这是完整性检查，不是授权：T09/T10 必须从可信注册表/已发布 Environment 冻结，检查当前吊销，并认证清单中完整 ExecutionSnapshot 的摘要。T14 必须把所选配置保留在签名离线闭包中。

凭据值使用 cryptography AES-GCM、随机 96 位 nonce，以及绑定 Workspace/引用/版本的 JCS AAD。外部设置选择活动主密钥 ID 和历史密钥映射。轮换生成新的不可变版本，解析不得静默替换为更新版本。管理、列表及吊销要求当前 Workspace OWNER/ADMIN 的 MANAGE_ENVIRONMENT 权限；管理响应不返回明文。在 T08/T09 实现真实设备身份、当前成员/授权、分配、租约及 fence 前，类型化可注入 Attempt 验证器默认拒绝。个人/离线执行默认使用精确本地映射。

已知 Playwright 原始 Trace 含认证请求头、Cookie 值、动作值、DOM 快照和业务数据。原始截图、Trace 与下载默认 CREDENTIAL_RESTRICTED；实现不声称能净化任意像素或 ZIP 资源。普通报告只提供脱敏结构化步骤、断言结果、错误及元数据，不提供原始路径/字节。认证/Cookie 请求头始终遮盖，解析后的凭据、会话及清理值注册进遮盖集合。SDK 核心在输出验证和普通投影前立即登记返回的每个清理令牌，包括通用生命周期提供器。SDK 显式特权本地能力不等于服务端授权。T12 对受限字节必须执行当前 Workspace/Attempt 访问检查及 MANAGE_ENVIRONMENT，拒绝生产方降低敏感度，将敏感度传播到产物元数据、事件、清单与导出，并保留特权本地 Trace 查看。T07 尚未实现生产产物存储、上传或下载强制检查。
