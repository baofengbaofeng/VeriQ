# V05 Runtime 生产源码与独立验证交接

状态：本轮只交付源码，未执行类型检查、测试、构建、候选 Node/Chrome、原生 SDK、CI、安装、签名、钥匙串或独立复审。本文不是通过报告，不修改历史 SDD 证据或原发行门禁。

## SOURCE_DELIVERY

| 范围 | 本轮实际源码 | 未包含的结论或后续工作 |
| --- | --- | --- |
| 可执行编排 | `scripts/build_runtime.mts` 提供 `mac-inputs`、`mac-stage`、`v1-inputs`、`package`；实际命令接入原 `runBoundedAssetCli` | 尚未运行任何动作；没有自动晋升、签名、ready 或自生成 Expected |
| Mac 五树 | `runtime-release.ts` 真实调用既有 entry/execution producer、C04 dependency producer、新 native/engine producer，独立事务及第三 intake 根组合 | 原 `Recipe`、`ExpectedPayloadInputs`、stage 和 v2 清单仍只支持 Darwin；审核者必须在真实材料形成后单独提供 Expected |
| Node/npm 原始材料 | 可通过 `nodeBootstrapAssets` 调用既有 `prepareMacNodeBootstrap`；stage 再次独立消费原始归档、npm 图和审核布局 | bootstrap 的 `UNREVIEWED_SOURCE`、pending 和原始权限边界保持；该结果不是可执行批准 |
| Mac 正式原生 | 运行原 `build-darwin.mjs` 与无测试开关 `build-vault-darwin.mjs`，实际 xcrun SDK、lipo、otool、SDKSettings、vault build-facts，生成完整 native 库存与正式 receipt；可选显式 nativeSigning 在封库存前真实签署新产物 | 本轮未运行编译、codesign、addon/helper；没有真实 Cookie、控制台、生产 Keychain 或签名安装结论 |
| 引擎材料 | 调用原 `scripts/build_engine.mts` 真实编译 SDK/contracts、打包 compiler/vendor、生成 npm 离线锁；核 Schema、唯一版本、全部实际文件并生成 ENGINE_PAYLOAD receipt | 原 producer 的依赖限制仍成立；没有调用签发或批准引擎装载流程 |
| Linux/Windows v1 | `runtime-release-v1.ts` 按旧 manifest schemaVersion1 生成实际 Vite 入口、执行源码、独立 Node 角色、正式 native、版本化 engine 与完整清单、候选 receipt | Node/npm/Chrome/生产依赖及其来源证据由调用者独立库存提供；Windows/Linux 生产依赖全自动构建不是 C04 Darwin receipt 的已实现跨平台等价物 |
| 归档 | `runtime-release-package.ts` 固定排序/时间/portable tar，不跟随链接，前后复验库存，输出 `candidate.json`、`payload-receipt.json`、`checksums.json` | Mac 链接仍需独立 `{arch,layout}` 文档；校验和文档明确排除自身；归档不是发行批准 |
| Mac 安装消费 | `loadMacRuntimeDistribution`、`loadInstalledRuntimeDistribution`、`bindDarwinDistribution`；原生和 helper 只授予原始返回对象的私有 WeakMap 能力 | 可信 descriptor 需要由安装器/可信包外层认证，不能由待核 Runtime 自举；真实签名装载仍待 V03/V05 |
| Mac 受控执行 | `createDarwinDistribution` 使用已核独立 Runner Node 及固定库存 preload 实际探针；CLI/桌面在线、离线与恢复可传同一私有品牌 token | 运行时才执行探针；Electron 不被当作 Node24；Mac 只承诺既有 CONTROLLED_WORKER_BROWSER 范围，不扩大任意后代停止保证 |
| Mac 凭据 | 新 DarwinVaultBackend 接原有有限 V1 helper 传输，helper 必须由库存授予；原生 Keychain helper 无修改 | 构造不访问系统 store；真实锁定/同值恢复/提交不确定/ACL/重启行为仍需独立运行 |
| 真实 bin 修正 | held 字节的精确 Node 首行允许无扩展名 Node 命令；保留公开赢家、其余同名命令使用 `.bin/.veriq/<sha256(owner.id)>/<name>`；边归属 witness 可采用真实解析子路径 | 根绑定与 entry/execution 字面 specifier 仍精确匹配；不改包路径、不改正文、不伪造 native inspection 或 Node 成功解析 |
| Windows 在线持久化与本机保留期 | 交给协调者分配的 [V11](V11-local-durability.md)，本批未宣称完成 | Windows 旧 `ONLINE_JOURNAL_DURABILITY_UNSUPPORTED` 与缺少 active/unknown Attempt 安全保留期入口是具体源码缺口，由 V11 独立记录实际交付 |

## 接口与材料

所有路径必须绝对，源码与工作根由调用者独占。`MacRuntimeProductionJob` 定义于 `apps/runtime/scripts/runtime-release.ts`：

| 字段 | 内容 |
| --- | --- |
| `sourceRoot` | 具有冻结依赖、实际 Vite/pnpm/node-gyp/TypeScript 与原源码的独占 checkout；不会把共享 node_modules 复制成来源绑定 |
| `seedRoot` | 原始 Node/Chrome 归档、来源归档、原始绑定、锁、独立 Chrome 布局及全部 tool/archive receipt 的输入根 |
| `workParent` | 与 sourceRoot/seedRoot 互不覆盖的真实已存在目录；本轮随机拥有的工作根始终返回/失败保留 |
| `recipe` | 既有 Recipe 除五个 BoundTree 以外的原字段；仍为 `MAC_RUNTIME_PAYLOAD_INPUTS`、真实 Darwin 架构 |
| `hostBuild` | `executable`、`viteCli`、`pnpmCli`、`pnpmStore`、`headerCache`、`engineOutput`、`timeoutMs`，全部为真实工具或目录；Node 必须是当前实际独立构建 Node 的规范物理路径且精确版本等于目标 |
| `targetNode` | C04 的 `{executable,version,artifactSha256}`；SHA 指实际 Node 可执行字节，必须等于 `recipe.tools[name=node].artifactSha256`，原归档 SHA 单独由 `recipe.node.file` 绑定 |
| `nodeBootstrapAssets?` | seedRoot 中原 assets 输入文档的独立 Ref；启用时只生产原始 Node/npm 材料并保留原未审标签 |
| `nativeSigning?` | `{identity,entitlements?:Ref,timestamp?:"secure"\|"none"}`；identity 由操作员明确提供，entitlements 必须是原 SourceBinding 中精确 Ref；默认不签名 |

source.binding 必须是规范 JCS 的现有 SourceBindingV1；caller 提供源文件集合，生产器不补写可信绑定。集合必须包含原 stage/generator 固定源码、完整 entry 输入、C04 requiredSources（包括新增 dependency/workspace/adapter/resolver 模块）、pnpm-workspace.yaml、原清单、LICENSE、完整 contracts/SDK 源码与 Schema、原 native 源码和三个正式原生脚本、scripts/build_engine.mts。遗漏会失败，不能以 producer 生成的新 JS 冒充原 Git 文件。

nativeSigning 固定使用真实 `/usr/bin/codesign`，在新编译 addon/helper 原路径调用 `--force --sign <identity> --options runtime --timestamp`（或明确 `--timestamp=none`）和可选原始 entitlements，再实际 `--verify --strict --verbose=2`、`--display --verbose=4`。签名工具原字节 SHA、开始/结束身份、实际命令、身份与时间戳策略显式记录到 `native-build.json` 的 signing 段。该段属于 commandEvidence 的实际签名动作，不把 codesign 冒称为 clang，也不改变现有公共 Tool 枚举与构建工具集合。vault build-facts 描述签名前编译产物，inspection 另列 unsignedBuildOutput 与最终 signed SHA。原始 Node/Chrome 字节从不被重签。签名后的五树材料仍需独立 Expected 审核；默认和签署候选都没有自动晋升为正式发行。

`produceMacRuntimeInputs(job, run)` 返回 `inputRoot`、原始配方 Ref、`workDirectory`、`producerTransactionsCleanup: "CONFIRMED"`、`AWAITING_INDEPENDENT_EXPECTED`。这个 cleanup 只描述两个 producer 事务，不表示已删除 retained intake、构建目录、Node bootstrap、engine 输出或所有后代进程。调用者仍拥有这些明确保留的生命周期。失败时不在未知关闭之后继续扫描或递归删除构建根。

entry producer 回调只复制到第三 intake，等待其全部 reader/lifetime 核验与事务清理后才进入 C04；C04 回调只复制到第四 dependency snapshot，等待 C04 consumers reader 收尾后才合入 intake。native/engine 随后追加独立树。正常 source/evidence 重复只允许原字节相同。

`RuntimeV1ProductionJob` 定义于 `runtime-release-v1.ts`，四个材料 `node/npm/browser/dependencies` 及 `materialEvidence` 均为 `{root,files: FileFact[]}` 独立完整库存。Node 材料恰含 `node` 或 `node.exe`。browser 根文件需包含 `chrome-linux64/chrome` 或 `chrome-win64/chrome.exe`；dependencies 根相对 `node_modules/`，需已包含平台正确的生产闭包、生成 Workspace JS、tsx、optional/peer/bin 材料。源文件必须绑定实际 Vite/native/engine producer。Windows 正式 guardian 原名 `veriq_guardian.exe` 复制为旧 loader 固定的 `native/veriq_runner.exe`，字节不变，不能以角色 Node 代替。

v1 与 Mac stage 候选布局都为 `<candidate>/runtime/runtime-manifest.json` 和兄弟 `payload-receipt.json`。receipt 共同包含 `target.{platform,arch,productVersion,nodeVersion,engineVersion}`、`source.commit`、`runtimeManifestSha256`，desktop 另核独立提供的 receipt 原始摘要。v1 无 Expected 配方合同，状态始终 `UNVERIFIED`，安装器必须取得独立 manifest/receipt/材料来源身份。

Mac 安装 descriptor 为 Runtime 根之外固定兄弟 `desktop-release.json`，`trustedRuntime` 必须包含 `{arch,layout,manifestSha256,productVersion,nodeVersion,engineVersion}`。Mac loader 使用精确 `{arch,layout}` 调原 v2 核验器，再核全部独立身份；不从 manifest 推导允许链接。CLI 与独立 Agent 各进程都重新取得库存对象；WeakMap 不能跨进程复制。

`createDarwinDistribution(distribution,{temporaryDirectory,stopTimeoutMs?})` 要求真实私有临时目录并实际运行观察器探针，返回 DarwinSourceCapability；其独立 Node 路径来自库存 Runner 角色。`recoverOffline(root,{execution?,darwinSource?})` 接同一 token。Mac doctor 只有同时获得已核 Runtime 对象与探针 token，浏览器/runner 路径完全一致时才进入安装 Mac 分支；源码直接 doctor 保留原拒绝路径。

## 独立执行命令

以下命令本轮均未运行；应在独立工作目录记录实际提交、原锁、宿主、工具 SHA、退出状态、日志与失败现场。

```sh
pnpm exec tsc --noEmit -p apps/runtime/scripts/tsconfig.json
pnpm --filter @veriq/runtime check
node --import tsx scripts/build_runtime.mts mac-inputs --job /absolute/mac-job.json
node --import tsx scripts/build_runtime.mts mac-stage --recipe /absolute/input/runtime-inputs.json --expected /absolute/review/expected.json --input-root /absolute/input --output-parent /absolute/candidates --candidate veriq-runtime-mac-x64
node --import tsx scripts/build_runtime.mts v1-inputs --job /absolute/native-v1-job.json
node --import tsx scripts/build_runtime.mts package --runtime-root /absolute/candidate/runtime --receipt /absolute/candidate/payload-receipt.json --output-parent /absolute/archives --candidate veriq-runtime-mac-x64 --mac-policy /absolute/review/mac-policy.json
```

`mac-policy.json` 只含 `{arch,layout}`，来源必须独立于待核 runtime-manifest。Linux/Windows package 不传 `--mac-policy`。`mac-stage` 的 Expected 必须在独立来源/构建/配方审核后取得；禁止读取刚生成 recipe 后直接计算字段写 Expected 来关闭任务。

既有定向测试与新增生产器应在后续环境运行：

```sh
node --import tsx --test apps/runtime/tests/runtime-payload-*.test.ts apps/runtime/tests/runtime-assets-*.test.ts apps/runtime/tests/distribution-manifest-v2.test.ts
node --import tsx --test apps/runtime/tests/controlled-*.test.ts apps/runtime/tests/guardian-browser.test.ts apps/runtime/tests/offline*.test.ts apps/runtime/tests/doctor-distribution.test.ts
```

随后按实际目标运行相关正式 native 行为用例及完整固定锁 Runtime 套件。Mac 必须真实 macOS15+ 原生 x64、arm64；Windows 必须真实 Windows11 x64；Linux 必须 Ubuntu24.04 x64。测试需要本机原生 Chrome、合法私有目录、真正工具/SDK/header/cache 和独立审阅后的资产材料，不能用 Linux 模拟 Mac。

## 必须覆盖的结果与拒绝边界

| 检查 | 独立任务的预期与边界 |
| --- | --- |
| 真实来源/工具 | 修改源文件、原锁、工具可执行字节、原归档、layout 或 evidence 时失败；Node 可执行 SHA 和原归档 SHA 不混用；控制环境新增未知变量继续按原门禁拒绝 |
| entry/dependency 生命周期 | 不能在活 reader 原视图写入其他树；异步消费期间原字节、inode、目录变化拒绝；producer 返回前不能发布完整 candidate |
| close/超时/截断 | 非零、信号、未准入、close 未确认、超时、日志截断均失败；保留真实 first error 和未知现场；不得把 direct child close 当任意后代停止证明 |
| 原生正式目标 | lipo 唯一架构、otool minos15.0、实际 SDK；故障宏、测试目标、错误架构和旧产物不能进入正式 native receipt；不运行真实 store |
| extensionless Node bin | exact `#!/usr/bin/env node`、`#!/usr/bin/node` 的无扩展名目标保留真实路径；shell、MachO、带 flags、CR、截断/错误首行和其他扩展名均拒绝 |
| 同层命令冲突 | 实际 alias 决定唯一公开赢家；保留其他 owner 的原正文与摘要，私有路径必须为完整 owner.id SHA；任意私有目录、截断摘要、错误赢家/目标/alias、丢失声明均拒绝；深层 shim 要能定位 pinned Runner 和真实 target |
| 依赖边 witness | 真实 `alias/bin/esbuild` 或允许 `alias/package.json` 可证明边归属；alias 前缀混淆、错误 owner、不存在或 blocked exports 子路径均拒绝；entry/execution 根字面值改变一字仍拒绝 |
| 库存/归档 | 缺项、额外文件、hardlink、special、逃逸 symlink、危险权限、超预算、来源变化拒绝；Mac 只允许独立 Framework 布局；v1 完全拒绝链接；归档/sidecar 原字节校验和闭合 |
| 安装能力 | 复制原对象字段、伪 descriptor、自生成布局或错误宿主不获原生能力；实际角色路径与精确独立 Node 版本必须匹配；Electron 仅取得主进程有限 native 能力 |
| 停止/恢复 | Mac 保留受控 Worker/Chrome 有界证明与未知隔离；Windows/Linux 保留 full descendant proof；日志未知或 owner 代际变化不能释放容量；V11 单独处理 Windows 持久 Claim 与保留期 |
| 凭据 | 原 helper 的锁定、拒绝、同值恢复、冲突、mutation-unconfirmed 与取消后真实退出保持；实际 Keychain/Cookie/生产信任另需明确环境及授权，不在普通源码验证中调用 |

## 已知失败与尚未闭合事项

- `363732f` 真实双 Mac run `43784631223` 在 `ENTRY_ENVIRONMENT` 失败；`ac2495c` 的有限诊断尚未独立复审或重新真实运行。不得猜测允许环境变量解决。
- `2455199` Windows CI `43781415658` 的三个 ACL/所有者失败仍保留。提升账户拥有者策略未决时明确失败关闭，不通过允许 Administrators/group owner 或移除私有文件策略取得通过。
- C04 生产收据和原 Mac intake/manifest-v2 仍只支持 Darwin；v1 的完整依赖材料准备及其平台真实解析需要 V04 或后续独立生产任务，不能从包装器推断四目标全部功能完成。
- 本轮 source 跨模块类型、完整注释覆盖率、真实原生命令/SDK 输出格式、正式签名与打包顺序均未执行检查。Runtime 先签名再封库存；打包后改变已登记字节会使全部 hash 失效，不能标成功。
- Windows 在线持久化、离线/cache 保留期及 active/unknown Attempt barrier 的后续源码与验证单列 V11；本文件没有将其降格为纯环境验收。
- 失败/关闭未知路径保留本轮拥有根，操作者需按实际 owner 与真实关闭证据处理现场；没有任意同用户并发写入下的原子整树保证，也没有无限后代的自动清理承诺。
