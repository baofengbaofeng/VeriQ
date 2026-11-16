# Java / Python HTTP 后端接入

VeriQ 通过正常 HTTP 认证、固定 OpenAPI 和 fixture 生命周期与被测后端交互。控制服务仍使用 Python3.12/Tornado/MySQL8.4；Java 不成为另一套控制服务或执行引擎。精确字段见[后端规范](../integration/backend.md)和[Schema](../../packages/contracts/schemas/platform-v1.schema.json)。C06 的新增代码尚未执行或复审。

## 可使用的源代码

| 示例 | 入口 | 存储 / 作用 |
| --- | --- | --- |
| Python/Tornado 服务 | [app.py](../../fixtures/demo-app/app.py) | SQLite；真实 fixture 所有权、关闭墓碑、员工、事务 |
| Python 标准库调用方 | [lifecycle.py](../../fixtures/integration/python/lifecycle.py) | 无附加包；真实 prepare/query/write/read/cleanup |
| Java Spring Boot2.3.1 | [独立 Maven 工程](../../fixtures/integration/spring-boot-2.3.1/) | Java11；POSIX 私有 JSON 原子快照、单进程文件锁 |
| 实际业务契约 | [Python OpenAPI](../../fixtures/demo-app/openapi.json)、[Java OpenAPI](../../fixtures/integration/spring-boot-2.3.1/src/main/resources/openapi.json) | 两份均明确正常 Bearer 身份、字段和响应 |

Java 示例固定客户要求的 `2.3.1.RELEASE`，仅属于独立接入样例；主仓库未新增 Java 构建依赖或锁。它共享 Python demo 的静态 UI 源码，采用同一目录和 DSL。JSON 快照用于小型受控示例，客户生产数据库必须用事务/行锁实现同样的不变量，不能把本示例当成多实例数据库服务。

## 认证与请求关联

业务 editor、fixture-service、maintenance 使用三份不同外部令牌。`GET /me` 必须返回实际身份，环境/凭据版本分别限制 allowedIdentityIds；HTTP200但身份不符仍失败。权限用例使用普通业务身份；fixture 高权限只用于准备/查询/清理。平台员工会话、设备身份、业务认证、外部 EXECUTION token 和 MAINTENANCE token 互不替代。

每个真实响应都有 `X-Request-Id` 与 `X-Build-Sha`；业务日志保留 requestId、非秘密业务 key、错误码、build SHA，禁止保存 Authorization、Cookie、密码或 cleanupToken。`GET /build-info` 返回实际目标版本，Run 中冻结的 buildSha 必须与部署目标核对。网关如已有 requestId，应定义可信入口及长度/字符规则，不直接反射任意外部值。

内置适配器支持 HTTP_BEARER 和 HTTP_SESSION 固定配置，不接收任意登录脚本。示例导入选择 HTTP_BEARER；Python 服务另提供 `/login`，Java 样例不实现 session 登录并已从自身 OpenAPI 移除该路由。企业 SSO/MFA 由业务正常集成提供，不用 fixture 身份跳过真实登录。

## Fixture 契约和一致性

准备 JSON：

```json
{
    "workspaceId":"<workspace-uuid>",
    "caseExecutionId":"<case-execution-uuid>",
    "attemptNo":1,
    "namespace":"veriq-example-<unique-attempt>",
    "idempotencyKey":"<workspace-uuid>:<case-execution-uuid>:1",
    "input":{"name":"VeriQ synthetic employee"},
    "ttlSeconds":300
}
```

POST `/prepare` 返回 fixtureId、namespace、cleanupToken、variables；输出变量严格为 `{"code":"employee-..."}`。code 是非秘密归属关联值，供 UI/业务请求解析 namespace；不是认证凭证。输入/输出 Schema 在网络调用及变量赋值前分别校验，SDK 不把所有 execution 变量自动塞进 input。

同键同完整参数返回同结果，不延长原 TTL；同键不同参数、已 CLOSED 或 namespace 冲突409。每次整用例重试使用全新 Attempt、Context、工作目录和 namespace；不可复用上一轮存储状态掩盖失败。

GET `/query?idempotencyKey=...` 只返回 fixtureId/namespace/state，禁止回传 cleanupToken。准备响应丢失时先查询是否实际创建；重发相同 prepare 可取得原结果，变更参数不得重放。清理 POST/DELETE `/cleanup` 使用相同身份信封，可带 cleanupToken；已具受限 fixture-service 身份时允许不带 token 补偿丢失的准备响应，显式错误 token 必须403。清理只能作用该 key 和 namespace 的对象，重复安全并保留关闭墓碑。

业务 POST `/employees` 和只读 GET 接受恰好一个 namespace 或 code。关键写入的 OPEN/TTL 检查与插入在同一数据库事务/存储临界区；cleanup 在同一序列中先 CLOSED 再删精确归属员工。事务外先查 OPEN 再另行插入会让晚到请求在清理后复活，不能采用。

业务写入本身没有“恰好一次”承诺。发生超时/中断应按公开业务键查询真实结果，不能因为 fixture prepare 幂等就盲目重发业务 POST。若业务需要写入幂等键，需由业务契约提供唯一约束和同键参数冲突语义，更新 OpenAPI/用例并保留真实结果。

## Python 服务与调用方

按[示例快速开始](sample-workspace.md)准备三份秘密环境、私有 SQLite 目录与目标 build。现有服务环境已经提供 Tornado，不创建第二套依赖环境。调用方使用任意 Python3.12 标准库：

```sh
python fixtures/integration/python/lifecycle.py \
    --base-url http://127.0.0.1:8090 --build-sha example-build-001 \
    --workspace '<workspace-uuid>' --probe-contract
```

命令创建合成数据，验证两类正常身份、准备重放、变更参数409、fixture 冒充业务写入403、editor 调用准备403、真实持久化 GET、finally 清理和重复清理。它真实发送请求，不可针对未授权业务环境运行。网络错误不自动重试，任何失败退出非零；没有输出 token、cleanupToken 或完整响应。该 HTTP 命令不运行浏览器，不能代替 UI/SDK 验收。

## Java Spring Boot2.3.1

前置：独立开发 JDK11/Maven 环境、允许获取已固定 Maven 依赖、POSIX 文件系统及私有目录；本轮没有安装、下载或运行。三个 `VERIQ_DEMO_*_TOKEN` 与 Python 示例角色名称相同，但两个服务应使用各自独立值。

```sh
umask 077
mkdir -p /tmp/veriq-java-private
export VERIQ_JAVA_DATABASE=/tmp/veriq-java-private/fixture.json
export VERIQ_JAVA_WEB_ROOT='<repository-absolute-path>/fixtures/demo-app'
export VERIQ_DEMO_BUILD_SHA=java-example-build-001
mvn -f fixtures/integration/spring-boot-2.3.1/pom.xml package
java -jar fixtures/integration/spring-boot-2.3.1/target/veriq-fixture-example-0.1.0.jar --server.port=8091
```

默认只监听127.0.0.1，必要时通过 Spring 正常参数配置受控监听与 TLS 代理。数据库目录/文件不得符号链接，目录无组或他人权限；存储和 `.lock` 文件私有。文件锁拒绝两个实例同时运行。存储先写私有临时快照、force并原子替换后更新内存；同目录原子 move 不支持时失败，不退回可能产生半写的替换。示例未实现高可用、目录 fsync 级掉电保证或客户数据库事务适配。

用上面的 Python 客户端改 `--base-url`、`--build-sha` 即可调用 Java。要运行浏览器 DSL，导入器的 `--demo-url` 指向 Java origin，三份秘密与该服务匹配，`VERIQ_JAVA_WEB_ROOT` 提供同一 HTML/JS。Spring jar 自身包含 `/openapi.json`，不会从运行主机任意路径读取契约。

## 外部补偿、故障与交付

外部中间件用独立 maintenance Bearer POST `/maintenance`，`{"limit":100}`，根据 `hasMore` 连续处理；不存在内部 Cron。平台的 fixture reconcile 接口另行安排具备网络和凭据能力的 Runtime 清理任务，不能只清空队列或强制释放未知进程容量。

必须验证准备响应丢失、部分准备失败、错误/缺失 cleanupToken、其它 namespace 清理拒绝、清理后晚到写入、Worker 退出、TTL 到期和服务重启。普通的“创建→删除→再次删除”无法证明并发隔离。后台异步结果使用有总时限的 GET 轮询，禁止轮询中重复写订单或审批。

客户交付固定 OpenAPI、错误码/状态、请求关联、真实 build、正常身份、输入/输出 Schema、清理所有权、事务边界、维护部署配置及 Runtime 网络/TLS 可达说明。记录通过与失败，不把本文源码或示例结果外推成客户接入通过。下一步执行[V06](../validation/tasks/V06-integration.md)。
