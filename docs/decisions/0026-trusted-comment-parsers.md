# Trusted comment parsers

状态：implemented（受限 Shell / CSS 注释适配，等待本切片独立审查）。日期：2026-11-17。

## 背景

全仓源码注释覆盖率必须大于 40%，遇到未支持的语法不能给出权威比例。
依赖冻结时有 48 个 unsupported；本切片只减少已接入路径，仍有未支持语言，比例保持 `None`，硬门禁仍然失败。
可信注释范围必须来自成熟语法解析器，不能用正则把字符串、heredoc 正文或 CSS URL 当成注释。
本决策先冻结开发工具闭包，再接入下述受限注释适配；不改变产品运行行为或整体验收状态。

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

当前首批适配范围仅为 `.sh`、精确路径 `deploy/desktop/macos/scripts/preinstall` 和 `.css`。
Shell 首行必须精确为 `#!/usr/bin/env bash` 或 `#!/bin/sh`（接受 CRLF）；未知、缺失或其他解释器保持具名未支持。
语法解析仅用于注释位置，不执行 shell，也不验证 POSIX 运行语义；shebang 不计说明注释，但保留为非空代码行。
适配器按需加载当前语法包并核验三个精确版本、核心 ABI 范围 13～15 及 grammar ABI 15。
解析器缺失、版本漂移、ABI 不兼容、`has_error`、`ERROR` 或任意 missing 节点均使整次解析失败关闭。
原始 UTF8 字节范围必须不越界、不重叠、与原文相同且位于码点边界，然后才转换物理行与 Python 码点坐标。
库存枚举与显示列宽不导入可选解析包，坏语法不能被当成零注释。
HTML 的嵌入语言尚未形成完整严格映射，Java 的 Unicode escape 存在错误注释边界反例；
HTML、Java 与 native 语言继续阻断，不能由核心包可加载推导为已支持。

## CSS 的保守上下文限定

固定 grammar 对 `a{background:url(foo/*literal*/bar)} /* real */` 不报告语法错，
却把 URL 数据中的 `/*literal*/` 错标为 comment。
[CSS Syntax 3 的 consume a url token](https://www.w3.org/TR/css-syntax-3/#consume-url-token)
将该未引号 URL 中的字符作为 token 数据；不能仅凭 comment 节点推导真实说明。
此前预检的未引号 URL 只覆盖双斜线地址，不能当成本反例已经被覆盖。

因此只接受直接父节点为 `stylesheet` 或 `block` 且没有 `call_expression` / `arguments` 祖先的 CSS comment。
其他上下文一律返回有界英文 `Unsupported CSS comment context` 错误，整次审计或修复停止，
不静默忽略节点或路径、不输出部分报告、不回退旧 scanner，也不自行归一化函数名或编写 URL lexer。
这是有意保守的子集：函数参数、声明等处的一些合法真实注释也会被拒绝，不宣称任意 CSS 全面支持。
大小写、转义 URL 名称及 quoted URL 函数旁注均有拒绝回归；普通 quoted URL 字符串与安全顶层 / 块注释仍可使用。
注释审计与 `.css` 块排版消费同一成熟范围及此限定；SCSS / LESS 与原生块排版保留既有行为，不获得比例支持。

新增 Shell / CSS 仅累计真实范围内非空正文行，空分隔符不抬分，代码与非空注释同一物理行仍双计。
Shell 正文只移除实际井号与前导空白，普通斜杠、星号及后续井号保留；CSS / TypeScript 的字面井号不被移除。
旧 TypeScript 的关闭分隔符旁有代码时也计注释行，以及既有通用 C 分隔符正文剥离顺序，均按旧契约保留，
作为后续计数语义债单独审查。
新增 Shell / CSS 的遮罩保留 CR/LF 及 Python splitlines 的 VT、FF、FS、GS、RS、NEL、LS、PS 物理分行符，
防止注释空行错移后吞掉后续代码；这只保留原文边界，不归一化内容或新增 lexer。
既有 TypeScript 遮罩仅保留 CR/LF 的边界行为在本切片保持不变，其 Unicode 分行语义另作既有债审查。
全局必须严格大于 40%，不存在逐文件配额；支持子集的 `observedRatio` 不能替代 `ratio=None` 的不完整结论。
YAML 工作流 / GYP 等嵌入代码分类仍待研究，HTML / Java / native 等未支持语言继续阻断。

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
该加载证据不代替 Mac / Windows 加载验证；适配器另有真实语法及消费者回归，仍不代表全仓覆盖率已通过。
冻结生产 export 的完整原始输出前后逐字节相同，共 56 条第三方 requirement；
SHA256 为 `be8ce958ee8f7db6ea70b35e92652842eb2303e03daa52d5e0f96c01146837a6`。

实现同步源码库存、注释审计和 CSS 块排版；`pnpm lint:comments` 使用固定服务环境的冻结、禁止同步入口。
普通 / skip-tests 发行硬门禁不放宽，剩余 unsupported 和正文违规须由完整实际审计披露。
开发前提与完整命令见[开发说明](../development.md)。本实现未修改依赖声明、锁或生产闭包。

## 替代方案

不采用自制注释正则扫描器、Pygments token 猜测或自动下载全集 grammar 的 pack。
HTML / Java / native 候选不在本次锁定范围，保留其既有具体阻塞，避免扩大未经验证的能力声明。
