# T02 — real accounts, installation and authenticated UI

Task base: `94a0da78e37841b8049c097e3e7de2793dd9a1a0`. This report describes T02 only; it does not claim the full VeriQ product or remaining F01–F14 modules are complete. No pushes, subagents, LICENSE changes or external email delivery were performed.

## Owned files

- Server: `apps/srv/pyproject.toml`; `apps/srv/src/veriq_server/{settings,db,service,validation,migrate,delivery,cli,app}.py`.
- Focused HTTP modules: `apps/srv/src/veriq_server/handlers/{__init__,base,auth,account,admin,health}.py`.
- Alembic: `apps/srv/src/veriq_server/migrations/env.py`, `migrations/versions/0001_accounts.py`.
- Python evidence tests: `apps/srv/tests/auth/{conftest,test_auth,test_settings_cli,test_delivery,browser_server}.py`.
- Web: `apps/web/{package.json,index.html,tsconfig.json,vite.config.ts,playwright.config.ts}`, `src/{api.ts,auth-context.ts,main.tsx,ui.tsx,style.css}`, `src/pages/{auth,account,users}.tsx`, `tests/auth.spec.ts`.
- Canonical API: `packages/contracts/openapi/platform.yaml`, regenerated `packages/contracts/src/api.generated.ts`; `pnpm-lock.yaml` only adds the already-pinned Playwright1.65.0 dependency to Web test tooling.
- Public docs: `docs/development.md`, appended T02 section in `docs/contracts.md`; this task report.

## Interfaces and persistence

`Settings` validates required secret configuration, HTTPS production origin and optional SMTP configuration; `load_settings(path, overrides)` implements explicit CLI > VERIQ_ environment > JSON file > nonsensitive defaults. Config repr uses SecretStr for database/key/SMTP credentials. `Database(settings)` exports async engine and `sessions`, configured MySQL utf8mb4, UTC and READ COMMITTED with SQL parameter redaction. `make_app(settings, db, delivery=None)` composes focused Tornado handlers without migrating or creating schema.

Downstream handlers subclass `handlers.base.API` and call `await self.identity(session, admin=False)` for `(User, UserSession)`. It checks the session token digest, expiry and current disabled status; `admin=True` also checks global system administrator capability. `service` exposes bootstrap and account helpers (`initialize`, `lock_installation`, `invalidate`, `issue_reset`, `hash_password`, `verify`, DTO helpers). `delivery.Delivery` is an async `send(recipient, subject, body)` protocol; `SMTPDelivery` implements verified TLS/STARTTLS and `ResetDispatcher` tracks background public reset work and drains on normal shutdown. T03 invitations can reuse the delivery seam; Workspace membership remains T03.

Migration `0001_accounts` creates only InnoDB/utf8mb4 tables: `veriq_installation`, `veriq_users`, `veriq_user_sessions`, `veriq_user_tokens`, `veriq_audit_logs`, with Alembic version in `veriq_alembic_version`. UUID/digest fields use ascii_bin; UTC timestamps use DATETIME(6); user email uses declared case-insensitive, accent-sensitive Unicode collation. The migration inserts singleton id1. Bootstrap/admin invariant mutations lock this row transactionally, so initialization never relies on empty-user counts. Login shares the guard with disable/reset/password changes to prevent stale credentials creating a new session after a concurrent revocation.

Passwords use actual Argon2id via argon2-cffi; session/reset/bootstrap secrets are random and only digests enter the database. Session cookies are HttpOnly, SameSite Strict, and Secure in production. Mutations require exact configured Origin plus Tornado's masked XSRF validation through canonical `X-CSRF-Token`. Request bodies are limited to 64KiB by the app (transport hard cap 1MiB), strict OpenAPI body schemas reject malformed/unknown fields, and API errors retain `{code,message,details,requestId}`. Logs omit request bodies, cookies, URL queries and exception messages.

## Implemented endpoints and pages

All routes use `/api/v1`; successful JSON remains `{data,requestId}`. Existing UserDTO/SessionDTO shapes are preserved; strict AdminUserDTO adds `systemAdmin` separately.

| Method | Route | Behavior |
| --- | --- | --- |
| GET/POST | `/setup` | Installation state/CSRF; transactionally consume operator secret and create first admin |
| POST | `/auth/login`, `/auth/logout` | Generic login failure, fresh opaque session, logout revocation |
| GET | `/auth/session` | Canonical SessionDTO |
| POST | `/auth/password-reset`, `/auth/password-reset/confirm` | Generic public acknowledgment; optional real SMTP; single-use expiring token and session invalidation |
| GET | `/account`, `/account/sessions` | Actual account/global capability and active sessions |
| POST | `/account/password`, `/account/sessions/revoke` | Verify current password/change and revoke, or revoke all own sessions |
| GET/POST | `/admin/users` | System-admin list/create |
| PATCH | `/admin/users/{userId}` | Disable/enable and grant/remove admin; protect last enabled admin |
| POST | `/admin/users/{userId}/sessions/revoke` | Revoke target sessions |
| POST | `/admin/users/{userId}/reset-link` | Authorized short-lived copyable link; token only in authorized response |
| GET | `/health/live`, `/health/ready` | HTTP liveness; database readiness |

React Router pages `/setup`, `/login`, `/reset`, `/reset/confirm`, `/account`, `/admin/users` call real typed API clients. They include validation, loading/error/empty states, retry paths, data-testid hooks and permission controls. Reset tokens travel in fragments, are removed from browser history on entry, and are not embedded in frontend configuration or server URL logs. Account/password/session and admin create/enable/disable/revoke/reset/role controls are usable; no fictional workspace dashboard exists.

## Operator/developer commands

See `docs/development.md` for complete safe instructions. Use an operator-owned private config directory and the supplied MySQL 8.4 database; do not put credentials in repository files or shell logs. `init` prompts privately for the async MySQL DSN, exclusively creates mode0600 config/key/installation-secret files, runs the explicit migration and provisions the secret digest. Interrupted init can resume with the same files without regenerating keys. `create-admin` prompts twice and consumes/deletes the local installation secret. `serve` never migrates.

```sh
uv run --project apps/srv veriq_server --config /private/veriq/veriq.json --public-url http://127.0.0.1:5173 --environment development init
uv run --project apps/srv veriq_server --config /private/veriq/veriq.json migrate
uv run --project apps/srv veriq_server --config /private/veriq/veriq.json create-admin --email admin@example.com --display-name Administrator
uv run --project apps/srv veriq_server --config /private/veriq/veriq.json doctor
uv run --project apps/srv veriq_server --config /private/veriq/veriq.json serve
pnpm --filter @veriq/web dev
```

The `/private/veriq` path is a placeholder, not a repository path. Vite on5173 proxies API8888; use the Vite origin as public_url. API development startup does not require frontend dist. Final production static staging/packaging remains T17/T18.

## Verification and durable evidence

Ignored evidence is `.superpowers/cache/t02/evidence/`; browser screenshot is `.superpowers/cache/t02/admin-users.png`, with reset URL masked. Test credentials remain only in the restricted operator file and are not repeated here. Tests assert database name `veriq_test` and a complete allowlist of owned tables before resetting anything. Python/browser tests run sequentially against that dedicated schema; no SQLite or fake server substitutes are used.

Observed RED/GREEN:

- Initial acceptance collection failed with missing `veriq_server.app` before implementation. First HTTP implementation then exposed the nonexistent EmptyObject schema; correction to canonical Empty produced GREEN. Original excerpts are in `red-observations.md`.
- Initial real browser run failed setup→login due to stale initialized state. Shared setup completion state fixed it; the full real-browser flow passed before later account navigation changes.
- Settings/CLI checks caught accepting production HTTP and an implicit CLI default incorrectly overriding a development config. Central Settings validation and correct precedence fixed them.
- `red-cli-resume.txt` records actual failing rerun of init on existing pre-admin config; preserving generated material and reusing the installation secret fixed it. `green-cli-smtp.txt`: 4 passed for CLI/settings/local SMTP focused checks.
- A later browser regression (generic reset success status missing) is preserved in `browser-reset-regression.txt`. Following systematic debugging, `browser-reset-diagnostics.txt` records only safe method/path/status/navigation/boolean UI state; its diagnostic run reached the real reset POST and received200. It exposed duplicate navigation owners in account sign-out and sign-in. Added observable exact-one-transition assertions before changing either: `red-navigation-count.txt` records two `/login` transitions; `red-signin-navigation-count.txt` records two `/account` transitions. Each small fix removes the caller's competing imperative navigation and keeps the existing route guard as the owner. `green-account-navigation.txt` proves the account fix; the final covering run includes both assertions and the unchanged reset flow. No retries, sleeps, forced clicks or weakened assertions were introduced.

Final commands/results:

- `UV_CACHE_DIR=/tmp/veriq-t02-uv uv run --project apps/srv pytest -c apps/srv/pyproject.toml apps/srv/tests --cov=veriq_server --cov-config=apps/srv/pyproject.toml --cov-report=term-missing -q`: **143 passed**, **93%** measured Python line coverage, including traced real CLI subprocesses (`final-python.txt`). Ten auth/settings/CLI/SMTP test functions include actual MySQL8.4.13 migrations, UTC/isolation/collation, concurrent setup, concurrent last-admin race, Argon2/nonplaintext storage, generic failures, canonical response-schema validation, CSRF/Origin/body failures, logout/expiry/password/reset/disable/revoke invalidation across separate browser clients, reset single-use/expiry, system-admin authorization, safe config and actual CLI lifecycle. Local TCP SMTP proves real delivery→reset/login and failed-delivery token revocation with safe logging; no external email was sent.
- `pnpm test`: **148 passed /4 files** (`final-contracts.txt`). All original contract checks are preserved.
- `pnpm check`, `pnpm --filter @veriq/web check`, `pnpm --filter @veriq/web build`: **passed** (`final-web-build.txt`), including generation freshness and strict Web unused-symbol checks.
- Explicit-config Ruff check/format and strict mypy: **passed**,18 source files checked (`final-python-static.txt`).
- `uv build --project apps/srv --wheel --out-dir .superpowers/cache/t02/wheel`: **passed** (`final-wheel.txt`). Inventory and import/validation smoke through the actual wheel, using the current Python dependency environment, confirms canonical schemas/OpenAPI, migration, CLI and SMTP adapter are included (`wheel-inventory-smoke.txt`). This is not a full production release acceptance claim.
- `env -u NO_COLOR -u FORCE_COLOR VERIQ_TEST_CHROMIUM=/usr/bin/chromium XDG_CONFIG_HOME=/tmp/veriq-t02-xdg-config XDG_CACHE_HOME=/tmp/veriq-t02-xdg-cache pnpm --filter @veriq/web test:e2e`: **1 passed /11.9s**, real local HTTP + MySQL + Chromium (`final-browser.txt`), no inherited color warnings. It covers setup secret error/success, generic login error/success, actual account/session display, admin create/last-admin boundary/promote/demote/disable/enable/revoke/reset-link, reset-confirm, user permission denial, password change, generic public reset, token reuse rejection, own-session revocation and missing-token state. Both redirect transition assertions pass. The masked admin screenshot was visually inspected.

## Limits and self-review

No Workspace membership/invite UI, execution modules, Electron GUI or production static packaging was added; those remain owned downstream tasks without reducing product scope. SMTP uses an in-process tracked delivery queue, not durable crash recovery; a process crash can lose pending delivery and users may request another link or contact an administrator. Actual remote TLS SMTP delivery was not exercised; TLS uses Python's verifying default SSL context and configuration rejects plaintext SMTP in production. Tests used a real local SMTP protocol listener only. Production TLS termination/reverse proxy, desktop/Windows and full release acceptance were not tested in T02.

Self-review covered transactional bootstrap/last-admin serialization, session issuance versus reset/disable, current-user authorization, token single-use/expiry, canonical shape consistency, secret-free logging/static assets and task-only changes. No committed credentials, binary artifacts, caches or local machine state are intended.

## FIX1 — I1 settings resolution and I2 bounded lists

Fix base: `678587d9009ee2acaeebd28c69a1fb85feb3b880`. This continuation preserves the original T02 implementation and evidence. No dependency graph, architecture, license, product scope, README, T01 or audit changes; no pushes, subagents or external emails.

Owned FIX1 files: `apps/srv/src/veriq_server/{cli,settings,pagination}.py`; `apps/srv/src/veriq_server/handlers/{account,admin}.py`; `apps/srv/tests/auth/{test_settings_cli,test_pagination}.py`; `apps/web/src/api.ts`, `apps/web/src/pages/{account,users}.tsx`, `apps/web/src/style.css`, `apps/web/tests/auth.spec.ts`; canonical `packages/contracts/openapi/platform.yaml` and regenerated `packages/contracts/src/api.generated.ts`; this report.

I1: `resolve_settings_values(path, overrides)` is the common CLI > VERIQ_ environment > file > defaults merge used by both `load_settings` and fresh/resumed `init`. Initialization prompts only for an absent database URL, generates only absent keys, validates all effective settings before writing or migrating, and persists effective initialization settings. Resumed writes use a private temporary file and atomic replacement, retaining existing master/signing key bytes even while an explicit environment key override supplies the effective runtime value. Host/port CLI overrides, environment session settings, explicit keys and SMTP validation now participate in initialization. Invalid environment configuration is rejected before config creation.

M2 recovery is covered precisely: the real CLI/MySQL lifecycle test deletes the installation-secret file after configuration exists but before administrator creation, reruns `init`, verifies configuration bytes are unchanged, and successfully creates the administrator. Secret creation/reprovisioning happens only while holding the installation singleton lock and after rejecting an already initialized installation. This covers the reviewed missing-secret interruption; it does not claim general filesystem failure injection. M1 coverage-threshold enforcement remains explicitly routed to T18 by the coordinator; FIX1 preserves existing subprocess/source/parallel coverage settings without weakening thresholds or excluding modules.

I2: both implemented GET lists accept `limit` (default25, range1–100) and opaque `cursor` (maximum4096 characters). `pagination.Page` uses Tornado's signed-value implementation, expires cursors after24 hours and binds them to authorized caller, list and filters. Handlers query at most limit+1 rows and return actual continuation cursors. Users use stable email/ID ordering and literal substring `q` (maximum254 characters), `disabled` and `systemAdmin` filters; own active sessions use stable createdAt/ID ordering and retain ownership/expiry conditions. Invalid limits, boolean filters, malformed or differently scoped cursors produce canonical errors. Pagination is a live view, not a frozen snapshot; restart paging to refresh filters or see newly inserted preceding rows. These parameters and semantics are canonical OpenAPI declarations, regenerated types feed Web query types, and actual pages expose page size, load-more controls and user filters with loading/error states.

Retained RED/GREEN evidence is `.superpowers/cache/t02/evidence/fix1/`:

- `red.txt`: 6 failed/3 passed before the fixes (four initialization cases and two unbounded-list cases). `green-settings.txt`: 7 passed; `green-pagination.txt`: 2 passed. Pagination tests seed105 users and106 active own sessions, traverse exact qualifying IDs without duplicates, cover tied creation times,100-row cap, filters/literal wildcard search, expiry/foreign exclusion, authorization and cursor context.
- `red-resume-persist.txt` records the resumed effective-configuration persistence regression. During this continuation, the first covering Python run reproduced that incomplete source state:148 passed/1 failed,93%, retained as `covering-python-red-resume-persist.txt`. Atomic persistence of validated non-key settings while retaining stored key bytes resolved it; `final-focused-settings.txt`: **7 passed/9.74s**.
- `red-browser.txt` records the absent paging control before UI changes. Despite its historical filename, `green-browser.txt` contains a failed later reset assertion, as does `browser-reset-recurrence.txt`; neither is claimed as GREEN. `reset-dom-diagnostics.txt` and `reset-outgoing-control-diagnostics.txt` preserve the investigation. The latter proves the test filled an email input still connected to the outgoing login form immediately after clicking Forgot password; the destination reset form then reported valueMissing and no reset HTTP request occurred. The fix awaits the expected destination heading before filling shared fields, with analogous readiness checks in the same workflow. Temporary console/network/elementHandle diagnostics were removed. The original final reset-success assertion and exact-one-navigation assertions remain; no sleep, retry, force action or assertion weakening was added.

Final covering checks ran sequentially against the dedicated allowlisted `veriq_test` MySQL schema, with credentials read only from the restricted test environment file:

- `UV_CACHE_DIR=/tmp/veriq-t02-uv uv run --project apps/srv pytest -c apps/srv/pyproject.toml apps/srv/tests --cov=veriq_server --cov-config=apps/srv/pyproject.toml --cov-report=term-missing -q`: **149 passed/31.48s,94% coverage** (`final-python.txt`). This includes the two real HTTP/MySQL pagination tests and CLI subprocess recovery/settings tests.
- `pnpm test`: **148 passed/4 files** (`final-contracts.txt`).
- `pnpm check`, `pnpm --filter @veriq/web check`, `pnpm --filter @veriq/web build`: **passed**, including generated contract freshness (`final-web-build.txt`).
- `UV_CACHE_DIR=/tmp/veriq-t02-uv uv run --project apps/srv ruff check --config apps/srv/pyproject.toml apps/srv/src apps/srv/tests`; same Ruff invocation with `format --check`; `UV_CACHE_DIR=/tmp/veriq-t02-uv uv run --project apps/srv mypy --config-file apps/srv/pyproject.toml apps/srv/src`: **passed**,27 formatted files and19 strictly checked source files (`final-python-static.txt`).
- `env -u NO_COLOR -u FORCE_COLOR VERIQ_TEST_CHROMIUM=/usr/bin/chromium XDG_CONFIG_HOME=/tmp/veriq-t02-xdg-config XDG_CACHE_HOME=/tmp/veriq-t02-xdg-cache pnpm --filter @veriq/web test:e2e`: **1 passed/8.6s**, workflow4.9s (`final-browser.txt`). Actual HTTP/MySQL/Chromium verifies paging/filter/empty-state controls alongside the entire existing account/reset/security workflow and navigation regressions. The generated masked Users screenshot was visually inspected.
- `UV_CACHE_DIR=/tmp/veriq-t02-uv uv build --project apps/srv --wheel --out-dir .superpowers/cache/t02/evidence/fix1/wheel`: **passed** (`final-wheel.txt`). Wheel inventory confirms the new pagination module, migration and current canonical query contracts are packaged (`wheel-inventory.txt`); no new production deployment claim is made.

No checks remain failed in the final covering state. Original T02 limits remain: no remote TLS SMTP, production reverse-proxy/static deployment, Windows or full release acceptance claim. Full product scope and downstream task ownership are preserved.
