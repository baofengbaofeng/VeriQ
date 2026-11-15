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

## 2. 最新确认最低系统版本：macOS 15（Sequoia）

用户先前提出参考2020年系统，随后接受过macOS14。2026-11-14，获知GitHub的macOS14托管镜像已于2026-11-02退役后，用户最新明确将两架构兼容与验收最低基线调整为 **macOS15（Sequoia）**。此前14及Big Sur 11设想均已被替代，最低版本不再待确认；实现与实际验收仍须完成。已核验的工具链参考版本边界如下：

| 固定组件 | 官方版本资料中的 macOS 边界 | 对 VeriQ 的影响 |
| --- | --- | --- |
| Electron 45.3.1 | Ventura 13 起，Intel/ARM | UI 壳本身不能覆盖 Big Sur 11 |
| 独立Node24.x；已核验参考版本24.22.1 | 参考版本的x64、arm64均为13.5起的Tier 1 | 用户要求Node兼容门槛为24.x；每个发行仍记录并核验实际具体版本/hash，不将Electron内嵌Node或任意系统Node代替其角色 |
| Playwright 1.65.0 / 配套 Chrome 158.0.8127.18 | 固定下载矩阵对 macOS 13 及以下不提供这两类目标，14 起提供 | 上游最低14不等于产品支持声明；VeriQ现以15为最低，尚无Mac实际验收 |

已决定：保留已选运行栈及每发行具体版本身份，产品支持目标从macOS15起；不支持macOS14及以下。不得只降低 `minimumSystemVersion`、静默降级依赖、改用任意系统浏览器后声称解决兼容。官方资产元数据存在不代表已下载验证、构建或运行成功。

CI已配置标准标签`macos-15-intel`（Intel）与`macos-15`（Apple Silicon）分别验证；镜像可用性不代表产品已通过验收。首轮真实双架构测试已复现私有文件接口的Linux路径依赖；B适配及独立复审已完成，两架构各44项通过，源码受控业务组件也已完成双架构验证，Keychain、GUI与完整安装验收仍待完成。GitHub macOS14退役是此次基线调整的依据，不再等待14设备。标签及退役记录见[GitHub标准Runner表](https://github.com/github/docs/blob/d59b2631959db46d71ca5f7748ec04311c6d0870/data/reusables/actions/supported-github-runners.md)与[Runner镜像记录](https://github.com/actions/runner-images/blob/95e6f51a068507e8f43d061d2166a39d0ef36ce8/README.md)。

核验依据为固定版本官方源码：[Electron README](https://github.com/electron/electron/blob/v45.3.1/README.md)、[Node BUILDING.md](https://github.com/nodejs/node/blob/v24.22.1/BUILDING.md)、[Playwright 浏览器版本](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/browsers.json)、[Playwright 下载矩阵](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/src/server/registry/index.ts)。访问日期为本文更新日期；需要实际目标验证后才能形成最终兼容矩阵。

## 3. 共享代码与平台适配

继续使用已批准的 Electron + React 和独立 Node Runtime，不因增加 Mac 另起桌面框架。共享 Workspace、DSL、编译器、SDK、断言、资源下载、离线执行协议及报告逻辑。下表是必须补齐的工作，不代表已经实现：

| 事项 | 当前缺口 | 接续要求 |
| --- | --- | --- |
| 平台合同 | `986a2d8`已实现并通过独立切片复审 | Schema/OpenAPI/生成类型与桌面派生Schema严格限制linux/x64、win32/x64、darwin/x64、darwin/arm64；251项契约及196项Python兼容检查通过。契约表达不证明主机系统版本或执行就绪 |
| 物理依赖闭包 | Node、Chrome、esbuild、原生组件均按平台产生 | 分别验证 x64/arm64；不能复制 Linux node_modules 或仅将 Electron 做 universal 就视为整个 Runtime 通用 |
| `.app` 与完整性 | 701eb92已交付v2静态库存组件及161项定向回归，独立复审通过；现有安装执行解析器仍保留schema1入口 | 继续核真实固定资产，向载荷生产和安装角色接入有限Framework链接；实际descriptor尚待归档枚举，禁止全局放开链接或盲目展平bundle |
| 私有文件 | B已实现Darwin公开POSIX目录句柄相对访问；`4966090`复审通过 | 双架构各44项实际测试通过；继续保持同FD owner、类型、权限、扩展ACL及提交不确定性检查，C2须保活File至真实CLI退出和最终核验 |
| Runtime Keychain | 用户已确认采用原生文件型 Keychain；独立 helper 及工具已完成源码复审和双架构安全 CI，真实存取待验收 | 复用有限 helper 协议与标准加密信封，通过独立辅助进程存取；锁定或访问失败时拒绝执行，无明文 fallback，签名身份及无交互策略须实际验证 |
| Electron Cookie | Mac 使用 Keychain，现有生产保护门未开放 Darwin | 最终签名 bundle 的 fuse、真实 provider、SQLite 密文、重启、锁定及旧 Cookie 退役均需真实验证 |
| 桌面生命周期 | 菜单栏、Dock、activate、登录项及安装路径存在平台差异 | 区分窗口关闭、退出 UI、停止 Agent、取消任务；保留后台执行与恢复能力 |
| 安装与升级 | Mac 安装载体及签名布局尚待设计 | 双架构独立产物是研究建议，尚非用户已选方案；必须核验执行中升级拒绝、兼容回滚与卸载保留数据 |

用户于2026-11-15（北京时间）确认：Mac Electron 主进程直接加载已核验的 Darwin Node-API 插件，用于私有档案和有限旧 Cookie 文件操作，不新增独立 Node 文件代理。只有完整库存、真实宿主身份、目标架构和对应签名/装载校验通过后才能绑定原生能力；renderer 不得直接取得插件、任意路径或句柄。两架构需验证实际 Electron 装载，Node-API 稳定接口本身不代替验收。独立文件型 Keychain helper 及其授权边界保持不变，此选择不授权真实钥匙串、Cookie 会话或信任配置操作。

Darwin私有目录的`replace(name, temporary, ...)`只接受严格的`.<小写UUID>.tmp`临时成员名（41字节）；业务暂存意图名与底层发布临时名是两个参数，不可互相替代。调用方须保留按Attempt识别的中断意图与提交不确定性，不通过放宽原生名称规则修复调用错误。

用户于2026-11-14明确选择原生文件型（file-based）Keychain，保持独立辅助进程架构，不改为需要新增应用封装、签名授权和 provisioning profile 的 Data Protection 路线。两类实现的权限与签名模型见 Apple [TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)；实际签名身份、无交互策略和升级连续性仍须验证。

私有测试路径不代表Keychain操作对用户偏好无影响：`SecKeychainCreate`可能更新持久搜索列表并在缺失时设置默认钥匙串，删除也会更新偏好；先创建再恢复设置不能作为隔离方案。Keychain模块在标准CI现有账户中仅执行构建及无钥匙串存储变更的协议检查，真实创建、锁定、删除必须在明确授权的独立可丢弃测试账户/会话进行，不以改变HOME或不支持的Dynamic偏好域代替隔离。

用户已确认可以安排 macOS15及以上的 Intel 与 Apple Silicon 独立测试环境。Cookie 冷启动、锁定与恢复，以及安装、签名升级验收必须在独立账户的真实登录会话中进行。现有标准 CI 的钥匙串默认值、搜索列表、登录存储及信任配置不得为此修改或锁定；Runtime 私有测试钥匙串的结果不替代 Electron Cookie 验收。测试环境可安排不代表已提供访问、签名资料或实际通过，后续须交付可运行的验收工具与对应记录。

## 4. 已确认的原生进程停止范围

用户已接受Mac正常停止以受控Worker和Chrome确实退出为准，检测到不确定时保持隔离并人工恢复，不承诺任意游离后代由内核自动清理。最低15、宿主原生Chrome及该停止范围均已确定，不再重复列为待用户选择；实现与真机证据尚未完成。

按[受控停止设计](macos-controlled-stop.md)与[实施子计划](../plans/macos-controlled-stop.md)推进：复用Playwright BrowserServer公共API和受控进程登记/退出观察；停止回执明确标识范围，不能写成Linux/Windows的全后代DRAINED证明。Linux subreaper和Windows Job继续保留原有强保证；未知不能自动释放容量。

此前可行性研究仍约束实现：kqueue的NOTE_TRACK不受支持，进程组或PID扫描不构成退出事实；Endpoint Security另需Apple批准/root/FDA且没有已证实的全排空通路，本方案不依赖；Linux VM浏览器已被用户排除。当前工程路线改为可信CLI通过公开Node通道持有真实子进程对象，不依赖非child peer身份链；具体发行Node自检、Darwin私有fd存储和双架构实际退出仍须验证，不能用未核实API补成就绪。

官方依据：[Apple XNU进程事件实现](https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.1.9/bsd/kern/kern_event.c#L1100)、[Endpoint Security entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.endpoint-security.client)。这些资料是先前研究依据，不是Mac实现或测试通过记录。

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
| 3 | 落实最低macOS与受控进程停止 | 最低15、宿主原生Chrome、受控停止范围均已确认；源码私有文件/受控业务组件已验，完整安装与真机产品验收待完成 |
| 4 | 扩展四组目标的平台合同，再按确认设计实施原生适配、依赖库存和双架构构建 | 合同切片`986a2d8`及B/C源码组件已验；继续系统凭据、完整库存与发行接入，就绪须实际证明，不能绕过受控停止设计 |
| 4a | Mac Runtime载荷输入与组装 | v2静态库存和独立输入核验器已完成源码审查；核验器经两项预算缺口修复复审，新67项通过，一项Framework名称Minor留T22。继续以相同合同完成有界归档与真实候选目录；当前不授予installed/ready、签名或凭据操作能力，双架构目标执行及Electron实际装载仍待验收 |
| 5 | 两类 Mac 原生安装与全功能验收 | 用户已确认可安排两架构独立测试环境；具体访问/独立登录会话、签名输入和实际验收记录仍待落实 |
| 6 | 完成较低优先级 Windows/Ubuntu 发行及 T21–T23 | 全部仍在首发范围；保留原有实现、失败和证据，不重新归零 |

每个 Mac 架构都需留下构建来源与实际依赖、安装、无终端 GUI、联网/离线运行、真实可见/无头浏览器、同 Attempt 停止、Keychain/Cookie、托盘/Dock/后台、升级回滚与签名状态的对应证据。不能以开发宿主、另一架构、源码测试或一次启动成功代替。
