# Veriq contributor and coding-agent instructions

## Authority
- Read README.md, docs/specs/veriq-1.0.md, docs/specs/desktop.md and the current task brief before coding.
- User explicitly requires subagent implementation and pausing on genuine unresolved questions. Do not silently decide scope, architecture or external-service changes. Ask the coordinator; coordinator asks the user.
- Existing LICENSE is AGPL-3.0; do not replace it.

## Product constraints
- Full first-release scope F01-F14, including an Electron desktop GUI; a partial loop is not the MVP.
- Python3.12/Tornado6.4/SQLAlchemy2/MySQL8.4; React18/Vite6/Tailwind3; Node24/TypeScript/Playwright execution.
- Workspace is the resource/authorization boundary. Validate nested references, downloads, events and imports.
- Every platform table starts with veriq_; Alembic table veriq_alembic_version.
- Local product processes use veriq/veriq_agent/veriq_runner (CLI may veriq_cli); real OS process names matter.
- No internal Cron. Expose authenticated, idempotent HTTP trigger/maintenance endpoints.
- Production frontend assets are built first, staged under apps/srv/src/veriq_server/static/dist and included in Python wheel. Dev frontend/backend can run separately without dist.
- Control service needs neither Node nor Chrome at runtime. Electron GUI and Node24 execution are separate.
- DSL is editable source, generated TS is immutable artifact; all execution dependencies are versioned.
- Default browsers global4, Workspace2; heartbeat10s, lease60s; expired unknown processes quarantine capacity.
- Retries belong to Veriq, Playwright retries=0, at most one whole-case retry; retry pass is UNSTABLE.
- Existing tests execute without model credentials; AI output never auto-publishes.

## Implementation and evidence
- Prefer mature third-party packages; do not reimplement crypto, browser waits or schema/migration frameworks.
- Use TDD for behavioral changes, observe RED then GREEN; test real observable behavior, not source-text strings.
- Focused tests while iterating, relevant full suite before committing; report every failure/blocker honestly.
- Do not hide failures with sleeps, forced clicks, broad exception swallowing, weaker assertions, mock UI or fake reports.
- Maintain API/Schema/types/sample consistency. Keep code focused and readable.
- Never commit secrets, environment credentials, binaries/caches or machine state.
- Implementers do not spawn other agents and do not push. Coordinator owns task review and integration.
- Only stage owned files; shared workspace contains other tasks and documents.
