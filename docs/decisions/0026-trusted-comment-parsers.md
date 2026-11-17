# Trusted comment parsers

状态：selected（仅开发依赖冻结；尚未实现注释适配器）。日期：2026-11-17。

## 背景

全仓源码注释覆盖率必须大于 40%，遇到未支持的语法不能给出权威比例。
现有门禁仍有 48 个 unsupported，比例仍为 `None`，硬门禁仍然失败。
可信注释范围必须来自成熟语法解析器，不能用正则把字符串、heredoc 正文或 CSS URL 当成注释。
本决策只准备受限开发工具闭包，不交付任何语言适配器，也不改变产品行为或验收状态。

## 决策

在 `apps/srv/pyproject.toml` 的 dev group 中精确固定以下三个独立包，使用 uv 正常生成锁文件：

| 包               | 版本   | 原文许可 | 用途                                    |
| ---------------- | ------ | -------- | --------------------------------------- |
| tree-sitter      | 0.26.1 | MIT      | 固定语法树核心与字节位置                |
| tree-sitter-bash | 0.25.1 | MIT      | Bash / 明确 POSIX-sh 输入的注释语法边界 |
| tree-sitter-css  | 0.25.0 | MIT      | CSS 注释语法边界                        |

不启用这些包的可选 extras。实际锁增量恰为三个包，没有新增传递运行依赖。
已有包的版本、来源与解析标记均未移动，产品 dependency list 和生产闭包保持不变。
开发环境沿用 `uv sync --project apps/srv --frozen --all-groups`，不依赖全局安装的解析器。
使用单独官方 grammar wheel；不采用会在运行时联网下载 grammar 的 language pack 或插件发现。

后续首批适配范围仅为 `.sh`、精确路径 `deploy/desktop/macos/scripts/preinstall` 和 `.css`。
Shell 必须有明确、已识别的 Bash / POSIX-sh shebang；未知、缺失或其他解释器保持未支持。
语法解析仅用于注释位置，不执行 shell，也不验证 POSIX 运行语义；shebang 不计为说明注释。
后续适配器必须在解析器缺失、ABI 不兼容、`has_error`、`ERROR` 或 missing 节点时失败关闭。
HTML 的嵌入语言尚未形成完整严格映射，Java 的 Unicode escape 存在错误注释边界反例；
HTML、Java 与 native 语言继续阻断，不能由核心包可加载推导为已支持。

## 许可、安全与供应证据

[精确审计记录](../dependencies/v09-comment-parsers-audit.json)保留三个官方 wheel 的来源、SHA256、
完整 MIT 版权和许可证原文、原文摘要、精确版本 OSV 请求与原始响应以及证据采集时间。
复用同一会话已有实际官方供应审计，不重复整个依赖库研究或全库漏洞扫描。
三个 wheel 的摘要均与官方元数据和新锁文件一致，安装后的 28 个原始 payload 文件逐字节相同。
原 wheel 的 RECORD 已逐项核验；RECORD 自身无摘要是 wheel 的正常自引用边界。

MIT 原文允许此受限开发工具用途，与既有 AGPL-3.0-only 项目许可兼容。
分发开发环境或这些工具时，必须保留各上游 MIT 版权、许可和免责条款。
开发标记不免除分发义务；[第三方声明](../../THIRD_PARTY_NOTICES.md)指向完整原文。
生产 wheel 不复制这些工具代码，生产 `--no-dev` wheelhouse 不含这三个包，Runtime 闭包不变。

精确 OSV 响应在采集时均未列出漏洞；每包记录供应证据采集时间，未单独记录每次 HTTP 查询时刻。
该结果不证明不存在未知漏洞或未来公告，也不证明任意解析输入都有资源上界。
不因依赖采用而宣称全发行安全评估通过。

## 验证与后果

普通冻结服务环境在 Python 3.12.14 / Linux x86_64 中成功导入三包并实际创建两族 Language / Parser。
核心接受 grammar ABI 13～15，Bash 与 CSS 实测均为 ABI 15，分别提取一条真实注释并排除字符串伪注释。
该证据不代替 Mac / Windows 加载验证，不代表语法适配器的失败路径或全仓覆盖率已通过。
冻结生产 export 的完整原始输出前后逐字节相同，共 56 条第三方 requirement；
SHA256 为 `be8ce958ee8f7db6ea70b35e92652842eb2303e03daa52d5e0f96c01146837a6`。

本次未修改源码库存、注释审计、工具入口或正常 / skip-tests 发行门禁。
后续须单独实施适配器及有意义的边界回归，然后重新审查完整范围和剩余 unsupported。

## 替代方案

不采用自制注释正则扫描器、Pygments token 猜测或自动下载全集 grammar 的 pack。
HTML / Java / native 候选不在本次锁定范围，保留其既有具体阻塞，避免扩大未经验证的能力声明。
