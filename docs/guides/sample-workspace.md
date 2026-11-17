<a id="导入和运行-veriq-示例-workspace"></a>
# Sample Workspace

本指南使用真实平台 API、真实受控业务服务和实际 Runtime 编译发布。C06 源码尚未执行；以下命令由后续 V06 在隔离环境运行，不代表已有通过报告。导入器不触发 Run，不写数据库行，不调用内部完成回执。正式示例模块和七类 JSON 现在随 `veriq-server` wheel 安装；控制服务主机无需 Git、Node 或仓库目录。

## 1. 准备控制平台和受控业务

按[开发指南](../development.md)准备 Python3.12、MySQL8.4、Node24 和固定仓库依赖；生产则使用[发行说明](../release.md)中的候选安装步骤，并保留未验收状态。先完成平台 setup 和员工登录，导入员工需为示例空间 Owner/Admin，不能只授予系统管理员而不授予空间成员身份。

选择私有、非生产数据目录；秘密由操作者的秘密管理器注入环境，不放在命令参数、仓库、日志或截图中。以下假定已提供 `VERIQ_DEMO_BUSINESS_TOKEN`、`VERIQ_DEMO_FIXTURE_TOKEN`、`VERIQ_DEMO_MAINTENANCE_TOKEN` 三个互异、至少24字符的随机值。

```sh
umask 077
mkdir -p /tmp/veriq-example-private
export VERIQ_DEMO_DATABASE=/tmp/veriq-example-private/demo.sqlite
export VERIQ_DEMO_BUILD_SHA=example-build-001
apps/srv/.venv/bin/python fixtures/demo-app/app.py
```

路径从仓库根执行。服务默认 `127.0.0.1:8090`；`VERIQ_DEMO_PORT` 和 `VERIQ_DEMO_BIND` 可覆盖端口与监听地址。需要远程/容器访问时显式配置受控监听和 TLS 反向代理；不要把 demo 直接暴露给公共网络。`GET /build-info` 返回目标 SHA，每次响应有服务端 `X-Request-Id` 和 `X-Build-Sha`。`/openapi.json` 为实际业务契约。

| Runtime 位置 | `--demo-url` 应填什么 | localhost 的真实含义 |
| --- | --- | --- |
| 与 demo 同一台主机 | `http://127.0.0.1:8090` | 当前 Runtime 主机 |
| 独立 Runtime 容器 | 容器可达的 HTTPS demo 入口 | 容器自身；不能指向宿主机或控制容器 |
| 员工桌面 / Mac | 桌面主机可达的 HTTPS demo 入口 | 员工桌面自身；不能指向云端 |
| 另一台云端 Runtime | 云端可达的 HTTPS demo 入口 | 该云端 Runtime 自身 |

导入器要求 origin 形式、无路径/用户信息；非 loopback 使用 HTTPS。固定 `allowedOrigins` 不授权任意重定向；业务 UI、API、fixture 如需不同 origin，应在环境草稿中明确逐项设置并重新验证发布。

## 2. 创建空间，再授权 Runtime

导入器的 HTTP 客户端使用 Python 标准库，入口为已安装模块 `python -m veriq_server.examples.bootstrap`。源码开发使用 `apps/srv/.venv/bin/python -m veriq_server.examples.bootstrap`，仓库 `fixtures/sample-workspace/bootstrap.py` 仅兼容转交同一模块，必须使用已安装或 editable 安装控制服务的 Python 环境，不会隐式注入仓库路径。进度文件保存 UUID 和非秘密配置，权限0600；父目录不得组/他人可写。`--server` 必须是平台实际 `public_url`，开发时通常是 Vite 的 `http://127.0.0.1:5173`，通过它代理 API；直接用后端端口却发送不同 Origin 会失败。

```sh
python -m veriq_server.examples.bootstrap \
    --server http://127.0.0.1:5173 \
    --email admin@example.com --workspace-key veriq-demo \
    --state /tmp/veriq-example-private/import.json --workspace-only
```

密码通过隐藏提示输入；无人值守可用私有 `VERIQ_BOOTSTRAP_PASSWORD` 环境。Cookie/CSRF 只在进程内存，退出尽力登出；登出失败时在 Account 的会话管理撤销该临时会话。

在 Runtimes 页或既有 Runtime CLI 中把设备绑定到返回空间。按[Runtime 登记说明](../development.md#runtime-enrollment-and-doctor-t08-development-cli)分别完成：所有者明确同意共享、系统管理员 MANAGED 信任、空间管理员凭据投递授权、实际批准的引擎库存、真实 Worker 启动。登记成功仅表示设备身份成立，OFFLINE 设备不能执行。编译不需要业务密钥，但不能绕过引擎库存和 MANAGED 回执门禁。本文不自动创建或晋升引擎。

## 3. 导入、校验、发布与建立计划

保持原三个业务服务环境令牌；业务和 fixture 两份会被加密写入平台，maintenance 不导入普通环境。执行设备须有本空间派发权，CLI 按管理员提供的真实设备 UUID 调用：

```sh
python -m veriq_server.examples.bootstrap \
    --server http://127.0.0.1:5173 \
    --email admin@example.com --workspace-key veriq-demo \
    --state /tmp/veriq-example-private/import.json \
    --runtime-id '<runtime-uuid>' \
    --demo-url http://127.0.0.1:8090 --build-sha example-build-001 \
    --locale en-US --timezone UTC --validation-timeout 300
```

| 顺序 | 创建内容 | 固定依赖 / 用途 |
| --- | --- | --- |
| 身份 | HTTP_BEARER `/me` 适配器；`demo_business` / `demo_fixture` 密钥版本 | editor 普通业务身份与 fixture-service 服务身份分离 |
| 1 | ELEMENT_CATALOG | 表单作用域、稳定 veriqId、行 recordKey |
| 2 | DATASET | latin / unicode 两条合成姓名 |
| 3 | FIXTURE | `/prepare`、`/query`、`/cleanup`、1800秒 TTL、严格输入/输出 |
| 4 | FLOW | 带 name 参数的公共填写步骤 |
| 5 | CASE | 导航到真实 fixture code、调用流程、观察写请求、提取 id、刷新和只读持久化检查 |
| 6 | SUITE | 固定 CASE/DATASET 版本、editor、chromium |
| 7 | ENVIRONMENT | 实际业务 origin、locale/timezone/build SHA、固定身份版本 |
| 最后 | HTTP 执行计划 | 固定套件/环境/设备、QUEUE、0次整用例重试、空初始变量 |

规范模板位于已安装 `veriq_server.examples` 包内的 `data/manifest.json` 和 `data/assets/*.json`，API 与 CLI 均通过 `importlib.resources` 读取，不从当前目录或请求参数找资源。仓库 `fixtures/sample-workspace` JSON 只是文档兼容副本，正常发行阶段检查其与规范包逐字节一致。模板中的 UUID 是示例依赖别名，原始 JSON 符合已有 DSL 结构；导入时全部重写为当前空间 API 返回的真实版本。模板没有 validation receipt 或编译 hash。CASE 的 `{{vars.code}}` 来自已校验 fixture 输出，`employeeId` 来自真实响应提取，`data.name` 来自数据集。

每类资源遵循同一协议：创建草稿 → GET `validation-preview` → 用返回 revision/sourceHash POST `validate` → 轮询真实 Job → 读取真实 `validation-receipt` → POST `publish`。202 只是排队；超时/失败退出非零，不发布假版本。恢复使用相同空间键、状态路径、URL、SHA 和语言参数；已发布内容不一致、草稿被编辑或计划变化时停止，另建空间键可独立重做。凭据创建响应丢失而本地未保存版本时，需要管理员从凭据元数据核对并恢复状态或使用新空间，不能猜测密钥版本。


## 使用管理台真实导入向导

在 Workspaces 页打开“导入示例 Workspace”按钮。向导以当前员工和空间为作用域；没有空间时可先创建或打开空间，再去 Runtimes 完成实际授权。它通过已认证的 `GET /api/v1/examples/sample-workspace` 读取当前安装包中的 manifest、七类 assets 和实际 JSON 字节散列，响应沿用 `data/requestId` 信封，未登录不能读取。

填写从实际 Runtime 可达的业务页面/API/fixture origins、真实目标 build、locale/timezone、业务 roleKey、两类允许身份及授权 Runtime。可选择已有 HTTP_BEARER 适配器和未撤销的凭据版本，或输入两份新令牌创建加密凭据；密码字段提交后清空，令牌不进入浏览器存储、查询缓存或日志。字段 label/veriqId 不包含 tokenId/secretVersionId。

点击“开始或恢复导入”后，页面显示真实 Job 状态和等待原因，依次发布资产并创建固定套件/环境/设备的 QUEUE 计划。未完成编译、失败、取消或超时不会显示已发布成功。停止按钮只停止本地请求和轮询；已经接受的远端 VALIDATE 作业仍可能继续，界面不会声称远端进程已停止。

恢复元数据使用当前员工和 Workspace 专属 sessionStorage，包含公开选择指纹、模板来源、已完成版本及计划 UUID，不含秘密。重新开始会读取实际资源头、草稿和作业，复用同一服务端校验键；已修改的草稿、发布内容、环境选择或计划拒绝覆盖。清除恢复标记只删除浏览器元数据，不删服务器对象、不撤销凭据；配置变化应使用独立空间。新建凭据响应丢失时不要猜测版本，重新读取授权元数据后明确选择已有版本，或由管理员检查后在独立空间重做。

向导使用平台既有 Cookie/CSRF/会话过期传输，不调用服务器内存长任务，不自动授权 Runtime、不晋升引擎、不发模型请求，也不自动触发 Run。成功后进入执行计划页手动运行或按下节使用受限 HTTP 调度。全局中英语言由应用共享 i18next 管理，机器状态及标识保持原值。

## 安装与发行资源边界

正常 `scripts/build_release.py` 调用 `stage_examples`，对规范模块、manifest 和七份资产记录 run 内 `examples-source-inventory.json`，并把该库存放入发行 evidence/manifest。所有规范资源仍为跟踪源码，不在构建或 API 进程内生成代码。wheel 使用现有包布局包含 `examples/**`，完整性仍以 wheel RECORD 和既有源码绑定为准；该散列清单不表示受管理编译或安装验收通过。

新入口源码已交付但尚未实际构建 wheel、无仓库安装或 GUI 运行。后续必须在仓库外、无 Node/Git 的已安装 Python 环境复现模块 `--help`、资源读取和真实 API 导入；再完成 GUI 成功、恢复、取消及权限拒绝。具体执行表见 [V06](../validation/tasks/V06-integration.md)。被测 demo 服务是独立目标，安装控制服务不会自动部署它，需先按本指南配置可达地址与正常身份。

## 4. 手动或 HTTP 触发

在 Plans 页查看真实套件、环境、角色及 Runtime 选择，手动触发后打开 Run 报告。预期每次有两个独立数据行执行，每行有单独 fixture/Attempt。默认 Playwright retries=0，示例计划 maxCaseRetries=0；修改重试时整用例最多一次，第二次通过为 UNSTABLE，不能当 PASSED。

外部调度使用空间服务账号的独立 `EXECUTION` token，限制本计划的 `trigger/read/cancel`。设备必须属于服务账号或由所有者明确共享；员工有权运行不意味着服务账号自动有权。授权后复用[现有标准库 CI 客户端](../../scripts/veriq_ci.py)：

```sh
python scripts/veriq_ci.py \
    --server http://127.0.0.1:5173 --workspace '<workspace-uuid>' \
    --plan '<plan-uuid>' --key example-001 \
    --build-sha example-build-001 --timeout 1800 \
    --junit /tmp/veriq-example-private/junit.xml
```

`VERIQ_CI_TOKEN` 通过私有环境注入；新触发用新幂等键，重放同次请求保持键与正文完全一致。CI 成功必须是终态 PASSED、有真实用例且执行时/当前门禁都通过。下载原始 Trace、截图或 HTML 是另一个受限证据权限，执行令牌不可替代。完整协议见[外部调度](../integration/external-scheduler.md)。

## 5. 清理与保留失败现场

SDK finally 按原信封清理；外部调度以独立 maintenance 身份 POST demo `/maintenance`，正文 `{"limit":100}`，按 `hasMore` 继续，处理崩溃/失联后的 TTL。它与平台 `/internal/v1/maintenance/fixture-cleanups/reconcile` 是不同服务，平台接口用于安排授权 Runtime 补偿，不应混用 token。

确认没有活动 Run、待处理清理、未知进程或未到期 fixture 后，再关闭 demo 并移除本次私有 SQLite 及 WAL/SHM 文件。先保留脱敏失败记录，不能删库把清理失败改成通过。归档计划/资源/空间、撤销服务令牌和示例密钥版本均通过平台管理界面完成；归档不等于物理删除历史记录。本脚本不提供静默销毁命令。
