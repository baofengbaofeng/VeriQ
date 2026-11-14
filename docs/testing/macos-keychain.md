# VeriQ：macOS Runtime Keychain 独立验收

本文用于 macOS15及以上 Intel x64、Apple Silicon arm64 两套独立测试环境。当前实现处于开发和审查阶段，本文提供运行入口，不代表已经完成真实钥匙串、安装或签名升级验收。Runtime helper 的结果不替代 Electron Cookie 验收。

## 测试环境

| 条件 | 要求 |
| --- | --- |
| 系统和架构 | 两架构分别原生执行，记录 `sw_vers`、`uname -m`，Intel 不以 Rosetta 替代 |
| 登录账户 | 专用、非 root、可丢弃账户；通过该账户真实图形登录会话中的 Terminal 执行 |
| 授权范围 | 操作者明确允许本账户内测试钥匙串的创建、锁定、解锁、删除及相应偏好变化 |
| 工具链 | 仓库规定的 Node24.x、锁定 pnpm、Xcode/Command Line Tools；保留具体版本与源码提交 |
| 账户数据 | 不放置个人、生产或其他测试任务的凭据；测试期间不切换该账户的登录会话 |
| 签名 | 当前源码 helper 测试不证明最终签名身份；安装和签名升级另行验收 |

`SecKeychainCreate` 和删除可能更改账户的持久搜索列表或默认钥匙串。随机私有文件路径、改变 HOME、sudo 或创建后恢复偏好都不能代替独立账户隔离。不要在标准共享 CI、日常工作账户或已有生产登录会话运行专用测试。

## 构建与无存储变更检查

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @veriq/runtime run build:vault:darwin --tests
pnpm --filter @veriq/runtime test:vault:darwin
```

上述带 `--tests` 的构建输出生产 helper 到 `apps/runtime/build/vault-darwin/veriq_agent`，同时将测试 helper、控制器和内存 ACL 驱动输出到 `apps/runtime/build/vault-darwin-test/`；省略 `--tests` 只构建生产 helper。普通安全测试只验证非法生产帧、测试能力、协议、进程终止及非持久 ACL 对象，不执行默认或持久钥匙串存取。

专用测试前必须重新执行上述带 `--tests`、不带 `--red-candidate` 的构建。`--red-candidate` 仅用于明确的失败基线，会将测试 helper 替换为 stub；其结果不是实际存取验收，也不能用于交付安装包。

## 配置独立登录会话

在专用账户的 Terminal 中获取控制器实际观察到的会话事实：

```bash
printf '%s\n' '{"operation":"session"}' | apps/runtime/build/vault-darwin-test/veriq_keychain_controller
```

该命令仅返回 `uid`、`login`、`session`，不会创建测试钥匙串。失败时先排查真实图形登录、账户与执行上下文，不通过删掉校验或伪造返回值继续。

在该账户拥有的新私有目录内创建会话声明 JSON，目录权限700、文件权限600，文件不得为符号链接。下面的数值仅为示例，须替换为上一步实际输出；声明文字需要完全一致：

```json
{
    "disposable": true,
    "acknowledgement": "I authorize Keychain preference changes in this disposable login session.",
    "uid": 501,
    "login": "veriq-test",
    "session": 100009
}
```

只有操作者确认该会话确实可丢弃、允许上述副作用后才设置 `disposable` 和授权声明。UID、登录名及会话核验仅证明上下文匹配，不能自动证明账户隔离；不得从其他账户复制声明使用。

## 执行真实存取验收

将变量设置为刚创建的声明文件绝对路径，再在同一登录会话、同一源码构建中执行：

```bash
export VERIQ_D1_DISPOSABLE_SESSION="/absolute/private/directory/session.json"
pnpm --filter @veriq/runtime test:vault:darwin:dedicated
```

无配置或上下文不符必须失败，不能将全跳过当作通过。控制器只创建其随机私有目录中的测试存储，密码由系统随机生成并留在进程内；TypeScript 不能指定任意钥匙串或 helper 路径。测试结束后须检查实际退出和清理结果；进程被强杀或清理失败可能留下加密测试状态，不表示之前的系统修改已撤销。

| 行为 | 必须保留的真实结果 |
| --- | --- |
| 精确范围存取 | 32字节含零值、同值幂等、冲突拒绝、大小写与版本范围隔离、跨 helper 读回 |
| 同时写入 | 两个实际 helper 在缺失查询后同步竞争，同值及不同值行为、最终值和真实退出 |
| 锁定恢复 | 实际锁定后拒绝、解锁后原值读回；不能用模拟布尔状态代替 |
| ACL 拒绝 | 宽、空、额外主体、owner/rights 等负例拒绝，并独立核验值及公开 ACL 状态未变 |
| 修改不确定 | 不能把修改后传输失败当作确定未写入，也不能自动覆盖或回放 |
| 日志与清理 | 报告不包含原始密钥、Base64、请求正文或密码；退出/清理失败保留为失败或未知 |

上表为验收目标，具体已覆盖项及实际结果以当前源码、测试报告为准，不能仅根据文档认定完成。公开 ACL 导出不证明底层隐藏时间策略；同二进制内存模板重启也不证明持久项重开或不同签名升级兼容。

## 验收记录

每架构分别记录源码提交、锁文件摘要、工具链、OS/架构、构建事实、测试命令、完整计数和清理状态。保存日志前核对其未包含敏感材料，不提交会话配置、测试存储或凭据。发生失败保留原结果，分析具体原因后再验证；不通过增加超时、强制授权或不断重跑获取绿色结果。

最终生产默认钥匙串、安装后的 helper 身份、Electron Cookie 冷启动/锁定与恢复、稳定签名升级和安装包仍须单独记录。参考[Mac 范围与验收要求](../specs/macos-mvp-scope.md)及[交付里程碑](../plans/milestones.md)。
