# T03 — Workspace, membership, authorization and invitations

Base: `7ba9d543ef736773592df188e0c94e5d8b58e00d`. T01/T02 interfaces were reused, not reimplemented. Owned implementation/source/docs/tests commit: `ef0fb6d4e5969ad95d13ba0af536ac64f4f6722d` (`feat: complete t03 Workspace membership and authorization`). This report is a separate owned documentation commit. Full F01–F14 and Electron scope, AGPL-3.0, Tornado6.6.1, Router7.18.5 and existing dependency locks are preserved. No subagents, pushes, external email or unrelated compiler/runtime work.

## Owned files

- Server: `db.py`, `service.py`, `app.py`, `handlers/admin.py`, new `handlers/workspace.py`, `auth/{__init__,authorization}.py`, `services/{__init__,workspace}.py`, `migrations/versions/0002_workspaces.py` under `apps/srv/src/veriq_server`.
- Tests: new `apps/srv/tests/auth/test_workspace.py`; exact new table allowlists in `conftest.py` and `browser_server.py`; the existing production-database-shape test now expects revision0002 instead of0001. No existing assertion was weakened. Existing auth browser test is unchanged.
- Web: `apps/web/src/{api.ts,main.tsx}`, new `features/workspaces/{WorkspaceContext,WorkspacePage}.tsx`, new `apps/web/tests/workspaces.spec.ts`.
- Contracts/docs: canonical `packages/contracts/openapi/platform.yaml`, regenerated `packages/contracts/src/api.generated.ts`, appended T03 boundary section in `docs/contracts.md`, this report. No new production dependency or lockfile change.

## Definitive interfaces and migration

`veriq_server.auth.authorization` exports:

```python
WorkspaceScope(workspace_id: str)  # frozen dataclass
Actor(user_id: str, workspace_id: str, role: str, active: bool = True)  # frozen
Permission  # StrEnum
Authorization.require(actor: Actor, scope: WorkspaceScope, permission: Permission) -> None
Authorization.require_reference(scope: WorkspaceScope, referenced_workspace_id: str) -> None
```

`require` rejects inactive actors, mismatched scopes and missing role permission with403 `WORKSPACE_FORBIDDEN`. Actor construction must use current authenticated database membership, not caller-supplied roles. `require_reference` rejects a foreign Workspace with422 `INVALID_REFERENCE`; it is a reusable reference check, not a pretend resource/version repository.

`services.workspace` exports `WorkspaceRepository(session: AsyncSession, scope: WorkspaceScope)` with async `get()`, `member(user_id)`, `invite(invitation_id)`, `authorize(user, permission=VIEW, *, write=False)`, `protect_owner(user_id)`; `protect_user_disable(session, user_id)`; and `workspace_dto`, `member_dto`, `invitation_dto`. All actual scoped repository lookups include their scope. Discovery lists intentionally span only the current user's ACTIVE memberships. `handlers.workspace.WorkspaceAPI` implements the HTTP boundary. `service.audit` adds backward-compatible keyword-only `workspace_id: str | None = None`.

`db.py` adds `Workspace`, `WorkspaceMember`, `WorkspaceInvite`, and optional `AuditLog.workspace_id`. Migration `0002_workspaces` follows `0001_accounts`, creates exactly `veriq_workspaces`, `veriq_workspace_members`, `veriq_workspace_invites`, and adds an indexed nullable Workspace FK to the existing audit table. No duplicate user/session/audit table or production `create_all` fallback. InnoDB/utf8mb4, declared Unicode collation, ascii_bin IDs/keys/digests, UTC DATETIME(6), foreign keys, unique Workspace keys, composite membership primary key and unique invitation digest are retained. Workspace key length160 matches canonical Key. Downgrade removes the audit FK/index/column before the three new tables. A real downgrade to0001 then upgrade to head preserves existing account/session data and permits Workspace creation afterward.

## Routes, requests and permissions

All routes below use existing Web Cookie/CSRF/Origin/body/error constraints. Successful JSON is `{data,requestId}`; errors remain flat `{code,message,details,requestId}`. Unsupported methods return405 before incompatible handler argument dispatch.

| Method | `/api/v1` route | Behavior/permission |
|---|---|---|
| GET | `/workspaces` | Current user's active memberships; optional `archived` boolean filter |
| POST | `/workspaces` | Any enabled authenticated account creates Workspace and its OWNER membership atomically |
| GET | `/workspaces/{workspaceId}` | Current active member, including archived details |
| PATCH | `/workspaces/{workspaceId}` | OWNER/ADMIN rename a live Workspace |
| DELETE | `/workspaces/{workspaceId}` | OWNER archives; returns EmptyEnvelope |
| GET | `.../members` | Current active member; bounded member/user display data |
| PUT | `.../members/{userId}` | OWNER/ADMIN updates existing membership role/status; OWNER changes require OWNER |
| DELETE | `.../members/{userId}` | OWNER/ADMIN removes member; OWNER removal requires OWNER |
| GET | `.../invitations` | OWNER/ADMIN list metadata/status; never return token URLs |
| POST | `.../invitations` | OWNER/ADMIN creates ADMIN/EDITOR/EXECUTOR/VIEWER invitation; optional `sendEmail` |
| DELETE | `.../invitations/{invitationId}` | OWNER/ADMIN revokes scoped invitation |
| POST | `/auth/invitations/accept` | CSRF-protected token acceptance with the identity rules below |

Permission policy: VIEW all five roles; EDIT OWNER/ADMIN/EDITOR; EXECUTE/DOWNLOAD additionally EXECUTOR; PUBLISH/MANAGE_ENVIRONMENT/MANAGE_MEMBERS/MANAGE_WORKSPACE OWNER/ADMIN; OWNERSHIP OWNER only. PRIVATE_DISPATCH is deliberately granted to no Workspace role: future device services require ownership or explicit grants. Global system administration never confers Workspace membership. ADMIN cannot promote themselves or anyone else to OWNER or modify/remove OWNER membership. Promotion to OWNER requires an existing enabled ACTIVE member and an explicit OWNER action. Existing OWNER memberships may become inactive only with another enabled ACTIVE OWNER remaining.

All three list families use actual SQL limit+1 queries, default25/max100, stable key/ID or email/ID ordering, and the existing signed24-hour Page cursors bound to caller/list/Workspace/filter. Limits and foreign/malformed cursors fail canonically. Tests traverse105 invitations and106 members without duplicates and verify the100-row cap; Workspace paging and filter-bound cursor rejection are also exercised. Lists are a live view, not a frozen snapshot.

Archive is one-way in this API and retains key/membership. Details/members remain readable by authorized members; all further scoped mutations and invitation acceptance reject with409 `WORKSPACE_ARCHIVED`. Archived Workspaces are exempt from the live-owner invariant. Duplicate keys, including archived keys, return409 `WORKSPACE_KEY_EXISTS`.

## Owner invariant and lock order

Every Workspace/member/invitation mutation acquires existing `lock_installation` **before identity and scoped reads** and holds it through commit. Existing global user-disable already holds that same lock and now calls `protect_user_disable` before mutation. Thus creation/role/status/removal/acceptance/disable use one serialization point and current authorization. The current services need no second explicit row lock. Future explicit locks must follow Workspace ID then user/member/invite ID order, never acquire the installation guard after another mutation row lock.

For each live Workspace, the successor query counts only ACTIVE OWNER memberships joined to enabled users and excludes the affected user. Removing/demoting/inactivating the final enabled owner, or disabling that account globally, returns409 `LAST_OWNER`; no automatic promotion. Real concurrent removal/demotion/disable and two-owner simultaneous account disables preserve the invariant. Separate tests prove that inactive memberships and globally disabled OWNER users do not count. This shared global guard intentionally serializes account/Workspace writes; finer-grained concurrency can be addressed with an invariant-preserving design later.

## Invitation identity and delivery

Invitations have random43-character secrets stored only as SHA-256 digests, seven-day expiry, single-use acceptance and revocation. Role comes from the authorized persisted invitation. Existing membership is a conflict, preventing a second token from changing an existing OWNER/role.

- Existing account: token-only acceptance requires that enabled account's authenticated session, matched by normalized invitation email/current user ID. Other/anonymous identities fail403/401. Providing password/displayName is rejected even for the correct account; no credential replacement, global privilege change or global session reset occurs. The attack test invites an existing system administrator from another Workspace and proves the inviter cannot replace its password or display name.
- New account: password/displayName are required; create a normal Argon2id user and membership, consume the invitation transactionally, return UserDTO, and leave the current session alone. Concurrent acceptance produces exactly one success. Account creation shares the guard with existing admin creation, avoiding a check/create takeover window.
- Disabled users, mismatched identities, expired/revoked/replayed tokens and archived targets are rejected. Invitation list responses expose only email/role/expiry/status metadata.
- Default creation returns a copyable `/invitations/accept#token=...` URL. Optional SMTP reuses actual existing `SMTPDelivery` and returns delivery NOT_REQUESTED/SENT/FAILED. If delivery fails, the returned copyable invitation remains usable and logs contain neither recipient/token nor SMTP exception contents. No configured adapter plus sendEmail returns409 `SMTP_UNAVAILABLE`.

Real local SMTP tests verify message→fragment token→successful acceptance and failed delivery→copy-link acceptance. No external mail or production TLS SMTP was tested.

## Actual Web UI and lifecycle

`WorkspacePage` uses real typed API calls and React Query. `/workspaces` offers paged selection/create/details/rename/archive, member display/role/status/removal and invitation create/copy/revoke with loading/error/empty/permission states and test IDs. No fake dashboard, metrics, resources or second Project concept. `AcceptInvitation` at `/invitations/accept` supports new ordinary-account creation and existing-account inline login/acceptance.

Tokens are read from fragments, removed immediately from history, and kept only in component memory. Existing-account login remains inline, retaining invitation intent without placing it in a login URL/query or resetting identity. Full refresh after scrubbing needs reopening the original invitation link. Token fields are masked in evidence screenshots.

`WorkspaceContext` exports `WorkspaceProvider` and `useWorkspace()` exposing selected/select, scope-lifetime AbortSignal and idempotent subscription-disposer registration. Query keys include identity and Workspace. Selection changes abort scoped queries/mutations, remove old scoped cache, close registered subscriptions and remount the detail view. The provider is keyed by authenticated identity on the Workspace route; route exit, logout/session expiry and identity changes cancel/clear its client and subscriptions. Selection is in memory for that route lifetime. No SSE stream exists yet; downstream subscriptions must register their disposer and consume the scope signal.

The real browser test holds an actual old-Workspace HTTP response while switching, observes Chromium `ERR_ABORTED`, and verifies no old member appears in the next Workspace. It also verifies new-account acceptance, existing-account inline login after history scrubbing, membership controls, role-limited UI, archive read-only UI and logout/login as another identity without the previous user's Workspace list. Existing auth/reset/navigation browser regressions remain unchanged and pass.

## RED/GREEN and observed failures

Evidence: `.superpowers/sdd/veriq-1/evidence/t03/` (ignored; contains no credentials). Test DSN is read only from the restricted ignored test-env file, never printed. Every database test asserts dedicated `veriq_test` and exact owned-table allowlists before reset; those allowlists add only the three new tables. Python and browser database suites ran sequentially.

- `red.txt`: initial seven failures on missing actual routes/policy/models; `green-initial.txt`:7 passed.
- `red-key.txt`: real500/DataError when canonical160-character key hit an80-character column; model/migration aligned to160. `red-key-conflict.txt`: duplicate key returned generic Account conflict; explicit guarded Workspace conflict resolved it.
- `red-methods.txt`: unsupported PUT dispatched incompatible Tornado signature and produced500; action/method guard resolves to405.
- `red-inactive-owner.txt`: overrestrictive rejection of an existing non-last OWNER's inactive membership; permitting it with enabled-successor check preserves the invariant.
- `red-audit.txt`: scoped audit test failed on absent Workspace field; extending the existing audit model/migration/helper and all scoped mutation audit calls resolved it.
- `red-browser.txt`: missing Workspaces link. `browser-initial.txt`: test setup403 caused by racing browser App setup/cookie initialization with an API setup request; initialize through API before navigating the browser, leaving all CSRF checks intact. `browser-cancellation.txt`: application correctly aborted the route, but the test attempted to fulfil it afterward; dispose the held actual response after the observed abort. Neither failure was hidden with retry, sleep, forced action or weaker assertion.
- `green-workspace.txt`:18 focused tests passed before final migration-preservation/disabled-user additions. Final covering run includes20 Workspace tests plus all149 existing Python tests.
- Formatter initially could not create default read-only HOME cache; task-local XDG directories resolved it. Formatter was pinned ephemeral Prettier3.6.2; no dependency graph change.

## Final verification

Exact commands run from repository root; all completed successfully:

```sh
UV_CACHE_DIR=/tmp/veriq-t03-uv uv run --project apps/srv pytest -c apps/srv/pyproject.toml apps/srv/tests --cov=veriq_server --cov-config=apps/srv/pyproject.toml --cov-report=term-missing -q
pnpm test
pnpm check
pnpm --filter @veriq/web check
pnpm --filter @veriq/web build
UV_CACHE_DIR=/tmp/veriq-t03-uv uv run --project apps/srv ruff check --config apps/srv/pyproject.toml apps/srv/src apps/srv/tests
UV_CACHE_DIR=/tmp/veriq-t03-uv uv run --project apps/srv ruff format --check --config apps/srv/pyproject.toml apps/srv/src apps/srv/tests
UV_CACHE_DIR=/tmp/veriq-t03-uv uv run --project apps/srv mypy --config-file apps/srv/pyproject.toml apps/srv/src
env -u NO_COLOR -u FORCE_COLOR VERIQ_TEST_CHROMIUM=/usr/bin/chromium XDG_CONFIG_HOME=/tmp/veriq-t03-xdg-config XDG_CACHE_HOME=/tmp/veriq-t03-xdg-cache pnpm --filter @veriq/web test:e2e
UV_CACHE_DIR=/tmp/veriq-t03-uv uv build --project apps/srv --wheel --out-dir .superpowers/sdd/veriq-1/evidence/t03/wheel
git diff --check
```

- Python: **169 passed/45.06s,95% measured line coverage** (`final-python.txt`), real MySQL8.4.13/HTTP/transactions/CLI/local SMTP; new HTTP Workspace handler95%, policy100%.
- Node contracts: **148 passed/4 files** (`final-contracts.txt`). Canonical regeneration freshness, strict Web typing and production Web build passed (`final-web-build.txt`).
- Ruff check/format and strict mypy passed:34 formatted files,25 checked source files (`final-static.txt`).
- Actual Chromium browser: **2 passed/13.2s** (`final-browser.txt`), original auth test4.8s + Workspace flow4.6s. Masked active screenshot `workspace-active.png` and token-free archived screenshot `workspace.png` were visually inspected.
- Wheel build and archive inventory passed (`final-wheel.txt`, `wheel-inventory.txt`): Workspace policy/service/handler, revision0002 and updated canonical OpenAPI included. This is not a production static deployment claim.

## Limits and handoff

No final check remains failed. T03 delivers current Workspace/member/invitation persistence, authorization, real UI and reusable scope/reference policies. Actual resources/versions/batch/evidence/SSE/download/import/device repositories and endpoints remain their downstream tasks and must adopt the documented current-membership checks; no claim that these unimplemented operations are already enforced. Device/private dispatch remains deny-by-default at the Workspace policy layer. Selection persists only within the Workspace route. Invitation email is synchronous after transaction commit with explicit delivery outcome/copy fallback, not a durable job queue. Production remote TLS SMTP, reverse proxy/static-wheel deployment, Windows/Electron and full F01–F14 release acceptance were not exercised. No scope reduction is implied.
