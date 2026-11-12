
import asyncio
import secrets
from uuid import uuid4
from sqlalchemy import text
from test_grants import ready, enroll


async def test_exact_rotation_recovery_does_not_restore_old_device_authority(site):
    c, db, ws = await ready(site)
    credential = await enroll(c, ws)
    old = credential["deviceToken"]
    headers = {"Authorization": "Bearer " + old}
    path = "/internal/v1/runtime/token/rotate"
    body = {"clientRequestId": str(uuid4()), "replacementToken": secrets.token_urlsafe(32)}
    replies = await asyncio.gather(*[c.post(path, json=body, headers=headers) for _ in range(2)])
    assert [r.status_code for r in replies] == [200, 200]
    assert replies[0].json()["data"] == replies[1].json()["data"]
    assert replies[0].json()["data"]["deviceToken"] == body["replacementToken"]
    assert (await c.get("/internal/v1/runtime", headers=headers)).status_code == 401
    for bad in [
        dict(body, clientRequestId=str(uuid4())),
        dict(body, replacementToken=secrets.token_urlsafe(32)),
    ]:
        assert (await c.post(path, json=bad, headers=headers)).status_code == 401
    successor = {"Authorization": "Bearer " + body["replacementToken"]}
    assert (await c.get("/internal/v1/runtime", headers=successor)).status_code == 200
    async with db.sessions() as session:
        rows = (
            await session.execute(
                text(
                    "SELECT token_hash, rotation_request_id, successor_hash FROM veriq_runtime_tokens"
                )
            )
        ).all()
        assert all(old not in str(row) and body["replacementToken"] not in str(row) for row in rows)
    assert (await c.post(path, json={}, headers=successor)).status_code == 200
    assert (await c.post(path, json=body, headers=headers)).status_code == 401


async def test_rotation_recovery_rejects_expired_successor_revoked_owner_and_same_token(site):
    c, db, ws = await ready(site)
    credential = await enroll(c, ws)
    headers = {"Authorization": "Bearer " + credential["deviceToken"]}
    path = "/internal/v1/runtime/token/rotate"
    body = {"clientRequestId": str(uuid4()), "replacementToken": credential["deviceToken"]}
    assert (await c.post(path, json=body, headers=headers)).status_code == 400
    body["replacementToken"] = secrets.token_urlsafe(32)
    assert (await c.post(path, json=body, headers=headers)).status_code == 200
    async with db.sessions.begin() as session:
        await session.execute(
            text(
                "UPDATE veriq_runtime_tokens SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 SECOND WHERE revoked=0"
            )
        )
    assert (await c.post(path, json=body, headers=headers)).status_code == 401
    credential = await enroll(c, ws)
    headers = {"Authorization": "Bearer " + credential["deviceToken"]}
    body = {"clientRequestId": str(uuid4()), "replacementToken": secrets.token_urlsafe(32)}
    assert (await c.post(path, json=body, headers=headers)).status_code == 200
    assert (
        await c.post(f"/api/v1/workspaces/{ws}/runtimes/{credential['runnerId']}/revoke", json={})
    ).status_code == 200
    assert (await c.post(path, json=body, headers=headers)).status_code == 401


async def test_exact_recovery_rechecks_current_owner_after_successor_was_issued(site):
    c, db, ws = await ready(site)
    credential = await enroll(c, ws)
    headers = {"Authorization": "Bearer " + credential["deviceToken"]}
    body = {"clientRequestId": str(uuid4()), "replacementToken": secrets.token_urlsafe(32)}
    path = "/internal/v1/runtime/token/rotate"
    assert (await c.post(path, json=body, headers=headers)).status_code == 200
    async with db.sessions.begin() as session:
        await session.execute(
            text(
                "UPDATE veriq_users SET disabled=1 WHERE id=(SELECT owner_user_id FROM veriq_runtimes WHERE id=:id)"
            ),
            {"id": credential["runnerId"]},
        )
    assert (await c.post(path, json=body, headers=headers)).status_code == 401
    assert (
        await c.get(
            "/internal/v1/runtime", headers={"Authorization": "Bearer " + body["replacementToken"]}
        )
    ).status_code == 401
