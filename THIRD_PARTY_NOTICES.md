# VeriQ third-party dependency record

VeriQ retains its existing AGPL-3.0 project license. Third-party code retains its own licenses.

The T01 dependency choices, exact versions, declared direct licenses, replacement boundaries and validation limits are recorded in [ADR 0003](docs/decisions/0003-engineering-baseline.md). Machine-readable inventories contain the installed [npm](docs/dependencies/npm-licenses.json) and [Python](docs/dependencies/python-licenses.json) dependency metadata, including development dependencies. Full resolved dependency versions and hashes are in the lockfiles.

For dual-licensed direct dependencies, the selected alternatives are Apache-2.0 for DOMPurify, BSD-3-Clause for cryptography and MIT for structlog. These choices do not replace upstream copyright notices or license text. Upstream package license files remain authoritative.

This repository has not produced a complete VeriQ distribution. These inventories are not a final native-binary SBOM or a complete installer notice bundle. Release assembly must include the actual license texts and notices shipped by Python/npm dependencies, Node, Electron/Chromium, Playwright browsers, native tools and the selected MySQL distribution for each supported OS. Target-specific optional dependencies absent from this Linux installation must be included in that release review. Preserve all required attribution, including the transitive CC-BY-4.0 package's notice; do not infer all dependencies share the project's license.

T04 adds RFC8785/JCS canonicalization using `rfc8785 0.1.4` and `canonicalize 2.1.0`, both Apache-2.0; see [ADR 0005](docs/decisions/0005-immutable-asset-validation.md). Their actual upstream LICENSE texts must accompany release distributions. The installed metadata inventories and lockfiles include both exact versions.

T05 uses the existing exact TypeScript 5.9.3/Ajv 8.18.0/ajv-formats 3.0.1 packages in the Node compiler and adds the exact Vitest V8 coverage provider 4.1.12 for development verification. Its added MIT/BSD-3-Clause dependency metadata is included in the npm inventory; see [ADR 0006](docs/decisions/0006-deterministic-compiler-artifacts.md).
