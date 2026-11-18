# 2026-11-18 Python Tool Syntax Accounting

> **编码代理执行要求：** 使用 superpowers:subagent-driven-development；只由实现子代理修改源码，协调者组织独立复审和提交。

**目标：** 在已有固定工具计量原则内识别三处 Python 行尾类型检查标记，并保留普通说明及原默认解析兼容性。

**架构：** 继续由 CPython 默认 AST 和 tokenize 解析文档串与代码；辅助类型注释 AST 只提供有限资格。真实微型仓库和既有审计 CLI 验收输出，mypy 合成静态输入证明消费行为。

**技术栈：** 现有 Python 3.12、mypy 1.19.1、pytest、Node 24 和 Vite 6.4.5；不新增依赖，不修改锁。

**规格：** [工具语法计量](../specs/tool-syntax-accounting.md)；[ADR 0030](../decisions/0030-python-tool-syntax-accounting.md)。

## 全局约束

- 全仓严格 C/(C+K)>40%，不得排除工具宿主整行、路径或新增可配置前缀白名单。
- 中文正文40～120个Unicode字符、每物理行120显示列，原三个工具标记字节保持。
- 默认AST为原语法和文档串权威，辅助类型注释AST的SyntaxError只不给工具资格。
- 仅完整真实COMMENT及精确单码标签，同物理行有非文档串内的NAME/NUMBER/STRING词元和已有K才接纳。
- 不修改其他程序、普通注释、元数据、测试断言强度、依赖、生产导出或旧冻结制品。
- 原始失败、源码、命令、输出及保护清单留存；仅清自有临时缓存，只提交推送dev，master不变。

## 审查重点

- 类型注释辅助解析不能把原本合法的Python变成整文件失败。
- 有K的闭括号或跨行字符串收尾仍不足以成为工具宿主。
- 字符串/文档串内容和附加普通说明不被固定词元一并免计。
- 去掉工具说明块之后，相邻普通说明仍独立通过首正文规则。
- 只含合格工具语法的源码C为0但K保留，CLI仍因比例不足返回失败；不出现假绿。

## 任务一：资格、计量及消费验收

**文件范围**

- 修改 `scripts/comment_audit.py`：辅助资格和既有 `_python_source` 的最小接入。
- 新建 `tests/acceptance/test_python_tool_directives.py`：计量、默认解析兼容、边界与真实mypy行为。
- 修改 `apps/srv/src/veriq_server/contracts.py`：只准确补充相邻第40行普通中文说明；三个固定标记所在行保持。
- 修改 `tests/acceptance/test_tool_directives.py`：只在临时文件仍存在时预存解析后的POSIX绝对路径，退出临时目录上下文后使用缓存期待值。

**接口约束**

- 新增私有 `_python_type_ignore_tags(text: str) -> dict[int, str]`，复用 `ast.parse(..., type_comments=True)`；仅返回两个精确已知标签。仅捕获辅助SyntaxError并返回空资格。
- `_python_source` 的返回类型、默认文档串解析、原代码集合及通用说明分组保持；合格COMMENT不构造普通说明块。
- 报告字段和方法标识不变，未知标记保持普通验收，调用现有支持夹具，不改共享测试支持器或生产API。

- [x] 新写真实审计计量与CLI用例：两个完整词元、同行代码去重、实参行、CRLF/CR/LF及Unicode；先记录因缺少资格而失败的RED。
- [x] 加负例：附加正文、尾空格、大小写/拼写/前缀/未知码/多码/裸ignore、字符串和文档串内同形字、纯说明行、仅闭括号行、跨行字符串收尾；断言旧C/K和普通正文问题保持。
- [x] 加默认AST可解析但辅助AST失败的输入，如 `print(1)  # type: int` 后隔空行放精确工具标记；断言不因辅助分类中断，标记回归普通说明。默认非法源码仍沿原路径失败，CLI不写部分JSON。
- [x] 加相邻普通说明与文档串同行代码用例；真实短普通说明仍被检查，完整普通中文说明可独立计C，K自然去重。
- [x] 最小实现辅助资格和真实词元/宿主验证；不改通用分组或默认AST函数口径。
- [x] 使用同一严格隔离配置运行四组真实mypy静态输入：精确标记退出0；移除退出1且含no-any-return与arg-type；无待抑制错误退出1且含unused-ignore；错拼退出2且含syntax。输入不执行、不加载项目插件或凭据，缺版本直接报错而非跳过。
- [x] 只补充contracts相邻短说明，按实际包内资源优先与源码目录回退解释；原AST、字符串及三个标记保持。保持Vite原警告/次数及清理断言；在临时文件存在时将 `(root / path).resolve().as_posix()` 存入期待路径字典，退出上下文后按当前path使用缓存值。
- [x] 跑新模块GREEN后，运行原六个工具模块和新模块一次，保留全部结果；不执行无关业务、DB、浏览器、原生或付费服务。
- [x] 跑触及源的正文/宽度/块排版/Black/Ruff/Pylint/mypy，基线与最终精确对照旧债；冻结所有原始证据、保护清单和完整新文件补丁。
- [ ] 独立SPEC及QUALITY、源码提交和一次全仓审计已完成；本次文档提交及pushdev以Git历史和远端状态核对。

### 必须可观察的计量断言

`marker` 参数只取规格中两个精确完整词元；合成函数名无需运行或真实业务依赖。
以下用例通过现有微型仓库、审计函数或CLI观察文件计数，不直接断言私有实现文本。

| 测试名称或族                                               | 明确输入                                            | C / K / 正文问题                           |
| ---------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------ |
| `test_inline_tool_marker_keeps_code`                       | `value = call(1)` 后同一行放 `marker`               | 0 / 1 / 0；ratio=0、passed=false、CLI退出1 |
| `test_known_marker_on_argument_line`                       | 三行调用，第二行 `1,` 后放 `marker`                 | 0 / 3 / 0                                  |
| `test_closing_delimiter_is_not_tool_host`                  | 三行表达式，最后一行仅 `)` 后放 `marker`            | 1 / 3 / 1                                  |
| `test_unknown_or_augmented_marker_stays_ordinary`          | 一行调用后放未知码或带附加说明的完整COMMENT         | 1 / 1，按实际普通正文长度及中文规则断言    |
| `test_literal_tool_spelling_has_no_comment_role`           | 单行赋值字符串包含 `marker`                         | 0 / 1 / 0                                  |
| `test_auxiliary_type_comment_failure_keeps_default_parser` | `print(1)  # type: int`，隔一空行再放调用及精确标记 | 2 / 2 / 2；默认AST有效，不中断             |
| `test_adjacent_ordinary_comment_keeps_own_first_body`      | 第一行调用及合格标记；第二行短普通中文注释          | 1 / 1 / 1；第二行不得免计                  |

其他换行、坐标和文档串边界在同族参数化用例中覆盖；完整合法普通说明使用明确中文正文，不用工具前缀凑长度。

原六模块命令：

```sh
PYTHONPATH=apps/srv/src apps/srv/.venv/bin/python -m pytest \
    tests/acceptance/test_comment_audit.py tests/acceptance/test_comment_audit_legacy.py \
    tests/acceptance/test_comment_blocks.py tests/acceptance/test_comment_syntax.py \
    tests/acceptance/test_source_inventory.py tests/acceptance/test_tool_directives.py \
    tests/acceptance/test_python_tool_directives.py -q
```

不把新任务的局部测试扩成完整MVP已验收，也不调用实际编译发行生产器覆盖旧缓存或签名材料。

## 实施结果

源码`c97526e`已独立复审，52新用例及唯一482全组通过，三marker/957保护保持；全仓706支持/28解析阻断/0正文，C10656/K151513，coverageComplete=false、ratio=null、passed=false，支持子集约6.57092%。
所有新测试和原始证据保留，纯工具验证不替代Windows实测或全产品验收。
