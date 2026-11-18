<a id="v11--本机-claim-持久化与保留期源码交接"></a>

# V11 Local Durability

状态：**源码交付；全部验证未执行**。用户要求先完成源码再独立验证；本任务未运行测试、类型检查、构建、原生程序、SQLite 打开、安装、CI、网络或独立复审。本文是后续执行清单，不是通过记录。Linux/Darwin 原在线日志提交实现和 Windows Job 全后代停止证明保持既有范围。

<a id="source_delivery"></a>

## 源码交付

| 范围                | 已交付源码                                                                                                                                        | 实际行为及边界                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows Claim 日志  | `apps/runtime/src/execution/windows-journal.ts`                                                                                                   | Node24 `node:sqlite`，专用 `agent/journal/veriq-online.sqlite`；WAL/FULL、参数绑定、BEGIN IMMEDIATE、原始 Claim/fence/request ID、严格 schema/版本/JSON/重复字段核验；记录提交和完整关闭后才允许 SPAWNING 后实际派生。4096 条上限、每条 64 KiB；超额拒绝，不丢弃历史。                 |
| Windows 私有 SQLite | `apps/runtime/native/windows-journal-files.h`、`windows-files.h`、`windows-addon.cc`、`apps/runtime/src/native/windows.ts`                        | 两个固定数据库用途；真实祖先链不共享删除并保持到 SQLite 关闭；当前 SID、私有 DACL、无重解析、普通单链接文件及 DB/WAL/SHM/journal 上限准入。缺失主库却存在辅助文件拒绝；不截断历史、不使用 chmod 冒充 ACL、不声称 Windows 目录 fsync。                                                  |
| Windows 恢复与 CLI  | `apps/runtime/src/execution/supervisor.ts`、`apps/runtime/src/cli.ts`                                                                             | Windows 实际私有数据库准入后才进入在线控制/认领；恢复使用原始持久 Claim 对账，孤立进程记录、旧 JSON/staging、损坏或未知状态隔离；只有已提交前置状态及无启动意图才允许 NO_PROCESS_SPAWNED。已派生始终调用原 Job 停止证明。                                                              |
| 只读维护观察        | `WindowsAttemptJournal.openExisting(root)`；C05 的 `execution/stopped-history.ts` 接入                                                            | 不创建目录或主库，SQLite `readOnly:true`，无建表或变更 PRAGMA；完全缺失才返回 undefined。SQLite WAL 内部可能打开/创建 SHM 等辅助锁文件，不能描述为零辅助文件 I/O。                                                                                                                     |
| 本机生命周期与墓碑  | `apps/runtime/src/offline/store.ts`                                                                                                               | 新增 `veriq_local_lifecycle`、`veriq_local_artifact_retirements`、`veriq_local_cache_lifecycle`、`veriq_local_retention_clock`；旧数据从首次实际观察开始计龄，报告访问与可信 GUI 包访问更新实际访问时间；持久时钟水位阻止回拨年龄推导。Windows LocalStore 也保持原生私有 SQLite 会话。 |
| 有界维护            | `apps/runtime/src/offline/retention.ts`、`offline/offline-retention-files.ts`                                                                     | `pruneLocalProfile(profileRoot, options)` 持有真实桌面 owner、agent-owner 与 SQLite 空闲写锁；任何活动/隔离占用、未知或孤立进程、待上传、缺停止范围、引用关系不确定都保留。每批 1–100 候选、最多4098文件/128 MiB；大报告逐证据墓碑分批前进。                                           |
| 跨平台实际退休      | `apps/runtime/native/windows-retention-files.h`、`apps/runtime/native/darwin/retention-files.h`、`native/darwin/addon.cc`、`src/native/darwin.ts` | Windows/Darwin 专用有限原生入口；Linux 持有目录 fd 经 proc 引用操作。证据在同一文件上流式 SHA256/大小/身份核验；缓存先隔离 `.veriq-retiring-<bundle UUID>`，再修改只读属性并删除完整可信库存中的成员，未知额外项保留现场。现有配置/凭据正文读取上限不扩大。                            |
| 产品入口与报告      | `apps/runtime/src/cli.ts`、`offline/reports.ts`；C03 桌面接入                                                                                     | `prune --workspace UUID`，默认 metadata90/bundle14/rawSuccess14/rawFailure30，可配置1–3650天；英文有限计数输出。报告证据逐项或整 Run 标记 EXPIRED，原始读取拒绝。C03 `pruneCache` 复用真实 desktopOwner、固定选定 Workspace、原生确认及现有忙门；没有任意路径 IPC。                    |

接口：

```ts
pruneLocalProfile(profileRoot: string, {
    workspaceId: string,
    metadataDays?: number,
    bundleDays?: number,
    rawSuccessDays?: number,
    rawFailureDays?: number,
    batchSize?: number,
    desktopOwner?: DesktopProfileOwner
}): Promise<{
    examinedRuns: number,
    rawRetiredRuns: number,
    metadataRetiredRuns: number,
    bundlesRetired: number,
    retained: number,
    hasMore: boolean
}>
```

缓存退休库存意图先完成 SQLite 提交，再重新取得空闲写锁和停止核验才隔离；中间窗口不删除文件。崩溃后只重做同一持久库存。报告退休保留 Run/Workspace/上传幂等回执与 Attempt 停止事实；元数据期满删除事件正文、完整结果及精确的报告显示文件。包仅在所有未退休结果均不再引用时可删。引擎、凭据、信任根、外部目录、任意 CLI 下载文件、未纳入桌面可信缓存索引的归档、未声明的 staging/work 文件不纳入通用删除。

## 精确待执行检查

以下全部结果均为 **未执行**，后续任务需要先取得对应真实目标、固定依赖与测试档案执行许可。不要在当前源码交付阶段运行这些命令。

| 环境                                       | 命令或操作                                                                                                                                                                                                            | 预期与失败边界                                                                                                                                                                               | 结果   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 独立 Node24、固定 pnpm 锁                  | `pnpm --filter @veriq/runtime check`                                                                                                                                                                                  | 新 API 类型、SQLite 类型、GUI/Runtime 引用一致；不得用 transpile-only 当作类型通过。                                                                                                         | 未执行 |
| Windows11 x64 普通用户；另跑 CI 管理员用户 | `pnpm --filter @veriq/runtime build:native:windows`；其后在 Runtime 工作目录 `node --import tsx --test tests/native/windows-profile.test.ts tests/native/windows-private-config.test.ts tests/native/windows.test.ts` | 实际 N-API 加载、SID/owner/DACL/继承、单链接/重解析、数据库与辅助文件共享方式；普通用户和 CI 管理员拥有者事实分别记录，不能放宽 owner 政策修历史失败。                                       | 未执行 |
| macOS15 x64、macOS15 arm64 分别原生宿主    | `pnpm --filter @veriq/runtime build:native:darwin`；在 Runtime 工作目录执行 `node --import tsx --test tests/native/darwin-private-files.test.ts`                                                                      | 新 CommonCrypto 流式摘要与固定退休入口、实际 ACL、只读树、RENAME_EXCL、fsync/close 错误；两架构均需真实原生编译和装载。                                                                      | 未执行 |
| Ubuntu24.04 x64 + Node24                   | 在 Runtime 工作目录：`node --import tsx --test tests/offline-store.test.ts tests/offline-recovery.test.ts tests/journal-recovery.test.ts tests/supervisor.test.ts`                                                    | Linux 原 journal/进程证明行为不回归，retention 的 fd 锚点、单链接、同名 inode、目录 sync/close 与有限批次。                                                                                  | 未执行 |
| 新增专用行为回归                           | 为 `windows-journal` 与 `offline-retention` 新增独立测试文件并执行                                                                                                                                                    | 当前没有为新增路径伪造通过结果；既有用例不足以覆盖新数据库和退休协议，需要真实可观察行为测试。                                                                                               | 未执行 |
| Windows 冷重启/断电、SQLite 故障           | 新档案初始化；分别在 ALLOCATED/ACTIVATING/ACTIVATED/SPAWNING 提交前后、提交后进程拉起前、RUNNING/STOPPED、提交后关闭错误点终止宿主并冷重启；另做真实存储断电试验                                                      | 原始 fence/request ID 保持；SPAWNING 或未知不推断未派生；FULL/WAL commit 及数据库辅助文件持久性真实核验；进程活性只认原 Job FULL_DESCENDANT_TREE。SQLite/OS 成功不等于介质断电保证已经通过。 | 未执行 |
| Windows 历史/路径对抗                      | 损坏 DB/WAL、未知 schema/version/触发器、同 Attempt 不同 Claim/fence、孤立辅助成员、旧 JSON/staging、孤立 process/drained、数据库/父链换名、reparse/hardlink、关闭失败                                                | 均阻止派生或维护，不截断、不自动修 ACL、不把未知旧日志迁移成 NO_PROCESS_SPAWNED。验证现有 `openExisting` 无目录/主库创建副作用。                                                             | 未执行 |
| 四目标保留期 fixture                       | 已上传成功14d/失败30d/元数据90d/包14d；分别配置最短、最长、非法天数和 batch                                                                                                                                           | 仅可信本机观察/访问年龄生效；首次遇到旧数据不凭 mtime 到期；任何 raw 保留期比 metadata 更长时仍先满足 raw 期限；回拨、未来 finishedAt、不可信或超大结果保留。                                | 未执行 |
| 活动与引用屏障                             | 同时尝试 CLI run/GUI view/online start/prune；QUARANTINED、未知停止范围、缺原生证明、待上传、失败上传、引用同包的另一 Workspace/Run                                                                                   | 持久占用或未知进程阻止维护，已上传但仍保留的报告继续引用包；引擎、源码依赖与凭据不被当无用目录清理。                                                                                         | 未执行 |
| 退休故障与重做                             | 每个证据 unlink 前后、单项墓碑提交前后、缓存意图提交、隔离、只读变更、部分文件/目录删除、索引更新、SQLite 最终提交、关闭点崩溃；重复调用直到 hasMore=false                                                            | 只重做同一可信库存；部分报告逐项 EXPIRED；预算耗尽有后续批次；未知额外成员保留；最小幂等/停止事实不丢失，任何部分失败不生成全部清理成功。                                                    | 未执行 |
| 桌面真实 GUI                               | `pnpm --filter @veriq/desktop check`、`pnpm --filter @veriq/desktop test:unit`；再真实安装 GUI 点击维护确认、取消确认、重复点击、忙状态与结果提示                                                                     | 实际辅助进程调用、desktopOwner 品牌和固定 Workspace，活动查看器／资源读取阻止清理；没有渲染进程路径/SQL/任意 fs 通道。                                                                       | 未执行 |

## 已知边界和未完成验收

- Windows 既有 CI 曾有三项 ACL/所有者失败；本源码不改变该政策，也没有证明这些失败已经解决。旧安装插件缺新增方法时保持失败，必须由后续原生构建/库存/安装任务交付匹配产物。
- 旧 Windows JSON/staging 无自动迁移或清除功能，非空即隔离并要求显式人工恢复；不能凭原有弱发布窗口制造未派生证明。这是明确保留的恢复边界。
- 在线日志目前硬上限4096条，不自动归档或删除原始 Claim/fence；达到上限拒绝继续认领执行，需要后续受审阅的生命周期/归档方案才能长期超过这一历史规模。
- 缓存只覆盖可信桌面 `desktop-bundles.json` 中的签名安装包。任意 `bundle download --output`、外部 `bundle verify --destination`、未知/超额/撤销后无法重新核验的库存与未声明 work/staging 均保留；不是磁盘任意垃圾回收器。
- 未可信计龄、待上传、缺少原生停止证明、单份结果超过8 MiB、缓存引用检查超过4096条未退休 Run 或包含损坏结果时，保守保留。达到文件、目录深度/数量或字节预算后拒绝/分批，不以去掉边界换取“清完”。
- 本机结果本来不承诺抵御同一 OS 用户主动篡改其全部私有档案；Linux Node rename 的隔离依赖私有维护命名空间及随后 inode 核验，实际父目录／路径替换竞争仍需独立真实故障验证。没有把普通路径检查升级成已经验证的安全结论。
- 本阶段没有独立质量审计或覆盖率结论，新增源代码、原生编译、完整注释规范与发行库存均需后续门禁；源码交付不表示支持矩阵、功耗/断电耐久性或完整 MVP 已验收。

## Windows owner 复验与 C07 的关系

2455199的旧Server2025日志在profile五子项owner断言首先失败，五项为node.json、local.lock、veriq.sqlite、WAL、SHM。
C07的669facc后来改变LocalStore Windows初始化：先通过私有文件会话建立缺失主库，并检查打开后的数据库及辅助文件。
当前源码仍保留严格owner/DACL验证和对应测试断言，不能把旧首失败位置或93/96当成当前结果。

先在仅含合成数据的唯一临时根核对实际创建令牌与对象owner/继承ACE，保持所有现有拒绝和幂等/字节断言；
不更改令牌/UAC，不借助真实凭据、默认profile或生产SQLite。ACL-only观察和完整LocalStore三例应分开记录。
当前Win11与等价Server原生结果、SQLite/WAL/SHM及锁目录的最终保证仍未验收，Linux的既有通过不替代它们。
