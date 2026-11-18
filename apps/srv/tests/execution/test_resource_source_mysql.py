import asyncio
import json
import os
import shutil
import tempfile
from hashlib import sha256
from pathlib import Path

import httpx
from test_auth import setup, login
from test_workspace import workspace, new_member, client
from test_lease_mysql import device
from test_agent_mysql import agent_once, business
from veriq_server.db import Artifact


async def test_published_source_exact_bytes_integrity_scope_and_current_membership(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    other_ws = await workspace(c, "other")
    created = await c.post(
        f"/api/v1/workspaces/{ws}/resources",
        json={
            "kind": "ELEMENT_CATALOG",
            "key": "catalog",
            "name": "Catalog",
            "content": {
                "kind": "ELEMENT_CATALOG",
                "document": {
                    "schemaVersion": "1.0",
                    "elements": [{"key": "name", "locator": {"by": "veriqId", "value": "name"}}],
                },
            },
        },
    )
    assert created.status_code == 201
    rid = created.json()["data"]["id"]
    base = f"/api/v1/workspaces/{ws}/resources/{rid}"
    preview = (await c.get(base + "/validation-preview")).json()["data"]
    queued = await c.post(
        base + "/validate",
        json={"revision": preview["revision"], "sourceHash": preview["sourceHash"]},
    )
    assert queued.status_code == 202
    job_id = queued.json()["data"]["id"]
    assert (
        await c.get(f"/api/v1/workspaces/{ws}/jobs/{job_id}/validation-receipt")
    ).status_code == 409
    # Real locked release packaging is test-only; controller never imports Node tooling.
    process = await asyncio.create_subprocess_exec(
        "node",
        "apps/web/tests/prepare-editor-agent.mjs",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    assert process.returncode == 0, stderr.decode()
    release = Path(".superpowers/cache/t11/release").resolve()
    env = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
    approved = Path(env["approved_engine_inventory_path"])
    previous = approved.read_bytes() if approved.exists() else None
    profile = Path(tempfile.mkdtemp(prefix="vq11-py-", dir="/tmp"))
    try:
        approved.write_bytes((release / "inventory.json").read_bytes())
        credential = await device(c, ws)
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
        (profile / "device.json").write_text(
            json.dumps({"server": "http://127.0.0.1:18889", **credential})
        )
        os.chmod(profile / "device.json", 0o600)
        await agent_once(profile, release)
        status = (await c.get(f"/api/v1/workspaces/{ws}/jobs/{job_id}")).json()["data"]
        assert status["state"] == "FINISHED" and status["outcome"] == "PASSED"
        receipt = (await c.get(f"/api/v1/workspaces/{ws}/jobs/{job_id}/validation-receipt")).json()[
            "data"
        ]
        published = await c.post(
            base + "/publish",
            json={"revision": preview["revision"], "validationReceiptId": receipt["id"]},
        )
        assert published.status_code == 201
        vid = published.json()["data"]["id"]
        source = base + f"/versions/{vid}/compiled-source"
        metadata = (await c.get(source)).json()["data"]
        assert metadata["descriptorSha256"] == receipt["compiledBundleSha256"]
        assert metadata["files"] and all(f["path"].endswith(".ts") for f in metadata["files"])
        file = metadata["files"][0]
        async with httpx.AsyncClient(
            base_url=str(c.base_url), cookies=c.cookies, headers=c.headers
        ) as raw:
            response = await raw.get(source, params={"path": file["path"]})
            assert response.status_code == 200
            actual = response.content
            assert sha256(actual).hexdigest() == file["sha256"] and len(actual) == file["sizeBytes"]
            assert response.headers["Content-Type"].startswith("text/plain")
            assert response.headers["X-Content-Type-Options"] == "nosniff"
            assert response.headers["Cache-Control"] == "private, no-store"
            assert "sandbox" in response.headers["Content-Security-Policy"]
            for path in [
                "package.json",
                "../../etc/passwd",
                file["sha256"],
                "trace.zip",
                "source/asset-snapshot.json",
            ]:
                assert (await raw.get(source, params={"path": path})).status_code == 404
            foreign = source.replace(f"/workspaces/{ws}/", f"/workspaces/{other_ws}/")
            assert (await raw.get(foreign, params={"path": file["path"]})).status_code == 404
            second = await c.post(
                f"/api/v1/workspaces/{ws}/resources",
                json={
                    "kind": "DATASET",
                    "key": "data",
                    "name": "Data",
                    "content": {
                        "kind": "DATASET",
                        "document": {
                            "schemaVersion": "1.0",
                            "columns": {"name": "string"},
                            "rows": [{"key": "one", "values": {"name": "literal"}}],
                        },
                    },
                },
            )
            assert second.status_code == 201
            mismatched = source.replace(
                f"/resources/{rid}/", f"/resources/{second.json()['data']['id']}/"
            )
            assert (await raw.get(mismatched, params={"path": file["path"]})).status_code == 404
            # Corrupt actual retained bytes, then length. The original descriptor and receipt stay untouched.
            async with db.sessions.begin() as session:
                artifact = await session.get(Artifact, (ws, file["sha256"]))
                artifact.content = actual + b"tampered"
            corrupt = await raw.get(source, params={"path": file["path"]})
            assert corrupt.status_code == 409 and corrupt.json()["code"] == "INVALID_ARTIFACT"
            async with db.sessions.begin() as session:
                artifact = await session.get(Artifact, (ws, file["sha256"]))
                artifact.content = actual
                artifact.size_bytes = len(actual) + 1
            assert (await raw.get(source, params={"path": file["path"]})).status_code == 409
            async with db.sessions.begin() as session:
                artifact = await session.get(Artifact, (ws, file["sha256"]))
                artifact.size_bytes = len(actual)
            assert (await raw.get(source, params={"path": file["path"]})).content == actual
        uid = await new_member(c, ws, "source-viewer@example.com", "VIEWER")
        async with client(c, "source-viewer@example.com") as viewer:
            assert (await viewer.get(source, params={"path": file["path"]})).status_code == 200
            assert (await viewer.get(foreign, params={"path": file["path"]})).status_code == 403
            assert (await c.delete(f"/api/v1/workspaces/{ws}/members/{uid}")).status_code == 200
            assert (await viewer.get(source, params={"path": file["path"]})).status_code == 403
        # Failed actual compilation projects a stable safe code and cannot create a receipt.
        bad = await c.post(
            f"/api/v1/workspaces/{ws}/resources",
            json={
                "kind": "CASE",
                "key": "bad",
                "name": "Bad",
                "content": {
                    "kind": "CASE",
                    "document": {
                        "schemaVersion": "1.0",
                        "caseKey": "bad",
                        "title": "Bad",
                        "kind": "READ",
                        "roleKey": "reader",
                        "catalogVersionId": vid,
                        "steps": [{"id": "missing", "action": "click", "target": "missing"}],
                    },
                },
            },
        )
        assert bad.status_code == 201
        bad_base = f"/api/v1/workspaces/{ws}/resources/{bad.json()['data']['id']}"
        candidate = (await c.get(bad_base + "/validation-preview")).json()["data"]
        failed = await c.post(
            bad_base + "/validate",
            json={"revision": candidate["revision"], "sourceHash": candidate["sourceHash"]},
        )
        assert failed.status_code == 202
        await agent_once(profile, release)
        failed_job = f"/api/v1/workspaces/{ws}/jobs/{failed.json()['data']['id']}"
        failure = (await c.get(failed_job)).json()["data"]
        assert failure["outcome"] == "ERROR" and failure["errorCode"] == "UNKNOWN_ELEMENT"
        assert (
            "issues" not in failure
            and (await c.get(failed_job + "/validation-receipt")).status_code == 409
        )
    finally:
        # agent_once waits for the foreground Agent and native guardian before returning.
        shutil.rmtree(profile)
        if previous is None:
            approved.unlink(missing_ok=True)
        else:
            approved.write_bytes(previous)


async def test_static_fetch_is_scoped_to_attempt_fence_and_version(site):
    from uuid import uuid4
    from test_lease_mysql import auth, claim_body, queued_browser_jobs
    from veriq_server.auth.authorization import WorkspaceScope
    from veriq_server.contracts import canonical_bytes, asset_source_hash
    from veriq_server.db import Job, CaseExecution
    from veriq_server.repositories.resource import ResourceRepository

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    foreign = await device(c, await workspace(c, "external"))
    (jid,) = await queued_browser_jobs(c, db, ws, 1)
    vid, rid = str(uuid4()), str(uuid4())
    document = {
        "schemaVersion": "1.0",
        "columns": {"n": "string"},
        "rows": [{"key": "k", "values": {"n": "synthetic-正文"}}],
    }
    asset = {
        "resourceId": rid,
        "versionId": vid,
        "kind": "DATASET",
        "document": document,
        "sha256": sha256(canonical_bytes({"kind": "DATASET", "document": document})).hexdigest(),
    }
    async with db.sessions.begin() as session:
        repo = ResourceRepository(session, WorkspaceScope(ws))
        job = await session.get(Job, jid)
        case = await session.get(CaseExecution, job.case_execution_id)
        case_content = {
            "kind": "CASE",
            "document": {
                "schemaVersion": "1.0",
                "caseKey": "case",
                "title": "Case",
                "kind": "READ",
                "roleKey": "reader",
                "catalogVersionId": str(uuid4()),
                "steps": [{"id": "published", "action": "goto", "path": "/"}],
            },
        }
        case_asset = {
            **case_content,
            "versionId": case.case_version_id,
            "resourceId": str(uuid4()),
            "sha256": sha256(canonical_bytes(case_content)).hexdigest(),
        }
        source = {
            "schemaVersion": "1.0",
            "workspaceId": ws,
            "engineVersion": "0.1.0",
            "entryCaseVersionIds": [case.case_version_id],
            "assets": [asset, case_asset],
        }
        source["sourceHash"] = asset_source_hash(source)
        case.source_snapshot_hash = await repo.store(canonical_bytes(source))
        snapshot = {
            "schemaVersion": "2.0",
            "workspaceId": ws,
            "caseExecutionId": case.id,
            "assetSourceHash": source["sourceHash"],
            "datasetVersionId": vid,
            "selectedRow": {
                "versionId": vid,
                "rowKey": "k",
                "rowSha256": sha256(canonical_bytes(document["rows"][0])).hexdigest(),
            },
        }
        display = {
            "schemaVersion": "1.0",
            "cases": [
                {
                    "caseVersionId": case.case_version_id,
                    "caseKey": "case",
                    "title": "Case",
                    "steps": [
                        {
                            "id": "v_" + "a" * 64,
                            "sourceId": "published",
                            "sourcePath": "/assets/0",
                            "action": "goto",
                            "order": 0,
                            "observers": [],
                            "assertions": [],
                        }
                    ],
                }
            ],
        }
        from veriq_server.contracts import validate_schema

        assert not validate_schema("ReportDisplayV1", display)
        file = await repo.store(canonical_bytes(display))
        descriptor = {
            "files": [
                {"path": "metadata/report-display.json", "sha256": file},
                {"path": "source/asset-snapshot.json", "sha256": case.source_snapshot_hash},
            ]
        }
        job.manifest_hash = await repo.store(
            canonical_bytes(
                {
                    "compiledBundleSha256": await repo.store(canonical_bytes(descriptor)),
                    "caseVersionId": case.case_version_id,
                    "engineVersion": "0.1.0",
                }
            )
        )
        job.snapshot_hash = await repo.store(canonical_bytes(snapshot))
        job.required_capabilities = {**job.required_capabilities, "connectedDatasets": "2.0"}
    request = claim_body(d)
    request["capabilities"] = {**request["capabilities"], "connectedDatasets": "2.0"}
    claim = (await c.post("/internal/v1/jobs/claim", json=request, headers=auth(d))).json()["data"]
    path = f"/internal/v1/attempts/{claim['attemptId']}/datasets/static"
    headers = {
        **auth(d),
        "X-VeriQ-Lease-Token": claim["leaseToken"],
        "X-VeriQ-Fencing-Token": str(claim["fencingToken"]),
    }
    selection = {"selection": "DATASET", "versionId": vid}
    proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
    assert (
        await c.post(path.rsplit("/datasets", 1)[0] + "/activate", json=proof, headers=auth(d))
    ).status_code == 200
    base = path.rsplit("/datasets", 1)[0]
    blocked = await c.post(
        base + "/artifact-uploads",
        json={
            **proof,
            "kind": "TRACE",
            "filename": "trace.zip",
            "contentType": "application/octet-stream",
            "sizeBytes": 12,
            "sha256": "1" * 64,
            "sensitivity": "CREDENTIAL_RESTRICTED",
        },
        headers=auth(d),
    )
    assert blocked.status_code == 409 and blocked.json()["code"] == "DATASET_EVIDENCE_FORBIDDEN"
    body = b'{"echo":"synthetic-private-body"}'
    metadata = {
        **proof,
        "kind": "MANIFEST",
        "filename": "completion.json",
        "contentType": "application/octet-stream",
        "sizeBytes": len(body),
        "sha256": sha256(body).hexdigest(),
        "sensitivity": "REDACTED",
    }
    blocked = await c.post(
        base + "/artifact-uploads",
        json={**metadata, "contentType": "synthetic-private-body"},
        headers=auth(d),
    )
    assert blocked.status_code == 409 and blocked.json()["code"] == "DATASET_EVIDENCE_FORBIDDEN"
    allowed = await c.post(base + "/artifact-uploads", json=metadata, headers=auth(d))
    assert allowed.status_code == 201
    upload = allowed.json()["data"]
    blocked = await c.put(
        upload["uploadUrl"] + "?offset=0",
        content=body,
        headers={**headers, "Content-Type": "application/octet-stream"},
    )
    assert blocked.status_code == 409 and blocked.json()["code"] == "DATASET_EVIDENCE_FORBIDDEN"
    from veriq_server.db import AttemptUpload

    async with db.sessions() as session:
        retained = await session.get(AttemptUpload, upload["artifactId"])
        assert not retained.complete and retained.content == b""
    unsafe = {
        "schemaVersion": "1.0",
        "sequence": 1,
        "attemptId": claim["attemptId"],
        "timestamp": claim["serverTime"],
        "type": "ASSERTION_RESULT",
        "stepId": "example",
        "assertionId": "echo",
        "payload": {
            "status": "FAILED",
            "severity": "BLOCK",
            "expectedSource": "published",
            "expected": None,
            "actual": {"present": True, "value": "synthetic-private-body"},
            "durationMs": 1,
        },
    }
    blocked = await c.post(base + "/events", json={**proof, "events": [unsafe]}, headers=auth(d))
    assert blocked.status_code == 409 and blocked.json()["code"] == "DATASET_EVIDENCE_FORBIDDEN"
    from veriq_server.db import AttemptEvent

    location = {k: v for k, v in unsafe.items() if k not in {"payload", "stepId", "assertionId"}}
    private = "private_echo_marker"
    for fact in [
        {"type": "LOG", "payload": {"level": "ERROR", "message": private}},
        {
            **unsafe,
            "payload": {
                **unsafe["payload"],
                "actual": {"present": False},
                "expectedSource": private,
            },
        },
        {"type": "STEP_STARTED", "stepId": private, "payload": {}},
        {"type": "STEP_STARTED", "stepId": "v_" + "a" * 64, "payload": {}},
        {"type": "CLEANUP_RESULT", "payload": {"cleanupStatus": "FAILED", "errorCode": private}},
    ]:
        blocked = await c.post(
            base + "/events", json={**proof, "events": [{**location, **fact}]}, headers=auth(d)
        )
        assert blocked.status_code == 409 and blocked.json()["code"] == "DATASET_EVIDENCE_FORBIDDEN"
    async with db.sessions() as session:
        assert await session.get(AttemptEvent, (claim["attemptId"], 1)) is None
    response = await c.post(path, json=selection, headers=headers)
    assert response.status_code == 200, response.text
    assert response.content == canonical_bytes(document)
    row = await c.post(
        path, json={"selection": "ROW", "versionId": vid, "rowKey": "k"}, headers=headers
    )
    assert row.content == canonical_bytes(document["rows"][0])
    for args in [
        {**selection, "versionId": str(uuid4())},
        {"selection": "VALIDATION_SOURCE"},
        {"selection": "ROW", "versionId": vid, "rowKey": "different"},
    ]:
        assert (await c.post(path, json=args, headers=headers)).status_code == 403
    assert (
        await c.post(path, json=selection, headers={**headers, **auth(foreign)})
    ).status_code == 403
    stale = {**headers, "X-VeriQ-Fencing-Token": str(claim["fencingToken"] + 1)}
    assert (await c.post(path, json=selection, headers=stale)).status_code == 409
    await c.post(f"/api/v1/workspaces/{ws}/runtimes/{d['runnerId']}/revoke", json={})
    assert (await c.post(path, json=selection, headers=headers)).status_code == 401


async def test_legacy_published_dataset_revalidation_uses_frozen_original(site, business):
    from uuid import uuid4
    from sqlalchemy import select
    from test_publish import create, publish
    from test_runs_mysql import environment, published
    from test_lease_mysql import auth, claim_body
    from veriq_server.db import Job, ResourceVersion, ValidationReceipt, Runtime
    from veriq_server.contracts import canonical_bytes

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    runtime_url = f"/api/v1/workspaces/{ws}/runtimes/{d['runnerId']}"
    assert (
        await c.put(
            runtime_url + "/grants",
            json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
        )
    ).status_code == 200
    assert (
        await c.put(
            runtime_url + "/trust", json={"trustStatus": "MANAGED", "allowCredentialDelivery": True}
        )
    ).status_code == 200
    origin, facts = business
    env = await environment(c, db, ws, origin=origin, identity_path="/identity", token="CAS")
    catalog = await published(
        c,
        db,
        ws,
        "elems",
        "ELEMENT_CATALOG",
        {
            "schemaVersion": "1.0",
            "elements": [{"key": "e", "locator": {"by": "veriqId", "value": "e"}}],
        },
    )
    marker = "TASK-SCOPED-PRIVATE-ECHO-41873"
    payload = marker + "正文😀" * 8000
    assert len(payload.encode()) > 65536
    expected_row = {
        "key": "first",
        "values": {"label": payload, "lookup": "first", "path": marker},
    }
    dataset = {
        "kind": "DATASET",
        "document": {
            "schemaVersion": "1.0",
            "columns": {"label": "string", "lookup": "string", "path": "string"},
            "rows": [json.loads(json.dumps(expected_row))],
        },
    }
    data_path = await create(c, ws, "rows", dataset)
    dataset_version, _, _ = await publish(c, db, data_path)
    document = {
        "schemaVersion": "1.0",
        "caseKey": "frozen",
        "title": "Frozen original",
        "kind": "READ",
        "roleKey": "reader",
        "catalogVersionId": catalog,
        "datasetVersionId": dataset_version["id"],
        "datasetBindings": {"labels": dataset_version["id"]},
        "steps": [
            {
                "id": "go",
                "action": "goto",
                "path": "/verified?echo={{data.path}}",
                "afterAssertions": [
                    {
                        "id": "echo",
                        "type": "url",
                        "source": "page",
                        "operator": "contains",
                        "severity": "BLOCK",
                        "expectedSource": "Published CAST route prefix",
                        "expected": "/verified",
                    },
                    {
                        "id": "url",
                        "type": "url",
                        "source": "page",
                        "operator": "contains",
                        "severity": "BLOCK",
                        "expectedSource": "Published expected route",
                        "datasetExpected": {
                            "op": "field",
                            "alias": "labels",
                            "key": "{{data.lookup}}",
                            "field": "path",
                        },
                    },
                ],
            }
        ],
    }
    case_path = await create(c, ws, "legacy", {"kind": "CASE", "document": document})
    editor = await new_member(c, ws, "previous-publisher@example.com", "ADMIN")
    await new_member(c, ws, "current-executor@example.com", "EXECUTOR")
    async with client(c, "previous-publisher@example.com") as publisher:
        version, original_receipt, original = await publish(publisher, db, case_path)
    assert (await c.delete(f"/api/v1/workspaces/{ws}/members/{editor}")).status_code == 200
    updated = {
        **document,
        "title": "Newer draft",
        "steps": [{"id": "bad", "action": "click", "target": "absent"}],
    }
    assert (
        await c.put(
            case_path + "/draft",
            json={"revision": 1, "content": {"kind": "CASE", "document": updated}},
        )
    ).status_code == 200
    dataset["document"]["rows"][0]["values"]["label"] = "CHANGED"
    assert (
        await c.put(data_path + "/draft", json={"revision": 1, "content": dataset})
    ).status_code == 200

    process = await asyncio.create_subprocess_exec(
        "node",
        "apps/web/tests/prepare-editor-agent.mjs",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    assert process.returncode == 0, stderr.decode()
    release = Path(".superpowers/cache/t11/release").resolve()
    config = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
    approved = Path(config["approved_engine_inventory_path"])
    previous = approved.read_bytes() if approved.exists() else None
    profile = Path(tempfile.mkdtemp(prefix="vq5-", dir="/tmp"))
    try:
        approved.write_bytes((release / "inventory.json").read_bytes())
        generated_url = case_path + f"/versions/{version['id']}/compiled-source"
        assert (await c.get(generated_url)).status_code == 409
        selection = {
            "caseVersionIds": [version["id"]],
            "environmentVersionId": env,
            "roleKeys": ["reader"],
            "browsers": ["chromium"],
            "runtimeIds": [d["runnerId"]],
        }
        async with db.sessions.begin() as session:
            from veriq_server.repositories.resource import ResourceRepository
            from veriq_server.auth.authorization import WorkspaceScope

            repo = ResourceRepository(session, WorkspaceScope(ws))
            frozen_receipt = await session.get(ValidationReceipt, original_receipt)
            original_bundle = frozen_receipt.compiled_bundle_sha256
            descriptor = json.loads((await repo.artifact(original_bundle)).content)
            member = next(
                f for f in descriptor["files"] if f["path"] == "source/asset-snapshot.json"
            )
            wrong = next(f for f in descriptor["files"] if f["path"] == "entry.ts")
            member.update(sha256=wrong["sha256"], sizeBytes=wrong["sizeBytes"])
            frozen_receipt.compiled_bundle_sha256 = await repo.store(canonical_bytes(descriptor))
        async with client(c, "current-executor@example.com") as executor:
            endpoint = f"/api/v1/workspaces/{ws}/runs"
            mismatch = await executor.post(
                endpoint, headers={"Idempotency-Key": str(uuid4())}, json=selection
            )
            assert (
                mismatch.status_code == 409
                and mismatch.json()["code"] == "COMPILED_PROVENANCE_REQUIRED"
            )
            assert not list(profile.iterdir())
            async with db.sessions.begin() as session:
                frozen_receipt = await session.get(ValidationReceipt, original_receipt)
                frozen_receipt.compiled_bundle_sha256 = original_bundle
            rsp = await executor.post(
                endpoint, headers={"Idempotency-Key": str(uuid4())}, json=selection
            )
        assert rsp.status_code == 202, rsp.text
        run_id = rsp.json()["data"]["id"]
        async with db.sessions.begin() as session:
            job = (await session.execute(select(Job).where(Job.run_id == run_id))).scalar_one()
            migration_id = job.required_capabilities["validationJobId"]
            test_id = job.id
            old_receipt = await session.get(ValidationReceipt, original_receipt)
            old_bundle = old_receipt.compiled_bundle_sha256
            runtime = await session.get(Runtime, d["runnerId"])
            runtime.capabilities = {**runtime.capabilities, "connectedDatasets": "2.0"}
        assert (
            await c.post("/internal/v1/jobs/claim", headers=auth(d), json=claim_body(d))
        ).status_code == 204
        claim_request = claim_body(d)
        claim_request["capabilities"] = {
            **claim_request["capabilities"],
            "connectedDatasets": "2.0",
        }
        claim = (
            await c.post("/internal/v1/jobs/claim", headers=auth(d), json=claim_request)
        ).json()["data"]
        assert claim["jobId"] == migration_id and claim["jobKind"] == "VALIDATE"
        proof_headers = {
            **auth(d),
            "X-VeriQ-Lease-Token": claim["leaseToken"],
            "X-VeriQ-Fencing-Token": str(claim["fencingToken"]),
        }
        private = f"/internal/v1/attempts/{claim['attemptId']}/datasets/static"
        response = await c.post(
            private, json={"selection": "VALIDATION_SOURCE"}, headers=proof_headers
        )
        assert response.content == canonical_bytes(original)
        assert response.headers["cache-control"] == "no-store"
        assert (
            await c.post(
                private,
                json={"selection": "DATASET", "versionId": version["id"]},
                headers=proof_headers,
            )
        ).status_code in (403, 409)
        original_digest = sha256(canonical_bytes(original)).hexdigest()
        content_base = f"/internal/v1/workspaces/{ws}/attempts/{claim['attemptId']}/content/"
        assert (
            await c.get(content_base + original_digest, headers=proof_headers)
        ).status_code == 404
        (profile / "agent").mkdir(mode=0o700)
        (profile / "agent/claim-request.json").write_text(json.dumps(claim_request))
        (profile / "device.json").write_text(json.dumps({"server": "http://127.0.0.1:18889", **d}))
        os.chmod(profile / "device.json", 0o600)

        # 已有历史报告库与联网 Agent 共用档案，真实 CLI 建库后记录其逻辑内容，覆盖 WAL/SQLite 数据的检查。
        history = await asyncio.create_subprocess_exec(
            "node",
            "--import",
            "tsx",
            "src/cli.ts",
            "--config-dir",
            str(profile),
            "results",
            "history",
            "--workspace",
            ws,
            cwd="apps/runtime",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        output, errors = await history.communicate()
        assert history.returncode == 0 and json.loads(output) == [], errors.decode()
        import sqlite3

        history_path = profile / "offline/veriq.sqlite"
        with sqlite3.connect(history_path.as_uri() + "?mode=ro", uri=True) as historical:
            history_before = list(historical.iterdump())

        scratch_parent = profile / "scratch"
        scratch_parent.mkdir(mode=0o700)

        async def launch(*args):
            return await asyncio.create_subprocess_exec(
                "node",
                "--import",
                "tsx",
                "tests/support/run-connected-attempt.ts",
                str(profile),
                str(release),
                "/usr/bin/chromium",
                *args,
                env={**os.environ, "TMPDIR": str(scratch_parent)},
                cwd="apps/runtime",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

        async def finish(child):
            _, err = await child.communicate()
            assert child.returncode == 0, err.decode()

        await finish(await launch())
        async with db.sessions() as session:
            migrated = await session.get(Job, migration_id)
            assert migrated.outcome == "PASSED", (migrated.state, migrated.outcome)
            new_receipt = (
                await session.execute(
                    select(ValidationReceipt).where(ValidationReceipt.job_id == migration_id)
                )
            ).scalar_one()
            assert (
                new_receipt.source_hash == original["sourceHash"]
                and new_receipt.compiled_bundle_sha256 != old_bundle
            )
            assert (
                await session.get(ResourceVersion, version["id"])
            ).receipt_id == original_receipt
            assert (
                await session.get(ValidationReceipt, original_receipt)
            ).compiled_bundle_sha256 == old_bundle
        view = await c.get(generated_url)
        assert view.status_code == 200, view.text
        assert view.json()["data"]["descriptorSha256"] == new_receipt.compiled_bundle_sha256
        await finish(await launch())
        async with db.sessions() as session:
            test_job = await session.get(Job, test_id)
            assert (test_job.state, test_job.outcome) == ("FINISHED", "PASSED"), (
                test_job.state,
                test_job.wait_reason,
                test_job.outcome,
            )
        from veriq_server.db import Attempt, AttemptEvent, AttemptUpload

        async with db.sessions() as session:
            attempt = (
                await session.execute(select(Attempt).where(Attempt.job_id == test_id))
            ).scalar_one()
            events = list(
                (
                    await session.scalars(
                        select(AttemptEvent.document).where(AttemptEvent.attempt_id == attempt.id)
                    )
                ).all()
            )
            uploads = list(
                (
                    await session.scalars(
                        select(AttemptUpload.metadata_json).where(
                            AttemptUpload.attempt_id == attempt.id
                        )
                    )
                ).all()
            )
            assert marker not in json.dumps(events)
            assert {entry["kind"] for entry in uploads} == {"MANIFEST"}
            assertions = [event for event in events if event["type"] == "ASSERTION_RESULT"]
            assert len(assertions) == 2 and all(
                event["payload"]["status"] == "PASSED" for event in assertions
            )
            assert all(event["payload"]["actual"] == {"present": False} for event in assertions)
            assert assertions[0]["payload"]["expectedSource"] == "CASE"
            assert all("Published CAST" not in json.dumps(event) for event in assertions)
            assert dataset_version["id"] in assertions[-1]["payload"]["expectedSource"]
        assert facts["echo"] == marker
        # 相同执行主体随后再次运行同一发布版本，应复用已经成功的独立验证，不能改写回执或重复创建验证任务。
        async with client(c, "current-executor@example.com") as executor:
            rerun = await executor.post(
                endpoint, headers={"Idempotency-Key": str(uuid4())}, json=selection
            )
            assert rerun.status_code == 202, rerun.text
        async with db.sessions() as session:
            queued = (
                await session.execute(select(Job).where(Job.run_id == rerun.json()["data"]["id"]))
            ).scalar_one()
            assert queued.required_capabilities["validationJobId"] == migration_id
        workdirs = list((profile / "agent/work").iterdir())
        assert len(workdirs) == 2
        for directory in workdirs:
            assert (directory / "completion.json").exists()
        for file in profile.rglob("*"):
            if file.is_file() and not file.is_symlink():
                assert marker.encode() not in file.read_bytes(), file
        testdir = next(
            directory for directory in workdirs if (directory / "execution.json").exists()
        )
        selected = json.loads((testdir / "execution.json").read_bytes())["selectedRow"]
        assert selected["rowSha256"] == sha256(canonical_bytes(expected_row)).hexdigest()

        def inspect_files(directory):
            # 实际运行中的浏览器会原子替换单个临时文件，只忽略检查时已经消失的名字，不跟随浏览器进程创建的链接。
            for item in directory.rglob("*"):
                try:
                    if item.is_file() and not item.is_symlink():
                        content = item.read_bytes()
                        for encoding in ("utf-8", "utf-16le"):
                            assert marker.encode(encoding) not in content, item
                except FileNotFoundError:
                    continue

        # 目标网页已接收冻结值之后分别观察真实业务失败、心跳取消和宿主 SIGKILL；后者由新进程取得原生停止证明。
        facts["echo_mode"] = "fail"
        await finish(await launch())
        async with db.sessions() as session:
            failed = (
                await session.scalars(select(Attempt).where(Attempt.job_id == queued.id))
            ).one()
            assert failed.outcome == "FAILED", failed.facts
            failed_facts = list(
                (
                    await session.scalars(
                        select(AttemptEvent.document).where(AttemptEvent.attempt_id == failed.id)
                    )
                ).all()
            )
            assert marker not in json.dumps(failed_facts)
            assert any(
                e["type"] == "ASSERTION_RESULT"
                and e["payload"]["status"] == "FAILED"
                and e["payload"]["errorCode"] == "ASSERTION_FAILED"
                for e in failed_facts
            )
        for end in ["cancel", "crash"]:
            facts["echo_mode"] = "hold"
            facts["echo_observed"].clear()
            facts["echo_release"].clear()
            async with client(c, "current-executor@example.com") as executor:
                new = await executor.post(
                    endpoint, headers={"Idempotency-Key": str(uuid4())}, json=selection
                )
            assert new.status_code == 202, new.text
            rid = new.json()["data"]["id"]
            agent = await launch()
            try:
                await asyncio.wait_for(facts["echo_observed"].wait(), 60)
                async with db.sessions() as session:
                    active_job = (await session.scalars(select(Job).where(Job.run_id == rid))).one()
                    active_id = active_job.active_attempt_id
                active_journal = json.loads(
                    (profile / "agent/attempts" / (active_id + ".json")).read_bytes()
                )
                scratch = scratch_parent / active_journal["allocation"]["temporaryName"]
                assert scratch.is_dir()
                await asyncio.to_thread(inspect_files, scratch)
                await asyncio.to_thread(inspect_files, profile)
                if end == "cancel":
                    # 使用有效设备、当前围栏和同一真实编译断言，仅替换出处。两种伪造均须在写入前拒绝。
                    async with db.sessions() as session:
                        active = await session.get(Attempt, active_id)
                        sequence = active.last_sequence + 1
                    confirmed = assertions[-1]
                    for name in [marker, assertions[0]["payload"]["expectedSource"]]:
                        forged = {
                            **confirmed,
                            "attemptId": active_id,
                            "sequence": sequence,
                            "payload": {**confirmed["payload"], "expectedSource": name},
                        }
                        proof = {
                            key: active_journal["claim"][key]
                            for key in ["leaseToken", "fencingToken"]
                        }
                        rejected = await c.post(
                            f"/internal/v1/attempts/{active_id}/events",
                            json={**proof, "events": [forged]},
                            headers=auth(json.loads((profile / "device.json").read_bytes())),
                        )
                        assert rejected.status_code == 409
                        assert rejected.json()["code"] == "DATASET_EVIDENCE_FORBIDDEN"
                    response = await c.post(
                        endpoint + "/" + rid + "/cancel", json={"reason": "Privacy test"}
                    )
                    assert response.status_code == 200, response.text
                    await asyncio.wait_for(finish(agent), 50)
                else:
                    agent.kill()
                    await agent.wait()
                    assert agent.returncode == -9
                    await finish(await launch("recover"))
            finally:
                facts["echo_release"].set()
                if agent.returncode is None:
                    agent.kill()
                    await agent.wait()
            async with db.sessions() as session:
                job = (await session.scalars(select(Job).where(Job.run_id == rid))).one()
                attempt = (
                    await session.scalars(select(Attempt).where(Attempt.job_id == job.id))
                ).one()
                if end == "cancel":
                    assert attempt.outcome == "CANCELLED", attempt.facts
                retained = list(
                    (
                        await session.scalars(
                            select(AttemptEvent.document).where(
                                AttemptEvent.attempt_id == attempt.id
                            )
                        )
                    ).all()
                )
                assert marker not in json.dumps(retained)
            journal = json.loads((profile / "agent/attempts" / (attempt.id + ".json")).read_bytes())
            assert journal["stop"]["processStopScope"] == "FULL_DESCENDANT_TREE"
            tombstone = scratch_parent / journal["allocation"]["temporaryName"]
            modules = Path(journal["work"]) / "node_modules"
            await asyncio.to_thread(inspect_files, tombstone)
            assert (tombstone / ".veriq-retirement-inventory").is_file()
            assert (modules / ".veriq-retired").is_file()
            assert journal["dataCleanup"] == "OWNERSHIP_UNCONFIRMED"
        for file in profile.rglob("*"):
            if file.is_file() and not file.is_symlink():
                assert marker.encode() not in file.read_bytes(), file
        with sqlite3.connect(history_path.as_uri() + "?mode=ro", uri=True) as historical:
            history_after = list(historical.iterdump())
            assert history_before == history_after
            assert marker not in "\n".join(history_after)
    finally:
        shutil.rmtree(profile)
        if previous is None:
            approved.unlink(missing_ok=True)
        else:
            approved.write_bytes(previous)


async def test_mvp_exposes_connected_runtime_only(site):
    c, _db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    base = f"/api/v1/workspaces/{ws}"
    for path in ("bundles", "result-imports", "result-import-uploads"):
        response = await c.post(base + "/" + path, json={})
        assert response.status_code == (405 if path == "bundles" else 404), (
            path,
            response.status_code,
        )
    assert (await c.get(base + "/runtimes")).status_code == 200


def test_protected_occurrences_expand_only_frozen_case_and_resolve_parameter_provenance():
    from veriq_server.services.connected_datasets import protected_occurrences

    wire = lambda p: "v_" + sha256(p.encode("utf8")).hexdigest()
    tree = {
        "assets": [
            {"versionId": "dataset", "kind": "DATASET", "document": {"fields": {"value": {}}}},
            {
                "versionId": "case",
                "kind": "CASE",
                "document": {
                    "steps": [
                        {
                            "action": "callFlow",
                            "versionId": "flow",
                            "parameters": {"value": "literal", "fromMatrix": "{{data.value}}"},
                        }
                    ]
                },
            },
            {
                "versionId": "flow",
                "kind": "FLOW",
                "document": {
                    "steps": [
                        {
                            "action": "goto",
                            "observers": [{"id": "realObserver"}],
                            "afterAssertions": [
                                {
                                    "type": "template",
                                    "versionId": "template",
                                    "severity": "WARN",
                                    "parameters": {"carried": "{{data.fromMatrix}}"},
                                }
                            ],
                        }
                    ]
                },
            },
            {
                "versionId": "template",
                "kind": "ASSERTION_TEMPLATE",
                "document": {
                    "assertions": [
                        {"type": "url", "severity": "BLOCK", "expected": "{{data.value}}"},
                        {"type": "url", "severity": "BLOCK", "expected": "{{data.carried}}"},
                        {"type": "url", "severity": "BLOCK", "datasetExpected": {"alias": "named"}},
                        {
                            "type": "responseSchema",
                            "severity": "BLOCK",
                            "expected": {"const": "{{data.carried}}"},
                        },
                    ]
                },
            },
            {"versionId": "other", "kind": "CASE", "document": {"steps": [{"action": "goto"}]}},
        ]
    }
    steps, sources = protected_occurrences(
        tree, "case", {"datasetVersionId": "dataset", "datasetBindings": {"named": "named-version"}}
    )
    root = "/assets/1/document/steps/0"
    nested = root + "/flow/0"
    assert steps == {wire(root): set(), wire(nested): {"realObserver"}}
    assert [
        sources[wire(nested), wire(nested + f"/afterAssertions/0/template/{i}")] for i in range(4)
    ] == [
        ("CASE", "WARN"),
        ("DATASET:dataset", "WARN"),
        ("DATASET:named-version", "WARN"),
        ("CASE", "WARN"),
    ]
