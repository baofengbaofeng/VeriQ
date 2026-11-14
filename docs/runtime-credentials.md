# 本机凭据档案退役 / Local credential profile retirement

`secret delete-profile` 永久退役所选本机凭据档案中的业务凭据、设备令牌和轮换候选。它与注销或清空单一用途不同：后两者保留其他用途仍需的主密钥。运行本命令需要具有已核验 RuntimeDistribution 凭据能力的 CLI，以及明确确认标志：

```text
veriq_cli --config-dir <profile-directory> secret delete-profile --confirm-all
```

先停止该档案的桌面、在线领取和离线执行。命令在整个操作中持有停止所有权、空闲执行守卫和档案锁；未知、隔离或未经证明的执行历史会阻止退役。旧明文尚未迁移、事务恢复尚未完成或空初始化恢复待处理时，先完成相应显式恢复操作，不会通过删除命令猜测或跳过旧意图。

操作先核验当前和旧初始化意图对应的精确密钥版本，持久化非秘密删除日志，再删除密文及索引，最后逐版本删除系统密钥并读回确认缺失。锁定、不可用、密钥冲突或不确定结果会明确失败。已开始删除后，普通消费会报 `VAULT_PROFILE_DELETION_REQUIRED`；再次明确运行相同命令会读取实际状态并继续原意图，不创建替代密钥。之前已确认缺失、后来才出现的旧密钥仍须匹配原意图摘要才能清理。

完成后保留 `vault/deletion.json`，记录档案、确切版本及清理事实。普通访问和空初始化恢复报 `VAULT_PROFILE_DELETED`，不会自动重新创建档案；今后使用不同的档案目录。保留该日志供精确清理与调查，特别是曾有系统写入结果不确定的情况。完成只表示本次确认的文件退休及系统密钥缺失，不表示远端服务恰好一次执行或物理介质擦除。

信任根、公钥、执行历史和非秘密配置继续保留。本机退役**不会撤销控制平台上的设备**；服务器设备撤销需通过控制平台单独执行。GUI 的永久退役入口尚未交付，将随可用的档案选择与确认流程验证；现有注销、单用途清空和显式迁移入口不变。

The command permanently retires all credential purposes in the selected local profile. It requires explicit `--confirm-all`, continuous stopped ownership, exact key scope checks and confirmed missing readback. A partial result retains a recoverable journal; completion retains a tombstone and prevents automatic reinitialization. Use a different profile directory for future credentials. Public configuration and execution history remain. Local retirement does not revoke the server device or promise physical erasure. A permanent-retirement GUI flow is still pending.
