# VeriQ 1.0 交付里程碑与 Agent 接续状态

> 状态快照：2026-11-13（Asia/Shanghai）。恢复基线：`master` 提交 `e5d5a6bb93cc5cf7b9496defc3f0995ab47c8384`；本轮已审查功能分支代码 `67779ed`（T17）。本文汇总已确认范围、已落地代码、验收缺口和接续上下文；不新增功能范围，也不替代需求规格。
>
> **用户已明确恢复开发，目标为完整 MVP 交付。** 从最新 master 建立隔离功能工作区，按 T16–T23 继续子 Agent 开发及独立审查。恢复开发不等于批准实际付费 Provider 调用、正式发布或外部部署；相关验收仍需具体配置和授权。

## 1. 当前交付结论

| 项目 | 当前结论 | 接续时的含义 |
| --- | --- | --- |
| 产品目标 | 企业 PC Web 自动化冒烟/回归平台；20 人以内、同时提交约 10 个 Run | 常规运行必须直接执行固定版本 TypeScript/Playwright，不依赖模型 |
| 首发范围 | F01–F14 全部模块，包括 Electron 桌面 GUI、两平台 Runtime、安装与运维 | 阶段性实现不能被改称完整 MVP；尚未达到开箱即用标准 |
| 实施任务 | T01–T12、T14–T17 共 16 项模块代码已完成并通过相应审查 | 不重做这些任务；修改其共享接口时补相应回归 |
| AI 模块 | T13 代码与修复复审已完成，实际外部 Provider 验收未完成 | 不能把协议模拟、无模型运行成功当成实际 Provider 通过 |
| 后续工作 | T18–T23 共 6 项尚未完成；T18 构建发行正在开发，T16/T17 已完成独立审查 | 从当前功能分支接续，不重做已完成任务；T18 改动尚待独立审查 |
| 已合并内容 | PR #10 覆盖资产编辑/报告/AI/签名包；PR #11 覆盖离线运行/恢复/回传，均已合并 | 基线 `master` 已包含 T15 修复；T16/T17 在 `codex/veriq-mvp-completion` 已审查，远端检查点 `9122982` 已包含相应代码及文档，尚未合并 master |
| 主要发布阻塞 | 全量发行/覆盖率及注释规范门禁尚未关闭；实际 Provider、生产打包、Electron、目标 OS 与完整验收待完成 | T18 当前固定浏览器 SDK 门禁已通过，但不等于完整发行或最终源码验收通过 |
| 当前文档 | 本里程碑台账由 README 提供入口 | 实现状态基于上述代码提交；文档本身的提交与远端状态以 Git 历史为准 |

### 状态口径

| 标记 | 定义 | 可以据此声称什么 |
| --- | --- | --- |
| 已完成·模块 | 对应任务实现及独立规格/质量审查已通过；有记录的适用测试 | 该模块代码已落地；不能推导全产品、所有 OS、发行门禁通过 |
| 部分完成 | 已有明确子功能，但该产品模块仍缺必要交付 | 必须同时阅读“已有内容”和“剩余事项” |
| 代码完成·待验收 | 代码审查通过，但指定的实际服务/平台验收尚缺 | 不能把任务标为完整验收完成 |
| 待开工 | 尚未完成实现；准备材料不是实现，也不是已批准的全部设计细节 | 用户已恢复；按依赖启动 |
| 发布阻塞 | 1.0 发布前必须关闭的已知失败或验收缺口 | 不能用超时放宽、重试到绿、声明已知限制替代关闭 |
| 后续修正 | 已记录并明确归属的非阻塞改进/契约修正 | 后续任务和最终整分支审查必须复核，不能静默丢弃 |

## 2. 需求与决策依据

| 优先依据 | 内容 | 使用方式 |
| --- | --- | --- |
| 用户最新指令 | 根据里程碑检查进度，恢复开发并持续至完整 MVP 交付 | 已恢复；按依赖推进，真正未决的范围/架构/外部服务事项核对后处理 |
| [贡献约束](../../AGENTS.md) | 命名、技术栈、权限、测试与 Agent 协作规则 | 开发开始前阅读 |
| [完整需求规格](../specs/veriq-1.0.md) | F01–F14、运行协议、安装、质量与验收 | 解决实施计划占位定义与已确认需求的冲突 |
| [桌面规格](../specs/desktop.md) | Electron、本地 GUI、离线操作、IPC、生命周期 | 覆盖早期“只有 CLI/薄启动器”的过期描述 |
| [实施计划](veriq-1.0.md) | T01–T23 的任务、依赖和验证目标 | 任务编号以标题为准；末尾少数建议提交消息编号存在旧偏移，不据此跳过任务 |
| [公共契约](../contracts.md)及 [Schema/OpenAPI](../../packages/contracts) | 规范字段、跨语言类型、协议和授权 | 修改必须同步规范源、生成类型和兼容样本 |
| [ADR](../decisions) | 已落地技术、签名、执行、报告、离线边界 | 候选库不等于已集成依赖；具体版本以锁文件和对应 ADR 为准 |
| [开发验证记录](../development.md#current-verification-limits) | 真实结果、历史失败、验证范围和未完成门禁 | 不把历史记录重写为当前全量通过 |

### 不得偏离的基线

| 约束 | 已确认取值/行为 | 状态及注意点 |
| --- | --- | --- |
| 项目命名 | 人类可读名称为 **VeriQ**；技术标识为 `veriq` | 文档、注释、标题必须保持该大小写；命令/路径/前缀保留技术小写 |
| 服务端 | Python 3.12、Tornado **6.6.1**、SQLAlchemy 2、MySQL 8.4 | Tornado 升级已获确认，不退回 6.3/6.4；不是 FastAPI/Django 项目 |
| Web | React 18、Vite 6、Tailwind 3、ESM、React Router **7.18.5**、TanStack Query 5、Radix/CVA、i18next | 不退回 Router 6；现有其他包按锁文件复用 |
| 本地执行 | 独立 Node24、TypeScript、同一编译器/SDK/Playwright 引擎 | Electron 内嵌 Node 不能代替固定 Node24 |
| 本地持久化 | Node24 内置 SQLite、WAL/FULL、受限文件、`veriq_` 表 | 已落地，不引入本地 Python/MySQL 前置依赖；恢复占用有代际 CAS |
| 桌面 | Electron + React，本地打包 UI、main/preload/renderer、受限 IPC | 必须交付 GUI；不重新改选 Rust/Tauri，不以远程网页窗口替代离线 GUI |
| 表和进程名 | 平台表均 `veriq_`，迁移表 `veriq_alembic_version`；自有进程 `veriq`/`veriq_agent`/`veriq_runner`，CLI 可 `veriq_cli` | Windows/Linux 都检查实际 OS 名称，不只改标题 |
| Workspace | 一项目一 Workspace；成员可加入多个；所有资源和嵌套引用均校验归属 | 系统管理员不是默认空间成员，也不默认拥有私人设备派单权 |
| 服务账号 | 独立于员工登录，令牌限 Workspace/计划/维护操作 | T16 必须补齐 CI 执行身份，不能用创建者会话冒充独立服务主体 |
| 调度 | 外部中间件唤醒 HTTP；平台无内部 Cron | Agent 轮询、心跳和受限 HTTP 维护继续保留 |
| 容量/租约 | 最多 10 个未结束 Run；在线全局 4、空间 2、本机离线 1；心跳 10 秒、租约 60 秒 | 过期不能复活；不能用逻辑取消、超时或 PID 不存在代替可靠停止证明 |
| 重试 | Playwright retries=0；平台最多一次安全的整用例重试；重试通过为 UNSTABLE | 业务写入未知不盲重放；新 Context/fixture/工作目录/namespace |
| 源码与预期 | 可编辑 DSL，生成 TS 不可变；运行冻结资产/引擎/环境/数据/角色/浏览器 | 不能执行漂移的最新版或把当前实际值复制为断言真值 |
| 离线信任 | 独立可信根验签；包不携带密钥/密码/Cookie/token；引用精确到版本 | UNKNOWN 撤销状态不能当 CURRENT；已知撤销硬拒绝 |
| 导入来源 | 独立 OFFLINE_IMPORT；当前正式门禁固定 false；不覆盖线上 Attempt | 包签名证明内容来源，不证明本地结果不可伪造；缺失变体不能 PASSED |
| 生产发布 | 先 Web check/build，再放入 `apps/srv/src/veriq_server/static/dist`，随 Python wheel 发布 | 正式服务端运行不需要 Node/Chrome；不是 Java/JAR 构建 |
| 复用与许可 | 保持 AGPL-3.0；优先成熟包和薄适配，不整站 fork | 变更依赖先核验版本/兼容性/许可/安全差异并记录 ADR；不重复造通用基础设施 |
| 人工维护规范 | 4空格、中文注释、英文日志；公开API和核心路径说明；有效注释覆盖率>40%，注释块首行有效文字≥60字符 | 遵守最新AGENTS及配置；禁止口号填充；历史注释覆盖率统计不代表当前版本；源码格式变化也必须重新绑定构建hash |
| 最终门禁 | 默认全测，Python/TS 核心行覆盖率分别 ≥75%；真实目标 OS、安装与故障验收 | 尚未证明这些整体验收全部满足 |

## 3. 里程碑总览

| 里程碑 | 覆盖任务 | 对应交付 | 当前状态 | 完成说明 / 退出条件 |
| --- | --- | --- | --- | --- |
| M01 工程、账户与空间 | T01–T03 | 契约、基线、自有账户、初始化、Workspace/RBAC | 已完成·模块 | 已有真实 API/UI 和审查；生产安装/全量覆盖率仍属后续 |
| M02 测试资产与执行语义 | T04–T07 | 不可变资源、编译器、操作断言 SDK、fixture/业务身份 | 已完成·模块；SDK 发布门禁阻塞 | 实现已落地；必须关闭完整 SDK 的既有 browser.close 超时 |
| M03 在线执行与编辑报告 | T08–T12 | 设备、统一队列、Linux Agent、资产 UI、实时报告/证据 | 已完成·模块 | Windows、安装包和桌面不包含在这次模块完成声明中 |
| M04 AI 辅助 | T13 | 配置、预算、结构化生成、审核、失败分析、无模型执行 | 代码完成·待验收 | 需要经授权实际 Provider 验收和独立持久配置 |
| M05 签名包与离线链路 | T14–T15 | 签名/验证、凭证引用、本地执行/恢复/报告/回传 | 已完成·模块 | 单 CASE、套件矩阵、草稿套件、崩溃证据链均有真实组合验证；GUI/安装待后续 |
| M06 外部自动化与服务器产品化 | T16–T18 | HTTP 触发/CI、生产同源、前端入 wheel、服务端发行 | 部分完成·T16/T17已审查 | 下一T18：前端入wheel、构建/SDK/发行验收 |
| M07 桌面与跨平台 Runtime | T19–T20 | Electron 全 GUI、Windows/Linux 安装与原生能力 | 待开工 | 两平台真实安装与生命周期、OS vault、签名/离网验收 |
| M08 运维与完整用户体验 | T21–T22 | 安装升级、备份恢复、观测、生命周期、示例/手册/接入 | 待开工 | 新环境按文档操作成功；全模块真实交互和中英文/键盘覆盖 |
| M09 1.0 产品验收 | T23 | 全范围、并发、故障、业务多轮、发行物与整分支审查 | 待开工 | 全部阻塞、授权和平台验收关闭后才可以标记 1.0 完成 |

## 4. 产品功能交付矩阵：F01–F14

| 编号 | 必须交付的全部功能要点 | 当前状态 | 已完成说明与上下文摘要 | 仍需交付 / 验收归属 |
| --- | --- | --- | --- | --- |
| F01 安装初始化 | 部署、迁移、管理员创建、配置预检、健康检查、示例初始化 | 部分完成 | 账户初始化、配置/迁移基础、开发启动已有；无固定管理员密码 | 同源服务已由T17交付；wheel/镜像/Compose/离线部署、doctor/升级恢复和示例向导由T18/T21/T22完成 |
| F02 自有用户 | 登录/退出、邀请/创建、单次重置、禁用、会话撤销 | 已完成·模块 | T02 真实账户 API/UI，opaque session、密码哈希、Cookie/CSRF、管理员操作 | 全产品安装与用户路径、可用 SMTP 部署引导、最终安全回归；T21–T23 |
| F03 Workspace | 一项目一空间、多成员、固定角色、切换、隔离、审计 | 已完成·模块 | T03 授权仓库和后续嵌套资源/证据/导出导入均已接入；系统管理员不隐式跨空间 | CI独立服务主体已由T16交付；桌面切换/缓存隔离与全模块撤权回归由T19/T23完成 |
| F04 页面元素 | testId/role、recordKey、作用域、目录版本/引用影响 | 已完成·模块 | ELEMENT_CATALOG、严格唯一定位、版本与编辑器已有 | 完整前端 testId 接入规范、示例与组合控件/键盘/Portal 验收；T22 |
| F05 用例资产 | 表单/JSON 双向、步骤、数据、变量、流程、草稿修订、校验发布、差异归档 | 已完成·模块 | 八类资源、CAS 修订、不可变发布、真实 Agent 编译回执、源码浏览；不是服务端直接编译 | 桌面适配、示例、全部交互与冲突恢复验收；T19/T22/T23 |
| F06 操作断言 | UI/URL/请求/响应/业务码、JSON Pointer/Schema、持久化、最终一致、模板与预期来源 | 已完成·模块；发布阻塞 | T05/T06 实现前置/后置断言、动作前监听、请求关联、dispose、类型化变量和受控重试 | 关闭完整 SDK 超时，匹配固定浏览器；补最终全产品业务故障验收；T18/T23 |
| F07 环境身份 | 地址/域名约束、语言时区、角色、凭证版本、构建身份 | 已完成·模块 | 独立认证注册、AES-GCM 版本凭证、按 Attempt 授权、明确下发同意、精确本地映射 | OS vault、代理/证书/桌面设置、实际部署手册；T19–T22 |
| F08 测试数据 | fixture 准备/查询、namespace、幂等 cleanup、部分失败/崩溃补偿 | 已完成·模块 | T07 真实 HTTP 示例与 SDK；统一 CLEANUP Job、独立 fixture 身份、TTL 契约与安全重试 | 实际企业业务接入、升级/失联补偿运维、跨 OS 故障验收；T21–T23 |
| F09 Runtime | 云端/本地、注册、自检、私人/共享、撤销、实际进程名 | 部分完成 | 设备身份/授权、真实 Linux 原生 guardian、在线 Agent/离线执行/doctor 已有 | Electron GUI、独立 Node/浏览器分发、Windows 原生进程树、服务/自启动/安装；T19/T20/T21 |
| F10 执行调度 | 手动、HTTP 触发、队列、容量、租约、取消、重跑与整用例重试 | 部分完成 | 手动入队、TEST/VALIDATE/CLEANUP、fencing、真实消费者/恢复/重试及T16计划/HTTP/服务身份/CI已验证 | 计划/HTTP/QUEUE/SKIP/REJECT/安全JUnit已交付；重跑及遗留API由T22补齐，实际10 Run压测由T23完成 |
| F11 报告 | 实时进度、差异、请求关联、所有 Attempt、耗时/环境/清理、证据、可信门禁、JUnit | 部分完成 | Web 结构化报告/SSE、受限原始证据、File/S3、Trace 本机查看、离线报告接口已有 | T16已交付受限CI状态/安全JUnit；桌面展示、指标/生命周期与最终统计验收仍由T19/T21/T23完成 |
| F12 本地离线 | 依赖闭包、签名/安全安装、凭证、脱平台运行、报告、恢复/回传/来源 | 核心代码已完成；产品形态待补 | T14/T15 真正断开控制监听后运行并回传；代际 CAS、证据/变体完整性与不可变导入已修复复审 | 无终端 GUI、OS vault、离网安装与两平台完整体验；T19/T20/T23 |
| F13 AI 辅助 | Provider 配置/连接、需求/OpenAPI/元素上下文、结构化草稿、审核、边界建议、失败分析、历史/费用预算 | 代码完成·待验收 | T13 已代码复审；官方 SDK、独立密钥、并发预算预留、取消/未知费用、人工审核；禁用/耗尽模型时真实 Run 仍成功且模型请求为 0 | 实际 Provider 授权与持久验收；契约/选择器遗留、最终 UX；T13/T16/T22/T23 |
| F14 产品运维 | 同源发布、安装升级、备份恢复、保留期、日志指标、许可、手册/验收报告 | 部分完成 | 基础配置/迁移/审计、原始证据 File/S3/退役屏障、精确锁与第三方声明已有 | 生产同源服务已交付；服务器/桌面发行、元数据/包保留期、密钥轮换恢复、指标与手册/验收由T18–T23完成 |

## 5. 实施任务台账：T01–T23

下表的“完成”指模块实现，不覆盖第 8 节的发布阻塞。短提交用于定位历史实现；合并方式可能导致主分支上另有合并提交。

| 任务 | 依赖 | 状态 | 完成说明与接续摘要 | 定位 / 后续动作 |
| --- | --- | --- | --- | --- |
| T01 工程与契约 | 无 | 已完成·模块 | 冻结基线、ADR、Schema/OpenAPI、Python/TS 共用兼容样本、生成一致性 | `23b5282`、`188c856`；[契约](../contracts.md) |
| T02 账户初始化与会话 | T01 | 已完成·模块 | 自有账户、安装引导、重置邀请、密码哈希、CSRF、禁用/撤销和管理 UI | `678587d`、`32e625e`；完整覆盖率门禁仍待 T18 |
| T03 Workspace 授权 | T02 | 已完成·模块 | 显式 WorkspaceScope、角色矩阵、最后 OWNER 保护、跨空间及 UI 切换 | `ef0fb6d`、`39672c4`、`eb75c4b`；后续主体和资源继续复用 |
| T04 资产版本与发布 | T01/T03 | 已完成·模块 | 八类统一资源、revision、依赖/影响、不可变版本/回执；真实写入由 T09/T10 补齐 | `2a2dd25`；不能伪造回执绕过发布 |
| T05 确定性编译 | T01/T04 | 已完成·模块 | compileAssets/assembleExecution、变量依赖、流程限制、实际 TS/manifest/依赖、源码哈希 | `dcb05c0`、`3588164`；[ADR0006](../decisions/0006-deterministic-compiler-artifacts.md) |
| T06 操作监听与断言 | T05 | 已完成·模块；发布阻塞 | 真实浏览器 SDK、关联响应、严格 JSON 类型/Pointer、持久化/最终一致、监听回收 | `2482be9`、`68c99fd`；当前完整 SDK 超时归属 T18 前解决 |
| T07 fixture/业务身份 | T06 | 已完成·模块 | HTTP prepare/query/cleanup、独立身份、声明输出、namespace/TTL、凭证轮换/撤销与安全重试 | `01561bc`、`6952a5b`；[后端接入](../integration/backend.md) |
| T08 设备与授权 | T03/T07 | 已完成·模块 | 注册/轮换/退出、自检、owner 共享、MANAGED 审批/独立下发同意、服务账号登记基础 | `255e7a4`、`094e670`；登记码误触发会话失效待 T22 |
| T09 队列/租约/fencing | T04/T08 | 已完成·模块 | MySQL 原子领取、20 claimer 竞争测试、容量、租约失效/迟到回报/未知进程隔离 | `170c277`、`a9956f3`；CI 执行服务主体由 T16 延伸 |
| T10 Agent 监督与重试 | T06/T07/T09 | 已完成·模块 | Linux 内核 subreaper、真实 Worker、事件、取消/丢租约、凭证 broker、停止证明/恢复 | `d04a4fc`、`ee8da33`；Windows/vault/预编译发行在 T20 |
| T11 资产/环境编辑 UI | T04/T05/T08/T10 | 已完成·模块 | 八类表单/JSON、模板/流程/数据、源码预览、版本差异、实际 Agent 编译发布/冲突恢复 | `c128ac5`、`b49f981`；最终编辑器浏览器 9 项通过，Monaco 优化待 T22 |
| T12 实时报告/证据 | T10/T11 | 已完成·模块 | SSE 补读、事实归约、原始证据独立 ACL、File/S3 发布/退役、可信门禁、历史兼容 | `f77a9b9`、`47986b0`；完整生命周期/契约遗留见后文 |
| T13 AI/无模型运行 | T11/T12 | 代码完成·待验收 | 配置/预算/审核/分析/历史实现及修复复审通过；真实无模型 Run 请求模型 0 次 | `f9573d0`、`3c96eb6`；实际外部 Provider 是未完成验收项 |
| T14 签名包/本地凭证 | T04/T10 | 已完成·模块 | 持久 Ed25519、可信 key 缓存、闭包/入口/SDK/依赖校验、只读安装、精确凭证；多 CASE/版本分页 | `46798ab`、`3ffb144`、`c1fa544`；[操作](../offline-bundles.md) |
| T15 离线/报告/回传 | T12/T14 | 已完成·模块 | SQLite、真实脱平台执行、恢复/取消、报告/原始证据、不可变导入、矩阵完整性和候选套件；4 项阻塞均修复复审 | `1b6fccb`、`86f1602`、`67968b4`；[操作](../offline-execution.md)、[ADR0017](../decisions/0017-offline-execution-import.md) |
| T16 HTTP 触发/维护/CI | T09/T12，并保留 T15 接口 | 已完成·模块 | 计划修订/冻结、独立执行token、真实同计划领取门控、幂等、GUI和CI已落地；I1认证回退/I2总截止时间修复复审关闭，零新增阻塞 | `599f989`、`10a1065`；[接入说明](../integration/external-scheduler.md)、[ADR0018](../decisions/0018-external-plan-trigger.md)；M1/M2见D12/D13 |
| T17 生产同源服务 | T02/T11 | 已完成·模块 | 唯一工厂、包内完整文件库存、已登记SPA GET/HEAD、API/静态404、缓存/范围/条件响应、build-info和健康兼容；HTML策略两轮修复复审关闭 | `4b58a4c`、`0f48d6e`、`67779ed`；[ADR0019](../decisions/0019-production-static-inventory.md)；stage/wheel仍属T18 |
| T18 构建与服务端发行 | T17 | 开发中·待审查 | 标准 wheel/stage 行为已有实际失败测试，构建和引擎工具开发中；固定浏览器 SDK 136 项通过、行覆盖率 91.46% | Web 入 wheel、干净安装、无 Node/Chrome、完整构建与覆盖率；正常发行仍受 B05 阻塞 |
| T19 Electron 全 GUI | T10/T11/T12/T14/T15 | 待开工 | Cloud/Local 资源/报告适配接口已有，不能算桌面应用已经实现 | main/preload/renderer、完整界面/IPC/离线/生命周期与真实 E2E |
| T20 两平台 Runtime 发行 | T19 | 待开工 | Linux 开发原生 helper 已验证，不等于 Ubuntu/Windows 安装包 | 两 OS 独立构建、Node/浏览器/vault、安装升级签名、实际进程名 |
| T21 安装运维 | T12/T16/T18/T20 | 待开工 | 基础 init/migrate/配置/原始证据维护已有，完整产品运维未完成 | Compose/离线包、备份恢复/轮换、生命周期、指标及遗留 M1 |
| T22 全模块 UX/示例/接入 | T11/T12/T13/T15/T16/T19/T21 | 待开工 | 现有局部页面/后端示例/说明不是完整示例向导或完整手册 | 全菜单真实操作、中英文/键盘、示例与前后端规范、遗留 UX |
| T23 1.0 完整验收 | T01–T22 | 待开工 | 尚无完整产品发行验收结论 | 全范围矩阵、10 Run、故障/篡改/权限、5–10 流程×≥5 轮、实际 Provider/OS、整分支审查 |

## 6. 剩余交付明细及完成标准

本节全部事项仍属首发范围；T16行已按模块交付更新，其余继续按依赖完成。下列路径未存在时表示拟交付物，不是可以直接运行的命令或文件；任何模块完成均不代替最终发布门禁。

| ID / 归属 | 待交付事项 | 已有上下文 / 状态 | 必须满足的完成说明 |
| --- | --- | --- | --- |
| R16-01 / T16 | 执行计划 CRUD 与 Web 管理 | 已完成·模块 | SUITE/环境/角色/浏览器/Runtime/重叠策略/重试配置，嵌套校验、修订冲突、分页、权限、真实表单操作 |
| R16-02 / T16 | 独立 CI 服务主体和 token | 已完成·模块 | token 限 Workspace/计划/操作，独立于创建者登录；当前撤销/禁用贯穿入队、领取、续租、凭证、完成和结果读取；不假造 User |
| R16-03 / T16 | 幂等 HTTP trigger | 已完成·模块 | 同键同参复用 Run、异参 409；首次入队 202；有限排队、状态 URL、真实快照与消费者；无内部 Cron |
| R16-04 / T16 | QUEUE/SKIP/REJECT | 已完成·模块 | 同计划 QUEUE 真正等待前序；SKIP 200+FINISHED/SKIPPED+无 Job；REJECT 409；10 个未结束 Run 原子限制和并发验收 |
| R16-05 / T16 | CI 结果/退出码/JUnit | 已完成·模块 | 仅实际合格通过返回成功；UNSTABLE/INCOMPLETE/SKIPPED 不冒充通过；有超时/取消/鉴权错误处理；使用安全结构化投影或受限等价方式，不能放开 raw ACL |
| R16-06 / T16 | 外部维护/调度接入 | 已完成·模块 | 完整文档/示例、受限 token、幂等/有界批次/hasMore；沿用线上→`offline:<id>` 续页语义；真实 trigger→Agent→报告/CI 组合验收 |
| R16-07 / T16 | 公共契约遗留修正 | 本轮纠正已完成；全局D11待补 | history/audit 的 after 参数；维护四操作列表的数量/唯一/未知值；AI 普通 Cookie/CSRF 入口不得声明无实现的 ServiceToken |
| R17-01 / T17 | 静态/SPA/API 路由 | 已完成·模块 | 健康/版本→API/internal→静态→登记 SPA GET/HEAD→404；未知 API 返回 JSON；缺 JS/CSS/图片不回 index |
| R17-02 / T17 | 路径、缓存与构建版本 | 已完成·模块 | 防穿越/链接；index 不缓存、hash assets immutable；build-info 与产物一致；开发缺 dist 可启动，生产缺产物启动失败 |
| R18-01 / T18 | `build.sh` 与顺序构建 | 未完成完整入口 | 精确工具/锁检查→Web 类型/lint/格式/build→安全 stage→后端检查/测试→wheel→干净安装→原子 output；不套用 JAR |
| R18-02 / T18 | Hatch/安装包完整性 | Schema/OpenAPI 入包基础已有 | editable 不要求 dist；正式 wheel 缺 dist/manifest 失败；完整 assets/迁移/版本/示例入包，无重复或旧资源；无 `.git` 源发行可构建 |
| R18-03 / T18 | 正常/紧急门禁 | 尚无完整发布结论 | 默认完整测试；`--with-tests` 等于默认；`--skip-tests --reason` 留痕且不跳静态/完整性检查，正常 release 拒绝紧急未验证产物 |
| R18-04 / T18 | 服务器发行物 | 待交付 | wheel、适配 Python3.12/目标 ABI 的 wheelhouse、tar/OCI、启动/部署资料、release.json/hash/SBOM/NOTICE；干净运行不依赖 Node/Chrome |
| R18-05 / T18 | 引擎批准/版本和质量 | 有测试构建器，不是生产批准工具 | 真实引擎产物与库存晋升；遵守 issuer/inventory/DB 锁协议；不能同版本覆盖不同内容；匹配浏览器的 SDK 门禁、核心行覆盖率 ≥75% |
| R19-01 / T19 | 桌面安装入口/窗口壳 | Electron 尚未交付 | 本地 renderer、单实例、托盘、重新唤起、版本/后台状态；不只载入远程网址 |
| R19-02 / T19 | 登录/空间/设备/资源 | 有 Web/Runtime API 可复用 | 配置控制地址、登录退出、Workspace/设备绑定与共享、浏览用例套件、下载、凭证映射、可见/无头选择 |
| R19-03 / T19 | 本地执行全 GUI | T15 host API 已有，界面待做 | 无终端启动/取消/恢复、进度、步骤断言/日志、历史、报告/Trace；断平台后仍可打开、运行、看报告；恢复后待上传与重试 |
| R19-04 / T19 | IPC 与 host 会话 | 预研待做 | contextIsolation、关闭 renderer Node、适用 sandbox；白名单参数/sender 校验；token/vault/任意 fs/spawn 不给 renderer；无无鉴权本地控制 HTTP |
| R19-05 / T19 | 生命周期与设置 | 待实现/真实 E2E | 关闭窗口、退出 UI、停止 Agent、取消测试独立；UI 崩溃不丢后台任务；自检、目录/缓存/并发、代理/证书及错误恢复可操作 |
| R20-01 / T20 | 独立 Runtime 和浏览器分发 | Linux dev helper 不是发行物 | 固定 Node24 与 Electron ABI 分离；编译器/SDK/锁/浏览器按 OS/arch 分发，全离网安装不共用 node_modules，不要求本机 Python/MySQL/cc |
| R20-02 / T20 | 原生进程、存储与停止 | Linux subreaper 有实际证据 | Windows 原生 Job/进程树与 Ubuntu 路径实测；OS vault；所有自有进程真实命名；未知停止继续隔离 |
| R20-03 / T20 | 安装升级卸载/签名 | 待交付 | Windows/Linux 安装包、启动停止/自启动、升级回滚、数据保留、签名/摘要校验；执行中不强更；开发签名与正式签名分开 |
| R21-01 / T21 | 部署与快速开始 | 有开发说明，不是完整生产安装 | Compose(API+MySQL+volume)、可选 demo/runtime profile、Python venv+wheelhouse、服务/systemd、可照做的初始化与网络映射 |
| R21-02 / T21 | 配置和迁移 | 基础优先级/CLI 已有 | CLI>VERIQ_>文件>默认；显式安全密钥/URL/DB；生产单迁移 job；只读包+外置数据/配置，实际预检/健康诊断 |
| R21-03 / T21 | 备份恢复/轮换/兼容 | 尚未完成整体验收 | DB/制品/所需密钥一致备份恢复；密钥轮换/rekey；升级不覆盖配置；不兼容回滚拒绝；数据库/Runtime/安装包兼容矩阵 |
| R21-04 / T21 | 完整生命周期与缓存 | 原始证据到期维护已有 | 元数据90天、导出包14天、成功原始证据14天/失败30天可配置；覆盖离线结果/上传/幂等记录/缓存；活动任务/最小退役屏障不能被盲删 |
| R21-05 / T21 | 指标和运维故障恢复 | 部分日志/健康基础已有 | 队列/容量/租约/心跳/事件积压/cleanup/存储/模型成本；liveness/readiness 分离；未知进程、离线设备和真实受管理云端执行恢复 |
| R22-01 / T22 | 全模块 UX 和语言 | 局部功能已实测 | 全 F01–F14 真实菜单/API、空/加载/错误/成功/权限态、表单/冲突、重连、键盘、PC≥1280、中英文；关闭所有已登记 UX 遗留 |
| R22-02 / T22 | 示例工程/向导 | Python HTTP demo 已有 | 示例 Workspace/目录/CASE/DATASET/FLOW/FIXTURE/SUITE/角色/计划，按 Runtime 可达 URL 配置，真实执行；不能用假报告代替 |
| R22-03 / T22 | 前端接入规范 | 主规格已有，独立完整指南待交付 | testId 业务语义、recordKey、作用域、Radix Portal/Trigger/Content、CVA/asChild/ref、TanStack 后台请求/乐观更新、locale/timezone、dnd-kit 键盘、DOMPurify |
| R22-04 / T22 | 后端接入规范与手册 | 已有 Python fixture 说明 | Java/Spring 与 Python HTTP/OpenAPI/正常角色认证、fixture/query/幂等 cleanup/requestId/build SHA；用户/管理员/接入/运维/故障全手册可重现 |
| R23-01 / T23 | 需求与发行报告 | 尚未完成 | F01–F14 逐项需求→实现→测试→产物映射、真实结果、已知限制和明确 release decision |
| R23-02 / T23 | 并发/故障/权限/篡改 | 局部测试不能替代整体验收 | 同时10 Run、4全局/2空间/1本机；快速响应、未持久化、歧义、失联、旧回报、取消/清理/证据失败、跨空间/私人设备、断网/缺凭证/篡改/重复导入 |
| R23-03 / T23 | 多轮业务/模型 | 参考系统实跑及无模型检查已有 | 真实业务5–10条关键流程×至少5轮，注明目标/build/角色、保留失败和修复；至少一个经授权实际 Provider，不能把轮次当统计可靠性证明 |
| R23-04 / T23 | 目标 OS/安装/升级恢复 | 未完成 | wheel 干净安装与生产深链接、服务器镜像、两 OS Runtime 安装/签名/进程/离网/升级/恢复；实际环境证据齐全 |
| R23-05 / T23 | 最终整分支复审与交付 | 尚未执行 | 独立整分支规格/质量审查、遗留清单复核、全量/覆盖率门禁、完整发行物/锁/许可/手册；发布授权与凭证单独确认 |

## 7. 最近一次完成的 T15：必须保留的上下文

| 项目 | 已落地结论 | 后续修改的约束 |
| --- | --- | --- |
| 完整链路 | 真正 Agent 编译/发布→签名导出/设备下载→OOB 指纹绑定→关停控制 HTTP 监听与已有连接→业务 HTTP/Chromium→恢复控制→正式设备客户端上传→MySQL 报告/原始证据 | 不用合成回执或只接收 receipt 的假服务器替代这条验收 |
| C1 恢复竞态 | 修复旧 ALLOCATED 观察释放正在 SPAWNING 的占用；SQLite v2 加 generation，恢复与启动事务 CAS，停止/完成/检查点同代际校验 | 两 OS 进程 barrier 验证两种顺序；NO_PROCESS_SPAWNED 仅允许成功阻止启动的恢复方使用；其他路径仍要 native proof |
| I1 缺失变体 | 按签名选择+受限浏览器 fallback 推导最多1000变体；未提交项投影为 INCOMPLETE、零 Attempt，计入报告/统计 | 不相信顶层结果或任意客户端计划；完整有效矩阵仍可 PASSED；不能一概降级掩盖错误 |
| 显式执行选项 | 可选 OfflineExecutionChoicesV1.browsers，1–3个唯一值；省略默认 Chromium | 签名 SUITE 显式 browsers 优先；直接 CASE 顺序来自签名选择 |
| 旧结果兼容 | 无 execution facts 仅能映射到唯一确定变体；歧义422/OFFLINE_VARIANT_FACTS_REQUIRED | 保留本地历史与 PENDING、提示明确错误，不能重跑业务或猜归属 |
| I2 证据与交接 | 原始字节 flush 后，ARTIFACT_CREATED 和描述符同 SQLite 事务；nextAttempt 与初始检查点原子提交，含 variantKey | 强杀宿主后 DOWNLOAD 可授权读取并按原 checksum 上传；恢复结果仍保守，不因文件存在而成功 |
| I3 编译根 | 已发布 SUITE 使用自己的 source/descriptor/真实编译文件；DSL-only 使用 draft/source.json；直接 CASE 保持自身编译根 | 发布 CASE 依赖的原始 source/receipt 单独保留审计；候选 SUITE 不能伪造为发布 CASE；候选导入无独立发布 expected plan 时 INCOMPLETE/gatefalse |
| 结果权威 | 新建 OfflineImport/OfflineAttempt 和独立 Run/CaseExecution | 不创建假的线上 lease/fencing；不覆盖原有在线 Attempt 全字段 |
| 原始证据 | 受限 host accessor、当前服务器权限、不可变附件 allowlist、File/S3 incarnation/发布记录 | 预上传未列出附件、提交后追加、迟到 finalize 都不能改变已提交结果 |
| 锁与维护 | 先 installation 后设备 token；初始鉴权事务在等待有限验证槽位前提交；过期维护线上阶段后 `offline:<id>` | 不在数据库权威锁内等待验证槽/外部存储；修正游标时同时保证总 batch budget 和幂等 receipt |

## 8. 阻塞、后续修正与人工输入

| 编号 | 状态 / 归属 | 已知事实和上下文 | 下一步 / 关闭标准 |
| --- | --- | --- | --- |
| B01 完整 SDK | T18 当前门禁通过；改动待审查，T23 最终复核 | 固定 Chromium158/revision1254 下完整 136 项/15 文件通过，33.38秒，V8 行覆盖率 91.46%（911/996）；保留15秒/两 worker，83个源码及锁文件哈希复核一致。历史134通过/1 browser.close超时和定向47通过的记录仍保留，旧根因未知 | 独立审查 T18 浏览器选择改动；最终发行绑定最终源码/锁与适用门禁，不把本次未复现当成旧根因已修复，不重复跑到绿 |
| B01a 浏览器差异 | 当前测试选择已调整，待 T18 审查；历史因果未证实 | SDK 测试改为显式 `VERIQ_TEST_CHROMIUM` 覆盖或 Playwright 固定浏览器；本次使用官方 Chromium158/revision1254。开发机 Chromium156 与旧失败的因果未证明 | 保持可移植选择、固定版本和原有时限/并发及业务断言；匹配浏览器的通过不能倒推出原先156的故障根因 |
| B01b 诊断隔离 | 必须保留的教训 | 历史一次 DEBUG 传到生成测试子进程，触发合成保护值泄漏断言；正常 Runtime 的显式子环境与该诊断不同 | 新观测不污染生成子进程；不能把受污染诊断命令当全绿或据此推断正常运行泄漏 |
| B02 实际 Provider | 待授权/配置；T13/T23 | 尚未确认实际 endpoint/model/预算并安全配置真实 key；没有进行实际外部调用 | 先明确服务/模型/预算与调用许可，在独立持久配置安全填 key；记录合成输入、实际 usage/cost/结果。此前建议不是授权，“继续”不是付费调用许可 |
| B03 目标 OS/发行 | 发布阻塞；T18/T20/T23 | 开发 Linux 原生执行、内置 SQLite、源码构建不是 Windows11/Ubuntu24.04 安装验收 | 对应 OS 真实构建安装、生命周期/vault/离网/升级/签名与报告；正式签名凭证不足时只标开发包并待确认 |
| B04 全量/覆盖率 | 发布阻塞；T18/T23 | 局部和模块检查有记录，但无完整发行和 Python/TS核心≥75%结论 | 同一代码/锁/static hash 的正常完整门禁；条件缺失不能自动跳过 |
| B05 编码规范 | 发布阻塞；T18检查/T22整改/T23复核 | 人工修改后不能沿用旧注释比例；e5d5a6b词法预检（含测试、排除生成、Python含docstring）约为Python6.9%、TS/JS4.9%，尚不满足>40%；该预检不是最终规范门禁 | 固定计数方法和排除清单，补充符号职责/不变量/行为说明并审查质量，达到>40%；公开API、中文注释、首行≥60字及英文日志同步检查，禁止填充或降低门槛 |
| D01 history/audit after | 后续修正；T16 | T12 接口可用，规范缺部分 after 查询声明 | 同步 OpenAPI/生成类型/真实分页正反例 |
| D02 维护四操作 | 后续修正；T16 | allowed枚举4项而旧 maxItems=3 | 支持完整合法列表，拒绝重复/未知/错误目的；不扩大 token 权限 |
| D03 AI auth 文档 | 后续修正；T16 | AI context preview/cancel 的部分声明含未实现 ServiceToken | 对齐实际 Cookie/CSRF，不以文档修正名义偷加新权限 |
| D04 T14-M1 本地输入 | 非阻塞遗留；T21/最终复审 | trust bind 文件 readFile 后才检查64KiB | 改用有界 regular-file/nofollow 读取并证明超大输入拒绝；不能只在读完后检查 |
| D05 T15-M1 引用查询 | 非阻塞遗留；T21/最终复审 | publication recover/offline_pins 会在权威锁内 materialize 所有匹配别名，缺针对性索引 | indexed EXISTS/LIMIT1及空间/hash/存活条件索引，保留 pending/complete/过期区别；小范围多别名/查询计划验证 |
| D06 危险清理 | 必须保留的存储约束；T21 | 空退役对象/最小幂等 tombstone 阻止迟到写入复活；元数据与包生命周期尚不完整 | 不按 age 盲删屏障/未知 IN_PROGRESS/幂等映射；显式定义90/14天与最小状态压缩/保留策略 |
| D07 登记码 UX | 非阻塞遗留；T22 | 设备登记错误401可能误清前端有效会话 | 区分登记错误与平台登录失效，覆盖真实前端回归 |
| D08 Monaco | 非阻塞遗留；T22 | eager Monaco 造成生产构建大 chunk 警告 | 优化加载仍保留离线 worker/assets；实际构建/E2E检查 |
| D09 AI CASE picker | 非阻塞遗留；T22 | source picker 对不支持的 CASE 上下文仍可选 | 按实际支持范围过滤/解释，并保持当前空间与权限 |
| D10 文案/告警 | 非阻塞遗留；T21/T22 | 历史说明日期/文案及测试颜色环境噪声 | 分别清理文案和基础设施警告，保留真实失败；不是新的核心功能 |
| D11 公共API遗留 | 必须闭合；T22/最终复审 | OpenAPI账号detail/revoke、Run rerun/events声明与实际路由不一致；实际已有disable及报告stream | 逐项对齐；F10重跑必须实现新Run/新上下文及当前授权，不静默删去；重复旧声明只有已有等价功能时才可清理 |
| D12 T16-M1 分页深链接 | 非阻塞遗留；T22/最终复审 | 报告目标Workspace在后续cursor页时，effect只依赖首项ID，加载更多后不自动选择 | 跟踪目标加载状态并避免覆盖后续人工选择；真实跨页浏览器回归 |
| D13 T16-M2 方法匹配 | 非阻塞遗留；T22/最终复审 | 计划detail POST、collection PUT/DELETE参数不匹配导致500而非405 | 按action/method提前拒绝；实际HTTP负例，保留认证/CSRF |

## 9. 验证证据：如何解释“已完成”

此表同时保留历史模块记录与本轮恢复基线检查。历史结果仅绑定其对应代码，不等于当前集成版本全量通过；本轮没有执行实际 Provider 请求。

| 证据组 | 实际结果 | 绑定及不能推导的结论 |
| --- | --- | --- |
| 2026-11-13恢复基线 | Python契约171通过/4.48秒；TS契约200通过/11.09秒；生成文件与契约类型检查通过 | e5d5a6b、冻结依赖；仅契约基线，不是完整SDK/覆盖率/发行验收 |
| T16实际组合/GUI | 真实服务账号Agent/CI/JUnit场景通过；最终GUI4通过/1.2分钟；独立于创建者登录，实际业务浏览器与凭证解析 | 开发Chromium156/PW1.65，非正式匹配浏览器门禁；令牌截图在dismiss/revoke后保存，无明文 |
| T16原始广套件 | 服务端437通过/4失败；Runtime63通过/3失败；TS先199/2，再200/1 | 全部保留：证据目录、方法期望、编译EXECUTION_ERROR、遗漏浏览器路径及兼容超时；不能称统一全绿 |
| T16定向纠正 | 服务端46通过/1证据变量错误，单项纠正1通过/41.02秒；Runtime原3项纠正后3通过；契约185通过 | 两项旧编译失败定向通过，但原因未证明；库存隔离/磁盘条件已改善，不倒推故障根因 |
| T16重要问题修复 | I1认证RED1失败、I2截止RED3失败/2通过；修复后18通过，最终传输7通过 | 最后小幅传输收紧由7项覆盖，不声称另一次统一20项运行；严格mypy84文件、Ruff/格式/生成检查通过 |
| T16独立审查 | 首轮0Critical/2Important/2Minor；修复复审I1/I2均关闭，新增问题0 | `599f989`→`10a1065`；M1/M2明确T22，跨任务发布门禁保持开放 |
| T17基础同源/契约 | Python受影响310通过/157.95秒；TS契约201通过；开发浏览器1通过/19秒 | 同期真实生产HTTPS/完整Vite/MySQL登录及刷新通过；测试包fixture不是已安装wheel |
| T17静态策略修复 | 首轮I1部分关闭；第二轮针对参数化HTML/XHTML重封清单RED6失败，最终静态90通过/3.69秒 | 全部原始RED/过渡41setup错误及中间51/61/82/84通过分版本保留；不合并为同一源码结果 |
| T17独立审查/静态 | 初审0Critical/1Important；两轮复审后I1关闭，新增问题0；严格mypy85、Ruff/格式/生成检查通过 | 13源文件、锁与12前端文件及原始证据哈希绑定已核对；后续修复仅校验器和测试，无浏览器/build重复 |
| T15 初始 Runtime/编译器 | Runtime62通过；契约196通过；编译器114通过，类型/静态检查有记录 | 属初始实现的检查，不替代后续修改后的针对性验证 |
| T15 初始广后端 | 290通过/7失败 | 6项缺本地测试清单配置、1项原生并发锁问题；原始命令保留失败，不能改写为整套通过 |
| T15 原失败补验 | 6项真实 Agent/编译通过；导入/发布记录34项通过 | 配置修复与代码修复的定向覆盖，不等于重跑全部297项 |
| T15 修复轮真实组合 | 4通过/239.79秒 | 单 CASE、套件取消/完整矩阵、候选套件、强杀 DOWNLOAD 恢复；真正 Agent 发布、断平台、业务浏览器、设备上传、MySQL 与原始字节校验，线上 Attempt 不变 |
| T15 最终离线修复 | 27通过/68.685秒 | 含两 OS 进程恢复顺序、交接崩溃、旧结果歧义、信任/篡改边界和真实 Worker |
| T15 最终后端修复 | 27通过/83.38秒 | 导入、矩阵、报告/权限/游标等受影响检查 |
| T15 最终契约/静态 | 契约200通过、生成检查通过；Runtime/Web类型通过；显式配置 Ruff/strict mypy80通过 | 首次组合类型命令中 Runtime tuple 失败保留，之后单独纠正并通过；默认配置 mypy 不替代 strict |
| T15 版本差异说明 | 真实4场景组合先于两个小幅客户端/检查点优化 | 后两个修改由最终冻结版本的离线/类型检查覆盖，不声称4场景随后全部重跑 |
| T15 独立审查 | 初次1 Critical/3 Important；修复复审4条全部关闭，零新增 | 初始 `1b6fccb`/组合 `86f1602`；修复 `67968b4`；M1仍明确后续处理 |
| T14 适用检查 | 最终 verifier14、编译器 emission37、契约196、包/guard6及真实 Agent/GUI/本地验签路径有记录 | 还包括1项生成 SDK 消费者；不代表完整 SDK 通过 |
| T13 无模型能力 | Provider禁用/预算耗尽的两个真实 Chromium Run均通过，模型请求0次 | 证明确定性执行独立于模型，不证明真实 Provider 连接/生成通过 |
| T11/T12 既有记录 | 编辑器最终9项浏览器；报告修复/存储/兼容等有单独记录 | 详见开发记录；阶段广套件及诊断失败没有被重写为全绿 |
| 历史材料可用性 | 仓库文档/代码/提交可长期取得；部分早期忽略日志在环境重建后丢失 | T01–T13 的历史数字引用已提交记录；不能伪造原始日志或宣称本次重验。T14/T15 当前本地日志也不是跨机器必有材料 |

## 10. 实际代码与上下文入口

| 区域 | 现有入口 | 接续时必须保留的含义 |
| --- | --- | --- |
| 规范源 | [packages/contracts](../../packages/contracts)、[契约说明](../contracts.md) | 共享 JSON Schema/OpenAPI/类型/兼容样本；不能另造一套 DSL |
| 账户/空间 | [auth](../../apps/srv/src/veriq_server/auth)、[Workspace 服务](../../apps/srv/src/veriq_server/services/workspace.py) | 当前主体+成员+作用域；body role 不是权限证明 |
| 执行入队 | [RunService](../../apps/srv/src/veriq_server/services/runs.py)、[JobService](../../apps/srv/src/veriq_server/services/jobs.py)、[LeaseService](../../apps/srv/src/veriq_server/services/lease.py) | installation锁、不可变矩阵、当前 requester、领取/续租/fencing；T16复用该链路 |
| 自动化身份 | [ServiceAccountService](../../apps/srv/src/veriq_server/services/service_account.py) | 目前支持登记/维护；TEST CI主体未补齐。created_by是归因，不是独立服务身份授权 |
| 编译器/SDK | [compiler](../../packages/compiler)、[runner-sdk](../../packages/runner-sdk) | 编译固定TS、assemble上下文、前置监听、事实与安全重试；控制端无Node |
| 真实 Worker/原生停止 | [execution](../../apps/runtime/src/execution)、[Linux guardian](../../apps/runtime/native/linux-runner.c) | nonce/UID/start ticks/子进程 drain及退出证明；别用纯 browser.close 替代 |
| 签名导出 | [BundleService](../../apps/srv/src/veriq_server/services/bundle.py)、[ADR0016](../decisions/0016-offline-bundle-boundaries.md) | issuer锁→inventory锁→DB；CPU/ZIP/签名在DB事务外；只读包路径不能要求旁边可写 |
| 本地执行/存储 | [offline](../../apps/runtime/src/offline)、[ADR0017](../decisions/0017-offline-execution-import.md) | generation CAS、atomic handoff/artifact checkpoint、被选编译根、SourceHash与文件哈希区分 |
| 导入/存储生命周期 | [ImportService](../../apps/srv/src/veriq_server/services/import_result.py)、[ImportUploadService](../../apps/srv/src/veriq_server/services/import_upload.py)、[publication](../../apps/srv/src/veriq_server/services/publication.py) | 全矩阵、当前权限、immutable allowlist、独立来源、XOR online/offline发布所有权、退役屏障 |
| 真实报告 | [ReportService](../../apps/srv/src/veriq_server/services/report.py)、[ReportAdapter](../../apps/web/src/features/reports/adapters.ts)、[LocalReports](../../apps/runtime/src/offline/reports.ts) | 云/本地共享形状；Node产品模块不能直接引入浏览器API；raw额外授权和hash检查 |
| 资产共享 UI | [resources](../../apps/web/src/features/resources)、[Web 路由](../../apps/web/src/main.tsx) | Cloud/Local适配、表单/JSON、分页选择器、空间切换abort/代际防串数据；桌面复用 |
| AI | [AI 说明](../ai.md)、[ADR0015](../decisions/0015-ai-provider-boundaries.md) | 独立 Provider 密钥/预算，人工审核，不自动发布或把raw Trace发模型 |
| 迁移 | [versions](../../apps/srv/src/veriq_server/migrations/versions) | 当前头0013；新增迁移须同步已知表/head断言，不能破坏离线历史/发布记录 |
| 部署规划 | [规格构建契约](../specs/veriq-1.0.md#18-构建打包和发布的强制契约) | `build.sh`、static/dist、Hatch hook、output、Compose等尚待对应任务，不把规划路径当现成产品 |

## 11. 下一阶段 T18 起点与接续顺序

| 顺序 | 工作 | 依据与验收关注点 |
| --- | --- | --- |
| 1 | 沿当前功能分支接续，先核对提交/状态/本台账 | T16/T17已审查；不在master编码、不重做已完成任务；本地HEAD和远端检查点以Git为准 |
| 2 | 读最新AGENTS、主/桌面规格、T18计划和实际接口 | 实际`make_app`及`handlers/static.py::load_published_site`；迁移0014；新文件/修改不恢复灌水注释 |
| 3 | 有界预研构建图、成熟工具与打包hook | 默认全测；前端check/build→安全stage→Python检查/测试→wheel→干净安装→原子output；紧急skip需reason并标记 |
| 4 | 按ADR0019生成完整静态库存和四字段身份 | `static-manifest.json`与Vite图分离；精确字节hash/无循环、完整worker/font/public、无旧资源/重复wheel条目 |
| 5 | 准备匹配浏览器和正式SDK门禁 | 固定PW1.65/Chromium158，portable覆盖代替写死路径；保留15秒/两worker；若复现旧关闭故障先采因，不提高超时或重复到绿 |
| 6 | 确认测试资源和数据隔离 | DB套件同flock；test-env仅当前工作区私有state；宿主Debian13不是Ubuntu24验收；磁盘有限，不盲下载/清证据/系统prune |
| 7 | 构建真实引擎并协调批准库存晋升 | 不将测试构建器冒充正式批准；不以同版本覆盖不同字节；遵守issuer锁→inventory锁→DB及权威I/O顺序 |
| 8 | 验证editable/wheel/无.git与目标ABI | 开发无dist可装依赖；正式缺dist失败；Schema/迁移/静态全入包；Ubuntu24裸包和固定容器分别实际验证，无Node/Chrome运行 |
| 9 | 保留B04/B05与跨任务验收 | 核心行覆盖75%、有意义注释40%等仍未完成；局部测试/应急包/收集通过不代替正常发行或整体MVP |
| 10 | 完成实现、证据、独立审查与状态文档后推进T19–T23 | 所有功能仍首发，Electron/两OS/运维/真实Provider与整体验收不得删减；必要外部授权在具体可审阅准备完成后核对 |

### 工作方式与证据保存

| 事项 | 要求 |
| --- | --- |
| Agent协作 | 既有要求采用子Agent实现、协调者集成与独立规格/质量复审；同一工作区避免多个产品实现并发写相同状态 |
| 新疑问 | 先查已确认规格和实际代码；真正未决的范围/架构/外部服务问题与用户核对，不重复问已批准事项 |
| 验证 | 观察真正缺失行为的RED，不把cwd/拼写/fixture错当功能RED；保留失败，再做适用检查；不降低断言或预算掩盖失败 |
| 修复 | 逐条记录review意见、修复、覆盖测试和FIX_BASE..HEAD；原复审只看修复/新增破坏，末尾另做整分支审查 |
| 绑定 | 报告精确命令/cwd/退出码、代码/锁/static hash；若测试后改代码，说明差异并补受影响覆盖，不宣称所有结果同一中间版本 |
| 本地工作资料 | 当前可能存在`.superpowers/sdd/veriq-1/`下的progress/current-state/brief/report/evidence；它们被忽略，其他机器/Agent不保证存在 |
| 可移交依据 | 本文、规格、计划、ADR、代码/提交是可取得的依据；若本地日志缺失，据代码补适用验证，不伪造原始结果，不整段重做已完成任务 |
| 密钥和测试环境 | 不将DSN、密码、API key、设备token、本地绝对机器状态写入仓库。真实Provider只用独立持久配置，不放可重置`veriq_test` |
| 现有测试约束 | DB套件（包括启动DB的Web/Agent测试）串行使用约定flock；本地环境重建时重新确认专用库/引擎清单/浏览器，而不是把旧路径当存在 |
| 暂停后恢复 | 用户已明确恢复；旧Agent会话不存在，刷新T16任务基线后分派新实现Agent，不重复已完成任务 |

## 12. 最终交付与状态更新标准

| 交付物 / 门禁 | 当前状态 | 完成时必须保存的说明 |
| --- | --- | --- |
| 全部源代码、锁、迁移、公共契约 | 已有核心；T16–T23待补 | 对应commit、变更范围、兼容性、未完成项 |
| 服务端wheel/wheelhouse/tar/OCI及同源Web | 待交付 | 静态manifest与代码版本、实际干净安装、目标ABI、无Node/Chrome启动 |
| Windows11/Ubuntu24.04桌面与Runtime包 | 待交付 | 对应OS构建/安装/进程名/停止/vault/离网/升级/签名证据 |
| 示例应用/Workspace/测试数据 | 部分已有 | 实际网络可达URL、正常角色与fixture边界、可重现操作，不是假的成功结果 |
| 用户/接入/管理员/运维/故障手册 | 部分已有 | 新环境按文档安装、跑通、诊断、升级、恢复的实际记录 |
| 第三方许可、NOTICE/SBOM/hash/release.json | 锁/声明已有，正式发行物待补 | 直接及传递依赖、实际二进制/ABI、版本/许可、安全核验与产物一致 |
| 全量/覆盖率/业务/故障/并发/权限 | 局部证据已有，整体验收待做 | 同一集成版本完整记录，缺条件/失败明确非通过，B01–B05全部关闭 |
| 实际Provider与正式签名/发布许可 | 待必要授权及配置 | 用户具体许可、独立安全配置、真实调用/成本或正式签名记录；代码合并不等于发布授权 |
| 整分支审查与发布结论 | 待执行 | 所有需求映射、阻塞关闭、遗留逐项处置、两平台与发行物齐全，之后才标记1.0可交付 |

每个后续任务合并后，更新本文件的基线、任务/功能/遗留状态与证据绑定，同时更新[实施计划](veriq-1.0.md)和[开发记录](../development.md)。新增范围先取得确认；完成说明写最终行为、实际验证和剩余约束，不只写“已完成”。
