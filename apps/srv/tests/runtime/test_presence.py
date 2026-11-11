from sqlalchemy import text
from test_grants import ready, enroll, CAPABILITIES
from uuid import uuid4


async def test_presence_is_recent_authenticated_claim_not_registration_or_get(site):
    c, db, ws = await ready(site)
    d = await enroll(c, ws)
    headers = {"Authorization": "Bearer " + d["deviceToken"]}
    info = (await c.get("/internal/v1/runtime", headers=headers)).json()["data"]
    assert info["status"] == "OFFLINE" and "lastSeenAt" not in info
    response = await c.post(
        "/internal/v1/jobs/claim",
        headers=headers,
        json={
            "runnerId": d["runnerId"],
            "clientRequestId": str(uuid4()),
            "capabilities": CAPABILITIES,
            "availableSlots": 1,
        },
    )
    assert response.status_code == 204
    info = (await c.get("/internal/v1/runtime", headers=headers)).json()["data"]
    assert info["status"] == "ONLINE"
    assert info["lastSeenAt"]
    async with db.sessions.begin() as session:
        await session.execute(
            text("UPDATE veriq_runtimes SET last_seen_at=UTC_TIMESTAMP()-INTERVAL 61 SECOND")
        )
    assert (await c.get("/internal/v1/runtime", headers=headers)).json()["data"][
        "status"
    ] == "OFFLINE"
    assert (
        await c.post(
            f"/internal/v1/attempts/{uuid4()}/heartbeat",
            headers=headers,
            json={"leaseToken": "x" * 43, "fencingToken": 1, "progress": {"phase": "RUNNING"}},
        )
    ).status_code in [403, 404, 409]
    assert (await c.get("/internal/v1/runtime", headers=headers)).json()["data"][
        "status"
    ] == "OFFLINE"
