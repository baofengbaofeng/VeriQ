<a id="adr-0012--kernel-owned-attempt-containment-and-correlated-claim-recovery"></a>
# 0012 Linux Attempt Containment

状态：协调者预研批准后，T10 复审修复 1 已接受。

真实反例推翻了原停止时的所有权扫描：Worker 可启动空环境且脱离的子进程，并在发现前退出；孤儿失去已记录父关系及继承 nonce，空扫描不能证明物理停止。普通信号转发 init 包装同样不足：随主 Worker 退出，或只转发其进程组，都不能证明全部收养子进程消失。本决策取代 ADR0011 的正向扫描证明。

每 Attempt 的薄 Linux guardian 使用既有内核 `PR_SET_CHILD_SUBREAPER` 原语，在唯一一次 fork 前成功启用收养。业务 Worker 停在内部门后，直到 Node 持久记录真实 UID、Worker 与 guardian PID/启动时间。现有服务端激活确认先于整条路径，可信 Node Worker 在编译/认证/fixture 前仍保留额外 START 消息门。

guardian 没有设备或租约凭据。到原 Worker 的 Node IPC 仍为 FD3，私有 guardian 状态/控制通道为 FD4/FD5，与业务 stdout/stderr 分离。Worker 在 exec 前关闭两者，不能持有控制通道或伪造 guardian 状态。有界版本 1 协议包含 READY(workerPid)、EXIT(code/signal)、START、STOP。父控制 EOF 或终止信号启动清理，信号处理器只设置标志。主循环独占 wait/reap，并在启动时间验证后向真实同 UID 直接子进程发信号。`/proc` PPID 枚举不依赖可选 task/children 文件。无论 setsid、exec、环境替换或中间父进程死亡，内核收养都把后代交回 guardian；扫描绝不作为成功依据。

只有派生门已关闭，且 `waitpid(-1) == -1`、errno 为 ECHILD，guardian 才可写私有 DRAINED 证明。退出前 fsync 文件和目录。版本 1 证明绑定 nonce、UID、guardian PID/启动时间及 Worker PID/启动时间。Node 精确验证这些日志身份，并等待 guardian 退出后才能确认停止。保留有界 TERM 宽限（默认 500ms），随后 KILL；父进程停止等待上限为宽限+2s。不可中断子进程可能活过等待：guardian 继续收养/收割，Node 返回未知，容量继续隔离。缺证明、guardian 死亡、身份不匹配、所有权事实不可读或旧日志缺少隔离信息，均不能靠回退扫描变成成功。guardian 死亡后，Node 可尽力终止精确识别的已知 Worker 组，但整树仍返回未知。

源码为 `apps/runtime/native/linux-runner.c`。仅开发使用的 `build:launcher` 调用 C 编译器，输出被忽略的 `apps/runtime/build/veriq_runner`；正常 Runtime 启动不编译，也不调用 bwrap/unshare/Python。Runtime 使用固定安装路径，不接受 Job 选择可执行文件；缺少助手则失败关闭。T20 必须按原生发行控制，为每个支持的 Linux 目标构建并随 Agent 分发相同助手 ABI/源码；开发构建不是生产安装器。Windows Job Object、原生映像/保险库集成仍属 T20，npm 依赖固定版本未改变。

另外，领取请求恢复现将精确 clientRequestId 与分配 Attempt 一同记入日志。只有成功协调同一请求后才能删除其待定请求文件；无关历史日志不能擦除更新且尚未确认的 UUID。没有关联信息的旧日志保守处理，不引入新队列、清单或服务端 fence 路径。

初次未发现证明只是有时限的观测。guardian 可能在父进程随后读取 `/proc` 前 fsync 证明并退出；该退出交接时，父进程在返回未知前再次检查完整证明绑定和 guardian 退出。活动 UID/启动时间/nonce 不匹配仍拒绝，仅空 `/proc` 结果始终不足。
