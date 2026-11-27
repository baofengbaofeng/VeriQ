"""通过回环服务向两种供应商协议的客户端交付可控响应，记录出站请求和并发顺序供生成与会话测试核对。"""

import asyncio
import json
import os
from contextlib import asynccontextmanager
from types import SimpleNamespace

from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets
from tornado.web import Application, RequestHandler

CASE = {
    "kind": "CASE",
    "document": {
        "schemaVersion": "1.0",
        "caseKey": "ai-example",
        "title": "Reviewed requirement",
        "kind": "READ",
        "roleKey": "anonymous",
        "catalogVersionId": "00000000-0000-0000-0000-000000000001",
        "steps": [{"id": "open", "action": "goto", "path": "/"}],
    },
}


@asynccontextmanager
async def emulator(port=None):
    """每次创建独立的请求记录和等待事件，允许用例挂起供应商响应，退出时先释放等待者再关闭监听。"""
    state = SimpleNamespace(
        calls=[],
        output=CASE,
        raw_content=None,
        status=200,
        usage=True,
        stop_reason="end_turn",
        finish_reason="stop",
        output_tokens=40,
        release=asyncio.Event(),
        started=asyncio.Event(),
        wait=False,
        stream_responses=[],
    )
    state.release.set()

    class Provider(RequestHandler):
        """在同一监听器内根据请求路径选择响应协议，使两种供应商客户端都能按真实协议结构读取用量。"""

        async def post(self):
            """先记录实际抵达的凭据头和请求体，再按用例配置返回错误、逐条流事件或带有用量的完整响应。"""
            state.calls.append(
                {
                    "path": self.request.path,
                    "body": json.loads(self.request.body),
                    "authorization": self.request.headers.get("Authorization"),
                    "x-api-key": self.request.headers.get("x-api-key"),
                }
            )
            state.started.set()
            if state.wait:
                await state.release.wait()
            self.set_status(state.status)
            if state.status != 200:
                self.write({"error": {"message": "secret-must-never-leak", "type": "api_error"}})
                return
            # 流式夹具按请求顺序消费协议事件，使测试能够穿过真实供应商 SDK，并验证工具结果发回后产生的第二轮请求。
            if state.calls[-1]["body"].get("stream") and state.stream_responses:
                self.set_header("Content-Type", "text/event-stream")
                anthropic = self.request.path.endswith("messages")
                for event in state.stream_responses.pop(0):
                    if anthropic:
                        self.write(f"event: {event['type']}\n")
                    self.write(f"data: {json.dumps(event)}\n\n")
                if not anthropic:
                    self.write("data: [DONE]\n\n")
                return
            content = (
                state.raw_content if state.raw_content is not None else json.dumps(state.output)
            )
            if self.request.path.endswith("messages"):
                self.write(
                    {
                        "id": "msg_emulator",
                        "type": "message",
                        "role": "assistant",
                        "model": "emulator",
                        "content": [{"type": "text", "text": content}],
                        "stop_reason": state.stop_reason,
                        "stop_sequence": None,
                        "usage": {"input_tokens": 80, "output_tokens": state.output_tokens},
                    }
                )
            else:
                value = {
                    "id": "chatcmpl_emulator",
                    "object": "chat.completion",
                    "created": 0,
                    "model": "emulator",
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": state.finish_reason,
                            "message": {"role": "assistant", "content": content},
                        }
                    ],
                }
                if state.usage:
                    value["usage"] = {
                        "prompt_tokens": 80,
                        "completion_tokens": state.output_tokens,
                        "total_tokens": 80 + state.output_tokens,
                    }
                self.write(value)

    sockets = bind_sockets(
        int(os.environ.get("VERIQ_TEST_MODEL_PORT", "18890")) if port is None else port, "127.0.0.1"
    )
    state.base_url = f"http://127.0.0.1:{sockets[0].getsockname()[1]}/v1"
    server = HTTPServer(Application([(r"/v1/.*", Provider)]))
    server.add_sockets(sockets)
    try:
        yield state
    finally:
        state.release.set()
        server.stop()
        await server.close_all_connections()
