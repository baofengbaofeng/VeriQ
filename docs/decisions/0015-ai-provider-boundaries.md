<a id="0015--optional-ai-providers-review-and-bounded-spending"></a>
# 0015 AI Provider Boundaries

状态：协调者预研后，T13 已接受。普通 Run/Agent 执行绝不导入或调用模型网关。

经小型统一异步网关使用官方 `openai==2.29.0`（Apache-2.0）与 `anthropic==0.84.0`（MIT）SDK。新增解析图经 OSV 审计，记录的七包查询未返回公告。HTTPX 保留 TLS 验证、操作员配置的精确 base URL 授权、禁用重定向与重试、30 秒超时及有界响应字节。模型、端点和费率显式配置，不做发现调用或隐式付费重试。

Provider 密钥只作为只写 API 输入。独立 Provider 记录使用现有 AES-GCM Keyring，AAD 用途为 `veriq-ai-provider-v1`；业务凭据 AAD 仍为 `veriq-credential-v1`。Provider 密钥不进入模型上下文、历史、审计、普通错误或凭据投递。早期未实现的 OpenAPI `secretRef` 替换为 `apiKey` 输入与 `keyConfigured` 输出，没有已持久化的旧 AI 记录需要迁移。

Owner/Admin 管理 Provider 和连接测试；Editor 及以上可生成/审核，成员查看当前范围历史。网络调用前后检查当前安装、身份、成员与 Provider；不跨外部 I/O 持有数据库事务或锁。撤销阻止后续披露或应用输出。生成使用请求 UUID 与规范请求摘要实现幂等，包括结果不明的失败之后。

每次调用冻结端点、模型、费率、币种，并在发送前预留整数微美元估算。输入上界包含完整序列化 messages/system/schema/context 的 UTF-8 字节量及 8192 个 Provider 封装 token。输出最多 8192 token，总输入上界 262144 token，单请求预留最多 USD5，月配置预算最多 USD10000。这些保守可配置价格是估计，不保证 Provider 实际计费。验证后的用量按不可变价格快照估算成本；缺少用量、错误、取消或进程中断继续占用预留，并显示实际用量/成本未知。UTC 自然月按需记账，未解决预留带入后续准入；不设 Cron，不自动退款、重试或协调。预算不得低于已持有/已使用额；有在途调用时只允许禁用，不允许不兼容的模型、密钥或费率变更。

上下文经过选择且可审阅：需求、提供的 OpenAPI/非秘密数据、选定不可变目录/数据版本、可选当前 CASE 修订及 ReportService 脱敏投影。不任意抓取、使用工具、读取原始产物、解析业务秘密或导出整个 Workspace。规范 JSON Schema 校验有界模型输出。只有人工显式接受，才经 ResourceService 写 CASE 草稿，保留修订/引用检查；边界和失败分析仍只是建议。Runtime 编译、调试、发布继续使用现有编辑器。

本地协议模拟器证据与真实 Provider 验收分开。付费外部验收调用要求用户批准端点、模型及预算，并在 Provider UI/设置输入密钥。不在聊天中索取秘密，也不在托管环境配置秘密值。
