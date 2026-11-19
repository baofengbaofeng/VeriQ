# README

本文件是 `docs/` 目录的索引，按任务查找开发、使用、接入、发行与验收资料。首版联网执行范围见公共契约，历史离线协议见兼容资料。操作指南与验收记录分别提供执行步骤和验证证据。

## 主要文档

| 文件 | 用途 | 何时阅读 |
| --- | --- | --- |
| [`docs/开发指南.md`](开发指南.md) | 开发环境、数据库初始化、控制服务与 Web 启动及开发检查。 | 配置本地环境、启动服务或运行检查时。 |
| [`docs/公共契约.md`](公共契约.md) | 公共接口、工作区数据集、资源编译、联网执行及历史兼容边界。 | 改动公共接口、数据集或执行路径时。 |
| [`packages/contracts/openapi/platform.yaml`](../packages/contracts/openapi/platform.yaml) | 平台 HTTP 接口的 OpenAPI 定义。 | 改动路由、请求、响应或鉴权契约时。 |
| [`packages/contracts/schemas/platform-v1.schema.json`](../packages/contracts/schemas/platform-v1.schema.json) | 共享 JSON Schema 的规范源。 | 改动共享字段、校验规则或生成类型时。 |
| [`docs/桌面工作台指南.md`](桌面工作台指南.md) | 工作台操作、宿主边界、Agent 与窗口生命周期、源码构建及桌面验收入口。 | 改动 Electron 桌面或本地 GUI 时。 |
| [`docs/decisions/0021-运行时发行与原生边界.md`](decisions/0021-运行时发行与原生边界.md) | Runtime 发行、目标平台与原生边界。 | 改动桌面或 Runtime 平台目标、发行或停止能力时。 |
| [`docs/模型辅助使用指南.md`](模型辅助使用指南.md) | Workspace Provider 配置、生成审核、预算及真实服务验收条件。 | 配置 Provider、审核生成内容或准备真实服务验收时。 |
| [`docs/本机凭据管理.md`](本机凭据管理.md) | 凭据档案退役、恢复及受管理 Linux 服务的显式文件存储条件。 | 操作本机凭据档案或核对文件存储边界时。 |
| [`docs/服务端发行指南.md`](服务端发行指南.md) | 发行候选构建、引擎晋升及目标安装、迁移和回滚。 | 构建、核验或部署服务端候选时。 |
| [`docs/历史离线资源包.md`](历史离线资源包.md) | 历史签名包格式、验签、签发者轮换和凭据映射。 | 核对旧资源包兼容性时。 |
| [`docs/历史离线执行与结果导入.md`](历史离线执行与结果导入.md) | 历史本机执行、报告恢复和结果导入协议。 | 核对或恢复历史离线记录时。 |

## 专题索引

- 示例工作区、前后端操作、编辑器配置和运维指引见[使用与接入指南](guides/使用与接入指南.md)。
- 业务前后端契约、外部调度和 CI 协议见[系统接入规范](integration/系统接入规范.md)。
- 需求矩阵、前置条件、历史证据及独立验收任务见[验证与验收索引](validation/验证与验收索引.md)。
- 安装依赖的许可元数据和专项审计证据见[依赖清单与审计记录](dependencies/README.md)。
- 架构选择、工程基线和批准边界见[架构决策记录](decisions/)。
- 服务端部署切换前的数据库迁移步骤见[数据库迁移](operations/migrations.md)。
- macOS 双架构 Runtime 凭据库的测试准备和独立验收步骤见[macOS Keychain](testing/macos-keychain.md)。
