<a id="v05-runtime-生产源码与独立验证交接"></a>

# V05 Runtime

状态：本轮只交付源码，未执行类型检查、测试、构建、候选 Node/Chrome、原生 SDK、CI、安装、签名、钥匙串或独立复审。本文不是通过报告，不修改历史 SDD 证据或原发行门禁。

2026-11-17 接续：上述为历史代码交付状态；本轮已实际完成双架构 Mac 入口来源、工具、安装及守卫阶段（各 97/97、零跳过）。
运行 `44012990245` 在构建前遇到模块循环初始化错误，F11 已本地修复并通过最终冻结版 39 项入口守卫，独立规格及质量复审未发现阻塞性或重要源码缺陷（`6525ec3`）；这不代表组装、原生存储、安装或发行验收通过。
最新提交、证据与剩余事项以[当前验证计划](../../plans/2026-11-17-mvp-validation.md)为准。
上述额度暂停已被用户随后明确恢复开发和 CI 的指令取代，不再作为等待理由。
最新受限入口运行 44071296597 绑定 e1d0cda，两架构 source/tooling/install/guards/build/final/cleanup 均通过；
两份 87 成员制品的摘要、86 项引用和源码/架构绑定已独立核验。
这只证明该提交的入口材料生产；完整依赖、Runtime、原生存储、桌面与发行仍按下文分别验收。

<a id="source_delivery"></a>

## 源码交付

| 范围                           | 本轮实际源码                                                                                                                                                                                                       | 未包含的结论或后续工作                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 可执行编排                     | `scripts/build_runtime.mts` 提供 `mac-inputs`、`mac-stage`、`v1-inputs`、`package`；实际命令接入原 `runBoundedAssetCli`                                                                                            | 尚未运行任何动作；没有自动晋升、签名、ready 或自生成 Expected                                                                              |
| Mac 五树                       | `runtime-release.ts` 真实调用既有 entry/execution 生产器、C04 dependency 生产器、新 native/engine 生产器，独立事务及第三归档接收根组合                                                                             | 原 `Recipe`、`ExpectedPayloadInputs`、组装阶段和 v2 清单仍只支持 Darwin；审核者必须在真实材料形成后单独提供 Expected                       |
| Node/npm 原始材料              | 可通过 `nodeBootstrapAssets` 调用既有 `prepareMacNodeBootstrap`；组装阶段再次独立消费原始归档、npm 图和审核布局                                                                                                    | 引导准备的 `UNREVIEWED_SOURCE`、pending 和原始权限边界保持；该结果不是可执行批准                                                           |
| Mac 正式原生                   | 运行原 `build-darwin.mjs` 与无测试开关 `build-vault-darwin.mjs`，实际 xcrun SDK、lipo、otool、SDKSettings、vault 构建事实，生成完整 native 库存与正式 receipt；可选显式 nativeSigning 在封库存前真实签署新产物     | 本轮未运行编译、codesign、addon/helper；没有真实 Cookie、控制台、生产 Keychain 或签名安装结论                                              |
| 引擎材料                       | 调用原 `scripts/build_engine.mts` 真实编译 SDK/contracts、打包 compiler/vendor、生成 npm 离线锁；核 Schema、唯一版本、全部实际文件并生成 ENGINE_PAYLOAD receipt                                                    | 原生产器的依赖限制仍成立；没有调用签发或批准引擎装载流程                                                                                   |
| Linux/Windows v1               | `runtime-release-v1.ts` 按旧 manifest schemaVersion1 生成实际 Vite 入口、执行源码、独立 Node 角色、正式 native、版本化 engine 与完整清单、候选 receipt；新增 `runtime-release-v1-dependencies.ts` 实际准备生产依赖 | Node/npm/Chrome 与工具身份仍由调用者独立库存提供；依赖可选择内置真实准备或独立已有材料，不伪造 C04 Darwin receipt；全部目标运行尚未执行    |
| 归档                           | `runtime-release-package.ts` 固定排序/时间/portable tar，不跟随链接，前后复验库存，输出 `candidate.json`、`payload-receipt.json`、`checksums.json`                                                                 | Mac 链接仍需独立 `{arch,layout}` 文档；校验和文档明确排除自身；归档不是发行批准                                                            |
| Mac 安装消费                   | `loadMacRuntimeDistribution`、`loadInstalledRuntimeDistribution`、`bindDarwinDistribution`；原生和辅助进程只授予原始返回对象的私有 WeakMap 能力                                                                    | 可信描述信息需要由安装器/可信包外层认证，不能由待核 Runtime 自举；真实签名装载仍待 V03/V05                                                 |
| Mac 受控执行                   | `createDarwinDistribution` 使用已核独立 Runner Node 及固定库存预加载脚本实际探针；CLI/桌面在线、离线与恢复可传同一私有品牌 token                                                                                   | 运行时才执行探针；Electron 不被当作 Node24；Mac 只承诺既有 CONTROLLED_WORKER_BROWSER 范围，不扩大任意后代停止保证                          |
| Mac 凭据                       | 新 DarwinVaultBackend 接原有有限 V1 辅助进程传输，辅助进程必须由库存授予；原生 Keychain 辅助进程无修改                                                                                                             | 构造不访问系统 store；真实锁定/同值恢复/提交不确定/ACL/重启行为仍需独立运行                                                                |
| 真实 bin 修正                  | held 字节的精确 Node 首行允许无扩展名 Node 命令；保留公开赢家、其余同名命令使用 `.bin/.veriq/<sha256(owner.id)>/<name>`；边归属 witness 可采用真实解析子路径                                                       | 根绑定与 entry/execution 字面 specifier 仍精确匹配；不改包路径、不改正文、不伪造 native 检查记录或 Node 成功解析                           |
| Windows 在线持久化与本机保留期 | 交给协调者分配的 [V11](V11-local-durability.md)，本批未宣称完成                                                                                                                                                    | Windows 旧 `ONLINE_JOURNAL_DURABILITY_UNSUPPORTED` 与缺少 active/unknown Attempt 安全保留期入口是具体源码缺口，由 V11 独立记录实际交付     |
| Windows 历史目录接缝           | C05b 的 `stopped-history.ts` 使用 C07 `WindowsAttemptJournal.openExisting` 只读读取原始 Claim 行，复用原有状态/路径/停止回执与真实 Job 排空核验                                                                    | SQLite 提交只证明认领日志，不能替代 native process/drained 成员或完整后代树停止证明；未知旧 JSON/staging、孤立 sidecar/native 记录继续隔离 |

## 接口与材料

所有路径必须绝对，源码与工作根由调用者独占。`MacRuntimeProductionJob` 定义于 `apps/runtime/scripts/runtime-release.ts`：

| 字段                   | 内容                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sourceRoot`           | 具有冻结依赖、实际 Vite/pnpm/node-gyp/TypeScript 与原源码的独占源码检出；不会把共享 node_modules 复制成来源绑定                                                                      |
| `seedRoot`             | 原始 Node/Chrome 归档、来源归档、原始绑定、锁、独立 Chrome 布局及全部 tool/archive receipt 的输入根                                                                                  |
| `workParent`           | 与 sourceRoot/seedRoot 互不覆盖的真实已存在目录；本轮随机拥有的工作根始终返回/失败保留                                                                                               |
| `recipe`               | 既有 Recipe 除五个 BoundTree 以外的原字段；仍为 `MAC_RUNTIME_PAYLOAD_INPUTS`、真实 Darwin 架构                                                                                       |
| `hostBuild`            | `executable`、`viteCli`、`pnpmCli`、`pnpmStore`、`headerCache`、`engineOutput`、`timeoutMs`，全部为真实工具或目录；Node 必须是当前实际独立构建 Node 的规范物理路径且精确版本等于目标 |
| `targetNode`           | C04 的 `{executable,version,artifactSha256}`；SHA 指实际 Node 可执行字节，必须等于 `recipe.tools[name=node].artifactSha256`，原归档 SHA 单独由 `recipe.node.file` 绑定               |
| `nodeBootstrapAssets?` | seedRoot 中原 assets 输入文档的独立 Ref；启用时只生产原始 Node/npm 材料并保留原未审标签                                                                                              |
| `nativeSigning?`       | `{identity,entitlements?:Ref,timestamp?:"secure"\|"none"}`；identity 由操作员明确提供，entitlements 必须是原 SourceBinding 中精确 Ref；默认不签名                                    |

source.binding 必须是规范 JCS 的现有 SourceBindingV1；caller 提供源文件集合，生产器不补写可信绑定。集合必须包含原 stage/generator 固定源码、完整 entry 输入、C04 requiredSources（包括新增 dependency/workspace/adapter/resolver 模块）、pnpm-workspace.yaml、原清单、LICENSE、完整 contracts/SDK 源码与 Schema、原 native 源码和三个正式原生脚本、scripts/build_engine.mts。遗漏会失败，不能以生产器生成的新 JS 冒充原 Git 文件。

nativeSigning 固定使用真实 `/usr/bin/codesign`，在新编译 addon/helper 原路径调用 `--force --sign <identity> --options runtime --timestamp`（或明确 `--timestamp=none`）和可选原始 entitlements，再实际 `--verify --strict --verbose=2`、`--display --verbose=4`。签名工具原字节 SHA、开始/结束身份、实际命令、身份与时间戳策略显式记录到 `native-build.json` 的签名段。该段属于 commandEvidence 的实际签名动作，不把 codesign 冒称为 clang，也不改变现有公共 Tool 枚举与构建工具集合。vault 构建事实描述签名前编译产物，检查记录另列 unsignedBuildOutput 与最终 signed SHA。原始 Node/Chrome 字节从不被重签。签名后的五树材料仍需独立 Expected 审核；默认和签署候选都没有自动晋升为正式发行。

`produceMacRuntimeInputs(job, run)` 返回 `inputRoot`、原始配方 Ref、`workDirectory`、`producerTransactionsCleanup: "CONFIRMED"`、`AWAITING_INDEPENDENT_EXPECTED`。这个 cleanup 只描述两个生产器事务，不表示已删除 retained 归档接收、构建目录、Node 引导准备、engine 输出或所有后代进程。调用者仍拥有这些明确保留的生命周期。失败时不在未知关闭之后继续扫描或递归删除构建根。

entry 生产器回调只复制到第三归档接收，等待其全部 reader/lifetime 核验与事务清理后才进入 C04；C04 回调只复制到第四依赖快照，等待 C04 consumers 读取器收尾后才合入归档接收。native/engine 随后追加独立树。正常 source/evidence 重复只允许原字节相同。

`RuntimeV1ProductionJob` 定义于 `runtime-release-v1.ts`，`node/npm/browser` 及 `materialEvidence` 均为 `{root,files: FileFact[]}` 独立完整库存。`dependencies` 与新增 `dependencyPreparation` 必须恰选其一；既有独立 dependencies 根相对 `node_modules/`，需已包含平台正确的生产闭包、生成 Workspace JS、tsx、optional/peer/bin 材料。Node 材料恰含 `node` 或 `node.exe`。browser 根文件需包含 `chrome-linux64/chrome` 或 `chrome-win64/chrome.exe`。源文件必须绑定实际 Vite/native/engine 生产器。Windows 正式 guardian 原名 `veriq_guardian.exe` 复制为旧加载器固定的 `native/veriq_runner.exe`，字节不变，不能以角色 Node 代替。

内置 v1 依赖准备不要求操作者另写生产器。仍使用相同 `v1-inputs --job` 命令，job 去掉 `dependencies`，增加下列实际输入字段：

| `dependencyPreparation` 字段 | 必须提供的真实材料                                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpmCli`                    | pnpm 工具包真实 `bin/pnpm.cjs` 的绝对物理路径；同一工具包必须包含 `dist/pnpm.cjs`                                                                                 |
| `pnpmPackage`                | `{root,files:FileFact[]}` 独立完整工具包库存；实际清单必须为 `pnpm@11.25.0`，所有实现文件原始摘要在动作前后匹配                                                   |
| `pnpmStore`                  | 已存在真实离线 store 绝对目录；仅消费原 pnpm 锁允许的 integrity，不执行在线获取或包安装脚本                                                                       |
| `compilerImplementation`     | 独立原始 Ref 数组，path 为实际 C04 发射器加载的 TypeScript `lib/typescript.js` 与该包 `package.json` 的绝对物理路径；实际长度/SHA 必须逐项完全匹配，版本仍为5.9.3 |

生产步骤在本次 candidate 外层 `dependency-build/` 内复制原始绑定源码，真实执行 `pnpm --filter @veriq/runtime... install --offline --frozen-lockfile --ignore-scripts --prod --node-linker=hoisted --package-import-method=copy --store-dir <store>`，逐字复核原始源码与锁。随后复用 C04 `materializeRuntimeWorkspacePackages` 实际发射 contracts/SDK 的 JS、声明、Schema 和全部 exports。新辅助进程、原 v1 构建器、共享文件/命令 helpers、C04 发射器/观察器适配器/resolver/closure 和原 `.github/scripts/production-layout.mjs` 都必须存在独立 SourceBinding，并匹配当前实际宿主源码。

Windows 不使用 Unix 权限模式写位推断构建材料安全：限定于构建输入的读取器子类仍核真实普通文件、FD、inode、链接数、时间、长度与完整摘要，原 Runtime 凭据/ACL 验证器不变。pnpm 的真实源码工作区 junction 只在已结束安装的自有投影中替换成生成的普通包副本，保留原链接目标、源清单和嵌套依赖域证据；未知目录链接、工作区环和越界端点拒绝。原始源码和锁不改写，生成 JS 不进入 SourceBinding 冒充 Git 原字节。现有观察器在投影后真实采集全部物理元数据，包实例和 peer 上下文不按名称版本合并。

可达闭包来自真实 entry/execution AST 外部字面导入和固定根 tsx；依赖与 peer 通过同一实际安装域查找，原锁 snapshot 按实际 peer 版本消歧。缺失 optional 必须由原锁的真实 Linux/Windows os/cpu 条件证明，不能复用 Darwin 排除结论。不同安装域映射同一最终包根、无法消歧的 snapshot、未知包内链接或缺失 required 依赖均明确失败关闭。

每个实际 bin 声明保留原正文和目标位置，公开赢家必须由本次真实 pnpm 包别名/link/shim 确定；其他同名命令采用已有 `.bin/.veriq/<完整 owner.id SHA>/<name>` 私有路径。Linux Shell 启动包装脚本固定发行 Runner；Windows 生成固定 `veriq_runner.exe` 的 shell/`.cmd` shim，不搜索系统 Node。原生 bin 只做真实 held ELF64 x86_64 或 PE/COFF AMD64 头检查并记录独立 v1 架构证据；不冒称 MachO、最低系统版本、签名或实际执行验收。

最终无链接布局中复用原 resolver，实际用已钉选宿主 Node 的 import/require 两套解析器读取每条根和依赖边：根仍精确匹配实际字面 specifier；边可尝试真实 bin/package.json 子路径但只接受实际成功且归属同一实例的结果。所有失败与条件结果保存，不执行候选包正文。`dependency-production.json` 引用工具、布局、工作区发射、原链接投影、图、完整库存、解析及原始命令日志；v1 外层 payload-receipt 增加 `dependencyProduction` 引用。结果仅为 `DEPENDENCIES_PRODUCED_UNVERIFIED`，没有生成 Expected 或来源批准。

v1 与 Mac 组装阶段候选布局都为 `<candidate>/runtime/runtime-manifest.json` 和兄弟 `payload-receipt.json`。receipt 共同包含 `target.{platform,arch,productVersion,nodeVersion,engineVersion}`、`source.commit`、`runtimeManifestSha256`，desktop 另核独立提供的 receipt 原始摘要。v1 无 Expected 配方合同，状态始终 `UNVERIFIED`，安装器必须取得独立 manifest/receipt/材料来源身份。

Mac 安装描述信息为 Runtime 根之外固定兄弟 `desktop-release.json`，`trustedRuntime` 必须包含 `{arch,layout,manifestSha256,productVersion,nodeVersion,engineVersion}`。Mac 加载器使用精确 `{arch,layout}` 调原 v2 核验器，再核全部独立身份；不从 manifest 推导允许链接。CLI 与独立 Agent 各进程都重新取得库存对象；WeakMap 不能跨进程复制。

`createDarwinDistribution(distribution,{temporaryDirectory,stopTimeoutMs?})` 要求真实私有临时目录并实际运行观察器探针，返回 DarwinSourceCapability；其独立 Node 路径来自库存 Runner 角色。`recoverOffline(root,{execution?,darwinSource?})` 接同一 token。Mac doctor 只有同时获得已核 Runtime 对象与探针 token，浏览器/runner 路径完全一致时才进入安装 Mac 分支；源码直接 doctor 保留原拒绝路径。

C05b 的 Windows `requireStoppedHistory(root)` 必须使用 C07 非创建的 `openExisting(root)`：没有数据库及辅助成员时才能得到 undefined；existing 读取器不创建目录/主数据库、不执行 CREATE TABLE、不切换 journal_mode、不补写原认领。SQLite WAL 只读连接仍可能为自身锁生命周期创建/打开受有限原生会话核验的 SHM/WAL，不能宣称保证零辅助文件 I/O。任何旧 `attempts/*.json` 或 staging 均拒绝，不据其 ALLOCATED 声明推断未派生。每条原始持久行再核 ClaimDTO、attemptId、固定 work 路径、请求标识与回执；前置状态必须没有 native 过程成员，其他状态必须具备同一 Attempt 的 `.process.json` 与 `.drained.json` 且原 `confirmStopped` 确认真正排空。数据库没有行但有进程成员时仍为孤立历史。Linux/Darwin 继续使用原 JSON、原证明及 Darwin fencing 绑定，不受此分支迁移。

## 独立执行命令

以下为各独立路径的命令参考；本轮已执行范围以当前验证计划为准，其余不计通过。
应在独立工作目录记录实际提交、原锁、宿主、工具 SHA、退出状态、日志与失败现场。
直接使用 node --import tsx 和 scripts/ 相对路径的命令须从 apps/runtime 启动，
不能从仓库根照抄后将模块查找错误解释为产品缺陷；以下命令块统一以该包目录为工作目录。

```sh
cd apps/runtime
pnpm exec tsc --noEmit -p scripts/tsconfig.json
pnpm check
node --import tsx scripts/build_runtime.mts mac-inputs --job /absolute/mac-job.json
node --import tsx scripts/build_runtime.mts mac-stage --recipe /absolute/input/runtime-inputs.json --expected /absolute/review/expected.json --input-root /absolute/input --output-parent /absolute/candidates --candidate veriq-runtime-mac-x64
node --import tsx scripts/build_runtime.mts v1-inputs --job /absolute/native-v1-job.json
node --import tsx scripts/build_runtime.mts package --runtime-root /absolute/candidate/runtime --receipt /absolute/candidate/payload-receipt.json --output-parent /absolute/archives --candidate veriq-runtime-mac-x64 --mac-policy /absolute/review/mac-policy.json
```

`mac-policy.json` 只含 `{arch,layout}`，来源必须独立于待核 runtime-manifest。Linux/Windows package 不传 `--mac-policy`。`mac-stage` 的 Expected 必须在独立来源/构建/配方审核后取得；禁止读取刚生成 recipe 后直接计算字段写 Expected 来关闭任务。

既有定向测试与新增生产器应在后续环境运行：

```sh
node --import tsx --test tests/runtime-payload-*.test.ts tests/runtime-assets-*.test.ts tests/distribution-manifest-v2.test.ts
node --import tsx --test tests/controlled-*.test.ts tests/guardian-browser.test.ts tests/offline*.test.ts tests/doctor-distribution.test.ts
```

随后按实际目标运行相关正式 native 行为用例及完整固定锁 Runtime 套件。Mac 必须真实 macOS15+ 原生 x64、arm64；Windows 必须真实 Windows11 x64；Linux 必须 Ubuntu24.04 x64。测试需要本机原生 Chrome、合法私有目录、真正工具/SDK/header/cache 和独立审阅后的资产材料，不能用 Linux 模拟 Mac。

## 必须覆盖的结果与拒绝边界

| 检查                      | 独立任务的预期与边界                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 真实来源/工具             | 修改源文件、原锁、工具可执行字节、原归档、layout 或 evidence 时失败；Node 可执行 SHA 和原归档 SHA 不混用；控制环境新增未知变量继续按原门禁拒绝                                                                                                                                                                                                        |
| entry/dependency 生命周期 | 不能在活读取器原视图写入其他树；异步消费期间原字节、inode、目录变化拒绝；生产器返回前不能发布完整 candidate                                                                                                                                                                                                                                           |
| close/超时/截断           | 非零、信号、未准入、close 未确认、超时、日志截断均失败；保留真实首个错误和未知现场；不得把直接子进程关闭当任意后代停止证明                                                                                                                                                                                                                            |
| 原生正式目标              | lipo 唯一架构、otool minos15.0、实际 SDK；故障宏、测试目标、错误架构和旧产物不能进入正式原生回执；不运行真实 store                                                                                                                                                                                                                                    |
| 无扩展名的 Node 命令      | exact `#!/usr/bin/env node`、`#!/usr/bin/node` 的无扩展名目标保留真实路径；shell、MachO、带 flags、CR、截断/错误首行和其他扩展名均拒绝                                                                                                                                                                                                                |
| 同层命令冲突              | 实际 alias 决定唯一公开赢家；保留其他 owner 的原正文与摘要，私有路径必须为完整 owner.id SHA；任意私有目录、截断摘要、错误赢家/目标/alias、丢失声明均拒绝；深层 shim 要能定位固定版本的 Runner 和真实 target                                                                                                                                           |
| 依赖边 witness            | 真实 `alias/bin/esbuild` 或允许 `alias/package.json` 可证明边归属；alias 前缀混淆、错误 owner、不存在或被阻止的 exports 子路径均拒绝；entry/execution 根字面值改变一字仍拒绝                                                                                                                                                                          |
| v1 依赖准备               | 分别在原生 Windows11/Ubuntu24.04 使用真实离线 store 执行；改 pnpm 包任何实现、TypeScript 实现、源码或原锁即拒绝；store 缺包不联网补齐，冻结的安装不能改锁；Windows junction 投影及嵌套 peer 域保留，不放宽凭据 owner；验证真实 pnpm shell alias、Windows `.cmd`、私有冲突 alias、optional os/cpu 和两套 Node 条件解析；支持外部材料与准备阶段恰选其一 |
| 库存/归档                 | 缺项、额外文件、硬链接、special、逃逸符号链接、危险权限、超预算、来源变化拒绝；Mac 只允许独立 Framework 布局；v1 完全拒绝链接；归档/sidecar 原字节校验和闭合                                                                                                                                                                                          |
| 安装能力                  | 复制原对象字段、伪描述信息、自生成布局或错误宿主不获原生能力；实际角色路径与精确独立 Node 版本必须匹配；Electron 仅取得主进程有限 native 能力                                                                                                                                                                                                         |
| 停止/恢复                 | Mac 保留受控 Worker/Chrome 有界证明与未知隔离；Windows/Linux 保留完整后代树停止证明；日志未知或 owner 代际变化不能释放容量；V11 单独处理 Windows 持久 Claim 与保留期                                                                                                                                                                                  |
| Windows 历史目录          | 空历史只读检查不得创建 DB/目录；DB 缺失但有 WAL/SHM/journal、畸形 Claim/回执、旧 JSON/staging、错 Attempt/work、前置行混 native 成员、有行无排空证明或无行有 native 成员均拒绝；SQLite 行不能伪造 Job 空结果或自动退休旧历史                                                                                                                          |
| 凭据                      | 原辅助进程的锁定、拒绝、同值恢复、冲突、mutation-unconfirmed 与取消后真实退出保持；实际 Keychain/Cookie/生产信任另需明确环境及授权，不在普通源码验证中调用                                                                                                                                                                                            |

## 已知失败与尚未闭合事项

- `363732f` 真实双 Mac run `43784631223` 在 `ENTRY_ENVIRONMENT` 失败；`ac2495c` 的有限诊断尚未独立复审或重新真实运行。不得猜测允许环境变量解决。
- `2455199` Windows CI `43781415658` 的三个 ACL/所有者失败仍保留。提升账户拥有者策略未决时明确失败关闭，不通过允许 Administrators/组所有者或移除私有文件策略取得通过。
- C04 生产收据和原 Mac intake/manifest-v2 仍只支持 Darwin；v1 内置依赖准备以原生平台的独立 v1 evidence 生产，不伪造 Mac receipt。源码已提供真实安装/发射/闭包/bin/解析路径，两个平台实际 pnpm 布局、工具封装、命令 shim 格式和完整运行均尚未执行；未知链接、安装域碰撞或不支持 shim 明确失败，不从未执行的编排推断四目标验收完成。
- 本轮 source 跨模块类型、完整注释覆盖率、真实原生命令/SDK 输出格式、正式签名与打包顺序均未执行检查。Runtime 先签名再封库存；打包后改变已登记字节会使全部 hash 失效，不能标成功。
- Windows 在线持久化、离线/cache 保留期及 active/未知 Attempt 屏障的后续源码与验证单列 V11；本文件没有将其降格为纯环境验收。
- 失败/关闭未知路径保留本轮拥有根，操作者需按实际 owner 与真实关闭证据处理现场；没有任意同用户并发写入下的原子整树保证，也没有无限后代的自动清理承诺。

## Windows 三例历史结果不能绑定当前源码

只读证据核对确认2455199的Windows Server2025原生组93/96，三例各首先停在合成Cookie文件owner、
迁移夹具根owner、Node/SQLite五子项owner断言。原始日志保留，gzip及解压双摘要一致；该次没有创建令牌的
TokenOwner/提升类型，不能静默接受Administrators owner或改变唯一用户ACE规则来关闭失败。

当前C07已使Windows LocalStore先原生建立私有主库，并在打开/建表后检查主库与辅助文件；
所以旧profile失败点和当前三项通过数均待复验。尚未找到V03/V05/V11的当前原生结案记录。
后续先选仅临时ACL/合成文件、不触任何实际凭据库的观察路径，再按明确范围执行三例；
Windows Server临时宿主的结果不能替代Windows11桌面安装/GUI验收，也不改变Mac双架构最高优先级。
