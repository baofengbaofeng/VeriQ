"""密码重置邮件投递：签发令牌后异步发送，投递失败则吊销令牌并写审计，日志刻意不含收件人与链接正文，MODULE 的失败路径返回稳定错误。
"""

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
    """邮件投递协议定义异步发送纯文本正文的接口，实现可替换为测试桩或真实 SMTP，Delivery 的失败路径返回稳定错误。
    Delivery 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    async def send(self, recipient: str, subject: str, body: str) -> None:
        """向指定收件人投递主题与正文；失败时应抛出异常，供调度器吊销对应重置令牌，Delivery.send 的失败路径返回稳定错误。
        send 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        ...


class SMTPDelivery:
    """基于 Settings 的 SMTP 实现：支持 SMTPS、STARTTLS 以及可选的用户名密码登录凭据，SMTPDelivery 的失败路径返回稳定错误。
    SMTPDelivery 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    def __init__(self, config: Settings):
        """保存 Settings 引用，后续发送时读取主机、端口、安全模式与可选登录凭据，SMTPDelivery.__init__ 的失败路径返回稳定错误。
        __init__ 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        self.config = config

    async def send(self, recipient: str, subject: str, body: str) -> None:
        """组装 EmailMessage 并在线程池中调用 _send，避免阻塞 Tornado 的 IOLoop 事件循环，SMTPDelivery.send 的失败路径返回稳定错误。
        send 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        message = EmailMessage()
        message["From"] = self.config.smtp_from
        message["To"] = recipient
        message["Subject"] = subject
        message.set_content(body)
        await asyncio.to_thread(self._send, message)

    def _send(self, message: EmailMessage) -> None:
        """同步建立 SMTP 会话，按配置执行 TLS/STARTTLS 与 login，然后 send_message，SMTPDelivery._send 的失败路径返回稳定错误。"""
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
    """异步调度密码重置：持安装锁查找用户、签发令牌并投递邮件，失败则删除对应令牌摘要，ResetDispatcher 的失败路径返回稳定错误。
    ResetDispatcher 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    def __init__(self, db: Database, config: Settings, delivery: Delivery | None):
        """保存数据库、配置与可选 Delivery，并初始化进行中任务集合供 close 等待，ResetDispatcher.__init__ 的失败路径返回稳定错误。
        __init__ 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        self.db, self.config, self.delivery = db, config, delivery
        self.pending: set[asyncio.Task[None]] = set()

    def submit(self, email: str) -> None:
        """入队重置任务；未配置 delivery 时直接返回，避免与登录枚举以外的行为产生差异，ResetDispatcher.submit 的失败路径返回稳定错误。
        submit 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        if self.delivery is None:
            return
        task = asyncio.create_task(self._run(email))
        self.pending.add(task)
        task.add_done_callback(self.pending.discard)

    async def _run(self, email: str) -> None:
        """执行单次重置：未知用户静默返回；投递失败吊销令牌并记录 reset.delivery_failed，ResetDispatcher._run 的失败路径返回稳定错误。"""
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
            # 日志刻意排除异常文本、收件人与密链，防止运维日志泄露重置材料。
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
        """等待全部进行中的投递任务结束后再返回，供 HTTPServer 优雅停机路径调用，ResetDispatcher.close 的失败路径返回稳定错误。
        close 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        if self.pending:
            await asyncio.gather(*list(self.pending))
