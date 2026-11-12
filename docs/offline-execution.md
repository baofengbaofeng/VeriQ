# VeriQ disconnected execution and result import

Use the existing trust binding and signed bundle verification workflow in [offline bundles](offline-bundles.md). Execution rechecks the installed tree's exact signature, member list and hashes, captures the verified bytes, and uses the existing isolated Node worker/compiler/SDK. A JavaScript `VerifiedBundle` object is not an authorization credential. Known revoked keys are rejected; offline revocation remains UNKNOWN. The control platform is not contacted while running; the business system and fixture endpoints must remain reachable.

Development Linux commands, from `apps/runtime`:

```sh
pnpm build:launcher
pnpm dev --config-dir /private/veriq run --offline /private/bundle --release-dir /private/engine --browser-executable /installed/chromium
pnpm dev --config-dir /private/veriq results history --workspace WORKSPACE_UUID
pnpm dev --config-dir /private/veriq results report LOCAL_RUN_UUID --workspace WORKSPACE_UUID
pnpm dev --config-dir /private/veriq results cancel LOCAL_RUN_UUID --workspace WORKSPACE_UUID
pnpm dev --config-dir /private/veriq results recover
pnpm dev --config-dir /private/veriq results upload LOCAL_RUN_UUID
```

`--debug` explicitly admits expired/unvalidated signed bundles and records dirty provenance. DSL-only DEBUG compiles the original immutable candidate with the matching installed approved engine; compiler diagnostics are retained and no published version or validation receipt is invented. Missing local credentials record `LOCAL_CREDENTIAL_MISSING`. Set exact issuer/Workspace/reference/version mappings using the existing secret-stdin command. Secrets are resolved only in the native host and private broker; the restricted file store is a development seam, with OS vault integration owned by packaging.

`--base-url` and `--fixture-url` explicitly authorize public routing changes and make the run dirty. Other engine, authentication or code overrides are not supported. The typed host requires an authorization callback for routing changes. `--retry` permits at most one safe whole-case retry using observed read safety plus compiler expectations, or successful declared fixture cleanup. A retry pass yields UNSTABLE and a new fixture namespace. Playwright retries remain zero.

A private Node SQLite database (`veriq_` tables, WAL/FULL synchronous commits) holds one local execution context across processes. Run checkpoints, canonical ordered events, cancellation requests, reports, stop receipts and upload retry state survive reopening. The Linux guardian's durable drain proof and exit authorize physical stop; unknown ownership remains quarantined. `results recover` explicitly reconciles an interrupted host. Cancellation requests do not claim physical stop until this proof exists. The CLI execution host is named `veriq`; the existing supervised workers use `veriq_runner`.

`LocalReports.snapshot(workspaceId, runId)` returns the shared report adapter shape without importing the browser API module. The raw accessor validates nested IDs, a host authorization callback, exact size and checksum; it never supplies arbitrary renderer filesystem access. Existing `trace open` invokes the pinned local Playwright viewer. Desktop IPC, GUI controls and packaged Windows/native viewer acceptance remain T19/T20.

Upload is explicit and uses separately enrolled device configuration, never an issuer routing label from out-of-band metadata. Failed requests remain PENDING locally and can be retried. Artifacts use authenticated reservations and at most 1 MiB chunks, with 32 MiB per file, 1000 upload reservations per local run, bounded responses and exact-origin/no-redirect transport. Result JSON is bounded to 8 MiB. Raw bytes never enter JSON/base64 and remain private attachments (`application/octet-stream`, sandbox CSP).

Public imports require Cookie/CSRF, current EXECUTE and DOWNLOAD, plus EDIT for draft content. Native routes require a current user-owned enrolled device and current owner/Workspace execution authority. Import authorization is repeated after external work and on replay. Domain identity `(workspace, bundle, localRunId)` and header-key aliases are immutable; a changed body returns409. Each import creates a distinct OFFLINE_IMPORT Run and separate offline attempt records, without online Attempt/lease/fencing/capacity writes.

The server retains declared facts separately from verified bundle/current-authority facts, reduces outcomes using retained compiler expectations and canonical events, and always returns `officialGatePassed: false`. Claimed MANAGED/CURRENT fields do not elevate trust. Older results lacking variant facts or DEBUG results lacking a signed expected plan import conservatively as INCOMPLETE. Imported event views retain structural facts and withhold dynamic values because local vault values are unavailable to the server; local reports retain the SDK's sanitized details. Raw access uses the existing MANAGE_ENVIRONMENT permission. Pending publication recovery, shared aliases and irreversible empty retirement fences are shared with the online File/S3 evidence lifecycle. Maintenance continuations are opaque: replay the returned nextCursor with a new request key until hasMore is false; online then offline phases share the requested limit. Replaying the same key/body returns the same receipt.

Native execution currently has Linux physical-stop evidence. Apt Chromium156 used in development differs from Playwright1.65's expected browser158; this is not the matched-browser formal SDK gate. Windows native/process/vault/installer acceptance and the outstanding official SDK browser gate remain separate release work. No Provider or model is used by deterministic execution.

The result records permitted fallback browsers in `executionChoices.browsers`; older results default to Chromium. A signed SUITE's explicit browsers, roles and dataset rows take precedence. Imports account for the complete signed matrix (maximum 1000 variants), displaying absent work as INCOMPLETE with no fabricated attempts. Published SUITEs use their own original compiled source; draft SUITEs use the exact signed draft source and remain conservative DEBUG imports.

An old result without execution facts can be imported only when its CASE has one unambiguous selected variant. `OFFLINE_VARIANT_FACTS_REQUIRED` (HTTP 422) means the server cannot safely attribute its facts. Retain the local report and pending upload for inspection; the client does not rerun business actions automatically. Current hosts record variant identity durably before launch, including when later recovery is needed.
