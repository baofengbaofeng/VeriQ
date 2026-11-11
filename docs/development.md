# Developing VeriQ

Installation, user accounts, Workspace management and versioned asset APIs are implemented. The current pages provide setup/login/logout, password reset, account/session controls, global user administration, Workspace selection, membership and invitations using actual MySQL records. The deterministic compiler, Runner SDK and built-in HTTP business/fixture lifecycle providers are implemented, together with versioned credential/authentication APIs. The asset editor, trusted Runtime integration, reports and desktop client remain under development.

After signing in, open **Workspaces** to create a project Workspace; its creator becomes OWNER. OWNER/ADMIN can invite members with a copyable link or configured SMTP. Existing accounts sign in within the acceptance page; new invitees create an ordinary account. Invitation tokens are removed from the address bar and retained in page memory, so reopen the original link after a full refresh. Global system administration does not grant project membership.

Workspace members can switch spaces and view their role. OWNER/ADMIN can manage permitted memberships; only OWNER can grant ownership or archive a Workspace. The final enabled ACTIVE OWNER cannot be removed, demoted or disabled without a successor. Archived Workspaces are read-only; this API currently has no restore operation. Resource authorization already uses this scope layer; execution and device services will adopt it in later tasks.

Asset API clients can create and revise all eight resource kinds under a Workspace, inspect pinned dependencies and read immutable published versions. Read `validation-preview` before submitting the returned revision/source hash to `validate`. This creates a real queued VALIDATE job; production receipt creation awaits the trusted Runtime integration. No public endpoint fabricates successful validation. Current permission, hash, entrypoint and publication contracts are in [contracts.md](contracts.md).

The compiler validates all eight asset kinds and emits deterministic TypeScript, source context and verified dependency files. Executable compilation requires actual engine distribution bytes. The compiler retains its isolated fixture-distribution test; the SDK additionally installs actual SDK/contracts JavaScript and dependency archives offline, typechecks emitted TypeScript and executes it in Chromium. Built-in authentication/fixture providers now have real local backend/browser evidence; deployed Runtime authorization and trusted worker assembly remain later integration tasks. See [the compiler contract](contracts.md) and [ADR 0006](decisions/0006-deterministic-compiler-artifacts.md).

Credential management APIs require Workspace OWNER/ADMIN and return metadata, never plaintext. Business and fixture identities are separate, version pinned, and configured through the immutable authentication registry. The internal credential resolver remains denied until a real device/Attempt verifier is integrated. The [backend integration guide](integration/backend.md) covers the controlled Tornado/SQLite test target, idempotent fixture lifecycle and compensation; this target does not replace the platform MySQL database. Raw Trace/screenshots/downloads carry credential-restricted sensitivity; production artifact authorization remains the report task. Initial variable declarations contain types only, with actual values frozen separately and checked before side effects.

Use the exact toolchain from [contracts.md](contracts.md). Install dependencies from the repository root:

```sh
uv sync --project apps/srv --frozen --all-groups
pnpm install --frozen-lockfile
```

Use a dedicated MySQL 8.4 database, InnoDB and utf8mb4. Provision its database/user outside VeriQ; grant schema migration and application access to that database. Production deployments should separate migration credentials from runtime credentials as operations mature. Connection setup uses UTC and READ COMMITTED; migration refuses another MySQL release series. Do not use a shared production database for development tests.

Initialize local configuration interactively; the command prompts privately for an async MySQL URL of the form `mysql+asyncmy://USER:PASSWORD@HOST:3306/DATABASE`:

```sh
uv run --project apps/srv veriq_server --config /private/veriq/veriq.json --public-url http://127.0.0.1:5173 --environment development init
```

Choose a writable operator-owned directory instead of `/private/veriq`. `init` writes the config and adjacent `veriq.installation-secret` using exclusive creation and mode 0600, generates random external master/signing key material, explicitly runs Alembic and registers the installation-secret hash in the singleton installation row. No fixed administrator password exists. If initialization is interrupted before administrator creation, rerun `init` with the same configuration/installation-secret files; it preserves existing key material. Back up configuration/key material privately; do not commit it or place it in frontend/static directories. `VERIQ_DATABASE_URL` can supply the DSN when using your own protected process environment; do not paste secrets into shared command logs.

Create the first administrator in one of two ways. Open the setup page and enter the operator's installation secret with the desired account/password; or use the local CLI, which reads the secret file and prompts for a password twice:

```sh
uv run --project apps/srv veriq_server --config /private/veriq/veriq.json create-admin --email admin@example.com --display-name Administrator
```

The database consumes the installation secret transactionally. Web setup leaves the now-invalid local secret file for the operator to delete; CLI creation deletes it. The unique singleton serializes competing first-administrator requests. After initialization, authorized system administrators create additional users through `/admin/users`.

Migrations are a separate operator command. Back up existing databases before upgrades. `serve` never creates tables or runs migrations:

```sh
uv run --project apps/srv veriq_server --config /private/veriq/veriq.json migrate
uv run --project apps/srv veriq_server --config /private/veriq/veriq.json doctor
uv run --project apps/srv veriq_server --config /private/veriq/veriq.json serve
```

`doctor` checks validated configuration, MySQL 8.4 and the installation table. `GET /api/v1/health/live` only checks the HTTP process; `GET /api/v1/health/ready` queries the database. All API responses use canonical JSON envelopes. Explicit CLI settings override `VERIQ_` environment variables, which override config-file values, which override nonsensitive defaults. For example `--port 8889` or `VERIQ_PORT=8889` changes the API port. Required settings are `database_url`, `public_url`, `master_key` and `signing_key`; key values contain 32 bytes encoded as hex. Production defaults require an HTTPS public origin and set Secure cookies. Use a same-origin TLS reverse proxy for production; final production static packaging belongs to T17/T18.

Run Vite in another terminal:

```sh
pnpm --filter @veriq/web dev
```

Vite serves `http://127.0.0.1:5173` and proxies `/api` to Tornado on `127.0.0.1:8888`. Set `public_url` to the browser's exact Vite origin for development; mutation requests enforce Origin and Tornado CSRF validation. The API starts without a frontend `dist` directory. Opening `/` on the API port alone returns a JSON 404 until production static routing is implemented.

Available pages are `/setup`, `/login`, `/reset`, `/reset/confirm`, `/account` and `/admin/users`. Passwords require 12–1024 characters. Without SMTP, public reset requests return the same generic response for every email and explain that an administrator supplies the link. Optional real SMTP delivery is configured in the protected file or with `VERIQ_SMTP_HOST`, `VERIQ_SMTP_PORT`, `VERIQ_SMTP_FROM`, `VERIQ_SMTP_USERNAME`, `VERIQ_SMTP_PASSWORD`, `VERIQ_SMTP_SECURITY` (`starttls` by default, or `tls`) and `VERIQ_SMTP_TIMEOUT`. Username/password must be supplied together; production rejects plaintext SMTP. TLS uses certificate verification. Public reset requests acknowledge before account lookup, and configured delivery runs as a tracked background task. A delivery failure logs a safe event, audits failure and revokes that issued token; the public response remains generic and never claims that mail was delivered. Normal server shutdown drains pending deliveries. This is an in-process delivery seam, without a durable queue across a process crash. `delivery.Delivery.send(recipient, subject, body)` can also support T03 invitations. An authorized administrator issues a copyable 30-minute one-time reset link, transmitted only in the authorized response. The URL carries the token in its fragment, which the browser removes on entry; it never enters the URL sent to the server. Password changes/resets, disable, logout and revocation invalidate sessions. The last enabled system administrator cannot be disabled or demoted without another enabled administrator.

Tests require the dedicated operator-supplied MySQL test environment at `.superpowers/sdd/veriq-1/test-env.json` containing `mysql_dsn`. Tests explicitly refuse any database except `veriq_test` and refuse unknown tables; they reset only the explicitly allowlisted VeriQ tables and `veriq_alembic_version`. Never point this file at existing platform data. Run Python and browser suites sequentially because both own that schema and fixed task ports:

```sh
uv run --project apps/srv pytest -c apps/srv/pyproject.toml apps/srv/tests --cov=veriq_server --cov-config=apps/srv/pyproject.toml --cov-report=term-missing -q
pnpm test
pnpm check
pnpm --filter @veriq/runner-sdk test:coverage
pnpm --filter @veriq/web check
pnpm --filter @veriq/web build
pnpm --filter @veriq/web test:e2e
```

Playwright uses its installed Chromium by default. On managed test hosts, `VERIQ_TEST_CHROMIUM=/usr/bin/chromium` selects an existing test browser; this option belongs only to the test configuration. Use writable task-local `UV_CACHE_DIR`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME` if HOME is read-only. Browser evidence goes under ignored `.superpowers/cache/t02/`. No browser or Node process is required by the Python API at runtime.

## Runtime enrollment and doctor (T08 development CLI)

Install the frozen workspace dependencies, then use the implemented CLI:

```sh
pnpm --filter @veriq/runtime dev doctor --server http://127.0.0.1:5173
pnpm --filter @veriq/runtime dev login --server http://127.0.0.1:5173 --name "My workstation"
pnpm --filter @veriq/runtime dev status
pnpm --filter @veriq/runtime dev workspace list
pnpm --filter @veriq/runtime dev workspace use APPROVED_WORKSPACE_UUID
pnpm --filter @veriq/runtime dev logout
```

Open the displayed control URL, sign in, select the Workspace, inspect the approval code and confirm the device and sharing scope. The device polls at five-second intervals until approval or the ten-minute expiry. A successful login registers an **offline** device; it does not start a worker. Workspace use accepts only the existing approved binding; it does not create a new grant. A revoked, expired, disabled-owner or removed-membership identity is denied at the next operation. Logout revokes the current token remotely before deleting local configuration; if unreachable it keeps the file so logout can be retried.

Doctor checks the actual pinned Node 24.22.1, supported OS/x64 architecture, installed compiler/SDK versions, Chromium executable and real headless launch/render, plus the configured control liveness endpoint. `--browser-executable PATH` explicitly selects an installed browser; production defaults use Playwright's installation. An unavailable browser or network produces a nonzero exit with a safe diagnostic. Success is exit 0, failure 1, cancellation 130. Diagnostics go to stdout; sanitized command failure logs go to stderr. No token is printed or passed in argv. Only HTTPS control origins are accepted, except localhost HTTP development. Redirects are rejected and requests/body sizes are bounded.

Deployment managers create a Workspace service account in the Runtime page and issue a one-time enrollment token. Supply it through standard input to `enroll-service --server ORIGIN --name NAME`; include `--share-workspace` only when consenting to Workspace use. Never paste a token as a command argument or put it in a URL. Tokens expire in ten minutes and cannot be used for execution-plan triggers, maintenance or credential resolution. System-admin MANAGED approval is separate from owner consent and cloud location. Workspace OWNER/ADMIN separately approves credential delivery after MANAGED trust; a global administrator with only project VIEWER/EDITOR membership cannot grant it. Disabling the account denies its devices immediately.

The Node development CLI uses the pinned tsx loader to consume shared TypeScript packages. Its env-paths configuration directory is mode 0700 and the device file is mode 0600 with proper-lockfile serialization and atomic replacement. `--config-dir` selects a dedicated private development directory. This is a documented file-storage seam, **not** an OS vault or a native release package. T20 provides OS vaults, installers and real process names; T09/T10 implement worker claim/lease/start/stop and unattended token renewal. A lost one-time receipt or rotation response requires explicit recovery/re-enrollment; no fake claim or silently restored credential exists. Bundle trust roots remain unavailable until T14 supplies an actual authenticated issuer.

Run Runtime tests with `VERIQ_TEST_CHROMIUM` selecting the test host's Chromium if necessary:

```sh
pnpm --filter @veriq/runtime test
pnpm --filter @veriq/runtime check
pnpm --filter @veriq/web test:e2e z-runtimes.spec.ts
```

The real browser journey launches the CLI, approves in the UI, reads the protected local credential, changes sharing and managed trust, revokes the device, and confirms the token is rejected. Vite forwards both `/api` and `/internal` to the control service. The Python control service still requires neither Node nor Chrome at runtime.
