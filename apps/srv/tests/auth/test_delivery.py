
import asyncio
from email import policy
from email.parser import BytesParser
import re

import httpx
from sqlalchemy import select
from tornado.httpserver import HTTPServer

from veriq_server.app import make_app
from veriq_server.db import UserToken
from veriq_server.settings import Settings
from test_auth import setup, login


async def test_local_smtp_delivery_and_private_failure(site, caplog):
    c, db = site
    await setup(c)
    messages = []
    connections = []
    failed = False

    async def smtp(reader, writer):
        connections.append(True)
        if failed:
            writer.write(b"421 SMTP-secret-error-marker\r\n")
            await writer.drain()
            writer.close()
            await writer.wait_closed()
            return
        writer.write(b"220 local VeriQ test SMTP\r\n")
        await writer.drain()
        while line := await reader.readline():
            command = line.upper()
            if command.startswith((b"EHLO", b"HELO")):
                writer.write(b"250 local\r\n")
            elif command.startswith((b"MAIL FROM:", b"RCPT TO:", b"RSET")):
                writer.write(b"250 accepted\r\n")
            elif command.startswith(b"DATA"):
                writer.write(b"354 send message\r\n")
                await writer.drain()
                parts = []
                while (part := await reader.readline()) != b".\r\n":
                    assert part
                    parts.append(part[1:] if part.startswith(b"..") else part)
                messages.append(b"".join(parts))
                writer.write(b"250 stored\r\n")
            elif command.startswith(b"QUIT"):
                writer.write(b"221 goodbye\r\n")
                await writer.drain()
                break
            else:
                writer.write(b"500 unsupported\r\n")
            await writer.drain()
        writer.close()
        await writer.wait_closed()

    smtp_listener = await asyncio.start_server(smtp, "127.0.0.1", 0)
    smtp_port = smtp_listener.sockets[0].getsockname()[1]
    config = Settings(
        database_url=db.engine.url.render_as_string(hide_password=False),
        public_url="http://127.0.0.1:18892",
        master_key="a" * 64,
        signing_key="b" * 64,
        environment="development",
        smtp_host="127.0.0.1",
        smtp_port=smtp_port,
        smtp_from="sender@example.com",
        smtp_security="none",
    )
    application = make_app(config, db)
    dispatcher = application.settings["reset_dispatcher"]
    server = HTTPServer(application)
    server.listen(18892, "127.0.0.1")
    try:
        async with httpx.AsyncClient(
            base_url=config.public_url, headers={"Origin": config.public_url}
        ) as other:
            state = await other.get("/api/v1/setup")
            other.headers["X-CSRF-Token"] = state.json()["data"]["csrfToken"]
            unknown = await other.post(
                "/api/v1/auth/password-reset", json={"email": "unknown@example.com"}
            )
            await dispatcher.close()
            assert not connections and not messages
            known = await other.post(
                "/api/v1/auth/password-reset", json={"email": "admin@example.com"}
            )
            assert (
                known.status_code == unknown.status_code == 200
                and known.json()["data"] == unknown.json()["data"] == {}
            )
            await dispatcher.close()
            assert len(messages) == 1
            mail = BytesParser(policy=policy.default).parsebytes(messages[0])
            assert (
                mail["To"] == "admin@example.com" and mail["Subject"] == "Reset your VeriQ password"
            )
            url = re.search(r"http://[^\s]+", mail.get_content()).group()
            token = url.split("token=")[1]
            assert token not in caplog.text
            assert (
                await other.post(
                    "/api/v1/auth/password-reset/confirm",
                    json={"token": token, "newPassword": "Delivered password 123!"},
                )
            ).status_code == 200
            assert (await login(other, password="Delivered password 123!")).status_code == 200
            failed = True
            response = await other.post(
                "/api/v1/auth/password-reset", json={"email": "admin@example.com"}
            )
            assert response.json()["data"] == {} and response.status_code == 200
            await dispatcher.close()
            async with db.sessions() as session:
                assert not (await session.execute(select(UserToken))).scalars().all()
            assert "mail.delivery_failed" in caplog.text
            assert "SMTP-secret-error-marker" not in caplog.text and token not in caplog.text
    finally:
        await dispatcher.close()
        server.stop()
        await server.close_all_connections()
        smtp_listener.close()
        await smtp_listener.wait_closed()
