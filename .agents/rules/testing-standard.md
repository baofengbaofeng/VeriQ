# Testing standard

行宽口径：源码及注释每个物理行最多 **120 个显示列**，与 IDE 的 120 列标尺一致。
中文及其它全角/宽字符占 2 列，ASCII 占 1 列；缩进、标点和注释分隔符均计入。

规定测试分层、TDD 流程、断言诚实性、覆盖率与平台相关验证要求。

## 1. 原则

- 测**可观察行为**与对外契约，不测实现源码字符串、注释文案或私有结构偶然形状。
- 行为变更优先 TDD：先写失败测试（RED），再实现至通过（GREEN）。
- 失败与阻塞必须如实报告；禁止用技巧把红测变绿。
- 自动化套件必须在**无模型凭证**时仍可运行；AI 相关用例不得依赖真实付费 Provider，除非任务明确授权并隔离配置。

## 2. 分层

| 层级 | 典型位置 | 要求 |
| --- | --- | --- |
| 契约/单测 | `apps/srv/tests`、`packages/*/tests`、各包 `*.test.ts` | 快速、稳定；覆盖纯逻辑、校验、归约、授权判定 |
| 组件/集成 | 服务 + MySQL、Runtime 与 native 夹具 | 使用真实协议与失败关闭路径；避免过度 mock 掉安全边界 |
| E2E / GUI | `tests/e2e`、`apps/web` / `apps/desktop` Playwright | 关键用户路径；禁止 flaky 重试掩盖产品缺陷 |
| 验收 / 平台 | `tests/acceptance`、目标 OS CI | 安装、进程名、停止范围、保险库等须在真实目标上证明 |

不要用更低层的「绿」推导更高层已验收。

## 3. Playwright 与产品重试语义

- 产品执行路径：Playwright `retries = 0`；整用例重试至多 1 次且由 VeriQ 编排；重试后通过记 `UNSTABLE`。
- 工程测试配置不得擅自打开宽泛重试来吞 flaky；确需重试须有书面理由，且不得改变产品语义断言。
- 禁止 `waitForTimeout` 类固定 sleep 作为同步手段；使用条件等待与确定性事件。
- 禁止「强制点击 / 强制可见」掩盖定位或权限问题。

## 4. 禁止的假绿手段

- 宽泛吞异常后断言成功
- 弱化断言（删掉关键字段校验、把 equals 改成 exists）
- Mock 掉本应测的 UI/报告后仍声称端到端通过
- 伪造报告、伪造停止回执、伪造签名验证成功
- 缺 MySQL / 浏览器 / 原生工具链时静默 skip 却声称门禁通过
- 用 Linux VM 浏览器代替 macOS 宿主原生 Chrome 来「通过」Mac 测试要求

## 5. 必须覆盖的负例类别（按变更触及）

- 跨 Workspace 访问拒绝
- 租约过期、fencing 冲突、迟到回报
- 停止证明缺失/范围错误 → 不释放容量
- 签名失败、撤销状态、重复导入幂等
- 无认证触发/维护接口
- Electron 非白名单 IPC / 错误 sender

## 6. 覆盖率与质量门禁

- 除非任务明确收窄范围，Python 与核心 TypeScript 包行覆盖率目标 **≥ 75%**。
- 注释覆盖率机械门禁 **> 40%**（见编码规范）；与行覆盖率分开统计。
- 关键路径（认证、授权、租约、停止、签名、凭证）即使行覆盖达标，仍须有专项行为测试。
- 默认发行门禁应跑完整相关测试；`--skip-tests` 类出口必须带原因且不得伪装成已验证发行。

## 7. 平台与夹具

- macOS：最低 15；测试使用宿主原生 Chrome；双架构分别证明，禁止仅用 Rosetta 代替 arm64/x64 结论。
- Linux/Windows：全后代停止证明与 Job/进程组等按规格验证；不得用 Mac 受控范围冒充。
- 夹具数据可重复、可清理；崩溃补偿与幂等清理须有测试。
- 原生模块测试失败不得靠「本机跳过」合入。

## 8. 本地常用命令（以仓库脚本为准）

```sh
# 契约与包测试（示例）
pnpm test
pnpm check
uv run --project apps/srv pytest -c apps/srv/pyproject.toml -q

# 注释门禁（示例）
python scripts/comment_audit.py --output /tmp/veriq-comment-audit.json
```

具体过滤参数、包 filter 与 CI 任务名以 `README.md` / `docs/development.md` 为准。

## 9. 检查清单

- [ ] 新行为有 RED→GREEN 证据
- [ ] 断言针对可观察结果；含必要负例
- [ ] 无 sleep/假报告/擅自重试吞 flaky
- [ ] 无模型密钥依赖；缺夹具未静默假绿
- [ ] 覆盖率与关键路径专项测试满足要求

## 源码显示列宽检查

运行 `python3 scripts/line_width.py` 或 `pnpm lint:width`，覆盖测试、夹具与生成源码。
显示列宽工具的边界验收位于 `tests/acceptance/test_line_width.py`。
格式化通过不等于列宽合格；不得用字符个数、字节数或 IDE 软换行代替实际物理行检查。
