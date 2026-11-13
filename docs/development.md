# Developing VeriQ

Installation, user accounts, Workspace management and versioned asset APIs are implemented. The current pages provide setup/login/logout, password reset, account/session controls, global user administration, Workspace selection, membership and invitations using actual MySQL records. The deterministic compiler, Runner SDK and built-in HTTP business/fixture lifecycle providers are implemented, together with versioned credential/authentication APIs. Runtime enrollment, owner-controlled sharing, separate hardware trust/Workspace credential delivery and development CLI/doctor are implemented. Asset editing/publication, actual Linux Agent/lease integration and restricted reports/storage have passed task reviews. The AI implementation has also passed code review; authorized actual-Provider acceptance remains pending. Signed bundle export/verification, issuer trust and exact local credential references have passed their task reviews. Offline execution/import, the desktop client and formal distributions remain under development.

After signing in, open **Workspaces** to create a project Workspace; its creator becomes OWNER. OWNER/ADMIN can invite members with a copyable link or configured SMTP. Existing accounts sign in within the acceptance page; new invitees create an ordinary account. Invitation tokens are removed from the address bar and retained in page memory, so reopen the original link after a full refresh. Global system administration does not grant project membership.

Workspace members can switch spaces and view their role. OWNER/ADMIN can manage permitted memberships; only OWNER can grant ownership or archive a Workspace. The final enabled ACTIVE OWNER cannot be removed, demoted or disabled without a successor. Archived Workspaces are read-only; this API currently has no restore operation. Resource, device, execution, report and AI services use this scope boundary.

Asset API clients can create and revise all eight resource kinds under a Workspace, inspect pinned dependencies and read immutable published versions. Read `validation-preview` before submitting the returned revision/source hash to `validate`. This creates a real queued VALIDATE job; the Linux Agent consumes it using an approved engine inventory, actual compilation and fenced completion. No public endpoint fabricates successful validation. Current permission, hash, entrypoint and publication contracts are in [contracts.md](contracts.md).

The compiler validates all eight asset kinds and emits deterministic TypeScript, source context and verified dependency files. Executable compilation requires actual engine distribution bytes. The compiler retains its isolated fixture-distribution test; the SDK additionally installs actual SDK/contracts JavaScript and dependency archives offline, typechecks emitted TypeScript and executes it in Chromium. Built-in authentication/fixture providers and Linux Agent assembly have real backend/browser evidence; native release packaging remains a later task. See [the compiler contract](contracts.md) and [ADR 0006](decisions/0006-deterministic-compiler-artifacts.md).

Credential management APIs require Workspace OWNER/ADMIN and return metadata, never plaintext. Business and fixture identities are separate, version pinned, and configured through the immutable authentication registry. The internal resolver requires the current device/Attempt authority and separately approved credential delivery. The [backend integration guide](integration/backend.md) covers the controlled Tornado/SQLite test target, idempotent fixture lifecycle and compensation; this target does not replace the platform MySQL database. Raw Trace/screenshots/downloads carry credential-restricted sensitivity and independent current report permissions. Initial variable declarations contain types only, with actual values frozen separately and checked before side effects.

The Runtime page supports real device-code approval and deployment service accounts. Registration is OFFLINE until an actual worker is running; capability reports do not approve an engine release. The development CLI supports explicit logout recovery, including `--local-only` without remote revocation. Current known UI issue: an invalid or expired authenticated approval code is misclassified as session expiration; it is tracked for the full error-handling pass and does not revoke the server session cookie.

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

Open the displayed control URL, sign in, select the Workspace, inspect the approval code and confirm the device and sharing scope. The device polls at five-second intervals until approval or the ten-minute expiry. A successful login registers an **offline** device; it does not start a worker. Workspace use accepts only the existing approved binding; it does not create a new grant. A revoked, expired, disabled-owner or removed-membership identity is denied at the next operation. Normal logout deletes the local device credential after successful remote logout, or after a definitive HTTP 401 `DEVICE_UNAUTHORIZED` / `DEVICE_REVOKED` rejection. The latter reports that the server already rejected the credential, without claiming to have revoked it. You can then enroll again in the same configuration directory. Unknown errors and network/transport failures return nonzero and retain the credential so logout can be retried. Login never automatically deletes or overwrites an existing credential.

For explicit local recovery while the server is unreachable, run `pnpm --filter @veriq/runtime dev logout --local-only` (with the same `--config-dir` if one was selected). This removes only the local device credential through the locked store; it does not contact the server, revoke any remote token, or delete project assets/results. The remote credential may remain valid. Revoke the device through the Web Runtime page when reachable, or wait for its expiry before assuming it cannot be used. This escape also permits replacement of an unreadable local credential file; normal login still preserves existing profiles.

Doctor checks the actual pinned Node 24.22.1, supported OS/x64 architecture, installed compiler/SDK versions, Chromium executable and real headless launch/render, plus the configured control liveness endpoint. `--browser-executable PATH` explicitly selects an installed browser; production defaults use Playwright's installation. An unavailable browser or network produces a nonzero exit with a safe diagnostic. Success is exit 0, failure 1, cancellation 130. Diagnostics go to stdout; sanitized command failure logs go to stderr. No token is printed or passed in argv. Only HTTPS control origins are accepted, except localhost HTTP development. Redirects are rejected and requests/body sizes are bounded.

Deployment managers create a Workspace service account in the Runtime page and issue a one-time enrollment token. Supply it through standard input to `enroll-service --server ORIGIN --name NAME`; include `--share-workspace` only when consenting to Workspace use. Never paste a token as a command argument or put it in a URL. Tokens expire in ten minutes and cannot be used for execution-plan triggers, maintenance or credential resolution. System-admin MANAGED approval is separate from owner consent and cloud location. Workspace OWNER/ADMIN separately approves credential delivery after MANAGED trust; a global administrator with only project VIEWER/EDITOR membership cannot grant it. Disabling the account denies its devices immediately.

The Node development CLI uses the pinned tsx loader to consume shared TypeScript packages. Its env-paths configuration directory is mode 0700 and the device file is mode 0600 with proper-lockfile serialization and atomic replacement. `--config-dir` selects a dedicated private development directory. This is a documented file-storage seam, **not** an OS vault or a native release package. T20 provides OS vaults, installers and complete native platform delivery; T09/T10 now implement Linux worker claim/lease/start/stop and recoverable unattended token renewal. A lost one-time enrollment receipt still requires explicit recovery/re-enrollment; the Agent recovers its exact journaled rotation candidate without overwriting a different enrolled principal. T14 provides a persisted issuer and separate `trust bind`/`trust refresh` commands; device credentials alone do not establish signer trust. See [offline bundle operations](offline-bundles.md).

Run Runtime tests with `VERIQ_TEST_CHROMIUM` selecting the test host's Chromium if necessary:

```sh
pnpm --filter @veriq/runtime test
pnpm --filter @veriq/runtime check
pnpm --filter @veriq/web test:e2e z-runtimes.spec.ts
```

The real browser journey launches the CLI, approves in the UI, reads the protected local credential, changes sharing and managed trust, revokes the device, and confirms the token is rejected. Vite forwards both `/api` and `/internal` to the control service. The Python control service still requires neither Node nor Chrome at runtime.

## Unified execution server (T09)

The implemented control API admits immutable published CASE/SUITE runs or frozen draft candidates, queues TEST/VALIDATE/CLEANUP, and checks both the current device and original requester. Defaults remain four global browser contexts, two per Workspace, ten unfinished Runs, heartbeat10s and lease60s. Explicit activation precedes side effects; an expired or unknown process loses authority and keeps its capacity quarantined until stop reconciliation. Cancellation of an unstarted retry finishes immediately while retaining earlier failures.

The server now verifies managed compiler completion against actual uploaded bytes, retained source and an operator-owned `approved_engine_inventory_path`. No production catalog is supplied yet: missing approval fails closed. T18/T20 build and promote exact engine bytes; the test-only archive producer is not an installation or production approval tool. The Python controller never executes Node or Chrome.

External middleware calls scoped, idempotent HTTP maintenance routes for lease reaping, fixture compensation and capacity reconciliation. A Workspace service token with purpose MAINTENANCE and explicit operations is distinct from one-time RUNTIME_ENROLLMENT. There is no internal Cron. Complete fields, hashing, event order, FINALIZE metadata, upload bounds and result rules are in the [execution contracts](contracts.md) and [queue decision](decisions/0010-unified-fenced-execution.md).

T09 is the server foundation. Its real MySQL/HTTP concurrency and actual compiler archive tests are separate from TEST/CLEANUP protocol fixtures; these fixtures are not browser traces or evidence of an Agent killing a process. T10 now supplies the real Linux consumer, process supervision, canonical SDK events and recoverable renewal. T12 adds restricted raw-evidence access, retention and reports. The development CLI still registers an offline device rather than automatically starting a worker.

## Online Linux Agent (reviewed T10)

Build the development launcher with an installed C compiler, then run the enrolled profile in a separate terminal. Production Runtime packages will contain the precompiled helper; normal Agent start never compiles source. The release directory must contain administrator-approved fixed engine bytes and its inventory. Current test producers are not production release tools.

```sh
pnpm --filter @veriq/runtime build:launcher
pnpm --filter @veriq/runtime dev --config-dir /private/veriq-profile runtime start --release-dir /operator/approved-engine --browser-executable /path/to/chromium
pnpm --filter @veriq/runtime dev --config-dir /private/veriq-profile runtime status
pnpm --filter @veriq/runtime dev --config-dir /private/veriq-profile runtime stop
```

Start is foreground; status/stop are issued from another terminal. Stop acknowledges the request, then the Agent interrupts work, attempts cleanup and confirms descendant termination. Logout requires the Agent to have stopped. Missing launcher or unconfirmed termination fails closed. Do not treat recent ONLINE presence as proof of a running process or permission to release capacity. The [Linux containment decision](decisions/0012-linux-attempt-containment.md) explains the kernel child-drain proof and recovery limits.

Every Attempt uses fresh business state and bounded event/evidence storage. Explicit cancellation preserves earlier observed failures. Configured whole-case retry requires either successful cleanup under the fixture's namespace-closing contract, or trusted compiler metadata plus complete observed read-only behavior. A no-fixture write with an uncertain result is not automatically repeated: RETRY_SAFETY_UNCONFIRMED requires business reconciliation before an explicit new Run. Read-only retry remains available; a retry pass aggregates UNSTABLE. See the [execution contracts](contracts.md) for exact fields and authorization.

The SDK test entry uses two workers with unchanged assertion/test timeouts. Heavier validation suites should run sequentially on constrained hosts. Earlier higher-concurrency timeouts remain documented; a passing bounded run is not proof that every possible scheduling race has been excluded. Windows process containment and the full desktop product remain subsequent tasks.

The resource and environment UI is available at `/resources` and `/environments` in the
Vite development app. Compile validation needs a currently authorized MANAGED Runtime and
operator-approved engine inventory; without one, editing works and validation remains queued.
Do not fabricate a receipt to enable publication. The focused browser command is
`VERIQ_TEST_CHROMIUM=/usr/bin/chromium pnpm --filter @veriq/web test:e2e case-publish.spec.ts`.
It uses the guarded dedicated MySQL fixture, builds a genuine locked test-only release,
registers the actual CLI and invokes the actual Linux Agent compiler. No test release is
promoted to the production catalog. It needs writable XDG paths and sufficient temporary
disk space; generated archives, device profiles and per-Attempt work are transient.

## External HTTP plans and CI (reviewed T16)

执行计划、独立服务账号 EXECUTION 令牌、同计划 QUEUE/SKIP/REJECT、GUI及安全CI报告由
`599f989` 实现，`10a1065` 修复管理入口认证回退与CI总截止时间，均经独立规格/质量审查及修复复审。
服务账号创建者停用后，真实Agent仍能以明确计划/操作授权完成实际业务浏览器、凭证解析、状态/JUnit读取。
CI超时使用单一截止时间，已知Run的取消另有最多10秒尽力请求；超时不证明远端任务未接受或物理进程已停止。
接入、幂等分页与维护说明见[外部调度](integration/external-scheduler.md)和[ADR0018](decisions/0018-external-plan-trigger.md)。

本轮证据按实际源码阶段分组：服务端广套件437通过/4失败，定向46通过/1测试证据变量错误，随后该单项1通过；
Runtime广套件63通过/3缺浏览器路径，补齐环境后三项通过；TS契约先199/2、后200/1兼容超时，最终定向185通过。
GUI最终4项通过。重要修复先观察认证/截止时间RED，再18项通过，最后传输收紧由7项通过覆盖；严格mypy84文件、
Ruff、格式和生成一致性均有记录。不将这些分组结果称为同一冻结版本全量通过；原两项编译EXECUTION_ERROR的
根因仍未证明，定向真实Agent/报告通过不倒推出磁盘是原因。源码、锁、提交树及哈希绑定已核对。

恢复环境中的测试库存已迁入当前工作区私有状态，历史清单与保留副本逐字节一致；专用测试库binlog压力已处理。
不把开发测试库存当正式批准分发。目标浏览器匹配、完整覆盖率、源码注释规范、真实Provider、生产打包及两平台
安装仍是后续门禁。报告跨页Workspace深链接和计划错误方法500两项Minor明确由T22整改；旧账号/重跑/events
声明仍须对齐，F10重跑不因旧路由未实现而被移出首发。完整状态以[里程碑](plans/milestones.md)为接续依据。

## Current verification limits

The offline execution/import module (`1b6fccb`, `86f1602`, fixed in `67968b4`)
passed independent spec/quality review and scoped rereview. Real composed tests
cover signed Agent-published CASEs, cancelled and complete SUITE matrices, candidate
SUITE role/browser/dataset overrides, and DOWNLOAD recovery after killing the
host: four scenarios passed against business HTTP and the actual MySQL import API
with the control listener physically stopped during execution. Source/variant/event
and raw checksums match; repeated uploads reuse the Run and preserve online Attempts.
Imports retain OFFLINE_IMPORT with gate false; omitted work stays INCOMPLETE.

The final fix checks passed 27 offline and 27 import/report tests, 200 contract
checks, generated-contract consistency, Runtime/Web types, Ruff and explicitly
configured strict mypy (80 files). The four-scenario composition predates two
small client/checkpoint refinements covered by the frozen-source offline checks;
it is not claimed as a second composition run on those refinements. The initial
broad server batch remains recorded as 290 passes/seven failures; six fixture
configuration failures and the native import lock defect were checked by six real
Agent/compiler tests and the affected import/publication suites. No clean rerun of
that entire batch or the full SDK is claimed. See [offline execution](offline-execution.md)
and [ADR0017](decisions/0017-offline-execution-import.md). Desktop/IPC, Windows/vault,
production packaging and the formal browser/Provider gates below remain assigned
work; this is not complete-product acceptance.

The signed-bundle implementation (`46798ab`, fixed in `3ffb144` and `c1fa544`)
passed independent review after correcting unchecked OOB sibling keys, semantic
closure/entrypoint binding, HTTP idempotency/auth/status contracts, and multi-CASE
version pagination. Final scoped evidence includes 14 offline verifier tests,
37 compiler emission tests, six bundle/guard checks, 196 contract tests, a real
Agent/keyboard-GUI/download/native-verification journey, and one generated SDK
consumer, plus types, mypy (76 files) and Ruff. The GUI pagination test discloses
its listing-only history padding; only genuine Agent-published roots are exported.
These checks are not whole-product acceptance.

The required T14 full SDK command remains **134 passed / one timeout**. New phase
evidence places the delayed await in fixture `browser.close()`, after executeStep
settled and context close completed; this alone does not prove its business-status
assertions passed. A separately authorized native process/pipe probe passed 47
selected tests under a different schedule and did not reproduce the gap. No cause
or lifecycle fix is claimed. System Chromium 156 differs from Playwright 1.65's
expected Chromium 158 (revision 1254); causality is unproven. Before formal build,
align the test harness with the matched pinned browser and obtain the official
gate, capturing native phases if it fails again. Preserve the 15-second/two-worker
checks and generated-child privacy. The later passing generated consumer is a
focused compatibility check, not a replacement full gate.

The AI implementation (`f9573d0`, fixed in `3c96eb6`) passed independent code review.
Its pre-fix final AI suite passed 20 tests. The review fixes have six causal backend
regressions passing, 29 covering cases passing, two corrected parser-fixture checks
passing, and three browser journeys passing, with mypy/Ruff/TypeScript checks. Two
covering commands retained one incorrect parser-fixture expectation each; neither
is described as a full 30-test pass. The earlier broad Python command was 356 passes
and one stale migration-head assertion; the broad Web command was 16 passes and one
shared-empty-fixture assumption. Targeted checks verify those corrections without
claiming a clean rerun of either broad suite. Real Chromium Runs with disabled and
exhausted Providers both passed with zero model HTTP requests. Actual external
Provider acceptance remains pending user authorization and durable isolated setup;
see [AI configuration and acceptance](ai.md). Never put real keys in resettable tests.

The reviewed editor implementation (`c128ac5`, fixed in `b49f981`) passed its final nine
browser tests, Web type check and production build. The initial implementation also passed
five existing Web journeys, 258 affected Python tests, 193 contract tests, 109 compiler tests,
Ruff and mypy. These are scoped development results, not complete product acceptance.

The broader `pnpm test` run remains failed: SDK cancellation test
`cancels an in-flight assertion while preserving already observed failure=false` exceeded its
unchanged 15-second budget under two workers (131 passed, one failed). The script stopped
before Runtime tests. One later instrumented, isolated execution passed in 671 ms; it did not
reproduce or explain the earlier failure. Capture the failing phase and resolve this before
claiming a passing formal build; increasing the timeout or retrying until green is not a fix.

The report implementation (`f77a9b9`, fixed in `47986b0`) also passed independent spec and
quality review. Its final fix checks passed 24 report/storage tests, two current physical
pipeline/schema tests and one actual pre-T12 compiler-archive compatibility test, plus
Ruff, mypy (65 files) and generated/type checks. Earlier applicable checks include Runtime
38, contracts 193, compiler 112 and Web 10 passes. Full backend runs had failures before
their scoped corrections; they are not represented as clean all-test runs.

The required T12 SDK run again recorded 131 passes and the same cancellation timeout.
Properly instrumented follow-up did not reproduce cancellation (1.287 seconds); its whole
command still failed because diagnostic DEBUG reached a generated-test child and printed
synthetic protected locator text, triggering that test's privacy assertion. This does not
resolve the timeout or establish a leak in the normal Runtime, which passes an explicit
child environment without DEBUG. Future required diagnosis must capture the failing phase
without contaminating the generated-child privacy check.

The production build also retains a large-chunk warning from eager Monaco loading; local
worker assets remain bundled for offline use. Loading improvements belong to the final UX
work. Existing test color-environment warnings remain an infrastructure follow-up.

## Reports and restricted evidence

The development `/reports` view uses actual Run/Attempt history, replayable event streams,
compiler-derived step labels and separate execution/current trust gates. Ordinary members
see redacted structured values. Raw Trace, HTML, screenshot, download and log access requires
current Workspace Owner/Admin permission and the exact Attempt association; caller-supplied
sensitivity cannot grant access. Locally view an authorized downloaded Trace with
`pnpm --filter @veriq/runtime dev trace open /path/to/trace.zip`; it uses the pinned Playwright
viewer on loopback and does not upload the file to a public service.

Raw evidence retention uses server terminal timestamps, defaults to 14 days for passed
Attempts and 30 days for other terminal outcomes, and is woken through the authenticated
external maintenance HTTP endpoint. Unknown historical timestamps remain retained. Source,
engine and compiled provenance stay pinned. Metadata/export-package lifecycle is still a
required operations task. Minimal empty private retirement fences prevent a late external
writer from restoring deleted evidence bytes; elapsed time alone is not sufficient to remove
those fences. Protocol and storage details are in [the contracts](contracts.md) and
[ADR0014](decisions/0014-report-evidence-storage.md).

T14 adds migration0011 (`veriq_bundles`) and the `/bundles` Web page. Provision the
separate operator issuer for existing installations before exporting; see
[offline bundle operations](offline-bundles.md). Fresh `init` creates it safely, while
`serve` never invents signing identity. The native CLI implements bundle download/verify,
trust bind/refresh and exact local secret mapping. Offline execution/result import now
use the same worker/compiler and durable local SQLite reports; see [offline operations](offline-execution.md). Native OS vault,
desktop IPC and installers remain their later tasks; package signatures do not confer
formal-result trust. Bundle retention roots are pinned pending T21's package lifecycle.
