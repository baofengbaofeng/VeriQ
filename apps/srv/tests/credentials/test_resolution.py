from importlib import import_module
from datetime import timedelta
import pytest
from test_auth import setup, login
from test_workspace import workspace
from veriq_server.service import Problem, now


async def test_resolution_requires_current_verified_grant_and_exact_pin(site, monkeypatch):
    module = import_module("veriq_server.credentials.resolve")
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
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
    adapter = (
        await c.post(
            base + "/auth-adapters",
            json={
                "configuration": {
                    "kind": "HTTP_BEARER",
                    "identityPath": "/me",
                    "identityPointer": "/id",
                }
            },
        )
    ).json()["data"]
    role = {
        "authAdapterVersionId": adapter["versionId"],
        "secretRef": "business",
        "secretVersionId": secret["versionId"],
        "allowedIdentityIds": ["editor"],
    }
    proof = module.VerifiedAttempt(
        workspace_id=ws,
        attempt_id="attempt",
        device_id="device",
        active=True,
        trust_status="MANAGED",
        credential_grant=True,
        membership_active=True,
        lease_until=now() + timedelta(seconds=60),
        fence=7,
        current_fence=7,
        identities=[role],
    )
    # 在领域测试中直接构造设备证明及其租约与围栏状态，确认有效证明可以解密，而密钥版本不符时请求被拒。
    from dataclasses import replace

    ring = import_module("veriq_server.credentials.crypto").Keyring(
        "primary", {"primary": bytes.fromhex("a" * 64)}
    )
    async with db.sessions() as session:
        assert await module.resolve_verified(
            session, proof, "business", secret["versionId"], ring
        ) == {"token": "synthetic"}
        for bad in [
            replace(proof, trust_status="USER_REGISTERED"),
            replace(proof, credential_grant=False),
            replace(proof, membership_active=False),
            replace(proof, active=False),
            replace(proof, current_fence=8),
            replace(proof, lease_until=now() - timedelta(seconds=1)),
            replace(proof, workspace_id="wrong"),
        ]:
            with pytest.raises(Problem):
                await module.resolve_verified(session, bad, "business", secret["versionId"], ring)
        with pytest.raises(Problem):
            await module.resolve_verified(session, proof, "business", "other-version", ring)
    # 在此用例替换证明校验器并注入预设证明，随后通过真实 HTTP 路由核对响应字段及禁止缓存的响应头。
    attempt_id = "11111111-1111-4111-8111-111111111111"

    async def verified(self, session, requested_attempt, transport):
        return replace(proof, attempt_id=attempt_id)

    from veriq_server.services.lease import DatabaseAttemptProofVerifier

    monkeypatch.setattr(DatabaseAttemptProofVerifier, "verify", verified)
    response = await c.post(
        f"/internal/v1/attempts/{attempt_id}/credentials/resolve",
        json={"secretRef": "business", "versionId": secret["versionId"]},
        headers={
            "Authorization": "Bearer synthetic-device",
            "X-VeriQ-Lease-Token": "synthetic-lease",
            "X-VeriQ-Fencing-Token": "7",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"] == {
        "secretRef": "business",
        "versionId": secret["versionId"],
        "value": {"token": "synthetic"},
    }
    assert response.headers["cache-control"] == "no-store"
    await c.post(base + f"/credentials/business/versions/{secret['versionId']}/revoke", json={})
    async with db.sessions() as session:
        with pytest.raises(Problem, match="revoked"):
            await module.resolve_verified(session, proof, "business", secret["versionId"], ring)


async def test_internal_http_requires_and_forwards_typed_lease_proof(site):
    import httpx
    from tornado.httpserver import HTTPServer
    from tornado.netutil import bind_sockets
    from veriq_server.app import make_app
    from veriq_server.settings import Settings

    c, db = site
    config = Settings(
        database_url=db.engine.url.render_as_string(hide_password=False),
        public_url="http://127.0.0.1",
        master_key="a" * 64,
        signing_key="b" * 64,
        environment="development",
    )
    app = make_app(config, db)
    seen = []

    class Verifier:
        async def verify(self, session, attempt_id, proof):
            seen.append(proof)
            raise Problem(403, "PROOF_CAPTURED", "No production verifier in this test")

    app.settings["attempt_proof_verifier"] = Verifier()
    sockets = bind_sockets(0, "127.0.0.1")
    server = HTTPServer(app)
    server.add_sockets(sockets)
    try:
        async with httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{sockets[0].getsockname()[1]}"
        ) as client:
            path = "/internal/v1/attempts/11111111-1111-4111-8111-111111111111/credentials/resolve"
            missing = await client.post(path, json={})
            assert missing.status_code == 403 and seen == []
            headers = {
                "Authorization": "Bearer synthetic-device-token",
                "X-VeriQ-Lease-Token": "synthetic-lease-token",
                "X-VeriQ-Fencing-Token": "7",
            }
            malformed = await client.post(
                path, json={}, headers={**headers, "X-VeriQ-Fencing-Token": "-1"}
            )
            assert malformed.status_code == 400 and seen == []
            response = await client.post(path, json={}, headers=headers)
            assert response.status_code == 403
            assert response.headers["cache-control"] == "no-store"
            assert len(seen) == 1
            assert seen[0].authorization == "Bearer synthetic-device-token"
            assert seen[0].lease_token == "synthetic-lease-token"
            assert seen[0].fencing_token == 7
            assert "synthetic" not in repr(seen[0])
    finally:
        server.stop()
        await server.close_all_connections()


async def test_adapter_and_secret_authorization_lock_serializes_revocation(site):
    from sqlalchemy import select
    from sqlalchemy.exc import OperationalError
    from veriq_server.auth.authorization import WorkspaceScope
    from veriq_server.credentials.crypto import Keyring
    from veriq_server.credentials.registry import IdentityRegistry
    from veriq_server.credentials.resolve import VerifiedAttempt, resolve_verified
    from veriq_server.db import AuthAdapterVersion, SecretVersion

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
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
    adapter = (
        await c.post(
            base + "/auth-adapters",
            json={
                "configuration": {
                    "kind": "HTTP_BEARER",
                    "identityPath": "/me",
                    "identityPointer": "/id",
                }
            },
        )
    ).json()["data"]
    role = {
        "authAdapterVersionId": adapter["versionId"],
        "secretRef": "business",
        "secretVersionId": secret["versionId"],
        "allowedIdentityIds": ["editor"],
    }
    proof = VerifiedAttempt(
        workspace_id=ws,
        attempt_id="attempt",
        device_id="device",
        active=True,
        trust_status="MANAGED",
        credential_grant=True,
        membership_active=True,
        lease_until=now() + timedelta(seconds=60),
        fence=1,
        current_fence=1,
        identities=[role],
    )
    ring = Keyring("primary", {"primary": bytes.fromhex("a" * 64)})
    async with db.sessions.begin() as issuing:
        await IdentityRegistry().require_role(issuing, WorkspaceScope(ws), role)
        # 签发事务持锁时由另一事务尝试锁定适配器版本和密钥版本，两次尝试均须被拒，签发事务随后继续解密。
        for model, version in [
            (AuthAdapterVersion, adapter["versionId"]),
            (SecretVersion, secret["versionId"]),
        ]:
            async with db.sessions() as revoking:
                with pytest.raises(OperationalError) as blocked:
                    await revoking.execute(
                        select(model).where(model.id == version).with_for_update(nowait=True)
                    )
                # 另一事务用 NOWAIT 获取已持有的凭据版本行锁时须报告锁冲突，证明并发撤权无法绕过签发事务的锁定。
                assert blocked.value.orig.args[0] == 3572
                await revoking.rollback()
        assert await resolve_verified(issuing, proof, "business", secret["versionId"], ring) == {
            "token": "synthetic"
        }
    assert (
        await c.post(base + f"/auth-adapters/{adapter['versionId']}/revoke", json={})
    ).status_code == 200
    async with db.sessions() as later:
        with pytest.raises(Problem, match="unavailable"):
            await resolve_verified(later, proof, "business", secret["versionId"], ring)
