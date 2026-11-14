# ADR 0020：服务发行、构建工具与引擎候选

状态：T18协调批准的实现边界，独立代码复审与正常发行验收另行记录。2026-11-13。

采用标准构建链：冻结依赖→Web真实类型/lint/格式→Vite→严格固定目录暂存→Python检查和默认完整测试→Hatch wheel→离线干净安装→原子输出。沿用ADR0019完整物理库存，Vite图不代替文件闭包。库存原始字节SHA256进入原有四字段BuildInfoDTO，不修改公开协议。

构建器持独占work/build.lock，子命令使用参数数组和独立进程组；失败和取消保留阶段日志，不发布成功指针。正式产物位于不可变版本目录，最后替换output/server指针；旧发行保留。正常CI拒绝testsSkipped；应急模式必须有原因且不绕过静态、格式、注释或包完整性检查。

Hatchling1.27.0与build1.4.0已锁定，不新增打包框架。editable仅映射合同资源；正式wheel强制验证前端并唯一force_include，sdist带相同前端、合同和帮助模块，无.git重建使用归档内输入。Python控制面增加`__main__`委托既有CLI，满足`python -m veriq_server serve`。发布包含迁移、版本、许可、示例配置与候选引擎库存。

## 工具比较与冻结

| 能力 | 选择及许可 | 比较与理由 |
| --- | --- | --- |
| Python lint/格式/类型 | 已有Ruff0.15.1（MIT）、mypy1.19.1（MIT） | 保留现有成熟工具与锁，不引入第二套Python lint |
| TS/JS lint | Biome2.6.7（选择MIT，另可选Apache-2.0） | ESLint9.39.1+typescript-eslint8.48.0均MIT，但新增数十个JS依赖；Biome使用单个当前平台二进制，lint-only，Prettier保持唯一格式化工具 |
| 格式 | 已有Prettier3.6.2（MIT） | 不使用Biome formatter改变既有格式规则 |
| 覆盖率 | 已有pytest-cov7.0.0/coverage与Vitest4.1.12/V8 | 使用实际服务和核心TS测试，默认最低75%，不把tsc当测试覆盖率 |
| SBOM | CycloneDX-bom8.0.1及cyclonedx-python-lib11.12.0（Apache-2.0） | 对比Syft外部二进制，Python工具可在唯一uv锁中冻结并直接探测干净venv；不手写通用SBOM格式/依赖求解器 |

CycloneDX7.2.1曾作预研比较，但其packaging<26会降级既有26.3，故未采用。8.0.1新增12个仅开发依赖：boolean-py5.0(BSD-2-Clause)、chardet7.7.0(0BSD)、cyclonedx-bom8.0.1、cyclonedx-python-lib11.12.0、defusedxml0.7.1(PSFL)、license-expression30.4.4(Apache-2.0)、lxml6.1.3(BSD-3-Clause)、packageurl-python0.17.6(MIT)、pip-requirements-parser32.0.1(MIT)、py-serializable2.2.0(Apache-2.0)、pyparsing3.3.3(MIT)、sortedcontainers2.4.0(Apache-2.0)。全部既有Python版本保持不变。Biome锁记录各目标可选二进制，本机仅安装Linux x64。

选定工具完整解析闭包的逐项许可与OSV即时查询见[审计记录](../dependencies/t18-build-tools-audit.json)。2026-11-13查询没有返回已知漏洞；这是特定时间的数据库结果，不代表永久无漏洞。Node最初直接fetch未使用继承代理而失败，改用保留代理和TLS验证的标准HTTP客户端读取官方元数据。没有降低TLS验证或使用非官方下载源。

Python SBOM由实际离线安装venv生成并经CycloneDX验证，收集许可文本。Web适配器消费pnpm已经解析的生产树和实际package.json，生成标准CycloneDX组件/依赖边并复制许可证原文。Web报告明确是捆绑前生产依赖闭包，tree-shaking后的精确代码范围不被伪造。工具本身不作为控制服务运行依赖。

## 引擎身份与权限

当前历史开发发行是engine/compiler/sdk均0.1.0，不能因源码变动覆盖同版本批准身份。新候选engine1.0.0独立于product/compiler/sdk0.1.0。生成器编译真实SDK/合同，使用确定性tar和npm离线锁生产依赖归档，不调用测试夹具，不访问issuer。

操作员显式晋升复用T14`authority_guard(settings, False)`及issuer-owned `.lock`→`.inventory.lock`顺序。候选文件先校验，锁内重读批准清单；同版本不同身份拒绝，旧条目保留，fsync后原子替换。构建CI没有私钥或晋升权限。

Settings.validation_engine_version默认0.1.0保持兼容；明确晋升和Runtime部署完成后，生产示例选择1.0.0。选择只影响新快照sourceHash、Job manifest及能力要求；旧预览冲突，旧Job/签名包/回执冻结版本不变。选择不能授予批准权，UNVALIDATED_DEBUG仍保持原语义。

## 平台、资源与验收边界

裸包基线Ubuntu24.04 x64/Python3.12，wheelhouse只取uv锁中的兼容二进制并核对散列，不复制宿主编译环境。固定容器基础镜像`python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e`独立验收。镜像不包含Node或Chrome。摘要通过官方registry元数据确认，本机没有盲目拉取镜像。

本次开发宿主Debian13，启动时仅约990MiB空闲；匹配Playwright1.65.0的chromium-headless-shell1254/158.0.8127.18选择性安装约288MiB，wheelhouse约40MiB，顺序创建临时venv并清理自有中间目录。Debian实测不代表Ubuntu或容器已验收。SDK原15s/2workers保持不变，正式全套136测试与91.46%行覆盖率在匹配浏览器上通过；历史旧浏览器超时原因仍未知，不归因为已证明修复。

真实lint/格式/B05注释门禁保持失败关闭。历史源码债由T22整改，T18候选组件测试通过不等于正常发行验收通过。实际Provider、Windows、桌面和正式签名/发布属于独立证据与授权范围。

# ADR 0020: server release and engine candidate

Use the frozen frontend→stage→server checks/tests→Hatch wheel→offline clean install→atomic output pipeline. Preserve ADR0019's complete physical inventory. Editable installs need no frontend; formal wheels and no-Git source archives contain the same checked resources.

Add only audited development tooling: Biome2.6.7 for linting, retaining Prettier3.6.2 for formatting, and CycloneDX-bom8.0.1 with its locked library for validated SBOMs. Preserve every existing Python pin. The exact license/point-in-time vulnerability delta is recorded separately.

Engine1.0.0 is a new candidate identity, distinct from product/compiler/SDK0.1.0. Building never approves it. Explicit operator promotion preserves T14's authority locks, old identities and immutable same-version bytes. Selection changes only new snapshots; it does not rewrite frozen jobs or signed packages.

Ubuntu24.04 and the separately pinned Python container require actual target execution. Debian clean-install proof and the matched-browser SDK pass do not replace those proofs or explain the historical timeout. Existing formatting/comment debt remains an enforced release blocker.
