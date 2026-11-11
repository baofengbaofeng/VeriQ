# VeriQ shared contracts v1

This document freezes the T01 interfaces for following tasks. It describes contracts, not implemented server endpoints or a finished product. Canonical schemas are [platform-v1.schema.json](../packages/contracts/schemas/platform-v1.schema.json); small `*-v1.schema.json` files are entry aliases. Field requiredness, exact unions and bounds come from those schemas, with committed TypeScript generated from the same source. Do not introduce another independently maintained DSL validator.

## Developer commands

Use Python 3.12.14, uv 0.13.5, Node 24.22.1 and pnpm 11.25.0. From the repository root:

```sh
uv sync --project apps/srv --frozen --all-groups
pnpm install --frozen-lockfile
uv run --project apps/srv pytest -c apps/srv/pyproject.toml apps/srv/tests/contracts -q
pnpm test
pnpm check
uv run --project apps/srv ruff check --config apps/srv/pyproject.toml apps/srv/src apps/srv/tests
uv run --project apps/srv ruff format --check --config apps/srv/pyproject.toml apps/srv/src apps/srv/tests
uv run --project apps/srv mypy --config-file apps/srv/pyproject.toml apps/srv/src
```

The explicit configuration paths make root-level Python checks use the service's pytest, Ruff and strict mypy settings; `uv --project` selects the environment but does not change the tools' working directory. Async fixtures use a function-scoped event loop by default.

`pnpm contracts:generate` regenerates committed wire/API types. `pnpm check` compiles the contract package and rejects stale generation. `pnpm test` currently runs the real contract suite; future workspace applications have dependency manifests and no pretend build/test commands. On hosts with read-only HOME, point `UV_CACHE_DIR` and XDG cache/data directories at writable task-local directories; keep proxy/CA verification enabled.

## Public libraries

Python imports from `veriq_server.contracts`:

```python
validate_case_schema(value: Any) -> list[ValidationIssue]
validate_schema(schema_name: str, value: Any) -> list[ValidationIssue]
serialize_contract(schema_name: str, value: Any) -> str
parse_contract(schema_name: str, text: str) -> Any
```

TypeScript imports from `@veriq/contracts` (`packages/contracts/src/index.ts`):

```ts
validateCaseSchema(value: unknown): ValidationIssue[];
validateSchema(schemaName: string, value: unknown): ValidationIssue[];
serializeContract(schemaName: string, value: unknown): string;
parseContract(schemaName: string, text: string): unknown;
```

`ValidationIssue` contains `path`, `code` and `message`. `path` is an RFC6901 instance pointer, with the empty string representing the root; `code` is `SCHEMA_VIOLATION` or `INVALID_JSON`. Validation returns an empty array/list on success and does not mutate/coerce input, inject defaults or remove fields. Unknown schema names raise `ValueError` / `Error`. Parsing and serialization validate and raise on invalid content. Dependency-specific diagnostic messages are not a cross-language byte-for-byte API; acceptance/rejection of shared fixtures is identical.

Serialization emits JSON text, not a signing canonicalization format. Sign bundle manifest **exact bytes** and hash file/artifact **exact bytes**; callers must retain those bytes. Schema validation does not recompute hashes, verify signatures, compare snapshot identifiers or authenticate callers. Deterministic source hashing/compilation must be implemented consistently at the compiler/publisher boundary; runtime values, machine paths and run IDs must not enter immutable source identity.

Both libraries reject NaN/Infinity, unsafe integers outside ±9,007,199,254,740,991, cycles and non-JSON host objects. Python additionally rejects tuples/non-string object keys; JavaScript rejects undefined, BigInt, functions, non-plain objects and symbols. `JsonValue` represents portable recursive JSON. Business big integers must be strings. Missing values use an explicit presence record in assertion results; they are not JSON null.

`Id` accepts hyphenated 8-4-4-4-12 hexadecimal UUID text in either letter case; URNs, braces, compact forms and surrounding whitespace are rejected. This is a lexical contract, not a UUID version/variant restriction. `Timestamp` uses a shared RFC3339 profile: a real Gregorian date in years 0001–9999; `T`/`t`; hour 00–23, minute/second 00–59; optional nonempty fractional seconds; mandatory `Z`/`z` or numeric offset (hour 00–23, minute 00–59). `-00:00` is accepted as RFC3339's unknown-offset representation. Leap seconds, spaces as separators, year zero, missing offsets and surrounding whitespace are rejected. Server timestamps emit UTC with uppercase `T`/`Z`. Canonical lexical constraints and full calendar checks jointly enforce this profile, including leap-year/day validity; package defaults alone do not define it.

`JsonValue`, `JsonObject` and `JsonSchema` are inert data. Their strings may contain literal `{{customer.name}}`, `{{evil()}}` or any other text. Actual/expected results, execution variables, dataset values, error details, JSON Schema contents and `DiagnosticText` log/error messages retain such text verbatim and must never be evaluated or recursively interpolated. Portable JSON restrictions still apply. `SafeString` and recursive `BindingJsonValue`/`BindingJsonObject` apply only to explicitly interpolated DSL fields: fill/press/selectOption values, request body/query/header values, flow/template parameters, assertion expected/query values, observer body/query matching, locator role names and catalog record keys. JSON Schema assertions remain literal. Resolving a permitted binding returns its value; braces inside that resolved data are not a second expression. There is no eval fallback or implicit interpolation of arbitrary wire data.

## Source and generated exports

- `packages/contracts/src/types.generated.ts`: all named canonical definitions, including `CaseDslV1`, `AssetSnapshotV1`, `SnapshotV1`, `ExecutionSnapshotV1`, `CompiledAssetBundle`, `ClaimRequest`, `ClaimDTO`, `ExecutionEventV1`, `JobManifestV1`, `BundleManifestV1`, `OfflineResultV1` and supporting DSL/resource/result types.
- `SnapshotV1` is an alias of `AssetSnapshotV1`; both names remain available.
- `JobManifestV1` discriminates on `kind`, with exported `TestJobManifestV1`, `ValidateJobManifestV1` and `CleanupJobManifestV1`.
- `packages/contracts/src/api.generated.ts`: OpenAPI `paths`, `components` and `operations`. The package root exposes aliases `PlatformPaths` and `PlatformComponents`; `@veriq/contracts/openapi` exposes the generated API types directly.
- `packages/contracts/openapi/platform.yaml`: OpenAPI 3.1, with external references into canonical JSON Schema. It is JSON-formatted YAML. Generated files are artifacts; change schemas/OpenAPI and regenerate them.

## Resource documents and DSL

`ResourceDocumentV1` is `{kind, document}` with a strict kind/document union:

| kind | document type | Required fields beyond schemaVersion `1.0` |
| --- | --- | --- |
| CASE | CaseDslV1 | caseKey, title, kind READ/WRITE, roleKey, catalogVersionId, steps |
| ELEMENT_CATALOG | ElementCatalogV1 | elements: key/locator records |
| ASSERTION_TEMPLATE | AssertionTemplateV1 | assertions; optional parameter type map |
| DATASET | DatasetV1 | columns type map, rows of `{key, values}` |
| FLOW | FlowV1 | steps; optional parameter type map |
| FIXTURE | FixtureV1 | prepare/query/cleanup endpoints, inputSchema, outputSchema, ttlSeconds |
| SUITE | SuiteV1 | cases with pinned versionId; optional datasetVersionId/roleKeys/browsers |
| ENVIRONMENT | EnvironmentV1 | baseURL, apiBaseURL, allowedOrigins, locale, timezone, roles |

Every fixed document field is declared and unknown fields are rejected. Intentional dictionaries are limited to named maps or JSON business data. `FixtureV1.query.method` is GET. `EnvironmentV1` optionally carries fixtureBaseURL/buildSha; each role carries roleKey, authAdapterVersionId, secretRef and secretVersionId, plus optional allowedIdentityIds. Environment snapshots and bundles contain credential references only, not passwords, device tokens, cookies or storageState.

`CaseDslV1` optionally pins fixtureVersionId, datasetVersionId and persistenceCheckpointStepId. A version reference is a UUID, never a mutable `latest` lookup. Semantic WRITE checkpoints/critical assertions, dependency ownership, variable existence/types, fixture schemas, flow expansion/cycles/depth and data-column consistency belong to the compiler/services.

Every step has id and a supported action. Optional shared fields are critical, beforeAssertions, observers, afterAssertions, extract, timeoutMs and failurePolicy (`STOP_CASE` / `CONTINUE`). Action-specific required fields are:

| action | Required action fields |
| --- | --- |
| goto | path |
| click/check/uncheck | target |
| fill/press/selectOption/upload | target, value |
| reload | none |
| apiRequest | method, path; optional query/body/headers |
| callFlow | versionId; optional parameters |

Fill/press values are strings; selectOption accepts a string or nonempty string array; upload accepts nonempty safe bundle-relative file paths. Paths are origin-relative and reject executable URL schemes. Templates permit only `{{data.identifier}}` and `{{vars.identifier}}` dotted data access; no eval, JSONPath or executable expressions. Complete-placeholder type preservation and substitution are compiler/SDK semantics.

Literal `Path` starts with exactly one `/` and rejects every backslash and C0/DEL control (including TAB, CR, LF and NUL). This covers navigation/API paths, observers and eventual queries. After substitution the compiler/SDK must repeat these checks, parse once with WHATWG URL semantics against the corresponding frozen `baseURL`/`apiBaseURL`/`fixtureBaseURL`, and require the normalized origin to equal that base's authorized origin and satisfy the Environment allowlist before any request/navigation. Never trim/strip controls to make a rejected path valid. Recheck policy after additional decoding and on every redirect; redirect credentials follow the authorized origin policy. Schema acceptance cannot perform these runtime checks.

Assertions have id/type/severity/expectedSource, usually operator/expected, and optional timeoutMs. UI state operators require booleans; UI text/value operators require strings; countEquals requires an integer; httpStatus/equals requires integer 100–599. Request methodEquals requires an allowed HTTP method; pathEquals requires a relative path. Request/response field equals/notEquals accept JSON, `in` requires an array, `contains` a string or array, and `exists` a boolean. JSON Pointer is RFC6901, including correct `~0`/`~1` escapes. Schema assertions carry JSON Schema data; eventually assertions use a read-only GET query; duration/requestCount and pinned assertion-template variants are defined in the schema. Severity is BLOCK/CONTINUE_FAIL/WARN. Unknown type/operator combinations fail validation.

Observers declare id/method/exact path, optional queryMatch/bodyMatch, timeout, retry policy and observation window. Defaults are documented for the SDK: timeout 15 seconds; window UNTIL_ACTION_SETTLED with 500 ms quiet time, retryPolicy FORBID. A FIXED window requires durationMs. `expectedCount` is accepted only with an explicit FIXED window; it does not claim coverage outside that window. Matching/ambiguity, pre-action listener registration, disposal and retry interpretation belong to the SDK. Assertion defaults are 5 seconds for UI, eventually total 10 seconds with 500 ms polling, subject to explicit validated timeout/interval fields. No fixed sleep or force-click fallback is authorized.

Extraction records source (`request:<observerId>` or `response:<observerId>`), pointer, destination `to`, valueType and required. Assertions use the corresponding source form; UI uses target and URL uses source `page`.

## Immutable snapshots and compiled assets

| Type | Required fields |
| --- | --- |
| AssetVersionV1 | resourceId, versionId, kind, sha256, document; kind/document strict union |
| AssetSnapshotV1 | schemaVersion, workspaceId, sourceHash, engineVersion, entryCaseVersionIds, assets |
| CompiledAssetBundle | schemaVersion, sourceHash, engineVersion, compilerVersion, runnerSdkVersion, entrypoints, files, dependencies |
| ExecutionSnapshotV1 | schemaVersion, workspaceId, runId, caseExecutionId, caseVersionId, assetSourceHash, environmentVersionId, environment, roleKey, browser, variables, secretVersions, namespace, attemptNo; optional dataRow |

`FileEntry` is `{path, sha256, sizeBytes}`; paths exclude absolute paths, traversal and backslashes. The importer must additionally reject links, normalization collisions, oversized archives and inconsistent hashes. Dependencies are `{name, version, integrity}` with exact semantic version strings. Generated TS files are immutable artifacts and are identified by the file manifest; DSL remains editable source. `secretVersions` consists of `{secretRef, versionId}` references. attemptNo is 1 or 2, reflecting at most one whole-case retry.

T05 implements `compileAssets(snapshot, distribution) -> CompiledAssetBundle` and the actual-byte API `compileFiles`; `assembleExecution(bundle, executionSnapshot, files)` attaches execution context without changing verified source. See the T05 handoff below for the required engine distribution and cold-download file context. Publication/VALIDATE receipts must be bound to source hash, revision and engine version. Runtime must download authorized content-addressed artifacts and validate hashes before consuming them.

## Claim, leases and job manifests

`ClaimRequest` is `{runnerId, clientRequestId, availableSlots, capabilities}`. Capabilities contain exact engineVersion, os (`linux`/`win32`), arch `x64`, browsers and optional jobKinds. Server-registered capacity and grants remain authoritative. A clientRequestId is reused for claim recovery, rather than issuing another business execution.

Claim returns HTTP 204 when no eligible job exists. Success `ClaimDTO` contains jobId, jobKind, attemptId, leaseToken, fencingToken, expiresAt, serverTime, leaseDurationMs, activationRequired (true), snapshotUrl and snapshotSha256. The latter pair identifies exact downloaded job-manifest bytes. Tokens are transport-only secrets; never put them into snapshots/events/offline bundles.

The canonical DeviceToken download is GET `/internal/v1/workspaces/{workspaceId}/attempts/{attemptId}/content/{sha256}` (`downloadAttemptContent`). `claim.snapshotUrl` is the enrolled control-service origin plus this route for the assigned Attempt and `claim.snapshotSha256`, identifying the **job manifest**, not its subject. Before sending credentials, require the enrolled origin, claimed attemptId and canonical route; reject download redirects. After verifying manifest bytes/hash, its workspaceId must agree with the route Workspace and jobId/kind with the claim. The disconnected UUID snapshot-download route is removed.

Every download requires DeviceToken and current `X-VeriQ-Lease-Token` / `X-VeriQ-Fencing-Token` **headers**. Authorize current device/trust/grant, Workspace, assigned Attempt, unexpired lease and fencing, then require hash membership in that Attempt's frozen immutable closure. Knowing a hash never grants access. Unknown/out-of-closure content returns 404, invalid/revoked device tokens 401, unauthorized binding/requester 403, expired/stale lease proof 409. Redact proof headers from logs; never put them into URLs, manifests or ordinary events. Cached bytes still require authorization.

Return original `application/octet-stream` bytes without an envelope, transformation or JSON reserialization. Verify SHA-256 over exact received bytes before parsing/execution. All references use the same Workspace/Attempt route and proof headers:

| Reference | Exact downloaded content |
| --- | --- |
| `claim.snapshotSha256` | JobManifestV1 bytes |
| manifest `snapshotSha256` | Frozen AssetSnapshotV1 for VALIDATE; ExecutionSnapshotV1/retained cleanup context for TEST/CLEANUP |
| TEST `executionSnapshotSha256` | Same ExecutionSnapshotV1 subject; equals manifest snapshotSha256 |
| TEST `compiledBundleSha256` | CompiledAssetBundle descriptor bytes |
| compiled `files[].sha256` | File bytes; also verify sizeBytes, then use the validated bundle-relative path locally |

Claim → manifest → subject/bundle → files therefore needs no UUID lookup, guessed storage path or browser credentials. T09 implements this exact-byte Artifact pipeline and current assignment authorization; T12 extends storage, reporting and raw-evidence access policy.

`JobManifestV1` common fields are schemaVersion, workspaceId, jobId, snapshotSha256 and engineVersion. Its snapshotSha256 identifies the frozen subject snapshot, distinct from the outer claim's manifest hash. Kind-specific fields:

| kind | Additional required fields | Frozen subject |
| --- | --- | --- |
| TEST | caseExecutionId, caseVersionId, compiledBundleSha256, executionSnapshotSha256 | ExecutionSnapshotV1; snapshotSha256 and executionSnapshotSha256 must agree |
| VALIDATE | resourceId, revision, sourceHash | AssetSnapshotV1 of immutable draft-validation closure |
| CLEANUP | maintenanceId, fixtureVersionId, namespace, cleanupRef | Original execution snapshot/cleanup context retained by the maintenance record; cleanupRef is an opaque authorized reference, not a secret or arbitrary local path |

Workspace/subject/hash agreement and immutable cleanup provenance are server/Runtime semantic checks. TEST, VALIDATE and CLEANUP share the same claim/lease/terminal protocol. Only browser-requiring jobs occupy browser capacity; no duplicate queue or internal Cron is implied.

`HeartbeatRequest` carries leaseToken/fencingToken and progress `{phase, optional stepId/completedSteps}`; `HeartbeatDTO` returns leaseExpiresAt/cancelRequested/serverTime/leaseDurationMs. `EventBatchRequest` carries lease credentials and events; response `EventBatchDTO.acceptedThrough` is the contiguous accepted sequence. `FinishRequest` carries lease credentials, kind, outcome, manifestSha256, lastSequence and cleanupStatus; `FinishDTO` returns attemptId, accepted true, outcome and manifestSha256. Attempt outcomes exclude UNSTABLE, which belongs only to aggregates over retry history. T09 enforces expired leases, stale fencing, exact finish replay and quarantine reconciliation as described below.

## Execution events and results

`ExecutionEventV1` is a strict union with common schemaVersion, attemptId, sequence (positive safe integer), type, timestamp (RFC3339), optional stepId/assertionId, and a typed payload. Step-related events require stepId; assertion results also require assertionId.

| type | Payload shape |
| --- | --- |
| ATTEMPT_STARTED | engineVersion, sourceHash |
| PHASE_CHANGED | phase |
| STEP_STARTED | empty object |
| STEP_FINISHED | status, durationMs; optional errorCode/message |
| ASSERTION_RESULT | status, severity, expectedSource, expected, actual, durationMs; optional errorCode |
| OBSERVER_RESULT | observerId, matchedCount, windowMode, durationMs, ambiguous, correlated requests |
| VARIABLE_EXTRACTED | name, valueType |
| LOG | level, message |
| CLEANUP_RESULT | cleanupStatus; optional errorCode |
| ARTIFACT_CREATED | artifactId, file, kind |
| ATTEMPT_FINISHED | outcome, cleanupStatus |

`actual` is `{present:false}` for MISSING or `{present:true,value:<JSON>}` for present values, including null. Raw business/cleanup/evidence results must be retained by downstream reporting; an exit code does not establish complete success. Sequence continuity, duplicate handling, required evidence and outcome reduction remain server/report responsibilities.

## Offline contracts

`BundleManifestV1` requires schemaVersion, bundleId, workspaceId, issuerId, keyId, createdAt, expiresAt, sourceHash, snapshotSha256, engineVersion, validationStatus (`VALIDATED` / `UNVALIDATED_DEBUG`) and files. Signature is detached from the exact manifest bytes. Trust roots are established through authenticated enrollment or an administrator's verified out-of-band process, never self-established from the untrusted bundle.

`OfflineResultV1` requires schemaVersion, workspaceId, bundleId, localRunId, deviceId, source exactly `OFFLINE_IMPORT`, trustStatus, dirty, revocationStatus, manifestSha256, startedAt, finishedAt, aggregate outcome, actualEnvironment and attempts. Each attempt contains attemptId, caseVersionId, attemptNo, attempt outcome, cleanupStatus, lastSequence, typed events and artifact manifest. Imported trust claims are untrusted input: the server derives authoritative device trust from current records and must retain both submitted provenance and its verification result. A signature authenticates package origin/integrity, not the truth of a local execution report.

Import is idempotent on `(workspaceId, bundleId, localRunId)` and creates a distinct run, never overwrites an online attempt. Current membership, resource closure, authorized overrides, signatures, file hashes, schema/engine compatibility and limits are all required service checks beyond structural validation.

## HTTP contract

OpenAPI covers auth/session/reset/invitations; Workspaces/members; resource draft/validate/publish/version/dependents; runtime enrollment/grants/trust/revoke; execution plans/trigger, jobs/runs/cancel/rerun/events/reports/artifacts; bundles/imports; AI providers/generations/review; secret references; service accounts; external maintenance; and internal claim/heartbeat/events/uploads/finish/reconcile/credential resolution.

Successful JSON responses are `{data, requestId}`. Errors are `{code, message, details, requestId}`; details is JSON data. Stable machine error codes are separate from translated user messages. Paginated data is `{items, nextCursor}` with opaque cursor/null. Revisions are required on draft updates; conflicts return 409. Trigger/import/maintenance operations require Idempotency-Key; the same key with different arguments conflicts. The external prefix is `/api/v1`, device prefix `/internal/v1`.

POST resource `/validate` returns JobDTO. After polling completion, GET `/api/v1/workspaces/{workspaceId}/jobs/{jobId}/validation-receipt` (`getValidationReceipt`) exposes `ValidationReceiptDTOEnvelope` to authorized Workspace browser/service callers. Successful VALIDATE jobs return the server-created receipt; pending/failed/cancelled/non-VALIDATE jobs return 409 `VALIDATION_RECEIPT_UNAVAILABLE`, missing/inaccessible jobs 404. Receipt fields bind id, workspaceId, jobId, resourceId, revision, sourceHash, engineVersion, compiledBundleSha256 and validatedAt. Submit receipt id as `PublishRequest.validationReceiptId` with matching revision. Publish must reauthorize caller/resource and compare every binding to the current draft/engine; a known stale/foreign receipt ID cannot authorize publication.

Web sessions use Cookie plus CSRF; service tokens and device tokens are separate scopes. Every nested Workspace/version/runtime/attempt/artifact/import reference requires server authorization, including SSE replay and downloads. OpenAPI declaration is not authorization enforcement. Internal credential resolution requires current lease/fencing, approved trust/grant and frozen secretVersionId; never write returned values into ordinary events, command lines or bundle files.

## T03 implemented Workspace boundary

`auth.authorization` exports frozen `WorkspaceScope(workspace_id)` and `Actor(user_id, workspace_id, role, active=True)`, `Permission`, and `Authorization.require(actor, scope, permission)`. `Authorization.require_reference(scope, referenced_workspace_id)` rejects foreign nested references with 422 `INVALID_REFERENCE`. Actors must come from a current authenticated identity and database membership; request body roles and system administrator capability are not membership proof. `services.workspace.WorkspaceRepository(session, scope)` requires an explicit scope for `get`, `member`, `invite`, `authorize` and `protect_owner`. Workspace discovery is separately filtered to the current user's ACTIVE memberships. Future resources, batches, SSE, downloads, evidence and imports must use these checks and their actual scoped repositories; T03 does not implement those endpoints.

VIEW is available to all five active roles. EDIT allows OWNER/ADMIN/EDITOR; EXECUTE and DOWNLOAD also allow EXECUTOR; PUBLISH, MANAGE_ENVIRONMENT, MANAGE_MEMBERS and MANAGE_WORKSPACE allow OWNER/ADMIN. OWNERSHIP allows OWNER only, including granting/removing/changing another OWNER and archiving. Workspace roles never grant PRIVATE_DISPATCH: the future device service must check device ownership or explicit grants. ADMIN can manage nonowner roles but cannot grant OWNER. Only existing enabled ACTIVE members may be promoted to OWNER. Inactive memberships and globally disabled users do not contribute to the enabled OWNER invariant.

All Workspace/member/invitation mutations and existing global user-disable operations acquire the existing installation singleton lock **before identity and scoped reads** and hold it through commit. This serializes ownership changes with disable, account creation and invitation acceptance; no second explicit row lock is needed in these services. Future explicit locks follow Workspace ID then user/member/invite ID order, never the reverse. This intentionally favors a simple shared invariant over concurrent account/Workspace writes. A live Workspace must retain at least one enabled ACTIVE OWNER; conflicting removal/demotion/disable returns 409 `LAST_OWNER`. Archive is a one-way owner operation in this API: it retains membership and key, exposes read-only details/members and rejects further scoped writes or acceptance of pending invitations. Archived Workspaces are exempt from the live-owner invariant.

Implemented Web-session routes are GET/POST `/api/v1/workspaces`, GET/PATCH/DELETE `/api/v1/workspaces/{workspaceId}`, GET `.../members`, PUT/DELETE `.../members/{userId}`, GET/POST `.../invitations`, DELETE `.../invitations/{invitationId}` and POST `/api/v1/auth/invitations/accept`. DELETE on Workspace archives and returns EmptyEnvelope. Lists use the existing signed keyset Page helper (default25/max100, limit+1 query), caller/list/Workspace/filter-bound 24-hour cursors and stable key/ID or email/ID ordering. Workspace listing optionally filters `archived`; its default includes both live and archived memberships. Invitation lists expose status/email/role/expiry, never reusable token URLs.

Invitations use a random token stored only as SHA-256 digest, expire after seven days, and can be accepted once or revoked. Creation returns the copyable `invitationUrl` with a fragment token; optional `sendEmail` uses the existing configured SMTP adapter and returns delivery NOT_REQUESTED/SENT/FAILED. A failed delivery retains the returned usable copyable link. Existing-account acceptance requires its matching authenticated identity and a token-only request: it cannot replace its password, alter global privileges or reset sessions. New-account acceptance also requires password/displayName and creates an ordinary user without logging them in or replacing the inviter's session. Disabled accounts, mismatched identity, replay, expired/revoked invitations and existing membership are rejected. Tokens are scrubbed from browser history on invitation entry and retained in component memory; existing users can sign in inline without placing the token in a login URL.

Alembic `0002_workspaces` adds `veriq_workspaces`, `veriq_workspace_members`, `veriq_workspace_invites` and a nullable indexed Workspace foreign key on the existing `veriq_audit_logs`; global account events retain null scope. `service.audit` adds optional keyword-only `workspace_id`; existing call sites remain compatible. Workspace mutations record their scope transactionally. No duplicate account/audit tables or startup schema fallback exist.

The actual React `/workspaces` page supports selection/create/rename/archive, member role/status/removal and invitation create/copy/revoke with bounded load-more lists and loading/error/empty/permission states. React Query keys contain identity and Workspace. A route-lifetime WorkspaceProvider is keyed by authenticated identity; switching aborts scoped queries/mutations, removes scoped cached data, and disposes registered subscriptions. Leaving the route or changing identity cancels/clears its client and subscriptions. Selection is in memory for the route lifetime. There are no Workspace event subscriptions yet; downstream subscriptions must register their disposer with `useWorkspace().subscribe` and consume the scope lifetime signal. Server authorization remains authoritative after permission changes.

Canonical external-maintenance triggers are POST `/internal/v1/maintenance/expired-leases/reap`, `/internal/v1/maintenance/fixture-cleanups/reconcile`, `/internal/v1/maintenance/artifacts/expire` and `/internal/v1/maintenance/capacity/reconcile`. They use scoped ServiceToken authentication, required Idempotency-Key and bounded request limit. `MaintenanceDTO` returns id/status/processedCount/**hasMore** so an external scheduler can continue bounded batches; these paths do not add an internal Cron service.

## Packaging and handoff verification

Python loads `veriq_server/_schemas` through package resources. Hatch maps the canonical directory into wheels; editable development may read the checkout source. The T01 isolated wheel test validates every shared fixture from outside the checkout with no Node available. T02/T18 must keep this mapping while enforcing production static assets, migrations and version/license artifacts; a contract-only smoke wheel is not a product release.

Shared fixtures live in `packages/contracts/fixtures/compatibility.json`. Python and Node compare the same named acceptance results using actual validators; tests additionally cover host-language non-JSON values, generated public names, OpenAPI resolution, strict DTOs, envelopes and revision requirements. Application, database, browser, Windows, desktop, security authorization and release acceptance tests remain the responsibility of their modules.

## T02 account implementation

The real server now implements `/api/v1/setup`, existing auth/session/reset routes, `/api/v1/account` with password/session controls, and `/api/v1/admin/users` with create/list/update, session revoke and authorized reset-link issuance. Optional real SMTP reset delivery uses verified TLS and a reusable delivery protocol; no external email was sent during tests. OpenAPI is extended with strict setup/admin/account DTOs; `UserDTO` and `SessionDTO` keep their original fields. `AdminUserDTO` adds global `systemAdmin` capability separately from future Workspace roles. All implemented success/error bodies retain the canonical envelopes. Tornado's masked CSRF mechanism accepts the canonical `X-CSRF-Token` header.

Python startup exports `Settings`, `load_settings`, `Database`, and `make_app(settings, db)`; downstream authenticated handlers can subclass `handlers.base.API` and call `await self.identity(session)` or `await self.identity(session, admin=True)`. Session authentication checks token digest, UTC expiry and current disabled status. `identity` returns `(User, UserSession)`. Database operations use `async with db.sessions.begin() as session`; never run schema creation in a handler. See [development.md](development.md) for safe `veriq_server init/migrate/create-admin/doctor/serve`, separate Vite startup, and real MySQL/browser tests.

## T04 resource, validation and publication implementation

The resource routes in OpenAPI are now implemented with current session/membership authorization: create/list/get/update metadata, get/update draft, validation preview, queue validation, publish, list/get versions, direct published dependents, job polling and receipt retrieval. Service-token authentication remains a later integration; these implementations accept Web sessions and CSRF. Resource kind/key never change, archival retains the key, and version reads always bind both Workspace and resource. Dependents include any published version that directly references any version of the selected resource, including historical/archived dependents; drafts are not published impact edges. Lists are bounded and stable with signed cursors.

Python boundaries:

```python
ResourceService(session, user, registry=None)
await service.update_draft(scope, resource_id, expected_revision, document)  # DraftDTO
await service.preview(scope, resource_id)  # ValidationPreviewDTO
await service.validate(scope, resource_id, revision, source_hash)  # JobDTO, QUEUED
PublishService(session, user, registry=None)
await service.publish(scope, resource_id, draft_revision, receipt_id)  # ResourceVersionDTO
ResourceRepository(session, scope)  # resource/draft/version/job/receipt/artifact/store
```

Mutation callers must acquire `lock_installation(session)` **before** identity/scoped reads and retain the transaction through commit, as the handlers do. Services authorize current membership themselves; repositories are scoped persistence helpers for authorized services. `store` is content-addressed and checks retained bytes before reusing a digest. No public write API updates a version or creates a receipt. `0003_resources` extends the existing migration chain with resources/drafts/versions/dependency edges/artifacts/shared jobs/receipts and leaves existing account/Workspace data intact.

`DraftDTO.documentHash` is SHA-256 of RFC8785 `{kind,document}` bytes. The Web editor obtains the distinct closure hash using `GET /api/v1/workspaces/{workspaceId}/resources/{resourceId}/validation-preview`; response fields are `resourceId`, `revision`, `candidateVersionId`, `documentHash`, `sourceHash`, `engineVersion`. Submit `{revision,sourceHash}` to `/validate`. The server recomputes the closure and rejects `STALE_REVISION`/`STALE_SOURCE_HASH` with 409. Repeating the same resource/revision/source returns the same queued/completed job. Job polling is `/api/v1/workspaces/{workspaceId}/jobs/{jobId}`, successful receipt retrieval appends `/validation-receipt` (409 until one exists), and publication submits `{revision,validationReceiptId}`. Structural invalidity returns 400 at HTTP, kind mismatch/unknown typed references 422, and receipt mismatch 409. There is no client receipt mint endpoint.

`canonical_bytes(value)` in Python and `canonicalBytes(value)` in TypeScript return RFC8785 bytes. Python `asset_source_hash(snapshot)` returns SHA-256 hex; TypeScript `assetSourceBytes(snapshot)` returns the same exact identity projection bytes so Node can use crypto and browsers can use WebCrypto. The latter is browser-compatible and does not import Node crypto. Identity is exactly the frozen `{schemaVersion,workspaceId,engineVersion,entryCaseVersionIds,assets}` object; assets and entry IDs are emitted in sorted UUID order. Claimed `sourceHash` and `validationTarget` are not hashed. Each asset's `sha256` covers its `{kind,document}` envelope, not just the inner document. Package vectors and source fixture provide cross-language known bytes/digest. Bundle signing continues to cover exact retained manifest bytes.

For first non-CASE publication, `AssetSnapshotV1.validationTarget` contains `{resourceId,versionId,revision}` and permits `entryCaseVersionIds: []`. The deterministic candidate `versionId` is adopted unchanged at publication. Source bytes and hash therefore survive removal of validation metadata. `CompiledAssetBundle.validationOnly: true` requires zero entrypoints but actual nonempty files/dependencies. Compiler consumers must validate target membership, referenced kinds, unique assets/entry cases and hashes semantically; schema validation alone does not establish closure integrity. `entrypoints` now contains `{caseVersionId,path}` records. `ExecutionSnapshotV1.caseVersionId` and `TestJobManifestV1.caseVersionId` are required; T05 must select exactly the pinned case's entrypoint and reject a validation-only bundle for TEST. No random caseExecutionId-to-filename guessing or zero-case PASSED execution is allowed.

`IdentityReferenceRegistry.require_role(session,scope,role)` is the T07 seam for adapter/secret domains. Its default fails closed with `UNRESOLVED_IDENTITY_REFERENCE`; application composition can inject the registry as the Tornado `identity_reference_registry` setting. Asset references are read only from defined CASE catalog/fixture/dataset fields, SUITE cases/datasets, `callFlow.versionId` and `template.versionId`. UUID-looking fields in datasets, expected values, JSON Schema or parameters remain inert data. T05 owns compiler semantic checks such as variable binding, critical assertions and expansion limits; successful publication awaits its verified Runtime output.

The unified queue stores `kind=VALIDATE`, resource `subject_id`, `state=QUEUED`, immutable `snapshot_hash` and `manifest_hash`, a resource/revision/source idempotency hash, required engine/compile capability, actor/time and nullable active attempt. `ValidateJobManifestV1.snapshotSha256` identifies the retained AssetSnapshot bytes; the claim-facing manifest hash identifies exact job-manifest bytes. T09 extends this table with claims/fencing/leases/capacity. T04 never claims compilation completed. Receipt fixture seeding in resource tests is explicitly the T08–T10 completion boundary.

Publishable receipt provenance includes `runtimeId`, `attemptId`, `compilerTrust: MANAGED`, resource/revision, Workspace/job, source/engine and compiled descriptor SHA-256. T08–T10 must create it only after verified successful authorized completion under a valid lease/fencing token by an admin-approved **trusted compiler**, checking the approved engine/compiler/SDK/lockfiles and actual uploaded bytes. Authentication of a USER_REGISTERED personal Runtime plus matching caller-declared hashes does not prove generated code correctness. T12 must preserve this trust boundary before redistributing executable TS. Publication checks the recorded MANAGED provenance, finished job/active attempt, exact server snapshot/manifest, matching source/root/revision and all actual descriptor file hashes/lengths. No production receipt writer exists yet; pending jobs cannot publish. See [ADR 0005](decisions/0005-immutable-asset-validation.md).

Limits: 2 MiB canonical resource content, 2 MiB + 4096-byte create/draft transport envelopes, 64 KiB other operations, 3 MiB hard HTTP transport; closure maximum 1000 assets/depth 100/16 MiB; list default 25/max 100. A realistic >64 KiB dataset is exercised over real HTTP/MySQL. A larger transport allowance does not alter account form limits or add binary upload support.

Publication retries return an existing version only when its source hash, document hash, engine and previously bound receipt's compiled descriptor hash all match. A different engine/source requires a new draft revision; different compiled bytes for the same immutable revision return `REPRODUCIBILITY_CONFLICT` (409). Identical recompilation bytes may return the original version, preserving its original receipt and artifact identity.

## T05 compiler, actual files and T06/T10 handoff

`@veriq/compiler` is Node-only. Shared `@veriq/contracts` stays browser-portable; Tornado does not import or invoke the compiler. The public exports are:

```ts
validate(snapshot: AssetSnapshotV1): ValidationIssue[];
analyze(snapshot: AssetSnapshotV1): Analysis; // issues + typed compiled cases
compileFiles(snapshot: AssetSnapshotV1, distribution?: EngineDistribution): CompiledOutput;
compileAssets(snapshot: AssetSnapshotV1, distribution?: EngineDistribution): CompiledAssetBundle;
verifyFiles(bundle: CompiledAssetBundle, files: Record<string, Uint8Array>): void;
assembleExecution(bundle: CompiledAssetBundle, snapshot: ExecutionSnapshotV1,
                  files?: Record<string, Uint8Array>): ExecutionPackage;
resolvePointer(value: JsonValue, pointer: string): Presence;
resolveBinding(value: JsonValue, context: {data: JsonValue; vars: JsonValue}): JsonValue;
```

`ValidationIssue` has `path`, a semantic string `code`, and `message`; the compiler preserves canonical structural errors and adds semantic codes. `CompiledOutput` is `{bundle, files}`. `ExecutionPackage` is `{bundle, files, entrypoint, snapshot}` with independent copies; assembly neither mutates immutable files nor writes execution values into generated source. The optional signatures preserve a clear failure for old callers: omitted distribution throws `ENGINE_DISTRIBUTION_REQUIRED`, omitted assembly files throws `BUNDLE_FILES_REQUIRED`. No file bytes are hidden in process-global state or added to the strict wire descriptor.

`EngineDistribution` contains `engineVersion`, `runnerSdkVersion`, exact `packageJson`/`packageLock` Uint8Array bytes, the complete canonical `DependencyVersion[]` inventory and `files: Record<string, Uint8Array>` for local `vendor/` archives. This is the approved T20 engine release input to T10. The package must be ESM, use local `file:vendor/...` dependencies, have no root install hooks/dev/optional dependencies, and use npm lockfile v3. Locked packages cannot be links or have install scripts. Every package has an exact inventory version/SHA-512 integrity and a verified local archive; required lock dependency edges must resolve inside the supplied closure. Missing artifacts, mismatched SDK/engine/lock/integrity and undeclared files fail closed. The compiler does not download dependencies, inspect archive members, install them or attest caller-supplied code authenticity. T08–T10 still enforce the approved release/compiler trust boundary from ADR 0005, and the importer must safely extract verified archives.

All compiled files are returned, including case `.test.ts`, one shared `source/context.ts`, `source/asset-snapshot.json`, package.json, package-lock.json, dependencies.json and vendor archives. File entries cover exact bytes/sizes. CASE entrypoints map the pinned `caseVersionId` to `cases/<caseVersionId>.test.ts`; assembly checks that explicit mapping, rejects duplicates/missing files, and never derives a case from `caseExecutionId`. `source/asset-snapshot.json` is always a schema-valid AssetSnapshotV1 and is located by exported `SOURCE_SNAPSHOT_PATH`. After verifying the descriptor and every file hash, a cold Runtime validates that source context's document hashes, closure, source hash, engine, Workspace and selected case. It also checks role/secret version references, authorized origins and the selected frozen dataset row. Suite role/browser/dataset variants remain pinned in the source. Assembly requires at least one complete variant to match role, browser and data together: an effective dataset matches one of its exact frozen rows, while a variant with no CASE default or SUITE override dataset matches absence of dataRow. A no-data alternative is retained even when another otherwise matching variant uses a dataset.

SUITE targets select exactly the server-produced deduplicated case version IDs and emit executable entrypoints. The six true library kinds emit `validationOnly: true`, zero entrypoints, a real validation.ts exporting frozen asset data, and the same required dependency files. Their source sidecar retains validationTarget so zero-entry snapshots remain schema-valid. CASE/SUITE executable context strips validationTarget. A target-free context can retain exactly one SUITE whose deduplicated case set equals the selected entries; two matching roots or other unreachable assets are rejected. Validation-only output cannot be assembled as TEST, and zero-case execution never reports PASSED.

The generated executable ABI is an ESM named export from `@veriq/runner-sdk`:

```ts
interface RunnerSdkV1 {
  registerCase(plan: CompiledCase, source: AssetSnapshotV1): void;
}
```

`CompiledCase`, `CompiledStep` and `CompiledAssertion` now live in browser-portable `@veriq/contracts` and are reexported by `@veriq/compiler`; its `RunnerSdkV1` remains the registration ABI. `registerCase` registers the Playwright case; T10 supplies the separately verified ExecutionSnapshot through its SDK execution-context mechanism. Generated modules contain no run/attempt/machine paths, runtime variables/data row or secret values. T06 implements production registration and verifies generated TypeScript against the packaged actual SDK and Chromium following an offline npm install. The compiler's earlier fixture archive test remains an isolated packaging test.

A `CompiledStep` contains the action/observer/extraction `step` with generated wire ID, `sourcePath`, `before`, `responseAssertions`, `after`, and optional `children` for callFlow. Original step assertion lists are removed from the action payload; execute the compiled lists only. SDK phase order is before assertions → unique target resolution → register observers → action or nested children → responseAssertions → checked extraction → after → observation-window checks → disposal. Wrapper observers span the entire flow, including later children; all exits dispose them. Assertions depending on newly extracted vars occur in `after`; dependencies include the target recordKey/role name, inherited catalog scopes and template parameter bindings as well as assertion expected/query values. Response/schema checks that do not depend on those values occur before assignment. The SDK must still check response availability, extraction presence/type and optional-value absence at runtime.

Flow/template parameter declarations are scoped `data` names: evaluate supplied parameter values once in the caller's current scope, overlay `data` for that invocation, and restore it afterward. Flow `vars` extraction is shared in execution order. Each `CompiledAssertion.parameters` is the outer-to-inner template parameter-binding stack to apply around that assertion. Dataset values, JSON Schemas and values obtained from a binding stay inert; call `resolveBinding` only on fields marked interpolated by the canonical DSL. Full placeholders preserve JSON types; embedded interpolation accepts scalar values and rejects object/array/null. Missing values throw; `resolvePointer` distinguishes `{present:false}` from `{present:true,value:null}` and checks own properties only. Neither API uses eval or reinterprets braces inside resolved data.

Semantic checks cover all eight kinds: typed pinned references, unique identities, catalog scopes/targets/bindings, dataset columns and every row, fixture schema/output declarations, scoped parameters/variable use and types, observer sources, recursion/expansion, WRITE business result assertions and explicit persistence proof. Standalone flow/template libraries may retain caller-supplied data/vars/catalog/observer requirements; each concrete CASE validates them against its actual closure. Fixture JSON Schema inference uses declared properties, local refs and type unions; ambiguous types cannot satisfy a concrete action type. For a SUITE root, every distinct effective dataset (override or CASE default, including an absent dataset) is checked against the complete CASE binding/type requirements, including nested properties and row optionality; a dataset may be supplied solely by the SUITE. Validation still emits one CASE mapping, and standalone CASE roots require their own declared data context. Each apiRequest.headers value must resolve to a string; full-placeholder number/object/array values are rejected, while embedded scalar interpolation remains valid. Runtime schema checks remain required. Environment checks validate configured origins/locale/timezone and reference shape, not Workspace membership, secret plaintext or external identity registration; T07 owns those checks.

Maximum flow depth is five, expanded steps including call boundaries are 500 per case/library, and template depth is five. Assertion expansion visits at most 5,000 nodes per case/library, counting template calls as well as leaves; it returns `EXPANDED_ASSERTION_LIMIT` before allocating an unbounded repeated-template DAG. Wire step/assertion IDs are `v_` plus a SHA-256 expansion-path digest (66 characters), preserving canonical Key bounds even for long nested DSL IDs. Expansion paths remain separate readable metadata. WRITE critical steps require a non-WARN response-field business assertion; checkpoint proof uses a non-WARN persisted UI check after navigation/reload, read-only GET response field, or eventual GET query, with ordering after critical writes. Same-step eventual read-back is permitted. `CompiledCase.persistenceCheckpointStepId` maps the explicit DSL checkpoint to its generated wire ID.

The compiler supplies no validation receipt, queue worker, browser SDK, authenticated fixture adapter or draft/export HTTP endpoint. T10 must upload every actual emitted file and the exact descriptor to the existing VALIDATE completion path before publication; T12 reuses those retained bytes. A no-Runtime draft export remains DSL/dependency definitions marked unvalidated and cannot obtain executable artifacts from a missing engine distribution. See [ADR 0006](decisions/0006-deterministic-compiler-artifacts.md).

## T06 Runner SDK and T07/T10 handoff

`@veriq/runner-sdk` exports `registerCase`, `configureExecution`, `executeCase`, `executeStep`, `createStepContext`, `armObserver`, `armEvent`, `ObserverRegistry`, and their typed context/result/provider interfaces. SDK runtime imports only Playwright 1.65.0, contracts, Ajv 8.18.0 and ajv-formats 3.0.1; these exact dependencies already exist in the lockfile and notices. It neither imports the compiler runtime nor interprets a second DSL. Root `pnpm test` and `pnpm check` include the SDK; `pnpm --filter @veriq/runner-sdk test:coverage` enforces core line coverage >=75. Tests require `/usr/bin/chromium` in the current Linux development environment.

`executeStep(plan: ResolvedStep, context: StepContext): Promise<StepResult>` accepts the shared `CompiledStep`. `StepResult` extends the canonical step payload with readable sourcePath, assertions, observer summaries, nested children and internal event evidence. Assertion results preserve expectedSource, resolved expected, MISSING versus present-null actual evidence, severity, duration and error code. Response Schema values remain inert. Blocking failures stop the step; CONTINUE_FAIL fails it and WARN remains a warning. Case-level failurePolicy controls continuation without turning a failed case into PASSED. WRITE completion additionally requires a successful compiled persistence checkpoint with a non-WARN passing assertion.

`armObserver(spec: NetworkObserverV1, context)` returns `waitFirst`, `finalize` and idempotent `dispose`. Matching uses API origin, exact method/path and bound query/body subsets; retries must preserve complete request data. Action query values and observer queryMatch use the same URL normalization after safe binding: strings remain strings; numbers/booleans/null use their string form; outer arrays emit ordered repeated keys (empty arrays emit no key or match constraint); object values and nested arrays use canonical compact JSON. A singleton repeated value normalizes to the same wire string as a scalar. Query subsets compare these wire values, while JSON body matching remains type-strict. For query fields also present in a literal path, scalar/object values replace that key and array values append, preserving the action serialization behavior. Observers remain live through their declared window; no one-step result claims whole-run counts. An ordinary observer must acquire a request candidate within its timeout (and within its FIXED window, if any), even with no response assertions. Finalization alone does not require a completed response body. Explicit count windows validate the actual count; a zero-count FIXED window can succeed without a first response, but response/extraction consumers still require one. All branch exits release listeners and reject pending consumers. Event-handle `dispose()` returns a Promise; await it to finish download cancellation and partial-file cleanup. Direct low-level SDK callers must provide a bounded deadline/cancellation context and browser-origin protection; `executeCase` installs the context-wide allowlist guard for its lifetime. API redirects cannot carry a request into another origin, even if that origin is otherwise allowlisted; write redirects are rejected. Encoded paths are checked after decoding as well as before URL resolution.

ObserverV1 additionally accepts:

- `{id, kind:'dialog', dialogType:'alert'|'beforeunload'|'confirm'|'prompt', message, handling:'accept'|'dismiss', promptText?, timeoutMs?}`. Message comparison is exact after safe binding. promptText is legal only with accepted prompts. Unexpected and mismatched dialogs are dismissed and fail.
- `{id, kind:'newPage', pageKey, timeoutMs?}`. Capture is the action Page's popup, with no context-wide page race. Optional pageKey on steps and UI/URL assertions selects it; omission always selects the original case page. Wrapper declarations are visible to children/caller steps; flow-local declarations are restored on return. Before assertions and action selection precede that step's declarations. Compiler checks duplicates and order. Only network observer IDs can supply request/response assertions or extraction.
- `{id, kind:'download', timeoutMs?}`. Trusted `downloads:{directory,maxBytes}` is required; names are engine-generated and partial persistence is removed on error. Suggested filename is metadata only. The byte cap applies to persisted evidence; Playwright stages downloads before exposing their stream, so T10/T20 must also bound browser temporary storage and close the context. Captures retain typed internal evidence for T10 projection to existing STEP_FINISHED and ARTIFACT_CREATED events.

Event acquisition defaults to 15 seconds, bounded by the case deadline. One-shot observers fail on a second event until the end of the step. All captures are prearmed, including callFlow wrappers, and checked again after assertions/network windows. See [ADR 0007](decisions/0007-runner-sdk-events.md).

The production case entrypoints are:

```ts
configureExecution(provider: ExecutionContextProvider): void;
registerCase(plan: CompiledCase, source: AssetSnapshotV1): void;
executeCase(plan: CompiledCase, source: AssetSnapshotV1,
            options: ExecutionOptions): Promise<CaseResult>;
```

A trusted worker setup calls `configureExecution`, or sets `VERIQ_EXECUTION_CONTEXT_MODULE` to an absolute trusted ESM module exporting `createExecutionContext(info)`. The provider returns `{execution, lifecycle, credentials?, signal?, files?, downloads?, emit?, redact?}` separately from immutable generated source. T10 must verify source/bundle hashes, authorization and the frozen execution variant via compiler assembly before running this code. SDK checks ExecutionSnapshot schema and source/Workspace/case identity; it is not a replacement for release provenance or Workspace authorization. T10 supplies a browser context with service workers blocked so request routing cannot be bypassed by a service worker. The provider belongs to the trusted engine, never DSL input or an uploaded arbitrary script.

`LifecycleProvider.authenticate({page,execution,signal,credentials?})` must return a verified nonempty identityId, checked against allowedIdentityIds when configured. `CredentialProvider.resolve({workspaceId,secretRef,versionId},signal)` is the T07 version-pinned lookup seam; the SDK does not pretend to resolve credentials itself. If the case references a fixture, both `prepare(fixture,context)` and `cleanup(fixture,cleanupToken,context)` are mandatory. prepare returns `{variables,cleanupToken}`; core automatically registers cleanupToken with its evidence policy before validating output or projecting ordinary results, including generic providers. Variables must satisfy outputSchema before assignment. Cleanup runs after partial preparation (token may be undefined), business failure and cancellation, using its own bounded signal. Providers must honor their signal and perform real idempotent cleanup/compensation; T07 owns these integrations. Authentication and prepare budgets are 60 seconds each; business steps share 120 seconds; cleanup has 30 seconds. registerCase uses a 240-second Playwright timeout and retries zero. Runtime remains responsible for process supervision and fencing.

`CaseResult` includes outcome, businessOutcome, cleanupStatus, steps and optional errorCode. Missing required providers, invalid fixture output or cleanup failure never report PASSED. `emit` receives internal STEP_FINISHED/CASE_FINISHED messages through mandatory supplied redaction when emission is enabled; these are SDK messages, not new platform wire event kinds. Production registerCase always requires redaction for its JSON result attachment and fails Playwright on every non-PASSED outcome. T10 maps SDK details to canonical events/artifacts; secret masking, credential integration, evidence upload, runtime cancellation and OS packaging remain downstream responsibilities. The upload `files` provider resolves approved bundle paths to actual bytes; absent providers fail instead of supplying empty files.

## T07 fixture and identity handoff

The concrete decision and tested backend contract are in [ADR 0008](decisions/0008-fixtures-business-identity.md) and [backend integration](integration/backend.md). `CaseDslV1.fixtureInput` is an optional explicit binding object (empty when omitted), validated before side effects. `CaseDslV1.initialVariables?: ParameterTypes` declares required initial names/types using existing ValueType semantics; source contains no values. Frozen `ExecutionSnapshot.variables` supplies values. The portable `resolveInitialVariables(declarations, values): JsonObject` export validates own-property presence/type and returns only the declared subset for pre-prepare bindings (`INITIAL_VARIABLES_INVALID` on failure). Extra frozen variables remain compatible but cannot be fixtureInput symbols. Fixture-output name collisions fail `DUPLICATE_VARIABLE`. Static literal/data constraints use full Ajv; dynamic bindings use declared types and independently decidable constraints, then cold assembly/SDK validate the entire input schema against actual values before authentication. `LifecycleContext.fixtureInput` carries its resolved value separately; fixture cleanupToken never becomes an ordinary variable. Fixture prepare/query/cleanup methods are POST/GET/POST-or-DELETE respectively. `EnvironmentV1.fixtureIdentity` is paired with fixtureBaseURL and is distinct from business roles.

`AuthAdapterConfigV1` supports `HTTP_BEARER` and `HTTP_SESSION`, fixed relative identity/login paths and identityPointer. `AuthAdapterVersionV1` is `{workspaceId,versionId,contentHash,configuration}`. The Workspace registry is immutable with mutable revocation metadata outside frozen configs. Optional `AssetSnapshotV1.authAdapters` appears for actual Environment closures and enters the source JCS projection only when present, sorted using UUID text code-point order (Python/TS shared vectors). Normal CASE source remains environment-independent. `ExecutionSnapshotV1.authAdapters` freezes its selected role/fixture closure; compiler assembly requires exact IDs, hashes, workspace and secret pins with no extras. T09/T10 must supply registry-authenticated values, current revocation checks and the TEST manifest hash of exact full ExecutionSnapshot bytes. T14 retains the separate signed offline profile.

Implemented management routes are Workspace `/credentials` GET/POST, `/credentials/{secretRef}/versions` POST, `/credentials/{secretRef}/versions/{versionId}/revoke` POST, `/auth-adapters` GET/POST, and `/auth-adapters/{versionId}/revoke` POST. All require current MANAGE_ENVIRONMENT permission, including listings; listings have scoped signed cursors. Responses contain metadata/configuration only. Migration `0004_credentials` adds `veriq_secret_refs`, `veriq_secret_versions`, `veriq_auth_adapter_versions`; it uses existing Workspace membership, audit and resource mechanisms. No additional jobs/artifacts/receipts table is created.

`IdentityRegistry.require_role(session,scope,role)` checks exact Workspace references, version revocation and explicit identity allowlists; `freeze(session,scope,roles)` returns sorted public config snapshots. Authorization locks/reloads mutable adapter and secret rows in the resolution transaction, with deterministic adapter ordering, so revocation cannot cross the authorization/decryption point.

`POST /internal/v1/attempts/{attemptId}/credentials/resolve` takes `{secretRef,versionId}` and required Authorization, X-VeriQ-Lease-Token, X-VeriQ-Fencing-Token headers. It responds with `{secretRef,versionId,value}` inside the standard envelope and Cache-Control:no-store. Production uses `DenyAttemptProof`. T08/T09 inject `AttemptProofVerifier.verify(session:AsyncSession, attempt_id:str, proof:CredentialProofTransport)->VerifiedAttempt`. Transport holds authorization and lease_token (excluded from repr), plus fencing_token. The handler verifies the returned Attempt ID/caller fence; domain policy checks active/current fence, unexpired lease, current membership/grant and MANAGED trust. T09 implements these facts in `DatabaseAttemptProofVerifier` under the same installation lock. T07 domain tests still explicitly inject proof fixtures; T09 separately tests actual device/Attempt/credential integration.

Settings `master_key_id` defaults to `primary`; `previous_master_keys` is an external key-ID-to-hex32 map, also accepted as JSON through VERIQ_PREVIOUS_MASTER_KEYS. CLI initialization serializes nested secrets only to the restricted operator config, and resumed init preserves the existing active key bytes, ID and prior decrypt keys together. Rotation creates immutable credential versions and never substitutes one for a revoked pinned version.

`EvidenceFileEntryV1` extends file metadata with required `sensitivity` (`REDACTED` or `CREDENTIAL_RESTRICTED`); ARTIFACT_CREATED payload files, offline artifact manifests, ArtifactDTO and ArtifactUploadRequest propagate it. DOWNLOAD joins artifact kinds. Raw Trace/screenshots/downloads default restricted. `EvidencePolicy` redacts registered credential/session/cleanup values and auth/cookie/proof headers and excludes raw paths from ordinary projection. `executeCase` offers a trusted `restrictedEvidence` artifact sink for collected downloads; ordinary events/results have no raw path. This sink is an engine upload boundary, not end-user download authorization. T12 must enforce current Workspace/Attempt access plus MANAGE_ENVIRONMENT for restricted bytes, reject producer classification downgrades, and prevent ordinary export/report permissions from bypassing the policy. Raw screenshots and Trace are not claimed sanitized or ordinarily viewable.

## T08 Runtime and service-account handoff

[ADR 0009](decisions/0009-runtime-enrollment.md) defines the approved ownership and enrollment model. Migration `0005_runtimes` adds the five Runtime tables and the reusable `veriq_service_accounts` / `veriq_service_tokens` foundation. Exactly one real user or service account owns a Runtime. Bindings and explicit named-member / whole-Workspace grants are separate from trust and location. Device capabilities remain `DEVICE_REPORTED`; registration returns `OFFLINE`, without `lastSeenAt` or invented execution history.

`RuntimeService(session).approve_enrollment(actor: User, code, binding: workspace_id, grants, enrollment_id=...)` creates the owner-selected binding and returns Runtime metadata. `require_device(authorization)` returns the database-backed `(Runtime, RuntimeBinding, RuntimeToken)` after checking expiry, revocation, active binding and current user membership or service-account authorization. `require_dispatch(actor: User, workspace_id, runtime_id)` additionally checks current EXECUTE permission and private owner consent. These methods are transaction primitives: acquire `lock_installation` **before** identity/Workspace reads and retain it through the protected operation. HTTP handlers do so. T09 must join/lock its assignment, job actor, selected environment/credential grants, lease hash, fencing token and immutable pins in this same authorization transaction; T09 now installs `DatabaseAttemptProofVerifier`, deriving that complete proof from current database state. T04 jobs/artifacts/validation receipts are preserved; T09 adds Runtime/Attempt receipt FKs and the verified production completion writer; the T08 enrollment path itself never seeds compiler receipts.

Implemented human routes: `POST /api/v1/runtime-enrollments` (201), `/poll`, `/inspect`, and `/{enrollmentId}/approve`. Inspect/approve require the real Web session, Origin and CSRF. Native creation/poll use no cookie identity; cross-origin browser requests are rejected. Approval requires `userCode`, current executable Workspace membership, and explicit private / member / Workspace consent. Private plus named shares is invalid. Public code and polling secret are independently random and hashed, expire in ten minutes, and consumption is atomic. Creation is limited to twenty requests per source in ten minutes; pending polls enforce five seconds. Poll returns 409 `ENROLLMENT_PENDING`, 429 `ENROLLMENT_SLOW_DOWN`, or the single credential receipt. Restart enrollment after expiry, lost one-time receipt or consumed secret.

Implemented management routes are Workspace `/runtimes` GET with signed scoped pagination, `/{runtimeId}` GET, `/grants` PUT, `/trust` PUT and `/revoke` POST. Private devices are omitted from unauthorized lists and inaccessible even to Workspace/system administrators without owner consent. Only the real owner or current Workspace OWNER/ADMIN acting for its service account can change sharing or revoke a device. Any sharing change resets trust/delivery approval. Only a system administrator with current Workspace access and existing owner sharing consent may approve MANAGED. Credential delivery is a separate project authority: PUT `/runtimes/{runtimeId}/credential-delivery` with `RuntimeCredentialDeliveryWrite {allowCredentialDelivery:boolean}` requires current Workspace OWNER/ADMIN (MANAGE_ENVIRONMENT), existing owner consent and MANAGED trust to enable. A non-global project administrator can approve it after a separate system-admin trust decision. Combined `/trust` updates can enable delivery only if the actor additionally has MANAGE_ENVIRONMENT; trust demotion can clear it without project-secret authority. Global administration never creates membership or consent. Revocation denies new device operations and does not rewrite historical outcomes. T09/T11 own `gateAtExecution` versus `gateNow` on actual runs.

`GET /internal/v1/runtime`, `POST /internal/v1/runtime/token/rotate`, and `/logout` authenticate the bearer device token and never accept a Web cookie as proof. Device credentials expire after 24 hours; rotation atomically revokes the previous token. The CLI removes its local credential after successful remote logout or definitive HTTP 401 DEVICE_UNAUTHORIZED/DEVICE_REVOKED rejection, and retains it on transport/unknown failures. Explicit `logout --local-only` removes only the local credential without contacting or claiming revocation at the server; it leaves project assets/results untouched and advises Web revocation or expiry. Existing-profile login protection remains in force until this explicit cleanup. Token payloads, HTTP error logs and audits never contain raw credentials. `DeviceCredentialsDTO` preserves `runnerId`, includes the approved initial `workspaceId`, and optionally supports **paired** `issuerId`/`trustedKeys`. T08 omits both issuer fields; T14 must supply actual authenticated Ed25519 roots and fail bundle verification clearly while none exists.

The canonical Workspace `/service-accounts` GET/POST, `/{serviceAccountId}/tokens` POST, `/disable` POST and `/tokens/{tokenId}/revoke` POST implement the T16 identity foundation. Current OWNER/ADMIN authority is required. T08 token purpose is exactly `RUNTIME_ENROLLMENT`: 256 bits, ten minutes, one consumption, independently revocable, no trigger/maintenance/credential powers. `POST /internal/v1/runtime-enrollments/service` consumes it into a service-owned MANAGED_CLOUD Runtime bound to the account's Workspace; trust still starts USER_REGISTERED. Disabled accounts immediately fail device authentication. T16 must extend these identities/tokens rather than duplicate them. Other planned service-account APIs/scopes remain unimplemented.

Runtime wire descriptors and enrollment/credential receipts are canonical JSON Schema definitions, aliased by OpenAPI and consumed by generated TypeScript. The native client validates successful device responses with the existing `@veriq/contracts` validator. Real UI at `/runtimes` uses the authenticated Workspace provider, scoped/cancelled queries, explicit loading/empty/error/success states, device inspection, private/member/Workspace consent, trust/revoke management and deployment service accounts. It displays current trust without fabricated historical results.

## T09 — implemented unified execution service

Migration `0006_execution` extends the original `veriq_jobs` and reuses Workspace+SHA
`veriq_artifacts` and `veriq_validation_receipts`. Run, CaseExecution, Attempt, capacity,
resource lease, claim receipt, event, upload and maintenance receipt tables have typed
Workspace foreign keys. A TEST Job references its actual Run+CaseExecution; a CLEANUP
Job references its actual maintenance receipt and original Attempt. CaseExecution
references either a published version or an immutable draft candidate UUID plus source
artifact, never a fabricated published version. Completed compiler receipts bind an
actual Attempt of the same Runtime and Workspace.

`JobService(session, settings).claim(RuntimeIdentity(authorization), ClaimRequest)`
returns ClaimDTO or None. `LeaseService.heartbeat(attempt_id, proof, progress)` returns
HeartbeatDTO. `CredentialProofTransport` carries the device authorization, lease token
and fence without revealing secrets in repr. Every public transaction acquires
`lock_installation(session)` before identity and Workspace reads and retains it through
commit. Domain callers must do the same. Current device owner/account, binding/consent,
requesting human's EXECUTE authority (or the narrow CLEANUP service grant), active
Attempt, hash-only lease and fence are checked together. Current revocation denies
content, credentials, events, uploads and finish; heartbeat signals cancellation without
extending the lease. Cached artifacts confer no authority.

Run admission: POST `/api/v1/workspaces/{workspaceId}/runs`, with cookie/CSRF and an
`Idempotency-Key` (1–160 characters), accepts exactly one of `caseVersionIds`,
`suiteVersionId`, `draftValidationJobId`, plus `environmentVersionId`, `roleKeys`,
`browsers`, `runtimeIds`, optional `variables`, `executionLocation`, `maxRetries` (0/1).
Server-frozen variants retain suite ordinal, dataset version and row key, selected role,
browser, environment, public adapter config hashes, reference-only secret version pins,
initial variables and a unique attempt namespace. Selection never falls back to another
Runtime/location. DEBUG may await its immutable candidate's managed validation, and
only then materializes the executable manifest. A terminal failed validation causes the dependent DEBUG cases and Run to finish ERROR when the queue next examines them. `triggerKind` (MANUAL/DEBUG) is distinct
from execution source/location. At most ten unfinished Runs exist globally; zero cases
finish INCOMPLETE with `NO_CASES_SELECTED`. GET/list/cancel use the same Workspace API.
Service-token Run admission remains denied until T16 supplies a real scoped plan grant.

The actual device routes are:

| Method and path | Request / response |
| --- | --- |
| POST `/internal/v1/jobs/claim` | ClaimRequest → ClaimDTO or 204 |
| POST `/internal/v1/attempts/{id}/activate` | leaseToken, fencingToken → attemptId, activated:true, fencingToken |
| POST `/internal/v1/attempts/{id}/heartbeat` | HeartbeatRequest → HeartbeatDTO |
| POST `/internal/v1/attempts/{id}/events` | EventBatchRequest → acceptedThrough |
| POST `/internal/v1/attempts/{id}/artifact-uploads` | proof + kind, filename, contentType, sha256, sizeBytes, sensitivity → artifactId, uploadUrl, method:PUT, expiresAt |
| PUT returned uploadUrl + `?offset=N` | raw octets + proof headers → artifactId, receivedBytes, complete |
| GET `/internal/v1/workspaces/{ws}/attempts/{id}/content/{sha256}` | proof headers → original bytes |
| POST `/internal/v1/attempts/{id}/finish` | FinishRequest → saved FinishDTO |
| POST `/internal/v1/attempts/{id}/reconcile` | fencingToken, processStopped, cleanupStatus, stoppedAt → attemptId, capacityReleased, auditId |

POST requests use `Authorization: Bearer <DeviceToken>` and JSON proof fields. PUT/GET
use `X-VeriQ-Lease-Token` and `X-VeriQ-Fencing-Token`. Native routes reject a foreign Origin; an omitted or same-service Origin is allowed
under the existing DeviceAPI policy. Downloads are permitted before
activation to verify the immutable closure. Credentials, uploads, events and finish
require activation. T10 must reject redirects/unexpected origins and verify every hash.

A claim allocates one LEASED Attempt; it does not permit execution effects. Reusing the
same clientRequestId before activation rotates token+fence on that same Attempt without
extending its deadline. After activation a duplicate returns 409
`ATTEMPT_ALREADY_ACTIVATED`, grants no new authority and leaves healthy capacity held.
Repeated activation likewise returns 409. Lost activation responses require local
process reconciliation, never a second process. Empty claim receipts retain 204 for 24
hours and are bounded at 10,000 per Runtime; external reap removes old empty receipts.
Nonempty receipts follow retained Attempt lifetime. Clients never reuse request UUIDs.

Server DB UTC determines validity: lease60s, heartbeat10s, Run budget30min. Claim exposes
`expiresAt`; Heartbeat exposes `leaseExpiresAt`; both expose `serverTime` and
`leaseDurationMs`. T10 maps the claim expiry to `LeaseGrant.leaseExpiresAt` when calling
`apps/runtime/src/lease.ts::leaseDeadline(grant, monotonicSend, monotonicReceive)`. Its
one-second stop reserve and full-roundtrip deduction are independent of client wall
clock. It is a tested helper, not yet the T10 process supervisor.

Capacity acquisition orders global → Workspace → Runtime → environment → exclusive
resource keys under the installation lock. Browser limits remain global4/Workspace2;
compile and cleanup each default global2/Workspace1, Runtime total headroom1,
environment browser2. Settings `compile_slots`, `cleanup_slots`, `runtime_job_slots`
control the independent non-browser/Runtime budgets; reported availableSlots cannot
raise them. Expired unactivated Attempts release safely. Expired activated or explicitly
unknown processes finish ERROR/WORKER_LOST and retain QUARANTINED capacity. Unknown
reconciliation immediately revokes live authority and aggregates the Run. Confirmed
stop releases capacity idempotently; it cannot turn an existing failure into success.
A live stopped Attempt without a valid completion becomes INCOMPLETE and aggregates.

Uploads keep Tornado's existing 3MiB transport cap. A chunk is at most 1MiB, one file
32MiB, total declared Attempt upload budget256MiB, at most1,000 records. Exact repeated
metadata returns the same upload; chunks must be contiguous or exact byte replays.
Completion of upload verifies full SHA/size before storing in the existing immutable
Artifact table. Temporary bytes are not executable artifacts. Proof is checked on every
chunk, including replay; partial bytes on expired Attempts are cleared by external reap.
T12 owns File/S3 backends, retention/report UI and raw-evidence download ACL/redaction;
T09's closure-download endpoint does not expose arbitrary uploaded evidence.

Compiler `compileFiles` now emits `metadata/expected-plans.json`, hash/size listed in
CompiledAssetBundle. `ExpectedPlansV1` has schemaVersion and cases, each with
caseVersionId, optional persistenceCheckpointStepId, requiredEvidenceKinds (TRACE), and
flattened steps `{id, order, parentId?, failurePolicy, assertions, observers}`. Assertions
carry `{id, severity, stage}`. This comes from actual CompiledCase analysis; the controller
does not expand DSL. T10 must produce canonical lifecycle/step/assertion/observer events
and real evidence, including ARTIFACT_CREATED with the returned artifactId and matching
file/kind. Events are contiguous from sequence1; exact repeats are accepted, changed
repeats or gaps conflict. Explicit dependent SKIPPED results carry blockedByStepId and,
for a BLOCK assertion, blockedByAssertionId; missing results do not become skips.

`completion-manifest-v1.schema.json` aliases the new strict `CompletionManifestV1`
union; legacy `attempt-manifest-v1.schema.json` still aliases JobManifestV1. Common
completion fields are schemaVersion, kind, attemptId, jobManifestSha256, businessOutcome,
cleanupStatus, evidence (EvidenceFileEntryV1[]), requiredEvidence (SHA[]),
processStopped:true. TEST additionally requires caseVersionId and expectedPlansSha256;
VALIDATE success (businessOutcome:PASSED) requires compiledBundleSha256 and engineInventorySha256; VALIDATE failure (businessOutcome:ERROR) prohibits compiledBundleSha256 and requires engineInventorySha256, failureCode (1–80 uppercase ASCII letters/digits/underscores, leading letter), and at least one nonempty uploaded LOG in both evidence and requiredEvidence, linked by ARTIFACT_CREATED. Missing diagnostics are rejected, and this branch never mints a ValidationReceipt or permits publication. CLEANUP requires
fixtureVersionId and original namespace. Upload the completion bytes before calling
finish. `FinishRequest.outcome` is only a submitted claim: the server derives outcome
from trusted metadata, retained events and verified own uploads. TEST missing lifecycle,
expected results, required evidence or matching ARTIFACT_CREATED is INCOMPLETE; cleanup
FAILED is ERROR. Raw business/cleanup/evidence facts are retained independently. At most
one whole-case retry follows FAILED/ERROR, with a new namespace and Attempt; retry pass
aggregates UNSTABLE. Playwright retries remain0. Same-hash finished replay returns the
saved receipt even after lease expiry, under current device/requester authorization;
a different hash cannot overwrite it. Reconcile/reap never fabricate a PASSED receipt.

`approved_engine_inventory_path` is an operator-controlled JSON file validated as
ApprovedEngineInventoryV1. Missing/invalid inventory fails closed for managed compiler
claim/completion. Each exact engine binds compiler/SDK versions, dependency inventory,
and SHA/size for package.json, package-lock.json, dependencies.json, engine/compiler.tgz
and vendor archives. The completion inventory hash is SHA-256 of canonical engine-entry
JSON, not the whole catalog. Only fixed release paths may be approved. Uploaded catalog
content never grants approval. Actual uploaded descriptor/files, immutable source
sidecar bytes, selected CASE entrypoints, expected plan, and current MANAGED active
compiler proof are verified before minting the existing ValidationReceipt. Previously
published trusted receipts remain immutable provenance. T18/T20 promote the same actual
release bytes into this operator catalog; no production catalog is synthesized in T09.
Controller runtime needs no Node/Chrome. Tests use real emitted archives and a test-only
producer; TEST lifecycle/evidence fixtures prove the server protocol, not real T10
browser/Agent execution or trace validity.

Workspace Owner/Admin may issue `purpose:MAINTENANCE` on the existing service-token API,
with explicit operations from `expired-leases/reap`, `fixture-cleanups/reconcile`,
`capacity/reconcile`. Tokens are hash-only, reusable for24h, currently account/Workspace
scoped and revocable. RUNTIME_ENROLLMENT remains a separate consumed10min secret and
cannot authorize these operations. POST `/internal/v1/maintenance/{operation}` requires
that Bearer token, explicit workspaceId, limit (1–10,000), optional cursor and an
Idempotency-Key. Same request replays its saved result; changed parameters conflict.
Reap bounds each of expired-Run jobs, expired Attempts and old empty receipts by limit.
It cancels unstarted work after30min with RUN_TIMEOUT, terminates expired live authority,
and conservatively quarantines unknown active processes. Fixture and capacity scans
return hasMore/nextCursor; callers use a new idempotency key per page/iteration.
Capacity reconciliation verifies counters against held leases without blind release.

Compensation creates CLEANUP in the same queue only once per original Attempt. It waits
until original capacity is released and uses a shared Runtime and current scoped
maintenance grant. The pinned cleanup subject contains Workspace, original namespace,
fixtureVersionId/definition, environment, public authAdapters and engineVersion; no
plaintext cleanup credential. T10 supplies an HTTP-only fixture context and resolves
only that frozen fixture identity through the actual proof verifier (no dummy Page).
Owner/Admin POST `/api/v1/workspaces/{ws}/attempts/{id}/reconcile` requires
`processStopped:true` and a reason of10–1,000 characters; it releases only quarantined
or already released capacity and records a Workspace audit without changing outcomes.
No internal scheduler, parallel queue, bootstrap-as-requester or offline fake Job is added.

### T09 review correction: result order, blocking, cancellation and queue progress

Expected-plan assertion `stage` describes execution, not editable DSL syntax:
BEFORE → RESPONSE → AFTER → FINALIZE. The compiler marks `requestCount` as FINALIZE
from its actual CompiledAssertion type because the SDK defers it until observers finish.
Other assertions keep their compiled stage; neither DSL nor SDK behavior changes.
A deferred count cannot prove that an earlier AFTER assertion or child was prevented.

The reducer retains every negative business and ATTEMPT_FINISHED outcome. Conflicting
terminal facts make evidence INCOMPLETE (ERROR keeps its higher priority); passing
steps cannot erase a later business/origin failure. Execution facts must occur between
ATTEMPT_STARTED and ATTEMPT_FINISHED, with cleanup after business work. Only LOG and
ARTIFACT_CREATED notifications may form a post-terminal upload tail. Assertions and
observers stay inside their STEP_STARTED/STEP_FINISHED interval; executed children stay
inside parents, siblings follow compiled order, and assertion stages follow their actual
execution order. FINALIZE assertions follow observed results.

An explicit skipped assertion may name a previously failed BLOCK assertion in an earlier
execution stage/order of the same step. The blocking fact must precede the skip. An
ancestor can prevent unstarted child work only through a BEFORE BLOCK; the child still
requires an explicit SKIPPED step fact. A failed STEP_FINISHED may explicitly name its
own prior non-FINALIZE BLOCK using blockedByStepId/blockedByAssertionId when that block
prevented observer finalization. Missing observer results are then retained as
`blockedObservers` facts, never invented PASSED observations. Without that proof, missing
observers remain INCOMPLETE.

Cancelling a queued retry distinguishes a finished historical Attempt from a live
assignment. It immediately finishes Job/CaseExecution/Run, records
`reasonCode:USER_CANCELLED`, and aggregates retained Attempt history plus CANCELLED.
An earlier FAILED/ERROR therefore remains the more severe outcome; the immutable
Attempt result is unchanged and no replacement Attempt is claimed.

Claim applies stable Workspace/state/time/Runtime/location/engine/kind predicates in
SQL, then traverses successive100-row pages by `(created_at,id)` until the transaction's
finite queue is exhausted or one eligible Job is reserved. Dynamic requester, allowlist,
dependency, quarantine and capacity checks still run on each candidate. The installation
lock prevents concurrent enqueue/authorization mutation during this traversal and the
DB-time fence excludes newer rows. There is no fixed prefix or new cursor table. Memory
and each query are bounded by100; total work and installation-lock hold time remain
proportional to the existing matching queue, a conservative consistency tradeoff.

## T10 — online Node Agent and physical execution

`apps/runtime/src/execution/supervisor.ts` exports `ExecutionSupervisor.runAttempt`
with `{claim, requestStarted, responseReceived}` and an AbortSignal. It returns
`AttemptResult {completion?: CompletionManifestV1, stop: StopReceipt, files: LocalEvidence[]}`.
The assigned JobManifest is an input; only measured execution produces a completion.
No completion means reconciliation, never an exit-code-derived passing result.
`terminateAttempt(id, reason)` returns the confirmed/unknown physical stop receipt.

Development CLI: `runtime start --release-dir <operator-release> --browser-executable
<pinned-browser>` runs the Agent in the foreground; `--once` consumes at most one claim.
`runtime status` and `runtime stop` use a private authenticated Unix socket. SIGINT/SIGTERM
also request cancellation. A profile permits one Agent. Logout requires stopping it first;
local-only logout removes both the device credential and any pending rotation candidate.
It retains execution evidence and does not revoke a remote credential. Native Windows
job objects, installer process images and OS vault integration remain T20 boundaries.

The local release directory has `inventory.json` (ApprovedEngineInventoryV1) and exact
files at its declared paths. It is selected by the operator, never by an assigned job.
The server independently approves the same inventory. T10 verifies hashes, installs only
the approved local archives with npm offline/ignore-scripts, executes the actual archived
compiler, and compares TEST descriptors/files with deterministic recompilation before
registerCase can run. The release closure includes the compiler's already locked
TypeScript dependency in addition to SDK dependencies. T18/T20 must promote these exact
bytes; a developer test archive is not a published production engine.

Claims are journaled and activated before the gated worker starts. Lost activation replies
with no spawned worker reconcile as stopped. Linux ownership uses a random per-Attempt
nonce, actual execution UID and `/proc` start times, including detached browser groups and recorded descendants.
Current `/proc` owner UID is checked again before signalling; missing/mismatched journal UID remains unknown.
Unknown identity or a process that cannot be confirmed stopped preserves quarantine.
The existing monotonic leaseDeadline drives an independent watchdog; device wall-clock
changes cannot revive authorization. Polling after204 waits at least10 seconds and uses a
fresh UUID. Only a specific unacknowledged claim request reuses its journaled UUID.

A business child receives no device token or lease proof. A private per-Attempt Unix
channel resolves only frozen business/fixture references through the parent; responses
are bounded and credentials remain in private process memory. SDK `onEvent` reports
actual recursive starts, assertion/observer results, finishes and cleanup. The ordinary
callback uses EvidencePolicy/redaction; restricted paths and raw traces use a separate
sink. The provider sends only the final case summary, since live step facts have already
been sent. Explicit skipped facts originate at actual STOP/BLOCK branches. The existing
server expected-plan/order/completeness reducer remains authoritative.

Each TEST has a fresh work directory, Playwright Context and fixture namespace, retries0,
serviceWorkers:block and a real restricted trace. Chromium temporary paths use short
private directories to fit Linux Unix-socket limits. A100ms byte/file monitor covers
browser staging, unfinished downloads and traces (default64MiB/10,000 files); it stops all
owned groups on overflow. It does not follow Chromium singleton symlinks. This is a
measured detection-and-stop limit with scan/scheduling delay, not a kernel filesystem
quota. Canonical event buffering is bounded to4MiB/10,000 events and fails closed on
exhaustion. Confirmed shutdown removes regenerable dependencies/caches; acknowledged
completion and local evidence stay private for reporting/retention work.

CLEANUP uses the neutral `FixtureServiceContext`, containing only the original
workspaceId/caseExecutionId/attemptNo/namespace, fixture-only secretVersions/authAdapters
and the actual fixture environment fields. External maintenance obtains these from the
original Attempt snapshot, including Attempt2, never from a retry's current Job snapshot.
It removes business-role pins from the compensation subject. HTTP cleanup reuses the SDK
fixture authentication/identity/idempotency contract without a Page or browser. The
server's CLEANUP proof allows the fixture identity only. Compiler failure uploads a
nonempty sanitized stable-code LOG and the existing ERROR completion without a bundle.

Recoverable device rotation accepts either legacy `{}` or
`{clientRequestId: UUID, replacementToken: 32-byte unpadded base64url}` at the existing
rotate endpoint. The private store fsyncs a pending candidate before HTTP and atomically
replaces the same principal's profile after confirmation. The server stores only
predecessor/successor hashes and request UUID. Exact recovery is restricted to rotate and
requires the still-current authorized successor; the old token never regains ordinary
device authority. Renewal is serialized with bounded control operations at startup and
on a12-hour monotonic schedule. A changed candidate/request, revoked successor or current
owner/binding revocation fails closed.

Runtime `lastSeenAt` now records server DB time for an authorized claim or valid heartbeat.
The DTO reports ONLINE for communication in the last60 seconds, OFFLINE otherwise, with
REVOKED taking priority. Registration and GET do not refresh it. Stop/disconnection may
remain ONLINE until the TTL elapses; recent communication is not physical-process proof
and never releases quarantined capacity.

TEST `CompletionManifestV1.retrySafety` is an optional classification:
`READ_ONLY_OBSERVED | WRITE_POSSIBLE | UNKNOWN`; absent means UNKNOWN. Compiler-owned
`ExpectedPlansV1.cases[].hasPotentialWrites` is an optional boolean; absent is unknown,
not false. Compiler source analysis includes WRITE declarations and non-GET/HEAD/OPTIONS
API/observer methods recursively. Runtime observes business Context requests (including
frames/popups), WebSocket activity and SDK business API calls, retaining only the category.
The trusted provider closes the complete business Context before read-only confirmation;
missing closure/window is UNKNOWN. Auth/fixture HTTP stays separate; service workers block.

The original completion service queues its one whole-case retry only with genuine fixture
closure (`cleanupSnapshotSha256` from the trusted producer plus SUCCEEDED cleanup), or both
trusted `hasPotentialWrites:false` and actual `READ_ONLY_OBSERVED`. Other failures retain the
original terminal outcome and record `retryReasonCode:RETRY_SAFETY_UNCONFIRMED` in Attempt
facts. Fake SUCCEEDED cleanup without a fixture does not authorize replay. A no-fixture write
whose response is lost is never automatically retried; a truly read-only failed Attempt can
still retry in a fresh Context/workdir and become UNSTABLE after passing. Business-key inquiry
and explicit user decisions for a new Run remain outside this narrow automatic retry gate.

`StepFinishedPayloadV1.status` also accepts `CANCELLED` for an actual interrupted operation.
The SDK uses explicit abort-versus-operation settlement, preserving a failure observed first;
it does not infer cancellation from arbitrary error text or erase an existing failed assertion.
An unfinished assertion interrupted by abort emits no fabricated ASSERTION_RESULT. The step
reports its interruption and CASE_FINISHED retains any earlier FAILED business facts. The
existing reducer and its cancellation completeness rules remain unchanged.


T10 fix1 supersedes stop-time process scanning as positive proof. The fixed installed Linux
`build/veriq_runner` guardian sets `PR_SET_CHILD_SUBREAPER` before forking the worker, then
keeps a private gate closed until Node has fsynced both PID/UID/start-time identities.
Activation is acknowledged before this launch path. The original Node worker IPC remains
FD3; guardian-only status/control use FD4/FD5 and are closed in the worker before exec.
Kernel adoption retains detached, empty-environment descendants after parent exit. `/proc`
PPID enumeration is used to signal direct children, never to prove an empty tree. The
single spawn gate must be closed and `waitpid(-1)` must return ECHILD before the guardian
fsyncs its private nonce/UID/guardian+worker identity-bound DRAINED proof. Positive stop also
requires guardian exit. Guardian loss, missing proof, changed UID/start time and bounded
stop failure remain unknown/quarantined; legacy journals without containment proof are not
silently upgraded. Agent control EOF triggers guardian cleanup. See ADR0012 for the local ABI.

A pending claim UUID is now copied to its assigned private Attempt journal before execution.
Recovery clears `claim-request.json` only when that same UUID was successfully reconciled;
retained historical journals, including older journals without this association, cannot
clear an unrelated newer lost request. The server claim/fence/lease protocol is unchanged.

## T11 shared editors and published source view

The Web resource/editor components accept `ResourceAdapter` instead of hard-coded remote
URLs. `CloudResourceAdapter` owns authenticated transport; `LocalResourceAdapter` is
read-only and accepts a single-Workspace immutable snapshot already verified by a trusted
host/provider. It does not implement signature verification, offline editing or sync.
React Hook Form holds the canonical source document, and local Monaco JSON buffers require
explicit Apply. Unapplied buffers block save/validate/publish; invalid JSON and409 revision
conflicts retain local content. All eight kinds expose graphical controls. Initial variable
controls declare types only, not runtime values. Source models/workers and Query state are
disposed or aborted on authenticated-user/Workspace/editor lifetime changes.

Existing `GET /api/v1/workspaces/{ws}/jobs/{job}` now includes actual optional `outcome`,
`waitReason` and a safe `errorCode` projected from the active retained Attempt. No detailed
compiler path or raw LOG is inferred. `GET .../validation-receipt` remains the only existing
successful receipt read; pending or failed validation never enables publication. Richer
structured compile diagnostics remain a T12 report-pipeline handoff.

`GET /api/v1/workspaces/{ws}/resources/{resource}/versions/{version}/compiled-source`
requires current Workspace VIEW and the resource/version's original retained receipt.
Without `path` the JSON data is `{descriptorSha256, files: FileEntry[]}`, listing only
`validation.ts`, `source/context.ts` and compiler case entrypoints `cases/{uuid}.test.ts`.
With a listed `path`, it returns the exact retained bytes as `text/plain; charset=utf-8`,
without an envelope, after descriptor membership/hash/length verification. The response is
private/no-store, nosniff and sandboxed. Arbitrary hashes, local filesystem paths, archives,
raw evidence and non-TypeScript members are unavailable. Generated TypeScript is displayed
read-only and is never compiled or executed in the frontend. The published version's receipt
and descriptor remain immutable even after later draft changes or revalidation.
