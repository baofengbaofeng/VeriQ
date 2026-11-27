"""测试会话重复运行、取消与报告诊断的授权边界，覆盖真实领域事务以及报告事实进入模型之前的范围限制。"""

import asyncio
import json
from uuid import uuid4

import pytest
from emulator import emulator
from sqlalchemy import select
from test_agent_configuration import _completion_delta, _tool_delta
from test_conversational_agent import conversation
from test_trigger import plan_fixture
from test_workspace import new_member, workspace

from veriq_server.auth.authorization import WorkspaceScope
from veriq_server.db import CaseExecution, Resource, ResourceVersion, Run, User, WorkspaceMember
from veriq_server.service import Problem, lock_installation
from veriq_server.services import agent_run_operations as ops
from veriq_server.services.report import ReportService
from veriq_server.settings import Settings


def test_diagnosis_limits_samples_but_counts_all_case_and_attempt_evidence():
    """构造超过模型输出上限的报告，验证全部异常仍进入汇总，未受控文本和无关敏感内容不进入任何输出字段。"""

    def case(index):
        return {
            "id": str(uuid4()),
            "caseVersionId": str(uuid4()),
            "state": "FINISHED",
            "outcome": "FAILED" if index > 8 else "PASSED",
            "provenance": {"roleKey": "never-send"},
            "attempts": [
                {
                    "id": str(uuid4()),
                    "attemptNo": attempt_no,
                    "phase": "FINISHED",
                    "outcome": "FAILED" if index > 8 else "PASSED",
                    "lastSequence": 42,
                    "facts": {
                        "errorCode": "ASSERTION_FAILED" if index > 8 else "NEVER_SEND_SECRET",
                        "diagnostics": [{"message": "never-send"}],
                    },
                }
                for attempt_no in (1, 2, 3)
            ],
        }

    cases = [case(index) for index in range(14)]
    report = {
        "run": {
            "id": str(uuid4()),
            "source": "CONNECTED_LOCAL",
            "triggerKind": "MANUAL",
            "state": "FINISHED",
            "outcome": "FAILED",
            "reasonCode": "never-send",
        },
        "statistics": {
            "caseCount": 14,
            "firstPassCount": 9,
            "retryPassCount": 0,
            "infrastructureErrorCount": 0,
        },
        "gateAtExecution": {"passed": False, "reasons": ["RUN_NOT_PASSED"]},
        "gateNow": {"passed": False, "reasons": ["RUN_NOT_PASSED"]},
        "cases": cases,
    }
    result = ops.project_run_report(report, diagnose=True)
    assert result["statistics"] == report["statistics"]
    assert result["diagnosis"]["outcomeCounts"] == {"PASSED": 9, "FAILED": 5}
    assert result["diagnosis"]["attemptErrorCounts"] == {"ASSERTION_FAILED": 15}
    assert result["cases"][0]["caseExecutionId"] == cases[9]["id"]
    assert len(result["cases"]) == 8 and result["omittedCases"] == 6
    assert [a["attemptNo"] for a in result["cases"][0]["attempts"]] == [2, 3]
    assert result["cases"][0]["attemptCount"] == 3
    assert result["cases"][0]["attempts"][0]["lastSequence"] == 42
    assert "never-send" not in json.dumps(result).lower() and "NEVER_SEND" not in json.dumps(result)
    for chinese in (True, False):
        rendered = ops.format_run_report(result, chinese=chinese)
        assert report["run"]["id"] in rendered and "ASSERTION_FAILED" in rendered
        assert cases[9]["id"] in rendered and cases[9]["attempts"][-1]["id"] in rendered
        assert cases[9]["attempts"][0]["id"] not in rendered
        assert cases[8]["id"] not in rendered and "never-send" not in rendered.lower()
        assert len(rendered) <= 6000


async def test_reviewed_run_repeats_frozen_published_selection_and_rechecks_authority(site):
    """用真实发布用例和设备生成首个运行，确认取消与重复执行的独立幂等性，并在归档资源和撤销权限后拒绝旧提议。"""
    c, db, workspace_id, _, plan = await plan_fixture(site)
    scope = WorkspaceScope(workspace_id)
    user_id = (await c.get("/api/v1/account")).json()["data"]["id"]
    selection = {
        k: plan[k]
        for k in ("suiteVersionId", "environmentVersionId", "roleKeys", "runtimeIds", "browsers")
    }
    selection["variables"] = {"opaque": "private-baseline"}
    response = await c.post(
        f"/api/v1/workspaces/{workspace_id}/runs",
        json=selection,
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 202, response.text
    original = response.json()["data"]["id"]
    context = {"runs": [{"runId": original}]}
    peer_id = await new_member(c, workspace_id, "repeat-peer@example.test", "EXECUTOR")
    cancel = {"type": "CANCEL_RUN", "sourceRunId": original}
    repeat = {"type": "RERUN_RUN", "sourceRunId": original}
    settings = Settings(
        database_url="mysql+asyncmy://unused@localhost/veriq_test",
        public_url="https://example.test",
        master_key="a" * 64,
        signing_key="b" * 64,
    )
    async with db.sessions.begin() as session:
        await lock_installation(session)
        user = await session.get(User, user_id)
        report = await ops.read_run_report(
            ReportService(session, user, settings), scope, original, diagnose=True
        )
        assert report["runId"] == original and report["statistics"]["caseCount"] == 1
        with pytest.raises(Problem) as unoffered:
            await ops.prepare_run_operation(session, scope, user, cancel, {"runs": []})
        assert unoffered.value.code == "AGENT_RUN_REFERENCE_REQUIRED"
        reviewed = await ops.prepare_run_operation(session, scope, user, cancel, context)
        assert (await session.get(Run, original)).state == "QUEUED"
        with pytest.raises(Problem) as pending:
            await ops.prepare_run_operation(session, scope, user, repeat, context)
        assert pending.value.code == "AGENT_RUN_NOT_REPEATABLE"
        receipt = await ops.apply_run_operation(session, scope, user, str(uuid4()), reviewed)
        assert receipt == {"type": "CANCEL_RUN", "runId": original}
        assert (await session.get(Run, original)).state == "FINISHED"
        peer = await session.get(User, peer_id)
        assert await ops.prepare_run_operation(session, scope, peer, cancel, context) == reviewed
        with pytest.raises(Problem) as private_source:
            await ops.prepare_run_operation(session, scope, peer, repeat, context)
        assert private_source.value.code == "AGENT_RUN_NOT_REPEATABLE"
        ready = await ops.prepare_run_operation(session, scope, user, repeat, context)
        assert set(ready) == {"type", "sourceRunId", "sourceSnapshotHash"}
        assert "private-baseline" not in json.dumps(ready)
        with pytest.raises(Problem) as stale:
            await ops.apply_run_operation(
                session, scope, user, str(uuid4()), {**ready, "sourceSnapshotHash": "0" * 64}
            )
        assert stale.value.code == "AGENT_RUN_CHANGED"
        key = str(uuid4())
        new = await ops.apply_run_operation(session, scope, user, key, ready)
        assert (
            new["type"] == "RERUN_RUN"
            and new["sourceRunId"] == original
            and new["runId"] != original
        )
        assert await ops.apply_run_operation(session, scope, user, key, ready) == new
        assert (
            len((await session.scalars(select(Run).where(Run.workspace_id == workspace_id))).all())
            == 2
        )
        target = (
            await session.scalars(select(CaseExecution).where(CaseExecution.run_id == new["runId"]))
        ).one()
        source = (
            await session.scalars(select(CaseExecution).where(CaseExecution.run_id == original))
        ).one()
        assert target.published_case_version_id == source.published_case_version_id
        source_run = await session.get(Run, original)
        original_hash = source_run.request_hash
        source_run.request_hash = "1" * 64
        with pytest.raises(Problem) as invalid_request:
            await ops.prepare_run_operation(session, scope, user, repeat, context)
        assert invalid_request.value.code == "AGENT_RUN_NOT_REPEATABLE"
        source_run.request_hash = original_hash
        case_version = await session.get(ResourceVersion, source.published_case_version_id)
        case_resource = await session.get(Resource, case_version.resource_id)
        case_resource.status = "ARCHIVED"
        with pytest.raises(Problem) as excluded_case:
            await ops.apply_run_operation(session, scope, user, str(uuid4()), ready)
        assert excluded_case.value.code == "RESOURCE_ARCHIVED"
        case_resource.status = "PUBLISHED"
        version = await session.get(ResourceVersion, plan["suiteVersionId"])
        resource = await session.get(Resource, version.resource_id)
        resource.status = "ARCHIVED"
        with pytest.raises(Problem) as archived:
            await ops.apply_run_operation(session, scope, user, str(uuid4()), ready)
        assert archived.value.code == "RESOURCE_ARCHIVED"
        member = await session.get(WorkspaceMember, (workspace_id, user_id))
        member.role = "VIEWER"
        with pytest.raises(Problem) as forbidden:
            await ops.apply_run_operation(session, scope, user, str(uuid4()), reviewed)
        assert forbidden.value.status == 403
        member.status = "REVOKED"
        with pytest.raises(Problem) as invisible:
            await ops.read_run_report(ReportService(session, user, settings), scope, original)
        assert invisible.value.status == 403


async def test_streamed_diagnosis_cancel_and_repeat_require_review_and_share_replay_receipts(site):
    """经真实供应商协议和流式 HTTP 路径查看授权证据、取消并重跑，双重确认共享回执，源变量不进入模型。"""
    c, db, workspace_id, _, plan = await plan_fixture(site)
    selection = {
        k: plan[k]
        for k in ("suiteVersionId", "environmentVersionId", "roleKeys", "runtimeIds", "browsers")
    }
    selection["variables"] = {"opaque": "private-source-never-send"}
    created = await c.post(
        f"/api/v1/workspaces/{workspace_id}/runs",
        json=selection,
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert created.status_code == 202, created.text
    original = created.json()["data"]["id"]
    async with emulator() as model:
        path, _, _ = await conversation(c, workspace_id, model)
        for operation in ("CANCEL_RUN", "RERUN_RUN"):
            draft = {"type": operation, "sourceRunId": original}
            model.stream_responses[:] = [
                [_tool_delta("diagnose_run_v1", {"runId": original}, "diagnosis")],
                [_tool_delta("prepare_run_operation_v1", {"proposal": draft}, "review")],
                [_completion_delta({"content": "Review this run operation."}, "stop")],
            ]
            streamed = await c.post(
                f"{path}/stream",
                json={"requestId": str(uuid4()), "text": f"{operation} for run {original}"},
            )
            assert streamed.is_success, streamed.text
            lines = streamed.text.splitlines()
            done = json.loads(lines[lines.index("event: done") + 1].removeprefix("data: "))
            assert done["status"] == "COMPLETED", done
            assert [(step["name"], step["status"]) for step in done["steps"]] == [
                ("diagnose_run_v1", "SUCCEEDED"),
                ("prepare_run_operation_v1", "SUCCEEDED"),
            ]
            evidence = json.loads(
                next(
                    m["content"]
                    for m in model.calls[-2]["body"]["messages"]
                    if m.get("role") == "tool" and m.get("tool_call_id") == "diagnosis"
                )
            )
            assert evidence["runId"] == original and evidence["statistics"]["caseCount"] == 1
            assert len(evidence["cases"]) == 1
            if operation == "RERUN_RUN":
                assert evidence["reasonCode"] == "USER_CANCELLED"
            assert done["proposal"] == {
                **draft,
                "sourceSnapshotHash": created.json()["data"]["snapshotHash"],
            }
            async with db.sessions() as session:
                runs = (
                    await session.scalars(select(Run).where(Run.workspace_id == workspace_id))
                ).all()
                assert len(runs) == 1 and runs[0].state == (
                    "QUEUED" if operation == "CANCEL_RUN" else "FINISHED"
                )
            confirmed = await asyncio.gather(
                *(c.post(f"{path}/{done['id']}/confirm") for _ in range(2))
            )
            assert all(response.is_success for response in confirmed), [
                response.text for response in confirmed
            ]
            receipts = [response.json()["data"]["receipt"] for response in confirmed]
            assert receipts[0] == receipts[1]
            if operation == "CANCEL_RUN":
                assert receipts[0] == {"type": operation, "runId": original}
            else:
                assert receipts[0]["sourceRunId"] == original and receipts[0]["runId"] != original
        model.stream_responses[:] = [
            [_tool_delta("get_run_report_v1", {"runId": original}, "details")],
            [_completion_delta({"content": "Invented provider conclusion."}, "stop")],
        ]
        streamed = await c.post(
            f"{path}/stream",
            json={
                "requestId": str(uuid4()),
                "text": f"Diagnose the detailed run report for {original}",
            },
        )
        assert streamed.is_success, streamed.text
        lines = streamed.text.splitlines()
        diagnosed = json.loads(lines[lines.index("event: done") + 1].removeprefix("data: "))
        assert diagnosed["relatedRunId"] == original
        assert evidence["cases"][0]["caseExecutionId"] in diagnosed["reply"]
        assert "USER_CANCELLED" in diagnosed["reply"]
        assert "Invented provider conclusion" not in diagnosed["reply"]
        assert "private-source-never-send" not in json.dumps(model.calls)
    async with db.sessions() as session:
        runs = (await session.scalars(select(Run).where(Run.workspace_id == workspace_id))).all()
        assert {run.state for run in runs} == {"FINISHED", "QUEUED"} and len(runs) == 2


async def test_plan_run_preserves_trigger_admission_and_foreign_scope_hides_target(site):
    """通过真实计划触发器落库并完成运行，跨空间读取消均拒绝，同空间也不能把计划运行变成绕开准入规则的手动请求。"""
    c, db, workspace_id, _, plan = await plan_fixture(site)
    other = await workspace(c, "other-run-scope")
    result = await c.post(
        f"/api/v1/workspaces/{workspace_id}/execution-plans/{plan['id']}/trigger",
        json={"buildSha": "build-42"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert result.status_code == 202, result.text
    run_id = result.json()["data"]["runId"]
    user_id = (await c.get("/api/v1/account")).json()["data"]["id"]
    scope = WorkspaceScope(workspace_id)
    context = {"runs": [{"runId": run_id}]}
    async with db.sessions.begin() as session:
        await lock_installation(session)
        user = await session.get(User, user_id)
        cancel = {"type": "CANCEL_RUN", "sourceRunId": run_id}
        with pytest.raises(Problem) as foreign:
            await ops.prepare_run_operation(session, WorkspaceScope(other), user, cancel, context)
        assert (foreign.value.status, foreign.value.code) == (404, "RUN_NOT_FOUND")
        reviewed = await ops.prepare_run_operation(session, scope, user, cancel, context)
        await ops.apply_run_operation(session, scope, user, str(uuid4()), reviewed)
        with pytest.raises(Problem) as plan_origin:
            await ops.prepare_run_operation(
                session, scope, user, {"type": "RERUN_RUN", "sourceRunId": run_id}, context
            )
        assert plan_origin.value.code == "AGENT_RUN_NOT_REPEATABLE"
        assert (
            len((await session.scalars(select(Run).where(Run.workspace_id == workspace_id))).all())
            == 1
        )
