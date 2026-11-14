# VeriQ third-party dependency record

VeriQ retains its existing AGPL-3.0 project license. Third-party code retains its own licenses.

The T01 dependency choices, exact versions, declared direct licenses, replacement boundaries and validation limits are recorded in [ADR 0003](docs/decisions/0003-engineering-baseline.md). Machine-readable inventories contain the installed [npm](docs/dependencies/npm-licenses.json) and [Python](docs/dependencies/python-licenses.json) dependency metadata, including development dependencies. Full resolved dependency versions and hashes are in the lockfiles.

For dual-licensed direct dependencies, the selected alternatives are Apache-2.0 for DOMPurify, BSD-3-Clause for cryptography and MIT for structlog. These choices do not replace upstream copyright notices or license text. Upstream package license files remain authoritative.

This repository has not produced a complete VeriQ distribution. These inventories are not a final native-binary SBOM or a complete installer notice bundle. Release assembly must include the actual license texts and notices shipped by Python/npm dependencies, Node, Electron/Chromium, Playwright browsers, native tools and the selected MySQL distribution for each supported OS. Target-specific optional dependencies absent from this Linux installation must be included in that release review. Preserve all required attribution, including the transitive CC-BY-4.0 package's notice; do not infer all dependencies share the project's license.

T04 adds RFC8785/JCS canonicalization using `rfc8785 0.1.4` and `canonicalize 2.1.0`, both Apache-2.0; see [ADR 0005](docs/decisions/0005-immutable-asset-validation.md). Their actual upstream LICENSE texts must accompany release distributions. The installed metadata inventories and lockfiles include both exact versions.

T05 uses the existing exact TypeScript 5.9.3/Ajv 8.18.0/ajv-formats 3.0.1 packages in the Node compiler and adds the exact Vitest V8 coverage provider 4.1.12 for development verification. Its added MIT/BSD-3-Clause dependency metadata is included in the npm inventory; see [ADR 0006](docs/decisions/0006-deterministic-compiler-artifacts.md).

T12 adds the storage/stream dependencies below; Moto/Flask and their server helpers are development-only emulator dependencies. Exact production/development graphs are retained in `apps/srv/uv.lock` and `pnpm-lock.yaml`. See [ADR0014](docs/decisions/0014-report-evidence-storage.md). The dateutil license alternative selected for distributions is BSD-3-Clause. Upstream license files must accompany actual releases.

| Package | Version | License |
| --- | --- | --- |
| blinker | 1.9.0 | MIT |
| boto3 | 1.44.0 | Apache-2.0 |
| botocore | 1.44.0 | Apache-2.0 |
| charset-normalizer | 3.5.2 | MIT |
| click | 8.5.1 | BSD-3-Clause |
| flask | 3.1.3 | BSD-3-Clause |
| flask-cors | 6.0.5 | MIT |
| itsdangerous | 2.2.0 | BSD-3-Clause |
| jinja2 | 3.1.6 | BSD-3-Clause |
| jmespath | 1.1.0 | MIT |
| moto | 5.2.5 | Apache-2.0 |
| python-dateutil | 2.9.0.post0 | Apache-2.0 OR BSD-3-Clause |
| requests | 2.34.2 | Apache-2.0 |
| responses | 0.26.3 | Apache-2.0 |
| s3transfer | 0.19.3 | Apache-2.0 |
| urllib3 | 2.8.0 | MIT |
| werkzeug | 3.1.9 | BSD-3-Clause |
| xmltodict | 1.0.4 | MIT |
| eventsource-parser | 4.1.3 | MIT |

T13 adds official AI Provider SDKs and the following resolved Python delta. Existing
HTTPX/Pydantic/cryptography dependencies are reused. See [ADR0015](docs/decisions/0015-ai-provider-boundaries.md).
The new graph's OSV query returned no advisories on 2026-11-11; this is a point-in-time
check, not a perpetual safety claim. Release bundles must preserve upstream license texts.
For sniffio the MIT alternative is selected. tqdm's code is MPL-2.0 with MIT-licensed
contributions as described by its upstream license; preserve both notices.

| Package | Version | License |
| --- | --- | --- |
| openai | 2.29.0 | Apache-2.0 |
| anthropic | 0.84.0 | MIT |
| distro | 1.9.0 | Apache-2.0 |
| docstring-parser | 0.18.0 | MIT |
| jiter | 0.19.0 | MIT |
| sniffio | 1.3.1 | MIT OR Apache-2.0 |
| tqdm | 4.70.1 | MPL-2.0 AND MIT |

T14 adds yauzl 3.4.0 (MIT), resolved pend 1.2.0 (MIT), and development-only
@types/yauzl 3.4.0 (MIT). Python ZIP writing uses the existing standard library;
Ed25519 reuses cryptography and Node crypto. The exact new graph's OSV query and
installed license-file hashes are recorded in
[the archive audit](docs/dependencies/t14-archive-audit.json). No advisories were
returned at that timestamp; this does not reassess unchanged dependencies or
replace release-time checks. Distributions must include the upstream MIT notices.

T18 adds development-only Biome2.6.7 (MIT selected) and CycloneDX-bom8.0.1 with the exact12-package Python delta in [ADR0020](docs/decisions/0020-server-release-pipeline.md). Existing runtime versions are unchanged. [The full tool audit](docs/dependencies/t18-build-tools-audit.json) records licenses and the2026-11-13 OSV result; no advisories were returned at that time. Actual server SBOMs collect installed dependency license texts; Web BOMs describe the pre-bundle production closure and retain upstream LICENSE/NOTICE/README files. These build tools are not installed into the control-service runtime wheelhouse.

T20 promotes the already locked @electron/fuses1.8.0 (MIT) to a direct desktop dependency for Cookie encryption fuse verification. No dependency versions change. [The exact13-package audit](docs/dependencies/t20-cookie-fuses-audit.json) records the installed MIT/ISC closure, registry integrity match and2026-11-14 OSV response with no advisories returned for those exact versions. This is not a full-release security assessment. Release bundles must preserve all upstream license texts.
