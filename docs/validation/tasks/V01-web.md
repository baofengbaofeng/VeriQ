<a id="v01-web-独立验证与复审"></a>

# V01 Web

状态：**源码交付；本轮未执行任何测试、lint、格式检查、类型检查、构建、浏览器、API 请求、CI 或独立复审。** 本文不是通过报告，所有命令均供后续接手者执行；实际结果、退出状态和问题尚待填写。源码提交由协调者登记，接手者必须记录实际验证提交，不能沿用历史通过记录。

<a id="source_delivery"></a>

## 源码交付

| 范围 | 已实现源码 | 待完成的验证或明确边界 |
| --- | --- | --- |
| 报告工作区 | 从所有已加载分页计算 URL 目标是否可用，URL 选择与默认回退分离；保留手动选择、初始 runId 与原有 Workspace Provider 归属；补全真实工作区加载、空态、错误重试及分页忙碌态 | 实际后页 URL 目标、首屏目标、不可访问目标、手选后的语言切换和列表重取；新增 `reports.spec.ts` 仅覆盖真实工作区，不产生报告 |
| 报告订阅与历史 | 数字 restart 仅重新挂载空渲染订阅子组件，保留父级 caseLimit、attemptId、generation；历史游标转为 ref，稳定 load 由按 generation 作为键的空组件触发；保留原有取消、序号去重/排序、重叠响应、错误与 hasMore 语义 | **真实含实际执行数据的报告／重试／历史仍必需，未验证。** 必须使用真实受管理编译器、已发布资产、Runtime 和实际执行事件，不能伪造验证回执、Attempt 或事件 |
| 资源表单 | Field 每个 RHF 控件分支及 VersionField 通过 useId/htmlFor/id 关联标签；保留 ref/name/onBlur/onChange、可选值及不可用版本；StringList 使用命名 fieldset/legend | 所有八类资源及字段分支、辅助技术名称、键盘操作、可选及不可用选项；密码分支需额外实际组件覆盖 |
| 数组与诊断 | 原始 JSON 数组和自由字符串列表使用私有行标记，初始化/添加分配，编辑保留、删除仅移除指定行；原有对象数组 `_formId` 不变；ResourceForms 在恢复远端草稿与 JSON 应用操作的权威 reset 边界更换 key；标记不进入 RHF 或持久化正文；诊断以完整语义项和同项出现次数稳定区分，Schema 校验按实际序列化输入记忆化缓存 | 连续输入/光标、空串与重复值、首/中行删除后存活节点和焦点、嵌套祖先删除、add/delete/add、同长度及不同长度 reset、准确保存正文、重复诊断及被隐去的路径。新增真实资源 UI 用例尚未运行 |
| 会话传输 | JSON、SSE、二进制请求捕获会话代次；只有当前且未取消请求的 AUTHENTICATION_REQUIRED 触发全局失效，其他登记/服务凭证错误仍抛给调用者；CSRF 只接受当前代次响应；新登录先取消旧登录/退出再发送请求，退出完成/真实失效推进代次；宿主传输契约不变 | 真实 Cookie/Set-Cookie 顺序、当前和过期 401、CSRF、取消、跨身份 UI 写入及桌面宿主适配均待验证。取消是客户端候选，**不能从代次检查或单元 fixture 推断浏览器已经排除旧头部**；若实测不能保证，需交协调者决定服务端协议，不得自行取消 cookie 清理 |
| 动作与调度 | Runtime 登记码变化使旧检查的成功/错误失去预览发布权；维护令牌实际 UI 增加第五项 `lifecycle/expire`，沿用既有 purpose、权限与请求语义 | 实际慢响应时修改登记码/切空间；五项维护权限与服务端/共享契约一致；跨分支动作及非全局认证错误不退出正常用户 |
| 发布测试收尾 | 新增小型 `withCleanup`，用独立存在性标志保存正文/清理错误，单错原样抛出，双错 AggregateError 与主因；恢复目录仅在所有已有日志明确 STOPPED 且摘要写入成功后删除，ENOENT 单独处理；CASE 元组用保证存在的首步骤加 slice(1,2) | 单元结算矩阵、throw undefined、受控 FS 的 ENOENT/其他 IO/坏日志/写失败/未 STOPPED；真实 Agent 停止证明仍需真实引擎，fixture 不提供此证明 |

新增测试源码：`apps/web/tests/unit/api-session-ownership.ts`、`apps/web/tests/unit/case-profile-cleanup.ts`；支持文件 `apps/web/tests/support/case-profile-cleanup.ts`、`apps/web/tests/support/hold-auth-response.ts`。发布测试的截图和停止摘要改用 testInfo.outputPath，后续执行不覆盖旧 T11 证据。后者使用 Node 原样转发本机真实认证响应，避免 `route.fetch()` 提前修改 BrowserContext Cookie；不构造认证内容，也不由测试调用 route.abort 制造取消。现有 `auth.spec.ts` 的延迟退出场景改为观察产品 requestfailed，释放屏障后通过当前 api.session() 和真实创建 Workspace 验证身份/CSRF；仍需以下完整竞态矩阵。

未做全十四模块的交互验收或全仓注释整改，不能把本次有限源码修复称为“所有 UX 已完成”。没有新增依赖、锁文件、共享契约或后端修改，没有安装、启动引擎、执行真实凭据操作或修改历史 SDD 证据。

<a id="source_deliveryc01b-共享双语键盘与示例入口"></a>

## 源码交付：C01b 共享双语、键盘与示例入口

C01b 已继续实现原先识别的全局语言源码缺口；此状态替换原“全站语言仅待后续编码”的登记，不能因此推断浏览器验收通过。

| 功能 | 实际交付源码 | 独立验证状态 |
| --- | --- | --- |
| 共享语言状态 | `src/locale.ts`、`src/locales/preference.ts` 和按账号、工作区、Runtime、计划、编辑器、共同操作拆分的词条；只接受持久化 `zh`/`en`，无有效偏好时跟随浏览器中文或英文回退，存储不可写时保留内存体验 | 未执行；须覆盖 en-US、zh-CN、无效偏好、禁用存储、刷新和跨窗口 storage 事件 |
| 实例生命周期 | `useAppLocale` 按挂载引用计数安装及释放 editorI18n、aiI18n 与 appI18n 桥接；同值检查和反馈锁避免循环，各实例保留独立命名空间；初始化也共享偏好，示例命名空间继续使用其嵌套错误词条 | 未执行；须覆盖单独嵌入、卸载/重挂载、严格效果重放，以及从三个实例分别改语言；不能只观察全局 select |
| 实际页面翻译 | 主进程导航、初始化/登录/重置、账号/用户、工作区/成员/邀请、Runtime/服务账号、计划/令牌及资源、环境、断言、离线包、报告的实际 React 标签、动作、提示、状态与可访问名称接入词条；保留 data-testid、技术枚举、业务名称、JSON 与请求值 | 未执行；既有英文浏览器用例选择器与固定双语预期已按英文展示更新，未运行任何一项；未知服务端领域消息及技术细节继续原样展示 |
| 控件与焦点 | `src/locale-ui.tsx` 提供共享 Provider 和唯一全局语言控件、跳至主内容链接；主进程使用主地标、活动导航与路径变化后的标题焦点，查询及语言变化不移动焦点；本地确认框通过共享 Radix 可选 cancelLabel/confirmLabel 接口提供翻译，保留焦点圈定和 Escape 行为 | 未执行；共享包接口由协调者提交 `2bdb181`，此处未修改共享目录；须真实键盘/读屏、1280宽布局和对话框测试 |
| 编辑器状态 | 资源表头随实际翻译函数更新但保持记忆化缓存；Monaco 的业务 label/代码语言/只读生命周期保持原契约，应用语言仅 updateOptions 更新可访问名称，不重建模型；有可键盘到达的 Tab 导航切换命令及真实 Windows/Linux、macOS 快捷键说明；数组保留原先键盘上/下移并增加独立名称及中文/英文拖动说明 | 未执行；必须确认未提交字段、原始行 key、光标、模型、撤销栈和报告订阅跨语言保持；不能用设置文本或模型来制造保留结果 |
| 示例向导真实入口 | `WorkspacePage` 的实际按钮挂载 C06b `SampleWorkspaceWizard`，使用已有导出 `request<T>` 的 Cookie/CSRF/epoch 传输，不添加 fetch 旁路；仅可管理且未归档当前空间作为导入目标，否则先显式创建新空间，关闭恢复触发器焦点；成功链接携带真实 workspaceId/planId，计划页以真实空间权限和计划详情接口展示目标，不自动触发或编辑 | 未执行；完整真实包读取、权限、秘密不落盘、受管理编译/发布、恢复、取消和计划目标流程仍需 V06/V01 联合验收 |
| 保留期与 SSE | HTTP410 仍为普通领域失败；已开始的 SSE authorization 帧由原 Response 的弱引用所有权判断，REPORT_EXPIRED 返回 ApiError410，空间拒绝为403，只有明确且仍拥有当前请求的 AUTHENTICATION_REQUIRED 帧可触发全局会话失效 | 未执行；已补单位源码覆盖域到期、旧帧和当前认证帧，但不代表真实流、Cookie 或服务端保留期验证 |
| 真实状态收尾 | 计划工作区、资源/版本选择及服务账号/令牌补齐实际加载与空态；保留原查询错误和权限拒绝。来源未知或到期的资源不变成假空列表，也没有占位导入成功或合成 Run | 未执行；完整十四模块逐屏需求映射及所有角色状态仍须独立验收 |

新增回归源码 `apps/web/tests/locale.spec.ts` 使用真实安装/登录、实际资源控件和真实翻译实例，覆盖英文/中文浏览器、无效偏好、持久化、未提交输入节点、桥接、跳转链接及路由焦点。源码用现有 Prettier `format` API 写回四空格格式，属于源码编辑；**没有执行 prettier --check、lint、类型检查、测试、构建、浏览器、CI 或独立复审**，不能把格式写回当成通过记录。

明确范围边界：这里完成的是 VeriQ 自有页面和编辑器可访问控件的共享语言接入。`src/features/resources/Monaco.tsx` 使用官方 Monaco 固定版本；其内建命令菜单、查找小部件和第三方辅助服务有在模块注册时缓存的独立 NLS 文案，并非 appI18n 词条。完整即时切换这些第三方内部文案尚未实现；不能用 DOM 替换或重建用户模型冒充完成。后续若要求这些内部菜单也立即双语，需单独实现受支持的 Monaco NLS 装载/切换方案并保留当前模型生命周期。本批没有声称所有第三方界面或 F01–F14 的完整 UX 已通过。

## 环境、入口与命令

| 检查 | 前置与待执行命令（仓库根目录） | 预期及当前结果 |
| --- | --- | --- |
| 应用类型 | 固定 Node24、pnpm11.25、已冻结安装依赖；`apps/web/node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json`；桌面复用另执行 `pnpm --filter @veriq/web build:desktop:types` | 应用及宿主复用完整类型通过；**未执行** |
| 完整测试文件类型 | `apps/web/node_modules/.bin/tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --lib es2022,dom,dom.iterable --strict --skipLibCheck apps/web/tests/case-publish.spec.ts apps/web/tests/reports.spec.ts apps/web/tests/auth.spec.ts apps/web/tests/unit/api-session-ownership.ts apps/web/tests/unit/case-profile-cleanup.ts apps/web/tests/locale.spec.ts` | 整文件而非截取用例；历史元组 TS2322 必须消除，保留全部新旧诊断；**未执行** |
| 完整 Web 静态检查/格式 | `pnpm --filter @veriq/web check`；若前置 tsc 失败仍单独执行并记录 `pnpm exec biome lint apps/web/src apps/web/tests apps/web/vite.config.ts apps/web/playwright.config.ts` 与 `pnpm exec prettier --check apps/web/src apps/web/tests apps/web/vite.config.ts apps/web/playwright.config.ts`，确保没有被前序 && 短路隐藏的诊断 | 新文件、所有原有文件、warnings/项提示均须保留，不能只报告局部范围的静态检查；**未执行**，格式和现有规范债务未获通过 |
| 传输/清理单元 | 使用已声明且已安装的 tsx；`node --import tsx --test apps/web/tests/unit/api-session-ownership.ts apps/web/tests/unit/case-profile-cleanup.ts` | 原始错误身份、双错 cause、取消顺序、旧代次不污染当前；仅受控传输/FS，不是 Cookie 或 Agent 真实性证明；**未执行** |
| 工作区/资源有限真实 GUI | 固定 Python3.12/uv、MySQL8.4 独立 `veriq_test` 数据库、5173/8888 空闲、已安装真实 Chromium；先核对现有 `.superpowers/sdd/veriq-1/evidence/t22/identity-effects/private-playwright.config.mts` 的绝对路径/launcher/测试库重置边界并复制为本轮私有配置，不改历史文件；使用 `apps/web/node_modules/.bin/playwright test --config <本轮私有配置> reports.spec.ts`，再对 `case-publish.spec.ts --grep 'primitive rows'`，另分别选择既有八类资源及 JSON 应用操作场景 | 只跑真实已有 API 和 UI；不得误用默认 prepare-editor-agent 自动安装/构建或启动无资格引擎；新增用例尚未执行，测试资源与端口需独立拥有 |
| 真实认证 GUI | 同一真实后端、A/B 账户和独立浏览器上下文；`apps/web/node_modules/.bin/playwright test --config <本轮私有配置> auth.spec.ts`；该文件现有首次初始化场景要求独占空安装测试库 | 保存真实状态/事件顺序和清理记录，敏感 Cookie/CSRF/密码仅留私有内存或受限制品，公开日志只记状态与散列；**未执行** |
| 真实引擎报告/发布 | 真实兼容 inventory/release、受管理 Runtime、受支持 Chrome、合成目标服务、API 创建的完整配套资产，按下一节执行 | 空报告、Local 测试夹具或造回执不算通过；**未执行且尚未资格化环境** |
| 最终集成 | 正常生产静态构建→wheel 由 V08 接手；全十四模块、1280 宽布局、中英文、键盘、角色、跨空间、并发/故障和整分支独立复审由 V10 接手 | C01 不替代这些门禁；**未执行** |

有限 UI 场景之外的既有测试不能自动计入通过；每个实际选择的场景和过滤条件都须记录。原始完整 CASE 类型历史命令另见 `.superpowers/sdd/veriq-1/evidence/t22/identity-effects/test-types-initial/command.json`；其历史 exit2 不代表新源码结果。

## C01b 双语与键盘接续验收（必需）

- 同一已冻结环境中执行 `apps/web/node_modules/.bin/playwright test --config <本轮私有配置> locale.spec.ts`；此文件只使用真实安装、登录和草稿 API，不需要伪造编译回执。先检查测试库独占，测试不能与首次安装用例共享已经变化的安装状态假设。
- 英文浏览器无偏好首屏英文，中文浏览器无偏好首屏中文；支持值刷新后保持，无效存储不参与命名空间解析；存储被拒绝仍能切换，跨窗口只接收有效值。桌面单独嵌入共享视图也需测试，不能仅测 Web 根 Provider。
- 在登录、账号改密、管理员筛选、Runtime 登记码、工作区邀请、计划版本/变量/秘密令牌、八类资源表单和 Monaco 未提交 JSON 中分别切语言；字段节点、未保存的值、光标、撤销栈、请求所有权和一次性令牌应保持，不多发业务或 AI 请求、不重挂载 Workspace/订阅。
- 分别调用真实 editorI18n、aiI18n、appI18n 的语言入口，检查导航、页面、示例命名空间、独立实例与刷新偏好一致；卸载后监听释放，旧组件不能反向覆盖当前语言。
- 仅使用键盘完成跳转链接、导航、语言 select、表单、原生 details、Radix 确认与取消、数组上/下移、拖动取消、Monaco Tab 导航及焦点退出。macOS 的 Monaco 切换为 Control+Shift+M，Windows/Linux 为 Ctrl+M；同时验证可见按钮调用同一官方命令。
- 路径改变聚焦新页面标题或加载中的主内容，语言和查询参数变化不抢焦点；关闭示例向导返回真实触发器，成功链接打开真实授权工作区和计划。深链接不可见/无权限/已归档/晚于首屏的数据必须真实报错或只读，不自动覆盖现有表单。
- 完整 V01 lint、应用和桌面声明、所有相关测试文件严格类型及 V09 规范仍未运行。词条文件是展示数据，不能由“增加了翻译”推断全仓注释覆盖率或第三方 NLS 已达标。

<a id="真正-populated-报告验收必需"></a>

## 真正含实际执行数据的报告验收（必需）

1. 通过真实 create → validation-preview → validate → 受管理编译完成 → validation-receipt → publish 建立资源；创建有真实授权 Runtime、环境、角色和浏览器的 Run。任何缺失库存/凭据/目标服务均记阻塞，不造回执或数据库领域记录。
2. 观察首次报告 GET、events/stream POST 与服务端初始 SSE 报告代次。普通渲染及证据更新不重开订阅；有限注入一次真实传输故障后 Retry 只新建一对请求，旧生命周期停止，选中 attempt、caseLimit 与 generation 归属符合既有语义。
3. 使用真实超过100条已接纳事件的 Attempt，首次打开只请求一页；推进 nextSequence 不自动再取；每次 More 一次、每次提交的报告 generation 一次，并使用当时最大游标。序号合并去重排序，重叠响应不回退游标，错误和 hasMore 不丢失。
4. 真实切换空间/Run/Attempt，确认旧请求取消、迟到结果不进入新作用域；验证原始证据权限、脱敏路径、下载失败、Trace、本地报告与导入来源。保留同空间 URL runId 变更原有语义，不自行扩大行为。
5. 用真实 managedCompiler 运行 reusable-flow/template、调用方页面、teardown 和发布全流程；确认每个进程日志真实 STOPPED，未知时保留 profile。cleanup 单元测试的受控文件不能替代此步骤。

## 真正会话竞态验收（必需）

- A 的两次真实账户读取在后端前暂停；A 退出真实完成后持有原始响应，第一条真实401打开登录页，第二条真实401保留到 B 登录后再交付。B 真实 session/account200 后释放旧退出与旧读取，B 的 UI、Cookie、session200 和实际 Workspace 写入201必须继续一致；真正撤销 B 后的当前401必须正常退出。
- 截获新的认证请求前已经因产品 AbortController 失败的旧退出请求，记录真实 requestfailed/AbortError 与请求头交付顺序；Node 转发器不共享 BrowserContext Cookie 容器，不能沿用 route.fetch 的提前 Cookie 变更当作网络证据。并发登录、重复退出与卸载也覆盖。
- A 的真实初始化 CSRF 响应在 B 登录前开始，B 当前 session 响应后才交付；后续 UI 写入必须使用 B 最新拥有的 token 文本并成功。不同掩码令牌字符串不自动意味着服务端验证失败，Tornado 可能接受同一原始秘密的不同掩码。
- JSON、SSE、二进制下载、取消的当前请求和过时请求分别覆盖；INVALID_CREDENTIALS、无效登记码和服务账号凭证错误保持原业务失败，不能撤销正常平台用户。
- 如果取消不能排除延迟 Set-Cookie，明确记失败并交协调者决定经审查的服务端协议；本批没有修改 cookie 名称、撤销或清理契约。

## 已知历史失败与本轮结果边界

| 既有记录 | 接手处理 |
| --- | --- |
| 服务端正式 CI `43781415653`、提交 `2455199`：Web 静态检查 15 项错误／ 32 项警告／ 138 项提示，后续构建测试未运行 | 历史失败保留；本轮不推断减少至0，必须完整重跑并保存所有诊断 |
| `case-publish.spec.ts` 独立严格类型检查 TS2322；ReportPage 七个 hook、资源八个非 Hook 问题的历史前置检查 | 源码已针对修复，整文件类型/lint尚无实际结果 |
| 全仓注释规范约4.56%，目标大于40%，历史264项首行等问题 | 仍为 V09 代码质量待办；C01 不宣称新旧所有文件规范通过 |
| 真实报告、Runtime、Provider、桌面安装和正常发行门禁未全部通过 | 不能用本任务空报告/单元/工作区子集代替 F01–F14 或 MVP 完成结论 |

实际执行记录表由后续任务填写：提交与锁摘要、环境/角色、准确命令、开始结束时间、退出状态、公开安全日志路径、失败原因、修复提交、哪些先前结果失效。当前所有行的实际结果均为“未执行”，无 RED/GREEN、通过数量或伪造的 Attempt。
