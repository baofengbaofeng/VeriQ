# VeriQ third-party dependency record

VeriQ retains its existing AGPL-3.0 project license. Third-party code retains its own licenses.

The T01 dependency choices, exact versions, declared direct licenses, replacement boundaries and validation limits are recorded in [ADR 0003](docs/decisions/0003-engineering-baseline.md). Machine-readable inventories contain the installed [npm](docs/dependencies/npm-licenses.json) and [Python](docs/dependencies/python-licenses.json) dependency metadata, including development dependencies. Full resolved dependency versions and hashes are in the lockfiles.

For dual-licensed direct dependencies, the selected alternatives are Apache-2.0 for DOMPurify, BSD-3-Clause for cryptography and MIT for structlog. These choices do not replace upstream copyright notices or license text. Upstream package license files remain authoritative.

This repository has not produced a complete VeriQ distribution. These inventories are not a final native-binary SBOM or a complete installer notice bundle. Release assembly must include the actual license texts and notices shipped by Python/npm dependencies, Node, Electron/Chromium, Playwright browsers, native tools and the selected MySQL distribution for each supported OS. Target-specific optional dependencies absent from this Linux installation must be included in that release review. Preserve all required attribution, including the transitive CC-BY-4.0 package's notice; do not infer all dependencies share the project's license.
