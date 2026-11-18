"""以真实员工 HTTP、MySQL 事务和本机模型协议端点验证多轮计划、确认副作用以及共享预算的私有记账。"""

import asyncio
import json
from datetime import timedelta
from uuid import uuid4

from sqlalchemy import select
from emulator import emulator
from test_agent_sessions import _agent, _create, _scope
from test_generation import provider_config
from test_trigger import plan_fixture
from test_workspace import workspace

from veriq_server.db import AgentTurn, AiGeneration, Artifact
from veriq_server.service import now


async def conversation(c, ws, model, **options):
    """为已登录员工选择本机协议端点并创建独立会话，每个用例观察生产入口产生的数据与模拟器实际收到的请求。"""
    base = f"/api/v1/workspaces/{ws}"
    config = provider_config(model.base_url, **options)
    response = await c.post(base + "/ai/providers", json=config)
    assert response.status_code == 201, response.text
    pid = response.json()["data"]["id"]
    assert (
        await c.put(
            _agent(ws) + "/settings", json={"defaultProviderId": pid, "agentProviderId": None}
        )
    ).is_success
    owned = await _create(c, ws, "Planning")
    return _agent(ws) + f"/sessions/{owned['id']}/turns", base + "/ai/providers/" + pid, config


async def submit(c, path, text, request_id=None):
    """通过正常的轮次提交拿到持久化状态，模型内容校验失败仍需有可供跨客户端恢复的明确失败记录。"""
    response = await c.post(path, json={"requestId": request_id or str(uuid4()), "text": text})
    assert response.status_code == 200, response.text
    return response.json()["data"]


def plan_input(plan):
    """计划写入只接收编辑字段和乐观锁修订，详情中的资源标识与状态由服务端保存，不能原样传给更新接口。"""
    return {k: v for k, v in plan.items() if k not in {"id", "archived", "workspaceId"}}


async def test_agent_plans_and_revises_in_two_turns(site):
    """从真实发布套件拟定新计划，再用第二轮明确要求调整名称，通过持久化历史与两份确认回执检查完整行为。"""
    c, _, ws, _, plan = await plan_fixture(site)
    safe = {k: v for k, v in plan_input(plan).items() if k not in {"variables", "revision"}}
    async with emulator() as model:
        path, _, _ = await conversation(c, ws, model)
        model.output = {
            "reply": "Smoke covers the reader flow. Payment coverage is missing.",
            "proposal": {"type": "SAVE_PLAN", "plan": {**safe, "name": "Reader smoke"}},
        }
        first = await submit(c, path, "Plan reader regression and identify coverage gaps")
        assert first["proposal"]["plan"] == {**safe, "name": "Reader smoke"}
        confirmation = (await c.post(f"{path}/{first['id']}/confirm")).json()["data"]
        receipt = confirmation["receipt"]
        assert receipt["planRevision"] == 1
        # 把变量写入真实的已有计划。后续预览与模型输入不能携带变量，实际更新必须保留其原值。
        target = f"/api/v1/workspaces/{ws}/execution-plans/{receipt['planId']}"
        existing = (await c.get(target)).json()["data"]
        updated = await c.put(
            target, json={**plan_input(existing), "variables": {"opaque": "private-baseline-value"}}
        )
        assert updated.is_success, updated.text
        model.output = {
            "reply": "Rename only.",
            "proposal": {
                "type": "SAVE_PLAN",
                "planId": receipt["planId"],
                "plan": {"revision": 2, "name": "Weekend smoke"},
            },
        }
        second = await submit(c, path, "Rename the plan we saved to Weekend smoke")
        assert second["proposal"]["previousPlan"] == {**safe, "name": "Reader smoke", "revision": 2}
        assert second["proposal"]["plan"] == {**safe, "name": "Weekend smoke", "revision": 2}
        wire = model.calls[-1]["body"]["messages"][1]["content"]
        assert first["text"] in wire and first["reply"] in wire
        assert plan["suiteVersionId"] in wire and "private-baseline-value" not in wire
        assert "private-baseline-value" not in json.dumps(second)
        confirm = await submit(c, path, "确认")
        assert confirm["receipt"] == {
            "type": "SAVE_PLAN",
            "planId": receipt["planId"],
            "planRevision": 3,
        }
        assert (await c.post(f"{path}/{second['id']}/confirm")).json()["data"][
            "receipt"
        ] == confirm["receipt"]
        assert len(model.calls) == 2
        after = (await c.get(target)).json()["data"]
        assert after == {**updated.json()["data"], "name": "Weekend smoke", "revision": 3}


async def test_agent_confirmation_checks_revision_and_is_idempotent(site):
    """触发前更新计划应使旧预览失效；新预览并发确认只能产生同一运行，确认后的重放也不依赖后来的修订。"""
    c, _, ws, _, plan = await plan_fixture(site)
    target = f"/api/v1/workspaces/{ws}/execution-plans/{plan['id']}"
    async with emulator() as model:
        path, _, _ = await conversation(c, ws, model)
        proposal = {"type": "TRIGGER_PLAN", "planId": plan["id"], "planRevision": 1}
        model.output = {"reply": "Run scheduled smoke", "proposal": proposal}
        old = await submit(c, path, "Run scheduled smoke")
        updated = await c.put(target, json={**plan_input(plan), "name": "Revised smoke"})
        assert updated.is_success
        rejected = await c.post(f"{path}/{old['id']}/confirm")
        assert (rejected.status_code, rejected.json()["code"]) == (409, "PLAN_REVISION_CONFLICT")
        model.output["proposal"] = {**proposal, "planRevision": 2}
        new = await submit(c, path, "Use the revised smoke plan")
        route = f"{path}/{new['id']}/confirm"
        copies = await asyncio.gather(c.post(route), c.post(route))
        receipts = [r.json()["data"]["receipt"] for r in copies]
        assert receipts[0] == receipts[1]
        assert receipts[0]["decision"] == "ENQUEUED"
        assert receipts[0]["planRevision"] == 2
        run_id = receipts[0]["runId"]
        model.output = {"reply": "Read the current report.", "relatedRunId": run_id}
        turn = await submit(c, path, "What happened to that run?")
        assert turn["relatedRunId"] == run_id
        report = (await c.get(f"/api/v1/workspaces/{ws}/runs/{run_id}/report")).json()["data"]
        wire = json.loads(model.calls[-1]["body"]["messages"][1]["content"])["context"]
        assert wire["runs"][0]["state"] == report["run"]["state"]
        assert wire["runs"][0]["outcome"] == report["run"].get("outcome")


async def test_agent_one_off_keeps_saved_plan(site):
    """一次性切换重试设置后，只创建普通运行；已有计划对象和修订完整保留，重复提交不触发第二次模型调用。"""
    c, db, ws, _, plan = await plan_fixture(site)
    base = f"/api/v1/workspaces/{ws}"
    updated = await c.put(
        base + f"/execution-plans/{plan['id']}",
        json={**plan_input(plan), "variables": {"approval": "stored-only-on-server"}},
    )
    assert updated.is_success, updated.text
    plan = updated.json()["data"]
    async with emulator() as model:
        path, _, _ = await conversation(c, ws, model)
        model.output = {
            "reply": "One-off with retry",
            "proposal": {
                "type": "RUN_ONCE",
                "planId": plan["id"],
                "planRevision": 2,
                "selection": {"maxRetries": 1},
            },
        }
        rid = str(uuid4())
        turn = await submit(c, path, "Retry once for this run only", rid)
        assert turn == await submit(c, path, turn["text"], rid)
        assert turn["proposal"]["selection"]["suiteVersionId"] == plan["suiteVersionId"]
        assert turn["proposal"]["selection"]["maxRetries"] == 1
        confirmed = await submit(c, path, "confirm")
        run_id = confirmed["receipt"]["runId"]
        run = (await c.get(base + f"/runs/{run_id}")).json()["data"]
        async with db.sessions.begin() as session:
            snapshot = await session.get(Artifact, (ws, run["snapshotHash"]))
            frozen = json.loads(snapshot.content)["request"]
            assert frozen["variables"] == plan["variables"] and frozen["maxRetries"] == 1
        assert "stored-only-on-server" not in model.calls[0]["body"]["messages"][1]["content"]
        assert (await c.get(base + f"/execution-plans/{plan['id']}")).json()["data"] == plan
        assert len(model.calls) == 1


async def test_agent_rejects_unoffered_and_foreign_references(site):
    """另一工作区的发布资源与凭空构造的 UUID 都不在本次提供的候选集内，即使符合提议结构也不得写入预览。"""
    c, _, ws, _, plan = await plan_fixture(site)
    other = await workspace(c, "other")
    async with emulator() as model:
        path, _, _ = await conversation(c, other, model)
        for version in (plan["suiteVersionId"], str(uuid4())):
            model.output = {
                "reply": "Ready",
                "proposal": {
                    "type": "SAVE_PLAN",
                    "plan": {
                        **{
                            k: v
                            for k, v in plan_input(plan).items()
                            if k not in {"revision", "variables"}
                        },
                        "suiteVersionId": version,
                    },
                },
            }
            turn = await submit(c, path, "Find reusable cases")
            assert turn["status"] == "FAILED" and "proposal" not in turn
            assert plan["id"] not in model.calls[-1]["body"]["messages"][1]["content"]


async def test_agent_provider_call_is_private_and_charged(site):
    """供应商调用记入普通预算但不进入共享历史；即使得到记账标识也无法通过普通详情、取消或审核访问对话。"""
    c, db = site
    ws = await _scope(c)
    async with emulator() as model:
        path, provider, config = await conversation(c, ws, model)
        model.output = {"reply": "Which environment should we cover?"}
        text = "private requirements for payroll"
        turn = await submit(c, path, text)
        assert turn["reply"] == model.output["reply"]
        async with db.sessions.begin() as s:
            usage = (await s.scalars(select(AiGeneration))).one()
            assert usage.cost_micros == 160
            assert text not in json.dumps(usage.data)
        budget = (await c.get(provider)).json()["data"]["budget"]
        assert budget["estimatedUsedUsd"] == 0.00016 and budget["heldUsd"] == 0
        hist = f"/api/v1/workspaces/{ws}/ai/generations"
        assert (await c.get(hist)).json()["data"]["items"] == []
        assert (await c.get(hist + "/" + usage.id)).status_code == 404
        assert (await c.post(f"{hist}/{usage.id}/cancel")).status_code == 404
        assert (
            await c.post(f"{hist}/{usage.id}/review", json={"decision": "REJECT"})
        ).status_code == 404
        config.pop("apiKey")
        assert (await c.put(provider, json={**config, "enabled": False})).is_success
        disabled = await c.post(path, json={"requestId": str(uuid4()), "text": "More"})
        assert disabled.json()["code"] == "AI_PROVIDER_DISABLED"
        assert (await c.put(provider, json={**config, "monthlyBudgetUsd": 0.001})).is_success
        exhausted = await c.post(path, json={"requestId": str(uuid4()), "text": "More"})
        assert exhausted.status_code == 429
        assert len(model.calls) == 1


async def test_agent_running_replay_expiry_and_late_result_fencing(site):
    """供应商阻塞期间重放可看到真实运行中轮次，超过调用期限后读取恢复失败，原调用迟到也不能写入提议。"""
    c, db = site
    ws = await _scope(c)
    async with emulator() as model:
        path, _, _ = await conversation(c, ws, model)
        model.output = {"reply": "Late response"}
        model.wait = True
        model.release.clear()
        rid = str(uuid4())
        task = asyncio.create_task(c.post(path, json={"requestId": rid, "text": "Plan"}))
        try:
            done, _ = await asyncio.wait(
                [task, asyncio.create_task(model.started.wait())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            assert task not in done, task.result().text if task in done else ""
            assert (await submit(c, path, "Plan", rid))["status"] == "RUNNING"
            async with db.sessions.begin() as s:
                pending = (await s.scalars(select(AgentTurn))).one()
                pending.created_at = now() - timedelta(minutes=5)
            history = (await c.get(path)).json()["data"]["items"]
            assert history[0]["status"] == "FAILED"
        finally:
            model.release.set()
            await task
        result = await submit(c, path, "Plan", rid)
        assert result["status"] == "FAILED" and "reply" not in result
        assert len(model.calls) == 1


async def test_model_patch_schema_matches_accepted_output(site):
    """直接验证实际线缆上的输出契约能够接受已有计划增量并排除服务端原值，保证模型指令与可接受响应一致。"""
    from jsonschema import Draft202012Validator

    c, _, ws, _, plan = await plan_fixture(site)
    async with emulator() as model:
        path, _, _ = await conversation(c, ws, model, adapter="ANTHROPIC")
        model.output = {
            "reply": "Rename",
            "proposal": {
                "type": "SAVE_PLAN",
                "planId": plan["id"],
                "plan": {"revision": 1, "name": "New title"},
            },
        }
        turn = await submit(c, path, "Rename the existing plan")
        body = model.calls[-1]["body"]
        assert "RUN_ONCE" in body["system"]
        schema = json.loads(body["messages"][0]["content"])["outputSchema"]
        validator = Draft202012Validator(schema)
        assert validator.is_valid(model.output)
        assert not validator.is_valid({"reply": "Rename", "proposal": turn["proposal"]})
        assert validator.is_valid(
            {
                "reply": "Retry",
                "proposal": {
                    "type": "RUN_ONCE",
                    "planId": plan["id"],
                    "planRevision": 1,
                    "selection": {"maxRetries": 1},
                },
            }
        )
        assert not validator.is_valid(
            {"reply": "Retry", "proposal": {"type": "RUN_ONCE", "selection": {"maxRetries": 1}}}
        )


async def test_confirmation_phrase_matches_action_and_current_permissions(site):
    """操作特定的确认文本不能误触另一类提议，已降为执行者的员工仍可确认运行，但不得付费向供应商提交新要求。"""
    from test_workspace import new_member, client

    c, _, ws, runtime, plan = await plan_fixture(site)
    base = f"/api/v1/workspaces/{ws}"
    member = await new_member(c, ws, role="EDITOR")
    shared = await c.put(
        base + f"/runtimes/{runtime['runnerId']}/grants",
        json={"workspaceId": ws, "userIds": [member], "sharedWithWorkspace": False},
    )
    assert shared.is_success, shared.text
    async with emulator() as model, client(c, "member@example.com") as employee:
        await conversation(c, ws, model)
        owned = await _create(employee, ws, "Member planning")
        path = _agent(ws) + f"/sessions/{owned['id']}/turns"
        model.output = {
            "reply": "Run",
            "proposal": {"type": "TRIGGER_PLAN", "planId": plan["id"], "planRevision": 1},
        }
        turn = await submit(employee, path, "Please run the smoke plan")
        assert turn["proposal"]["type"] == "TRIGGER_PLAN"
        mismatch = await employee.post(path, json={"requestId": str(uuid4()), "text": "确认保存"})
        assert (mismatch.status_code, mismatch.json().get("code")) == (
            409,
            "AGENT_CONFIRM_MISMATCH",
        )
        assert (
            await c.put(base + f"/members/{member}", json={"role": "EXECUTOR", "status": "ACTIVE"})
        ).is_success
        assert (
            await employee.post(path, json={"requestId": str(uuid4()), "text": "New plan"})
        ).status_code == 403
        confirmed = await submit(employee, path, "确认执行")
        assert confirmed["receipt"]["decision"] == "ENQUEUED"
        assert (
            await c.put(base + f"/members/{member}", json={"role": "VIEWER", "status": "ACTIVE"})
        ).is_success
        assert (await employee.post(f"{path}/{turn['id']}/confirm")).status_code == 403
        assert len(model.calls) == 1


async def test_agent_direct_case_run_and_authoritative_summary(site):
    """直接运行已发布单用例无需创建套件或计划，随后按明确编号查询的结果陈述来自当前报告，即使供应商猜错也能纠正。"""
    c, _, ws, _, plan = await plan_fixture(site)
    async with emulator() as model:
        path, _, _ = await conversation(c, ws, model)
        model.output = {"reply": "Which published case?"}
        await submit(c, path, "Find the reader cases covered by the suite")
        sent = json.loads(model.calls[0]["body"]["messages"][1]["content"])["context"]
        suite = next(a for a in sent["assets"] if a["versionId"] == plan["suiteVersionId"])
        case_id = suite["caseVersionIds"][0]
        assert suite["caseCount"] == 1
        selection = {
            k: plan[k] for k in ("browsers", "roleKeys", "environmentVersionId", "runtimeIds")
        }
        model.output = {
            "reply": "Run this case once",
            "proposal": {
                "type": "RUN_ONCE",
                "selection": {**selection, "caseVersionIds": [case_id]},
            },
        }
        turn = await submit(c, path, "Run only the reader case this time")
        run = (await c.post(f"{path}/{turn['id']}/confirm")).json()["data"]["receipt"]["runId"]
        other = await _create(c, ws, "Read report")
        model.output = {"reply": "All cases passed", "relatedRunId": run}
        read = await submit(c, _agent(ws) + f"/sessions/{other['id']}/turns", "Report for " + run)
        assert read["relatedRunId"] == run and model.output["reply"] not in read["reply"]
        report = (await c.get(f"/api/v1/workspaces/{ws}/runs/{run}/report")).json()["data"]
        assert report["run"]["state"] in read["reply"]


async def test_agent_model_output_withheld_after_provider_revocation(site):
    """上游等待期间允许管理员实际停用供应商，调用结束后记录已发生的费用并扣留结果，保留可恢复的失败轮次。"""
    c, _ = site
    ws = await _scope(c)
    async with emulator() as model:
        path, provider, config = await conversation(c, ws, model)
        model.output = {"reply": "This reply must be withheld"}
        model.wait = True
        model.release.clear()
        task = asyncio.create_task(c.post(path, json={"requestId": str(uuid4()), "text": "Plan"}))
        try:
            await asyncio.wait_for(model.started.wait(), timeout=5)
            config.pop("apiKey")
            assert (await c.put(provider, json={**config, "enabled": False})).is_success
        finally:
            model.release.set()
            completed = await task
        turn = completed.json()["data"]
        assert turn["status"] == "FAILED" and turn["errorCode"] == "AI_PROVIDER_DISABLED"
        assert "reply" not in turn and "proposal" not in turn
        assert (await c.get(provider)).json()["data"]["budget"]["estimatedUsedUsd"] == 0.00016


async def test_explicit_report_without_model_reference_uses_authoritative_state(site):
    """显式请求运行状态无需供应商正确回传标识，详细元数据已经到期时仍可读取范围内运行的真实摘要。"""
    from veriq_server.db import CaseExecution

    c, db, ws, _, plan = await plan_fixture(site)
    base = f"/api/v1/workspaces/{ws}"
    started = await c.post(
        base + f"/execution-plans/{plan['id']}/trigger",
        json={},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert started.is_success, started.text
    rid = started.json()["data"]["runId"]
    async with db.sessions.begin() as s:
        case = await s.scalar(select(CaseExecution).where(CaseExecution.run_id == rid))
        case.provenance = {**case.provenance, "metadataExpiredAt": "2026-01-01T00:00:00Z"}
    assert (await c.get(base + f"/runs/{rid}/report")).status_code == 410
    truth = (await c.get(base + f"/runs/{rid}")).json()["data"]
    async with emulator() as model:
        path, _, _ = await conversation(c, ws, model)
        model.output = {"reply": "All cases PASSED"}
        result = await submit(c, path, "Status of run " + rid.upper())
        assert result.get("relatedRunId") == rid
        assert truth["state"] in result["reply"] and "PASSED" not in result["reply"]
        wire = json.loads(model.calls[-1]["body"]["messages"][1]["content"])["context"]
        assert wire["runs"] == [
            {"runId": rid, "state": truth["state"], "outcome": truth.get("outcome")}
        ]


async def test_redacted_plan_name_remains_intact_on_unrelated_update(site):
    """模拟器实际收到的是引用脱敏占位符，而已有计划的非目标名称必须保持原有字面值，不能把占位符写回。"""
    c, _, ws, _, plan = await plan_fixture(site)
    target = f"/api/v1/workspaces/{ws}/execution-plans/{plan['id']}"
    title = "Verify secretRef error handling"
    assert (await c.put(target, json={**plan_input(plan), "name": title})).is_success
    async with emulator() as model:
        path, _, _ = await conversation(c, ws, model)
        model.output = {
            "reply": "Retry once",
            "proposal": {
                "type": "SAVE_PLAN",
                "planId": plan["id"],
                "plan": {"revision": 2, "maxCaseRetries": 1},
            },
        }
        turn = await submit(c, path, "Enable one retry on the saved plan")
        assert title not in model.calls[-1]["body"]["messages"][1]["content"]
        assert turn["proposal"]["plan"]["name"] == title
        assert (await c.post(f"{path}/{turn['id']}/confirm")).is_success
        assert (await c.get(target)).json()["data"]["name"] == title
        model.output["proposal"]["plan"] = {
            **turn["proposal"]["plan"],
            "revision": 3,
            "maxCaseRetries": 0,
            "name": "[WITHHELD_REFERENCE]",
        }
        full = await submit(c, path, "Reset retries")
        assert full["proposal"]["plan"]["name"] == title


async def test_role_and_browser_must_match_a_concrete_variant(site):
    """角色虽然属于所选环境，仍须匹配同一用例的角色和浏览器；套件覆盖角色生效且不能忽略套件的浏览器过滤。"""
    from test_runs_mysql import published
    from veriq_server.db import ResourceVersion

    c, db, ws, _, plan = await plan_fixture(site)
    async with db.sessions.begin() as s:
        suite = await s.get(ResourceVersion, plan["suiteVersionId"])
        env = await s.get(ResourceVersion, plan["environmentVersionId"])
        case_id = suite.document_json["document"]["cases"][0]["versionId"]
        env_doc = env.document_json["document"]
    role = {**env_doc["roles"][0], "roleKey": "admin"}
    env_id = await published(
        c, db, ws, "multi-role-env", "ENVIRONMENT", {**env_doc, "roles": [*env_doc["roles"], role]}
    )
    suite_id = await published(
        c,
        db,
        ws,
        "override-suite",
        "SUITE",
        {
            "schemaVersion": "1.0",
            "cases": [
                {"versionId": case_id, "roleKeys": ["admin"], "browsers": ["chromium"]},
                {"versionId": case_id, "roleKeys": ["reader"], "browsers": ["firefox"]},
            ],
        },
    )
    base = {
        "environmentVersionId": env_id,
        "browsers": ["chromium"],
        "runtimeIds": plan["runtimeIds"],
    }
    async with emulator() as model:
        path, _, _ = await conversation(c, ws, model)
        for values in (
            {"caseVersionIds": [case_id], "roleKeys": ["admin"]},
            {"suiteVersionId": suite_id, "roleKeys": ["reader"]},
        ):
            model.output = {
                "reply": "Ready to run",
                "proposal": {"type": "RUN_ONCE", "selection": {**base, **values}},
            }
            turn = await submit(c, path, "Check coverage")
            assert turn["status"] == "COMPLETED" and "proposal" not in turn
            assert "role" in turn["reply"] and "browser" in turn["reply"]
            assert (await c.post(f"{path}/{turn['id']}/confirm")).status_code == 409
        # 旧版曾允许保存这种选择，直接确认既有数据库中的预览也必须重新检查实际变体，不能派发空矩阵。
        old = AgentTurn(
            id=str(uuid4()),
            session_id=path.split("/")[-2],
            created_at=now(),
            request_id=str(uuid4()),
            text="Legacy request",
            status="COMPLETED",
            reply="Legacy preview",
            proposal=model.output["proposal"],
        )
        async with db.sessions.begin() as s:
            s.add(old)
        rejected = await c.post(f"{path}/{old.id}/confirm")
        assert (rejected.status_code, rejected.json()["code"]) == (422, "AGENT_NO_MATCHING_CASE")
        model.output["proposal"]["selection"]["roleKeys"] = ["admin"]
        valid = await submit(c, path, "Use the suite role override")
        assert valid["proposal"]["type"] == "RUN_ONCE"
        receipt = (await c.post(f"{path}/{valid['id']}/confirm")).json()["data"]["receipt"]
        report = await c.get(f"/api/v1/workspaces/{ws}/runs/{receipt['runId']}/report")
        assert report.json()["data"]["statistics"]["caseCount"] == 1


async def test_history_withholds_revoked_previous_plan_and_archived_selection(site):
    """已保存计划改用第二台设备后撤销旧设备，再归档另一个待确认提议所选的套件，两处历史引用都不能返回模型。"""
    from test_lease_mysql import device
    from test_runs_mysql import published
    from veriq_server.db import ResourceVersion

    c, db, ws, original, plan = await plan_fixture(site)
    replacement = await device(c, ws)
    async with db.sessions.begin() as s:
        suite = await s.get(ResourceVersion, plan["suiteVersionId"])
        suite_doc = suite.document_json["document"]
    extra = await published(c, db, ws, "extra-suite", "SUITE", suite_doc)
    async with db.sessions.begin() as s:
        extra_resource = (await s.get(ResourceVersion, extra)).resource_id
    async with emulator() as model:
        path, _, _ = await conversation(c, ws, model)
        model.output = {
            "reply": "Switch device",
            "proposal": {
                "type": "SAVE_PLAN",
                "planId": plan["id"],
                "plan": {"revision": 1, "runtimeIds": [replacement["runnerId"]]},
            },
        }
        switched = await submit(c, path, "Switch the device")
        assert (await c.post(f"{path}/{switched['id']}/confirm")).is_success
        model.output = {
            "reply": "Run extra suite",
            "proposal": {
                "type": "RUN_ONCE",
                "planId": plan["id"],
                "planRevision": 2,
                "selection": {"suiteVersionId": extra},
            },
        }
        assert "proposal" in await submit(c, path, "Try the other suite once")
        base = f"/api/v1/workspaces/{ws}"
        assert (await c.post(base + f"/runtimes/{original['runnerId']}/revoke", json={})).is_success
        assert (
            await c.patch(
                base + f"/resources/{extra_resource}", json={"archived": True, "name": "Extra"}
            )
        ).is_success
        model.output = {"reply": "Current coverage"}
        await submit(c, path, "List our available coverage")
        history = json.loads(model.calls[-1]["body"]["messages"][1]["content"])["context"][
            "history"
        ]
        assert all(x not in json.dumps(history) for x in (extra, original["runnerId"]))
