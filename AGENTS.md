# VeriQ 贡献者与编码代理指令

本文件是人类贡献者与编码代理的长期契约，只定义约束、标准、锁定基线与协作规则。产品行为细节见规格文档；精确依赖版本以锁文件与 ADR 为准。工程细则见「规范与规则文档」。

文档冲突时：该主题已批准的专项规格或 ADR 优先，其次以本文件中的流程与不可协商基线为准，再次以 `.agents/rules/` 的专项规则为准。编码数字与已点名工具（注释块首行、行宽、Python 3.12、pylint / Black / Pyink、Prettier）以 `.agents/rules/` 已写明的条文为准；本文件只作与之相同的摘要，不得用更旧的数字覆盖它们。

## 权威与协作

- 编码前须阅读本文件、仓库根 `README.md`、当前任务简报，以及下方与任务相关的规格和专项规范。
- 涉及契约或工程基线变更时，阅读 `docs/contracts.md`、`packages/contracts` 以及 `docs/decisions/` 下相关 ADR。
- 必须由子代理实现。遇到真正未决问题——尤其是范围、架构、许可证、平台保证或外部服务变更——须暂停并询问协调者；由协调者再询问用户。禁止静默擅自决定。
- 实现者不得再派生子代理，也不得 push。协调者负责任务评审与集成。
- 只 stage 当前任务归属的文件。共享工作区可能包含其他任务与文档。
- 影响公共契约、工程基线或平台停止/安全保证的变更，必须先更新（或与实现同步更新）所属规格或 ADR。
- 现有 `LICENSE` 为 AGPL-3.0，不得替换。优先采用许可兼容的成熟第三方包；新增或升级依赖前须记录版本、许可与安全理由（ADR）。未经批准不得引入未知或自定义许可。
- 进度、里程碑和验收交接放在 `docs/plans/` 与 `docs/validation/`，不写入本文件。

## 规范与规则文档

专项规范与本文件一并强制执行。规则目录是 [`.agents/rules/README.md`](./.agents/rules/README.md)。以下索引链接至仓库中的文件与章节。

### 规格

| 文件 | 用途 | 何时阅读 |
| --- | --- | --- |
| [docs/specs/veriq-1.0.md](./docs/specs/veriq-1.0.md) | 产品与技术规格 | 编码前，以及行为与规格可能不一致时 |
| [docs/specs/desktop.md](./docs/specs/desktop.md) | 桌面图形客户端规格 | 改动 Electron 桌面或本地 GUI 时 |
| [docs/specs/macos-controlled-stop.md](./docs/specs/macos-controlled-stop.md) | macOS 受控进程停止 | 改动 macOS 进程停止或停止回执时 |
| [docs/specs/macos-mvp-scope.md](./docs/specs/macos-mvp-scope.md) | Mac 平台范围、兼容性与接续记录 | 改动 Mac 桌面或 Runtime 目标时 |
| [docs/specs/runtime-assets-observation.md](./docs/specs/runtime-assets-observation.md) | Mac 官方资产获取与观察 | 改动 Mac 资产获取或观察工具时 |
| [docs/specs/runtime-manifest-v2.md](./docs/specs/runtime-manifest-v2.md) | Mac Runtime v2 静态库存 | 改动 Darwin Runtime 清单校验时 |
| [docs/specs/runtime-payload-inputs.md](./docs/specs/runtime-payload-inputs.md) | macOS Runtime 静态输入核验与有界归档准备 | 改动 Runtime 输入核验或归档准备时 |

### 独立规则文档

| 文件 | 用途 | 何时阅读 |
| --- | --- | --- |
| [`.agents/rules/README.md`](./.agents/rules/README.md) | 专项规范目录 | 需要判断该打开哪一份规则时 |
| [Coding Standard](./.agents/rules/coding-standard.md) | 跨语言编码要求、与产品约束冲突时的优先规则及工程章节 | 编写或审查源码，或处理下列工程主题时 |
| [`.agents/rules/coding-standard-rules/python-coding-standard.md`](./.agents/rules/coding-standard-rules/python-coding-standard.md) | Python 语言与风格详本。文首 VeriQ 改编是规范性的 | 编写或审查 Python 时 |
| [`.agents/rules/coding-standard-rules/typescript-javascript-coding-standard.md`](./.agents/rules/coding-standard-rules/typescript-javascript-coding-standard.md) | TypeScript 与 JavaScript 风格详本。VeriQ 格式规则是规范性的 | 编写或审查 TypeScript 或 JavaScript 时 |
| [`.agents/rules/commit-standard.md`](./.agents/rules/commit-standard.md) | 提交边界、消息与代理不 push | 准备提交时 |
| [`.agents/rules/security-standard.md`](./.agents/rules/security-standard.md) | 认证授权、密钥、IPC、签名与供应链 | 改动安全相关路径时 |
| [`.agents/rules/testing-standard.md`](./.agents/rules/testing-standard.md) | TDD、假绿禁令、覆盖率与平台测试 | 编写或审查测试时 |
| [`.agents/rules/review-standard.md`](./.agents/rules/review-standard.md) | 审查职责、必查项与拒绝标准 | 审查代码或规格时 |
| [原生与跨平台要求](./.agents/rules/release-standard.md#原生与跨平台要求) | 进程停止范围、凭据、路径与能力声明 | 改动各操作系统上的进程、凭据或停止证明时 |
| [发行、配置与回滚](./.agents/rules/release-standard.md#发行配置与回滚) | 产物完整性、晋升、安全默认与回滚 | 构建发行物或设定配置默认时 |
| [`.agents/rules/privacy-standard.md`](./.agents/rules/privacy-standard.md) | 数据分类、证据授权、保留期与脱敏 | 处理用户数据、证据或日志时 |

编写 Python 时遵守 [Coding Standard](./.agents/rules/coding-standard.md) 与 [Python 编码规范](./.agents/rules/coding-standard-rules/python-coding-standard.md)。编写 TypeScript/JavaScript 时遵守同一总则与 [TypeScript/JavaScript 编码规范](./.agents/rules/coding-standard-rules/typescript-javascript-coding-standard.md)。语言指南与总则冲突时，以总则和本文件中的不可协商基线为准；总则与语言指南已经写明的数字和工具名，不得用本文件以外的旧稿覆盖。

### 工程章节

| 章节 | 用途 | 何时阅读 |
| --- | --- | --- |
| [9. 架构边界与扩展性](./.agents/rules/coding-standard.md#9-架构边界与扩展性) | 分层依赖、控制面与执行面、扩展点 | 新增模块或调整依赖方向时 |
| [10. 资产编译与不可变产物](./.agents/rules/coding-standard.md#10-资产编译与不可变产物) | DSL、发布、快照与引擎确定性 | 处理 DSL、编译或执行快照时 |
| [11. 审计与执行事件](./.agents/rules/coding-standard.md#11-审计与执行事件) | 审计点、事件顺序、fencing 与订阅授权 | 记录审计或发出执行事件时 |
| [12. 并发、幂等、状态与超时预算](./.agents/rules/coding-standard.md#12-并发幂等状态与超时预算) | 租约、fencing、幂等、容量隔离、重试、超时与背压 | 改动队列、租约或结果写入，或设定并发、超时、批次预算时 |
| [13. 数据库与迁移](./.agents/rules/coding-standard.md#13-数据库与迁移) | 表前缀、UTC/UUID、迁移与事务原子性 | 设计表或编写迁移时 |
| [14. 依赖与许可](./.agents/rules/coding-standard.md#14-依赖与许可) | 依赖钉死、许可与漏洞 | 选取或升级依赖时 |
| [15. 文档、契约与 API 兼容性](./.agents/rules/coding-standard.md#15-文档契约与-api-兼容性) | 规格、ADR、跨语言契约一致性与 API 兼容性 | 修改规格、ADR、用户文档或公共 HTTP、IPC、结果协议等契约时 |
| [16. 错误处理与可观测性](./.agents/rules/coding-standard.md#16-错误处理与可观测性) | 失败关闭、错误码、日志脱敏与健康信号 | 设计错误处理或日志时 |
| [17. 出站网络与外部集成](./.agents/rules/coding-standard.md#17-出站网络与外部集成) | SSRF、Provider、对象存储与出站超时重试 | 新增或修改出站调用时 |

## 产品标识与仓库布局

- 人类可读名称为 **VeriQ**，用于注释、文档、规格、计划、API/GUI 标题与生成文档。技术标识保持小写：`veriq`、`@veriq/*`、Python 包名 `veriq_server`。
- 全部平台物理表以 `veriq_` 开头。Alembic 版本表为 `veriq_alembic_version`。
- 本机产品进程名必须是目标平台上的真实 OS 进程名：桌面入口 `veriq` / `veriq.exe`，后台 `veriq_agent`，执行 `veriq_runner`。CLI 可用 `veriq_cli`。
- 规范包布局：
  - `apps/srv` — Tornado 控制服务（`veriq_server`）；Python 依赖只写在 `apps/srv/pyproject.toml` 及其锁文件
  - `apps/web` — React 管理台（`@veriq/web`）
  - `apps/runtime` — Agent / CLI / 离线执行（`@veriq/runtime`）
  - `apps/desktop` — Electron 图形客户端（`@veriq/desktop`）
  - `packages/contracts` — JSON Schema、OpenAPI、生成类型
  - `packages/compiler`、`packages/runner-sdk`、`packages/ui` — 编译器、Playwright SDK、共享 UI
- JavaScript 由仓库根目录的 pnpm workspace 统一管理。控制服务的 Python 依赖不得写入 Node 清单。

## 架构边界

- 控制服务提供 API、认证、Workspace 授权、队列与生产静态资源。控制服务不运行浏览器测试。生产控制面运行时不需要 Node，也不需要 Chrome/Playwright。
- 云端与本地 Runtime 共用同一套 Node 24 执行引擎、编译器、Runner SDK 与结果协议。Electron 内嵌的 Node/Chromium 不是测试引擎；桌面升级不得静默更改已锁定的 Playwright 浏览器工具链。
- DSL 为可编辑源码；生成的 TypeScript 为不可变产物。全部执行依赖须版本化。运行须冻结资产、引擎、环境、数据、角色与浏览器快照。禁止执行漂移的最新草稿，也禁止把现场实际值复制为断言真值。
- Workspace 是资源与授权边界。嵌套引用、下载、事件、导出与导入均须校验 `workspace_id` 与成员身份。系统管理员不是隐式 Workspace 成员，也不隐式拥有私人设备派单权。
- 个人 Runtime 默认私有；共享须所有者显式授权。权限撤销必须阻断后续领取、下载与上传。离线设备与已下载数据无法保证立即被远程回收。
- Electron：启用 `contextIsolation`，关闭 renderer 的 Node 集成，在适用处启用 sandbox；preload 仅暴露白名单类型化 IPC。设备 token、密钥、进程派生与任意文件系统访问不得暴露给 renderer。禁止开放无认证的本地 HTTP 控制端口。
- Mac Electron 主进程直接加载已核验的 Darwin Node-API 插件，用于私有配置和有限的 Cookie 文件操作。禁止另做独立的 Node 文件代理。仅在清单、宿主、架构以及目标加载与签名检查通过后绑定。Renderer 保持隔离，独立的文件型 Keychain 助手保持不变。这一选择不授权真实的 Keychain、Cookie、会话或信任库操作。
- 优先复用成熟库；禁止自行实现密码学原语、浏览器等待、Cron 引擎、schema/迁移框架或通用报告引擎。

## 平台与进程停止

| 目标 | 要求 | 优先级 | 约束 |
| --- | --- | --- | --- |
| macOS Intel x64 | 必须 | 最高 | 最低 macOS 15（Sequoia）；Mac 测试使用宿主原生 Chrome；禁止用 Linux 虚拟机浏览器代替；须真实架构验证，仅 Rosetta 不足 |
| macOS Apple Silicon arm64 | 必须 | 最高 | 同 Intel Mac |
| Windows 11 x64 | 必须 | 较低 | 仍须交付完整桌面与 Runtime |
| Ubuntu 24.04 x64 | 必须 | 较低 | 仍须交付完整桌面与 Runtime |
| 服务端 Linux x64 | 必须 | 服务端基线 | 前端构建后暂存并打入 Python wheel；控制面运行时无 Node/Chrome |

进程停止回执必须携带明确的 `processStopScope`：

| 范围 | 适用平台 | 含义 |
| --- | --- | --- |
| `FULL_DESCENDANT_TREE` | Linux / Windows | 经核实的全后代排空 |
| `CONTROLLED_WORKER_BROWSER` | macOS | 观察到受控 Worker 与 Chrome 退出；不确定则隔离，并交人工恢复 |
| `NO_PROCESS_SPAWNED` | 各平台 | 持久状态证明未派生执行进程 |

- macOS 不承诺任意游离后代的内核级清理。禁止将 Mac 受控停止证据改写为 Linux/Windows 的 `DRAINED` 或全树证明。
- PID 消失、窗口关闭、Context 关闭或 CLI 退出码单独均不构成完整的受控停止回执。
- 过期或未知进程占用隔离容量；逻辑取消、超时或 PID 缺失不得伪装成停止成功。

## 执行默认值

| 参数 | 默认值 |
| --- | --- |
| 未结束 Run 上限 | 10 |
| 在线全局浏览器上下文 | 4 |
| 单 Workspace 浏览器上下文 | 2 |
| 离线本机并发 | 1 |
| 心跳 | 10s |
| 租约 | 60s |
| Playwright `retries` | 0 |
| 整用例重试 | 至多 1 次，由 VeriQ 负责（新 Context、新 fixture、新工作目录） |
| 该次重试后通过 | `UNSTABLE`（默认门禁不通过） |

结果归约顺序：`ERROR > INCOMPLETE > FAILED > CANCELLED > UNSTABLE > SKIPPED > PASSED`。须保留底层业务、清理与证据事实，禁止只存最高优先级标签。

## 调度与维护

- 产品内部不设 Cron。外部调度通过经认证、幂等的 HTTP 触发与维护接口唤醒。
- 维护接口必须使用受限身份、有界批次、幂等语义，并在仍有剩余工作时返回处理数量与 `hasMore`。
- Agent 轮询与心跳不是 Cron，仍属于统一执行协议的一部分。

## 打包与运行环境

- 开发模式：前端与后端可分开运行；Python editable 安装不得依赖已存在的前端 `dist`。
- 生产服务端：先构建前端，暂存至 `apps/srv/src/veriq_server/static/dist`，并将完整静态清单与迁移一并打入 Python wheel。缺少 `index.html` 或清单则构建失败。同源服务须区分 API、静态文件与已登记 SPA 路由；未知 API 或缺失静态资源返回真实 404。
- 凭证不得写入前端构建产物。用户证据不得放入静态发布目录。
- 桌面产物按 `darwin/x64`、`darwin/arm64`、`win32/x64`、`linux/x64` 分别构建与验收。共享业务代码不能替代各平台的凭据库、进程监督、原生文件系统与生命周期适配。
- 本地 Runtime 持久化使用锁定的 Node 24 内置 SQLite，表名仍用 `veriq_` 前缀。桌面与 Runtime 不得要求终端用户安装 Python 或 MySQL。
- 时间戳以 UTC 存储；除非具体产品界面另行定义，默认显示时区为 Asia/Shanghai。平台实体 ID 使用 UUID 字符串。

## 离线与 AI

- 离线包为已签名的依赖闭包与只读快照。包内不得携带密码、Cookie 或设备 token。签名证明包内容的来源与完整性，不证明本地结果不可伪造。
- 离线指无需连接控制平台；被测系统仍须可达。离线不包含双向编辑同步。
- 结果导入走独立的离线导入路径：须幂等、带来源标识，且不得覆盖在线 Attempt 的权威记录。
- AI 为可选辅助。自动化测试必须在无模型凭证时仍可运行。未配置 Provider 时，确定性执行须完整可用。AI 输出须经校验与人工审核，严禁自动发布。协议模拟成功不等于 Provider 验收通过。

## 锁定的工程基线

精确解析版本以 `pnpm-lock.yaml`、`apps/srv/uv.lock`、`.python-version`、`.node-version` 与 ADR 为准。产品依赖禁止使用浮动的 `latest` 范围。保持精确钉死（pnpm `saveExact`，CI 与发行路径使用冻结安装）。

| 层次 | 锁定族 |
| --- | --- |
| 控制服务 | Python 3.12、Tornado **6.6.1**、SQLAlchemy 2、Alembic、asyncmy、Pydantic 2、MySQL **8.4** |
| Web | React **18**、Vite **6**、Tailwind **3**、TypeScript、ESM、react-router-dom / React Router **7.18.5**、TanStack Query 5 |
| 工具链 | Node **24**（`>=24 <25`）、pnpm **11.25.0**、uv、Biome、Prettier、Playwright Test（以锁文件钉死） |
| 桌面 | Electron 与 React，以及 electron-builder / electron-vite；与 Electron 并列的独立 Node 24 Runtime |
| 契约 | JSON Schema、OpenAPI、Pydantic、jsonschema、Ajv；保持跨语言样例一致 |

凡移动上述族、Router 或 Tornado 的钉死版本，或 Playwright / Electron 引擎身份的依赖变更，均须显式批准并更新 ADR。

## 编码规范（强制摘要）

细则见 [Coding Standard](./.agents/rules/coding-standard.md)、[Python 编码规范](./.agents/rules/coding-standard-rules/python-coding-standard.md) 与 [TypeScript/JavaScript 编码规范](./.agents/rules/coding-standard-rules/typescript-javascript-coding-standard.md)。下列条目与这些文件一致：

- 缩进：TypeScript/JavaScript、Python、C/C++ 以及同仓库其它可编程源码一律使用 **4 个空格**；禁止 Tab 缩进（`.editorconfig` 明确例外者除外，如 `Makefile`）。新增与改动文件必须符合 `.editorconfig`（UTF-8、LF、文件末换行）。
- 行宽：代码和注释每个物理行最多 **120 个显示列**，与 IDE 的 120 列标尺一致。中文等全角/宽字符占 2 列，ASCII 占 1 列；缩进、标点和注释分隔符也计入。导入、长字符串、URL 和生成源码同样遵守上限；完整 Unicode 口径见《Coding Standard》。
- 注释语言：源码注释（含模块说明、公开 API 文档串、关键路径旁注）一律使用**中文**；产品名 VeriQ 与技术标识可保留原文。
- 注释覆盖率：可编程源代码注释覆盖率必须 **大于 40%**（注释行 / (注释行 + 非空代码行)）。仅排除生成物与 vendored 依赖。覆盖率必须靠针对当前代码的有效说明达成，禁止用套话、政策复读或占位长句批量粘贴凑数。
- 固定工具语法：经语法上下文和实际工具行为验证的标记按功能代码计量，标记贡献 `C=0`，所在非空物理行保留在 `K` 并适用显示列宽限制。识别范围和普通说明的处理见[工具语法计量规格](./docs/specs/tool-syntax-accounting.md)。
- 注释质量：每条注释必须解释**此处**的职责、不变量、失败关闭点或非显而易见的取舍。禁止在每个注释块重复粘贴通用安全或契约口号。测试文件以行为说明为主。
- 公开 API 注释：所有公开方法、公开类、公开接口、类型定义和导出函数都必须有中文注释。核心功能、关键分支、关键逻辑与重点执行路径也必须有注释。
- 注释正文：独立单行注释及各注释块的首行有效正文为 **40～120 个 Unicode 字符**，且须含中文；缩进、`//`、`#`、`/**`、`*`、`*/` 和文档字符串引号不计入正文。块注释续行不设 40 字符下限；每个物理行仍最多 120 个显示列。C 风格独立文档块的开闭分隔符各自独占一行，正文从下一行的 ` * ` 开始；首行指首行有效正文，不是分隔符行。
- 日志语言：所有日志输出（logger、诊断 print、结构化 log event message）必须使用**英文**。请求或领域数据体中的其它语言可以保留。禁止在日志中输出密钥、token、Cookie、密码或未脱敏的隐私字段。
- Python：解释器只使用 **3.12**。静态检查必须使用 pylint，并配合 pylintrc。格式化必须使用 Black 或 Pyink。
- TypeScript/JavaScript：以 Biome、Prettier 与 `tsc` 为准。Prettier 的 `printWidth` 为 120，仅为排版目标；显示列宽硬上限由 `python3 scripts/line_width.py` / `pnpm lint:width` 检查。普通字符串使用双引号（`singleQuote: false`）；仅当字符串含有双引号、需要避免转义时允许单引号。
- 机械检查：`scripts/comment_audit.py`（syntax-comments-v1）、`scripts/comment_blocks.py`（块注释排版）及 `scripts/line_width.py`（显示列宽）。自动通过只证明可机械验证的条件；注释实质仍须人工审查。
- 不得以虚构、占位、CTF 式表述或临时代码弱化上述规则。协调者与实现者在评审中均须执行。

## 实现与证据

完整测试要求见 [测试规范](./.agents/rules/testing-standard.md)。提交边界见 [提交规范](./.agents/rules/commit-standard.md)。安全底线见 [安全规范](./.agents/rules/security-standard.md)。

- 行为变更优先采用 TDD：先观察到 RED，再实现到 GREEN。断言真实可观察行为，不测源码文本字符串是否匹配。
- 迭代时跑聚焦测试；移交提交或集成前跑相关更完整套件。每一次失败与阻塞都必须如实报告。
- 禁止用 sleep、强制点击、宽泛吞异常、弱化断言、假 UI、假报告，或在缺少必需夹具（MySQL、浏览器、原生工具链）时静默跳过，来掩盖失败。
- 保持 API、Schema、OpenAPI、生成类型、样例与文档一致。修改契约后须重新生成，并运行拥有这些产物的包级 `check` 与 `test`。细则见 [文档、契约与 API 兼容性](./.agents/rules/coding-standard.md#15-文档契约与-api-兼容性)。
- 变更保持聚焦、可读。永不提交密钥、环境凭证、二进制、缓存或机器状态。
- 质量门禁：除非任务明确收窄范围，Python 与核心 TypeScript 包行覆盖率目标为 **≥ 75%**。关键认证、租约与 fencing、停止回执和恢复路径仍须有超出覆盖率数字的专项行为测试。
- 不得以空壳接口、占位页面、仅含 TODO 的模块或默认跳过的测试套件冒充功能交付。
- 依赖变更遵守 [依赖与许可](./.agents/rules/coding-standard.md#14-依赖与许可)。

## 代理操作规则

审查标准见 [评审规范](./.agents/rules/review-standard.md)。

- 变更范围、架构、已锁定依赖族、许可立场或平台停止保证前，必须先询问。
- 只负责被指派的切片；禁止顺手重构无关包。
- 切片完成定义：行为符合所属规格的失败关闭点；测试呈现可观察行为的 RED 到 GREEN；触及契约时已同步类型与样例；满足编码、测试与安全专项规范；未 stage 密钥或机器状态。限制条件须显式写明，不得靠弱化断言掩盖。
- 审查者应拒绝看起来是绿的、但缺少与所声明结论相匹配的行为或平台证据的结果。
