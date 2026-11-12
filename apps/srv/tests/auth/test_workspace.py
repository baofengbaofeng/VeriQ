
import asyncio
from contextlib import asynccontextmanager
from urllib.parse import urlsplit, parse_qs

import httpx
from sqlalchemy import select

from veriq_server.db import User
from test_auth import setup, login


@asynccontextmanager
async def client(c, email, password="Long password 123!"):
    async with httpx.AsyncClient(
        base_url=str(c.base_url), headers={"Origin": str(c.base_url).rstrip("/")}
    ) as other:
        other.headers["X-CSRF-Token"] = (await other.get("/api/v1/setup")).json()["data"][
            "csrfToken"
        ]
        assert (await login(other, email, password)).status_code == 200
        yield other


async def workspace(c, key="alpha"):
    r = await c.post("/api/v1/workspaces", json={"key": key, "name": key.title()})
    assert r.status_code == 201, r.text
    return r.json()["data"]["id"]


async def invite(c, ws, email="member@example.com", role="VIEWER"):
    r = await c.post(f"/api/v1/workspaces/{ws}/invitations", json={"email": email, "role": role})
    assert r.status_code == 201, r.text
    return parse_qs(urlsplit(r.json()["data"]["invitationUrl"]).fragment)["token"][0]


async def accept(c, token, **data):
    return await c.post("/api/v1/auth/invitations/accept", json={"token": token, **data})


async def new_member(c, ws, email="member@example.com", role="VIEWER"):
    token = await invite(c, ws, email, role)
    r = await accept(c, token, password="Long password 123!", displayName=email)
    assert r.status_code == 200, r.text
    return r.json()["data"]["id"]


async def test_workspace_isolation_roles_archival_and_owner(site):
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    other_ws = await workspace(c, "beta")
    uid = await new_member(c, ws)
    async with client(c, "member@example.com") as member:
        items = (await member.get("/api/v1/workspaces")).json()["data"]["items"]
        assert [row["id"] for row in items] == [ws]
        assert (await member.get(f"/api/v1/workspaces/{other_ws}")).status_code == 403
        assert (await member.get(f"/api/v1/workspaces/{other_ws}/members")).status_code == 403
        assert (
            await member.patch(f"/api/v1/workspaces/{ws}", json={"name": "Denied"})
        ).status_code == 403
        assert (
            await member.post(
                f"/api/v1/workspaces/{ws}/invitations",
                json={"email": "x@example.com", "role": "ADMIN"},
            )
        ).status_code == 403
    own = (await c.get("/api/v1/account")).json()["data"]["id"]
    route = f"/api/v1/workspaces/{ws}/members/{own}"
    assert (await c.delete(route)).status_code == 409
    assert (await c.put(route, json={"role": "VIEWER", "status": "ACTIVE"})).status_code == 409
    # Ownership transfer is explicit; admins cannot grant themselves ownership.
    member_route = f"/api/v1/workspaces/{ws}/members/{uid}"
    assert (
        await c.put(member_route, json={"role": "ADMIN", "status": "ACTIVE"})
    ).status_code == 200
    async with client(c, "member@example.com") as member:
        assert (
            await member.put(member_route, json={"role": "OWNER", "status": "ACTIVE"})
        ).status_code == 403
        assert (await member.delete(route)).status_code == 403
    assert (await c.patch(f"/api/v1/workspaces/{ws}", json={"name": "Renamed"})).json()["data"][
        "name"
    ] == "Renamed"
    assert (await c.delete(f"/api/v1/workspaces/{ws}")).status_code == 200
    assert (await c.get(f"/api/v1/workspaces/{ws}")).json()["data"]["archived"] is True
    assert (
        await c.post(
            f"/api/v1/workspaces/{ws}/invitations",
            json={"email": "x@example.com", "role": "VIEWER"},
        )
    ).status_code == 409


async def test_existing_account_invitation_never_resets_identity(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    await c.post(
        "/api/v1/admin/users",
        json={
            "email": "inviter@example.com",
            "displayName": "Inviter",
            "password": "Long password 123!",
            "systemAdmin": False,
        },
    )
    async with client(c, "inviter@example.com") as inviter:
        private = await workspace(inviter, "private")
        token = await invite(inviter, private, "ADMIN@EXAMPLE.COM", "ADMIN")
        attack = await accept(
            inviter, token, password="Attacker password 123!", displayName="Attacker"
        )
        assert attack.status_code == 403
        assert (await accept(inviter, token)).status_code == 403
        async with httpx.AsyncClient(
            base_url=str(c.base_url), headers={"Origin": str(c.base_url).rstrip("/")}
        ) as anonymous:
            anonymous.headers["X-CSRF-Token"] = (await anonymous.get("/api/v1/setup")).json()[
                "data"
            ]["csrfToken"]
            assert (
                await accept(
                    anonymous, token, password="Attacker password 123!", displayName="Attacker"
                )
            ).status_code == 401
        assert (await accept(c, token)).status_code == 200
        assert (await accept(c, token)).status_code == 400
        assert (await login(c, password="Attacker password 123!")).status_code == 401
        assert (await login(c)).status_code == 200
    async with db.sessions() as s:
        admin = (
            await s.execute(select(User).where(User.email == "admin@example.com"))
        ).scalar_one()
        assert admin.display_name == "Administrator" and admin.system_admin
    # Platform administrator is not implicitly a member of another Workspace.
    await c.post(
        "/api/v1/admin/users",
        json={
            "email": "outsider@example.com",
            "displayName": "Outsider",
            "password": "Long password 123!",
            "systemAdmin": True,
        },
    )
    async with client(c, "outsider@example.com") as outsider:
        assert (await outsider.get(f"/api/v1/workspaces/{ws}")).status_code == 403


async def test_invite_expiry_replay_revocation_and_disabled_accounts(site):
    from datetime import timedelta
    from veriq_server.db import WorkspaceInvite
    from veriq_server.service import digest, now

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    uid = await new_member(c, ws)
    token = await invite(c, ws, "member@example.com")
    assert (await c.patch(f"/api/v1/admin/users/{uid}", json={"disabled": True})).status_code == 200
    assert (await accept(c, token)).status_code == 403
    token = await invite(c, ws, "expired@example.com")
    async with db.sessions.begin() as s:
        inv = (
            await s.execute(
                select(WorkspaceInvite).where(WorkspaceInvite.token_hash == digest(token))
            )
        ).scalar_one()
        inv.expires_at = now() - timedelta(seconds=1)
    assert (
        await accept(c, token, password="Long password 123!", displayName="Expired")
    ).status_code == 400
    page = (await c.get(f"/api/v1/workspaces/{ws}/invitations")).json()["data"]
    assert len(page["items"]) == 3
    assert all("invitationUrl" not in row and "token" not in row for row in page["items"])
    assert (
        await c.delete(f"/api/v1/workspaces/{ws}/invitations/{page['items'][-1]['id']}")
    ).status_code == 200
    assert (await accept(c, "invalid")).status_code == 400


async def test_concurrent_owner_removal_demotion_and_global_disable(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    uid = await new_member(c, ws)
    owner = (await c.get("/api/v1/account")).json()["data"]["id"]
    route = f"/api/v1/workspaces/{ws}/members"
    assert (
        await c.put(f"{route}/{uid}", json={"role": "OWNER", "status": "ACTIVE"})
    ).status_code == 200
    # Keep a nonmember system admin available to exercise cross-service disable.
    r = await c.post(
        "/api/v1/admin/users",
        json={
            "email": "operator@example.com",
            "displayName": "Operator",
            "password": "Long password 123!",
            "systemAdmin": True,
        },
    )
    assert r.status_code == 201
    async with client(c, "operator@example.com") as operator:
        results = await asyncio.gather(
            c.delete(f"{route}/{uid}"),
            c.put(f"{route}/{owner}", json={"role": "VIEWER", "status": "ACTIVE"}),
            operator.patch(f"/api/v1/admin/users/{owner}", json={"disabled": True}),
        )
        # Demotion and disable of the same user may both succeed; two owners
        # must never both lose their enabled ACTIVE ownership.
        assert 1 <= sum(r.status_code == 200 for r in results) <= 2
        assert any(r.status_code in {403, 409} for r in results)
        assert all(r.status_code in {200, 403, 409} for r in results)
    from veriq_server.db import WorkspaceMember

    async with db.sessions() as s:
        owners = (
            (
                await s.execute(
                    select(WorkspaceMember)
                    .join(User)
                    .where(
                        WorkspaceMember.workspace_id == ws,
                        WorkspaceMember.role == "OWNER",
                        WorkspaceMember.status == "ACTIVE",
                        User.disabled.is_(False),
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(owners) == 1


async def test_disabled_owner_not_counted_and_disable_rejected(site):
    c, _ = site
    await setup(c)
    await login(c)
    await workspace(c)
    own = (await c.get("/api/v1/account")).json()["data"]["id"]
    r = await c.post(
        "/api/v1/admin/users",
        json={
            "email": "operator@example.com",
            "displayName": "Operator",
            "password": "Long password 123!",
            "systemAdmin": True,
        },
    )
    assert r.status_code == 201
    async with client(c, "operator@example.com") as operator:
        r = await operator.patch(f"/api/v1/admin/users/{own}", json={"disabled": True})
        assert r.status_code == 409 and r.json()["code"] == "LAST_OWNER"


async def test_bounded_workspace_member_invite_lists_and_cursor_scope(site):
    c, _ = site
    await setup(c)
    await login(c)
    ids = [await workspace(c, f"ws-{i}") for i in range(4)]
    page = (await c.get("/api/v1/workspaces?limit=2")).json()["data"]
    assert [row["id"] for row in page["items"]] == ids[:2]
    tail = (
        await c.get("/api/v1/workspaces", params={"cursor": page["nextCursor"], "limit": 2})
    ).json()["data"]
    assert [row["id"] for row in tail["items"]] == ids[2:] and tail["nextCursor"] is None
    for i in range(3):
        await invite(c, ids[0], f"m{i}@example.com")
    page = (await c.get(f"/api/v1/workspaces/{ids[0]}/invitations?limit=1")).json()["data"]
    assert len(page["items"]) == 1 and page["nextCursor"]
    assert (
        await c.get(
            f"/api/v1/workspaces/{ids[1]}/invitations", params={"cursor": page["nextCursor"]}
        )
    ).status_code == 400
    assert (
        await c.get(f"/api/v1/workspaces/{ids[0]}/members", params={"cursor": page["nextCursor"]})
    ).status_code == 400
    for path in [
        "/api/v1/workspaces",
        f"/api/v1/workspaces/{ids[0]}/members",
        f"/api/v1/workspaces/{ids[0]}/invitations",
    ]:
        assert (await c.get(path, params={"limit": 101})).status_code == 400


async def test_scoped_policy_denies_foreign_references_and_private_dispatch():
    import pytest
    from veriq_server.auth.authorization import Actor, Authorization, Permission, WorkspaceScope
    from veriq_server.service import Problem

    scope = WorkspaceScope("alpha")
    actor = Actor("user", "alpha", "VIEWER")
    Authorization.require(actor, scope, Permission.VIEW)
    with pytest.raises(Problem) as denied:
        Authorization.require(actor, WorkspaceScope("beta"), Permission.VIEW)
    assert denied.value.status == 403
    with pytest.raises(Problem) as reference:
        Authorization.require_reference(scope, "beta")
    assert reference.value.code == "INVALID_REFERENCE"
    for role in ["OWNER", "ADMIN", "EDITOR", "EXECUTOR", "VIEWER"]:
        with pytest.raises(Problem):
            Authorization.require(Actor("user", "alpha", role), scope, Permission.PRIVATE_DISPATCH)


async def test_workspace_key_contract_accepts_full_length(site):
    c, _ = site
    await setup(c)
    await login(c)
    await workspace(c, "w" * 160)


async def test_workspace_key_conflict_retains_archived_keys(site):
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    assert (await c.delete(f"/api/v1/workspaces/{ws}")).status_code == 200
    r = await c.post("/api/v1/workspaces", json={"key": "alpha", "name": "Duplicate"})
    assert r.status_code == 409 and r.json()["code"] == "WORKSPACE_KEY_EXISTS"


async def test_two_enabled_owners_cannot_both_be_disabled(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    own = (await c.get("/api/v1/account")).json()["data"]["id"]
    uid = await new_member(c, ws)
    assert (
        await c.put(
            f"/api/v1/workspaces/{ws}/members/{uid}", json={"role": "OWNER", "status": "ACTIVE"}
        )
    ).status_code == 200
    r = await c.post(
        "/api/v1/admin/users",
        json={
            "email": "operator@example.com",
            "displayName": "Operator",
            "password": "Long password 123!",
            "systemAdmin": True,
        },
    )
    assert r.status_code == 201
    async with client(c, "operator@example.com") as operator:
        results = await asyncio.gather(
            *[
                operator.patch(f"/api/v1/admin/users/{id}", json={"disabled": True})
                for id in [own, uid]
            ]
        )
        assert sorted(r.status_code for r in results) == [200, 409]
        assert next(r for r in results if r.status_code == 409).json()["code"] == "LAST_OWNER"
    from veriq_server.db import WorkspaceMember

    async with db.sessions() as s:
        owners = (
            (
                await s.execute(
                    select(User)
                    .join(WorkspaceMember)
                    .where(
                        WorkspaceMember.workspace_id == ws,
                        WorkspaceMember.role == "OWNER",
                        WorkspaceMember.status == "ACTIVE",
                        User.disabled.is_(False),
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(owners) == 1


async def test_scoped_repository_and_bulk_policy_never_cross_space(site):
    import pytest
    from veriq_server.auth.authorization import WorkspaceScope
    from veriq_server.services.workspace import WorkspaceRepository
    from veriq_server.service import Problem

    c, db = site
    await setup(c)
    await login(c)
    a, b = await workspace(c), await workspace(c, "other")
    uid = await new_member(c, a)
    await invite(c, a, "future@example.com")
    invitation = (await c.get(f"/api/v1/workspaces/{a}/invitations")).json()["data"]["items"][0]
    async with db.sessions() as s:
        repo = WorkspaceRepository(s, WorkspaceScope(b))
        assert await repo.member(uid) is None
        with pytest.raises(Problem) as denied:
            await repo.invite(invitation["id"])
        assert denied.value.status == 404
    assert (
        await c.delete(f"/api/v1/workspaces/{b}/invitations/{invitation['id']}")
    ).status_code == 404
    assert (
        await c.put(
            f"/api/v1/workspaces/{b}/members/{uid}", json={"role": "ADMIN", "status": "ACTIVE"}
        )
    ).status_code == 404


async def test_workspace_methods_reject_unsupported_verbs(site):
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    for method, path in [
        ("PUT", "/api/v1/workspaces"),
        ("PUT", f"/api/v1/workspaces/{ws}"),
        ("PATCH", f"/api/v1/workspaces/{ws}/members"),
        ("POST", f"/api/v1/workspaces/{ws}/members/{ws}"),
        ("GET", f"/api/v1/workspaces/{ws}/invitations/{ws}"),
    ]:
        assert (await c.request(method, path, json={})).status_code == 405


async def test_members_and_invitations_traverse_real_bounded_pages(site):
    from uuid import uuid4
    from datetime import timedelta
    from veriq_server.db import WorkspaceMember, WorkspaceInvite
    from veriq_server.service import now, digest

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    async with db.sessions.begin() as s:
        admin = (await s.execute(select(User))).scalar_one()
        for i in range(105):
            uid = str(uuid4())
            email = f"m{i:03}@example.com"
            s.add(
                User(
                    id=uid,
                    email=email,
                    display_name=email,
                    password_hash=admin.password_hash,
                    disabled=i == 0,
                    system_admin=False,
                )
            )
            await s.flush()
            s.add(WorkspaceMember(workspace_id=ws, user_id=uid, role="VIEWER", status="ACTIVE"))
            s.add(
                WorkspaceInvite(
                    id=str(uuid4()),
                    workspace_id=ws,
                    email=email,
                    role="VIEWER",
                    token_hash=digest(str(uuid4())),
                    expires_at=now() + timedelta(days=1),
                    created_at=now(),
                    consumed=False,
                    revoked=False,
                )
            )
    for resource, total in [("members", 106), ("invitations", 105)]:
        route = f"/api/v1/workspaces/{ws}/{resource}"
        cap = (await c.get(route, params={"limit": 100})).json()["data"]
        assert len(cap["items"]) == 100 and cap["nextCursor"]
        cursor = None
        emails = []
        while True:
            params = {"limit": 9}
            if cursor:
                params["cursor"] = cursor
            page = (await c.get(route, params=params)).json()["data"]
            assert 0 < len(page["items"]) <= 9
            emails += [row["email"] for row in page["items"]]
            cursor = page["nextCursor"]
            if cursor is None:
                break
        assert len(emails) == len(set(emails)) == total and emails == sorted(emails)


async def test_invitation_concurrent_single_use_and_password_hashes(site):
    from veriq_server.db import WorkspaceInvite
    from veriq_server.service import digest

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    token = await invite(c, ws)
    results = await asyncio.gather(
        *[accept(c, token, password="Long password 123!", displayName="Member") for _ in range(2)]
    )
    assert sorted(r.status_code for r in results) == [200, 400]
    async with db.sessions() as s:
        inv = (await s.execute(select(WorkspaceInvite))).scalar_one()
        user = (
            await s.execute(select(User).where(User.email == "member@example.com"))
        ).scalar_one()
        assert inv.token_hash == digest(token) and token not in inv.token_hash
        assert (
            inv.consumed and user.password_hash.startswith("$argon2id$") and not user.system_admin
        )
    # The inviter retains their own global session and cannot replace the member identity.
    assert (await c.get("/api/v1/account")).json()["data"]["email"] == "admin@example.com"


async def test_disabled_members_and_revoked_invites_cannot_authorize(site):
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    uid = await new_member(c, ws)
    assert (
        await c.put(
            f"/api/v1/workspaces/{ws}/members/{uid}", json={"role": "VIEWER", "status": "DISABLED"}
        )
    ).status_code == 200
    async with client(c, "member@example.com") as member:
        assert (await member.get(f"/api/v1/workspaces/{ws}")).status_code == 403
        assert (await member.get("/api/v1/workspaces")).json()["data"]["items"] == []
    token = await invite(c, ws, "revoked@example.com")
    invitations = (await c.get(f"/api/v1/workspaces/{ws}/invitations")).json()["data"]["items"]
    inv = next(i for i in invitations if i["email"] == "revoked@example.com")
    assert (await c.delete(f"/api/v1/workspaces/{ws}/invitations/{inv['id']}")).status_code == 200
    assert (
        await accept(c, token, password="Long password 123!", displayName="Revoked")
    ).status_code == 400


async def test_inactive_owner_does_not_count_as_successor(site):
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    own = (await c.get("/api/v1/account")).json()["data"]["id"]
    uid = await new_member(c, ws)
    route = f"/api/v1/workspaces/{ws}/members"
    assert (
        await c.put(f"{route}/{uid}", json={"role": "OWNER", "status": "ACTIVE"})
    ).status_code == 200
    assert (
        await c.put(f"{route}/{uid}", json={"role": "OWNER", "status": "DISABLED"})
    ).status_code == 200
    r = await c.delete(f"{route}/{own}")
    assert r.status_code == 409 and r.json()["code"] == "LAST_OWNER"


async def test_globally_disabled_owner_does_not_count_as_successor(site):
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    own = (await c.get("/api/v1/account")).json()["data"]["id"]
    uid = await new_member(c, ws)
    route = f"/api/v1/workspaces/{ws}/members"
    assert (
        await c.put(f"{route}/{uid}", json={"role": "OWNER", "status": "ACTIVE"})
    ).status_code == 200
    assert (await c.patch(f"/api/v1/admin/users/{uid}", json={"disabled": True})).status_code == 200
    r = await c.delete(f"{route}/{own}")
    assert r.status_code == 409 and r.json()["code"] == "LAST_OWNER"


async def test_workspace_migration_upgrades_existing_account_data(site):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from veriq_server import migrate

    c, db = site
    await setup(c)
    await login(c)
    user = (await c.get("/api/v1/account")).json()["data"]
    config = Config()
    config.set_main_option("script_location", str(Path(migrate.__file__).parent / "migrations"))
    async with db.engine.connect() as connection:

        def downgrade(sync):
            config.attributes["connection"] = sync
            command.downgrade(config, "0001_accounts")

        await connection.run_sync(downgrade)
        await connection.commit()

        def upgrade(sync):
            config.attributes["connection"] = sync
            command.upgrade(config, "head")

        await connection.run_sync(upgrade)
        await connection.commit()
    assert (await c.get("/api/v1/account")).json()["data"] == user
    await workspace(c)


async def test_workspace_audit_preserves_scope_without_invitation_secrets(site):
    from veriq_server.db import AuditLog

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    await new_member(c, ws)
    async with db.sessions() as s:
        rows = (
            (await s.execute(select(AuditLog).where(AuditLog.action.like("workspace.%"))))
            .scalars()
            .all()
        )
        assert len(rows) == 3
        assert all(row.workspace_id == ws for row in rows)


async def test_real_smtp_invitation_delivery_and_copyable_failure(site, caplog):
    from email import policy
    from email.parser import BytesParser
    from tornado.httpserver import HTTPServer
    from veriq_server.app import make_app
    from veriq_server.settings import Settings

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    assert (
        await c.post(
            f"/api/v1/workspaces/{ws}/invitations",
            json={"email": "mail@example.com", "role": "VIEWER", "sendEmail": True},
        )
    ).status_code == 409
    messages = []
    failed = False

    async def smtp(reader, writer):
        if failed:
            writer.write(b"421 private-mail-error\r\n")
            await writer.drain()
            writer.close()
            await writer.wait_closed()
            return
        writer.write(b"220 local VeriQ test SMTP\r\n")
        await writer.drain()
        while line := await reader.readline():
            command = line.upper()
            if command.startswith((b"EHLO", b"HELO", b"MAIL FROM:", b"RCPT TO:")):
                writer.write(b"250 accepted\r\n")
            elif command.startswith(b"DATA"):
                writer.write(b"354 send message\r\n")
                await writer.drain()
                parts = []
                while (part := await reader.readline()) != b".\r\n":
                    assert part
                    parts.append(part)
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

    listener = await asyncio.start_server(smtp, "127.0.0.1", 0)
    settings = Settings(
        database_url=db.engine.url.render_as_string(hide_password=False),
        public_url="http://127.0.0.1:18893",
        master_key="a" * 64,
        signing_key="b" * 64,
        environment="development",
        smtp_host="127.0.0.1",
        smtp_port=listener.sockets[0].getsockname()[1],
        smtp_from="sender@example.com",
        smtp_security="none",
    )
    app = make_app(settings, db)
    server = HTTPServer(app)
    server.listen(18893, "127.0.0.1")
    try:
        async with httpx.AsyncClient(
            base_url=settings.public_url, headers={"Origin": settings.public_url}
        ) as mail:
            mail.headers["X-CSRF-Token"] = (await mail.get("/api/v1/setup")).json()["data"][
                "csrfToken"
            ]
            await login(mail)
            r = await mail.post(
                f"/api/v1/workspaces/{ws}/invitations",
                json={"email": "mail@example.com", "role": "VIEWER", "sendEmail": True},
            )
            assert r.status_code == 201 and r.json()["data"]["delivery"] == "SENT"
            body = r.json()["data"]
            message = BytesParser(policy=policy.default).parsebytes(messages[0])
            assert (
                message["To"] == "mail@example.com"
                and message["Subject"] == "VeriQ Workspace invitation"
            )
            assert body["invitationUrl"] in message.get_content()
            token = parse_qs(urlsplit(body["invitationUrl"]).fragment)["token"][0]
            assert (
                await accept(mail, token, password="Long password 123!", displayName="Mail Member")
            ).status_code == 200
            failed = True
            r = await mail.post(
                f"/api/v1/workspaces/{ws}/invitations",
                json={"email": "failed@example.com", "role": "VIEWER", "sendEmail": True},
            )
            assert r.status_code == 201 and r.json()["data"]["delivery"] == "FAILED"
            fallback = parse_qs(urlsplit(r.json()["data"]["invitationUrl"]).fragment)["token"][0]
            assert (
                await accept(mail, fallback, password="Long password 123!", displayName="Fallback")
            ).status_code == 200
            assert (
                "private-mail-error" not in caplog.text
                and token not in caplog.text
                and fallback not in caplog.text
            )
    finally:
        await app.settings["reset_dispatcher"].close()
        server.stop()
        await server.close_all_connections()
        listener.close()
        await listener.wait_closed()
