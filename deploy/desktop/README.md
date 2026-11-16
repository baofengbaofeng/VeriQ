# VeriQ desktop packaging

此目录是安装源码与操作约定，不是已构建安装包或通过报告。Mac Intel、Apple Silicon 各自使用 macOS 15+ 原生宿主；Windows 使用 Windows 11 x64；Linux 使用 Ubuntu 24.04 x64。本轮没有运行构建、安装、签名、测试或发布。

## 输入与命令

先用已有入口生成 GUI：

```sh
pnpm --filter @veriq/desktop build:gui
```

它复用现有 Web desktop 类型产物、electron-vite 三层构建和 `stage-runtime.mjs`；输出 `apps/desktop/out/` 与 `apps/desktop/desktop-inventory.json`。`build` 仍提供 Linux 源码开发 helper；正式安装器只消费独立 Runtime 生产器的真实完整资源树。

Runtime 必须为 `<candidate>/runtime/`，清单固定为 `runtime-manifest.json`；外部回执必须包含以下字段，Mac 可直接使用既有 `payload-receipt.json`：

| 字段 | 要求 |
| --- | --- |
| `target` | `platform/arch/productVersion/nodeVersion/engineVersion` 全部明确且相同 |
| `source.commit` | 实际源码完整 40 位 SHA |
| `runtimeManifestSha256` | 原始 Runtime 清单摘要 |

另由独立审核者提供期望 JSON，放在候选与 GUI 树外，不能从本次扫描自动批准。它包含 `DesktopRelease` 的全部字段与 `runtimeReceiptSha256`：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion/appId/productName` | `1`、`io.github.baofengbaofeng.veriq`、`VeriQ` |
| `candidate/sourceCommit/platform/arch/productVersion` | 不可变候选名、源码、单一原生目标和产品版本 |
| `signing.mode` | `DEVELOPMENT_UNSIGNED`、Mac `AD_HOC` 或明确配置的 `NATIVE_SIGNED` |
| `signing.identity` | 仅 native-signed 的实际 Developer ID Application / Windows 证书主体 |
| `guiInventorySha256` | `desktop-inventory.json` 原始字节 SHA256 |
| `profileFormat` | 首版固定为 `2`，对应现有 SQLite 数据格式 |
| `trustedRuntime` | `arch/manifestSha256/productVersion/nodeVersion/engineVersion`；Mac 另含外部可信 `layout` |
| `trustedRuntime.layout` | 既有 MacChromeLayout；不能从待核清单自动授权 Framework 链接 |
| `runtimeReceiptSha256` | 外部回执的原始 SHA256 |
| `updatePublicKeyPem` | 可选的已配置 Ed25519 发布者公钥；缺少时明确拒绝 GUI 人工更新 |

真实输入审核完成后，操作者在对应原生宿主运行以下入口；大写路径代表操作者提供的真实绝对路径，不能原样执行或用示例摘要替代：

```sh
pnpm --filter @veriq/desktop package:installer \
    --expected /ABS/APPROVED/desktop-expected.json \
    --runtime /ABS/CANDIDATES/CANDIDATE/runtime \
    --receipt /ABS/CANDIDATES/CANDIDATE/payload-receipt.json \
    --gui /ABS/CHECKOUT/apps/desktop/out \
    --output /ABS/OUTPUT/NEW-CANDIDATE \
    --signing DEVELOPMENT_UNSIGNED
```

`--output` 必须尚不存在，父目录与临时目录要有实际足够空间。入口最低保留 12 GiB，并按真实 Runtime 字节提高预算。`AD_HOC` 仅适用于 Mac；`NATIVE_SIGNED` 还要求 `--identity`，Mac 另要求 `--installer-identity`。本源码不申请证书、不自动公证、不取得生产凭据。Linux 的发行签名使用独立 Ed25519 清单或包仓库；CLI 拒绝把 Linux 标为 `NATIVE_SIGNED`。unsigned 模式清除偶然存在的签名环境，不能自动选用本机证书。

Mac 安装器是 pkg；技术程序目录为 `/Applications/veriq.app`，Bundle ID 和显示产品名仍是 VeriQ。Windows 为交互式 NSIS，Ubuntu 为 deb。GUI、preload 与 renderer 进入 ASAR；角色 Node、npm、执行器、引擎、Chrome 与原生辅助程序完整位于 `resources/runtime`。所有目标检查输出真实安装器，并生成 `desktop-package-result.json`，状态始终为 `PACKAGED_UNVERIFIED`。

## 不可变签名边界

Runtime 的 Node、Chrome、角色和原生插件如需签名，必须在库存封存之前完成。builder 的 Mac `signIgnore` 保留整个 Runtime 子树；`afterPack` 与 `afterSign` 仍使用原期望重新核对实际打包资源。任何字节变化都拒绝，不重写清单或自动自信任。Electron GUI 自身的 fuse 与签名只修改 builder 新副本。

正式 Mac 签名模式要求 Runtime 内部原生代码已经具备与目标加载政策兼容的签名。AD_HOC 只表示本机候选，unsigned 的 Apple Silicon 执行限制必须如实记录；两者都不能充当正式签名发行。最终包的签名链、公证/Gatekeeper、库存与安装后加载仍按 V03 独立验收。

## 更新与回滚

首版采用人工发起的升级。用户选择发布者签名 JSON；宿主核对当前安装公钥、目标、来源版本、安装器 hash/大小与原生签名，复制到私有档案的 `update-<uuid>/`。准备期间禁止并发更新。发布者清单必须声明相同 `profileFormat=2` 与相同 `runtimeEngineVersion`，并在 `compatibleEngineVersions` 保留当前引擎；本入口拒绝通过桌面壳更新静默更换引擎或降级数据库格式。

后台的 `prepareMaintenance` 封住新业务请求，拒绝准备、执行、在线领取、查看器与正在中断的操作；再复用现有在线停止历史证明、Agent 合作锁与 SQLite `holdIdle`。任何未知或隔离历史均拒绝，不为了升级取消 Run。取得空闲证明后显式停止后台，打开已核验安装器所在目录并退出 UI；用户在 UI 完全退出后手动启动安装。安装器仍独立拒绝实际存在的产品角色，查询失败也拒绝，绝不强杀同名进程。

签名正文必须是 `DesktopUpdate`：`schemaVersion/appId/platform/arch/version/direction/fromVersions/compatibleEngineVersions/runtimeEngineVersion/profileFormat/installer`；`installer` 包含 `name/sha256/sizeBytes/nativeSigner`。`nativeSigner` 为 Mac Installer 证书身份、Windows 证书 SHA1 指纹，Linux 使用明确的签名策略标签。`direction` 可为 `upgrade` 或 `rollback`，回滚同样要明确列出当前来源版本，不自动推断兼容。

发布者持有既有私钥时可生成标准封套；此工具不生成密钥、不执行 codesign，也不发布：

```sh
pnpm --filter @veriq/desktop package:sign-update \
    --release /ABS/TRUSTED/CURRENT/desktop-release.json \
    --payload /ABS/REVIEWED/update-payload.json \
    --key-file /ABS/PRIVATE/publisher-key.pem \
    --output /ABS/NEW/update.veriq-update.json
```

封套仅含 `payload` 与 `signature` 两个 base64 字段，签名覆盖 payload 的原始字节。POSIX 私钥需当前账户所有且无组/其它权限；Windows 发布账户 ACL 需独立验收。公钥供应和轮换属于明确发布操作，不能从下载材料自举信任。

## 数据与卸载

配置、设备身份、凭据密文、SQLite、离线资源和报告位于应用外的 Electron userData `VeriQ/profile`，可信开发启动器的显式 profile 继续保留。安装、升级、回滚及卸载均默认保留；NSIS 显式 `deleteAppDataOnUninstall=false`，Mac pkg 与 deb 不删除用户目录。卸载前先通过产品已有独立流程退役秘密；删除应用不等于退出设备信任，也不承诺介质擦除。手动暂存的安装器保留以便安装与恢复，可在完全停止后自行清理对应 `update-<uuid>` 目录。

App 的关闭按钮首次提示后收起到托盘/菜单栏，缺少 Linux 托盘时最小化；Dock 或第二实例恢复原窗口。退出 UI 不停止 Agent，停止 Agent 需要另一原生确认。Mac/Windows 安装版通过系统登录项 API 显式开关启动 GUI，Linux 不伪称支持这个 API。版本诊断分开显示 GUI/Electron/内嵌 Node/Chromium 与独立 Node、产品、引擎、候选及签名模式。

独立验收清单见 [V03](../../docs/validation/tasks/V03-desktop.md)。

## Mac 原生签名材料的实际生产入口

C05 已实现 `scripts/build_runtime.mts mac-inputs` 的 `MacRuntimeProductionJob.nativeSigning`。它是现有五树真实生产任务的可选字段，不是 desktop installer 在打包后重写 Runtime 的开关：

| 字段 | 实际要求 |
| --- | --- |
| `nativeSigning.identity` | 操作者已有的 `Developer ID Application: …` 身份，必须显式提供；不申请、导入或自动选择证书 |
| `nativeSigning.entitlements` | 可选 `{path,sizeBytes,sha256}`，必须逐字对应原 `SourceBindingV1` 中的真实源码 Ref，不能临时塞入未绑定文件 |
| `nativeSigning.timestamp` | `secure` 或 `none`；省略采用受保护时间戳，只有明确选择 `none` 才关闭 |

操作者把这些字段加到已有真实 Mac 生产 job，冻结与原 job 一致的全部来源/工具/Node/Chrome/锁材料，在对应原生 Mac 架构上运行：

```sh
node --import tsx scripts/build_runtime.mts mac-inputs --job /ABS/REVIEWED/mac-job.json
```

生产者只对本次新构建的 `veriq_private_files.node` 和独立 Keychain helper 执行固定 `/usr/bin/codesign` 的受限签名，再实际 `--verify --strict` 与 `--display`；固定 signer 的真实可执行摘要在命令前后核对并保留有界 `commandEvidence`。原 Node、角色 Node 原始字节与 Chrome 归档不重签。签名发生在 native receipt/库存最终摘要固定**之前**，不改变 helper 业务协议或生成发布通过结论；不设置 `nativeSigning` 时继续是默认未签名静态材料。

`mac-inputs` 输出仍为 `AWAITING_INDEPENDENT_EXPECTED`。独立审核者必须审阅签名后的五树、命令证据、来源与原始 recipe 字节，再外部提供真实 Expected，不能重用签名前的摘要，也不能由生产器自动批准。然后消费原 stage 合同：

```sh
node --import tsx scripts/build_runtime.mts mac-stage \
    --recipe /ABS/PRODUCED/recipe.json \
    --expected /ABS/INDEPENDENT/expected.json \
    --input-root /ABS/PRODUCED/input-root \
    --output-parent /ABS/CANDIDATES \
    --candidate REVIEWED-CANDIDATE
```

最终 `runtime/` 与 `payload-receipt.json` 再由**另一份外部 desktop expected**绑定，才进入上文 `package:installer --signing NATIVE_SIGNED --identity … --installer-identity …`。Runtime 的 `signIgnore`、`afterPack`、`afterSign` 原清单复验保持不变。此说明记录已实现的源码操作链，本轮没有运行任何签名、构建、证书或钥匙串操作。

## 桌面清理和共享语言

设置中的“本机保留期清理”无需终端，只发送当前本机 Workspace UUID 与保留天数和批量预算。天数限定1–3650，批量1–100；main 在原生确认中显示实际工作区和策略，Agent 再核对当前选择、活动准备/执行/在线领取/查看器/缓存读取与持久停止历史。后台复用自身真实 `desktopOwner` 能力，不重复获取自己持有的 profile 锁。旧缓存首次观察才开始计龄，成功重验的实际资源访问刷新 SQLite 访问时间；不靠目录 mtime 判定到期。

清理结果是一个有界批次的真实计数，仍有候选时由用户明确再次发起；不能按计时器自动循环。原始证据退休、报告元数据保留、未回传保护与缓存引用判断由 C07 的实际维护器执行。关闭页面、退出窗口、取消确认和网络/IPC 超时具有不同含义；清理开始后没有伪造的撤销按钮，界面会提示超时或关闭并不能证明回滚。

renderer 使用 `AppLocaleProvider` 和 `appI18n/setAppLanguage` 连接 Web 的应用、资源/报告与 AI 命名空间，语言偏好遵循同一受限持久化约定，监听随组件卸载清理。切换语言不重置 Workspace、草稿或请求 scope。main 仅使用无 React/DOM 的有限错误指引，原生菜单和确认保留可理解的中英双语；未知异常不在产品提示中回显宿主路径或堆栈。
