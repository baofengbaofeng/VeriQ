> 执行修订：用户要求先补README，然后使用subagent编码；出现影响范围、架构或外部服务的未决问题必须暂停核对。桌面GUI首发采用Electron；T19包含apps/desktop及electron-builder，不按旧Rust壳文件清单执行。仓库现有AGPL-3.0保持。

# VeriQ 1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Subagent-driven execution is optional only if explicitly selected. Steps use checkbox syntax. 本文为完整产品的内部实施顺序，不把中间任务作为缩减MVP交付。

**Goal:** 完整交付规格F01-F14，达到安装、运行、云/本地/离线、管理、报告、升级运维均可用。

**Architecture:** Python3.12/Tornado 6.6.1/SQLAlchemy/MySQL控制面，React产物进入后端static/dist统一发布，独立Node/Playwright Runtime执行。统一Job类型TEST/VALIDATE/CLEANUP，外部HTTP唤醒，无内部Cron。

**Tech Stack:** 见规格技术选型表，具体依赖和产品许可在审阅后ADR锁定。

**Spec:** [06-VeriQ-v1.0-需求与技术规格.md](../specs/veriq-1.0.md)

## Global Constraints

- F01-F14全部属于首发MVP，不能以开发阶段为由删减。
- Python3.12、Tornado 6.6.1、SQLAlchemy2.0、MySQL8.4 LTS；全部表veriq_，Alembic表veriq_alembic_version。
- 私人设备与Workspace分别授权；本地自有进程veriq/veriq_agent/veriq_runner。
- 开发前后端分开；生产web check/build后复制到apps/srv/src/veriq_server/static/dist，随wheel发布。
- 服务端运行不需要Node或浏览器；Runtime采用同一TS引擎，不在常规执行调用模型。
- 业务唤醒和维护提供HTTP，Cron交外部；心跳10秒、租约60秒，过期不能复活。
- 在线4个上下文、Workspace2个；10个未结束Run；离线本机1个，不宣称云端可约束全部离线并发。
- Playwright retries=0；VeriQ最多1次整用例重试，首次失败重试通过UNSTABLE。
- 发布内容不可变；所有结果检查fencing，未知物理进程与资源QUARANTINED。
- 正常发布默认全测，Python/TS核心行覆盖>=75%；紧急跳过需原因和标记，常规release拒绝。
- 文中测试片段规定核心断言，完整测试初始化由所属任务实现；以下命令尚未执行，不得把预期输出当实际证据。

## Review Focus

1. 真实HTTP成功但数据未落库、同路径后台请求、动作失败后的监听残留：T06/T07。
2. 设备失联但浏览器仍运行、旧令牌迟到：T09/T10/T22，不能仅回收数据库计数。
3. gitignore前端产物未入wheel、SPA吞API404、生产意外依赖Node：T17/T18。
4. 离线包/报告篡改、跨Workspace访问、个人设备调度：T03/T08/T14/T15。
5. 全模块只做页面壳、测试默认被跳过、Windows发行未经实测：T19/T21/T22。

## 仓库验证入口

T01建立pnpm check、pnpm verify、pnpm e2e -- <spec>、pnpm acceptance、pnpm compatibility:runtime；Python命令统一uv run --project apps/srv。E2E与验收脚本启动/连接测试环境并返回非零失败码。构建全测可拆CI job，但证据必须绑定同一commit/锁文件/static hash。

## T01：工程基线、依赖ADR与公共契约

**依赖：** 无

**状态：** 已完成并通过独立规格/质量审查（`23b5282`、`188c856`）；仅代表工程基线与公共契约。

**Files（拟创建/修改）：**

- `apps/srv/pyproject.toml`
- `apps/srv/uv.lock`
- `pnpm-workspace.yaml`
- `packages/contracts/schemas/case-v1.schema.json`
- `packages/contracts/openapi/platform.yaml`
- `packages/contracts/tests/compatibility.test.ts`
- `apps/srv/tests/contracts/test_compatibility.py`

**Interfaces：** validate_case_schema(input: Any) -> list[ValidationIssue]；生成CaseDslV1、SnapshotV1、JobManifestV1等TS类型。

- [x] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert validate_case_schema(valid_case) == []
assert validate_case_schema(unknown_action_case)
assert python_validation_results == node_validation_results
```

- [x] **Step 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/contracts -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **Step 3：实现上述接口与文件。** 相同至少20个正反样本结果一致；无浮动latest依赖；选定原生入口技术和许可证；候选不伪称已批准。
- [x] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t01 工程基线、依赖ADR与公共契约`。有新决策先更新ADR，不扩展到下一任务。

## T02：自有账号、初始化与会话

**依赖：** T01

**状态：** 已完成并通过独立规格/质量审查（`678587d`、`32e625e`）；覆盖自有账户、初始化、会话与管理员界面。

**Files（拟创建/修改）：**

- `apps/srv/src/veriq_server/auth/session.py`
- `apps/srv/src/veriq_server/services/bootstrap.py`
- `apps/srv/src/veriq_server/handlers/auth.py`
- `apps/web/src/features/auth/LoginPage.tsx`
- `apps/web/src/features/setup/SetupPage.tsx`
- `apps/srv/tests/auth/test_session.py`

**Interfaces：** SessionService.login(credentials: LoginInput) -> SessionReceipt；BootstrapService.create_admin(input: AdminInput, setup_proof: SetupProof) -> UserDTO。

- [x] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert await login_valid_user() == AUTHENTICATED
assert await use_revoked_session() == UNAUTHENTICATED
assert await bootstrap_second_admin_without_authority() == FORBIDDEN
```

- [x] **Step 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/auth -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **Step 3：实现上述接口与文件。** 密码可靠哈希、无固定默认密码、单次重置/邀请令牌、CSRF、禁用后会话无效；安装/登录UI真实可用。
- [x] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t02 自有账号、初始化与会话`。有新决策先更新ADR，不扩展到下一任务。

## T03：Workspace、成员与强制授权

**依赖：** T02

**状态：** 已完成并通过独立规格/质量审查（`ef0fb6d`、`39672c4`、`eb75c4b`）；资源、执行与证据等后续服务须复用作用域授权。

**Files（拟创建/修改）：**

- `apps/srv/src/veriq_server/services/workspace.py`
- `apps/srv/src/veriq_server/auth/authorization.py`
- `apps/web/src/features/workspaces/WorkspacePage.tsx`
- `apps/srv/tests/auth/test_workspace.py`

**Interfaces：** Authorization.require(actor: Actor, scope: WorkspaceScope, permission: Permission) -> None；所有Repository显式WorkspaceScope。

- [x] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert await actor_a_read_workspace_b() == FORBIDDEN
assert await remove_last_owner() == CONFLICT
assert await reference_other_workspace_version() == INVALID_REFERENCE
```

- [x] **Step 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/auth/test_workspace.py -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **Step 3：实现上述接口与文件。** 资源、批量、证据、SSE、下载、导入全部跨空间拒绝；切换空间清缓存/取消旧订阅。
- [x] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t03 Workspace、成员与强制授权`。有新决策先更新ADR，不扩展到下一任务。

## T04：版本化资产、草稿、校验回执与发布

**依赖：** T01/T03

**状态：** 已完成并通过独立规格/质量审查（`2a2dd25`）；生产回执写入依赖后续可信 Runtime 完成链路。

**Files（拟创建/修改）：**

- `apps/srv/src/veriq_server/services/resource.py`
- `apps/srv/src/veriq_server/services/publish.py`
- `apps/srv/src/veriq_server/repositories/resource.py`
- `apps/srv/tests/resources/test_publish.py`

**Interfaces：** ResourceService.update_draft(scope, resource_id, expected_revision, document) -> DraftDTO；PublishService.publish(scope, draft_revision, receipt_id) -> VersionDTO。

- [x] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert await stale_revision_update() == CONFLICT
assert old_version.document == old_document
assert await publish_with_receipt_for_other_hash() == INVALID_RECEIPT
```

- [x] **Step 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/resources -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **Step 3：实现上述接口与文件。** 所有kind共用版本规则；修改模板/目录/数据不改变旧版本；维护引用与影响分析。
- [x] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t04 版本化资产、草稿、校验回执与发布`。有新决策先更新ADR，不扩展到下一任务。

## T05：确定性编译器与变量依赖

**状态：** 已完成并通过独立规格/质量审查（`dcb05c0`、`3588164`）；生产 SDK 执行由 T06 实现。

**依赖：** T01/T04

**Files（拟创建/修改）：**

- `packages/compiler/src/validate.ts`
- `packages/compiler/src/dependency.ts`
- `packages/compiler/src/compile.ts`
- `packages/compiler/tests/compile.test.ts`

**Interfaces：** validate(snapshot: AssetSnapshotV1): ValidationIssue[]；compileAssets(snapshot: AssetSnapshotV1): CompiledAssetBundle；assembleExecution(bundle, snapshot: ExecutionSnapshotV1): ExecutionPackage。

- [x] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```ts
expect(validate(useBeforeExtract).map(x => x.code)).toContain('VARIABLE_USED_BEFORE_DEFINED');
expect(compileAssets(assetSnapshot).sourceHash).toBe(compileAssets(assetSnapshot).sourceHash);
```

- [x] **Step 2：运行测试确认未实现时失败。** `pnpm --filter @veriq/compiler exec vitest run tests/semantics.test.ts tests/emission.test.ts`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **Step 3：实现上述接口与文件。** fixture输出声明、模板固定、流程5层/500步、secret引用、JSON Pointer缺失类型、写用例持久化检查点。VALIDATE上传实际TS/依赖/文件manifest，服务端存不可变制品供正式包复用，草稿无Runtime导出标unvalidated且只含DSL。
- [x] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t05 确定性编译器与变量依赖`。有新决策先更新ADR，不扩展到下一任务。

## T06：操作、监听和完整断言SDK

**状态：** 已完成并通过独立规格/质量审查（`2482be9`、`68c99fd`）；真实身份/fixture 与 Runtime 接入分别由 T07/T10 完成。

**依赖：** T05

**Files（拟创建/修改）：**

- `packages/runner-sdk/src/execute-step.ts`
- `packages/runner-sdk/src/observers/network.ts`
- `packages/runner-sdk/src/assertions/ui.ts`
- `packages/runner-sdk/src/assertions/http.ts`
- `packages/runner-sdk/tests/network.test.ts`
- `packages/runner-sdk/tests/persistence.test.ts`

**Interfaces：** executeStep(step: ResolvedStep, ctx: StepContext): Promise<StepResult>；armObserver(...): ObserverHandle，包含waitFirst/finalize/dispose。

- [x] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```ts
expect(savedRequest.body.code).toBe(attemptCode);
expect(await missingPersistenceCase()).toMatchObject({outcome:'FAILED'});
expect(registry.activeCount()).toBe(0);
```

- [x] **Step 2：运行测试确认未实现时失败。** `pnpm --filter @veriq/runner-sdk exec vitest run tests`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **Step 3：实现上述接口与文件。** 快速响应、同路径干扰、歧义、合法重试、JSON/非JSON/204、最终一致、点击失败无悬挂Promise；使用真实Playwright验证。
- [x] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t06 操作、监听和完整断言SDK`。有新决策先更新ADR，不扩展到下一任务。

## T07：fixture、业务身份与补偿

**状态：** 已完成并通过独立规格/质量审查（`01561bc`、`6952a5b`）；真实设备授权、制品权限与离线签名接入分别由 T08/T09、T12、T14 完成。

**依赖：** T06

**Files（拟创建/修改）：**

- `packages/runner-sdk/src/fixtures/client.ts`
- `fixtures/demo-app/`
- `fixtures/test-support/`
- `packages/runner-sdk/tests/fixtures.test.ts`
- `docs/integration/backend.md`

**Interfaces：** prepareFixture(request: FixtureRequest): Promise<FixtureContext>；cleanupFixture(context): Promise<CleanupReceipt>；凭证解析隔离于普通变量。

- [x] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```ts
expect(second.fixtureId).toBe(first.fixtureId);
expect(attemptA.namespace).not.toBe(attemptB.namespace);
expect(await cleanupAgain()).toMatchObject({status:'ALREADY_CLEANED'});
```

- [x] **Step 2：运行测试确认未实现时失败。** `pnpm --filter @veriq/runner-sdk exec vitest run tests/fixtures.test.ts`；失败必须来自缺失行为，而非测试环境拼写错误。
- [x] **Step 3：实现上述接口与文件。** 同key异参409，UI创建资源归属、部分失败/强杀回收、权限请求使用业务身份；stub与真实被测系统分别验收。环境roleKey映射认证/凭证版本，受管理设备按有效Attempt权限领取、个人设备默认本地解析，测试撤销、轮换、越权下发和日志不泄露。
- [x] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [x] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t07 fixture、业务身份与补偿`。有新决策先更新ADR，不扩展到下一任务。

## T08：设备注册、能力与私有/共享授权

**依赖：** T03

**Files（拟创建/修改）：**

- `apps/srv/src/veriq_server/services/runtime.py`
- `apps/srv/src/veriq_server/handlers/enrollment.py`
- `apps/runtime/src/enrollment.ts`
- `apps/web/src/features/runtimes/RuntimePage.tsx`
- `apps/srv/tests/runtime/test_grants.py`

**Interfaces：** RuntimeService.approve_enrollment(actor, code, binding, grants) -> EnrollmentReceipt；设备token最小权限且可撤销。

- [ ] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert await dispatch_to_unshared_private_runtime() == FORBIDDEN
assert await claim_with_revoked_device_token() == UNAUTHORIZED
```

- [ ] **Step 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/runtime -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **Step 3：实现上述接口与文件。** owner确认共享；管理员不隐式操控私人机器；doctor真实检查版本/网络/浏览器。系统管理员授予MANAGED，客户端不得自报；服务账号注册云端Runtime，历史与当前门禁可信度分开。
- [ ] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t08 设备注册、能力与私有/共享授权`。有新决策先更新ADR，不扩展到下一任务。

## T09：统一Job队列、快照、容量与fencing

**依赖：** T04/T08

**Files（拟创建/修改）：**

- `apps/srv/src/veriq_server/services/jobs.py`
- `apps/srv/src/veriq_server/services/lease.py`
- `apps/srv/src/veriq_server/services/capacity.py`
- `apps/srv/tests/execution/test_lease_mysql.py`

**Interfaces：** JobService.claim(identity: RuntimeIdentity, req: ClaimRequest) -> ClaimDTO | None；LeaseService.heartbeat(attempt_id, proof) -> HeartbeatDTO；kind=TEST/VALIDATE/CLEANUP。

- [ ] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert active_browser_slots <= 4
assert workspace_browser_slots <= 2
assert stale_fence_result.accepted is False
assert expired_unknown_worker.capacity_state == QUARANTINED
```

- [ ] **Step 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/execution/test_lease_mysql.py -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **Step 3：实现上述接口与文件。** 真实MySQL并发20claimer、同执行单租约、原子容量、响应丢失恢复、过期不能续活、未知进程容量不盲释放。
- [ ] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t09 统一Job队列、快照、容量与fencing`。有新决策先更新ADR，不扩展到下一任务。

## T10：Agent监督、事件、取消与整用例重试

**依赖：** T06/T07/T09

**Files（拟创建/修改）：**

- `apps/runtime/src/agent/claim-loop.ts`
- `apps/runtime/src/agent/heartbeat.ts`
- `apps/runtime/src/execution/supervisor.ts`
- `apps/runtime/src/execution/events.ts`
- `apps/runtime/tests/supervisor.test.ts`

**Interfaces：** runAttempt(claim: ClaimedAttempt, signal: AbortSignal): Promise<JobManifestV1>；terminateAttempt(id, reason): Promise<StopReceipt>。

- [ ] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```ts
expect(processes.active()).toHaveLength(0);
expect(retryPassed.outcome).toBe('UNSTABLE');
expect(firstAttempt.fixtureId).not.toBe(secondAttempt.fixtureId);
```

- [ ] **Step 2：运行测试确认未实现时失败。** `pnpm --filter @veriq/runtime exec vitest run tests/supervisor.test.ts`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **Step 3：实现上述接口与文件。** TEST/VALIDATE/CLEANUP真实分派；断网停止、finally、事件缓冲有界、重试由平台单层控制。
- [ ] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t10 Agent监督、事件、取消与整用例重试`。有新决策先更新ADR，不扩展到下一任务。

## T11：完整资产编辑器与环境配置UI

**依赖：** T04/T05/T08

**Files（拟创建/修改）：**

- `apps/web/src/features/resources/ResourcePage.tsx`
- `apps/web/src/features/cases/CaseEditor.tsx`
- `apps/web/src/features/assertions/AssertionEditor.tsx`
- `apps/web/src/features/environments/EnvironmentPage.tsx`
- `tests/e2e/case-publish.spec.ts`

**Interfaces：** Web只提交CaseDslV1；observer/断言/变量面板共享同一表单状态，JSON编辑与表单可逆。

- [ ] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```ts
expect(await page.getByTestId('case.validation-errors').count()).toBe(0);
await expect(page.getByTestId('case.published-version')).toBeVisible();
```

- [ ] **Step 2：运行测试确认未实现时失败。** `pnpm e2e -- tests/e2e/case-publish.spec.ts`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **Step 3：实现上述接口与文件。** 全部资源kind、模板参数/影响、数据行、公共流程、版本差异、错误/空态/冲突真实可用。
- [ ] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t11 完整资产编辑器与环境配置UI`。有新决策先更新ADR，不扩展到下一任务。

## T12：实时报告、证据、审计与可信门禁

**依赖：** T10/T11

**Files（拟创建/修改）：**

- `apps/srv/src/veriq_server/services/report.py`
- `apps/srv/src/veriq_server/services/artifact.py`
- `apps/srv/src/veriq_server/services/gate.py`
- `apps/web/src/features/reports/ReportPage.tsx`
- `apps/srv/tests/report/test_integrity.py`

**Interfaces：** ReportService.get(scope, run_id) -> RunReportDTO；ResultService.finish(proof, manifest) -> CommitReceipt；File/S3 ArtifactStore同接口。

- [ ] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert incomplete_manifest.outcome == INCOMPLETE
assert await foreign_workspace_artifact() == FORBIDDEN
assert same_finish_retry.receipt_id == first_receipt.receipt_id
```

- [ ] **Step 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/report -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **Step 3：实现上述接口与文件。** SSE补读、事件幂等、同终态重放、原始HTML隔离、Trace受限、各Attempt保留；错误不全绿。共享归约样本固定ERROR>INCOMPLETE>FAILED>CANCELLED>UNSTABLE>SKIPPED>PASSED，测试清理失败、取消缺证据、零用例与计划跳过。
- [ ] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t12 实时报告、证据、审计与可信门禁`。有新决策先更新ADR，不扩展到下一任务。

## T13：AI完整模块与无模型执行

**依赖：** T11/T12

**Files（拟创建/修改）：**

- `apps/srv/src/veriq_server/services/ai.py`
- `apps/srv/src/veriq_server/infrastructure/providers.py`
- `apps/web/src/features/ai/AiPage.tsx`
- `apps/srv/tests/ai/test_generation.py`

**Interfaces：** ModelGateway.generate(context: DraftContext) -> ModelReply；AiService.create_draft(scope, req) -> GenerationDTO；预算拒绝不影响Run。

- [ ] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert generation.resource_state == DRAFT
assert disabled_provider_run.outcome == PASSED
assert model_calls_during_execution == 0
```

- [ ] **Step 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/ai -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **Step 3：实现上述接口与文件。** Provider配置/连接、结构化生成/审核、脱敏失败分析、历史与费用；mock及经授权真实Provider各有证据。
- [ ] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t13 AI完整模块与无模型执行`。有新决策先更新ADR，不扩展到下一任务。

## T14：依赖闭包、签名包与本地凭证

**依赖：** T04/T10

**Files（拟创建/修改）：**

- `apps/srv/src/veriq_server/services/bundle.py`
- `apps/runtime/src/offline/verify.ts`
- `apps/runtime/src/credentials/store.ts`
- `apps/web/src/features/bundles/BundlePage.tsx`
- `apps/srv/tests/bundles/test_export.py`

**Interfaces：** BundleService.export(scope, req) -> BundleDTO；verifyBundle(input: Path): VerifiedBundle；SecretResolver.resolve(ref, attempt): SecretValue。

- [ ] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert exported_zip.contains_secret_values is False
assert tampered_bundle.accepted is False
assert set(exported_versions) == set(dependency_closure)
```

- [ ] **Step 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/bundles -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **Step 3：实现上述接口与文件。** 完整闭包、manifest字节签名、hash、安全解压、无密钥、secretRef本地映射、缺依赖明确失败。信任根通过认证绑定/带外指纹建立，禁止信任包内自带根，测试替换key、轮换、已知撤销和离线未知撤销状态。
- [ ] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t14 依赖闭包、签名包与本地凭证`。有新决策先更新ADR，不扩展到下一任务。

## T15：离线执行、本地报告与幂等回传

**依赖：** T12/T14

**Files（拟创建/修改）：**

- `apps/runtime/src/offline/run.ts`
- `apps/runtime/src/offline/upload.ts`
- `apps/srv/src/veriq_server/services/import_result.py`
- `apps/runtime/tests/offline.test.ts`
- `apps/srv/tests/bundles/test_import.py`

**Interfaces：** runOffline(bundle, config): Promise<OfflineResultV1>；ImportService.import(scope, result) -> ImportReceipt。

- [ ] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert first_import.run_id == repeated_import.run_id
assert first_import.source == OFFLINE_IMPORT
assert dirty_import.official_gate_passed is False
```

- [ ] **Step 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/bundles/test_import.py -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **Step 3：实现上述接口与文件。** 无平台连接可运行看报告，原线上Attempt不被覆盖，dirty/环境覆盖/来源可信度如实显示；本地进程仍命名veriq。
- [ ] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t15 离线执行、本地报告与幂等回传`。有新决策先更新ADR，不扩展到下一任务。

## T16：外部HTTP触发、维护接口与CI

**依赖：** T09/T12

**Files（拟创建/修改）：**

- `apps/srv/src/veriq_server/services/execution_plan.py`
- `apps/srv/src/veriq_server/services/maintenance.py`
- `apps/srv/src/veriq_server/handlers/trigger.py`
- `apps/web/src/features/runs/ExecutionPlansPage.tsx`
- `apps/srv/tests/execution/test_trigger.py`
- `docs/integration/external-scheduler.md`

**Interfaces：** TriggerService.trigger(scope, plan_id, input, idempotency_key) -> TriggerReceipt；maintenance按批次处理并返回hasMore。

- [ ] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert repeated_trigger.run_id == first_trigger.run_id
assert same_key_different_input.status == 409
assert unauthenticated_maintenance.status == 401
```

- [ ] **Step 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/execution/test_trigger.py -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **Step 3：实现上述接口与文件。** 仅HTTP无内部Cron；重叠策略、CI退出码/JUnit、受限凭证、租约/清理/保留期维护及外部接入说明。
- [ ] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t16 外部HTTP触发、维护接口与CI`。有新决策先更新ADR，不扩展到下一任务。

## T17：生产同源静态服务与开发代理

**依赖：** T02/T11

**Files（拟创建/修改）：**

- `apps/web/vite.config.ts`
- `apps/srv/src/veriq_server/handlers/static.py`
- `apps/srv/src/veriq_server/application.py`
- `apps/srv/tests/static/test_routes.py`

**Interfaces：** create_application(settings: Settings) -> tornado.web.Application；production静态根由安装包定位，development不要求dist。

- [ ] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert spa_deep_link.status == 200
assert missing_api.content_type == 'application/json'
assert missing_js.status == 404
assert path_traversal.status in (403, 404)
```

- [ ] **Step 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest apps/srv/tests/static -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **Step 3：实现上述接口与文件。** API404不回index，缺JS不回index，缓存头正确，同源Cookie/CSRF，前后端可分开调试。
- [ ] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t17 生产同源静态服务与开发代理`。有新决策先更新ADR，不扩展到下一任务。

## T18：前端先构建、wheel强制入包与服务端发行

**依赖：** T17

**Files（拟创建/修改）：**

- `build.sh`
- `scripts/build_release.py`
- `scripts/stage_web.py`
- `scripts/verify_wheel.py`
- `apps/srv/pyproject.toml`
- `apps/srv/hatch_build.py`
- `tests/acceptance/test_server_package.py`

**Interfaces：** build_release(options: BuildOptions) -> ReleaseManifest；必须顺序web check/build→stage→srv检查测试→wheel→干净安装→原子output。

- [ ] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert wheel.has('veriq_server/static/dist/index.html')
assert wheel.has_migrations()
assert release.tests_skipped is False
assert production_starts_without_node_or_chrome is True
```

- [ ] **Step 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest tests/acceptance/test_server_package.py -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **Step 3：实现上述接口与文件。** Hatchling hook区分editable与正式wheel；干净checkout无dist可安装开发依赖，正式构建缺dist失败；gitignore静态目录真实入wheel、无重复资源、无旧assets、版本一致、离线wheelhouse、正常默认全测、紧急跳过记录原因、SBOM/NOTICE/hash完整。
- [ ] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t18 前端先构建、wheel强制入包与服务端发行`。有新决策先更新ADR，不扩展到下一任务。

## T19：完整Electron桌面图形界面

**依赖：** T10/T11/T12/T14/T15

**Files：** apps/desktop/package.json；apps/desktop/electron.vite.config.ts；apps/desktop/src/main/index.ts；apps/desktop/src/preload/index.ts；apps/desktop/src/renderer/；packages/ui/；tests/e2e/desktop.spec.ts。

**Interfaces：** DesktopBridge为白名单类型化IPC；CloudResourceAdapter与LocalResourceAdapter共享资源视图；AgentClient连接受限本机IPC，不开启无认证控制端口。

- [ ] Step 1：写桌面真实E2E，覆盖登录/Workspace、设备绑定、下载、独立执行、取消、报告、回传、设置、自检和托盘。Renderer不得直接获得进程/任意文件/密钥能力。
- [ ] Step 2：运行pnpm desktop:test并确认缺功能时失败，保存证据。
- [ ] Step 3：实现全部桌面界面和Cloud/Local适配；本地静态UI随包，无平台连接也能操作缓存；UI与独立Node24 Agent生命周期分离。
- [ ] Step 4：运行组件、IPC、安全和真实Electron测试；检查UI崩溃/窗口关闭不丢后台执行。
- [ ] Step 5：同步契约、安装说明并提交。

## T20：Windows/Linux桌面与Runtime发行

**依赖：** T19

**Files：** apps/desktop/electron-builder.yml；scripts/build_runtime.mjs；tests/compatibility/process-names.spec.ts；docs/operations/runtime-install.md；对应CI工作流。

**Interfaces：** 桌面入口veriq，后台veriq_agent，执行veriq_runner；CLI可veriq_cli；固定Node24执行引擎独立于Electron内置Node。

- [ ] Step 1：测试安装后的实际进程名、离网依赖、后台/托盘、停止进程树、单实例、升级/卸载和签名校验。
- [ ] Step 2：在对应OS运行pnpm compatibility:runtime，确认未实现行为失败。
- [ ] Step 3：electron-builder发行GUI/Agent/Runner和浏览器；Linux与Windows独立构建验收，不另引入Rust桌面壳。
- [ ] Step 4：各OS验证安装包并保存产物/日志；没有正式签名证书时标记开发包，暂停正式签名发布并询问用户。
- [ ] Step 5：同步兼容矩阵和用户说明并提交。

## T21：安装、升级、备份恢复与观测

**依赖：** T12/T16/T18/T20

**Files（拟创建/修改）：**

- `deploy/compose.yaml`
- `deploy/Dockerfile`
- `deploy/install.sh`
- `deploy/start.sh`
- `docs/operations/install.md`
- `docs/operations/upgrade.md`
- `docs/operations/backup-restore.md`
- `tests/acceptance/test_operations.py`

**Interfaces：** veriq_server init/migrate/serve/doctor；配置CLI>VERIQ_env>文件>默认；liveness/readiness分离。

- [ ] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert restored.resource_hashes == before_backup.resource_hashes
assert upgrade_preserves_external_config is True
assert incompatible_rollback_is_rejected is True
```

- [ ] **Step 2：运行测试确认未实现时失败。** `uv run --project apps/srv pytest tests/acceptance/test_operations.py -q`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **Step 3：实现上述接口与文件。** 单迁移job、主密钥备份、File/S3、保留期、容量/租约/清理指标、离线设备恢复、公开快速开始可照做；Compose可选Runtime profile与Linux服务安装，云端受管理设备真实执行并进入门禁。
- [ ] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t20 安装、升级、备份恢复与观测`。有新决策先更新ADR，不扩展到下一任务。

## T22：全模块用户体验、示例与接入文档

**依赖：** T11/T12/T13/T15/T16/T19/T21

**Files（拟创建/修改）：**

- `fixtures/demo-app/`
- `docs/user-guide.md`
- `docs/integration/frontend.md`
- `docs/integration/backend.md`
- `docs/admin-guide.md`
- `tests/e2e/full-product.spec.ts`

**Interfaces：** 示例Workspace具备目录、用例、数据、fixture、角色和执行计划，URL按Runtime网络可达配置。

- [ ] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```ts
await expect(page.getByTestId('workspace.demo')).toBeVisible();
await expect(page.getByTestId('run.outcome')).toHaveText('PASSED');
```

- [ ] **Step 2：运行测试确认未实现时失败。** `pnpm e2e -- tests/e2e/full-product.spec.ts`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **Step 3：实现上述接口与文件。** F01-F14全部菜单和操作有真实API、空态/错误/加载/权限，中文/英文，文档可重现，非假数据演示。
- [ ] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t21 全模块用户体验、示例与接入文档`。有新决策先更新ADR，不扩展到下一任务。

## T23：完整产品验收与1.0发布门禁

**依赖：** T01-T22

**Files（拟创建/修改）：**

- `tests/acceptance/`
- `docs/acceptance/requirements-matrix.md`
- `docs/acceptance/release-report.md`
- `docs/known-limitations.md`

**Interfaces：** release_gate(report: AcceptanceReport) -> ReleaseDecision；全部需求、产物、兼容和故障证据齐全才通过。

- [ ] **Step 1：编写失败测试。** 落实以下关键断言与规格中的该模块验收。

```python
assert all(requirement.accepted for requirement in report.f01_to_f14)
assert report.official_release_has_no_skipped_tests
assert report.contains_real_windows_and_linux_evidence
```

- [ ] **Step 2：运行测试确认未实现时失败。** `pnpm acceptance`；失败必须来自缺失行为，而非测试环境拼写错误。
- [ ] **Step 3：实现上述接口与文件。** 10Run并发、未知进程隔离、离线、篡改、权限、模型关闭、真实业务5～10条×至少5轮、wheel/安装/升级/恢复、许可与签名。
- [ ] **Step 4：运行相同命令并检查实际结果。** 全部目标测试通过，再运行受影响的契约/集成检查；保存命令与输出，未运行明确标记。
- [ ] **Step 5：自查规格覆盖并提交。** 同步Schema/OpenAPI/客户端/文档，提交消息建议 `feat: complete t22 完整产品验收与1.0发布门禁`。有新决策先更新ADR，不扩展到下一任务。

## 最终验收与交接

最终交付必须包含服务端发布包与镜像、两个OS的Runtime包、源码/锁文件、迁移、公共契约、示例工程、用户/管理员/接入/运维手册、SBOM/NOTICE、真实验收结果及已知限制。全部F01-F14通过后才标记1.0完成；内部任务完成不能代替完整产品验收。

进入编码前由用户审阅规格与选型。本文不授权代用户选择商业许可证、付费服务、发布生产环境或发送通知。审阅确认后按任务执行，不重复询问已确认的范围与技术要求。

