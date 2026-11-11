"""Local HTTP protocol emulator. Does not contact or impersonate a real provider."""

import asyncio
import json
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
async def emulator():
    state = SimpleNamespace(
        calls=[],
        output=CASE,
        raw_content=None,
        status=200,
        usage=True,
        release=asyncio.Event(),
        started=asyncio.Event(),
        wait=False,
    )
    state.release.set()

    class Provider(RequestHandler):
        async def post(self):
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
                        "stop_reason": "end_turn",
                        "stop_sequence": None,
                        "usage": {"input_tokens": 80, "output_tokens": 40},
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
                            "finish_reason": "stop",
                            "message": {"role": "assistant", "content": content},
                        }
                    ],
                }
                if state.usage:
                    value["usage"] = {
                        "prompt_tokens": 80,
                        "completion_tokens": 40,
                        "total_tokens": 120,
                    }
                self.write(value)

    sockets = bind_sockets(18890, "127.0.0.1")
    state.base_url = f"http://127.0.0.1:{sockets[0].getsockname()[1]}/v1"
    server = HTTPServer(Application([(r"/v1/.*", Provider)]))
    server.add_sockets(sockets)
    try:
        yield state
    finally:
        state.release.set()
        server.stop()
        await server.close_all_connections()
