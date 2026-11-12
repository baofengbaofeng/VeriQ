"""Actual compiler archives, current managed Runtime, chunk upload and publication."""

import asyncio
import pytest
import json
from hashlib import sha256
from pathlib import Path
from uuid import uuid4
from test_auth import setup, login
from test_workspace import workspace
from test_lease_mysql import device, auth, claim_body


async def upload(c, credential, claim, content, filename, kind="SOURCE"):
    proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
    base = f"/internal/v1/attempts/{claim['attemptId']}"
    digest = sha256(content).hexdigest()
    response = await c.post(
        base + "/artifact-uploads",
        json={
            **proof,
            "kind": kind,
            "filename": filename,
            "contentType": "application/octet-stream",
            "sha256": digest,
            "sizeBytes": len(content),
            "sensitivity": "REDACTED",
        },
        headers=auth(credential),
    )
    assert response.status_code == 201, response.text
    target = response.json()["data"]["uploadUrl"]
    headers = {
        **auth(credential),
        "Content-Type": "application/octet-stream",
        "X-VeriQ-Lease-Token": claim["leaseToken"],
        "X-VeriQ-Fencing-Token": str(claim["fencingToken"]),
    }
    for offset in range(0, max(1, len(content)), 1024 * 1024):
        r = await c.put(
            target + f"?offset={offset}",
            content=content[offset : offset + 1024 * 1024],
            headers=headers,
        )
        assert r.status_code == 200, r.text
    return digest


@pytest.mark.parametrize(
    "kind",
    [
        "ELEMENT_CATALOG",
        "CASE",
        "CASE_WITH_MISSING_ARTIFACT_EVENT",
        "CASE_COMPILER_ERROR",
        "CASE_CANCEL_RETRY",
    ],
)
async def test_managed_real_compilation_finishes_once_and_can_publish(site, tmp_path, kind):
    from veriq_server.db import Job, Artifact
    from veriq_server.contracts import canonical_bytes

    cancel_retry = kind == "CASE_CANCEL_RETRY"
    compiler_error = kind == "CASE_COMPILER_ERROR"
    missing_artifact_event = kind == "CASE_WITH_MISSING_ARTIFACT_EVENT"
    if missing_artifact_event or compiler_error or cancel_retry:
        kind = "CASE"
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    if kind == "CASE":
        from test_runs_mysql import published

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
        document = {
            "schemaVersion": "1.0",
            "caseKey": "read",
            "title": "Read",
            "kind": "READ",
            "roleKey": "reader",
            "catalogVersionId": catalog,
            "steps": [{"id": "open", "action": "goto", "path": "/"}],
        }
    else:
        document = {
            "schemaVersion": "1.0",
            "elements": [{"key": "save", "locator": {"by": "testId", "value": "save"}}],
        }
    if compiler_error:
        document["steps"] = [{"id": "missing", "action": "click", "target": "not_in_catalog"}]
    resource = await c.post(
        f"/api/v1/workspaces/{ws}/resources",
        json={
            "kind": kind,
            "key": "target",
            "name": "Target",
            "content": {"kind": kind, "document": document},
        },
    )
    assert resource.status_code == 201, resource.text
    base = f"/api/v1/workspaces/{ws}/resources/{resource.json()['data']['id']}"
    preview = (await c.get(base + "/validation-preview")).json()["data"]
    queued = await c.post(
        base + "/validate",
        json={"revision": preview["revision"], "sourceHash": preview["sourceHash"]},
    )
    assert queued.status_code == 202, queued.text
    job_id = queued.json()["data"]["id"]
    async with db.sessions() as session:
        job = await session.get(Job, job_id)
        source = (await session.get(Artifact, (ws, job.snapshot_hash))).content
    source_path = tmp_path / "snapshot.json"
    source_path.write_bytes(source)
    output = tmp_path / "compiled"
    process = await asyncio.create_subprocess_exec(
        "node",
        "--import",
        "../contracts/node_modules/tsx/dist/loader.mjs",
        "tests/queue-fixture.ts",
        str(source_path),
        str(output),
        *(["--expect-failure"] if compiler_error else []),
        cwd="packages/runner-sdk",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    assert process.returncode == 0, stderr.decode()
    records = json.loads((output / "index.json").read_text())
    config = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
    Path(config["approved_engine_inventory_path"]).write_bytes(
        canonical_bytes(records["inventory"])
    )
    # Registration does not confer compiler trust.
    assert (
        await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))
    ).status_code == 204
    consent = await c.put(
        f"/api/v1/workspaces/{ws}/runtimes/{d['runnerId']}/grants",
        json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
    )
    assert consent.status_code == 200, consent.text
    trust = await c.put(
        f"/api/v1/workspaces/{ws}/runtimes/{d['runnerId']}/trust",
        json={"trustStatus": "MANAGED", "allowCredentialDelivery": False},
    )
    assert trust.status_code == 200, trust.text
    claimed = await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))
    assert claimed.status_code == 200, claimed.text
    claim = claimed.json()["data"]
    proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
    endpoint = f"/internal/v1/attempts/{claim['attemptId']}"
    assert (await c.post(endpoint + "/activate", json=proof, headers=auth(d))).status_code == 200
    if compiler_error:
        await exercise_compiler_failure(c, db, ws, d, claim, records, output, base, preview, job_id)
        return
    for file in records["files"]:
        await upload(c, d, claim, (output / file["sha256"]).read_bytes(), file["path"])
    bundle_hash = await upload(
        c, d, claim, (output / "bundle.json").read_bytes(), "bundle.json", "MANIFEST"
    )
    completion = {
        "schemaVersion": "1.0",
        "attemptId": claim["attemptId"],
        "jobManifestSha256": claim["snapshotSha256"],
        "kind": "VALIDATE",
        "businessOutcome": "PASSED",
        "cleanupStatus": "NOT_REQUIRED",
        "evidence": [],
        "requiredEvidence": [],
        "processStopped": True,
        "compiledBundleSha256": bundle_hash,
        "engineInventorySha256": records["inventoryHash"],
    }
    if kind == "ELEMENT_CATALOG":
        # Actual non-CASE compiler emits two different metadata paths with identical
        # canonical empty cases. Both upload/event identities must survive CAS sharing.
        from sqlalchemy import select
        from veriq_server.db import AttemptUpload

        shared = [
            f
            for f in records["files"]
            if f["path"] in {"metadata/expected-plans.json", "metadata/report-display.json"}
        ]
        assert len(shared) == 2 and shared[0]["sha256"] == shared[1]["sha256"]
        async with db.sessions() as session:
            rows = list(
                (
                    await session.execute(
                        select(AttemptUpload).where(AttemptUpload.attempt_id == claim["attemptId"])
                    )
                ).scalars()
            )
        events = []
        for index, file in enumerate(shared):
            entry = {**file, "sensitivity": "REDACTED"}
            row = next(r for r in rows if r.metadata_json["filename"] == file["path"])
            completion["evidence"].append(entry)
            events.append(
                {
                    "schemaVersion": "1.0",
                    "attemptId": claim["attemptId"],
                    "sequence": index + 1,
                    "timestamp": "2026-11-11T12:00:00Z",
                    "type": "ARTIFACT_CREATED",
                    "payload": {"artifactId": row.id, "kind": "SOURCE", "file": entry},
                }
            )
        posted = await c.post(
            endpoint + "/events", json={**proof, "events": events}, headers=auth(d)
        )
        assert posted.status_code == 200, posted.text
        assert (
            await c.post(endpoint + "/events", json={**proof, "events": events}, headers=auth(d))
        ).status_code == 200
        changed = json.loads(json.dumps(events))
        changed[0]["payload"]["file"]["path"] = "replayed-path.json"
        rejected = await c.post(
            endpoint + "/events", json={**proof, "events": changed}, headers=auth(d)
        )
        assert rejected.status_code == 409 and rejected.json()["code"] == "EVENT_CONFLICT"
        forged = {
            **completion,
            "evidence": [
                {**completion["evidence"][0], "path": "wrong-path.json"},
                completion["evidence"][1],
            ],
        }
        forged_hash = await upload(
            c, d, claim, canonical_bytes(forged), "wrong-evidence.json", "MANIFEST"
        )
        rejected = await c.post(
            endpoint + "/finish",
            json={
                **proof,
                "kind": "VALIDATE",
                "outcome": "PASSED",
                "manifestSha256": forged_hash,
                "lastSequence": 2,
                "cleanupStatus": "NOT_REQUIRED",
            },
            headers=auth(d),
        )
        assert rejected.status_code == 409 and rejected.json()["code"] == "INVALID_EVIDENCE"
    manifest_hash = await upload(
        c, d, claim, canonical_bytes(completion), "completion.json", "MANIFEST"
    )
    finish = {
        **proof,
        "kind": "VALIDATE",
        "outcome": "PASSED",
        "manifestSha256": manifest_hash,
        "lastSequence": 2 if kind == "ELEMENT_CATALOG" else 0,
        "cleanupStatus": "NOT_REQUIRED",
    }
    downgraded = await c.put(
        f"/api/v1/workspaces/{ws}/runtimes/{d['runnerId']}/trust",
        json={"trustStatus": "USER_REGISTERED", "allowCredentialDelivery": False},
    )
    assert downgraded.status_code == 200
    denied = await c.post(endpoint + "/finish", json=finish, headers=auth(d))
    assert denied.status_code == 403 and denied.json()["code"] == "UNTRUSTED_COMPILER"
    assert (
        await c.put(
            f"/api/v1/workspaces/{ws}/runtimes/{d['runnerId']}/trust",
            json={"trustStatus": "MANAGED", "allowCredentialDelivery": False},
        )
    ).status_code == 200
    stale = await c.post(
        endpoint + "/finish",
        json={**finish, "fencingToken": proof["fencingToken"] + 1},
        headers=auth(d),
    )
    assert stale.status_code == 409 and stale.json()["code"] == "STALE_FENCE"
    # Even a MANAGED caller cannot attach unrelated source bytes to a valid descriptor.
    wrong_source = canonical_bytes({"unrelated": True})
    wrong_source_hash = await upload(c, d, claim, wrong_source, "wrong-source.json")
    wrong_bundle = json.loads((output / "bundle.json").read_bytes())
    wrong_bundle["files"] = [
        {**file, "sha256": wrong_source_hash, "sizeBytes": len(wrong_source)}
        if file["path"] == "source/asset-snapshot.json"
        else file
        for file in wrong_bundle["files"]
    ]
    wrong_bundle_hash = await upload(
        c, d, claim, canonical_bytes(wrong_bundle), "wrong-bundle.json", "MANIFEST"
    )
    wrong_completion_hash = await upload(
        c,
        d,
        claim,
        canonical_bytes({**completion, "compiledBundleSha256": wrong_bundle_hash}),
        "wrong-completion.json",
        "MANIFEST",
    )
    rejected = await c.post(
        endpoint + "/finish",
        json={**finish, "manifestSha256": wrong_completion_hash},
        headers=auth(d),
    )
    assert rejected.status_code == 409 and rejected.json()["code"] == "INVALID_COMPILED_SOURCE", (
        rejected.text
    )
    result = await c.post(endpoint + "/finish", json=finish, headers=auth(d))
    assert result.status_code == 200, result.text
    assert result.json()["data"]["outcome"] == "PASSED"
    from sqlalchemy import text
    from veriq_server.db import Attempt

    async with db.sessions() as session:
        finished_at = (await session.get(Attempt, claim["attemptId"])).finished_at
        assert finished_at is not None

    async with db.sessions.begin() as session:
        await session.execute(
            text("UPDATE veriq_attempts SET lease_expires_at=UTC_TIMESTAMP(6)-INTERVAL 1 SECOND")
        )
    assert (await c.post(endpoint + "/finish", json=finish, headers=auth(d))).json()[
        "data"
    ] == result.json()["data"]
    async with db.sessions() as session:
        assert (await session.get(Attempt, claim["attemptId"])).finished_at == finished_at
    different = await c.post(
        endpoint + "/finish", json={**finish, "manifestSha256": "0" * 64}, headers=auth(d)
    )
    assert different.status_code == 409 and different.json()["code"] == "FINISH_CONFLICT"
    receipt = await c.get(f"/api/v1/workspaces/{ws}/jobs/{job_id}/validation-receipt")
    assert receipt.status_code == 200, receipt.text
    published = await c.post(
        base + "/publish",
        json={"revision": preview["revision"], "validationReceiptId": receipt.json()["data"]["id"]},
    )
    assert published.status_code == 201, published.text
    if kind == "CASE":
        await exercise_test_protocol(
            c,
            db,
            ws,
            d,
            published.json()["data"]["id"],
            output,
            missing_artifact_event,
            cancel_retry,
        )


async def exercise_test_protocol(
    c, db, ws, d, case_version, output, missing_artifact_event=False, cancel_retry=False
):
    """Server protocol integration; actual browser execution remains T10."""
    from test_runs_mysql import environment
    from veriq_server.contracts import canonical_bytes
    from veriq_server.db import AttemptUpload
    from sqlalchemy import select

    env = await environment(c, db, ws)
    bundle = json.loads((output / "bundle.json").read_text())
    expected = next(f for f in bundle["files"] if f["path"] == "metadata/expected-plans.json")
    plan = json.loads((output / expected["sha256"]).read_text())["cases"][0]
    create = {
        "caseVersionIds": [case_version],
        "environmentVersionId": env,
        "roleKeys": ["reader"],
        "browsers": ["chromium"],
        "runtimeIds": [d["runnerId"]],
        "maxRetries": 1,
    }
    response = await c.post(
        f"/api/v1/workspaces/{ws}/runs", json=create, headers={"Idempotency-Key": str(uuid4())}
    )
    assert response.status_code == 202, response.text
    run_id = response.json()["data"]["id"]
    for index, status in enumerate(["PASSED"] if missing_artifact_event else ["FAILED", "PASSED"]):
        claim_response = await c.post(
            "/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d)
        )
        assert claim_response.status_code == 200, claim_response.text
        claim = claim_response.json()["data"]
        endpoint = f"/internal/v1/attempts/{claim['attemptId']}"
        proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
        headers = {
            **auth(d),
            "X-VeriQ-Lease-Token": proof["leaseToken"],
            "X-VeriQ-Fencing-Token": str(proof["fencingToken"]),
        }
        manifest = (await c.get(claim["snapshotUrl"], headers=headers)).json()
        snapshot_response = await c.get(
            f"/internal/v1/workspaces/{ws}/attempts/{claim['attemptId']}/content/{manifest['executionSnapshotSha256']}",
            headers=headers,
        )
        assert snapshot_response.status_code == 200, snapshot_response.text
        snapshot = snapshot_response.json()
        assert snapshot["attemptNo"] == index + 1
        secret = snapshot["secretVersions"][0]
        credential_request = {"secretRef": secret["secretRef"], "versionId": secret["versionId"]}
        denied = await c.post(
            endpoint + "/credentials/resolve", json=credential_request, headers=headers
        )
        assert denied.status_code == 409 and denied.json()["code"] == "ACTIVATION_REQUIRED"
        assert (
            await c.post(endpoint + "/activate", json=proof, headers=auth(d))
        ).status_code == 200
        if index == 0:
            assert (
                await c.post(
                    endpoint + "/credentials/resolve", json=credential_request, headers=headers
                )
            ).status_code == 403
            allowed = await c.put(
                f"/api/v1/workspaces/{ws}/runtimes/{d['runnerId']}/credential-delivery",
                json={"allowCredentialDelivery": True},
            )
            assert allowed.status_code == 200, allowed.text
        resolved = await c.post(
            endpoint + "/credentials/resolve", json=credential_request, headers=headers
        )
        assert resolved.status_code == 200, resolved.text
        assert resolved.json()["data"]["value"] == {"token": "synthetic-business-secret"}
        # Protocol fixture bytes are explicitly not a claim of a browser/Trace run.
        evidence = b"T09 opaque evidence protocol fixture"
        evidence_hash = await upload(c, d, claim, evidence, "trace.zip", "TRACE")
        async with db.sessions() as session:
            row = (
                await session.execute(
                    select(AttemptUpload).where(
                        AttemptUpload.attempt_id == claim["attemptId"],
                        AttemptUpload.sha256 == evidence_hash,
                    )
                )
            ).scalar_one()
            artifact_id = row.id
        entry = {
            "path": "trace.zip",
            "sha256": evidence_hash,
            "sizeBytes": len(evidence),
            "sensitivity": "REDACTED",
        }
        raw = [
            ("ATTEMPT_STARTED", {"engineVersion": "0.1.0", "sourceHash": bundle["sourceHash"]}, {}),
            ("STEP_STARTED", {}, {"stepId": plan["steps"][0]["id"]}),
            (
                "STEP_FINISHED",
                {"status": "PASSED" if cancel_retry and index == 0 else status, "durationMs": 1},
                {"stepId": plan["steps"][0]["id"]},
            ),
            ("CLEANUP_RESULT", {"cleanupStatus": "NOT_REQUIRED"}, {}),
            ("ARTIFACT_CREATED", {"artifactId": artifact_id, "file": entry, "kind": "TRACE"}, {}),
            ("ATTEMPT_FINISHED", {"outcome": status, "cleanupStatus": "NOT_REQUIRED"}, {}),
        ]
        if missing_artifact_event:
            raw = [entry for entry in raw if entry[0] != "ARTIFACT_CREATED"]
        events = [
            {
                "schemaVersion": "1.0",
                "attemptId": claim["attemptId"],
                "sequence": seq,
                "timestamp": "2026-11-11T12:00:00Z",
                "type": typ,
                "payload": payload,
                **extra,
            }
            for seq, (typ, payload, extra) in enumerate(raw, 1)
        ]
        accepted = await c.post(
            endpoint + "/events", json={**proof, "events": events}, headers=auth(d)
        )
        assert accepted.status_code == 200, accepted.text
        assert (
            await c.post(endpoint + "/events", json={**proof, "events": events}, headers=auth(d))
        ).json()["data"]["acceptedThrough"] == len(events)
        completion = {
            "schemaVersion": "1.0",
            "attemptId": claim["attemptId"],
            "jobManifestSha256": claim["snapshotSha256"],
            "kind": "TEST",
            "caseVersionId": case_version,
            "expectedPlansSha256": expected["sha256"],
            # Explicit protocol fixture; physical observations are covered by test_agent_mysql.
            "retrySafety": "READ_ONLY_OBSERVED",
            "businessOutcome": status,
            "cleanupStatus": "NOT_REQUIRED",
            "evidence": [entry],
            "requiredEvidence": [evidence_hash],
            "processStopped": True,
        }
        digest = await upload(
            c, d, claim, canonical_bytes(completion), "completion.json", "MANIFEST"
        )
        result = await c.post(
            endpoint + "/finish",
            json={
                **proof,
                "kind": "TEST",
                "outcome": "PASSED",
                "manifestSha256": digest,
                "lastSequence": len(events),
                "cleanupStatus": "NOT_REQUIRED",
            },
            headers=auth(d),
        )
        assert result.status_code == 200, result.text
        assert result.json()["data"]["outcome"] == (
            "INCOMPLETE" if missing_artifact_event else status
        )
        if cancel_retry and index == 0:
            from veriq_server.db import Attempt, Job, CaseExecution, Run

            cancelled = await c.post(
                f"/api/v1/workspaces/{ws}/runs/{run_id}/cancel",
                json={"reason": "Cancel pending retry"},
            )
            assert cancelled.status_code == 200, cancelled.text
            body = cancelled.json()["data"]
            assert body["state"] == "FINISHED" and body["outcome"] == "FAILED", body
            assert body["reasonCode"] == "USER_CANCELLED"
            async with db.sessions() as session:
                attempt = await session.get(Attempt, claim["attemptId"])
                job = await session.get(Job, attempt.job_id)
                case = await session.get(CaseExecution, job.case_execution_id)
                run = await session.get(Run, run_id)
                assert (
                    attempt.phase == "FINISHED"
                    and attempt.outcome == "FAILED"
                    and attempt.capacity_state == "RELEASED"
                )
                assert job.state == case.state == run.state == "FINISHED"
                assert job.outcome == case.outcome == run.outcome == "FAILED"
                assert (
                    len(
                        (await session.execute(select(Attempt).where(Attempt.job_id == job.id)))
                        .scalars()
                        .all()
                    )
                    == 1
                )
            assert (
                await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))
            ).status_code == 204
            return
    run = (await c.get(f"/api/v1/workspaces/{ws}/runs/{run_id}")).json()["data"]
    assert run["state"] == "FINISHED" and run["outcome"] == (
        "INCOMPLETE" if missing_artifact_event else "UNSTABLE"
    )


async def exercise_compiler_failure(c, db, ws, d, claim, records, output, base, preview, job_id):
    from veriq_server.contracts import canonical_bytes
    from veriq_server.db import AttemptUpload, ValidationReceipt
    from sqlalchemy import select

    from test_runs_mysql import environment

    environment_id = await environment(c, db, ws)
    pending = await c.post(
        f"/api/v1/workspaces/{ws}/runs",
        json={
            "draftValidationJobId": job_id,
            "environmentVersionId": environment_id,
            "roleKeys": ["reader"],
            "browsers": ["chromium"],
            "runtimeIds": [d["runnerId"]],
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert pending.status_code == 202, pending.text
    pending_run = pending.json()["data"]["id"]
    assert records["failed"] and not (output / "bundle.json").exists()
    diagnostic = (output / "failure.log").read_bytes()
    assert b"ASSET_VALIDATION_FAILED" in diagnostic and b"UNKNOWN_ELEMENT" in diagnostic
    log_hash = await upload(c, d, claim, diagnostic, "compiler.log", "LOG")
    async with db.sessions() as session:
        record = (
            await session.execute(
                select(AttemptUpload).where(
                    AttemptUpload.attempt_id == claim["attemptId"], AttemptUpload.sha256 == log_hash
                )
            )
        ).scalar_one()
        upload_id = record.id
    proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
    endpoint = f"/internal/v1/attempts/{claim['attemptId']}"
    entry = {
        "path": "compiler.log",
        "sha256": log_hash,
        "sizeBytes": len(diagnostic),
        "sensitivity": "REDACTED",
    }
    event = {
        "schemaVersion": "1.0",
        "attemptId": claim["attemptId"],
        "sequence": 1,
        "timestamp": "2026-11-11T12:00:00Z",
        "type": "ARTIFACT_CREATED",
        "payload": {"artifactId": upload_id, "file": entry, "kind": "LOG"},
    }
    assert (
        await c.post(endpoint + "/events", json={**proof, "events": [event]}, headers=auth(d))
    ).status_code == 200
    completion = {
        "schemaVersion": "1.0",
        "attemptId": claim["attemptId"],
        "jobManifestSha256": claim["snapshotSha256"],
        "kind": "VALIDATE",
        "businessOutcome": "ERROR",
        "cleanupStatus": "NOT_REQUIRED",
        "evidence": [entry],
        "requiredEvidence": [log_hash],
        "processStopped": True,
        "engineInventorySha256": records["inventoryHash"],
        "failureCode": "ASSET_VALIDATION_FAILED",
    }
    manifest_hash = await upload(
        c, d, claim, canonical_bytes(completion), "completion.json", "MANIFEST"
    )
    finish = {
        **proof,
        "kind": "VALIDATE",
        "outcome": "PASSED",
        "manifestSha256": manifest_hash,
        "lastSequence": 1,
        "cleanupStatus": "NOT_REQUIRED",
    }
    result = await c.post(endpoint + "/finish", json=finish, headers=auth(d))
    assert result.status_code == 200 and result.json()["data"]["outcome"] == "ERROR", result.text
    assert (await c.post(endpoint + "/finish", json=finish, headers=auth(d))).json()[
        "data"
    ] == result.json()["data"]
    async with db.sessions() as session:
        assert not (
            await session.execute(
                select(ValidationReceipt).where(ValidationReceipt.job_id == job_id)
            )
        ).first()
    rejected = await c.post(
        base + "/publish",
        json={"revision": preview["revision"], "validationReceiptId": str(uuid4())},
    )
    assert rejected.status_code == 409, rejected.text
    assert (
        await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))
    ).status_code == 204
    ended = (await c.get(f"/api/v1/workspaces/{ws}/runs/{pending_run}")).json()["data"]
    assert ended["state"] == "FINISHED" and ended["outcome"] == "ERROR"
