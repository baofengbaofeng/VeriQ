# Rules

本文件是 `.agents/rules/` 的索引。每条只转述该文件自己写明的用途，并说明何时打开它。具体条文在对应文件里。

## 直接放在 `.agents/rules/` 的标准

### [api-compatibility-evolution-standard.md](./api-compatibility-evolution-standard.md)

用途：约束公共 HTTP、IPC 与结果协议的变更方式，保证客户端、Runtime 与外部调度可安全演进。

何时阅读或适用：变更公共 HTTP、IPC 或结果协议时。

### [architecture-boundary-extensibility-standard.md](./architecture-boundary-extensibility-standard.md)

用途：固定模块职责与依赖方向，使新功能可扩展而不侵蚀控制面与执行面分离。

何时阅读或适用：新增模块、调整依赖方向或做扩展时。

### [asset-compilation-immutable-artifact-standard.md](./asset-compilation-immutable-artifact-standard.md)

用途：约束 DSL、校验、编译、发布与执行快照，保证可复现执行，并防止改生成物或跑最新草稿破坏确定性。

何时阅读或适用：处理 DSL、校验、编译、发布或执行快照时。

### [audit-event-standard.md](./audit-event-standard.md)

用途：约束审计日志、执行事件流与实时通知的完整性、授权与可靠性，支撑追责与可观测性。

何时阅读或适用：记录审计、发出执行事件或提供实时通知时。

### [coding-standard.md](./coding-standard.md)

用途：VeriQ 仓库编码规范的入口。规定跨语言强制约定，以及这些约定与 VeriQ 产品约束冲突时的优先规则。语言细则以专项指南为准。

何时阅读或适用：编写或审查源码、需要跨语言格式与注释约定，或需要判断语言指南与产品约束谁优先时。语言细节再打开 `coding-standard-rules/` 下的指南。

### [commit-standard.md](./commit-standard.md)

用途：规范 Git 提交的内容边界、消息格式与代理协作约束，保证历史可审阅、可回滚、可追溯。

何时阅读或适用：准备提交、写提交消息，或处理代理协作中的提交边界时。

### [concurrency-idempotency-state-standard.md](./concurrency-idempotency-state-standard.md)

用途：约束队列领取、租约、fencing、取消与结果写入，降低竞态、重复执行与错误释放容量的风险。

何时阅读或适用：实现或修改队列领取、租约、fencing、取消或结果写入时。

### [database-migration-standard.md](./database-migration-standard.md)

用途：约束 MySQL 模式设计、Alembic 迁移与数据完整性，保障可演进与生产安全。

何时阅读或适用：设计表结构、编写迁移或处理数据完整性时。

### [dependency-license-standard.md](./dependency-license-standard.md)

用途：规定第三方依赖的选取、钉死、许可兼容与变更流程，降低供应链与合规风险。

何时阅读或适用：选取、钉死、升级依赖，或判断许可兼容时。

### [documentation-contract-standard.md](./documentation-contract-standard.md)

用途：规定规格、ADR、用户文档与跨语言契约的维护方式，保证实现、类型、样例与文档一致。

何时阅读或适用：修改规格、ADR、用户文档或跨语言契约时。

### [error-handling-observability-standard.md](./error-handling-observability-standard.md)

用途：提升故障可诊断性与失败关闭的一致性，避免静默失败和敏感信息泄漏。

何时阅读或适用：设计错误处理、失败关闭、日志或可观测信号时。

### [native-cross-platform-standard.md](./native-cross-platform-standard.md)

用途：约束桌面与 Runtime 在各操作系统上的进程、凭据、文件系统与停止证明，避免用单一平台假设冒充全平台正确。

何时阅读或适用：改动各操作系统上的进程、凭据、文件系统或停止证明时。

### [outbound-network-integration-standard.md](./outbound-network-integration-standard.md)

用途：约束控制面、Runtime 与桌面发起的外部调用和集成点，防止 SSRF、凭证泄漏与不可控重试风暴。

何时阅读或适用：新增或修改出站调用与外部集成时。

### [performance-timeout-budget-standard.md](./performance-timeout-budget-standard.md)

用途：用明确的并发上限、超时与批次预算约束实现，避免无界等待、资源耗尽与「靠睡一会儿」的假稳定。

何时阅读或适用：设定并发上限、超时、批次预算，或评估阻塞与资源占用时。

### [privacy-data-retention-standard.md](./privacy-data-retention-standard.md)

用途：约束用户数据、证据、日志与备份中的敏感信息处理及保留期，降低泄漏与合规风险。

何时阅读或适用：处理用户数据、证据、日志、备份或保留期时。

### [release-rollback-configuration-standard.md](./release-rollback-configuration-standard.md)

用途：约束服务端、桌面与引擎发行物的完整性、可追溯与安全默认配置，降低错误发布与不可回滚的风险。

何时阅读或适用：构建发行物、准备回滚或设定配置默认时。

### [review-standard.md](./review-standard.md)

用途：规定代码与规格审查的职责、必查项与拒绝标准，避免「看起来绿」的合入。

何时阅读或适用：审查代码或规格、给出审查结论时。

### [security-standard.md](./security-standard.md)

用途：规定认证授权、密钥处理、桌面 IPC、供应链与失败关闭的安全基线。实现细节以规格与 ADR 为准；本文件约束必须与禁止的行为。

何时阅读或适用：改动认证授权、密钥、桌面 IPC、供应链或安全失败关闭时。

### [testing-standard.md](./testing-standard.md)

用途：规定测试分层、TDD 流程、断言诚实性、覆盖率与平台相关验证要求。

何时阅读或适用：编写或审查测试、覆盖率或平台验证时。

## `coding-standard-rules/` 下的语言指南

这两份是语言细则。`coding-standard.md` 写明跨语言强制约定，并要求语言细节以专项指南为准。

### [python-coding-standard.md](./coding-standard-rules/python-coding-standard.md)

用途：Python 风格指南，列出 Python 程序应当遵守和应当避免的做法。文首的 VeriQ 改编是规范性的，与 Google 原文不一致时以改编为准。

何时阅读或适用：编写或审查 Python 源码的语言用法和风格时。

### [typescript-javascript-coding-standard.md](./coding-standard-rules/typescript-javascript-coding-standard.md)

用途：TypeScript 与 JavaScript 风格指南。术语采用 RFC 2119。示例只说明规则，示例中的可选格式不是额外规范。文中的 VeriQ 格式规则是规范性的，与 Google 原文不一致时以该节为准。

何时阅读或适用：编写或审查 TypeScript 或 JavaScript 源码的风格时。
