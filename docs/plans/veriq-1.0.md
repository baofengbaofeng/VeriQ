> 执行修订：用户要求先补README，然后使用子代理编码；出现影响范围、架构或外部服务的未决问题必须暂停核对。桌面GUI首发采用Electron；T19包含apps/desktop及electron-builder，不按旧Rust壳文件清单执行。仓库现有AGPL-3.0保持。

<a id="veriq-10-implementation-plan"></a>

# VeriQ 1.0

> **面向编码代理：** 必须使用 `superpowers:executing-plans` 技能逐任务实施；仅在明确选择后，才可采用子代理驱动的执行方式。步骤使用复选框语法。本文为完整产品的内部实施顺序，不把中间任务作为缩减 MVP 交付。

**目标：** 完整交付规格F01-F14，达到安装、运行、云/本地/离线、管理、报告、升级运维均可用。

**架构：** Python3.12/Tornado 6.6.1/SQLAlchemy/MySQL控制面，React产物进入后端static/dist统一发布，独立Node/Playwright Runtime执行。统一Job类型TEST/VALIDATE/CLEANUP，外部HTTP唤醒，无内部Cron。

**技术栈：** 见规格技术选型表，具体依赖和产品许可在审阅后ADR锁定。

**规格：** [06-VeriQ-v1.0-需求与技术规格.md](../specs/veriq-1.0.md)

<a id="global-constraints"></a>

## 全局约束

- F01-F14全部属于首发MVP，不能以开发阶段为由删减。
- Python3.12、Tornado 6.6.1、SQLAlchemy2.0、MySQL8.4 LTS；全部表veriq\_，Alembic表veriq_alembic_version。
- 私人设备与Workspace分别授权；本地自有进程veriq/veriq_agent/veriq_runner。
- 开发前后端分开；生产web check/build后复制到apps/srv/src/veriq_server/static/dist，随wheel发布。
- 服务端运行不需要Node或浏览器；Runtime采用同一TS引擎，不在常规执行调用模型。
- 业务唤醒和维护提供HTTP，Cron交外部；心跳10秒、租约60秒，过期不能复活。
- 在线4个上下文、Workspace2个；10个未结束Run；离线本机1个，不宣称云端可约束全部离线并发。
- Playwright retries=0；VeriQ最多1次整用例重试，首次失败重试通过UNSTABLE。
- 发布内容不可变；所有结果检查fencing，未知物理进程与资源QUARANTINED。
- 正常发布默认全测，Python/TS核心行覆盖>=75%；紧急跳过需原因和标记，常规发行拒绝。
- 文中测试片段规定核心断言，完整测试初始化由所属任务实现；以下命令尚未执行，不得把预期输出当实际证据。

<a id="review-focus"></a>

## 审查重点

1. 真实HTTP成功但数据未落库、同路径后台请求、动作失败后的监听残留：T06/T07。
2. 设备失联但浏览器仍运行、旧令牌迟到：T09/T10/T22，不能仅回收数据库计数。
3. gitignore前端产物未入wheel、SPA吞API404、生产意外依赖Node：T17/T18。
4. 离线包/报告篡改、跨Workspace访问、个人设备调度：T03/T08/T14/T15。
5. 全模块只做页面壳、测试默认被跳过、Windows发行未经实测：T19/T21/T22。

## 仓库验证入口

T01建立pnpm check、pnpm verify、pnpm e2e -- <spec>、pnpm acceptance、pnpm compatibility:runtime；Python命令统一uv run --project apps/srv。E2E与验收脚本启动/连接测试环境并返回非零失败码。构建全测可拆为 CI 作业，但证据必须绑定同一commit/锁文件/static 摘要。

## T01：工程基线、依赖ADR与公共契约

**依赖：** 无

**状态：** 已完成并通过独立规格/质量审查（`23b5282`、`188c856`）；仅代表工程基线与公共契约。

**文件（拟创建或修改）：**

- `apps/srv/pyproject.toml`
- `apps/srv/uv.lock`
- `pnpm-workspace.yaml`
- `packages/contracts/schemas/case-v1.schema.json`
- `packages/contracts/openapi/platform.yaml`
- `packages/contracts/tests/compatibility.test.ts`
- `apps/srv/tests/contracts/test_compatibility.py`

**接口：** validate_case_schema(input: Any) -> list[ValidationIssue]；生成CaseDslV1、SnapshotV1、JobManifestV1等TS类型。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert validate_case_schema(valid_case) == []
assert validate_case_schema(unknown_action_case)
assert python_validation_results == node_validation_results
```

- [x] **步骤 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/contracts -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** 相同至少20个正反样本结果一致；无浮动latest依赖；选定原生入口技术和许可证；候选不伪称已批准。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t01 工程基线、依赖ADR与公共契约`。有新决策先更新ADR，不扩展到下一任务。

## T02：自有账号、初始化与会话

**依赖：** T01

**状态：** 已完成并通过独立规格/质量审查（`678587d`、`32e625e`）；覆盖自有账户、初始化、会话与管理员界面。

**文件（拟创建或修改）：**

- `apps/srv/src/veriq_server/auth/session.py`
- `apps/srv/src/veriq_server/services/bootstrap.py`
- `apps/srv/src/veriq_server/handlers/auth.py`
- `apps/web/src/features/auth/LoginPage.tsx`
- `apps/web/src/features/setup/SetupPage.tsx`
- `apps/srv/tests/auth/test_session.py`

**接口：** SessionService.login(credentials: LoginInput) -> SessionReceipt；BootstrapService.create_admin(input: AdminInput, setup_proof: SetupProof) -> UserDTO。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert await login_valid_user() == AUTHENTICATED
assert await use_revoked_session() == UNAUTHENTICATED
assert await bootstrap_second_admin_without_authority() == FORBIDDEN
```

- [x] **步骤 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/auth -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** 密码可靠哈希、无固定默认密码、单次重置/邀请令牌、CSRF、禁用后会话无效；安装/登录UI真实可用。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t02 自有账号、初始化与会话`。有新决策先更新ADR，不扩展到下一任务。

## T03：Workspace、成员与强制授权

**依赖：** T02

**状态：** 已完成并通过独立规格/质量审查（`ef0fb6d`、`39672c4`、`eb75c4b`）；资源、执行与证据等后续服务须复用作用域授权。

**文件（拟创建或修改）：**

- `apps/srv/src/veriq_server/services/workspace.py`
- `apps/srv/src/veriq_server/auth/authorization.py`
- `apps/web/src/features/workspaces/WorkspacePage.tsx`
- `apps/srv/tests/auth/test_workspace.py`

**接口：** Authorization.require(actor: Actor, scope: WorkspaceScope, permission: Permission) -> None；所有Repository显式WorkspaceScope。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert await actor_a_read_workspace_b() == FORBIDDEN
assert await remove_last_owner() == CONFLICT
assert await reference_other_workspace_version() == INVALID_REFERENCE
```

- [x] **步骤 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/auth/test_workspace.py -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** 资源、批量、证据、SSE、下载、导入全部跨空间拒绝；切换空间清缓存/取消旧订阅。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t03 Workspace、成员与强制授权`。有新决策先更新ADR，不扩展到下一任务。

## T04：版本化资产、草稿、校验回执与发布

**依赖：** T01/T03

**状态：** 已完成并通过独立规格/质量审查（`2a2dd25`）；生产回执写入依赖后续可信 Runtime 完成链路。

**文件（拟创建或修改）：**

- `apps/srv/src/veriq_server/services/resource.py`
- `apps/srv/src/veriq_server/services/publish.py`
- `apps/srv/src/veriq_server/repositories/resource.py`
- `apps/srv/tests/resources/test_publish.py`

**接口：** ResourceService.update_draft(scope, resource_id, expected_revision, document) -> DraftDTO；PublishService.publish(scope, draft_revision, receipt_id) -> VersionDTO。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert await stale_revision_update() == CONFLICT
assert old_version.document == old_document
assert await publish_with_receipt_for_other_hash() == INVALID_RECEIPT
```

- [x] **步骤 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/resources -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** 所有kind共用版本规则；修改模板/目录/数据不改变旧版本；维护引用与影响分析。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t04 版本化资产、草稿、校验回执与发布`。有新决策先更新ADR，不扩展到下一任务。

## T05：确定性编译器与变量依赖

**状态：** 已完成并通过独立规格/质量审查（`dcb05c0`、`3588164`）；生产 SDK 执行由 T06 实现。

**依赖：** T01/T04

**文件（拟创建或修改）：**

- `packages/compiler/src/validate.ts`
- `packages/compiler/src/dependency.ts`
- `packages/compiler/src/compile.ts`
- `packages/compiler/tests/compile.test.ts`

**接口：** validate(snapshot: AssetSnapshotV1): ValidationIssue[]；compileAssets(snapshot: AssetSnapshotV1): CompiledAssetBundle；assembleExecution(bundle, snapshot: ExecutionSnapshotV1): ExecutionPackage。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```ts
expect(validate(useBeforeExtract).map((x) => x.code)).toContain("VARIABLE_USED_BEFORE_DEFINED");
expect(compileAssets(assetSnapshot).sourceHash).toBe(compileAssets(assetSnapshot).sourceHash);
```

- [x] **步骤 2：运行测试确认未实现时失败。** `pnpm --filter @veriq/compiler exec vitest run tests/semantics.test.ts tests/emission.test.ts`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** 测试夹具输出声明、模板固定、流程5层/500步、secret引用、JSON Pointer缺失类型、写用例持久化检查点。VALIDATE上传实际TS/依赖/文件清单，服务端存不可变制品供正式包复用，草稿无Runtime导出标unvalidated且只含DSL。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t05 确定性编译器与变量依赖`。有新决策先更新ADR，不扩展到下一任务。

## T06：操作、监听和完整断言SDK

**状态：** 已完成并通过独立规格/质量审查（`2482be9`、`68c99fd`）；真实身份/fixture 与 Runtime 接入分别由 T07/T10 完成。

**依赖：** T05

**文件（拟创建或修改）：**

- `packages/runner-sdk/src/execute-step.ts`
- `packages/runner-sdk/src/observers/network.ts`
- `packages/runner-sdk/src/assertions/ui.ts`
- `packages/runner-sdk/src/assertions/http.ts`
- `packages/runner-sdk/tests/network.test.ts`
- `packages/runner-sdk/tests/persistence.test.ts`

**接口：** executeStep(step: ResolvedStep, ctx: StepContext): Promise<StepResult>；armObserver(...): ObserverHandle，包含waitFirst/finalize/dispose。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```ts
expect(savedRequest.body.code).toBe(attemptCode);
expect(await missingPersistenceCase()).toMatchObject({ outcome: "FAILED" });
expect(registry.activeCount()).toBe(0);
```

- [x] **步骤 2：运行测试确认未实现时失败。** `pnpm --filter @veriq/runner-sdk exec vitest run tests`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** 快速响应、同路径干扰、歧义、合法重试、JSON/非JSON/204、最终一致、点击失败无悬挂Promise；使用真实Playwright验证。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t06 操作、监听和完整断言SDK`。有新决策先更新ADR，不扩展到下一任务。

<a id="t07fixture业务身份与补偿"></a>

## T07：测试夹具、业务身份与补偿

**状态：** 已完成并通过独立规格/质量审查（`01561bc`、`6952a5b`）；真实设备授权、制品权限与离线签名接入分别由 T08/T09、T12、T14 完成。

**依赖：** T06

**文件（拟创建或修改）：**

- `packages/runner-sdk/src/fixtures/client.ts`
- `fixtures/demo-app/`
- `fixtures/test-support/`
- `packages/runner-sdk/tests/fixtures.test.ts`
- `docs/integration/backend.md`

**接口：** prepareFixture(request: FixtureRequest): Promise<FixtureContext>；cleanupFixture(context): Promise<CleanupReceipt>；凭证解析隔离于普通变量。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```ts
expect(second.fixtureId).toBe(first.fixtureId);
expect(attemptA.namespace).not.toBe(attemptB.namespace);
expect(await cleanupAgain()).toMatchObject({ status: "ALREADY_CLEANED" });
```

- [x] **步骤 2：运行测试确认未实现时失败。** `pnpm --filter @veriq/runner-sdk exec vitest run tests/fixtures.test.ts`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** 同key异参409，UI创建资源归属、部分失败/强杀回收、权限请求使用业务身份；桩实现与真实被测系统分别验收。环境roleKey映射认证/凭证版本，受管理设备按有效Attempt权限领取、个人设备默认本地解析，测试撤销、轮换、越权下发和日志不泄露。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t07 fixture、业务身份与补偿`。有新决策先更新ADR，不扩展到下一任务。

## T08：设备注册、能力与私有/共享授权

**状态：** 已完成并通过独立关键修复复审（`255e7a4`、`094e670`）；登记码错误触发前端会话失效的 Minor 已记录至 T22，真实队列/租约由 T09/T10 接入。

**依赖：** T03/T07

**文件（拟创建或修改）：**

- `apps/srv/src/veriq_server/services/runtime.py`
- `apps/srv/src/veriq_server/handlers/enrollment.py`
- `apps/runtime/src/enrollment.ts`
- `apps/web/src/features/runtimes/RuntimePage.tsx`
- `apps/srv/tests/runtime/test_grants.py`

**接口：** RuntimeService.approve_enrollment(actor, code, binding, grants) -> EnrollmentReceipt；设备token最小权限且可撤销。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert await dispatch_to_unshared_private_runtime() == FORBIDDEN
assert await claim_with_revoked_device_token() == UNAUTHORIZED
```

- [x] **步骤 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/runtime -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** 所有者确认共享；管理员不隐式操控私人机器；doctor真实检查版本/网络/浏览器。系统管理员授予MANAGED，客户端不得自报；服务账号注册云端Runtime，历史与当前门禁可信度分开。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t08 设备注册、能力与私有/共享授权`。有新决策先更新ADR，不扩展到下一任务。

## T09：统一Job队列、快照、容量与fencing

**依赖：** T04/T08

**状态：** 已完成并通过独立规格/质量审查及修复复审（`170c277`、`a9956f3`）；真实 Agent 进程、浏览器与事件生产由 T10 接入，原始证据访问控制与报告由 T12 完成。

**文件（拟创建或修改）：**

- `apps/srv/src/veriq_server/services/jobs.py`
- `apps/srv/src/veriq_server/services/lease.py`
- `apps/srv/src/veriq_server/services/capacity.py`
- `apps/srv/tests/execution/test_lease_mysql.py`

**接口：** JobService.claim(identity: RuntimeIdentity, req: ClaimRequest) -> ClaimDTO | None；LeaseService.heartbeat(attempt_id, proof) -> HeartbeatDTO；kind=TEST/VALIDATE/CLEANUP。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert active_browser_slots <= 4
assert workspace_browser_slots <= 2
assert stale_fence_result.accepted is False
assert expired_unknown_worker.capacity_state == QUARANTINED
```

- [x] **步骤 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/execution/test_lease_mysql.py -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** 真实MySQL并发20claimer、同执行单租约、原子容量、响应丢失恢复、过期不能续活、未知进程容量不盲释放。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t09 统一Job队列、快照、容量与fencing`。有新决策先更新ADR，不扩展到下一任务。

## T10：Agent监督、事件、取消与整用例重试

**依赖：** T06/T07/T09

**状态：** 已完成并通过独立规格/质量审查及修复复审（`d04a4fc`、`ee8da33`）；Linux 使用每 Attempt 的内核 subreaper guardian。Windows 原生 Job、发行打包与 OS 凭据库由 T20 完成，图形界面由 T19 完成。

**文件（拟创建或修改）：**

- `apps/runtime/src/agent/claim-loop.ts`
- `apps/runtime/src/agent/heartbeat.ts`
- `apps/runtime/src/execution/supervisor.ts`
- `apps/runtime/src/execution/events.ts`
- `apps/runtime/tests/supervisor.test.ts`

**接口：** ExecutionSupervisor.runAttempt(claim: ClaimedAttempt, signal: AbortSignal): Promise<AttemptResult>；terminateAttempt(id, reason): Promise<StopReceipt>。AttemptResult 包含可选 CompletionManifestV1、真实 StopReceipt 与 LocalEvidence[]；JobManifestV1 是分配输入。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```ts
expect(processes.active()).toHaveLength(0);
expect(retryPassed.outcome).toBe("UNSTABLE");
expect(firstAttempt.fixtureId).not.toBe(secondAttempt.fixtureId);
```

- [x] **步骤 2：运行测试确认未实现时失败。** 先 `pnpm --filter @veriq/runtime build:launcher`，再 `pnpm --filter @veriq/runtime exec node --import tsx --test tests/supervisor.test.ts`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** TEST/VALIDATE/CLEANUP真实分派；断网停止、最终清理、事件缓冲有界、重试由平台单层控制。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t10 Agent监督、事件、取消与整用例重试`。有新决策先更新ADR，不扩展到下一任务。

## T11：完整资产编辑器与环境配置UI

**依赖：** T04/T05/T08/T10

**状态：** 已完成并通过独立规格、质量审查及修复复审（`c128ac5`、`b49f981`）。最终编辑器浏览器回归 9 项通过；整体 SDK 测试仍有取消场景超时待定位，正式构建前必须解决，见[开发验证记录](../development.md#current-verification-limits)。本阶段不代表完整 MVP 已交付。

**文件（拟创建或修改）：**

- `apps/web/src/features/resources/ResourcePage.tsx`
- `apps/web/src/features/cases/CaseEditor.tsx`
- `apps/web/src/features/assertions/AssertionEditor.tsx`
- `apps/web/src/features/environments/EnvironmentPage.tsx`
- `apps/web/tests/case-publish.spec.ts`

**接口：** Web只提交CaseDslV1；observer/断言/变量面板共享同一表单状态，JSON编辑与表单可逆。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```ts
expect(await page.locator('[veriq-id="case.validation-errors"]').count()).toBe(0);
await expect(page.locator('[veriq-id="case.published-version"]')).toBeVisible();
```

- [x] **步骤 2：运行测试确认未实现时失败。** `pnpm --filter @veriq/web test:e2e case-publish.spec.ts`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** 全部资源kind、模板参数/影响、数据行、公共流程、版本差异、错误/空态/冲突真实可用。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t11 完整资产编辑器与环境配置UI`。有新决策先更新ADR，不扩展到下一任务。

## T12：实时报告、证据、审计与可信门禁

**依赖：** T10/T11

**状态：** 已完成并通过独立规格、质量审查及修复复审（`f77a9b9`、`47986b0`）。真实报告与受限证据、存储/退役并发、旧编译包兼容和统计修复有针对性证据；SDK 取消超时仍待正式构建前定位。完整元数据/导出包生命周期、桌面与离线模块仍按后续任务交付。

**文件（拟创建或修改）：**

- `apps/srv/src/veriq_server/services/report.py`
- `apps/srv/src/veriq_server/services/artifact.py`
- `apps/srv/src/veriq_server/services/gate.py`
- `apps/web/src/features/reports/ReportPage.tsx`
- `apps/srv/tests/report/test_integrity.py`

**接口：** ReportService.get(scope, run_id) -> RunReportDTO；ResultService.finish(proof, manifest) -> CommitReceipt；File/S3 ArtifactStore同接口。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert incomplete_manifest.outcome == INCOMPLETE
assert await foreign_workspace_artifact() == FORBIDDEN
assert same_finish_retry.receipt_id == first_receipt.receipt_id
```

- [x] **步骤 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/report -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** SSE补读、事件幂等、同终态重放、原始HTML隔离、Trace受限、各Attempt保留；错误不全绿。共享归约样本固定ERROR>INCOMPLETE>FAILED>CANCELLED>UNSTABLE>SKIPPED>PASSED，测试清理失败、取消缺证据、零用例与计划跳过。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t12 实时报告、证据、审计与可信门禁`。有新决策先更新ADR，不扩展到下一任务。

## T13：AI完整模块与无模型执行

**依赖：** T11/T12

**状态：** 代码实现与修复复审已通过（`f9573d0`、`3c96eb6`）；Provider 配置、预算、生成审核、失败分析和无模型真实执行有针对性证据。经授权的实际外部 Provider 验收尚待用户确认服务、模型、预算并建立独立配置，T13 验收仍未完成。见 [AI 说明](../ai.md)与[验证限制](../development.md#current-verification-limits)。

**文件（拟创建或修改）：**

- `apps/srv/src/veriq_server/services/ai.py`
- `apps/srv/src/veriq_server/infrastructure/providers.py`
- `apps/web/src/features/ai/AiPage.tsx`
- `apps/srv/tests/ai/test_generation.py`

**接口：** ModelGateway.generate(context: DraftContext) -> ModelReply；AiService.create_draft(scope, req) -> GenerationDTO；预算拒绝不影响Run。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert generation.resource_state == DRAFT
assert disabled_provider_run.outcome == PASSED
assert model_calls_during_execution == 0
```

- [x] **步骤 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/ai -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **步骤 3：实现上述接口与文件。** Provider配置/连接、结构化生成/审核、脱敏失败分析、历史与费用；mock及经授权真实Provider各有证据。
- [ ] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t13 AI完整模块与无模型执行`。有新决策先更新ADR，不扩展到下一任务。

## T14：依赖闭包、签名包与本地凭证

**依赖：** T04/T10

**状态：** 模块实现及两轮修复复审已通过（`46798ab`、`3ffb144`、`c1fa544`）。支持真实发布包和无 Runtime 的 DSL 草稿调试包、可信公钥缓存、严格入口/闭包验证、幂等导出、多 CASE 与版本分页、精确本地凭证引用及 SDK 动态键名脱敏。完整 SDK 检查仍有既有浏览器关闭超时，必须在 T18 正式门禁前处理，见[验证限制](../development.md#current-verification-limits)；T15 已补齐本地执行/回传，桌面仍由后续任务交付。

**文件（拟创建或修改）：**

- `apps/srv/src/veriq_server/services/bundle.py`
- `apps/runtime/src/offline/verify.ts`
- `apps/runtime/src/credentials/store.ts`
- `apps/web/src/features/bundles/BundlePage.tsx`
- `apps/srv/tests/bundles/test_export.py`

**接口：** BundleService.export(scope, req) -> BundleDTO；verifyBundle(input: Path): VerifiedBundle；SecretResolver.resolve(ref, attempt): SecretValue。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert exported_zip.contains_secret_values is False
assert tampered_bundle.accepted is False
assert set(exported_versions) == set(dependency_closure)
```

- [x] **步骤 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/bundles -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** 完整闭包、清单字节签名、摘要、安全解压、无密钥、secretRef本地映射、缺依赖明确失败。信任根通过认证绑定/带外指纹建立，禁止信任包内自带根，测试替换key、轮换、已知撤销和离线未知撤销状态。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t14 依赖闭包、签名包与本地凭证`。有新决策先更新ADR，不扩展到下一任务。

## T15：离线执行、本地报告与幂等回传

**依赖：** T12/T14

**状态：** 模块实现与独立规格/质量复审已通过（`1b6fccb`、`86f1602`、`67968b4`）。真实断网执行、单机占用与代际恢复、证据持久化、完整/取消套件矩阵、草稿套件、幂等导入及报告回读均有实际验证；导入来源固定为 OFFLINE_IMPORT，缺失变体保守展示且正式门禁为 false。最终针对性检查为离线 27 项、后端 27 项、契约 200 项，真实组合验收 4 项；广套件历史失败与版本绑定见[验证记录](../development.md#current-verification-limits)。完整 SDK、桌面/目标 OS 发行及实际 Provider 验收继续按后续门禁执行，不能据此宣称完整 MVP 完成。

**文件（拟创建或修改）：**

- `apps/runtime/src/offline/run.ts`
- `apps/runtime/src/offline/upload.ts`
- `apps/srv/src/veriq_server/services/import_result.py`
- `apps/runtime/tests/offline.test.ts`
- `apps/srv/tests/bundles/test_import.py`

**接口：** runOffline(bundle, config): Promise<OfflineResultV1>；ImportService.import(scope, result) -> ImportReceipt。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert first_import.run_id == repeated_import.run_id
assert first_import.source == OFFLINE_IMPORT
assert dirty_import.official_gate_passed is False
```

- [x] **步骤 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/bundles/test_import.py -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** 无平台连接可运行看报告，原线上Attempt不被覆盖，dirty/环境覆盖/来源可信度如实显示；本地进程仍命名veriq。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t15 离线执行、本地报告与幂等回传`。有新决策先更新ADR，不扩展到下一任务。

## T16：外部HTTP触发、维护接口与CI

**状态：** 已完成模块实现及独立重要问题修复复审（`599f989`、`10a1065`）。真实Agent/CI与GUI已验证；I1认证回退、I2总截止时间已关闭。M1分页深链接、M2错误方法匹配归T22；分组广套件失败与定向纠正见里程碑，不能称完整发布门禁通过。

**依赖：** T09/T12

**文件（拟创建或修改）：**

- `apps/srv/src/veriq_server/services/execution_plan.py`
- `apps/srv/src/veriq_server/services/maintenance.py`
- `apps/srv/src/veriq_server/handlers/trigger.py`
- `apps/web/src/features/runs/ExecutionPlansPage.tsx`
- `apps/srv/tests/execution/test_trigger.py`
- `docs/integration/external-scheduler.md`

**接口：** TriggerService.trigger(scope, plan_id, input, idempotency_key) -> TriggerReceipt；maintenance按批次处理并返回hasMore。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert repeated_trigger.run_id == first_trigger.run_id
assert same_key_different_input.status == 409
assert unauthenticated_maintenance.status == 401
```

- [x] **步骤 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/execution/test_trigger.py -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** 仅HTTP无内部Cron；重叠策略、CI退出码/JUnit、受限凭证、租约/清理/保留期维护及外部接入说明。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t16 外部HTTP触发、维护接口与CI`。有新决策先更新ADR，不扩展到下一任务。

## T17：生产同源静态服务与开发代理

**状态：** 已完成并通过独立审查及两轮修复复审（`4b58a4c`、`0f48d6e`、`67779ed`）。完整静态清单、生产HTTPS真实前端认证/深链接、缓存/拒绝策略已验证；非入口HTML后缀/MIME参数缺口已关闭。真实stage/wheel/无Node干净安装由T18继续，完整就绪检查由T21继续。

**依赖：** T02/T11

**文件（拟创建或修改）：**

- `apps/web/vite.config.ts`
- `apps/srv/src/veriq_server/handlers/static.py`
- `apps/srv/src/veriq_server/app.py`
- `apps/srv/tests/static/test_routes.py`

**接口：** make_app(settings: Settings, db: Database, delivery: Delivery | None = None) -> tornado.web.Application；production静态根由安装包定位，development不要求dist。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert spa_deep_link.status == 200
assert missing_api.content_type == 'application/json'
assert missing_js.status == 404
assert path_traversal.status in (403, 404)
```

- [x] **步骤 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/static -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** API404不回index，缺JS不回index，缓存头正确，同源Cookie/CSRF，前后端可分开调试。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t17 生产同源静态服务与开发代理`。有新决策先更新ADR，不扩展到下一任务。

## T18：前端先构建、wheel强制入包与服务端发行

**状态：** 代码实现及重要问题修复复审已通过（`3995648`、`dc95f26`）；正式发行验收仍待T22/T23。27项取消/新鲜校验回归及Debian下当前wheel安装通过；默认构建因真实Web 静态规则检查失败，M1/M2及全仓规范、目标Ubuntu/OCI仍未关闭。参见[里程碑](milestones.md)与[发行指南](../release.md)。

**依赖：** T17

**文件（拟创建或修改）：**

- `build.sh`
- `scripts/build_release.py`
- `scripts/stage_web.py`
- `scripts/verify_wheel.py`
- `apps/srv/pyproject.toml`
- `apps/srv/hatch_build.py`
- `tests/acceptance/test_server_package.py`

**接口：** build_release(options: BuildOptions) -> ReleaseManifest；必须顺序web check/build→stage→srv检查测试→wheel→干净安装→原子output。

- [x] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert wheel.has('veriq_server/static/dist/index.html')
assert wheel.has_migrations()
assert release.tests_skipped is False
assert production_starts_without_node_or_chrome is True
```

- [x] **步骤 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest tests/acceptance/test_server_package.py -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **步骤 3：实现上述接口与文件。** Hatchling hook区分editable与正式wheel；干净检出目录无dist可安装开发依赖，正式构建缺dist失败；gitignore静态目录真实入wheel、无重复资源、无旧assets、版本一致、离线wheelhouse、正常默认全测、紧急跳过记录原因、SBOM/NOTICE/hash完整。
- [x] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t18 前端先构建、wheel强制入包与服务端发行`。有新决策先更新ADR，不扩展到下一任务。

**未完成的发行验收：** 最终源码/锁/static绑定的默认完整门禁、Python/TS核心覆盖率、B05有效说明与历史格式/类型债、目标Ubuntu24.04及独立OCI实测。当前候选为UNVERIFIED，不因上述实现活动已执行而宣称正常发行或完整MVP交付。

## T19：完整Electron桌面图形界面

**依赖：** T10/T11/T12/T14/T15

**状态：** 模块及六项重要修复复审已通过（`bac5162`→`eb2dc4e`，新增C/I/M为0）；精确源码六GUI/34unit/2display通过。Windows11/Ubuntu安装、原生托盘/vault/签名及全产品/Provider/质量门禁仍由T20–T23完成，见[里程碑](milestones.md)。

**文件：** apps/desktop/package.json；apps/desktop/electron.vite.config.ts；apps/desktop/src/main/index.ts；apps/desktop/src/preload/index.ts；apps/desktop/src/renderer/；packages/ui/；tests/e2e/desktop.spec.ts。

**接口：** DesktopBridge为白名单类型化IPC；CloudResourceAdapter与LocalResourceAdapter共享资源视图；AgentClient连接受限本机IPC，不开启无认证控制端口。

- [x] 步骤 1：写桌面真实E2E，覆盖登录/Workspace、设备绑定、下载、独立执行、取消、报告、回传、设置、自检和托盘入口（原生目标托盘验收归T20）。Renderer不得直接获得进程/任意文件/密钥能力。
- [x] 步骤 2：运行pnpm desktop:test并确认缺功能时失败，保存证据。
- [x] 步骤 3：实现全部桌面界面和Cloud/Local适配；本地静态UI随包，无平台连接也能操作缓存；UI与独立Node24 Agent生命周期分离。
- [x] 步骤 4：运行组件、IPC、安全和真实Electron测试；检查UI崩溃/窗口关闭不丢后台执行。
- [x] 步骤 5：同步契约、安装说明并提交。

## T20：Mac双架构优先的桌面与Runtime发行

**依赖：** T19

**2026-11-14范围修订：** macOS Intel x64、Apple Silicon arm64均为MVP最高优先级；Windows11 x64、Ubuntu24.04 x64保留、优先级较低。Mac最低系统已确认为macOS15（Sequoia），测试必须用宿主原生Chrome；Mac已确认受控Worker/Chrome退出、未知隔离和人工恢复，按[停止子计划](macos-controlled-stop.md)实施；Linux/Windows现有全后代停止保证及凭据/离网验收标准保留；Mac按明确的受控范围验收。已有Windows/Linux证据继续保留，不能映射为Mac通过。

**当前切片状态（2026-11-15）：** 静态输入、归档及完整stage组件已复审；固定官方资产获取与观测工具`c84f0a7`及修复`7aa8c65`/`0a370cc`已通过源码定向复审。真实双Mac首轮`4f1a326`获取通过，观测因未完成异步等待失败；小制品已核验，普通16385字节成员已本地复现，`8ecf4c0`修复512字节解析进度与成员等待互等，受影响三个suite143项及原审查代理定向复审通过；第二轮`656f189`的双Mac获取继续通过，观测已明确返回不支持格式并确认清理，`1bff4ca`补齐12处首拒诊断，183项受影响回归及原审查代理复审通过，全部准入谓词/API/清理未变；第三轮`cb48e77`已在双Mac取得Chrome Stored方法0/flags4的真实首拒证据；根据规范与成熟库四组字节/CRC比较，`864851c`的R5仅取消这一额外组合拒绝，其余方法/掩码、原始flags一致性及完整性校验保留，196项受影响回归、685源码/681保护及原审查代理规格/质量复审通过；`a245535`的双Mac15原始归档完整扫描随后均通过，两份小证据各25成员CRC/24清单引用/19源码绑定及原ZIP权限/五条Framework链接事实复核通过，来源/发布者/布局选择仍未晋升；独立D22由`6ef86c1`统一三消费者的私有五秒关闭结算，214项受影响回归与全新独立审查通过，未知关闭保留INCOMPLETE与首错。之后继续真实提取、生产依赖闭包、搬移执行及Electron装载/安装验收。源码组件完成不提前勾选整T20，完整状态见[里程碑](milestones.md)。

**文件：** apps/desktop/electron-builder.yml；scripts/build_runtime.mjs；tests/compatibility/process-names.spec.ts；docs/operations/runtime-install.md；对应CI工作流。

**接口：** 桌面入口veriq，后台veriq_agent，执行veriq_runner；CLI可veriq_cli；固定Node24执行引擎独立于Electron内置Node。

- [ ] 步骤 1：测试安装后的实际进程名、离网依赖、后台/托盘、停止进程树、单实例、升级/卸载和签名校验。
- [ ] 步骤 2：在对应OS运行pnpm compatibility:runtime，确认未实现行为失败。
- [ ] 步骤 3：electron-builder发行GUI/Agent/Runner和浏览器；macOS x64、macOS arm64、Windows x64、Ubuntu x64独立构建验收，优先Mac两架构，不另引入Rust桌面壳。Mac补齐Keychain、Cookie实际保护、私有文件适配、进程监督、菜单栏/Dock及真实架构依赖闭包。
- [ ] 步骤 4：各OS验证安装包并保存产物/日志；没有正式签名证书时标记开发包，暂停正式签名发布并询问用户。
- [ ] 步骤 5：同步兼容矩阵和用户说明并提交。

**T20追加状态（2026-11-15）：** `68875bb` / `88398c9`完成Node原始内容提取与npm物理实例索引源码组件，清单关闭不确定性/首错覆盖已修复，44项受影响检查和同一审查代理复审通过。其0600/0700私有材料与逻辑链接不等于可执行Node、完整graph或真实官方归档消费通过。`218271c`修复夹具两次取时的租约窗口，15项本地检查及独立复审通过；`16b0ff4`实际运行43717307923双Mac15业务各26项全部通过，D24关闭。私有Keychain路由`75fed42`及GitHub表达式修正`16b0ff4`已复审并获实际解析确认；运行43717451911各7项非持久测试通过、2项专用测试拒绝。诊断组件`2ce2de9`的过滤24项/集成5项/原路由39项与独立审查通过，运行43721479873确认双架构均实际编译成功，四个专用夹具均在Keychain创建和路径校验返回0后于KEYCHAIN_STAT拒绝，具体文件属性仍待诊断；删除仅记录开始后控制器被SIGKILL，清理保持未知。Bundle ID固定`io.github.baofengbaofeng.veriq`；用户已授权独立GitHub临时VM/一次性账户私有Keychain创建、锁定/解锁、删除及该账户偏好影响，无需重复询问。Cookie、真实控制台、生产默认钥匙串与签名安装仍分别验收。

**T20追加状态（2026-11-16，北京时间）：** 用户PR #25合并后的`origin/master fb52be4`已通过零源码差异合并`6db4bc0`同步。`cdc46d8`实际诊断确认旧文件组/其他权限不符；权限组件`3063739`及夹具修正`e726c2d` / `994f9cb`经独立复审，运行43730742396双Mac各22项真实权限用例、7项非持久及26项业务检查通过，控制器构建事实包含实际新头文件。随后私有运行43732187459四个夹具均通过创建、文件绑定、模式和身份检查；各2项专用测试仍在清理路径失败，删除仅开始后SIGKILL，正文及OS删除未知。`27bfd58` / `ab98441`新增正文/擦除/清理分离、首个操作和已返回辅助进程事实诊断；初审I1消费者组合校验已修复并经同一代理定向复审，最终26新/24旧过滤/49属性/22阶段用例及类型格式通过。原M1响应形状可能保守保留UNKNOWN留最终复审；不把源码通过当成私有验收成功。下一步仅一次已授权双架构诊断，同时接续既有官方资产流水线的Node静态消费；两者均不代表整个T20或MVP完成。

**T20真实验收追加（2026-11-16，北京时间）：** 官方Node静态消费组件已闭合：`1c20bc5` / `89d568d`源码、一次上传条件修正及原审查代理复审通过，真实运行43740087046两架构各unit8及ACQUIRE/OBSERVE/BOOTSTRAP通过、提交与清理CONFIRMED；各5888原始成员/4797文件/1089目录/npm根及嵌套144实例，46个ZIP成员CRC、45引用、独立19+producer2+ciProcess2共23源码引用核验通过。仅下载两份小元数据，大归档和未上传包体未在本机重哈希；源审查、目标Graph、可执行布局、Chrome提取与完整Runtime仍待交付。原生操作诊断`16ffe36`经35/24/49/22定向检查及全新独立审查，真实43742207469两Mac编译及非持久7项通过；第一broad seed19在helper-frame谓词失败，read-denial3在event-denied标记不符。未捕获辅助进程原始读取OSStatus，不能推断exit2或读取成功。两正文/清理回调失败、擦除通过；仅ARM第二夹具记录SecKeychainDelete返回0，其余仅开始，完整清理仍未知。下一步定位这两条辅助进程读取路径，不放宽负例或改变清理时序。

**T20读取验收追加（2026-11-16，北京时间）：** `2e8d960` / `6710c5d`闭合辅助进程原始读取诊断与真实无存储原生自测，运行43749005113确认旧读取均返回-50参数错误，不是权限拒绝。`29661cc`将测试读取改为范围准确的ALL元数据唯一性检查及引用锚定的单条数据读取，保留生产ACL/NoUI与原有全部负例；62/24/49/22定向检查、类型、全新独立规格/质量审查通过。真实43752171340双Mac编译、自测及7项非持久通过，读取返回0，拒绝读取返回-25293且前后均解锁；第二专用用例正文/擦除/清理通过、控制器exit0、删除返回0。第一用例完成broad策略的读取基线及get/set/delete拒绝、未变化证明后，在原有remove24失败；后续七策略与不确定恢复尚未执行，首夹具完整清理未知。删除OSStatus仍待捕获，不把假设当成授权原因，也不把读取通过计为整个T20完成。

**T20私有Runtime存储组件完成（2026-11-16，北京时间）：** 原查询修复`29661cc`后的首个remove失败由`13ab3e3`真实诊断为SecItemDelete返回-25244；`e0ba135`仅在测试控制器内完整核验同范围ALL元数据/引用后，逐项调用SecKeychainItemDelete，保留全部生产ACL检查、八项负例和原预算。两轮原审查代理规格/质量复审C/I/M均0，最后一文件改动复用未变化的64/24/49/22及类型结果；root39封存/695保护Git/20历史封存与319缓存成员核验通过。真实43758515194双Mac SDK/共享原生自测、各7非持久＋2专用通过且无跳过；八策略、未变化证明、不确定恢复及真实-25293解锁读取拒绝通过，四夹具正文/擦除/清理通过、实际控制器exit0、SecKeychainDelete返回0且目录清理通过。匹配多条的删除仅经源码批次校验/遍历与生命周期审查，不冒称另有原生多匹配用例；粗粒度清理摘要仍为源绑定测试推导，详细记录另有实际退出/删除事实。关闭此功能组件，后续继续生产依赖、可执行Runtime、Electron与安装；不提前关闭整T20或MVP。

### T20 固定锁生产依赖布局生产器（组件已完成）

既有T20范围内的CI生产步骤，按已确认的双Mac优先级继续。保留现有官方资产流水线，通过同一工作流的显式purpose选择独立生产布局任务；该步骤产生可复用的物理布局元数据，后续仍需真实依赖物化、目标解析、可执行布局、Chrome与完整Runtime验收。

**文件职责与接口：** 修改 `.github/workflows/runtime-payload-macos.yml` 仅加入purpose准入和独立原生矩阵；新增 `.github/scripts/production-layout.mjs` 负责生产步骤/物理清单；新增 `apps/runtime/tests/production-layout-ci.test.mjs` 验证真实小进程及文件系统边界。复用既有 `runBoundedAssetCli({executable,args,cwd,timeoutMs})`，不修改或复制进程管理器，不增加产品库或新工作流。生产器无副作用导出 `classifyCommandResult(result): "PASS" | "FAIL"` 与 `collectLayoutMetadata({root, evidenceDir, workspaceRoots, limits}): Promise<{schemaVersion:1, totals, artifacts}>`，后者产生有SHA/字节/类别的分块JSON引用及完整原始清单；CLI入口仅直接执行时运行。宿主沿用CI的Node24.x并记精确版本/hash，不与正式执行引擎版本混同；不输出GraphProof、Expected或就绪。

**全局约束：** macOS15 Intel x64/Apple Silicon arm64；受信宿主Node24及固定pnpm11.25.0；冻结原锁、生产、离线、忽略脚本、hoisted，原严格peer/发布年龄/overrides策略保留；不运行提取的Node/Chrome、Electron、安装脚本或实际Provider。元数据仅为源绑定观测，来源和发布者状态不晋升。中文有效注释首行≥60、4空格/无Tab、英文日志、VeriQ/AGPL及现有资产预算/准入/上传语义保留。

**审查重点与对应测试：**

- 截断、超时、派生失败或关闭未知不能报告安装PASS；用真实Node小子进程验证阶段结算及后续NOT_RUN。
- 符号链接只记录原始目标，绝不递归读取外部目标；用真实外部毒化清单链接验证不跟随。
- 同名同版的嵌套包不能折叠；用实际嵌套目录和完整清单验证不同物理实例及文件归属。
- 清单/路径/实例/总字节越界必须失败，不能省略后报告成功；用真实超限文件与小预算验证。
- 未知purpose、错误源码或平台不得获取依赖；保存准入分支和真正双架构运行事实，默认资产分支保留。

- [x]   1. 编写生产器的失败阶段、真实嵌套包/链接/越界测试并观察RED；此处只验证工具行为，不伪造真实pnpm布局。
- [x]   2. 实现CI工具并复用已有有界进程函数。source_ref必须40位十六进制且等于GITHUB_SHA，记录workflow/锁/workspace/各package 清单及脚本/测试/进程依赖SHA。
- [x]   3. 在独立自有目录使用宿主工具准备存储：pnpm fetch --prod --frozen-lockfile --ignore-scripts；记录全workspace生产获取范围，锁不变；不宣称Runtime过滤获取。
- [x]   4. 使用无node_modules的新源码副本及已准备存储，运行pnpm --filter @veriq/runtime... install --frozen-lockfile --offline --ignore-scripts --prod --node-linker=hoisted --package-import-method=copy；记录实际importer/包/链接事实，过滤未生效或拒绝不得靠改锁、inject、对等方放宽来掩盖。
- [x]   5. 生产全部物理package实例、完整原始package.json、普通文件SHA/大小/模式、原始符号链接、bin及workspace源码映射；Node内置fs/crypto完成有界观察，不新增图求解器，不执行包体。
- [x]   6. 工作流新增purpose（默认assets、显式production-layout）和拒绝未知值的准入，保留原push/default-assets步骤及制品行为；独立Mac矩阵30分钟，工具≤4/获取≤12/安装≤8/观测≤4分钟，旧资产job40分钟不变。
- [x]   7. 宿主工具/来源准入后显式运行新MJS单测门禁，再做生产获取；命令stdout64KiB/stderr4MiB/六秒有限关闭沿用现有函数。物理清单≤4000实例/40000成员/1024链接/16GiB内容，路径≤1024，清单≤1MiB/其他JSON读取≤4MiB，上传固定元数据/日志总≤64MiB，超限显式失败。
- [x]   8. 记录STARTED/PASS/FAIL/NOT_RUN、原始参数/退出/超时/关闭/锁前后SHA及占用；只上传固定、关闭后取得的元数据/日志，7天保留。包体/存储/checkout/HOME/缓存和大归档不上传；已失败/未知的布局不获得成功清单。
- [x]   9. 运行覆盖新调用方/清单逻辑的本地GREEN、格式和源码保护检查，源绑定PRE/POST/精确3路径提交，独立审查。协调者之后仅一次production-layout手动触发，核验双架构小制品身份、CRC、引用、源码/工具/锁与物理计数；不本机重哈希未上传的包体。

注：只改一个巨型工作流内嵌全部观察代码会增加维护负担，因此采用一个CI专用工具和永久测试；仍只有一个既有工作流、没有新产品模块，先前只读预检的一文件建议在此细化。此为现有授权T20的实现分解，不改变已确认MVP/产品架构或引入外部付费服务。

## T21：安装、升级、备份恢复与观测

**依赖：** T12/T16/T18/T20

**文件（拟创建或修改）：**

- `deploy/compose.yaml`
- `deploy/Dockerfile`
- `deploy/install.sh`
- `deploy/start.sh`
- `docs/operations/install.md`
- `docs/operations/upgrade.md`
- `docs/operations/backup-restore.md`
- `tests/acceptance/test_operations.py`

**接口：** veriq_server init/migrate/serve/doctor；配置CLI>VERIQ_env>文件>默认；liveness/readiness分离。

- [ ] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert restored.resource_hashes == before_backup.resource_hashes
assert upgrade_preserves_external_config is True
assert incompatible_rollback_is_rejected is True
```

- [ ] **步骤 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest tests/acceptance/test_operations.py -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **步骤 3：实现上述接口与文件。** 单迁移job、主密钥备份、File/S3、保留期、容量/租约/清理指标、离线设备恢复、公开快速开始可照做；Compose可选Runtime profile与Linux服务安装，云端受管理设备真实执行并进入门禁。
- [ ] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t20 安装、升级、备份恢复与观测`。有新决策先更新ADR，不扩展到下一任务。

## T22：全模块用户体验、示例与接入文档

**独立前置整改状态（2026-11-15）：** D14注释坐标由`e4a8cf6`及`c1b43c6`修复，28项真实行为测试、原审查代理定向复审通过；保留Node原始换行/码点映射和Python通用物理换行。`f35fb6b`随后完成十文件102处按钮类型注解，专项规则/类型/格式及独立复审通过（20 submit/82 button，原6处保留）。`6ef86c1`对应全仓注释审计为541文件、4.5642307104%/264项违规，B05>40%仍未通过。`764ef88`完成会话/列表的稳定回调与响应归属，`ebbec8a`及`90d3a1a`分别修复迟到变更覆盖退出、过期退出意图阻挡后续登录；最终完整认证用例1/1通过（20.6秒）、9项Hook规则清零，同一Astra两轮定向复审最终C/I/M均0。本地仅核对20项直接依赖并使用限定的私有Vite启动器，完整锁树CI、D23全局会话传输验收仍开放；`cb48e77`完整CI的43项错误中已有9项源码整改，其余完整复验及UX/示例等余项未完成，不提前计整T22验收。

**依赖：** T11/T12/T13/T15/T16/T19/T21

**文件（拟创建或修改）：**

- `fixtures/demo-app/`
- `docs/user-guide.md`
- `docs/integration/frontend.md`
- `docs/integration/backend.md`
- `docs/admin-guide.md`
- `tests/e2e/full-product.spec.ts`

**接口：** 示例Workspace具备目录、用例、数据、fixture、角色和执行计划，URL按Runtime网络可达配置。

- [ ] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```ts
await expect(page.locator('[veriq-id="workspace.demo"]')).toBeVisible();
await expect(page.locator('[veriq-id="run.outcome"]')).toHaveText("PASSED");
```

- [ ] **步骤 2：运行测试确认未实现时失败。** `pnpm e2e -- tests/e2e/full-product.spec.ts`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **步骤 3：实现上述接口与文件。** F01-F14全部菜单和操作有真实API、空态/错误/加载/权限，中文/英文，文档可重现，非假数据演示。
- [ ] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t21 全模块用户体验、示例与接入文档`。有新决策先更新ADR，不扩展到下一任务。

**T22 Workspace追加（2026-11-16，北京时间）：** `1010675`完成W2B Provider生命周期及四个入口默认选择；真实BASE复现旧回调在Beta提交后误留Beta，GREEN两项浏览器回归通过（17.8秒），包含实际Provider/QueryClient、真实后端四入口、重渲染/切换/卸载及重新登录。应用和新测试严格类型、定向lint/格式及全新独立规格/质量审查通过；690保护Git文件、7015既有证据、18封存与319缓存成员核验通过。静态规则检查仍有3项既有警告及19项提示，浏览器保留色彩环境警告，不称零警告；本地仅直接20依赖核对，不冒称完整锁树。D12/Report、其余Hook、Identity、全局会话与全产品/发行门禁仍开放。

**T22 Identity追加（2026-11-16，北京时间）：** `ed5d7c9`完成W2C，真实BASE/GREEN各2通过且无行为RED冒称；实际静态2Hook错误清零，RHF稳定reset清理及旧作用域secret写入保护通过全新独立审查。root93封存/694保护Git/7270旧证据/21历史封存与319缓存核验。完整应用及所选测试严格类型通过，所选程序不含未改共享beforeEach；完整case文件旧noUnsafeFinally/TS2322仍保留，初始静态start/elapsed缺失已披露且不重建，完整发布与B05未关闭。

## T23：完整产品验收与1.0发布门禁

**依赖：** T01-T22

**文件（拟创建或修改）：**

- `tests/acceptance/`
- `docs/acceptance/requirements-matrix.md`
- `docs/acceptance/release-report.md`
- `docs/known-limitations.md`

**接口：** release_gate(report: AcceptanceReport) -> ReleaseDecision；全部需求、产物、兼容和故障证据齐全才通过。

- [ ] **步骤 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert all(requirement.accepted for requirement in report.f01_to_f14)
assert report.official_release_has_no_skipped_tests
assert report.contains_real_windows_and_linux_evidence
assert report.contains_real_macos_x64_and_arm64_evidence
```

- [ ] **步骤 2：运行测试确认未实现时失败。** `pnpm acceptance`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **步骤 3：实现上述接口与文件。** 10Run并发、未知进程隔离、离线、篡改、权限、模型关闭、真实业务5～10条×至少5轮、wheel/安装/升级/恢复、许可与签名。
- [ ] **步骤 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **步骤 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t22 完整产品验收与1.0发布门禁`。有新决策先更新ADR，不扩展到下一任务。

## 最终验收与交接

最终交付必须包含服务端发布包与镜像、macOS15及以上x64/arm64、Windows11 x64和Ubuntu24.04 x64的桌面与Runtime包、源码/锁文件、迁移、公共契约、示例工程、用户/管理员/接入/运维手册、SBOM/NOTICE、真实验收结果及已知限制。全部F01-F14通过后才标记1.0完成；内部任务完成不能代替完整产品验收。

进入编码前由用户审阅规格与选型。本文不授权代用户选择商业许可证、付费服务、发布生产环境或发送通知。审阅确认后按任务执行，不重复询问已确认的范围与技术要求。

**T20 生产布局验收追加（2026-11-16，北京时间）：** `ca34c8d` 首次真实双 Mac 验证保留为失败：ARM 工具实现路径错误，Intel 测试未确认子进程就绪。`afe4838` 使用 pnpm 11.25.0 实际 ESM 入口与实现记录，并加入真实 READY/release/DONE 通知；正常及延迟启动场景、34 项相关测试、原代理复审与源码保护检查通过。新运行 [43770719879](https://github.com/baofengbaofeng/VeriQ/actions/runs/43770719879) 两架构工具、获取、离线安装、采集四阶段全部通过；每边 194 ZIP 成员、193 引用、14 项选定源码及全部 698 Git 文件记录、121 原始包清单与 8,390 物理成员已独立核验。锁文件前后相同，未放宽参数或政策。此组件关闭于第一轮修复；来源信任、包体复现、依赖闭包、目标解析、可执行 Runtime、Electron 与安装仍开放。

**T22 AI 追加（2026-11-16，北京时间）：** `b0aeb1e` 将八类请求输入与预览审核状态统一管理，实际变更同时清除预览与已审核请求，同值操作保留状态；默认选择使用稳定的首项 ID。真实 BASE 保持与两项 GREEN 回归通过，4 项 Hook 错误清零，完整应用及整个 AI 测试文件严格类型检查、独立审查和证据核验通过。修改后完整本地 Web 静态规则检查 为 18 项错误 / 33 项警告 / 138 项提示，未截断；这是本地源码基线，不能替代正式发行。四次测试预期/定位错误已保留并更正，资源引用按钮仅做静态覆盖；完整旧 AI 流程、外部 Provider、全局会话及 B05 仍开放。

### T20 入口与执行文件的临时输入视图

**目标与范围：** 在既有 T20 内生成可被当前严格 读取器 消费的 agent/cli 入口树、八个原始执行文件及收据。保留五树最终组装和独立 Expected 门禁；本组件不发布独立输入目录、不执行产出的 JavaScript 或候选 Node/Chrome。

**内部方案选择：** 复用调用者持有的 ArchiveTransaction work 生命周期，消费者 inputRoot 固定为 work.scratch/views，树根为 entries/execution，源码快照保留原相对路径，元数据位于 input-evidence/。这样沿用现有 0644/0755 视图和外层 0700 私有保护，无须增加 profile、schema 或发布政策。另建独立发布器会重复已有所有权/审计规则，故不采用。此为已批准 T20 内的实现细化，由协调者选择；总体架构和执行方式不变。

**文件与复用：** 新增 apps/runtime/scripts/runtime-payload-entries.ts、apps/runtime/runtime.vite.config.mjs、apps/runtime/tests/runtime-payload-entries.test.ts；runtime-payload-graph.ts 只增加现有字面导入分析和导入边分类的窄导出，不改算法。复用已声明的桌面 Vite 6.4.5 CLI、Rollup、锁定 TypeScript 和现有 reader/transaction/canonical JSON；不新增依赖或改锁。

**接口：** withEntryInputViews<T>(work: ArchiveTransaction, options: EntryInputOptions, consume: (inputRoot: string, trees: Readonly<{entries: BoundTree; execution: BoundTree}>) => Promise<T>): Promise<T>。EntryInputOptions 使用现有 SourceBindingV1 与两项 Omit<Build, "commandEvidence">，再接收调用者持有的独立空构建目录和真实宿主构建动作；具体动作观察结构为内部类型，须保留实际 argv/cwd/时刻/工具身份/退出及关闭事实，不能预先声明成功。调用者拥有事务与构建目录的释放，回调只在全部核验后运行；函数不返回持久或 就绪 能力。

**固定契约：** 源入口为 apps/desktop/src/agent/index.ts 与 apps/runtime/src/cli.ts，输出入口恰为 agent.js/cli.js，所有 chunk/asset 和字面导入必须完整登记。独立 MJS 配置只导入 Node 内建，使用普通 Vite 配置，不能复制 electron-vite 专属 externalizeDeps 选项后假定生效。固定复制 worker/provider/compile-entry/archive/controlled-command/controlled-child/controlled-child-protocol/controlled-child-preload.mjs；无改写、打包或脚本执行。编译器既有显式 tsx 路径保留，不能推断所有消费者都有 loader。

- [x]   1. 用真实宿主 Vite 构建两个共享工作区与 JSON Schema 的小型 TS 入口，先观察缺少生产器或错误 root/mode 的 RED；记录构建观察，不运行生成入口。
- [x]   2. 配置按明确 sourceRoot 构建两个 Node 入口，排除 Electron main/preload/renderer；记录实际工作区模块、清单 与 JSON 输入，避免通过宿主 检出目录 偷读未绑定源码。
- [x]   3. 宿主构建只写独立目录；确认真实成功与关闭后，完整扫描并通过 work.write 复制到 views/entries，固定八文件复制到 views/execution，原始源码快照写到 views 下的原路径。
- [x]   4. 用既有 TreeInventory/EntriesReceipt/ExecutionReceipt/BoundTree 生成 规范化 元数据并严格读取；明确去掉一次 views/ 前缀。核源码、锁、目标、实际命令证据、模式、链接禁令、完整父目录和所有 JS 资产导入，再运行消费者回调及 reader/transaction 收尾核验。
- [x]   5. 核验源码/锁/选项变更、缺失或额外输出、相对 chunk 丢失、Electron 导入、带隐藏导入的 JS asset、链接/路径冲突、失败构建、未知关闭与消费后变更。未知关闭不再扫描或删除构建目录，不伪造全配方/Expected 绕过局部核验。
- [x]   6. 新生产器与现有 graph 相关检查、类型/格式/注释及源绑定保护通过后，精确四路径提交并独立复审。之后另行接入已授权开发 CI 的双 Mac 入口构建验收；不重复已关闭的布局观测，不把源准备计为完整 Runtime。

**T22 资源编辑器追加（2026-11-16，北京时间）：** f03f719 完成资源页首项默认依赖与 Monaco 最新值引用，保留模型、撤销、当前回调和销毁行为。两项新真实 GUI/组件回归及未改 JSON 应用（Apply）用例通过，完整应用与新测试严格类型、独立审查及 143 项证据核验通过。三项 Hook 错误清零，旧资源页两项列表键问题保留。完整本地前端检查现为 15 项错误 / 32 项警告 / 138 项提示，无遗漏；全局规范、旧用例类型、正式发行和完整 MVP 仍开放。

**T20 入口源码审查追加（2026-11-16）：** `7d61422` / `2dcb09e` 完成上述输入视图与第一轮修复。55 项真实 Vite/依赖图 相关测试、完整 Runtime 类型、格式与定向注释检查通过；原独立审查员确认两项 重要问题 均已解决，剩余 C/I/M 为 0。原始 93 项与修复 63 项封存、702 Git 文件、28 历史封存 2,160 项及既有证据保护通过独立核验。真实最近物理 package.json 必须绑定，保留命名空间按大小写折叠拒绝；未知关闭仍不扫描或删除构建目录。下一项为同一审阅提交的双 Mac 真实项目入口构建 CI；本源码组件通过不关闭原生、五树组装、独立 Expected、依赖解析或完整 Runtime/MVP。
