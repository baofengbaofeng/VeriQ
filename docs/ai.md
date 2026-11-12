# VeriQ AI assistance

AI is optional. The `/ai` page provides Workspace-scoped provider configuration, connection tests, reviewed generation, boundary advice, sanitized Run analysis and call history. Ordinary deterministic execution does not use a model; provider disablement and exhausted budgets do not prevent Runs.

## Configure

1. An operator sets `ai_allowed_base_urls` in the normal server configuration. Defaults authorize exactly `https://api.openai.com/v1` and `https://api.anthropic.com/v1`; URL matching includes scheme, host, effective port and path. Redirects are rejected. Custom HTTPS endpoints require explicit operator authorization. Local HTTP is permitted only for explicitly configured loopback endpoints in development, as used by protocol-emulator tests.
2. A Workspace Owner/Admin opens AI and enters the endpoint, adapter, model, estimated input/output USD per million tokens, monthly budget, per-call limit and maximum output tokens. Model IDs must support the adapter's JSON chat/text interface. Provider-specific reasoning, multimodal, tools, streaming and hosted web search are not enabled.
3. Enter the API key in the password field, save and enable the provider. Keys are write-only: the field clears after a successful save and the server returns only `keyConfigured`. Leaving the key blank while editing preserves it. The server stores an AES-GCM encrypted key in a separate AI-purpose namespace; it is never a business `secretRef` or an Agent credential.
4. Connection test is a bounded synthetic generation, uses the same reservation policy, and appears in history. It is a real request to the configured provider, so obtain authorization for external costs before using a paid endpoint.

## Review and generate

Select only needed immutable resource versions, enter requirements and optionally supplied OpenAPI/nonsecret test data. Select an existing CASE for revision-bound modification or leave it blank for a new draft. Failure analysis additionally requires a Run ID. Context preview shows the exact sanitized context, provenance, conservative token bound and reservation before any request is sent. Credentials, identity references, raw Trace/HTML/screenshots/downloads and raw logs are excluded. Review freeform supplied material before sending: no automatic sanitizer can identify every secret hidden under an arbitrary business field name.

Generate sends that context to the selected provider. Output must pass canonical JSON Schema and reference restrictions. The view displays diagnostics, original candidate and proposed output. Boundary suggestions and analysis remain advice. Explicit acceptance creates or updates only a CASE DRAFT through the existing resource service; current permissions, revision and references are rechecked. Open the embedded resource editor to edit, validate with a real Runtime, debug, and publish using its normal authorization and receipt workflow. Model output is never automatically published or used to rewrite assertion truth during execution.

## Spending and cancellation

All prices are **operator-configured estimates**, not provider invoices or a guarantee against a provider changing its prices. Each immutable call record snapshots model, endpoint, rates and USD currency. Admission reserves a conservative UTF-8 byte bound for the complete system/schema/context messages plus 8192 framing tokens, and the configured output cap. Limits: 64 KiB selected context, 262144 input-bound tokens, 8192 output tokens, USD5 per request, USD10000 per monthly provider budget and 20 configured providers per Workspace.

Successful reported usage calculates estimated spending. Missing/invalid usage, errors, timeouts, cancellation and server interruption retain the reservation and show UNKNOWN, never fabricated zero cost. Unknown reservations remain charged across UTC month changes; known usage is accounted in the reservation's UTC month. There is no internal Cron, automatic refund, automatic paid retry, or automatic unknown-cost reconciliation. Lowering a budget below held and used spending is rejected. Active calls allow provider disablement but reject incompatible configuration/key changes.

A request UUID and canonical body provide idempotency; reuse the identical request to retrieve its current record without paying twice. A different body with the same UUID is rejected. Cancel records local cancellation and withholds the result. It cannot guarantee that the external provider stopped or that billing ceased. If verified usage arrives afterward, its estimate is retained even for a cancelled result. A disconnected tab can refresh history to inspect/cancel the durable reservation. Disabling/deleting a provider or losing current authorization prevents output disclosure/application.

## Verification and actual-provider acceptance

Automated tests use an explicitly local HTTP protocol emulator through both official SDKs, never a fake UI or a claim of paid-provider execution. Native Agent/Chromium tests verify PASSED Runs with disabled/exhausted providers and zero model HTTP requests. Browser tests cover configuration, key clearing, context/estimate preview, explicit review, genuine Runtime compilation/publication, cancellation, history and Workspace clearing.

Actual external-provider acceptance is separate and remains pending authorized provider credentials and a durable operator-owned acceptance environment. Do not enter real provider keys in the resettable `veriq_test` database or automated browser fixture. A proposed minimal acceptance uses one synthetic boundary-suggestion call, an explicitly approved model/endpoint, 128 output tokens and a reviewed reservation no greater than USD0.02. The operator must authorize the endpoint/model/budget and enter the key through the secure form; never send keys in chat or use internal tool credentials.
