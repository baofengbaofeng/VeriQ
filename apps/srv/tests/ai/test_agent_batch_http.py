"""流式对话只把完整的草稿组交给员工审阅，确认一次产生有序的真实资源回执，后续模型历史不含配置原文。"""

from copy import deepcopy
import json
from uuid import uuid4

from emulator import emulator
from sqlalchemy import select
from test_agent_configuration import _completion_delta, _tool_delta
from test_auth import login, setup
from test_conversational_agent import conversation, submit
from test_publish import CATALOG
from test_workspace import workspace

from veriq_server.db import Resource


async def test_review_one_batch_then_replay_its_ordered_receipts(site):
    """受控供应商准备两个草稿后只得到项数，员工可核对完整内容，重复确认不能再创建资源或推动修订。"""
    client, db = site
    await setup(client)
    await login(client)
    wid = await workspace(client)
    items = []
    for key in ("first", "second"):
        content = deepcopy(CATALOG)
        content["document"]["elements"][0]["locator"]["value"] = f"private-locator-{key}"
        items.append(
            {
                "type": "SAVE_RESOURCE_DRAFT",
                "resource": {
                    "kind": "ELEMENT_CATALOG",
                    "key": key,
                    "name": key,
                    "content": content,
                },
            }
        )
    group = {"type": "SAVE_RESOURCE_DRAFTS", "items": items}
    async with emulator() as model:
        turns, _, _ = await conversation(client, wid, model)
        model.stream_responses[:] = [
            [_tool_delta("prepare_resource_batch_v1", {"proposal": group}, "prepare-two-drafts")],
            [_completion_delta({"content": "Review these two draft changes together."}, "stop")],
        ]
        response = await client.post(
            turns + "/stream",
            json={
                "requestId": str(uuid4()),
                "text": "Prepare these two draft changes for one review.",
            },
        )
        assert response.is_success, response.text
        lines = response.text.splitlines()
        turn = json.loads(lines[lines.index("event: done") + 1].removeprefix("data: "))
        assert turn["proposal"] == group
        tool_reply = next(
            m["content"] for m in model.calls[-1]["body"]["messages"] if m["role"] == "tool"
        )
        assert json.loads(tool_reply) == {"type": "SAVE_RESOURCE_DRAFTS", "itemCount": 2}
        async with db.sessions() as s:
            assert await s.scalar(select(Resource.id)) is None
        confirm = f"{turns}/{turn['id']}/confirm"
        first = await client.post(confirm)
        assert first.is_success, first.text
        receipt = first.json()["data"]["receipt"]
        assert receipt["type"] == "SAVE_RESOURCE_DRAFTS" and len(receipt["items"]) == 2
        assert (await client.post(confirm)).json()["data"]["receipt"] == receipt
        for source, saved in zip(items, receipt["items"], strict=True):
            assert (saved["type"], saved["revision"], saved["kind"]) == (
                "SAVE_RESOURCE_DRAFT",
                1,
                "ELEMENT_CATALOG",
            )
            path = f"/api/v1/workspaces/{wid}/resources/{saved['resourceId']}"
            assert (await client.get(path)).json()["data"]["key"] == source["resource"]["key"]
            assert (await client.get(path + "/draft")).json()["data"]["content"] == source[
                "resource"
            ]["content"]
        model.output = {"reply": "Both changes are saved."}
        await submit(client, turns, "Which draft changes have been saved?")
        assert "private-locator" not in json.dumps(model.calls[-1]["body"])
