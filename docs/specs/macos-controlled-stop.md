# VeriQ：macOS 受控进程停止设计

更新：2026-11-14（北京时间）。用户已确认：macOS14起、Intel x64与Apple Silicon arm64优先、宿主原生Chrome；Mac正常停止以受控Worker和Chrome确实退出为范围，检测到停止不确定时隔离并人工恢复，不承诺任意游离后代由内核自动清空。本文将该范围映射到已有Runtime，不表示实现或真机验收完成。

## 1. 已选方案及边界

| 方案 | 决定 | 原因 |
| --- | --- | --- |
| 原生Mac、受控进程明确登记和退出观察 | 用户已接受验收范围，按本设计实施 | 保留宿主原生Chrome与现有Electron/Node/Playwright栈；未知不冒充停止 |
| 与Linux subreaper/Windows Job完全相同的任意后代强排空 | 不作为Mac首发承诺 | 普通Mac应用权限下尚未找到经核实的等价机制；既有Linux/Windows强保证继续保留 |
| Endpoint Security特殊授权 | 本方案不依赖 | 新增Apple审批/root/FDA且尚无完整收敛证明，不作为普通客户端开箱条件 |
| Linux虚拟机浏览器 | 用户已排除 | 不满足宿主macOS原生Chrome要求 |

业务结果、fixture清理和进程停止是不同事实。通过测试不证明进程退出，Chrome窗口消失、Context关闭、CLI结束码或裸PID不在也不能单独作为完整受控停止回执。

## 2. 受控集合和成熟组件

继续使用固定Playwright公共API。Mac的Agent持有`BrowserServer`与outer worker的原始`ChildProcess`对象；通过`chromium.launchServer`启动核验后的宿主Chrome，再让Playwright Test通过`use.connectOptions`连接。复用现有context/page、报告、Trace和SDK，不读取Playwright私有字段，不另写测试执行框架。

受控集合包括：outer worker、其直接创建的npm/编译/Playwright CLI命令、运行前完成登记的Playwright测试worker，以及BrowserServer拥有的Chrome应用主进程。Playwright自身或Chrome派生的任意未登记游离后代不在内核级清理承诺内；已观测到的异常不得被正常退出覆盖。报告应显示“受控进程停止已确认”，不能显示为全部后代已排空。

工程选择：Agent直接持有浏览器，首版不增加新常驻sidecar。Agent死亡后无法恢复活句柄或有效已提交证明时保留隔离；跨Agent崩溃自动重连不在这一选择中隐含完成。

## 3. 启动和停止状态机

| 阶段 | 需要的事实 | 失败处理 |
| --- | --- | --- |
| 持久启动意图 | 同一Attempt、nonce、owner generation及受控范围在派生前落盘 | 无法持久化就不启动；派生与登记之间中断保持未知 |
| 登记outer worker | 保留实际ChildProcess及exit/error监听；START前持久化 | 不凭PID补登记，不让未获确认的worker执行用例 |
| 登记直接命令 | worker先报spawn intent，原始父进程持有每个命令handle并结清exit | 超时发终止后仍须等待真实退出；未结清intent阻止正回执 |
| 登记测试worker | SDK的worker-scoped fixture在连接浏览器/执行步骤前完成私有登记与确认 | 未登记、乱序、重放、断连或CLI异常导致登记不完整时隔离 |
| 启动Chrome | launchServer只用发行库存路径、loopback与随机控制端点；登记实际Chrome handle | endpoint不进日志/argv；写入有界私有控制成员。创建中断不能伪称未派生 |
| 正常/取消收尾 | 关闭新启动/登记门；业务abort及清理；直接命令结清；关闭BrowserServer并观察Chrome exit/close；等待受控worker退出 | close返回或连接断开不替代进程exit；强制终止也等待事实 |
| 提交停止证明 | 同一generation的登记集合闭合、所有受控成员实际退出、无未结清intent | 原子提交失败或结果不确定返回false，不释放容量 |

BrowserServer的`close/kill/process`及close事件可复用。停止去重、截止时间、存储耗尽和用户取消共享同一终结状态机。外层worker不得继续吞掉CLI异常而声称生命周期已结清；业务失败的CLI正常结束与进程管理失败必须区分。

Agent只向自己持有原始ChildProcess对象的进程发终止；worker管理其直接命令handle。对非直接子进程的测试worker只做定点退出观察，不对可能复用的裸PID猜测发送信号。

## 4. Darwin退出观察与私有存储

优先采用有限Node-API封装公开kqueue `EVFILT_PROC/NOTE_EXIT`，只观察已登记进程，不使用不受支持的NOTE_TRACK递归能力。实现必须解决私有连接与peer PID/UID的认证、先attach观察再挑战ACK、ACK前禁止业务、退出/连接交接竞争及断连。不能把自报PID或检查前后的字符串身份当作内核绑定证明。

`proc_pidinfo`相关libproc头存在private/subject-to-change标记，不作为本设计已验证的稳定公共身份原语。若公开peer认证与挑战方案未验证，保持不可用并交付真实失败证据，不用私有SPI或PID扫描补成支持。具体native接口由实现审查定案，需两架构Mac实际测试。

ProcessRecords和VaultFiles目前依赖Linux `/proc/self/fd`，Mac先补有限目录fd相对操作：逐级openat拒绝链接，同fd检查owner/type/mode，受限成员读取和有界枚举，自有临时文件刷新后renameat发布；提交后不确定性继续传播。只读历史不修权限、不删文件。Mac socket按实际sockaddr_un字节上限校验，不沿用Linux108字节常量。

## 5. 统一停止范围合同

新增`processStopScope`，与现有`processStopped`分开：

| 值 | 含义 | 正回执适用 |
| --- | --- | --- |
| `FULL_DESCENDANT_TREE` | 原内核维护的全部后代排空 | Linux/Windows既有经核实后端 |
| `CONTROLLED_WORKER_BROWSER` | 本文定义的受控集合退出 | Mac新后端 |
| `NO_PROCESS_SPAWNED` | 持久状态证明确实没有派生执行进程 | 各平台实际未派生路径；SPAWNING未知不能使用 |

范围不是成功标记：`processStopped=false`仍为停止未确认。新增字段保留在StopReceipt、完成清单、离线Attempt、停止对账及报告facts中；不能在上传、导入或报告归约时丢失后将Mac结果视作全后代保证。

在线服务依据绑定Runtime的已登记能力检查正回执范围：Darwin必须明确声明受控范围或真实未派生范围；Linux/Windows不能用受控范围替代原强保证。范围缺失的历史Linux/Windows客户继续兼容，保留为未声明，不将旧数据补写成Mac证明。服务端验证授权、fence及声明语义，并不声称远程重新验证了OS事实。

离线结果缺少可信平台信息时只保留已有声明与来源，不从字段猜物理OS、补造历史范围或提升可信门禁。导入不释放在线容量。管理员审计解除仍是单独行为，不伪造自动停止证明。

Mac使用独立`CONTROLLED_STOPPED`持久证明和明确scope，不写Linux/Windows的`DRAINED`。ProcessRecords名称白名单、stopped-history成员配对/上限和孤立记录检查一并适配；只有已提交且身份/范围匹配的proof可以恢复正结论，PID消失或owner死去保持未知。

## 6. 实施与验收

实施顺序见[Mac停止实施计划](../plans/macos-controlled-stop.md)。先完成范围合同/服务端失败关闭，再补Darwin私有文件及退出观察、受控所有权、最后开放真实入口和双架构发行。前置切片完成不能代表Mac已就绪。

每架构必须验证：真实launchServer/connect执行与报告；取消及Chrome实际退出；直接命令超时/不退出；测试worker在登记前/后异常退出；owner崩溃；退出早于监听；伪造/重放登记；提交失败；缺失scope；在线/离线容量隔离与显式恢复；原Linux/Windows排空回归。游离后代测试应明确展示本平台保证边界，不能伪造DRAINED。

构建与验证在真实Mac目标进行，当前Linux宿主不下载大包或冒充Mac调用。Keychain、Cookie、bundle内部链接、安装升级和正式签名仍由相邻T20事项完成，不因本文绕过。
