# Native and cross-platform standard

行宽口径：源码及注释每个物理行最多 **120 个显示列**，与 IDE 的 120 列标尺一致。
中文及其它全角/宽字符占 2 列，ASCII 占 1 列；缩进、标点和注释分隔符均计入。

约束桌面/Runtime 在各 OS 上的进程、凭据、文件系统与停止证明，避免用单一平台假设冒充全平台正确。

## 1. 目标矩阵

| 目标 | 要求 |
| --- | --- |
| macOS 15+ x64 / arm64 | 最高优先；宿主原生 Chrome；真实架构验收；Rosetta 不能代替另一架构结论 |
| Windows 11 x64 | 必须交付；Server 验证不能自动等同 Win11 安装验收 |
| Ubuntu 24.04 x64 | 必须交付 |
| 服务端 Linux x64 | 控制面无 Node/Chrome 运行时依赖 |

每平台分别构建与验收；禁止「在 A 平台绿了就声称 B 支持」。

## 2. 进程命名与监督

- 真实 OS 进程名：`veriq` / `veriq_agent` / `veriq_runner`（及 Windows `.exe`）。
- Electron 内嵌 Node ≠ 锁定 Node 24 执行引擎；测试浏览器 ≠ 桌面 UI Chromium。
- Linux / Windows：全后代停止范围 `FULL_DESCENDANT_TREE`（subreaper / Job 等经核实机制）。
- macOS：`CONTROLLED_WORKER_BROWSER`；不确定则隔离；禁止写成 `DRAINED` 全树证明。
- 不得以 PID 扫描、窗口关闭、裸退出码单独作为完整停止回执。

## 3. 凭据与私有存储

- 使用各平台批准的保险库 / 加密信封（如 Windows Credential Manager、Linux Secret Service、macOS Keychain 方案须按规格选择并验证）。
- 禁止明文 fallback。Darwin 等平台须考虑扩展 ACL 等超出简单 `0600` 的威胁。
- Cookie / 密钥文件权限与所有者检查须在目标 OS 验证；不要假设 POSIX 权限模型处处成立。

## 4. 文件系统与路径

- 拒绝路径穿越与任意链接跟随（按平台规则）；Mac `.app` 内符号链接策略须显式设计，禁止全局放开。
- 路径长度、socket 路径上限、换行符（LF/CRLF）差异须在原生与测试中显式处理。
- 私有日志 FD / 目录 fd 相对操作等能力缺失时失败关闭，不得 silently 退回不安全 API。

## 5. 能力声明

- Runtime 须声明平台、架构与停止范围等能力；服务端按声明校验正回执，不远程「重做」OS 事实。
- 缺能力则 doctor/ready 失败，不得带病领取浏览器任务。

## 6. 检查清单

- [ ] 变更在目标 OS/架构有对应证据或明确未验证声明
- [ ] `processStopScope` 与平台匹配
- [ ] 凭据与私有文件无明文 fallback
- [ ] 未用跨平台假设掩盖路径/权限/进程差异
