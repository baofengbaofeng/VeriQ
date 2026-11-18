<a id="v02后端运维独立验证交接"></a>

# V02 Operations

状态：源码已交付，部分独立验收已完成；下文矩阵保留初始接续范围，不能把历史“未执行”理解为当前全部未执行。完整 V02 尚未通过。

## 当前已验证范围

| 源码与专项            | 实际结果                                                                                      | 接续范围                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| F03 / 04ac403 就绪    | 最终模块 7 项通过，含 5 项真实 HTTP/MySQL 与 2 项诊断控制；另有既有子集 10 项通过             | 健康、缺失 FILE 根、迁移漂移、静态字节变化、live 不访问依赖已覆盖；不要重复设计 |
| 530ef1a 生命周期/指标 | 专项 15 项真实 HTTP/MySQL 通过并复审                                                          | 维护五操作、幂等/授权与八组指标已验证；不是完整保留图或部署证明                 |
| ea23161 到期读取      | 报告/SSE 既有 12 项、Bundle/导入 4 项、AI 5 项分组通过并复审                                  | 保留原 Cookie、当前成员权限及持久化事实；未执行真实维护扫描、物理清除或模型调用 |
| 65bface 就绪依赖/缓存 | 模块20项与认证/静态邻居2项，共22/22；六类故障、精确一秒缓存和六项转义诊断控制均通过并复审     | 版本/权限为明确注入，真实错误系统或只读挂载仍未证明；不代表并发或部署           |
| 51bd067 并发和截止    | 完整就绪24项通过，实际1.005/2.006/3.007秒；共享/取消/单工作与迟到恢复；宽判据误通过反例已关闭 | 直接monitor取消不是HTTP处理器取消，受控延迟不是实际内核/网络卡顿                |
| 17aba48 S3策略        | 两就绪模块37项通过，九HTTP策略/SDK账本/头名控制；默认零探测，精确SDK参数与关闭，运输零次      | 真实Tornado/MySQL配合Stubber，不是实际S3/IAM/网络重试证明                       |
| 80590f9轮换/rekey     | 12专项加4邻居共16/16；真实Old/old遗漏RED→GREEN、跨空间分批/回滚、私有CLI已复审                | 原12类型/R0914保留；真正停写切换与备份恢复单独验收                              |
| 57f5017恢复纯校验     | 46新增+4纯CLI邻居共50/50，归档signing一致性RED/GREEN，独立规格/质量通过                       | 2Minor精度、原2类型/13Pylint、实际全实例读锁/恢复及停写切换仍开放               |

轮换/rekey核心与合成CLI已验证；实际停写切换、备份恢复、真实S3与正常部署仍待独立验证。原末节“没有本轮执行失败”等描述只适用于最初源码优先交付阶段，后续结果以上表及[最新计划](../../plans/2026-11-17-mvp-validation.md)为准。

<a id="source_delivery"></a>

## 源码交付

| 功能          | 已实现源码与行为                                                                                                                                                                                                                                                                                                                                                   | 仍未实现的功能/边界                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 存活/就绪     | `readiness.py`、`handlers/health.py`、`app.py`、`cli.py`：进程存活不访问依赖；精确 MySQL 8.4、Alembic head/Installation、生产静态字节及启动身份、FILE 实际读写；S3 显式 disabled/read-object/head-bucket；按需合并、一秒缓存、数据库一秒/阻塞两秒/响应三秒预算、单探针最多一个阻塞工作                                                                             | 没有主动 S3 写探针；disabled 必须返回 storage=false。线程内核 I/O/DNS/凭据发现无法硬取消，关闭等待实际工作释放资源，进程退出硬上限由服务管理器决定                                                                                                                                                                                                                                        |
| 工作区指标    | `handlers/operations.py`、`services/operations.py`：员工会话加当前 OWNER/ADMIN，真实工作区聚合，十秒预算；容量、租约、心跳、事件、cleanup、存储、模型成本                                                                                                                                                                                                          | 没有 Prometheus 导出器、长期时序数据库或未送达平台的设备事件观测；不承诺跨查询瞬间一致快照                                                                                                                                                                                                                                                                                                |
| 保留期        | `services/lifecycle.py`、`services/maintenance.py`、`services/cache_retention.py`：90 天终结在线/离线事件、报告、导入环境声明、终结 AI 上下文及 CaseExecution/Attempt 来源信息压缩；14 天归档加有效签名/活动/共享引用屏障；上传清理；原始证据继续既有成功14/失败30天维护；完整工作区引用闭包保护下回收无引用老 INLINE 载荷，保留最小请求指纹/源根/账单/幂等/退役行 | 引用图默认预算2048根行/2048节点/8MiB，配置`lifecycle_graph_max_rows/nodes/bytes`显式可调且有硬上限100000/100000/256MiB；不足、未知、缺失强根、损坏时保留整页并记录 `artifact.gc_preserved_*` 审计原因。不是部分图删除，也不是过期强根删除。AuditLog本身仅有最小ID/actor/target/workspace/action/time，无其它业务载荷，原样保留；不声称所有元数据行物理删除。HTTP 定时唤醒接口由操作员提供 |
| 保留期迁移    | `migrations/versions/0015_artifact_retention.py`、`db.py`、`repositories/resource.py`：新增 Artifact.created_at、工作区/年龄/摘要索引，显式INLINE复活重置年龄                                                                                                                                                                                                      | 已获根协调者明确授权；新Alembic头0015，未知历史年龄从迁移时刻开始，不追溯猜测；有制品数据拒绝降级。**迁移未执行**                                                                                                                                                                                                                                                                         |
| 过期读取      | `services/report.py`、`services/bundle.py`、`services/ai.py`：授权后详细读取稳定410，AI列表保留计费/状态并标记过期；原始报告制品下载继续既有 ArtifactService 权限与过期规则                                                                                                                                                                                        | 新域错误需根协调者同步共享 OpenAPI/生成类型；本任务不编辑公共 schema                                                                                                                                                                                                                                                                                                                      |
| 一致备份/恢复 | `recovery.py`、`snapshot_io.py`、`cli.py`：真实所有表 JSONL、FILE树/退役对象、S3数据库存活引用/退役键、生效密钥配置、issuer/engine及一次性安装密钥；停机声明、在途状态拒绝、迁移互斥与 MySQL 全局读锁；恢复前全量摘要及版本/密钥检查、空目标拒绝、逐外键验证、失败标记                                                                                             | 停机一致备份为本次交付契约；在线连续备份/PITR属于独立基础设施能力，未作为该契约承诺；MySQL全局读锁影响同实例所有数据库。只备份 S3 数据库权威引用，不复制无引用未知对象、桶 IAM/KMS/版本化/生命周期等基础设施配置。数据库和外部对象不是分布式事务，失败需操作员保留现场后重新准备空目标                                                                                                    |
| 密钥轮换      | `rekey.py`、`cli.py`：生成私有新配置且保留旧环，显式停写后分批重封装 SecretVersion 与 AiProvider；沿用 AES-GCM purpose/AAD，版本不变；缺钥/损坏整批回滚                                                                                                                                                                                                            | 不自动销毁旧密钥，不自动轮换 Cookie signing_key；Bundle 签发者继续既有 rotate/revoke。旧备份解密材料必须独立保留                                                                                                                                                                                                                                                                          |
| 部署          | `deploy/bootstrap.sh`、`veriq.service`、`veriq-migrate.service`、`compose.yaml`、`server.example.json`、`OPERATIONS.md`：独立迁移、外置数据、只读安装、非特权 Compose、生产轮换/恢复流程；Linux内核进程名veriq                                                                                                                                                     | 未发行新 wheel/镜像，未提供目标部署域名、TLS证书、正式批准引擎、业务数据库或真实服务凭据；已有systemd Restart=on-failure和Compose restart策略重启受管服务；外部基础设施自动重建属独立部署能力，不把未知Runtime进程强制恢复为已停止                                                                                                                                                        |

## HTTP 接口与共享契约同步

| 方法与路由                                                | 身份/请求                                                                                                                                                                    | 响应与失败                                                                                                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET `/health/live`、`/api/v1/health/live`                 | 匿名，无正文                                                                                                                                                                 | 原有 `{status:"ok",checks:{process:true}}` 或 `{alive:true}`；不调用监视器                                                                                                                 |
| GET `/health/ready`                                       | 匿名，无正文                                                                                                                                                                 | `{data:{status:"ok"或"degraded",checks:{database:boolean,mysqlVersion:boolean,schema:boolean,static:boolean,storage:boolean}},requestId}`；全部true200，否则503；不暴露路径、DSN、桶或异常 |
| GET `/api/v1/health/ready`                                | 匿名                                                                                                                                                                         | 成功 `{data:{ready:true},requestId}`；失败500 `READINESS_UNAVAILABLE`                                                                                                                      |
| GET `/api/v1/workspaces/{workspaceId}/operations/metrics` | 员工会话与当前工作区OWNER/ADMIN；无正文/额外过滤                                                                                                                             | 下方 MetricsDTO 信封；401/403/404/503；所有响应no-store                                                                                                                                    |
| POST `/internal/v1/maintenance/lifecycle/expire`          | Bearer MAINTENANCE 令牌作用域必须显式包含`lifecycle/expire`；`Idempotency-Key`；既有 MaintenanceRequest `{workspaceId,limit,cursor?}`，limit1–10000，workspaceId本处理器必填 | 既有 `{data:{id,status:"FINISHED",processedCount,hasMore,nextCursor?},requestId}`；同键异请求409；跨空间/失效/禁用/归档403；游标无效400                                                    |

MetricsDTO 具体字段：

```typescript
{
    workspaceId: string;
    observedAt: string;
    queue: Record<string, number>;
    capacity: Record<string, number>;
    leases: {
        active: number;
        expired: number;
    }
    heartbeat: {
        devices: number;
        stale: number;
    }
    events: {
        persisted: number;
        accepted: number;
        backlog: number;
    }
    cleanup: Record<string, number>;
    storage: {
        objects: number;
        bytes: number;
        pendingDeletions: number;
        pendingPublications: number;
        incompleteUploads: number;
    }
    modelCost: {
        recordedMicros: number;
        reservedMicros: number;
        unknown: number;
    }
}
```

`queue`/`cleanup` 是实际Job状态计数；`capacity` 包含资源租约状态行数和 `browserLimit/browserUsed/compileLimit/compileUsed/cleanupLimit/cleanupUsed`。设备心跳只统计当前工作区活动绑定，30秒无心跳为stale；不输出设备身份。事件只计算未过期在线Attempt，backlog为 accepted−persisted 的非负差值。模型 recordedMicros 是原有平台估算，reservedMicros仅RUNNING；unknown为未记录成本的生成数。

新增410只使用既有ErrorEnvelope：

| 错误                  | 精确路由                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REPORT_EXPIRED        | GET `/api/v1/workspaces/{workspaceId}/runs/{runId}/report`及同Run路径`/ci-report`、`/junit`；GET `/api/v1/workspaces/{workspaceId}/attempts/{attemptId}/history`；GET同Attempt路径`/artifacts`（元数据列表）；GET `/api/v1/workspaces/{workspaceId}/runs/{runId}/attempts/{attemptId}/display`；POST `/api/v1/workspaces/{workspaceId}/runs/{runId}/events/stream`（首帧前HTTP410，流已开始则沿用SSEauthorization事件携带错误码） |
| BUNDLE_EXPIRED        | GET `/api/v1/workspaces/{workspaceId}/bundles/{bundleId}`及`/manifest`、`/download`；GET `/internal/v1/workspaces/{workspaceId}/bundles/{bundleId}/download`；POST `/api/v1/workspaces/{workspaceId}/bundles`幂等重放；POST `/api/v1/workspaces/{workspaceId}/result-imports`及`/internal/v1/workspaces/{workspaceId}/result-imports`授权所用归档已过期                                                                           |
| AI_GENERATION_EXPIRED | GET `/api/v1/workspaces/{workspaceId}/ai/generations/{generationId}`；POST同generation路径`/review`、`/cancel`。列表仍200并保留状态/费用，errorCode标记过期                                                                                                                                                                                                                                                                       |

## CLI 入口

全部命令先放 `--config PATH`；真实步骤与故障处理见 [部署手册](../../../deploy/OPERATIONS.md)。

| 命令                | 参数与不变量                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup`            | `--destination ABS_NEW_DIRECTORY --services-stopped`；需要数据库全局读锁权限；仅输出完成清单摘要；失败不产生成功回执                                                                                                   |
| `restore`           | `--source ABS_DIRECTORY --expected-manifest-sha256 HASH --services-stopped --allow-restore --confirm-empty-target`；S3还需显式`--allow-s3-inventory`授权空桶清单检查。目标必须是同安装身份且迁移完的空库/空FILE根/空桶 |
| `rotate-master-key` | `--new-key-id UNIQUE_ID --output ABS_NEW_CONFIG`；不覆盖原配置，历史环保留                                                                                                                                             |
| `rekey`             | `--services-stopped --limit 1..1000`；返回processedCount/hasMore/activeKeyId；重复直到hasMore=false                                                                                                                    |
| `doctor`            | 使用同一ReadinessMonitor执行全部关键依赖检查；S3默认disabled时不会假报ready                                                                                                                                            |

## 后续验证矩阵

| 独立任务               | 环境与材料                                                                                                         | 命令/步骤                                                                                                                                                                                                                                                                                          | 预期与失败边界                                                                                                                                                                                 | 本轮结果                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 定向与回归             | Python3.12固定锁依赖；独占veriq_test MySQL8.4，按已有fixture使用`/tmp/veriq-t12-db.lock`；生产static_package夹具   | 后续新增真实readiness/metrics/lifecycle/recovery/rekey行为测试，然后运行 `uv run --project apps/srv python -m pytest -c apps/srv/pyproject.toml apps/srv/tests/auth apps/srv/tests/static apps/srv/tests/report apps/srv/tests/credentials apps/srv/tests/ai -q`；DB测试须使用既有flock协议        | 实际数据库迁移头/缺失Installation/权限/隔离/恢复检查；现有fixture默认FILE目录必须改为已存在tmp_path，旧DB-only健康断言必须更新，不可放宽新存储检查                                             | **未执行；新的运维专用行为测试源码仍需后续补齐** |
| liveness/readiness故障 | 真实HTTP应用、可控MySQL/File目录/真实静态fixture；Moto或受控botocore失败注入                                       | 逐项停DB、改版本/迁移头、改静态字节/清单/自洽新身份、移除/链接/只读FILE根；live与ready同时请求；并发、取消、延迟、关闭                                                                                                                                                                             | live恒不访问依赖；公开ready正确503且无敏感文本；legacy500；三秒响应预算、每阻塞探针单工作、一秒无过期成功缓存；残留线程限制必须记录                                                            | 未执行                                           |
| S3策略                 | 默认禁止真实S3；先Moto；真实S3需独立凭据/权限与人工授权                                                            | disabled断言零调用；read-object精确hash/size/Body关闭；head-bucket仅显式策略调用；失败/凭据发现超时                                                                                                                                                                                                | 无Put/Delete隐式探针，无默认ListBucket；策略证明范围与实际IAM分开记录                                                                                                                          | 未执行；本轮零S3调用                             |
| 指标与授权             | 两个Workspace、OWNER/ADMIN/VIEWER/禁用用户、当前/撤销会话与设备binding                                             | 实际入队、claim/隔离/释放、写事件、模拟未知费用、撤销成员后请求；将指标与SQL实际值对比                                                                                                                                                                                                             | 不泄露其他Workspace、真实状态计数/容量限额/未知成本正确；timeout503                                                                                                                            | 未执行                                           |
| 生命周期               | 专用数据库与FILE/Moto；到期和未到期各类真实根、UNKNOWN cleanup、活动租约、晚到写入、共享digest、IN_PROGRESS导出/AI | 重复同key、改请求、逐nextCursor、新轮从空游标开始；大于limit的单Attempt事件、多上传与阶段边界；provenance保留门禁布尔/ID且清除大共享列表；迁移前老对象年龄从迁移起算、显式复活重置；构造共享/嵌套JSON/文本/ZIP根、丢失根、损坏/未知媒体、深度/行数/字节预算超限；先artifacts后lifecycle再artifacts | 每页实际推进且重放无副作用；活动/未知/共享引用不被盲删；410发生在授权后；幂等/退役tombstone不复活；读摘要/费用仍可用；完整闭包之外的老INLINE对象才释放字节，不完整图保留全部候选并可读审计原因 | 未执行                                           |
| 快照一致性/恢复拒绝    | 独立MySQL8.4及有RELOAD/FLUSH_TABLES权限的维护身份；停写所有实例/设备；含真实文件/密钥/损坏变体的合成业务           | 按手册backup；修改任一payload/清单、错digest、不同head/build/key、非空库/FILE/S3、缺flags、并发migrate、活动状态；受控失败于copy/S3/insert/commit                                                                                                                                                  | 一致表+制品+密钥；所有不兼容/非空/active拒绝；不打印秘密；失败标记保留；DML回滚而外置现场可人工调查；恢复后逐外键/解密/报告对比                                                                | 未执行；没有真实备份/恢复                        |
| 轮换与rekey            | 至少两历史key_id，SecretVersion与AiProvider多Workspace、有效/撤销密文与损坏变体                                    | 新配置生成、同ID/已有路径拒绝；多批rekey、重跑、缺旧钥/错AAD/损坏密文；旧备份分别恢复                                                                                                                                                                                                              | 两类AAD与版本身份保留；明文不输出；当前批失败回滚；最终旧key引用为零；不自动销毁历史key                                                                                                        | 未执行                                           |
| 正常发行/部署          | 正常前端dist→wheel发行，Ubuntu24.04 systemd；Docker/Compose；独立TLS 来源站点和批准引擎库存                        | 默认`./build.sh`后仓库外离网安装；bootstrap/migrate/service/doctor；Compose bootstrap/up；只读安装、端口映射、停机升级、失败恢复、内核comm检查                                                                                                                                                     | 无Node/Chrome可运行控制服务；配置数据外置、独立迁移；真实veriq进程名；默认发行门禁不变                                                                                                         | 未执行；依赖V08正常发行                          |
| 独立质量/复审          | 最终提交、固定锁、完整AGENTS规范                                                                                   | 类型/格式/lint/注释质量与首行审计，后续完整服务测试和规格/安全审查                                                                                                                                                                                                                                 | 既有全仓注释债务不能据本源码交付计为通过；SQLAlchemy反射/循环外键/取消与文件边界必须专门审查                                                                                                   | 全部延期；未运行任何检查                         |

## 已知失败与人工材料

没有本轮执行失败可报告，因为所有运行均被用户明确延期；不能据此写成“无失败已通过”。历史全仓质量与正常发行失败见上级交接。需操作员提供：独占测试数据库、真实维护权限、目标目录/UID、TLS与公网origin、批准引擎材料、可控存储、备份加密存储及独立清单摘要。真实S3、生产凭据和真实恢复另行授权，不能使用现有业务数据进行破坏性演练。

## 就绪专项接续

`65bface` 最终执行了完整就绪模块与两个具名相邻节点，22 项全部通过；原先 F03 的结果无需重做设计。后续增加并发用例时保留这 20 项模块实例及其断言，按修改相关范围复验；不将客户端断开直接当作服务端等待者已取消，也不把线程超时写成线程停止。数据库仍使用原专用库守护与共享锁。

主密钥静态预检发现 `AiProvider.key_id` 继承数据库排序规则，而配置 keyring 区分大小写；两个比较在不区分大小写列上可能同时漏掉大小写不同的历史 ID 并错误返回 `hasMore=false`。这仍是条件风险，没有真实行为失败记录。后续先用合成数据确认，保留已有 ID 拼写和模式；核心 ORM 夹具的空闲 HTTP 监听不等于实际生产服务停写。

就绪并发和截止已由 `51bd067` 交付，前述“后续增加并发”是该切片之前的历史接续说明。继续保留完整 24 项和原断言，后续 S3 共享提取时按实际修改复验；不需要重新设计已经完成的四项。真实恢复仍不能由空闲 HTTP 测试夹具、合成归档或无数据库拒绝用例代替。

S3 验收的开发类型前置已由 `04e4eca` 完成并复审：原生产 56 项不变，新增四个开发包及对象键收窄。S3 客户端计数/运输、权限与真实端点没有在此步骤执行，仍按后续模块验收。已有就绪模块 24 项来源 `51bd067`，不能因为开发类型安装而重写为新运行。

S3与就绪整体专项已由 `17aba48` 完成37项及复审，前述“S3后续”保留初始历史上下文，不能重复派发。继续轮换与恢复时采用上述当前表及仓库根模块入口；原始测试数据库守护、限时捕获和锁规则不变。核心重封装可用空闲夹具，但不得声称实际控制服务已停写。

## 轮换专项的复审与接续

80590f9的两处双操作数BINARY比较保留ID、schema和AAD契约；真实MySQL反例与最终16项行为证据已独立核对。两项说明缺口在Fix1关闭，仅改docstring和注释，外层/内嵌Python可执行AST相同；16项运行仍属于修正前哈希。938保护文件一致，无新类型/Pylint诊断；既有12项类型和R0914、全仓>40%及完整MVP门禁仍保留。

下一组仅使用合成归档验证恢复拒绝、完整性、值编解码及CLI，不能把数据库访问哨兵当成成功恢复或全局读锁证明。实际恢复要先准备独立实例/空目标、适用权限、确认停写与操作步骤，不在此专项推定获准。

## 恢复纯校验的边界与后续

57f5017共50项通过（6.43秒），签名归档错字节在真实Settings/静态身份/载荷摘要后被准确拒绝。合法合成归档和真实CLI空目标对照均到驱动前哨兵；所有拒绝均检查准确原因、零数据库访问尝试和目标状态。独立规格/质量通过，939保护一致；原2类型及13Pylint保留。没有运行SQL、实际S3或全局读锁，不等于备份恢复演练。

非阻断精度事项留给后续整分支审查：UTC解码增加offset显式断言；source-parent目标时把沙箱根mode纳入状态快照。下一步先整改现有严格类型门禁；实际恢复仍按既有矩阵准备隔离实例、迁移空目标、权限、停写和可审阅操作步骤。全仓>40%及完整发行仍未通过。

1f616fa后续严格类型专项已关闭rekey12项与recovery2项：完整102服务/19工具检查均0错误，5真实ORM与7回环CI通过，恢复保持AST与冷导入证据。历史“原2类型保留”仅属于57f5017验收阶段，不应重新派发；Pylint、两项精度Minor、实际恢复与停写仍开放。

## 恢复两项断言精度建议已关闭

`2ebbdd6` 只改原恢复测试，独立SPEC/QUALITY通过、C/I/M为0。固定UTC微秒wire解码的零偏移现有显式断言，树快照以'.'覆盖根lstat完整模式，39个相关节点保留原后代/拒绝/驱动/CLI与隐私比较。当前test179ec658、codec18a54e91、recovery6e1dddc1的原50纯用例一次通过（pytest6.84秒、外层11.133秒）；旧57f5017的50只作历史，不能冒称本次结果。

完整脱敏stdout及6790字节/SHA独立复核，50唯一通过节点、当前942保护及反向源码基线均核对。静态原始输出、启动/回收元数据和逐项前后清单未独立保留，审查已披露CannotVerify，相关实施记录不冒充独立原始证据。原两Minor正式关闭；本次未观察到生产故障，不改变任意时区处理契约，也未执行真实DB/SQL/恢复/global读锁/S3。

真实运维验收仍从本文件的隔离实例、目标权限、停写和恢复步骤准备。全量质量、>40%注释、实际平台与发行门禁继续开放，本次不global。
