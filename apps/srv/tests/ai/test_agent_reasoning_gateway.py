"""通过本机 SSE 协议响应验证真实 SDK 交给对话层的推理摘要与回复，涵盖不同适配器的隔离边界。"""

from functools import partial

from emulator import emulator

from veriq_server.infrastructure.providers import DraftContext, ProviderGateway


async def _noop_tool(_name, _arguments):
    return {"accepted": True}


async def _collect(parts, text):
    parts.append(text)


async def test_chat_completion_does_not_emit_raw_reasoning_content():
    """兼容接口可能附带原始推理扩展字段，即使收到该字段，服务端也只公开独立的正常回复内容。"""
    async with emulator(port=0) as model:
        model.stream_responses = [
            [
                {
                    "id": "chatcmpl_test",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": "emulator",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"reasoning_content": "private analysis", "content": "Ready"},
                            "finish_reason": "stop",
                        }
                    ],
                }
            ]
        ]
        text, summaries = [], []
        gateway = ProviderGateway(
            {"adapter": "OPENAI_COMPATIBLE", "baseURL": model.base_url, "model": "emulator"},
            "emulator-key",
        )
        reply = await gateway.generate_agent_stream(
            DraftContext({}, {}, 2000),
            [],
            partial(_collect, text),
            partial(_collect, summaries),
            _noop_tool,
        )
        assert text == ["Ready"] and reply.output == "Ready"
        assert not summaries


def _claude_events(blocks, *, stop_reason):
    """生成真实 Messages 流的开始、内容块增量及结束事件，签名与摘要字段只由消息服务协议产生。"""
    yield {
        "type": "message_start",
        "message": {
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4-6",
            "content": [],
            "usage": {"input_tokens": 50, "output_tokens": 1},
        },
    }
    for index, (block, deltas) in enumerate(blocks):
        yield {"type": "content_block_start", "index": index, "content_block": block}
        for delta in deltas:
            yield {"type": "content_block_delta", "index": index, "delta": delta}
        yield {"type": "content_block_stop", "index": index}
    yield {
        "type": "message_delta",
        "delta": {"stop_reason": stop_reason, "stop_sequence": None},
        "usage": {"output_tokens": 30},
    }
    yield {"type": "message_stop"}


async def test_claude_only_emits_opted_in_summary_and_keeps_signed_tool_continuity():
    """摘要只在已请求供应商摘要模式时公开，多段内容完整交给脱敏回调，签名只用于同一次调用的工具续接。"""
    async with emulator(port=0) as model:
        model.stream_responses = [
            list(
                _claude_events(
                    [
                        (
                            {"type": "thinking", "thinking": "", "signature": ""},
                            [
                                {"type": "thinking_delta", "thinking": "Check "},
                                {"type": "thinking_delta", "thinking": "candidate types."},
                                {"type": "signature_delta", "signature": "opaque-signature"},
                            ],
                        ),
                        ({"type": "tool_use", "id": "tool_test", "name": "check", "input": {}}, []),
                    ],
                    stop_reason="tool_use",
                )
            ),
            list(
                _claude_events(
                    [({"type": "text", "text": ""}, [{"type": "text_delta", "text": "Ready"}])],
                    stop_reason="end_turn",
                )
            ),
        ]
        text, summaries = [], []
        gateway = ProviderGateway(
            {"adapter": "ANTHROPIC", "baseURL": model.base_url, "model": "claude-sonnet-4-6"},
            "emulator-key",
        )
        reply = await gateway.generate_agent_stream(
            DraftContext({}, {}, 2000),
            [
                {
                    "name": "check",
                    "description": "Check candidate types",
                    "parameters": {"type": "object"},
                }
            ],
            partial(_collect, text),
            partial(_collect, summaries),
            _noop_tool,
        )
        assert text == ["Ready"] and reply.output == "Ready"
        assert summaries == ["Check candidate types."]
        assert model.calls[0]["body"]["thinking"] == {"type": "adaptive", "display": "summarized"}
        assert model.calls[1]["body"]["messages"][1]["content"][0] == {
            "type": "thinking",
            "thinking": "Check candidate types.",
            "signature": "opaque-signature",
        }
