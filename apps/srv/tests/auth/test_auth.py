"""Auth acceptance uses a task-only schema in actual MySQL, never SQLite."""

import httpx
from sqlalchemy import select

from veriq_server.db import User, UserToken
from veriq_server.service import digest


async def setup(c):
    return await c.post(
        "/api/v1/setup",
        json={
            "installationSecret": "operator-secret",
            "email": "admin@example.com",
            "displayName": "Administrator",
            "password": "Long password 123!",
        },
    )


async def login(c, email="admin@example.com", password="Long password 123!"):
    r = await c.post("/api/v1/auth/login", json={"email": email, "password": password})
    if r.status_code == 200:
        c.headers["X-CSRF-Token"] = r.json()["data"]["csrfToken"]
    return r


async def test_setup_guard_and_session_security(site):
    c, db = site
    bad = await c.post(
        "/api/v1/setup",
        json={
            "installationSecret": "wrong",
            "email": "a@example.com",
            "displayName": "A",
            "password": "Long password 123!",
        },
    )
    assert bad.status_code == 403
    import asyncio

    results = await asyncio.gather(setup(c), setup(c))
    assert sorted(r.status_code for r in results) == [201, 409]
    async with db.sessions() as s:
        user = (await s.execute(select(User))).scalar_one()
        assert user.password_hash.startswith("$argon2id$")
        assert "Long password" not in user.password_hash
    wrong = await login(c, password="bad")
    absent = await login(c, email="missing@example.com")
    assert wrong.status_code == absent.status_code == 401
    assert wrong.json()["message"] == absent.json()["message"]
    r = await login(c)
    assert r.status_code == 200
    from veriq_server.validation import validate_api

    validate_api("SessionDTO", r.json()["data"])
    assert "HttpOnly" in r.headers["set-cookie"] and "SameSite=Strict" in r.headers["set-cookie"]
    token = c.headers.pop("X-CSRF-Token")
    assert (await c.post("/api/v1/auth/logout", json={})).status_code == 403
    c.headers["X-CSRF-Token"] = token
    assert (await c.post("/api/v1/auth/logout", json={})).status_code == 200
    assert (await c.get("/api/v1/auth/session")).status_code == 401


async def test_admin_reset_disable_and_last_admin(site):
    c, db = site
    await setup(c)
    await login(c)
    assert (
        await c.patch(
            "/api/v1/admin/users/"
            + (await c.get("/api/v1/auth/session")).json()["data"]["user"]["id"],
            json={"disabled": True},
        )
    ).status_code == 409
    r = await c.post(
        "/api/v1/admin/users",
        json={
            "email": "user@example.com",
            "displayName": "User",
            "password": "Long password 123!",
            "systemAdmin": False,
        },
    )
    assert r.status_code == 201
    uid = r.json()["data"]["id"]
    link = await c.post(f"/api/v1/admin/users/{uid}/reset-link", json={})
    assert link.status_code == 200
    token = link.json()["data"]["url"].split("token=")[1]
    async with db.sessions() as s:
        stored = (await s.execute(select(UserToken))).scalar_one()
        assert stored.token_hash == digest(token) and stored.token_hash != token
    assert (
        await c.post(
            "/api/v1/auth/password-reset/confirm",
            json={"token": token, "newPassword": "Changed password 123!"},
        )
    ).status_code == 200
    assert (
        await c.post(
            "/api/v1/auth/password-reset/confirm",
            json={"token": token, "newPassword": "Changed password 123!"},
        )
    ).status_code == 400
    await login(c, "user@example.com", "Changed password 123!")
    assert (await c.get("/api/v1/admin/users")).status_code == 403
    assert (
        await c.post("/api/v1/auth/password-reset", json={"email": "missing@example.com"})
    ).json()["data"] == {}
    assert (await c.post("/api/v1/auth/password-reset", json={"email": "user@example.com"})).json()[
        "data"
    ] == {}
    await login(c)
    await c.patch(f"/api/v1/admin/users/{uid}", json={"disabled": True})
    assert (await login(c, "user@example.com", "Changed password 123!")).status_code == 401
    assert (await c.get("/api/v1/unknown")).status_code == 404
    malformed = await c.post(
        "/api/v1/auth/login", content="{", headers={"Content-Type": "application/json"}
    )
    assert malformed.status_code == 400 and set(malformed.json()) == {
        "code",
        "message",
        "details",
        "requestId",
    }


async def test_expiry_revoke_password_origin_and_safe_errors(site):
    from datetime import timedelta
    from sqlalchemy import update
    from veriq_server.db import UserSession
    from veriq_server.service import now

    c, db = site
    await setup(c)
    await login(c)
    uid = (await c.get("/api/v1/account")).json()["data"]["id"]
    session_cookie = c.cookies.get("veriq_session")
    async with db.sessions.begin() as s:
        await s.execute(update(UserSession).values(expires_at=now() - timedelta(seconds=1)))
    assert (await c.get("/api/v1/auth/session")).status_code == 401
    await login(c)
    async with db.sessions() as s:
        stored = (
            await s.execute(
                select(UserSession).where(
                    UserSession.token_hash == digest(c.cookies.get("veriq_session"))
                )
            )
        ).scalar_one()
        assert stored.token_hash != session_cookie
    assert (
        await c.post("/api/v1/auth/logout", json={}, headers={"Origin": "https://attacker.example"})
    ).status_code == 403
    link = (await c.post(f"/api/v1/admin/users/{uid}/reset-link", json={})).json()["data"]["url"]
    reset_token = link.split("token=")[1]
    async with db.sessions.begin() as s:
        await s.execute(update(UserToken).values(expires_at=now() - timedelta(seconds=1)))
    assert (
        await c.post(
            "/api/v1/auth/password-reset/confirm",
            json={"token": reset_token, "newPassword": "New password 123!"},
        )
    ).status_code == 400
    assert (
        await c.post(
            "/api/v1/account/password",
            json={"currentPassword": "wrong", "newPassword": "New password 123!"},
        )
    ).status_code == 400
    assert (
        await c.post(
            "/api/v1/account/password",
            json={"currentPassword": "Long password 123!", "newPassword": "New password 123!"},
        )
    ).status_code == 200
    assert (await c.get("/api/v1/auth/session")).status_code == 401
    assert (await login(c)).status_code == 401
    assert (await login(c, password="New password 123!")).status_code == 200
    assert (await c.post("/api/v1/account/sessions/revoke", json={})).status_code == 200
    assert (await c.get("/api/v1/auth/session")).status_code == 401
    # App-level body limit preserves the JSON error envelope (below transport hard limit).
    oversized = await c.post(
        "/api/v1/auth/login", content="x" * 65537, headers={"Content-Type": "application/json"}
    )
    assert oversized.status_code == 413 and oversized.json()["code"] == "BODY_TOO_LARGE"


async def test_concurrent_last_admin_and_disabled_session(site):
    import asyncio

    c, db = site
    await setup(c)
    await login(c)
    admin1 = (await c.get("/api/v1/account")).json()["data"]["id"]
    admin2 = (
        await c.post(
            "/api/v1/admin/users",
            json={
                "email": "second@example.com",
                "displayName": "Second",
                "password": "Long password 123!",
                "systemAdmin": True,
            },
        )
    ).json()["data"]["id"]
    # Two clients representing distinct administrators race to disable themselves.
    async with httpx.AsyncClient(
        base_url=str(c.base_url), headers={"Origin": str(c.base_url).rstrip("/")}
    ) as other:
        state = await other.get("/api/v1/setup")
        other.headers["X-CSRF-Token"] = state.json()["data"]["csrfToken"]
        await login(other, "second@example.com")
        results = await asyncio.gather(
            c.patch(f"/api/v1/admin/users/{admin1}", json={"disabled": True}),
            other.patch(f"/api/v1/admin/users/{admin2}", json={"disabled": True}),
        )
        assert sorted(r.status_code for r in results) == [200, 409]
        disabled_client = c if results[0].status_code == 200 else other
        assert (await disabled_client.get("/api/v1/auth/session")).status_code == 401
    async with db.sessions() as s:
        enabled = (
            (
                await s.execute(
                    select(User).where(User.system_admin.is_(True), User.disabled.is_(False))
                )
            )
            .scalars()
            .all()
        )
        assert len(enabled) == 1


async def test_reset_and_admin_revoke_invalidate_another_browser(site):
    c, db = site
    await setup(c)
    await login(c)
    uid = (
        await c.post(
            "/api/v1/admin/users",
            json={
                "email": "session-user@example.com",
                "displayName": "Session User",
                "password": "Long password 123!",
                "systemAdmin": False,
            },
        )
    ).json()["data"]["id"]
    async with httpx.AsyncClient(
        base_url=str(c.base_url), headers={"Origin": str(c.base_url).rstrip("/")}
    ) as other:
        state = await other.get("/api/v1/setup")
        other.headers["X-CSRF-Token"] = state.json()["data"]["csrfToken"]
        await login(other, "session-user@example.com")
        assert (await other.get("/api/v1/auth/session")).status_code == 200
        reset = (
            (await c.post(f"/api/v1/admin/users/{uid}/reset-link", json={}))
            .json()["data"]["url"]
            .split("token=")[1]
        )
        assert (
            await c.post(
                "/api/v1/auth/password-reset/confirm",
                json={"token": reset, "newPassword": "Changed password 123!"},
            )
        ).status_code == 200
        assert (await other.get("/api/v1/auth/session")).status_code == 401
        await login(other, "session-user@example.com", "Changed password 123!")
        assert (
            await c.post(f"/api/v1/admin/users/{uid}/sessions/revoke", json={})
        ).status_code == 200
        assert (await other.get("/api/v1/auth/session")).status_code == 401
        await login(other, "session-user@example.com", "Changed password 123!")
        assert (
            await c.patch(f"/api/v1/admin/users/{uid}", json={"disabled": True})
        ).status_code == 200
        assert (await other.get("/api/v1/auth/session")).status_code == 401


async def test_production_cookie_and_database_shape(site):
    from veriq_server.app import make_app
    from veriq_server.settings import Settings
    from tornado.httpserver import HTTPServer
    from sqlalchemy import text

    c, db = site
    await setup(c)
    # Only cookie flags are inspected here; the production TLS terminator is outside T02.
    config = Settings(
        database_url=db.engine.url.render_as_string(hide_password=False),
        public_url="https://veriq.example.com",
        master_key="a" * 64,
        signing_key="b" * 64,
    )
    server = HTTPServer(make_app(config, db))
    server.listen(18891, "127.0.0.1")
    try:
        async with httpx.AsyncClient(
            base_url="http://127.0.0.1:18891", headers={"Origin": config.public_url}
        ) as other:
            state = await other.get("/api/v1/setup")
            assert "Secure" in state.headers["set-cookie"]
            response = await other.post(
                "/api/v1/auth/login",
                json={"email": "admin@example.com", "password": "Long password 123!"},
                headers={
                    "Cookie": "_xsrf=" + state.cookies["_xsrf"],
                    "X-CSRF-Token": state.json()["data"]["csrfToken"],
                },
            )
            assert response.status_code == 200
            assert all(
                flag in response.headers["set-cookie"]
                for flag in ["Secure", "HttpOnly", "SameSite=Strict"]
            )
    finally:
        server.stop()
        await server.close_all_connections()
    async with db.sessions() as s:
        assert str((await s.execute(text("SELECT VERSION()"))).scalar()).startswith("8.4.13")
        assert (await s.execute(text("SELECT @@session.time_zone"))).scalar() == "+00:00"
        assert (
            await s.execute(text("SELECT @@transaction_isolation"))
        ).scalar() == "READ-COMMITTED"
        assert (
            await s.execute(text("SELECT version_num FROM veriq_alembic_version"))
        ).scalar() == "0008_reports"
        assert (
            await s.execute(
                text(
                    "SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='veriq_artifacts' AND COLUMN_NAME='content'"
                )
            )
        ).scalar() == "YES"
        assert (
            await s.execute(
                text(
                    "SELECT DATETIME_PRECISION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='veriq_attempts' AND COLUMN_NAME='finished_at'"
                )
            )
        ).scalar() == 6
        columns = (
            await s.execute(
                text(
                    "SELECT TABLE_NAME,COLUMN_NAME,DATETIME_PRECISION,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()"
                )
            )
        ).all()
        for table, column, precision, collation in columns:
            if column in {"id", "user_id"} and table != "veriq_installation":
                assert collation == "ascii_bin"
            if column in {"created_at", "expires_at"}:
                assert precision == 6
