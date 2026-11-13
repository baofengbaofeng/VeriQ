# VeriQ 1.0 交付里程碑与 Agent 接续状态

> 状态快照：2026-11-13（UTC）。恢复基线：`master` 提交 `e5d5a6bb93cc5cf7b9496defc3f0995ab47c8384`；本轮已审查功能分支代码 `eb2dc4e`（T19模块及修复复审；正式发行待验收）。本文汇总已确认范围、已落地代码、验收缺口和接续上下文；不新增功能范围，也不替代需求规格。
>
> **用户已明确恢复开发，目标为完整 MVP 交付。** 从最新 master 建立隔离功能工作区，按 T16–T23 继续子 Agent 开发及独立审查。恢复开发不等于批准实际付费 Provider 调用、正式发布或外部部署；相关验收仍需具体配置和授权。

## 1. 当前交付结论

| 项目 | 当前结论 | 接续时的含义 |
| --- | --- | --- |
| 产品目标 | 企业 PC Web 自动化冒烟/回归平台；20 人以内、同时提交约 10 个 Run | 常规运行必须直接执行固定版本 TypeScript/Playwright，不依赖模型 |
| 首发范围 | F01–F14 全部模块，包括 Electron 桌面 GUI、两平台 Runtime、安装与运维 | 阶段性实现不能被改称完整 MVP；尚未达到开箱即用标准 |
| 实施任务 | T01–T12、T14–T17、T19 共17项模块已审查；T18代码及重要修复已审查，正式发行待验收 | 不重做已完成实现；T18仍需T22/T23关闭正常发行和目标环境验收 |
| AI 模块 | T13 代码与修复复审已完成，实际外部 Provider 验收未完成 | 不能把协议模拟、无模型运行成功当成实际 Provider 通过 |
| 后续工作 | T20–T23 共4项实现/整体验收继续；T13/T18保留指定实际验收 | T19 `bac5162`→`eb2dc4e`六项Important复审全部关闭、新增0；实际六GUI一次通过，现推进T20原生所有权/IPC切片；发行身份切片已实现 |
| 已合并内容 | PR #10/#11已合并至恢复基线，覆盖至T15；T16–T19代码在功能分支已审查，T18正式发行待验收 | 当前分支`codex/veriq-mvp-completion`；远端状态以实际Git HEAD为准，尚未合并本轮代码至master |
| 主要发布阻塞 | 默认构建实际失败于Web lint；历史格式/类型与B05未达标，目标OS/OCI、Electron、真实Provider和完整验收未完成 | 固定SDK门禁/当前wheel组件验证通过不等于完整正常发行 |
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
| M02 测试资产与执行语义 | T04–T07 | 不可变资源、编译器、操作断言 SDK、fixture/业务身份 | 已完成·模块；最终源码门禁待验收 | T18匹配浏览器下SDK136项/91.46%通过；历史超时根因仍未知，不能据此重派旧诊断；T23验证最终源码 |
| M03 在线执行与编辑报告 | T08–T12 | 设备、统一队列、Linux Agent、资产 UI、实时报告/证据 | 已完成·模块 | Windows、安装包和桌面不包含在这次模块完成声明中 |
| M04 AI 辅助 | T13 | 配置、预算、结构化生成、审核、失败分析、无模型执行 | 代码完成·待验收 | 需要经授权实际 Provider 验收和独立持久配置 |
| M05 签名包与离线链路 | T14–T15 | 签名/验证、凭证引用、本地执行/恢复/报告/回传 | 已完成·模块 | 单 CASE、套件矩阵、草稿套件、崩溃证据链均有真实组合验证；GUI/安装待后续 |
| M06 外部自动化与服务器产品化 | T16–T18 | HTTP/CI、生产同源、前端入wheel、构建/引擎工具 | 代码完成·发行待验收 | T18重要问题复审关闭；默认正常门禁失败，Ubuntu/OCI及最终正常包由T22/T23闭合 |
| M07 桌面与跨平台 Runtime | T19–T20 | Electron 全 GUI、Windows/Linux 安装与原生能力 | 进行中·T19模块完成，T20分步实现 | T19重要问题复审已关闭；六GUI/34unit/2display通过；两平台安装、vault、签名、离网及安全默认值由T20继续 |
| M08 运维与完整用户体验 | T21–T22 | 安装升级、备份恢复、观测、生命周期、示例/手册/接入 | 待开工 | 新环境按文档操作成功；全模块真实交互和中英文/键盘覆盖 |
| M09 1.0 产品验收 | T23 | 全范围、并发、故障、业务多轮、发行物与整分支审查 | 待开工 | 全部阻塞、授权和平台验收关闭后才可以标记 1.0 完成 |

## 4. 产品功能交付矩阵：F01–F14

| 编号 | 必须交付的全部功能要点 | 当前状态 | 已完成说明与上下文摘要 | 仍需交付 / 验收归属 |
| --- | --- | --- | --- | --- |
| F01 安装初始化 | 部署、迁移、管理员创建、配置预检、健康检查、示例初始化 | 部分完成 | 初始化和同源已有，T18交付构建/wheel/离线依赖/部署工具及组件安装证明 | Ubuntu/OCI正常发行、完整迁移/升级恢复、示例向导由T21–T23完成 |
| F02 自有用户 | 登录/退出、邀请/创建、单次重置、禁用、会话撤销 | 已完成·模块 | T02 真实账户 API/UI，opaque session、密码哈希、Cookie/CSRF、管理员操作 | 全产品安装与用户路径、可用 SMTP 部署引导、最终安全回归；T21–T23 |
| F03 Workspace | 一项目一空间、多成员、固定角色、切换、隔离、审计 | 已完成·模块 | T03 授权仓库和后续嵌套资源/证据/导出导入均已接入；系统管理员不隐式跨空间 | CI独立服务主体已由T16交付；桌面切换/缓存隔离与全模块撤权回归由T19/T23完成 |
| F04 页面元素 | testId/role、recordKey、作用域、目录版本/引用影响 | 已完成·模块 | ELEMENT_CATALOG、严格唯一定位、版本与编辑器已有 | 完整前端 testId 接入规范、示例与组合控件/键盘/Portal 验收；T22 |
| F05 用例资产 | 表单/JSON 双向、步骤、数据、变量、流程、草稿修订、校验发布、差异归档 | 已完成·模块 | 八类资源、CAS 修订、不可变发布、真实 Agent 编译回执、源码浏览；不是服务端直接编译 | 桌面适配、示例、全部交互与冲突恢复验收；T19/T22/T23 |
| F06 操作断言 | UI/URL/请求/响应/业务码、JSON Pointer/Schema、持久化、最终一致、模板与预期来源 | 已完成·模块；最终集成待验收 | 前置/后置断言、动作前监听/关联、dispose、类型和重试；T18固定浏览器SDK136项通过、行覆盖91.46% | 历史browser.close根因仍未知；T23按最终源码门禁及全业务故障验收，不重跑旧诊断 |
| F07 环境身份 | 地址/域名约束、语言时区、角色、凭证版本、构建身份 | 已完成·模块 | 独立认证注册、AES-GCM 版本凭证、按 Attempt 授权、明确下发同意、精确本地映射 | OS vault、代理/证书/桌面设置、实际部署手册；T19–T22 |
| F08 测试数据 | fixture 准备/查询、namespace、幂等 cleanup、部分失败/崩溃补偿 | 已完成·模块 | T07 真实 HTTP 示例与 SDK；统一 CLEANUP Job、独立 fixture 身份、TTL 契约与安全重试 | 实际企业业务接入、升级/失联补偿运维、跨 OS 故障验收；T21–T23 |
| F09 Runtime | 云端/本地、注册、自检、私人/共享、撤销、实际进程名 | 部分完成 | 设备授权、Linux guardian、在线Agent/离线执行/doctor、Electron完整GUI及后台独立生命周期已审查 | 独立Node/浏览器分发、Windows原生进程树、OS vault、安装/自启动及目标系统进程名；T20/T21/T23 |
| F10 执行调度 | 手动、HTTP 触发、队列、容量、租约、取消、重跑与整用例重试 | 部分完成 | 手动入队、TEST/VALIDATE/CLEANUP、fencing、真实消费者/恢复/重试及T16计划/HTTP/服务身份/CI已验证 | 计划/HTTP/QUEUE/SKIP/REJECT/安全JUnit已交付；重跑及遗留API由T22补齐，实际10 Run压测由T23完成 |
| F11 报告 | 实时进度、差异、请求关联、所有Attempt、环境/清理、证据、可信门禁、JUnit | 部分完成 | Web/SSE、受限原始证据、File/S3、安全CI/JUnit、桌面报告及原生Trace/图片、离线回传已交付 | 指标/完整生命周期、最终统计与整体验收仍由T21/T23完成 |
| F12 本地离线 | 依赖闭包、签名/安全安装、凭证、独立执行、报告、恢复/回传/来源 | 核心与GUI已审查；发行待验收 | T14/T15真实断平台运行/回传及代际/完整性修复；T19无终端GUI、可见158执行/同Attempt停止、同Agent/Run恢复已验证 | OS vault、全离网安装和Windows11/Ubuntu24.04完整产品体验；T20/T23 |
| F13 AI 辅助 | Provider 配置/连接、需求/OpenAPI/元素上下文、结构化草稿、审核、边界建议、失败分析、历史/费用预算 | 代码完成·待验收 | T13 已代码复审；官方 SDK、独立密钥、并发预算预留、取消/未知费用、人工审核；禁用/耗尽模型时真实 Run 仍成功且模型请求为 0 | 实际 Provider 授权与持久验收；契约/选择器遗留、最终 UX；T13/T16/T22/T23 |
| F14 产品运维 | 同源发布、安装升级、备份恢复、保留期、日志指标、许可、手册/验收报告 | 部分完成 | 同源与T18构建/引擎/晋升、wheelhouse/SBOM/NOTICE及部署代码已有，当前wheel组件安装验证通过 | 正常发行、两平台包、完整生命周期、轮换恢复/指标和手册/最终验收仍由T20–T23完成 |

## 5. 实施任务台账：T01–T23

下表的“完成”指模块实现，不覆盖第 8 节的发布阻塞。短提交用于定位历史实现；合并方式可能导致主分支上另有合并提交。

| 任务 | 依赖 | 状态 | 完成说明与接续摘要 | 定位 / 后续动作 |
| --- | --- | --- | --- | --- |
| T01 工程与契约 | 无 | 已完成·模块 | 冻结基线、ADR、Schema/OpenAPI、Python/TS 共用兼容样本、生成一致性 | `23b5282`、`188c856`；[契约](../contracts.md) |
| T02 账户初始化与会话 | T01 | 已完成·模块 | 自有账户、安装引导、重置邀请、密码哈希、CSRF、禁用/撤销和管理 UI | `678587d`、`32e625e`；完整覆盖率与正常发行仍待T22/T23 |
| T03 Workspace 授权 | T02 | 已完成·模块 | 显式 WorkspaceScope、角色矩阵、最后 OWNER 保护、跨空间及 UI 切换 | `ef0fb6d`、`39672c4`、`eb75c4b`；后续主体和资源继续复用 |
| T04 资产版本与发布 | T01/T03 | 已完成·模块 | 八类统一资源、revision、依赖/影响、不可变版本/回执；真实写入由 T09/T10 补齐 | `2a2dd25`；不能伪造回执绕过发布 |
| T05 确定性编译 | T01/T04 | 已完成·模块 | compileAssets/assembleExecution、变量依赖、流程限制、实际 TS/manifest/依赖、源码哈希 | `dcb05c0`、`3588164`；[ADR0006](../decisions/0006-deterministic-compiler-artifacts.md) |
| T06 操作监听与断言 | T05 | 已完成·模块；最终集成待验收 | 真实SDK、响应关联、严格JSON/Pointer、持久化/最终一致、监听回收 | `2482be9`/`68c99fd`；T18固定浏览器136项/91.46%通过，旧故障原因未知，T23最终复核 |
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
| T17 生产同源服务 | T02/T11 | 已完成·模块 | 唯一工厂、包内完整文件库存、已登记SPA GET/HEAD、API/静态404、缓存/范围/条件响应、build-info和健康兼容；HTML策略两轮修复复审关闭 | `4b58a4c`、`0f48d6e`、`67779ed`；[ADR0019](../decisions/0019-production-static-inventory.md)；stage/wheel已由T18交付，正式目标发行待验收 |
| T18 构建与服务端发行 | T17 | 代码完成·待验收 | 默认完整门禁、Hatch/stage/wheel/离线安装、SBOM/引擎及独立晋升；两项Important修复复审通过 | `3995648`/`dc95f26`；27项fix回归、当前UNVERIFIED wheel安装通过；正常发行/Ubuntu/OCI及M1/M2仍开放 |
| T19 Electron 全 GUI | T10/T11/T12/T14/T15 | 已完成·模块及Fix1复审 | `bac5162`→`eb2dc4e`：完整本地界面、有限IPC、独立Node24、云端编辑/编译发布、签名下载、断网执行、报告/Trace/幂等回传与故障恢复；实际6GUI/34unit/2display通过 | I1–I6全部关闭，新增C/I/M均0；Windows/POSIX路径单测不等于安装验收，目标OS/vault/发行、Provider和全仓质量仍待T20–T23 |
| T20 两平台 Runtime 发行 | T19 | 进行中·原生切片 | [ADR0021](../decisions/0021-runtime-distribution.md)及`18792c0`发行身份/角色路径/npm JS/tar已有实现；Windows初始13项实际原生/帧测试通过；新增所有权及管道关闭两项回归均完成真实RED→GREEN，当前15项全部通过 | 原生异常生命周期/完整IPC及Worker/CLI集成、OS vault、两OS独立构建及安装/离网/真实进程名仍须交付；整任务未复审 |
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
| R18-01 / T18 | `build.sh` 与顺序构建 | 代码已审查，正常全链未通过 | 冻结安装→Web check/build→安全stage→后端静态/测试→wheel→安装→原子output；实际停于Web145 lint errors，输出未创建 |
| R18-02 / T18 | Hatch/安装包完整性 | 组件证明通过；最终源发行待验收 | editable无dist可用、正式缺资源失败、完整资源/RECORD校验；Fix1当前wheel离线/只读/仓库外无Node启动通过；无.git重建仅绑定早期399候选 |
| R18-03 / T18 | 正常/紧急门禁 | 行为已实现，未产正常成功包 | default/with-tests完整；skip需reason且不跳静态/完整性；TERM/INT及detached子树、锁继承和未知证明隔离已实测，原子输出保护通过 |
| R18-04 / T18 | 服务器发行物 | UNVERIFIED候选可审阅，正式目标验收未过 | 当前Fix1 wheel，55个锁定依赖wheel、SBOM/NOTICE/hash/部署代码；早期399 tar保留为历史候选；Ubuntu裸包/独立OCI/最终正常tar待T22/T23 |
| R18-05 / T18 | 引擎批准/版本和质量 | 生产器与晋升代码已审查；最终发行待验收 | 原1.0.0身份不变；T19另用未批准1.0.2-t19-fix1实际生产并消费，六GUI通过；最终源码核心75%与正式候选仍待T23 |
| R19-01 / T19 | 桌面窗口与本地入口 | 已完成·GUI模块；安装入口/原生托盘待T20 | 实际本地renderer、单实例、第二实例唤起、关闭保留后台及离线资产通过；不只载入远端网址，未将无D-Bus回退当目标托盘证明 |
| R19-02 / T19 | 登录/空间/设备/资源 | 已完成·模块及复审 | 真实账号/Workspace/绑定共享、云端编辑编译发布、签名下载和凭证映射；GUI退出后复制旧Cookie401，设备绑定保留 |
| R19-03 / T19 | 本地执行全GUI | 已完成·模块及复审 | 断平台真实PASSED、历史/Trace、PENDING→COMPLETE与幂等回传、取消；实际可见Chrome158及同Attempt正停止证明 |
| R19-04 / T19 | IPC与host会话 | 已完成·模块及复审 | sandbox/contextIsolation、有限桥接、私有host Cookie、字节有界UTF-8、实时新增Attempt原生证据归属；renderer无通用fs/spawn/token能力 |
| R19-05 / T19 | 生命周期与设置 | 已完成·模块及复审 | 真实UI renderer异常退出→新PID恢复，同Agent/Run继续；确认退出UI、重开、取消Run及停止Agent独立，自检/缓存/代理等有限设置可操作 |
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

### T19 当前验证上下文（`eb2dc4e`模块与Fix1复审通过）

| 验证事项 | 实际结果 | 接续约束 |
| --- | --- | --- |
| 独立审查 | 初审6 Important；Fix1 I1–I6全部ADDRESSED，新增C/I/M为0/0/0 | 仅模块与修复范围批准，不表示安装发行或完整MVP通过 |
| 同源GUI与执行版本 | Electron45.3.1/UI Node24.22.2/Chromium156，独立Node24.22.1，Playwright1.65/full Chrome158.0.8127.18 | UI引擎、Node执行器、业务浏览器必须区分；业务浏览器旧`--no-sandbox`参数两次仍是T20安全默认值待办 |
| 真实当前组合 | [GitHub run43485459939](https://github.com/baofengbaofeng/VeriQ/actions/runs/43485459939)，job132092596576；6GUI全部单次PASS、retry0/skip0/flaky0，125.020秒；34unit/2display通过 | 6例含明确component-only启动投影，不把它当真实后台；不将早期201contracts称该job重跑 |
| 签名包与引擎 | 真实producer创建独立未批准测试候选1.0.2-t19-fix1，canonical `1c64aff0…`；实际编译发布、签名下载及脱平台执行 | 原1.0.0 canonical `4ac70538…`/raw `75fc7c83…`和1.0.1-t19探针保持原身份，不覆盖或自动晋升 |
| 可见执行与停止 | 实际full158 IsViewable/无headless，browser→worker→guardian→Agent；同Attempt `52ba5b84-504a-487e-b74e-294e9ecc7a41` processStopped、STOPPED、windowGone、ownedPidsExited均true | 不是另起示例浏览器；X11/XWayland通过，不冒充纯Wayland或Windows安装验证 |
| UI故障与后台连续性 | pidfd向唯一自有UI renderer注入异常终止，真实gone killed/exit9，旧6262→新6583、同main6209/窗口/content恢复，同AgentPID/Run继续；退出UI重开后仍完成 | Python3.12仅QA helper，产品不引入Python；官方Browser/Tab角色、UID/start/exe/祖先/pidfd均核验，不是失败后的业务清理kill-to-green |
| 报告与会话 | 真实原生Trace内容/关闭清理、图片、离线源码/worker、PENDING恢复COMPLETE与重复同回执通过；GUI登出后旧Cookie401且设备不解绑 | 原始证据仍按当前权限授权；不将OFFLINE_IMPORT变成可信正式门禁通过 |
| 当前源码与证据身份 | 501源码SHA与`eb2dc4e` Git blobs匹配；原始inventory字节与canonical一致；CI有65 compiled hash记录 | compiled字节未下载独立重hash，不称本地重建或可发布包；38修复源文件与616 raw绑定另存私有资料，其他机器不保证有 |
| 宿主QA准备 | 三个精确测试二进制AppArmor临时profile加载后全部移除，全局限制及其他profile不变 | 是限定QA宿主配置，不是产品安装策略，控制服务生产仍无Node/Chrome |

#### T19 六项问题完成说明

| ID | 原问题与上下文摘要 | 修复及验证结果 |
| --- | --- | --- |
| I1 | logout空对象被生成的无body策略提前拒绝，只清本地Cookie | 规范Empty及生成策略对齐；真实POST、无条件本地清理、复制旧Cookie服务端401/设备保留，复审关闭 |
| I2 | 任意socket分片逐块转UTF-8污染中文/non-BMP | 客户端与broker按原字节限额组帧、严格解码；真实分片输入/输出及上限回归，复审关闭 |
| I3 | `assets + "/"`无法接受Windows反斜杠路径 | 原生relative/sep/absolute包含判断，保留链接/普通文件约束；Windows/POSIX正反例，复审关闭 |
| I4 | 监督器过滤掉可见模式的可信DISPLAY/XAUTHORITY | 仅headed传本机可信显示白名单；真实full158窗口及同Attempt物理停止，复审关闭 |
| I5 | 仅初始报告记录Attempt，SSE新增后原生证据失去Run归属 | 每次初始/流更新先验证并记录；实际SSE parser空报告→新增Attempt→原生动作及跨空间拒绝，复审关闭 |
| I6 | finally只发SIGTERM，下一fixture可能抢旧DB锁 | 等实际exit+stdio close；认证停止自有Agent并核实退出；真实flock排空回归及完整六例串行，复审关闭 |

历史失败仍保留：一次导出5秒断言失败的精确原因UNKNOWN，后来的POST201不能倒推已修复；旧core-producing注入只证明第10秒renderer CoreDumping=1/宿主systemd-coredump，不证明整个180秒状态。改用句柄绑定的真实renderer异常终止完成恢复验收，未修改产品恢复器或系统core策略。旧proc独立NUL参数假设与真实进程标题不符，已由可信Electron官方角色指标替代。

全仓质量仍未达标：`bac5162`阶段固定方法统计4.8747684%、279项首行违规；43个新增非生成文件的9.0250433%也是该历史局部测量。它们不是当前完整全仓PASS，也不是每任务独立门槛。AGENTS要求最终全仓有效注释>40%，T22整改、T23复核；不得扩大生成物排除或填充注释。正常服务器发行、Provider和目标系统验收仍保留。

### T20 当前实现与实际 CI 上下文（未完成整任务）

| 项目 | 当前事实 | 剩余事项与接续约束 |
| --- | --- | --- |
| 发行身份/路径切片 | `18792c0`已实现真实发行库存、角色执行器、npm JS、tar及路径适配；23Runtime、7最终受影响桌面测试、CLI与严格检查通过 | 合成库存单测不代表真实安装包；完整分发器、原生能力、vault和安装仍待交付 |
| Windows实际行为基线 | `09e8586`，[run43498685838](https://github.com/baofengbaofeng/VeriQ/actions/runs/43498685838)，Windows Server2025/Node24.22.1；冻结安装成功，2项测试失败、0跳过：不支持Windows进程监督及Unix路径监听EACCES | 已据此开始Win32 Job/私有管道/ACL实现；该Server基线不能替代Windows11安装或GUI验收 |
| 初始原生/帧验证 | `0b915e2`，[run43507693240](https://github.com/baofengbaofeng/VeriQ/actions/runs/43507693240)：原生编译及13项测试通过、0跳过，1.651秒；实际Job排空/改名Agent扩展/私有管道及帧正反例 | 旧EOF等待假设已按完整UTF8/JSON帧修正，提前EPIPE仍拒绝；CLI/Worker/私有存储/异常场景及Windows11安装仍未交付 |
| Windows源码绑定 | `0b915e2`及新增负例`1aa9ae4`各158个实际源码文件hash与Git字节的精确LF→CRLF变换匹配，0个原始字节相同 | 2871条原生输入hash为CI元数据记录，未下载二进制独立重hash；保留实际测试字节关系，跨OS引擎维护唯一身份 |
| 所有权/关闭实际负例 | `1aa9ae4`，[run43512448515](https://github.com/baofengbaofeng/VeriQ/actions/runs/43512448515)：安装和编译通过，15项中13通过/2失败/0跳过；拒绝停止后Worker不再处理新挑战；关闭后保留旧回调导致同名端点无法重新绑定 | 属于真实行为失败；最小两文件修复`fbf93e3`已由同一15项测试全部验证通过；其余release分支、取消时序和部分构造失败仍须独立覆盖 |
| 两项修复实际验证 | `fbf93e3`，[run43513680640](https://github.com/baofengbaofeng/VeriQ/actions/runs/43513680640)：安装/原生编译及同一15项测试全部通过、0跳过，2.838秒；拒绝停止后真实新挑战进度1→26，旧回调仍可达时同名端点重绑成功 | 仅关闭已复现的两点；其余身份/跨Attempt/取消时序、部分构造失败及完整Windows集成继续，不代表整T20或Windows11通过 |
| 当前Ubuntu源码GUI | `37f4701`，[run43502801828](https://github.com/baofengbaofeng/VeriQ/actions/runs/43502801828)：新引擎/build/全包类型/34unit/2display及6项GUI全部通过、0重试/跳过/不稳定，125.852秒 | 同Attempt可见158及真实停止通过，三份临时策略清理成功；旧`09e8586`证据路径迁移失败已修正；不是安装或Windows验收 |
| 引擎与构建证据 | Ubuntu GUI使用独立未批准`1.0.3-t20-37f4701afece8053c38eb3c5fa208cdd1912e564`，canonical`9cb02519…`、raw`dbd803f4…`；518源码与Git blob一致 | 70条compiled hash为CI记录，compiled字节未下载独立重hash；未晋升、不覆盖T19候选；旧09候选保留为历史 |
| 正常服务器发行 | [run43498685897](https://github.com/baofengbaofeng/VeriQ/actions/runs/43498685897)仍在Web检查失败：Biome145errors/38warnings/132infos，检查53文件 | 132infos不是132个格式失败文件；T22整改、T23同一最终源码重新执行正常完整门禁，不使用跳过测试代替 |
| 接续顺序 | 继续原生所有权/取消/IPC和完整Worker/CLI集成；不要重复已完成预研或初始13项诊断 | 再做系统凭据/迁移、真实依赖闭包/安装升级、目标OS验收和整T20独立复审；之后继续T21–T23 |

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
| B01 完整 SDK | T18模块门禁通过；T23最终源码复核 | 固定Chromium158/revision1254下136项/15文件通过33.38秒，V8行91.46%（911/996），保留15秒/两worker；83输入当时冻结，后仅根开发元数据/测试守卫有差异，SDK产品src未改 | T18选择改动已审查，守卫另1项通过；历史134/1关闭超时根因未知。最终发行绑定最终输入，不以旧阶段代替最终全量或重复到绿 |
| B01a 浏览器差异 | 可移植选择已审查；历史因果未证实 | SDK测试使用显式`VERIQ_TEST_CHROMIUM`或官方固定浏览器，生成子进程一致；正式阶段使用158/revision1254 | 保留固定版本、原时限/worker与业务断言；本次通过不证明旧156是故障原因 |
| B01b 诊断隔离 | 必须保留的教训 | 历史一次 DEBUG 传到生成测试子进程，触发合成保护值泄漏断言；正常 Runtime 的显式子环境与该诊断不同 | 新观测不污染生成子进程；不能把受污染诊断命令当全绿或据此推断正常运行泄漏 |
| B02 实际 Provider | 待授权/配置；T13/T23 | 尚未确认实际 endpoint/model/预算并安全配置真实 key；没有进行实际外部调用 | 先明确服务/模型/预算与调用许可，在独立持久配置安全填 key；记录合成输入、实际 usage/cost/结果。此前建议不是授权，“继续”不是付费调用许可 |
| B03 目标 OS/发行 | 发布阻塞；T18/T20/T23 | 开发 Linux 原生执行、内置 SQLite、源码构建不是 Windows11/Ubuntu24.04 安装验收 | 对应 OS 真实构建安装、生命周期/vault/离网/升级/签名与报告；正式签名凭证不足时只标开发包并待确认 |
| B04 全量/覆盖率 | 发布阻塞；T22整改/T23最终验证 | 当前默认构建冻结安装通过后Web lint145 errors失败，后续未到达；单独格式132文件失败、四处旧CI mypy错误，完整Python/TS覆盖未验收 | 最终同一源码/锁/static的正常完整门禁及testsSkipped=false产物；当前SDK91.46%和组件安装不替代全链 |
| B05 编码规范 | 发布阻塞；T18工具已交付/T22整改/T23复核 | T18初始399固定syntax-comments-v1计328源码（含测试/legacy、仅排除两生成合同）2914注释/62494代码=4.4551%，280首行违规；Fix1未宣称消除该差距；早期5.70%为不同方法/范围 | 先修D14偏移；固定范围和>40%门槛，按职责/不变量/行为补充有效中文说明、首行≥60/公开API/英文日志及格式类型，人工审查无灌水 |
| D01 history/audit after | 已关闭·T16 | 原缺少的after分页查询已同步规范/生成类型及适用检查 | 后续接口修改保持真实游标和契约一致，不再作为未开工事项 |
| D02 维护四操作 | 已关闭·T16 | 四个合法维护操作的数量/唯一约束已纠正，未知操作仍拒绝 | 保持受限token权限与完整四项列表，不回退旧maxItems=3 |
| D03 AI auth 文档 | 已关闭·T16 | AI常规Cookie/CSRF入口与规范已对齐，未增加未经实现的ServiceToken权限 | 后续transport适配保留真实认证边界 |
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
| D14 T18-M1 注释坐标 | 非阻塞遗留；T22/最终复审 | TypeScript UTF-16偏移直接用于Python码点数组，合法emoji尾注释可IndexError或误计 | 统一坐标/Node侧残余计数，验证BMP/nonBMP/无尾换行/多行，保留原计数范围和门槛 |
| D15 T18-M2 版本资料 | 非阻塞遗留；T22/最终复审 | `--engine-version`可选，而wheel内release/version.json固定candidate1.0.0 | 从实际候选生成/核对包内外product/compiler/SDK/engine版本，不能交付互相矛盾资料或改写旧身份 |

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
| T18 SDK/生产器 | 固定浏览器136通过/33.38秒、SDK行91.46%；真实引擎17文件load/初始候选offline npm13包与29exports/最终compile21文件 | SDK冻结与最终root元数据/测试守卫变化分别披露；引擎加载/编译不冒充真实浏览器消费，归T19/T23 |
| T18包/受影响检查 | 初始验收13通过；后端140通过/1旧测试控制失败，第二真实配置应用修正后定向2通过；mypy98通过 | 首wheel缺`__main__`失败保留；399无.git/sdist重建绑定旧候选，不代表Fix1 |
| T18修复复审 | I1取消/锁/子树与I2等待锁后freshness；最终27通过/30.37秒，7模块mypy与Ruff/格式通过；复审新增0 | `3995648`→`dc95f26`；真实TERM/INT/setsid/十秒升级/未知证明隔离/同步尾段；原M1/M2明确T22 |
| T18当前wheel/默认入口 | Fix1 wheel `15bc3473…`实际离线、只读、仓库外、无Node/Chrome启动通过；真实默认入口8阶段均回收，Web145 errors停止，output前后均absent | Debian13/Python3.12.14，不是Ubuntu/OCI通过；候选UNVERIFIED，未发布；425源码/146修复证据及旧122/10产物绑定核对 |
| T19最终GUI/复审 | `eb2dc4e`六GUI单次通过/125.020秒、34unit/2display；I1–I6全部关闭、新增C/I/M均0 | run43485459939；501源身份、同Attempt可视停止、同Agent/Run恢复、旧Cookie401与QA策略清理；未替代安装/Provider/全仓发行门禁 |
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
| 自动化身份 | [ServiceAccountService](../../apps/srv/src/veriq_server/services/service_account.py) | T16已支持独立登记/维护/计划EXECUTION主体；created_by仅归因，当前令牌/成员/计划与设备权限仍逐次检查 |
| 编译器/SDK | [compiler](../../packages/compiler)、[runner-sdk](../../packages/runner-sdk) | 编译固定TS、assemble上下文、前置监听、事实与安全重试；控制端无Node |
| 真实 Worker/原生停止 | [execution](../../apps/runtime/src/execution)、[Linux guardian](../../apps/runtime/native/linux-runner.c) | nonce/UID/start ticks/子进程 drain及退出证明；别用纯 browser.close 替代 |
| 签名导出 | [BundleService](../../apps/srv/src/veriq_server/services/bundle.py)、[ADR0016](../decisions/0016-offline-bundle-boundaries.md) | issuer锁→inventory锁→DB；CPU/ZIP/签名在DB事务外；只读包路径不能要求旁边可写 |
| 本地执行/存储 | [offline](../../apps/runtime/src/offline)、[ADR0017](../decisions/0017-offline-execution-import.md) | generation CAS、atomic handoff/artifact checkpoint、被选编译根、SourceHash与文件哈希区分 |
| 导入/存储生命周期 | [ImportService](../../apps/srv/src/veriq_server/services/import_result.py)、[ImportUploadService](../../apps/srv/src/veriq_server/services/import_upload.py)、[publication](../../apps/srv/src/veriq_server/services/publication.py) | 全矩阵、当前权限、immutable allowlist、独立来源、XOR online/offline发布所有权、退役屏障 |
| 真实报告 | [ReportService](../../apps/srv/src/veriq_server/services/report.py)、[ReportAdapter](../../apps/web/src/features/reports/adapters.ts)、[LocalReports](../../apps/runtime/src/offline/reports.ts) | 云/本地共享形状；Node产品模块不能直接引入浏览器API；raw额外授权和hash检查 |
| 资产共享 UI | [resources](../../apps/web/src/features/resources)、[Web 路由](../../apps/web/src/main.tsx) | Cloud/Local适配、表单/JSON、分页选择器、空间切换abort/代际防串数据；桌面复用 |
| AI | [AI 说明](../ai.md)、[ADR0015](../decisions/0015-ai-provider-boundaries.md) | 独立 Provider 密钥/预算，人工审核，不自动发布或把raw Trace发模型 |
| 迁移 | [versions](../../apps/srv/src/veriq_server/migrations/versions) | 当前头0014；新增迁移同步已知表/head断言，保护旧离线历史/发布/计划与独立主体 |
| 构建/部署 | [发行指南](../release.md)、[ADR0020](../decisions/0020-server-release-pipeline.md)、[build.sh](../../build.sh) | T18已交付真实生产器/校验/部署代码和组件证明；默认正常门禁及Ubuntu/OCI仍未过，不将UNVERIFIED标为正式发行 |

## 11. 当前 T20 发行与后续接续顺序

| 顺序 | 工作 | 依据与验收关注点 |
| --- | --- | --- |
| 1 | 沿功能分支核对本台账与Git状态 | T19模块/六项复审已过；T13真实Provider、T18正常发行仍待验收，不重做已通过模块 |
| 2 | 复用已完成T20预研与发行身份切片 | 读取AGENTS、规格、ADR0021及当前实际导出；继续原生生命周期和集成，新依赖仍逐项核验许可/版本/安全与空间预算，不重复整轮预研 |
| 3 | 正式分发独立Node/引擎/浏览器 | Node24.22.1与Electron内嵌Node分开；ASAR外实际Agent/helper/native依赖闭包；CLI/cloud/doctor用同一真实验证过的distribution身份 |
| 4 | 完成两OS原生所有权与凭据 | 实际veriq/veriq_agent/veriq_runner、Windows Job/私有IPC ACL、Linux guardian、OS vault；处理preparing startupId和activeRun，未知停止仍隔离 |
| 5 | 安装、离网、托盘、自启动与升级回滚 | 执行中不强更，真实关闭/退出/取消/停止语义不回退；安装签名根与企业测试包issuer根区分 |
| 6 | 在精确目标验证 | Windows11不以Windows Server冒充；Ubuntu24.04 QA源码GUI不等于已安装包；独立构建/安装/vault/进程/停止证据绑定实际OS和版本 |
| 7 | 继续T21–T23 | 运维/恢复/生命周期、全UX/i18n/示例/接入规范、全部已登记Minor/D11重跑与全仓质量，最后同一源码正常全门禁/完整产品验收 |
| 8 | 保持资源与权限边界 | DB/Web/Agent同flock；私有DSN/key不入库；大包优先目标CI，保留旧引擎身份/原始证据；无内部业务Cron |
| 9 | 对具体外部输入/动作核对授权 | 可审阅候选完成后核对实际Provider端点/模型/预算及安全key配置、必要Windows11环境、正式签名/发布授权；独立可做的工作持续推进 |

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
| 暂停后恢复 | 用户已明确恢复；从实际Git和本台账定位当前任务，T16–T18代码已审查，不因旧暂停或SDK失败记录重做已完成实现 |

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
