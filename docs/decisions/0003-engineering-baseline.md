# ADR 0003: VeriQ engineering baseline and shared contracts

- Status: selected engineering baseline for T01; user constraints and ADRs 0001/0002/0004 govern Tornado, branding and Router. This ADR does not declare product release or target-platform acceptance.
- Date: 2026-11-10.
- License: existing project AGPL-3.0 retained; technical identifiers remain `veriq`. No forked application code or additional proprietary framework is introduced.

## Toolchains and native entry

Use Python 3.12.14 with uv 0.13.5; Node 24.22.1 with pnpm 11.25.0; MySQL Community Server 8.4.13. Coordinator verified the running database and image `mysql@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902`. Python/Node versions are recorded in `.python-version` / `.node-version`; package-manager and engine constraints live in root `package.json`. MySQL communicates over its protocol; there is no embedded MySQL library in the control service.

Use the already selected Electron direction for the desktop native executable (`veriq` / `veriq.exe`), built with electron-builder. Keep Node 24 independent of Electron's embedded Node and Chromium. Agent/Runner distributions copy the exact Node runtime under `veriq_agent` / `veriq_runner` executable names (with `.exe` on Windows), retain Node notices, and initialize the real OS process name before processing work. CLI may use `veriq_cli`. No Rust shell, SEA assumption or second execution engine is selected.

Linux POC: executing a renamed Node binary alone returned `MainThread` from `/proc/self/comm`; setting `process.title` to the required role at bootstrap returned actual kernel names `veriq_agent` and `veriq_runner`. This is evidence about real OS state, not merely a log label. The POC binaries are ignored local tools. Desktop executable naming, descendant Playwright processes, worker bootstrap, process groups, Windows task-manager names, GUI packaging and signing still require their real downstream platform tests. No Windows or desktop acceptance is claimed here.

Node uses its MIT license plus bundled third-party notices; Electron/electron-builder use MIT, and Electron's Chromium/other components retain their own notices. MySQL Community Server has GPL-2.0 distribution obligations. Final platform-specific binary/SBOM/license verification belongs to release assembly; package metadata inventories below are not substitutes for binary notices.

## Reproducible dependency policy

All direct third-party requirements below are exact; all resolved transitive versions and integrity hashes are in `pnpm-lock.yaml` and `apps/srv/uv.lock`. Internal packages use workspace references. There are no `latest` requirements.

pnpm 11 reads project settings from `pnpm-workspace.yaml`. Keep exact saving, strict engines and peers, a 1440-minute minimum release age, explicit `enableGlobalVirtualStore: false`, a portable ignored project-local store, and `verifyDepsBeforeRun: error`. This preserves dependency verification and avoids a CI/local default difference that otherwise triggered implicit installation and a non-TTY directory-purge error. A targeted Monaco→DOMPurify 3.4.17 patch override removes the older vulnerable sanitizer; Vitest’s compatible Vite dependency is pinned to 6.4.5 to retain the required Vite 6 family. esbuild and electron-winstaller lifecycle scripts are explicitly allowed; the latter selects the packaged 7-Zip architecture. Electron's executable installation and browser downloads are separate from this contract test baseline.

Vite 6.4.6 was published less than 24 hours before selection and failed the minimum release age check; select 6.4.5. React 18, Vite 6, Tailwind 3, Router 7.18.5 (ADR 0004), Query 5, SQLAlchemy 2 and Python/Node major families remain user constraints. These constrained majors are deliberate compatibility choices, not claims of indefinite upstream support. Published version availability, engine/peer resolution, actual installation and the POCs/tests are the maintenance/compatibility evidence at T01. Future updates require review of advisories and upstream support as well as tests; a lockfile alone is not a security audit.

## Python direct dependencies

| Package | Exact version | Declared license | Purpose / replacement boundary |
| --- | --- | --- | --- |
| tornado | 6.6.1 | Apache-2.0 | Required control API/event loop; ADR 0001 user-approved security upgrade |
| sqlalchemy | 2.0.46 | MIT | ORM/transactions; repositories isolate it |
| alembic | 1.18.4 | MIT | Migrations; no custom migration engine |
| asyncmy | 0.2.18 | Apache-2.0 | Async MySQL driver; SQLAlchemy dialect boundary, aiomysql candidate |
| pydantic | 2.12.5 | MIT | HTTP/config models; shared DSL source remains JSON Schema |
| jsonschema[format-nongpl] | 4.26.0 | MIT | Draft 2020-12 validation plus actual URI/date-time checks; format extras avoid GPL optional formats |
| argon2-cffi | 25.1.0 | MIT | Password hashing; authentication adapter boundary |
| cryptography | 50.0.2 | Apache-2.0 OR BSD-3-Clause | AES-GCM/Ed25519; select BSD-3-Clause alternative, no custom crypto |
| httpx | 0.28.1 | BSD-3-Clause | Outbound HTTP adapters; aiohttp remains unselected candidate |
| structlog | 25.5.0 | MIT OR Apache-2.0 | Structured logs; select MIT alternative, standard logging adapter replaceable |
| pytest | 9.2.0 | MIT | Python behavior tests |
| pytest-asyncio | 1.3.0 | Apache-2.0 | Async test execution |
| pytest-cov | 7.0.0 | MIT | Python coverage evidence |
| ruff | 0.15.1 | MIT | Lint/format checks |
| mypy | 1.19.1 | MIT | Strict Python typing |
| types-jsonschema | 4.26.0.20260202 | Apache-2.0 | jsonschema typing |
| build | 1.4.0 | MIT | PEP 517 wheel build frontend |
| hatchling | 1.27.0 | MIT | Editable/wheel backend and canonical-schema inclusion |
| pyyaml | 6.0.3 | MIT | Contract/deployment YAML tooling |

Control-service dependencies import/install under Python 3.12; shared schema tests, typing and an isolated installed-wheel POC validate the contract path. Database migrations, real MySQL transactions, auth/crypto flows and HTTP application behavior are downstream tests, not claims from package installation.

## JavaScript direct dependencies

Versions and license declarations below come from installed exact package metadata. Full installed transitive metadata (including development dependencies) is in [npm-licenses.json](../dependencies/npm-licenses.json); Python equivalents are in [python-licenses.json](../dependencies/python-licenses.json). Full target-specific optional packages are locked even when not installed on this Linux host.

| Package | Exact version | Declared license | Workspaces |
| --- | --- | --- | --- |
| @apidevtools/swagger-parser | 12.1.0 | MIT | contracts |
| @dnd-kit/core | 6.3.1 | MIT | web |
| @playwright/test | 1.65.0 | Apache-2.0 | runner-sdk |
| @radix-ui/react-dialog | 1.3.1 | MIT | ui |
| @tanstack/react-query | 5.107.1 | MIT | desktop, web |
| @tanstack/react-table | 8.21.3 | MIT | web |
| @types/node | 24.10.1 | MIT | compiler, contracts, desktop, runner-sdk, runtime, web |
| @types/proper-lockfile | 4.1.4 | MIT | runtime |
| @types/react | 18.3.31 | MIT | desktop, ui, web |
| @types/react-dom | 18.3.7 | MIT | desktop, ui, web |
| @vitejs/plugin-react | 4.7.0 | MIT | desktop, web |
| ajv | 8.18.0 | MIT | contracts |
| ajv-formats | 3.0.1 | MIT | contracts |
| class-variance-authority | 0.7.1 | Apache-2.0 | ui |
| commander | 14.0.3 | MIT | runtime |
| dompurify | 3.4.17 | (MPL-2.0 OR Apache-2.0) | web |
| electron | 45.2.3 | MIT | desktop |
| electron-builder | 26.18.1 | MIT | desktop |
| env-paths | 3.0.0 | MIT | runtime |
| i18next | 25.10.10 | MIT | desktop, web |
| json-schema-to-typescript | 15.0.4 | MIT | contracts |
| monaco-editor | 0.57.0 | MIT | web |
| openapi-typescript | 7.10.1 | MIT | contracts |
| pino | 10.4.0 | MIT | runtime |
| proper-lockfile | 4.1.2 | MIT | runtime |
| react | 18.3.1 | MIT | desktop, ui, web |
| react-dom | 18.3.1 | MIT | desktop, ui, web |
| react-hook-form | 7.91.0 | MIT | web |
| react-i18next | 16.6.6 | MIT | desktop, web |
| react-router-dom | 7.18.5 | MIT | web |
| tailwindcss | 3.4.19 | MIT | desktop, web |
| tsx | 4.23.15 | MIT | contracts |
| typescript | 5.9.3 | Apache-2.0 | compiler, contracts, desktop, runner-sdk, runtime, web |
| vite | 6.4.5 | MIT | desktop, web |
| vitest | 4.1.12 | MIT | compiler, contracts, runner-sdk |

For DOMPurify select its Apache-2.0 alternative. Preserve Apache notices for TypeScript, Playwright and CVA. All other direct npm packages report MIT. These metadata declarations do not certify the contents of downloaded native binaries.

Selection/replacement boundaries:

- React/Vite/plugin-react/Router/Query/Tailwind are the required UI families. Radix dialog and CVA provide accessible primitives and variants; i18next/react-i18next provide translation. Shared UI/feature adapters isolate these dependencies.
- React Hook Form, TanStack Table and Monaco provide mature forms/tables/JSON editing rather than bespoke frameworks. dnd-kit supplies accessible drag operations; DOMPurify handles any allowed rich content. None implies these application features have been implemented.
- Electron/electron-builder implement the selected desktop direction and native packaging. Tauri/Rust/SEA are not additional selected dependencies.
- Commander, env-paths, proper-lockfile and Pino provide CLI/data paths/locking/logging behind Runtime adapters.
- Playwright Test is the single browser execution engine. Runner SDK owns integration; Playwright retries must remain zero, and VeriQ owns whole-case retries.
- Ajv2020 + ajv-formats mirror Python jsonschema over canonical sources. json-schema-to-typescript generates wire types; openapi-typescript generates API client types; Swagger Parser validates the resolved API. There is no independently maintained Zod/TS DSL schema.
- TypeScript/types, tsx and Vitest are development tools. Upgrading or replacing generators must preserve generated APIs, checked fixture behavior and generation staleness checks.

Installation with strict peers succeeds on Node 24.22.1. Actual contract tests, generated TypeScript compilation, OpenAPI resolution and DTO validation supply the POC; no app build or browser/desktop test is implied. pnpm reported deprecated transitive boolean 3.2.0, glob 7.2.3, inflight 1.0.6 and rimraf 2.6.3; they are recorded in the lock/inventory and need normal upstream tracking.

AI Provider SDKs, Midscene, Tenacity, boto3, Allure, ReportPortal, PyCasbin and additional Radix controls remain unselected candidates until their task has a concrete need and dependency/license review. No candidate is described as approved or implemented.

## Contract/source and packaging decision

`packages/contracts/schemas/platform-v1.schema.json` is the canonical schema source. Small per-contract schema aliases reference it. Python and Ajv reject unknown fields, invalid discriminators/operator/value combinations, unsafe executable bindings, non-finite JSON and unsafe integers. Compiler/service semantics remain separate: reference ownership, variable/type flow, publication receipts, Workspace authorization and source-hash verification are not implied by schema success.

Wire types are generated from canonical JSON Schema. A pure reference alias is emitted explicitly, preventing the generator from hiding `AssetSnapshotV1` behind `SnapshotV1`. OpenAPI references those schema definitions; its recursive JSON type imports the same generated `JsonValue` to avoid TypeScript indexed-access recursion. Generated files are committed and `pnpm check` compares regeneration byte-for-byte.

The Python wheel force-includes the canonical schema directory under `veriq_server/_schemas`; the loader prefers installed package resources and only falls back to the checkout for editable development. The isolated-wheel POC validates all shared fixtures from outside the checkout with Node unavailable. This avoids a runtime Node requirement or two hand-maintained schema copies.

This is an engineering wheel smoke test. T02/T18 must add frontend staging, migrations/version artifacts, strict production build completeness and clean installation without breaking editable installs. A T01 smoke wheel is not a production server release.

Final distributable SBOMs, complete license texts/notices for every platform binary and installer, and security/release gates remain T18 deliverables. [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) records the current inventory scope honestly.


## Security remediation and applicability

The user approved Router 7.18.5 in ADR 0004, retaining React 18/Vite 6. Tornado 6.6.1 was approved in ADR 0001. Final direct versions above also include asyncmy 0.2.18, cryptography 50.0.2, pytest 9.2.0, Vitest 4.1.12 and tsx 4.23.15; Monaco's exact DOMPurify 3.4.15 transitive is patched to 3.4.17. These updates replace the initial audited baseline; no vulnerable initial version is silently treated as accepted.

The asyncmy advisory lacked a first-patched version, but the official [v0.2.12 release](https://github.com/long2ice/asyncmy/releases/tag/v0.2.12) explicitly removed unsafe escape_dict for CVE-2025-65896. Retaining the driver at 0.2.18 avoids an unnecessary architecture change. A real MySQL 8.4/SQLAlchemy 2 probe preserves typed JSON and quote/backslash binds. Converter behavior now quotes a dictionary as a scalar string rather than returning the old unescaped mapping; it does not necessarily reject dictionaries. AES-GCM/AAD and Ed25519/tamper compatibility probes pass with cryptography 50.0.2.

Post-remediation audits find no known issues in the 61 audited Python packages and no npm high/critical findings. npm still reports [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), moderate, against builder-only minimatch 9.0.9/10.2.6. The maintainer's affected operation requires attacker-controlled glob patterns and optimizationLevel>=2. Installed app-builder-lib FileMatcher passes only `{dot:true}`; @electron/universal passes only `{matchBase:true}`; minimatch defaults optimizationLevel to 1. No affected call path was identified in those callers, and builder patterns are trusted source-controlled configuration, not application request input. Preserve this applicability record and recheck at desktop packaging or whenever callers/configuration change. No blind 9/10→11 override or blanket audit suppression is used. The ordinary full npm audit remains nonzero for this recorded finding; it is not called clean.

Audit metadata, candidate checks and upstream patch evidence are retained in the task evidence. An audit matches known versions to advisories; it neither proves every finding is exploitable nor establishes absence of unknown vulnerabilities. Final target-platform binaries and release assembly still require their own review.
