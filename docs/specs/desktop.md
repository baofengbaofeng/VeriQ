# VeriQ桌面图形客户端：需求修订与技术候选

日期：2026-11-10。用户明确要求本地Runtime提供类似本地软件的图形界面。本文覆盖此前“首版仅CLI、不建设桌面界面”的描述；桌面GUI属于首发完整MVP，CLI与无人值守Agent继续保留。按用户确认采用Electron桌面方向，精确依赖版本仍须锁定。

2026-11-14范围修订：macOS Intel x64、Apple Silicon arm64均为首发必需、最高优先级；Windows11 x64、Ubuntu24.04 x64仍属MVP、优先级较低。Mac最低版本已确认为macOS14（Sonoma），测试必须使用宿主macOS的原生Chrome；原生适配待决事项见[Mac范围与兼容性记录](macos-mvp-scope.md)。目标范围不代表现有代码已兼容或完成安装验收。

## 必须提供的桌面能力

- 原生安装、桌面/开始菜单入口、独立窗口、单实例、托盘、后台状态、版本与诊断。
- 配置服务端、登录/退出、Workspace选择、设备绑定与共享状态。
- 查看可访问用例/套件、下载资源、配置本地环境与凭证映射、选择可见/无头浏览器执行。
- 任务启动、进度、步骤与断言详情、日志、取消、历史、报告/Trace入口。
- 已下载资源在控制平台断网时仍能通过GUI运行与查看本地报告；恢复连接后显示待上传结果并可幂等回传。
- 浏览器/依赖自检、资源目录、并发、缓存清理、代理/证书与安装/卸载说明。
- 关闭窗口、退出UI、停止Agent、取消测试分别定义；窗口关闭默认到托盘并提示，正在执行任务时完全退出须明确展示影响。UI崩溃不导致无人值守Agent自动丢失。

联网资源编辑可以复用云端资源组件和API；既有离线包仍按只读快照执行。本次GUI要求不自动增加离线双向编辑/同步。桌面程序不要求本机安装Python/MySQL。

## 框架对比与推荐

| 维度 | Electron + React | Tauri 2 + React |
|---|---|---|
| 团队与引擎适配 | TypeScript/Node生态一致，现成集成较多 | Rust侧更重，Playwright以Node sidecar提供 |
| UI运行环境 | 内置Chromium，跨系统一致性较高 | 使用系统WebView，需验证WebView2/WebKit依赖 |
| 资源占用 | 安装体积和内存较大 | UI壳通常更轻，但Node/测试浏览器体积仍存在 |
| 第三方基础能力 | electron-builder/electron-vite等候选 | 官方插件/sidecar/capabilities等候选 |
| 推荐适用 | 优先交付完整功能与复用现有TS栈 | 优先减少UI壳资源且愿意维护Rust侧 |

推荐Electron + React + 独立Node24 Runtime。Electron内嵌Node版本随其版本变化，不能等同于锁定的Node24执行引擎；Agent/Runner使用单独固定版本。Playwright测试浏览器与桌面UI Chromium分离，桌面壳版本更新不静默升级测试引擎。

桌面入口名veriq，后台veriq_agent，执行veriq_runner；CLI可使用veriq_cli并保留兼容入口策略。实际Electron主/渲染进程和自有子进程在目标OS验收名称，不只改窗口标题。原先拟选Rust薄入口不再作为桌面必需组件，只有CLI/服务启动确有需要时保留。

## 代码与部署调整

- 新增apps/desktop，包含main、preload、renderer；复用packages/ui和可共享feature，使用Cloud/Local适配器区分数据来源。
- 桌面React产物随安装包本地提供，不能只load远程管理网址，否则离线GUI不可用。
- Electron main使用contextIsolation、关闭renderer Node集成、启用适用的sandbox；preload只暴露白名单类型化IPC，验证参数与sender。设备token、密钥、spawn和任意文件访问不暴露给renderer。
- Agent与UI之间使用受限本机IPC，服务端凭证不嵌入桌面前端；不开放无认证本地HTTP控制接口。
- CLI、桌面和云端共用编译器/SDK/结果协议，不实现两套测试引擎。
- 服务端仍按web build→Python static/dist→wheel统一发布；桌面产物按macOS x64、macOS arm64、Windows x64、Ubuntu x64分别构建，优先完成Mac两架构，包含GUI/Agent/Runner及所需依赖。共享业务代码不替代各平台凭据库、进程监督、原生文件和生命周期适配。
- 新增桌面构建/签名、GUI E2E、断网GUI、托盘/退出、崩溃重连、IPC授权与进程命名验收。升级/回滚使用签名校验并兼容引擎；执行中不强制更新。

## 完整MVP验收追加

安装后用户不需要终端即可完成配置、绑定、资源下载、启动/取消、报告和回传。拔掉平台连接后可打开本地软件、浏览缓存资源、运行和看报告。恢复后不丢执行历史、不重复上传；关闭窗口与停止后台的行为明确。桌面UI属于全部功能模块交付清单，不推迟到后续版本。

参考：https://www.electronjs.org/docs/latest/tutorial/security 、https://v2.tauri.app/develop/sidecar/ 。精确版本与打包工具由ADR冻结。
