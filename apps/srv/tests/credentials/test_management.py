from sqlalchemy import text
from test_auth import setup, login
from test_workspace import workspace, new_member, client


async def test_version_management_encrypts_never_echoes_and_revokes(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    base = f"/api/v1/workspaces/{ws}/credentials"
    value = {"token": "synthetic-super-secret-token"}
    first = await c.post(
        base, json={"secretRef": "business", "value": value, "allowedIdentityIds": ["editor"]}
    )
    assert first.status_code == 201, first.text
    version = first.json()["data"]["versionId"]
    assert value["token"] not in first.text
    listed = await c.get(base)
    assert listed.status_code == 200
    assert value["token"] not in listed.text
    async with db.sessions() as session:
        row = (
            await session.execute(
                text("SELECT ciphertext, nonce, key_id FROM veriq_secret_versions WHERE id=:id"),
                {"id": version},
            )
        ).one()
        assert value["token"].encode() not in row.ciphertext
        assert len(row.nonce) == 12
        assert row.key_id == "primary"
    rotated = await c.post(
        base + "/business/versions",
        json={"value": {"token": "synthetic-rotated"}, "allowedIdentityIds": ["editor"]},
    )
    assert rotated.status_code == 201, rotated.text
    assert rotated.json()["data"]["versionId"] != version
    revoked = await c.post(base + f"/business/versions/{version}/revoke", json={})
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["data"]["revoked"] is True
    again = await c.post(base + f"/business/versions/{version}/revoke", json={})
    assert again.status_code == 200


async def test_credentials_require_current_environment_manager_and_workspace(site):
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    other = await workspace(c, "other")
    await new_member(c, ws, role="EDITOR")
    async with client(c, "member@example.com") as editor:
        for target in [ws, other]:
            base = f"/api/v1/workspaces/{target}/credentials"
            assert (await editor.get(base)).status_code == 403
            assert (
                await editor.post(
                    base,
                    json={
                        "secretRef": "forbidden",
                        "value": {"token": "synthetic"},
                        "allowedIdentityIds": ["editor"],
                    },
                )
            ).status_code == 403
    # Never accept trust/lease labels supplied by a caller as a device proof.
    response = await c.post(
        "/internal/v1/attempts/11111111-1111-4111-8111-111111111111/credentials/resolve",
        json={"trustStatus": "MANAGED", "workspaceId": ws},
    )
    assert response.status_code == 403, response.text
    assert response.json()["code"] == "ATTEMPT_PROOF_REQUIRED"


async def test_adapter_registry_rejects_code_and_cross_workspace_references(site):
    from veriq_server.credentials.registry import IdentityRegistry
    from veriq_server.auth.authorization import WorkspaceScope
    from veriq_server.service import Problem
    import pytest

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    other = await workspace(c, "other")
    base = f"/api/v1/workspaces/{ws}"
    secret = (
        await c.post(
            base + "/credentials",
            json={
                "secretRef": "business",
                "value": {"token": "synthetic"},
                "allowedIdentityIds": ["editor"],
            },
        )
    ).json()["data"]
    response = await c.post(
        base + "/auth-adapters",
        json={
            "configuration": {
                "kind": "HTTP_BEARER",
                "identityPath": "/me",
                "identityPointer": "/id",
            }
        },
    )
    assert response.status_code == 201, response.text
    adapter = response.json()["data"]
    assert len(adapter["contentHash"]) == 64
    assert (
        await c.post(
            base + "/auth-adapters", json={"configuration": {"kind": "SCRIPT", "source": "evil()"}}
        )
    ).status_code == 400
    role = {
        "roleKey": "editor",
        "authAdapterVersionId": adapter["versionId"],
        "secretRef": "business",
        "secretVersionId": secret["versionId"],
        "allowedIdentityIds": ["editor"],
    }
    async with db.sessions() as session:
        await IdentityRegistry().require_role(session, WorkspaceScope(ws), role)
        with pytest.raises(Problem):
            await IdentityRegistry().require_role(session, WorkspaceScope(other), role)
        with pytest.raises(Problem):
            await IdentityRegistry().require_role(
                session, WorkspaceScope(ws), {**role, "allowedIdentityIds": ["admin"]}
            )
    assert (
        await c.post(base + f"/credentials/business/versions/{secret['versionId']}/revoke", json={})
    ).status_code == 200
    async with db.sessions() as session:
        with pytest.raises(Problem, match="revoked"):
            await IdentityRegistry().require_role(session, WorkspaceScope(ws), role)


async def test_management_actions_reject_unsupported_methods_before_dispatch(site):
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    for suffix in [
        "/credentials/business/versions",
        "/credentials/business/versions/11111111-1111-4111-8111-111111111111/revoke",
        "/auth-adapters/11111111-1111-4111-8111-111111111111/revoke",
    ]:
        response = await c.get(f"/api/v1/workspaces/{ws}" + suffix)
        assert response.status_code == 405
