# VeriQ third-party dependency record

VeriQ retains its existing AGPL-3.0 project license. Third-party code retains its own licenses.

The Web refresh selects @radix-ui/react-dropdown-menu 2.2.1, @radix-ui/react-select 2.4.1 and
@radix-ui/react-tooltip 1.4.1 (MIT), alongside existing @radix-ui/react-dialog 1.3.1 (MIT) and
class-variance-authority 0.7.1 (Apache-2.0). The 19-package installed delta, including the three
new direct controls, declares MIT. Preserve their upstream copyright/license texts and any supplied
NOTICE files in distributions. [ADR 0024](docs/decisions/0024-web-ui-dependencies.md) records purpose,
attribution, the retained metadata evidence and the dated 2026-11-17 production advisory audit;
that audit does not provide a permanent security guarantee or replace release SBOM checks.

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

R03 test recovery directly declares development-only undici 7.30.2 (MIT, already resolved) and
adds tough-cookie 6.1.0 (BSD-3-Clause), with tldts 7.5.4 and tldts-core 7.5.4 (MIT).
The unit-test entry also directly declares existing tsx 4.23.15 (MIT) without changing its resolved closure.
Only tough-cookie, tldts and tldts-core are newly resolved packages.
[ADR 0025](docs/decisions/0025-web-test-recovery-transport.md) records the single-origin transport,
automatic Playwright trace boundary, release-age evidence and the dated exact-version advisory query.
Preserve each upstream LICENSE and copyright notice in distributions. These dependencies serve test
recovery only and do not change the Runtime production closure or the locked execution engine.

V09 adds development-only tree-sitter 0.26.1, tree-sitter-bash 0.25.1, tree-sitter-css 0.25.0,
and tree-sitter-java 0.23.5,
each under the MIT license. Their original wheel license texts, exact source and wheel hashes,
and the dated exact-version OSV responses are preserved in the
[comment parser audit](docs/dependencies/v09-comment-parsers-audit.json).
The upstream copyright notices are Copyright (c) 2019 Max Brunsfeld, GitHub (tree-sitter),
Copyright (c) 2017 Max Brunsfeld (tree-sitter-bash), Copyright (c) 2018 Max Brunsfeld (tree-sitter-css), and Copyright (c) 2017 Ayman Nadeem (tree-sitter-java).
Distributing a development environment or these tools requires retaining their full MIT copyright,
permission and warranty notices. They are absent from the production service `--no-dev` wheelhouse;
their code is not copied into the service wheel or Runtime. The retained OSV responses listed no
advisories at the recorded evidence capture times; this is not a complete release security assessment.
[ADR 0026](docs/decisions/0026-trusted-comment-parsers.md) records the limited source-comment purpose,
ABI validation and the unchanged production dependency closure. The adapters support qualified Shell, CSS and Java source only.
The Java adapter rejects raw Unicode escape spellings and bare CR bytes, including in otherwise legal input. It accepts LF and CRLF.
The pinned grammar can absorb code after a bare CR into a line comment despite the line boundaries defined by JLS §3.4 and §3.7.

V09 adds four development-only MIT distributions for strict S3 checking:
`boto3-stubs[s3]` 1.44.0, `mypy-boto3-s3` 1.44.0, `botocore-stubs` 1.43.126,
and `types-s3transfer` 0.19.3. The upstream copyright notices are Copyright (c) 2026 Vlad Emelianov
for `boto3-stubs` and `mypy-boto3-s3`, and Copyright (c) 2022 Vlad Emelianov for `botocore-stubs`
and `types-s3transfer`. Distributions of these tools must retain their original copyright, permission,
and warranty notices. Official wheel hashes, original MIT texts, and the 2026-11-17 exact-version OSV
query are recorded in the [SDK type audit](docs/dependencies/v09-sdk-types-audit.json).
[ADR 0027](docs/decisions/0027-sdk-type-stubs.md) records the verified scope of the older core declarations.
The production `--no-dev` requirements export retains the same 56 entries and distribution hashes.

## V09 qualified HTML comment parser

V09 extends the source-comment adapters to qualified HTML with development-only
tree-sitter-html 0.23.2 under the MIT license. Its distribution retains the upstream notice
below. The grammar is absent from the production service `--no-dev` requirements and is
used for static source measurement. The Linux x86_64 wheel, exact-version OSV response,
and qualification scope are recorded in the [comment parser audit](docs/dependencies/v09-comment-parsers-audit.json)
and [ADR 0026](docs/decisions/0026-trusted-comment-parsers.md).

```text
The MIT License (MIT)

Copyright (c) 2014 Max Brunsfeld

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## TailAdmin React Free

Web shell, navigation icons, resource cards, form and table layouts adapted from
[TailAdmin React Free](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard)
at commit `9aaac11e9e6fa87d0afe0e976b5ac291e29eeeb9`. The responsive header, user menu and its icons also adapt
the [v2.5.1 source](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/tree/486ed748b21e032a4432effeca4ef3684fa223d3).

MIT License

Copyright (c) 2023 TailAdmin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
