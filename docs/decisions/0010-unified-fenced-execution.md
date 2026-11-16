<a id="adr-0010--unified-queue-and-verified-execution-boundaries"></a>
# 0010 Unified Fenced Execution

状态：协调者批准的 T09 实现选择；实现证据另行记录。

全部任务仍位于 `veriq_jobs`。Run 准入冻结 Workspace 授权的已发布资产或不可变草稿候选、环境、角色、浏览器、数据集版本、数据行及套件序号。候选 UUID 不得假装引用已发布记录。触发类型、来源/位置和精确请求的 Runtime 选择器保持分离。服务 Run 主体必须拥有真实范围授权；登记秘密不能授权执行。

每个受保护操作在读取当前设备和请求者之前取得既有安装授权锁，并持有到提交。容量锁依全局、Workspace、Runtime、环境、资源顺序取得。默认全局四个、Workspace 两个浏览器槽；编译和清理有独立默认值：全局二个、Workspace 一个，Runtime 总余量由服务端配置，默认为一。领取不能根据 availableSlots 增加余量。最多准入十个未结束 Run。

分配不等于激活。仅存摘要的租约秘密授权 LEASED Attempt；认证、fixture 和业务副作用之前必须完成显式激活确认。恢复尚未激活的请求会同时轮换令牌和 fence。已激活请求返回冲突，不新增权限，也不隔离健康执行。过期后的未知进程保留槽位及资源锁，直到原设备确认停止，或具有范围授权且留审计的管理员完成协调。服务端数据库 UTC 签发 60 秒租约，Runtime 每 10 秒心跳。本地期限使用单调时钟和请求往返预算，绝不与设备墙上时间比较。

空（204）领取回执具有已记录的 24 小时恢复窗口及每 Runtime 硬准入上限；外部维护删除符合条件的旧空回执。非空回执仍绑定保留的 Attempt，不能分配第二次业务执行。客户端绝不能复用请求 UUID。不增加内部定时器或 Cron。MAINTENANCE 令牌以 Workspace 为范围、仅存摘要、可独立吊销，并明确限制到具名操作；登记令牌仍为单次且不可调用维护。普通服务账号禁用规则继续生效。

ApprovedEngineInventoryV1 由操作员控制，默认不可用。它绑定引擎/编译器/SDK 版本以及精确发行包、锁、代码、vendor 字节和依赖；上传库存不能自我批准。生成 CASE 文件及预期计划元数据，由当前 MANAGED 编译器身份加活动租约/fence 认证，并与保留源码/描述符字节比较。控制器从不运行 Node 或 Chrome。T18/T20 必须晋升同一发行字节。

CompletionManifestV1 与 JobManifestV1 的旧 attempt-manifest 别名分离。编译分析将预期步骤、断言、观察器身份及依赖元数据写入摘要列明的文件。服务端归约检查真实保留事件、明确且有理由的跳过以及所需证据；缺少元数据不能推断 PASSED。原始业务、清理和证据结果保持分离。精确成功完成重放在当前授权下使用已存回执；不同清单不能覆盖终态结果。T12 将该保留字节管道扩展至 File/S3、保留期、报告和 UI，不再引入回执写入方或队列。

产物上传保持 3 MiB 传输上限。经证明授权的有界分块、显式偏移和精确摘要，避免提高其他路由认证前的缓冲量。

T09 实现细化：显式未知进程协调立即将 Attempt 终结为 ERROR/WORKER_LOST，聚合 CaseExecution/Run 并隔离容量；稍后的停止只释放容量，保留结果。已确认实时停止但没有验证完成的执行为 INCOMPLETE。外部 reap 还对有界排队任务执行 30 分钟 Run 预算，把未启动用例标为 CANCELLED/RUN_TIMEOUT 并聚合；活动未知进程继续隔离。任何超时都不意味着成功。

数据库强制维护 TEST 的 Run+CaseExecution、CLEANUP 的维护回执/原 Attempt 主体关系、源码产物引用、已发布或候选 CASE 身份、Attempt 阶段/fence 边界，以及编译器回执 Runtime+Attempt 来源。MySQL 迁移保留既有排队 VALIDATE 身份和源码字节。

写入加固要求精确保留的源码侧车与冻结源码一致（CASE 投影省略 validationTarget，库验证保留它），并检查选定入口路径及 validationOnly 边界。证据必须具有保留且匹配的 ARTIFACT_CREATED 事件，关联真实 Attempt 上传，不能只声明摘要。公开传输、元数据、完成协议及 T10/T12/T18/T20 义务记录在 `docs/contracts.md`；服务端协议夹具不能宣称真实浏览器执行。

协调者批准的失败 ABI 细化：VALIDATE 成功明确为带描述符的 PASSED，实际编译失败为独立严格 ERROR 分支，禁止 compiledBundleSha256。它保留批准的 engineInventorySha256、当前分配/证明、processStopped:true、有界安全 failureCode 及经验证的非空 LOG 证据。缺诊断字节或事件关联则拒绝。该分支不签发回执，不授权发布，保留精确完成重放。依赖的 DEBUG 工作在读取该验证失败时完成为 ERROR，不等待 Run 超时。

复审修复 1 保留负面清单/终态事实，校验生命周期、嵌套步骤区间、同级顺序及真实断言阶段。仅编译器使用的预期计划 FINALIZE 标注延迟的 requestCount 断言；DSL 和 SDK 执行不变。同一步后续阶段的 BLOCK 跳过必须有真实先前失败 BLOCK 事实。缺失观察器必须有明确的失败步骤阻断证明，记录为 blockedObservers，绝不是 PASSED；祖先阻止子项必须发生在 BEFORE 并明确标记子项 SKIPPED。终态执行后只允许 LOG/ARTIFACT_CREATED 尾部事件。

取消排队重试会记录 USER_CANCELLED，立即结束已停止的排队工作，并按固定严重度归约原历史与 CANCELLED，不抹除 FAILED/ERROR Attempt。领取使用稳定 SQL 谓词及 100 行 keyset 分页遍历有限事务队列，在保持安装/容量锁序的同时消除队首饥饿；聚合锁定时间随匹配队列大小增长。
