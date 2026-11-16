<a id="v00公共契约与生成代码独立验证"></a>

# V00 Contracts

状态：本轮已修改源码并运行必要代码生成，未执行验证或复审。

| 项目 | 后续任务 | 通过标准 |
| --- | --- | --- |
| 维护操作 | 验证 `ServiceTokenIssue` 五项 MAINTENANCE 操作和 EXECUTION 三项操作 | 维护允许 `lifecycle/expire`；五项可同时选择，重复/未知值被拒绝；执行仍限定 trigger/read/cancel 与计划 |
| 生命周期入口 | 调用 `POST /internal/v1/maintenance/lifecycle/expire` | 复用有界请求、Workspace 服务令牌、幂等键与游标；错误权限、跨空间、同键异参均被拒绝 |
| 运维指标 | 调用 `GET /api/v1/workspaces/{workspaceId}/operations/metrics` | 当前 OWNER/ADMIN 可读，普通成员与跨空间不能读取；超时 503；返回标准 data/requestId 信封 |
| 指标字段 | 核对实际 DB 数据与 DTO | queue/capacity/leases/heartbeat/events/cleanup/storage/modelCost 均为当前空间的实际观测，计数不为负，无凭据或原始日志 |
| 代码生成 | 执行 `pnpm --filter @veriq/contracts check` 及适用契约测试 | OpenAPI、Schema 和生成 TS 一致，无以手改生成文件掩盖源定义不一致 |
| 桌面派生契约 | 对照 `apps/desktop/scripts/generate-operations.mjs` 输出与 IPC 白名单 | 新枚举同步，未经设计的任意 HTTP/文件/命令能力没有暴露 |
| 兼容性 | 原四项维护与原 health/readiness 调用 | 旧请求与返回兼容；无内部 Cron，EXECUTION、设备登记和员工会话用途没有混淆 |

前置：锁定的 Node 24、pnpm 11.25.0、既有依赖、独立 MySQL 测试数据库、已初始化管理员与两个 Workspace。不要在本轮代码提交上直接标记上述任务通过；实际命令、提交、输出和失败修复应由接手 Agent 登记。

生命周期补充：验证报告/历史/证据元数据、Bundle 读取/下载/幂等重放与 AI 详情/review/cancel 的 410 以及导入引用过期 Bundle 的拒绝。报告 SSE 在首帧前返回 HTTP 410；首帧后使用既有 authorization 事件携带 REPORT_EXPIRED，此领域到期不得撤销当前员工会话。原始证据下载仍按原 ACL 和到期规则处理。
