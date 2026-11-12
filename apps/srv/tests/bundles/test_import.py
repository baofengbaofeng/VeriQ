
from uuid import uuid4
import sys
import pytest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "execution"))


async def test_import_requires_authenticated_membership_before_payload(site):
    client, _ = site
    response = await client.post(
        f"/api/v1/workspaces/{uuid4()}/result-imports",
        json={},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 401, response.text


async def imported_fixture(approved_metadata, site):
    import io
    import json
    import zipfile
    from test_auth import setup, login
    from test_workspace import workspace
    from test_export import published, environment
    from veriq_server.repositories.resource import ResourceRepository
    from veriq_server.auth.authorization import WorkspaceScope

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    async with db.sessions.begin() as session:
        for raw in approved_metadata.values():
            await ResourceRepository(session, WorkspaceScope(ws)).store(raw)
    env = await environment(c, db, ws)
    catalog = await published(
        c,
        db,
        ws,
        "catalog",
        "ELEMENT_CATALOG",
        {
            "schemaVersion": "1.0",
            "elements": [{"key": "save", "locator": {"by": "testId", "value": "save"}}],
        },
    )
    case = await published(
        c,
        db,
        ws,
        "case",
        "CASE",
        {
            "schemaVersion": "1.0",
            "caseKey": "read",
            "title": "Read",
            "kind": "READ",
            "roleKey": "reader",
            "catalogVersionId": catalog,
            "steps": [{"id": "open", "action": "goto", "path": "/"}],
        },
    )
    c.headers["Idempotency-Key"] = str(uuid4())
    response = await c.post(
        f"/api/v1/workspaces/{ws}/bundles",
        json={
            "caseVersionIds": [case],
            "environmentVersionId": env,
            "validationStatus": "VALIDATED",
        },
    )
    assert response.status_code == 201, response.text
    bundle = response.json()["data"]
    archive = zipfile.ZipFile(
        io.BytesIO(
            (await c.get(f"/api/v1/workspaces/{ws}/bundles/{bundle['id']}/download")).content
        )
    )
    snapshot = json.loads(archive.read("snapshot.json"))
    actual = next(a["document"] for a in snapshot["assets"] if a["versionId"] == env)
    payload = {
        "schemaVersion": "1.0",
        "workspaceId": ws,
        "bundleId": bundle["id"],
        "localRunId": str(uuid4()),
        "deviceId": str(uuid4()),
        "source": "OFFLINE_IMPORT",
        "trustStatus": "MANAGED",
        "dirty": True,
        "revocationStatus": "CURRENT",
        "manifestSha256": bundle["manifestSha256"],
        "startedAt": "2026-11-12T00:00:00Z",
        "finishedAt": "2026-11-12T00:00:01Z",
        "outcome": "PASSED",
        "actualEnvironment": actual,
        "attempts": [
            {
                "attemptId": str(uuid4()),
                "caseVersionId": case,
                "attemptNo": 1,
                "outcome": "PASSED",
                "cleanupStatus": "NOT_REQUIRED",
                "lastSequence": 0,
                "events": [],
                "artifacts": [],
            }
        ],
    }
    return c, db, ws, payload, bundle


async def test_idempotent_import_preserves_claimed_facts_but_never_promotes_gate(
    approved_metadata, site
):
    c, db, ws, payload, bundle = await imported_fixture(approved_metadata, site)
    c.headers["Idempotency-Key"] = str(uuid4())
    route = f"/api/v1/workspaces/{ws}/result-imports"
    first = await c.post(route, json=payload)
    assert first.status_code == 201, first.text
    second = await c.post(route, json=payload)
    assert second.status_code == 201, second.text
    assert first.json()["data"]["runId"] == second.json()["data"]["runId"]
    assert first.json()["data"]["source"] == "OFFLINE_IMPORT"
    assert first.json()["data"]["officialGatePassed"] is False
    c.headers["Idempotency-Key"] = str(uuid4())
    assert (await c.post(route, json=payload)).json()["data"]["runId"] == first.json()["data"][
        "runId"
    ]
    payload["dirty"] = False
    changed = await c.post(route, json=payload)
    assert changed.status_code == 409, changed.text
    report = await c.get(f"/api/v1/workspaces/{ws}/runs/{first.json()['data']['runId']}/report")
    assert report.status_code == 200, report.text
    assert report.json()["data"]["run"]["outcome"] == "INCOMPLETE"
    assert report.json()["data"]["gateNow"]["passed"] is False


async def test_import_raw_bytes_use_private_authorized_transfer_and_scoped_report(
    approved_metadata, site
):
    from hashlib import sha256

    c, db, ws, payload, bundle = await imported_fixture(approved_metadata, site)
    raw = b"<html>private offline evidence</html>"
    file = {
        "path": "report.html",
        "sha256": sha256(raw).hexdigest(),
        "sizeBytes": len(raw),
        "kind": "HTML",
        "artifactId": str(uuid4()),
        "sensitivity": "CREDENTIAL_RESTRICTED",
    }
    req = {
        "bundleId": bundle["id"],
        "localRunId": payload["localRunId"],
        "attemptId": payload["attempts"][0]["attemptId"],
        "file": file,
    }
    start = await c.post(f"/api/v1/workspaces/{ws}/result-import-uploads", json=req)
    assert start.status_code == 201, start.text
    upload = start.json()["data"]
    response = await c.put(
        upload["uploadUrl"] + "?offset=0",
        content=raw,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["complete"] is True
    payload["attempts"][0]["artifacts"] = [file]
    c.headers["Idempotency-Key"] = str(uuid4())
    imported = await c.post(f"/api/v1/workspaces/{ws}/result-imports", json=payload)
    assert imported.status_code == 201, imported.text
    report = (
        await c.get(f"/api/v1/workspaces/{ws}/runs/{imported.json()['data']['runId']}/report")
    ).json()["data"]
    attempt = report["cases"][0]["attempts"][0]["id"]
    files = await c.get(f"/api/v1/workspaces/{ws}/attempts/{attempt}/artifacts")
    assert files.status_code == 200, files.text
    assert files.json()["data"]["items"][0]["sensitivity"] == "CREDENTIAL_RESTRICTED"
    response = await c.get(f"/api/v1/workspaces/{ws}/attempts/{attempt}/artifacts/{upload['id']}")
    assert response.status_code == 200, response.text
    assert response.content == raw
    assert response.headers["content-type"] == "application/octet-stream"
    assert "sandbox" in response.headers["content-security-policy"]
    wrong = await c.get(f"/api/v1/workspaces/{uuid4()}/attempts/{attempt}/artifacts/{upload['id']}")
    assert wrong.status_code in {403, 404}


async def test_offline_pending_publication_survives_recovery_until_its_reservation_expires(
    approved_metadata, site
):
    from datetime import timedelta
    from hashlib import sha256
    from veriq_server.db import Artifact, ArtifactPublication, OfflineImportUpload
    from veriq_server.services.publication import recover
    from veriq_server.service import now

    c, db, ws, payload, bundle = await imported_fixture(approved_metadata, site)
    raw = b"pending offline bytes"
    file = {
        "path": "trace.zip",
        "sha256": sha256(raw).hexdigest(),
        "sizeBytes": len(raw),
        "kind": "TRACE",
        "sensitivity": "CREDENTIAL_RESTRICTED",
    }
    reply = await c.post(
        f"/api/v1/workspaces/{ws}/result-import-uploads",
        json={
            "bundleId": bundle["id"],
            "localRunId": payload["localRunId"],
            "attemptId": payload["attempts"][0]["attemptId"],
            "file": file,
        },
    )
    upload_id = reply.json()["data"]["id"]
    incarnation = str(uuid4())
    async with db.sessions.begin() as session:
        session.add(
            Artifact(
                workspace_id=ws,
                sha256=file["sha256"],
                content=None,
                size_bytes=len(raw),
                media_type="application/octet-stream",
                storage_backend="FILE",
                storage_incarnation=incarnation,
            )
        )
        session.add(
            ArtifactPublication(
                id=incarnation,
                workspace_id=ws,
                sha256=file["sha256"],
                storage_backend="FILE",
                upload_id=None,
                offline_upload_id=upload_id,
                state="PENDING",
            )
        )
        upload = await session.get(OfflineImportUpload, upload_id)
        upload.storage_incarnation = incarnation
    async with db.sessions.begin() as session:
        await recover(session, ws, 100)
        assert (await session.get(ArtifactPublication, incarnation)).state == "PENDING"
        upload = await session.get(OfflineImportUpload, upload_id)
        upload.expires_at = now() - timedelta(seconds=1)
    async with db.sessions.begin() as session:
        await recover(session, ws, 100)
        assert (await session.get(ArtifactPublication, incarnation)).state == "RETIRED"


async def test_import_replay_reauthorizes_and_chunk_cannot_finish_after_permission_revocation(
    approved_metadata, site, monkeypatch
):
    from hashlib import sha256
    from sqlalchemy import select
    from veriq_server.db import WorkspaceMember
    from veriq_server.services.artifact import FileArtifactStore

    c, db, ws, payload, bundle = await imported_fixture(approved_metadata, site)
    c.headers["Idempotency-Key"] = str(uuid4())
    route = f"/api/v1/workspaces/{ws}/result-imports"
    assert (await c.post(route, json=payload)).status_code == 201
    raw = b"authority race bytes"
    file = {
        "path": "trace.zip",
        "sha256": sha256(raw).hexdigest(),
        "sizeBytes": len(raw),
        "kind": "TRACE",
        "sensitivity": "CREDENTIAL_RESTRICTED",
    }
    reply = await c.post(
        f"/api/v1/workspaces/{ws}/result-import-uploads",
        json={
            "bundleId": bundle["id"],
            "localRunId": str(uuid4()),
            "attemptId": str(uuid4()),
            "file": file,
        },
    )
    assert reply.status_code == 201, reply.text
    original = FileArtifactStore.put

    async def put_and_revoke(self, *args, **kwargs):
        await original(self, *args, **kwargs)
        async with db.sessions.begin() as session:
            member = (
                await session.execute(
                    select(WorkspaceMember).where(WorkspaceMember.workspace_id == ws)
                )
            ).scalar_one()
            member.role = "VIEWER"

    monkeypatch.setattr(FileArtifactStore, "put", put_and_revoke)
    response = await c.put(
        reply.json()["data"]["uploadUrl"] + "?offset=0",
        content=raw,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert response.status_code == 403, response.text
    replay = await c.post(route, json=payload)
    assert replay.status_code == 403, replay.text


async def test_import_rejects_execution_role_outside_signed_selection(approved_metadata, site):
    import io
    import json
    import zipfile
    from hashlib import sha256
    from veriq_server.contracts import canonical_bytes

    c, db, ws, payload, bundle = await imported_fixture(approved_metadata, site)
    archive = zipfile.ZipFile(
        io.BytesIO(
            (await c.get(f"/api/v1/workspaces/{ws}/bundles/{bundle['id']}/download")).content
        )
    )
    case = payload["attempts"][0]["caseVersionId"]
    source = json.loads(archive.read(f"provenance/{case}/source.json"))
    selection = json.loads(archive.read("selection.json"))
    snapshot = json.loads(archive.read("snapshot.json"))
    execution = {
        "schemaVersion": "1.0",
        "workspaceId": ws,
        "runId": payload["localRunId"],
        "caseExecutionId": str(uuid4()),
        "caseVersionId": case,
        "assetSourceHash": source["sourceHash"],
        "environmentVersionId": selection["environmentVersionId"],
        "environment": payload["actualEnvironment"],
        "roleKey": "forged_role",
        "browser": "chromium",
        "variables": {},
        "secretVersions": [],
        "authAdapters": snapshot["authAdapters"],
        "namespace": "attempt_offline",
        "attemptNo": 1,
        "suiteEntryIndex": 0,
    }
    payload["attempts"][0]["execution"] = execution
    payload["attempts"][0]["variantKey"] = sha256(
        canonical_bytes([case, 0, "forged_role", "chromium", None, None])
    ).hexdigest()
    c.headers["Idempotency-Key"] = str(uuid4())
    response = await c.post(f"/api/v1/workspaces/{ws}/result-imports", json=payload)
    assert response.status_code == 422, response.text


async def test_completed_offline_chunk_replay_rejects_changed_bytes(approved_metadata, site):
    from hashlib import sha256

    c, db, ws, payload, bundle = await imported_fixture(approved_metadata, site)
    raw = b"completed-upload"
    file = {
        "path": "trace.zip",
        "sha256": sha256(raw).hexdigest(),
        "sizeBytes": len(raw),
        "kind": "TRACE",
        "sensitivity": "CREDENTIAL_RESTRICTED",
    }
    reply = await c.post(
        f"/api/v1/workspaces/{ws}/result-import-uploads",
        json={
            "bundleId": bundle["id"],
            "localRunId": payload["localRunId"],
            "attemptId": payload["attempts"][0]["attemptId"],
            "file": file,
        },
    )
    path = reply.json()["data"]["uploadUrl"] + "?offset=0"
    assert (
        await c.put(path, content=raw, headers={"Content-Type": "application/octet-stream"})
    ).status_code == 200
    changed = await c.put(
        path, content=b"changed", headers={"Content-Type": "application/octet-stream"}
    )
    assert changed.status_code == 409, changed.text


async def test_online_offline_shared_digest_aliases_preserve_live_bytes_both_directions(
    approved_metadata, site
):
    from datetime import timedelta
    from hashlib import sha256
    from sqlalchemy import select
    from test_lease_mysql import queued_browser_jobs, device, auth, claim_body
    from test_completion_mysql import upload
    from veriq_server.db import Attempt, AttemptUpload, OfflineImportUpload, Artifact
    from veriq_server.service import now

    c, db, ws, payload, bundle = await imported_fixture(approved_metadata, site)
    await queued_browser_jobs(c, db, ws, 1)
    credential = await device(c, ws)
    claim = (
        await c.post(
            "/internal/v1/jobs/claim", json=claim_body(credential), headers=auth(credential)
        )
    ).json()["data"]
    proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
    assert (
        await c.post(
            f"/internal/v1/attempts/{claim['attemptId']}/activate",
            json=proof,
            headers=auth(credential),
        )
    ).status_code == 200
    raw = b"actual shared online offline evidence"
    digest = await upload(c, credential, claim, raw, "shared.bin", "DOWNLOAD")
    async with db.sessions() as session:
        online = (
            await session.execute(
                select(AttemptUpload).where(
                    AttemptUpload.attempt_id == claim["attemptId"], AttemptUpload.sha256 == digest
                )
            )
        ).scalar_one()
        online_path = f"/api/v1/workspaces/{ws}/attempts/{claim['attemptId']}/artifacts/{online.id}"

    async def offline_alias():
        file = {
            "path": "shared.bin",
            "sha256": sha256(raw).hexdigest(),
            "sizeBytes": len(raw),
            "kind": "DOWNLOAD",
            "sensitivity": "CREDENTIAL_RESTRICTED",
        }
        response = await c.post(
            f"/internal/v1/workspaces/{ws}/result-import-uploads",
            json={
                "bundleId": bundle["id"],
                "localRunId": str(uuid4()),
                "attemptId": str(uuid4()),
                "file": file,
            },
            headers=auth(credential),
        )
        assert response.status_code == 201, response.text
        row = response.json()["data"]
        result = await c.put(
            row["uploadUrl"] + "?offset=0",
            content=raw,
            headers={**auth(credential), "Content-Type": "application/octet-stream"},
        )
        assert result.status_code == 200, result.text
        return row["id"]

    first = await offline_alias()
    account = (
        await c.post(
            f"/api/v1/workspaces/{ws}/service-accounts", json={"name": "Offline alias retention"}
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

    async with db.sessions.begin() as session:
        row = await session.get(OfflineImportUpload, first)
        row.expires_at = now() - timedelta(days=1)
    await expire()
    assert (await c.get(online_path)).content == raw
    second = await offline_alias()
    assert (
        await c.post(
            f"/internal/v1/attempts/{claim['attemptId']}/reconcile",
            json={
                "fencingToken": claim["fencingToken"],
                "processStopped": True,
                "cleanupStatus": "NOT_REQUIRED",
                "stoppedAt": "2026-11-12T00:00:00Z",
            },
            headers=auth(credential),
        )
    ).status_code == 200
    async with db.sessions.begin() as session:
        row = await session.get(Attempt, claim["attemptId"])
        row.finished_at = now() - timedelta(days=40)
    await expire()
    assert (await c.get(online_path)).status_code == 410
    async with db.sessions() as session:
        artifact = await session.get(Artifact, (ws, digest))
        assert artifact.expired_at is None
        assert (await session.get(OfflineImportUpload, second)).expired_at is None
    async with db.sessions.begin() as session:
        row = await session.get(OfflineImportUpload, second)
        row.expires_at = now() - timedelta(days=1)
    await expire()
    async with db.sessions() as session:
        assert (await session.get(Artifact, (ws, digest))).expired_at is not None


async def test_late_offline_writer_cannot_recreate_retired_publication(
    approved_metadata, site, monkeypatch
):
    import asyncio
    from datetime import timedelta
    from hashlib import sha256
    from veriq_server.db import OfflineImportUpload, ArtifactPublication, Artifact
    from veriq_server.services.artifact import FileArtifactStore
    from veriq_server.service import now

    c, db, ws, payload, bundle = await imported_fixture(approved_metadata, site)
    raw = b"late offline writer bytes"
    file = {
        "path": "trace.zip",
        "sha256": sha256(raw).hexdigest(),
        "sizeBytes": len(raw),
        "kind": "TRACE",
        "sensitivity": "CREDENTIAL_RESTRICTED",
    }
    reply = await c.post(
        f"/api/v1/workspaces/{ws}/result-import-uploads",
        json={
            "bundleId": bundle["id"],
            "localRunId": payload["localRunId"],
            "attemptId": payload["attempts"][0]["attemptId"],
            "file": file,
        },
    )
    row = reply.json()["data"]
    account = (
        await c.post(
            f"/api/v1/workspaces/{ws}/service-accounts", json={"name": "Offline late writer"}
        )
    ).json()["data"]
    token = (
        await c.post(
            f"/api/v1/workspaces/{ws}/service-accounts/{account['id']}/tokens",
            json={"purpose": "MAINTENANCE", "operations": ["artifacts/expire"]},
        )
    ).json()["data"]["token"]
    started, release = asyncio.Event(), asyncio.Event()
    original = FileArtifactStore.put
    seen = []

    async def paused(self, *args):
        seen.append(self)
        started.set()
        await release.wait()
        return await original(self, *args)

    monkeypatch.setattr(FileArtifactStore, "put", paused)
    pending = asyncio.create_task(
        c.put(
            row["uploadUrl"] + "?offset=0",
            content=raw,
            headers={"Content-Type": "application/octet-stream"},
        )
    )
    try:
        await asyncio.wait_for(started.wait(), 10)
        async with db.sessions.begin() as session:
            upload = await session.get(OfflineImportUpload, row["id"])
            upload.expires_at = now() - timedelta(seconds=1)
            incarnation = upload.storage_incarnation
        expired = await c.post(
            "/internal/v1/maintenance/artifacts/expire",
            json={"workspaceId": ws, "limit": 100},
            headers={"Authorization": "Bearer " + token, "Idempotency-Key": str(uuid4())},
        )
        assert expired.status_code == 200, expired.text
        release.set()
        response = await asyncio.wait_for(pending, 10)
        assert response.status_code in {409, 410}, response.text
        assert seen[0]._path(ws, file["sha256"], incarnation).read_bytes() == b""
        async with db.sessions() as session:
            assert (await session.get(ArtifactPublication, incarnation)).state == "RETIRED"
            assert (await session.get(Artifact, (ws, file["sha256"]))).expired_at is not None
    finally:
        release.set()
        await pending


async def test_imported_result_cannot_gain_new_artifacts_after_immutable_commit(
    approved_metadata, site
):
    from hashlib import sha256

    c, db, ws, payload, bundle = await imported_fixture(approved_metadata, site)
    c.headers["Idempotency-Key"] = str(uuid4())
    assert (
        await c.post(f"/api/v1/workspaces/{ws}/result-imports", json=payload)
    ).status_code == 201
    raw = b"late attachment"
    response = await c.post(
        f"/api/v1/workspaces/{ws}/result-import-uploads",
        json={
            "bundleId": bundle["id"],
            "localRunId": payload["localRunId"],
            "attemptId": payload["attempts"][0]["attemptId"],
            "file": {
                "path": "late.bin",
                "sha256": sha256(raw).hexdigest(),
                "sizeBytes": len(raw),
                "kind": "DOWNLOAD",
                "sensitivity": "CREDENTIAL_RESTRICTED",
            },
        },
    )
    assert response.status_code == 409, response.text


async def test_unlisted_prestaged_and_inflight_evidence_cannot_attach_after_import(
    approved_metadata, site, monkeypatch
):
    import asyncio
    from hashlib import sha256
    from veriq_server.services.artifact import FileArtifactStore

    c, db, ws, payload, bundle = await imported_fixture(approved_metadata, site)

    async def reserve(name):
        raw = name.encode()
        response = await c.post(
            f"/api/v1/workspaces/{ws}/result-import-uploads",
            json={
                "bundleId": bundle["id"],
                "localRunId": payload["localRunId"],
                "attemptId": payload["attempts"][0]["attemptId"],
                "file": {
                    "path": name,
                    "sha256": sha256(raw).hexdigest(),
                    "sizeBytes": len(raw),
                    "kind": "DOWNLOAD",
                    "sensitivity": "CREDENTIAL_RESTRICTED",
                },
            },
        )
        assert response.status_code == 201, response.text
        return response.json()["data"], raw

    completed, raw = await reserve("unlisted.bin")
    assert (
        await c.put(
            completed["uploadUrl"] + "?offset=0",
            content=raw,
            headers={"Content-Type": "application/octet-stream"},
        )
    ).status_code == 200
    inflight, raw = await reserve("inflight.bin")
    started, release = asyncio.Event(), asyncio.Event()
    original = FileArtifactStore.put

    async def paused(self, *args):
        started.set()
        await release.wait()
        return await original(self, *args)

    monkeypatch.setattr(FileArtifactStore, "put", paused)
    pending = asyncio.create_task(
        c.put(
            inflight["uploadUrl"] + "?offset=0",
            content=raw,
            headers={"Content-Type": "application/octet-stream"},
        )
    )
    try:
        await asyncio.wait_for(started.wait(), 10)
        c.headers["Idempotency-Key"] = str(uuid4())
        imported = await c.post(f"/api/v1/workspaces/{ws}/result-imports", json=payload)
        assert imported.status_code == 201, imported.text
        run = imported.json()["data"]["runId"]
        report = (await c.get(f"/api/v1/workspaces/{ws}/runs/{run}/report")).json()["data"]
        attempt = report["cases"][0]["attempts"][0]["id"]
        files = await c.get(f"/api/v1/workspaces/{ws}/attempts/{attempt}/artifacts")
        assert files.json()["data"]["items"] == [], files.text
        assert (
            await c.get(f"/api/v1/workspaces/{ws}/attempts/{attempt}/artifacts/{completed['id']}")
        ).status_code == 404
        release.set()
        response = await asyncio.wait_for(pending, 10)
        assert response.status_code == 409, response.text
        again = await c.put(
            inflight["uploadUrl"] + "?offset=0",
            content=raw,
            headers={"Content-Type": "application/octet-stream"},
        )
        assert again.status_code == 409, again.text
    finally:
        release.set()
        await pending


async def test_native_import_concurrent_keys_reauthorize_device_replay(approved_metadata, site):
    import asyncio
    from test_lease_mysql import device, auth

    c, db, ws, payload, bundle = await imported_fixture(approved_metadata, site)
    credential = await device(c, ws)
    path = f"/internal/v1/workspaces/{ws}/result-imports"
    headers = {**auth(credential), "Idempotency-Key": str(uuid4())}
    assert (
        await c.post(path, json=payload, headers={"Idempotency-Key": str(uuid4())})
    ).status_code == 401
    responses = await asyncio.gather(
        *(
            c.post(path, json=payload, headers={**headers, "Idempotency-Key": str(uuid4())})
            for _ in range(3)
        )
    )
    assert all(r.status_code == 201 for r in responses), [r.text for r in responses]
    assert len({r.json()["data"]["runId"] for r in responses}) == 1
    assert all(r.json()["data"]["officialGatePassed"] is False for r in responses)
    assert (
        await c.post(f"/api/v1/workspaces/{ws}/runtimes/{credential['runnerId']}/revoke", json={})
    ).status_code == 200
    assert (await c.post(path, json=payload, headers=headers)).status_code == 401


async def test_import_envelope_reaches_schema_above_three_mib_and_keeps_chunk_limit(site):
    from test_auth import setup, login

    c, _ = site
    await setup(c)
    await login(c)
    response = await c.post(
        f"/api/v1/workspaces/{uuid4()}/result-imports",
        json={"padding": "x" * (3 * 1024 * 1024 + 1)},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 400, response.text[:300]
    assert response.json()["code"] == "INVALID_REQUEST"
    chunk = await c.put(
        f"/api/v1/workspaces/{uuid4()}/result-import-uploads/{uuid4()}?offset=0",
        content=b"x" * (1024 * 1024 + 1),
        headers={"Content-Type": "application/octet-stream"},
    )
    assert chunk.status_code == 413, chunk.text


@pytest.mark.parametrize("with_online", [False, True])
async def test_offline_expiry_pagination_preserves_limit_and_continuation(
    approved_metadata, site, with_online
):
    from hashlib import sha256
    from datetime import timedelta
    from veriq_server.db import OfflineImportUpload
    from veriq_server.service import now

    c, db, ws, payload, bundle = await imported_fixture(approved_metadata, site)
    for name in ["one.bin", "two.bin"]:
        response = await c.post(
            f"/api/v1/workspaces/{ws}/result-import-uploads",
            json={
                "bundleId": bundle["id"],
                "localRunId": payload["localRunId"],
                "attemptId": payload["attempts"][0]["attemptId"],
                "file": {
                    "path": name,
                    "sha256": sha256(name.encode()).hexdigest(),
                    "sizeBytes": len(name),
                    "kind": "DOWNLOAD",
                    "sensitivity": "CREDENTIAL_RESTRICTED",
                },
            },
        )
        assert response.status_code == 201, response.text
        async with db.sessions.begin() as session:
            row = await session.get(OfflineImportUpload, response.json()["data"]["id"])
            row.expires_at = now() - timedelta(seconds=1)
    if with_online:
        from test_lease_mysql import queued_browser_jobs, device, auth, claim_body
        from test_completion_mysql import upload
        from veriq_server.db import Attempt

        await queued_browser_jobs(c, db, ws, 1)
        credential = await device(c, ws)
        claim = (
            await c.post(
                "/internal/v1/jobs/claim", json=claim_body(credential), headers=auth(credential)
            )
        ).json()["data"]
        proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
        assert (
            await c.post(
                f"/internal/v1/attempts/{claim['attemptId']}/activate",
                json=proof,
                headers=auth(credential),
            )
        ).status_code == 200
        await upload(c, credential, claim, b"online page", "online.bin", "DOWNLOAD")
        assert (
            await c.post(
                f"/internal/v1/attempts/{claim['attemptId']}/reconcile",
                json={
                    "fencingToken": claim["fencingToken"],
                    "processStopped": True,
                    "cleanupStatus": "NOT_REQUIRED",
                    "stoppedAt": "2026-11-12T00:00:00Z",
                },
                headers=auth(credential),
            )
        ).status_code == 200
        async with db.sessions.begin() as session:
            row = await session.get(Attempt, claim["attemptId"])
            row.finished_at = now() - timedelta(days=40)
    account = (
        await c.post(
            f"/api/v1/workspaces/{ws}/service-accounts", json={"name": "Offline pagination"}
        )
    ).json()["data"]
    token = (
        await c.post(
            f"/api/v1/workspaces/{ws}/service-accounts/{account['id']}/tokens",
            json={"purpose": "MAINTENANCE", "operations": ["artifacts/expire"]},
        )
    ).json()["data"]["token"]

    async def expire(cursor=None):
        kwargs = {
            "json": {"workspaceId": ws, "limit": 1, **({"cursor": cursor} if cursor else {})},
            "headers": {"Authorization": "Bearer " + token, "Idempotency-Key": str(uuid4())},
        }
        response = await c.post("/internal/v1/maintenance/artifacts/expire", **kwargs)
        assert response.status_code == 200, response.text
        replay = await c.post("/internal/v1/maintenance/artifacts/expire", **kwargs)
        assert replay.json()["data"] == response.json()["data"]
        return response.json()["data"]

    page = await expire()
    for index in range(2 + int(with_online)):
        assert page["processedCount"] == 1, page
        more = index < 1 + int(with_online)
        assert page["hasMore"] is more, page
        if more:
            assert page.get("nextCursor"), page
            page = await expire(page["nextCursor"])


async def test_archived_workspace_blocks_import_replay_and_new_upload(approved_metadata, site):
    from hashlib import sha256

    c, db, ws, payload, bundle = await imported_fixture(approved_metadata, site)
    c.headers["Idempotency-Key"] = str(uuid4())
    route = f"/api/v1/workspaces/{ws}/result-imports"
    assert (await c.post(route, json=payload)).status_code == 201
    assert (await c.delete(f"/api/v1/workspaces/{ws}")).status_code == 200
    replay = await c.post(route, json=payload)
    assert replay.status_code == 409 and replay.json()["code"] == "WORKSPACE_ARCHIVED", replay.text
    response = await c.post(
        f"/api/v1/workspaces/{ws}/result-import-uploads",
        json={
            "bundleId": bundle["id"],
            "localRunId": str(uuid4()),
            "attemptId": payload["attempts"][0]["attemptId"],
            "file": {
                "path": "archived.bin",
                "sha256": sha256(b"x").hexdigest(),
                "sizeBytes": 1,
                "kind": "DOWNLOAD",
                "sensitivity": "CREDENTIAL_RESTRICTED",
            },
        },
    )
    assert response.status_code == 409 and response.json()["code"] == "WORKSPACE_ARCHIVED", (
        response.text
    )
