# VeriQ 协作指南

## 从任务定位知识

项目的架构、公共契约、运维步骤和验收证据保存在 VeriQ-Knowledge。优先读取有权访问的本地检出，例如与本仓并列的 `../VeriQ-Knowledge`。从知识库根目录的 [变更导航](https://github.com/baofengbaofeng/VeriQ-Knowledge/blob/master/README.md#change-navigation) 定位文档。只有源码可用时，从当前检出的实现与测试取证，并在交付中标明待核对的知识库内容。[VeriQ-Knowledge](https://github.com/baofengbaofeng/VeriQ-Knowledge)

| 变更 | 首读知识库文档 | 本仓入口 |
| --- | --- | --- |
| HTTP、鉴权、外部调度 | `对外接口与集成契约/平台公开接口与共享数据契约.md` 的生产 HTTP 操作索引、`对外接口与集成契约/外部调度与持续集成接入规范.md` | `packages/contracts/`、`apps/srv/src/veriq_server/app.py` 和对应处理器、`scripts/veriq_ci.py` |
| 资源校验、设备领取、Runtime | `项目背景与系统架构/项目背景与首版架构总览.md`、`架构设计与决策记录/README.md` 中的 ADR-005、ADR-010、ADR-021 | `apps/srv/src/veriq_server/services/` 下的 `jobs.py` 和 `server_compilation.py`、`apps/runtime/src/agent/claim-loop.ts` |
| 安装、迁移、恢复 | `部署发布与运维恢复/服务端发行构建与安装手册.md`、`部署发布与运维恢复/数据库迁移备份与恢复手册.md` | `apps/srv/src/veriq_server/cli.py`、`deploy/`、`apps/srv/tests/operations/` |

事实以适用版本的源码、契约和实际验收为依据。接口、配置、权限或发布行为变化时，在 PR 中记录受影响的知识库页面及同步状态。跨仓检查从知识库根目录启动，按其 `.agents/skills/kb-consistency-check/SKILL.md` 和仓库脚本执行。

## 验证入口

- 在源码仓根运行 `pnpm check`、`pnpm test`，按变更涉及的包选择范围。修改共享契约时核对 `pnpm contracts:generate` 的生成物。
- Web 检查通过 `pnpm --filter @veriq/web check` 单独运行，默认 Web 测试入口是 `pnpm --filter @veriq/web test:e2e`。独立交互套件使用 `pnpm --filter @veriq/web exec playwright test -c playwright.interactions.config.ts`。桌面端到端入口是 `pnpm desktop:test`。
- 服务端测试从根目录使用 `uv run --project apps/srv python -m pytest -c apps/srv/pyproject.toml apps/srv/tests`，按变更选择文件和用例。需 MySQL 的测试使用专用测试库。
- 在交付中记录实际执行的命令、结果和未核验的目标环境。仓库外的临时规格、计划与运行日志留在本地。
