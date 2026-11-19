# 2026 11 18 Tool syntax accounting implementation plan

> 编码代理：使用 `superpowers:subagent-driven-development` 执行。
> 本文是既有 [MVP 验证计划](2026-11-17-mvp-validation.md) 的细化任务，沿用其唯一台账与接续目录。

**目标：** 将已批准的固定 Vite 工具标记准确计作功能代码，保留普通注释规范和全仓质量门禁。

**架构：** TypeScript AST 桥接器为合格区间附加已知分类，Python 审计器保留这些区间的代码行。
实际 Vite 转换正反例验证工具消费；仓库普通说明只作必要中文修正。

**技术栈：** 已冻结的 TypeScript 5.9.3、Vite 6.4.5、Node 24、Python 3.12、pytest；不新增依赖。

**规格：** [Tool syntax accounting](../specs/tool-syntax-accounting.md)、[ADR 0028](../decisions/0028-工具语法计量.md)。

## 全局约束

- 全仓 C/(C+K) 严格 >40%，有效工具标记 C=0，K 保留；无文件排除、阈值或语言范围变更。
- 普通说明中文，独立单行及块首行正文 40～120 Unicode 字符，整物理行最多 120 显示列（中文两列）。
- 既有动态导入标记、业务代码、测试断言和运行时字符串保持原义；不补空洞注释凑比例。
- 本次只支持合格动态导入首实参前导固定标记；未知分类不受信任，整批坏语法不输出部分 JSON。
- 仅 dev，子代理实现且不再派生子代理、不操作 Git；协调者负责独立审查、明确路径提交和推送 dev。
- 不启动浏览器、数据库、真实 Provider 或 CI；不新增依赖、不监听端口、不读取项目真实环境配置。
- 原始命令、退出码、stdout/stderr、源码哈希和保护清单保留在任务证据目录；仅清理自身缓存与沙箱。

## 审查重点

| 输入或条件                                 | 应有行为及所属测试                                       |
| ------------------------------------------ | -------------------------------------------------------- |
| 同形文字位于字符串、模板、正则或 JSX       | 仍为代码，不生成可信标记；语法正反例                     |
| 拼写近似、附加正文或普通方法宿主           | 继续普通说明检查，不宽泛按前缀放行；桥接器与 CLI 负例    |
| 工具与普通说明同行、多个工具词元或独立多行 | 独立计算 C/K，物理代码行去重；精确计量例                 |
| 中文、emoji、CRLF/CR/LF/LS/PS 与坏语法批次 | 坐标不漂移，整批拒绝不输出半份 JSON；坐标与批次例        |
| 转换器未实际运行或消费分支未触发           | 实际 Vite 正反控制必须产生可观察差异；不以静态正则为证据 |

## 任务一：可信工具语法分类与计量

仅一个实现批次，桥接器与消费者共享角色契约，完成后统一独立 SPEC 与 QUALITY 审查。

| 路径                                                                           | 职责与允许变化                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `scripts/comment_ranges.mjs`                                                   | 既有 AST/语法失败关闭之上识别合格位置，添加可选 `codeDirective` |
| `scripts/comment_audit.py`                                                     | 可选已知分类类型；合格范围不作为说明也不从代码中遮罩            |
| `tests/acceptance/test_tool_directives.py`（新建）                             | 实际桥接、审计 CLI、Vite 公开 API 正反例；复用公开验收助手      |
| `apps/web/tests/contracts.spec.ts`                                             | 仅两条普通英文说明翻译为准确中文；工具标记和全部执行代码不变    |
| `tests/acceptance/test_comment_syntax.py`                                      | 仅既有短行内说明补足实际理由；执行代码和断言不变                |
| `AGENTS.md`                                                                    | 摘要澄清可信工具语法 C=0/K 保留并指向规格                       |
| `.agents/rules/coding-standard.md`                                             | 说明功能代码、普通说明和排版 pragma 的边界                      |
| `.agents/rules/coding-standard-rules/typescript-javascript-coding-standard.md` | 同步语言规则，不扩展未知工具                                    |

**接口：** 既有区间字段全部保持；仅合格区间增加 `codeDirective: "vite-ignore"`。
Python 类型用可选已知字面量，普通或未知角色仍按旧说明处理；不得增加 `Any` 或通用免检配置。

- [x] 写测试 `test_dynamic_import_directive_keeps_code_denominator`：实际 CLI 对仅含合格标记的导入断言 C=0、K=1、无正文问题、门禁退出 1。
- [x] 补充表中五类输入及独立行、同行混合、未知角色负例；真实 Vite 测试沿用只读预检确认的可观察正反差异。
- [x] 执行新模块观察明确的缺失分类/错误计量 RED，保留命令及失败输出；已有消费控制可先通过，不能虚构全部失败。
- [x] 实现 AST 上下文分类和 Python 计量，不改变既有普通区间 JSON 形状、坐标、换行或批次语法检查。
- [x] 修正上述三处普通说明并同步三份长期规则；注释修正用 AST/词元及原始其他字节证明业务代码不变。
- [x] 新模块通过后，执行相关完整六模块一次：`PYTHONPATH=apps/srv/src apps/srv/.venv/bin/python -m pytest tests/acceptance/test_comment_audit.py tests/acceptance/test_comment_audit_legacy.py tests/acceptance/test_comment_blocks.py tests/acceptance/test_comment_syntax.py tests/acceptance/test_source_inventory.py tests/acceptance/test_tool_directives.py -q`。
- [x] 运行触及文件 Prettier/Biome、Python Black/Ruff/Pylint/mypy、正文与显示列宽、块排版；对既存诊断做同命令前后差分，不加忽略或全仓重排。
- [x] 冻结全部归属源码及非归属 Git blob/模式，保存完整 U10 补丁；实现者报告给协调者，等待独立 SPEC 与 QUALITY 审查。
- [x] 协调者审查通过后明确路径提交源码，在该源码提交上刷新全仓注释审计一次；公开记录结果和剩余阻断，再单独提交文档并推送 dev。

## 自审记录

规格中的分类、计量、普通说明、失败关闭及工具消费均由任务一覆盖；无新增依赖或平台承诺。
桥接器产出的可选字段与消费者已知字面量一致，原有公开助手复用且无需编辑。
只读预检报告位于同一 MVP 台账的 `v09-tool-directive-qualified-preflight/report.md`，
实际结果决定 Vite 消费断言，不能把源码中警告分支静态观察写成已运行证据。

## 实际执行结果

源码 b92f53f 已提交并独立规格/质量通过，430项相关验收通过；全仓701/28/138、ratio=null，门禁仍失败。
最后一步已完成：源码b92f53f、文档4018274已推送dev，一次审计及公开记录均保留；后续状态以Git历史为准。
Windows警告路径格式Minor登记到V09，不弱化断言；详见主计划和独立质量清单。
