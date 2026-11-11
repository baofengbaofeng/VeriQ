# ADR 0010 — Unified queue and verified execution boundaries

Status: coordinator-approved T09 implementation choices; implementation evidence is recorded separately.

All jobs remain in `veriq_jobs`. Run admission freezes Workspace-authorized published
assets or an immutable draft candidate, environment, role, browser, dataset version,
row and suite ordinal. Candidate UUIDs never pretend to reference published rows.
Trigger kind, source/location and the exact requested Runtime selector remain separate.
Service Run principals require actual scoped grants; enrollment secrets never authorize runs.

Every protected operation holds the existing installation authorization lock before
current device and requester reads through commit. Capacity locks follow global,
Workspace, Runtime, environment, resource order. Defaults are four global and two
Workspace browser slots; compilation and cleanup have independent global defaults of
two, Workspace one, and server-configured Runtime total headroom one. Claims never
increase headroom from availableSlots. At most ten unfinished Runs are admitted.

Allocation is not activation. Hash-only lease secrets authorize a LEASED Attempt;
explicit acknowledged activation must precede authentication, fixtures and business
side effects. Recovering an unactivated request rotates both token and fence. An
already activated request returns conflict without new authority and without
quarantining a healthy execution. Unknown processes after expiry retain their slots
and resource locks until original-device stop confirmation or scoped audited admin
reconciliation. Server database UTC grants 60-second leases and Runtime sends a
10-second heartbeat. Local deadlines use monotonic request roundtrip budgets,
never a comparison against the device wall clock.

Empty (204) claim receipts have a documented 24-hour recovery window and a hard
per-Runtime admission bound; external maintenance removes eligible old empty receipts.
Nonempty receipts remain tied to the retained Attempt and cannot allocate another business
execution. Clients must never reuse request UUIDs. No internal timer
or Cron is added. MAINTENANCE tokens are Workspace scoped, hash-only, independently
revocable, and explicitly limited to named operations; enrollment tokens remain
one-time and unable to call maintenance. Ordinary service-account disabling applies.

ApprovedEngineInventoryV1 is operator-controlled configuration, unavailable by default.
It binds engine/compiler/SDK versions and exact release package, lock, code, vendor
bytes and dependencies. Uploaded inventories cannot approve themselves. Generated
CASE files and expected-plan metadata are authenticated by current MANAGED compiler
identity plus active lease/fence and checked against retained source/descriptor bytes.
The controller never runs Node or Chrome. T18/T20 must promote the same release bytes.

CompletionManifestV1 is separate from the legacy attempt-manifest alias for JobManifestV1.
Compiler analysis emits expected step/assertion/observer identities and dependency
metadata into a hash-listed file. Server reduction checks actual retained events,
explicit justified skips and required evidence; missing metadata cannot imply PASSED.
Raw business, cleanup and evidence results remain distinct. Exact successful finish
replays use the saved receipt under current authorization; differing manifests cannot
overwrite a terminal result. T12 extends this retained-byte pipeline for File/S3,
retention, reports and UI; it does not introduce another receipt writer or queue.

Artifact uploads retain the 3 MiB transport ceiling. Bounded proof-authorized chunks,
explicit offsets and exact hashes avoid increasing pre-auth buffering on other routes.

T09 implementation refinement: explicit unknown-process reconciliation immediately
terminalizes the Attempt as ERROR/WORKER_LOST, aggregates CaseExecution/Run and quarantines
capacity; a later stop only releases capacity and preserves outcome. A live confirmed
stop without verified completion is INCOMPLETE. External reap also enforces the30-minute
Run budget on bounded queued jobs, marking unstarted cases CANCELLED/RUN_TIMEOUT and
aggregating; active unknown processes retain quarantine. No timeout implies success.

The database enforces TEST Run+CaseExecution and CLEANUP maintenance-receipt/original-
Attempt subject relationships, source artifact references, published-or-candidate CASE
identity, Attempt phase/fence bounds and compiler receipt Runtime+Attempt provenance.
MySQL migration preserves existing queued VALIDATE identities and source bytes.

Writer hardening checks the exact retained source sidecar against frozen source (CASE
projection omits validationTarget, library validation retains it), selected entrypoint
paths and validationOnly boundary. Evidence requires a retained matching
ARTIFACT_CREATED event linked to the actual Attempt upload, not just a declared hash.
Public transport/metadata/completion and T10/T12/T18/T20 obligations are recorded in
`docs/contracts.md`; real browser execution is not claimed by server protocol fixtures.

Coordinator-approved failure ABI refinement: VALIDATE success is explicitly PASSED
with a descriptor; actual compiler failure is a separate strict ERROR branch forbidding
compiledBundleSha256. It retains approved engineInventorySha256, current assignment/
proof, processStopped:true, bounded safe failureCode and verified nonempty LOG evidence.
Missing diagnostic bytes/event linkage is rejected. This branch never mints a receipt,
never authorizes publish, and preserves exact completion replay. Dependent DEBUG work
finishes ERROR when the failed validation is examined rather than waiting for Run timeout.

Review fix1 preserves negative manifest/terminal facts and validates lifecycle, nested
step intervals, sibling order and actual assertion stages. Compiler-only expected-plan
FINALIZE marks deferred requestCount assertions; the DSL and SDK execution stay unchanged.
Same-step later-stage BLOCK skips require an actual preceding failed BLOCK fact. Missing
observers require explicit failed-step block proof and are recorded as blockedObservers,
never PASSED; ancestor prevention of children requires BEFORE plus explicit child SKIPPED.
Only LOG/ARTIFACT_CREATED tails may follow terminal execution.

Queued-retry cancellation records USER_CANCELLED, immediately finishes stopped queued
work, and reduces original history plus CANCELLED by fixed severity; it does not erase
FAILED/ERROR Attempts. Claim uses stable SQL predicates and100-row keyset pages through
the finite transaction queue. This removes head-of-queue starvation while preserving
installation/capacity lock ordering; aggregate lock time scales with matching queue size.
