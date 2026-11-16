<a id="v02后端运维独立验证交接"></a>

# V02 Operations

状态：源码交付；本轮未执行测试、语法/类型检查、迁移、数据库、容器、构建、安装、S3 或独立复审。下列命令全部是接续任务的执行建议，不是执行记录。原有全产品质量、注释、正常发行和跨目标恢复门禁继续有效。

<a id="source_delivery"></a>

## 源码交付

| 功能 | 已实现源码与行为 | 仍未实现的功能/边界 |
| --- | --- | --- |
| 存活/就绪 | `readiness.py`、`handlers/health.py`、`app.py`、`cli.py`：进程存活不访问依赖；精确 MySQL 8.4、Alembic head/Installation、生产静态字节及启动身份、FILE 实际读写；S3 显式 disabled/read-object/head-bucket；按需合并、一秒缓存、数据库一秒/阻塞两秒/响应三秒预算、单探针最多一个阻塞工作 | 没有主动 S3 写探针；disabled 必须返回 storage=false。线程内核 I/O/DNS/凭据发现无法硬取消，关闭等待实际工作释放资源，进程退出硬上限由服务管理器决定 |
| 工作区指标 | `handlers/operations.py`、`services/operations.py`：员工会话加当前 OWNER/ADMIN，真实工作区聚合，十秒预算；容量、租约、心跳、事件、cleanup、存储、模型成本 | 没有 Prometheus 导出器、长期时序数据库或未送达平台的设备事件观测；不承诺跨查询瞬间一致快照 |
| 保留期 | `services/lifecycle.py`、`services/maintenance.py`、`services/cache_retention.py`：90 天终结在线/离线事件、报告、导入环境声明、终结 AI 上下文及 CaseExecution/Attempt 来源信息压缩；14 天归档加有效签名/活动/共享引用屏障；上传清理；原始证据继续既有成功14/失败30天维护；完整工作区引用闭包保护下回收无引用老 INLINE 载荷，保留最小请求指纹/源根/账单/幂等/退役行 | 引用图默认预算2048根行/2048节点/8MiB，配置`lifecycle_graph_max_rows/nodes/bytes`显式可调且有硬上限100000/100000/256MiB；不足、未知、缺失强根、损坏时保留整页并记录 `artifact.gc_preserved_*` 审计原因。不是部分图删除，也不是过期强根删除。AuditLog本身仅有最小ID/actor/target/workspace/action/time，无其它业务载荷，原样保留；不声称所有元数据行物理删除。HTTP 定时唤醒接口由操作员提供 |
| 保留期迁移 | `migrations/versions/0015_artifact_retention.py`、`db.py`、`repositories/resource.py`：新增 Artifact.created_at、工作区/年龄/摘要索引，显式INLINE复活重置年龄 | 已获根协调者明确授权；新Alembic头0015，未知历史年龄从迁移时刻开始，不追溯猜测；有制品数据拒绝降级。**迁移未执行** |
| 过期读取 | `services/report.py`、`services/bundle.py`、`services/ai.py`：授权后详细读取稳定410，AI列表保留计费/状态并标记过期；原始报告制品下载继续既有 ArtifactService 权限与过期规则 | 新域错误需根协调者同步共享 OpenAPI/生成类型；本任务不编辑公共 schema |
| 一致备份/恢复 | `recovery.py`、`snapshot_io.py`、`cli.py`：真实所有表 JSONL、FILE树/退役对象、S3数据库存活引用/退役键、生效密钥配置、issuer/engine及一次性安装密钥；停机声明、在途状态拒绝、迁移互斥与 MySQL 全局读锁；恢复前全量摘要及版本/密钥检查、空目标拒绝、逐外键验证、失败标记 | 停机一致备份为本次交付契约；在线连续备份/PITR属于独立基础设施能力，未作为该契约承诺；MySQL全局读锁影响同实例所有数据库。只备份 S3 数据库权威引用，不复制无引用未知对象、桶 IAM/KMS/版本化/生命周期等基础设施配置。数据库和外部对象不是分布式事务，失败需操作员保留现场后重新准备空目标 |
| 密钥轮换 | `rekey.py`、`cli.py`：生成私有新配置且保留旧环，显式停写后分批重封装 SecretVersion 与 AiProvider；沿用 AES-GCM purpose/AAD，版本不变；缺钥/损坏整批回滚 | 不自动销毁旧密钥，不自动轮换 Cookie signing_key；Bundle 签发者继续既有 rotate/revoke。旧备份解密材料必须独立保留 |
| 部署 | `deploy/bootstrap.sh`、`veriq.service`、`veriq-migrate.service`、`compose.yaml`、`server.example.json`、`OPERATIONS.md`：独立迁移、外置数据、只读安装、非特权 Compose、生产轮换/恢复流程；Linux内核进程名veriq | 未发行新 wheel/镜像，未提供目标部署域名、TLS证书、正式批准引擎、业务数据库或真实服务凭据；已有systemd Restart=on-failure和Compose restart策略重启受管服务；外部基础设施自动重建属独立部署能力，不把未知Runtime进程强制恢复为已停止 |

## HTTP 接口与共享契约同步

| 方法与路由 | 身份/请求 | 响应与失败 |
| --- | --- | --- |
| GET `/health/live`、`/api/v1/health/live` | 匿名，无正文 | 原有 `{status:"ok",checks:{process:true}}` 或 `{alive:true}`；不调用监视器 |
| GET `/health/ready` | 匿名，无正文 | `{data:{status:"ok"或"degraded",checks:{database:boolean,mysqlVersion:boolean,schema:boolean,static:boolean,storage:boolean}},requestId}`；全部true200，否则503；不暴露路径、DSN、桶或异常 |
| GET `/api/v1/health/ready` | 匿名 | 成功 `{data:{ready:true},requestId}`；失败500 `READINESS_UNAVAILABLE` |
| GET `/api/v1/workspaces/{workspaceId}/operations/metrics` | 员工会话与当前工作区OWNER/ADMIN；无正文/额外过滤 | 下方 MetricsDTO 信封；401/403/404/503；所有响应no-store |
| POST `/internal/v1/maintenance/lifecycle/expire` | Bearer MAINTENANCE 令牌作用域必须显式包含`lifecycle/expire`；`Idempotency-Key`；既有 MaintenanceRequest `{workspaceId,limit,cursor?}`，limit1–10000，workspaceId本处理器必填 | 既有 `{data:{id,status:"FINISHED",processedCount,hasMore,nextCursor?},requestId}`；同键异请求409；跨空间/失效/禁用/归档403；游标无效400 |

MetricsDTO 具体字段：

```typescript
{
    workspaceId: string;
    observedAt: string;
    queue: Record<string, number>;
    capacity: Record<string, number>;
    leases: { active: number; expired: number };
    heartbeat: { devices: number; stale: number };
    events: { persisted: number; accepted: number; backlog: number };
    cleanup: Record<string, number>;
    storage: {
        objects: number; bytes: number; pendingDeletions: number;
        pendingPublications: number; incompleteUploads: number;
    };
    modelCost: { recordedMicros: number; reservedMicros: number; unknown: number };
}
```

`queue`/`cleanup` 是实际Job状态计数；`capacity` 包含资源租约状态行数和 `browserLimit/browserUsed/compileLimit/compileUsed/cleanupLimit/cleanupUsed`。设备心跳只统计当前工作区活动绑定，30秒无心跳为stale；不输出设备身份。事件只计算未过期在线Attempt，backlog为 accepted−persisted 的非负差值。模型 recordedMicros 是原有平台估算，reservedMicros仅RUNNING；unknown为未记录成本的生成数。

新增410只使用既有ErrorEnvelope：

| 错误 | 精确路由 |
| --- | --- |
| REPORT_EXPIRED | GET `/api/v1/workspaces/{workspaceId}/runs/{runId}/report`及同Run路径`/ci-report`、`/junit`；GET `/api/v1/workspaces/{workspaceId}/attempts/{attemptId}/history`；GET同Attempt路径`/artifacts`（元数据列表）；GET `/api/v1/workspaces/{workspaceId}/runs/{runId}/attempts/{attemptId}/display`；POST `/api/v1/workspaces/{workspaceId}/runs/{runId}/events/stream`（首帧前HTTP410，流已开始则沿用SSEauthorization事件携带错误码） |
| BUNDLE_EXPIRED | GET `/api/v1/workspaces/{workspaceId}/bundles/{bundleId}`及`/manifest`、`/download`；GET `/internal/v1/workspaces/{workspaceId}/bundles/{bundleId}/download`；POST `/api/v1/workspaces/{workspaceId}/bundles`幂等重放；POST `/api/v1/workspaces/{workspaceId}/result-imports`及`/internal/v1/workspaces/{workspaceId}/result-imports`授权所用归档已过期 |
| AI_GENERATION_EXPIRED | GET `/api/v1/workspaces/{workspaceId}/ai/generations/{generationId}`；POST同generation路径`/review`、`/cancel`。列表仍200并保留状态/费用，errorCode标记过期 |

## CLI 入口

全部命令先放 `--config PATH`；真实步骤与故障处理见 [部署手册](../../../deploy/OPERATIONS.md)。

| 命令 | 参数与不变量 |
| --- | --- |
| `backup` | `--destination ABS_NEW_DIRECTORY --services-stopped`；需要数据库全局读锁权限；仅输出完成清单摘要；失败不产生成功回执 |
| `restore` | `--source ABS_DIRECTORY --expected-manifest-sha256 HASH --services-stopped --allow-restore --confirm-empty-target`；S3还需显式`--allow-s3-inventory`授权空桶清单检查。目标必须是同安装身份且迁移完的空库/空FILE根/空桶 |
| `rotate-master-key` | `--new-key-id UNIQUE_ID --output ABS_NEW_CONFIG`；不覆盖原配置，历史环保留 |
| `rekey` | `--services-stopped --limit 1..1000`；返回processedCount/hasMore/activeKeyId；重复直到hasMore=false |
| `doctor` | 使用同一ReadinessMonitor执行全部关键依赖检查；S3默认disabled时不会假报ready |

## 后续验证矩阵

| 独立任务 | 环境与材料 | 命令/步骤 | 预期与失败边界 | 本轮结果 |
| --- | --- | --- | --- | --- |
| 定向与回归 | Python3.12固定锁依赖；独占veriq_test MySQL8.4，按已有fixture使用`/tmp/veriq-t12-db.lock`；生产static_package夹具 | 后续新增真实readiness/metrics/lifecycle/recovery/rekey行为测试，然后运行 `uv run --project apps/srv pytest -c apps/srv/pyproject.toml apps/srv/tests/auth apps/srv/tests/static apps/srv/tests/report apps/srv/tests/credentials apps/srv/tests/ai -q`；DB测试须使用既有flock协议 | 实际数据库迁移头/缺失Installation/权限/隔离/恢复检查；现有fixture默认FILE目录必须改为已存在tmp_path，旧DB-only健康断言必须更新，不可放宽新存储检查 | **未执行；新的运维专用行为测试源码仍需后续补齐** |
| liveness/readiness故障 | 真实HTTP应用、可控MySQL/File目录/真实静态fixture；Moto或受控botocore失败注入 | 逐项停DB、改版本/迁移头、改静态字节/清单/自洽新身份、移除/链接/只读FILE根；live与ready同时请求；并发、取消、延迟、关闭 | live恒不访问依赖；公开ready正确503且无敏感文本；legacy500；三秒响应预算、每阻塞探针单工作、一秒无过期成功缓存；残留线程限制必须记录 | 未执行 |
| S3策略 | 默认禁止真实S3；先Moto；真实S3需独立凭据/权限与人工授权 | disabled断言零调用；read-object精确hash/size/Body关闭；head-bucket仅显式策略调用；失败/凭据发现超时 | 无Put/Delete隐式探针，无默认ListBucket；策略证明范围与实际IAM分开记录 | 未执行；本轮零S3调用 |
| 指标与授权 | 两个Workspace、OWNER/ADMIN/VIEWER/禁用用户、当前/撤销会话与设备binding | 实际入队、claim/隔离/释放、写事件、模拟未知费用、撤销成员后请求；将指标与SQL实际值对比 | 不泄露其他Workspace、真实状态计数/容量限额/未知成本正确；timeout503 | 未执行 |
| 生命周期 | 专用数据库与FILE/Moto；到期和未到期各类真实根、UNKNOWN cleanup、活动租约、晚到写入、共享digest、IN_PROGRESS导出/AI | 重复同key、改请求、逐nextCursor、新轮从空游标开始；大于limit的单Attempt事件、多上传与阶段边界；provenance保留门禁布尔/ID且清除大共享列表；迁移前老对象年龄从迁移起算、显式复活重置；构造共享/嵌套JSON/文本/ZIP根、丢失根、损坏/未知媒体、深度/行数/字节预算超限；先artifacts后lifecycle再artifacts | 每页实际推进且重放无副作用；活动/未知/共享引用不被盲删；410发生在授权后；幂等/退役tombstone不复活；读摘要/费用仍可用；完整闭包之外的老INLINE对象才释放字节，不完整图保留全部候选并可读审计原因 | 未执行 |
| 快照一致性/恢复拒绝 | 独立MySQL8.4及有RELOAD/FLUSH_TABLES权限的维护身份；停写所有实例/设备；含真实文件/密钥/损坏变体的合成业务 | 按手册backup；修改任一payload/清单、错digest、不同head/build/key、非空库/FILE/S3、缺flags、并发migrate、活动状态；受控失败于copy/S3/insert/commit | 一致表+制品+密钥；所有不兼容/非空/active拒绝；不打印秘密；失败标记保留；DML回滚而外置现场可人工调查；恢复后逐外键/解密/报告对比 | 未执行；没有真实备份/恢复 |
| 轮换与rekey | 至少两历史key_id，SecretVersion与AiProvider多Workspace、有效/撤销密文与损坏变体 | 新配置生成、同ID/已有路径拒绝；多批rekey、重跑、缺旧钥/错AAD/损坏密文；旧备份分别恢复 | 两类AAD与版本身份保留；明文不输出；当前批失败回滚；最终旧key引用为零；不自动销毁历史key | 未执行 |
| 正常发行/部署 | 正常前端dist→wheel发行，Ubuntu24.04 systemd；Docker/Compose；独立TLS 来源站点和批准引擎库存 | 默认`./build.sh`后仓库外离网安装；bootstrap/migrate/service/doctor；Compose bootstrap/up；只读安装、端口映射、停机升级、失败恢复、内核comm检查 | 无Node/Chrome可运行控制服务；配置数据外置、独立迁移；真实veriq进程名；默认发行门禁不变 | 未执行；依赖V08正常发行 |
| 独立质量/复审 | 最终提交、固定锁、完整AGENTS规范 | 类型/格式/lint/注释质量与首行审计，后续完整服务测试和规格/安全审查 | 既有全仓注释债务不能据本源码交付计为通过；SQLAlchemy反射/循环外键/取消与文件边界必须专门审查 | 全部延期；未运行任何检查 |

## 已知失败与人工材料

没有本轮执行失败可报告，因为所有运行均被用户明确延期；不能据此写成“无失败已通过”。历史全仓质量与正常发行失败见上级交接。需操作员提供：独占测试数据库、真实维护权限、目标目录/UID、TLS与公网origin、批准引擎材料、可控存储、备份加密存储及独立清单摘要。真实S3、生产凭据和真实恢复另行授权，不能使用现有业务数据进行破坏性演练。
