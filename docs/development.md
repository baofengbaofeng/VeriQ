# Developing VeriQ

Installation, user accounts and Workspace management are implemented: setup/login/logout, password reset, account/session controls, global user administration, Workspace selection, membership and invitations. Test assets, execution, reports and the desktop client remain under development. The pages use actual MySQL records.

After signing in, open **Workspaces** to create a project Workspace; its creator becomes OWNER. OWNER/ADMIN can invite members with a copyable link or configured SMTP. Existing accounts sign in within the acceptance page; new invitees create an ordinary account. Invitation tokens are removed from the address bar and retained in page memory, so reopen the original link after a full refresh. Global system administration does not grant project membership.

Workspace members can switch spaces and view their role. OWNER/ADMIN can manage permitted memberships; only OWNER can grant ownership or archive a Workspace. The final enabled ACTIVE OWNER cannot be removed, demoted or disabled without a successor. Archived Workspaces are read-only; this API currently has no restore operation. Resource, execution and device authorization will build on this scope layer in later tasks.

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

Tests require the dedicated operator-supplied MySQL test environment at `.superpowers/sdd/veriq-1/test-env.json` containing `mysql_dsn`. Tests explicitly refuse any database except `veriq_test` and refuse unknown tables; they reset only T02 account tables and `veriq_alembic_version`. Never point this file at existing platform data. Run Python and browser suites sequentially because both own that schema and fixed task ports:

```sh
uv run --project apps/srv pytest -c apps/srv/pyproject.toml apps/srv/tests --cov=veriq_server --cov-config=apps/srv/pyproject.toml --cov-report=term-missing -q
pnpm test
pnpm check
pnpm --filter @veriq/web check
pnpm --filter @veriq/web build
pnpm --filter @veriq/web test:e2e
```

Playwright uses its installed Chromium by default. On managed test hosts, `VERIQ_TEST_CHROMIUM=/usr/bin/chromium` selects an existing test browser; this option belongs only to the test configuration. Use writable task-local `UV_CACHE_DIR`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME` if HOME is read-only. Browser evidence goes under ignored `.superpowers/cache/t02/`. No browser or Node process is required by the Python API at runtime.
