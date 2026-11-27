"""使用真实运行、数据库和供应商协议检查后台分析的证据范围、预算结算以及停止和撤权后的可见性。"""

import asyncio
import json
from datetime import timedelta
from uuid import uuid4

import pytest
from emulator import emulator
from sqlalchemy import select
from test_conversational_agent import conversation
from test_trigger import plan_fixture
from tornado.web import RequestHandler

from veriq_server.db import (
    AgentSession,
    AgentTask,
    AiGeneration,
    AiProvider,
    CaseExecution,
    Installation,
    Run,
    User,
)
from veriq_server.services.jobs import database_time
from veriq_server.service import Problem
from veriq_server.services import agent_task_analysis
from veriq_server.services.agent_task_analysis import analyze_task
from veriq_server.services.agent_tasks import advance_tasks
from veriq_server.services.ai import AiService
from veriq_server.settings import Settings


async def _claimed(site, model, *, claim=True):
    """从已认证接口创建会话和执行并取消运行，再模拟调度器已经提交的领取，保留真实回执和供应商配置。"""
    c, db, ws, _, plan = await plan_fixture(site)
    turns, _, config = await conversation(c, ws, model)
    task_id, run = await _follow_cancelled(c, ws, plan, turns)
    if claim:
        async with db.sessions.begin() as session:
            task = await session.get(AgentTask, task_id)
            task.state = "ANALYZING"
            task.next_check_at = await database_time(session) + timedelta(minutes=5)
    return db, _worker_settings(db, c, model), task_id, run, config["apiKey"]


async def _follow_cancelled(c, ws, plan, turns):
    """通过正常接口跟踪员工选定的执行并记录取消原因，保留业务身份与权限供后续模型及费用检查使用。"""
    base = f"/api/v1/workspaces/{ws}"
    fired = await c.post(
        f"{base}/execution-plans/{plan['id']}/trigger",
        headers={"Idempotency-Key": str(uuid4())},
        json={},
    )
    assert fired.is_success, fired.text
    run = fired.json()["data"]["runId"]
    tasks = turns.removesuffix("/turns") + "/tasks"
    result = await c.post(tasks, json={"requestId": str(uuid4()), "runId": run, "analyze": True})
    assert result.is_success, result.text
    task_id = result.json()["data"]["id"]
    cancelled = await c.post(f"{base}/runs/{run}/cancel", json={"reason": "Cancelled by employee"})
    assert cancelled.is_success, cancelled.text
    return task_id, run


def _worker_settings(db, c, model):
    """给独立工作器注入与测试站点相同的数据库和密钥配置，部署出口清单仅允许本例的回环模型服务。"""
    return Settings.model_validate(
        {
            "database_url": db.engine.url.render_as_string(hide_password=False),
            "public_url": str(c.base_url).rstrip("/"),
            "master_key": "a" * 64,
            "signing_key": "b" * 64,
            "environment": "development",
            "ai_allowed_base_urls": [model.base_url],
        }
    )


@pytest.mark.parametrize(
    "change",
    [
        "none",
        "stop",
        "revoke",
        "endpoint",
        "revision",
        "expired",
        "retention",
        "ai_retention",
        "invalid",
    ],
)
async def test_paid_analysis_respects_authority_after_call_and_settles_usage(site, change):
    """让真实模型请求停在回环端点，在另一事务中检查预留和权限变更，再验证迟到回复的可见性与已知费用。"""
    async with emulator() as model:
        db, settings, task_id, run_id, key = await _claimed(site, model)
        model.output = {"basis": f"Based on report {key}", "suggestions": ["Review case coverage."]}
        if change == "invalid":
            model.output["outcome"] = "PASSED"
        model.wait = True
        model.release.clear()
        worker = asyncio.create_task(analyze_task(db, settings, task_id))
        try:
            await asyncio.wait_for(model.started.wait(), timeout=10)
            await _change_during_call(site[0], db, settings, task_id, change)
            await analyze_task(db, settings, task_id)
        finally:
            model.release.set()
            await worker
        await analyze_task(db, settings, task_id)
        _assert_report_request(model.calls, run_id, key)
        async with db.sessions() as session:
            task = await session.get(AgentTask, task_id)
            usage = (await session.scalars(select(AiGeneration))).one()
            assert usage.id == task.analysis_attempt_id
            assert usage.cost_micros == 160
            assert usage.data["inputTokens"] == 80 and usage.data["outputTokens"] == 40
            assert (await session.get(Run, run_id)).outcome == "CANCELLED"
            assert task.next_check_at is None
            if change == "none":
                assert usage.status == "SUCCEEDED"
                assert task.analysis == {
                    "basis": "Based on report [REDACTED]",
                    "suggestions": ["Review case coverage."],
                }
                assert task.state == "COMPLETED" and task.error_code is None
            else:
                assert task.analysis is None
                assert task.state == ("STOPPED" if change == "stop" else "COMPLETED")
                if change != "stop":
                    assert task.error_code


async def _change_during_call(client, db, settings, task_id, change):
    """在供应商等待期间变更真实权限、保留标记或任务状态，结算时再依据数据库中的原始预留核验结果。"""
    async with db.sessions.begin() as session:
        task = await session.get(AgentTask, task_id)
        usage = await session.get(AiGeneration, task.analysis_attempt_id)
        assert usage.status == "RUNNING" and usage.cost_micros is None
        assert usage.purpose == "CONVERSATION"
        if change == "expired":
            task.next_check_at = await database_time(session) - timedelta(seconds=1)
        if change == "revision":
            (await session.get(AiProvider, usage.provider_id)).revision += 1
        if change == "revoke":
            employee = await session.get(AgentSession, task.session_id)
            (await session.get(User, employee.user_id)).disabled = True
        if change == "ai_retention":
            usage.data = {
                "metadataExpiredAt": (await database_time(session)).isoformat(),
                "providerRevision": usage.data["providerRevision"],
            }
        if change == "retention":
            case = await session.scalar(
                select(CaseExecution).where(CaseExecution.run_id == task.run_id)
            )
            case.provenance = {
                **case.provenance,
                "metadataExpiredAt": (await database_time(session)).isoformat(),
            }
        if change == "endpoint":
            settings.ai_allowed_base_urls.clear()
    if change == "stop":
        root = f"/api/v1/workspaces/{usage.workspace_id}/agent/sessions"
        route = f"{root}/{task.session_id}/tasks"
        stopped = await client.post(f"{route}/{task_id}/stop")
        assert stopped.is_success, stopped.text
        async with db.sessions() as session:
            pending = await session.get(AiGeneration, usage.id)
            assert pending.status == "FAILED" and pending.cost_micros is None


def _assert_report_request(calls, run_id, key):
    """按模型实际收到的 HTTP 请求检查精确运行标识和诊断投影，同时排除原始制品、密钥及任何工具能力。"""
    assert len(calls) == 1
    body = calls[0]["body"]
    assert "tools" not in body
    context = json.loads(body["messages"][1]["content"])["context"]
    assert context["runId"] == run_id and context["outcome"] == "CANCELLED"
    assert "diagnosis" in context and "artifacts" not in context and key not in json.dumps(context)


@pytest.mark.parametrize("when", ["before_reserve", "after_reserve"])
async def test_revoked_endpoint_before_dispatch_leaves_no_charge_or_analysis(
    site, monkeypatch, when
):
    """在调用开始前收回真实模型地址时仍从权威运行取得终态，但不能预留费用、发送证据或保存生成的结论。"""
    async with emulator() as model:
        db, settings, task_id, run_id, _ = await _claimed(site, model)
        if when == "before_reserve":
            settings.ai_allowed_base_urls.clear()
        else:
            reserve = AiService.reserve_usage

            async def revoke_after_reserve(service, *args, **kwargs):
                usage = await reserve(service, *args, **kwargs)
                settings.ai_allowed_base_urls.clear()
                return usage

            monkeypatch.setattr(AiService, "reserve_usage", revoke_after_reserve)
        await analyze_task(db, settings, task_id)
        assert not model.calls
        async with db.sessions() as session:
            task = await session.get(AgentTask, task_id)
            assert task.state == "COMPLETED" and task.error_code == "AI_ENDPOINT_FORBIDDEN"
            assert task.analysis is None
            if when == "before_reserve":
                assert task.analysis_attempt_id is None
                assert (await session.scalars(select(AiGeneration))).all() == []
            else:
                usage = await session.get(AiGeneration, task.analysis_attempt_id)
                assert usage.status == "FAILED" and usage.cost_micros == 0
            assert (await session.get(Run, run_id)).outcome == "CANCELLED"


@pytest.mark.parametrize("malformed", [False, True])
async def test_finished_task_does_not_repeat_unknown_provider_charge(site, monkeypatch, malformed):
    """供应商已经收到请求但无法返回用量时保留该笔预算，重新到达的工作消息不能生成第二条请求或新的结论。"""
    async with emulator() as model:
        db, settings, task_id, run_id, _ = await _claimed(site, model, claim=False)
        if malformed:
            write = RequestHandler.write

            def write_malformed(handler, chunk):
                if handler.request.path == "/v1/chat/completions" and isinstance(chunk, dict):
                    chunk = {**chunk, "choices": None}
                return write(handler, chunk)

            monkeypatch.setattr(RequestHandler, "write", write_malformed)
        else:
            model.status = 503
        assert await advance_tasks(db, settings) == 1
        await analyze_task(db, settings, task_id)
        assert len(model.calls) == 1
        async with db.sessions() as session:
            task = await session.get(AgentTask, task_id)
            usage = (await session.scalars(select(AiGeneration))).one()
            assert task.state == "COMPLETED" and task.error_code == "AI_PROVIDER_ERROR"
            assert task.analysis is None and usage.id == task.analysis_attempt_id
            assert (
                usage.status == "FAILED" and usage.cost_micros is None and usage.reserved_micros > 0
            )
            assert (await session.get(Run, run_id)).outcome == "CANCELLED"


async def test_report_projection_holds_no_installation_lock_and_runs_once(site, monkeypatch):
    """在真实报告投影期间通过独立事务取得安装行锁，检查模型返回前的授权和保留检查不会重复构建完整报告。"""
    async with emulator() as model:
        db, settings, task_id, _, _ = await _claimed(site, model)
        model.output = {"basis": "Cancelled by the employee", "suggestions": []}
        reads = []
        read = agent_task_analysis.read_run_report

        async def observed(*args, **kwargs):
            async with db.sessions.begin() as other:
                assert await other.scalar(select(Installation.id).with_for_update(skip_locked=True))
            reads.append(args[2])
            return await read(*args, **kwargs)

        monkeypatch.setattr(agent_task_analysis, "read_run_report", observed)
        await analyze_task(db, settings, task_id)
        async with db.sessions() as session:
            task = await session.get(AgentTask, task_id)
            assert reads == [task.run_id] and task.analysis == model.output


async def test_completed_advice_hides_after_authoritative_report_expires(site):
    """员工在同一会话查看已结算分析，正式报告元数据留存到期后仍可看到真实运行结果而无法再次读取模型建议。"""
    async with emulator() as model:
        db, settings, task_id, run_id, _ = await _claimed(site, model)
        model.output = {"basis": "Employee cancellation", "suggestions": []}
        await analyze_task(db, settings, task_id)
        async with db.sessions() as session:
            task = await session.get(AgentTask, task_id)
            usage = await session.get(AiGeneration, task.analysis_attempt_id)
            route = (
                f"/api/v1/workspaces/{usage.workspace_id}/agent/sessions/{task.session_id}/tasks"
            )
        first = await site[0].get(route)
        assert first.is_success, first.text
        assert first.json()["data"]["items"][0]["analysis"] == model.output
        async with db.sessions.begin() as session:
            case = await session.scalar(select(CaseExecution).where(CaseExecution.run_id == run_id))
            case.provenance = {
                **case.provenance,
                "metadataExpiredAt": (await database_time(session)).isoformat(),
            }
        second = await site[0].get(route)
        assert second.is_success, second.text
        row = second.json()["data"]["items"][0]
        assert (
            "analysis" not in row and row["state"] == "COMPLETED" and row["outcome"] == "CANCELLED"
        )
        assert len(model.calls) == 1


@pytest.mark.parametrize(
    "change", ["expired", "previous_claim", "during_projection", "during_failure"]
)
async def test_unreserved_worker_cannot_charge_or_complete_a_replaced_claim(
    site, monkeypatch, change
):
    """持久预留之前，已超时或被新领取取代的工作实例只能放弃；即使旧投影失败，也不能覆盖新任务的期限或状态。"""
    async with emulator() as model:
        db, settings, task_id, _, _ = await _claimed(site, model)
        async with db.sessions.begin() as session:
            task = await session.get(AgentTask, task_id)
            expected = task.next_check_at
            if change == "expired":
                expected = await database_time(session) - timedelta(seconds=1)
                task.next_check_at = expected
            elif change == "previous_claim":
                task.next_check_at = expected + timedelta(minutes=1)
        if change.startswith("during_"):
            project = agent_task_analysis.read_run_report

            async def replace_during_read(*args, **kwargs):
                async with db.sessions.begin() as session:
                    task = await session.get(AgentTask, task_id)
                    task.next_check_at = expected + timedelta(minutes=1)
                if change == "during_failure":
                    raise Problem(410, "REPORT_EXPIRED", "Old projection expired")
                return await project(*args, **kwargs)

            monkeypatch.setattr(agent_task_analysis, "read_run_report", replace_during_read)
        await analyze_task(db, settings, task_id, expected_deadline=expected)
        assert not model.calls
        async with db.sessions() as session:
            task = await session.get(AgentTask, task_id)
            assert (
                task.state == "ANALYZING"
                and task.analysis_attempt_id is None
                and task.error_code is None
            )
            assert task.next_check_at == (
                expected if change == "expired" else expected + timedelta(minutes=1)
            )
            assert (await session.scalars(select(AiGeneration))).all() == []
