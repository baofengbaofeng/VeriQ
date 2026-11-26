"""通过真实员工接口核对对话标题、供应商摘要和流式期限，验证并发结算始终保留员工明确保存的标题。"""

import asyncio
import json
from datetime import timedelta
from uuid import uuid4

from emulator import emulator
from sqlalchemy import select
from test_agent_reasoning_gateway import _claude_events
from test_agent_sessions import _agent, _scope
from test_conversational_agent import conversation, submit

from veriq_server.db import AgentTurn
from veriq_server.service import now

async def test_automatic_title_tracks_topics_but_preserves_followup_context(site):
    """新会话随两次独立主题更新，简短的认可不会挤掉已有主题，且所有自动命名都复用正常模型调用。"""
    client, _ = site
    workspace = await _scope(client)
    collection = _agent(workspace) + "/sessions"
    async with emulator() as model:
        await conversation(client, workspace, model)
        model.output = {"reply": "I can help prepare that configuration."}
        created = await client.post(collection, json={})
        assert created.status_code == 201
        route = f"{collection}/{created.json()['data']['id']}"
        prompts = ["Configure checkout smoke", "Thanks", "配置会员数据集"]
        titles = ["Configure checkout smoke", "Configure checkout smoke", "配置会员数据集"]
        for prompt, title in zip(prompts, titles, strict=True):
            turn = await submit(client, route + "/turns", prompt)
            assert turn["status"] == "COMPLETED"
            assert (await client.get(route)).json()["data"]["title"] == title
        listed = (await client.get(collection)).json()["data"]["items"]
        assert listed[0]["title"] == titles[-1]
        assert len(model.calls) == len(prompts)


async def test_manual_title_wins_an_inflight_model_call(site):
    """等待本地模型协议请求进入受控阻塞点再命名，证明稍后成功结算不能覆盖已提交的手动标题。"""
    client, _ = site
    workspace = await _scope(client)
    collection = _agent(workspace) + "/sessions"
    async with emulator() as model:
        await conversation(client, workspace, model)
        model.output = {"reply": "Prepared configuration guidance."}
        created = (await client.post(collection, json={})).json()["data"]
        route = f"{collection}/{created['id']}"
        model.wait = True
        model.started.clear()
        model.release.clear()
        pending = asyncio.create_task(submit(client, route + "/turns", "Configure login tests"))
        try:
            await asyncio.wait_for(model.started.wait(), timeout=10)
            renamed = await client.patch(route, json={"title": "New conversation"})
            assert renamed.status_code == 200, renamed.text
        finally:
            model.release.set()
            turn = await pending
        assert turn["status"] == "COMPLETED"
        assert (await client.get(route)).json()["data"]["title"] == "New conversation"
        await submit(client, route + "/turns", f"Configure billing suite {uuid4()}")
        assert (await client.get(route)).json()["data"]["title"] == "New conversation"


async def test_stream_persists_only_the_redacted_provider_summary(site):
    """供应商把已知密钥拆在两个增量时，员工流式事件和重新加载的历史都只能读到整块脱敏后的推理摘要。"""
    client, _ = site
    workspace = await _scope(client)
    async with emulator() as model:
        path, _, _ = await conversation(
            client, workspace, model, adapter="ANTHROPIC", model="claude-sonnet-4-6"
        )
        model.stream_responses = [
            list(
                _claude_events(
                    [
                        (
                            {"type": "thinking", "thinking": "", "signature": ""},
                            [
                                {"type": "thinking_delta", "thinking": "Compare synthetic-"},
                                {"type": "thinking_delta", "thinking": "provider-key."},
                                {"type": "signature_delta", "signature": "provider-signature"},
                            ],
                        ),
                        ({"type": "text", "text": ""}, [{"type": "text_delta", "text": "Ready"}]),
                    ],
                    stop_reason="end_turn",
                )
            )
        ]
        response = await client.post(
            path + "/stream", json={"requestId": str(uuid4()), "text": "Check the setup"}
        )
        assert response.is_success, response.text
        assert response.headers["content-type"] == "text/event-stream"
        assert (
            "synthetic-provider-key" not in response.text
            and "provider-signature" not in response.text
        )
        events = [event.partition("\ndata: ") for event in response.text.strip().split("\n\n")]
        parsed = {kind: json.loads(body) for kind, _, body in events}
        expected = "Compare [REDACTED]."
        assert parsed["event: thinking"] == {"text": expected}
        assert parsed["event: done"]["thinking"] == expected
        persisted = (await client.get(path)).json()["data"]["items"]
        assert persisted[0]["thinking"] == expected


async def test_reading_history_does_not_expire_a_live_stream_at_sixty_seconds(site):
    """流式调用的真实等待时间长于非流式补全，历史轮询不得在允许的等待预算内将同一个进行中轮次提前封存。"""
    client, database = site
    workspace = await _scope(client)
    async with emulator() as model:
        path, _, _ = await conversation(
            client, workspace, model, adapter="ANTHROPIC", model="claude-sonnet-4-6"
        )
        model.stream_responses = [
            list(
                _claude_events(
                    [({"type": "text", "text": ""}, [{"type": "text_delta", "text": "Ready"}])],
                    stop_reason="end_turn",
                )
            )
        ]
        model.wait = True
        model.release.clear()
        payload = {"requestId": str(uuid4()), "text": "Check the setup"}
        request = asyncio.create_task(client.post(path + "/stream", json=payload))
        try:
            await asyncio.wait_for(model.started.wait(), timeout=10)
            async with database.sessions.begin() as session:
                pending = (await session.scalars(select(AgentTurn))).one()
                pending.created_at = now() - timedelta(minutes=2)
            history = (await client.get(path)).json()["data"]["items"]
            assert history[0]["status"] == "RUNNING"
        finally:
            model.release.set()
            await request
        completed = (await client.get(path)).json()["data"]["items"]
        assert completed[0]["status"] == "COMPLETED"
