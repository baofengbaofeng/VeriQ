"""用真实登录、账户会话列表与撤销路由验证展示摘要、活动时间和权限范围，测试不依赖实际用户或外部服务。"""

from asyncio import gather
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import select, update

from veriq_server import migrate
from veriq_server.auth.session_client import classify_session_client
from veriq_server.db import AuditLog, User, UserSession
from veriq_server.service import digest, now, stamp
from test_auth import login, setup

SESSIONS = "/api/v1/account/sessions"
CHROME_ON_MAC = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 example-extension"
)


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("", (None, None)),
        ("unknown-client/1", ("OTHER", "OTHER")),
        (
            "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.0.0 Safari/537.36 Edg/130.0",
            ("EDGE", "WINDOWS"),
        ),
        ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1", ("SAFARI", "IOS")),
        ("Mozilla/5.0 (Linux; Android 14) Chrome/130.0.0.0 Safari/537.36", ("CHROME", "ANDROID")),
        ("Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0 Electron/45.0", ("ELECTRON", "LINUX")),
    ],
)
def test_session_client_hint_uses_specific_family(header, expected):
    """浏览器兼容标记不能盖过更具体的分类，空头保留未知状况，其他输入全部收敛成有限的展示值。"""
    assert classify_session_client(header) == expected


async def test_session_summary_and_activity_follow_authenticated_use(site):
    """浏览器摘要只公开粗粒度分类，活动更新保留到期时间；会话探测与列表读取不会把当前会话标为近期使用。"""
    c, db = site
    assert (await setup(c)).status_code == 201
    c.headers["User-Agent"] = CHROME_ON_MAC
    assert (await login(c)).status_code == 200
    summary = (await c.get(SESSIONS)).json()["data"]["items"][0]
    assert summary["browser"] == "CHROME"
    assert summary["operatingSystem"] == "MACOS"
    assert summary["lastActiveAt"] == summary["createdAt"]
    assert set(summary) == {
        "id",
        "current",
        "createdAt",
        "expiresAt",
        "browser",
        "operatingSystem",
        "lastActiveAt",
    }

    # 直接把会话设为历史活动，不使用真实等待；随后通过独立请求观察服务端记录的变化与节流边界。
    previous = now() - timedelta(minutes=2)
    async with db.sessions.begin() as session:
        await session.execute(
            update(UserSession)
            .where(UserSession.id == summary["id"])
            .values(last_active_at=previous)
        )
    assert (await c.get("/api/v1/auth/session")).status_code == 200
    listing = (await c.get(SESSIONS)).json()["data"]["items"][0]
    assert listing["lastActiveAt"] == stamp(previous)

    started = now()
    assert (await c.get("/api/v1/account")).status_code == 200
    for _ in range(30):
        listing = (await c.get(SESSIONS)).json()["data"]["items"][0]
        if listing["lastActiveAt"] != stamp(previous):
            break
    assert stamp(started) <= listing["lastActiveAt"] <= stamp(now())
    assert listing["expiresAt"] == summary["expiresAt"]
    assert (await c.get("/api/v1/account")).status_code == 200
    assert (await c.get(SESSIONS)).json()["data"]["items"] == [listing]


async def test_migrated_legacy_session_remains_authenticated(site):
    """回退到旧结构再升级，老会话保留固定到期和认证能力；第一次合格请求才开始填充活动时间。"""
    c, db = site
    assert (await setup(c)).status_code == 201
    assert (await login(c)).status_code == 200
    original = (await c.get(SESSIONS)).json()["data"]["items"][0]
    config = Config()
    config.set_main_option("script_location", str(Path(migrate.__file__).parent / "migrations"))
    async with db.engine.connect() as connection:
        # 只在本用例的专用数据库里执行降级，用重新添加的可空列模拟升级前已经签发的旧会话。
        def round_trip(sync):
            config.attributes["connection"] = sync
            command.downgrade(config, "0022_agent_attachments")
            command.upgrade(config, "head")

        await connection.run_sync(round_trip)
        await connection.commit()
    assert (await c.get("/api/v1/auth/session")).status_code == 200
    legacy = (await c.get(SESSIONS)).json()["data"]["items"][0]
    assert legacy == {key: original[key] for key in ("id", "current", "createdAt", "expiresAt")}

    started = now()
    assert (await c.get("/api/v1/account")).status_code == 200
    for _ in range(30):
        listing = (await c.get(SESSIONS)).json()["data"]["items"][0]
        if "lastActiveAt" in listing:
            break
    assert stamp(started) <= listing.pop("lastActiveAt") <= stamp(now())
    assert listing == legacy


async def test_revoke_only_unexpired_other_sessions_owned_by_caller(site):
    """分别登录当前、其他和外部账户会话，核对单条失效的真实认证结果、同源门禁及拒绝时不产生审计记录。"""
    c, db = site
    assert (await setup(c)).status_code == 201
    assert (await login(c)).status_code == 200
    current = (await c.get(SESSIONS)).json()["data"]["items"][0]["id"]
    foreign_email = "other-session@veriq.test"
    created = await c.post(
        "/api/v1/admin/users",
        json={
            "email": foreign_email,
            "displayName": "Other session owner",
            "password": "Long password 123!",
            "systemAdmin": False,
        },
    )
    assert created.status_code == 201

    origin = str(c.base_url).rstrip("/")
    async with (
        httpx.AsyncClient(base_url=origin, headers={"Origin": origin}) as other,
        httpx.AsyncClient(base_url=origin, headers={"Origin": origin}) as foreign,
    ):
        for client in (other, foreign):
            setup_response = await client.get("/api/v1/setup")
            client.headers["X-CSRF-Token"] = setup_response.json()["data"]["csrfToken"]
        assert (await login(other)).status_code == 200
        assert (await login(foreign, foreign_email)).status_code == 200
        target = next(
            row["id"]
            for row in (await c.get(SESSIONS)).json()["data"]["items"]
            if not row["current"]
        )
        foreign_id = (await foreign.get(SESSIONS)).json()["data"]["items"][0]["id"]
        expired_id = str(uuid4())
        async with db.sessions.begin() as session:
            owner = (
                await session.execute(select(User).where(User.system_admin.is_(True)))
            ).scalar_one()
            session.add(
                UserSession(
                    id=expired_id,
                    user_id=owner.id,
                    token_hash=digest("synthetic-expired-session"),
                    created_at=now() - timedelta(hours=1),
                    expires_at=now() - timedelta(minutes=1),
                )
            )
        destination = f"{SESSIONS}/{target}"
        for headers in ({"X-CSRF-Token": ""}, {"Origin": "https://foreign-origin.test"}):
            assert (await c.delete(destination, headers=headers)).status_code == 403
        assert (await other.get("/api/v1/auth/session")).status_code == 200

        response = await c.delete(f"{SESSIONS}/{current.upper()}")
        assert (response.status_code, response.json()["code"]) == (
            409,
            "CANNOT_REVOKE_CURRENT_SESSION",
        )
        for unavailable in (expired_id, foreign_id, str(uuid4())):
            response = await c.delete(f"{SESSIONS}/{unavailable}")
            assert (response.status_code, response.json()["code"]) == (404, "SESSION_NOT_FOUND")
        # 相同会话被两次并发撤销时，只有一个请求删除记录并成功返回，另一次保持查无有效会话的结果。
        first, second = await gather(c.delete(destination), c.delete(destination))
        successful, unavailable = sorted((first, second), key=lambda response: response.status_code)
        assert successful.status_code == 200 and successful.json()["data"] == {}
        assert (unavailable.status_code, unavailable.json()["code"]) == (404, "SESSION_NOT_FOUND")
        assert (await other.get("/api/v1/auth/session")).status_code == 401
        assert (await foreign.get("/api/v1/auth/session")).status_code == 200
        assert (await c.get("/api/v1/auth/session")).status_code == 200
        assert [row["id"] for row in (await c.get(SESSIONS)).json()["data"]["items"]] == [current]

        async with db.sessions() as session:
            audit = (
                await session.execute(select(AuditLog).where(AuditLog.action == "session.revoked"))
            ).scalar_one()
            assert (audit.actor_id, audit.target_id, audit.workspace_id) == (owner.id, target, None)
