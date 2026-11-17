"""运维指标验收通过员工会话读取真实工作区聚合，以不等量合成数据给出八分组的独立字面预期和隔离反例。
所有模型费用均为数据库记录，不调用模型提供方。
"""

import asyncio
import datetime
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, cast

import httpx
import pytest
import sqlalchemy
from sqlalchemy.ext import asyncio as sa_asyncio

import test_lifecycle_http_mysql as lifecycle
import test_workspace
from veriq_server import db as models
from veriq_server import service
from veriq_server import validation
from veriq_server.handlers import operations

Site = tuple[httpx.AsyncClient, models.Database]


def route(workspace_id: str) -> str:
    """工作区始终来自路径而不是任意查询条件，所有授权与数据断言都通过同一个真实路由入口执行以避免替代测试。
    不直接调用生产聚合函数读取指标。
    """
    return f"/api/v1/workspaces/{workspace_id}/operations/metrics"


def metrics(
    response: httpx.Response, workspace_id: str, database_time: datetime.datetime | None = None
) -> dict[str, Any]:
    """先排除私有载荷和内部池标识再比较成功信封，随后校验契约、观测时间及所有数值为非负整数的共同约束。
    字面业务预期由各测试独立给出。
    """
    if any(
        value in response.text
        for value in (lifecycle.PRIVATE, "01/workspace/", "00/global/", "lease_token_hash")
    ):
        pytest.fail("Metrics exposed private fixture data", pytrace=False)
    body = lifecycle.checked(response, 200)
    result: dict[str, Any] = body["data"]
    validation.validate_api("OperationsMetricsDTO", result)
    assert set(result) == {
        "workspaceId",
        "observedAt",
        "queue",
        "cleanup",
        "capacity",
        "leases",
        "heartbeat",
        "events",
        "storage",
        "modelCost",
    }
    assert result["workspaceId"] == workspace_id
    observed = datetime.datetime.fromisoformat(result["observedAt"].replace("Z", "+00:00"))
    assert observed.utcoffset() == datetime.timedelta(0)
    assert abs((datetime.datetime.now(datetime.timezone.utc) - observed).total_seconds()) < 30
    if database_time is not None:
        assert (
            abs((observed - database_time.replace(tzinfo=datetime.timezone.utc)).total_seconds())
            < 30
        )
    groups = {key: value for key, value in result.items() if isinstance(value, dict)}
    assert len(groups) == 8
    assert all(
        isinstance(number, int) and not isinstance(number, bool) and number >= 0
        for group in groups.values()
        for number in group.values()
    )
    return groups


async def assert_nonmember_system_admin(client: httpx.AsyncClient, workspace_id: str) -> None:
    """独立系统管理员可以读取自己创建的工作区，却不能跨越已有工作区的成员边界，从而区分系统身份与当前空间角色。
    用户创建、登录与空间创建均通过真实接口完成。
    """
    created = await client.post(
        "/api/v1/admin/users",
        json={
            "email": "outsider@example.com",
            "displayName": "Outsider",
            "password": "Long password 123!",
            "systemAdmin": True,
        },
    )
    assert created.status_code == 201
    async with test_workspace.client(client, "outsider@example.com") as outsider:
        private = await lifecycle.create_workspace(outsider, "private")
        assert metrics(await outsider.get(route(private)), private)
        lifecycle.checked(await outsider.get(route(workspace_id)), 403, "WORKSPACE_FORBIDDEN")


# 既有员工会话在连续角色及成员变化后请求同一路由，因此需要保留原身份与当前治理变量验证即时撤权。
async def test_metrics_current_employee_roles_membership_and_workspace_isolation(
    site: Site,
) -> None:
    """指标要求当前员工会话和目标工作区管理角色，系统管理员并非隐式成员，已有会话在降权或停用后立即失去读取权限。
    同时覆盖另一工作区管理者与无会话的服务令牌。
    """
    client, database, workspace_id = await lifecycle.initialized(site)
    del database
    other = await lifecycle.create_workspace(client, "other")
    assert metrics(await client.get(route(workspace_id)), workspace_id)
    member_id: str = await cast(
        Callable[[httpx.AsyncClient, str, str, str], Awaitable[str]], test_workspace.new_member
    )(client, workspace_id, "member@example.com", "ADMIN")
    async with test_workspace.client(client, "member@example.com") as member:
        assert metrics(await member.get(route(workspace_id)), workspace_id)
        lifecycle.checked(await member.get(route(other)), 403, "WORKSPACE_FORBIDDEN")
        membership = f"/api/v1/workspaces/{workspace_id}/members/{member_id}"
        for role, status in (("VIEWER", "ACTIVE"), ("ADMIN", "DISABLED"), ("ADMIN", "ACTIVE")):
            assert (
                await client.put(membership, json={"role": role, "status": status})
            ).status_code == 200
            response = await member.get(route(workspace_id))
            if role == "ADMIN" and status == "ACTIVE":
                assert metrics(response, workspace_id)
            else:
                lifecycle.checked(response, 403, "WORKSPACE_FORBIDDEN")
        assert (await client.delete(membership)).status_code == 200
        lifecycle.checked(await member.get(route(workspace_id)), 403, "WORKSPACE_FORBIDDEN")
    await assert_nonmember_system_admin(client, workspace_id)
    token = (await lifecycle.maintenance_token(client, workspace_id))[1]
    async with httpx.AsyncClient(base_url=str(client.base_url)) as external:
        lifecycle.checked(await external.get(route(workspace_id)), 401, "AUTHENTICATION_REQUIRED")
        lifecycle.checked(
            await external.get(
                route(workspace_id), headers={"Authorization": "Bearer " + token["token"]}
            ),
            401,
            "AUTHENTICATION_REQUIRED",
        )


async def seed_costs(
    session: sa_asyncio.AsyncSession, workspace_id: str, actor: str, other: bool
) -> None:
    """费用夹具分别记录已结算、运行中预留及终态未知账单，终态的大额预留只作排除反例，避免把未知费用解释为零。
    加密配置字段均为不可用合成值，不生成外部请求。
    """
    provider_id = str(uuid.uuid4())
    session.add(
        models.AiProvider(
            id=provider_id,
            workspace_id=workspace_id,
            revision=1,
            config={"private": lifecycle.PRIVATE},
            enabled=False,
            key_id="synthetic-key",
            key_version=str(uuid.uuid4()),
            nonce=b"synthetic",
            ciphertext=b"synthetic",
        )
    )
    await session.flush()
    rows = [("SUCCEEDED", 19, 71), ("RUNNING", 5, 13), ("FAILED", None, 97)]
    if other:
        rows = [("RUNNING", 31, 37), ("CANCELLED", None, 101), ("SUCCEEDED", None, 103)]
    for status, cost, reserved in rows:
        session.add(
            models.AiGeneration(
                id=str(uuid.uuid4()),
                workspace_id=workspace_id,
                provider_id=provider_id,
                actor_id=actor,
                request_id=str(uuid.uuid4()),
                request_hash="f" * 64,
                created_at=service.now(),
                month="2026-11",
                status=status,
                purpose="DRAFT",
                reserved_micros=reserved,
                cost_micros=cost,
                data={"private": lifecycle.PRIVATE},
            )
        )


async def seed_execution_metrics(
    session: sa_asyncio.AsyncSession, workspace_id: str, other: str, actor: str
) -> tuple[models.Attempt, ...]:
    """执行指标样本包含两个未完成租约及到期终态，并给元数据墓碑和跨空间事件设置不同序号以区分筛选口径。
    清理任务另含排队与成功终态，保留队列和清理分组的差异。
    """
    first = await lifecycle.seed_attempt(
        session,
        workspace_id,
        actor,
        lifecycle.AttemptSpec(phase="RUNNING", owner_state="RUNNING", capacity="HELD", sequence=5),
    )
    second = await lifecycle.seed_attempt(
        session,
        workspace_id,
        actor,
        lifecycle.AttemptSpec(
            phase="LEASED",
            owner_state="QUEUED",
            capacity="QUARANTINED",
            sequence=2,
            expired=False,
        ),
        identity=(first.runtime_id, None),
    )
    finished = await lifecycle.seed_attempt(
        session, workspace_id, actor, lifecycle.AttemptSpec(sequence=99)
    )
    finished.facts = {"metadataExpiredAt": "2020-01-01T00:00:00Z", "private": lifecycle.PRIVATE}
    b_attempt = await lifecycle.seed_attempt(
        session, other, actor, lifecycle.AttemptSpec(sequence=0)
    )
    for attempt, sequence in (
        (first, 1),
        (first, 2),
        (second, 1),
        (finished, 1),
        (b_attempt, 1),
    ):
        lifecycle.seed_event(session, attempt, sequence)
    await lifecycle.seed_cleanup(session, finished, actor, ("QUEUED", None))
    await lifecycle.seed_cleanup(session, finished, actor, ("FINISHED", "PASSED"))
    return first, second, finished, b_attempt


async def seed_heartbeat_metrics(
    session: sa_asyncio.AsyncSession, attempts: tuple[models.Attempt, ...], actor: str
) -> None:
    """设备样本让两个尝试共用一台新鲜设备，同时加入旧心跳、空心跳、禁用绑定与未绑定设备以检查去重和范围。
    共享设备在另一工作区仍只按自己的有效绑定计数。
    """
    first, finished = attempts[0], attempts[2]
    workspace_id, other = first.workspace_id, attempts[3].workspace_id
    old = service.now() - datetime.timedelta(days=400)
    first_runtime = await session.get(models.Runtime, first.runtime_id)
    finished_runtime = await session.get(models.Runtime, finished.runtime_id)
    assert first_runtime is not None and finished_runtime is not None
    first_runtime.last_seen_at = service.now() + datetime.timedelta(days=1)
    finished_runtime.last_seen_at = old
    session.add(models.RuntimeBinding(runtime_id=first.runtime_id, workspace_id=other, active=True))
    inactive = models.Runtime(
        id=str(uuid.uuid4()),
        owner_user_id=actor,
        name="Inactive stale",
        location="CONNECTED_LOCAL",
        trust_status="TRUSTED",
        capabilities={},
        created_at=old,
    )
    unbound = models.Runtime(
        id=str(uuid.uuid4()),
        owner_user_id=actor,
        name="Unbound stale",
        location="CONNECTED_LOCAL",
        trust_status="TRUSTED",
        capabilities={},
        created_at=old,
    )
    session.add_all([inactive, unbound])
    await session.flush()
    session.add(
        models.RuntimeBinding(runtime_id=inactive.id, workspace_id=workspace_id, active=False)
    )


async def seed_capacity_metrics(
    session: sa_asyncio.AsyncSession, attempts: tuple[models.Attempt, ...]
) -> None:
    """容量池为当前空间设置非默认上限，并放入大额全局池与另一空间池以确认指标只使用目标路径和占用状态。
    三种资源租约状态各保留一行供字面预期核对。
    """
    first, second, finished, b_attempt = attempts
    workspace_id, other = first.workspace_id, b_attempt.workspace_id
    for kind, limit, used in (("browser", 5, 2), ("compile", 3, 1), ("cleanup", 4, 2)):
        session.add(
            models.CapacityPool(key=f"01/workspace/{workspace_id}/{kind}", limit=limit, used=used)
        )
    session.add(models.CapacityPool(key="00/global/browser", limit=99, used=89))
    session.add(models.CapacityPool(key=f"01/workspace/{other}/browser", limit=11, used=7))
    await session.flush()
    for attempt, state in ((first, "HELD"), (second, "QUARANTINED"), (finished, "RELEASED")):
        session.add(
            models.ResourceLease(
                attempt_id=attempt.id,
                workspace_id=workspace_id,
                pool_key=f"01/workspace/{workspace_id}/browser",
                state=state,
            )
        )


async def seed_storage_metrics(
    session: sa_asyncio.AsyncSession, first: models.Attempt, b_attempt: models.Attempt
) -> None:
    """存储样本区分有效与已到期制品、待删与已删回执、待发布与完成发布，以及未完成、完成和过期上传。
    两空间使用不等对象字节与回执数量，防止仅按存在性验收。
    """
    old = service.now() - datetime.timedelta(days=400)
    for ws, digest, size, expired in (
        (first.workspace_id, "1" * 64, 11, False),
        (first.workspace_id, "2" * 64, 1000, True),
        (b_attempt.workspace_id, "3" * 64, 23, False),
    ):
        session.add(
            models.Artifact(
                workspace_id=ws,
                sha256=digest,
                size_bytes=size,
                content=b"synthetic",
                media_type="application/octet-stream",
                expired_at=old if expired else None,
                deleted_at=old if expired else None,
            )
        )
    for ws, done in (
        (first.workspace_id, False),
        (first.workspace_id, True),
        (b_attempt.workspace_id, False),
        (b_attempt.workspace_id, False),
    ):
        session.add(
            models.ArtifactDeletion(
                id=str(uuid.uuid4()),
                workspace_id=ws,
                sha256="4" * 64,
                storage_backend="FILE",
                storage_incarnation=str(uuid.uuid4()),
                deleted_at=old if done else None,
            )
        )
    pending = lifecycle.seed_upload(session, first)
    complete = lifecycle.seed_upload(session, first, complete=True)
    lifecycle.seed_upload(session, first, expired_at=old)
    other_upload = lifecycle.seed_upload(session, b_attempt)
    lifecycle.seed_upload(session, b_attempt)
    await session.flush()
    for upload, state in (
        (pending, "PENDING"),
        (complete, "COMMITTED"),
        (complete, "RETIRED"),
        (other_upload, "PENDING"),
        (other_upload, "PENDING"),
    ):
        session.add(
            models.ArtifactPublication(
                id=str(uuid.uuid4()),
                workspace_id=upload.workspace_id,
                upload_id=upload.id,
                sha256=upload.sha256,
                storage_backend="FILE",
                state=state,
            )
        )


# 八组指标共用不等量数据和筛选反例，单个事务明确列出持久化关系以防独立初始化掩盖工作区串扰。
async def test_metrics_exact_eight_groups_and_unequal_workspace_counterexamples(site: Site) -> None:
    """两工作区使用不同队列、租约、事件、存储和账单数值，逐组比较字面预期并放入完成、到期、禁用绑定等筛选反例。
    预期不调用生产聚合函数，也不从返回结果复制业务数值。
    """
    client, database, workspace_id = await lifecycle.initialized(site)
    other = await lifecycle.create_workspace(client, "other")
    actor = (await client.get("/api/v1/account")).json()["data"]["id"]
    async with database.sessions.begin() as session:
        attempts = await seed_execution_metrics(session, workspace_id, other, actor)
        await seed_heartbeat_metrics(session, attempts, actor)
        await seed_capacity_metrics(session, attempts)
        await seed_storage_metrics(session, attempts[0], attempts[3])
        await seed_costs(session, workspace_id, actor, False)
        await seed_costs(session, other, actor, True)
        observed_at = (
            await session.execute(sqlalchemy.select(sqlalchemy.func.utc_timestamp(6)))
        ).scalar_one()
    expected = {
        "queue": {"RUNNING": 1, "QUEUED": 2, "FINISHED": 2},
        "cleanup": {"QUEUED": 1, "FINISHED": 1},
        "capacity": {
            "HELD": 1,
            "QUARANTINED": 1,
            "RELEASED": 1,
            "browserLimit": 5,
            "browserUsed": 2,
            "compileLimit": 3,
            "compileUsed": 1,
            "cleanupLimit": 4,
            "cleanupUsed": 2,
        },
        "leases": {"active": 2, "expired": 1},
        "heartbeat": {"devices": 2, "stale": 1},
        "events": {"persisted": 3, "accepted": 7, "backlog": 4},
        "storage": {
            "objects": 2,
            "bytes": 18,
            "pendingDeletions": 1,
            "pendingPublications": 1,
            "incompleteUploads": 1,
        },
        "modelCost": {"recordedMicros": 24, "reservedMicros": 13, "unknown": 1},
    }
    assert metrics(await client.get(route(workspace_id)), workspace_id, observed_at) == expected
    assert metrics(await client.get(route(other)), other, observed_at) == {
        "queue": {"FINISHED": 1},
        "cleanup": {},
        "capacity": {
            "browserLimit": 11,
            "browserUsed": 7,
            "compileLimit": 1,
            "compileUsed": 0,
            "cleanupLimit": 1,
            "cleanupUsed": 0,
        },
        "leases": {"active": 0, "expired": 0},
        "heartbeat": {"devices": 2, "stale": 1},
        "events": {"persisted": 1, "accepted": 0, "backlog": 0},
        "storage": {
            "objects": 2,
            "bytes": 30,
            "pendingDeletions": 2,
            "pendingPublications": 2,
            "incompleteUploads": 2,
        },
        "modelCost": {"recordedMicros": 31, "reservedMicros": 37, "unknown": 2},
    }


async def test_metrics_empty_workspace_defaults_and_zero_groups(site: Site) -> None:
    """空工作区没有容量池时使用既定浏览器与编译清理默认值，其余分组明确为零或空状态映射而非未知账单伪值。
    该独立样本也约束聚合不能读取安装全局数据。
    """
    client, database, workspace_id = await lifecycle.initialized(site)
    del database
    assert metrics(await client.get(route(workspace_id)), workspace_id) == {
        "queue": {},
        "cleanup": {},
        "capacity": {
            "browserLimit": 2,
            "browserUsed": 0,
            "compileLimit": 1,
            "compileUsed": 0,
            "cleanupLimit": 1,
            "cleanupUsed": 0,
        },
        "leases": {"active": 0, "expired": 0},
        "heartbeat": {"devices": 0, "stale": 0},
        "events": {"persisted": 0, "accepted": 0, "backlog": 0},
        "storage": {
            "objects": 0,
            "bytes": 0,
            "pendingDeletions": 0,
            "pendingPublications": 0,
            "incompleteUploads": 0,
        },
        "modelCost": {"recordedMicros": 0, "reservedMicros": 0, "unknown": 0},
    }


@pytest.mark.parametrize(
    "actual_deadline", [False, True], ids=["query-timeout", "real-ten-second-deadline"]
)
async def test_metrics_timeout_standard_503_and_actual_handler_deadline(
    site: Site, monkeypatch: pytest.MonkeyPatch, actual_deadline: bool
) -> None:
    """查询直接超时及受事件阻塞超过真实十秒预算均返回标准不可用错误，身份和工作区授权仍走真实数据库查询。
    不缩短生产预算，不用睡眠同步，也不返回部分或零值成功数据。
    """
    client, database, workspace_id = await lifecycle.initialized(site)
    del database
    entered, cancelled, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def unavailable(session: sa_asyncio.AsyncSession, target: str) -> dict[str, Any]:
        """只替换聚合查询这个依赖边界，进入前授权已经完成；实际定时例等待事件并记录取消以证明处理器确实中断等待。
        直接超时例单独覆盖标准异常映射。
        """
        assert session.is_active and target == workspace_id
        entered.set()
        if not actual_deadline:
            raise TimeoutError("Synthetic metrics dependency timeout")
        try:
            await release.wait()
        finally:
            cancelled.set()
        pytest.fail("Blocked metrics unexpectedly resumed")

    monkeypatch.setattr(operations, "workspace_metrics", unavailable)
    started = time.monotonic()
    request = asyncio.create_task(client.get(route(workspace_id), timeout=15))
    try:
        await asyncio.wait_for(entered.wait(), timeout=3)
        response = await asyncio.wait_for(request, timeout=14)
        elapsed = time.monotonic() - started
        body = lifecycle.checked(response, 503, "METRICS_UNAVAILABLE")
        assert body["message"] == "Metrics query timed out"
        assert set(body) == {"code", "message", "details", "requestId"}
        assert body["details"] == {}
        if actual_deadline:
            assert cancelled.is_set()
            assert 9 <= elapsed < 14
        else:
            assert elapsed < 3
    finally:
        release.set()
        if not request.done():
            request.cancel()
        await asyncio.gather(request, return_exceptions=True)
