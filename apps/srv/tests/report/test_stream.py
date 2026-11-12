"""Real HTTP streaming replay, disconnect and current membership checks."""

import asyncio
import json
import httpx
from test_auth import setup, login
from test_workspace import workspace
from test_lease_mysql import queued_browser_jobs, device, claim_body, auth
from veriq_server.db import Job, WorkspaceMember


async def event(lines):
    result = {}

    async def read():
        async for line in lines:
            if not line:
                if result:
                    return result
                continue
            if line.startswith("id: "):
                result["id"] = line[4:]
            if line.startswith("event: "):
                result["event"] = line[7:]
            if line.startswith("data: "):
                result["data"] = json.loads(line[6:])
        raise AssertionError("Stream ended before event")

    return await asyncio.wait_for(read(), 10)


async def test_sse_replays_once_and_closes_after_membership_revocation(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    jobs = await queued_browser_jobs(c, db, ws, 1)
    credential = await device(c, ws)
    claim = (
        await c.post(
            "/internal/v1/jobs/claim", json=claim_body(credential), headers=auth(credential)
        )
    ).json()["data"]
    proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
    endpoint = f"/internal/v1/attempts/{claim['attemptId']}"
    assert (
        await c.post(endpoint + "/activate", json=proof, headers=auth(credential))
    ).status_code == 200
    events = [
        {
            "schemaVersion": "1.0",
            "attemptId": claim["attemptId"],
            "sequence": 1,
            "timestamp": "2026-11-11T12:00:00Z",
            "type": "ATTEMPT_STARTED",
            "payload": {"engineVersion": "0.1.0", "sourceHash": "0" * 64},
        }
    ]
    assert (
        await c.post(
            endpoint + "/events", json={**proof, "events": events}, headers=auth(credential)
        )
    ).status_code == 200
    assert (
        await c.post(
            endpoint + "/events", json={**proof, "events": events}, headers=auth(credential)
        )
    ).status_code == 200
    async with db.sessions() as session:
        run_id = (await session.get(Job, jobs[0])).run_id
    path = f"/api/v1/workspaces/{ws}/runs/{run_id}/events/stream"
    from uuid import uuid4
    from veriq_server.handlers.report import encode_cursor

    actor = (await c.get("/api/v1/account")).json()["data"]["id"]
    maximum = encode_cursor(
        "b" * 64,
        {"workspaceId": ws, "runId": run_id, "userId": actor},
        {str(uuid4()): 9007199254740991 for _ in range(2000)},
    )
    # The actual POST transport admits the maximum signed body and rejects its
    # foreign Attempt positions normally, rather than failing a header/body limit.
    invalid = await c.post(path, json={"cursor": maximum})
    assert invalid.status_code == 400 and invalid.json()["code"] == "REPORT_RESYNC_REQUIRED"
    oversized = await c.post(path, json={"cursor": "x" * (256 * 1024)})
    assert oversized.status_code == 413
    async with httpx.AsyncClient(
        base_url=str(c.base_url), cookies=c.cookies, headers=c.headers, timeout=10
    ) as raw:
        async with raw.stream("POST", path, json={}) as response:
            assert response.status_code == 200
            first = await event(response.aiter_lines())
            assert len(first["data"]["events"]) == 1
            cursor = first["id"]
        async with raw.stream("POST", path, json={"cursor": cursor}) as response:
            lines = response.aiter_lines()
            replay = await event(lines)
            assert replay["data"]["events"] == []
            runtime = f"/api/v1/workspaces/{ws}/runtimes/{credential['runnerId']}"
            assert (
                await c.put(
                    runtime + "/grants",
                    json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
                )
            ).status_code == 200
            assert (
                await c.put(
                    runtime + "/trust",
                    json={"trustStatus": "MANAGED", "allowCredentialDelivery": False},
                )
            ).status_code == 200
            trust_update = await event(lines)
            assert trust_update["event"] == "report" and trust_update["data"]["events"] == []
            attempt = trust_update["data"]["report"]["cases"][0]["attempts"][0]
            assert attempt["provenance"]["trustStatus"] == "USER_REGISTERED"
            assert not attempt["gateNow"]["passed"]
            actor = (await c.get("/api/v1/account")).json()["data"]["id"]
            async with db.sessions.begin() as session:
                member = await session.get(WorkspaceMember, (ws, actor))
                member.status = "REMOVED"
            revoked = await event(lines)
            assert revoked["event"] == "authorization"
            assert revoked["data"]["code"] == "WORKSPACE_FORBIDDEN"
        assert (await raw.post(path, json={"cursor": cursor})).status_code == 403
