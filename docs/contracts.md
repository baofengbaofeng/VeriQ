# Contracts

<a id="veriq-shared-contracts-v1"></a>

本文冻结 T01 的接口，供后续任务使用，描述的是契约，并不表示服务端端点已经实现或产品已经完成。规范模式位于 [platform-v1.schema.json](../packages/contracts/schemas/platform-v1.schema.json)；较小的 `*-v1.schema.json` 文件只是入口别名。字段必填性、精确联合类型及边界均以这些模式为准，提交的 TypeScript 也由同一来源生成。不得另行维护一套独立的 DSL 校验器。

<a id="developer-commands"></a>
## 开发命令

使用 Python 3.12.14、uv 0.13.5、稳定版 Node24.x（`>=24 <25`）和 pnpm 11.25.0；CI 跟随 `24.x`。在仓库根目录执行：

```sh
uv sync --project apps/srv --frozen --all-groups
pnpm install --frozen-lockfile
uv run --project apps/srv python -m pytest -c apps/srv/pyproject.toml apps/srv/tests/contracts -q
pnpm test
pnpm check
uv run --project apps/srv ruff check --config apps/srv/pyproject.toml apps/srv/src apps/srv/tests
uv run --project apps/srv ruff format --check --config apps/srv/pyproject.toml apps/srv/src apps/srv/tests
uv run --project apps/srv mypy --config-file apps/srv/pyproject.toml apps/srv/src
```

显式配置路径确保从根目录执行 Python 检查时采用服务端的 pytest、Ruff 和严格 mypy 设置；`uv --project` 只选择环境，不改变工具的工作目录。异步夹具默认使用函数级事件循环。

`pnpm contracts:generate` 重新生成并提交传输/API 类型；`pnpm check` 编译契约包并拒绝过期生成物；`pnpm test` 当前执行真实契约测试。后续工作区应用已有依赖清单，不提供假装可用的构建或测试命令。宿主 HOME 只读时，将 `UV_CACHE_DIR` 及 XDG 缓存/数据目录指向任务内可写目录，保持代理与 CA 校验开启。

<a id="public-libraries"></a>
## 公共库

Python 从 `veriq_server.contracts` 导入：

```python
validate_case_schema(value: Any) -> list[ValidationIssue]
validate_schema(schema_name: str, value: Any) -> list[ValidationIssue]
serialize_contract(schema_name: str, value: Any) -> str
parse_contract(schema_name: str, text: str) -> Any
```

TypeScript 从 `@veriq/contracts`（`packages/contracts/src/index.ts`）导入：

```ts
validateCaseSchema(value: unknown): ValidationIssue[];
validateSchema(schemaName: string, value: unknown): ValidationIssue[];
serializeContract(schemaName: string, value: unknown): string;
parseContract(schemaName: string, text: string): unknown;
```

`ValidationIssue` 包含 `path`、`code` 和 `message`。`path` 是 RFC6901 实例指针，空字符串表示根；`code` 为 `SCHEMA_VIOLATION` 或 `INVALID_JSON`。校验成功返回空数组/列表，不修改或强制转换输入、不注入默认值、不删除字段。未知模式名抛出 `ValueError` / `Error`。解析与序列化均执行校验，并在内容无效时抛错。依赖库的诊断消息不是要求跨语言逐字节一致的 API，但共享夹具的接受/拒绝结果必须一致。

序列化输出 JSON 文本，不是签名规范化格式。Bundle 清单签名必须覆盖**原始精确字节**，文件/产物哈希也必须覆盖**原始精确字节**，调用方须保留这些字节。模式校验不会重新计算哈希、验证签名、比较快照标识或认证调用方。确定性源码哈希和编译必须在编译器/发布边界一致实现；运行时值、机器路径和 Run ID 不得进入不可变源码身份。

两个库都拒绝 NaN/Infinity、超出 ±9,007,199,254,740,991 的不安全整数、循环及非 JSON 宿主对象。Python 还拒绝元组和非字符串对象键；JavaScript 拒绝 undefined、BigInt、函数、非普通对象和 Symbol。`JsonValue` 表示可移植的递归 JSON；业务大整数须用字符串。断言结果用显式存在性记录表示缺失值，不能用 JSON null 代替。

`Id` 接受带连字符的 8-4-4-4-12 十六进制 UUID 文本，字母大小写均可；拒绝 URN、花括号、紧凑形式及前后空白。这是词法契约，不限制 UUID 版本或变体。`Timestamp` 采用共享 RFC3339 子集：年份 0001–9999 的真实公历日期、`T`/`t`、00–23 时、00–59 分/秒，可选但非空的小数秒，以及必填的 `Z`/`z` 或数值偏移（小时 00–23，分钟 00–59）。接受 RFC3339 表示未知偏移的 `-00:00`。拒绝闰秒、空格分隔符、零年、缺少偏移及前后空白。服务端输出带大写 `T`/`Z` 的 UTC 时间戳。规范词法约束与完整日历检查共同保证该规则，包括闰年和日期有效性，不能只依赖包的默认行为。

`JsonValue`、`JsonObject` 和 `JsonSchema` 是惰性数据，字符串可包含字面值 `{{customer.name}}`、`{{evil()}}` 或任意文本。实际/预期结果、执行变量、数据集值、错误详情、JSON Schema 内容及 `DiagnosticText` 日志/错误消息必须原样保留这些文本，不得求值或递归插值，且仍受可移植 JSON 约束。`SafeString` 及递归的 `BindingJsonValue`/`BindingJsonObject` 仅适用于显式插值的 DSL 字段：fill/press/selectOption 值、请求正文/query/header 值、流程/模板参数、断言 expected/query 值、观察器 body/query 匹配、定位器角色名和目录记录键。JSON Schema 断言保持字面内容。允许的绑定解析后返回其值，解析结果数据中的花括号不能再次成为表达式。不得提供 eval 回退，也不得隐式插值任意传输数据。

<a id="source-and-generated-exports"></a>
## 源码与生成导出

- `packages/contracts/src/types.generated.ts`：全部命名规范定义，包括 `CaseDslV1`、`AssetSnapshotV1`、`SnapshotV1`、`ExecutionSnapshotV1`、`CompiledAssetBundle`、`ClaimRequest`、`ClaimDTO`、`ExecutionEventV1`、`JobManifestV1`、`BundleManifestV1`、`OfflineResultV1` 及配套 DSL/资源/结果类型。
- `SnapshotV1` 是 `AssetSnapshotV1` 的别名，保留两个名称。
- `JobManifestV1` 以 `kind` 区分分支，导出 `TestJobManifestV1`、`ValidateJobManifestV1` 和 `CleanupJobManifestV1`。
- `packages/contracts/src/api.generated.ts`：OpenAPI 的 `paths`、`components` 和 `operations`。包根导出别名 `PlatformPaths`、`PlatformComponents`；`@veriq/contracts/openapi` 直接导出生成的 API 类型。
- `packages/contracts/openapi/platform.yaml`：OpenAPI 3.1，通过外部引用指向规范 JSON Schema，文件采用 JSON 格式的 YAML。生成文件是产物，须先修改模式/OpenAPI 再重新生成。

<a id="resource-documents-and-dsl"></a>
## 资源文档与 DSL

`ResourceDocumentV1` 为 `{kind, document}`，其 kind/document 使用严格联合：

| kind | 文档类型 | 除 schemaVersion 外的必填字段 |
| --- | --- | --- |
| CASE | CaseDslV1 | caseKey、title、kind READ/WRITE、roleKey、catalogVersionId、steps |
| ELEMENT_CATALOG | ElementCatalogV1 | elements：key/locator 记录 |
| ASSERTION_TEMPLATE | AssertionTemplateV1 | assertions；可选参数类型映射 |
| DATASET | DatasetV1 / DatasetV2 | V1 使用 columns 和 rows；V2 使用 shape、fields 和 source |
| FLOW | FlowV1 | steps；可选参数类型映射 |
| FIXTURE | FixtureV1 | prepare/query/cleanup 端点、inputSchema、outputSchema、ttlSeconds |
| SUITE | SuiteV1 | 锁定 versionId 的 cases；可选 datasetVersionId/roleKeys/browsers |
| ENVIRONMENT | EnvironmentV1 | baseURL、apiBaseURL、allowedOrigins、locale、timezone、roles |

所有固定文档字段都须声明，拒绝未知字段。有意开放的字典仅限已命名映射或 JSON 业务数据。`FixtureV1.query.method` 为 GET。`EnvironmentV1` 可选 fixtureBaseURL/buildSha；每个角色包含 roleKey、authAdapterVersionId、secretRef、secretVersionId，可选 allowedIdentityIds。环境快照和 Bundle 只包含凭据引用，不包含密码、设备 token、Cookie 或 storageState。

`DatasetV1` 保留 `schemaVersion: "1.0"` 及原有必填列和非空行规则。`DatasetV2` 使用 `schemaVersion: "2.0"`，静态来源为 `{kind: "STATIC", rows}`，字段声明由 `fields` 映射保存。字段类型为 `string`、`number`、`integer`、`boolean`、`object` 或 `array`，`required` 控制是否可省略，`nullable` 控制是否接受显式 `null`。TABLE 行包含 `key` 和 `values`。TREE 行另含 `parentKey`（根节点为 `null`）和数值 `order`。

草稿沿用资源正文及依赖闭包预算。可信编译验证行键、声明字段的存在和值类型，以及树的孤立节点、循环和深度，根节点计为第 1 层，最多 100 层。独立参考数据集允许空行数组，CASE 或 SUITE 矩阵要求至少一行，并按冻结行数组顺序投影 `{key, values}` 到既有执行快照。V2 矩阵要求联网执行。冻结闭包包含 V2 数据集时拒绝离线导出、安装或结果导入，含被套件覆盖的默认引用。

`GET /api/v1/workspaces/{workspaceId}/resources/dataset-copies` 按 `sourceWorkspaceId` 查询来源中已发布的数据集版本。每项返回 `resourceId`、`key`、`name`、`versionId` 和 `versionNo`。沿用资源列表的分页预算，游标绑定当前用户、目标及来源。

同路径 `POST` 接受以下请求。两个操作均校验目标可编辑及源可下载。成功时返回 201 和目标资源 DTO；初始草稿修订为 1。目标空间内同类型键冲突返回 409。目标草稿与复制审计在同一事务提交，审计保留来源版本标识供内部追溯。

```json
{
    "sourceWorkspaceId": "11111111-1111-4111-8111-111111111111",
    "sourceDatasetVersionId": "22222222-2222-4222-8222-222222222222",
    "key": "checkout_cases",
    "name": "结账数据"
}
```


`CaseDslV1` 可选锁定 fixtureVersionId、datasetVersionId 和 persistenceCheckpointStepId。版本引用是 UUID，不得查询可变 `latest`。WRITE 检查点/关键断言、依赖归属、变量存在性/类型、夹具模式、流程展开/环/深度及数据列一致性等语义由编译器/服务负责。

每个步骤都有 id 和受支持的 action。共享可选字段为 critical、beforeAssertions、observers、afterAssertions、extract、timeoutMs、failurePolicy（`STOP_CASE` / `CONTINUE`）。各动作的必填字段如下：

| action | 动作必填字段 |
| --- | --- |
| goto | path |
| click/check/uncheck | target |
| fill/press/selectOption/upload | target、value |
| reload | 无 |
| apiRequest | method、path；可选 query/body/headers |
| callFlow | versionId；可选 parameters |

fill/press 值为字符串；selectOption 接受字符串或非空字符串数组；upload 接受非空、安全的 Bundle 相对文件路径。路径相对于来源，拒绝可执行 URL 协议。模板只允许 `{{data.identifier}}` 和 `{{vars.identifier}}` 点式数据访问，不允许 eval、JSONPath 或可执行表达式。完整占位符的类型保留和替换由编译器/SDK 定义。

字面 `Path` 必须恰好以一个 `/` 开头，拒绝所有反斜杠及 C0/DEL 控制字符（含 TAB、CR、LF、NUL）。规则适用于导航/API 路径、观察器和最终一致查询。替换后，编译器/SDK 必须重复检查，按照 WHATWG URL 语义相对冻结的对应 `baseURL`/`apiBaseURL`/`fixtureBaseURL` 解析一次，并在任何请求或导航前要求规范化来源等于该基地址的授权来源且符合 Environment 允许列表。不得通过 trim 或删除控制字符使拒绝路径变为有效。额外解码后及每次重定向均须重查策略；重定向凭据遵循授权来源策略。模式接受不代表完成这些运行时检查。

断言包含 id/type/severity/expectedSource，通常还包含 operator/expected，可选 timeoutMs。UI 状态操作符要求布尔值；UI 文本/值操作符要求字符串；countEquals 要求整数；httpStatus/equals 要求 100–599 的整数。请求 methodEquals 要求允许的 HTTP 方法；pathEquals 要求相对路径。请求/响应字段 equals/notEquals 接受 JSON，`in` 要求数组，`contains` 要求字符串或数组，`exists` 要求布尔值。JSON Pointer 采用 RFC6901，包括正确的 `~0`/`~1` 转义。Schema 断言携带 JSON Schema 数据；eventually 断言采用只读 GET 查询；duration/requestCount 及锁定断言模板分支均由模式定义。severity 为 BLOCK/CONTINUE_FAIL/WARN。未知 type/operator 组合校验失败。

观察器声明 id/method/精确 path，可选 queryMatch/bodyMatch、timeout、重试策略与观察窗口。SDK 默认值：超时 15 秒；UNTIL_ACTION_SETTLED 窗口静默时间 500 ms；retryPolicy 为 FORBID。FIXED 窗口必须有 durationMs。`expectedCount` 仅允许配合显式 FIXED 窗口，不表示覆盖窗口外事件。匹配/歧义、动作前监听注册、释放和重试解释由 SDK 负责。断言默认 UI 超时 5 秒；eventually 总计 10 秒、轮询间隔 500 ms，服从显式且经过校验的 timeout/interval 字段。不得以固定 sleep 或强制点击兜底。

提取记录 source（`request:<observerId>` 或 `response:<observerId>`）、pointer、目标 `to`、valueType 和 required。断言使用对应 source 形式；UI 使用 target，URL 使用 source `page`。

<a id="immutable-snapshots-and-compiled-assets"></a>
## 不可变快照与编译产物

| 类型 | 必填字段 |
| --- | --- |
| AssetVersionV1 | resourceId、versionId、kind、sha256、document；kind/document 严格联合 |
| AssetSnapshotV1 | schemaVersion、workspaceId、sourceHash、engineVersion、entryCaseVersionIds、assets |
| CompiledAssetBundle | schemaVersion、sourceHash、engineVersion、compilerVersion、runnerSdkVersion、entrypoints、files、dependencies |
| ExecutionSnapshotV1 | schemaVersion、workspaceId、runId、caseExecutionId、caseVersionId、assetSourceHash、environmentVersionId、environment、roleKey、browser、variables、secretVersions、namespace、attemptNo；可选 dataRow |

`FileEntry` 为 `{path, sha256, sizeBytes}`，路径排除绝对路径、目录穿越和反斜杠。导入器还必须拒绝链接、规范化冲突、超大归档和哈希不一致。依赖为 `{name, version, integrity}`，使用精确语义版本。生成 TS 是由文件清单标识的不可变产物，DSL 仍为可编辑源码。`secretVersions` 为 `{secretRef, versionId}` 引用。attemptNo 只能为 1 或 2，表示最多一次整用例重试。

T05 实现 `compileAssets(snapshot, distribution) -> CompiledAssetBundle` 和返回真实字节的 `compileFiles`；`assembleExecution(bundle, executionSnapshot, files)` 附加执行上下文，不修改已验证源码。所需引擎发行及冷下载文件上下文见后文 T05 交接。发布/VALIDATE 回执必须绑定源码哈希、修订与引擎版本。Runtime 必须下载经授权、按内容寻址的产物，消费前校验哈希。

<a id="claim-leases-and-job-manifests"></a>
## 领取、租约与作业清单

`ClaimRequest` 为 `{runnerId, clientRequestId, availableSlots, capabilities}`。能力包含精确 engineVersion、os（`linux`/`win32`）、arch `x64`、browsers，可选 jobKinds。服务端登记容量及授权始终具有权威性。领取恢复重用 clientRequestId，而不是再次发起业务执行。

无合格作业时领取返回 HTTP 204。成功的 `ClaimDTO` 包含 jobId、jobKind、attemptId、leaseToken、fencingToken、expiresAt、serverTime、leaseDurationMs、activationRequired（true）、snapshotUrl、snapshotSha256。最后两项标识下载的作业清单精确字节。Token 是仅用于传输的秘密，不得写入快照、事件或离线包。

规范 DeviceToken 下载为 GET `/internal/v1/workspaces/{workspaceId}/attempts/{attemptId}/content/{sha256}`（`downloadAttemptContent`）。`claim.snapshotUrl` 是登记的控制服务来源加上该路由，绑定获派 Attempt 及 `claim.snapshotSha256`，标识的是**作业清单**，不是其主体。发送凭据前须核对登记来源、已领取 attemptId 及规范路由，拒绝下载重定向。验证清单字节/哈希后，其 workspaceId 必须与路由 Workspace 一致，jobId/kind 必须与领取记录一致。已移除无关联的 UUID 快照下载路由。

每次下载都需要 DeviceToken，以及当前 `X-VeriQ-Lease-Token` / `X-VeriQ-Fencing-Token` **请求头**。须授权当前设备/信任/授权、Workspace、获派 Attempt、未过期租约与 fencing，再要求哈希属于该 Attempt 冻结的不可变闭包。知道哈希不构成访问授权。未知或闭包外内容返回 404，无效/已撤销设备 token 返回 401，未授权绑定/请求者返回 403，过期或陈旧租约证明返回 409。日志必须脱敏证明请求头，不能写入 URL、清单或普通事件。缓存字节同样需要授权。

返回原始 `application/octet-stream` 字节，不加封装、不转换、不重新序列化 JSON。解析/执行前对收到的精确字节验证 SHA-256。全部引用使用同一 Workspace/Attempt 路由与证明请求头：

| 引用 | 精确下载内容 |
| --- | --- |
| `claim.snapshotSha256` | JobManifestV1 字节 |
| 清单 `snapshotSha256` | VALIDATE 的冻结 AssetSnapshotV1；TEST/CLEANUP 的 ExecutionSnapshotV1/保留清理上下文 |
| TEST `executionSnapshotSha256` | 同一 ExecutionSnapshotV1 主体，等于清单 snapshotSha256 |
| TEST `compiledBundleSha256` | CompiledAssetBundle 描述符字节 |
| 编译 `files[].sha256` | 文件字节；还须验证 sizeBytes，再在本机使用经过校验的 Bundle 相对路径 |

因此 Claim → 清单 → 主体/Bundle → 文件不需要 UUID 查询、猜测存储路径或浏览器凭据。T09 实现该精确字节 Artifact 管道与当前派单授权；T12 扩展存储、报告及原始证据访问策略。

`JobManifestV1` 公共字段为 schemaVersion、workspaceId、jobId、snapshotSha256、engineVersion。其中 snapshotSha256 标识冻结主体快照，与外层领取的清单哈希不同。各 kind 的字段如下：

| kind | 额外必填字段 | 冻结主体 |
| --- | --- | --- |
| TEST | caseExecutionId、caseVersionId、compiledBundleSha256、executionSnapshotSha256 | ExecutionSnapshotV1；snapshotSha256 必须等于 executionSnapshotSha256 |
| VALIDATE | resourceId、revision、sourceHash | 不可变草稿验证闭包的 AssetSnapshotV1 |
| CLEANUP | maintenanceId、fixtureVersionId、namespace、cleanupRef | 维护记录保留的原始执行快照/清理上下文；cleanupRef 是不透明的授权引用，不是秘密或任意本机路径 |

Workspace/主体/哈希一致性及不可变清理来源由服务端/Runtime 作语义检查。TEST、VALIDATE、CLEANUP 共用领取/租约/终态协议，只有需要浏览器的作业占用浏览器容量，不另建重复队列或内部 Cron。

`HeartbeatRequest` 携带 leaseToken/fencingToken 及进度 `{phase, optional stepId/completedSteps}`；`HeartbeatDTO` 返回 leaseExpiresAt/cancelRequested/serverTime/leaseDurationMs。`EventBatchRequest` 携带租约凭据和事件；响应 `EventBatchDTO.acceptedThrough` 表示连续接受的序号。`FinishRequest` 携带租约凭据、kind、outcome、manifestSha256、lastSequence、cleanupStatus；`FinishDTO` 返回 attemptId、accepted true、outcome、manifestSha256。Attempt 结果不含 UNSTABLE，该值只属于重试历史聚合。T09 按后文要求强制执行租约过期、陈旧 fencing、精确完成重放及隔离对账。

<a id="execution-events-and-results"></a>
## 执行事件与结果

`ExecutionEventV1` 为严格联合，公共字段为 schemaVersion、attemptId、sequence（正安全整数）、type、timestamp（RFC3339）、可选 stepId/assertionId，以及有类型的 payload。步骤事件必须有 stepId；断言结果还必须有 assertionId。

| type | Payload 结构 |
| --- | --- |
| ATTEMPT_STARTED | engineVersion、sourceHash |
| PHASE_CHANGED | phase |
| STEP_STARTED | 空对象 |
| STEP_FINISHED | status、durationMs；可选 errorCode/message |
| ASSERTION_RESULT | status、severity、expectedSource、expected、actual、durationMs；可选 errorCode |
| OBSERVER_RESULT | observerId、matchedCount、windowMode、durationMs、ambiguous、关联请求 |
| VARIABLE_EXTRACTED | name、valueType |
| LOG | level、message |
| CLEANUP_RESULT | cleanupStatus；可选 errorCode |
| ARTIFACT_CREATED | artifactId、file、kind |
| ATTEMPT_FINISHED | outcome、cleanupStatus |

MISSING 的 `actual` 为 `{present:false}`；存在的值使用 `{present:true,value:<JSON>}`，包括 null。下游报告必须保留原始业务、清理与证据结果；退出码不足以证明完整成功。序号连续性、重复处理、必需证据和结果归约仍由服务端/报告负责。

<a id="offline-contracts"></a>
## 离线契约

`BundleManifestV1` 必须包含 schemaVersion、bundleId、workspaceId、issuerId、keyId、createdAt、expiresAt、sourceHash、snapshotSha256、engineVersion、validationStatus（`VALIDATED` / `UNVALIDATED_DEBUG`）和 files。签名与精确清单字节分离。信任根通过经认证登记或管理员验证过的带外流程建立，绝不能由不可信 Bundle 自行建立。

`OfflineResultV1` 必须包含 schemaVersion、workspaceId、bundleId、localRunId、deviceId、精确为 `OFFLINE_IMPORT` 的 source、trustStatus、dirty、revocationStatus、manifestSha256、startedAt、finishedAt、聚合 outcome、actualEnvironment 和 attempts。每个 Attempt 含 attemptId、caseVersionId、attemptNo、Attempt outcome、cleanupStatus、lastSequence、有类型事件及产物清单。导入的信任声明是不可信输入：服务端从当前记录推导权威设备信任，必须同时保留提交的来源声明及其验证结果。签名认证包的来源/完整性，不证明本机执行报告真实。

导入以 `(workspaceId, bundleId, localRunId)` 幂等，创建独立 Run，绝不覆盖在线 Attempt。当前成员身份、资源闭包、授权覆盖项、签名、文件哈希、模式/引擎兼容及限额都属于结构校验之外必须执行的服务检查。

<a id="http-contract"></a>
## HTTP 契约

OpenAPI 覆盖认证/会话/重置/邀请，Workspace/成员，资源草稿/验证/发布/版本/依赖者，Runtime 登记/授权/信任/撤销，执行计划/触发、作业/Run/取消/重跑/事件/报告/产物，Bundle/导入，AI Provider/生成/评审，秘密引用，服务账户，外部维护，以及内部领取/心跳/事件/上传/完成/对账/凭据解析。

成功 JSON 响应为 `{data, requestId}`；错误为 `{code, message, details, requestId}`，details 是 JSON 数据。稳定机器错误码与翻译后的用户消息分离。分页数据为 `{items, nextCursor}`，cursor 为不透明值或 null。草稿更新必须带 revision，冲突返回 409。触发、导入和维护操作必须带 Idempotency-Key，同键不同参数发生冲突。外部前缀为 `/api/v1`，设备前缀为 `/internal/v1`。
成功与错误响应的 `X-Request-Id` 头均与 JSON 信封中的 `requestId` 相同。

POST 资源 `/validate` 返回 JobDTO。轮询完成后，GET `/api/v1/workspaces/{workspaceId}/jobs/{jobId}/validation-receipt`（`getValidationReceipt`）向获授权的 Workspace 浏览器/服务调用方提供 `ValidationReceiptDTOEnvelope`。成功 VALIDATE 作业返回服务端创建的回执；待处理、失败、取消或非 VALIDATE 作业返回 409 `VALIDATION_RECEIPT_UNAVAILABLE`，不存在或不可访问的作业返回 404。回执绑定 id、workspaceId、jobId、resourceId、revision、sourceHash、engineVersion、compiledBundleSha256、validatedAt。以 `PublishRequest.validationReceiptId` 提交回执 id，并携带匹配 revision。发布必须重新授权调用方/资源，将所有绑定与当前草稿/引擎比较；已知但陈旧或外域的回执 ID 不能授权发布。

Web 会话使用 Cookie 加 CSRF；服务 token 与设备 token 属于独立权限范围。每个嵌套 Workspace/version/runtime/attempt/artifact/import 引用均需服务端授权，包括 SSE 重放和下载。OpenAPI 声明不能代替授权执行。内部凭据解析须具备当前租约/fencing、获批信任/授权及冻结 secretVersionId；返回值不得写入普通事件、命令行或 Bundle 文件。

<a id="t03-implemented-workspace-boundary"></a>
## T03 已实现的 Workspace 边界

`auth.authorization` 导出冻结的 `WorkspaceScope(workspace_id)`、`Actor(user_id, workspace_id, role, active=True)`、`Permission` 和 `Authorization.require(actor, scope, permission)`。`Authorization.require_reference(scope, referenced_workspace_id)` 以 422 `INVALID_REFERENCE` 拒绝跨 Workspace 嵌套引用。Actor 必须来自当前经认证身份及数据库成员关系；请求正文角色和系统管理员能力都不是成员证明。`services.workspace.WorkspaceRepository(session, scope)` 的 `get`、`member`、`invite`、`authorize`、`protect_owner` 必须具备显式 scope。Workspace 发现另行筛选当前用户 ACTIVE 成员关系。后续资源、批次、SSE、下载、证据和导入须使用这些检查及实际的受范围约束仓储；T03 不实现那些端点。

五种有效角色均可 VIEW。EDIT 允许 OWNER/ADMIN/EDITOR；EXECUTE、DOWNLOAD 另允许 EXECUTOR；PUBLISH、MANAGE_ENVIRONMENT、MANAGE_MEMBERS、MANAGE_WORKSPACE 允许 OWNER/ADMIN。OWNERSHIP 仅允许 OWNER，包括授予、移除或修改另一 OWNER 以及归档。Workspace 角色绝不授予 PRIVATE_DISPATCH，后续设备服务须检查设备所有权或显式授权。ADMIN 可管理非所有者角色，不能授予 OWNER。只有现有、已启用的 ACTIVE 成员可提升为 OWNER。非活动成员和全局禁用用户不计入已启用 OWNER 不变量。

全部 Workspace/成员/邀请变更及既有全局用户禁用操作，都在**身份与范围读取之前**取得既有安装级单例锁，并持有至提交。这使所有权变更与禁用、建号、接受邀请串行化，这些服务不再需要第二把显式行锁。后续显式锁必须按 Workspace ID，再按用户/成员/邀请 ID 顺序取得，不能反向。此设计有意用简单共享不变量换取账户/Workspace 写入并发性。未归档 Workspace 至少保留一个已启用的 ACTIVE OWNER；冲突移除、降权或禁用返回 409 `LAST_OWNER`。本 API 的归档是 OWNER 单向操作：保留成员关系与 key，允许只读详情/成员，拒绝后续范围内写入和接受待处理邀请。已归档 Workspace 不受存续 OWNER 不变量约束。

已实现的 Web 会话路由为 GET/POST `/api/v1/workspaces`、GET/PATCH/DELETE `/api/v1/workspaces/{workspaceId}`、GET `.../members`、PUT/DELETE `.../members/{userId}`、GET/POST `.../invitations`、DELETE `.../invitations/{invitationId}`、POST `/api/v1/auth/invitations/accept`。Workspace DELETE 执行归档并返回 EmptyEnvelope。列表复用签名 keyset Page 工具，默认 25、最大 100、查询 limit+1；24 小时游标绑定调用方、列表、Workspace、过滤条件，按 key/ID 或 email/ID 稳定排序。Workspace 列表可选 `archived` 过滤，默认包含存续及归档成员关系。邀请列表提供状态、邮箱、角色、到期时间，不暴露可复用 token URL。

邀请采用随机 token，仅存 SHA-256 摘要，七天过期，可接受一次或撤销。创建返回 fragment token 形式的可复制 `invitationUrl`；可选 `sendEmail` 调用既有 SMTP 配置适配器，返回 NOT_REQUESTED/SENT/FAILED 投递状态。投递失败仍保留可复制可用链接。现有账户接受邀请必须使用与邀请匹配的已认证身份，且请求只能携带 token，不能替换密码、更改全局权限或重置会话。新账户接受还需 password/displayName，创建普通用户，不自动登录，也不替换邀请者会话。拒绝禁用账户、身份不匹配、重放、过期/撤销邀请及已有成员关系。邀请入口从浏览器历史清除 token，仅保留于组件内存；现有用户可在页面内登录，不把 token 放入登录 URL。

Alembic `0002_workspaces` 新增 `veriq_workspaces`、`veriq_workspace_members`、`veriq_workspace_invites`，在既有 `veriq_audit_logs` 上新增允许空值且带索引的 Workspace 外键；全局账户事件仍为 null 范围。`service.audit` 新增仅关键字传入的可选 `workspace_id`，兼容原调用。Workspace 变更在事务内记录范围，不重复创建账户/审计表，也不提供启动时建表回退。

实际 React `/workspaces` 页面支持选择、创建、重命名、归档，成员角色/状态/移除，以及邀请创建/复制/撤销，提供有界加载更多列表和加载、错误、空、权限状态。React Query key 包含身份和 Workspace。路由生命周期内的 WorkspaceProvider 以认证身份为 key；切换会中止范围查询/变更、删除范围缓存并释放已登记订阅。离开路由或身份变化会取消并清除其客户端与订阅，选择仅保留在该路由生命周期的内存中。当前尚无 Workspace 事件订阅；下游订阅须向 `useWorkspace().subscribe` 登记释放器，并使用范围生命周期信号。权限变化后仍以服务端授权为准。

规范外部维护触发为 POST `/internal/v1/maintenance/expired-leases/reap`、`/internal/v1/maintenance/fixture-cleanups/reconcile`、`/internal/v1/maintenance/artifacts/expire`、`/internal/v1/maintenance/capacity/reconcile`、`/internal/v1/maintenance/lifecycle/expire`。它们使用受范围约束的 ServiceToken 认证、必填 Idempotency-Key 和有界请求 limit。`MaintenanceDTO` 返回 id/status/processedCount/**hasMore**，供外部调度继续处理有界批次；这些路由不增加内部 Cron 服务。

<a id="packaging-and-handoff-verification"></a>
## 打包与交接验证

Python 通过包资源加载 `veriq_server/_schemas`。Hatch 将规范目录映射进 wheel；editable 开发可读取检出源码。T01 隔离 wheel 测试在仓库外、无 Node 环境验证每个共享夹具。T02/T18 在强制生产静态资源、迁移及版本/许可证产物时，必须保留此映射；仅包含契约的冒烟 wheel 不是产品发行。

共享夹具位于 `packages/contracts/fixtures/compatibility.json`。Python 和 Node 使用真实校验器比较同名接受结果；测试还覆盖宿主语言非 JSON 值、生成的公共名称、OpenAPI 解析、严格 DTO、封装及 revision 要求。应用、数据库、浏览器、Windows、桌面、安全授权和发行验收仍由相应模块负责。

<a id="t02-account-implementation"></a>
## T02 账户实现

实际服务端现已实现 `/api/v1/setup`、既有认证/会话/重置路由、含口令/会话控制的 `/api/v1/account`，以及支持创建/列表/修改、会话撤销、授权签发重置链接的 `/api/v1/admin/users`。可选真实 SMTP 重置投递使用经验证 TLS 和可复用投递协议，测试中未发送外部邮件。OpenAPI 已扩展严格 setup/admin/account DTO，`UserDTO`、`SessionDTO` 保留原字段。`AdminUserDTO` 将全局 `systemAdmin` 能力与未来 Workspace 角色分开。所有已实现成功/错误正文保留规范封装。Tornado 掩码 CSRF 机制接受规范 `X-CSRF-Token` 请求头。

Python 启动导出 `Settings`、`load_settings`、`Database`、`make_app(settings, db)`；下游认证处理器可继承 `handlers.base.API`，调用 `await self.identity(session)` 或 `await self.identity(session, admin=True)`。会话认证检查 token 摘要、UTC 过期时间及当前禁用状态；`identity` 返回 `(User, UserSession)`。数据库操作使用 `async with db.sessions.begin() as session`，不得在处理器中建表。安全的 `veriq_server init/migrate/create-admin/doctor/serve`、独立 Vite 启动和真实 MySQL/浏览器测试见[开发说明](development.md)。

<a id="t04-resource-validation-and-publication-implementation"></a>
## T04 资源、验证与发布实现

OpenAPI 资源路由现已按当前会话/成员关系授权实现：创建/列表/获取/更新元数据，获取/更新草稿，验证预览，入队验证，发布，版本列表/获取，直接已发布依赖者，作业轮询与回执读取。服务 token 认证仍待后续集成；这些实现接受 Web 会话和 CSRF。资源 kind/key 不可变，归档保留 key，版本读取始终同时绑定 Workspace 与资源。依赖者包括任何直接引用所选资源任一版本的已发布版本，含历史/已归档依赖者；草稿不构成已发布影响边。列表有界，使用签名游标稳定排序。

Python 边界：

```python
ResourceService(session, user, registry=None)
await service.update_draft(scope, resource_id, expected_revision, document)  # DraftDTO
await service.preview(scope, resource_id)  # ValidationPreviewDTO
await service.validate(scope, resource_id, revision, source_hash)  # JobDTO, QUEUED
PublishService(session, user, registry=None)
await service.publish(scope, resource_id, draft_revision, receipt_id)  # ResourceVersionDTO
ResourceRepository(session, scope)  # resource/draft/version/job/receipt/artifact/store
```

变更调用方必须像处理器一样，在身份/范围读取**之前**取得 `lock_installation(session)`，并保持事务直到提交。服务自身授权当前成员关系；仓储只是为获授权服务提供带范围的持久化帮助。`store` 按内容寻址，复用摘要前检查保留字节。没有公共写 API 可更新版本或创建回执。`0003_resources` 扩展既有迁移链，新增资源/草稿/版本/依赖边/产物/共享作业/回执，保留现有账户与 Workspace 数据。

`DraftDTO.documentHash` 是 RFC8785 `{kind,document}` 字节的 SHA-256。Web 编辑器通过 `GET /api/v1/workspaces/{workspaceId}/resources/{resourceId}/validation-preview` 获取独立闭包哈希，响应含 `resourceId`、`revision`、`candidateVersionId`、`documentHash`、`sourceHash`、`engineVersion`。向 `/validate` 提交 `{revision,sourceHash}`。服务端重新计算闭包，以 409 拒绝 `STALE_REVISION`/`STALE_SOURCE_HASH`。同一资源/revision/source 重试返回同一排队或已完成作业。作业轮询为 `/api/v1/workspaces/{workspaceId}/jobs/{jobId}`；成功回执追加 `/validation-receipt`，回执存在前返回 409；发布提交 `{revision,validationReceiptId}`。HTTP 结构无效返回 400，kind 不匹配/未知类型引用返回 422，回执不匹配返回 409。不存在客户端铸造回执端点。

Python `canonical_bytes(value)` 和 TypeScript `canonicalBytes(value)` 返回 RFC8785 字节。Python `asset_source_hash(snapshot)` 返回 SHA-256 十六进制；TypeScript `assetSourceBytes(snapshot)` 返回相同精确身份投影字节，供 Node crypto 或浏览器 WebCrypto 使用。后者兼容浏览器，不导入 Node crypto。身份恰好是冻结的 `{schemaVersion,workspaceId,engineVersion,entryCaseVersionIds,assets}` 对象，assets 和入口 ID 按 UUID 排序输出。声明的 `sourceHash` 与 `validationTarget` 不参与哈希。每个 asset 的 `sha256` 覆盖其 `{kind,document}` 封装，不是仅内部 document。包向量和源码夹具提供跨语言已知字节/摘要。Bundle 签名仍覆盖精确保留的清单字节。

首次发布非 CASE 时，`AssetSnapshotV1.validationTarget` 包含 `{resourceId,versionId,revision}`，允许 `entryCaseVersionIds: []`。确定性候选 `versionId` 发布时原样采用，因此移除验证元数据后源码字节和哈希不变。`CompiledAssetBundle.validationOnly: true` 要求零入口，但必须有真实非空 files/dependencies。编译器消费者须语义验证目标成员、引用 kind、资产/入口用例唯一性及哈希；单靠模式校验不能证明闭包完整。`entrypoints` 现含 `{caseVersionId,path}` 记录。`ExecutionSnapshotV1.caseVersionId` 和 `TestJobManifestV1.caseVersionId` 必填；T05 必须精确选择锁定用例入口，拒绝将 validation-only Bundle 用于 TEST。不得随机由 caseExecutionId 猜文件名，也不得将零用例执行记为 PASSED。

`IdentityReferenceRegistry.require_role(session,scope,role)` 是 T07 的适配器/秘密域接缝，默认以 `UNRESOLVED_IDENTITY_REFERENCE` 失败关闭。应用组装可通过 Tornado `identity_reference_registry` 设置注入注册表。资产引用仅从既定 CASE 的 catalog/fixture/dataset、SUITE cases/datasets、`callFlow.versionId`、`template.versionId` 字段读取。数据集、预期值、JSON Schema 或参数内看似 UUID 的字段仍为惰性数据。T05 负责变量绑定、关键断言、展开限制等编译语义；成功发布等待经核实的 Runtime 输出。

统一队列存储 `kind=VALIDATE`、资源 `subject_id`、`state=QUEUED`、不可变 `snapshot_hash`/`manifest_hash`、资源/revision/source 幂等哈希、要求的引擎/编译能力、行为人/时间及可空活动 Attempt。`ValidateJobManifestV1.snapshotSha256` 标识保留的 AssetSnapshot 字节；面向领取的清单哈希标识精确作业清单字节。T09 在此表上扩展领取/fencing/租约/容量。T04 从未声称编译已完成；资源测试的回执夹具注入明确属于 T08–T10 完成边界。

可发布回执来源包含 `runtimeId`、`attemptId`、`compilerTrust: MANAGED`、资源/revision、Workspace/job、source/engine 及编译描述符 SHA-256。T08–T10 只能在有效租约/fencing 下，由管理员批准的**可信编译器**完成成功、授权且经核验的执行后创建回执，须检查批准的引擎/编译器/SDK/锁文件及实际上传字节。USER_REGISTERED 个人 Runtime 认证加上匹配的调用方声明哈希，并不能证明生成代码正确。T12 重分发可执行 TS 前必须保留此信任边界。发布检查已记录 MANAGED 来源、完成作业/活动 Attempt、精确服务端快照/清单、匹配的源码/根/revision，以及描述符所有实际文件的哈希/长度。当前还没有生产回执写入器，待处理作业不能发布。见 [ADR 0005](decisions/0005-immutable-asset-validation.md)。

限制：规范资源内容 2 MiB，创建/草稿传输封装 2 MiB + 4096 字节，其他操作 64 KiB，HTTP 硬传输 3 MiB；闭包最多 1000 个资产、深度 100、16 MiB；列表默认 25、最大 100。真实 HTTP/MySQL 已覆盖大于 64 KiB 的实际数据集。更大传输限额不改变账户表单限制，也不增加二进制上传支持。

发布重试仅在源码哈希、文档哈希、引擎及先前绑定回执的编译描述符哈希全部匹配时返回已有版本。引擎或源码不同必须创建新草稿 revision；同一不可变 revision 编译字节不同返回 `REPRODUCIBILITY_CONFLICT`（409）。字节相同的重新编译可返回原版本，保留原回执和产物身份。

<a id="t05-compiler-actual-files-and-t06t10-handoff"></a>
## T05 编译器、真实文件与 T06/T10 交接

`@veriq/compiler` 仅用于 Node。共享 `@veriq/contracts` 保持浏览器可移植，Tornado 不导入或调用编译器。公共导出为：

```ts
validate(snapshot: AssetSnapshotV1): ValidationIssue[];
analyze(snapshot: AssetSnapshotV1): Analysis; // 校验问题与带类型的编译用例
compileFiles(snapshot: AssetSnapshotV1, distribution?: EngineDistribution): CompiledOutput;
compileAssets(snapshot: AssetSnapshotV1, distribution?: EngineDistribution): CompiledAssetBundle;
verifyFiles(bundle: CompiledAssetBundle, files: Record<string, Uint8Array>): void;
assembleExecution(bundle: CompiledAssetBundle, snapshot: ExecutionSnapshotV1,
                  files?: Record<string, Uint8Array>): ExecutionPackage;
resolvePointer(value: JsonValue, pointer: string): Presence;
resolveBinding(value: JsonValue, context: {data: JsonValue; vars: JsonValue}): JsonValue;
```

`ValidationIssue` 含 `path`、语义字符串 `code`、`message`；编译器保留规范结构错误并增加语义码。`CompiledOutput` 为 `{bundle, files}`；`ExecutionPackage` 为带独立副本的 `{bundle, files, entrypoint, snapshot}`。组装不修改不可变文件，也不向生成源码写入执行值。可选签名为旧调用方保留明确失败：省略 distribution 抛出 `ENGINE_DISTRIBUTION_REQUIRED`，省略组装 files 抛出 `BUNDLE_FILES_REQUIRED`。文件字节不隐藏于进程全局状态，也不添加到严格传输描述符。

`EngineDistribution` 包含 `engineVersion`、`runnerSdkVersion`、精确的 `packageJson`/`packageLock` Uint8Array 字节、完整规范 `DependencyVersion[]` 库存，以及本地 `vendor/` 归档的 `files: Record<string, Uint8Array>`。它是 T20 批准后提供给 T10 的引擎发行输入。包必须为 ESM，使用本地 `file:vendor/...` 依赖，无根安装钩子、开发或可选依赖，并使用 npm lockfile v3。锁定包不得是链接，也不得有安装脚本。每个包都有精确库存版本/SHA-512 integrity 和经验证本地归档；必需锁依赖边必须在所提供闭包内解析。缺少产物、SDK/引擎/锁/integrity 不匹配或存在未声明文件，均须失败关闭。编译器不下载依赖、检查归档成员、安装依赖或证明调用方代码真实。T08–T10 仍执行 ADR 0005 的批准发行/编译器信任边界，导入器必须安全提取已验证归档。

返回全部编译文件，包括用例 `.test.ts`、一个共享 `source/context.ts`、`source/asset-snapshot.json`、package.json、package-lock.json、dependencies.json 和 vendor 归档。文件项覆盖精确字节和大小。CASE 入口将锁定 `caseVersionId` 映射到 `cases/<caseVersionId>.test.ts`；组装检查此显式映射，拒绝重复或缺失文件，绝不从 `caseExecutionId` 推导用例。`source/asset-snapshot.json` 始终是模式有效的 AssetSnapshotV1，通过导出的 `SOURCE_SNAPSHOT_PATH` 定位。冷启动 Runtime 验证描述符及全部文件哈希后，再检查该源码上下文的文档哈希、闭包、源码哈希、引擎、Workspace 与所选用例，同时检查角色/秘密版本引用、授权来源及选定冻结数据行。套件角色/浏览器/数据集变体仍锁定在源码中。组装要求至少一个完整变体同时匹配角色、浏览器及数据：有效数据集必须精确匹配其冻结行之一；不存在 CASE 默认数据集或 SUITE 覆盖数据集的变体，则匹配缺少 dataRow。即使另一个其他条件匹配的变体使用数据集，也保留无数据选项。

SUITE 目标精确选择服务端产生的去重用例版本 ID，并输出可执行入口。六种真正的库类型输出 `validationOnly: true`、零入口、导出冻结资产数据的真实 validation.ts，以及相同的必需依赖文件。其源码伴随文件保留 validationTarget，使零入口快照仍通过模式校验；CASE/SUITE 可执行上下文移除 validationTarget。无目标上下文可保留恰好一个去重用例集合等于所选入口的 SUITE；拒绝两个匹配根或其他不可达资产。仅验证输出不能组装为 TEST，零用例执行不能记为 PASSED。

生成的可执行 ABI 是 `@veriq/runner-sdk` 的 ESM 具名导出：

```ts
interface RunnerSdkV1 {
    registerCase(plan: CompiledCase, source: AssetSnapshotV1): void;
}
```

`CompiledCase`、`CompiledStep`、`CompiledAssertion` 现位于可供浏览器使用的 `@veriq/contracts`，并由 `@veriq/compiler` 再导出；`RunnerSdkV1` 仍为注册 ABI。`registerCase` 注册 Playwright 用例，T10 通过独立 SDK 执行上下文机制提供另行验证的 ExecutionSnapshot。生成模块不含 Run/Attempt/机器路径、运行时变量/数据行或秘密值。T06 实现生产注册，在离线 npm 安装后，用打包的真实 SDK 与 Chromium 验证生成 TypeScript。编译器早期夹具归档测试仍只是隔离打包测试。

`CompiledStep` 包含带生成传输 ID 的动作/观察器/提取 `step`、`sourcePath`、`before`、`responseAssertions`、`after`，以及 callFlow 可选 `children`。动作载荷已移除原步骤断言列表，只执行编译后的列表。SDK 阶段顺序是：前置断言 → 唯一目标解析 → 注册观察器 → 动作或嵌套子步骤 → responseAssertions → 校验后的提取 → after → 观察窗口检查 → 释放。包装观察器覆盖整个流程及后续子步骤，所有退出分支均释放。依赖新提取 vars 的断言放在 `after`；依赖项包括 target recordKey/角色名、继承目录范围、模板参数绑定及断言 expected/query 值。与这些值无关的响应/模式检查在赋值前执行。SDK 运行时仍须检查响应可用性、提取存在性/类型及可选值缺失。

流程/模板参数声明是有范围的 `data` 名称：在调用方当前范围求值一次输入参数，为本次调用覆盖 `data`，完成后恢复。流程 `vars` 提取按执行顺序共享。每个 `CompiledAssertion.parameters` 是该断言外层到内层的模板参数绑定栈。数据集值、JSON Schema 及从绑定取得的值始终惰性；仅对规范 DSL 标记为插值的字段调用 `resolveBinding`。完整占位符保留 JSON 类型；内嵌插值接受标量，拒绝对象/数组/null。缺失值抛错；`resolvePointer` 区分 `{present:false}` 与 `{present:true,value:null}`，只检查自身属性。两个 API 都不使用 eval，也不重新解释解析数据中的花括号。

八种类型均有语义检查：有类型的锁定引用、唯一身份、目录范围/目标/绑定、数据列与每一行、夹具模式/输出声明、范围参数/变量用法与类型、观察器来源、递归/展开、WRITE 业务结果断言和显式持久化证明。独立流程/模板库可保留调用方提供的 data/vars/catalog/observer 要求，每个具体 CASE 按实际闭包验证。夹具 JSON Schema 类型推断使用声明属性、本地引用和类型联合，歧义类型不能满足具体动作类型。SUITE 根的每种不同有效数据集（覆盖、CASE 默认或无数据集）都按完整 CASE 绑定/类型要求检查，含嵌套属性及行可选性；数据集可仅由 SUITE 提供。验证仍输出一个 CASE 映射，独立 CASE 根必须具备自己的声明数据上下文。每个 apiRequest.headers 值必须解析为字符串；完整占位符的数字/对象/数组值会拒绝，内嵌标量插值仍有效。运行时模式检查仍必需。环境检查验证配置来源/locale/timezone 及引用形状，不验证 Workspace 成员、秘密明文或外部身份登记，后者由 T07 负责。

流程最大深度为五；每个用例/库展开步骤（含调用边界）最多 500；模板深度为五。每个用例/库断言展开最多访问 5,000 个节点，计入模板调用及叶子；在分配无界重复模板 DAG 前返回 `EXPANDED_ASSERTION_LIMIT`。传输步骤/断言 ID 为 `v_` 加 SHA-256 展开路径摘要，共 66 字符，长嵌套 DSL ID 也保持规范 Key 边界；展开路径另作可读元数据。WRITE 关键步骤要求非 WARN 的响应字段业务断言；检查点证明必须在关键写入后，使用导航/重载后的非 WARN 持久 UI 检查、只读 GET 响应字段或 eventual GET 查询。允许同一步骤 eventual 回读。`CompiledCase.persistenceCheckpointStepId` 将显式 DSL 检查点映射到生成传输 ID。

编译器不提供验证回执、队列 Worker、浏览器 SDK、认证夹具适配器或草稿/导出 HTTP 端点。发布前 T10 须向既有 VALIDATE 完成路径上传每个实际输出文件及精确描述符；T12 复用这些保留字节。没有 Runtime 的草稿导出仍只是标记未验证的 DSL/依赖定义，缺少引擎发行时不能获得可执行产物。见 [ADR 0006](decisions/0006-deterministic-compiler-artifacts.md)。

<a id="t06-runner-sdk-and-t07t10-handoff"></a>
## T06 Runner SDK 与 T07/T10 交接

`@veriq/runner-sdk` 导出 `registerCase`、`configureExecution`、`executeCase`、`executeStep`、`createStepContext`、`armObserver`、`armEvent`、`ObserverRegistry` 及有类型的上下文/结果/Provider 接口。SDK 运行时只导入 Playwright 1.65.0、contracts、Ajv 8.18.0 和 ajv-formats 3.0.1，这些精确依赖已存在于锁文件和声明中。SDK 不导入编译器运行时，也不解释另一套 DSL。根 `pnpm test`、`pnpm check` 包含 SDK；`pnpm --filter @veriq/runner-sdk test:coverage` 强制核心行覆盖率至少 75。当前 Linux 开发环境测试要求 `/usr/bin/chromium`。

`executeStep(plan: ResolvedStep, context: StepContext): Promise<StepResult>` 接受共享 `CompiledStep`。`StepResult` 在规范步骤载荷上增加可读 sourcePath、断言、观察器摘要、嵌套子项及内部事件证据。断言结果保留 expectedSource、解析后的 expected、MISSING 与存在 null 的实际证据区别、severity、耗时和错误码。响应 Schema 值保持惰性。阻断失败停止步骤；CONTINUE_FAIL 使步骤失败，WARN 保留警告。用例级 failurePolicy 控制后续执行，不能把失败用例变为 PASSED。WRITE 完成还要求成功的编译持久化检查点，并有非 WARN 的通过断言。

`armObserver(spec: NetworkObserverV1, context)` 返回 `waitFirst`、`finalize` 和幂等 `dispose`。匹配使用 API 来源、精确方法/路径及绑定后的 query/body 子集，重试必须保留完整请求数据。安全绑定后，动作 query 值和观察器 queryMatch 使用同一 URL 规范化：字符串保持字符串；数字/布尔/null 用字符串形式；外层数组输出有序重复键，空数组不输出键也不形成匹配约束；对象值和嵌套数组使用规范紧凑 JSON。单元素重复值规范化后与标量具有相同传输字符串。query 子集比较这些传输值，JSON body 匹配仍严格区分类型。字面路径中也存在的 query 字段，标量/对象替换该键，数组追加，保持动作序列化行为。观察器在声明窗口内一直有效；单步骤结果不能声称统计整个 Run。普通观察器必须在超时内取得候选请求；存在 FIXED 窗口时还须在该窗口内，即使没有响应断言也如此。单独 finalize 不要求响应正文已完成。显式计数窗口验证实际数量；零计数 FIXED 窗口可不等到首个响应而成功，但响应/提取消费者仍必须有响应。所有退出分支释放监听器并拒绝挂起消费者。事件句柄 `dispose()` 返回 Promise，须 await 以完成下载取消和部分文件清理。直接使用底层 SDK 的调用方必须提供有界截止时间/取消上下文及浏览器来源保护；`executeCase` 在自身生命周期安装 Context 级允许列表守卫。API 重定向不能把请求带到其他来源，即使那个来源本来在允许列表中；写入重定向一律拒绝。编码路径在解码后及 URL 解析前都须检查。

ObserverV1 另接受：

- `{id, kind:'dialog', dialogType:'alert'|'beforeunload'|'confirm'|'prompt', message, handling:'accept'|'dismiss', promptText?, timeoutMs?}`。message 安全绑定后精确比较；promptText 仅可用于接受的 prompt。意外或不匹配对话框被 dismiss 并失败。
- `{id, kind:'newPage', pageKey, timeoutMs?}`。只捕获动作 Page 的 popup，不进行 Context 级页面竞态。步骤及 UI/URL 断言可选 pageKey 选择它，省略始终选原用例页面。包装声明对子步骤/调用方步骤可见，流程局部声明返回时恢复。前置断言和动作选择发生在该步骤声明之前；编译器检查重复及顺序。只有网络观察器 ID 可供请求/响应断言或提取使用。
- `{id, kind:'download', timeoutMs?}`。必须提供可信 `downloads:{directory,maxBytes}`；名称由引擎产生，错误时清除部分持久化文件。建议文件名只是元数据。字节上限限制已持久化证据；Playwright 在暴露流前先暂存下载，因此 T10/T20 还必须限制浏览器临时存储并关闭 Context。捕获结果保留有类型内部证据，供 T10 投影到既有 STEP_FINISHED、ARTIFACT_CREATED 事件。

事件获取默认 15 秒，受用例截止时间限制。单次观察器在步骤结束前出现第二次事件即失败。所有捕获都预先布防，包括 callFlow 包装，并在断言/网络窗口后再次检查。见 [ADR 0007](decisions/0007-runner-sdk-events.md)。

生产用例入口为：

```ts
configureExecution(provider: ExecutionContextProvider): void;
registerCase(plan: CompiledCase, source: AssetSnapshotV1): void;
executeCase(plan: CompiledCase, source: AssetSnapshotV1,
            options: ExecutionOptions): Promise<CaseResult>;
```

可信 Worker 初始化调用 `configureExecution`，或将 `VERIQ_EXECUTION_CONTEXT_MODULE` 设置为导出 `createExecutionContext(info)` 的可信绝对 ESM 模块。Provider 将 `{execution, lifecycle, credentials?, signal?, files?, downloads?, emit?, redact?}` 与不可变生成源码分开返回。运行该代码前，T10 必须经编译器组装验证源码/Bundle 哈希、授权及冻结执行变体。SDK 检查 ExecutionSnapshot 模式及源码/Workspace/用例身份，不能代替发行来源或 Workspace 授权。T10 提供禁用 Service Worker 的浏览器 Context，避免 Service Worker 绕过请求路由。Provider 属于可信引擎，绝非 DSL 输入或任意上传脚本。

`LifecycleProvider.authenticate({page,execution,signal,credentials?})` 必须返回已验证、非空 identityId；配置 allowedIdentityIds 时还须核对允许列表。`CredentialProvider.resolve({workspaceId,secretRef,versionId},signal)` 是 T07 锁定版本的查找接缝，SDK 不伪装自行解析凭据。用例引用夹具时，`prepare(fixture,context)` 和 `cleanup(fixture,cleanupToken,context)` 均必需。prepare 返回 `{variables,cleanupToken}`；核心在校验输出或投影普通结果前，自动向证据策略登记 cleanupToken，通用 Provider 也如此。变量赋值前必须满足 outputSchema。部分准备（token 可为 undefined）、业务失败或取消后都执行清理，使用独立有界信号。Provider 必须响应 signal，执行真实、幂等清理/补偿；T07 负责这些集成。认证和 prepare 各 60 秒，业务步骤共享 120 秒，清理 30 秒。registerCase 使用 240 秒 Playwright 超时、零重试，Runtime 仍负责进程监督和 fencing。

`CaseResult` 包含 outcome、businessOutcome、cleanupStatus、steps，可选 errorCode。缺少必需 Provider、夹具输出无效或清理失败都不能报告 PASSED。启用发出事件时，`emit` 必须通过调用方提供的脱敏接收内部 STEP_FINISHED/CASE_FINISHED 消息；它们是 SDK 消息，不是新增平台传输事件类型。生产 registerCase 始终要求 JSON 结果附件脱敏，所有非 PASSED 结果都令 Playwright 失败。T10 将 SDK 详情映射到规范事件/产物；秘密掩码、凭据集成、证据上传、Runtime 取消及 OS 打包仍由下游负责。上传 `files` Provider 将批准的 Bundle 路径解析为真实字节，缺少 Provider 应失败，不能提供空文件。

<a id="t07-fixture-and-identity-handoff"></a>
## T07 夹具与身份交接

具体决策及已测试的后端契约见 [ADR 0008](decisions/0008-fixtures-business-identity.md) 和[后端集成](integration/backend.md)。`CaseDslV1.fixtureInput` 是可选显式绑定对象，省略时为空，副作用发生前校验。`CaseDslV1.initialVariables?: ParameterTypes` 按既有 ValueType 语义声明必需初始名称/类型，源码不含值；冻结 `ExecutionSnapshot.variables` 提供值。可移植导出 `resolveInitialVariables(declarations, values): JsonObject` 校验自身属性存在性/类型，仅返回 prepare 前绑定所声明子集，失败为 `INITIAL_VARIABLES_INVALID`。额外冻结变量保持兼容，但不能成为 fixtureInput 符号。夹具输出名称冲突报 `DUPLICATE_VARIABLE`。静态字面值/数据约束使用完整 Ajv；动态绑定使用声明类型及可独立判定约束，再由冷组装/SDK 在认证前用实际值校验完整输入模式。`LifecycleContext.fixtureInput` 独立携带解析值，夹具 cleanupToken 从不成为普通变量。prepare/query/cleanup 方法分别为 POST/GET/POST-or-DELETE。`EnvironmentV1.fixtureIdentity` 与 fixtureBaseURL 配对，独立于业务角色。

`AuthAdapterConfigV1` 支持 `HTTP_BEARER`、`HTTP_SESSION`、固定相对 identity/login 路径及 identityPointer。`AuthAdapterVersionV1` 为 `{workspaceId,versionId,contentHash,configuration}`。Workspace 注册表不可变，可变撤销元数据放在冻结配置之外。可选 `AssetSnapshotV1.authAdapters` 仅用于真实 Environment 闭包，存在时才进入源码 JCS 投影，并按 UUID 文本码点排序，Python/TS 共用向量。普通 CASE 源码仍与环境无关。`ExecutionSnapshotV1.authAdapters` 冻结所选角色/夹具闭包，编译器组装要求精确 ID、哈希、Workspace、秘密锁定版本且无多余项。T09/T10 必须提供注册表认证值、当前撤销检查及完整 ExecutionSnapshot 精确字节的 TEST 清单哈希。T14 保留独立签名离线档案。

已实现管理路由为 Workspace 下的 `/credentials` GET/POST、`/credentials/{secretRef}/versions` POST、`/credentials/{secretRef}/versions/{versionId}/revoke` POST、`/auth-adapters` GET/POST、`/auth-adapters/{versionId}/revoke` POST。包括列表在内都要求当前 MANAGE_ENVIRONMENT；列表使用范围签名游标。响应只含元数据/配置。迁移 `0004_credentials` 新增 `veriq_secret_refs`、`veriq_secret_versions`、`veriq_auth_adapter_versions`，复用既有 Workspace 成员、审计和资源机制，不另建 jobs/artifacts/receipts 表。

`IdentityRegistry.require_role(session,scope,role)` 检查精确 Workspace 引用、版本撤销及显式身份允许列表；`freeze(session,scope,roles)` 返回排序的公共配置快照。授权在解析事务中按确定性适配器顺序锁定/重载可变适配器和秘密行，防止撤销跨越授权/解密点。

`POST /internal/v1/attempts/{attemptId}/credentials/resolve` 接收 `{secretRef,versionId}`，要求 Authorization、X-VeriQ-Lease-Token、X-VeriQ-Fencing-Token 请求头，返回标准封装内的 `{secretRef,versionId,value}`，带 Cache-Control:no-store。生产使用 `DenyAttemptProof`。T08/T09 注入 `AttemptProofVerifier.verify(session:AsyncSession, attempt_id:str, proof:CredentialProofTransport)->VerifiedAttempt`。传输对象持有不进入 repr 的 authorization、lease_token，以及 fencing_token。处理器检查返回 Attempt ID/调用方 fence；域策略检查活动/当前 fence、未过期租约、当前成员/授权和 MANAGED 信任。T09 在同一安装锁下用 `DatabaseAttemptProofVerifier` 实现这些事实。T07 域测试仍显式注入证明夹具，T09 另测真实设备/Attempt/凭据集成。

设置 `master_key_id` 默认 `primary`；`previous_master_keys` 是外部密钥 ID 到 hex32 的映射，也可通过 VERIQ_PREVIOUS_MASTER_KEYS 传入 JSON。CLI 初始化仅向受限运维配置序列化嵌套秘密；恢复 init 时同时保留已有活动密钥字节、ID 及历史解密钥匙。轮换创建不可变凭据版本，绝不以新版本替代已撤销的锁定版本。

`EvidenceFileEntryV1` 在文件元数据上增加必填 `sensitivity`（`REDACTED` 或 `CREDENTIAL_RESTRICTED`）；ARTIFACT_CREATED 的 payload files、离线产物清单、ArtifactDTO 和 ArtifactUploadRequest 都传递它。产物 kind 新增 DOWNLOAD。原始 Trace/截图/下载默认受限。`EvidencePolicy` 脱敏已登记凭据/会话/cleanup 值及 auth/cookie/proof 请求头，普通投影排除原始路径。`executeCase` 向收集的下载提供可信 `restrictedEvidence` 产物接收端；普通事件/结果不含原始路径。该接收端是引擎上传边界，不是终端用户下载授权。T12 对受限字节必须执行当前 Workspace/Attempt 访问检查及 MANAGE_ENVIRONMENT，拒绝生产者降低分类，阻止普通导出/报告权限绕过策略。不声称原始截图和 Trace 已脱敏或可普通查看。

<a id="t08-runtime-and-service-account-handoff"></a>
## T08 Runtime 与服务账户交接

[ADR 0009](decisions/0009-runtime-enrollment.md) 定义批准的所有权与登记模型。迁移 `0005_runtimes` 新增五张 Runtime 表及可复用的 `veriq_service_accounts` / `veriq_service_tokens` 基础。每个 Runtime 恰好归属一个真实用户或服务账户。绑定和显式具名成员/整个 Workspace 授权独立于信任与位置。设备能力保持 `DEVICE_REPORTED`，登记返回 `OFFLINE`，不附带 `lastSeenAt` 或伪造执行历史。

`RuntimeService(session).approve_enrollment(actor: User, code, binding: workspace_id, grants, enrollment_id=...)` 创建所有者选定绑定并返回 Runtime 元数据。`require_device(authorization)` 检查过期、撤销、有效绑定及当前用户成员关系或服务账户授权后，返回数据库支持的 `(Runtime, RuntimeBinding, RuntimeToken)`。`require_dispatch(actor: User, workspace_id, runtime_id)` 另查当前 EXECUTE 与私人所有者同意。它们是事务原语：在身份/Workspace 读取**之前**取得 `lock_installation`，持有至受保护操作结束；HTTP 处理器已这样执行。T09 必须在同一授权事务中关联/锁定派单、作业行为人、所选环境/凭据授权、租约哈希、fencing token 及不可变锁定项。T09 现已安装 `DatabaseAttemptProofVerifier`，从当前数据库推导完整证明。保留 T04 作业/产物/验证回执，T09 增加 Runtime/Attempt 回执外键及经验证生产完成写入器；T08 登记路径自身绝不注入编译回执。

已实现的人员路由为 `POST /api/v1/runtime-enrollments`（201）、`/poll`、`/inspect`、`/{enrollmentId}/approve`。inspect/approve 要求真实 Web 会话、Origin 和 CSRF；原生创建/轮询不使用 Cookie 身份，拒绝跨来源浏览器请求。批准要求 `userCode`、当前可执行 Workspace 成员关系，以及显式私人/成员/Workspace 同意。私人加具名共享无效。公开码和轮询秘密独立随机且存哈希，十分钟过期，原子消费。创建限制每来源十分钟二十次，待批准轮询强制五秒间隔。轮询返回 409 `ENROLLMENT_PENDING`、429 `ENROLLMENT_SLOW_DOWN` 或一次性凭据回执。过期、丢失一次性回执或秘密已消费后须重新登记。

已实现管理路由为 Workspace `/runtimes` GET（范围签名分页）、`/{runtimeId}` GET、`/grants` PUT、`/trust` PUT、`/revoke` POST。未经所有者同意，私人设备不出现在未授权列表中，Workspace/系统管理员也不可访问。仅真实所有者或代表其服务账户的当前 Workspace OWNER/ADMIN 可改共享或撤销设备。任何共享变更都重置信任/投递批准。仅具备当前 Workspace 访问权及既有所有者共享同意的系统管理员可批准 MANAGED。凭据投递是独立项目权限：PUT `/runtimes/{runtimeId}/credential-delivery` 携带 `RuntimeCredentialDeliveryWrite {allowCredentialDelivery:boolean}`，启用必须具备当前 Workspace OWNER/ADMIN（MANAGE_ENVIRONMENT）、所有者既有同意及 MANAGED 信任。非全局项目管理员可在系统管理员独立信任决定后批准投递。合并 `/trust` 更新只有在行为人额外拥有 MANAGE_ENVIRONMENT 时才可启用投递；信任降级可在无项目秘密权限时清除投递。全局管理从不自动创造成员关系或同意。撤销拒绝后续设备操作，不重写历史结果。真实 Run 的 `gateAtExecution` 与 `gateNow` 由 T09/T11 负责。

`GET /internal/v1/runtime`、`POST /internal/v1/runtime/token/rotate`、`/logout` 认证 Bearer 设备 token，绝不接受 Web Cookie 作为证明。设备凭据 24 小时过期，轮换原子撤销旧 token。CLI 仅在远端注销成功，或明确 HTTP 401 DEVICE_UNAUTHORIZED/DEVICE_REVOKED 拒绝后删除本机凭据；传输或未知失败时保留。显式 `logout --local-only` 仅删除本机凭据，不联系服务端也不声称已撤销；项目资产/结果保持不变，并提示 Web 撤销或等待过期。已有档案的登录保护持续到此次显式清理。Token 载荷、HTTP 错误日志和审计从不包含原始凭据。`DeviceCredentialsDTO` 保留 `runnerId`，包含批准的初始 `workspaceId`，并可选支持**成对**的 `issuerId`/`trustedKeys`。T08 省略两个 issuer 字段；T14 须提供实际认证的 Ed25519 根，缺少根时明确使 Bundle 校验失败。

规范 Workspace `/service-accounts` GET/POST、`/{serviceAccountId}/tokens` POST、`/disable` POST、`/tokens/{tokenId}/revoke` POST 实现 T16 身份基础，要求当前 OWNER/ADMIN。T08 token purpose 精确为 `RUNTIME_ENROLLMENT`：256 位、十分钟、消费一次、独立可撤销，不具触发/维护/凭据权限。`POST /internal/v1/runtime-enrollments/service` 消费它，创建归服务账户所有、绑定该账户 Workspace 的 MANAGED_CLOUD Runtime；初始信任仍是 USER_REGISTERED。账户禁用会立即使设备认证失败。T16 必须扩展而非重复创建这些身份/token，其余计划的服务账户 API/权限范围仍未实现。

Runtime 传输描述符及登记/凭据回执由规范 JSON Schema 定义，OpenAPI 引用别名，生成 TypeScript 消费。原生客户端用既有 `@veriq/contracts` 校验成功设备响应。`/runtimes` 的真实 UI 使用已认证 Workspace Provider、带范围且可取消的查询，提供明确加载/空/错误/成功状态，设备检查、私人/成员/Workspace 同意、信任/撤销管理及部署服务账户。页面展示当前信任，不伪造历史结果。

<a id="t09--implemented-unified-execution-service"></a>
## T09 已实现的统一执行服务

迁移 `0006_execution` 扩展原 `veriq_jobs`，复用 Workspace+SHA `veriq_artifacts` 和 `veriq_validation_receipts`。Run、CaseExecution、Attempt、容量、资源租约、领取回执、事件、上传及维护回执表具有有类型 Workspace 外键。TEST Job 引用真实 Run+CaseExecution；CLEANUP Job 引用真实维护回执及原 Attempt。CaseExecution 引用已发布版本，或不可变草稿候选 UUID 加源码产物，不能伪造已发布版本。完成的编译回执绑定同一 Runtime、Workspace 的实际 Attempt。

`JobService(session, settings).claim(RuntimeIdentity(authorization), ClaimRequest)` 返回 ClaimDTO 或 None。`LeaseService.heartbeat(attempt_id, proof, progress)` 返回 HeartbeatDTO。`CredentialProofTransport` 携带设备认证、租约 token、fence，repr 不泄露秘密。每个公共事务在身份和 Workspace 读取前取得 `lock_installation(session)`，持有至提交，域调用方也必须如此。当前设备所有者/账户、绑定/同意、请求人的 EXECUTE 权限（或窄范围 CLEANUP 服务授权）、活动 Attempt、仅哈希租约及 fence 一起检查。当前撤销拒绝内容、凭据、事件、上传和完成；心跳发出取消信号而不延长租约。缓存产物不提供授权。

Run 准入：POST `/api/v1/workspaces/{workspaceId}/runs` 使用 Cookie/CSRF 及 `Idempotency-Key`（1–160 字符），精确选择 `caseVersionIds`、`suiteVersionId`、`draftValidationJobId` 之一，加 `environmentVersionId`、`roleKeys`、`browsers`、`runtimeIds`，可选 `variables`、`executionLocation`、`maxRetries`（0/1）。服务端冻结变体保留套件序号、数据集版本/行 key、所选角色/浏览器/环境、公共适配器配置哈希、仅引用的秘密锁定版本、初始变量和唯一 Attempt namespace。选择从不回退到其他 Runtime/位置。DEBUG 可等待其不可变候选的托管验证，之后才物化可执行清单。验证以失败终态结束后，队列下次检查时将依赖 DEBUG 用例和 Run 结束为 ERROR。`triggerKind`（MANUAL/DEBUG）与执行来源/位置独立。全局最多十个未完成 Run；零用例以 `NO_CASES_SELECTED` 结束为 INCOMPLETE。GET/列表/取消使用同一 Workspace API。在 T16 提供真实范围计划授权前，拒绝服务 token Run 准入。

实际设备路由为：

| 方法与路径 | 请求 / 响应 |
| --- | --- |
| POST `/internal/v1/jobs/claim` | ClaimRequest → ClaimDTO 或 204 |
| POST `/internal/v1/attempts/{id}/activate` | leaseToken、fencingToken → attemptId、activated:true、fencingToken |
| POST `/internal/v1/attempts/{id}/heartbeat` | HeartbeatRequest → HeartbeatDTO |
| POST `/internal/v1/attempts/{id}/events` | EventBatchRequest → acceptedThrough |
| POST `/internal/v1/attempts/{id}/artifact-uploads` | proof + kind、filename、contentType、sha256、sizeBytes、sensitivity → artifactId、uploadUrl、method:PUT、expiresAt |
| PUT 返回的 uploadUrl + `?offset=N` | 原始字节 + 证明请求头 → artifactId、receivedBytes、complete |
| GET `/internal/v1/workspaces/{ws}/attempts/{id}/content/{sha256}` | 证明请求头 → 原始字节 |
| POST `/internal/v1/attempts/{id}/finish` | FinishRequest → 已保存 FinishDTO |
| POST `/internal/v1/attempts/{id}/reconcile` | fencingToken、processStopped、cleanupStatus、stoppedAt → attemptId、capacityReleased、auditId |

POST 使用 `Authorization: Bearer <DeviceToken>` 与 JSON 证明字段；PUT/GET 使用 `X-VeriQ-Lease-Token`、`X-VeriQ-Fencing-Token`。原生路由拒绝外部 Origin，既有 DeviceAPI 策略允许缺省或同服务 Origin。激活前允许下载，以验证不可变闭包；凭据、上传、事件、完成必须在激活后。T10 必须拒绝重定向/意外来源并核验每个哈希。

领取分配一个 LEASED Attempt，不允许执行副作用。激活前重用同一 clientRequestId 会轮换该 Attempt 的 token+fence，不延长截止时间；激活后重复请求返回 409 `ATTEMPT_ALREADY_ACTIVATED`，不授予新权限，健康容量保持占用。重复激活同样返回 409。丢失激活响应须执行本机进程对账，不能启动第二个进程。空领取回执保留 204 共 24 小时，每 Runtime 最多 10,000 条，外部 reap 清理旧空回执。非空回执随保留的 Attempt 生命周期保留。客户端绝不重用请求 UUID。

有效性以服务端数据库 UTC 判定：租约 60 秒，心跳 10 秒，Run 预算 30 分钟。Claim 暴露 `expiresAt`，Heartbeat 暴露 `leaseExpiresAt`，两者均暴露 `serverTime`、`leaseDurationMs`。T10 调用 `apps/runtime/src/lease.ts::leaseDeadline(grant, monotonicSend, monotonicReceive)` 时，将领取过期映射到 `LeaseGrant.leaseExpiresAt`。该工具的一秒停止预留和完整往返扣减独立于客户端墙钟。它是已测试的帮助函数，尚不是 T10 进程监督器。

安装锁下容量取得顺序为全局 → Workspace → Runtime → 环境 → 独占资源 key。浏览器上限仍为全局 4/Workspace 2；编译、清理各默认全局 2/Workspace 1，Runtime 总余量 1，环境浏览器 2。`compile_slots`、`cleanup_slots`、`runtime_job_slots` 控制独立非浏览器/Runtime 预算，设备上报 availableSlots 不能提高预算。过期未激活 Attempt 安全释放；过期已激活或明确未知进程以 ERROR/WORKER_LOST 结束并保持 QUARANTINED 容量。未知对账立即撤销实时权限并聚合 Run。确认停止幂等释放容量，不能把既有失败变成成功。无有效完成证明的存活已停止 Attempt 变为 INCOMPLETE 并参与聚合。

上传保留 Tornado 既有 3 MiB 传输上限：单块最多 1 MiB，单文件 32 MiB，Attempt 声明上传总预算 256 MiB，最多 1,000 条。精确重复元数据返回同一上传，块必须连续或为精确字节重放。上传完成验证完整 SHA/大小后才写入既有不可变 Artifact 表，临时字节不是可执行产物。每个块（含重放）均查证明；外部 reap 清除过期 Attempt 部分字节。T12 负责 File/S3 后端、保留期/报告 UI 及原始证据下载 ACL/脱敏；T09 闭包下载端点不暴露任意上传证据。

编译器 `compileFiles` 现输出 `metadata/expected-plans.json`，其哈希/大小列入 CompiledAssetBundle。`ExpectedPlansV1` 含 schemaVersion 和 cases，每项含 caseVersionId、可选 persistenceCheckpointStepId、requiredEvidenceKinds（TRACE）及扁平步骤 `{id, order, parentId?, failurePolicy, assertions, observers}`。断言含 `{id, severity, stage}`。数据来自真实 CompiledCase 分析，控制服务不展开 DSL。T10 须生成规范生命周期/步骤/断言/观察器事件及真实证据，包括携带返回 artifactId、匹配 file/kind 的 ARTIFACT_CREATED。事件从 sequence1 连续，接受精确重复，内容变化的重复或缺口冲突。显式依赖 SKIPPED 结果携带 blockedByStepId，BLOCK 断言还带 blockedByAssertionId；缺少结果不能变成跳过。

`completion-manifest-v1.schema.json` 现在是严格联合类型 `CompletionManifestV1` 的别名；旧 `attempt-manifest-v1.schema.json` 仍是 JobManifestV1 的别名。共同完成字段为 schemaVersion、kind、attemptId、jobManifestSha256、businessOutcome、cleanupStatus、evidence（EvidenceFileEntryV1[]）、requiredEvidence（SHA[]）和 `processStopped:true`。TEST 另外要求 caseVersionId 与 expectedPlansSha256。VALIDATE 成功（`businessOutcome:PASSED`）时要求 compiledBundleSha256 和 engineInventorySha256；VALIDATE 失败（`businessOutcome:ERROR`）时禁止 compiledBundleSha256，要求 engineInventorySha256、failureCode，以及至少一个已上传且非空的 LOG。failureCode 必须是 1～80 个大写 ASCII 字母、数字或下划线，且以字母开头；LOG 必须同时列入 evidence 和 requiredEvidence，并通过 ARTIFACT_CREATED 关联。缺少诊断将被拒绝，此分支绝不签发 ValidationReceipt，也不允许发布。CLEANUP 要求 fixtureVersionId 和原始 namespace。调用 finish 前必须先上传完成清单字节。

`FinishRequest.outcome` 只是调用方提交的声明；服务端从可信元数据、保留事件及已验证的本次上传推导结果。TEST 缺少生命周期、预期结果、必需证据或匹配的 ARTIFACT_CREATED 时为 INCOMPLETE；清理 FAILED 则归为 ERROR。原始业务、清理和证据事实分别保留。FAILED/ERROR 后至多进行一次整用例重试，使用新的命名空间和 Attempt；重试后通过归约为 UNSTABLE。Playwright 的 retries 仍为 0。已完成请求按相同散列重放时，即使租约过期，仍在检查当前设备及请求者授权后返回已保存回执；不同散列不能覆盖它。核对或租约回收绝不伪造 PASSED 回执。

`approved_engine_inventory_path` 指向由操作员控制的 JSON 文件，并按 ApprovedEngineInventoryV1 校验。缺失或无效的库存会使受管理编译器领取和完成流程失败关闭。每个精确引擎条目绑定编译器/SDK 版本、依赖库存，以及 package.json、package-lock.json、dependencies.json、engine/compiler.tgz 和供应商归档的 SHA/大小。完成库存散列是规范化引擎条目 JSON 的 SHA-256，不是整个目录的散列。只能批准固定发行路径；上传的目录内容本身不会授予批准。

签发既有 ValidationReceipt 前，必须验证实际上传的描述符与文件、不可变源码旁车字节、选定 CASE 入口、预期计划，以及当前有效 MANAGED 编译器证明。以前发布的可信回执继续作为不可变来源记录。T18/T20 将同一批实际发行字节晋升到操作员目录；T09 不合成生产目录。控制服务运行时无需 Node/Chrome。测试使用真实发射归档和仅供测试的生产器；TEST 生命周期/证据夹具只证明服务端协议，不能证明 T10 的真实浏览器、Agent 执行或 Trace 有效性。

Workspace Owner/Admin 可通过既有服务令牌 API 签发 `purpose:MAINTENANCE`，显式允许
`expired-leases/reap`、`fixture-cleanups/reconcile`、`capacity/reconcile`、`artifacts/expire`、
`lifecycle/expire` 中的操作；签发与令牌元数据列表均支持同时返回五项操作。
令牌只保存散列，可在 24 小时内重复使用，按当前账号/Workspace 限定并可撤销。
RUNTIME_ENROLLMENT 仍是单独的 10 分钟一次性秘密，不能授权这些操作。
`POST /internal/v1/maintenance/{operation}` 要求对应 Bearer 令牌、显式 workspaceId、
limit（1～10,000）、可选 cursor 和 Idempotency-Key。相同请求重放已保存结果，参数变化则冲突。

租约回收分别以 limit 限制到期 Run 的 Job、到期 Attempt 和旧空回执的处理数量。未启动工作超过 30 分钟以 RUN_TIMEOUT 取消；到期的活跃执行授权被终止，未知活跃进程则保守隔离。fixture 与容量扫描返回 hasMore/nextCursor；调用方为每页或每次迭代使用新幂等键。容量核对按持有租约验证计数器，不盲目释放。

补偿在同一队列中为每个原始 Attempt 至多创建一次 CLEANUP。它等待原容量释放，使用共享 Runtime 与当前有范围限制的维护授权。固定清理主体包含 Workspace、原命名空间、fixtureVersionId/definition、环境、公开 authAdapters 和 engineVersion，不含明文清理凭据。T10 提供只含 HTTP 能力的 fixture 上下文，通过真实证明验证器只解析冻结的 fixture 身份，不创建虚假 Page。

Owner/Admin 调用 `POST /api/v1/workspaces/{ws}/attempts/{id}/reconcile` 时，要求 `processStopped:true` 和 10～1,000 字符的原因；它只释放隔离或已释放的容量，记录 Workspace 审计而不改变结果。此处不新增内部调度器、并行队列、以引导身份充当请求者的路径或虚假离线 Job。

<a id="t09-review-correction-result-order-blocking-cancellation-and-queue-progress"></a>
### T09 复审修正：结果顺序、阻断、取消与队列推进

预期计划断言的 `stage` 描述执行顺序，不是可编辑 DSL 语法：BEFORE → RESPONSE → AFTER → FINALIZE。编译器按实际 CompiledAssertion 类型将 `requestCount` 标记为 FINALIZE，因为 SDK 将其延迟至观察器结束后执行。其他断言保持编译后的阶段；DSL 与 SDK 行为均不改变。延迟计数不能证明更早的 AFTER 断言或子步骤已被阻止。

归约器保留每个负面的业务结果与 ATTEMPT_FINISHED 结果。冲突的终态事实使证据变为 INCOMPLETE，ERROR 仍保持更高优先级；通过的步骤不能消除后来的业务或来源失败。执行事实必须位于 ATTEMPT_STARTED 与 ATTEMPT_FINISHED 之间，清理在业务工作之后。终态之后的上传尾部只允许 LOG 和 ARTIFACT_CREATED 通知。断言与观察器必须位于所属 STEP_STARTED/STEP_FINISHED 区间；实际执行的子步骤位于父步骤内，同级步骤遵循编译顺序，断言阶段遵循其实际执行顺序。FINALIZE 断言位于已观察结果之后。

显式跳过的断言可以指向同一步骤中、在更早执行阶段或顺序失败的 BLOCK 断言；阻断事实必须先于跳过事实。祖先只能通过 BEFORE BLOCK 阻止尚未开始的子工作，子步骤仍须具有明确 SKIPPED 事实。若自身先前的非 FINALIZE BLOCK 阻止了观察器最终收尾，失败的 STEP_FINISHED 可通过 blockedByStepId/blockedByAssertionId 显式引用该 BLOCK。此时缺少的观察器结果保留为 `blockedObservers` 事实，不能虚构 PASSED 观察结果；没有这种证明时，缺少的观察器仍导致 INCOMPLETE。

取消排队中的重试时，要区分已经结束的历史 Attempt 与活跃派单。它立即结束 Job/CaseExecution/Run，记录 `reasonCode:USER_CANCELLED`，并将保留的 Attempt 历史与 CANCELLED 一起归约。因此，更早的 FAILED/ERROR 仍保持较高严重程度；不可变 Attempt 结果不改写，也不会领取替代 Attempt。

领取在 SQL 中应用稳定的 Workspace、状态、时间、Runtime、位置、引擎及种类条件，随后按 `(created_at,id)` 连续遍历每页 100 行，直到事务内的有限队列耗尽或预留到一个合格 Job。动态请求者、允许列表、依赖、隔离及容量检查仍逐个候选执行。安装锁阻止遍历期间并发入队或授权变更，数据库时间围栏排除较新的行。不设置固定前缀限制，也不新增游标表。内存及单次查询均以 100 行为界，总工作量和安装锁持有时间仍与当前匹配队列长度成正比；这是保守的一致性取舍。

<a id="t10--online-node-agent-and-physical-execution"></a>
## T10：在线 Node Agent 与物理执行

`apps/runtime/src/execution/supervisor.ts` 导出 `ExecutionSupervisor.runAttempt`，输入为 `{claim, requestStarted, responseReceived}` 和 AbortSignal，返回 `AttemptResult {completion?: CompletionManifestV1, stop: StopReceipt, files: LocalEvidence[]}`。分配的 JobManifest 只是输入，只有实际测量到的执行才能产生完成结果。没有完成清单就进入核对流程，绝不能根据退出码推导通过。`terminateAttempt(id, reason)` 返回物理停止已确认或未知的回执。

开发 CLI：`runtime start --release-dir <operator-release> --browser-executable <pinned-browser>` 在前台运行 Agent；`--once` 至多消费一次领取。`runtime status` 和 `runtime stop` 使用私有、经过认证的 Unix socket。SIGINT/SIGTERM 同样请求取消。一个档案只允许一个 Agent；退出登录前必须先停止它。仅本地退出会删除设备凭据及待确认轮换候选，保留执行证据且不撤销远端凭据。原生 Windows Job Object、安装器进程映像与操作系统保险库集成仍属于 T20 边界。

本机发行目录包含 `inventory.json`（ApprovedEngineInventoryV1）及其声明路径上的精确文件，由操作员选择，绝不由派发 Job 决定。服务端独立批准相同库存。T10 验证散列，仅以 npm 离线且禁用安装脚本的方式安装已批准本机归档，执行归档内真实编译器，并在 registerCase 运行前通过确定性重编译比较 TEST 描述符与文件。发行闭包除 SDK 依赖外，还包含编译器已经锁定的 TypeScript 依赖。T18/T20 必须晋升这些精确字节；开发者测试归档不是已发布的生产引擎。

领取先记入日志并完成激活，再开启受门控的 Worker。若激活回复丢失且尚未派生 Worker，则可按已停止核对。Linux 所有权使用每 Attempt 随机 nonce、实际执行 UID 和 `/proc` 启动时间，覆盖独立浏览器进程组及已记录后代。发信号前再次检查当前 `/proc` 所有者 UID；日志 UID 缺失或不匹配时保持未知。身份未知或无法确认进程停止时继续隔离。既有单调 leaseDeadline 驱动独立看门狗，设备墙上时钟变化不能恢复授权。收到 204 后至少等待 10 秒再轮询，并使用新 UUID；只有某个具体、未确认的领取请求才复用其日志 UUID。

业务子进程不会收到设备令牌或租约证明。每 Attempt 私有 Unix 通道通过父进程只解析冻结的业务/fixture 引用；响应有界，凭据留在私有进程内存。SDK `onEvent` 报告实际递归开始、断言/观察器结果、完成和清理。普通回调使用 EvidencePolicy/脱敏，受限路径及原始 Trace 使用独立接收器。由于实时步骤事实已经发送，提供器只发送最终用例摘要。显式跳过事实来自真实 STOP/BLOCK 分支；既有服务端预期计划、顺序和完整性归约器仍是权威依据。

每次 TEST 使用全新工作目录、Playwright Context 和 fixture 命名空间，retries 为 0、`serviceWorkers:block`，并记录真实受限 Trace。Chromium 临时路径使用短私有目录，以满足 Linux Unix socket 路径长度限制。字节/文件监视器每 100ms 检查浏览器暂存、未完成下载和 Trace，默认上限为 64MiB/10,000 文件，超限时停止全部自有进程组。它不跟随 Chromium singleton 符号链接。这是带扫描/调度延迟的实测检测与停止限制，不是内核文件系统配额。规范事件缓冲限制为 4MiB/10,000 事件，耗尽时失败关闭。确认关闭后删除可重新生成的依赖/缓存；已确认完成结果与本地证据继续私有保留，供报告与保留期工作使用。

CLEANUP 使用中立的 `FixtureServiceContext`，只包含原始 workspaceId/caseExecutionId/attemptNo/namespace、fixture 专用 secretVersions/authAdapters 以及实际 fixture 环境字段。外部维护从原始 Attempt 快照取得这些内容，包括 Attempt2，绝不使用重试当前 Job 的快照；补偿主体移除业务角色固定引用。HTTP 清理不需要 Page 或浏览器，复用 SDK fixture 认证、身份及幂等契约。服务端 CLEANUP 证明只允许 fixture 身份。编译器失败时上传非空、已脱敏、含稳定错误码的 LOG，及既有不带产物包的 ERROR 完成清单。

可恢复设备轮换在既有 rotate 端点接受旧 `{}`，或 `{clientRequestId: UUID, replacementToken: 32-byte unpadded base64url}`。私有存储在 HTTP 调用前先将待确认候选 fsync，得到确认后原子替换同一主体档案。服务端仅保存前任/后继散列及请求 UUID。精确恢复仅限 rotate，且要求仍为当前、已授权的后继令牌；旧令牌绝不恢复普通设备权限。续期与有界控制操作串行执行，在启动及每 12 小时的单调时钟计划中运行。候选/请求改变、后继撤销或当前所有者/绑定撤销时均失败关闭。

Runtime 的 `lastSeenAt` 现在按已授权领取或有效心跳记录服务端数据库时间。最近 60 秒内通信的 DTO 为 ONLINE，否则为 OFFLINE，REVOKED 优先。登记和 GET 不刷新它。停止或断连后，在 TTL 耗尽前仍可能显示 ONLINE；近期通信不是物理进程证明，也不释放隔离容量。

TEST 的 `CompletionManifestV1.retrySafety` 是可选分类：`READ_ONLY_OBSERVED | WRITE_POSSIBLE | UNKNOWN`，缺省为 UNKNOWN。编译器拥有的 `ExpectedPlansV1.cases[].hasPotentialWrites` 是可选布尔值，缺省表示未知而不是 false。编译器源码分析递归纳入 WRITE 声明，以及 API/观察器中的非 GET/HEAD/OPTIONS 方法。Runtime 观察业务 Context 请求，包括 frame、弹窗、WebSocket 活动及 SDK 业务 API 调用，只保留分类。可信提供器先关闭完整业务 Context，才能确认只读；缺少关闭或观察窗口时为 UNKNOWN。认证/fixture HTTP 独立处理，Service Worker 被阻止。

原完成服务只有在真实 fixture 闭合，即可信生产器提供 `cleanupSnapshotSha256` 且清理为 SUCCEEDED，或者同时具有可信 `hasPotentialWrites:false` 与实际 `READ_ONLY_OBSERVED` 时，才入队一次整用例重试。其他失败保留原始终态，并在 Attempt 事实中记录 `retryReasonCode:RETRY_SAFETY_UNCONFIRMED`。没有 fixture 却伪报 SUCCEEDED 清理不能授权重放。无 fixture 的写入若响应丢失，绝不自动重试；真正只读的失败 Attempt 仍可在全新 Context/工作目录中重试，通过后归为 UNSTABLE。业务键查询及用户明确决定建立新 Run，不属于这个狭窄自动重试门禁。

`StepFinishedPayloadV1.status` 还接受实际中断操作的 CANCELLED。SDK 显式区分取消与操作结算，保留最先观察到的失败，不根据任意错误文字推测取消，也不消除已有失败断言。未完成断言被取消信号打断时，不发射虚构的 ASSERTION_RESULT；步骤报告中断，CASE_FINISHED 保留更早的 FAILED 业务事实。既有归约器及取消完整性规则保持不变。

T10 fix1 不再把停止时进程扫描当成正面证明。固定安装的 Linux `build/veriq_runner` 守护程序在 fork Worker 前设置 `PR_SET_CHILD_SUBREAPER`，随后保持私有启动门关闭，直到 Node 将 PID/UID/启动时间的两份身份均 fsync。此启动路径之前已经确认激活。原 Node Worker IPC 仍使用 FD3；守护专用状态/控制使用 FD4/FD5，并在 Worker exec 前关闭。内核收养机制在父进程退出后仍保留已脱离、环境为空的后代。`/proc` PPID 枚举用于向直接子进程发信号，绝不用于证明进程树为空。唯一派生门必须关闭，且 `waitpid(-1)` 返回 ECHILD 后，守护才能 fsync 其私有 DRAINED 证明；证明绑定 nonce、UID、守护与 Worker 身份。确认停止还要求守护进程退出。守护丢失、证明缺失、UID/启动时间变化或有界停止失败都保持未知与隔离；旧日志缺少进程约束证明时不会静默升级。Agent 控制通道 EOF 触发守护清理。本机 ABI 见 ADR0012。

待确认领取 UUID 现在在执行前复制到其所属私有 Attempt 日志。恢复只有在同一 UUID 成功核对后才清除 `claim-request.json`；保留的历史日志，包括没有此关联的旧日志，不能清除无关且更新的丢失请求。服务端领取、围栏和租约协议保持不变。

<a id="t11-shared-editors-and-published-source-view"></a>
## T11：共享编辑器与已发布源码视图

Web 资源和编辑器组件接收 `ResourceAdapter`，而不硬编码远端 URL。`CloudResourceAdapter` 负责经过认证的传输；`LocalResourceAdapter` 为只读适配器，只接受已经由可信宿主/提供器验证的单 Workspace 不可变快照，不实现签名验证、离线编辑或同步。React Hook Form 保存规范源文档，本地 Monaco JSON 缓冲必须显式应用。未应用缓冲会阻止保存、校验和发布；JSON 无效或发生 409 版本冲突时保留本地内容。全部八类资产提供图形控件。初始变量控件只声明类型，不填写运行时值。认证用户、Workspace 或编辑器生命周期变化时，释放源码模型/Worker，并释放或中止 Query 状态。

既有 `GET /api/v1/workspaces/{ws}/jobs/{job}` 现在包含来自活跃、保留 Attempt 的实际可选 outcome、waitReason 及安全 errorCode，不推断详细编译器路径或原始 LOG。`GET .../validation-receipt` 仍是读取成功回执的唯一既有入口，待处理或失败的验证绝不允许发布。更丰富的结构化编译诊断仍交由 T12 报告管道承接。

`GET /api/v1/workspaces/{ws}/resources/{resource}/versions/{version}/compiled-source` 要求当前 Workspace VIEW 权限，以及该资源/版本原始保留回执。没有 `path` 时，JSON 数据为 `{descriptorSha256, files: FileEntry[]}`，只列出 `validation.ts`、`source/context.ts` 和编译器用例入口 `cases/{uuid}.test.ts`。提供列表中的 `path` 时，在核对描述符成员关系、散列和长度后，以 `text/plain; charset=utf-8` 返回精确保留字节，不使用信封。响应为私有、不缓存（private/no-store），带 nosniff 和沙箱约束。不提供任意散列、本地文件系统路径、归档、原始证据或非 TypeScript 成员。生成 TypeScript 仅供只读展示，绝不在前端编译或执行。即使草稿后来改变或再次验证，已发布版本的回执和描述符也保持不可变。

<a id="t12-reports-evidence-and-diagnostics"></a>
## T12：报告、证据与诊断

`GET /api/v1/workspaces/{ws}/runs/{run}/report` 投影保留的 Run、每个 TEST Attempt、业务/清理/证据事实、补偿 Job 和统计信息，复用 CompletionService 与规范结果归约器。`gateAtExecution` 使用激活时、执行前冻结的权威信任、位置和授权；历史来源缺失时为 UNKNOWN。`gateNow` 另外检查当前 Runtime/Workspace 权限。两类投影都不改变历史结果，也不会将原本非正式的执行升级为正式执行。

`GET .../attempts/{attempt}/history?after={sequence}` 至多返回 100 个有序事件，约 1MiB，并附 nextSequence/hasMore。普通报告会脱敏冻结的凭据引用，包括已撤销版本，覆盖精确值、URL 编码和 Base64 形式，并处理敏感键。LOG、制品创建及提取变量的载荷不对普通报告开放。若凭据无法解密，则隐藏携带值的事件字段并返回 `valuesAvailable:false`。`GET .../audit?after={id}` 返回有界 Workspace 审计分页。

`POST .../runs/{run}/events/stream` 使用当前会话 Cookie、精确 Origin 和 CSRF，并由固定版本 eventsource-parser 解析 SSE。JSON 正文最多 256KiB。可选签名 `cursor` 绑定操作者/Workspace/Run，以及至多 2,000 个 TEST Attempt 序号位置，对应 1,000 个已准入 Run 变体乘两次 Attempt；游标绝不放入 URL 或 HTTP 请求头。每轮检查当前授权，并在 flush 前释放事务。即使没有 TEST 事件，当前门禁或清理补偿变化也会更新完整报告。游标无效、到期、属于其他主体或指向未来时，在首次 flush 前以 REPORT_RESYNC_REQUIRED 失败；客户端显式重新加载权威报告及历史分页，不能静默丢弃位置。后续授权错误会关闭流。认证用户、Workspace、Run 或视图生命周期变化时，消费者须中止订阅。

新编译产物包包含列入散列清单的 `metadata/report-display.json`（ReportDisplayV1）。分析器在展开传输 ID 前保留实际源步骤/断言 ID。元数据包含用例标题/key、传输/源码 ID、真实源码路径、动作名称、父级/顺序、断言 type/operator/severity/expectedSource，以及观察器 method/path，不含动作值、凭据或认证载荷。既有 ExpectedPlans 执行及归约语义保持不变。

`GET .../runs/{run}/attempts/{attempt}/display` 要求当前 Workspace VIEW、精确 Run/TEST Attempt 关联、不可变派单/描述符成员关系、散列/大小/Schema，以及预期计划 ID、顺序、父级均匹配。响应仅返回这份允许列表元数据投影和已脱敏的公开环境/浏览器字段，不提供通用散列读取器。既有不可变产物包和回执不变；历史标签缺失时明确为 ABSENT，脱敏上下文不可用时为 REDACTED。共享 Cloud/Local 报告适配器消费这份类型契约；本地适配器要求宿主已验证、不可变且只属于一个 Workspace 的快照。

`GET .../attempts/{attempt}/artifacts` 列出可用性及服务端最终生效的受限敏感等级。`GET .../artifacts/{upload}` 在暂存存储 I/O 前后均要求当前 Workspace MANAGE_ENVIRONMENT 权限（Owner/Admin）与精确 Attempt 关联。所有原始上传都保持特权访问，包括调用方标记为 REDACTED 的 LOG、HTML、Trace。响应为私有、不缓存的 octet-stream 附件，带 nosniff 和沙箱约束，不暴露直接或预签名存储 URL。HTML/JUnit/截图/Trace 是实际 Playwright 证据。特权用户可下载 Trace 并执行 `veriq trace open trace.zip`，用隔离私有临时目录在回环地址打开固定版本 Playwright 查看器。

迁移 0008 保留既有内联源码、清单及引擎读取器，并加入外部原始证据状态。默认 File CAS 使用原子、不可变发布；可选 S3 CAS 使用条件写入及有界 boto3 工作线程 I/O。上传元数据保持不可变，供完成验证使用；相同字节散列即使出现在不同证据路径，也保留各自上传与事件关联。暂存写入及 ACK 丢失后的分块重放在提交前重新核对当前围栏。MAINTENANCE 令牌操作 `artifacts/expire` 扩展既有经过认证、幂等的 HTTP 维护接口，为符合条件的旧终态 TEST 证据写入到期墓碑，保留源码/编译/引擎闭包引用，重试外部删除，并返回 410/EXPIRED；它不改变历史完整性或结果，也没有内部 Cron。

编译失败现在可携带有界 CompilerDiagnosticV1 记录，来自实际 `analyze().issues`，经既有 Worker、完成流程、Job 和编辑器管道传递。错误码和路径来自分析器，消息为静态安全文本。不安全路径明确标为 REDACTED，不能替换成虚构祖先。旧记录没有诊断时继续保持缺失。

保留期使用服务端拥有的 `Attempt.finished_at`，历史未知时允许为空。它只在完成、失联或核对导致终态转换时，按数据库 UTC 一次性写入；回执重放不重新计时。报告的 finishedAt 如实暴露这个可空值，与物理停止确认相互独立。活跃 Attempt 及没有终态时间戳的记录继续固定保留。PASSED 原始证据默认保留 14 天（artifact_success_retention_days），其他终态原始证据保留 30 天（artifact_retention_days），两者均可配置为 1～3650 天。完整元数据保留 90 天，以及成功导出包的生命周期，仍是 T14/T15 后所需的 T21 工作；T12 保留不可变源码、编译、引擎和来源制品。

原始证据按每个 AttemptUpload 关联到期：某个关联到期后保持 410，即使另一个 Attempt 后来上传相同字节也不会恢复。物理 CAS 使用服务端生成的不可变实例标识，旧键仍可读取。所有有效、活跃、源码和引擎引用均固定保留字节。外部删除前，维护持久记录具体后端/实例；重新补入数据时预留新实例，并在提交前重新核对围栏，旧的待删除任务不能命中新对象。源码晋升保留已验证内联字节，将多余外部副本安排删除。

维护的 processedCount 统计本次新到期的逻辑关联；物理删除记录独立重试，不是执行 Job。S3 bucket/endpoint 与 File 根目录属于操作员存储位置，改变它们必须进行显式存储迁移，不能只改运行配置。若存在旧 Schema 无法保留的外部字节、逻辑到期或待删除状态，则拒绝降级。

激活来源从冻结执行快照的凭据引用记录 `credentialDeliveryRequired`，与捕获的 credentialDeliveryAllowed 分开；它表示要求，不证明凭据实际已使用。若后来撤回一项所需且曾被捕获的批准，gateNow 加入 CREDENTIAL_DELIVERY_APPROVAL_REVOKED 并阻断，不改变 gateAtExecution、outcome 或凭据投递行为。旧来源没有这个区分时，保守保留其已捕获的批准要求。

T12 复审修正（迁移 0009）：外部发布意图按不可变实例持久化为 PENDING/COMMITTED/RETIRED。退役以永久、只允许创建的空围栏替换精确私有 File/S3 键，移除证据字节，同时防止晚到写入方重新创建。空证据不能绕过 RETIRED 权威状态。经过认证的 artifacts/expire 恢复被遗弃的待发布意图，并在数据库事务外重试精确退役 I/O。逻辑 processedCount 仍统计到期上传关联。这些私有安全键/日志在未来提供安全写入方退役协议前，不参与自动 90 天元数据回收；不新增公开 API、原始路径或 URL。

动态断言 JsonValue 对象若包含携带凭据的成员名，则整体隐藏为 `[REDACTED]`，避免键碰撞；普通事件协议键保持完整。保留的编译器归档允许缺少 safeDiagnostics 和 ReportDisplay 元数据，Runtime 入口让这些字段继续缺失，同时保留精确编译器/产物包来源检查。首轮报告计数显式选择 attemptNo1，不依赖 UUID 排序。

<a id="optional-ai-t13"></a>
## 可选 AI（T13）

AI 提供器的增删改查、连接测试、`/ai/context`、生成、历史、审核和取消，均是 Workspace 范围的 Cookie/CSRF API。规范 OpenAPI 与生成客户端类型定义全部有界输入。此前未实现的提供器 secretRef 字段替换为仅写 apiKey 输入和 keyConfigured 输出；业务凭据与 AI 密钥使用分离、绑定各自用途的 AES-GCM 域。迁移 0010 只新增 AI 表。

`ModelGateway.generate(DraftContext) -> ModelReply` 使用固定版本官方 SDK。`AiService.create_draft(scope, req) -> GenerationDTO` 在短权威事务中预留预算，在锁外调用提供器，然后重新核对当前授权。同步 POST 返回 201，包含已记录失败或费用未知状态；请求 UUID/正文重放返回同一生成记录，不再重复调用。历史查询使用有界签名游标。

生成结果是不可信数据。CASE 输出须通过 ResourceDocumentV1、选定引用及显式人工审核；接受结果只调用 ResourceService 的 create/update_draft。编译、调试与发布继续使用既有 Runtime 工作流。边界建议和已脱敏报告分析不能自动应用。提供器密钥、原始证据和业务凭据引用绝不进入模型上下文。

预算使用整数微美元估算，保留不可变费率/模型快照；用量未知或取消时，预算预留跨 UTC 月份继续保留。禁用提供器、预算耗尽或提供器错误不会影响确定性 Run。精确限制和验收边界见 [AI 操作](ai.md)及 [ADR0015](decisions/0015-ai-provider-boundaries.md)。

<a id="t14-signed-offline-packages"></a>
## T14：签名离线包

`BundleSelectionV1` 是规范类型，BundleCreate 为其别名。选择内容必须且只能是一份有界 CASE 版本列表、一个 SUITE 版本或一个不可变草稿验证 Job，再附环境。选择草稿要求 UNVALIDATED_DEBUG，且导出、列表、读取和下载时均检查当前 EDIT；普通已发布导出要求 DOWNLOAD。BundleDTO 标识保留的清单和快照散列。`/manifest` 是信封预览；分离签名验证的是下载 ZIP 内 `manifest.json` 的精确字节，不是重新序列化的预览 JSON。`/download` 返回私有附件 `application/octet-stream`，绝不返回预签名 URL。

归档包含 `manifest.json`、原始 64 字节 Ed25519 `manifest.sig`、`snapshot.json`、`selection.json`、`resources.json`、`assets/{version}.json`，每个已发布版本的 `provenance/{version}/{source,descriptor,receipt}.json`，以及已验证的 `compiled/{version}/{original descriptor path}` 字节。已发布包包含 `engine/inventory.json` 和已批准的包、锁与依赖元数据；操作系统/架构执行归档单独安装。仅 DSL 的 DEBUG 包增加原始 `draft/source.json`、冻结时元数据与 `engine/requirements.json`，不包含编译文件。

`IssuerTrustV1` 具有稳定发行者、单调递增修订号、有界公钥、指纹和显式撤销事实。`GET /internal/v1/issuer` 及内部包下载路由单独认证真实、当前有效的设备 Bearer，与 Web Cookie/CSRF 分离。信任刷新只接受经过认证的 HTTPS origin；显式带外绑定核对管理员确认的指纹。包内携带的密钥永不自动建立信任。发行者私有文件与 Runtime 本地映射采用不同的受限配置。

导出收集不可变且获授权的字节，在有界线程中组装 ZIP 前释放数据库锁，然后重新检查会话/成员、凭据固定引用、发行者与引擎批准。Runtime 在写入成员前验证签名，检查精确清单成员、可移植路径、完整依赖、来源和散列约束，再原子安装只读数据。经过本机验证的快照提供给既有 LocalResourceAdapter；仅 DSL 候选日期表示原始快照冻结时间，不虚构已发布版本或验证回执。SDK 用户动态 JSON 键若携带本机秘密的精确值、URL 编码值或 Base64 值，则隐藏整个对象；协议键、ID 和枚举保持完整。原始 Trace 仍受凭据访问限制。限制与操作见[离线包](offline-bundles.md)。

T14 复审修正：createBundle 要求可打印 ASCII Idempotency-Key，并同步返回 201。公开包操作只使用 WebSession+CSRF，原生 Bearer 路由继续分离。Workspace/幂等键持久绑定操作者和规范正文；重放只有在重新检查当前权限、固定引用、发行者和引擎后才返回原不可变结果。IN_PROGRESS/FAILED，以及操作者或正文变化，均返回 409，不自动接管。崩溃语义及协同配置晋升保护见[离线包](offline-bundles.md)。迁移 0012 新增 veriq_bundle_exports；0011 保持不可变。

<a id="t16-external-execution-plans-and-ci"></a>
## T16：外部执行计划与 CI

迁移 0014 新增 `veriq_execution_plans`、Run 上可空的计划/修订号/序号及服务请求者关联，并为令牌加入显式计划范围。既有员工 Run 和离线导入保持原始来源，计划关联为空。计划更新及归档要求当前 revision；列表游标绑定员工和 Workspace。写入选择限制为 20 个 Runtime、32 个角色、3 个浏览器，以及既有的 1,000 个展开变体。矩阵基数在展开变体对象前检查，不提供 Cron 字段或定时器。

`POST .../execution-plans/{plan}/trigger` 返回 TriggerReceipt 信封：`{decision: ENQUEUED|REUSED|SKIPPED, runId, statusUrl}`。首次入队为 202，重放为 200；重叠策略 SKIP 返回 200，创建终态 SKIPPED/OVERLAP_SKIPPED 且不创建 Job；REJECT 返回 409；QUEUE 按稳定的计划内序号，在较早未完成 Run 和未释放物理 Attempt 之后串行执行。继续使用既有安装锁、全局 10 个未完成 Run 上限，以及浏览器 4/2 容量限制。幂等摘要绑定调用者身份、计划 ID 和输入，不绑定可变计划设置。计划编辑后，相同键重放仍保留原始 Run，同时检查当前授权。

`EXECUTION` 令牌 24 小时后到期，要求显式 planIds 和相互独立的 trigger/read/cancel 操作范围。它们属于独立服务身份，created_by 仅保留审计归因。准入、领取、心跳、凭据解析与完成复用当前请求者授权检查。允许服务账号拥有的 Runtime 或由所有者明确共享给 Workspace 的 Runtime；不会从令牌签发员工继承其私人硬件。令牌/账号撤销、到期、Workspace/计划归档及当前 Runtime 选择/共享检查均失败关闭。`GET .../service-accounts/{account}/tokens` 只返回分页元数据，明文仅在签发响应出现。登记与维护用途不能获得执行范围。

只有限定范围的触发、单 Run 状态/取消、`/ci-report` 和 `/junit` 接受执行 Bearer。显式无效的 Authorization 绝不回退使用同时提供的 Cookie。普通 Web 写入继续要求 Origin+CSRF。普通报告/证据端点拒绝 Bearer；CI 使用安全摘要投影，不读取原始报告证据。`/junit` 要求 Run 为终态，通过标准库 XML 序列化真实用例 ID/结果，并明确记录整体门禁失败。原始 Playwright JUnit 仍是 OWNER/ADMIN 凭据受限的原始证据。断言值、请求头、业务标签及本机保险库数据不进入 CI XML。可运行的 Python 标准库客户端、退出码及外部维护分页示例见[外部调度接入](integration/external-scheduler.md)。

保留的契约修正：维护允许全部四种已登记操作，取值必须已知且唯一；历史和审计声明实际 after 查询参数；AI 上下文/取消及其他 AI 路由只声明员工 Cookie/CSRF，不提供未实现的 ServiceToken 范围。

<a id="生产静态与构建信息--production-static-and-build-information"></a>
## 生产静态与构建信息

`GET /api/v1/build-info` 使用既有严格 `BuildInfoDTOEnvelope`，不增减四个公开字段。正式模式启动时验证包内 `static/dist` 的完整库存和构建身份；`staticManifestHash` 是 `static-manifest.json` 原始字节 SHA-256，而不是 Vite 模块图哈希。没有发行输入的开发服务返回结构化 `503 BUILD_INFO_UNAVAILABLE`。完整路径、哈希循环排除、私有元数据和 T18 生成边界见 [ADR 0019](decisions/0019-production-static-inventory.md)。

<a id="桌面宿主与本机协议--desktop-host-and-local-protocol"></a>
## 桌面宿主与本机协议

桌面复用既有平台 OpenAPI，未新增 Server Run、DSL 或设备 token 模式。`DesktopBridge` 是本机内部类型边界：云端调用使用明确枚举的 `operationId`、结构化参数和契约正文，由宿主重新绑定当前 Workspace；Cookie / CSRF 只属于独立 Electron Session，设备身份只属于独立 Node24 Agent。报告流同时限制待连接与活动句柄，总计最多四条；切换工作区或注销撤销旧流。`operations.generated.*` 和宿主校验闭包由 `apps/desktop/scripts/generate-operations.mjs` 读取共享 OpenAPI 与平台模式生成，服务端新增端点不会自动扩张桌面权限。

本机启动准备使用独立的 `startupId` 和 `preparing` 状态，尚未创建 Run 时不伪造 Run ID。取消启动必须引用当前准备事务，取消执行必须匹配当前持久化 Run；旧标识不能中止新任务。离线执行的可选 `headless` 默认为 `true`，可见模式要求已探测到匹配的完整浏览器，选择与实际能力写入本机执行记录。原始证据经当前范围检查和原生确认后保存或查看，renderer 不接收文件路径或原始字节。

### 命名数据集断言

CASE 的可选 `datasetBindings` 将别名固定到当前工作区已发布的 DATASET 版本。执行快照记录相同映射，安装时逐项核对。矩阵仍由 CASE 或 SUITE 的 `datasetVersionId` 决定。
除模板调用与 `responseSchema` 外，每个断言恰有一个 `expected` 或 `datasetExpected`，并保留独立的 `expectedSource`。查询节点的 `alias` 在调用 CASE 中解析。仅键、父键和等值参数展开当前步骤或模板的显式绑定，返回值始终保持 JSON 字面内容。

| op | 参数 | 结果 |
| --- | --- | --- |
| field | key、field | 返回字段原值；缺行或未设置的字段产生 ERROR |
| contains | key | 存在对应行返回 true，否则 false |
| filter | field、equals、select | 按冻结行顺序返回匹配行的 select 字段。严格 JSON 等值，缺字段不匹配 null，匹配后缺少投影字段产生 ERROR |
| path | key | 从树根至目标的键序列，包含根与目标 |
| children | parentKey | 直接子节点键，按 order 再按键排序。null 选择根节点，叶节点返回空数组 |

查询错误产生 ERROR，即使断言为 WARN。正常比较失败继续沿用原严重性。查询断言事件使用空预期和缺失实际值来避免传递数据正文。

## 联网静态数据传输

经核验的发行库存分别记录编译器和 Runner SDK 声明的联网协议。只有两个组件均声明 2.0 才对外报告该能力。
旧库存缺少声明的组件仍可执行兼容的无数据任务。含数据集的在线验证或测试任务领取时要求客户端声明 `connectedDatasets: "2.0"`。
`ConnectedSourceSnapshotV2` 保留原始源摘要、原始规范字节摘要以及依赖的顺序。
每项数据集只携带资源和版本身份、字段声明、资产摘要和文档摘要。
`ConnectedExecutionSnapshotV2.selectedRow` 保存版本、行键及执行行的规范摘要。
控制面保留完整冻结源，普通 Attempt 内容下载只授权投影和已验证的产物。

设备通过 `POST /internal/v1/attempts/{attemptId}/datasets/static` 指定 `VALIDATION_SOURCE`、
`DATASET` 或 `ROW`。请求复用当前设备、租约、围栏和请求者权限。验证源只属于本次受管验证任务。
测试编译器在内存中重建整个原冻结闭包并重算源码与编译包摘要，因而可读取该闭包内的静态版本。
浏览器用例只恢复本例声明的别名，矩阵行只接受当前变体的版本和键。
私有 IPC 使用最多 32 KiB 原始字节的有界分段，完整载荷上限 16 MiB，先验证 SHA-256 再解码。

历史含数据编译包通过受管验证任务从原发布快照重新编译。执行请求者须有当前派发权限，
原始发布人的后续权限变化不改写历史版本或回执。被批准的同一引擎必须提供联网投影能力；
缺少该能力时验证失败，测试保持阻断。验证投影和文件传输不构成对离线数据的授权。
