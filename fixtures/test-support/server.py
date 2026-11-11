"""Test-only transport barriers around the real demo business validation boundary."""

import asyncio
import importlib.util
import os
from pathlib import Path
from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets

spec = importlib.util.spec_from_file_location(
    "demo", Path(__file__).parents[1] / "demo-app" / "app.py"
)
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)
accepted = asyncio.Event()
released = asyncio.Event()


class ControlledHandler(demo.Handler):
    async def validate_employee(self, name):
        await super().validate_employee(name)
        if name == "controlled-late":
            accepted.set()
            await released.wait()

    async def post(self):
        if self.request.path.startswith("/test/"):
            self.require("maintenance")
            if self.request.path == "/test/accepted":
                await accepted.wait()
            elif self.request.path == "/test/release":
                released.set()
            elif self.request.path == "/test/expire":
                self.store.db.execute(
                    "UPDATE fixtures SET expires=0 WHERE namespace=?", (self.body()["namespace"],)
                )
            self.finish({"ok": True})
        else:
            await super().post()


async def main():
    store = demo.Store(os.environ["VERIQ_DEMO_DATABASE"])
    app = demo.application(
        store,
        os.environ["VERIQ_DEMO_BUSINESS_TOKEN"],
        os.environ["VERIQ_DEMO_FIXTURE_TOKEN"],
        os.environ["VERIQ_DEMO_MAINTENANCE_TOKEN"],
        ControlledHandler,
    )
    sockets = bind_sockets(0, "127.0.0.1")
    server = HTTPServer(app)
    server.add_sockets(sockets)
    print(sockets[0].getsockname()[1], flush=True)
    await asyncio.Event().wait()


asyncio.run(main())
