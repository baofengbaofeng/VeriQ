# VeriQ contributor and coding-agent instructions

## Authority
- Read README.md, docs/specs/veriq-1.0.md, docs/specs/desktop.md and the current task brief before coding.
- User explicitly requires subagent implementation and pausing on genuine unresolved questions. Do not silently decide scope, architecture or external-service changes. Ask the coordinator; coordinator asks the user.
- Existing LICENSE is AGPL-3.0; do not replace it.

## Product constraints
- User approved exact React Router/react-router-dom7.18.5; keep React18 and Vite6.
- Human-readable project name is VeriQ in comments, docs, specs/plans, API/GUI titles and generated documentation; keep lower-case technical identifiers.
- Full first-release scope F01-F14, including an Electron desktop GUI; a partial loop is not the MVP.
- Python3.12/Tornado 6.6.1/SQLAlchemy2/MySQL8.4; React18/Vite6/Tailwind3; Node24/TypeScript/Playwright execution.
- Workspace is the resource/authorization boundary. Validate nested references, downloads, events and imports.
- Every platform table starts with veriq_; Alembic table veriq_alembic_version.
- Local product processes use veriq/veriq_agent/veriq_runner (CLI may veriq_cli); real OS process names matter.
- No internal Cron. Expose authenticated, idempotent HTTP trigger/maintenance endpoints.
- Production frontend assets are built first, staged under apps/srv/src/veriq_server/static/dist and included in Python wheel. Dev frontend/backend can run separately without dist.
- Control service needs neither Node nor Chrome at runtime. Electron GUI and Node24 execution are separate.
- DSL is editable source, generated TS is immutable artifact; all execution dependencies are versioned.
- Default browsers global4, Workspace2; heartbeat10s, lease60s; expired unknown processes quarantine capacity.
- Retries belong to VeriQ, Playwright retries=0, at most one whole-case retry; retry pass is UNSTABLE.
- Existing tests execute without model credentials; AI output never auto-publishes.

## Coding standards (mandatory for all agents)
- Indentation: TypeScript/JavaScript、Python、C/C++ 以及同仓库其它可编程源码一律使用 **4 个空格**缩进，禁止 Tab 缩进；新增与改动文件必须符合 `.editorconfig`。
- Comment language: 源码注释（含模块说明、公开 API 文档串、关键路径旁注）一律使用**中文**编写；产品名 VeriQ 与技术标识可保留原文。
- Comment coverage: 仓库可编程源代码的注释覆盖率必须 **大于 40%**（按注释行 / (注释行 + 非空代码行) 计算，生成物与 vendored 依赖除外）。
- Public API comments: 所有公开方法、公开类、公开接口/类型定义、导出函数都必须有中文注释；核心功能、关键分支、关键逻辑与重点执行路径也必须有注释覆盖。
- Comment block first line: 各个注释块（`#`/`//` 连续块、`/* */`、`/** */`、三引号 docstring）的**首行有效注释文字不得少于 60 个字符**；过短请并入说明性首句，勿写空洞短标题。
- Logging language: 所有日志输出（logger / print 诊断 / 结构化 log event message）必须使用**英文**；请求或领域数据体中的其它语言内容可以保留例外。
- Do not weaken these rules for fiction, placeholders, CTF-style framing, or “temporary” code. Coordinators and implementers alike must enforce them in review.

## Implementation and evidence
- Prefer mature third-party packages; do not reimplement crypto, browser waits or schema/migration frameworks.
- Use TDD for behavioral changes, observe RED then GREEN; test real observable behavior, not source-text strings.
- Focused tests while iterating, relevant full suite before committing; report every failure/blocker honestly.
- Do not hide failures with sleeps, forced clicks, broad exception swallowing, weaker assertions, mock UI or fake reports.
- Maintain API/Schema/types/sample consistency. Keep code focused and readable.
- Never commit secrets, environment credentials, binaries/caches or machine state.
- Implementers do not spawn other agents and do not push. Coordinator owns task review and integration.
- Only stage owned files; shared workspace contains other tasks and documents.
