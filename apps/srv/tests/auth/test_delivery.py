"""在回环邮件服务器上观察密码重置投递，核对存在和不存在的账号获得相同的公开响应且日志保护凭据。"""

import asyncio
from email import policy
from email.parser import BytesParser
import re
from unittest.mock import AsyncMock

import httpx
from sqlalchemy import event, select
from sqlalchemy.orm import Session
from tornado.httpserver import HTTPServer

from veriq_server.app import make_app
from veriq_server.db import AuditLog, UserToken
from veriq_server.delivery import ResetDispatcher
from veriq_server.settings import Settings
from test_auth import setup, login


async def test_local_smtp_delivery_and_private_failure(site, caplog):
    """捕获真实邮件并使用其中的重置链接，再让邮件服务器拒绝投递，检查公开响应与日志中的私密字段。"""
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
                actions = (
                    await session.scalars(
                        select(AuditLog.action).where(AuditLog.action.like("reset.%"))
                    )
                ).all()
                assert sorted(actions) == [
                    "reset.delivered",
                    "reset.delivery_failed",
                    "reset.requested",
                    "reset.requested",
                ]
            assert "mail.delivery_failed" in caplog.text
            assert "SMTP-secret-error-marker" not in caplog.text and token not in caplog.text
    finally:
        await dispatcher.close()
        server.stop()
        await server.close_all_connections()
        smtp_listener.close()
        await smtp_listener.wait_closed()


async def test_delivered_link_survives_audit_commit_failure(site, caplog):
    """在投递成功后让审计提交失败，验证邮件中的链接仍能完成改密，运维可凭日志定位请求审计行。"""
    client, db = site
    await setup(client)
    config = Settings(
        database_url=db.engine.url.render_as_string(hide_password=False),
        public_url=str(client.base_url).rstrip("/"),
        master_key="a" * 64,
        signing_key="b" * 64,
        environment="development",
    )
    delivery = AsyncMock()
    dispatcher = ResetDispatcher(db, config, delivery)

    def fail_delivered_commit(session):
        if any(
            isinstance(row, AuditLog) and row.action == "reset.delivered" for row in session.new
        ):
            raise RuntimeError("private-database-error-marker")

    event.listen(Session, "before_commit", fail_delivered_commit)
    try:
        dispatcher.submit("admin@example.com")
        await dispatcher.close()
    finally:
        event.remove(Session, "before_commit", fail_delivered_commit)

    delivery.send.assert_awaited_once()
    body = delivery.send.await_args.args[2]
    token = re.search(r"#token=(\S+)", body).group(1)
    confirmed = await client.post(
        "/api/v1/auth/password-reset/confirm",
        json={"token": token, "newPassword": "Delivered password 123!"},
    )
    assert confirmed.status_code == 200
    async with db.sessions() as session:
        request = (
            await session.scalars(select(AuditLog).where(AuditLog.action.like("reset.%")))
        ).one()
        assert request.action == "reset.requested"
    events = [
        record.veriq_fields
        for record in caplog.records
        if record.name == "veriq" and record.getMessage() == "mail.delivered_audit_failed"
    ]
    assert len(events) == 1 and events[0]["requestAuditId"] == request.id
    assert all(
        private not in caplog.text and private not in str(events)
        for private in ("private-database-error-marker", "admin@example.com", token)
    )
