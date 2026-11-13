"""通过实际 HTTP、已发布套件与隔离数据库验证计划触发的幂等和重叠协议，发布助手仅负责构造可信资产，运行结果仍由执行层负责而不在此伪造成功状态。"""

from uuid import uuid4

from test_auth import setup, login
from test_workspace import workspace
from test_lease_mysql import device
from test_runs_mysql import published, environment


async def plan_fixture(site, policy="QUEUE"):
    """构造有身份环境、真实发布版本与已登记设备的最小计划请求，使缺失路由或行为直接表现为断言失败，并避免使用虚构资源编号触发无关的引用校验错误。"""
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    runtime = await device(c, ws)
    env = await environment(c, db, ws)
    catalog = await published(
        c,
        db,
        ws,
        "catalog",
        "ELEMENT_CATALOG",
        {
            "schemaVersion": "1.0",
            "elements": [{"key": "name", "locator": {"by": "testId", "value": "name"}}],
        },
    )
    case = await published(
        c,
        db,
        ws,
        "case",
        "CASE",
        {
            "schemaVersion": "1.0",
            "caseKey": "case",
            "title": "Trigger case",
            "kind": "READ",
            "roleKey": "reader",
            "catalogVersionId": catalog,
            "steps": [{"id": "open", "action": "goto", "path": "/"}],
        },
    )
    suite = await published(
        c,
        db,
        ws,
        "suite",
        "SUITE",
        {
            "schemaVersion": "1.0",
            "cases": [{"versionId": case}],
        },
    )
    response = await c.post(
        f"/api/v1/workspaces/{ws}/execution-plans",
        json={
            "name": "Scheduled smoke",
            "suiteVersionId": suite,
            "environmentVersionId": env,
            "roleKeys": ["reader"],
            "browsers": ["chromium"],
            "runtimeIds": [runtime["runnerId"]],
            "overlapPolicy": policy,
            "maxCaseRetries": 0,
            "variables": {},
        },
    )
    assert response.status_code == 201, response.text
    return c, db, ws, runtime, response.json()["data"]


async def test_trigger_reuses_key_and_conflicts_on_changed_input(site):
    """外部重试必须复用原运行而不能重复入队，同时相同幂等键携带不同构建信息必须返回冲突；该测试同时要求首次触发返回可轮询的状态地址与明确准入决策。"""
    c, _, ws, _, plan = await plan_fixture(site)
    path = f"/api/v1/workspaces/{ws}/execution-plans/{plan['id']}/trigger"
    headers = {"Idempotency-Key": str(uuid4())}
    first = await c.post(path, json={"buildSha": "build-a"}, headers=headers)
    assert first.status_code == 202, first.text
    assert first.json()["data"]["decision"] == "ENQUEUED"
    repeated = await c.post(path, json={"buildSha": "build-a"}, headers=headers)
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["data"]["runId"] == first.json()["data"]["runId"]
    assert repeated.json()["data"]["decision"] == "REUSED"
    conflict = await c.post(path, json={"buildSha": "build-b"}, headers=headers)
    assert conflict.status_code == 409, conflict.text


async def test_maintenance_requires_independent_authentication(site):
    """维护入口即使收到已登录浏览器的 Cookie 也必须要求独立服务令牌，避免将普通用户会话误作后台维护权限，并验证未认证调用不会进入批次处理或生成可重放回执。"""
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    response = await c.post(
        "/internal/v1/maintenance/expired-leases/reap",
        json={
            "workspaceId": ws,
            "limit": 1,
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 401, response.text


async def service_token(c, ws, plan, operations=None):
    """服务测试通过实际管理接口签发一次性显示的执行令牌，并明确限定计划和操作；测试返回账号标识用于验证当前禁用与吊销，不把管理员 Cookie 当成自动化请求已经通过认证的证据。"""
    account = await c.post(f"/api/v1/workspaces/{ws}/service-accounts", json={"name": "CI account"})
    assert account.status_code == 201, account.text
    account_id = account.json()["data"]["id"]
    path = f"/api/v1/workspaces/{ws}/service-accounts/{account_id}/tokens"
    response = await c.post(
        path,
        json={
            "purpose": "EXECUTION",
            "operations": operations or ["trigger", "read", "cancel"],
            "planIds": [plan["id"]],
        },
    )
    assert response.status_code == 201, response.text
    return account_id, response.json()["data"]


async def test_three_parallel_triggers_serialize_claims_and_freeze_revision(site):
    """三个并发触发应产生三个稳定序号且只有最早运行可领取，修改计划后原始键重试仍指向旧快照；首运行未释放物理占用时即使逻辑取消，也不得让后继任务穿过重叠保护。"""
    import asyncio
    from sqlalchemy import select
    from veriq_server.db import Run, Job
    from test_lease_mysql import claim_body, auth

    c, db, ws, runtime, plan = await plan_fixture(site)
    path = f"/api/v1/workspaces/{ws}/execution-plans/{plan['id']}"
    keys = [str(uuid4()) for _ in range(3)]
    results = await asyncio.gather(
        *(c.post(path + "/trigger", json={}, headers={"Idempotency-Key": k}) for k in keys)
    )
    assert all(r.status_code == 202 for r in results), [r.text for r in results]
    async with db.sessions() as session:
        runs = list(
            (
                await session.scalars(
                    select(Run).where(Run.plan_id == plan["id"]).order_by(Run.plan_sequence)
                )
            ).all()
        )
        assert [r.plan_sequence for r in runs] == [1, 2, 3]
        first_id = runs[0].id
        hashes = {r.id: r.snapshot_hash for r in runs}
    first_claim = await c.post(
        "/internal/v1/jobs/claim", json=claim_body(runtime), headers=auth(runtime)
    )
    assert first_claim.status_code == 200, first_claim.text
    claim = first_claim.json()["data"]
    async with db.sessions() as session:
        assert (await session.get(Job, claim["jobId"])).run_id == first_id
    next_claim = await c.post(
        "/internal/v1/jobs/claim", json=claim_body(runtime), headers=auth(runtime)
    )
    assert next_claim.status_code == 204, next_claim.text
    changed = {k: v for k, v in plan.items() if k not in {"id", "workspaceId", "archived"}}
    changed["name"] = "Updated plan"
    changed["overlapPolicy"] = "REJECT"
    updated = await c.put(path, json=changed)
    assert updated.status_code == 200, updated.text
    replay = await c.post(path + "/trigger", json={}, headers={"Idempotency-Key": keys[0]})
    assert (
        replay.status_code == 200
        and replay.json()["data"]["runId"] == results[0].json()["data"]["runId"]
    )
    async with db.sessions() as session:
        for rid, value in hashes.items():
            assert (await session.get(Run, rid)).snapshot_hash == value
    stale = await c.put(path, json=changed)
    assert stale.status_code == 409, stale.text
    blocked = await c.post(path + "/trigger", json={}, headers={"Idempotency-Key": str(uuid4())})
    assert blocked.status_code == 409, blocked.text


async def test_skip_creates_terminal_run_without_jobs(site):
    """SKIP 的重叠触发必须留下独立终态记录且没有执行任务，避免调度方把 HTTP 成功误认为业务通过；相同键重放仍保留该跳过记录，安全 JUnit 与 CI 摘要必须继续呈现失败门禁。"""
    from sqlalchemy import select
    from veriq_server.db import Job

    c, db, ws, _, plan = await plan_fixture(site, "SKIP")
    path = f"/api/v1/workspaces/{ws}/execution-plans/{plan['id']}/trigger"
    assert (
        await c.post(path, json={}, headers={"Idempotency-Key": str(uuid4())})
    ).status_code == 202
    key = str(uuid4())
    skip = await c.post(path, json={}, headers={"Idempotency-Key": key})
    assert skip.status_code == 200, skip.text
    assert skip.json()["data"]["decision"] == "SKIPPED"
    run_id = skip.json()["data"]["runId"]
    status = await c.get(skip.json()["data"]["statusUrl"])
    assert status.json()["data"]["outcome"] == "SKIPPED"
    assert status.json()["data"]["reasonCode"] == "OVERLAP_SKIPPED"
    async with db.sessions() as session:
        assert not (await session.scalars(select(Job).where(Job.run_id == run_id))).all()
    xml = await c.get(f"/api/v1/workspaces/{ws}/runs/{run_id}/junit")
    assert xml.status_code == 200 and b"<failure" in xml.content


async def test_service_scope_private_runtime_revoke_and_no_cookie_fallback(site):
    """执行令牌只能触发列入范围的计划且不能借管理员 Cookie 派发私人设备，明确共享后可执行；令牌吊销立即阻断状态读取和任务领取，错误 Bearer 即使附带有效 Cookie 也不会回退成功。"""
    from test_lease_mysql import claim_body, auth

    c, _, ws, runtime, plan = await plan_fixture(site)
    account, token = await service_token(c, ws, plan)
    headers = {"Authorization": "Bearer " + token["token"], "Idempotency-Key": str(uuid4())}
    path = f"/api/v1/workspaces/{ws}/execution-plans/{plan['id']}/trigger"
    private = await c.post(path, json={}, headers=headers)
    assert private.status_code == 403, private.text
    assert (
        await c.put(
            f"/api/v1/workspaces/{ws}/runtimes/{runtime['runnerId']}/grants",
            json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
        )
    ).status_code == 200
    trigger = await c.post(path, json={}, headers=headers)
    assert trigger.status_code == 202, trigger.text
    run = trigger.json()["data"]
    assert (await c.get(run["statusUrl"], headers=headers)).status_code == 200
    assert (await c.get(run["statusUrl"] + "/report", headers=headers)).status_code == 401
    # 普通报告仍按当前 Cookie 读取；没有 Cookie 的自动化客户端不能借此读取原始报告内容，下面独立客户端验证该限制和非法令牌拒绝。
    import httpx

    async with httpx.AsyncClient(base_url=str(c.base_url)) as external:
        assert (
            await external.get(run["statusUrl"] + "/report", headers=headers)
        ).status_code == 401
        assert (
            await external.get(run["statusUrl"] + "/ci-report", headers=headers)
        ).status_code == 200
        assert (
            await external.get(f"/api/v1/workspaces/{ws}/runs", headers=headers)
        ).status_code == 403
    assert (
        await c.get(run["statusUrl"], headers={"Authorization": "Bearer invalid"})
    ).status_code == 401
    revoked = await c.post(
        f"/api/v1/workspaces/{ws}/service-accounts/{account}/tokens/{token['id']}/revoke", json={}
    )
    assert revoked.status_code == 200
    assert (await c.get(run["statusUrl"], headers=headers)).status_code == 401
    assert (
        await c.post("/internal/v1/jobs/claim", json=claim_body(runtime), headers=auth(runtime))
    ).status_code == 204


async def test_maintenance_four_operations_and_strict_purpose_scopes(site):
    """完整四项维护权限应能一次签发，但重复、未知操作和跨用途混合都必须在契约校验时被拒绝；执行令牌独立要求计划范围，既有登记令牌不能通过额外字段获得触发或维护能力。"""
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    account = (
        await c.post(f"/api/v1/workspaces/{ws}/service-accounts", json={"name": "Maintenance"})
    ).json()["data"]["id"]
    path = f"/api/v1/workspaces/{ws}/service-accounts/{account}/tokens"
    operations = [
        "expired-leases/reap",
        "fixture-cleanups/reconcile",
        "capacity/reconcile",
        "artifacts/expire",
    ]
    issued = await c.post(path, json={"purpose": "MAINTENANCE", "operations": operations})
    assert issued.status_code == 201, issued.text
    for invalid in [operations + [operations[0]], ["unknown"], ["trigger"]]:
        assert (
            await c.post(path, json={"purpose": "MAINTENANCE", "operations": invalid})
        ).status_code == 400
    assert (
        await c.post(path, json={"purpose": "EXECUTION", "operations": ["read"]})
    ).status_code == 400
    assert (
        await c.post(path, json={"purpose": "RUNTIME_ENROLLMENT", "operations": ["trigger"]})
    ).status_code == 400
    listing = await c.get(path)
    assert listing.status_code == 200, listing.text
    assert "token" not in listing.json()["data"]["items"][0]


async def test_scope_removal_cancels_active_lease_and_blocks_reads(site):
    """所有者撤销设备共享必须同时阻止计划状态读取、后续领取和现有租约续期，心跳仅返回取消而不能延长已失去授权的执行；重新共享不能恢复已经吊销的令牌或把旧 lease 变成新执行许可。"""
    from test_lease_mysql import claim_body, auth

    c, _, ws, runtime, plan = await plan_fixture(site)
    _, token = await service_token(c, ws, plan)
    grants = f"/api/v1/workspaces/{ws}/runtimes/{runtime['runnerId']}/grants"
    assert (
        await c.put(grants, json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True})
    ).status_code == 200
    headers = {"Authorization": "Bearer " + token["token"], "Idempotency-Key": str(uuid4())}
    triggered = await c.post(
        f"/api/v1/workspaces/{ws}/execution-plans/{plan['id']}/trigger", json={}, headers=headers
    )
    assert triggered.status_code == 202, triggered.text
    claim = await c.post("/internal/v1/jobs/claim", json=claim_body(runtime), headers=auth(runtime))
    assert claim.status_code == 200, claim.text
    lease = claim.json()["data"]
    assert (
        await c.put(grants, json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": False})
    ).status_code == 200
    assert (await c.get(triggered.json()["data"]["statusUrl"], headers=headers)).status_code == 403
    heartbeat = await c.post(
        f"/internal/v1/attempts/{lease['attemptId']}/heartbeat",
        headers=auth(runtime),
        json={
            "leaseToken": lease["leaseToken"],
            "fencingToken": lease["fencingToken"],
            "progress": {"phase": "LEASED"},
        },
    )
    assert heartbeat.status_code == 200, heartbeat.text
    assert heartbeat.json()["data"]["cancelRequested"] is True
    activation = await c.post(
        f"/internal/v1/attempts/{lease['attemptId']}/activate",
        headers=auth(runtime),
        json={"leaseToken": lease["leaseToken"], "fencingToken": lease["fencingToken"]},
    )
    assert activation.status_code == 403, activation.text


async def test_ci_timeout_is_nonzero_and_requests_real_run_cancellation(site, tmp_path):
    """外部 CI 在真实 HTTP 运行始终排队时必须按总预算超时并非零退出，同时尝试取消它已经获得的运行；测试检查持久化终态而不依赖脚本日志宣称取消成功，确保没有消费者时不会伪造通过。"""
    import asyncio
    import os

    c, _, ws, runtime, plan = await plan_fixture(site)
    _, token = await service_token(c, ws, plan)
    assert (
        await c.put(
            f"/api/v1/workspaces/{ws}/runtimes/{runtime['runnerId']}/grants",
            json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
        )
    ).status_code == 200
    key = str(uuid4())
    process = await asyncio.create_subprocess_exec(
        "python",
        "scripts/veriq_ci.py",
        "--server",
        str(c.base_url).rstrip("/"),
        "--workspace",
        ws,
        "--plan",
        plan["id"],
        "--key",
        key,
        "--timeout",
        "1",
        "--poll-interval",
        "0.1",
        "--junit",
        str(tmp_path / "timeout.xml"),
        env={**os.environ, "VERIQ_CI_TOKEN": token["token"]},
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    assert process.returncode == 2, stderr.decode()
    assert not (tmp_path / "timeout.xml").exists()
    replay = await c.post(
        f"/api/v1/workspaces/{ws}/execution-plans/{plan['id']}/trigger",
        json={},
        headers={"Authorization": "Bearer " + token["token"], "Idempotency-Key": key},
    )
    assert replay.status_code == 200, replay.text
    status = await c.get(replay.json()["data"]["statusUrl"])
    assert status.json()["data"]["outcome"] == "CANCELLED"


async def test_parallel_admission_never_exceeds_ten_unfinished_runs(site):
    """九个排队运行之后同时提交三个新触发只能再接受一个，另外两个必须返回容量上限；安装锁使计数与入队原子化，同键重试仍能读取已接受回执而不消耗第十一个运行名额。"""
    import asyncio
    from sqlalchemy import select, func
    from veriq_server.db import Run

    c, db, ws, _, plan = await plan_fixture(site)
    path = f"/api/v1/workspaces/{ws}/execution-plans/{plan['id']}/trigger"
    for _ in range(9):
        assert (
            await c.post(path, json={}, headers={"Idempotency-Key": str(uuid4())})
        ).status_code == 202
    responses = await asyncio.gather(
        *(c.post(path, json={}, headers={"Idempotency-Key": str(uuid4())}) for _ in range(3))
    )
    assert sorted(r.status_code for r in responses) == [202, 429, 429], [r.text for r in responses]
    async with db.sessions() as session:
        assert (
            await session.scalar(
                select(func.count()).select_from(Run).where(Run.state != "FINISHED")
            )
            == 10
        )


async def test_terminal_prior_run_with_quarantined_process_blocks_another_runtime(site):
    """前驱租约过期成为逻辑终态后，另一台空闲设备仍不可领取同计划后继运行；只有管理员记录物理停止并安全释放占用后才继续，证明串行条件不只是 Run 状态或同设备容量碰巧不足。"""
    from datetime import timedelta
    from test_lease_mysql import claim_body, auth
    from veriq_server.db import Attempt
    from veriq_server.service import now

    c, db, ws, first, plan = await plan_fixture(site)
    second = await device(c, ws)
    body = {k: v for k, v in plan.items() if k not in {"id", "workspaceId", "archived"}}
    body["runtimeIds"] = [first["runnerId"], second["runnerId"]]
    path = f"/api/v1/workspaces/{ws}/execution-plans/{plan['id']}"
    assert (await c.put(path, json=body)).status_code == 200
    for _ in range(2):
        assert (
            await c.post(path + "/trigger", json={}, headers={"Idempotency-Key": str(uuid4())})
        ).status_code == 202
    claim = await c.post("/internal/v1/jobs/claim", json=claim_body(first), headers=auth(first))
    assert claim.status_code == 200, claim.text
    lease = claim.json()["data"]
    attempt_id = lease["attemptId"]
    activated = await c.post(
        f"/internal/v1/attempts/{attempt_id}/activate",
        json={"leaseToken": lease["leaseToken"], "fencingToken": lease["fencingToken"]},
        headers=auth(first),
    )
    assert activated.status_code == 200, activated.text
    async with db.sessions.begin() as session:
        attempt = await session.get(Attempt, attempt_id)
        attempt.lease_expires_at = now() - timedelta(seconds=1)
    account = (
        await c.post(f"/api/v1/workspaces/{ws}/service-accounts", json={"name": "Lease reaper"})
    ).json()["data"]["id"]
    token = (
        await c.post(
            f"/api/v1/workspaces/{ws}/service-accounts/{account}/tokens",
            json={"purpose": "MAINTENANCE", "operations": ["expired-leases/reap"]},
        )
    ).json()["data"]["token"]
    reaped = await c.post(
        "/internal/v1/maintenance/expired-leases/reap",
        json={"workspaceId": ws, "limit": 10},
        headers={"Authorization": "Bearer " + token, "Idempotency-Key": str(uuid4())},
    )
    assert reaped.status_code == 200, reaped.text
    idle = await c.post("/internal/v1/jobs/claim", json=claim_body(second), headers=auth(second))
    assert idle.status_code == 204, idle.text
    async with db.sessions() as session:
        assert (await session.get(Attempt, attempt_id)).capacity_state == "QUARANTINED"
    released = await c.post(
        f"/api/v1/workspaces/{ws}/attempts/{attempt_id}/reconcile",
        json={"reason": "Test confirms stopped process", "processStopped": True},
    )
    assert released.status_code == 200, released.text
    next_claim = await c.post(
        "/internal/v1/jobs/claim", json=claim_body(second), headers=auth(second)
    )
    assert next_claim.status_code == 200, next_claim.text


async def test_plan_nested_references_archival_and_cookie_csrf_fail_closed(site):
    """计划管理不能把环境版本当套件、使用不存在角色或越过设备作用域，归档需当前修订并阻止后续触发；普通浏览器写入仍要求 CSRF，而执行令牌范围不能因为知道另一个计划编号而扩大。"""
    c, _, ws, _, plan = await plan_fixture(site)
    path = f"/api/v1/workspaces/{ws}/execution-plans"
    body = {k: v for k, v in plan.items() if k not in {"id", "workspaceId", "archived", "revision"}}
    for change in [
        {"suiteVersionId": plan["environmentVersionId"]},
        {"environmentVersionId": plan["suiteVersionId"]},
        {"roleKeys": ["ungranted"]},
    ]:
        denied = await c.post(path, json={**body, **change})
        assert denied.status_code == 422, denied.text
    csrf = c.headers.pop("X-CSRF-Token")
    try:
        assert (await c.post(path, json=body)).status_code == 403
    finally:
        c.headers["X-CSRF-Token"] = csrf
    _, token = await service_token(c, ws, plan)
    unauthorized = await c.post(
        path + f"/{uuid4()}/trigger",
        json={},
        headers={"Authorization": "Bearer " + token["token"], "Idempotency-Key": str(uuid4())},
    )
    assert unauthorized.status_code == 403, unauthorized.text
    stale = await c.request(
        "DELETE", path + "/" + plan["id"], json={"revision": plan["revision"] + 1}
    )
    assert stale.status_code == 409, stale.text
    archived = await c.request(
        "DELETE", path + "/" + plan["id"], json={"revision": plan["revision"]}
    )
    assert archived.status_code == 200, archived.text
    assert (
        await c.post(
            path + "/" + plan["id"] + "/trigger", json={}, headers={"Idempotency-Key": str(uuid4())}
        )
    ).status_code == 409


async def test_plan_management_rejects_bearer_instead_of_falling_back_to_cookie(site):
    """即使请求同时携带有效管理员 Cookie 和 CSRF，计划管理也不能忽略显式 Bearer 后退回员工权限；执行令牌的管理请求必须失败关闭，调用方只有移除错误认证协议才能按普通浏览器会话编辑。"""
    c, _, ws, _, plan = await plan_fixture(site)
    response = await c.get(
        f"/api/v1/workspaces/{ws}/execution-plans/{plan['id']}",
        headers={"Authorization": "Bearer invalid"},
    )
    assert response.status_code == 401, response.text


async def test_token_management_rejects_explicit_bearer_with_valid_employee_cookie(site):
    """令牌列表和签发都只接受员工会话，即使同一请求有有效 Cookie 与 CSRF 也不能忽略显式无效或有效执行 Bearer；移除认证头后普通管理流程仍可成功，而缺少 CSRF 的签发继续失败关闭。"""
    c, _, ws, _, plan = await plan_fixture(site)
    account, token = await service_token(c, ws, plan)
    path = f"/api/v1/workspaces/{ws}/service-accounts/{account}/tokens"
    body = {"purpose": "EXECUTION", "operations": ["read"], "planIds": [plan["id"]]}
    statuses = []
    for bearer in ["invalid", token["token"]]:
        headers = {"Authorization": "Bearer " + bearer}
        statuses.append((await c.get(path, headers=headers)).status_code)
        statuses.append((await c.post(path, json=body, headers=headers)).status_code)
    assert statuses == [401, 401, 401, 401], statuses
    listed = await c.get(path)
    assert listed.status_code == 200, listed.text
    assert len(listed.json()["data"]["items"]) == 1
    assert (await c.post(path, json=body)).status_code == 201
    csrf = c.headers.pop("X-CSRF-Token")
    try:
        assert (await c.post(path, json=body)).status_code == 403
    finally:
        c.headers["X-CSRF-Token"] = csrf
