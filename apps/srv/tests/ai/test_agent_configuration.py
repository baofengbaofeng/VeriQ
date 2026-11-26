"""验证模型只能准备可审阅的配置草稿，由已获授权的员工确认写入，旧修订和其他空间的引用仍被拒绝。"""

import base64
import json
from urllib.parse import quote
from uuid import uuid4

import pytest
from emulator import emulator
from jsonschema import ValidationError
from test_auth import login, setup
from test_conversational_agent import conversation, submit
from test_workspace import workspace

from veriq_server.db import AgentTurn
from veriq_server.service import Problem, now
from veriq_server.services.agent_reply_stream import (
    ReplyStreamRedactor,
    guard_agent_stream,
    sanitize_stream_reply,
)
from veriq_server.services.agent_tools import resolve_tool, sanitize_proposal_output
from veriq_server.services.conversational_agent import ConversationalAgent, _tool_catalog
from veriq_server.validation import validate_api


def _dataset():
    """构造没有连接或凭据的静态测试数据集，后续用同一输入同时检查模型合同和普通资源编辑器读到的内容。"""
    return {
        "kind": "DATASET",
        "key": "agent-samples",
        "name": "Agent samples",
        "content": {
            "kind": "DATASET",
            "document": {
                "schemaVersion": "2.0",
                "shape": "TABLE",
                "fields": {"name": {"type": "string", "required": True, "nullable": False}},
                "source": {"kind": "STATIC", "rows": [{"key": "first", "values": {"name": "One"}}]},
            },
        },
    }


def test_resource_proposal_and_receipt_are_public_contracts():
    """旧提议合同只允许计划与运行，资源候选及保存回执必须能由同一严格验证器校验，供聊天与编辑器共享。"""
    validate_api("AgentProposal", {"type": "SAVE_RESOURCE_DRAFT", "resource": _dataset()})
    validate_api(
        "AgentReceipt",
        {
            "type": "SAVE_RESOURCE_DRAFT",
            "resourceId": str(uuid4()),
            "revision": 1,
            "kind": "DATASET",
        },
    )


def test_tool_catalog_resolves_versioned_capabilities_and_rejects_invalid_arguments():
    """旧名称仍路由到同一份受验证能力，模型选择不存在的版本或把 HTTP 请求字段塞进业务工具时立即拒绝。"""
    catalog = _tool_catalog()
    assert resolve_tool(catalog, "get_run_status") is catalog["get_run_status_v1"]
    assert resolve_tool(catalog, "preview_proposal") is catalog["prepare_execution_action_v1"]
    find = resolve_tool(catalog, "find_configuration_v1")
    find.validate_arguments({"kind": "DATASET", "resourceId": str(uuid4())})
    with pytest.raises(Problem) as invalid:
        find.validate_arguments({"kind": "DATASET", "path": "/api/v1"})
    assert invalid.value.code == "AGENT_TOOL_ARGUMENTS_INVALID"
    with pytest.raises(Problem) as unknown:
        resolve_tool(catalog, "find_configuration_v2")
    assert unknown.value.code == "AGENT_TOOL_UNKNOWN"


def test_resource_preview_rejects_protected_data_instead_of_mutating_the_draft():
    """供应商回显受保护值时不能把脱敏占位值放进待保存文档，同一个正常草稿仍可给用户逐项确认配置。"""
    dataset = _dataset()
    proposed = {
        "reply": "Review the draft",
        "proposal": {"type": "SAVE_RESOURCE_DRAFT", "resource": dataset},
    }
    assert sanitize_proposal_output(proposed, {"test-private-provider-key"}) == proposed
    dataset["content"]["document"]["source"]["rows"][0]["values"][
        "name"
    ] = "test-private-provider-key"
    with pytest.raises(Problem) as rejected:
        sanitize_proposal_output(proposed, {"test-private-provider-key"})
    assert rejected.value.code == "AGENT_RESOURCE_INVALID"
    assert "test-private-provider-key" not in rejected.value.message


async def test_invalid_stream_payload_does_not_mutate_reserved_turn():
    """工具状态校验失败时持久化轮次应保留空结果，客户端重新打开历史也不能读到验证失败的输出或提议。"""
    turn = AgentTurn(
        id=str(uuid4()), text="Configure a dataset", created_at=now(), status="RUNNING"
    )
    proposal = {"type": "SAVE_RESOURCE_DRAFT", "resource": _dataset()}
    service = object.__new__(ConversationalAgent)
    with pytest.raises(ValidationError):
        await service._accept_stream(
            None,
            None,
            None,
            turn,
            "Review the proposal",
            proposal,
            str(uuid4()),
            [{"name": "bad_step", "status": "RUNNING"}],
            "Provider summary",
        )
    assert turn.reply is None and turn.proposal is None
    assert turn.steps is None and turn.reasoning_summary is None and turn.related_run_id is None


def test_secret_variants_are_hidden_across_every_stream_boundary():
    """三个供应商密钥表示随机拆分也只能送出遮蔽文本，无关的回复开头无需等到整条模型回复后才显示。"""
    secret = "test+private/provider-key"
    for variant in (secret, quote(secret, safe=""), base64.b64encode(secret.encode()).decode()):
        for boundary in range(1, len(variant)):
            redactor = ReplyStreamRedactor({secret})
            first = redactor.feed(f"Working: {variant[:boundary]}")
            assert first == "Working: "
            remaining = redactor.feed(f"{variant[boundary:]} ready.") + redactor.finish()
            assert remaining == "[REDACTED] ready."


@pytest.mark.parametrize("marker", ["secretRef", "{{secret"])
def test_split_reference_marker_prevents_streaming_the_rest(marker):
    """引用的真实名字不一定已知，检测到跨增量拼成的引用标记后，后续值始终留在服务端并由完成事件替换。"""
    redactor = ReplyStreamRedactor(set())
    assert redactor.feed("A reference: " + marker[:4]) == "A reference: "
    assert redactor.feed(marker[4:] + " private-name") == "[WITHHELD_REFERENCE]"
    assert redactor.feed("more private material") + redactor.finish() == ""
    assert sanitize_stream_reply(marker + " private-name", {marker}) == "[WITHHELD_REFERENCE]"


async def test_stream_stops_publishing_after_current_access_is_lost():
    """实时授权成功后首帧可立即发送，后续权限撤销时阻止工具和回复帧，原连接不因短时重新授权而恢复写入。"""
    events = []
    authorized = True

    async def authorize():
        if not authorized:
            raise Problem(403, "FORBIDDEN", "Workspace permission denied")

    async def emit(event, data):
        events.append((event, data))

    publish = guard_agent_stream(authorize, emit)
    assert await publish("delta", {"text": "First"})
    authorized = False
    assert not await publish("delta", {"text": "After revocation"})
    authorized = True
    assert not await publish("step", {"name": "find_configuration_v1"})
    assert events == [("delta", {"text": "First"})]


async def test_agent_dataset_draft_confirmation_and_stale_revision(site):
    """通过员工会话准备数据集后，只有确认才产生实际草稿；重放取原回执，其他页面先保存时旧确认失败。"""
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c, "agent-config")
    resources = f"/api/v1/workspaces/{ws}/resources"
    dataset = _dataset()
    async with emulator() as model:
        path, _, _ = await conversation(c, ws, model)
        create = {"type": "SAVE_RESOURCE_DRAFT", "resource": dataset}
        model.output = {"reply": "Review the proposed dataset draft.", "proposal": create}
        first = await submit(c, path, "Create a static dataset with a single sample")
        assert first["proposal"] == create
        assert (await c.get(resources, params={"kind": "DATASET"})).json()["data"]["items"] == []
        confirmation = f"{path}/{first['id']}/confirm"
        result = await c.post(confirmation)
        assert result.is_success, result.text
        saved = result.json()["data"]["receipt"]
        assert saved == {
            "type": "SAVE_RESOURCE_DRAFT",
            "resourceId": saved["resourceId"],
            "revision": 1,
            "kind": "DATASET",
        }
        assert (await c.post(confirmation)).json()["data"]["receipt"] == saved
        rid = saved["resourceId"]
        draft = f"{resources}/{rid}/draft"
        current = (await c.get(draft)).json()["data"]
        assert current["content"] == dataset["content"]
        model.output["proposal"] = {**create, "resourceId": rid, "revision": 1}
        second = await submit(c, path, f"Update the dataset draft {rid}")
        assert second["proposal"]["revision"] == 1
        assert (await c.put(draft, json={"revision": 1, "content": current["content"]})).is_success
        stale = await c.post(f"{path}/{second['id']}/confirm")
        assert stale.status_code == 409
        assert stale.json()["code"] == "STALE_REVISION"


async def test_agent_cannot_propose_replacing_another_workspace_draft(site):
    """即使员工分别拥有两个空间，将另一空间内的已知资源编号用于当前会话仍然不能生成可确认的提议。"""
    c, _ = site
    await setup(c)
    await login(c)
    current = await workspace(c, "agent-current")
    foreign = await workspace(c, "agent-foreign")
    resource = _dataset()
    saved = await c.post(f"/api/v1/workspaces/{foreign}/resources", json=resource)
    assert saved.is_success, saved.text
    rid = saved.json()["data"]["id"]
    async with emulator() as model:
        path, _, _ = await conversation(c, current, model)
        model.output = {
            "reply": "Replace the selected draft.",
            "proposal": {
                "type": "SAVE_RESOURCE_DRAFT",
                "resource": resource,
                "resourceId": rid,
                "revision": 1,
            },
        }
        turn = await submit(c, path, f"Replace draft {rid}")
        assert turn["status"] == "FAILED"
        assert "proposal" not in turn


def _completion_delta(delta, finish):
    """为本机协议端点构造 SDK 可消费的实际补全增量，结束理由让网关进入下一轮工具调用或完成员工回复。"""
    return {
        "id": "chatcmpl_agent_config",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "emulator",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def _tool_delta(name, arguments, call_id):
    """由供应商协议提供函数名及编码参数，服务端必须按登记的版本解析，再产生下一轮可观察到的工具结果。"""
    call = {
        "index": 0,
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }
    return _completion_delta({"tool_calls": [call]}, "tool_calls")


async def test_streamed_configuration_discovery_proposes_but_does_not_save(site):
    """经过真实供应商 SDK 的流式对话可定位已有配置并准备修订，工具只给模型表结构，用户看到待审阅的新草稿。"""
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c, "stream-agent-config")
    resources = f"/api/v1/workspaces/{ws}/resources"
    existing = _dataset()
    existing["content"]["document"]["source"]["rows"][0]["values"][
        "name"
    ] = "private-unselected-row-value"
    response = await c.post(resources, json=existing)
    assert response.is_success, response.text
    rid = response.json()["data"]["id"]
    proposal = {
        "type": "SAVE_RESOURCE_DRAFT",
        "resourceId": rid,
        "revision": 1,
        "resource": _dataset(),
    }
    async with emulator() as model:
        path, _, provider = await conversation(c, ws, model)
        key = provider["apiKey"]
        model.stream_responses[:] = [
            [_tool_delta("find_configuration_v1", {"resourceId": rid}, "lookup-dataset")],
            [_tool_delta("prepare_resource_draft_v1", {"proposal": proposal}, "review-dataset")],
            [
                _completion_delta(
                    {"content": f"Review the replacement dataset draft. {key[:5]}"}, None
                ),
                _completion_delta({"content": key[5:]}, "stop"),
            ],
        ]
        result = await c.post(
            f"{path}/stream",
            json={"requestId": str(uuid4()), "text": "Review a sample dataset replacement"},
        )
        assert result.is_success, result.text
        lines = result.text.splitlines()
        done = json.loads(lines[lines.index("event: done") + 1].removeprefix("data: "))
        live_reply = "".join(
            json.loads(lines[index + 1].removeprefix("data: "))["text"]
            for index, line in enumerate(lines)
            if line == "event: delta"
        )
        assert live_reply == done["reply"] == "Review the replacement dataset draft. [REDACTED]"
        assert done["proposal"] == proposal
        assert [(step["name"], step["status"]) for step in done["steps"]] == [
            ("find_configuration_v1", "SUCCEEDED"),
            ("prepare_resource_draft_v1", "SUCCEEDED"),
        ]
        tools = [tool["function"]["name"] for tool in model.calls[0]["body"]["tools"]]
        assert "find_configuration_v1" in tools and "prepare_resource_draft_v1" in tools
        messages = model.calls[1]["body"]["messages"]
        lookup = json.loads(
            next(message["content"] for message in messages if message["role"] == "tool")
        )
        assert lookup["draft"]["rowCount"] == 1
        assert "private-unselected-row-value" not in json.dumps(lookup)
        draft_url = f"{resources}/{rid}/draft"
        assert (await c.get(draft_url)).json()["data"]["content"] == existing["content"]
        confirm = await submit(c, path, "confirm draft", expected_proposal=done["id"])
        assert confirm["receipt"]["revision"] == 2
        assert (await c.get(draft_url)).json()["data"]["content"] == proposal["resource"]["content"]
