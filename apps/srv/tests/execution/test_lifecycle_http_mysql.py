"""生命周期验收通过独立维护身份访问真实数据库，检查游标推进和当前撤权，同时保留物理停止与清理结果。
测试只写合成行，不启动执行器，也不把逻辑过期解释为设备停止。
"""

import datetime
import dataclasses
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, cast

import httpx
import pytest
import sqlalchemy
from sqlalchemy.ext import asyncio as sa_asyncio

import test_auth
import test_lease_mysql
import test_workspace
from veriq_server import db as models
from veriq_server import service
from veriq_server import validation

Site = tuple[httpx.AsyncClient, models.Database]
PATH = "/internal/v1/maintenance/lifecycle/expire"
PRIVATE = "synthetic-private-lifecycle-payload"

# 既有夹具助手缺少类型标注，此处只声明已核对的调用签名，运行仍使用原函数以保留真实身份治理和数据库守护。
create_workspace = cast(
    Callable[[httpx.AsyncClient, str], Awaitable[str]], test_workspace.workspace
)
create_device = cast(
    Callable[[httpx.AsyncClient, str], Awaitable[dict[str, Any]]], test_lease_mysql.device
)
setup_admin = cast(Callable[[httpx.AsyncClient], Awaitable[httpx.Response]], test_auth.setup)
login_admin = cast(Callable[[httpx.AsyncClient], Awaitable[httpx.Response]], test_auth.login)


def checked(response: httpx.Response, status: int, code: str | None = None) -> dict[str, Any]:
    """任何响应比较或模式校验之前先拒绝私有合成标记，防止断言差异把维护期间保留的原始载荷写入日志。
    错误信息固定，不把响应正文附加到失败输出。
    """
    authorization = response.request.headers.get("authorization", "")
    sensitive = [PRIVATE, "a" * 64, "b" * 64]
    if authorization.startswith("Bearer ") and len(authorization[7:]) >= 20:
        sensitive.append(authorization[7:])
    for cookie in response.request.headers.get("cookie", "").split(";"):
        value = cookie.partition("=")[2].strip()
        if len(value) >= 20:
            sensitive.append(value)
    if any(value in response.text for value in sensitive):
        pytest.fail("Response exposed private fixture data", pytrace=False)
    assert response.status_code == status
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["cache-control"] == "no-store"
    body: dict[str, Any] = response.json()
    assert body["requestId"] == response.headers["x-request-id"]
    assert body["requestId"]
    if code:
        assert body["code"] == code
        assert "data" not in body
        validation.validate_api("ErrorEnvelope", body)
    return body


async def initialized(site: Site) -> tuple[httpx.AsyncClient, models.Database, str]:
    """沿用已有守护夹具建立真实管理员及工作区，移除先行校验钩子以确保私有标记总在业务断言之前检查。
    数据库名称与表白名单仍完全由既有夹具守护。
    """
    client, database = site
    client.event_hooks["response"].clear()
    assert (await setup_admin(client)).status_code == 201
    assert (await login_admin(client)).status_code == 200
    workspace_id: str = await create_workspace(client, "alpha")
    return client, database, workspace_id


async def maintenance_token(
    client: httpx.AsyncClient,
    workspace_id: str,
    operations: list[str] | None = None,
    purpose: str = "MAINTENANCE",
) -> tuple[str, dict[str, Any]]:
    """身份治理必须经过真实员工管理接口，签发响应中的一次性令牌只供请求头使用，禁止附加到断言诊断中。
    参数允许构造其他用途或缺少精确操作的独立身份。
    """
    account = await client.post(
        f"/api/v1/workspaces/{workspace_id}/service-accounts", json={"name": "Lifecycle observer"}
    )
    assert account.status_code == 201
    account_id: str = account.json()["data"]["id"]
    payload: dict[str, Any] = {"purpose": purpose}
    if purpose == "MAINTENANCE":
        payload["operations"] = operations or ["lifecycle/expire", "capacity/reconcile"]
    issued = await client.post(
        f"/api/v1/workspaces/{workspace_id}/service-accounts/{account_id}/tokens", json=payload
    )
    assert issued.status_code == 201
    return account_id, issued.json()["data"]


# 请求助手逐项暴露幂等键和批量游标，保留关键字参数以便负例清晰区分同键变参而不隐藏请求字段。
# pylint: disable-next=too-many-arguments
async def expire(
    client: httpx.AsyncClient,
    workspace_id: str,
    token: dict[str, Any],
    *,
    key: str | None = None,
    limit: int = 1,
    cursor: str = "",
) -> httpx.Response:
    """每次推进默认使用新幂等键，而显式传键用于回执重放与冲突验收；调用始终指向公开登记的维护路由。
    空游标仍按实际在线阶段语义发送。
    """
    return await client.post(
        PATH,
        json={"workspaceId": workspace_id, "limit": limit, "cursor": cursor},
        headers={
            "Authorization": "Bearer " + token["token"],
            "Idempotency-Key": key or str(uuid.uuid4()),
        },
    )


@dataclasses.dataclass(frozen=True)
class AttemptSpec:
    """尝试夹具把可独立变化的保留与容量事实集中为显式记录，默认值对应已完成且可清理的合成验证任务。
    每个测试只覆盖需要偏离默认状态的字段，不影响真实服务配置。
    """

    phase: str = "FINISHED"
    capacity: str = "RELEASED"
    owner_state: str = "FINISHED"
    cleanup: str = "SUCCEEDED"
    sequence: int = 0
    expired: bool = True
    run_state: str | None = None


# 同一尝试的外键及保护条件需要共同构造，显式关键字用于精确区分每个筛选反例而不压入隐式配置。
async def seed_attempt(
    session: sa_asyncio.AsyncSession,
    workspace_id: str,
    actor: str,
    spec: AttemptSpec | None = None,
    identity: tuple[str | None, str | None] = (None, None),
) -> models.Attempt:
    """构造有合法外键的最小持久化尝试，时间远离到期边界，并留下围栏和完成回执用于清理前后逐项比较。
    identity 指定可复用设备与固定尝试标识，状态记录只描述业务筛选条件。
    此助手仅造数据，不替代维护处理器或指标聚合逻辑。
    """
    spec = spec or AttemptSpec()
    runtime_id, attempt_id = identity
    old = service.now() - datetime.timedelta(days=400)
    digest = service.digest(workspace_id)
    artifact = await session.get(models.Artifact, (workspace_id, digest))
    if artifact is None:
        session.add(
            models.Artifact(
                workspace_id=workspace_id,
                sha256=digest,
                content=PRIVATE.encode(),
                size_bytes=7,
                media_type="application/json",
                created_at=old,
            )
        )
        await session.flush()
    if runtime_id is None:
        runtime_id = str(uuid.uuid4())
        session.add(
            models.Runtime(
                id=runtime_id,
                owner_user_id=actor,
                name="Synthetic observer",
                location="CONNECTED_LOCAL",
                trust_status="TRUSTED",
                capabilities={"private": PRIVATE},
                created_at=old,
            )
        )
        await session.flush()
        session.add(
            models.RuntimeBinding(runtime_id=runtime_id, workspace_id=workspace_id, active=True)
        )
        await session.flush()
    run_id, execution_id = None, None
    if spec.run_state is not None:
        run_id, execution_id, candidate = (str(uuid.uuid4()) for _ in range(3))
        session.add(
            models.Run(
                id=run_id,
                workspace_id=workspace_id,
                created_by=actor,
                idempotency_key=run_id,
                request_hash=digest,
                trigger_kind="MANUAL",
                source="CONNECTED_LOCAL",
                state=spec.run_state,
                snapshot_hash=digest,
                created_at=old,
            )
        )
        await session.flush()
        session.add(
            models.CaseExecution(
                id=execution_id,
                workspace_id=workspace_id,
                run_id=run_id,
                case_version_id=candidate,
                candidate_version_id=candidate,
                source_snapshot_hash=digest,
                variant_key=digest,
                provenance={},
                state="FINISHED",
            )
        )
        await session.flush()
    job = models.Job(
        id=str(uuid.uuid4()),
        workspace_id=workspace_id,
        kind="TEST" if run_id else "VALIDATE",
        subject_id=execution_id or str(uuid.uuid4()),
        run_id=run_id,
        case_execution_id=execution_id,
        state=spec.owner_state,
        outcome="PASSED" if spec.owner_state == "FINISHED" else None,
        snapshot_hash=digest,
        manifest_hash=digest,
        required_capabilities={},
        created_by=actor,
        created_at=old,
        fence=17,
    )
    session.add(job)
    await session.flush()
    attempt = models.Attempt(
        id=attempt_id or str(uuid.uuid4()),
        workspace_id=workspace_id,
        job_id=job.id,
        runtime_id=runtime_id,
        attempt_no=1,
        snapshot_hash=digest,
        manifest_hash=digest,
        lease_token_hash="c" * 64,
        fencing_token=17,
        lease_expires_at=old if spec.expired else service.now() + datetime.timedelta(days=2),
        phase=spec.phase,
        outcome="PASSED" if spec.phase == "FINISHED" else None,
        capacity_state=spec.capacity,
        facts={
            "cleanup": spec.cleanup,
            "processStopped": True,
            "processStopScope": "NO_PROCESS_SPAWNED",
            "business": "PASSED",
            "private": PRIVATE,
        },
        finished_at=old if spec.phase == "FINISHED" else None,
        finish_hash="d" * 64,
        finish_receipt={"accepted": True, "fencingToken": 17},
        last_sequence=spec.sequence,
        created_at=old,
    )
    session.add(attempt)
    await session.flush()
    return attempt


def seed_event(session: sa_asyncio.AsyncSession, attempt: models.Attempt, sequence: int) -> None:
    """事件故意带有私有哨兵并按独立序号存储，使分页验收能区分原始事件删除、元数据墓碑与围栏事实保留。
    事件内容不进入任何成功指标的字面预期。
    """
    session.add(
        models.AttemptEvent(
            attempt_id=attempt.id,
            workspace_id=attempt.workspace_id,
            sequence=sequence,
            event_hash=service.digest(str(sequence)),
            document={"private": PRIVATE},
        )
    )


def seed_upload(
    session: sa_asyncio.AsyncSession, attempt: models.Attempt, **values: Any
) -> models.AttemptUpload:
    """上传保留合成字节与私有元数据用于验证过期后清空载荷，完成和既有过期状态可独立构造作为筛选反例。
    不创建实际外部对象，也不调用存储提供方。
    """
    upload = models.AttemptUpload(
        id=str(uuid.uuid4()),
        attempt_id=attempt.id,
        workspace_id=attempt.workspace_id,
        sha256="e" * 64,
        size_bytes=3,
        metadata_json={"private": PRIVATE},
        content=b"abc",
        **values,
    )
    session.add(upload)
    return upload


async def seed_cleanup(
    session: sa_asyncio.AsyncSession,
    attempt: models.Attempt,
    actor: str,
    state: tuple[str, str | None],
) -> None:
    """依赖清理任务绑定独立维护回执及原尝试，既可构造未完成状态也可构造终态失败，防止只检查存在性就放行。
    该助手在生命周期保护与指标状态分组夹具间复用合法外键关系。
    """
    receipt = models.MaintenanceReceipt(
        id=str(uuid.uuid4()),
        workspace_id=attempt.workspace_id,
        idempotency_key=str(uuid.uuid4()),
        request_hash="f" * 64,
        receipt={"status": "FINISHED"},
    )
    session.add(receipt)
    await session.flush()
    session.add(
        models.Job(
            id=str(uuid.uuid4()),
            workspace_id=attempt.workspace_id,
            kind="CLEANUP",
            subject_id=receipt.id,
            maintenance_id=receipt.id,
            origin_attempt_id=attempt.id,
            state=state[0],
            outcome=state[1],
            snapshot_hash=attempt.snapshot_hash,
            manifest_hash=attempt.manifest_hash,
            required_capabilities={},
            created_by=actor,
            created_at=service.now(),
        )
    )


async def scoped_execution_token(
    client: httpx.AsyncClient, database: models.Database, workspace_id: str, valid_account: str
) -> dict[str, Any]:
    """另用真实令牌管理接口签发只读执行身份，计划持久化仅供合法范围校验，不启动执行流程或修改维护权限。
    该身份作为错误用途反例而不会用于维护成功请求。
    """
    actor = (await client.get("/api/v1/account")).json()["data"]["id"]
    plan_id = str(uuid.uuid4())
    async with database.sessions.begin() as session:
        session.add(
            models.ExecutionPlan(
                id=plan_id,
                workspace_id=workspace_id,
                name="Synthetic scope",
                selection={},
                created_by=actor,
                created_at=service.now(),
            )
        )
    execution = await client.post(
        f"/api/v1/workspaces/{workspace_id}/service-accounts/{valid_account}/tokens",
        json={"purpose": "EXECUTION", "operations": ["read"], "planIds": [plan_id]},
    )
    assert execution.status_code == 201
    result: dict[str, Any] = execution.json()["data"]
    return result


async def assert_wrong_maintenance_scopes(
    client: httpx.AsyncClient, workspace_id: str, other: str
) -> None:
    """缺少目标操作、使用登记用途和绑定另一工作区的身份分别通过管理接口建立，随后逐项访问相同维护路由确认拒绝。
    每个账号独立，避免某个错误范围被其他令牌权限掩盖。
    """
    for ws, operations, purpose in (
        (other, None, "MAINTENANCE"),
        (workspace_id, ["capacity/reconcile"], "MAINTENANCE"),
        (workspace_id, None, "RUNTIME_ENROLLMENT"),
    ):
        account, wrong = await maintenance_token(client, ws, operations, purpose)
        del account
        checked(await expire(client, workspace_id, wrong), 403, "MAINTENANCE_FORBIDDEN")


# 各种身份在同一工作区与同一路由中对照，保留独立账号和令牌变量以便证明成功来源与拒绝边界。
async def test_lifecycle_independent_identity_and_exact_workspace_operation(site: Site) -> None:
    """管理员会话、登记用途和设备身份均不能代替维护身份，缺少精确操作与跨空间令牌也必须在任何清理前拒绝。
    成功请求随后使用无员工会话的独立客户端证明授权来源。
    """
    client, database, workspace_id = await initialized(site)
    other = await create_workspace(client, "other")
    valid_account, valid = await maintenance_token(client, workspace_id)
    execution = await scoped_execution_token(client, database, workspace_id, valid_account)
    checked(await expire(client, workspace_id, execution), 403, "MAINTENANCE_FORBIDDEN")
    payload = {"workspaceId": workspace_id, "limit": 1}
    headers = {"Idempotency-Key": str(uuid.uuid4())}
    checked(await client.post(PATH, json=payload, headers=headers), 401, "SERVICE_TOKEN_INVALID")
    for authorization in ("Basic invalid", "Bearer invalid"):
        expected = 401 if authorization.startswith("Basic") else 403
        checked(
            await client.post(
                PATH, json=payload, headers={**headers, "Authorization": authorization}
            ),
            expected,
            "SERVICE_TOKEN_INVALID" if expected == 401 else "MAINTENANCE_FORBIDDEN",
        )
    await assert_wrong_maintenance_scopes(client, workspace_id, other)
    runtime = await create_device(client, workspace_id)
    checked(
        await expire(client, workspace_id, {"token": runtime["deviceToken"]}),
        403,
        "MAINTENANCE_FORBIDDEN",
    )
    async with httpx.AsyncClient(base_url=str(client.base_url)) as external:
        result = checked(await expire(external, workspace_id, valid), 200)["data"]
        validation.validate_api("MaintenanceDTO", result)
        assert result == {
            "id": result["id"],
            "status": "FINISHED",
            "processedCount": 0,
            "hasMore": True,
            "nextCursor": "offline:",
        }


@pytest.mark.parametrize("change", ["revoke", "disable", "archive", "expire"])
async def test_lifecycle_current_revocation_precedes_receipt_replay(
    site: Site, change: str
) -> None:
    """相同键已经生成成功回执后仍重新检查当前令牌、账号和工作区状态，防止通过幂等重放绕过随后发生的撤权。
    除时间到期外，状态变化均经过真实治理接口。
    """
    client, database, workspace_id = await initialized(site)
    account, token = await maintenance_token(client, workspace_id)
    key = str(uuid.uuid4())
    first = checked(await expire(client, workspace_id, token, key=key), 200)["data"]
    assert checked(await expire(client, workspace_id, token, key=key), 200)["data"] == first
    path = f"/api/v1/workspaces/{workspace_id}/service-accounts/{account}"
    if change == "revoke":
        assert (
            await client.post(path + f"/tokens/{token['id']}/revoke", json={})
        ).status_code == 200
    elif change == "disable":
        assert (await client.post(path + "/disable", json={})).status_code == 200
    elif change == "archive":
        assert (await client.delete(f"/api/v1/workspaces/{workspace_id}")).status_code == 200
    else:
        async with database.sessions.begin() as session:
            row = await session.get(models.ServiceToken, token["id"])
            assert row is not None
            row.expires_at = service.now() - datetime.timedelta(days=1)
    checked(await expire(client, workspace_id, token, key=key), 403, "MAINTENANCE_FORBIDDEN")
    checked(await expire(client, workspace_id, token), 403, "MAINTENANCE_FORBIDDEN")


async def test_lifecycle_validation_and_idempotent_payload_conflicts(site: Site) -> None:
    """实际维护处理器要求工作区、有限批量、合法阶段游标与有限幂等键，同键改变操作或任一请求参数都不能重用旧回执。
    负例之后再次重放原始请求确认回执没有被覆盖。
    """
    client, database, workspace_id = await initialized(site)
    account, token = await maintenance_token(client, workspace_id)
    del account, database
    headers = {"Authorization": "Bearer " + token["token"], "Idempotency-Key": str(uuid.uuid4())}
    for payload, code in (
        ({"limit": 1}, "WORKSPACE_REQUIRED"),
        ({"workspaceId": workspace_id, "limit": 0}, "INVALID_REQUEST"),
        ({"workspaceId": workspace_id, "limit": 10001}, "INVALID_REQUEST"),
        ({"workspaceId": workspace_id, "limit": True}, "INVALID_REQUEST"),
        ({"workspaceId": workspace_id, "limit": 1, "cursor": "online"}, "INVALID_CURSOR"),
        ({"workspaceId": workspace_id, "limit": 1, "cursor": "unknown:"}, "INVALID_CURSOR"),
        ({"workspaceId": workspace_id, "limit": 1, "cursor": "x" * 241}, "INVALID_REQUEST"),
    ):
        checked(await client.post(PATH, json=payload, headers=headers), 400, code)
    for key in ("", "k" * 161):
        checked(
            await client.post(
                PATH,
                json={"workspaceId": workspace_id, "limit": 1},
                headers={**headers, "Idempotency-Key": key},
            ),
            400,
            "IDEMPOTENCY_KEY_REQUIRED",
        )
    key = str(uuid.uuid4())
    first = checked(await expire(client, workspace_id, token, key=key), 200)["data"]
    checked(
        await expire(client, workspace_id, token, key=key, limit=2), 409, "IDEMPOTENCY_CONFLICT"
    )
    checked(
        await expire(client, workspace_id, token, key=key, cursor="offline:"),
        409,
        "IDEMPOTENCY_CONFLICT",
    )
    checked(
        await client.post(
            "/internal/v1/maintenance/capacity/reconcile",
            json={"workspaceId": workspace_id, "limit": 1, "cursor": ""},
            headers={**headers, "Idempotency-Key": key},
        ),
        409,
        "IDEMPOTENCY_CONFLICT",
    )
    assert checked(await expire(client, workspace_id, token, key=key), 200)["data"] == first


@dataclasses.dataclass(frozen=True)
class LifecycleGraph:
    """分页夹具只暴露用于核对持久化效果的稳定标识，在线子记录和另一空间数据保持独立以防无意扩大清理范围。
    身份凭据始终由真实管理接口另外签发。
    """

    attempt_id: str
    second_id: str
    other_attempt_id: str
    upload_ids: list[str]
    other_upload_id: str


async def seed_lifecycle_graph(
    database: models.Database, workspace_id: str, other: str, actor: str
) -> LifecycleGraph:
    """在线图包含两条有序终态记录，首条带两个事件与两个上传，另一工作区保留相同种类的原始载荷作隔离对照。
    标识排序固定，确保单项预算的每页效果具有独立预期。
    """
    async with database.sessions.begin() as session:
        attempt = await seed_attempt(
            session,
            workspace_id,
            actor,
            AttemptSpec(sequence=2),
            identity=(None, "00000000-0000-4000-8000-000000000001"),
        )
        second = await seed_attempt(
            session,
            workspace_id,
            actor,
            AttemptSpec(cleanup="NOT_REQUIRED"),
            identity=(None, "00000000-0000-4000-8000-000000000002"),
        )
        other_attempt = await seed_attempt(session, other, actor, AttemptSpec(sequence=1))
        for sequence in (1, 2):
            seed_event(session, attempt, sequence)
        seed_event(session, other_attempt, 1)
        uploads = [seed_upload(session, attempt) for _ in range(2)]
        other_upload = seed_upload(session, other_attempt)
    return LifecycleGraph(
        attempt.id, second.id, other_attempt.id, [row.id for row in uploads], other_upload.id
    )


async def online_snapshot(
    database: models.Database, graph: LifecycleGraph
) -> tuple[list[int], list[tuple[datetime.datetime | None, bytes]]]:
    """每页读取元数据墓碑、围栏完成事实及剩余子记录，返回可比较的载荷快照以证明相同回执重放没有额外副作用。
    完成标记先于所有子载荷删除，因此每页都检查保留事实。
    """
    async with database.sessions() as session:
        attempt = await session.get(models.Attempt, graph.attempt_id)
        assert attempt is not None
        assert attempt.facts["metadataExpiredAt"] and "private" not in attempt.facts
        assert attempt.fencing_token == 17 and attempt.finish_hash == "d" * 64
        assert attempt.finish_receipt == {"accepted": True, "fencingToken": 17}
        assert attempt.phase == "FINISHED" and attempt.capacity_state == "RELEASED"
        assert attempt.facts["processStopScope"] == "NO_PROCESS_SPAWNED"
        retained = list(
            (
                await session.scalars(
                    sqlalchemy.select(models.AttemptEvent.sequence)
                    .where(models.AttemptEvent.attempt_id == graph.attempt_id)
                    .order_by(models.AttemptEvent.sequence)
                )
            ).all()
        )
        uploads = []
        for item in graph.upload_ids:
            upload = await session.get(models.AttemptUpload, item)
            assert upload is not None
            uploads.append((upload.expired_at, upload.content))
        return retained, uploads


async def assert_lifecycle_graph_retired(database: models.Database, graph: LifecycleGraph) -> None:
    """最终核对两条目标记录已过期且上传载荷清空，另一空间的事实、事件和上传仍完整，避免只依赖处理数量作结论。
    保留时间到期不改变已存在的物理停止范围。
    """
    async with database.sessions() as session:
        second = await session.get(models.Attempt, graph.second_id)
        assert second is not None and second.facts["metadataExpiredAt"]
        for item in graph.upload_ids:
            upload = await session.get(models.AttemptUpload, item)
            assert upload is not None and upload.expired_at is not None and upload.content == b""
        untouched = await session.get(models.Attempt, graph.other_attempt_id)
        assert untouched is not None and untouched.facts["private"] == PRIVATE
        events = (
            await session.scalars(
                sqlalchemy.select(models.AttemptEvent).where(
                    models.AttemptEvent.attempt_id == graph.other_attempt_id
                )
            )
        ).all()
        assert len(events) == 1
        upload = await session.get(models.AttemptUpload, graph.other_upload_id)
        assert upload is not None and upload.expired_at is None and upload.content == b"abc"


# 分页前后数据库事实与回执必须在同一连续场景中比较，拆分测试会丢失原键重放及跨页推进的因果关系。
async def test_lifecycle_one_item_effects_replay_and_bounded_phase_termination(site: Site) -> None:
    """单项预算分多次清除事件与未完成上传，每次重放保持同回执且不重复副作用，后续新键沿游标进入最终阶段。
    元数据先作墓碑，完成结果与围栏保留，另一个工作区载荷不变。
    """
    client, database, workspace_id = await initialized(site)
    other = await create_workspace(client, "other")
    token = (await maintenance_token(client, workspace_id))[1]
    actor = (await client.get("/api/v1/account")).json()["data"]["id"]
    graph = await seed_lifecycle_graph(database, workspace_id, other, actor)
    cursor, cursors = "", []
    for page in range(14):
        key = str(uuid.uuid4())
        result = checked(await expire(client, workspace_id, token, key=key, cursor=cursor), 200)[
            "data"
        ]
        validation.validate_api("MaintenanceDTO", result)
        before_replay = await online_snapshot(database, graph)
        if page < 2:
            assert before_replay[0] == ([2] if page == 0 else [])
            assert result["processedCount"] == 1
        if page <= 3:
            assert sum(item[0] is not None for item in before_replay[1]) == max(0, page - 1)
        assert (
            checked(await expire(client, workspace_id, token, key=key, cursor=cursor), 200)["data"]
            == result
        )
        assert await online_snapshot(database, graph) == before_replay
        if not result["hasMore"]:
            assert "nextCursor" not in result
            break
        cursor = result["nextCursor"]
        cursors.append(cursor)
    else:
        pytest.fail("Lifecycle did not terminate within the fixture page bound")
    assert {value.partition(":")[0] for value in cursors} == {
        "online",
        "offline",
        "exports",
        "uploads",
        "imports",
        "model-cache",
        "provenance",
        "cache",
    }
    assert "online:" + graph.attempt_id in cursors
    await assert_lifecycle_graph_retired(database, graph)


async def seed_protected_graph(
    session: sa_asyncio.AsyncSession, workspace_id: str, actor: str
) -> tuple[list[str], str, str]:
    """保护图把占用未释放、所有者未完成、清理失败和依赖未完成分别持久化，并放入一条可过期记录作执行对照。
    所有记录共用一次维护页，以便检查逐项保护和实际推进。
    """
    protected = []
    for values in (
        {"capacity": "HELD"},
        {"capacity": "QUARANTINED"},
        {"owner_state": "RUNNING"},
        {"run_state": "RUNNING"},
        {"cleanup": "FAILED"},
    ):
        options: dict[str, Any] = dict(values)
        row = await seed_attempt(session, workspace_id, actor, AttemptSpec(**options))
        protected.append(row.id)
        seed_event(session, row, 1)
    leased = await seed_attempt(session, workspace_id, actor)
    seed_event(session, leased, 1)
    protected.append(leased.id)
    session.add(models.CapacityPool(key="synthetic-protected-pool", limit=2, used=1))
    await session.flush()
    session.add(
        models.ResourceLease(
            attempt_id=leased.id,
            workspace_id=workspace_id,
            pool_key="synthetic-protected-pool",
            state="HELD",
        )
    )
    pending = await seed_attempt(session, workspace_id, actor)
    protected.append(pending.id)
    seed_event(session, pending, 1)
    seed_cleanup_state = ("FINISHED", "FAILED")
    await seed_cleanup(session, pending, actor, seed_cleanup_state)
    unfinished = await seed_attempt(session, workspace_id, actor)
    protected.append(unfinished.id)
    seed_event(session, unfinished, 1)
    await seed_cleanup(session, unfinished, actor, ("QUEUED", None))
    eligible = await seed_attempt(session, workspace_id, actor)
    eligible_id = eligible.id
    return protected, eligible_id, leased.id


async def assert_protected_graph(
    database: models.Database, graph: tuple[list[str], str, str]
) -> None:
    """保护后的尝试必须保留私有事实与原始事件，同时可清理对照已作墓碑，资源租约及池占用保持原状。
    该检查不通过逻辑终态推导物理停止或释放成功。
    """
    async with database.sessions() as session:
        for item in graph[0]:
            row = await session.get(models.Attempt, item)
            assert row is not None and "metadataExpiredAt" not in row.facts
            assert row.facts["private"] == PRIVATE and row.fencing_token == 17
            assert (await session.get(models.AttemptEvent, (item, 1))) is not None
        eligible = await session.get(models.Attempt, graph[1])
        assert eligible is not None and eligible.facts["metadataExpiredAt"]
        lease = await session.get(models.ResourceLease, (graph[2], "synthetic-protected-pool"))
        pool = await session.get(models.CapacityPool, "synthetic-protected-pool")
        assert lease is not None and lease.state == "HELD"
        assert pool is not None and pool.used == 1


# 同页保护反例与可清理对照共享一次维护请求，保留各行标识用于逐项检查围栏和事件未被误删。
async def test_lifecycle_protects_capacity_owner_and_unsuccessful_cleanup(site: Site) -> None:
    """已到保留期限的尝试仍须满足释放容量、所有者完成和依赖清理成功，隔离占用不得被逻辑过期伪装成停止。
    同页包含可清理对照，确认拒绝不是整个维护入口未执行。
    """
    client, database, workspace_id = await initialized(site)
    token = (await maintenance_token(client, workspace_id))[1]
    actor = (await client.get("/api/v1/account")).json()["data"]["id"]
    async with database.sessions.begin() as session:
        graph = await seed_protected_graph(session, workspace_id, actor)
    result = checked(await expire(client, workspace_id, token, limit=20), 200)["data"]
    assert result["nextCursor"] == "offline:" and result["processedCount"] == 1
    await assert_protected_graph(database, graph)
