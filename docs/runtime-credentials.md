# 本机凭据档案退役 / Local credential profile retirement

`secret delete-profile` 永久退役所选本机凭据档案中的业务凭据、设备令牌和轮换候选。它与注销或清空单一用途不同：后两者保留其他用途仍需的主密钥。运行本命令需要具有已核验 RuntimeDistribution 凭据能力的 CLI，以及明确确认标志：

```text
veriq_cli --config-dir <profile-directory> secret delete-profile --confirm-all
```

先停止该档案的桌面、在线领取和离线执行。命令在整个操作中持有停止所有权、空闲执行守卫和档案锁；未知、隔离或未经证明的执行历史会阻止退役。旧明文尚未迁移、文件事务恢复尚未完成，或存在待处理的 `initialization.json` 恢复意图时，先完成相应恢复操作，不会通过删除命令猜测或跳过旧意图。只有原始空 `initializing` 清单且没有初始化恢复日志时，可以直接退役；精确旧密钥已缺失时不会先创建新钥再删除。

操作先核验当前和旧初始化意图对应的精确密钥版本，持久化非秘密删除日志，再删除密文及索引，最后逐版本删除系统密钥并读回确认缺失。锁定、不可用、密钥冲突或不确定结果会明确失败。已开始删除后，普通消费会报 `VAULT_PROFILE_DELETION_REQUIRED`；再次明确运行相同命令会读取实际状态并继续原意图，不创建替代密钥。之前已确认缺失、后来才出现的旧密钥仍须匹配原意图摘要才能清理。

完成后保留 `vault/deletion.json`，记录档案、确切版本及清理事实。普通访问和空初始化恢复报 `VAULT_PROFILE_DELETED`，不会自动重新创建档案；今后使用不同的档案目录。保留该日志供精确清理与调查，特别是曾有系统写入结果不确定的情况。完成只表示本次确认的文件退休及系统密钥缺失，不表示远端服务恰好一次执行或物理介质擦除。

信任根、公钥、执行历史和非秘密配置继续保留。本机退役**不会撤销控制平台上的设备**；服务器设备撤销需通过控制平台单独执行。GUI 的永久退役入口尚未交付，将随可用的档案选择与确认流程验证；现有注销、单用途清空和显式迁移入口不变。

The command permanently retires all credential purposes in the selected local profile. It requires explicit `--confirm-all`, continuous stopped ownership, exact key scope checks and confirmed missing readback. A partial result retains a recoverable journal; completion retains a tombstone and prevents automatic reinitialization. Use a different profile directory for future credentials. Public configuration and execution history remain. Local retirement does not revoke the server device or promise physical erasure. A permanent-retirement GUI flow is still pending.


## 显式服务文件模式 / Explicit managed file mode

只有无桌面的受管理 Linux 服务可明确选择 `restricted-file`。服务部署者负责提供专用非 root 账户和外置持久卷；Runtime 核验所声明 UID 与实际 UID/eUID 一致、没有 Electron/图形会话环境，卷为可写的独立挂载点，档案位于该卷内，最终目录属于当前用户且为 `0700`，密钥文件为 `0600`。路径须为规范绝对路径，不接受符号链接、根卷、普通未挂载目录或已知易失文件系统/容器 overlay。每次后端操作重查挂载身份和私有文件属性，不自动 chmod 修复已有公开数据。

```text
veriq_cli --config-dir /srv/veriq-volume/profile --credential-mode restricted-file --managed-service-uid <uid> --persistent-volume /srv/veriq-volume --acknowledge-unencrypted-storage <command>
```

该模式**不提供静态加密保护**：随机主密钥以原始形式保存在同卷 `restricted-keys` 私有目录，每份精确版本记录最多 512 字节。业务载荷复用现有认证、引用绑定和恢复格式，但拥有文件读取权限的主体同时拥有解密所需密钥，不能因此宣称 OS vault 或加密静态存储。CLI 每次明确输出此模式。密钥不放在 argv、环境变量或镜像；登记秘密继续使用既有有界标准输入接口。

每次文件后端操作最多观察五秒。超时或取消并不取消内核 I/O：实际操作与关闭清理继续保留目录合作锁和同进程隔离，结束前拒绝再次调用；开始修改后的未知错误报告不确定，晚到读取的密钥副本清零。工厂初始化目录也使用相同观察边界。

`os-vault` 仍是默认选择；锁定、不可用或出错不会选择文件模式。Desktop 没有文件模式选择入口。每次服务命令都须显式选择文件模式；改变模式参数不会自动搬迁既有 OS-vault 主密钥，已有加密档案在所选后端缺钥时仍明确失败。服务模式不改变设备的执行位置或 `trustStatus`，不会自动授予控制平台 `MANAGED` 信任。显式指定 `--credential-mode os-vault` 而缺少发行能力时会直接拒绝，不执行旧文件分支。此前未指定模式的源码无凭据上下文兼容路径仍在安全默认闭合工作中；不能把本节的显式入口当作完整源码默认路径已验收。

挂载检查和独立 Node 进程重启读回只证明当前环境观察到的卷及文件状态，不能证明 VM 销毁、掉电或部署升级后卷必然保留。实际 Compose/systemd 安装、账户与卷生命周期及运维仍属于部署验收。文件模式的整体凭据退役使用同一精确删除日志和完成标记，保留公共配置及历史，不自动撤销服务器设备。

Managed headless Linux must explicitly select the mode, match the configured nonroot service UID, supply a private external writable mount and acknowledge no encryption at rest. Raw master keys reside on the same volume; payload authentication does not provide confidentiality against readers of that volume. No Desktop fallback or server trust grant occurs. Mount checks and process restarts are not power-loss or deployment durability proof.
