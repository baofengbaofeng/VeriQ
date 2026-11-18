# Development

<a id="developing-veriq"></a>

安装、用户账户、Workspace 管理及版本化资产 API 已实现。当前页面基于真实 MySQL 记录提供初始化、登录/退出、密码重置、账户/会话控制、全局用户管理、Workspace 选择、成员和邀请功能。确定性编译器、Runner SDK、内置 HTTP 业务/fixture 生命周期 Provider，以及版本化凭据/认证 API 均已实现。Runtime 登记、所有者控制的共享、独立硬件信任与 Workspace 凭据投递、开发 CLI/doctor 已实现。资产编辑/发布、真实 Linux Agent/租约集成及受限报告/存储已通过任务审查。AI 实现也已通过代码审查，获授权的真实 Provider 验收仍待进行。签名资源包导出/验证、签发者信任及精确本机凭据引用均已通过各自任务审查。离线执行/导入已通过任务审查。服务端发行工具已经代码审查但尚待验收；桌面客户端和正式分发仍在开发。

登录后打开 **Workspaces** 创建项目 Workspace，创建者成为 OWNER。OWNER/ADMIN 可通过可复制链接或已配置的 SMTP 邀请成员。已有账户在接受邀请页登录；新受邀者创建普通账户。邀请令牌从地址栏移除并保存在页面内存中，因此完整刷新后须重新打开原链接。全局系统管理员身份不授予项目成员资格。

Workspace 成员可切换空间并查看自身角色。OWNER/ADMIN 可管理允许的成员关系；只有 OWNER 可授予所有权或归档 Workspace。没有接任者时，不得移除、降权或停用最后一位启用中的 ACTIVE OWNER。归档 Workspace 只读，目前 API 没有恢复操作。资源、设备、执行、报告和 AI 服务均使用这一范围边界。

资产 API 客户端可在 Workspace 内创建、修订全部八类资源，检查钉选依赖并读取不可变发布版本。先读取 `validation-preview`，再将返回的修订号/源码摘要提交给 `validate`。这会创建真实的排队 VALIDATE Job；Linux Agent 使用批准引擎库存、真实编译及受 fencing 约束的完成协议处理它。没有公开端点会伪造校验成功。当前权限、摘要、入口和发布契约见[契约文档](contracts.md)。

编译器校验全部八类资产，生成确定性 TypeScript、源码上下文及已核验依赖文件。可执行编译要求真实引擎发行字节。编译器保留隔离的夹具发行测试；SDK 还会离线安装真实 SDK/契约 JavaScript 与依赖归档，对生成 TypeScript 做类型检查并在 Chromium 中执行。内置认证/fixture Provider 及 Linux Agent 组装已有真实后端/浏览器证据；原生发行打包仍是后续任务。见[编译器契约](contracts.md)和 [ADR 0006](decisions/0006-deterministic-compiler-artifacts.md)。

凭据管理 API 要求 Workspace OWNER/ADMIN，只返回元数据而不返回明文。业务身份与 fixture 身份分离、版本钉死，并通过不可变认证注册表配置。内部解析器要求当前设备/Attempt 权威状态及独立批准的凭据投递。[后端接入指南](integration/backend.md)涵盖受控 Tornado/SQLite 测试目标、幂等 fixture 生命周期和补偿；该目标不替代平台 MySQL 数据库。原始 Trace/截图/下载文件具有受凭据限制的敏感级别，并要求独立的当前报告权限。初始变量声明只含类型，实际值另行冻结，并在副作用发生前校验。

Runtime 页面支持真实设备码批准及部署服务账号。实际 worker 运行前，注册状态为 OFFLINE；能力报告不代表批准引擎发行。开发 CLI 支持显式退出恢复，包括不执行远端撤销的 `--local-only`。当前已知 UI 问题：无效或过期的已认证批准码被误分类为会话过期；该问题已纳入完整错误处理整改，不会撤销服务端会话 Cookie。

使用[契约文档](contracts.md)中的精确工具链。在仓库根目录安装依赖：

```sh
uv sync --project apps/srv --frozen --all-groups
pnpm install --frozen-lockfile
```

全组同步会安装用于严格检查 S3 的四个精确 dev 输入。`boto3-stubs[s3]` 与 `mypy-boto3-s3` 均为 `1.44.0`，
`botocore-stubs` 为 `1.43.126`，`types-s3transfer` 为 `0.19.3`。核心声明与运行时 botocore `1.44.0` 的兼容范围限于已核对的接口。
服务生产依赖、56 项冻结发行需求与 SDK 运行版本继续使用原有锁定值。
生产源码引用 `mypy_boto3_s3` 时，仅在 `TYPE_CHECKING` 中导入，并使用字符串注解或延迟求值。详见 [ADR 0027](decisions/0027-sdk-type-stubs.md)。

注释工具也要求先完成上述冻结全组 Python 同步，不能依赖全局偶然安装的 tree-sitter。
在仓库根运行：

```sh
pnpm lint:comments
uv run --project apps/srv --frozen --no-sync python scripts/comment_audit.py --output /tmp/veriq-comment-audit.json
```

`lint:comments` 同样通过 `uv run --project apps/srv --frozen --no-sync` 使用服务解释器，不自动联网补装或执行源码。
按需加载的 Shell / CSS / Java parser 会核验精确版本及 ABI，缺包、坏语法、missing 节点或不可信范围直接失败。
Shell 只接入 `.sh` 与精确 preinstall 路径，并要求首行 `#!/usr/bin/env bash` 或 `#!/bin/sh`；
shebang 保留代码计数，不能算说明。CSS 仅接受直接位于 stylesheet / block 且没有函数参数祖先的 comment，
函数、声明等其他注释上下文会明确报 unsupported（包括未引号 URL 中被 grammar 误标的伪注释）。
这些边界见 [ADR 0026](decisions/0026-trusted-comment-parsers.md)。库存与列宽枚举仍不依赖可选 parser。
Java 原始 UTF8 中任何 ASCII 反斜杠紧跟小写 `u` 都在 parser 构造前整文件拒绝，不判断资格或转译。
因此一些合法 escaped literal 也保守失败；不提供 Unicode normalizer 或完整 JLS 保证。
未紧跟 LF 的原始 CR 也在 parser 构造前整文件拒绝，包括合法文本块中的裸 CR。LF 和完整 CRLF 继续支持。
固定语法可能把裸 CR 后的代码并入行注释，而 JLS §3.4 / §3.7 将裸 CR 识别为行终止符，见上述 ADR。
其余 `.java` 使用固定 tree-sitter-java 0.23.5 的真实行 / 块注释，Java ABI 14、Shell / CSS ABI 15。
审计与排版共享成熟范围及原始坐标，坏输入不输出部分报告，也不从源码分母静默排除。
SCSS / LESS、HTML、native 等未支持比例语言继续阻断；YAML / GYP 嵌入代码分类仍待研究。
全仓比例必须严格大于 40%；`ratio=None` 时只有支持子集的 `observedRatio`，不代表全仓通过，也无逐文件配额。

使用专用 MySQL 8.4 数据库、InnoDB 和 utf8mb4。在 VeriQ 外准备数据库及用户，并授予该库的 Schema 迁移与应用访问权限。随着运维能力完善，生产部署应分离迁移凭据和运行凭据。连接初始化使用 UTC 与 READ COMMITTED；迁移拒绝其他 MySQL 发行系列。开发测试不得使用共享生产数据库。

交互初始化本机配置；命令私下提示输入形如 `mysql+asyncmy://USER:PASSWORD@HOST:3306/DATABASE` 的异步 MySQL URL：

```sh
uv run --project apps/srv veriq_server --config /private/veriq/veriq.json --public-url http://127.0.0.1:5173 --environment development init
```

请使用运维人员拥有的可写目录替代 `/private/veriq`。`init` 以独占创建及 0600 权限写入配置和相邻的 `veriq.installation-secret`，生成随机外置主密钥/签名密钥材料，显式运行 Alembic，并将安装秘密摘要登记到安装单例行。不存在固定管理员密码。若初始化在管理员创建前被中断，使用相同配置/安装秘密文件重新运行 `init`，已有密钥材料会被保留。私下备份配置和密钥材料，不得提交，也不得放入前端/静态目录。使用自有受保护进程环境时，可通过 `VERIQ_DATABASE_URL` 提供 DSN；不要把秘密粘贴到共享命令日志。

首位管理员可用两种方式创建：打开初始化页，输入运维人员的安装秘密及所需账户/密码；或使用本机 CLI，由它读取秘密文件并提示输入两次密码：

```sh
uv run --project apps/srv veriq_server --config /private/veriq/veriq.json create-admin --email admin@example.com --display-name Administrator
```

数据库在事务中消费安装秘密。Web 初始化保留已失效的本机秘密文件，供运维人员删除；CLI 创建会删除它。唯一单例将并发的首位管理员请求串行化。初始化后，已授权系统管理员通过 `/admin/users` 创建其他用户。

迁移是独立运维命令，升级前须备份已有数据库。`serve` 绝不创建表或执行迁移：

```sh
uv run --project apps/srv veriq_server --config /private/veriq/veriq.json migrate
uv run --project apps/srv veriq_server --config /private/veriq/veriq.json doctor
uv run --project apps/srv veriq_server --config /private/veriq/veriq.json serve
```

`doctor` 检查已校验配置、MySQL 8.4 和安装表。`GET /api/v1/health/live` 只检查 HTTP 进程；`GET /api/v1/health/ready` 查询数据库。所有 API 响应使用规范 JSON 信封。显式 CLI 参数优先于 `VERIQ_` 环境变量，后者优先于配置文件，配置文件再优先于非敏感默认值。例如 `--port 8889` 或 `VERIQ_PORT=8889` 会修改 API 端口。必填设置为 `database_url`、`public_url`、`master_key` 和 `signing_key`；密钥值是 32 字节的十六进制编码。生产默认要求 HTTPS 公开来源并设置 Secure Cookie。生产使用同源 TLS 反向代理；生产静态服务、已完成代码审查的发行暂存/wheel 验证已实现，正常发行和目标 OS 验收仍待完成，见[库存契约](decisions/0019-production-static-inventory.md)。

在另一个终端启动 Vite：

```sh
pnpm --filter @veriq/web dev
```

Vite 服务地址为 `http://127.0.0.1:5173`，将 `/api` 代理至 `127.0.0.1:8888` 的 Tornado。开发时将 `public_url` 设置为浏览器使用的精确 Vite Origin；变更请求强制校验 Origin 和 Tornado CSRF。API 启动不需要前端 `dist` 目录。开发时只访问 API 端口的 `/` 会返回 JSON 404，前端路由由 Vite 负责。它的固定端口为 5173（`strictPort`），`/api` 和 `/internal` 在代理时均保留浏览器 Origin。没有已发布前端时，`GET /api/v1/build-info` 返回结构化 `503 BUILD_INFO_UNAVAILABLE`。生产则要求 [ADR 0019](decisions/0019-production-static-inventory.md) 描述的完整包库存及元数据。

可用页面为 `/setup`、`/login`、`/reset`、`/reset/confirm`、`/account` 和 `/admin/users`。密码长度要求为 12～1024 字符。未配置 SMTP 时，公开重置请求对所有邮箱返回相同的通用响应，并说明由管理员提供链接。可选真实 SMTP 投递通过受保护配置文件，或 `VERIQ_SMTP_HOST`、`VERIQ_SMTP_PORT`、`VERIQ_SMTP_FROM`、`VERIQ_SMTP_USERNAME`、`VERIQ_SMTP_PASSWORD`、`VERIQ_SMTP_SECURITY`（默认 `starttls`，也可为 `tls`）及 `VERIQ_SMTP_TIMEOUT` 配置。用户名和密码必须同时提供；生产拒绝明文 SMTP。TLS 校验证书。公开重置请求在账户查询前即应答；已配置的投递作为受跟踪后台任务执行。投递失败时记录安全事件、审计失败并撤销该次签发的令牌；公开响应始终通用，绝不声称邮件已送达。正常关闭服务会排空待处理投递。这是进程内投递接缝，没有跨进程崩溃保留的持久队列。`delivery.Delivery.send(recipient, subject, body)` 也可用于 T03 邀请。获授权管理员签发可复制、30 分钟有效且一次性的重置链接，仅在获授权响应中传递。URL 将令牌放在 fragment 中，浏览器进入时移除，不会出现在发给服务端的 URL 中。密码修改/重置、停用、退出及撤销都会使会话失效。没有其他启用管理员时，不得停用或降权最后一位启用中的系统管理员。

测试命令统一在仓库根目录使用 `uv run --project apps/srv python -m pytest`；模块入口为共享测试支持提供完整包命名空间，正式发行构建也采用这一方式。裸 `pytest` 控制台入口不作为这些仓库共享测试的支持入口。

测试要求运维人员提供专用 MySQL 环境，在 `.superpowers/sdd/veriq-1/test-env.json` 中设置 `mysql_dsn`。测试明确拒绝 `veriq_test` 以外的数据库及未知表，只重置显式白名单内的 VeriQ 表与 `veriq_alembic_version`。绝不将该文件指向已有平台数据。Python 和浏览器套件共用此 Schema 及固定任务端口，须顺序执行：

```sh
uv run --project apps/srv python -m pytest -c apps/srv/pyproject.toml apps/srv/tests --cov=veriq_server --cov-config=apps/srv/pyproject.toml --cov-report=term-missing -q
pnpm test
pnpm check
pnpm --filter @veriq/runner-sdk test:coverage
pnpm --filter @veriq/web check
pnpm --filter @veriq/web build
pnpm --filter @veriq/web test:e2e
```

Playwright 默认使用它安装的 Chromium。受管理测试主机可通过 `VERIQ_TEST_CHROMIUM=/usr/bin/chromium` 选择已有测试浏览器；该选项仅属于测试配置。HOME 只读时，使用任务专属的可写 `UV_CACHE_DIR`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`。浏览器证据进入已忽略的 `.superpowers/cache/t02/`。Python API 运行时不需要浏览器或 Node 进程。

<a id="runtime-enrollment-and-doctor-t08-development-cli"></a>

## Runtime 登记与诊断（T08 开发 CLI）

安装冻结的工作区依赖后，使用已实现的 CLI：

```sh
pnpm --filter @veriq/runtime dev doctor --server http://127.0.0.1:5173
pnpm --filter @veriq/runtime dev login --server http://127.0.0.1:5173 --name "My workstation"
pnpm --filter @veriq/runtime dev status
pnpm --filter @veriq/runtime dev workspace list
pnpm --filter @veriq/runtime dev workspace use APPROVED_WORKSPACE_UUID
pnpm --filter @veriq/runtime dev logout
```

打开显示的控制 URL，登录、选择 Workspace，核对批准码并确认设备及共享范围。设备每五秒轮询一次，直至批准或十分钟到期。登录成功登记的是**离线**设备，不会启动 worker。Workspace 使用命令只接受已有批准绑定，不创建新授权。已撤销、过期、所有者停用或成员资格被移除的身份在下一次操作时被拒绝。正常退出在远端退出成功后，或明确收到 HTTP 401 `DEVICE_UNAUTHORIZED` / `DEVICE_REVOKED` 拒绝后，删除本机设备凭据。后一种情况只报告服务端已拒绝该凭据，不声称撤销了它。之后可在同一配置目录重新登记。未知错误及网络/传输失败返回非零并保留凭据，以便重试退出。登录绝不自动删除或覆盖已有凭据。

服务器不可达时，如需显式本机恢复，可运行 `pnpm --filter @veriq/runtime dev logout --local-only`，若此前选定了目录，继续使用相同 `--config-dir`。它只通过加锁存储删除本机设备凭据，不联系服务端、不撤销任何远端令牌，也不删除项目资产/结果。远端凭据可能仍有效。恢复连通后通过 Web Runtime 页面撤销设备，或等到其过期，再认定它已不可用。该恢复入口也允许替换无法读取的本机凭据文件；正常登录仍保留已有档案。

CI 跟随 `24.x`；已安装候选仍要求清单记录的精确 Node 版本、角色路径和库存摘要。Doctor 检查真实、稳定、独立的 Node24.x（`>=24 <25`），拒绝把 Electron 当作执行器。它还检查受支持 OS/x64 架构、已安装编译器/SDK 版本、Chromium 可执行文件及真实无头启动/渲染，以及配置的控制服务存活端点。`--browser-executable PATH` 显式选择已安装浏览器；生产默认使用 Playwright 安装。浏览器不可用或网络失败时，返回非零并给出安全诊断。成功退出码为0，失败为1，取消为130。诊断写 stdout，脱敏命令失败日志写 stderr。不打印令牌，也不通过 argv 传递令牌。只接受 HTTPS 控制来源，localhost HTTP 开发环境除外。拒绝重定向，请求及正文大小均有界。

部署管理人员在 Runtime 页面创建 Workspace 服务账号，并签发一次性登记令牌。通过标准输入将其交给 `enroll-service --server ORIGIN --name NAME`；只有同意 Workspace 使用时才添加 `--share-workspace`。绝不把令牌粘贴为命令参数或放进 URL。令牌十分钟过期，不能触发执行计划、维护或解析凭据。系统管理员的 MANAGED 批准独立于所有者同意及云端位置。MANAGED 信任通过后，由 Workspace OWNER/ADMIN 另外批准凭据投递；只有项目 VIEWER/EDITOR 身份的全局管理员不能授予它。停用服务账号会立即拒绝其设备。

Node 开发 CLI 使用钉死版本的 tsx 加载器消费共享 TypeScript 包。env-paths 配置目录权限为 0700，设备文件权限为 0600，通过 proper-lockfile 串行化并原子替换。`--config-dir` 选择专用私有开发目录。这是已文档化的文件存储接缝，**不是** OS vault 或原生发行包。T20 提供 OS vault、安装器及完整原生平台交付；T09/T10 已实现 Linux worker 的领取、租约、启动、停止及可恢复的无人值守令牌轮换。丢失一次性登记回执仍须显式恢复/重新登记；Agent 会恢复日志中记录的精确轮换候选，不覆盖另一登记主体。T14 提供持久化签发者及独立 `trust bind`/`trust refresh` 命令，设备凭据本身不建立签名者信任。见[离线资源包操作](offline-bundles.md)。

需要时用 `VERIQ_TEST_CHROMIUM` 选择测试主机上的 Chromium，再运行 Runtime 测试：

```sh
pnpm --filter @veriq/runtime test
pnpm --filter @veriq/runtime check
pnpm --filter @veriq/web test:e2e z-runtimes.spec.ts
```

真实浏览器流程启动 CLI，在 UI 中批准，读取受保护的本机凭据，修改共享和受管理信任，撤销设备并确认令牌被拒绝。Vite 将 `/api` 与 `/internal` 转发给控制服务。Python 控制服务运行时仍不需要 Node 或 Chrome。

<a id="unified-execution-server-t09"></a>

## 统一执行服务端（T09）

已实现的控制 API 准入不可变已发布 CASE/SUITE Run 或冻结草稿候选，对 TEST/VALIDATE/CLEANUP 排队，同时检查当前设备和原始请求者。默认仍为全局四个浏览器上下文、每 Workspace 两个、十个未结束 Run、心跳10s、租约60s。副作用发生前必须显式激活；过期或未知进程失去权限，并在停止核对完成前继续隔离占用容量。取消尚未开始的重试会立即结束，同时保留此前失败。

服务端依据真实上传字节、保留源码及运维人员拥有的 `approved_engine_inventory_path` 核验受管理编译完成。任何引擎都不会被隐式批准：缺少批准就失败关闭。T18 已提供实际引擎构建器及独立、受守卫保护的运维晋升；T20 增加原生分发。见[发行工具](release.md)。仅用于测试的归档生产器不是安装或生产批准工具。Python 控制服务绝不执行 Node 或 Chrome。

外部中间件调用限定范围且幂等的 HTTP 维护路由，完成租约回收、fixture 补偿及容量核对。用途为 MAINTENANCE、带显式操作的 Workspace 服务令牌，与一次性 RUNTIME_ENROLLMENT 不同。内部不设 Cron。完整字段、摘要、事件顺序、FINALIZE 元数据、上传上限和结果规则见[执行契约](contracts.md)与[队列决策](decisions/0010-unified-fenced-execution.md)。

T09 是服务端基础。其真实 MySQL/HTTP 并发及真实编译器归档测试与 TEST/CLEANUP 协议夹具分离；这些夹具不是浏览器 Trace，也不是 Agent 杀进程的证据。T10 已提供真实 Linux 消费者、进程监督、规范 SDK 事件及可恢复轮换。T12 增加受限原始证据访问、保留期及报告。开发 CLI 仍只是登记离线设备，不自动启动 worker。

<a id="online-linux-agent-reviewed-t10"></a>

## 在线 Linux Agent（T10 已审查）

使用已安装的 C 编译器构建开发启动器，再在独立终端运行已登记档案。生产 Runtime 包会包含预编译助手；正常 Agent 启动绝不编译源码。发行目录必须含管理员批准的固定引擎字节及其库存。当前测试生产器不是生产发行工具。

```sh
pnpm --filter @veriq/runtime build:launcher
pnpm --filter @veriq/runtime dev --config-dir /private/veriq-profile runtime start --release-dir /operator/approved-engine --browser-executable /path/to/chromium
pnpm --filter @veriq/runtime dev --config-dir /private/veriq-profile runtime status
pnpm --filter @veriq/runtime dev --config-dir /private/veriq-profile runtime stop
```

启动以前台方式运行；状态/停止从另一个终端发出。停止先确认请求，随后 Agent 中断工作、尝试清理并确认后代终止。退出登录要求 Agent 已停止。缺少启动器或无法确认终止时失败关闭。不能把最近的 ONLINE 在线状态当作进程正在运行的证明，或释放容量的授权。[Linux 约束决策](decisions/0012-linux-attempt-containment.md)说明了内核子进程排空证明及恢复限制。

每个 Attempt 使用新的业务状态及有界事件/证据存储。显式取消保留此前已观察的失败。配置整用例重试时，必须成功完成符合 fixture 命名空间关闭契约的清理，或同时具备可信编译器元数据与完整观察到的只读行为。没有 fixture 的写操作若结果不确定，不会被自动重复：RETRY_SAFETY_UNCONFIRMED 要求先做业务核对，之后才能显式新建 Run。只读重试仍可使用；重试通过聚合为 UNSTABLE。精确字段和授权见[执行契约](contracts.md)。

SDK 测试入口使用两个 worker，不改变断言/测试超时。资源受限主机上的较重校验套件应顺序执行。此前较高并发下的超时继续保留记录；一次有界运行通过，不证明排除了所有可能的调度竞争。Windows 进程约束及完整桌面产品仍为后续任务。

Vite 开发应用中的 `/resources` 和 `/environments` 提供资源及环境 UI。编译校验需要当前获授权的 MANAGED Runtime 和运维人员批准的引擎库存；缺少它们时仍可编辑，校验继续排队。不得虚构回执以启用发布。定向浏览器命令为 `VERIQ_TEST_CHROMIUM=/usr/bin/chromium pnpm --filter @veriq/web test:e2e case-publish.spec.ts`。它使用受守卫保护的专用 MySQL 夹具，构建真实、锁定且仅用于测试的发行，登记实际 CLI 并调用真实 Linux Agent 编译器。测试发行不会晋升至生产目录。它需要可写 XDG 路径及足够临时磁盘空间；生成归档、设备档案和各 Attempt 工作目录均为临时材料。

<a id="external-http-plans-and-ci-reviewed-t16"></a>

## 外部 HTTP 计划与 CI（T16 已审查）

执行计划、独立服务账号 EXECUTION 令牌、同计划 QUEUE/SKIP/REJECT、GUI及安全CI报告由
`599f989` 实现，`10a1065` 修复管理入口认证回退与CI总截止时间，均经独立规格/质量审查及修复复审。
服务账号创建者停用后，真实Agent仍能以明确计划/操作授权完成实际业务浏览器、凭证解析、状态/JUnit读取。
CI超时使用单一截止时间，已知Run的取消另有最多10秒尽力请求；超时不证明远端任务未接受或物理进程已停止。
接入、幂等分页与维护说明见[外部调度](integration/external-scheduler.md)和[ADR0018](decisions/0018-external-plan-trigger.md)。

本轮证据按实际源码阶段分组：服务端广套件437通过/4失败，定向46通过/1测试证据变量错误，随后该单项1通过；
Runtime广套件63通过/3缺浏览器路径，补齐环境后三项通过；TS契约先199/2、后200/1兼容超时，最终定向185通过。
GUI最终4项通过。重要修复先观察认证/截止时间RED，再18项通过，最后传输收紧由7项通过覆盖；严格mypy84文件、
Ruff、格式和生成一致性均有记录。不将这些分组结果称为同一冻结版本全量通过；原两项编译EXECUTION_ERROR的
根因仍未证明，定向真实Agent/报告通过不倒推出磁盘是原因。源码、锁、提交树及哈希绑定已核对。

恢复环境中的测试库存已迁入当前工作区私有状态，历史清单与保留副本逐字节一致；专用测试库binlog压力已处理。
不把开发测试库存当正式批准分发。目标浏览器匹配、完整覆盖率、源码注释规范、真实Provider、生产打包及两平台
安装仍是后续门禁。报告跨页Workspace深链接和计划错误方法500两项次要问题明确由T22整改；旧账号/重跑/events
声明仍须对齐，F10重跑不因旧路由未实现而被移出首发。完整状态以[里程碑](plans/milestones.md)为接续依据。

<a id="production-same-origin-static-service-reviewed-t17"></a>

## 生产同源静态服务（T17 已审查）

`4b58a4c`沿用唯一make_app工厂实现生产同源静态/SPA/API路由，`0f48d6e`/`67779ed`修复非入口HTML的后缀与MIME参数绕过，独立复审已关闭，零新增问题。
完整文件库存与Vite图分别校验；生产缺文件、哈希/长度/闭包/版本/路径错误启动失败，开发不依赖dist。
公开build-info使用既有四字段；开发缺发行物诚实返回503。公开健康别名使用规范HealthDTO，保留旧API响应兼容。
[ADR0019](decisions/0019-production-static-inventory.md)定义T18必须遵守的stage清单/metadata格式、精确字节hash和无循环依赖。

基础实现阶段310项Python受影响回归、201项TS契约、真实HTTPS/Vite/MySQL认证和深链接，以及独立开发代理认证场景均通过。
后续修复先观察真实RED，最终90项静态回归与85文件严格mypy、Ruff/格式通过；未重复310/浏览器/build，也不把旧结果重新绑定到修复源码。
生产浏览器使用实际编译前端和临时TLS/包资源，服务器仍为真实Python工厂；这不是已安装wheel或目标OS发行验收。
T18已提供实际stage/wheel及Debian下无Node/只读/仓库外安装证明，正常发行和Ubuntu/OCI验收仍开放；T21继续完整存储/静态/关键依赖就绪监控；[里程碑](plans/milestones.md)保留所有发布阻塞。

<a id="server-release-tooling-reviewed-t18-acceptance-pending"></a>

## 服务端发行工具（T18 已审查，验收待完成）

`3995648` 实现发行流水线，`dc95f26` 修复取消隔离及等待权威锁后的候选新鲜度。独立限定范围复审关闭了两个重要问题，未发现新增问题。构建阶段现使用隔离的 Linux subreaper，直到完整子树被收割才释放构建锁；缺少完成证明时隔离工作区。晋升在取得既有签发者/库存守卫锁后，重新验证最初选定的库存及文件字节。见 [ADR0020](decisions/0020-server-release-pipeline.md) 和[发行指南](release.md)。

`dc95f26` 上的真实默认构建完成冻结安装后，在 Web lint 阶段停止：145 个错误、38 个警告和 128 条信息。`output/server` 在构建前后均不存在。独立格式检查发现 132 个文件；T18 初始固定注释审计记录 4.4551% 及 280 处违规，另有四个已有 CI 客户端 mypy 注解待处理。这些都是真实的 T22/T23 发行阻塞。不声称已完成正常全量发行、目标 Ubuntu24.04 或 OCI 验收。

证据继续按源码阶段分开记录：钉死 Chromium158/revision1254 的 SDK 门禁通过 136 个测试/15 个文件，用时 33.38 秒，行覆盖率 91.46%；保持 15 秒/两个 worker 限制不变，Fix1 中 SDK 产品源码未改变。历史超时原因仍为 UNKNOWN。初始包验收通过 13 个测试；受影响后端批次为 140 通过/一个过时测试控制失败，之后两项定向检查通过。Fix1 的 27 项真实信号、锁及新鲜度测试用时 30.37 秒通过。不据此推断统一全量通过。

Fix1 wheel（`15bc3473…`）含当前晋升源码，并在 Debian13/Python3.12.14 上通过真实离线、只读、仓库外、空 PATH 的生产启动。其静态原始库存仍为 `561ee42a…`。此前 `3995648` 的无 Git 源码重建和 UNVERIFIED tar 仍是历史候选，不含 Fix1。最终引擎候选条目 `4ac70538…` 和原始库存 `75fc7c83…` 具有加载/安装/导出/编译证据；真实候选浏览器执行归 T19/T23。UTF-16 注释审计及可配置引擎元数据两个次要问题仍分配给 T22。[里程碑](plans/milestones.md)列出全部剩余验收工作。

<a id="electron-desktop-gui-reviewed-t19"></a>

## Electron 桌面 GUI（T19 已审查）

T19 源码 `bac5162` 及截至 `eb2dc4e` 的 Fix1 通过初次任务审查及针对六个问题的限定范围复审。退出现在会联系服务端并撤销复制的普通 Cookie，同时保留设备绑定；客户端/broker 保留分段 UTF-8 字节，随包资产采用 Windows/POSIX 原生包含关系，可见执行保留可信 X11 上下文，流式 Attempt 保留原生证据所有权，夹具等待进程/标准输入输出关闭。

[对应精确提交的运行43485459939](https://github.com/baofengbaofeng/VeriQ/actions/runs/43485459939) 将六个桌面 GUI 用例各执行一次，跳过和不稳定结果均为零（125.020 秒），另执行 34 个单元测试及 2 个显示测试。真实完整 Chrome158 的可见窗口观察与正向停止证明属于同一个 Attempt。真实且归属已确认的 UI renderer 异常终止后创建了新 renderer，而同一独立 Agent/Run 继续运行；原生退出界面/重新打开、上传恢复/幂等、取消和复制 Cookie 后401均通过。仅组件的启动用例仍被明确标注为组件证据。

QA 只使用 Python3.12/pidfd 注入归属精确的 renderer 故障；Python 不是桌面产品依赖。此前会生成核心转储的注入在托管收集器下，十秒时观察到 renderer CoreDumping=1，既未证明是 systemd 缺陷，也不是获接受的产品规避方案。真实进程角色来自可信 Electron Browser/Tab 指标，因为 Linux 进程标题不保留独立的 NUL 参数。所有先前失败继续保留记录；972 导出失败的精确原因仍为 UNKNOWN。

CI 使用独立且未批准的引擎1.0.2-t19-fix1（规范 `1c64aff0…`），保留原始引擎身份。501 个源码摘要匹配该提交，原始库存身份也匹配；65 个编译摘要是 CI 清单记录，其字节未下载到本机独立重算。托管环境精确二进制的 AppArmor QA 策略已完整移除，没有修改全局限制。已有业务浏览器 `--no-sandbox` 参数仍是 T20 安全默认值任务，与启用沙箱的 Electron UI 分开记录。

以上关闭 T19 模块，不代表已安装 Windows11/Ubuntu24.04 分发、vault/进程/签名/升级、真实 Provider、全仓质量或完整 MVP 验收完成。继续 T20 打包及[里程碑接续](plans/milestones.md)；绑定源码的 GUI 证据不是生产发行包。见[桌面开发](desktop.md)。

<a id="current-verification-limits"></a>

## 当前验证限制

离线执行/导入模块（`1b6fccb`、`86f1602`，修复于 `67968b4`）通过独立规格/质量审查及限定范围复审。真实组合测试覆盖签名且由 Agent 发布的 CASE、取消及完整 SUITE 矩阵、候选 SUITE 的角色/浏览器/数据集覆盖，以及杀死宿主后的 DOWNLOAD 恢复：四个场景通过业务 HTTP 和真实 MySQL 导入 API 验证，执行期间控制监听器被物理停止。源码、变体、事件及原始摘要匹配；重复上传复用 Run，保留在线 Attempt。导入保留 OFFLINE_IMPORT 且门禁为 false；省略工作仍为 INCOMPLETE。

最终修复检查通过 27 个离线及 27 个导入/报告测试、200 个契约检查、生成契约一致性、Runtime/Web 类型、Ruff 及显式配置的严格 mypy（80 个文件）。四场景组合早于两个较小的客户端/检查点细化，后者由冻结源码离线检查覆盖；不声称针对这些细化再次执行了组合测试。初始广泛服务端批次仍记录为 290 通过/七个失败；六个夹具配置失败和原生导入锁缺陷已由六个真实 Agent/编译器测试及受影响导入/发布套件检查。不声称干净重跑了整个批次或完整 SDK。见[离线执行](offline-execution.md)和 [ADR0017](decisions/0017-offline-execution-import.md)。桌面/IPC、Windows/vault、生产打包及下列正式浏览器/Provider 门禁仍是已分配工作，不是完整产品验收。

签名资源包实现（`46798ab`，修复于 `3ffb144`、`c1fa544`）在修复未检查的带外同级密钥、语义闭包/入口绑定、HTTP 幂等/认证/状态契约及多 CASE 版本分页后，通过独立审查。最终限定范围证据包括 14 个离线验证器测试、37 个编译器生成测试、六个资源包/守卫检查、196 个契约测试、一个真实 Agent/键盘 GUI/下载/原生验证流程、一个生成 SDK 消费者，以及类型、mypy（76 个文件）和 Ruff。GUI 分页测试明确披露其只用于列表的历史填充；只有真实 Agent 发布的根会被导出。这些检查不是全产品验收。

历史 T14 完整 SDK 命令记录为 **134 通过 / 一个超时**；上文较晚的 T18 钉死浏览器门禁通过，但没有证明旧根因。新增阶段证据将延迟等待定位于 fixture `browser.close()`，发生在 executeStep 结算及 Context 关闭完成后；仅凭这一点不能证明其业务状态断言已通过。另一次独立授权的原生进程/管道探针在不同调度下通过 47 个选中测试，没有复现该间隙。不声称已找到原因或完成生命周期修复。系统 Chromium156 与 Playwright1.65 预期的 Chromium158（revision1254）不同，但因果关系未证明。正式构建前，将测试工具对齐匹配的钉死浏览器并取得正式门禁；若再次失败，捕获原生阶段。保留 15 秒/两个 worker 检查及生成子进程隐私要求。之后通过的生成消费者只是定向兼容性检查，不能替代完整门禁。

AI 实现（`f9573d0`，修复于 `3c96eb6`）通过独立代码审查。修复前最终 AI 套件通过 20 个测试。审查修复包含六个通过的因果后端回归、29 个通过的覆盖用例、两个通过的已纠正解析器夹具检查、三个通过的浏览器流程，以及 mypy/Ruff/TypeScript 检查。两个覆盖命令各保留一个错误的解析器夹具期望，均不描述为完整 30 测试通过。此前广泛 Python 命令为 356 通过和一个过时迁移头断言失败；广泛 Web 命令为 16 通过和一个共享空夹具假设失败。定向检查验证这些纠正，不声称干净重跑任何一套广泛套件。真实 Chromium Run 在 Provider 禁用和耗尽两种场景均通过，模型 HTTP 请求为零。真实外部 Provider 验收仍等待用户授权及持久隔离环境，见 [AI 配置与验收](ai.md)。绝不将真实密钥写入可重置测试。

已审查的编辑器实现（`c128ac5`，修复于 `b49f981`）通过最终九个浏览器测试、Web 类型检查及生产构建。初始实现还通过五个已有 Web 流程、258 个受影响 Python 测试、193 个契约测试、109 个编译器测试、Ruff 和 mypy。这些是限定范围的开发结果，不是完整产品验收。

较广泛的 `pnpm test` 仍失败：SDK 取消测试 `cancels an in-flight assertion while preserving already observed failure=false` 在两个 worker 下超出未改变的 15 秒预算（131 通过、一个失败）。脚本在 Runtime 测试之前停止。之后一次带观测、隔离的执行在 671 ms 通过，既未复现也未解释此前失败。声称正式构建通过前，须捕获失败阶段并解决问题；增加超时或重试到绿都不是修复。

报告实现（`f77a9b9`，修复于 `47986b0`）也通过独立规格及质量审查。最终修复检查通过 24 个报告/存储测试、两个当前物理流水线/Schema 测试、一个真实 T12 之前编译器归档兼容测试，以及 Ruff、mypy（65 个文件）和生成/类型检查。此前适用检查还包括 Runtime38、契约193、编译器112、Web10 通过。完整后端运行在限定范围纠正前出现过失败，不会被表述为干净的全测试运行。

要求执行的 T12 SDK 再次记录 131 通过及相同取消超时。正确添加观测的后续检查未复现取消（1.287 秒）；但整个命令仍失败，因为诊断 DEBUG 进入生成测试子进程并打印合成受保护定位文本，触发该测试的隐私断言。这既未解决超时，也未证明正常 Runtime 存在泄漏；正常 Runtime 传递不含 DEBUG 的显式子进程环境。后续必要诊断必须捕获失败阶段，同时避免污染生成子进程隐私检查。

生产构建还保留因提前加载 Monaco 导致的大分块警告；本机 worker 资产仍随包提供以支持离线使用。加载改善归最终 UX 工作。已有测试颜色环境警告仍待基础设施跟进。

<a id="reports-and-restricted-evidence"></a>

## 报告与受限证据

开发 `/reports` 视图使用真实 Run/Attempt 历史、可重放事件流、编译器派生步骤标签，以及分开的执行时/当前信任门禁。普通成员查看脱敏结构化值。原始 Trace、HTML、截图、下载和日志访问要求当前 Workspace Owner/Admin 权限及精确 Attempt 关联；调用者提供的敏感级别不能授予访问。通过 `pnpm --filter @veriq/runtime dev trace open /path/to/trace.zip` 在本机查看获授权下载的 Trace；它使用钉死版本 Playwright 回环查看器，不会把文件上传至公开服务。

原始证据保留期依据服务端终态时间戳，默认通过的 Attempt 保留14天，其他终态结果保留30天，由经过认证的外部维护 HTTP 端点唤醒。时间戳未知的历史记录继续保留。源码、引擎及编译来源保持钉死。元数据/导出包生命周期仍是必要运维任务。最小的私有空退役栅栏防止迟到外部写入者恢复已删除证据字节；仅经过一段时间不足以移除栅栏。协议和存储详情见[契约](contracts.md)及 [ADR0014](decisions/0014-report-evidence-storage.md)。

T14 增加迁移0011（`veriq_bundles`）及 `/bundles` Web 页面。已有安装导出前，须准备独立运维签发者，见[离线资源包操作](offline-bundles.md)。新 `init` 会安全创建它，`serve` 绝不凭空生成签名身份。原生 CLI 实现资源包下载/验证、信任绑定/刷新及精确本机秘密映射。离线执行/结果导入现使用同一套 worker/编译器及持久本机 SQLite 报告，见[离线操作](offline-execution.md)。原生 OS vault、桌面 IPC 及安装器仍是各自后续任务；包签名不会赋予正式结果信任。资源包保留根保持钉死，等待 T21 的包生命周期工作。
