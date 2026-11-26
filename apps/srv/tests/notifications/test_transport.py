"""站内信传输用真实会话和两套独立 Tornado 应用验证，请求以同一部署域进行 CSRF 核对且只连接专用测试库。"""

import asyncio
import json
import os
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

import httpx
import pytest
from sqlalchemy import delete, event, text
from sqlalchemy.engine import make_url
from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets

from veriq_server.app import make_app
from veriq_server.db import Base, Database, UserSession
from veriq_server.migrate import migrate
from veriq_server.service import digest, lock_installation, provision_setup_secret
from veriq_server.settings import Settings
from veriq_server.validation import validate_api

_ORIGIN = "http://veriq.test"
_PASSWORD = "Long password 123!"
_ROOT = "/api/v1/notifications"


@asynccontextmanager
async def _node(settings):
    """每个节点使用单独连接池和应用状态，通过系统分配环回端口，避免与本机开发服务或其它测试进程争用。"""
    database = Database(settings)
    application = make_app(settings, database)
    sockets = bind_sockets(0, "127.0.0.1")
    server = HTTPServer(application)
    server.add_sockets(sockets)
    try:
        yield f"http://127.0.0.1:{sockets[0].getsockname()[1]}", database
    finally:
        server.stop()
        await server.close_all_connections()
        await application.settings["notification_watcher"].close()
        await database.close()


@pytest.fixture(name="notification_nodes")
async def _notification_nodes(tmp_path):
    """测试专用数据库在重建前必须符合库名和表名双重约束，随后迁移到当前版本并初始化一次控制面安装记录。"""
    dsn = os.environ.get("VERIQ_NOTIFICATION_TEST_MYSQL")
    if not dsn:
        environment = Path(".superpowers/sdd/veriq-1/test-env.json")
        dsn = json.loads(environment.read_text(encoding="utf-8"))["mysql_dsn"]
    assert make_url(dsn).database == "veriq_test"
    settings = Settings(
        database_url=dsn,
        public_url=_ORIGIN,
        master_key="a" * 64,
        signing_key="b" * 64,
        environment="development",
        artifact_directory=str(tmp_path / "artifacts"),
    )
    database = Database(settings)
    try:
        async with database.engine.begin() as connection:
            tables = (await connection.execute(text("SHOW TABLES"))).scalars().all()
            assert set(tables) <= {*Base.metadata.tables, "veriq_alembic_version"}
            await connection.execute(text("SET FOREIGN_KEY_CHECKS=0"))
            for table in tables:
                await connection.execute(text(f"DROP TABLE `{table}`"))
            await connection.execute(text("SET FOREIGN_KEY_CHECKS=1"))
        await migrate(settings)
        await provision_setup_secret(database, "operator-secret")
    finally:
        await database.close()
    async with _node(settings) as first, _node(settings) as second:
        yield first, second


@asynccontextmanager
async def _client(address, email=None):
    """发起真实匿名初始化请求获取防跨站令牌，按用例需要登录后使用服务端更新过的令牌和会话 Cookie。"""
    async with httpx.AsyncClient(
        base_url=address, headers={"Origin": _ORIGIN}, timeout=10
    ) as client:
        boot = await client.get("/api/v1/setup")
        client.headers["X-CSRF-Token"] = boot.json()["data"]["csrfToken"]
        if email is not None:
            login = await client.post(
                "/api/v1/auth/login", json={"email": email, "password": _PASSWORD}
            )
            assert login.status_code == 200, login.text
            client.headers["X-CSRF-Token"] = login.json()["data"]["csrfToken"]
        yield client


async def _install(address):
    """两节点安装共享一个数据库，先从写节点完成初始化，再创建一个没有工作区成员身份的已注册邀请对象。"""
    async with _client(address) as client:
        setup = await client.post(
            "/api/v1/setup",
            json={
                "installationSecret": "operator-secret",
                "email": "admin@example.com",
                "displayName": "Administrator",
                "password": _PASSWORD,
            },
        )
        assert setup.status_code == 201, setup.text
    async with _client(address, "admin@example.com") as owner:
        created = await owner.post(
            "/api/v1/admin/users",
            json={
                "email": "recipient@example.com",
                "displayName": "Recipient",
                "password": _PASSWORD,
                "systemAdmin": False,
            },
        )
        assert created.status_code == 201, created.text


async def _invite(owner, key):
    """由真实邀请写入口发出通知，每次用独立工作区获得不同投递，测试不通过内部接口伪造消息。"""
    workspace = await owner.post("/api/v1/workspaces", json={"key": key, "name": key})
    assert workspace.status_code == 201, workspace.text
    workspace_id = workspace.json()["data"]["id"]
    invitation = await owner.post(
        f"/api/v1/workspaces/{workspace_id}/invitations",
        json={"email": "recipient@example.com", "role": "VIEWER"},
    )
    assert invitation.status_code == 201, invitation.text
    return workspace_id, invitation.json()["data"]["id"]


async def _frame(lines):
    """按帧读取实际网络流并跳过心跳，等待靠具体事件推进，服务端提前关闭或不发送事件都会形成失败。"""
    async with asyncio.timeout(10):
        current = {}
        async for line in lines:
            if line.startswith("event: "):
                current["event"] = line[7:]
            elif line.startswith("data: "):
                current["data"] = json.loads(line[6:])
            elif not line and current:
                return current
    raise AssertionError("Stream ended before a complete event")


async def test_inbox_requires_session_csrf_and_same_origin(notification_nodes):
    """验证匿名和伪造来源的请求均在传输层终止，错误响应仍走统一 JSON 信封且不会建立持续事件流。"""
    (first, _), (second, _) = notification_nodes
    await _install(first)
    async with _client(second) as anonymous:
        assert (await anonymous.get(_ROOT)).status_code == 401
        assert (await anonymous.post(_ROOT + "/stream", json={})).status_code == 401
    async with _client(second, "recipient@example.com") as recipient:
        rejected = await recipient.post(
            _ROOT + "/stream", json={}, headers={"Origin": "http://other.test"}
        )
        assert rejected.status_code == 403 and rejected.json()["code"] == "ORIGIN_FORBIDDEN"
        recipient.headers.pop("X-CSRF-Token")
        rejected = await recipient.post(_ROOT + "/stream", json={})
        assert rejected.status_code == 403 and rejected.json()["code"] == "CSRF_FORBIDDEN"
        invalid = await recipient.get(_ROOT, params={"unread": "yes"})
        assert invalid.status_code == 400 and invalid.json()["code"] == "INVALID_FILTER"


async def _receive_invitation(owner, recipient):
    """节点乙保持真实流连接，节点甲提交首条邀请，同时验证空白收件箱首帧、代理头与跨节点有效版本帧。"""
    async with recipient.stream("POST", _ROOT + "/stream", json={}) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert response.headers["x-accel-buffering"] == "no"
        lines = response.aiter_lines()
        assert await _frame(lines) == {"event": "inbox", "data": {"revision": "0"}}
        workspace_id, invitation_id = await _invite(owner, "first")
        inbox_event = await _frame(lines)
        validate_api("NotificationInboxEvent", inbox_event["data"])
        assert inbox_event["event"] == "inbox"
        revision = int(inbox_event["data"]["revision"])
        assert revision > 0
        return workspace_id, invitation_id, revision


async def _mark_and_reconnect(address, recipient, through, revision):
    """在原写入节点复用现有浏览器会话并标记旧快照，重新创建连接时只依据该节点读出的持久化版本继续。"""
    async with httpx.AsyncClient(
        base_url=address, cookies=recipient.cookies, headers=recipient.headers
    ) as other:
        read_all = await other.post(_ROOT + "/read-all", json={"through": through})
        assert read_all.status_code == 200 and read_all.json()["data"] == {"updated": 1}
        async with other.stream("POST", _ROOT + "/stream", json={}) as response:
            assert response.status_code == 200
            latest = await _frame(response.aiter_lines())
            assert latest["event"] == "inbox"
            assert int(latest["data"]["revision"]) > revision


async def test_cross_node_stream_reconnect_and_read_watermark(notification_nodes):
    """在节点甲写入并由节点乙推送，只用真实 HTTP 读取状态，同时验证读到的水位不会消耗其后提交的第二条邀请。"""
    (first, _), (second, _) = notification_nodes
    await _install(first)
    async with (
        _client(first, "admin@example.com") as owner,
        _client(second, "recipient@example.com") as recipient,
    ):
        workspace_id, invitation_id, revision = await _receive_invitation(owner, recipient)
        inbox = (await recipient.get(_ROOT)).json()["data"]
        validate_api("NotificationInboxDTO", inbox)
        assert inbox["unreadCount"] == 1
        notification = inbox["items"][0]
        assert notification["workspaceId"] == workspace_id
        assert notification["invitationId"] == invitation_id
        assert notification["invitationStatus"] == "PENDING"
        public_path = _ROOT + "/" + notification["id"]
        assert (await owner.get(public_path)).status_code == 404
        await _invite(owner, "second")
        await _mark_and_reconnect(first, recipient, inbox["readThrough"], revision)
        unread = (await recipient.get(_ROOT, params={"unread": "true"})).json()["data"]
        assert unread["unreadCount"] == 1 and len(unread["items"]) == 1
        assert unread["items"][0]["workspaceId"] != workspace_id
        cleared = await recipient.get(public_path)
        assert cleared.json()["data"]["readAt"]
        accepted = await recipient.post(public_path + "/accept", json={})
        assert accepted.status_code == 200 and accepted.json()["data"] == {
            "workspaceId": workspace_id
        }


async def test_stream_session_revocation_visible_across_nodes(notification_nodes):
    """已建立的流连接仍按活跃会话检查，另一节点退出之后只收到稳定授权事件，随后连接结束且无法读取通知。"""
    (first, _), (second, _) = notification_nodes
    await _install(first)
    async with _client(second, "recipient@example.com") as recipient:
        async with recipient.stream("POST", _ROOT + "/stream", json={}) as response:
            assert response.status_code == 200
            lines = response.aiter_lines()
            assert (await _frame(lines))["event"] == "inbox"
            async with httpx.AsyncClient(
                base_url=first, cookies=recipient.cookies, headers=recipient.headers
            ) as other:
                assert (await other.post("/api/v1/auth/logout", json={})).status_code == 200
            assert await _frame(lines) == {
                "event": "authorization",
                "data": {"code": "AUTHENTICATION_REQUIRED"},
            }
            async with asyncio.timeout(5):
                assert [line async for line in lines] == []
        assert (await recipient.get(_ROOT)).status_code == 401


@contextmanager
def _observe_installation_lock(database):
    """观察读节点已提交给驱动的行锁查询，测试在持有写锁时等这个信号或过早响应，无需猜测请求何时开始等待。"""
    attempting = asyncio.Event()

    def record(statement, **_context):
        """数据库允许提交注销前只采集安装单例锁的查询开始事件，真实 SQL 执行与网络响应仍由 Tornado 控制。"""
        if "veriq_installation" in statement and "FOR UPDATE" in statement:
            attempting.set()

    engine = database.engine.sync_engine
    event.listen(engine, "before_cursor_execute", record, named=True)
    try:
        yield attempting
    finally:
        event.remove(engine, "before_cursor_execute", record)


async def _queue_under_held_lock(tasks, operation, attempting):
    """持锁事务只等待目标请求向驱动提交获取锁的语句，返回得更早的请求没有参与同一个数据库串行化边界。"""
    request = tasks.create_task(operation)
    observed = tasks.create_task(attempting.wait())
    async with asyncio.timeout(5):
        done, _ = await asyncio.wait({request, observed}, return_when=asyncio.FIRST_COMPLETED)
    assert request not in done, "HTTP request returned before the installation lock was released"
    return request


async def _read_after_revoke(writer, reader, recipient, route):
    """持锁模拟另一节点撤销会话，读取必须受同一边界约束；只在观察到数据库请求已排队后提交真正的撤销。"""
    session_token = recipient.cookies.get("veriq_session")
    assert session_token
    async with asyncio.TaskGroup() as tasks:
        with _observe_installation_lock(reader) as attempting:
            async with writer.sessions.begin() as transaction:
                await lock_installation(transaction)
                request = await _queue_under_held_lock(tasks, recipient.get(route), attempting)
                removed = await transaction.execute(
                    delete(UserSession).where(UserSession.token_hash == digest(session_token))
                )
                assert removed.rowcount == 1
            return await request


@pytest.mark.parametrize("detail", [False, True], ids=["list", "detail"])
async def test_inbox_read_waits_for_inflight_session_revocation(notification_nodes, detail):
    """并发退出一旦在真实 MySQL 事务中提交，已排队的列表或详情请求须重新确认会话，并以认证错误结束。"""
    (first, writer), (second, reader) = notification_nodes
    await _install(first)
    async with (
        _client(first, "admin@example.com") as owner,
        _client(second, "recipient@example.com") as recipient,
    ):
        await _invite(owner, "revoked-reader")
        initial = await recipient.get(_ROOT)
        assert initial.status_code == 200
        notification = initial.json()["data"]["items"][0]
        route = f"{_ROOT}/{notification['id']}" if detail else _ROOT
        response = await _read_after_revoke(writer, reader, recipient, route)
        assert response.status_code == 401
        assert response.json()["code"] == "AUTHENTICATION_REQUIRED"
        assert "data" not in response.json()


async def test_http_logout_waits_for_installation_lock(notification_nodes):
    """另一节点持锁时实际注销请求也须排队，待成功注销后旧客户端无法打开收件箱，再注销仍沿用既有错误。"""
    (first, writer), (second, reader) = notification_nodes
    await _install(first)
    async with _client(second, "recipient@example.com") as recipient:
        assert (await recipient.get(_ROOT)).status_code == 200
        async with httpx.AsyncClient(
            base_url=first, cookies=recipient.cookies, headers=recipient.headers
        ) as logout_client:
            async with asyncio.TaskGroup() as tasks:
                with _observe_installation_lock(writer) as attempting:
                    async with reader.sessions.begin() as transaction:
                        await lock_installation(transaction)
                        request = await _queue_under_held_lock(
                            tasks, logout_client.post("/api/v1/auth/logout", json={}), attempting
                        )
                    completed = await request
            assert completed.status_code == 200 and completed.json()["data"] == {}
            repeated = await logout_client.post("/api/v1/auth/logout", json={})
            assert (
                repeated.status_code == 401 and repeated.json()["code"] == "AUTHENTICATION_REQUIRED"
            )
        old_session = await recipient.get(_ROOT)
        assert (
            old_session.status_code == 401
            and old_session.json()["code"] == "AUTHENTICATION_REQUIRED"
        )
