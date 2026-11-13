# ADR 0021：独立 Runtime、原生边界与桌面发行

状态：2026-11-13，T20 实现边界已确定，正在分步实施；本文不是安装包或目标系统验收报告。T19 源码 `eb2dc4e` 的模块与六项修复复审已通过，完整发行仍需 T20–T23 的实际证据。状态以[里程碑](../plans/milestones.md)为准。

## 已有约束与版本

保留 Electron45.3.1、electron-vite6.0.0、electron-builder26.18.1，独立执行器使用 Node24.22.1；业务浏览器为 Playwright1.65.0 对应的完整 Chromium158.0.8127.18/rev1254。Electron 内嵌 Node24.22.2 和 UI Chromium156 分别记录，不能替代独立执行器和业务浏览器。

支持目标为 Windows11 x64、Ubuntu24.04 x64，另有 Linux 无桌面云端 Runtime。当前开发宿主 Debian13、托管 Windows Server 构建以及 Ubuntu 虚拟显示测试，各自只能证明实际执行的内容。真实安装、托盘、凭据库、跨用户访问、升级和离网验收不能互相替代。

## 成熟组件比较与选择

| 能力 | 候选与许可 | 决定及依据 | 尚需验证 |
| --- | --- | --- | --- |
| 桌面打包 | 已锁 electron-builder26.18.1，MIT | 继续复用，首批 NSIS x64 与 Ubuntu .deb，另交独立 Runtime 归档 | 各 OS 实际安装、卸载、离网系统依赖和签名状态 |
| 归档 | 已锁 tar7.5.22，BlueOak-1.0.0 | 作为 Runtime/构建的明确依赖，替换固定 GNU tar 路径；保留路径、类型、长度和 hash 校验 | 确定性生成、危险成员拒绝、Windows 原生路径与旧包兼容 |
| TS 载入 | 已锁 tsx4.23.15，MIT | 独立 Runtime 明确携带，含 esbuild0.28.2 对应平台二进制 | 实际安装闭包；两平台离线 npm 缓存不能只含构建宿主的可选包 |
| Windows 进程树 | Win32 Job Object | 薄原生 guardian 使用系统所有权、挂起启动和 Job 排空；保持未知停止隔离 | 实际 HANDLE/创建时间、后代、Job 嵌套、异常退出与 Unicode 参数 |
| 进程枚举/终止 | @vscode/windows-process-tree0.8.0、tree-kill1.2.2，均 MIT | 不作为停止证明；枚举和 taskkill 不提供 Job 所有权及排空事实 | 不计划为此引入运行依赖 |
| 原生适配 | node-addon-api8.9.2，MIT；对比 koffi3.3.8，MIT | 选择构建期 Node-API 辅助库，提供有限 Win32 IPC/ACL/系统凭据接口；避免通用动态 FFI | 实际获取后的锁/完整性/安全记录、目标构建、ABI、取消与句柄释放 |
| 凭据库 | @napi-rs/keyring2.1.2，MIT | 暂不引入原始预编译包；原生闭包有待处置的公告，Linux 默认还可能回退到易失 keyutils | 如后续重选须重新评审实际目标二进制及第三方许可 |
| 凭据库 | keytar7.9.0，MIT | 不选；上游归档且 Node24 预编译兼容尚未证明 | 不因直接包无公告就视原生图已安全 |
| 系统凭据 | Windows Credential Manager、Linux libsecret/Secret Service | 复用成熟 OS 服务，用有限原生适配访问；独立 Agent 在 UI 退出后仍可工作 | Ubuntu 精确系统包/ABI/许可、锁定与不可用、重启和真实用户隔离 |
| 大凭据载荷 | Node 标准 crypto 认证加密 | OS vault 保存随机密钥，版本化私有密文保存 storageState、设备与轮换载荷；保留精确引用和恢复日志 | AAD/原子替换/失败恢复/迁移/删除及大对象上限 |

以上是实现选择和比较，尚未安装的包不写成已集成。tar 的既有精确闭包为 @isaacs/fs-minipass4.0.1、chownr3.0.0、minipass7.1.3、minizlib3.1.0、yallist5.0.0，沿用根锁中的版本；不因为 registry 存在更新版本而静默升级。node-addon-api 仅用于构建，安装后的机器不要求编译器。

预研在 2026-11-13 对 keyring2.1.2 上游 Cargo.lock 的 186 个 registry 版本及 13 个 npm 元组做即时 OSV 查询。Rust 命中为 ctutils0.4.3（RUSTSEC-2026-0385，修复0.4.4）、rustix1.1.5（RUSTSEC-2026-0486，修复1.1.6），以及 zbus_names4.3.5、zvariant5.15.1、zvariant_derive5.15.1 三条停止维护公告。后者不被称作已证明可利用漏洞；Cargo.lock 命中也不直接证明每个目标二进制都含有或可到达该代码。尚未完成二进制归属和处置，因此不以直接 npm 查询无结果宣称整个原生闭包安全。系统适配方案同样必须完成真实构建图审计。

## 独立发行闭包与身份

GUI 随包携带本地页面。Agent、CLI、Worker、编译 helper、运行依赖、Node 角色文件、浏览器和引擎放在真正的 ASAR 外资源目录；独立 Node 不依赖 Electron 的虚拟文件系统、仓库源码链接、全局工具或在线下载。实际可执行文件名为 veriq、veriq_agent、veriq_runner，CLI 可为 veriq_cli；每个进程的执行路径、hash 与 OS 名称均须核验。原生 guardian 和角色 Node 可以在不同目录各自使用 veriq_runner 名称，所有权通过实际句柄与启动身份区分。

npm 使用固定 Node 发行物中的 npm-cli.js 和完整依赖，通过角色 Node 调用，不依赖 npm.cmd、系统 npm 或 shell 拼接。固定 Node 归档内实际 npm 版本与依赖图仍需在获取时记录。生产 Runtime 不要求 Python、MySQL、cc、pnpm 或开发 checkout。

发行 resolver 验证实际文件和引擎库存后，才给 CLI、桌面、云端注册、doctor 和启动报告同一分发身份。product、engine、compiler、SDK 版本分开。初始开发候选命名为 product1.0.0-dev.t20、engine1.0.3-t20；生成前冻结真实输入，之后任何输入变化另建候选。保留原1.0.0、1.0.1-t19 与1.0.2-t19-fix1，不覆盖旧签名包所需的字节。跨 OS 可选原生依赖是否进入同一引擎库存必须由实际生产器及离网安装证明。

## 私有 IPC、凭据和生命周期

Windows 使用明确当前账户 SID 的受限本机管道，拒绝远程客户端、名称抢占、错误主体、旧 nonce 和超限帧。Node-API 适配自行管理正式 Win32 管道 HANDLE，不假定 Node 的 POSIX fd3/4/5 协议可移植，也不把 HANDLE 传入未公开的 Node 内部接口。Linux 保留已有 guardian 协议；两侧共用有限业务命令、授权和有界 UTF-8 帧。

桌面默认使用系统凭据库，锁定、缺失、不可用和错误不能都折叠为缺凭据。凭据库不可用时明确失败，不自动降级。大型载荷使用标准认证加密，密钥独立保存在 OS vault，元数据绑定 profile、purpose、精确引用和版本。当前设备 token、旧/新轮换 token 与业务凭据一起纳入；迁移须显式进行，在停止且独占的 profile 中写入、读回核验和记录进度，再删除旧明文。中途失败保留可恢复事实。

无桌面 Linux 服务可按既有规格显式选择 restricted-file：专用用户、拥有者核验、0700目录和0600文件、外置持久卷及明示的非加密存储性质。该模式不是桌面 fallback，不声称 OS vault 或加密静态存储。登记秘密经有界标准输入或 OS 服务凭据通道注入，不写入 argv、镜像或日志。

更新与卸载须把 preparing startupId、正在执行、在线 Worker、未知或隔离进程都视为忙。替换文件前获得同一次操作的真实停止证明。首版采用人工发起的已验证安装升级，不增加自动更新依赖；不能依赖安装器强杀所有同名进程。回滚必须兼容数据库、本地日志和旧引擎，卸载默认保留外置历史与配置。

## 沙箱、签名和执行预算

业务 Playwright 当前存在显式关闭沙箱的历史配置，必须在 T20 中用启动、可见/无头及同 Attempt 停止测试处理；Electron UI 沙箱证明不覆盖业务浏览器。目标默认启用适用沙箱，Ubuntu .deb 可为 root-owned 固定程序路径提供包管理的精确 AppArmor 策略；不授权任意可写路径，不修改全局限制。任意路径解压的独立包不能假定已有宿主授权，doctor 必须说明缺失条件。

开发候选标记 DEVELOPMENT_UNSIGNED，hash 只证明完整性。正式 Windows Authenticode、Linux 发行签名及发布授权另行配置；安装包发行信任与企业测试包 issuer 信任分开。候选流水线不自动发布、不晋升引擎、不使用正式凭据。

Node、Electron、完整 Chrome 的压缩元数据合计约 Linux363MB、Windows412MB，未含角色副本、运行依赖、原生模块、系统库和打包暂存，不能作为安装空间承诺。当前约142MiB空闲宿主只做有界源码检查；大包在新建目标 CI 按平台串行构建。初始规划预留12GiB，实际测量后调整；不删除保护的旧引擎、profile 或证据。Ubuntu 系统库/字体与 Windows DLL 闭包分别在目标解析、锁定和离网验证，不搬运 Debian 宿主库。

# ADR 0021: independent Runtime and native distribution

Retain the frozen Electron toolchain, independent Node24.22.1 and full Playwright-matched Chrome158. Stage actual role executables, JS/helper/dependency closure, npm, browser and verified engines outside ASAR. Product, engine, compiler and SDK identities remain distinct and immutable. Windows11 and Ubuntu24.04 installed acceptance require their actual targets.

Reuse locked tar/tsx, Win32 Jobs, Credential Manager and Linux Secret Service through narrow native adapters. node-addon-api8.9.2 is selected as build-only assistance, subject to actual acquisition and target graph verification. Do not introduce unchanged keyring2.1.2 while its native advisory disposition remains unresolved. Desktop vault keys protect standard authenticated encrypted payloads; explicit restricted-file mode is permitted for unattended Linux, without a silent desktop downgrade or an encryption claim.

Private IPC validates the actual user, operation and bounded frames. Updates must honor preparing, active, online and quarantined ownership and actual stop proof. Candidate NSIS/.deb/standalone artifacts are development unsigned until formal signing is configured and authorized; checksums are not publisher authenticity. Large payload work runs on target CI, preserving existing evidence. These decisions do not claim implementation, target acceptance or complete MVP delivery.
