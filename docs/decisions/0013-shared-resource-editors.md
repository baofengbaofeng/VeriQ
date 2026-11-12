# ADR 0013 — Shared resource forms and retained generated source

Status: coordinator-approved bounded T11 preflight, 2026-11-11.

The eight resource editors share React Hook Form document state and canonical AJV
validation. Monaco holds an independent text buffer only while editing JSON; an explicit
Apply validates and replaces that same document. Unapplied text blocks save, compile and
publish. Typed action/assertion/observer controls retain the canonical DSL and source
metadata, initial-variable declarations carry types only, and business JSON values remain
inert. No alternate DSL validator or frontend compiler is introduced. Monaco workers are
bundled locally. The existing exact dependency pins are unchanged.

Resource views receive a typed ResourceAdapter and an abortable Workspace lifetime. The
Cloud adapter owns session transport. The read-only Local adapter consumes snapshots
verified by a trusted host/provider; it does not verify signatures or authenticate an
untrusted input using a caller-provided flag. Local edits and synchronization are outside
this task. Authenticated-user and Workspace keyed mounts clear queries, editor models and
one-time credentials on changes. Current backend authorization remains authoritative.

The existing job read projects actual outcome/waitReason and a bounded safe errorCode
from retained Attempt facts. It does not expose raw LOG artifacts or invent structured
compiler issue paths. Canonical local validation supplies schema pointers. The current
Agent sanitizes compiler failures into stable codes; richer structured compiler diagnostics
must be integrated with the retained-event/report pipeline in T12 rather than inferred from
untrusted strings by the UI.

`GET /api/v1/workspaces/{ws}/resources/{resource}/versions/{version}/compiled-source`
is a human-view seam for already-published versions. Current Workspace VIEW authorization,
resource/version ownership and the immutable version's retained receipt bind the descriptor.
Without `path` it returns only allowlisted generated TypeScript file metadata and descriptor
hash. With `path` it returns that descriptor member's exact retained bytes after hash and
length verification. Caller hashes, filesystem paths, arbitrary descriptor files and raw
evidence are not accepted. Text is served as non-executable `text/plain`, private/no-store
and nosniff, and Monaco is read-only; this route never executes or recompiles the file.
It reuses the current Artifact repository, successful receipt and single Job pipeline.
Candidate source viewing is not added; after publication the preview identifies the immutable
version and its original descriptor. T12 retains ownership of broader storage, reports,
raw evidence access and retention.
