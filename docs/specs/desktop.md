<a id="veriq桌面图形客户端需求修订与技术候选"></a>

# Desktop

日期：2026-11-10。用户明确要求本地Runtime提供类似本地软件的图形界面。本文覆盖此前“首版仅CLI、不建设桌面界面”的描述；桌面GUI属于首发完整MVP，CLI与无人值守Agent继续保留。按用户确认采用Electron桌面方向，精确依赖版本仍须锁定。

2026-11-14范围修订：macOS Intel x64、Apple Silicon arm64均为首发必需、最高优先级；Windows11 x64、Ubuntu24.04 x64仍属MVP、优先级较低。Mac最低版本已确认为macOS15（Sequoia），测试必须使用宿主macOS的原生Chrome；停止范围已按用户确认采用[受控Worker/Chrome退出与未知隔离](macos-controlled-stop.md)，原生适配进度见[Mac范围记录](macos-mvp-scope.md)。目标范围不代表现有代码已兼容或完成安装验收。

## 固定应用身份与私有钥匙串验收

Mac 正式打包的 Bundle ID 固定为 `io.github.baofengbaofeng.veriq`，签名配置、应用身份校验和后续升级必须沿用该值。此项为已确认的发行契约，实际 `.app` 打包、装载、签名与升级结果仍须按目标架构验收。技术标识中的 `veriq` 保持小写，产品名称使用 VeriQ。

Runtime 私有文件型 Keychain 的真实验收采用独立 GitHub 临时 Mac VM 的一次性账户，范围包括创建、锁定、解锁、删除测试钥匙串，以及这些操作对该测试账户偏好的影响。每次执行须在同一任务内重新核验账户与安全会话并保留实际清理证据；旧 VM 的预检不能替代新 VM 的检查。Cookie、真实控制台登录、生产默认钥匙串及签名安装继续单独验收，此处没有宣称它们已通过。

## 必须提供的桌面能力

- 原生安装、桌面/开始菜单入口、独立窗口、单实例、托盘、后台状态、版本与诊断。
- 配置服务端、登录/退出、Workspace选择、设备绑定与共享状态。
- 联网查看可访问的用例、套件和数据集，配置本地环境与凭证映射，选择可见或无头浏览器执行。
- 任务启动、进度、步骤与断言详情、日志、取消、历史、报告和允许采集的 Trace 入口。矩阵或命名数据集任务只显示状态、出处和安全错误码。
- 执行需要保持与控制平台及被测系统的连接。平台失联时以任务租约控制停止与清理。
- 浏览器/依赖自检、资源目录、并发、缓存清理、代理/证书与安装/卸载说明。
- 关闭窗口、退出UI、停止Agent、取消测试分别定义；窗口关闭默认到托盘并提示，正在执行任务时完全退出须明确展示影响。UI崩溃不导致无人值守Agent自动丢失。

联网资源编辑复用 Web 资源组件和 API。测试数据的下载、使用和清理遵循[工作区数据集与联网执行](veriq-datasets.md)。桌面程序不要求本机安装 Python 或 MySQL。

## 框架对比与推荐

| 维度 | Electron + React | Tauri 2 + React |
|---|---|---|
| 团队与引擎适配 | TypeScript/Node生态一致，现成集成较多 | Rust侧更重，Playwright以Node 辅助进程提供 |
| UI运行环境 | 内置Chromium，跨系统一致性较高 | 使用系统WebView，需验证WebView2/WebKit依赖 |
| 资源占用 | 安装体积和内存较大 | UI壳通常更轻，但Node/测试浏览器体积仍存在 |
| 第三方基础能力 | electron-builder/electron-vite等候选 | 官方插件、辅助进程及能力授权配置等候选 |
| 推荐适用 | 优先交付完整功能与复用现有TS栈 | 优先减少UI壳资源且愿意维护Rust侧 |

推荐Electron + React + 独立Node24 Runtime。Electron内嵌Node版本随其版本变化，不能等同于锁定的Node24执行引擎；Agent/Runner使用单独固定版本。Playwright测试浏览器与桌面UI Chromium分离，桌面壳版本更新不静默升级测试引擎。

桌面入口名veriq，后台veriq_agent，执行veriq_runner；CLI可使用veriq_cli并保留兼容入口策略。实际Electron主/渲染进程和自有子进程在目标OS验收名称，不只改窗口标题。原先拟选Rust薄入口不再作为桌面必需组件，只有CLI/服务启动确有需要时保留。

## 代码与部署调整

- 新增apps/desktop，包含主进程、预加载脚本、渲染进程；复用packages/ui和可共享功能，使用云端／本地适配器区分数据来源。
- 桌面 React 产物随安装包提供，平台失联时窗口仍可显示连接状态和诊断。
- Electron 主进程使用contextIsolation、关闭渲染进程 Node集成、启用适用的沙箱（sandbox）；预加载脚本只暴露白名单类型化IPC，验证参数与发送者（sender）。设备token、密钥、spawn和任意文件访问不暴露给渲染进程。
- Mac已确认由Electron主进程直接加载已核验的Darwin Node-API插件处理私有档案与有限Cookie文件操作；先核库存/宿主/架构再绑定能力，不向渲染进程开放原生接口。独立Keychain 辅助进程不变，实际双架构装载及签名/权限仍须验收。
- Agent与UI之间使用受限本机IPC，服务端凭证不嵌入桌面前端；不开放无认证本地HTTP控制接口。
- CLI、桌面和云端共用编译器/SDK/结果协议，不实现两套测试引擎。
- 服务端仍按前端构建→Python static/dist→wheel统一发布；桌面产物按macOS x64、macOS arm64、Windows x64、Ubuntu x64分别构建，优先完成Mac两架构，包含GUI/Agent/Runner及所需依赖。共享业务代码不替代各平台凭据库、进程监督、原生文件和生命周期适配。
- 验收桌面构建与签名、GUI E2E、断网状态与清理、托盘与退出、崩溃重连、IPC 授权和进程命名。升级及回滚使用签名校验并兼容引擎，执行中不强制更新。

## 完整MVP验收追加

安装后用户可在桌面窗口完成配置、绑定、联网查看资源、启动或停止在线领取、查看平台报告及已有本机历史。联网 Agent 将每次结果提交给控制面。断开平台连接后，验收停止领取、租约失效后的受控停止和本地数据清理。恢复连接后可由平台重新调度，历史执行状态与回报去重可核对。关闭窗口与停止后台的行为明确。桌面 UI 属于首发交付清单。

参考：https://www.electronjs.org/docs/latest/tutorial/security 、https://v2.tauri.app/develop/sidecar/ 。精确版本与打包工具由ADR冻结。
