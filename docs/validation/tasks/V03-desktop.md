# V03：桌面安装、生命周期与升级独立验证

状态：2026-11-16 源码交付；本轮未运行测试、类型检查、构建、CI、codesign、安装、Keychain/Cookie 操作或独立复审。本文件不宣称四个目标支持已验收。操作细节和接口见 [桌面打包说明](../../../deploy/desktop/README.md)。

## SOURCE_DELIVERY

| 实现范围 | 已交付源码 | 剩余工作 / 边界 |
| --- | --- | --- |
| 四目标真实打包 | electron-builder26.18.1 工厂和 CLI，Mac 两架构 pkg、Windows NSIS、Ubuntu deb | 所有真实构建与安装均未执行，签名材料须独立提供 |
| 独立输入 | 外部 expected、候选/来源/回执/GUI/Runtime 精确绑定，Mac 原有限链接验证器，复制后/afterPack/afterSign 复验 | 没有批准 expected，不从扫描结果自动批准，不输出 ready |
| 本地 UI 与角色布局 | 原 electron-vite/stage-runtime 复用，GUI ASAR，物理 Node24/Agent/Runner/Chrome/引擎在 Runtime 外置资源，fuse 明确配置 | 真实 bundle AST 外部依赖、加载解析和安装后 hash 仍需验证；不能沿用旧产物结论 |
| Mac 宿主 | Bundle ID、macOS15、宿主架构、安装路径和显式签名模式先核验；main 直接绑定已核 Darwin NAPI | 真机两架构签名/加载、Cookie/控制台/默认 Keychain 尚未验收；独立文件 Keychain helper 未替换 |
| 生命周期 | Mac tray/menu/Dock、Windows/KDE tray、Linux 最小化回退、系统菜单、登录项、退出 UI/停止 Agent 分离、版本诊断 | 真实桌面环境、系统会话、崩溃重连和进程名仍须逐目标观察 |
| 手动升级/回滚 | Ed25519 清单验签、安装器完整性与原生签名、私有暂存、持续空闲门禁、真实停止后人工安装 | 仅相同引擎与数据格式2；跨引擎迁移/数据格式迁移被明确拒绝，需未来独立设计实现，不作为本入口已支持 |
| 安装/卸载 | 活动角色及不确定查询拒绝、无强杀、保留外置 profile、Ubuntu 固定路径 AppArmor | 真实安装器阶段与多个 OS 会话竞争验证未执行；用户绕过 GUI 直接安装仍受系统签名和原生进程拒绝门禁 |
| 测试源码 | `installation.test.ts` 合成签名/目标/回滚/库存拒绝，Cookie 无宿主能力拒绝断言更新 | 全部未执行，不把合成密码算法用例计为原生系统验收 |

## 精确入口和接口

- `pnpm --filter @veriq/desktop build:gui`：现有 Vite 输出和静态 GUI 清单，不能自动批准。
- `pnpm --filter @veriq/desktop package:installer`：参数及外部身份合同见打包说明；只接受原生对应宿主，输出 `PACKAGED_UNVERIFIED`。
- `pnpm --filter @veriq/desktop package:sign-update`：显式现有私钥签封套，不能申请证书或发布。
- 安装资源：`resources/desktop-release.json` 与 `resources/runtime/runtime-manifest.json`；Mac 技术程序路径 `/Applications/veriq.app/Contents/MacOS/veriq`，显示名 VeriQ。
- Runtime 接口：C05 `loadMacRuntimeDistribution(root, trusted)`、`bindDarwinDistribution`、`createDarwinDistribution`、`recoverOffline(root, {execution,darwinSource})`、`diagnoseRelease({runtime,darwinSource,...})`；Desktop 保留原始对象能力，不复制自报 JSON 授权。
- IPC：新增有限 `installUpdate()`，没有 renderer 路径参数；维护命令 `prepareMaintenance` 只由可信 main 请求，不加入 renderer 本机操作白名单。
- 来源回执：`target` 五字段、`source.commit`、`runtimeManifestSha256`，外部 `runtimeReceiptSha256` 绑定原始字节；Mac 使用原 `payload-receipt.json`。
- 源码生成：仅执行了 `node apps/desktop/scripts/generate-operations.mjs` 同步共享 OpenAPI 派生材料，未增加云端 IPC 白名单权限；这是代码生成，不是验证或构建通过证据。

## 目标与前置环境

| 优先级 | 独立目标 | 前置条件 | 实际结果 |
| --- | --- | --- | --- |
| P0 | macOS15+ Intel x64 | 原生 Mac、原生宿主 Chrome、独立 Node24 精确版本、真实五树材料与外部 expected、足够磁盘、独立临时账户/安全会话 | 未执行 |
| P0 | macOS15+ Apple Silicon arm64 | 同上；原生 arm64 Node/Electron/NAPI/Chrome，不能用 Linux VM 或 Intel/Rosetta 结果替代 | 未执行 |
| P1 | Windows11 x64 | 真实 Windows11 用户桌面，独立 Node24，Windows IPC/ACL/Job 与凭据服务，签名材料另授权 | 未执行；历史 Server 结果不替代 |
| P1 | Ubuntu24.04 x64 | 干净 Ubuntu 原生桌面/真实 Secret Service、系统库和字体、固定 root-owned 安装路径及 AppArmor | 未执行；Debian/Xvfb 结果不替代 |

构建宿主需冻结 Node24、pnpm11.25.0、根锁文件与工具精确版本，Electron45.3.1、electron-vite6.0.0、electron-builder26.18.1。Mac source/lock/recipe/Chrome 布局及输入 Expected 必须按既有 Runtime 准入链独立批准；没有这些材料就记录阻塞，不制作假 receipt。最低空间预算 12 GiB，按实际资源提高。正式签名证书、公证账户、Ed25519 发布公钥/私钥、Windows ACL 权限与原生系统信任均需独立提供授权。

## 待执行检查

所有行的实际状态均为**未执行**，接手者记录命令、退出码、实际提交、工具/锁摘要、产物与失败原因。不要把下列命令当成本轮已通过。

| 阶段 | 命令 / 操作 | 预期与拒绝边界 |
| --- | --- | --- |
| 代码检查 | `pnpm --filter @veriq/desktop check`，包括新增 packaging tsconfig；定向 ESLint/Prettier 及注释审计 | 无新类型/格式/有效注释问题，既有全仓债务仍分别登记 |
| 单元 | `pnpm --filter @veriq/desktop test:unit` | 真 Ed25519 合成验签拒绝错发布者/篡改/无公钥；版本、目标、引擎和格式拒绝；GUI 全资源库存/链接/缺失入口拒绝；原 Cookie/IPC/Agent 回归 |
| 来源与 Vite | 执行对应源码 build:gui、C04/C05 真入口、外部审阅 Expected | 实际 main/agent/cli/preload/renderer 与依赖闭包一致，无源码路径、pnpm链接或全局模块后备；fuses 及其传递依赖实际编入 GUI |
| 原生 installer | 四目标分别执行 package:installer，保留 stdout/stderr 与 result | pkg/exe/deb 均存在且 hash真实；未核输入/目标不符/外部期望在候选内/空间不足/已有输出必须拒绝；状态一直未验收 |
| 不可变 Runtime | 对原始、复制后、afterPack、afterSign、实际安装资源分别重核原 expected 和完整库存 | Runtime/Node/插件/Chrome 任一签名改写均失败，绝不能重新 hash 后自动批准；Mac Framework 原始链接不增删 |
| 应用签名 | 双 Mac 分别 `codesign --verify --deep --strict`、`codesign --display --verbose=4`；pkg `pkgutil --check-signature`；Windows `Get-AuthenticodeSignature`；Linux真实发布签名 | 明确记录 unsigned/ad-hoc/native-signed；证书身份、Bundle ID 和架构正确；不把 checksum 或临时 VM 签名当生产信任；公证/Gatekeeper单独验证 |
| Mac 直接装载 | 启动已安装 .app，验证 main 真实 NAPI路径/架构/ABI/签名；改换库存、目标、插件、BundleID或低版本系统 | 在私有档案/Cookie建立前失败；main直接加载，不能出现独立 Node 文件代理或 Linux 浏览器替代 |
| 独立角色 | 安装后无终端使用 GUI/下载/运行/取消/报告/回传；观察实际 OS 进程名称、execPath、Node与Chrome版本 | UI为veriq，Agent/Runner独立Node24且hash匹配；Electron内嵌Node不能替代；正式安装不需要Python/MySQL/cc/pnpm |
| 生命周期 | 关闭按钮首次提示、tray/menu/Dock、第二实例、Cmd/Ctrl+Q、普通菜单、OS登录项、UI崩溃和Agent重连 | 关闭可恢复；退出UI后Agent继续；停止Agent原生确认并真实收尾；登录项只在实际支持目标生效；所有版本身份分别显示 |
| 活动更新拒绝 | preparing/active/online/viewer/interruption/QUARANTINED/未知历史/SQLite占用期间准备升级 | 不取消Run，不替换文件，不吞错误；原命令继续可观测；持久停止历史与合作锁均要满足 |
| 更新正向/回滚 | 用独立真实发布者公钥签名清单，相同引擎和格式；改签名/文件hash/来源版本/架构/证书/引擎/格式分别重试 | 拒绝所有不匹配；复制后全字节再核；空闲证明和停止之后显示安装器并退出UI，人工安装；失败保留旧app/profile和诊断，不自动删除或重放 |
| 包管理竞争 | UI/Agent/Runner/CLI仍运行、另用户会话角色、工具错误/无法枚举、旧UI仍退出中、CLI重新启动时运行安装器 | 原生pkg/NSIS/deb拒绝而不杀任何同名进程；NSIS自定义宏确实替代默认关进程；无权限/工具错误不能等同不存在 |
| Ubuntu沙箱 | 实际 /opt 固定目录权限、GUI与测试Chrome AppArmor、可见/无头执行、离网系统库/字体 | 沙箱生效，不修改全局限制，不向任意可写路径授权；完整库闭包缺失时失败说明 |
| 卸载与保留 | 每目标安装→配置/报告→卸载→同版本重装、升级失败/回滚 | 外置配置/凭据/资源/历史保留；显式凭据退役仍独立；不把删除目录称为物理擦除 |
| GUI E2E | 对应目标 `pnpm --filter @veriq/desktop test:e2e` 及真实断网/恢复流程 | 登录、Workspace、设备、资源、离线运行、报告、Trace、幂等上传完整，不以mock GUI通过替代 |

## Mac Keychain、Cookie 和真实控制台专门前置

- 两架构分别使用本次新建、经账户与安全会话预检的独立临时 Mac VM。既有私有文件 Keychain 临时账户结果不能覆盖新 VM。保留同任务内 helper退出、钥匙串条目/文件删除及目录清理事实。
- 真实 Cookie 持久化要验证已修改副本的 fuse、实际 OS 提供者、冷启动读回与磁盘明文搜索；先核应用签名与原始宿主能力，合成 `v10` 结果不能计为真实加密。
- 真实控制台登录、锁定/解锁、默认用户 Keychain 与生产信任操作需要单独人工授权；本轮只提供源码，未取得或使用这些授权。
- 独立文件 Keychain helper 与 GUI safeStorage Cookie 是两个边界。验证任一项不能替代另一项；main NAPI 只处理有限私有文件与Cookie文件操作。

## 既有失败、已知限制与风险

| 项目 | 保留事实 / 后续要求 |
| --- | --- |
| Windows历史ACL | 同提交 `2455199` 的 Server CI 曾96项中3项ACL/owner失败；真实Windows11及当前源码未验收，不能放宽私有权限使其通过 |
| Mac入口历史失败 | `363732f` 双Mac `ENTRY_ENVIRONMENT` 失败；`ac2495c` 诊断修复尚无新原生结果，不能猜测允许环境或移除门禁 |
| 质量门禁 | 根已登记全仓注释约4.56%与历史lint失败；本轮新代码仍需真实格式、类型、注释与完整质量审查，未声称达标 |
| 原生包信任 | Runtime须先签名后封库存；GUI签名不替代Runtime内层签名兼容或加载检查。unsigned/ad-hoc不能作为正式发行 |
| 首版更新范围 | 拒绝跨引擎和数据库格式更新；如产品需要迁移到另一引擎/格式，需独立实现历史引擎保留与迁移恢复，本入口不会暗中处理 |
| 人工安装边界 | 维护证明与实际原生安装之间为用户操作；安装器再次检查活角色，不能承诺抵抗恶意用户绕过系统签名/包管理器替换自身文件 |
| GUI依赖闭包 | builder使用Runtime node_modules物理副本；@electron/fuses显式内联，必须实际确认Vite传递依赖与所有动态加载均闭合 |
| 路径与空间 | Mac技术程序名veriq.app、产品显示VeriQ。输入和输出要求真实无链接路径；空间预算可能高于12GiB，缺失应阻塞而非跳过 |

后续独立复审须覆盖所有新增生产路径、签名输入和失败恢复。通过适用项前不得标记桌面 ready、四目标已支持或完整 MVP 完成。

## 协调者串行提交前的未完成接线

- C05 已同意提供**封库存之前**的显式原生签名生产选项；C03 消费接口、`signIgnore` 和复制后/签名后复验已实现。生产选项的精确 CLI/API 及其操作说明仍待 C05 返回后补录，目前不能把文档中的前置签名材料当成该生产选项已经接通的证明。
- C07 本地保留期维护 helper 正在实现；当前 GUI 只有已有按已登记 `bundleId` 的明确确认 `clearBundle`。新的全量有界保留期清理 GUI 操作尚未接线，需待 helper 实际 API 与 `desktopOwner` 原始能力复用接口落地后补实现，不把 CLI 后台维护冒称成 GUI 已完成。
- 此处仅完成 C03 核心源码交接，协调者要求先停止写入并串行提交，后续接线作为明确的拥有路径跟进；全部测试/构建/安装/签名/复审仍未执行。
