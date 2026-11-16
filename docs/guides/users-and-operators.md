<a id="veriq-用户管理员与运维快速手册"></a>
# Users and Operators

当前源码交付与实际验收分开记录。C06 新增示例/指南尚未运行；平台已知发行、Mac/Windows 和质量阻塞继续保留在[MVP 交接](../validation/mvp-handoff.md)。这里提供可操作路径和故障判断，不改变正式发布门禁。

## 普通使用者

1. 在平台公开地址登录；首次部署由管理员完成 setup。通过邀请加入正确 Workspace，确认当前角色；系统管理员身份不自动授予项目访问权。
2. 查看该空间的目录、用例、数据集、流程、fixture、套件和环境。DSL 是可编辑源，生成 TypeScript 是不可变产物；不直接修改生成物来修复用例。
3. 修改草稿后看依赖和验证预览，提交真实验证。QUEUED 表示等待编译，PASSED 回执与当前 revision/sourceHash 一致后才能发布；草稿又被编辑必须重新验证。
4. 建立或选择已发布套件和环境，检查业务角色、locale/timezone、目标 build、浏览器及设备。确认设备在线、自检有效、对空间有共享授权，环境中的密钥版本仍可用。
5. 手动触发 Plan 或 Run。观察队列/等待原因、步骤、请求关联、提取和断言差异；写入成功必须包含独立持久化检查。新执行冻结资产版本，不随“最新版”变化。
6. 查看报告时区分 outcome、cleanupStatus、gateAtExecution 和 gateNow。PASSED 但当前信任失效不能当当前门禁通过；失败后整用例重试通过为 UNSTABLE。零用例/跳过不算通过。
7. 取消时等待实际停止和清理事实；UI 的取消回执不证明未知 OS 进程已经退出。遇到 quarantine 不创建重复执行绕过容量，应交由设备所有者/管理员检查。

示例按[快速开始](sample-workspace.md)导入。用自己的业务替换目标 origin、正常角色和 fixture；示例仅包含合成员工，不连接真实订单、支付或客户生产数据库。AI 是可选草稿助手，输出仍需校验和人工发布；无模型凭据也应能执行已有确定性资产。

## 权限与账户管理

| 身份/能力 | 负责什么 | 必须单独检查 |
| --- | --- | --- |
| 平台系统管理员 | 安装、用户、设备 MANAGED 信任等全局治理 | 不能凭此访问任意 Workspace 数据 |
| Workspace OWNER | 成员/所有权、空间归档、项目治理 | 最后一个有效 Owner 不能被移除或禁用 |
| Workspace ADMIN | 被授予的成员、环境、凭据及项目管理 | 不能凭隐藏 UI 绕过服务端权限 |
| EDITOR / VIEWER | 编辑或只读范围 | 环境/凭据/原始证据权限另按平台策略 |
| 设备所有者 | 私人设备授权、同意共享、撤销 | 云端位置不等于 MANAGED，也不自动同意投递秘密 |
| 服务账号 | 限定计划触发/读取/取消或有界维护 | 与员工、设备登记、业务角色用途互不替代 |

通过用户管理创建员工、禁用离职账号、发受限重置链接；邀请/重置令牌仅经受控渠道交付，不贴在工单或截图。邮件失败时不要声称已投递，按页面状态使用受限复制链接。账户改密、重置、禁用、登出和会话撤销影响登录态；独立服务账号需单独禁用/撤销，不因创建员工离职自动失效。

成员角色变更和邀请属于目标 Workspace；离职移交先设置有效继任 Owner，再移除原 Owner。归档保留历史且现有 API 没有空间恢复操作，误归档由管理员按既有运维流程处理，不能直接改库伪装恢复。

## Runtime 与密钥管理

设备登记、所有者共享、系统 MANAGED 信任、空间凭据投递分别授权。不要为了让编译或执行立即通过而关闭库存、签名、租约或当前主体检查。Runtimes 页看登记状态、设备位置、实际在线能力、共享范围、信任和投递；CLI 的 doctor 需要真实浏览器启动，但本轮交付不运行它。

Mac 优先 macOS15+ Intel x64 / Apple Silicon arm64，使用宿主原生 Chrome；Windows11 x64、Ubuntu24.04 x64 仍需各自验收。控制服务无需 Node/Chrome；桌面 Electron 的内嵌 Node 不代替独立 Node24 引擎。具体安装/打包与已知失败见[发行](../release.md)、[桌面规格](../specs/desktop.md)、[Runtime 凭据](../runtime-credentials.md)。

业务凭据由环境管理界面安全创建，使用 secretRef 与不可变 secretVersionId，allowedIdentityIds 必须匹配真实 `/me`。普通包不包含密码、Cookie、storageState、设备 token 或 cleanupToken。不要把 token/tokenId/secretVersionId 放进业务表单 label、testId、recordKey、title、query string 或报告业务名称。tokenId 仅在具有管理权的令牌元数据视图显示；它不是再次授权依据。

轮换先建立新版本、更新并发布环境、在受控 Run 验证，再按授权撤销旧版本；历史快照仍引用旧版本，不能无痕改写。已下发长期密码不能保证从不可信设备远程擦除，应使用短期业务会话和明确设备授权。下载 Trace/截图前确认当前原始证据权限；共享故障时优先导出安全摘要，检查业务正文、DOM label 和 URL 是否包含凭据标识。

## 运维启动、升级和恢复

平台初始化、MySQL 迁移、首次管理员、同源 public_url、开发 Vite 代理的精确命令沿用[开发指南](../development.md)；部署、备份/恢复、主密钥轮换和 rekey 的当前具体命令见[运维操作指南](../../deploy/OPERATIONS.md)，其源码和验证边界见[V02](../validation/tasks/V02-operations.md)。前端必须先构建并进入 Python wheel，正常发行入口沿用[发行说明](../release.md)。本指南不创建另一份安装脚本或假定候选包已正式支持四个平台。

上线检查配置/数据目录权限、MySQL8.4、密钥与签名材料、制品存储、TLS/public_url、实际 Runtime 网络、外部维护调度和备份。`/api/v1/health/live` 只表示 HTTP 进程；readiness 还要检查实际依赖，不能仅凭 liveness 放流。控制服务不在每实例启动时自动迁移，升级由单独受控迁移步骤执行。

备份要包含数据库、制品、配置、主密钥历史、签名私钥/信任材料及必要设备/运行恢复数据；密钥与数据备份按独立受限策略保存。恢复在隔离实例演练，确认同一备份时间窗的引用仍能读取、旧 secretVersion 可解密、制品 hash 与签名一致。恢复后先禁用外部触发和设备领取，核对活动租约/未知进程再恢复服务，避免重复业务写入。迁移和回滚细节参照[迁移操作](../operations/migrations.md)。

所有计划由外部中间件触发；平台无内部 Cron。调度器调用有界租约回收、fixture 清理补偿、容量核对和制品过期接口，按真实 `hasMore/nextCursor` 继续并为每页派生独立幂等键；重试同页保持原键和正文。维护与执行使用独立用途 token，详见[外部调度](../integration/external-scheduler.md)。

保留期删除涉及结构化报告与原始敏感证据的区别、当前下载授权和物理删除围栏。不要直接删目录或数据库行释放空间，避免破坏运行引用及重试/删除并发。监控 readiness、队列等待、容量 quarantine、Runtime 心跳、清理积压、保留期积压和鉴权失败；报警中保留 requestId 和稳定错误码，不记录原始请求头。

## 故障排查

| 现象 | 先检查 | 正确处理 |
| --- | --- | --- |
| 登录/导入403 | public_url、Origin、CSRF Cookie、TLS | 使用精确公开 origin；不要关闭 CSRF 或混用 Vite/后端端口 |
| 401 | 当前会话、禁用/撤销、token 用途/过期 | 正常重新认证或轮换；Bearer 失败不可回退员工 Cookie |
| 看不到空间/404 | 当前 Workspace、活跃成员、嵌套资源归属 | 切换正确空间并核对成员，不猜测别的 UUID |
| 验证持续 QUEUED | MANAGED 编译设备、批准引擎库存、在线 Worker、容量 | 修复真实运行条件后复用原作业；不得插入成功回执 |
| STALE_REVISION/SOURCE_HASH | 草稿被并发编辑或依赖变化 | 重读预览并人工比较，不覆盖他人修改 |
| CREDENTIAL_REQUIRED/身份不匹配 | secretRef/version、allowedIdentityIds、设备投递授权 | 在环境管理修正并重新发布，禁止改用 fixture 身份 |
| 网络/证书错误 | 从 Runtime 主机访问目标 UI/API/fixture/认证 | 修正实际可达 origin 和系统信任，不关闭 TLS 校验 |
| 定位重复/找不到 | 实际 DOM scope、Portal、行是否挂载、recordKey | 修正目录/正常交互并发布新版本，不 nth/force/sleep 掩盖 |
| toast 成功但回读失败 | HTTP业务码、独立GET、目标build、缓存与异步时限 | 保留失败，用真实业务契约诊断，不把 toast 当持久化 |
| 写请求断开 | 业务键/fixture code 查询、requestId日志 | 先确认真实结果，不能自动重发未知业务副作用 |
| cleanup失败 | 原信封/token、namespace所有权、fixture可达性 | 受限服务补偿与外部TTL；保留失败直到精确清理完成 |
| CANCELLED但容量占用 | 停止证据、失联Worker/Chrome、lease/fence | 保持 quarantine，按目标OS受控恢复，不按时间强制释放 |
| HTTP计划409/429 | 同键正文变化、重叠策略、10Run/全局4/空间2限制 | 原调用重试保留键，新的调用新键；等待合法容量 |
| CI200/202但未通过 | 最终outcome、真实用例数、两个gate | 等终态；SKIPPED/UNSTABLE/零用例不通过 |
| 导入进度冲突 | 平台origin/空间key、已发布内容、计划变更 | 保留原状态人工核对，另建空间key独立重做 |
| Java示例启动失败 | JDK11、私有POSIX目录、原子move、已有文件锁 | 修正样例环境；不退回共享文件/多实例无锁存储 |

共享问题时提供源码提交、工具/OS/架构、目标 build、Workspace/Run/Job 的受限标识、稳定错误码和 requestId、脱敏步骤及 cleanup 状态。不要附明文 token、密钥、Cookie 或原始未审查 Trace。后续真实复现记录使用[V06](../validation/tasks/V06-integration.md)。
