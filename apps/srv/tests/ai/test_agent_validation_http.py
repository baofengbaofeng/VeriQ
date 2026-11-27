"""从真实对话接口准备资源校验，验证人员确认与回执重放分别遵循共享表单契约、工作区授权与队列幂等。"""

import json
from uuid import uuid4

from emulator import emulator
from sqlalchemy import func, select
from test_agent_configuration import _completion_delta, _tool_delta
from test_auth import login, setup
from test_conversational_agent import conversation, submit
from test_publish import create
from test_workspace import workspace

from veriq_server.db import Job, WorkspaceMember


async def test_turn_validation_confirmation_replays_only_with_current_access(site):
    """从正常对话送入资源与修订，只在确认请求后排队；重复确认复用真实作业，后续撤销编辑权时拒绝旧回执重放。"""
    client, db = site
    await setup(client)
    await login(client)
    workspace_id = await workspace(client)
    uid = (await client.get("/api/v1/account")).json()["data"]["id"]
    resource = await create(client, workspace_id)
    rid = resource.rsplit("/", 1)[1]
    preview = (await client.get(resource + "/validation-preview")).json()["data"]
    async with emulator() as model:
        turns, _, _ = await conversation(client, workspace_id, model)
        model.output = {
            "reply": "Review this exact draft before queueing validation.",
            "proposal": {"type": "VALIDATE_RESOURCE", "resourceId": rid, "revision": 1},
        }
        turn = await submit(client, turns, f"Validate resource {rid} revision 1")
        assert turn["proposal"] == {**model.output["proposal"], "sourceHash": preview["sourceHash"]}
        async with db.sessions() as session:
            assert await session.scalar(select(func.count()).select_from(Job)) == 0
        confirm = f"{turns}/{turn['id']}/confirm"
        first = await client.post(confirm)
        assert first.is_success, first.text
        receipt = first.json()["data"]["receipt"]
        assert receipt == {**turn["proposal"], "validationJobId": receipt["validationJobId"]}
        assert (await client.post(confirm)).json()["data"]["receipt"] == receipt
        await _assert_streamed_progress(client, turns, model, receipt)
        async with db.sessions.begin() as session:
            assert (await session.scalars(select(Job.id))).all() == [receipt["validationJobId"]]
            member = await session.get(WorkspaceMember, (workspace_id, uid))
            member.role = "VIEWER"
        denied = await client.post(confirm)
        assert denied.status_code == 403


async def _assert_streamed_progress(client, turns, model, receipt):
    """通过本机供应商协议触发真实的进度查询，核对工具回传的内容与员工收到的编译回执一致且不含业务正文。"""
    model.stream_responses[:] = [
        [
            _tool_delta(
                "get_validation_progress_v1",
                {"validationJobId": receipt["validationJobId"]},
                "read-validation",
            )
        ],
        [_completion_delta({"content": "Validation is queued."}, "stop")],
    ]
    streamed = await client.post(
        turns + "/stream",
        json={
            "requestId": str(uuid4()),
            "text": "Check progress of the validation we just queued.",
        },
    )
    assert streamed.is_success, streamed.text
    lines = streamed.text.splitlines()
    done = json.loads(lines[lines.index("event: done") + 1].removeprefix("data: "))
    assert [(step["name"], step["status"]) for step in done["steps"]] == [
        ("get_validation_progress_v1", "SUCCEEDED")
    ]
    messages = model.calls[-1]["body"]["messages"]
    progress = json.loads(
        next(message["content"] for message in messages if message["role"] == "tool")
    )
    assert progress == {key: value for key, value in receipt.items() if key != "type"} | {
        "state": "QUEUED"
    }
