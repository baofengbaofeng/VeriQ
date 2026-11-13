# 外部调度与 CI / External scheduling and CI

VeriQ 不解释 Cron，也不运行计划扫描器。管理员在 **执行计划 / Plans** 中选择已发布 SUITE、环境、角色、浏览器、设备、变量、重试和重叠策略；编辑带 revision，归档保留历史。手动触发与外部 HTTP 使用同一冻结与准入路径。

VeriQ has no internal Cron. Create a plan in **Plans**, selecting published Suite/Environment versions, roles, browsers, Runtimes, initial variables, retry count and overlap policy. Updates require the current revision; archive preserves history. Manual and external triggers share admission and immutable execution snapshots.

## 独立服务身份 / Independent service identity

空间 Owner/Admin 在计划页创建服务账号。执行令牌 `purpose=EXECUTION` 有效 24 小时，必须列出 `planIds` 和操作 `trigger`、`read`、`cancel`（按需授予）。`trigger` 允许计划执行与其运行期间的设备授权检查；`read` 允许该计划运行状态、安全 CI 摘要和 JUnit；`cancel` 允许取消。它不能管理计划、列出空间全部运行、读取原始报告事件或下载原始 JUnit/HTML/Trace。账号禁用、令牌吊销/过期、空间/计划归档立即阻止后续授权。创建员工是审计归因，离职或注销不会自动使独立服务账号失效。

Workspace Owners/Admins issue EXECUTION tokens with explicit plan and operation scopes. Tokens expire after 24 hours and can be revoked immediately. `created_by` is attribution, not employee impersonation. Token values are shown once; token lists contain metadata only. Store the value in your CI secret manager, never in repository files, command arguments or browser local storage. Rotate before expiry. In-flight execution continues to require its original token's live authority; revoking it stops further execution authorization, so rotate between runs.

设备必须由该服务账号拥有，或由设备所有者明确共享到空间。管理员不能借服务账号向员工私人 PC 派发。设备登记使用另一个 `RUNTIME_ENROLLMENT` 用途令牌（10 分钟、一次性），与执行/维护令牌不可互换。在 **Runtimes** 查看、登记审批、共享、信任和凭证投递权限；凭证投递仍需显式许可，受信设备与当前 lease/fencing。

A service can dispatch only to its own Runtime or one explicitly shared with the Workspace by its owner. Enrollment uses a separate single-use, ten-minute token. Runtime trust and credential delivery remain independent permissions. Registration, owner sharing and credential delivery controls are available in **Runtimes**. Execution, enrollment and maintenance tokens are not interchangeable.

## 触发协议 / Trigger protocol

以下仅使用占位符，实际密钥由 CI 秘密变量注入。

```sh
curl --fail-with-body --request POST \
  --header "Authorization: Bearer ${VERIQ_CI_TOKEN}" \
  --header 'Content-Type: application/json' \
  --header "Idempotency-Key: ${CI_PIPELINE_ID}-smoke" \
  --data '{"buildSha":"<build-sha>","reason":"External scheduled smoke"}' \
  'https://<veriq-host>/api/v1/workspaces/<workspace-id>/execution-plans/<plan-id>/trigger'
```

首次准入 `202`，数据为 `{decision: "ENQUEUED", runId, statusUrl}`。同一键、同一主体及输入重试 `200/REUSED`，始终指向原运行，即使计划已编辑；改变输入或主体为 `409`。新一次调度必须使用新键。输入仅接受有界 `buildSha`/`reason`，不允许覆盖环境、凭证或代码。当前权限每次重查。

The first admitted trigger returns 202. Retries must preserve the same key and exact payload; changed payload/principal returns 409. A successful replay refers to the original immutable Run even after a plan update. Use a new key for a new invocation. Status polling uses the returned same-origin `/api/v1/workspaces/{ws}/runs/{run}` path with a read-scoped token.

- `QUEUE`：同计划按稳定序号串行，前驱逻辑结束且物理占用已安全释放后，后继 Job 才能领取；修改策略不消除旧前驱。所有计划共享现有容量：最多 10 个未完成 Run，全局 4 / 空间 2 浏览器上下文，超限 `429`。单运行最多 1000 个展开变体。
- `SKIP`：重叠时 `200/SKIPPED`，创建 `FINISHED/SKIPPED`、`OVERLAP_SKIPPED` 的运行，不创建 Job；跳过不通过门禁。
- `REJECT`：重叠返回 `409/PLAN_OVERLAP`。

QUEUE serializes a plan's Runs, including unresolved physical process occupancy. SKIP records a terminal skipped Run without jobs. REJECT returns a conflict. Unknown processes remain quarantined; elapsed time alone never frees their capacity. Existing global/Workspace capacity and admission limits still apply.

## 可直接运行的 CI / Runnable CI command

需要 Python 3.12+，没有附加 Python 包。仓库提供 `scripts/veriq_ci.py`；CI 平台将 `VERIQ_CI_TOKEN` 注入为秘密环境变量。

```sh
python scripts/veriq_ci.py \
  --server 'https://<veriq-host>' \
  --workspace '<workspace-uuid>' --plan '<plan-uuid>' \
  --key "${CI_PIPELINE_ID}-smoke" --build-sha "${CI_COMMIT_SHA}" \
  --timeout 1800 --junit artifacts/veriq-junit.xml
```

退出 `0` 仅限最终 PASSED、执行时及当前门禁都通过且存在真实用例。FAILED/ERROR/UNSTABLE/CANCELLED/INCOMPLETE/SKIPPED 退出 `1`；超时、认证丢失、协议/网络错误或用户中断退出 `2`。`--timeout` 是触发重试、轮询、安全报告与 JUnit 下载共同使用的绝对总预算，持续零碎响应不会延长它。超时/中断另给最多 10 秒尽力请求取消，取消确认不等于未知物理进程已经停止；触发响应超时且尚无 runId 时，是否已接受仍未知，后续人工重试须保留同一幂等键。授权失效立即失败；首次触发网络重试至多三次并复用原键，不因 HTTP 200/202 而宣称通过。

The command triggers, polls, retrieves the safe report and writes JUnit. Only PASSED plus both authoritative gates and real cases exits zero. Result failures exit 1; timeout, interruption, authorization loss and transport/protocol errors exit 2. One absolute timeout covers trigger retries, polling and both report downloads, including slow trickled responses. Timeout/interruption uses a separate cancellation allowance of at most 10 seconds when a Run is known. A timed-out trigger may have been accepted; preserve its idempotency key and do not assume physical execution stopped. A redirect is rejected to protect the token. HTTPS is required except for explicit loopback development.

`GET .../ci-report` 返回运行、用例标识/状态、统计和 `gatePassed`。`GET .../junit` 只允许终态，使用标准 XML 库输出安全 JUnit；每个真实用例一个 testcase，整体门禁失败另有明确 gate testcase。它不包含原始断言值、请求头、日志、设备本地库或业务标题。原始 Playwright JUnit 仍是独立的管理员受限证据，不能用执行令牌下载。离线导入不能变成正式线上计划运行。

Safe JUnit is a thin projection of authoritative report facts, with no raw assertion values, headers, logs, vault contents or business labels. The original Playwright JUnit remains restricted raw evidence. Imported offline results cannot be transformed into online plan jobs or a verified online gate.

GitHub Actions 示例（替换全部占位符；仓库和 CI 权限由部署者管理）：

```yaml
name: VeriQ scheduled smoke
on:
    workflow_dispatch: {}
    schedule:
        - cron: '*/15 * * * *'
permissions:
    contents: read
jobs:
    smoke:
        runs-on: ubuntu-24.04
        timeout-minutes: 35
        steps:
            - uses: actions/checkout@<approved-checkout-commit>
            - name: VeriQ gate
              env:
                  VERIQ_CI_TOKEN: ${{ secrets.VERIQ_CI_TOKEN }}
              run: >-
                  python scripts/veriq_ci.py --server https://<veriq-host>
                  --workspace <workspace-uuid> --plan <plan-uuid>
                  --key "${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
                  --build-sha "$GITHUB_SHA" --junit artifacts/veriq-junit.xml
```

## 有界维护 / Bounded maintenance

另签发 `purpose=MAINTENANCE`、24 小时令牌，明确允许以下全部或部分操作：

| 路径后缀 / Suffix | 职责 / Purpose |
| --- | --- |
| `expired-leases/reap` | 过期租约和运行预算 / expired lease and Run budget handling |
| `fixture-cleanups/reconcile` | 有能力 Runtime 执行清理补偿 / enqueue authorized Runtime cleanup |
| `capacity/reconcile` | 有停止证据的容量核对 / reconcile safely released capacity |
| `artifacts/expire` | 到期原始证据与物理删除围栏 / retention and fenced deletion |

```sh
curl --fail-with-body --request POST \
  --header "Authorization: Bearer ${VERIQ_MAINTENANCE_TOKEN}" \
  --header "Idempotency-Key: ${EXTERNAL_TICK_ID}-artifacts-page-0" \
  --header 'Content-Type: application/json' \
  --data '{"workspaceId":"<workspace-uuid>","limit":100}' \
  'https://<veriq-host>/internal/v1/maintenance/artifacts/expire'
```

调度器按 `hasMore` 继续，把服务端 `nextCursor` 原样作为下一次正文 `cursor`，每页使用独立派生键，例如 `<tick-id>-<operation>-page-<n>`。重试某一页必须保留同一个键、操作、limit、cursor；同键变更为冲突。不要把 cursor 当 UUID 或排序值：原始制品维护可能返回 `offline:<id>` 阶段游标，必须作为不透明字符串处理。账号/权限重查在回执重放之前。外部调度器应监控连续失败、hasMore 积压、队列等待和 Runtime 离线，并按部署容量设置调用频率。

Use the returned opaque cursor unchanged while `hasMore` is true; derive a new idempotency key for each page and retain it for retries of that exact page. Cursor phases may include `offline:<id>`. Never reset or reinterpret it as a UUID. Maintenance preserves leases, quarantine and storage retirement fences; it does not bypass unknown physical process state. Monitor repeated failures and backlog in the external scheduler. No maintenance timer is started inside VeriQ.
