# Signed offline bundles

The Bundles page exports selected published CASE versions or a SUITE with a published
environment. It downloads an immutable, signed ZIP. Selecting Draft DEBUG freezes the
current candidate using the existing validation queue; an Agent is not required to
export that DSL-only snapshot. Local compilation/execution is the next Runtime module.
Signature verification proves package source and integrity, not the honesty of local
results. Offline verification reports revocation UNKNOWN and never grants a formal gate.

The controller retains each original immutable validation source, receipt, compiled
descriptor and generated file. The combined snapshot contains the complete exact
version closure, public environment/adapter configuration and secretRef/version pins.
It never resolves credential values. Store passwords/tokens in credential mappings;
do not author sensitive literal values in resource documents or datasets.

New installations initialize a separate Ed25519 issuer under an operator-only directory.
Existing installations must explicitly provision one and set `bundle_issuer_path` in
configuration. The cookie/HMAC `signing_key` has a different purpose and is never reused.

```sh
uv run --project apps/srv python -m veriq_server issuer init --path /private/veriq-issuer/issuer.json
uv run --project apps/srv python -m veriq_server issuer show --path /private/veriq-issuer/issuer.json
uv run --project apps/srv python -m veriq_server issuer rotate --path /private/veriq-issuer/issuer.json
uv run --project apps/srv python -m veriq_server issuer revoke --path /private/veriq-issuer/issuer.json --key-id OLD_KEY_ID
```

Commands print public metadata only. Back up the private issuer file and its history;
all service instances must use the same operator-managed material. Rotation keeps old
public keys. Rotate before revoking the active key. Restart never invents a new identity.
Missing/lost keys disable exports clearly while unrelated platform functions continue.
Loss requiring a new issuer needs explicit authenticated rebind or administrator
fingerprint redistribution; old packages remain verifiable with retained trusted roots.
Do not restore stale revocation state over a newer trusted cache.

The native CLI uses bearer authentication, exact origin and no redirects/cookies:

```sh
veriq_cli trust refresh
veriq_cli bundle download BUNDLE_UUID --output ./download/bundle.zip
veriq_cli bundle verify ./download/bundle.zip --destination ./snapshots/BUNDLE_UUID
```

`trust refresh` requires an enrolled HTTPS server and current device authorization.
For initial out-of-band trust, obtain the issuer's public JSON through the administrator
and independently compare an active key fingerprint:

```sh
veriq_cli trust bind issuer-public.json --origin https://control.example --fingerprint SHA256
```

A ZIP cannot install its own key. Known revoked keys always fail. Expired or unvalidated
packages fail unless `bundle verify --debug` is explicit; this remains non-formal.
Issuer replacement requires an explicit fingerprint rebind. Public roots/revocations
remain after logout; clearing the entire native profile is a distinct intentional action.

Local credentials are keyed by issuer, Workspace, exact secretRef and version UUID.
Use `secret set` with JSON on stdin, never a value in argv or a renderer field transported
to arbitrary filesystem APIs. `secret remove` accepts the same exact reference options.

```sh
veriq_cli secret set --issuer ISSUER --workspace WORKSPACE_UUID --ref reader --version VERSION_UUID
```

The current native seam uses a 0700 directory and atomic 0600 configuration file; it is
not an OS vault. Values never appear in command output. Missing mappings fail explicitly;
there is no automatic online resolution or substitution of a newer version. Logout clears
local mappings while retaining trust. T20 owns OS vault/native installation validation.

Limits are 100 selected CASE roots, 1000 assets, reference depth100, 2MiB per resource,
16MiB source closure, 4096 ZIP entries, 64MiB compressed archive, 128MiB expanded output,
16MiB per member, and 1MiB manifest. Verification checks the exact detached signature
before writing archive members, then complete hashes/provenance before atomically
publishing a read-only snapshot. Paths use a bounded portable ASCII subset; traversal,
backslashes, Windows reserved names/ADS/trailing dots, collisions, symlinks/devices,
encryption and undeclared/missing files are rejected. Existing destinations are not
intentionally overwritten. Reverify downloaded bytes after any local modification.

The ZIP carries engine identity/inventory and lock metadata, not cross-OS node_modules.
Install a matching supported Runtime and browsers separately. A missing dependency or
unavailable original provenance fails export/verification. Data is read-only; this does
not add offline editing, automatic sync, result import or another online Attempt path.
T15 owns distinct OFFLINE_IMPORT results. Package/metadata lifecycle and explicit
read-only cache deletion are T21; raw Trace remains credential-restricted.
