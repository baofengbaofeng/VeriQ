# VeriQ：Mac 首发范围、兼容性与开发接续

更新：2026-11-14（北京时间）。本文记录用户已确认的范围、固定工具链核验结果与未决事项，补充主规格和桌面规格；不是已批准的新原生架构、安装报告或支持声明。已有 Windows/Linux 实现及真实失败、成功证据继续保留。

## 1. 已确认范围与优先级

| 目标 | MVP 范围 | 优先级 | 当前状态与完成标准 |
| --- | --- | --- | --- |
| macOS Intel x64 | 必须交付完整桌面 GUI 与独立 Runtime | 最高 | 原生适配及实际安装验收未完成；需要 Intel 原生构建与目标验收，不能仅以 Rosetta 代替 |
| macOS Apple Silicon arm64 | 必须交付完整桌面 GUI 与独立 Runtime | 最高 | 原生适配及实际安装验收未完成；GUI、Node、浏览器和原生组件须验证真实架构 |
| Windows 11 x64 | 仍必须交付 | 较低 | Windows Server 原生验证不能代替 Windows 11 安装验收；已有 ACL/所有者失败继续保留 |
| Ubuntu 24.04 x64 | 仍必须交付 | 较低 | 已有源码 GUI、系统凭据与进程监督证据，完整安装、离网及升级验收未完成 |
| 服务端 Linux x64 | 原有部署范围不变 | 原计划 | Python 控制服务运行时不要求 Node 或浏览器；生产先构建前端并随 wheel 发布 |

用户已进一步明确：Mac测试必须使用**宿主macOS的原生Chrome**，不能用Linux虚拟机中的浏览器代替；继续使用固定Playwright配套版本，不将这句话解释为任意系统Chrome可替代固定引擎。

四组桌面目标都必须完成 F01–F14 中适用的本地功能。优先级调整不删除 Windows/Ubuntu，不允许把 Mac 仅打包成功当作完整客户端交付。

## 2. 已确认最低系统版本：macOS 14（Sonoma）

用户先前提出参考2020年系统；核验固定工具链后，用户在获知Sonoma于2023年发布后回复“OK”，现确认两架构均以 **macOS 14（Sonoma）** 为最低版本，替代先前Big Sur 11设想。不再将最低版本列为待确认；实现与真机验收仍须完成。当前固定版本存在以下边界：

| 固定组件 | 官方版本资料中的 macOS 边界 | 对 VeriQ 的影响 |
| --- | --- | --- |
| Electron 45.3.1 | Ventura 13 起，Intel/ARM | UI 壳本身不能覆盖 Big Sur 11 |
| 独立 Node 24.22.1 | x64、arm64 均为 13.5 起的 Tier 1 | 不可将 Electron 内嵌 Node 或系统 Node 代替独立运行引擎 |
| Playwright 1.65.0 / 配套 Chrome 158.0.8127.18 | 固定下载矩阵对 macOS 13 及以下不提供这两类目标，14 起提供 | 完整产品最低macOS14已获用户确认；尚无真机验收 |

已决定：保持固定运行栈，支持目标从macOS14起；不支持macOS11、12、13。不得只降低 `minimumSystemVersion`、静默降级依赖、改用任意系统浏览器后声称解决兼容。官方资产元数据存在不代表已下载验证、构建或运行成功。

核验依据为固定版本官方源码：[Electron README](https://github.com/electron/electron/blob/v45.3.1/README.md)、[Node BUILDING.md](https://github.com/nodejs/node/blob/v24.22.1/BUILDING.md)、[Playwright 浏览器版本](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/browsers.json)、[Playwright 下载矩阵](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/src/server/registry/index.ts)。访问日期为本文更新日期；需要实际目标验证后才能形成最终兼容矩阵。

## 3. 共享代码与平台适配

继续使用已批准的 Electron + React 和独立 Node Runtime，不因增加 Mac 另起桌面框架。共享 Workspace、DSL、编译器、SDK、断言、资源下载、离线执行协议及报告逻辑。下表是必须补齐的工作，不代表已经实现：

| 事项 | 当前缺口 | 接续要求 |
| --- | --- | --- |
| 平台合同 | `986a2d8`已实现并通过独立切片复审 | Schema/OpenAPI/生成类型与桌面派生Schema严格限制linux/x64、win32/x64、darwin/x64、darwin/arm64；251项契约及196项Python兼容检查通过。契约表达不证明主机系统版本或执行就绪 |
| 物理依赖闭包 | Node、Chrome、esbuild、原生组件均按平台产生 | 分别验证 x64/arm64；不能复制 Linux node_modules 或仅将 Electron 做 universal 就视为整个 Runtime 通用 |
| `.app` 与完整性 | Mac Framework 有真实内部符号链接，当前库存拒绝所有链接 | 先核实际固定资产，再设计保留签名的有限规则；禁止全局放开链接、任意路径或盲目展平 bundle |
| 私有文件 | 当前非 Windows 路径使用 `/proc/self/fd` | Darwin 没有该接口；需有限的目录句柄相对访问适配，继续校验 owner、类型、权限及提交不确定性 |
| Runtime Keychain | 现有后端是 Windows Credential Manager / Linux Secret Service | 复用有限 helper 协议与标准加密信封；明确 Keychain 实现、签名身份及无交互策略，不能以明文 fallback 通过 |
| Electron Cookie | Mac 使用 Keychain，现有生产保护门未开放 Darwin | 最终签名 bundle 的 fuse、真实 provider、SQLite 密文、重启、锁定及旧 Cookie 退役均需真实验证 |
| 桌面生命周期 | 菜单栏、Dock、activate、登录项及安装路径存在平台差异 | 区分窗口关闭、退出 UI、停止 Agent、取消任务；保留后台执行与恢复能力 |
| 安装与升级 | Mac 安装载体及签名布局尚待设计 | 双架构独立产物是研究建议，尚非用户已选方案；必须核验执行中升级拒绝、兼容回滚与卸载保留数据 |

Keychain 两类实现的权限与签名模型见 Apple [TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)。默认 file-based Keychain 与 data-protection Keychain 不能混为一种机制；选择需要结合固定 helper 布局及真实用户会话验证。

## 4. 原生进程监督：仍未解决的架构问题

原有规格要求同一 Attempt 的完整进程树停止后才能自动释放容量；未知必须隔离。Linux subreaper 与 Windows Job 各有内核维护的后代边界。Mac 不能直接套用 Linux 实现：

- kqueue 的 `NOTE_TRACK` 等标志在 Apple XNU 中被拒绝，不能引用 FreeBSD 行为声称 Darwin 支持递归追踪。
- 进程组、PID/PPID 扫描或根进程退出，无法覆盖已有真实反例中的空环境、脱离进程组并成为孤儿的后代；不能据此生成 `DRAINED`。
- Endpoint Security 是待研究候选，需要 Apple 单独批准的 entitlement、root 与用户 Full Disk Access；普通 Developer ID、公证或自签不能替代。已核验事件身份及丢事件计数，但尚未证明事件流收敛与完整排空，不能宣称方案已成立。
- Linux VM曾作为研究备选，会改变浏览器实际运行OS、资源占用与本地可见浏览器体验。用户现已要求宿主macOS原生Chrome，**该替代方案已排除**，不得继续按可选架构实施。

官方依据：[Apple XNU 进程事件实现](https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.1.9/bsd/kern/kern_event.c#L1100)、[Endpoint Security entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.endpoint-security.client)、[es_new_client](https://developer.apple.com/documentation/endpointsecurity/es_new_client(_:_:))。

后续必须先形成可验证的实现方案，再按用户要求核对涉及承诺或架构的变化。不得隐藏为“各 OS 只需改打包”，也不得为了继续编码而放松停止标准。

## 5. 证书与用户提前准备事项

| 平台 | 正式分发准备 | 自签与内部测试边界 |
| --- | --- | --- |
| macOS 两架构 | Apple Developer Program；Developer ID Application 及私钥；公证凭据，例如具备权限的 App Store Connect API Key；采用 PKG 才额外需要 Developer ID Installer | 两架构共用签名身份；自签不等于 Gatekeeper 认可或公证，是否可单独放行取决于系统/企业策略；Keychain 与升级身份须实测 |
| Windows x64 | 可信 Authenticode 或适当云签名服务；事先确认令牌/HSM/CI 可用方式 | 可由 IT 部署企业信任链，仍可能有 SmartScreen/策略限制；不假定证书可导出 PFX |
| Ubuntu x64 | 直接 `.deb` 无须购买商业证书；自建 APT 仓库准备签名密钥 | 可自行管理仓库公钥与签名；使用者需明确配置来源信任 |

用户已讨论自签的可行性，尚未明确将“全部平台正式自签”设为发行策略。继续区分未签开发候选、已签候选与正式发布验收，不能把校验和当发布者信任。私钥、密码不得写入聊天、仓库或日志；使用 CI Secrets、受控钥匙串或签名服务。正式签名、公证与发布需要有效凭据及具体授权；公共业务代码开发不依赖这些凭据。

## 6. 接续次序与验收状态

| 次序 | 工作 | 当前状态 / 依赖 |
| --- | --- | --- |
| 1 | 同步已确认范围至 README、规格、计划和里程碑 | 本文随范围修订提供；不改变已有实际验证结论 |
| 2 | 完成公共凭据故障状态与显式恢复入口 | `ae38f0a`及修复`b2baf88`通过独立定向复审；最终48项桌面单测通过，适用host/renderer严格检查通过；不依赖Mac原生机制，不代表GUI/目标OS验收 |
| 3 | 落实最低macOS与完整进程监督方案 | 最低14已确认；监督方案仍需可行性依据和设计核对 |
| 4 | 扩展四组目标的平台合同，再按确认设计实施原生适配、依赖库存和双架构构建 | 合同切片`986a2d8`已复审；原生适配和运行仍待实施，能力就绪须真实证明，不能绕过未决监督设计 |
| 5 | 两类 Mac 原生安装与全功能验收 | 待实际 Intel / Apple Silicon 设备或适当目标环境；用户尚未确认设备可用性 |
| 6 | 完成较低优先级 Windows/Ubuntu 发行及 T21–T23 | 全部仍在首发范围；保留原有实现、失败和证据，不重新归零 |

每个 Mac 架构都需留下构建来源与实际依赖、安装、无终端 GUI、联网/离线运行、真实可见/无头浏览器、同 Attempt 停止、Keychain/Cookie、托盘/Dock/后台、升级回滚与签名状态的对应证据。不能以开发宿主、另一架构、源码测试或一次启动成功代替。
