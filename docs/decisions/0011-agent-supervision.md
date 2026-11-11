# ADR 0011 — Agent process authority and recoverable device renewal

Status: accepted for T10 following coordinator preflight approval.

The Node Agent owns device credentials and control requests. Business children receive only
frozen execution configuration and narrowly resolved business credentials through private IPC;
they never inherit device authorization, lease proofs or the credential-store path. Online
execution never falls back to offline mode. The existing queue, expected plan, reducer and
CompletionManifestV1 remain the sole assignment/result pipeline.

Device rotation retains the legacy empty-body API. A recoverable rotation supplies a UUID
clientRequestId and a cryptographically random 32-byte base64url replacementToken. Before
sending, the private locked store durably records the pending request/candidate. The server
stores only token hashes plus request UUID and successor hash on the predecessor row. First
rotation requires current device authorization. Exact recovery is restricted to this endpoint,
the original predecessor/request/candidate, current Runtime/binding/owner authorization and
an unexpired, unrevoked successor. It never restores the predecessor's ordinary authority,
rotates twice or extends expiry. The client compares the expected predecessor and principal,
atomically replaces and fsyncs device.json, then removes the pending journal. A single Agent
holds the credential-store lock; control requests coordinate renewal without retrying business
writes. Renewal happens at startup and on a monotonic schedule before the 24-hour lifetime.

The supervisor journals assignment and activation before execution effects. Only acknowledged
activation permits a child. A lost activation response with no spawned process is reconciled
as stopped; uncertain ownership remains unknown and quarantined. Linux children have a dedicated
process group, actual execution UID, random ownership nonce and recorded /proc start time.
The journal UID and current /proc directory owner UID must agree before signalling;
missing or changed UID remains unknown. Descendant ownership
includes detached browser groups; discovered PID/start-time pairs are journaled before
signalling and rechecked. TERM then bounded KILL
must establish no live group members before a positive StopReceipt. PID reuse or inaccessible
identity fails closed. A monotonic watchdog uses the existing leaseDeadline helper, independently
of network requests and device wall time. Windows native job/process naming evidence remains
T20 work; the Linux implementation rejects unsupported platforms.

runAttempt returns AttemptResult {completion?, stop, files}; the input JobManifestV1 is never
returned as fabricated completion. TEST verifies immutable closure hashes and compiler assembly
against fixed local release bytes, then executes generated TS through Playwright with retries=0,
a fresh work directory, Context and fixture. SDK lifecycle hooks report actual start/assertion/
observer/finish facts. Expected plans authorize identifiers and legitimate blocked skips, not
observed timestamps or success. Raw trace/download evidence uses the restricted sink.

Browser temporary, trace and download storage is isolated per Attempt and monitored every
100ms. Exceeding a bounded byte/file budget stops the whole process group, including unfinished
downloads. This is a detection-and-stop limit with scheduling/scan delay, not a filesystem hard
quota. Event buffers are bounded; overflow aborts execution rather than dropping success-critical
facts. CLEANUP uses a neutral HTTP fixture context without a fake Page or browser launch. The compensation
subject retains the original Attempt caseExecutionId/attemptNo/namespace and only its
fixture credential/adapter pins and fixture environment fields.
VALIDATE executes the actual compiler; a failure uploads a sanitized stable diagnostic LOG and
uses the existing ERROR/no-bundle completion ABI. No second completion writer is introduced.

Automatic whole-case retry must not blindly replay an uncertain write. The compiler adds
optional `hasPotentialWrites` to each expected case, derived from WRITE declarations and
non-read-only API/observer methods, including expanded children. Missing legacy metadata
is unknown. The trusted SDK observes the complete business window through Context closure:
Context requests include frames/popups, page WebSocket activity is write-possible, and
SDK business API requests report methods separately. Dedicated auth/fixture HTTP is excluded.
Only a fully observed and closed Context can produce `READ_ONLY_OBSERVED`; potential writes
produce `WRITE_POSSIBLE`, and missing/incomplete observation produces `UNKNOWN`. No sensitive
URL, body or header is added to completion. Service workers remain blocked.

The existing completion writer permits the existing one retry only when a genuinely declared
fixture has SUCCEEDED cleanup under its namespace-close/reject-late-writes contract, or both
trusted metadata says no potential writes and actual completion says READ_ONLY_OBSERVED.
A client safe flag alone, missing metadata, or fake cleanup success without a declared fixture
cannot authorize retry. Otherwise historical failure remains terminal and Attempt facts carry
`retryReasonCode: RETRY_SAFETY_UNCONFIRMED`. No generic business-key reconciliation API is added;
uncertain writes without fixture closure require reconciliation before an explicit user new Run.

Real cancellation exposed a pre-existing SDK/canonical mismatch: interrupted operations were
reported FAILED while the case reported CANCELLED. StepFinishedPayload now permits CANCELLED.
A typed cancellation path races operation settlement with abort; the first observed failure
is retained and unfinished assertions emit no invented failed result. Context closure actually
interrupts browser work; cleanup still uses the independent HTTP lifecycle. Existing failures
remain FAILED at step/case level and the original reducer is unchanged. The cancellation grace
timer does not retain a completed foreground Agent process after its child has exited.
