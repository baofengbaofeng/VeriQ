"""重置入口在创建任务前执行有界准入，跨节点冷却读取数据库令牌；测试不连接外部邮件或使用生产账户。"""

import asyncio
from datetime import timedelta

import pytest
from sqlalchemy import select, update

from veriq_server import delivery
from veriq_server.handlers import auth
from veriq_server.db import UserToken
from veriq_server.delivery import ResetDispatcher
from veriq_server.service import now
from veriq_server.settings import Settings
from test_auth import login, setup


async def test_reset_admission_bounds_tasks_before_scheduling(monkeypatch):
    """阻塞下游执行时仍限制实际任务数量，同一规范邮箱只允许一个在途任务；完成释放后可以再次进入队列。"""
    gate = asyncio.Event()

    async def blocked(_email):
        """只替换任务的下游等待，保留真实的准入及完成回调；释放信号确定任务结束顺序，不依赖邮件或数据库时延。"""
        await gate.wait()

    dispatcher = ResetDispatcher(None, None, object())
    monkeypatch.setattr(dispatcher, "_run", blocked)
    try:
        for index in range(100):
            dispatcher.submit(f"user-{index}@example.invalid")
        assert len(dispatcher.pending) == 32
    finally:
        gate.set()
        await dispatcher.close()

    gate.clear()
    try:
        dispatcher.submit("same@example.invalid")
        dispatcher.submit("SAME@example.invalid")
        assert len(dispatcher.pending) == 1
    finally:
        gate.set()
        await dispatcher.close()


async def test_reset_source_limit_recovers_after_window(monkeypatch):
    """同一来源在固定窗口内达到上限后不再创建任务，其他来源仍能进入；过窗后再次准入而不依赖真实等待。"""
    clock = [10.0]
    monkeypatch.setattr(delivery, "monotonic", lambda: clock[0], raising=False)
    delivered = []

    async def complete(email):
        """收集真正经过准入的合成邮箱执行结果，拒绝请求不会到达此执行体；只替换下游，不模拟限流判断本身。"""
        delivered.append(email)

    dispatcher = ResetDispatcher(None, None, object())
    monkeypatch.setattr(dispatcher, "_run", complete)
    for index in range(6):
        dispatcher.submit(f"one-{index}@example.invalid", source="192.0.2.1")
        await dispatcher.close()
    assert len(delivered) == 5
    dispatcher.submit("other@example.invalid", source="192.0.2.2")
    await dispatcher.close()
    assert len(delivered) == 6
    clock[0] += 60
    dispatcher.submit("retry@example.invalid", source="192.0.2.1")
    await dispatcher.close()
    assert delivered[-1] == "retry@example.invalid"


async def test_reset_disabled_delivery_has_no_tasks_or_work():
    """未配置邮件投递器时不为任何邮箱分配后台任务，保持原有无差别响应边界，也不建立邮箱或来源历史缓存。"""
    dispatcher = ResetDispatcher(None, None, None)
    for index in range(100):
        dispatcher.submit(f"user-{index}@example.invalid")
    assert not dispatcher.pending


async def test_reset_email_cooldown_is_shared_between_dispatchers(site):
    """两个独立投递器共享真实数据库；未消费的新令牌抑制第二封邮件，过窗后新申请仍正常签发。"""
    client, db = site
    await setup(client)
    messages = []

    class CapturedDelivery:
        """只替换对外邮件投递接口，在内存保存合成邮件；账号查询、安装锁、签发、冷却及提交仍执行真实生产代码。"""

        async def send(self, recipient, _subject, body):
            """在内存收集专用账户生成的邮件并验证投递次数，不连接外部邮件服务，也不把一次性重置链接写入测试日志。"""
            messages.append((recipient, body))

    settings = Settings(
        database_url=db.engine.url.render_as_string(hide_password=False),
        public_url="http://127.0.0.1:18889",
        master_key="a" * 64,
        signing_key="b" * 64,
        environment="development",
    )
    first = ResetDispatcher(db, settings, CapturedDelivery())
    second = ResetDispatcher(db, settings, CapturedDelivery())
    first.submit("admin@example.com")
    await first.close()
    async with db.sessions() as session:
        original = (await session.execute(select(UserToken.token_hash))).scalar_one()
    second.submit("ADMIN@example.com")
    await second.close()
    assert len(messages) == 1
    async with db.sessions() as session:
        assert (await session.execute(select(UserToken.token_hash))).scalar_one() == original
    async with db.sessions.begin() as session:
        await session.execute(update(UserToken).values(issued_at=now() - timedelta(seconds=61)))
    second.submit("admin@example.com")
    await second.close()
    assert len(messages) == 2
    async with db.sessions() as session:
        assert (await session.execute(select(UserToken.token_hash))).scalar_one() != original


@pytest.mark.parametrize("expired", [False, True])
async def test_reset_expiry_uses_database_clock_not_api_clock(site, monkeypatch, expired):
    """签发与确认共用数据库 UTC；API 主机快慢一年均不改变令牌在数据库期限内外的实际接受结果。"""
    client, db = site
    await setup(client)
    await login(client)
    user = (await client.get("/api/v1/account")).json()["data"]["id"]
    url = (await client.post(f"/api/v1/admin/users/{user}/reset-link", json={})).json()["data"][
        "url"
    ]
    token = url.split("token=")[1]
    if expired:
        async with db.sessions.begin() as session:
            await session.execute(update(UserToken).values(expires_at=now() - timedelta(seconds=1)))
    host_clock = now() + timedelta(days=-366 if expired else 366)
    monkeypatch.setattr(auth, "now", lambda: host_clock)
    response = await client.post(
        "/api/v1/auth/password-reset/confirm",
        json={"token": token, "newPassword": "Changed password 123!"},
    )
    assert response.status_code == (400 if expired else 200)
