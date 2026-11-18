# VeriQ 对话测试 Agent 实施计划

> **执行方式** 使用 `superpowers:subagent-driven-development` 分任务实现及审查。

**目标** 交付可以从多轮对话自主制定、修改、执行测试计划，并跨 Web 和 Electron 查看进度和结果的首版。

**架构** Tornado 服务端存储会话、对话轮次和 Workspace 模型设置。服务端复用 Provider 预算、结构化模型输出和 VeriQ 现有执行服务。两端客户界面复用会话视图和云端报告适配器。

**技术栈** Python 3.12、Tornado、SQLAlchemy / MySQL 8.4、React、Electron 和共享 OpenAPI。

**规格** [对话测试 Agent](../specs/conversational-test-agent.md)

## 共同约束

- 使用当前员工认证和 Workspace 权限，服务端检查会话所有权。桌面使用现有受限 CloudOperation 桥接。
- 维护 OpenAPI、JSON Schema、Python 包内 Schema 和 TypeScript 生成契约的同步。新增表保留 `veriq_` 命名。
- 使用现有依赖、队列、已发布资产和冻结执行快照。对模型输出和操作确认分别进行结构、来源和权限校验。
- 模型密钥及原始制品留在受限通道。会话文本与模型输出不进入普通审计日志。

## 审查重点

- 拿到另一个用户或 Workspace 的会话、轮次标识仍无法读取或操作。
- Provider 继承、显式禁用和预算耗尽按服务端权威配置处理。
- 另一端保存新版计划后，旧预览不能覆盖新版本或触发新版计划。
- 两端确认同一操作及网络重试不会重复保存或执行。
- 聊天或模型调用不可用时，现有 Run 进度、结果和人工操作继续可用。

### 任务 1：会话、配置与契约

**文件** `apps/srv/src/veriq_server/db.py`、迁移 `0016_conversational_agent.py`、`services/agent_sessions.py`、`handlers/agent.py`、`app.py`、`packages/contracts` 与相关测试。

- [ ] 使用真实 MySQL 测试会话隔离、创建/归档、分页、已绑定/继承/未配置，先观察新路由缺失的失败。
- [ ] 提供 `/api/v1/workspaces/{workspaceId}/agent/settings` GET/PUT，保存两个可空 Provider ID，以及修订或采用安装锁对配置写入串行化。管理要求 MANAGE_WORKSPACE，GET 只公开配置 ID 和解析状态。
- [ ] 提供 `/agent/sessions` GET/POST、`/agent/sessions/{sessionId}` GET/DELETE（归档）、`/agent/sessions/{sessionId}/turns` GET，当前用户名下会话按签名游标分页。实现 `AgentSessionService`、`AgentSettings`、`AgentSession`、`AgentTurn`，并把轮次提交和确认契约登记供下一任务接入。
- [ ] 提供 `POST /agent/sessions/{sessionId}/turns`，输入 `{requestId, text}`，以及 `POST /agent/sessions/{sessionId}/turns/{turnId}/confirm`，两者返回 `AgentTurnDTO`。轮次项包含 `id`, `text`, `status`, `createdAt`，可含 `reply`, `errorCode`, `providerId`, `providerRevision`, `proposal`, `receipt`。提议使用明确类型 `SAVE_PLAN`, `TRIGGER_PLAN`, `RUN_ONCE`，回执使用对应的计划或 Run 标识。下一任务接入这两条写路由。
- [ ] 生成契约并运行相应 Python 和 TypeScript 测试。

### 任务 2：对话编排与执行操作

**文件** `services/conversational_agent.py`、对话上下文和已验证操作模块、`services/ai.py` 或共用计费服务、Provider 网关、`handlers/agent.py` 与相关测试。

- [ ] 通过本机模型协议模拟器与真实数据库编写并先运行失败用例。覆盖利用第二轮调整计划、保留未调整字段、未知/跨空间候选、旧修订冲突、一次性运行、重复请求和幂等确认。覆盖停用、预算和普通 AI 历史隔离。
- [ ] `POST .../turns` 持久化按会话唯一的请求、查找当前已发布资产/计划/环境/Runtime 和会话内真实 Run 安全摘要。给模型有限候选上下文，系统指令要求计划细化、优先选现有候选、列缺口及假设、集中追问。只接受有效 Schema 和已授权候选。模型输出持久化为回复及可选结构化预览。命中明确的确认指令时应用上一条确定操作。
- [ ] 复用 `ExecutionPlanService.write`、`TriggerService.trigger`、`RunService.create` 和 `ReportService`。在同一受控事务重校验所有权、计划修订及当下授权，写入业务事实和回执。更新使用对基准计划的有限变更，已保存计划与本次执行的调整保持各自语义。
- [ ] 用现有 AI Provider 预算原子预留和记账，锁外调用网关并重查授权；拒绝持久化非法模型操作。以稳定操作身份保持重试幂等，前端刷新通过轮次历史恢复请求状态。
- [ ] 运行 Agent、AI、执行计划和契约回归测试。

### 任务 3：双端对话与报告

**文件** `apps/web/src/features/agent`、Web 路由和导航、桌面 UI 入口和操作白名单、服务端 SPA 登记与相关测试。

- [ ] 编写共享 UI 与双端桥接测试，先观察入口缺失。验证会话请求使用当前工作区，切换工作区清除旧视图，模型继承、确认、历史与 Run 卡片可用。
- [ ] 共用对话视图和服务端适配器，提供会话列表、输入与多轮历史、计划差异预览、操作确认、配置入口和错误。复用报告订阅展示真进度、结论和授权报告链接。桌面接入主进程 OpenAPI 操作白名单，离线时显示连接提示。
- [ ] 运行 Web/桌面类型检查、契约检查及可用的端到端测试。

## 集成验收

- 简短业务描述 → 已发布资产匹配与覆盖缺口 → 创建或修改计划 → 执行 → 在另一端继续会话 → 看到实际报告。
- 专用模型配置、继承、无可用模型，跨用户/Workspace 拒绝，计划修订冲突与幂等重放逐项验证。验证真实 Provider 和目标平台时分别记录测试条件。
