# VeriQ 数据集 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可从 Web 和桌面管理、可在断言引用的工作区数据集，支持静态表/树和 HTTP，并让联网客户端执行结束后没有数据副本。

**Architecture:** 数据集沿用资源修订和冻结闭包。编译产物投影只含数据描述和摘要，授权后的正文经受控 IPC 送入工作进程内存。HTTP 代理持有出站授权和密钥，SDK 统一承载查询和断言执行语义。

**Tech Stack:** Tornado、SQLAlchemy、MySQL、JSON Schema/OpenAPI、React、Electron、Node 24、TypeScript、Playwright。

**Spec:** [VeriQ 工作区数据集与联网执行](../../specs/veriq-datasets.md)。

## Global Constraints

- 保留既有资源、用例、执行和报告版本的只读兼容。保持 `{{data.*}}` 与静态套件矩阵的语义。
- 根契约和类型一并生成。沿用已锁定 Node、Tornado、数据库、Electron 和 Playwright，不升级依赖族。
- 工作区、版本、设备、租约、fence 与明文访问权限一起校验。运营诊断只保留结构化脱敏信息。
- 首期复用规范资源内容 2 MiB 的上限。内存传输超出批准预算按资源错误处理。
- MVP 发布路径为联网执行。现有历史记录、已发布版本与数据库表不做破坏性迁移。
- 每个切片先写有明确失败原因的测试，再实施、重跑并提交。已有无关测试失败单独记录。

## Review Focus

- 旧资产冻结版本的重验证不会替换当前草稿或改变矩阵行。任务 5 固定旧版本后修改草稿再启动。
- 大于 64 KiB 的静态正文和跨 IPC 分帧 Unicode 均完整到达工作进程。任务 5 比较原始字节摘要。
- 结束前重新分配租约或撤销成员会立即阻断后续读取。任务 5 用新的 fence 触发旧 Attempt 拒绝。
- 同一阶段的重复请求、前后阶段、套件重试分别遵循取样约定。任务 8 以有计数器的真实上游验证请求次数。
- 已被断言消费的数据可能出现在浏览器回显、报告和工作目录。任务 6 让夹具上游故意回显标记并扫描本机状态。

## 第一批 · 静态数据闭环

### 1. 静态数据契约与语义校验

**Files** `packages/contracts/schemas/platform-v1.schema.json`、`packages/contracts/openapi/platform.yaml`、`packages/contracts/scripts/generate.ts`（按现有生成器需要）、`packages/compiler/src/validate.ts`、新增 `packages/contracts/tests/datasets.test.ts` 和 `apps/srv/tests/resources/test_datasets.py`。使用正式生成命令更新 Python/TS 与桌面模式。

**Interfaces** 保留 `DatasetV1`。新 `DatasetV2` 用 `schemaVersion: "2.0"`、`shape: "TABLE" | "TREE"`、`source: {kind: "STATIC", rows: DataRowV2[]}` 及 `fields`。`fields` 为字段名到 `{type, required, nullable}` 的映射。`DataRowV2` 含 `key`、`values`，TREE 行另外含 `parentKey: string | null`、`order: number`。`validateDataset` 返回有位置和稳定代码的编译诊断。既有编译器和服务端共享契约测试夹具，语义不重复写进 JSON Schema。

- [ ] 写 `datasetV2 validates sparse rows and typed values`，验证 `code: "01"` 可用，`code: 1` 触发字段类型错误，可选字段缺失通过，显式 `null` 仅在可空时通过。写 `tree rejects unresolved and cyclic parent links`，分别断言 `DATASET_ORPHAN_NODE` 和 `DATASET_TREE_CYCLE`。V1 样例仍通过原验证。
- [ ] 运行 `pnpm --filter @veriq/contracts exec vitest run tests/datasets.test.ts` 与 `uv --project apps/srv run pytest apps/srv/tests/resources/test_datasets.py -q`，确认新结构被拒绝且旧用例仍绿。
- [ ] 实现 V2 契约、树关系检查和编译器单一入口。复用已有文档大小与闭包预算。允许空的静态参考集合，禁止将空集合用作套件矩阵输入。
- [ ] 运行 `pnpm --filter @veriq/contracts generate`、同上聚焦测试、`pnpm --filter @veriq/contracts check` 和 `pnpm --filter @veriq/compiler test`。验证生成物同步与 V1 回归。
- [ ] 按仓库提交规范提交契约与校验切片。

### 2. 跨工作区复制及草稿对话框

**Files** `apps/srv/src/veriq_server/{app.py,handlers/resource.py,services/resource.py,repositories/resource.py}`、`packages/contracts/openapi/platform.yaml`、`apps/web/src/features/resources/{ResourcePage.tsx,adapters.ts}`、`apps/desktop/src/renderer/adapters.ts`、`apps/web/tests/case-publish.spec.ts` 和 `apps/srv/tests/resources/test_datasets.py`。

**Interfaces** `POST /api/v1/workspaces/{workspaceId}/resources/dataset-copies`，正文 `DatasetCopyRequest {sourceWorkspaceId, sourceDatasetVersionId, key, name}`，响应复用资源 DTO。`ResourceService.copy_dataset(scope, data)`，`CloudResourceAdapter.copyDataset(request, signal)`。目标草稿单次原子写入，复制源版本可追踪。桌面复用同一适配器。

- [ ] 写 `test_copy_dataset_checks_both_workspaces`，源无 DOWNLOAD 或目标无 EDIT 分别拒绝，数据库无目标草稿。写 `test_copy_dataset_is_independent`，源发布后变更不改变目标草稿，目标新 ID，同名 key 冲突时返回 409 且无部分结果。
- [ ] 运行 `uv --project apps/srv run pytest apps/srv/tests/resources/test_datasets.py -q`，确认复制业务测试因接口尚无而失败。
- [ ] 实现复制事务和审计。对话框从有下载权限的空间选择源发布版本，创建目标资源后打开草稿。HTTP 来源的配置清理留给任务 7，并用兼容 DTO 保持复制入口不变。
- [ ] 运行同上 pytest 和 `pnpm --filter @veriq/web exec playwright test tests/case-publish.spec.ts -g 'copy dataset'`，验证页面到真实接口及权限隔离。
- [ ] 提交复制切片。

### 3. 表格和树编辑、导入预检

**Files** `apps/web/src/features/resources/ResourceForms.tsx`、新增 `apps/web/src/features/resources/DatasetFields.tsx` 与 `dataset-import.ts`、`apps/web/tests/case-publish.spec.ts`。复用 ResourcePage 的版本差异、引用影响、JSON 编辑器和保存校验。

**Interfaces** `DatasetFields` 按契约呈现 V1/静态 V2。`parseDatasetImport(format: "CSV" | "JSON", text: string, dataset: DatasetV2): {rows: DataRowV2[]; issues: DatasetImportIssue[]}`，`issues` 附行号、字段和错误码，只有无错误的预检结果可应用到当前草稿。CSV 首行字段名，`key` 必有，树另包含 `parentKey`、`order`。文本按字段类型转换，字符串空值保留，空白的可选非字符串字段省略，显式 `null` 使用 JSON 导入。

- [ ] 写 `imports table and tree drafts with validation preview`，断言 CSV 中含逗号、换行、转义双引号的值正确；对孤儿、重复 key 和错误列给出行级诊断，保存前原草稿仍可读取。确认 Web 和桌面同用组件。
- [ ] 运行 `pnpm --filter @veriq/web exec playwright test tests/case-publish.spec.ts -g 'imports table and tree'`，确认新入口不存在而失败。
- [ ] 实现字段编辑、表格行、树父节点/排序编辑、导入预检与应用。保持服务端最终校验和 2 MiB 预算。沿用已有解析依赖或标准能力，新增依赖须先完成项目要求的 ADR。
- [ ] 重跑上述测试与 `pnpm --filter @veriq/desktop check`，确认桌面共享组件类型通过。
- [ ] 提交管理表单切片。

### 4. 命名数据集与断言

**Files** `packages/contracts/{schemas/platform-v1.schema.json,src/compiled.ts}`、`apps/srv/src/veriq_server/services/{resource.py,runs.py}`、`packages/compiler/src/{validate.ts,compile.ts}`、`packages/runner-sdk/src/{context.ts,assertions/http.ts}`、新增 `packages/runner-sdk/src/datasets.ts`、`apps/web/src/features/cases/CaseEditor.tsx`、`apps/web/src/features/assertions/AssertionEditor.tsx`、`packages/compiler/tests/semantics.test.ts`、`packages/runner-sdk/tests/assertions.test.ts`。

**Interfaces** CASE 可附 `datasetBindings: Record<string, Id>`。断言可附 `datasetExpected: DatasetQuery`，与字面 `expected` 二选一。查询为 `{alias, op, ...}` 五个分支：`field(key, field)`、`contains(key)`、`filter(field, equals, select)`、`path(key)`、`children(parentKey)`。键和等值参数用现有显式 `BindingJsonValue` 解析。`DatasetResolver.read(query: DatasetQuery, parameters: JsonObject, signal: AbortSignal): Promise<JsonValue>` 返回类型化惰性值。查询错误转 `ERROR`，`contains` 的无匹配转 `false`。仅引用明确选择的发布版本。

- [ ] 写编译用例 `locks named dataset versions for each CASE binding`，跨空间、未知别名、动态源用作矩阵及不存在字段均失败；合法用例同时保有原 `data` 绑定。写 SDK 用例 `distinguishes empty membership, missing field, and null`，另外断言 `path` 返回根到目标的 key 序列、子项顺序稳定。
- [ ] 运行 `pnpm --filter @veriq/compiler test` 与 `pnpm --filter @veriq/runner-sdk exec vitest run tests/assertions.test.ts`，确认测试在新接口缺失处失败。
- [ ] 实现 DSL AST、版本闭包、编译类型检查、SDK 查询及断言编辑器。模板通过调用的 CASE 绑定解析，无绑定时在 CASE 编译期给出诊断。服务端从声明字段提取依赖，值中的 UUID 继续作为字面数据。
- [ ] 重跑两组包测试、契约生成/检查，运行真实 MySQL 的 `apps/srv/tests/execution/test_runs_mysql.py` 核对旧套件场景。
- [ ] 提交断言与查询切片。

### 5. 新版联网产物与静态数据传输

**Files** `apps/srv/src/veriq_server/services/{resource.py,runs.py,resource_source.py,completion.py,lease.py}`、新增 `apps/srv/src/veriq_server/handlers/dataset_runtime.py`、`apps/srv/src/veriq_server/app.py`、`packages/compiler/src/compile.ts`、`packages/contracts/{schemas/platform-v1.schema.json,openapi/platform.yaml}`、`apps/runtime/src/execution/{supervisor.ts,compile-entry.mjs,broker.ts,provider.mjs}`、`apps/runtime/tests/{supervisor.test.ts,pipe-framing.test.ts}`、`apps/srv/tests/execution/test_resource_source_mysql.py`。

**Interfaces** 在现有快照基础上建立带独立版本号的 `ConnectedSourceSnapshotV2`、`ConnectedExecutionSnapshotV2`。每个静态数据版本描述记录 `{resourceId, versionId, schema, contentSha256}`，选中行另记 `{versionId, rowKey, rowSha256}`。`POST /internal/v1/attempts/{attemptId}/datasets/static` 请求采用三个分支，`{selection: "DATASET", versionId}`、`{selection: "ROW", versionId, rowKey}` 和 `{selection: "VALIDATION_SOURCE"}`。最后一个分支只接受 `VALIDATE`，返回当前任务冻结的候选验证源，候选 ID 不得用作发布版本。验证私有任务授权后返回规范字节，数据绑定到声明快照。控制面可保存原始静态文档。Runtime 通过 AttemptBroker 在进程间以内存传递，单帧维持现有 64 KiB 边界，响应使用至多 32 KiB 原始字节分块，再完整验哈希和解码。

- [ ] 写 `test_static_fetch_is_scoped_to_attempt_fence_and_version`，用错误 workspace、未声明 versionId 和旧 fence 分别拒绝；同一已声明版本在草稿更新后仍返回冻结字节。写 `connected snapshot never writes dataset marker`，扫描有权目录并验证夹具包含超过 64 KiB 和跨帧 Unicode。
- [ ] 运行 `uv --project apps/srv run pytest apps/srv/tests/execution/test_resource_source_mysql.py -q` 与 `pnpm --filter @veriq/runtime exec node --import tsx --test tests/supervisor.test.ts tests/pipe-framing.test.ts`，确认现有产物出现夹具标记且授权新接口尚无。
- [ ] 实现 V2 投影、快照摘要与工作进程的授权正文传递。`VALIDATE` 通过 broker 将正文字节临时传给编译 Worker，磁盘输出只有数据描述。`TEST` 先验证 V2 格式及版本，不对不兼容客户端分配含数据的新任务。旧包的完整冻结源留服务端，使用已批准引擎重验证同样的发布版本，生成独立 V2 产物，旧回执和版本 ID 保持原样。离线命令不由这个传输接口授权。
- [ ] 重跑聚焦用例并测试字节/摘要不一致、分块超限、租约撤销及旧包迁移失败时在首个正文磁盘写入前终止。
- [ ] 提交联网协议切片。

### 6. 数据生命周期、证据与 MVP 入口调整

**Files** `apps/runtime/src/execution/{supervisor.ts,provider.mjs,worker.mjs,storage.ts}`、`packages/runner-sdk/src/{register-case.ts,evidence.ts,assertions/http.ts}`、`apps/srv/src/veriq_server/services/completion.py`、`apps/web/src/{layout.tsx,main.tsx}`、`apps/desktop/src/renderer/App.tsx`、`apps/runtime/src/cli.ts`、`apps/srv/src/veriq_server/app.py`、`docs/specs/{desktop.md,veriq-1.0.md}`、`docs/contracts.md` 与 `README.md`。保留既有历史记录和历史协议测试，发行入口以联网工作流为准。

**Interfaces** 可信执行上下文的证据策略标记 `datasetProtected: boolean`；按冻结依赖计算。断言事件保留结果、出现位置、错误码和来源版本，可展示仅包含脱敏值的结构化差异。数据进入浏览器或上游回显时，禁用无法在写文件前清除原文的采集。恢复清理只移除可证明归属且已证明进程停止的旧数据文件与副本，写入不含正文的清理状态。

- [ ] 写 `dataset value is absent from reports and files after pass, failure, cancellation and crash`，将外部可见值作为浏览器回显，扫描本地工作区、报告、日志与 SQLite 内容；校验出处和状态仍可见。写 `mvp exposes connected runtime only`，验证 Web/桌面/CLI 与服务端生产 API 对离线模式均不可用。
- [ ] 在真实 Runtime/浏览器测试入口运行上述用例，确认旧路径产生缓存或 Trace、旧入口仍可启动。记录操作系统、浏览器和实际启动方式。
- [ ] 实现先脱敏后写入、冻结源选择、停止后清理与恢复。依现有停止证明为 Linux、Windows 和 macOS 各自设门禁。仓库内历史样例和数据表原样保留，生产默认入口移除离线导出、启动和导入路径。发布验收和用户指南改用联网术语。
- [ ] 重跑真实流程。额外验证旧任务目录路径替换、符号链接和未知进程时不扩大删除范围且报告状态。三平台原生验收分别留证。
- [ ] 提交生命周期与 MVP 入口切片。

## 第二批 · HTTP 断言数据闭环

### 7. HTTP 数据源管理、出站与签名

**Files** `packages/contracts/{schemas/platform-v1.schema.json,openapi/platform.yaml}`、`apps/srv/src/veriq_server/{app.py,settings.py,services/resource.py}`、新增 `apps/srv/src/veriq_server/datasets/{request.py,signing.py,mapping.py}`、`apps/web/src/features/resources/{DatasetFields.tsx,adapters.ts}`、新增 `apps/srv/tests/resources/test_http_datasets.py`、`apps/web/tests/case-publish.spec.ts`。

**Interfaces** 扩展 `DatasetV2.source` 的 `HTTP` 分支。字段为 `connectionRef`、`method`、`path`、有序 `query`、`headers`、`body`、`auth`、`parameters`、`mapping`、可选 `pagination`。连接标识从部署侧批准的 `dataset_connections` 解析，登记 Workspace、环境、HTTPS 目标及可用凭证范围。请求和映射只执行明确声明的字段节点。`build_request(config, args, now_utc, key_resolver)` 产出实际发出的请求字节和经批准的路由。HTTP 请求头值必须为字符串。`map_response(mapping, document)` 产出 `DataRowV2[]` 并验证类型与完整性。预览通过有编辑和出站目标访问授权的同一服务执行。复制目标未重绑连接及密钥的配置不可发布。

- [ ] 写 `test_custom_signature_matches_wire_bytes`，使用固定时间戳、重复参数、空值与非 ASCII 预期签名向量，加密或签名调用复用现有密码学库。写 `test_dataset_request_uses_only_approved_connection`，只用测试夹具，覆盖未批准目的地、重定向被拒绝、脱敏预览、分页超限和错误响应映射。
- [ ] 运行 `uv --project apps/srv run pytest apps/srv/tests/resources/test_http_datasets.py -q`，确认新服务行为缺失。
- [ ] 实现请求构造、受限表达式、凭证绑定、白名单出口与有界取数。首批分页支持显式页码及游标，服务器限制循环游标、响应字节、页数和总时间。自动重试只适用于明确幂等且可重试的读取失败。按现有配置和秘密引用方式复用，不在产品代码中新增自制密码学原语。
- [ ] 在 Web/桌面共用表单增加 HTTP 请求编辑、映射和脱敏预览。写 `edits and previews HTTP datasets`，验证重复参数、源配置复制后要求重绑，以及凭证正文不可从 UI 读回。
- [ ] 重跑 pytest、对应 Web Playwright 用例和桌面类型检查，提交 HTTP 配置切片。

### 8. HTTP 在线读取、缓存与断言验收

**Files** `apps/srv/src/veriq_server/handlers/dataset_runtime.py`、`apps/srv/src/veriq_server/services/{runs.py,lease.py}`、`apps/runtime/src/execution/{supervisor.ts,provider.mjs}`、`packages/runner-sdk/src/{datasets.ts,execute-step.ts,assertions/http.ts}`、`apps/srv/tests/execution/test_resource_source_mysql.py`、`packages/runner-sdk/tests/assertions.test.ts`。

**Interfaces** `POST /internal/v1/attempts/{attemptId}/datasets/http`，正文 `{versionId, parameters}`，成功 `{sourceVersionId, fetchedAt, rows}`。服务端根据冻结配置还原请求，并在实际调用前校验当前授权和密钥，返回前复核设备、租约与 fence。Runner 阶段缓存使用 `{attemptId, stepId, phase, versionId, environmentVersionId, canonicalParameters}`，只在本阶段共享该键的完成值或未完成 promise。独立阶段、新 Attempt 和新参数触发新读取。

- [ ] 写 `test_http_dataset_rechecks_access_before_delivery`，撤权后未交付读被拒绝，依赖外版本无出站请求。写 `samples once per assertion phase`，断言同阶段同参发 1 次、不同参数多 1 次、before/after 各自采样、重试新 Attempt 重新读。验证成功的空列表、上游 401、超时、分页不全和比较失败各有独立状态。
- [ ] 运行对应真实 MySQL 流程和 `pnpm --filter @veriq/runner-sdk exec vitest run tests/assertions.test.ts`，确认失败指向代理与阶段缓存能力缺失。
- [ ] 实现服务端代理、可信 Runtime 数据读取、阶段级合并与 AbortSignal 清理。读取失败保持业务错误码，阶段结束释放引用。重复请求合并只在同一进程和同一阶段生效。
- [ ] 重跑聚焦测试。回归旧用例、单源断言、多源断言、含 HTTP 数据集的浏览器回显，以及平台断链触发丢租约后的清理。同步 SDK、OpenAPI 和产品契约文档。
- [ ] 提交实时断言切片并做整体验收，报告已验证平台和仍缺失的实际环境。
