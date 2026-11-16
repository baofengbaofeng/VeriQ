<a id="veriqmacos-runtime-keychain-独立验收"></a>
# macOS Keychain

本文用于 macOS15及以上 Intel x64、Apple Silicon arm64 两套独立测试环境。当前实现处于开发和审查阶段，本文提供运行入口，不代表已经完成真实钥匙串、安装或签名升级验收。Runtime helper 的结果不替代 Electron Cookie 验收。

## 测试环境

| 条件 | 要求 |
| --- | --- |
| 系统和架构 | 两架构分别原生执行，记录 `sw_vers`、`uname -m`，Intel 不以 Rosetta 替代 |
| 登录账户 | 专用、非 root、可丢弃账户；普通人工路线通过真实图形登录会话中的 Terminal 执行，下述已授权 GitHub 临时账户路线单独核验当前安全会话 |
| 授权范围 | 操作者明确允许本账户内测试钥匙串的创建、锁定、解锁、删除及相应偏好变化 |
| 工具链 | 仓库规定的 Node24.x、锁定 pnpm、Xcode/Command Line Tools；保留具体版本与源码提交 |
| 账户数据 | 不放置个人、生产或其他测试任务的凭据；测试期间不切换该账户的登录会话 |
| 签名 | 当前源码 helper 测试不证明最终签名身份；安装和签名升级另行验收 |

`SecKeychainCreate` 和删除可能更改账户的持久搜索列表或默认钥匙串。随机私有文件路径、改变 HOME、sudo 或创建后恢复偏好都不能代替独立账户隔离。不要在标准共享 CI、日常工作账户或已有生产登录会话运行专用测试。

## 构建与无存储变更检查

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @veriq/runtime run build:vault:darwin --tests
pnpm --filter @veriq/runtime test:vault:darwin
```

上述带 `--tests` 的构建输出生产 helper 到 `apps/runtime/build/vault-darwin/veriq_agent`，同时将测试 helper、控制器和内存 ACL 驱动输出到 `apps/runtime/build/vault-darwin-test/`；省略 `--tests` 只构建生产 helper。普通安全测试只验证非法生产帧、测试能力、协议、进程终止及非持久 ACL 对象，不执行默认或持久钥匙串存取。

专用测试前必须重新执行上述带 `--tests`、不带 `--red-candidate` 的构建。`--red-candidate` 仅用于明确的失败基线，会将测试 helper 替换为 stub；其结果不是实际存取验收，也不能用于交付安装包。

## 可选的独立 CI 只读预检

仓库现有 Mac 工作流提供独立的手动会话预检模式：

```bash
gh workflow run runtime-native-macos.yml --ref codex/veriq-mvp-completion -f session_preflight=true -f vault_baseline=false
```

它在两类新建的 GitHub hosted 作业中只构建既有原生成员并调用控制器 `session` 操作。普通测试作业在该模式跳过；预检本身不运行测试 suite，不生成可丢弃会话声明，不执行持久钥匙串操作。`session_preflight` 与 `vault_baseline` 同时启用会在 checkout/build 前失败。此模式不影响常规 push 和原有 baseline 模式。

`1b77b39` 的[首次双架构预检](https://github.com/baofengbaofeng/VeriQ/actions/runs/43639551338)均通过当前控制器的非 root UID/安全会话谓词，源码与制品已核验。`getlogin_r` 返回的是继承登录名，不能自动认定为实际控制台用户；会话标识和图形访问标志也不单独证明控制台已完成登录。报告因此固定保留 `consoleLoginCompletion: NOT_PROVEN`、`accountDisposability: NOT_ATTESTED`、`persistentOperations: NOT_RUN` 和 `tests: NOT_RUN`。

真实 Runtime 私有存储、Electron Cookie、生产默认钥匙串和签名安装分别验收。只读预检通过不是运行持久测试的授权，也不能替代下述新 VM 在同一任务内的会话检查。

## 已授权的独立 GitHub 临时 Mac 验收

用户已明确授权独立 GitHub 临时 Mac VM/一次性账户中的 Runtime 私有文件型 Keychain 创建、锁定、解锁、删除及这些操作对该账户搜索列表和默认值偏好的影响。该授权只适用于现有工作流的专用任务 `macos-private-store-acceptance`，不扩展到普通 push、共享 CI、Cookie、生产默认存储、真实控制台登录、信任、签名或安装。账户销毁提供隔离边界，不是清理完成证据。

源码审查冻结后，由协调者在已审查的同一 ref 手动触发一次：

```bash
gh workflow run runtime-native-macos.yml --ref <reviewed-ref> -f private_store_acceptance=true -f session_preflight=false -f vault_baseline=false
```

三个输入均默认 `false`；公共路由任务在 checkout/build 前拒绝任意两个或三个目的同时启用。普通 push 和普通手动运行保留原有任务；baseline 仍为独立失败基线，preflight 仍只读。专用任务固定 `macos-15-intel/x64`、`macos-15/arm64`，`fail-fast: false`；两个架构必须来自同一次运行、同一冻结源码，不能拼接不同运行的成功结果。

每个实际任务在 checkout 前要求可信 `runner.environment == github-hosted`。随后重新检查源码 HEAD、工作流 SHA/ref、run/attempt/job、镜像、实际 macOS15及以上、uname/Node/runner 架构、Node24.x 具体版本/hash，以及当前非 root UID/EUID。控制器 `operation:session` 在最小环境下限制5秒/4096字节并要求真实零退出、精确 `uid/login/session`；既有原生 `getlogin_r`、Security session、graphic-access 与非 root-session 谓词保持不变。这是可信上下文观察及当前会话谓词，不是独立密码学证明或真实控制台登录完成证明。

同一任务先使用既有锁定依赖构建四个非 red 成员，再根据本机实际会话事实与上述用户授权，在上传目录之外独占创建0700目录和0600、本人拥有、普通非链接、最多4096字节的声明。声明使用既有协议文字；控制器 create 时再次独立检查当前会话。不会复制旧 VM 的声明，也不会上传该文件。生产 helper 参与构建，但测试不向生产默认存储发送有效请求。

从 `apps/runtime` 执行的原有命令为：

```bash
node scripts/build-vault-darwin.mjs --tests
node --import tsx --test --test-reporter=tap tests/native/darwin-vault.test.ts
node --import tsx --test --test-reporter=tap tests/native/darwin-vault-dedicated.test.ts
```

两个 suite 均在同一任务内设置 `VERIQ_D1_DISPOSABLE_SESSION` 为刚生成的精确路径，分别要求7与2个真实 PASS，fail/cancel/skip/todo 全零。构建只使用现有 Xcode/系统 SDK，无新增 SDK、Chrome、Electron 或 Cookie 安装。依赖安装仍使用已锁定工具及 `--ignore-scripts`。

| 阶段 | 预先固定上限及理由 |
| --- | --- |
| pnpm 工具 / 冻结依赖 | 120秒 / 240秒；仅既有包安装，不下载浏览器资产 |
| 四成员构建 | 300秒；覆盖四次既有单编译60秒限制及身份观测 |
| 只读 session | 5秒、4096字节、SIGKILL；不需要长期守护进程 |
| 非持久7项 / 专用2项 | 120秒 / 600秒；覆盖协议负例及多次有界5秒控制器请求、并发写入与两套清理 |
| 终止确认 | 子进程终止后另限1秒观察 close；缺少 close 保持未知 |
| 日志 / 制品 | 每阶段每流512KiB；构建事实4MiB；单架构固定白名单制品最多12MiB；整个任务30分钟 |

超时、溢出或异常保留首错，不自动重试或延长预算。只有完整、未截断输出和真实测试进程零退出才可通过。日志保存固定状态、计数及受限诊断，原始协议、密钥、Base64材料、密码、声明、Keychain 文件、二进制和环境转储均不导出；可疑正文拒绝上传并保留摘要与失败状态。制品 `runtime-private-store-<arch>-<run>-<attempt>-<sha>` 即使前置步骤失败也保留未完成报告，包含源码/锁/测试/夹具/控制器/helper/构建摘要、实际四成员构建身份、命令/退出/计时与当前非秘密会话事实。

清理依据来自两条精确具名 TAP 测试及冻结源码：`dedicated session proves persistent exact-scope storage and refusal behavior`、`dedicated session observes real unlocked OS secret-read denial`。每个测试都在 finally 等待 fixture cleanup，后者消费控制器实际 SecKeychainDelete/rmdir 成功回复后等待 close；控制器先核验自有 helper 已退出。第二项还要求真实解锁状态下 OS 秘密读取拒绝及授权主体独立核验值、ACL、属性未变，不能以本地策略拒绝代替。

完整2项 PASS、测试进程 exit0 与 source-bound 记录共同推导 `cleanupEvidence: DERIVED_FROM_SOURCE_BOUND_TEST_PASS`、`helperExits: DERIVED_CONFIRMED`、`cleanupCommandCompletion: DERIVED_SUCCESS`、`controllerClose: DERIVED_OBSERVED`。夹具没有记录控制器退出码或导出独立确认事件，因此固定 `controllerExitCode: NOT_CAPTURED`、`cleanupAckArtifact: NOT_EMITTED`。缺失、重复、失败、跳过、取消、超时或截断都保持 `UNKNOWN_OR_FAILED`；不合成确认，不通过扫描/删除未知存储或 VM 销毁推导回滚。

报告固定区分 `authorization: USER_APPROVED_DISPOSABLE_ACCOUNT` 与 `consoleLoginCompletion: NOT_PROVEN`；Cookie、productionDefaultStore、signing、install 均为 `NOT_EXECUTED`。真实两架构执行结果仍待协调者审查后的单次 CI 验证，成功仅建立 Runtime 私有测试存储验收，不代表完整 MVP、生产默认 helper、安装或签名升级通过。原始失败须先保留并具体诊断，再决定新的有限修复与运行。

## 配置独立登录会话

在专用账户的 Terminal 中获取控制器实际观察到的会话事实：

```bash
printf '%s\n' '{"operation":"session"}' | apps/runtime/build/vault-darwin-test/veriq_keychain_controller
```

该命令仅返回 `uid`、`login`、`session`，不会创建测试钥匙串。失败时先排查真实图形登录、账户与执行上下文，不通过删掉校验或伪造返回值继续。

在该账户拥有的新私有目录内创建会话声明 JSON，目录权限700、文件权限600，文件不得为符号链接。下面的数值仅为示例，须替换为上一步实际输出；声明文字需要完全一致：

```json
{
    "disposable": true,
    "acknowledgement": "I authorize Keychain preference changes in this disposable login session.",
    "uid": 501,
    "login": "veriq-test",
    "session": 100009
}
```

只有操作者确认该会话确实可丢弃、允许上述副作用后才设置 `disposable` 和授权声明。UID、登录名及会话核验仅证明上下文匹配，不能自动证明账户隔离；不得从其他账户复制声明使用。

## 执行真实存取验收

将变量设置为刚创建的声明文件绝对路径，再在同一登录会话、同一源码构建中执行：

```bash
export VERIQ_D1_DISPOSABLE_SESSION="/absolute/private/directory/session.json"
pnpm --filter @veriq/runtime test:vault:darwin:dedicated
```

无配置或上下文不符必须失败，不能将全跳过当作通过。控制器只创建其随机私有目录中的测试存储，密码由系统随机生成并留在进程内；TypeScript 不能指定任意钥匙串或 helper 路径。测试结束后须检查实际退出和清理结果；进程被强杀或清理失败可能留下加密测试状态，不表示之前的系统修改已撤销。

| 行为 | 必须保留的真实结果 |
| --- | --- |
| 精确范围存取 | 32字节含零值、同值幂等、冲突拒绝、大小写与版本范围隔离、跨 helper 读回 |
| 同时写入 | 两个实际 helper 在缺失查询后同步竞争，同值及不同值行为、最终值和真实退出 |
| 锁定恢复 | 实际锁定后拒绝、解锁后原值读回；不能用模拟布尔状态代替 |
| ACL 拒绝 | 宽、空、额外主体、owner/rights 等负例拒绝，并独立核验值及公开 ACL 状态未变 |
| 修改不确定 | 不能把修改后传输失败当作确定未写入，也不能自动覆盖或回放 |
| 日志与清理 | 报告不包含原始密钥、Base64、请求正文或密码；退出/清理失败保留为失败或未知 |

上表为验收目标，具体已覆盖项及实际结果以当前源码、测试报告为准，不能仅根据文档认定完成。公开 ACL 导出不证明底层隐藏时间策略；同二进制内存模板重启也不证明持久项重开或不同签名升级兼容。

## 验收记录

每架构分别记录源码提交、锁文件摘要、工具链、OS/架构、构建事实、测试命令、完整计数和清理状态。保存日志前核对其未包含敏感材料，不提交会话配置、测试存储或凭据。发生失败保留原结果，分析具体原因后再验证；不通过增加超时、强制授权或不断重跑获取绿色结果。

最终生产默认钥匙串、安装后的 helper 身份、Electron Cookie 冷启动/锁定与恢复、稳定签名升级和安装包仍须单独记录。参考[Mac 范围与验收要求](../specs/macos-mvp-scope.md)及[交付里程碑](../plans/milestones.md)。
