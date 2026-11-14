from uuid import uuid4
import json
from sqlalchemy import select, text
from test_auth import setup, login
from test_workspace import workspace
from test_runs_mysql import published, environment
from test_lease_mysql import device, auth, claim_body
from test_completion_mysql import upload
from veriq_server.contracts import canonical_bytes
from veriq_server.db import Job, Attempt, CapacityPool, Artifact


async def test_cleanup_uses_same_queue_scoped_actor_and_waits_for_unknown_process_stop(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    base = f"/api/v1/workspaces/{ws}"
    assert (
        await c.put(
            base + f"/runtimes/{d['runnerId']}/grants",
            json={"workspaceId": ws, "sharedWithWorkspace": True, "userIds": []},
        )
    ).status_code == 200
    env = await environment(c, db, ws, True)
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
    fixture = await published(
        c,
        db,
        ws,
        "fixture",
        "FIXTURE",
        {
            "schemaVersion": "1.0",
            "prepare": {"method": "POST", "path": "/fixtures"},
            "query": {"method": "GET", "path": "/fixtures"},
            "cleanup": {"method": "DELETE", "path": "/fixtures"},
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object"},
            "ttlSeconds": 3600,
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
            "fixtureVersionId": fixture,
            "steps": [{"id": "open", "action": "goto", "path": "/"}],
        },
    )
    run = await c.post(
        base + "/runs",
        json={
            "caseVersionIds": [case],
            "environmentVersionId": env,
            "roleKeys": ["reader"],
            "browsers": ["chromium"],
            "runtimeIds": [d["runnerId"]],
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert run.status_code == 202, run.text
    claim = (await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))).json()[
        "data"
    ]
    proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
    origin = f"/internal/v1/attempts/{claim['attemptId']}"
    assert (await c.post(origin + "/activate", json=proof, headers=auth(d))).status_code == 200
    account = (await c.post(base + "/service-accounts", json={"name": "Compensation"})).json()[
        "data"
    ]
    token = (
        await c.post(
            base + f"/service-accounts/{account['id']}/tokens",
            json={
                "purpose": "MAINTENANCE",
                "operations": ["expired-leases/reap", "fixture-cleanups/reconcile"],
            },
        )
    ).json()["data"]
    async with db.sessions.begin() as session:
        await session.execute(
            text(
                "UPDATE veriq_attempts SET lease_expires_at=UTC_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE id=:id"
            ),
            {"id": claim["attemptId"]},
        )

    async def maintenance(operation):
        response = await c.post(
            "/internal/v1/maintenance/" + operation,
            json={"workspaceId": ws, "limit": 100},
            headers={"Authorization": "Bearer " + token["token"], "Idempotency-Key": str(uuid4())},
        )
        assert response.status_code == 200, response.text
        return response.json()["data"]

    assert (await maintenance("expired-leases/reap"))["processedCount"] == 1
    assert (await maintenance("fixture-cleanups/reconcile"))["processedCount"] == 1
    assert (await maintenance("fixture-cleanups/reconcile"))["processedCount"] == 0
    assert (
        await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))
    ).status_code == 204
    async with db.sessions() as session:
        cleanup = (await session.execute(select(Job).where(Job.kind == "CLEANUP"))).scalar_one()
        assert cleanup.origin_attempt_id == claim["attemptId"]
        subject = json.loads((await session.get(Artifact, (ws, cleanup.snapshot_hash))).content)
        original = await session.get(Attempt, claim["attemptId"])
        frozen = json.loads((await session.get(Artifact, (ws, original.snapshot_hash))).content)
        assert subject["caseExecutionId"] == frozen["caseExecutionId"]
        assert subject["attemptNo"] == frozen["attemptNo"]
        assert subject["namespace"] == frozen["namespace"]
        assert subject["secretVersions"] == [
            {
                "secretRef": "fixture",
                "versionId": frozen["environment"]["fixtureIdentity"]["secretVersionId"],
            }
        ]

        assert (await session.get(Attempt, claim["attemptId"])).capacity_state == "QUARANTINED"
    stopped = await c.post(
        origin + "/reconcile",
        json={
            "fencingToken": claim["fencingToken"],
            "processStopped": True,
            "cleanupStatus": "PENDING",
            "stoppedAt": "2026-11-11T12:00:00Z",
        },
        headers=auth(d),
    )
    assert stopped.status_code == 200, stopped.text
    claim = (await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))).json()[
        "data"
    ]
    assert claim["jobKind"] == "CLEANUP"
    proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
    endpoint = f"/internal/v1/attempts/{claim['attemptId']}"
    headers = {
        **auth(d),
        "X-VeriQ-Lease-Token": proof["leaseToken"],
        "X-VeriQ-Fencing-Token": str(proof["fencingToken"]),
    }
    manifest = (await c.get(claim["snapshotUrl"], headers=headers)).json()
    snapshot = (
        await c.get(
            f"/internal/v1/workspaces/{ws}/attempts/{claim['attemptId']}/content/{manifest['snapshotSha256']}",
            headers=headers,
        )
    ).json()
    assert "synthetic-fixture-secret" not in json.dumps(snapshot)
    assert (
        snapshot["namespace"] == manifest["namespace"] and snapshot["fixtureVersionId"] == fixture
    )
    assert (await c.post(endpoint + "/activate", json=proof, headers=auth(d))).status_code == 200
    assert "roles" not in snapshot["environment"]
    assert (
        await c.put(
            base + f"/runtimes/{d['runnerId']}/trust",
            json={"trustStatus": "MANAGED", "allowCredentialDelivery": True},
        )
    ).status_code == 200
    business = frozen["environment"]["roles"][0]
    forbidden = await c.post(
        endpoint + "/credentials/resolve",
        headers=headers,
        json={"secretRef": business["secretRef"], "versionId": business["secretVersionId"]},
    )
    assert forbidden.status_code == 403
    fixture_identity = snapshot["environment"]["fixtureIdentity"]
    allowed = await c.post(
        endpoint + "/credentials/resolve",
        headers=headers,
        json={
            "secretRef": fixture_identity["secretRef"],
            "versionId": fixture_identity["secretVersionId"],
        },
    )
    assert allowed.status_code == 200
    raw = [
        ("ATTEMPT_STARTED", {"engineVersion": "0.1.0", "sourceHash": manifest["snapshotSha256"]}),
        ("CLEANUP_RESULT", {"cleanupStatus": "SUCCEEDED"}),
        ("ATTEMPT_FINISHED", {"outcome": "PASSED", "cleanupStatus": "SUCCEEDED"}),
    ]
    events = [
        {
            "schemaVersion": "1.0",
            "attemptId": claim["attemptId"],
            "sequence": seq,
            "timestamp": "2026-11-11T12:00:00Z",
            "type": kind,
            "payload": payload,
        }
        for seq, (kind, payload) in enumerate(raw, 1)
    ]
    assert (
        await c.post(endpoint + "/events", json={**proof, "events": events}, headers=auth(d))
    ).status_code == 200
    completion = {
        "schemaVersion": "1.0",
        "attemptId": claim["attemptId"],
        "jobManifestSha256": claim["snapshotSha256"],
        "kind": "CLEANUP",
        "fixtureVersionId": fixture,
        "namespace": manifest["namespace"],
        "businessOutcome": "PASSED",
        "cleanupStatus": "SUCCEEDED",
        "evidence": [],
        "requiredEvidence": [],
        "processStopped": True,
        "processStopScope": "CONTROLLED_WORKER_BROWSER",
    }
    digest = await upload(c, d, claim, canonical_bytes(completion), "completion.json", "MANIFEST")
    from veriq_server.db import Runtime

    async with db.sessions.begin() as session:
        runtime = await session.get(Runtime, d["runnerId"])
        runtime.capabilities = {**runtime.capabilities, "os": "darwin"}
    finish = {
        **proof,
        "kind": "CLEANUP",
        "outcome": "PASSED",
        "manifestSha256": digest,
        "lastSequence": len(events),
        "cleanupStatus": "SUCCEEDED",
    }
    for scope in [None, "FULL_DESCENDANT_TREE"]:
        wrong = {k: v for k, v in completion.items() if k != "processStopScope"}
        if scope is not None:
            wrong["processStopScope"] = scope
        wrong_hash = await upload(
            c, d, claim, canonical_bytes(wrong), "wrong-scope.json", "MANIFEST"
        )
        denied = await c.post(
            endpoint + "/finish", json={**finish, "manifestSha256": wrong_hash}, headers=auth(d)
        )
        assert (
            denied.status_code == 409 and denied.json()["code"] == "PROCESS_STOP_SCOPE_INVALID"
        ), denied.text
        async with db.sessions() as session:
            attempt = await session.get(Attempt, claim["attemptId"])
            assert attempt.capacity_state == "HELD" and attempt.finish_receipt is None
            assert (await session.get(CapacityPool, "00/global/cleanup")).used == 1
    result = await c.post(endpoint + "/finish", json=finish, headers=auth(d))
    assert result.status_code == 200, result.text
    assert result.json()["data"]["outcome"] == "PASSED"
    async with db.sessions() as session:
        attempt = await session.get(Attempt, claim["attemptId"])
        assert attempt.facts["processStopped"] is True
        assert attempt.facts["processStopScope"] == "CONTROLLED_WORKER_BROWSER"
        assert (await session.get(CapacityPool, "00/global/browser")).used == 0
        assert (await session.get(CapacityPool, "00/global/cleanup")).used == 0
