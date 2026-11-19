# 依赖清单与审计记录

本目录保存已安装依赖的许可元数据，以及特定依赖变更的审计证据。记录反映采集时的安装环境、包版本和查询结果。漏洞查询的覆盖范围以各文件记录的日期、来源和精确版本为准。

依赖解析的版本与分发物哈希见 [pnpm 锁文件](../../pnpm-lock.yaml)和 [Python 锁文件](../../apps/srv/uv.lock)。许可与归属义务以上游许可证和 NOTICE 原文为准，项目记录见[第三方声明](../../THIRD_PARTY_NOTICES.md)。发行时按目标平台的实际交付内容核对 NOTICE 和 SBOM，流程见[发行指南](../服务端发行指南.md)。

## 许可清单

| 文件 | 记录内容 |
| --- | --- |
| [npm-license-inventory.json](npm-license-inventory.json) | 已安装 npm 包的版本、声明许可和主页，包含开发依赖。其他平台的可选包以锁文件及目标产物为准。 |
| [python-license-inventory.json](python-license-inventory.json) | 已安装的 Python 分发物，含构建与开发依赖及 V09 的 pylint、Black 工具闭包。记录版本、许可元数据和许可文件。 |

## 专项审计

| 文件 | 记录内容 |
| --- | --- |
| [offline-archive-dependency-audit.json](offline-archive-dependency-audit.json) | T14 离线 ZIP 读取所用 `yauzl`、传递依赖 `pend` 及类型包 `@types/yauzl` 的许可与 OSV 查询。 |
| [server-release-tools-audit.json](server-release-tools-audit.json) | T18 服务端发行工具的许可元数据和 OSV 查询，共核对 44 个精确版本，涵盖既有 Python 依赖及新增发行工具和平台包。 |
| [electron-cookie-fuses-audit.json](electron-cookie-fuses-audit.json) | T20 将锁定的 `@electron/fuses` 1.8.0 提升为桌面端直接依赖，以核验 Cookie 相关 fuse。保留包完整性、安装闭包和 OSV 证据。 |
| [native-addon-build-tools-audit.json](native-addon-build-tools-audit.json) | T20 对 21 个构建期 Node-API 工具依赖精确版本的核对，含注册表完整性、许可、OSV 查询及 Windows 原生构建证据。 |
| [source-comment-parsers-audit.json](source-comment-parsers-audit.json) | V09 开发期注释解析器审计，涵盖 Tree-sitter 核心与 Bash、CSS、Java、HTML 语法包。记录 wheel、许可、ABI 和查询证据，HTML 单列于 `htmlIncrement`。 |
| [python-lint-and-format-tools-audit.json](python-lint-and-format-tools-audit.json) | V09 核对 pylint、Black 及其依赖闭包的 14 个精确版本，其中新增 9 个包。记录许可、OSV 查询和生产依赖导出比对。 |
| [s3-sdk-type-stubs-audit.json](s3-sdk-type-stubs-audit.json) | V09 核对用于 S3 严格类型检查的四个 Python 类型存根，包含 wheel 许可、OSV 查询、兼容性和生产依赖导出比对。 |
