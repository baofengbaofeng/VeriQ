# VeriQ 第三方依赖声明

VeriQ 沿用 AGPL-3.0 项目许可证。第三方代码继续适用各自的许可证。

网页界面更新选用 `@radix-ui/react-dropdown-menu` 2.2.1、`@radix-ui/react-select` 2.4.1 和 `@radix-ui/react-tooltip` 1.4.1（MIT），并继续使用既有的 `@radix-ui/react-dialog` 1.3.1（MIT）与 `class-variance-authority` 0.7.1（Apache-2.0）。新增安装的 19 个包均声明采用 MIT，三项新增的直接控件也在其中。分发时须保留上游版权声明、许可证原文以及随附的 NOTICE 文件。用途、署名、保留的元数据证据及 2026-11-17 对生产依赖图的漏洞公告查询见 [ADR-024](https://github.com/baofengbaofeng/VeriQ-Knowledge/blob/master/decisions/ADR-024-%E7%BD%91%E9%A1%B5%E7%95%8C%E9%9D%A2%E4%BE%9D%E8%B5%96.md)。查询结果限于当时的记录，发行仍须单独核对软件物料清单（SBOM）。

T01 的依赖选型、精确版本、直接依赖声明的许可证、替换边界和验证范围见 [ADR-003](https://github.com/baofengbaofeng/VeriQ-Knowledge/blob/master/decisions/ADR-003-%E5%B7%A5%E7%A8%8B%E5%9F%BA%E7%BA%BF.md)。机器可读清单记录实际安装的依赖元数据，包含开发依赖。解析后的完整依赖版本和哈希见锁文件。[npm 许可清单](docs/dependencies/npm-license-inventory.json) · [Python 许可清单](docs/dependencies/python-license-inventory.json) · [依赖清单与审计索引](docs/dependencies/README.md)

对于提供两种许可证供选择的直接依赖，DOMPurify 选用 Apache-2.0，cryptography 选用 BSD-3-Clause，structlog 选用 MIT。仍须保留上游版权声明与许可证原文，具体条款以上游包的许可证文件为准。

仓库尚未产出完整的 VeriQ 发行物。现有清单记录已安装依赖的元数据，最终的原生二进制 SBOM 和安装包声明须按各支持平台的实际交付内容单独编制。组装发行物时，须纳入 Python 与 npm 依赖、Node、Electron/Chromium、Playwright 浏览器、原生工具和所选 MySQL 分发版本随附的许可证原文与声明。当前 Linux 安装中未安装的目标平台专用可选依赖，也须纳入相应平台的发行核查。须逐项履行各依赖的署名义务，包括采用 CC-BY-4.0 的传递依赖所附的声明。

T04 使用 `rfc8785 0.1.4` 与 `canonicalize 2.1.0` 实现 RFC 8785/JCS 规范化，两者均采用 Apache-2.0。发行物须随附两者的上游 LICENSE 原文。已安装依赖的元数据清单与锁文件均收录这两个精确版本。[ADR-005](https://github.com/baofengbaofeng/VeriQ-Knowledge/blob/master/decisions/ADR-005-%E4%B8%8D%E5%8F%AF%E5%8F%98%E8%B5%84%E4%BA%A7%E6%A0%A1%E9%AA%8C.md)

T05 的 Node 编译器继续使用已锁定的 TypeScript 5.9.3、Ajv 8.18.0 和 `ajv-formats` 3.0.1，并新增 Vitest V8 覆盖率工具 4.1.12，用于开发验证。新增依赖的 MIT 与 BSD-3-Clause 许可元数据收录在 npm 清单中。[ADR-006](https://github.com/baofengbaofeng/VeriQ-Knowledge/blob/master/decisions/ADR-006-%E7%A1%AE%E5%AE%9A%E6%80%A7%E7%BC%96%E8%AF%91%E4%BA%A7%E7%89%A9.md)

T12 新增下列存储及流式传输依赖。Moto、Flask 及相关服务端辅助组件仅用于开发环境中的模拟器。生产和开发环境的精确依赖图保存在 `apps/srv/uv.lock` 与 `pnpm-lock.yaml`。分发 `python-dateutil` 时选用 BSD-3-Clause，实际发行物须随附上游许可证文件。[ADR-014](https://github.com/baofengbaofeng/VeriQ-Knowledge/blob/master/decisions/ADR-014-%E6%8A%A5%E5%91%8A%E4%B8%8E%E8%AF%81%E6%8D%AE%E5%AD%98%E5%82%A8.md)

| 依赖包 | 版本 | 许可证 |
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

T13 新增官方模型服务 SDK 及下列解析出的 Python 依赖，继续复用既有的 HTTPX、Pydantic 和 cryptography。2026-11-11 对新增依赖图的 OSV 查询未返回漏洞公告，结果限于查询当时。发行物须保留上游许可证原文。`sniffio` 选用 MIT。按 `tqdm` 的上游许可证，代码采用 MPL-2.0，其中部分贡献采用 MIT，分发时须保留两者的声明。[ADR-015](https://github.com/baofengbaofeng/VeriQ-Knowledge/blob/master/decisions/ADR-015-%E6%A8%A1%E5%9E%8B%E6%9C%8D%E5%8A%A1%E6%8E%A5%E5%85%A5%E8%BE%B9%E7%95%8C.md)

| 依赖包 | 版本 | 许可证 |
| --- | --- | --- |
| openai | 2.29.0 | Apache-2.0 |
| anthropic | 0.84.0 | MIT |
| distro | 1.9.0 | Apache-2.0 |
| docstring-parser | 0.18.0 | MIT |
| jiter | 0.19.0 | MIT |
| sniffio | 1.3.1 | MIT OR Apache-2.0 |
| tqdm | 4.70.1 | MPL-2.0 AND MIT |

T14 新增 `yauzl` 3.4.0（MIT）、解析得到的 `pend` 1.2.0（MIT），以及仅供开发使用的 `@types/yauzl` 3.4.0（MIT）。Python 写入 ZIP 继续使用既有标准库，Ed25519 继续复用 cryptography 和 Node crypto。审计记录新增依赖图的精确版本 OSV 查询结果和已安装许可证文件的哈希。查询在记录时点未返回漏洞公告，范围限于本次新增依赖，发行时仍须另行核查。分发时须随附上游 MIT 声明。[离线归档依赖审计](docs/dependencies/offline-archive-dependency-audit.json)

T18 新增仅供开发使用的 Biome 2.6.7（选用 MIT）和 CycloneDX-bom 8.0.1，Python 依赖图的变更涉及 12 个精确版本的包。既有运行时版本保持不变。工具审计记录许可证和 2026-11-13 的 OSV 查询结果，当时未返回漏洞公告。服务端 SBOM 收集实际安装依赖的许可证原文。网页端物料清单记录打包前的生产依赖闭包，并保留上游 LICENSE、NOTICE 与 README 文件。控制服务的运行时 wheelhouse 不安装这些构建工具。[ADR-020](https://github.com/baofengbaofeng/VeriQ-Knowledge/blob/master/decisions/ADR-020-%E6%9C%8D%E5%8A%A1%E7%AB%AF%E5%8F%91%E8%A1%8C%E6%B5%81%E7%A8%8B.md) · [服务端发行工具审计](docs/dependencies/server-release-tools-audit.json)

T20 将已锁定的 `@electron/fuses` 1.8.0（MIT）提升为桌面端直接依赖，用于核验 Cookie 加密 fuse，各依赖版本保持不变。审计覆盖实际安装闭包中的 13 个精确版本，记录 MIT 和 ISC 许可证、与注册表一致的完整性信息及 2026-11-14 的 OSV 响应。该次查询未返回这些版本的漏洞公告，评估范围限于所列依赖。发行物须保留所有上游许可证原文。[Electron Cookie fuse 审计](docs/dependencies/electron-cookie-fuses-audit.json)

R03 为恢复测试将已解析的 `undici` 7.30.2（MIT）直接声明为仅供开发使用的依赖，并新增 `tough-cookie` 6.1.0（BSD-3-Clause）及其依赖 `tldts` 7.5.4、`tldts-core` 7.5.4（MIT）。单元测试入口也直接声明既有的 `tsx` 4.23.15（MIT），其解析闭包保持不变。新增解析的包只有 `tough-cookie`、`tldts` 和 `tldts-core`。分发时须保留每个包的上游 LICENSE 及版权声明。这些依赖仅用于恢复测试，Runtime 的生产依赖闭包和锁定的执行引擎保持不变。单一源（origin）的传输边界、Playwright 自动追踪的范围、依赖发布时间证据及带日期的精确版本漏洞公告查询见 [ADR-025](https://github.com/baofengbaofeng/VeriQ-Knowledge/blob/master/decisions/ADR-025-%E7%BD%91%E9%A1%B5%E6%B5%8B%E8%AF%95%E6%81%A2%E5%A4%8D%E7%9A%84%E4%BC%A0%E8%BE%93%E4%B8%8E%E8%BF%BD%E8%B8%AA%E8%BE%B9%E7%95%8C.md)。

V09 新增仅供开发使用的 `tree-sitter` 0.26.1、`tree-sitter-bash` 0.25.1、`tree-sitter-css` 0.25.0 和 `tree-sitter-java` 0.23.5，均采用 MIT。审计保留各 wheel 中的许可证原文、确切的分发来源及 wheel 的 SHA-256 哈希，以及带日期的精确版本 OSV 响应。上游版权声明如下。[源码注释解析器审计](docs/dependencies/source-comment-parsers-audit.json)

- `tree-sitter`：Copyright (c) 2019 Max Brunsfeld, GitHub
- `tree-sitter-bash`：Copyright (c) 2017 Max Brunsfeld
- `tree-sitter-css`：Copyright (c) 2018 Max Brunsfeld
- `tree-sitter-java`：Copyright (c) 2017 Ayman Nadeem

分发开发环境或这些工具时，须保留完整的 MIT 版权声明、许可声明和保证免责声明。控制服务的生产 `--no-dev` wheelhouse 不含这些工具，其代码也不复制到服务端 wheel 或 Runtime。保留的 OSV 响应在各自的取证时点未列出漏洞公告，评估范围限于所列依赖。注释解析的用途边界、ABI 验证以及生产依赖闭包不变的证据见 [ADR-026](https://github.com/baofengbaofeng/VeriQ-Knowledge/blob/master/decisions/ADR-026-%E5%8F%AF%E4%BF%A1%E6%B3%A8%E9%87%8A%E8%A7%A3%E6%9E%90%E5%99%A8.md)。

这一阶段的适配器仅支持符合条件的 Shell、CSS 和 Java 源码。Java 适配器拒绝原始 Unicode 转义写法和裸 CR 字节，即使它们出现在其他方面合法的输入中。适配器接受 LF 与 CRLF。固定版本的语法解析器可能将裸 CR 后的代码归入行注释，JLS §3.4 与 §3.7 则定义了相应的行边界。

V09 为严格检查 S3 类型新增四个仅供开发使用的 MIT 分发包。`boto3-stubs[s3]` 1.44.0 和 `mypy-boto3-s3` 1.44.0 的上游版权声明为 Copyright (c) 2026 Vlad Emelianov。`botocore-stubs` 1.43.126 和 `types-s3transfer` 0.19.3 的上游版权声明为 Copyright (c) 2022 Vlad Emelianov。分发这些工具时，须保留原始版权声明、许可声明和保证免责声明。审计保存官方 wheel 的哈希、MIT 原文及 2026-11-17 的精确版本 OSV 查询。较旧核心类型声明的核验范围见 ADR，生产 `--no-dev` 依赖导出仍包含原有的 56 个条目和分发包哈希。[S3 SDK 类型存根审计](docs/dependencies/s3-sdk-type-stubs-audit.json) · [ADR-027](https://github.com/baofengbaofeng/VeriQ-Knowledge/blob/master/decisions/ADR-027-%E5%AF%B9%E8%B1%A1%E5%AD%98%E5%82%A8%E5%BC%80%E5%8F%91%E5%A5%97%E4%BB%B6%E7%B1%BB%E5%9E%8B%E5%AD%98%E6%A0%B9.md)

## V09 符合条件的 HTML 注释解析器

V09 使用仅供开发的 `tree-sitter-html` 0.23.2 将注释适配器扩展至符合条件的 HTML。该包采用 MIT，仅用于源码静态计量，未纳入控制服务的生产 `--no-dev` 依赖。分发时须保留下方的上游声明。Linux x86_64 wheel、精确版本 OSV 响应和支持范围见[源码注释解析器审计](docs/dependencies/source-comment-parsers-audit.json)与 [ADR-026](https://github.com/baofengbaofeng/VeriQ-Knowledge/blob/master/decisions/ADR-026-%E5%8F%AF%E4%BF%A1%E6%B3%A8%E9%87%8A%E8%A7%A3%E6%9E%90%E5%99%A8.md)。

### 上游许可证原文

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

## Excel 数据集导入

Excel 导入使用 `read-excel-file` 9.3.20、`fflate` 0.8.3 及解析出的 `saxen` 11.2.0、`unzipper-esm` 0.13.3 和 `worker-f` 0.1.25。五个包均采用 MIT，分发须保留上游许可证和版权原文。Web 发行 SBOM 按实际安装闭包收集这些声明。[ADR-032](https://github.com/baofengbaofeng/VeriQ-Knowledge/blob/master/decisions/ADR-032-Excel%E6%95%B0%E6%8D%AE%E9%9B%86%E5%AF%BC%E5%85%A5.md) · [精确版本审计](docs/dependencies/excel-import-dependency-audit.json)

## TailAdmin React Free 界面来源

网页界面框架、导航图标、资源卡片、表单和表格布局改编自 TailAdmin React Free 的提交 `9aaac11e9e6fa87d0afe0e976b5ac291e29eeeb9`。响应式页眉、工作区及用户菜单、图标和工作区表单对话框也参考并改编自 v2.5.1 的源码。[TailAdmin React Free](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard) · [v2.5.1 源码](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/tree/486ed748b21e032a4432effeca4ef3684fa223d3)

### 上游许可证原文

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

## MIT 许可证中文译文

上方两份 MIT 许可证的许可条款、保留条件和免责声明相同。以下译文供阅读，分发时须保留相应的上游原文。

- `tree-sitter-html`：版权所有 © 2014 Max Brunsfeld
- TailAdmin React Free：版权所有 © 2023 TailAdmin

在满足下列条件的前提下，特此免费授予任何取得本软件及相关文档文件副本（统称“软件”）的人不受限制地处置本软件的权利，包括但不限于使用、复制、修改、合并、发布、分发、再许可和/或销售本软件的副本，并允许本软件的接收者行使同样的权利。

本软件的所有副本或实质性部分均须包含上述版权声明和本许可声明。

本软件按“现状”提供，不作任何明示或默示保证，包括但不限于适销性、特定用途适用性及不侵权保证。无论基于合同、侵权或其他事由，作者或版权持有人在任何情况下均不对因本软件、本软件的使用或其他处置而产生或与之有关的任何索赔、损害赔偿或其他责任负责。
