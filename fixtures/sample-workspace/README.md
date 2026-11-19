# VeriQ sample Workspace source

规范实现和数据已移入 `veriq_server.examples` 安装包，使用 `python -m veriq_server.examples.bootstrap`。本目录 bootstrap/platform_http 仅兼容转交相同已安装实现，不插入仓库路径、不维护第二套导入器。JSON 保留为文档兼容副本，正常发行 stage_examples 要求与规范包逐字节相同。

实际 GUI 位于 Workspaces 的“导入示例 Workspace”，清单来自已认证的 `/api/v1/examples/sample-workspace`。真实编译、回执、发布和计划仍走原员工API；无Runtime、批准引擎或凭据投递时失败或等待，不合成成功。

按[完整指南](../../docs/guides/示例工作区快速开始.md)先创建空间、授权实际Runtime，再完成CLI或GUI导入。本轮源码未执行，安装包/GUI/恢复验证接续见[V06](../../docs/validation/tasks/端到端接入验收.md)。
