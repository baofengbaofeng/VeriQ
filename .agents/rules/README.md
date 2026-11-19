# README

本文件是 `.agents/rules/` 的索引。每条说明规范的用途和适用时机。具体条文见对应文件或章节。

源码与注释的统一要求见《Coding Standard》的[显示列宽的统一计算](./coding-standard.md#11-显示列宽的统一计算)与[注释正文长度](./coding-standard.md#12-注释正文长度)。

## 1. 独立规则文档

| 文件 | 用途 | 何时阅读或适用 |
| --- | --- | --- |
| [`.agents/rules/coding-standard.md`](./coding-standard.md) | 跨语言编码与工程要求，涵盖架构、契约、并发、依赖与外部集成等主题。 | 编写或审查源码时阅读，工程主题按[文档目录](./coding-standard.md#目录)查找。 |
| [`.agents/rules/commit-standard.md`](./commit-standard.md) | Git 提交边界、消息格式与代理协作约束。 | 准备提交或写提交消息时。 |
| [`.agents/rules/privacy-standard.md`](./privacy-standard.md) | 数据分类、访问控制、保留期与脱敏。 | 处理用户数据、证据、日志或备份时。 |
| [`.agents/rules/release-standard.md`](./release-standard.md) | 发行物完整性、安全配置与回滚，以及目标平台验收、进程与凭据要求。 | 构建发行物、准备回滚或配置默认值时查阅[发行、配置与回滚](./release-standard.md#1-发行配置与回滚)。涉及目标平台验收、进程、凭据、文件系统或停止证明时查阅[原生与跨平台要求](./release-standard.md#2-原生与跨平台要求)。 |
| [`.agents/rules/review-standard.md`](./review-standard.md) | 审查职责、必查项与拒绝标准。 | 审查代码或规格、给出审查结论时。 |
| [`.agents/rules/security-standard.md`](./security-standard.md) | 认证授权、密钥、桌面 IPC、签名、供应链与失败关闭的安全基线。 | 改动安全相关路径时。 |
| [`.agents/rules/testing-standard.md`](./testing-standard.md) | 测试分层、TDD、断言诚实性、覆盖率与平台验证。 | 编写或审查测试、评估覆盖率或进行平台验证时。 |

## 2. `coding-standard-rules/` 下的语言指南

编写 Python、TypeScript 或 JavaScript 时，须同时遵守 [Coding Standard](./coding-standard.md) 和下表对应的语言指南。语言指南与总则冲突时，以总则和 [`AGENTS.md`](../../AGENTS.md) 中的不可协商基线为准。总则与语言指南已经写明的数字和工具名不得用旧稿覆盖。

| 文件 | 用途 | 何时阅读或适用 |
| --- | --- | --- |
| [`.agents/rules/coding-standard-rules/python-coding-standard.md`](./coding-standard-rules/python-coding-standard.md) | Python 语言与风格细则，文首的 VeriQ 改编是规范性的。 | 编写或审查 Python 源码时。 |
| [`.agents/rules/coding-standard-rules/typescript-javascript-coding-standard.md`](./coding-standard-rules/typescript-javascript-coding-standard.md) | TypeScript 与 JavaScript 风格细则，文中的 VeriQ 格式规则是规范性的。 | 编写或审查 TypeScript 或 JavaScript 源码时。 |
