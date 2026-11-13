# ADR 0019：生产静态库存与包内服务

状态：T17 协调审定。2026-11-13。

Vite `.vite/manifest.json` 是模块图，不能保证包含复制的公开文件、worker 或字体。生产完整性检查不能把该图当成整个发行目录的库存。

生产静态根固定为安装包 `veriq_server/static/dist`，由 Python package resources 定位，沿用唯一的 `app.py::make_app`。使用 Tornado `StaticFileHandler` 负责文件传输；薄适配器负责发布资格、符号链接拒绝、结构化错误及缓存策略。开发模式不读取该目录，也不要求已构建前端。

发行输入另含 `static-manifest.json`，精确格式为 `{ "schemaVersion": "1.0", "files": [{ "path": "index.html", "sha256": "…", "sizeBytes": 123 }] }`。它列出全部输出普通文件，包括入口、Vite 模块图和图外公开资源，排除 `static-manifest.json` 与 `build-info.json`，从而避免哈希循环。路径使用相对 POSIX 形式，禁止点段、空段、转义、反斜杠、符号链接、重复路径或附加字段。服务启动时核对全部精确字节哈希、长度及目录集合，发现未列文件也拒绝启动。

`build-info.json` 沿用现有严格 `BuildInfoDTO` 四字段：`version`、`commit`、`buildId`、`staticManifestHash`。最后一项是 `static-manifest.json` **原始字节**的 SHA-256，版本必须等于 Python 包版本。服务不从请求、环境或 Git 动态补全身份。构建元数据与隐藏文件不公开为静态 URL；`GET /api/v1/build-info` 只返回已验证的公开 DTO。开发环境无发行描述时返回结构化 `503 BUILD_INFO_UNAVAILABLE`。

完整库存中的非隐藏资源可公开；除 `index.html` 外不接收 HTML。原始用户证据仍保存在制品存储，不能进入发行目录。路由顺序保持健康/构建信息、已实现 API、未知 API/internal 拒绝、精确公开文件、实际登记 SPA GET/HEAD、结构化 404。入口和普通资源 `no-cache`，带 Vite 指纹的 assets 使用一年 immutable 缓存；查询参数不能升级普通文件缓存。

顶层 `/health/live`、`/health/ready` 沿用现有 `HealthDTOEnvelope`，分别报告进程检查和数据库检查；已知数据库故障时 readiness 返回 `503` 与 `degraded`，不返回异常或连接串。历史 `/api/v1/health/*` 数据字段保留。T21 继续负责存储及关键依赖的完整运维 readiness，当前不宣称已经覆盖所有依赖。

T17 实现服务端校验和测试输入；T18 负责完整 frontend build/stage、库存和元数据生成、wheel hook、干净安装及无 Node 生产验收。T17 的测试输入或源码构建不代表已有正式发行包，也不保证元数据中的 commit 已经过发行流水线证明。

# ADR 0019: production static inventory and package serving

Status: approved for T17 coordination, 2026-11-13.

Vite's module graph may omit copied public files, workers or fonts. A separate `static-manifest.json` records the complete regular-file closure using exactly `{schemaVersion:"1.0", files:[{path,sha256,sizeBytes}]}`. It includes `index.html` and `.vite/manifest.json`, excluding itself and `build-info.json` to avoid a hash cycle. Relative POSIX paths must be unique and safe, with no links or extra fields. Startup verifies exact bytes, sizes and the complete directory file set.

The fixed root is installed `veriq_server/static/dist`, resolved through Python package resources. The existing `make_app` remains the only factory. A thin Tornado `StaticFileHandler` adapter enforces publication, links, JSON errors and cache policy. Development does not require a frontend build.

Build metadata retains the exact existing four-field DTO. `staticManifestHash` hashes the exact inventory bytes; `version` must match the Python package. Metadata and hidden files stay private; the public API returns validated nonsecret metadata, or `503 BUILD_INFO_UNAVAILABLE` in development. Public inventory files exclude additional HTML; raw evidence remains in separately authorized artifact storage.

Existing APIs precede exact public-file routes and actual registered SPA GET/HEAD routes. Unknown API/internal paths and missing files return JSON errors. Index and ordinary files revalidate; fingerprinted assets cache immutably for one year. Query parameters cannot upgrade cache policy.

Canonical top-level health aliases retain HealthDTOEnvelope: process liveness remains independent of the database; a known database outage returns readiness503 with degraded/database:false, without exception or DSN details. Legacy health API bodies remain unchanged. T21 owns fuller storage and critical-dependency readiness.

T18 owns the production inventory writer, staging, wheel hooks and clean-install/no-Node acceptance. T17 implements serving and validation with test inputs, without claiming a release artifact or independently proven commit provenance.
