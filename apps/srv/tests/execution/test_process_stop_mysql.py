"""通过真实停止对账端点和数据库容量池核对声明语义，确保已绑定的平台与围栏先决定授权，失败关闭时保留本次未知事实且从不把声明升级为远程进程证明。"""

import pytest
from test_auth import setup, login
from test_workspace import workspace
from test_lease_mysql import device, auth, claim_body, queued_browser_jobs
from veriq_server.db import Attempt, Runtime, CapacityPool


@pytest.mark.parametrize(
    "os_name,scope,allowed",
    [
        ("darwin", None, False),
        ("darwin", "FULL_DESCENDANT_TREE", False),
        ("darwin", "CONTROLLED_WORKER_BROWSER", True),
        ("darwin", "NO_PROCESS_SPAWNED", True),
        ("linux", None, True),
        ("win32", None, True),
        ("linux", "CONTROLLED_WORKER_BROWSER", False),
        ("win32", "CONTROLLED_WORKER_BROWSER", False),
        (None, None, True),
        (None, "CONTROLLED_WORKER_BROWSER", False),
        (None, "FULL_DESCENDANT_TREE", False),
        (None, "NO_PROCESS_SPAWNED", False),
    ],
)
@pytest.mark.parametrize("finished", [False, True])
async def test_reconcile_scope_rejects_before_capacity_release(
    site, os_name, scope, allowed, finished
):
    """逐一核对已登记平台的正回执允许范围与容量池实际计数，陈旧围栏必须先于范围错误被拒绝，已结束 Attempt 的后续确认也必须保存本次实际停止事实。"""
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    await queued_browser_jobs(c, db, ws, 1)
    response = await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))
    assert response.status_code == 200, response.text
    claim = response.json()["data"]
    async with db.sessions.begin() as session:
        runtime = await session.get(Runtime, d["runnerId"])
        runtime.capabilities = {k: v for k, v in runtime.capabilities.items() if k != "os"}
        if os_name is not None:
            runtime.capabilities = {**runtime.capabilities, "os": os_name}
        if finished:
            attempt = await session.get(Attempt, claim["attemptId"])
            attempt.phase = "FINISHED"
    facts = {
        "fencingToken": claim["fencingToken"],
        "processStopped": True,
        "cleanupStatus": "PENDING",
        "stoppedAt": "2026-11-14T00:00:00Z",
    }
    if scope is not None:
        facts["processStopScope"] = scope
    base = f"/internal/v1/attempts/{claim['attemptId']}/reconcile"
    stale = await c.post(
        base, json={**facts, "fencingToken": claim["fencingToken"] + 1}, headers=auth(d)
    )
    assert stale.status_code == 409 and stale.json()["code"] == "STALE_FENCE"
    result = await c.post(base, json=facts, headers=auth(d))
    assert result.status_code == (200 if allowed else 409), result.text
    if not allowed:
        assert result.json()["code"] == "PROCESS_STOP_SCOPE_INVALID"
    async with db.sessions() as session:
        attempt = await session.get(Attempt, claim["attemptId"])
        pool = await session.get(CapacityPool, "00/global/browser")
        assert attempt.capacity_state == ("RELEASED" if allowed else "HELD")
        assert pool.used == (0 if allowed else 1)
        if allowed:
            assert attempt.facts["processStopped"] is True
            assert attempt.facts["stopConfirmation"] == facts
            assert attempt.facts.get("processStopScope") == scope
            assert ("processStopScope" in attempt.facts) is (scope is not None)


@pytest.mark.parametrize("finished", [False, True])
@pytest.mark.parametrize("scope", [None, "CONTROLLED_WORKER_BROWSER", "FULL_DESCENDANT_TREE"])
async def test_unknown_darwin_stop_preserves_facts_and_quarantine(site, finished, scope):
    """实际调用停止未知分支核对数据库容量隔离及历史事实保留，无范围的新失败必须清除此前范围声明，合法但未确认的范围不得把 false 提升成成功回执。"""
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    await queued_browser_jobs(c, db, ws, 1)
    response = await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))
    assert response.status_code == 200, response.text
    claim = response.json()["data"]
    async with db.sessions.begin() as session:
        runtime = await session.get(Runtime, d["runnerId"])
        runtime.capabilities = {**runtime.capabilities, "os": "darwin"}
        attempt = await session.get(Attempt, claim["attemptId"])
        attempt.facts = {
            "retained": "history",
            "processStopped": True,
            "processStopScope": "NO_PROCESS_SPAWNED",
        }
        if finished:
            attempt.phase = "FINISHED"
    facts = {
        "fencingToken": claim["fencingToken"],
        "processStopped": False,
        "cleanupStatus": "PENDING",
        "stoppedAt": "2026-11-14T00:00:00Z",
    }
    if scope is not None:
        facts["processStopScope"] = scope
    result = await c.post(
        f"/internal/v1/attempts/{claim['attemptId']}/reconcile", json=facts, headers=auth(d)
    )
    assert result.status_code == 200, result.text
    assert result.json()["data"]["capacityReleased"] is False
    async with db.sessions() as session:
        attempt = await session.get(Attempt, claim["attemptId"])
        assert attempt.capacity_state == "QUARANTINED"
        assert (await session.get(CapacityPool, "00/global/browser")).used == 1
        assert attempt.facts["retained"] == "history"
        assert attempt.facts["processStopped"] is False
        assert attempt.facts["stopConfirmation"] == facts
        assert ("processStopScope" in attempt.facts) is (scope is not None)
        assert attempt.facts.get("processStopScope") == scope


async def test_legacy_completed_replay_preserves_missing_scope(site):
    """已完成的旧清单在当前身份下仍按原摘要幂等返回，后来登记的 Darwin 能力不得给历史 facts 补造范围；另一个摘要依旧冲突，防止借重放修改旧停止事实。"""
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    await queued_browser_jobs(c, db, ws, 1)
    claimed = await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))
    assert claimed.status_code == 200, claimed.text
    claim = claimed.json()["data"]
    digest = "a" * 64
    receipt = {
        "attemptId": claim["attemptId"],
        "accepted": True,
        "outcome": "PASSED",
        "manifestSha256": digest,
    }
    async with db.sessions.begin() as session:
        runtime = await session.get(Runtime, d["runnerId"])
        runtime.capabilities = {**runtime.capabilities, "os": "darwin"}
        attempt = await session.get(Attempt, claim["attemptId"])
        attempt.phase = "FINISHED"
        attempt.finish_hash, attempt.finish_receipt = digest, receipt
        attempt.facts = {"outcome": "PASSED"}
    finish = {
        "leaseToken": claim["leaseToken"],
        "fencingToken": claim["fencingToken"],
        "kind": "TEST",
        "outcome": "PASSED",
        "manifestSha256": digest,
        "lastSequence": 0,
        "cleanupStatus": "NOT_REQUIRED",
    }
    endpoint = f"/internal/v1/attempts/{claim['attemptId']}/finish"
    replay = await c.post(endpoint, json=finish, headers=auth(d))
    assert replay.status_code == 200 and replay.json()["data"] == receipt, replay.text
    changed = await c.post(endpoint, json={**finish, "manifestSha256": "b" * 64}, headers=auth(d))
    assert changed.status_code == 409 and changed.json()["code"] == "FINISH_CONFLICT"
    async with db.sessions() as session:
        attempt = await session.get(Attempt, claim["attemptId"])
        assert attempt.facts == {"outcome": "PASSED"}
