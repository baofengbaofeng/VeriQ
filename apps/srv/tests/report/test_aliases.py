
import asyncio
from datetime import timedelta
from uuid import uuid4
from hashlib import sha256
from sqlalchemy import select
from test_auth import setup, login
from test_workspace import workspace
from test_lease_mysql import queued_browser_jobs, device, auth, claim_body
from test_completion_mysql import upload
from veriq_server.db import Attempt, AttemptUpload
from veriq_server.service import now
from veriq_server.services.artifact import FileArtifactStore


async def test_live_alias_pins_bytes_and_old_delete_cannot_remove_rehydrated_upload(
    site, monkeypatch
):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    await queued_browser_jobs(c, db, ws, 3)
    credential = await device(c, ws)
    raw = b"identical actual downloaded fixture bytes" * 27000
    digest = sha256(raw).hexdigest()

    async def capture():
        response = await c.post(
            "/internal/v1/jobs/claim", json=claim_body(credential), headers=auth(credential)
        )
        assert response.status_code == 200, response.text
        claim = response.json()["data"]
        proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
        target = f"/internal/v1/attempts/{claim['attemptId']}"
        assert (
            await c.post(target + "/activate", json=proof, headers=auth(credential))
        ).status_code == 200
        await upload(c, credential, claim, raw, "same.bin", "DOWNLOAD")
        async with db.sessions() as session:
            row = (
                await session.execute(
                    select(AttemptUpload).where(
                        AttemptUpload.attempt_id == claim["attemptId"],
                        AttemptUpload.sha256 == digest,
                    )
                )
            ).scalar_one()
            path = f"/api/v1/workspaces/{ws}/attempts/{claim['attemptId']}/artifacts/{row.id}"
        # Completed external upload lost-ACK recovery verifies the exact tail chunk.
        replay_headers = {
            **auth(credential),
            "Content-Type": "application/octet-stream",
            "X-VeriQ-Lease-Token": claim["leaseToken"],
            "X-VeriQ-Fencing-Token": str(claim["fencingToken"]),
        }
        replay_target = target + f"/artifact-uploads/{row.id}?offset=1048576"
        replay = await c.put(replay_target, content=raw[1048576:], headers=replay_headers)
        assert replay.status_code == 200 and replay.json()["data"]["complete"]
        changed = await c.put(replay_target, content=b"wrong", headers=replay_headers)
        assert changed.status_code == 409 and changed.json()["code"] == "UPLOAD_CONFLICT"
        return claim, path

    async def terminal(claim, days):
        target = f"/internal/v1/attempts/{claim['attemptId']}/reconcile"
        assert (
            await c.post(
                target,
                json={
                    "fencingToken": claim["fencingToken"],
                    "processStopped": True,
                    "cleanupStatus": "NOT_REQUIRED",
                    "stoppedAt": "2026-11-11T12:00:00Z",
                },
                headers=auth(credential),
            )
        ).status_code == 200
        async with db.sessions.begin() as session:
            attempt = await session.get(Attempt, claim["attemptId"])
            attempt.finished_at = now() - timedelta(days=days)

    first, old_path = await capture()
    await terminal(first, 40)
    second, live_path = await capture()
    account = (
        await c.post(f"/api/v1/workspaces/{ws}/service-accounts", json={"name": "Alias retention"})
    ).json()["data"]
    token = (
        await c.post(
            f"/api/v1/workspaces/{ws}/service-accounts/{account['id']}/tokens",
            json={"purpose": "MAINTENANCE", "operations": ["artifacts/expire"]},
        )
    ).json()["data"]["token"]

    async def expire():
        return await c.post(
            "/internal/v1/maintenance/artifacts/expire",
            json={"workspaceId": ws, "limit": 100},
            headers={"Authorization": "Bearer " + token, "Idempotency-Key": str(uuid4())},
        )

    assert (await expire()).status_code == 200
    assert (await c.get(old_path)).status_code == 410
    assert (await c.get(live_path)).content == raw
    await terminal(second, 1)
    assert (await expire()).status_code == 200
    assert (await c.get(live_path)).content == raw
    await terminal(second, 40)
    deleting, release = asyncio.Event(), asyncio.Event()
    original = FileArtifactStore.retire

    async def paused(self, *args):
        deleting.set()
        await release.wait()
        return await original(self, *args)

    monkeypatch.setattr(FileArtifactStore, "retire", paused)
    pending = asyncio.create_task(expire())
    try:
        await asyncio.wait_for(deleting.wait(), 10)
        third, new_path = await capture()
        assert (await c.get(new_path)).content == raw
        release.set()
        assert (await asyncio.wait_for(pending, 10)).status_code == 200
        assert (await c.get(new_path)).content == raw
        assert (await c.get(old_path)).status_code == 410
        assert (await c.get(live_path)).status_code == 410
    finally:
        release.set()
        await pending
