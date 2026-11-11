# ADR 0014 — report provenance and restricted evidence storage

Status: accepted for T12 by coordinator, 2026-11-11.

Reports project the existing CompletionService writer and results reducer. Activation
freezes authoritative Runtime trust, location and current grants before side effects.
Completion retains that snapshot; historical absence remains UNKNOWN. Current gates
cannot promote an originally unmanaged, unknown, dirty or offline execution.

Raw uploaded bytes (including LOG) require current Workspace MANAGE_ENVIRONMENT and
Attempt linkage. Effective sensitivity is server-derived independently of immutable
submitted upload metadata. Trace, HTML, screenshot and download claims cannot downgrade
access. Ordinary reports expose structured facts with sensitive headers and frozen
credential values (exact, URL and base64 forms) redacted; unavailable decryption withholds
value-bearing fields explicitly. No generic device read or direct/presigned URL is added.
Raw HTML is attachment-only with sandbox/nosniff. Local Trace viewing reuses pinned
Playwright and never uploads to a public viewer.

New raw evidence uses a File/S3 CAS. Existing inline artifacts and source/manifest/engine
closure readers remain intact. External bytes are staged outside authority transactions;
current grants/fence and immutable metadata are checked again before commit/response.
Completed-upload replay must verify exact offsets/bytes through that same staged boundary.
Storage is bounded to existing32MiB file limits; File publishes immutable bytes atomically;
S3 uses conditional writes and verifies retained hash/length. Shared inline source digests
stay inline. No parallel artifact/result writer is introduced.

External MAINTENANCE artifacts/expire tombstones only eligible terminal TEST evidence,
pins actual source/compiled/engine closure, retains receipts/manifests/provenance, and
reports EXPIRED without rewriting historical evidence completeness or outcome. External
I/O runs outside DB transactions and deletion retries are idempotent. No internal Cron.

S3 uses mature boto3; exact versions and new dependency graph/license/advisory evidence
are recorded with the final lock. Moto loopback HTTP is emulator verification, not live
AWS certification. No cloud service or paid account is required.

Compiler diagnostics come from actual analyze().issues, never parsed error prose. The
canonical optional failure diagnostics retain real code/path and static safe messages;
unsafe or unavailable paths have an explicit marker, not a fabricated ancestor. Old
failures remain absent. The existing Job/editor/report projections consume those facts.

The stream uses POST + fetch ReadableStream and eventsource-parser4.1.3 (MIT), current
cookie/CSRF/Origin, and a256KiB body. The signed actor/Workspace/Run cursor contains at
most2000 TEST Attempt positions (1000 admitted matrix variants ×2 retries). Cursor never
travels in URL or header. Event pages retain sequence and cap count100/approximately1MiB;
clients explicitly reload authoritative report/history after invalid/expired cursor.
Cleanup compensation and current gates are reprojected even without new TEST events.
Transactions finish before SSE flush; authorization is rechecked every bounded read cycle.

New exact dependencies: boto3 1.44.0 / botocore1.44.0 (Apache-2.0), dev-only Moto5.2.5
(Apache-2.0), Flask3.1.3 (BSD-3-Clause), Flask-CORS6.0.5 (MIT). Flask-CORS is required by
Moto's loopback HTTP server; it does not enable production controller CORS. Minimal dev
packages avoid the unrelated full moto[server] dependency graph. Botocore requires
python-dateutil>=2.1,<3.0, so the resolver changes the former4.0.0 to2.9.0.post0; existing
JSON Schema date-time validation and affected platform checks are retained. All changed
Python packages and eventsource-parser are audited via OSV with exact versions; the
2026-11-11 query returned zero advisories across19 changed/new packages. Locks retain
transitive versions/hashes. This is a point-in-time advisory result, not a guarantee.

A CAS reservation is persisted before final raw-byte I/O. Failed/revoked finalization keeps
an incomplete upload and its reservation eligible for later external retention, without
marking bytes complete. A later exact source upload promotes shared bytes inline, pinning
them; source/manifest/non-raw uploads and actual assignment/receipt roots prevent expiry.
Legacy inline raw-only TEST evidence can expire after those same reference checks.


The coordinator approved an additive ReportDisplayV1 metadata member after reviewing the
first real report UI. The compiler preserves original source step/assertion IDs before
wire transforms and emits allowlisted titles/keys/actions, parent/order, assertion metadata
and observer summaries. No action values or auth payloads are emitted. A scoped
Run/Attempt display endpoint verifies immutable descriptor hash/size/schema and exact
ExpectedPlans membership before returning redacted metadata. Old bundles remain immutable
and explicitly lack display metadata. Main reports present structured comparisons and
chronological steps; protocol/provenance JSON is optional technical detail. The metadata
adds consumer ABI, so one instrumented full SDK gate is required after source freeze.

Real catalog compilation exposed identical empty ExpectedPlans/ReportDisplay bytes at two
paths. Completion must match each evidence entry to its complete upload and exact linked
ARTIFACT_CREATED event, not collapse all evidence identities into a digest-only map.
Descriptor closure remains content-addressed and the existing writer/reducer is retained.

Retention uses nullable server-owned Attempt.finished_at added in0008. Existing completion,
lease-loss/reap and reconciliation terminal transitions stamp database UTC once; replay
never resets it. This is platform terminal time, not a physical-stop assertion. Historical
missing times remain unknown and retained, with no invented backfill. Raw PASSED evidence
defaults to14days (`artifact_success_retention_days`), other terminal evidence30days
(`artifact_retention_days`); active/shared/pinned closure bytes cannot expire. Full metadata90
and successful export-package lifecycle remain required T21 work after T14/T15 resources
exist; this task deliberately retains those references rather than deleting them early.

The coordinator required logical link expiry and safe repeated identical-byte uploads in
T12, not a permanent digest410. AttemptUpload.expired_at permanently tombstones each old
link. Artifact records only the current private storage incarnation; new external keys are
Workspace/SHA.UUID (legacy null incarnation preserves Workspace/SHA). Once every reference
is expired and no source/engine root pins bytes, maintenance durably records that exact
backend/incarnation for deletion and tombstones the current CAS. A newly authorized upload
reserves a fresh UUID, stages verified bytes outside the transaction and rechecks current
proof/fence/incarnation before committing. Pending deletion always addresses the old
immutable key and cannot delete new bytes. Source promotion may enqueue its redundant
external incarnation while preserving verified inline bytes. Logical processedCount counts
expired upload links; physical pending deletion is independently retryable. No raw storage
key is exposed, no execution queue or Cron is added, and old links never revive.

Current gates also block withdrawal of captured credential-delivery approval when frozen
execution pins require delivery. Activation captures that authoritative requirement; no
claim of actual credential use is inferred. Legacy provenance without the distinction is
conservative. This projection policy does not alter delivery grants or historical outcomes.
