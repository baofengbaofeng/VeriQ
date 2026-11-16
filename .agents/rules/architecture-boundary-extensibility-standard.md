# Architecture boundary and extensibility standard

固定模块职责与依赖方向，使新功能可扩展而不侵蚀控制面/执行面分离。

## 1. 分层与方向

允许的依赖方向（概念上）：

```text
apps/web, apps/desktop(renderer)
        ↓
packages/ui, packages/contracts
        ↓
apps/srv (控制面)  ←HTTP→  apps/runtime / desktop(agent)
                                ↓
                     packages/compiler, packages/runner-sdk
```

- 控制面 **不得** 依赖 Playwright、Chrome、Electron、桌面原生模块才能启动或完成核心 API。
- Web/Desktop UI **不得** 直连数据库或读取服务端私有密钥存储。
- `packages/contracts` 保持无业务副作用；生成类型可被各端依赖，但契约包不反向依赖 apps。
- 禁止为图省事引入循环依赖（例如 runtime ↔ srv 共享可变单例）。

## 2. 职责边界

| 模块 | 应做 | 不应做 |
| --- | --- | --- |
| `apps/srv` | 认证、Workspace、队列、契约校验、静态托管 | 跑浏览器测试、内嵌 Node 执行引擎 |
| `apps/runtime` | 领取任务、编译执行、本地持久化、停止证明 | 实现第二套结果协议或绕过 fencing |
| `apps/desktop` | GUI、白名单 IPC、本地打包资源 | 用远程网页代替离线 GUI；把 Electron Node 当测试引擎 |
| `packages/compiler` | DSL → 不可变 TS | 执行测试或访问用户密钥 |
| `packages/runner-sdk` | 确定性执行与事件 | 产品级重试策略（重试归 VeriQ） |

## 3. 扩展点偏好

- 新能力优先：契约字段扩展 → 服务适配 → Runtime 能力声明 → UI，而不是先做 UI 假页面。
- 平台差异收敛到 native/adapter 层；共享业务代码不复制成多份「几乎一样」的实现。
- 存储后端（本地文件 / S3 等）以适配器隔离；业务服务不散落 SDK 调用。
- AI Provider 以适配器接入；确定性主路径在无 Provider 时完整可用。

## 4. 配置与特性开关

- 配置经统一设置加载与校验；禁止散落魔法常量且无文档。
- 特性开关不得绕过授权或签名校验。
- 环境相关 URL、域名约束等属于环境资产，不硬编码进执行快照逻辑之外的随意位置。

## 5. 代码质量与可扩展性

- 新模块保持小而可测；公共入口有中文注释说明不变量。
- 避免「工具类万能桶」导致边界消失。
- 复制粘贴第三次出现的逻辑应抽到正确层（contracts / domain service / adapter），而不是继续分叉。

## 6. 检查清单

- [ ] 未把执行引擎依赖引入控制面
- [ ] 依赖方向符合分层；无新的循环依赖
- [ ] 平台差异在适配层；契约先于 UI
- [ ] 扩展未削弱授权/签名/停止等不变量
