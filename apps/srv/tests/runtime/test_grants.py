
import asyncio

import pytest
from sqlalchemy import text
from test_auth import setup, login
from test_workspace import workspace, new_member, client

CAPABILITIES = {"engineVersion": "0.1.0", "os": "linux", "arch": "x64", "browsers": ["chromium"]}


async def begin(c, **extra):
    r = await c.post(
        "/api/v1/runtime-enrollments",
        json={
            "name": "Private laptop",
            "location": "CONNECTED_LOCAL",
            "capabilities": CAPABILITIES,
            **extra,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["data"]


async def enroll(c, ws, *, private=True, users=None):
    device = await begin(c)
    approved = await c.post(
        f"/api/v1/runtime-enrollments/{device['id']}/approve",
        json={
            "userCode": device["userCode"],
            "workspaceId": ws,
            "private": private,
            "sharedWithUserIds": users or [],
        },
    )
    assert approved.status_code == 200, approved.text
    r = await c.post("/api/v1/runtime-enrollments/poll", json={"deviceCode": device["deviceCode"]})
    assert r.status_code == 200, r.text
    return r.json()["data"]


async def ready(site):
    c, db = site
    await setup(c)
    await login(c)
    return c, db, await workspace(c)


async def test_private_owner_consent_current_grants_and_real_token_revocation(site):
    c, db, ws = await ready(site)
    await new_member(c, ws, role="ADMIN")
    async with client(c, "member@example.com") as owner:
        credential = await enroll(owner, ws)
        rid = credential["runnerId"]
        base = f"/api/v1/workspaces/{ws}/runtimes/{rid}"
        assert (await c.get(base)).status_code == 403  # Even system/Workspace owner.
        assert (
            await c.put(
                base + "/grants",
                json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
            )
        ).status_code == 403
        assert (
            await c.put(
                base + "/trust", json={"trustStatus": "MANAGED", "allowCredentialDelivery": True}
            )
        ).status_code == 403
        row = (await owner.get(base)).json()["data"]
        assert row["status"] == "OFFLINE" and row["trustStatus"] == "USER_REGISTERED"
        assert "lastSeenAt" not in row
        from veriq_server.services.runtime import RuntimeService
        from veriq_server.db import User
        from veriq_server.service import Problem, lock_installation

        async with db.sessions.begin() as session:
            await lock_installation(session)
            actor = await session.get(User, (await c.get("/api/v1/account")).json()["data"]["id"])
            with pytest.raises(Problem) as denied:
                await RuntimeService(session).require_dispatch(actor, ws, rid)
            assert denied.value.status == 403
        shared = await owner.put(
            base + "/grants", json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True}
        )
        assert shared.status_code == 200, shared.text
        assert (
            await owner.put(
                base + "/trust", json={"trustStatus": "MANAGED", "allowCredentialDelivery": True}
            )
        ).status_code == 403
        assert (
            await c.put(
                base + "/trust", json={"trustStatus": "MANAGED", "allowCredentialDelivery": True}
            )
        ).status_code == 200
        async with db.sessions.begin() as session:
            await lock_installation(session)
            actor = await session.get(User, actor.id)
            assert (await RuntimeService(session).require_dispatch(actor, ws, rid)).id == rid
        headers = {"Authorization": "Bearer " + credential["deviceToken"]}
        assert (await c.get("/internal/v1/runtime", headers=headers)).status_code == 200
        revoked = await owner.post(base + "/revoke", json={})
        assert revoked.status_code == 200
        assert (await c.get("/internal/v1/runtime", headers=headers)).status_code == 401


async def test_enrollment_secrets_separated_single_use_and_rotation(site):
    c, db, ws = await ready(site)
    d = await begin(c)
    assert d["userCode"] != d["deviceCode"] and len(d["deviceCode"]) >= 43
    assert d["deviceCode"] not in d["verificationUrl"]
    poll = "/api/v1/runtime-enrollments/poll"
    assert (await c.post(poll, json={"deviceCode": d["userCode"]})).status_code == 401
    pending = await c.post(poll, json={"deviceCode": d["deviceCode"]})
    assert pending.status_code == 409 and pending.json()["code"] == "ENROLLMENT_PENDING"
    approval = {
        "userCode": d["userCode"],
        "workspaceId": ws,
        "private": True,
        "sharedWithUserIds": [],
    }
    path = f"/api/v1/runtime-enrollments/{d['id']}/approve"
    results = await asyncio.gather(c.post(path, json=approval), c.post(path, json=approval))
    assert sorted(r.status_code for r in results) == [200, 409]
    results = await asyncio.gather(
        *[c.post(poll, json={"deviceCode": d["deviceCode"]}) for _ in range(2)]
    )
    assert sorted(r.status_code for r in results) == [200, 401]
    token = next(r.json()["data"] for r in results if r.status_code == 200)["deviceToken"]
    headers = {"Authorization": "Bearer " + token}
    rotated = await c.post("/internal/v1/runtime/token/rotate", json={}, headers=headers)
    assert rotated.status_code == 200, rotated.text
    assert (await c.get("/internal/v1/runtime", headers=headers)).status_code == 401
    new = rotated.json()["data"]["deviceToken"]
    assert (
        await c.get("/internal/v1/runtime", headers={"Authorization": "Bearer " + new})
    ).status_code == 200
    async with db.sessions() as session:
        rows = (
            (await session.execute(text("SELECT token_hash FROM veriq_runtime_tokens")))
            .scalars()
            .all()
        )
        assert token not in rows and new not in rows and all(len(v) == 64 for v in rows)


async def test_expiry_membership_removal_and_client_trust_rejected(site):
    c, db, ws = await ready(site)
    assert (
        await c.post(
            "/api/v1/runtime-enrollments",
            json={
                "name": "Bad",
                "location": "CONNECTED_LOCAL",
                "capabilities": CAPABILITIES,
                "trustStatus": "MANAGED",
            },
        )
    ).status_code == 400
    uid = await new_member(c, ws, role="EXECUTOR")
    async with client(c, "member@example.com") as member:
        d = await begin(member)
        async with db.sessions.begin() as s:
            await s.execute(
                text(
                    "UPDATE veriq_runtime_enrollments SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 SECOND"
                )
            )
        assert (
            await member.post(
                f"/api/v1/runtime-enrollments/{d['id']}/approve",
                json={
                    "userCode": d["userCode"],
                    "workspaceId": ws,
                    "private": True,
                    "sharedWithUserIds": [],
                },
            )
        ).status_code == 401
        credentials = await enroll(member, ws)
        headers = {"Authorization": "Bearer " + credentials["deviceToken"]}
        assert (await member.get("/internal/v1/runtime", headers=headers)).status_code == 200
        assert (await c.delete(f"/api/v1/workspaces/{ws}/members/{uid}")).status_code == 200
        assert (await member.get("/internal/v1/runtime", headers=headers)).status_code == 401


async def test_cross_workspace_grants_and_private_rollback_of_trust(site):
    c, db, ws = await ready(site)
    other = await workspace(c, "other")
    outsider = await new_member(c, other, role="EXECUTOR")
    credential = await enroll(c, ws, private=False)
    rid = credential["runnerId"]
    base = f"/api/v1/workspaces/{ws}/runtimes/{rid}"
    assert (
        await c.put(
            base + "/grants",
            json={"workspaceId": other, "userIds": [], "sharedWithWorkspace": True},
        )
    ).status_code == 422
    assert (
        await c.put(
            base + "/grants",
            json={"workspaceId": ws, "userIds": [outsider], "sharedWithWorkspace": False},
        )
    ).status_code == 422
    assert (
        await c.put(
            base + "/trust", json={"trustStatus": "MANAGED", "allowCredentialDelivery": True}
        )
    ).status_code == 200
    private = await c.put(
        base + "/grants", json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": False}
    )
    assert private.status_code == 200
    assert private.json()["data"]["trustStatus"] == "USER_REGISTERED"
    assert private.json()["data"]["allowCredentialDelivery"] is False
    listed = await c.get(f"/api/v1/workspaces/{ws}/runtimes?limit=1")
    assert listed.status_code == 200 and len(listed.json()["data"]["items"]) == 1
    assert (await c.get(f"/api/v1/workspaces/{ws}/runtimes?limit=101")).status_code == 400


async def test_service_account_bootstrap_current_scope_and_disable(site):
    c, db, ws = await ready(site)
    base = f"/api/v1/workspaces/{ws}/service-accounts"
    created = await c.post(base, json={"name": "Deployment"})
    assert created.status_code == 201, created.text
    sid = created.json()["data"]["id"]
    issued = await c.post(base + f"/{sid}/tokens", json={"purpose": "RUNTIME_ENROLLMENT"})
    assert issued.status_code == 201, issued.text
    secret = issued.json()["data"]["token"]
    payload = {"name": "Cloud worker", "capabilities": CAPABILITIES, "sharedWithWorkspace": True}
    headers = {"Authorization": "Bearer " + secret}
    results = await asyncio.gather(
        *[
            c.post("/internal/v1/runtime-enrollments/service", json=payload, headers=headers)
            for _ in range(2)
        ]
    )
    assert sorted(r.status_code for r in results) == [201, 401]
    credential = next(r.json()["data"] for r in results if r.status_code == 201)
    device = {"Authorization": "Bearer " + credential["deviceToken"]}
    info = await c.get("/internal/v1/runtime", headers=device)
    assert info.status_code == 200
    assert info.json()["data"]["ownerType"] == "SERVICE_ACCOUNT"
    assert info.json()["data"]["ownerId"] == sid
    assert info.json()["data"]["trustStatus"] == "USER_REGISTERED"
    other = await workspace(c, "other")
    assert (
        await c.get(f"/api/v1/workspaces/{other}/runtimes/{credential['runnerId']}")
    ).status_code == 404
    assert (
        await c.post(base + f"/{sid}/tokens", json={"purpose": "MAINTENANCE"})
    ).status_code == 400
    disabled = await c.post(base + f"/{sid}/disable", json={})
    assert disabled.status_code == 200
    assert (await c.get("/internal/v1/runtime", headers=device)).status_code == 401
    assert (
        await c.post(base + f"/{sid}/tokens", json={"purpose": "RUNTIME_ENROLLMENT"})
    ).status_code == 403
    await new_member(c, ws)
    async with client(c, "member@example.com") as member:
        assert (await member.get(base)).status_code == 403
        assert (await member.post(base, json={"name": "Forbidden"})).status_code == 403


async def test_pending_poll_rate_limit_and_token_expiry(site):
    c, db, ws = await ready(site)
    d = await begin(c)
    path = "/api/v1/runtime-enrollments/poll"
    assert (await c.post(path, json={"deviceCode": d["deviceCode"]})).status_code == 409
    assert (await c.post(path, json={"deviceCode": d["deviceCode"]})).status_code == 429
    credential = await enroll(c, ws)
    async with db.sessions.begin() as session:
        await session.execute(
            text("UPDATE veriq_runtime_tokens SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 SECOND")
        )
    assert (
        await c.get(
            "/internal/v1/runtime", headers={"Authorization": "Bearer " + credential["deviceToken"]}
        )
    ).status_code == 401


async def test_service_bootstrap_expiry_revoke_and_cannot_cross_scope(site):
    c, db, ws = await ready(site)
    base = f"/api/v1/workspaces/{ws}/service-accounts"
    account = (await c.post(base, json={"name": "Build deployment"})).json()["data"]
    token = (
        await c.post(base + f"/{account['id']}/tokens", json={"purpose": "RUNTIME_ENROLLMENT"})
    ).json()["data"]
    payload = {"name": "Expired", "capabilities": CAPABILITIES, "sharedWithWorkspace": False}
    async with db.sessions.begin() as session:
        await session.execute(
            text("UPDATE veriq_service_tokens SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 SECOND")
        )
    assert (
        await c.post(
            "/internal/v1/runtime-enrollments/service",
            json=payload,
            headers={"Authorization": "Bearer " + token["token"]},
        )
    ).status_code == 401
    token = (
        await c.post(base + f"/{account['id']}/tokens", json={"purpose": "RUNTIME_ENROLLMENT"})
    ).json()["data"]
    assert (
        await c.post(base + f"/{account['id']}/tokens/{token['id']}/revoke", json={})
    ).status_code == 200
    assert (
        await c.post(
            "/internal/v1/runtime-enrollments/service",
            json=payload,
            headers={"Authorization": "Bearer " + token["token"]},
        )
    ).status_code == 401
    other = await workspace(c, "unrelated")
    assert (
        await c.post(
            f"/api/v1/workspaces/{other}/service-accounts/{account['id']}/tokens",
            json={"purpose": "RUNTIME_ENROLLMENT"},
        )
    ).status_code == 404
    async with db.sessions() as session:
        rows = (
            (await session.execute(text("SELECT token_hash FROM veriq_service_tokens")))
            .scalars()
            .all()
        )
        assert token["token"] not in rows


async def test_inspection_csrf_token_scope_and_unsupported_methods(site):
    c, db, ws = await ready(site)
    d = await begin(c)
    r = await c.post("/api/v1/runtime-enrollments/inspect", json={"userCode": d["userCode"]})
    assert r.status_code == 200 and r.json()["data"]["name"] == "Private laptop"
    assert d["deviceCode"] not in r.text
    credential = await enroll(c, ws)
    headers = {"Authorization": "Bearer " + credential["deviceToken"]}
    # Device tokens cannot authenticate Web membership/admin APIs.
    import httpx

    async with httpx.AsyncClient(base_url=c.base_url, headers=headers) as native:
        assert (await native.get(f"/api/v1/workspaces/{ws}/runtimes")).status_code == 401
        assert (
            await native.post(
                "/api/v1/runtime-enrollments/inspect", json={"userCode": d["userCode"]}
            )
        ).status_code == 403
        assert (await native.get("/internal/v1/runtime")).status_code == 200
        assert (await native.post("/internal/v1/runtime", json={})).status_code == 405
        assert (await native.get("/internal/v1/runtime/token/rotate")).status_code == 405
        assert (await native.post("/internal/v1/runtime/logout", json={})).status_code == 200
        assert (await native.get("/internal/v1/runtime")).status_code == 401
    # Originless native registration works; browser cross-origin requests fail closed.
    assert (
        await c.post(
            "/api/v1/runtime-enrollments",
            json={"name": "x", "location": "CONNECTED_LOCAL", "capabilities": CAPABILITIES},
            headers={"Origin": "https://other.example"},
        )
    ).status_code == 403


async def test_runtime_routes_reject_wrong_methods_before_argument_dispatch(site):
    c, _, ws = await ready(site)
    rid = "11111111-1111-4111-8111-111111111111"
    for method, path in [
        ("put", f"/api/v1/workspaces/{ws}/runtimes"),
        ("post", f"/api/v1/workspaces/{ws}/runtimes"),
        ("get", f"/api/v1/workspaces/{ws}/service-accounts/{rid}/tokens"),
        ("get", f"/api/v1/workspaces/{ws}/service-accounts/{rid}/disable"),
    ]:
        response = await c.request(method, path, json={})
        assert response.status_code == 405, response.text


async def test_hardware_trust_and_workspace_secret_delivery_need_distinct_authorities(site):
    c, _, ws = await ready(site)
    global_id = await new_member(c, ws, email="security@example.com", role="VIEWER")
    await new_member(c, ws, email="project-admin@example.com", role="ADMIN")
    assert (
        await c.patch(f"/api/v1/admin/users/{global_id}", json={"systemAdmin": True})
    ).status_code == 200
    credential = await enroll(c, ws, private=False)
    base = f"/api/v1/workspaces/{ws}/runtimes/{credential['runnerId']}"
    async with (
        client(c, "security@example.com") as security,
        client(c, "project-admin@example.com") as manager,
    ):
        for role in ["VIEWER", "EDITOR"]:
            assert (
                await c.put(
                    f"/api/v1/workspaces/{ws}/members/{global_id}",
                    json={"role": role, "status": "ACTIVE"},
                )
            ).status_code == 200
            denied = await security.put(
                base + "/trust", json={"trustStatus": "MANAGED", "allowCredentialDelivery": True}
            )
            assert denied.status_code == 403, denied.text
            assert (
                await security.put(
                    base + "/credential-delivery", json={"allowCredentialDelivery": True}
                )
            ).status_code == 403
        assert (
            await manager.put(
                base + "/trust", json={"trustStatus": "MANAGED", "allowCredentialDelivery": False}
            )
        ).status_code == 403
        assert (
            await manager.put(base + "/credential-delivery", json={"allowCredentialDelivery": True})
        ).status_code == 403
        assert (
            await security.put(
                base + "/trust", json={"trustStatus": "MANAGED", "allowCredentialDelivery": False}
            )
        ).status_code == 200
        approved = await manager.put(
            base + "/credential-delivery", json={"allowCredentialDelivery": True}
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["data"]["allowCredentialDelivery"] is True
        # Security can clear the grant when demoting trust, without secret authority.
        assert (
            await security.put(
                base + "/trust",
                json={"trustStatus": "USER_REGISTERED", "allowCredentialDelivery": False},
            )
        ).status_code == 200
        assert (await manager.get(base)).json()["data"]["allowCredentialDelivery"] is False
        assert (
            await c.put(
                base + "/grants",
                json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": False},
            )
        ).status_code == 200
        assert (
            await c.put(base + "/credential-delivery", json={"allowCredentialDelivery": True})
        ).status_code == 403
        assert (
            await manager.put(base + "/credential-delivery", json={"allowCredentialDelivery": True})
        ).status_code == 403
