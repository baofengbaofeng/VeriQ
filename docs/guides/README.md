# VeriQ 接入与使用指南

这些指南对应当前源码，**C06 新增内容尚未运行验证或独立复审**。执行结果、正式安装与发行状态以[验证交接](../validation/mvp-handoff.md)为准。

| 任务 | 阅读入口 | 可使用的源代码 |
| --- | --- | --- |
| 导入示例空间并建立 HTTP 计划 | [示例快速开始](sample-workspace.md) | [导入器](../../fixtures/sample-workspace/bootstrap.py)、[七类资产](../../fixtures/sample-workspace/assets/) |
| 接入业务前端 | [React18 接入](frontend-react18.md) | [组件](../../fixtures/integration/react18/)、[可运行 demo UI](../../fixtures/demo-app/) |
| 接入 Java/Python 后端 | [HTTP 后端接入](backend-http.md) | [标准库客户端](../../fixtures/integration/python/lifecycle.py)、[Spring Boot2.3.1](../../fixtures/integration/spring-boot-2.3.1/) |
| 使用、管理与排障 | [用户、管理员与运维](users-and-operators.md) | [具体运维命令](../../deploy/OPERATIONS.md)、[已有开发入口](../development.md)、[发行说明](../release.md) |
| 后续 Agent 真实验证 | [V06](../validation/tasks/V06-integration.md) | 环境、命令、8条流程×5轮、失败及清理要求 |

产品规格、公共 Schema、原有接入规范分别见[需求](../specs/veriq-1.0.md)、[契约](../contracts.md)、[前端](../integration/frontend.md)、[后端](../integration/backend.md)。这些指南补充落地步骤，不创建另一份协议或验收结论。
