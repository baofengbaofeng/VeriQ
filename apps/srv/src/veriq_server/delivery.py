"""密码重置邮件投递：签发令牌后异步发送，投递失败则吊销令牌并写审计，日志刻意不含收件人与链接正文，MODULE
的失败路径返回稳定错误。
"""

import asyncio
from datetime import datetime, timedelta
from logging import ERROR
import smtplib
import ssl
from email.message import EmailMessage
from typing import Protocol, cast
from time import monotonic

from sqlalchemy import delete, func, select

from .db import Database, User, UserToken
from .log import log
from .outbound import outbound
from .service import audit, digest, issue_reset, lock_installation, stamp
from .settings import Settings

# 这些预算保护单个 API 进程；同邮箱的跨节点投递冷却由数据库令牌签发时间在安装锁内判定。
MAX_PENDING_RESETS = 32
RESET_SOURCE_LIMIT = 5
RESET_WINDOW_SECONDS = 60
MAX_RESET_SOURCES = 1024


class Delivery(Protocol):
    """邮件投递协议定义异步发送纯文本正文的接口，实现可替换为测试桩或真实 SMTP，Delivery 的失败路径返回稳定错误。
    Delivery 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，
    勿假设通用成功默认值。
    """

    async def send(self, recipient: str, subject: str, body: str) -> None:
        """向指定收件人投递主题与正文；失败时应抛出异常，供调度器吊销对应重置令牌，Delivery.send
        的失败路径返回稳定错误。
        send 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        ...


class SMTPDelivery:
    """基于 Settings 的 SMTP 实现：支持 SMTPS、STARTTLS 以及可选的用户名密码登录凭据，SMTPDelivery
    的失败路径返回稳定错误。
    SMTPDelivery 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，
    勿假设通用成功默认值。
    """

    def __init__(self, config: Settings):
        """保存 Settings 引用，后续发送时读取主机、端口、安全模式与可选登录凭据，SMTPDelivery.__init__
        的失败路径返回稳定错误。
        __init__ 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        self.config = config

    async def send(self, recipient: str, subject: str, body: str) -> None:
        """组装 EmailMessage 并在线程池中调用 _send，避免阻塞 Tornado 的 IOLoop 事件循环，SMTPDelivery.send
        的失败路径返回稳定错误。
        send 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        with outbound(
            "smtp", "mail.delivered", failure_event="mail.delivery_failed", method_name="send"
        ):
            message = EmailMessage()
            message["From"] = self.config.smtp_from
            message["To"] = recipient
            message["Subject"] = subject
            message.set_content(body)
            await asyncio.to_thread(self._send, message)

    def _send(self, message: EmailMessage) -> None:
        """同步建立 SMTP 会话，按配置执行 TLS/STARTTLS 与 login，然后 send_message，SMTPDelivery._send
        的失败路径返回稳定错误。
        """
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
    """异步调度密码重置：持安装锁查找用户、签发令牌并投递邮件，失败则删除对应令牌摘要，ResetDispatcher
    的失败路径返回稳定错误。
    ResetDispatcher 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，
    勿假设通用成功默认值。
    """

    def __init__(self, db: Database, config: Settings, delivery: Delivery | None):
        """保存数据库、配置与可选 Delivery，并初始化进行中任务集合供 close 等待，ResetDispatcher.__init__
        的失败路径返回稳定错误。
        __init__ 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        self.db, self.config, self.delivery = db, config, delivery
        self.pending: set[asyncio.Task[None]] = set()
        self._emails: set[str] = set()
        self._sources: dict[str, tuple[float, int]] = {}

    def submit(self, email: str, *, source: str | None = None) -> None:
        """在创建 Task 前限制来源、总积压及同邮箱在途任务；拒绝时静默合并，公开响应与账户存在性无关。"""
        if self.delivery is None:
            return
        if source is not None and not self._admit_source(source):
            return
        email_key = digest(email.lower())
        if len(self.pending) >= MAX_PENDING_RESETS or email_key in self._emails:
            return
        self._emails.add(email_key)
        task = asyncio.create_task(self._run(email))
        self.pending.add(task)

        def completed(done: asyncio.Task[None]) -> None:
            """任务结束或取消均释放本进程任务名额及邮箱摘要，去重只覆盖在途任务，不保留邮箱正文或无限历史。"""
            self.pending.discard(done)
            self._emails.discard(email_key)

        task.add_done_callback(completed)

    def _admit_source(self, source: str) -> bool:
        """固定窗口只保存有界来源摘要；满表拒绝新来源，避免通过轮换来源驱逐尚有效的限流记录。"""
        clock = monotonic()
        self._sources = {
            key: value
            for key, value in self._sources.items()
            if clock - value[0] < RESET_WINDOW_SECONDS
        }
        key = digest(source)
        existing = self._sources.get(key)
        if existing is None:
            if len(self._sources) >= MAX_RESET_SOURCES:
                return False
            self._sources[key] = (clock, 1)
            return True
        started, count = existing
        if count >= RESET_SOURCE_LIMIT:
            return False
        self._sources[key] = (started, count + 1)
        return True

    async def _run(self, email: str) -> None:
        """投递失败时撤销本次令牌。投递成功后的审计故障按请求审计 ID 记录，供运维核对。"""
        token: str | None = None
        user_id: str | None = None
        smtp_in_progress = False
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
                clock = cast(
                    datetime, (await session.execute(select(func.utc_timestamp(6)))).scalar_one()
                )
                recent = await session.scalar(
                    select(UserToken.id)
                    .where(
                        UserToken.user_id == user.id,
                        UserToken.consumed.is_(False),
                        UserToken.issued_at > clock - timedelta(seconds=RESET_WINDOW_SECONDS),
                    )
                    .limit(1)
                )
                if recent is not None:
                    return
                user_id = user.id
                recipient = user.email
                token, expiry = await issue_reset(session, user, self.config.reset_minutes)
                request_audit_id = audit(session, "reset.requested", None, user.id)
            url = self.config.public_url + "/reset/confirm#token=" + token
            assert self.delivery is not None
            smtp_in_progress = isinstance(self.delivery, SMTPDelivery)
            await self.delivery.send(
                recipient,
                "Reset your VeriQ password",
                (
                    f"Use this one-time link to reset your VeriQ password:\n\n{url}\n\nThis link expires at "
                    f"{stamp(expiry)}. If you did not request it, ignore this email."
                ),
            )
        except Exception:
            # 邮件失败日志仅记录固定事件，不附异常文本、收件人或重置链接，避免投递适配器错误将口令重置材料写入运维日志。
            if not smtp_in_progress:
                log("_undef", "mail.delivery_failed", level=ERROR)
            if token:
                try:
                    async with self.db.sessions.begin() as session:
                        await session.execute(
                            delete(UserToken).where(UserToken.token_hash == digest(token))
                        )
                        audit(session, "reset.delivery_failed", None, user_id)
                except Exception:
                    log("_undef", "mail.revoke_failed", level=ERROR)
            return

        try:
            async with self.db.sessions.begin() as session:
                audit(session, "reset.delivered", None, user_id)
        except Exception:
            log(
                "_undef",
                "mail.delivered_audit_failed",
                level=ERROR,
                requestAuditId=request_audit_id,
            )

    async def close(self) -> None:
        """等待全部进行中的投递任务结束后再返回，供 HTTPServer 优雅停机路径调用，ResetDispatcher.close
        的失败路径返回稳定错误。
        close 实现于 apps/srv/src/veriq_server/delivery.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        if self.pending:
            await asyncio.gather(*list(self.pending))
