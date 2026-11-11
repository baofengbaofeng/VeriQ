# ADR 0016 — Signed offline data and local credentials

Status: implementation decision for T14, 2026-11-11.

The controller exports bounded ZIP data using Python's standard-library zipfile; Node
uses pinned yauzl 3.4.0 (MIT) for lazy, size-validated reads. Ed25519 uses cryptography
and node:crypto. This does not package platform-specific node_modules or browsers.

manifest.json exact bytes and detached manifest.sig authenticate every other listed
member. snapshot.json binds selected published roots, environment and exact closure;
original validation snapshots, descriptors, receipts and compiled files preserve
provenance. Engine inventories and lock metadata identify the independently installed
approved release. Export never resolves encrypted credentials. Public adapter metadata
and exact secretRef/version pins are the only authentication data exported.

The operator explicitly initializes a purpose-separated issuer file (0700 directory,
0600 file, atomic replacement). Restart reuses it; loss prevents new exports. Backups
must retain issuer identity and keys. Rotation retains old public keys. Revocation is
monotonic and old keys remain identifiable. A lost identity requires explicit trusted
re-enrollment/out-of-band redistribution; packages cannot install their own roots.
Runtime caches public issuer state separately from logout-deletable credentials.
Only authenticated HTTPS exact-origin device transport or a checked out-of-band
fingerprint establishes trust. Offline verification always reports revocation UNKNOWN;
known revoked keys fail. Expired/unvalidated bundles require explicit DEBUG and never
confer formal result trust. Signature validity never proves local result honesty.

Verify signatures before publishing extracted files. Reject unsafe/ambiguous paths,
case-insensitive collisions, links, encryption, extra/missing entries and size overruns.
Limits: 4096 members, 64 MiB archive, 128 MiB total output, 16 MiB per file. Resource
closure retains its existing 1000-asset/100-depth/16-MiB limits. A private staging
directory is renamed only after complete hash verification, then exposed read-only.

Local credentials use exact issuer/workspace/ref/version mapping in a restricted atomic
configuration file. This is the specified restricted-config seam, not an OS vault;
T20 owns native vault integration. Missing mappings fail without online fallback.
Dynamic JSON member names containing protected local secret values (including URL and
base64 forms) withhold their entire object. Protocol envelopes are projected separately
so protocol-owned IDs, status and sequence remain valid.

`BundleSelectionV1` is the canonical request contract (OpenAPI aliases it). Exactly
one CASE list, SUITE, or immutable `draftValidationJobId` is selected. Draft export
requires EDIT and UNVALIDATED_DEBUG; every read/download also requires EDIT. A queued
VALIDATE snapshot works without an Agent: its original source/validationTarget and
published dependency provenance are retained, generated TS is absent, and
engine/requirements.json explicitly requires matching local compilation in T15.
Published exports preserve actual compiled bytes and approved inventory/lock metadata.

Assembly is bounded to two concurrent requests per service process. Authorized
immutable inputs are collected under the existing authority transaction, ZIP/signature
work runs in a worker thread outside DB locks, then current session/membership, exact
credential pins, issuer state and approved engine are rechecked before persistence.
Bundle archive/manifest/snapshot references pin existing Artifact rows; package14-day
and metadata90-day lifecycle are T21, not an undocumented T14 garbage collector.

Canonical resource DTOs moved into the shared schema and remain OpenAPI aliases. No
second resource validator was introduced. The native verified snapshot supplies the
existing local read-only resource adapter seam, including only allowlisted TS sources.
Public roots and monotonic cached revocations survive logout; local secret mappings
are cleared. Explicit profile deletion (including trust) remains a separate host action.
The restricted config seam is honest about file permissions; Windows native vault and
installer validation remain T20. The new archive graph's exact versions, license hashes
and timestamped OSV result are in `docs/dependencies/t14-archive-audit.json`.
