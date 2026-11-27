"""员工收件箱使用同源会话，通知流只携带服务端投递版本，列表、详情与快捷操作各自重新检查当前业务授权。"""

import asyncio
import json
from contextlib import suppress
from dataclasses import dataclass, field
from itertools import batched
from logging import WARNING

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from tornado.iostream import StreamClosedError

from ..log import log
from ..logging_context import new_trace, use_trace
from ..db import Database, User, UserSession
from ..pagination import boolean_filter
from ..service import Problem, lock_installation
from ..services.agent_form_receipts import FORM_ORIGIN_HEADER
from ..services.notification_inbox import (
    NotificationInbox,
    deliver_due_notifications,
    notification_revisions,
)
from .base import API

_POLL_SECONDS = 2
_STREAM_LIMIT = 1024
_BATCH_SIZE = 100
_HEARTBEAT_SECONDS = 15
_STREAM_TIMEOUT = 10


@dataclass(eq=False)
class _Subscriber:
    """每条连接只保留最新投递版本，慢客户端无需保留逐条事件，重新取快照可以恢复任意合并的中间版本。"""

    user_id: str
    session_id: str
    pending: asyncio.Queue[str | None] = field(default_factory=lambda: asyncio.Queue(maxsize=1))
    revision: str | None = None

    def send(self, revision: str | None) -> None:
        """队列中有尚未写出的状态时直接替换，连接关闭和授权失效以空值解除等待，避免持续积压或占用连接。"""
        if self.pending.full():
            self.pending.get_nowait()
        self.pending.put_nowait(revision)
        self.revision = revision


class NotificationWatcher:
    """每个应用节点合并本节点所有活跃连接的会话检查和版本读取，进程内订阅只负责把数据库中已提交的状态送出。"""

    def __init__(self, db: Database):
        """读取器只持有应用数据库和有限连接集合，构造应用时不启动任务，最后一条连接离开时停止读取。"""
        self.db = db
        self._subscribers: set[_Subscriber] = set()
        self._task: asyncio.Task[None] | None = None
        self._delivery: asyncio.Task[None] | None = None
        self._draining: set[asyncio.Task[None]] = set()
        self._closed = False
        self._wake = asyncio.Event()

    def subscribe(self, user_id: str, session_id: str) -> _Subscriber:
        """在成功验证会话后建立本地订阅，唤醒节点共享读取器获取首个持久化版本，不从客户端接收版本游标。"""
        if self._closed:
            raise Problem(503, "NOTIFICATION_UNAVAILABLE", "Inbox stream is unavailable")
        if len(self._subscribers) >= _STREAM_LIMIT:
            raise Problem(429, "NOTIFICATION_STREAM_LIMIT", "Too many inbox streams on this node")
        subscriber = _Subscriber(user_id, session_id)
        self._subscribers.add(subscriber)
        self._wake.set()
        if self._task is None:
            with use_trace(new_trace()):
                self._task = asyncio.create_task(self._read())
        return subscriber

    def unsubscribe(self, subscriber: _Subscriber) -> None:
        """先移除连接再释放等待，节点没有订阅时取消当前读取任务，新订阅可启动新的读取周期恢复状态。"""
        self._subscribers.discard(subscriber)
        if not self._subscribers and self._task is not None:
            self._cancel(self._task)
            self._task = None
            self._stop_delivery()

    async def close(self) -> None:
        """应用停止后解除本节点剩余连接与数据库任务，等待取消完成再归还连接池，其他节点可继续处理未投递记录。"""
        self._closed = True
        tasks = self._draining | {task for task in (self._task, self._delivery) if task is not None}
        for subscriber in self._subscribers:
            subscriber.send(None)
        self._subscribers.clear()
        self._task = self._delivery = None
        for task in tasks:
            if task not in self._draining:
                task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task

    def _stop_delivery(self) -> None:
        """节点停止监听时一并放弃本地正在等待的投递事务，下一次请求会从仍未完成的持久化记录继续恢复。"""
        if self._delivery is not None:
            self._cancel(self._delivery)
            self._delivery = None

    def _cancel(self, task: asyncio.Task[None]) -> None:
        """最后一个订阅退出时保留取消任务直到数据库已回滚，节点随后停止也可以等待已离开调度器的任务。"""
        self._draining.add(task)
        task.add_done_callback(self._draining.discard)
        task.cancel()

    async def _deliver(self) -> None:
        """到期投递可能排队获取写锁，使用单独的事务与任务，避免延误所有连接的会话撤销和收件箱版本读取。"""
        try:
            async with self.db.sessions.begin() as session:
                await deliver_due_notifications(session, limit=_BATCH_SIZE)
        except SQLAlchemyError:
            log("_undef", "notification.delivery_scan_failed", level=WARNING)
        finally:
            if self._delivery is asyncio.current_task():
                self._delivery = None

    async def _read(self) -> None:
        """每轮独立推进到期事件和已提交版本，某一轮数据库异常后重新读取，恢复时由持久化版本补齐更新。"""
        try:
            while self._subscribers:
                self._wake.clear()
                if self._delivery is None:
                    self._delivery = asyncio.create_task(self._deliver())
                try:
                    await self._refresh()
                except SQLAlchemyError:
                    log("_undef", "notification.version_scan_failed", level=WARNING)
                if not self._subscribers:
                    break
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=_POLL_SECONDS)
                except TimeoutError:
                    continue
        finally:
            if self._task is asyncio.current_task():
                self._task = None
                self._stop_delivery()

    async def _refresh(self) -> None:
        """按真实会话主键批量核对当前所有者、账户状态和数据库过期时间，失效连接收不到后续投递版本。"""
        subscribers = tuple(self._subscribers)
        grouped: dict[str, list[_Subscriber]] = {}
        for subscriber in subscribers:
            grouped.setdefault(subscriber.session_id, []).append(subscriber)
        for session_ids in batched(grouped, _BATCH_SIZE):
            async with self.db.sessions() as session:
                rows = await session.execute(
                    select(UserSession.id, UserSession.user_id)
                    .join(User, User.id == UserSession.user_id)
                    .where(
                        UserSession.id.in_(session_ids),
                        UserSession.expires_at > func.utc_timestamp(6),
                        User.disabled.is_(False),
                    )
                )
                active = dict(rows.tuples().all())
                revisions = await notification_revisions(session, set(active.values()))
            for session_id in session_ids:
                for subscriber in grouped[session_id]:
                    if subscriber not in self._subscribers:
                        continue
                    if active.get(session_id) != subscriber.user_id:
                        subscriber.send(None)
                        self._subscribers.discard(subscriber)
                        continue
                    revision = revisions.get(subscriber.user_id, "0")
                    if subscriber.revision != revision:
                        subscriber.send(revision)


_WRITE_SCHEMAS = {
    "notification-read": "Empty",
    "notification-read-all": "NotificationReadAllRequest",
    "notification-accept": "Empty",
    "notification-agent-seen": "NotificationAgentSeenRequest",
    "notification-stream": "Empty",
}


# 通知写操作使用 Tornado 的完整缓冲正文读取路径，基类的流式上传回调只在启用流式上传装饰器后才会执行。
class NotificationAPI(API):  # pylint: disable=abstract-method
    """收件箱的读取与操作以当前员工会话为准，动作的路由参数只用于定位资源，授权和投递水位由领域服务检查。"""

    body_limit = 8192
    _subscriber: _Subscriber | None = None
    _disconnected = False

    def on_finish(self) -> None:
        """自动铃铛刷新与后台事件连接不改变账号活动时间，用户触发的详情和写操作沿用基类的持久化登记。"""
        if self.action not in {"notification-list", "notification-stream"}:
            super().on_finish()

    async def get(self, notification_id: str = "") -> None:
        """列表以当前用户筛选条件和有界分页读取，允许从离线状态回来时推进一批已经到期但尚未投递的消息。"""
        if self.action not in {"notification-list", "notification-detail"}:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        async with self.db.sessions.begin() as session:
            # 先取得与注销和成员变更一致的写入护栏，再读取授权、通知列表和未读统计，避免分次命中不同快照。
            await lock_installation(session)
            user, _ = await self.identity(session)
            inbox = NotificationInbox(session, user, self.config)
            if self.action == "notification-list":
                unread = boolean_filter(self, "unread") is True
                cursor = self.get_query_argument("cursor", None)
                if cursor is not None and not 1 <= len(cursor) <= 4096:
                    raise Problem(400, "INVALID_CURSOR", "Inbox cursor is invalid")
                raw_limit = self.get_query_argument("limit", "25")
                if len(raw_limit) > 3 or not raw_limit.isascii() or not raw_limit.isdecimal():
                    raise Problem(
                        400, "INVALID_LIMIT", "Page limit must be an integer from 1 to 100"
                    )
                limit = int(raw_limit)
                if not 1 <= limit <= 100:
                    raise Problem(
                        400, "INVALID_LIMIT", "Page limit must be an integer from 1 to 100"
                    )
                await deliver_due_notifications(session, limit=_BATCH_SIZE)
                result = await inbox.list(cursor, limit, unread)
            else:
                result = await inbox.detail(notification_id.lower())
        self.respond(result)

    async def post(self, notification_id: str = "") -> None:
        """每个写动作先按已登记的独立正文模式验证，同源和 CSRF 由请求基类把关，成员变化沿用现有安装级写锁。"""
        schema = _WRITE_SCHEMAS.get(self.action)
        if not schema:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        body = self.body(schema)
        if self.action == "notification-stream":
            await self._stream()
            return
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            inbox = NotificationInbox(session, user, self.config)
            if self.action == "notification-read":
                result = await inbox.read(
                    notification_id.lower(),
                    form_origin=self.request.headers.get(FORM_ORIGIN_HEADER),
                )
            elif self.action == "notification-read-all":
                result = await inbox.read_all(body["through"])
            elif self.action == "notification-accept":
                result = await inbox.accept(
                    notification_id.lower(),
                    form_origin=self.request.headers.get(FORM_ORIGIN_HEADER),
                )
            else:
                result = await inbox.agent_seen(
                    body["workspaceId"].lower(), body["sessionId"].lower(), body["turnId"].lower()
                )
        self.respond(result)

    def on_connection_close(self) -> None:
        """断开的连接立即醒来并移除订阅，读取器不会因为低速网络或消失的浏览器一直保留等待队列。"""
        self._disconnected = True
        if subscriber := self._subscriber:
            subscriber.send(None)

    async def _stream(self) -> None:
        """先完成会话检查和首个版本查询，再切换到事件流；写出期间没有数据库事务，心跳和待写数据均有超时。"""
        self._disconnected = False
        async with self.db.sessions() as session:
            user, current = await self.identity(session)
        if self._disconnected:
            return
        watcher: NotificationWatcher = self.application.settings["notification_watcher"]
        subscriber = watcher.subscribe(user.id, current.id)
        self._subscriber = subscriber
        try:
            try:
                revision = await asyncio.wait_for(subscriber.pending.get(), timeout=_STREAM_TIMEOUT)
            except TimeoutError:
                raise Problem(
                    503, "NOTIFICATION_UNAVAILABLE", "Inbox stream is unavailable"
                ) from None
            if self._disconnected:
                return
            if revision is None:
                raise Problem(401, "AUTHENTICATION_REQUIRED", "Please sign in")
            self.set_header("Content-Type", "text/event-stream; charset=UTF-8")
            self.set_header("X-Accel-Buffering", "no")
            self._write_event("inbox", {"revision": revision})
            await asyncio.wait_for(self.flush(), timeout=_STREAM_TIMEOUT)
            while not self._disconnected:
                try:
                    revision = await asyncio.wait_for(
                        subscriber.pending.get(), timeout=_HEARTBEAT_SECONDS
                    )
                except TimeoutError:
                    self.write(": keepalive\n\n")
                else:
                    if self._disconnected:
                        break
                    if revision is None:
                        self._write_event("authorization", {"code": "AUTHENTICATION_REQUIRED"})
                        await asyncio.wait_for(self.flush(), timeout=_STREAM_TIMEOUT)
                        break
                    self._write_event("inbox", {"revision": revision})
                await asyncio.wait_for(self.flush(), timeout=_STREAM_TIMEOUT)
        except (StreamClosedError, TimeoutError):
            return
        finally:
            watcher.unsubscribe(subscriber)
            self._subscriber = None

    def _write_event(self, name: str, value: dict[str, str]) -> None:
        """只发送固定类型的失效或授权事件，不将业务摘要、账户标识和邀请秘密复制到可能长时间连接的响应。"""
        self.write(f"event: {name}\ndata: {json.dumps(value, separators=(',', ':'))}\n\n")
