"""Optional real SMTP delivery; reusable by account reset and future invitations."""

import asyncio
import logging
import smtplib
import ssl
from email.message import EmailMessage
from typing import Protocol

from sqlalchemy import delete, select

from .db import Database, User, UserToken
from .service import audit, digest, issue_reset, lock_installation, stamp
from .settings import Settings

log = logging.getLogger("veriq.mail")


class Delivery(Protocol):
    async def send(self, recipient: str, subject: str, body: str) -> None: ...


class SMTPDelivery:
    def __init__(self, config: Settings):
        self.config = config

    async def send(self, recipient: str, subject: str, body: str) -> None:
        message = EmailMessage()
        message["From"] = self.config.smtp_from
        message["To"] = recipient
        message["Subject"] = subject
        message.set_content(body)
        await asyncio.to_thread(self._send, message)

    def _send(self, message: EmailMessage) -> None:
        host = self.config.smtp_host
        assert host is not None
        context = ssl.create_default_context()
        client: smtplib.SMTP
        if self.config.smtp_security == "tls":
            client = smtplib.SMTP_SSL(
                host, self.config.smtp_port, timeout=self.config.smtp_timeout, context=context
            )
        else:
            client = smtplib.SMTP(host, self.config.smtp_port, timeout=self.config.smtp_timeout)
        with client:
            if self.config.smtp_security == "starttls":
                client.starttls(context=context)
            if self.config.smtp_username and self.config.smtp_password:
                client.login(
                    self.config.smtp_username.get_secret_value(),
                    self.config.smtp_password.get_secret_value(),
                )
            client.send_message(message)


class ResetDispatcher:
    """Return the same public response before looking up any account.

    Pending work is tracked and drained at shutdown. A send failure revokes that
    exact token and writes a safe audit event; SMTP errors/tokens never enter logs.
    """

    def __init__(self, db: Database, config: Settings, delivery: Delivery | None):
        self.db, self.config, self.delivery = db, config, delivery
        self.pending: set[asyncio.Task[None]] = set()

    def submit(self, email: str) -> None:
        if self.delivery is None:
            return
        task = asyncio.create_task(self._run(email))
        self.pending.add(task)
        task.add_done_callback(self.pending.discard)

    async def _run(self, email: str) -> None:
        token: str | None = None
        user_id: str | None = None
        try:
            async with self.db.sessions.begin() as session:
                await lock_installation(session)
                user = (
                    await session.execute(
                        select(User).where(User.email == email.lower(), User.disabled.is_(False))
                    )
                ).scalar_one_or_none()
                if user is None:
                    return
                user_id = user.id
                recipient = user.email
                token, expiry = await issue_reset(session, user, self.config.reset_minutes)
                audit(session, "reset.requested", None, user.id)
            url = self.config.public_url + "/reset/confirm#token=" + token
            assert self.delivery is not None
            await self.delivery.send(
                recipient,
                "Reset your VeriQ password",
                f"Use this one-time link to reset your VeriQ password:\n\n{url}\n\nThis link expires at {stamp(expiry)}. If you did not request it, ignore this email.",
            )
            async with self.db.sessions.begin() as session:
                audit(session, "reset.delivered", None, user_id)
        except Exception:
            # Deliberately exclude exception text, recipient and secret link.
            log.error('{"event":"mail.delivery_failed"}')
            if token:
                try:
                    async with self.db.sessions.begin() as session:
                        await session.execute(
                            delete(UserToken).where(UserToken.token_hash == digest(token))
                        )
                        audit(session, "reset.delivery_failed", None, user_id)
                except Exception:
                    log.error('{"event":"mail.revoke_failed"}')

    async def close(self) -> None:
        if self.pending:
            await asyncio.gather(*list(self.pending))
