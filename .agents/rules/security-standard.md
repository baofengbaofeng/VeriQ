# Security standard

行宽口径：源码及注释每个物理行最多 **120 个显示列**，与 IDE 的 120 列标尺一致。
中文及其它全角/宽字符占 2 列，ASCII 占 1 列；缩进、标点和注释分隔符均计入。
注释长度只统计有效正文的 Unicode 字符，不含缩进与注释符号。
独立单行及块注释首行有效正文为 40～120 字符；块注释续行不设 40 字符下限。

规定认证授权、密钥处理、桌面 IPC、供应链与失败关闭的安全基线。实现细节以规格与 ADR 为准；本文件约束「必须 / 禁止」行为。

## 1. 威胁模型要点（实现时默认假设）

- 攻击者可能持有跨 Workspace 的资源 ID 猜测或泄漏的链接。
- Renderer / 前端不可信任；不得把高权限能力直接暴露给 UI 层。
- 离线包可能被篡改；签名验证失败必须拒绝，不得降级为「警告后继续」。
- 本地 Runtime 上的恶意或受损进程可能尝试读取凭证库；须依赖 OS 凭据存储与最小权限 IPC。
- 日志与错误响应是常见泄密面。

## 2. 认证、会话与令牌

- 员工登录身份与服务账号身份分离；服务令牌只能授予已声明的 Workspace / 计划 / 维护操作范围。
- 禁止「知道 planId 即有权执行」；所有触发接口须鉴权与授权。
- 会话撤销、用户禁用、令牌轮换必须立即对后续请求生效。
- 密码使用成熟哈希库（如 argon2）；禁止自研哈希或明文存储。
- 设备 token、API token、刷新凭证禁止写入前端构建产物、仓库、日志或 issue/PR 正文。

## 3. Workspace 授权

- Workspace 是资源与授权边界。凡资源读写、批量操作、引用解析、SSE/事件、证据下载、导出、导入、Runtime 领取/上传/凭证解析，均须校验 `workspace_id` 与成员状态。
- 系统管理员不是隐式空间成员，也不隐式拥有私人设备派单权。
- 个人 Runtime 默认私有；共享须所有者显式授权。撤销后必须阻断后续 claim/download/upload。
- 跨空间 IDOR 类缺陷视为高危：测试必须覆盖负例。

## 4. 密钥与敏感数据

- 密钥、密码、Cookie、设备 token 不得进入离线包、静态资源目录或客户端可下载的明文配置。
- 配置 UI 可创建/更新/撤销凭证引用，但不得回显原文。
- 日志、追踪、错误响应须脱敏；禁止打印 Authorization 头、Cookie、连接串密码。
- 本地凭据使用各平台系统保险库 / 批准的加密信封；禁止明文 fallback「先跑通再说」。
- 测试夹具使用假数据或专用测试密钥；禁止提交真实生产凭证。

## 5. 控制面与执行面

- 控制服务运行时不需要 Node/Chrome；不得为了图省事把浏览器执行嵌进控制面进程。
- 制品上传路径由服务端生成与校验；拒绝任意文件路径与路径穿越。
- 维护与触发接口：受限身份、有界批次、幂等；禁止未认证的内部后门路由。

## 6. Electron 与本机 IPC

- 启用 `contextIsolation`；关闭 renderer Node 集成；适用处启用 sandbox。
- preload 仅暴露白名单、类型化、参数校验过的 IPC；校验 sender。
- 禁止：renderer 直接 spawn、任意读盘、拿到设备 token/主密钥、开放无认证本地 HTTP 控制口。
- UI 崩溃不得导致无人值守 Agent 权限模型被绕过；窗口关闭与停止 Agent 的语义须分离且明确。

## 7. 签名、离线与停止证明

- 离线包须验签；信任根与撤销状态按规格处理（已知撤销硬拒绝；未知不得当 CURRENT）。
- 签名证明包内容来源与完整性，不证明本地结果未被篡改——导入与门禁不得夸大信任。
- 进程停止回执必须带正确 `processStopScope`；禁止把 Mac 受控停止写成全后代排空。不确定即隔离，不释放容量。

## 8. 供应链与依赖

- 精确钉死版本；CI/发行使用冻结锁文件安装。
- 新增依赖前评估漏洞、许可、维护状态；高危/严重未修复 CVE 不得引入。
- 禁止随意放宽 `minimumReleaseAge`、禁用完整性校验或关闭 peer/engine 严格模式，除非有书面批准与 ADR。
- 发行物须能提供 SBOM / NOTICE / 校验和所需信息（流程见发行文档）。

## 9. 安全相关变更的审查要求

- 触及认证、授权、加密、IPC、凭证、签名、停止证明的 PR，必须有负例测试与失败关闭说明。
- 不得以「仅内部环境」为由削弱校验。
- 发现疑似密钥泄漏：立即轮换，勿在聊天中继续传播完整密钥；从 Git 历史清除须走协调者流程。

## 10. 检查清单

- [ ] Workspace / 角色校验覆盖所有新入口
- [ ] 无密钥进仓、进日志、进前端产物、进离线包
- [ ] Electron IPC 仍为白名单且参数校验完整
- [ ] 失败路径 fail closed；停止/签名不确定不放行
- [ ] 依赖与许可已按规范评估

## 11. OWASP Top 10 与本仓库控制

当前 Web 应用风险基线是 OWASP Top 10:2025。类别名称保持官方英文，便于对照原文。2025 把 SSRF 与 CSRF 归入 A01，把 XSS 归入 A05，把脆弱组件扩进 A03。下面仍按本仓库要守住的控制分开写，避免被归类方式盖住。

- A01:2025 Broken Access Control
- A02:2025 Security Misconfiguration
- A03:2025 Software Supply Chain Failures
- A04:2025 Cryptographic Failures
- A05:2025 Injection
- A06:2025 Insecure Design
- A07:2025 Authentication Failures
- A08:2025 Software or Data Integrity Failures
- A09:2025 Security Logging and Alerting Failures
- A10:2025 Mishandling of Exceptional Conditions

### 11.1 注入

对应 A05。业务查询使用 SQLAlchemy 表达式和绑定参数。禁止把请求字段、排序、过滤或标识拼进 SQL 字符串，包括 `text()`。迁移里的固定语句不得改成拼接外部输入。

禁止 `eval` 或把不可信文本当代码执行。模型上下文按现有网关处理：只是数据，不是指令；模型输出不得自动发布，也不得借此索取凭证。

### 11.2 认证

对应 A07，并服从第 2 节。口令使用现有 Argon2 `PasswordHasher`，禁止自研哈希或明文口令。浏览器会话使用 HttpOnly、`SameSite=Strict` 的 `veriq_session` Cookie；生产环境设置 `Secure`。服务端只保存该令牌的 SHA-256 摘要，不保存可重放的原文。

员工会话、服务令牌和设备令牌继续分开。禁用、撤销、过期必须让下一次请求失败。知道 `planId` 或其他资源 ID 不是认证。

### 11.3 访问控制

对应 A01 的对象级与功能级失效，并服从第 3 节。Workspace 是边界。嵌套引用、下载、事件、导入、领取和凭证解析都要核对当前身份的 `workspace_id` 与成员状态。OpenAPI 里写了路径不等于已经授权。系统管理员不是隐式空间成员。跨空间引用失败必须关闭，负例测试要能看到拒绝。

### 11.4 XSS

对应 A05 中的跨站脚本。管理台用 React 渲染文本。禁止把不可信字符串交给 `innerHTML`、`dangerouslySetInnerHTML` 或任何等价的 HTML 解析。报告、资源正文和 bundle 下载响应保持现有 `Content-Security-Policy`：`sandbox`；报告与资源正文还包括 `default-src 'none'`。不要为了让预览执行脚本而放宽这些头。API 响应保持 `X-Content-Type-Options: nosniff`。

### 11.5 CSRF

2025 将 CSRF 记在 A01。浏览器态写请求必须同时满足两道现有门禁：`Origin` 等于配置的 `public_url`，以及 `X-CSRF-Token` 通过 Tornado 的 CSRF 校验。会话 Cookie 保持 `SameSite=Strict`。

设备令牌或服务令牌入口若按现有处理器不走浏览器 CSRF，必须改用对应令牌鉴权，不得把 `veriq_session` 当作替代。示例导入客户端的写请求继续携带当前 CSRF，并且不得跟随重定向把员工 Cookie 送到另一个目标。

### 11.6 SSRF

2025 将 SSRF 记在 A01。调用方能影响目标的出站请求必须走已批准的主机白名单，失败即拒绝。AI 供应商地址继续经过 `allowed_endpoint`：只接受算子白名单中的地址；拒绝 URL 内嵌凭证、查询串、片段、反斜杠、`..` 和空白；生产只用 `https`；明文 `http` 仅限开发环境的本机 loopback。供应商 HTTP 客户端保持 `follow_redirects=False`，不因重试或重定向改打别的主机，响应体保持现有上限。

示例导入客户端只访问配置的平台 origin 下 `/api/v1/` 路径，拒绝重定向；`http` 只允许本机 loopback。不要增加「用户给一个 URL，服务端去抓」的入口。

### 11.7 安全配置错误

对应 A02。生产会话 Cookie 必须 `Secure`。不得在生产关掉 `Secure`、`SameSite` 或 CSRF。控制面 JSON 响应保持 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff` 和 `Referrer-Policy: no-referrer`。

Electron 窗口保持 `contextIsolation`，关闭 renderer 的 Node 集成，适用处启用 sandbox。发行构建不得为了调试打开 renderer Node 或无认证本地 HTTP 控制口。控制服务运行时不嵌入 Node 或 Chrome。已启用的 SMTP TLS 或 STARTTLS 使用平台默认证书校验，不得换成不验证证书的上下文。不得以「仅内部环境」放宽上述校验。

### 11.8 脆弱与过时组件

这是 A03 中本仓库已经约束的那一部分，不把 A03 缩小成一次 CVE 扫描。依赖精确钉死版本，CI 和发行使用冻结锁文件。新增依赖前评估漏洞、许可和维护状态；高危或严重且未修复的 CVE 不得引入。放宽 `minimumReleaseAge`、关掉完整性校验或 peer/engine 严格模式，仍须书面批准和 ADR。签名、SBOM、NOTICE 与校验和继续服从第 8 节。

### 11.9 日志

对应 A09 的日志要求，并服从第 4 节。日志消息使用英文。HTTP 错误日志只记录 `requestId` 与异常类型，不记录请求正文、`Authorization`、Cookie、连接串密码、设备 token 或模型密钥。凭证配置接口不得回显原文。

认证失败、授权失败、CSRF 或 Origin 拒绝、签名失败和越权引用必须留下不含秘密的英文结构化日志。本文件不另建告警产品；这些事件不得只存在于被丢弃的调试输出里。

### 11.10 其余 Top 10 类别

- A04 加密失败：口令用 Argon2，会话与安装类令牌按现有 `digest` 只存 SHA-256 摘要。本地凭据用系统保险库或已批准的加密信封。禁止自研加密和明文兜底。
- A06 不安全设计：默认威胁模型见第 1 节。身份按员工、服务令牌、设备令牌分开；Workspace 是授权边界；模型输出不得自动发布。
- A08 软件或数据完整性失败：离线包验签失败必须拒绝。签名不证明本机结果未被改过。生成的 TypeScript 是不可变产物，不得当成可编辑源再写回信任边界。
- A10 异常条件处理失当：失败必须关闭。签名状态未知不得当成 CURRENT。Mac 停止范围不确定就隔离，不释放容量。超限正文直接拒绝，不截断后继续处理。错误响应使用稳定的 code 和 message，不返回堆栈。禁止用空的异常吞掉认证、授权或验签失败。
