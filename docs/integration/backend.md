# VeriQ 后端接入规范 / Backend integration

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

## Runnable sample and exact SDK contract

T07 ships a runnable controlled Python/Tornado demo at `fixtures/demo-app/app.py` and HTTP lifecycle clients in `@veriq/runner-sdk`. The demo persists fixture ownership, closed namespaces and employees in SQLite. It is a sample target, not the MySQL-backed VeriQ control service. Tests exercise this target with real Chromium and real HTTP; they do not certify arbitrary customer Java/Spring or Python deployments.

Start the demo with the service Python environment and externally supplied configuration:

```sh
export VERIQ_DEMO_DATABASE=/restricted/demo.sqlite
# Supply three distinct random tokens (at least 24 characters) through your secret manager:
# VERIQ_DEMO_BUSINESS_TOKEN, VERIQ_DEMO_FIXTURE_TOKEN, VERIQ_DEMO_MAINTENANCE_TOKEN
apps/srv/.venv/bin/python fixtures/demo-app/app.py
```

It listens on loopback port 8090 (`VERIQ_DEMO_PORT` overrides it). Put an authenticated TLS terminator in front of non-local deployments. Test-support barrier routes live only in `fixtures/test-support/server.py`; the normal demo has none. The HTTP contract is documented in `fixtures/demo-app/openapi.json`.

Prepare receives `{workspaceId,caseExecutionId,attemptNo,namespace,idempotencyKey,input,ttlSeconds}`. The exact idempotency key is `workspaceId:caseExecutionId:attemptNo`. Repeated identical requests return the same fixture ID; altered parameters return 409. The client validates explicit `CaseDslV1.fixtureInput` against the pinned Fixture inputSchema before authentication or network calls. `CaseDslV1.initialVariables` declares allowed initial names and ValueType types (for example `{"name":"string"}`); actual values remain in frozen `ExecutionSnapshot.variables`. Every declared key must be present and correctly typed before authentication. Inputs resolve only these declared initial variables plus the selected data row, never future fixture outputs. Inputs never implicitly include all execution variables. Prepare returns `{fixtureId,namespace,variables,cleanupToken}`; variables validate against outputSchema before assignment. Cleanup sends the same ownership fields and optional cleanupToken in a POST/DELETE JSON body. Query uses GET with idempotencyKey, never the token.

Fixture calls use Environment.fixtureIdentity and fixtureBaseURL. Ordinary UI/API permission checks use the selected business role. `HTTP_BEARER` takes local/resolved `{token}` and verifies identity at identityPath. `HTTP_SESSION` POSTs the credential JSON to loginPath and verifies identityPath; both extract the identity using identityPointer and require it in allowedIdentityIds. These bounded built-ins support common token and HTTP session login integrations. Custom SSO/MFA flows or customer-specific response transformations are not implemented. Credentials and adapter versions are created/revoked through the Workspace APIs; no authentication code upload exists.

The business endpoint attaches every created resource to a namespace and checks that namespace is OPEN and unexpired inside the same transaction as its write. Cleanup marks the namespace CLOSED and deletes only its owned resources in one transaction. It keeps a closed tombstone, including when prepare has not yet returned. A late UI/API commit must fail after cleanup. The test suite holds a business validation operation after the server accepts it, cleans the fixture, then resumes the operation and verifies 409 and resource removal. Duplicate cleanup alone is not this guarantee.

External scheduling invokes authenticated `POST /maintenance` with `{limit:1..100}` using the independent maintenance token. It returns `{processed,hasMore}` and is safe to repeat. There is no internal Cron. Worker death requires this external TTL reconciliation even if no cleanup receipt/token was returned. Customer Java/Spring and Python services should implement the same transaction/ownership guarantees using their own database; calling DELETE from a browser finally block is insufficient. Retain closed namespace tombstones for the full retry/idempotency window. The demo retains them indefinitely.

The SDK exports `prepareFixture`, `cleanupFixture`, `createHttpLifecycle`, `LocalCredentialProvider`, and `EvidencePolicy`. `LifecycleContext.fixtureInput` carries resolved input separately; cleanup accepts an undefined token and relies on the stable namespace/key. Clients abort isolated requests on their signal, never replay writes across redirects, and dispose authentication sessions. `LocalCredentialProvider` accepts only exact Workspace/reference/version mappings; T20 supplies OS-vault/restricted-config integration. It has no platform-network fallback.

Raw screenshots, Trace and downloads are restricted evidence. Ordinary reports retain redacted structured steps/assertions/errors and artifact metadata, without raw local paths or bytes. `EvidencePolicy` can collect real screenshots and Trace into mode-0700 directories/mode-0600 files. Explicit trusted local credential-evidence capability is required for raw access. The control service applies Workspace-scoped MANAGE_ENVIRONMENT authorization before granting restricted artifact access. Raw Trace remains viewable with the pinned Playwright Trace viewer by an authorized operator; do not upload it to a public service. Sessions are held in isolated memory contexts; no storageState file is written by these adapters.

The normal control-service factory injects `DatabaseAttemptProofVerifier`. It authenticates device authorization and lease/fencing headers, checking the active assignment, current Workspace membership, environment/device grants, server-granted MANAGED trust and exact pinned role/fixture references under the installation authority transaction. A caller's trust labels never establish authority. T09/T10 freeze registry records and hash the full ExecutionSnapshot before assignment. Signed offline profiles contain only non-secret configuration and references. T12 provides restricted artifact storage and authorization, and T11 provides management editors. Final whole-product and installed-platform acceptance remains tracked in the milestone ledger.
