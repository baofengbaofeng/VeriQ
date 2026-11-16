<a id="adr-0011--agent-process-authority-and-recoverable-device-renewal"></a>
# 0011 Agent Supervision

状态：协调者预研批准后，T10 已接受。

Node Agent 拥有设备凭据和控制请求。业务子进程仅经私有 IPC 获得冻结执行配置及窄范围解析的业务凭据，绝不继承设备授权、租约证明或凭据存储路径。在线执行不回退离线模式。既有队列、预期计划、归约器和 CompletionManifestV1 仍是唯一分配/结果管道。

设备轮换保留旧的空正文 API。可恢复轮换提供 UUID clientRequestId 及密码学随机的 32 字节 base64url replacementToken。发送前，私有加锁存储持久记录待定请求/候选。服务端只在前任记录保存令牌摘要、请求 UUID 和后继摘要。首次轮换要求当前设备授权。精确恢复只适用于此端点、原前任/请求/候选、当前 Runtime/绑定/所有者授权，以及未过期、未吊销的后继；不会恢复前任普通权限、再次轮换或延长有效期。客户端比较预期前任和主体，原子替换并 fsync device.json，再删除待定日志。仅一个 Agent 持有凭据存储锁，控制请求协调续期而不重试业务写入。续期在启动时及 24 小时寿命前的单调时钟计划上发生。

监督器在执行副作用前记录分配和激活日志；只有确认激活后才允许子进程。激活响应丢失且未派生进程时，按已停止协调；所有权不确定仍为未知并隔离。Linux 子进程具有专用进程组、真实执行 UID、随机所有权 nonce，以及已记录的 /proc 启动时间。发信号前，日志 UID 必须与当前 /proc 目录所有者 UID 一致，缺失或变化仍为未知。后代所有权覆盖脱离的浏览器组；发现的 PID/启动时间对在发信号前记入日志并复核。先 TERM，再有界 KILL，必须确认没有活动组成员才能返回正向 StopReceipt。PID 复用或身份不可读失败关闭。单调时钟看门狗使用既有 leaseDeadline 辅助函数，独立于网络请求和设备墙上时间。Windows 原生 Job/进程名证据仍属 T20；Linux 实现拒绝不支持的平台。

runAttempt 返回 AttemptResult {completion?, stop, files}，绝不将输入 JobManifestV1 作为伪造完成返回。TEST 对固定本地发行字节验证不可变闭包摘要及编译组装，再使用 Playwright 执行生成 TS，retries=0，并创建新的工作目录、Context 和 fixture。SDK 生命周期钩子报告真实开始、断言、观察器及完成事实。预期计划只授权标识和合法阻断跳过，不授权观测时间戳或成功。原始 Trace/下载证据使用受限存储端。

浏览器临时文件、Trace 和下载存储按 Attempt 隔离，每 100ms 监控。超过有界字节/文件预算时停止整个进程组，包括未完成下载。这是带调度/扫描延迟的检测并停止限制，不是文件系统硬配额。事件缓冲有界；溢出时中止执行，不丢弃成功判定所需事实。CLEANUP 使用中立 HTTP fixture 上下文，不伪造 Page 或启动浏览器。补偿主体保留原 Attempt 的 caseExecutionId/attemptNo/namespace，仅携带其 fixture 凭据/适配器固定版本及 fixture 环境字段。VALIDATE 执行真实编译器；失败时上传脱敏稳定诊断 LOG，使用现有 ERROR/无包完成 ABI，不引入第二个完成写入方。

自动整用例重试不得盲目重放不确定写入。编译器向每个预期用例添加可选 `hasPotentialWrites`，由 WRITE 声明及非只读 API/观察器方法推导，含展开子项。旧元数据缺失表示未知。可信 SDK 观察直到 Context 关闭的完整业务窗口：Context 请求含 frame/popup，页面 WebSocket 活动表示可能写入，SDK 业务 API 单独报告方法；专用认证/fixture HTTP 不计入。只有完整观察并关闭的 Context 可产生 `READ_ONLY_OBSERVED`；潜在写入产生 `WRITE_POSSIBLE`，缺失/不完整观察产生 `UNKNOWN`。完成记录不增加敏感 URL、正文或请求头，Service Worker 继续禁用。

既有完成写入方仅在真实声明的 fixture 按命名空间关闭/拒绝晚写契约达到 SUCCEEDED 清理，或可信元数据无潜在写入且实际完成为 READ_ONLY_OBSERVED 时，允许原有的一次重试。仅客户端安全标志、缺少元数据，或未声明 fixture 却伪造清理成功，均不能授权重试。否则历史失败保持终态，Attempt 事实携带 `retryReasonCode: RETRY_SAFETY_UNCONFIRMED`。不增加通用业务键协调 API；没有 fixture 闭包的不确定写入，须先协调，再由用户显式创建新 Run。

真实取消暴露既有 SDK/规范契约不一致：中断操作报告 FAILED，而用例报告 CANCELLED。StepFinishedPayload 现允许 CANCELLED。类型化取消路径让操作结算与 abort 竞争，保留先观测到的失败，未完成断言不捏造失败结果。关闭 Context 真正中断浏览器工作，清理仍走独立 HTTP 生命周期。既有失败在步骤/用例级保持 FAILED，原归约器不变。子进程退出后，取消宽限定时器不会继续占住已完成的前台 Agent 进程。
