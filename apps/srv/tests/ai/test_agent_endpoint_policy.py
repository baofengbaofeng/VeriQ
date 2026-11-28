"""通过真实会话与本机模型协议验证出口授权撤销前后的历史边界、付费调用次数、流式披露和预留结算。"""

import asyncio
import json
from uuid import uuid4

import pytest
from emulator import emulator
from sqlalchemy import select
from test_agent_configuration import _completion_delta, _dataset, _tool_delta
from test_agent_reasoning_gateway import _claude_events
from test_agent_sessions import _scope
from test_conversational_agent import conversation, submit

from veriq_server.db import AiGeneration
from veriq_server.infrastructure.providers import DraftContext, ProviderGateway
from veriq_server.services.ai import AiService


@pytest.mark.parametrize("stream", [False, True])
async def test_revocation_between_reservation_and_dispatch(site, monkeypatch, stream):
    """在真实预留成功后撤销运营方许可，普通和流式轮次都不应送出请求；此前合法保存的普通会话仍可恢复。"""
    c, db = site
    ws = await _scope(c)
    async with emulator() as model:
        path, _, _ = await conversation(c, ws, model)
        model.output = {
            "reply": "Review the proposed sample dataset.",
            "proposal": {"type": "SAVE_RESOURCE_DRAFT", "resource": _dataset()},
        }
        previous = await submit(c, path, "Create a static sample dataset")
        assert previous["status"] == "COMPLETED"
        reserve = AiService.reserve_usage

        async def revoke_after_reserve(service, *args, **kwargs):
            """用正常账本方法建立预留，在返回业务编排器前直接变更部署许可，以稳定覆盖两次事务之间的窗口。"""
            usage = await reserve(service, *args, **kwargs)
            service.settings.ai_allowed_base_urls.remove(model.base_url)
            return usage

        monkeypatch.setattr(AiService, "reserve_usage", revoke_after_reserve)
        url = f"{path}/stream" if stream else path
        denied = await c.post(url, json={"requestId": str(uuid4()), "text": "Review my plan"})
        assert denied.is_success, denied.text
        assert len(model.calls) == 1
        assert "AI_ENDPOINT_FORBIDDEN" in denied.text
        history = (await c.get(path)).json()["data"]["items"]
        assert next(item for item in history if item["id"] == previous["id"]) == previous
        confirmed = await c.post(f"{path}/{previous['id']}/confirm")
        assert confirmed.is_success, confirmed.text
        receipt = confirmed.json()["data"]["receipt"]
        assert receipt["kind"] == "DATASET" and receipt["revision"] == 1
        assert len(model.calls) == 1
        async with db.sessions() as session:
            failed = await session.scalar(
                select(AiGeneration).where(AiGeneration.status == "FAILED")
            )
            assert failed.cost_micros == 0


@pytest.mark.parametrize(
    ("adapter", "reports_usage"),
    [("OPENAI_COMPATIBLE", True), ("OPENAI_COMPATIBLE", False), ("ANTHROPIC", True)],
)
async def test_stream_revocation_blocks_tool_followup_and_settles_usage(
    site, adapter, reports_usage, monkeypatch
):
    """在供应商已收到首轮后撤销当前选择；首轮已产生的费用照实结算，后续内容、工具回填与下一次请求均被拦截。"""
    c, db = site
    ws = await _scope(c)
    async with emulator() as model:
        model_name = "claude-sonnet-4-6" if adapter == "ANTHROPIC" else "emulator"
        path, _, _ = await conversation(c, ws, model, adapter=adapter, model=model_name)
        policy = None
        reserve = AiService.reserve_usage

        async def capture_policy(service, *args, **kwargs):
            """取得真实处理器使用的部署配置引用，随后待真实请求到达才撤销许可，生产授权逻辑与上游 SDK 均照常运行。"""
            nonlocal policy
            policy = service.settings.ai_allowed_base_urls
            return await reserve(service, *args, **kwargs)

        monkeypatch.setattr(AiService, "reserve_usage", capture_policy)
        text = "Private model fragment"
        name = "find_configuration_v1"
        if adapter == "ANTHROPIC":
            blocks = [
                (
                    {"type": "thinking", "thinking": "", "signature": ""},
                    [
                        {"type": "thinking_delta", "thinking": "Private summary"},
                        {"type": "signature_delta", "signature": "test-signature"},
                    ],
                ),
                ({"type": "text", "text": ""}, [{"type": "text_delta", "text": text}]),
                ({"type": "tool_use", "id": "tool_test", "name": name, "input": {}}, []),
            ]
            events = list(_claude_events(blocks, stop_reason="tool_use"))
        else:
            usage = {"prompt_tokens": 50, "completion_tokens": 30, "total_tokens": 80}
            events = [
                _completion_delta({"content": text}, None),
                _tool_delta(name, {}, "tool_test"),
            ]
            if reports_usage:
                events[-1]["usage"] = usage
        model.stream_responses = [events, events]
        model.wait = True
        model.release.clear()
        task = asyncio.create_task(
            c.post(
                f"{path}/stream", json={"requestId": str(uuid4()), "text": "Review configuration"}
            )
        )
        try:
            await asyncio.wait_for(model.started.wait(), 8)
            assert policy is not None
            policy.remove(model.base_url)
        finally:
            model.release.set()
        response = await task
        assert response.is_success, response.text
        assert len(model.calls) == 1
        assert "AI_ENDPOINT_FORBIDDEN" in response.text
        assert "event: delta" not in response.text and "event: step" not in response.text
        assert "event: thinking" not in response.text and "Private summary" not in response.text
        assert text not in response.text
        async with db.sessions() as session:
            usage_row = (await session.scalars(select(AiGeneration))).one()
            body = model.calls[0]["body"]
            prompt = {key: body[key] for key in ("system", "messages", "tools") if key in body}
            prompt_bytes = len(
                json.dumps(prompt, ensure_ascii=False, separators=(",", ":")).encode()
            )
            assert usage_row.data["inputTokenBound"] >= (prompt_bytes + 8192) * 4
            assert (
                usage_row.reserved_micros
                >= usage_row.data["inputTokenBound"] + 2 * 4 * body["max_tokens"]
            )
            assert usage_row.status == "FAILED"
            assert usage_row.cost_micros == (110 if reports_usage else None)


async def _unexpected_callback(*_args):
    pytest.fail("No model callback should run")


async def test_round_denied_before_first_sdk_request_retains_no_charge():
    """网关收到首轮拒绝时直接返回零用量；通过环回端点记录确认没有发送包含凭据或上下文的请求。"""

    async def denied():
        return "AI_ENDPOINT_FORBIDDEN"

    async with emulator(port=0) as model:
        gateway = ProviderGateway(
            config={"baseURL": model.base_url, "adapter": "ANTHROPIC", "model": "emulator"},
            key="test",
        )
        reply = await gateway.generate_agent_stream(
            DraftContext({}, {}, 20),
            [],
            _unexpected_callback,
            None,
            _unexpected_callback,
            authorize_round=denied,
        )
        assert not model.calls
        assert (reply.error_code, reply.input_tokens, reply.output_tokens) == (
            "AI_ENDPOINT_FORBIDDEN",
            0,
            0,
        )


@pytest.mark.parametrize("adapter", ["ANTHROPIC", "OPENAI_COMPATIBLE"])
async def test_stream_tool_schema_exceeding_round_limit_is_never_sent(adapter):
    """验证首轮也将完整工具声明计入请求上限，超限时不向供应商发送任何请求，并将确定未发出的调用用量记为零。"""
    async with emulator(port=0) as model:
        gateway = ProviderGateway(
            {"adapter": adapter, "baseURL": model.base_url, "model": "emulator"}, "test"
        )
        tools = [{"name": "check", "description": "查" * 90000, "parameters": {"type": "object"}}]
        reply = await gateway.generate_agent_stream(
            DraftContext({}, {}, 100), tools, _unexpected_callback, None, _unexpected_callback
        )
        assert not model.calls
        assert (reply.error_code, reply.input_tokens, reply.output_tokens) == (
            "AI_REQUEST_LIMIT",
            0,
            0,
        )


@pytest.mark.parametrize(
    ("adapter", "reports_usage"),
    [("OPENAI_COMPATIBLE", True), ("OPENAI_COMPATIBLE", False), ("ANTHROPIC", True)],
)
async def test_stream_history_exceeding_reservation_stops_before_followup(adapter, reports_usage):
    """两次请求各自都低于冻结总额，合计超过预留时停止；只结算已发送轮次，缺失用量时保留预留。"""

    async def large_result(name, arguments):
        assert name == "check" and arguments == {}
        return {"result": "测" * 1400}

    async with emulator(port=0) as model:
        if adapter == "ANTHROPIC":
            events = list(
                _claude_events(
                    [({"type": "tool_use", "id": "tool_test", "name": "check", "input": {}}, [])],
                    stop_reason="tool_use",
                )
            )
            events[0]["message"]["usage"]["input_tokens"] = 6000
        else:
            events = [_tool_delta("check", {}, "tool_test")]
            if reports_usage:
                events[0]["usage"] = {
                    "prompt_tokens": 6000,
                    "completion_tokens": 30,
                    "total_tokens": 6030,
                }
        model.stream_responses = [events, events]
        gateway = ProviderGateway(
            {"adapter": adapter, "baseURL": model.base_url, "model": "emulator"}, "test"
        )
        tools = [{"name": "check", "description": "Check", "parameters": {"type": "object"}}]
        reply = await gateway.generate_agent_stream(
            DraftContext({}, {}, 100), tools, _unexpected_callback, None, large_result, max_rounds=2
        )
        assert len(model.calls) == 1
        assert reply.error_code == "AI_REQUEST_LIMIT"
        assert (reply.input_tokens, reply.output_tokens) == (
            (6000, 30) if reports_usage else (None, None)
        )
