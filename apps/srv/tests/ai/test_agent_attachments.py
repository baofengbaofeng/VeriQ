"""通过公开契约、真实员工会话和本机模型协议检查附件准入、供应商消息映射与历史内容隔离。"""

import base64
import json
from uuid import uuid4

import pytest
from emulator import emulator
from jsonschema import ValidationError
from test_agent_sessions import _scope
from test_conversational_agent import conversation
from test_workspace import client, new_member

from veriq_server.infrastructure.providers import DraftContext, ProviderGateway
from veriq_server.service import Problem
from veriq_server.services.agent_attachments import TEXT_ATTACHMENT_LIMIT, read_attachments
from veriq_server.validation import validate_api

PNG_DATA = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGO4t3YfAAS2Ako5Hvp4AAAAAElFTkSuQmCC"
)


def _file(name, media_type, data):
    """从原始字节构造标准 Base64 请求，避免测试依赖浏览器的 MIME 推断并对出站文件执行逐字节核对。"""
    return {"name": name, "mediaType": media_type, "dataBase64": base64.b64encode(data).decode()}


def _decode_upload(call, adapter):
    """在协议请求中核对图像的真实字节，然后返回独立文本块承载的上下文，供调用者验证附件内容而非附件名。"""
    parts = call["body"]["messages"][-1]["content"]
    if adapter == "ANTHROPIC":
        assert parts[1]["source"] == {"type": "base64", "media_type": "image/png", "data": PNG_DATA}
    else:
        assert parts[1]["image_url"]["url"] == f"data:image/png;base64,{PNG_DATA}"
    return json.loads(parts[0]["text"])["context"]


def test_attachment_only_turn_requires_a_nonempty_file_list():
    """只发文件仍属于有效对话输入，空正文与空文件列表的组合则不能创建任何一次付费的模型请求。"""
    request = {"requestId": str(uuid4()), "text": ""}
    valid_file = _file("plan.md", "text/markdown", b"Plan")
    validate_api("AgentTurnSubmit", {**request, "attachments": [valid_file]})
    svg = _file("x.svg", "image/svg+xml", b"<svg/>")
    for extra in ({}, {"attachments": []}, {"attachments": [svg]}):
        with pytest.raises(ValidationError):
            validate_api("AgentTurnSubmit", {**request, **extra})
    with pytest.raises(ValidationError):
        validate_api("AgentTurnSubmit", {**request, "text": "\n", "attachments": [valid_file]})


def test_decoded_text_limit_and_image_integrity_are_checked():
    """校验单轮文本总量，拒绝二进制伪装成文本、损坏的像素容器以及试图把文件名变成目录地址的提交。"""
    large = b"X" * TEXT_ATTACHMENT_LIMIT
    files = [_file("full.txt", "text/plain", large), _file("extra.csv", "text/csv", b"Id")]
    with pytest.raises(Problem) as too_large:
        read_attachments(files)
    assert too_large.value.code == "AGENT_ATTACHMENT_LIMIT"
    png = bytearray(base64.b64decode(PNG_DATA))
    png[29] ^= 1
    for invalid in (
        _file("broken.png", "image/png", bytes(png)),
        _file("binary.txt", "text/plain", b"\x00text"),
        _file("../plan.txt", "text/plain", b"Invalid name"),
        _file("broken.jpg", "image/jpeg", b"\xff\xd8\xff\xd9"),
        {
            "name": "plan.txt",
            "mediaType": "text/plain",
            "dataBase64": "data:text/plain;base64,AAAA",
        },
    ):
        with pytest.raises(Problem) as error:
            read_attachments([invalid])
        assert error.value.code == "AGENT_ATTACHMENT_INVALID"


def _stream_events(adapter):
    """为两种官方流式协议分别提供可结束的一段正文，使用真实 SDK 消费事件并核对完整消息序列。"""
    if adapter == "OPENAI_COMPATIBLE":
        return [
            {
                "id": "chatcmpl_fixture",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "fixture",
                "choices": [
                    {"index": 0, "delta": {"content": "Diagram received"}, "finish_reason": "stop"}
                ],
            }
        ]
    return [
        {
            "type": "message_start",
            "message": {
                "id": "msg_fixture",
                "type": "message",
                "role": "assistant",
                "model": "fixture",
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 80, "output_tokens": 0},
            },
        },
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": "Diagram received"},
        },
        {"type": "content_block_stop", "index": 0},
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": 40},
        },
        {"type": "message_stop"},
    ]


@pytest.mark.parametrize("adapter", ["OPENAI_COMPATIBLE", "ANTHROPIC"])
@pytest.mark.parametrize("streamed", [False, True])
async def test_gateway_encodes_images_for_native_sdk(adapter, streamed):
    """穿过真实 SDK 把同一个内存图片及其文本描述发往本机协议服务，图像用量在调用前单独计入输入上界。"""
    files = read_attachments([_file("diagram.png", "image/png", base64.b64decode(PNG_DATA))])
    text_context = DraftContext({"attachments": files.materials}, {"type": "object"}, 64)
    image_context = DraftContext(text_context.context, text_context.schema, 64, images=files.images)
    assert image_context.input_bound() > text_context.input_bound()
    async with emulator(port=0) as endpoint:
        endpoint.output = {"reply": "Diagram received"}
        gateway = ProviderGateway(
            {"adapter": adapter, "model": "fixture", "baseURL": endpoint.base_url}, "synthetic-key"
        )
        if streamed:
            endpoint.stream_responses.append(_stream_events(adapter))
            received = []

            async def capture(text):
                """收集真实 SDK 回调的正文增量，核对带图片的模型请求仍在收到结果时立即推进当前轮次界面。"""
                received.append(text)

            async def reject_tool(name, arguments):
                """夹具只发送文本回复，因此任何工具调用都视为协议回归，报告意外的工具标识与参数名称。"""
                pytest.fail(f"Unexpected tool call {name}: {list(arguments)}")

            result = await gateway.generate_agent_stream(
                image_context, [], capture, None, reject_tool
            )
            assert result.output == "Diagram received" and received == [result.output]
        else:
            result = await gateway.generate(image_context)
            assert result.output == endpoint.output
        assert result.error_code is None
        assert _decode_upload(endpoint.calls[0], adapter) == text_context.context


@pytest.mark.parametrize("adapter", ["OPENAI_COMPATIBLE", "ANTHROPIC"])
async def test_attachment_text_and_image_reach_provider_and_replay_is_content_bound(site, adapter):
    """本轮文件以文本上下文或原生图像块送出，历史只返回名称类型大小，并阻断修改文件后重用一次调用编号。"""
    c, _ = site
    workspace = await _scope(c)
    async with emulator() as model:
        path, _, _ = await conversation(c, workspace, model, adapter=adapter, supportsImages=True)
        model.output = {"reply": "Prepared requirements"}
        text = b"Plan evidence: attachment-only-unique-value"
        files = [
            _file("plan.md", "text/markdown", text),
            _file("diagram.png", "image/png", base64.b64decode(PNG_DATA)),
        ]
        request = {"requestId": str(uuid4()), "text": "", "attachments": files}
        response = await c.post(path, json=request)
        assert response.is_success, response.text
        turn = response.json()["data"]
        assert turn["status"] == "COMPLETED"
        assert turn["attachments"] == [
            {"name": "plan.md", "mediaType": "text/markdown", "sizeBytes": len(text)},
            {
                "name": "diagram.png",
                "mediaType": "image/png",
                "sizeBytes": len(base64.b64decode(PNG_DATA)),
            },
        ]
        assert (
            _decode_upload(model.calls[-1], adapter)["attachments"][0]["content"] == text.decode()
        )

        history = await c.get(path)
        assert history.json()["data"]["items"] == [turn]
        assert "attachment-only-unique-value" not in history.text and PNG_DATA not in history.text
        assert (await c.post(path, json=request)).json()["data"] == turn
        mismatch = await c.post(
            path,
            json={
                **request,
                "attachments": [_file("plan.md", "text/markdown", b"Other"), files[1]],
            },
        )
        assert (mismatch.status_code, mismatch.json()["code"]) == (409, "IDEMPOTENCY_CONFLICT")
        assert len(model.calls) == 1

        followup = await c.post(path, json={"requestId": str(uuid4()), "text": "Continue"})
        assert followup.is_success, followup.text
        new_context = json.dumps(model.calls[-1]["body"])
        assert "attachment-only-unique-value" not in new_context and PNG_DATA not in new_context


async def test_attachment_upload_rejects_wrong_session_and_unsupported_vision(site):
    """图片能力未开通时拒绝发送，而且同空间另一个编辑者不能利用附件入口访问所有者的私有会话。"""
    c, _ = site
    workspace = await _scope(c)
    member_id = await new_member(c, workspace, role="EDITOR")
    members = (await c.get(f"/api/v1/workspaces/{workspace}/members")).json()["data"]["items"]
    member = next(row for row in members if row["userId"] == member_id)
    async with emulator() as model:
        path, _, _ = await conversation(c, workspace, model)
        image = _file("diagram.png", "image/png", base64.b64decode(PNG_DATA))
        request = {"requestId": str(uuid4()), "text": "Read the screenshot", "attachments": [image]}
        response = await c.post(path, json=request)
        assert (response.status_code, response.json()["code"]) == (422, "AGENT_IMAGE_UNSUPPORTED")
        bogus = _file("diagram.png", "image/png", b"arbitrary payload")
        rejected = await c.post(path, json={**request, "attachments": [bogus]})
        assert (rejected.status_code, rejected.json()["code"]) == (422, "AGENT_ATTACHMENT_INVALID")
        async with client(c, member["email"]) as another:
            unauthorized = await another.post(path, json=request)
        assert (unauthorized.status_code, unauthorized.json()["code"]) == (
            404,
            "AGENT_SESSION_NOT_FOUND",
        )
        assert not model.calls
