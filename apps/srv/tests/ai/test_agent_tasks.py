"""经真实员工会话与独立数据库检查测试跟踪的重放、隔离及后台停止边界，并核对运行结论始终由测试执行服务提供。"""

import asyncio
from uuid import uuid4

import pytest
from emulator import emulator
from test_agent_sessions import _create
from test_conversational_agent import conversation
from test_trigger import plan_fixture
from test_workspace import client, new_member


def _root(turns):
    return turns.removesuffix("/turns") + "/tasks"


@pytest.mark.parametrize("mode", ["AUTO", "MAIN", "SUBAGENT"])
async def test_turn_confirmation_delegates_without_holding_the_conversation(site, mode):
    """一次确认后可以继续发送新轮次，重复确认不会创建额外运行或后台任务，后台偏好仍由首次审阅的请求决定。"""
    c, _, ws, _, plan = await plan_fixture(site)
    async with emulator() as model:
        turns, _, _ = await conversation(c, ws, model)
        model.output = {
            "reply": "Run smoke",
            "proposal": {
                "type": "TRIGGER_PLAN",
                "planId": plan["id"],
                "planRevision": 1,
            },
        }
        reply = await c.post(
            turns,
            json={
                "requestId": str(uuid4()),
                "text": "Run smoke",
                "delegationMode": mode,
            },
        )
        assert reply.is_success, reply.text
        turn_id = reply.json()["data"]["id"]
        assert reply.json()["data"]["delegationMode"] == mode
        override = await c.post(
            turns,
            json={
                "requestId": str(uuid4()),
                "text": "confirm run",
                "expectedProposalId": turn_id,
                "delegationMode": "MAIN",
            },
        )
        assert override.status_code == 400
        confirmed = await c.post(f"{turns}/{turn_id}/confirm")
        assert confirmed.is_success, confirmed.text
        run = confirmed.json()["data"]["receipt"]["runId"]
        assert (await c.post(f"{turns}/{turn_id}/confirm")).json()["data"] == confirmed.json()[
            "data"
        ]
        tasks = (await c.get(_root(turns))).json()["data"]["items"]
        if mode == "MAIN":
            assert tasks == []
        else:
            assert len(tasks) == 1
            assert tasks[0]["runId"] == run
            assert tasks[0]["mode"] == ("AUTO" if mode == "AUTO" else "MANUAL")
        model.output = {"reply": "The next plan can reuse your environment."}
        next_reply = await c.post(
            turns, json={"requestId": str(uuid4()), "text": "Discuss the next plan"}
        )
        assert next_reply.is_success and next_reply.json()["data"]["status"] == "COMPLETED"


async def test_manual_follow_replays_and_stop_leaves_run_intact(site):
    """同一请求身份在页面重试后保持同一后台任务，停止跟踪不会取消或改变真实运行，原会话之外也无法使用该任务编号。"""
    c, _, ws, _, plan = await plan_fixture(site)
    async with emulator() as model:
        turns, _, _ = await conversation(c, ws, model)
        model.output = {
            "reply": "Run smoke",
            "proposal": {
                "type": "TRIGGER_PLAN",
                "planId": plan["id"],
                "planRevision": 1,
            },
        }
        reply = await c.post(
            turns,
            json={
                "requestId": str(uuid4()),
                "text": "Run smoke",
                "delegationMode": "MAIN",
            },
        )
        assert reply.is_success, reply.text
        run_id = (await c.post(f"{turns}/{reply.json()['data']['id']}/confirm")).json()["data"][
            "receipt"
        ]["runId"]
    route = _root(turns)
    req = {"requestId": str(uuid4()), "runId": run_id}
    followed = await c.post(route, json=req)
    assert followed.is_success, followed.text
    task = followed.json()["data"]
    assert task["mode"] == "MANUAL"
    assert (await c.post(route, json=req)).json()["data"] == task
    other = await _create(c, ws, "Other session")
    other_tasks = f"{route.split('/sessions/')[0]}/sessions/{other['id']}/tasks"
    assert (await c.post(f"{other_tasks}/{task['id']}/stop")).status_code == 404
    async with client(c, "admin@example.com") as same_owner:
        assert (await same_owner.get(route)).json()["data"]["items"] == [task]
    run_route = f"/api/v1/workspaces/{ws}/runs/{run_id}/report"
    before = (await c.get(run_route)).json()["data"]["run"]["state"]
    end = await c.post(f"{route}/{task['id']}/stop")
    assert end.json()["data"]["state"] == "STOPPED"
    assert (await c.post(f"{route}/{task['id']}/stop")).json()["data"] == end.json()["data"]
    assert (await c.get(run_route)).json()["data"]["run"]["state"] == before


async def test_background_worker_reads_real_cancelled_outcome_after_restart(site):
    """真正的取消从运行服务进入数据库，重新领取的后台跟踪只能由该持久状态完成，既有运行回执和任务标识始终保持一致。"""
    from sqlalchemy import update

    from veriq_server.db import AgentTask
    from veriq_server.service import now
    from veriq_server.services.agent_tasks import advance_tasks

    c, db, ws, _, plan = await plan_fixture(site)
    async with emulator() as model:
        turns, _, _ = await conversation(c, ws, model)
        model.output = {
            "reply": "Run smoke",
            "proposal": {
                "type": "TRIGGER_PLAN",
                "planId": plan["id"],
                "planRevision": 1,
                "delegateRun": True,
            },
        }
        proposed = await c.post(
            turns, json={"requestId": str(uuid4()), "text": "Run and track smoke"}
        )
        assert proposed.is_success, proposed.text
        confirmed = await c.post(f"{turns}/{proposed.json()['data']['id']}/confirm")
        assert confirmed.is_success, confirmed.text
    run_id = confirmed.json()["data"]["receipt"]["runId"]
    tasks = _root(turns)
    assert (await c.get(tasks)).json()["data"]["items"][0]["state"] == "QUEUED"
    assert sorted(await asyncio.gather(advance_tasks(db), advance_tasks(db))) == [0, 1]
    task = (await c.get(tasks)).json()["data"]["items"][0]
    assert task["state"] == "FOLLOWING"
    cancelled = await c.post(
        f"/api/v1/workspaces/{ws}/runs/{run_id}/cancel", json={"reason": "Stop the smoke test"}
    )
    assert cancelled.is_success, cancelled.text
    async with db.sessions.begin() as session:
        await session.execute(
            update(AgentTask).where(AgentTask.id == task["id"]).values(next_check_at=now())
        )
    assert await advance_tasks(db) == 1
    assert (await c.get(tasks)).json()["data"]["items"] == [
        {**task, "state": "COMPLETED", "outcome": "CANCELLED"},
    ]
    assert await advance_tasks(db) == 0
    pending = await c.post(
        tasks, json={"requestId": str(uuid4()), "runId": run_id, "analyze": True}
    )
    assert pending.is_success, pending.text
    orphan_id = pending.json()["data"]["id"]
    async with db.sessions.begin() as session:
        await session.execute(
            update(AgentTask)
            .where(AgentTask.id == orphan_id)
            .values(state="ANALYZING", next_check_at=now())
        )
    assert await advance_tasks(db) == 1
    after = (await c.get(tasks)).json()["data"]["items"]
    assert next(item for item in after if item["id"] == orphan_id)["state"] == "FOLLOWING"


@pytest.mark.parametrize(("mode", "expected"), [("AUTO", []), ("SUBAGENT", ["MANUAL"])])
async def test_explicit_mode_can_override_the_model_delegate_decision(site, mode, expected):
    """模型选择仅作用于自动模式，员工明确指定后台任务时仍保留真实运行的跟踪回执，并按该任务归属继续展示结果。"""
    c, _, ws, _, plan = await plan_fixture(site)
    async with emulator() as model:
        turns, _, _ = await conversation(c, ws, model)
        model.output = {
            "reply": "Run smoke",
            "proposal": {
                "type": "TRIGGER_PLAN",
                "planId": plan["id"],
                "planRevision": 1,
                "delegateRun": False,
            },
        }
        response = await c.post(
            turns,
            json={
                "requestId": str(uuid4()),
                "text": "Launch smoke",
                "delegationMode": mode,
            },
        )
        assert response.is_success, response.text
        confirmed = await c.post(f"{turns}/{response.json()['data']['id']}/confirm")
        assert confirmed.is_success, confirmed.text
        assert [
            task["mode"] for task in (await c.get(_root(turns))).json()["data"]["items"]
        ] == expected


async def test_legacy_reviewed_proposal_does_not_acquire_followup(site):
    """迁移前产生的旧提议没有已审阅的委派选择，继续确认仍创建原有业务运行，同时不会改变原有审批内容。"""
    from veriq_server.db import AgentTurn

    c, db, ws, _, plan = await plan_fixture(site)
    async with emulator() as model:
        turns, _, _ = await conversation(c, ws, model)
        model.output = {
            "reply": "Run smoke",
            "proposal": {"type": "TRIGGER_PLAN", "planId": plan["id"], "planRevision": 1},
        }
        response = await c.post(turns, json={"requestId": str(uuid4()), "text": "Run smoke"})
        assert response.is_success, response.text
        turn_id = response.json()["data"]["id"]
    async with db.sessions.begin() as session:
        stored = await session.get(AgentTurn, turn_id)
        stored.delegation_mode = None
    confirmed = await c.post(f"{turns}/{turn_id}/confirm")
    assert confirmed.is_success, confirmed.text
    assert "runId" in confirmed.json()["data"]["receipt"]
    assert (await c.get(_root(turns))).json()["data"]["items"] == []


async def test_revoked_viewer_cannot_continue_following_running_test(site):
    """停用查看者的成员关系后，下一次领取应停止该私有跟踪，原运行继续由仍具权限的员工读取和管理。"""
    from veriq_server.db import AgentTask
    from veriq_server.services.agent_tasks import advance_tasks

    owner, db, ws, _, plan = await plan_fixture(site)
    role = {"role": "VIEWER", "status": "DISABLED"}
    user_id = await new_member(owner, ws)
    async with emulator() as model:
        turns, _, _ = await conversation(owner, ws, model)
        model.output = {
            "reply": "Run smoke",
            "proposal": {"type": "TRIGGER_PLAN", "planId": plan["id"], "planRevision": 1},
        }
        posted = await owner.post(
            turns, json={"requestId": str(uuid4()), "text": "Run smoke", "delegationMode": "MAIN"}
        )
        assert posted.is_success, posted.text
        confirmed = await owner.post(f"{turns}/{posted.json()['data']['id']}/confirm")
        assert confirmed.is_success, confirmed.text
    run_id = confirmed.json()["data"]["receipt"]["runId"]
    async with client(owner, "member@example.com") as member:
        session = await _create(member, ws, "Follow smoke")
        tasks = f"/api/v1/workspaces/{ws}/agent/sessions/{session['id']}/tasks"
        posted = await member.post(tasks, json={"requestId": str(uuid4()), "runId": run_id})
        assert posted.is_success, posted.text
        task_id = posted.json()["data"]["id"]
        revoked = await owner.put(f"/api/v1/workspaces/{ws}/members/{user_id}", json=role)
        assert revoked.is_success, revoked.text
        assert (await member.get(tasks)).status_code == 403
        assert await advance_tasks(db) == 1
    async with db.sessions() as session:
        failed = await session.get(AgentTask, task_id)
        assert (failed.state, failed.error_code) == ("FAILED", "AGENT_TASK_UNAVAILABLE")
    report = await owner.get(f"/api/v1/workspaces/{ws}/runs/{run_id}/report")
    assert report.json()["data"]["run"]["state"] == "QUEUED"
