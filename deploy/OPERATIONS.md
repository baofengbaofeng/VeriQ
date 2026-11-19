# VeriQ 服务端安装与运维

本目录交付生产运维入口源码；本轮未执行安装、迁移、备份、恢复、容器或测试。正式发行仍必须通过默认构建与独立验收，不能把下面的操作步骤当作成功证据。使用 Python 3.12、MySQL 8.4；控制服务运行无需 Node 或浏览器。前端必须先由正常发行流程构建到 `veriq_server/static/dist` 并进入 wheel。

## 外置目录与初始化

以独立 `veriq` 用户运行，配置目录 `/etc/veriq` 为 0700，配置与密钥文件为 0600，制品目录 `/var/lib/veriq/artifacts` 为 0700。程序安装目录只读。先配置 HTTPS origin、真实数据库及已批准的引擎库存；`server.example.json` 只有非敏感设置，没有可用凭据。不要把示例域名或版本当成已批准发行。

在独立安装目标执行发行包中的 `bash deploy/install.sh /opt/veriq/releases/RELEASE`；该脚本只消费经过 sha256sums 检查的 wheelhouse，拒绝已有安装目录。设置 `VERIQ_PUBLIC_URL=https://your-veriq.example`，然后以 `veriq` 用户执行：

```bash
bash deploy/bootstrap.sh /opt/veriq/releases/RELEASE /etc/veriq/veriq.json /var/lib/veriq/artifacts admin@example.com Administrator
```

脚本询问真实 MySQL DSN 和管理员密码，不把它们写入日志。也可以从受保护的环境向 `init` 提供 `VERIQ_DATABASE_URL`；环境值优先于配置，CLI 优先于环境。初始化生成主密钥、签名密钥和独立 Bundle issuer，执行显式迁移，再创建管理员并消费一次性安装密钥。生产 `serve` 永不自动迁移。重复初始化不会更换已有主密钥环，已初始化数据库拒绝再次创建安装密钥。

## systemd 与升级

将 `current` 链接指向单一已验收安装目录，将两个 `.service` 文件安装到 `/etc/systemd/system` 后执行 `systemctl daemon-reload`。首次启用服务前单独执行：

```bash
systemctl start veriq-migrate.service
systemctl start veriq.service
/opt/veriq/current/bin/python -B -m veriq_server --config /etc/veriq/veriq.json doctor
```

迁移单元不是服务启动钩子；每次升级由操作员显式运行一次。迁移与备份/恢复使用同数据库名的 MySQL 命名锁，竞争时拒绝或按迁移既有预算等待。发行目录可并存，升级不覆盖配置和 `/var/lib/veriq`。Linux 控制服务在内核中使用 `veriq` 进程名。先停止流量、Runtime 领取、外部 HTTP Cron 和服务，完成备份，切换安装链接并运行迁移、doctor、readiness；全部通过后才恢复写入。回滚需要对应版本安装包和该版本备份，不能让旧软件解释升级后的数据库；就绪和恢复均要求精确 Alembic head。

## Compose

在同一正常发行根目录保留 `deploy/`、wheel 和 wheelhouse。外置目录由宿主机预先创建并允许容器 UID 10001 访问。设置 `VERIQ_CONFIG_DIRECTORY`、`VERIQ_DB_PASSWORD_FILE`、`VERIQ_DB_ROOT_PASSWORD_FILE`，密码文件为私有普通文件。配置 DSN 的主机为 `database`、端口 3306；制品与 issuer 使用示例中的 `/var/lib/veriq` 路径。先准备配置非敏感字段和批准的引擎库存，再运行：

```bash
docker compose -f deploy/compose.yaml --profile bootstrap run --rm -it bootstrap init
docker compose -f deploy/compose.yaml --profile bootstrap run --rm -it bootstrap create-admin --email admin@example.com --display-name Administrator
docker compose -f deploy/compose.yaml up -d api
```

独立 `migrate` job 在数据库健康后完成，API 依赖其成功退出。API 根文件系统只读、配置挂载只读、制品独立 volume，数据库另有 volume。容器 MySQL 用户默认供演示部署同时执行迁移；严格生产部署应以独立 DDL 身份运行迁移任务，再将 API 配置改为 DML/SELECT 身份。不要把数据库 volume 删除当作升级手段。

宿主机只公开 `127.0.0.1:8888`。在同一可信主机配置 TLS 反向代理，外部 origin 必须与 `public_url` 完全一致，代理 SSE 关闭缓冲并保持长连接，传递原始 Host。浏览器通过同源访问 SPA/API；Runtime 访问实际 HTTPS 地址。容器/其他机器的 `localhost` 指向其自身，不能用来指向平台或被测应用。

## 就绪、指标与 HTTP Cron

`/health/live` 只检查进程，数据库或制品停机不会让它失败。`/health/ready` 返回布尔 `database/mysqlVersion/schema/static/storage`；任何 false 为 503。生产静态文件必须持续匹配启动时校验的发布库存，版本/迁移必须匹配当前安装包。FILE 探测在已有根目录内独占创建小文件，读写、同步后删除；拒绝链接目录和不完整恢复标记。

S3 的默认 `readiness_s3_strategy=disabled` 不请求远端，`storage=false`。操作员可以显式配置 `read-object`，提供 `readiness_s3_object_key`、`readiness_s3_object_sha256` 与精确 `readiness_s3_object_size`（最多 1MiB）；对象必须预先存在且保持不可变。该策略只证明精确对象可读。显式 `head-bucket` 使用 HeadBucket，AWS 需要桶级权限，只证明桶访问。没有主动对象写探针，也不增加默认桶权限。两种策略都不证明 Put/Delete/KMS 写入权。

工作区 OWNER/ADMIN 登录后可读取 `GET /api/v1/workspaces/{workspaceId}/operations/metrics`，数据覆盖工作区队列、容量、租约、绑定设备心跳、事件、cleanup、存储和模型成本。每次重新授权；不公开跨工作区全局占用。容量的 HELD/QUARANTINED/RELEASED 是各类资源租约行数，`browserLimit/browserUsed` 等字段是实际工作区池。事件 backlog 是未过期在线 Attempt 的已接受最大序号之和减持久化事件行数，不表示尚未送达平台的设备事件。模型预留只统计 RUNNING，未知账单单独计数，记录成本沿用平台估算口径。

外部调度以当前工作区的 MAINTENANCE 令牌调用 `/internal/v1/maintenance/{operation}`，operation 为 `expired-leases/reap`、`fixture-cleanups/reconcile`、`capacity/reconcile`、`artifacts/expire`、`lifecycle/expire`。每个 POST 包含 `workspaceId`、`limit`（1–10000）和可选 `cursor`，头部包含 `Authorization: Bearer ...` 和独立 `Idempotency-Key`。从私有文件加载令牌，不把令牌拼入命令行历史。重复同一 key 和同一请求回放同一回执；新的一页使用新 key，并传上一页 `nextCursor`，直到 `hasMore=false`。没有内置调度器。

默认元数据 90 天，导出 14 天，成功原始证据 14 天、失败 30 天，未完成离线上传 1 天；通过 Settings 对应 `*_retention_days` 配置。`artifacts/expire` 处理在线/离线原始证据并执行持久删除队列；`lifecycle/expire` 分阶段压缩终结报告事件、离线事件与环境声明、清理不完整上传、释放到期归档及终结模型输出/上下文。后者还压缩终结 CaseExecution 和 Attempt 的 provenance，保留门禁布尔事实、账单、请求指纹、源引用及最小幂等/围栏记录；AuditLog自身只有最小身份/动作/时间记录，原样保留。迁移0015增加 Artifact.created_at，历史未知年龄统一从迁移时刻起算，显式复活重置年龄。缓存阶段先扫描所有工作区直接与JSON根，并完整追踪内联JSON/文本引用闭包；默认2048根行、2048节点或8MiB预算任一超限、强根缺失、未知/损坏内容都整页保留并记录 artifact.gc_preserved_* 审计原因。较大工作区可由操作员按内存预算显式调整 `lifecycle_graph_max_rows`、`lifecycle_graph_max_nodes`（各最多100000）及 `lifecycle_graph_max_bytes`（最多256MiB），不能绕过整图完成条件。只有完整闭包外且超过90天的INLINE载荷被压缩为墓碑，不移除仍被引用的源和引擎材料。签名包仍有效、其他根仍引用归档、活动任务、非 RELEASED 容量或未知 cleanup 均阻止相关删除。详细报告过期返回 410；摘要和最小历史仍保留。先运行 `artifacts/expire`，再运行生命周期维护，最后再次运行制品维护排空删除队列。

## 一致备份

停止所有控制实例、外部 Cron、Runtime 领取/回报和签发者配置写入，确认真实进程都停止或已按现有流程调和；未知/隔离任务必须先人工调查，不能伪造停止证明。备份拒绝非终结 Attempt、未释放容量、PENDING publication、IN_PROGRESS 导出和 RUNNING 模型调用。必须使用专用维护身份具备全部表 SELECT 和 MySQL `FLUSH TABLES WITH READ LOCK` 权限（RELOAD 或对应 FLUSH_TABLES 动态权限）；该锁在备份窗口阻止整个 MySQL 实例写入，应安排维护窗口，不能在共享繁忙实例无计划执行。

```bash
/opt/veriq/current/bin/python -B -m veriq_server --config /etc/veriq/veriq.json backup --destination /backup/veriq-SNAPSHOT --services-stopped
```

目的目录必须是尚不存在的绝对路径。快照包含真实数据库表 JSONL（含 Alembic）、全部 FILE 树（含零字节退役屏障）、数据库引用的存活 S3 对象、S3 退役键、完整生效配置/密钥环、尚存的一次性安装密钥、issuer 私钥及批准引擎库存；私有文件均 0600、目录 0700。完成清单最后写入，CLI 只返回 `manifestSha256`，将此摘要独立安全保存。失败目录没有成功回执，应保留调查，不可当成完整备份。备份本身不做加密，必须放到操作员控制的加密存储；其中包含完整解密材料，不能上传公共制品服务。S3 没有 ListBucket 需求，读取的是数据库明确引用的对象；不把孤立未知对象当成业务权威数据。

## 恢复与兼容

在独立空数据库先执行相同发行版本的 `migrate`，不能执行 `init` 或创建管理员。目标允许迁移生成的未初始化 singleton，其他业务表必须为空，数据库 migration head、表集合、程序版本、生产 buildInfo 全部必须与备份匹配。配置目标 DSN/FILE 根/S3 目标桶，但从备份私有配置安全恢复主密钥环和 signing_key，保留其精确字节和标识。issuer/engine 文件的目标路径必须未存在或与快照字节完全相同，不覆盖冲突配置。

```bash
/opt/veriq/current/bin/python -B -m veriq_server --config /etc/veriq/restore-target.json restore --source /backup/veriq-SNAPSHOT --expected-manifest-sha256 SAVED_SHA256 --services-stopped --allow-restore --confirm-empty-target
```

FILE 目标必须为空；S3 有数据时还必须显式加 `--allow-s3-inventory`，该参数授权恢复前 ListObjectsV2 检查空桶，需要额外桶级 ListBucket 权限。拒绝非空桶；readiness 固定探针对象也应在恢复完成后再准备。先重建 S3 屏障，再写存活对象。表插入通过 SQLAlchemy 类型绑定，临时仅在该会话停用循环外键检查，提交前逐外键检查所有引用；拒绝悬空关系。不会执行快照携带的 SQL、迁移或命令。

恢复不是数据库与对象存储的分布式事务：任何中途失败都保留 `.veriq-restore-incomplete`，readiness 不可用，操作员必须保留现场并在重新准备空目标后重试；不能直接删除标记假装恢复完成。成功后运行 doctor、HTTP readiness、凭据解密/无模型用例和报告抽查，才启动流量与外部 Cron。不要以“恢复命令退出成功”代替完整业务恢复演练。

## 主密钥轮换

先备份旧配置与数据；签名密钥、Bundle Ed25519 私钥和凭据主密钥是不同用途，不用一种轮换代替另一种。生成新主密钥配置：

```bash
/opt/veriq/current/bin/python -B -m veriq_server --config /etc/veriq/veriq.json rotate-master-key --new-key-id NEXT_ID --output /etc/veriq/veriq-next.json
/opt/veriq/current/bin/python -B -m veriq_server --config /etc/veriq/veriq-next.json rekey --services-stopped --limit 100
```

第一条不覆盖旧配置、不输出密钥，保留所有旧 key_id 和字节；停写后将服务统一切换到新配置，再重复第二条直到 `hasMore=false`。重封装覆盖 SecretVersion 和 AiProvider，使用现有 AES-GCM/AAD；版本身份、nonce 随机性及业务明文语义保持。任何旧密钥缺失、AAD/密文损坏会回滚整批。移除旧密钥前必须独立验证两个表无引用并为旧备份保留所需密钥，不自动销毁历史配置。Bundle issuer 的 rotate/revoke 继续使用既有 `issuer` CLI。
