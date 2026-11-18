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
        source = {
            "schemaVersion": "1.0",
            "workspaceId": ws,
            "engineVersion": "0.1.0",
            "entryCaseVersionIds": [case.case_version_id],
            "assets": [asset],
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
    origin, _ = business
    env = await environment(c, db, ws, origin=origin, identity_path="/identity")
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
    marker = "PRIVATE-synthetic-冻结正文"
    payload = marker + "正文😀" * 8000
    assert len(payload.encode()) > 65536
    expected_row = {
        "key": "first",
        "values": {"label": payload, "lookup": "first", "path": "/verified"},
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
                "path": "/verified",
                "afterAssertions": [
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
                    }
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

        async def once():
            child = await asyncio.create_subprocess_exec(
                "node",
                "--import",
                "tsx",
                "tests/support/run-connected-attempt.ts",
                str(profile),
                str(release),
                "/usr/bin/chromium",
                cwd="apps/runtime",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, err = await child.communicate()
            assert child.returncode == 0, err.decode()

        await once()
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
        await once()
        async with db.sessions() as session:
            test_job = await session.get(Job, test_id)
            assert (test_job.state, test_job.outcome) == ("FINISHED", "PASSED"), (
                test_job.state,
                test_job.wait_reason,
                test_job.outcome,
            )
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
    finally:
        shutil.rmtree(profile)
        if previous is None:
            approved.unlink(missing_ok=True)
        else:
            approved.write_bytes(previous)
