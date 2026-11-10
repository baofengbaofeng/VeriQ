"""Observable bounded list traversal on real HTTP/MySQL."""

from datetime import timedelta
from uuid import uuid4

import httpx
from sqlalchemy import select

from veriq_server.db import User, UserSession
from veriq_server.service import digest, now
from test_auth import setup, login


async def test_users_filtered_keyset_pages_and_caps(site):
    c, db = site
    await setup(c)
    await login(c)
    expected = []
    async with db.sessions.begin() as s:
        admin = (await s.execute(select(User))).scalar_one()
        for index in range(105):
            uid = str(uuid4())
            s.add(
                User(
                    id=uid,
                    email=f"team-{index:03}@example.com",
                    display_name="Team User",
                    password_hash=admin.password_hash,
                    disabled=index % 2 == 0,
                    system_admin=False,
                )
            )
            if index % 2 == 0:
                expected.append(uid)
    ids = []
    cursor = None
    while True:
        params = {"limit": "7", "q": "team-", "disabled": "true", "systemAdmin": "false"}
        if cursor:
            params["cursor"] = cursor
        r = await c.get("/api/v1/admin/users", params=params)
        assert r.status_code == 200
        page = r.json()["data"]
        assert 0 < len(page["items"]) <= 7
        ids.extend(item["id"] for item in page["items"])
        cursor = page["nextCursor"]
        if cursor is None:
            break
    assert ids == expected and len(ids) == len(set(ids))
    cap = (await c.get("/api/v1/admin/users", params={"limit": "100"})).json()["data"]
    assert len(cap["items"]) == 100 and cap["nextCursor"]
    for params in [
        {"limit": "101"},
        {"limit": "0"},
        {"limit": "abc"},
        {"cursor": "malformed"},
        {"disabled": "yes"},
        {"q": "x" * 255},
    ]:
        assert (await c.get("/api/v1/admin/users", params=params)).status_code == 400
    assert (
        await c.get("/api/v1/admin/users", params={"cursor": cap["nextCursor"], "q": "different"})
    ).status_code == 400
    assert (await c.get("/api/v1/admin/users", params={"q": "team-%"})).json()["data"][
        "items"
    ] == []
    admins = (
        await c.get("/api/v1/admin/users", params={"disabled": "false", "systemAdmin": "true"})
    ).json()["data"]["items"]
    assert len(admins) == 1 and admins[0]["email"] == "admin@example.com"
    # Authorization is checked before cursors, and a cursor grants no capability.
    await c.post("/api/v1/auth/logout", json={})
    assert (
        await c.get("/api/v1/admin/users", params={"cursor": cap["nextCursor"]})
    ).status_code == 401


async def test_own_sessions_stable_ties_scope_and_caps(site):
    c, db = site
    await setup(c)
    await login(c)
    current = (await c.get("/api/v1/account/sessions")).json()["data"]["items"][0]["id"]
    created = now() - timedelta(minutes=1)
    own_ids = []
    async with db.sessions.begin() as s:
        admin = (await s.execute(select(User))).scalar_one()
        other = User(
            id=str(uuid4()),
            email="other@example.com",
            display_name="Other",
            password_hash=admin.password_hash,
            disabled=False,
            system_admin=False,
        )
        s.add(other)
        await s.flush()
        for index in range(105):
            uid = str(uuid4())
            own_ids.append(uid)
            s.add(
                UserSession(
                    id=uid,
                    user_id=admin.id,
                    token_hash=digest("owned-session-" + str(index)),
                    created_at=created,
                    expires_at=now() + timedelta(hours=1),
                )
            )
        s.add(
            UserSession(
                id=str(uuid4()),
                user_id=admin.id,
                token_hash=digest("expired-own-session"),
                created_at=created,
                expires_at=now() - timedelta(seconds=1),
            )
        )
        s.add(
            UserSession(
                id=str(uuid4()),
                user_id=other.id,
                token_hash=digest("foreign-session"),
                created_at=created,
                expires_at=now() + timedelta(hours=1),
            )
        )
    cursor = None
    ids = []
    first_cursor = None
    while True:
        params = {"limit": "9"}
        if cursor:
            params["cursor"] = cursor
        page = (await c.get("/api/v1/account/sessions", params=params)).json()["data"]
        assert 0 < len(page["items"]) <= 9
        ids.extend(item["id"] for item in page["items"])
        cursor = page["nextCursor"]
        first_cursor = first_cursor or cursor
        if not cursor:
            break
    assert ids == sorted(own_ids) + [current] and len(ids) == len(set(ids))
    assert (
        len(
            (await c.get("/api/v1/account/sessions", params={"limit": "100"})).json()["data"][
                "items"
            ]
        )
        == 100
    )
    for params in [{"limit": "101"}, {"limit": "0"}, {"cursor": "invalid"}]:
        assert (await c.get("/api/v1/account/sessions", params=params)).status_code == 400
    async with httpx.AsyncClient(
        base_url=str(c.base_url), headers={"Origin": str(c.base_url).rstrip("/")}
    ) as other_client:
        state = await other_client.get("/api/v1/setup")
        other_client.headers["X-CSRF-Token"] = state.json()["data"]["csrfToken"]
        await login(other_client, "other@example.com")
        assert (
            await other_client.get("/api/v1/account/sessions", params={"cursor": first_cursor})
        ).status_code == 400
        assert (
            await other_client.get("/api/v1/admin/users", params={"cursor": first_cursor})
        ).status_code == 403
    assert (await c.get("/api/v1/admin/users", params={"cursor": first_cursor})).status_code == 400
