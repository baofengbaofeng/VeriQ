<a id="veriq-后端接入规范--backend-integration"></a>
# Backend

本规范适用于 Java / Spring Boot 或 Python 业务服务；双方通过 HTTP、固定 OpenAPI、正常业务认证及 fixture 生命周期协作。VeriQ 控制服务的 Python 技术栈不限制被测后端语言。先完成下面的接入交付，再阅读后文现有示例和 SDK 的精确契约。

## 后端接入交付清单

| 交付物 | 必须提供的行为 | 验收场景 |
| --- | --- | --- |
| 接口版本 | 固定 OpenAPI、HTTP 状态、稳定业务错误码、字段及空值语义 | 正常、校验失败、无权限、重复请求和不存在资源 |
| 应用身份 | 可记录的 build SHA / 版本，以及实际被测地址 | Run 冻结版本与实际目标一致；环境覆盖明确记录 |
| 正常认证 | 业务角色与 fixture 服务身份分离，验证真实身份和权限 | 普通员工、管理员、跨空间/租户访问拒绝 |
| fixture 准备 | 显式输入/输出 Schema、每 Attempt 独立 namespace、参数绑定幂等键 | 相同键和参数返回同一结果；同键不同参数 409 |
| fixture 查询 | 以稳定键只读查询准备结果和业务对象 | 准备响应丢失、写入结果未知时可确认真实结果 |
| fixture 清理 | 精确所有权、重复安全、部分准备也可清理 | 清理其他 namespace 必须拒绝，重复调用无副作用 |
| 晚到写入隔离 | 业务写入与 namespace 的 OPEN/TTL 校验在同一事务内 | 清理后恢复一个此前阻塞的请求，写入仍须拒绝 |
| TTL 补偿 | 外部唤醒的受限、鉴权、有界、幂等维护接口 | Worker 被杀、未取得 cleanupToken 也能最终清理 |
| 关联诊断 | requestId、非秘密业务键、错误码和 build 版本 | 从步骤关联业务日志；不记录密钥、密码或原始 token |
| 网络可达 | Runtime 可访问 Web、API、fixture、认证和必要 TLS 信任链 | 分别从云端与本地运行环境检查，而非只从浏览器开发机检查 |

### fixture 生命周期与事务边界

准备请求的稳定身份为 `workspaceId`、`caseExecutionId`、`attemptNo` 和 `namespace`；SDK 使用的幂等键为 `workspaceId:caseExecutionId:attemptNo`。每次平台整用例重试使用新的 Attempt、浏览器 Context、namespace 和 fixture。不可将当前员工的全局业务数据作为可删除的测试集合。

准备返回的 `variables` 必须满足已发布 fixture 的输出 Schema，供后续 UI/API 步骤引用；`cleanupToken` 仅用于清理授权，不作为普通业务变量或写入报告。查询使用 GET 和幂等键；清理使用 POST/DELETE 的 JSON body。业务写入返回的标识用于独立只读查询与持久化断言。

Java 实现可复用 Spring MVC、Jackson、现有校验组件和数据库事务；Python 实现可复用已有 HTTP 框架与事务库。关键要求是 namespace 状态检查与数据写入共用同一个事务和可靠的并发控制。仅在事务外查询一次状态，再另行写入，无法阻止清理后的晚到提交。清理事务先将 namespace 标记 CLOSED，并精确移除该 namespace 拥有的数据；保留足以拒绝旧键重放的关闭记录。

接入验收应通过受控业务请求制造真实竞争：请求已被接收但尚未提交时执行清理，然后放行原请求，要求它失败且对象未重新出现。普通“准备—删除—再次删除”只能证明重复清理安全，不能证明晚到写入隔离。

### 请求与断言管理

后端需区分 HTTP 成功与业务成功，约定稳定的业务码、JSON 类型、缺失字段与 null 的语义。VeriQ 使用 RFC6901 JSON Pointer 和 JSON Schema 验证响应。最终一致性查询必须只读，并有业务定义的总时限；不要在查询过程中再次提交订单、审批或其他写操作。

UI 隐藏按钮不能替代后端越权校验。权限回归使用正常业务身份分别检查 UI 和 API；fixture 高权限身份不能参与普通权限断言。写入超时或连接中断后，先按业务键/幂等键查询实际结果，再依照用例策略处理，避免未知结果被盲目重发。

测试支持路由在受控环境鉴权开放，不能接受任意 SQL、文件路径或执行代码。fixture 清理和维护与平台的普通员工登录分别授权。业务服务可以使用外部中间件定时调用补偿接口；VeriQ 不提供内部 Cron。

### 当前实现与验收边界

仓库已提供真实 HTTP 生命周期客户端及以下受控示例；控制服务已经接入数据库 Attempt 验证器与受限证据授权。T20 的生产 OS 凭据与跨平台发行仍在里程碑中逐项验收，不能从示例成功推导所有安装环境已支持。自定义 SSO/MFA 与任意客户登录脚本不属于当前内置认证适配能力。

完整接入需结合[前端锚点规范](frontend.md)、[外部调度](external-scheduler.md)、[公共契约](../contracts.md)及[里程碑](../plans/milestones.md)。客户业务服务仍须在自身数据库与网络环境通过实际契约、权限、并发和故障测试。

<a id="runnable-sample-and-exact-sdk-contract"></a>
## 可运行示例与精确 SDK 契约

T07 在 `fixtures/demo-app/app.py` 提供可运行的受控 Python/Tornado 示例，并在 `@veriq/runner-sdk` 中提供 HTTP 生命周期客户端。示例通过 SQLite 持久化 fixture 所有权、已关闭的命名空间和员工数据。它是被测示例目标，不是使用 MySQL 的 VeriQ 控制服务。测试使用真实 Chromium 和 HTTP 请求访问这个目标，不能据此认定任意客户 Java/Spring 或 Python 部署已通过验收。

使用服务端 Python 环境及外部提供的配置启动示例：

```sh
export VERIQ_DEMO_DATABASE=/restricted/demo.sqlite
# 通过秘密管理器提供三个互不相同、每个至少 24 字符的随机令牌，供业务、fixture 与维护身份分别使用：
# VERIQ_DEMO_BUSINESS_TOKEN, VERIQ_DEMO_FIXTURE_TOKEN, VERIQ_DEMO_MAINTENANCE_TOKEN
apps/srv/.venv/bin/python fixtures/demo-app/app.py
```

默认监听回环地址的 8090 端口，可通过 `VERIQ_DEMO_PORT` 覆盖。非本机部署应在前方配置带认证的 TLS 终止代理。测试屏障路由仅存在于 `fixtures/test-support/server.py`，普通示例服务不提供这些路由。HTTP 契约见 `fixtures/demo-app/openapi.json`。

准备请求接收 `{workspaceId,caseExecutionId,attemptNo,namespace,idempotencyKey,input,ttlSeconds}`，精确幂等键为 `workspaceId:caseExecutionId:attemptNo`。重复的相同请求返回原 fixture ID，参数改变则返回 409。客户端在认证或发起网络调用前，使用固定 Fixture 的 inputSchema 验证显式声明的 `CaseDslV1.fixtureInput`。`CaseDslV1.initialVariables` 声明允许的初始变量名与 ValueType 类型，例如 `{"name":"string"}`；实际值仍保存在冻结的 `ExecutionSnapshot.variables` 中。认证前必须确认每个声明的键均存在且类型正确。输入只能解析这些已声明的初始变量及选中数据行，不能读取尚未产生的 fixture 输出，也不会隐式包含全部执行变量。准备响应为 `{fixtureId,namespace,variables,cleanupToken}`；变量赋值前须通过 outputSchema 验证。清理通过 POST/DELETE 的 JSON 正文发送相同所有权字段及可选 cleanupToken；查询通过 GET 和 idempotencyKey 进行，绝不使用令牌作为查询参数。

fixture 调用使用 Environment.fixtureIdentity 与 fixtureBaseURL；普通 UI/API 权限检查使用选定的业务角色。`HTTP_BEARER` 接收本地提供或已解析的 `{token}`，并在 identityPath 核验身份。`HTTP_SESSION` 将凭据 JSON 通过 POST 发送至 loginPath，再核验 identityPath。两者均通过 identityPointer 提取身份，要求身份位于 allowedIdentityIds 中。这些有界内置适配器支持常见令牌与 HTTP 会话登录集成，尚未实现自定义 SSO/MFA 流程或客户专用响应转换。凭据和适配器版本通过 Workspace API 创建、撤销，不提供认证代码上传入口。

业务端点将每个新建资源归属到一个命名空间，并在数据写入的同一事务中检查命名空间为 OPEN 且尚未到期。清理在同一事务中将命名空间标记为 CLOSED，只删除该命名空间拥有的资源，并保留关闭墓碑；即使准备请求尚未返回也须如此。清理后的晚到 UI/API 提交必须失败。测试套件在服务端接收业务校验操作后暂停它，清理 fixture，再恢复该操作并确认返回 409 且资源已移除；仅验证重复清理不能证明这一保证。

外部调度使用独立维护令牌调用经过认证的 `POST /maintenance`，正文为 `{limit:1..100}`，响应为 `{processed,hasMore}`，可安全重复执行。系统没有内部 Cron。Worker 退出后仍需外部 TTL 核对，即使此前没有取得清理回执或令牌也不能省略。客户 Java/Spring 与 Python 服务应在自身数据库中实现相同的事务和所有权保证；只在浏览器 finally 块中调用 DELETE 并不足够。关闭命名空间的墓碑至少保留至完整重试和幂等窗口结束；本示例无限期保留。

SDK 导出 `prepareFixture`、`cleanupFixture`、`createHttpLifecycle`、`LocalCredentialProvider` 和 `EvidencePolicy`。`LifecycleContext.fixtureInput` 单独携带已解析输入；清理允许令牌未定义，并依赖稳定的命名空间与幂等键。客户端收到取消信号时中止本次隔离请求，不跨重定向重放写入，并释放认证会话。`LocalCredentialProvider` 只接受精确的 Workspace、引用与版本映射；T20 提供操作系统保险库和受限配置集成，不提供回退到平台网络取凭据的能力。

原始截图、Trace 和下载文件属于受限证据。普通报告保留已脱敏的结构化步骤、断言、错误及制品元数据，不包含本机原始路径或字节。`EvidencePolicy` 可将真实截图与 Trace 保存到权限为 0700 的目录和权限为 0600 的文件；访问原始证据需要显式、可信的本机凭据与证据能力。控制服务在授权读取受限制品前执行 Workspace 范围的 MANAGE_ENVIRONMENT 校验。获授权操作员仍可使用固定版本的 Playwright Trace 查看器打开原始 Trace，不应将其上传至公共服务。这些适配器将会话保存在隔离内存上下文中，不写入 storageState 文件。

控制服务的正常工厂注入 `DatabaseAttemptProofVerifier`。它校验设备授权及租约、围栏请求头，并在安装级权威事务内检查当前派单、Workspace 成员身份、环境和设备授权、服务端授予的 MANAGED 信任，以及精确固定的角色和 fixture 引用。调用方自报的信任标签不能形成授权依据。T09/T10 在派单前冻结登记记录，并对完整 ExecutionSnapshot 计算散列。签名离线档案只包含非秘密配置与引用。T12 提供受限制品存储及授权，T11 提供管理编辑器。完整产品和已安装平台的最终验收仍记录在里程碑台账中。
