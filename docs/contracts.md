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
| ExecutionSnapshotV1 | schemaVersion, workspaceId, runId, caseExecutionId, assetSourceHash, environmentVersionId, environment, roleKey, browser, variables, secretVersions, namespace, attemptNo; optional dataRow |

`FileEntry` is `{path, sha256, sizeBytes}`; paths exclude absolute paths, traversal and backslashes. The importer must additionally reject links, normalization collisions, oversized archives and inconsistent hashes. Dependencies are `{name, version, integrity}` with exact semantic version strings. Generated TS files are immutable artifacts and are identified by the file manifest; DSL remains editable source. `secretVersions` consists of `{secretRef, versionId}` references. attemptNo is 1 or 2, reflecting at most one whole-case retry.

The planned compiler interface is `compileAssets(AssetSnapshotV1) -> CompiledAssetBundle`; `assembleExecution(bundle, ExecutionSnapshotV1)` attaches execution context without changing verified source. T01 provides the contracts, not those implementations. Publication/VALIDATE receipts must be bound to source hash, revision and engine version. Runtime must download authorized content-addressed artifacts and validate hashes before consuming them.

## Claim, leases and job manifests

`ClaimRequest` is `{runnerId, clientRequestId, availableSlots, capabilities}`. Capabilities contain exact engineVersion, os (`linux`/`win32`), arch `x64`, browsers and optional jobKinds. Server-registered capacity and grants remain authoritative. A clientRequestId is reused for claim recovery, rather than issuing another business execution.

Claim returns HTTP 204 when no eligible job exists. Success `ClaimDTO` contains jobId, jobKind, attemptId, leaseToken, fencingToken, expiresAt, snapshotUrl and snapshotSha256. The latter pair identifies exact downloaded job-manifest bytes. Tokens are transport-only secrets; never put them into snapshots/events/offline bundles.

The canonical DeviceToken download is GET `/internal/v1/workspaces/{workspaceId}/attempts/{attemptId}/content/{sha256}` (`downloadAttemptContent`). `claim.snapshotUrl` is the enrolled control-service origin plus this route for the assigned Attempt and `claim.snapshotSha256`, identifying the **job manifest**, not its subject. Before sending credentials, require the enrolled origin, claimed attemptId and canonical route; reject download redirects. After verifying manifest bytes/hash, its workspaceId must agree with the route Workspace and jobId/kind with the claim. The disconnected UUID snapshot-download route is removed.

Every download requires DeviceToken and current `X-VeriQ-Lease-Token` / `X-VeriQ-Fencing-Token` **headers**. Authorize current device/trust/grant, Workspace, assigned Attempt, unexpired lease and fencing, then require hash membership in that Attempt's frozen immutable closure. Knowing a hash never grants access. Unknown/out-of-closure content returns 404, unauthorized/revoked devices 403, expired/stale lease proof 409. Redact proof headers from logs; never put them into URLs, manifests or ordinary events. Cached bytes still require authorization.

Return original `application/octet-stream` bytes without an envelope, transformation or JSON reserialization. Verify SHA-256 over exact received bytes before parsing/execution. All references use the same Workspace/Attempt route and proof headers:

| Reference | Exact downloaded content |
| --- | --- |
| `claim.snapshotSha256` | JobManifestV1 bytes |
| manifest `snapshotSha256` | Frozen AssetSnapshotV1 for VALIDATE; ExecutionSnapshotV1/retained cleanup context for TEST/CLEANUP |
| TEST `executionSnapshotSha256` | Same ExecutionSnapshotV1 subject; equals manifest snapshotSha256 |
| TEST `compiledBundleSha256` | CompiledAssetBundle descriptor bytes |
| compiled `files[].sha256` | File bytes; also verify sizeBytes, then use the validated bundle-relative path locally |

Claim → manifest → subject/bundle → files therefore needs no UUID lookup, guessed storage path or browser credentials. Addresses/proof requirements are canonical; storage and HTTP authorization implementations remain downstream.

`JobManifestV1` common fields are schemaVersion, workspaceId, jobId, snapshotSha256 and engineVersion. Its snapshotSha256 identifies the frozen subject snapshot, distinct from the outer claim's manifest hash. Kind-specific fields:

| kind | Additional required fields | Frozen subject |
| --- | --- | --- |
| TEST | caseExecutionId, compiledBundleSha256, executionSnapshotSha256 | ExecutionSnapshotV1; snapshotSha256 and executionSnapshotSha256 must agree |
| VALIDATE | resourceId, revision, sourceHash | AssetSnapshotV1 of immutable draft-validation closure |
| CLEANUP | maintenanceId, fixtureVersionId, namespace, cleanupRef | Original execution snapshot/cleanup context retained by the maintenance record; cleanupRef is an opaque authorized reference, not a secret or arbitrary local path |

Workspace/subject/hash agreement and immutable cleanup provenance are server/Runtime semantic checks. TEST, VALIDATE and CLEANUP share the same claim/lease/terminal protocol. Only browser-requiring jobs occupy browser capacity; no duplicate queue or internal Cron is implied.

`HeartbeatRequest` carries leaseToken/fencingToken and progress `{phase, optional stepId/completedSteps}`; `HeartbeatDTO` returns leaseExpiresAt/cancelRequested. `EventBatchRequest` carries lease credentials and events; response `EventBatchDTO.acceptedThrough` is the contiguous accepted sequence. `FinishRequest` carries lease credentials, kind, outcome, manifestSha256, lastSequence and cleanupStatus; `FinishDTO` returns attemptId, accepted true, outcome and manifestSha256. Attempt outcomes exclude UNSTABLE, which belongs only to aggregates over retry history. Expired leases, stale fencing, idempotent finish replay and quarantine reconciliation are service requirements.

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

Canonical external-maintenance triggers are POST `/internal/v1/maintenance/expired-leases/reap`, `/internal/v1/maintenance/fixture-cleanups/reconcile`, `/internal/v1/maintenance/artifacts/expire` and `/internal/v1/maintenance/capacity/reconcile`. They use scoped ServiceToken authentication, required Idempotency-Key and bounded request limit. `MaintenanceDTO` returns id/status/processedCount/**hasMore** so an external scheduler can continue bounded batches; these paths do not add an internal Cron service.

## Packaging and handoff verification

Python loads `veriq_server/_schemas` through package resources. Hatch maps the canonical directory into wheels; editable development may read the checkout source. The T01 isolated wheel test validates every shared fixture from outside the checkout with no Node available. T02/T18 must keep this mapping while enforcing production static assets, migrations and version/license artifacts; a contract-only smoke wheel is not a product release.

Shared fixtures live in `packages/contracts/fixtures/compatibility.json`. Python and Node compare the same named acceptance results using actual validators; tests additionally cover host-language non-JSON values, generated public names, OpenAPI resolution, strict DTOs, envelopes and revision requirements. Application, database, browser, Windows, desktop, security authorization and release acceptance tests remain the responsibility of their modules.

## T02 account implementation

The real server now implements `/api/v1/setup`, existing auth/session/reset routes, `/api/v1/account` with password/session controls, and `/api/v1/admin/users` with create/list/update, session revoke and authorized reset-link issuance. Optional real SMTP reset delivery uses verified TLS and a reusable delivery protocol; no external email was sent during tests. OpenAPI is extended with strict setup/admin/account DTOs; `UserDTO` and `SessionDTO` keep their original fields. `AdminUserDTO` adds global `systemAdmin` capability separately from future Workspace roles. All implemented success/error bodies retain the canonical envelopes. Tornado's masked CSRF mechanism accepts the canonical `X-CSRF-Token` header.

Python startup exports `Settings`, `load_settings`, `Database`, and `make_app(settings, db)`; downstream authenticated handlers can subclass `handlers.base.API` and call `await self.identity(session)` or `await self.identity(session, admin=True)`. Session authentication checks token digest, UTC expiry and current disabled status. `identity` returns `(User, UserSession)`. Database operations use `async with db.sessions.begin() as session`; never run schema creation in a handler. See [development.md](development.md) for safe `veriq_server init/migrate/create-admin/doctor/serve`, separate Vite startup, and real MySQL/browser tests.
