"""Current fence/authorization must be checked after actual external storage I/O."""

import asyncio
from hashlib import sha256
from test_auth import setup, login
from test_workspace import workspace
from test_lease_mysql import queued_browser_jobs, device, claim_body, auth
from veriq_server.services.artifact import FileArtifactStore
from veriq_server.db import AttemptUpload


async def test_revocation_during_real_file_staging_never_commits_upload(site, monkeypatch):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    await queued_browser_jobs(c, db, ws, 1)
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
    data = b"actual staged restricted bytes"
    created = await c.post(
        endpoint + "/artifact-uploads",
        json={
            **proof,
            "kind": "TRACE",
            "filename": "trace.zip",
            "contentType": "application/zip",
            "sha256": sha256(data).hexdigest(),
            "sizeBytes": len(data),
            "sensitivity": "REDACTED",
        },
        headers=auth(credential),
    )
    assert created.status_code == 201
    upload = created.json()["data"]
    staged, release = asyncio.Event(), asyncio.Event()
    original = FileArtifactStore.put

    async def paused(self, *args):
        await original(self, *args)
        staged.set()
        await release.wait()

    monkeypatch.setattr(FileArtifactStore, "put", paused)
    pending = asyncio.create_task(
        c.put(
            upload["uploadUrl"] + "?offset=0",
            content=data,
            headers={
                **auth(credential),
                "Content-Type": "application/octet-stream",
                "X-VeriQ-Lease-Token": claim["leaseToken"],
                "X-VeriQ-Fencing-Token": str(claim["fencingToken"]),
            },
        )
    )
    try:
        await asyncio.wait_for(staged.wait(), 10)
        # This mutation completing while I/O waits also proves the installation lock was released.
        revoked = await asyncio.wait_for(
            c.post(f"/api/v1/workspaces/{ws}/runtimes/{credential['runnerId']}/revoke", json={}), 5
        )
        assert revoked.status_code == 200
    finally:
        release.set()
    result = await pending
    assert result.status_code in {401, 403}
    async with db.sessions() as session:
        assert not (await session.get(AttemptUpload, upload["artifactId"])).complete
