# VeriQ：macOS受控停止实施计划

更新：2026-11-14（北京时间）。依据[已确认范围与设计](../specs/macos-controlled-stop.md)，属于完整T20的子计划，不新增MVP模块，不代表Mac已实现。用户已批准受控停止验收范围，最低14与宿主原生Chrome不得重复询问。

| 切片 | 交付 | 主要文件/调用点 | 验证门槛 | 状态 |
| --- | --- | --- | --- | --- |
| A1 范围合同与服务端 | `processStopScope`保留、Darwin正回执缺/错范围拒绝，未知隔离，历史兼容 | contracts源/生成物/桌面派生Schema；completion、maintenance、import_result及适用报告facts | Node/Python正负样本，真实服务finish/reconcile不误释放容量，跨Workspace/fence仍有效 | 待实施 |
| A2 Runtime与离线传播 | Linux/Windows经原证明后声明原范围；真正未派生明确标注；offline store/result/report全链保存范围 | processes、windows-processes、supervisor、offline/run/store/reports及生成完成清单 | 既有内核证明未弱化；未知不变成NO_PROCESS；重启/导出/导入不丢范围 | 待实施 |
| B Darwin原生基础 | 有限私有fd操作、已登记进程的定点退出观察及peer认证 | 新native/darwin源与Node-API适配/build脚本；records、credentials/files及历史守卫 | 两架构实际build；symlink/owner/权限/长度/提交失败、连接身份/退出竞争；缺能力明确失败 | 待实施 |
| C 受控所有权 | Agent持有BrowserServer/outer worker；命令结清；SDK worker登记；CONTROLLED_STOPPED | 新darwin-processes；worker/provider；SDK注册fixture；在线/离线PW config | 原生Chrome真实执行/退出；CLI/worker/owner故障与乱序重放；完整登记集合结清才正回执 | 待实施 |
| D 入口与发行验收 | 真实ready后开放Darwin；完整库存/路径/角色与独立Node；双架构工作流 | distribution/paths/doctor/CLI、构建与发行说明、Mac目标CI | 无终端GUI/离线/同Attempt停止/恢复/安装升级与证据；不能用单测代替 | 待实施 |

执行约束：采用subagent，单一产品writer、独立规格与质量审查；每切片按真实行为RED→GREEN和适用全套，不反复碰绿，不改超时掩盖失败。Node兼容门槛的当前用户修正优先完成，正式发行继续记录实际具体版本/hash，不以浮动范围代替身份。

A1不开放doctor或Darwin启动。正回执范围检查发生在容量释放前；失败回执即使缺范围也必须可报告停止未知并保留隔离。服务端只保存客户端声明，不将它升级为OS远程证明。新字段不能被完成facts重建、离线导入或报告生成遗漏。

A2真正未派生仅由本地持久pre-spawn状态产生；不从根PID消失或错误码推断。旧缺字段保留兼容，不能给历史数据补造scope。管理员解除与自动停止确认保持分别审计。

B/C的peer身份、kqueue具体生命周期及真实进程退出必须有Mac证据；使用proc_pidinfo私有接口、NOTE_TRACK、PID列表或进程组扫描作为证明均不属于已定实现。实现细节出现真实新范围问题时按AGENTS向用户核对，常规工程细节由协调者裁定并记录。

## Builder复核后的工程裁定

以下细节由协调者依据既有授权与源码核查确定，不增加用户范围，也不代表对应代码已完成：

- A1采用集中`validate_process_stop_claim(capabilities, process_stopped, scope)`类服务校验入口，正回执的范围缺失或平台错配统一返回稳定`PROCESS_STOP_SCOPE_INVALID`；原认证、Workspace与fence先验证，释放容量前校验范围。
- `processStopped=false`缺scope仍能进入隔离；已提供的合法scope作为未确认声明保存，不变成成功。未知枚举仍由正式Schema拒绝。历史非Darwin缺字段兼容，绝不默认为全后代或Mac证明。
- completion各kind、停止对账true/false（含Attempt已经FINISHED）、离线导入都在重建facts后显式保留boolean与实际存在的scope；停止对账同时保留原`stopConfirmation`，不丢失新失败事实。导入不猜历史OS或提升信任，不释放在线容量。
- A2共用显式pre-spawn状态判定：只接受本次已提交的ALLOCATED/ACTIVATING/ACTIVATED或离线明确的RECOVERING_UNSPAWNED；SPAWNING、RUNNING、提交不确定及未结清启动意图不能因`!child`、`state !== SPAWNING`或reason字符串得到NO_PROCESS。
- 在线状态文件的原子提交须包括父目录刷新；提交发生未知错误后保留启动/容量不确定性，不用内存状态制造未派生证明。Darwin的fd实现仍在B，不为A2开放不支持路径。
- 旧文件不回填scope；原平台的旧proof经本次完整核验后，可以在新生成的回执声明本次验证所得FULL，必须与篡改历史区别。管理员人工解除始终单独审计。
