# VeriQ sample Workspace source

`assets/*.json` 是七类现有 DSL 文档，`manifest.json` 记录拓扑顺序与有效 UUID 示例别名；导入时重写为真实发布版本。没有测试报告、伪造回执或 SQL 引导数据。

`bootstrap.py` 使用标准库和 `platform_http.py` 调用员工 Cookie/CSRF API，创建空间/身份、依次真实验证发布、建立 HTTP 计划；不触发 Run，不自动授权设备或晋升引擎。状态文件只保存非秘密元数据，恢复时拒绝覆盖已变化的资源。

按[完整指南](../../docs/guides/sample-workspace.md)先 `--workspace-only`、授权实际 Runtime，再完成导入。C06 源码未执行，验证接续见[V06](../../docs/validation/tasks/V06-integration.md)。
