
import asyncio
import json
from base64 import b64encode
from datetime import timedelta
from hashlib import sha256
from urllib.parse import quote
from uuid import uuid4
import httpx
import pytest
from sqlalchemy import select
from test_auth import setup, login
from test_workspace import workspace
from test_lease_mysql import queued_browser_jobs, device, claim_body, auth
from test_completion_mysql import upload
from test_stream import event
from veriq_server.auth.authorization import WorkspaceScope
from veriq_server.contracts import canonical_bytes
from veriq_server.db import (
    Artifact,
    ArtifactPublication,
    Attempt,
    AttemptUpload,
    CaseExecution,
    Job,
    Run,
    SecretVersion,
)
from veriq_server.repositories.resource import ResourceRepository
from veriq_server.service import now, lock_installation
from veriq_server.services.artifact import FileArtifactStore, S3ArtifactStore, key


async def active(site):
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
    endpoint = f"/internal/v1/attempts/{claim['attemptId']}"
    proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
    assert (
        await c.post(endpoint + "/activate", json=proof, headers=auth(credential))
    ).status_code == 200
    return c, db, ws, jobs[0], credential, claim, endpoint, proof


async def maintenance(c, ws):
    account = (
        await c.post(
            f"/api/v1/workspaces/{ws}/service-accounts", json={"name": "Review retirement"}
        )
    ).json()["data"]
    token = (
        await c.post(
            f"/api/v1/workspaces/{ws}/service-accounts/{account['id']}/tokens",
            json={"purpose": "MAINTENANCE", "operations": ["artifacts/expire"]},
        )
    ).json()["data"]["token"]

    async def expire():
        response = await c.post(
            "/internal/v1/maintenance/artifacts/expire",
            json={"workspaceId": ws, "limit": 100},
            headers={"Authorization": "Bearer " + token, "Idempotency-Key": str(uuid4())},
        )
        assert response.status_code == 200, response.text

    return expire


@pytest.mark.parametrize("site", ["FILE", "S3"], indirect=True)
async def test_r1_source_promotion_before_raw_publication_cannot_leave_late_bytes(
    site, monkeypatch
):
    c, db, ws, _, credential, claim, endpoint, proof = await active(site)
    raw = b"synthetic protected bytes shared with immutable source"
    digest = sha256(raw).hexdigest()
    response = await c.post(
        endpoint + "/artifact-uploads",
        json={
            **proof,
            "kind": "LOG",
            "filename": "raw.log",
            "contentType": "text/plain",
            "sha256": digest,
            "sizeBytes": len(raw),
            "sensitivity": "REDACTED",
        },
        headers=auth(credential),
    )
    assert response.status_code == 201
    created = response.json()["data"]
    entered, resume = asyncio.Event(), asyncio.Event()
    original = FileArtifactStore.put
    physical = []
    original_s3 = S3ArtifactStore.put

    async def before_publish(store, workspace_id, sha, content, incarnation=None):
        physical.append((store, workspace_id, sha, incarnation))
        entered.set()
        await resume.wait()
        return await (original if isinstance(store, FileArtifactStore) else original_s3)(
            store, workspace_id, sha, content, incarnation
        )

    monkeypatch.setattr(FileArtifactStore, "put", before_publish)
    monkeypatch.setattr(S3ArtifactStore, "put", before_publish)
    pending = asyncio.create_task(
        c.put(
            created["uploadUrl"] + "?offset=0",
            content=raw,
            headers={
                **auth(credential),
                "Content-Type": "application/octet-stream",
                "X-VeriQ-Lease-Token": claim["leaseToken"],
                "X-VeriQ-Fencing-Token": str(claim["fencingToken"]),
            },
        )
    )
    expire = await maintenance(c, ws)
    try:
        await asyncio.wait_for(entered.wait(), 10)
        await upload(c, credential, claim, raw, "source.ts", "SOURCE")
        await expire()
        resume.set()
        result = await asyncio.wait_for(pending, 10)
        assert result.status_code == 409
        await expire()
        store, workspace_id, sha, incarnation = physical[0]
        if isinstance(store, FileArtifactStore):
            assert store._path(workspace_id, sha, incarnation).read_bytes() == b""
        else:
            retired = await asyncio.to_thread(
                store.client.get_object,
                Bucket=store.bucket,
                Key=key(workspace_id, sha, incarnation),
            )
            assert retired["Body"].read() == b""
            retired["Body"].close()
        with pytest.raises(ValueError):
            await store.read(workspace_id, sha, len(raw), incarnation)
        async with db.sessions.begin() as session:
            source = await ResourceRepository(session, WorkspaceScope(ws)).artifact(digest)
            assert source.content == raw
            attempt = await session.get(Attempt, claim["attemptId"])
            attempt.phase, attempt.outcome = "FINISHED", "ERROR"
            attempt.finished_at = now() - timedelta(days=40)
        await expire()
        async with db.sessions() as session:
            assert (await session.get(AttemptUpload, created["artifactId"])).expired_at
            assert (await session.get(Artifact, (ws, digest))).content == raw
    finally:
        resume.set()
        await pending


@pytest.mark.parametrize("encoding", ["exact", "url", "base64"])
async def test_r2_revoked_pinned_keys_are_withheld_in_history_and_sse_without_protocol_loss(
    site, encoding
):
    c, db, ws, job_id, credential, claim, endpoint, proof = await active(site)
    secret = "synthetic/key credential!"
    forms = [secret, quote(secret, safe=""), b64encode(secret.encode()).decode()]
    pin = (
        await c.post(
            f"/api/v1/workspaces/{ws}/credentials",
            json={
                "secretRef": "review",
                "value": {"token": secret, "protocolCoincidence": "sequence"},
                "allowedIdentityIds": ["reader"],
            },
        )
    ).json()["data"]["versionId"]
    async with db.sessions.begin() as session:
        await lock_installation(session)
        attempt = await session.get(Attempt, claim["attemptId"])
        attempt.snapshot_hash = await ResourceRepository(session, WorkspaceScope(ws)).store(
            canonical_bytes({"secretVersions": [{"secretRef": "review", "versionId": pin}]})
        )
        (await session.get(SecretVersion, pin)).revoked = True
        run_id = (await session.get(Job, job_id)).run_id
    actual = {
        forms[["exact", "url", "base64"].index(encoding)]: "record",
        "[REDACTED]": "do not merge",
    }
    document = {
        "schemaVersion": "1.0",
        "attemptId": claim["attemptId"],
        "sequence": 1,
        "timestamp": "2026-11-11T12:00:00Z",
        "type": "ASSERTION_RESULT",
        "stepId": "step",
        "assertionId": "assertion",
        "payload": {
            "expectedSource": "REQ-review",
            "status": "PASSED",
            "severity": "BLOCK",
            "durationMs": 1,
            "expected": {"safe": "expected"},
            "actual": {"present": True, "value": actual},
        },
    }
    posted = await c.post(
        endpoint + "/events", json={**proof, "events": [document]}, headers=auth(credential)
    )
    assert posted.status_code == 200, posted.text

    def check(projected):
        text = json.dumps(projected)
        assert all(form not in text for form in forms)
        assert projected["sequence"] == 1 and projected["type"] == "ASSERTION_RESULT"
        assert projected["valuesAvailable"] is True
        assert projected["payload"]["actual"] == {"present": True, "value": "[REDACTED]"}
        assert projected["payload"]["expected"] == {"safe": "expected"}

    history = await c.get(f"/api/v1/workspaces/{ws}/attempts/{claim['attemptId']}/history")
    assert history.status_code == 200
    check(history.json()["data"]["items"][0])
    async with httpx.AsyncClient(
        base_url=str(c.base_url), cookies=c.cookies, headers=c.headers, timeout=10
    ) as raw:
        async with raw.stream(
            "POST", f"/api/v1/workspaces/{ws}/runs/{run_id}/events/stream", json={}
        ) as response:
            assert response.status_code == 200
            check((await event(response.aiter_lines()))["data"]["events"][0])


async def test_r4_first_pass_uses_attempt_number_not_uuid_order(site):
    c, db, ws, job_id, _, claim, _, _ = await active(site)
    async with db.sessions.begin() as session:
        first = await session.get(Attempt, claim["attemptId"])
        first.phase, first.outcome = "FINISHED", "FAILED"
        first.finished_at = now()
        values = {column.name: getattr(first, column.name) for column in Attempt.__table__.columns}
        values.update(id="00000000-0000-4000-8000-000000000001", attempt_no=2, outcome="PASSED")
        assert values["id"] < first.id
        session.add(Attempt(**values))
        job = await session.get(Job, job_id)
        job.state, job.outcome = "FINISHED", "UNSTABLE"
        case = await session.get(CaseExecution, job.case_execution_id)
        case.state, case.outcome = "FINISHED", "UNSTABLE"
        run = await session.get(Run, job.run_id)
        run.state, run.outcome = "FINISHED", "UNSTABLE"
        run_id = run.id
    response = await c.get(f"/api/v1/workspaces/{ws}/runs/{run_id}/report")
    assert response.status_code == 200, response.text
    report = response.json()["data"]
    assert report["statistics"]["firstPassCount"] == 0
    assert report["statistics"]["retryPassCount"] == 1
    assert report["run"]["outcome"] == report["cases"][0]["outcome"] == "UNSTABLE"
    assert [a["attemptNo"] for a in report["cases"][0]["attempts"]] == [1, 2]


@pytest.mark.parametrize("site", ["FILE", "S3"], indirect=True)
@pytest.mark.parametrize("published", [False, True])
async def test_r1_persisted_interrupted_publication_recovers_without_request_cleanup(
    site, monkeypatch, published
):
    c, db, ws, _, credential, claim, endpoint, proof = await active(site)
    raw = b"synthetic crash-recovery private bytes"
    digest = sha256(raw).hexdigest()
    created = (
        await c.post(
            endpoint + "/artifact-uploads",
            json={
                **proof,
                "kind": "LOG",
                "filename": "interrupted.log",
                "contentType": "text/plain",
                "sha256": digest,
                "sizeBytes": len(raw),
                "sensitivity": "REDACTED",
            },
            headers=auth(credential),
        )
    ).json()["data"]
    methods = {FileArtifactStore: FileArtifactStore.put, S3ArtifactStore: S3ArtifactStore.put}
    observed = []

    async def interrupted(store, workspace_id, sha, content, incarnation=None):
        observed.append((store, incarnation))
        if published:
            await methods[type(store)](store, workspace_id, sha, content, incarnation)
        raise OSError("synthetic interrupted storage operation")

    for cls in methods:
        monkeypatch.setattr(cls, "put", interrupted)
    result = await c.put(
        created["uploadUrl"] + "?offset=0",
        content=raw,
        headers={
            **auth(credential),
            "Content-Type": "application/octet-stream",
            "X-VeriQ-Lease-Token": claim["leaseToken"],
            "X-VeriQ-Fencing-Token": str(claim["fencingToken"]),
        },
    )
    assert result.status_code == 500
    store, incarnation = observed[0]
    async with db.sessions.begin() as session:
        publication = await session.get(ArtifactPublication, incarnation)
        assert publication.state == "PENDING"
        # Persisted loss of lease authorizes retirement, not an assumption that put
        # stopped. We deliberately resume the original create-only put afterward.
        (await session.get(Attempt, claim["attemptId"])).lease_expires_at = now() - timedelta(
            seconds=1
        )
    expire = await maintenance(c, ws)
    await expire()
    async with db.sessions() as session:
        assert (await session.get(ArtifactPublication, incarnation)).state == "RETIRED"
        assert (await session.get(Artifact, (ws, digest))).expired_at
        assert not (await session.get(AttemptUpload, created["artifactId"])).complete
    with pytest.raises(ValueError):
        await methods[type(store)](store, ws, digest, raw, incarnation)
    await expire()
    if isinstance(store, FileArtifactStore):
        assert store._path(ws, digest, incarnation).read_bytes() == b""
    else:
        retired = await asyncio.to_thread(
            store.client.get_object, Bucket=store.bucket, Key=key(ws, digest, incarnation)
        )
        assert retired["Body"].read() == b""
        retired["Body"].close()


async def test_r1_empty_evidence_cannot_read_through_a_retired_publication(site):
    c, db, ws, _, credential, claim, _, _ = await active(site)
    digest = await upload(c, credential, claim, b"", "empty.bin", "DOWNLOAD")
    async with db.sessions.begin() as session:
        artifact = await session.get(Artifact, (ws, digest))
        publication = await session.get(ArtifactPublication, artifact.storage_incarnation)
        publication.state = "RETIRED"
        row = (
            await session.execute(select(AttemptUpload).where(AttemptUpload.sha256 == digest))
        ).scalar_one()
        path = f"/api/v1/workspaces/{ws}/attempts/{claim['attemptId']}/artifacts/{row.id}"
    assert (await c.get(path)).status_code == 410
