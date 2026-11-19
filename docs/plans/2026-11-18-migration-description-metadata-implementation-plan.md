# 2026 11 18 Migration description metadata implementation plan

> 编码代理使用superpowers:subagent-driven-development。本文细化原MVP验证计划，沿用其唯一执行台账。

**目标：** 按用户已确认的方案保持迁移英文运行输出，并用独立中文说明满足源码规范。

**架构：** 0006初始文档改为中文开发说明，原英文值显式保存为导入块后的模块元数据；DDL和迁移图保持。
实际Alembic与正式审计入口同时验证英文输出及中文说明，不扩展语言豁免。

**技术栈：** 冻结Python3.12、Alembic1.18.4、pytest及既有comment_audit验收助手，不新增依赖。

**规格：** [Migration description metadata](../specs/migration-description-metadata.md)、[ADR0029](../decisions/0029-迁移说明运行元数据.md)。

## 全局约束

- 原英文值精确为 `Existing queued VALIDATE jobs retain their bytes and identity.`。
- 仅0006迁移的指定元数据表示及普通提示可变；revision/down_revision、DDL、其他代码和字符串保持。
- 中文说明40～120Unicode，整物理行120显示列CJK2；英文程序值C=0/K保留，全仓严格>40不变。
- 不执行真实SQL/迁移/数据库、浏览器、原生或Provider，不改变审计器/配置/依赖。
- 子代理唯一源码writer，不子代理派生/Git写入；root独立审查后明确路径提交、只推送dev，master不改。
- 保留raw命令/输出/源码SHA及保护manifest，仅清自身缓存与临时目录。

## 审查重点

| 条件                                | 预期及任务一的验证                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| 原字符串有字符或标点漂移            | 实际模块及Script.doc/longdoc精确等于原英文常量                                                 |
| DDL或迁移图意外变化                 | 仅归一化指定模块文档值并去除指定等值赋值后全AST相等，其他词元和字符串保持                      |
| 只改文案却使history/current描述变化 | 真实command.history正常/verbose及Script.cmd_format保持描述与迁移边，路径差异仅显式归一化临时根 |
| 日志验证误执行升级函数              | 真实离线MigrationContext在日志后、原DDL前由哨兵中止，原upgrade/downgrade均未执行，无连接       |
| 误把元数据加进注释分子              | 实际微型仓库审计正文通过，已知元数据赋值留在代码K，无新豁免                                    |

## 任务一：迁移字段表示与实际消费保真

| 路径                                                            | 允许范围                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| apps/srv/src/veriq_server/migrations/versions/0006_execution.py | 指定初始文档改中文，导入后添加等值 `__doc__` 赋值；upgrade普通提示改中文 |
| tests/acceptance/test_migration_metadata.py（新建）             | 实际模块、Alembic显示/日志、正式审计验收；复用既有公开助手，不修改助手   |

**接口：** 对外仍是同值module.`__doc__`和原Alembic迁移对象；不新增产品API或审计字段。

- [x] 编写test_migration_description_preserves_alembic_consumers，以实际迁移和明确原英文常量验证Script.doc/longdoc、显示与日志。
- [x] 编写test_migration_description_passes_prose_audit，复制实际源码到公开repository夹具，断言真实审计violations为空。
- [x] 修改前运行新模块，记录语言约束的真实RED；原英文输出控制本来通过，不能虚构全红或生产DDL故障。
- [x] 实施唯一元数据表示和两处中文说明，保留原值及导入顺序，不运行upgrade/downgrade。
- [x] 最终新模块一次通过；原430/50/16及业务/DB/PW不重复，实际Alembic消费证据不冒称数据库迁移通过。
- [x] 比对指定迁移的精确AST/词元/其他字面量；触及Python的Black/Ruff/Pylint/mypy/正文/块/显示列检查不得新增诊断，记录旧债。
- [ ] root冻结完整补丁及保护清单，派独立SPEC/QUALITY审查；通过后源码提交、一次全仓审计、单独文档提交和推送dev。

## 自审与授权来源

三个呈现入口、DDL不变和计量均有任务一对应，接口原值单一，测试读取实际模块而非复制预期实现。
用户已明确选择该具体方案及既有subagent执行方式，细化计划不再次请求同一批准。
普通38条中的0006旧提示归本任务，后续纯Python批次应移除它，避免重复派发。

自审补充：Pylint使用正常模块文档；采用中文模块文档加英文元数据赋值，避免#头导致新增C0114。
仅两个精确AST变化，仍须验证Alembic加载完成后的真实输出；不改日志过滤器或配置。

## 实际结果

source3026258已提交并独立通过，4项验收通过、原英文运行呈现不变。
全仓702/28/111、ratio=null仍失败；最后一步中源码与一次审计已完成，文档提交/远端同步状态按Git历史核对。
