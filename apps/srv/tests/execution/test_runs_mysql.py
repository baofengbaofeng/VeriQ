
import json
from uuid import uuid4
from sqlalchemy import select
from test_auth import setup, login
from test_workspace import workspace
from test_publish import create, publish
from test_lease_mysql import device
from veriq_server.db import Job, Artifact, CaseExecution


async def published(c, db, ws, key, kind, document):
    path = await create(c, ws, key, {"kind": kind, "document": document})
    version, _, _ = await publish(c, db, path)
    return version["id"]


async def environment(c, db, ws, with_fixture=False):
    base = f"/api/v1/workspaces/{ws}"
    secret = (
        await c.post(
            base + "/credentials",
            json={
                "secretRef": "business",
                "value": {"token": "synthetic-business-secret"},
                "allowedIdentityIds": ["reader"],
            },
        )
    ).json()["data"]
    adapter = (
        await c.post(
            base + "/auth-adapters",
            json={
                "configuration": {
                    "kind": "HTTP_BEARER",
                    "identityPath": "/me",
                    "identityPointer": "/id",
                }
            },
        )
    ).json()["data"]
    doc = {
        "schemaVersion": "1.0",
        "baseURL": "https://business.test",
        "apiBaseURL": "https://business.test",
        "allowedOrigins": ["https://business.test"],
        "locale": "en-US",
        "timezone": "UTC",
        "roles": [
            {
                "roleKey": "reader",
                "authAdapterVersionId": adapter["versionId"],
                "secretRef": "business",
                "secretVersionId": secret["versionId"],
                "allowedIdentityIds": ["reader"],
            }
        ],
    }
    if with_fixture:
        fixture_secret = (
            await c.post(
                base + "/credentials",
                json={
                    "secretRef": "fixture",
                    "value": {"token": "synthetic-fixture-secret"},
                    "allowedIdentityIds": ["fixture-service"],
                },
            )
        ).json()["data"]
        doc["fixtureBaseURL"] = "https://business.test"
        doc["fixtureIdentity"] = {
            "authAdapterVersionId": adapter["versionId"],
            "secretRef": "fixture",
            "secretVersionId": fixture_secret["versionId"],
            "allowedIdentityIds": ["fixture-service"],
        }
    return await published(c, db, ws, "env", "ENVIRONMENT", doc)


async def test_suite_matrix_preserves_dataset_row_provenance_and_frozen_variables(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    env = await environment(c, db, ws)
    catalog = await published(
        c,
        db,
        ws,
        "catalog",
        "ELEMENT_CATALOG",
        {
            "schemaVersion": "1.0",
            "elements": [{"key": "name", "locator": {"by": "testId", "value": "name"}}],
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
            "caseKey": "case",
            "title": "Frozen",
            "kind": "READ",
            "roleKey": "reader",
            "catalogVersionId": catalog,
            "initialVariables": {"initial": "string"},
            "steps": [
                {"id": "fill", "action": "fill", "target": "name", "value": "{{vars.initial}}"}
            ],
        },
    )
    datasets = [
        await published(
            c,
            db,
            ws,
            "dataset" + v,
            "DATASET",
            {
                "schemaVersion": "1.0",
                "columns": {"value": "string"},
                "rows": [{"key": "same", "values": {"value": v}}],
            },
        )
        for v in ["A", "B"]
    ]
    suite = await published(
        c,
        db,
        ws,
        "suite",
        "SUITE",
        {
            "schemaVersion": "1.0",
            "cases": [{"versionId": case, "datasetVersionId": dataset} for dataset in datasets],
        },
    )
    data = {
        "suiteVersionId": suite,
        "environmentVersionId": env,
        "roleKeys": ["reader"],
        "browsers": ["chromium"],
        "runtimeIds": [d["runnerId"]],
    }
    endpoint = f"/api/v1/workspaces/{ws}/runs"
    bad = await c.post(endpoint, json=data, headers={"Idempotency-Key": str(uuid4())})
    assert bad.status_code == 422, bad.text
    data["variables"] = {"initial": "frozen input"}
    key = str(uuid4())
    response = await c.post(endpoint, json=data, headers={"Idempotency-Key": key})
    assert response.status_code == 202, response.text
    run = response.json()["data"]
    assert (await c.post(endpoint, json=data, headers={"Idempotency-Key": key})).json()[
        "data"
    ] == run
    async with db.sessions() as session:
        jobs = (await session.execute(select(Job).where(Job.run_id == run["id"]))).scalars().all()
        assert len(jobs) == 2
        executions = (
            (await session.execute(select(CaseExecution).where(CaseExecution.run_id == run["id"])))
            .scalars()
            .all()
        )
        assert {e.provenance["datasetVersionId"] for e in executions} == set(datasets)
        assert {e.provenance["suiteEntryIndex"] for e in executions} == {0, 1}
        snapshots = [
            json.loads((await session.get(Artifact, (ws, j.snapshot_hash))).content) for j in jobs
        ]
        assert all(s["variables"] == data["variables"] and s["authAdapters"] for s in snapshots)
        assert all("synthetic-business-secret" not in json.dumps(s) for s in snapshots)
    empty = {k: v for k, v in data.items() if k != "suiteVersionId"}
    empty["caseVersionIds"] = []
    zero = await c.post(endpoint, json=empty, headers={"Idempotency-Key": str(uuid4())})
    assert zero.status_code == 202, zero.text
    assert zero.json()["data"]["outcome"] == "INCOMPLETE"
    assert zero.json()["data"]["reasonCode"] == "NO_CASES_SELECTED"
    for _ in range(9):
        admitted = await c.post(endpoint, json=data, headers={"Idempotency-Key": str(uuid4())})
        assert admitted.status_code == 202, admitted.text
    overflow = await c.post(endpoint, json=data, headers={"Idempotency-Key": str(uuid4())})
    assert overflow.status_code == 429 and overflow.json()["code"] == "RUN_LIMIT"
    assert (await c.post(endpoint, json=data, headers={"Idempotency-Key": key})).status_code == 202
    cancelled = await c.post(
        endpoint + f"/{run['id']}/cancel", json={"reason": "Operator cancellation"}
    )
    assert cancelled.status_code == 200, cancelled.text
    assert (
        cancelled.json()["data"]["state"] == "FINISHED"
        and cancelled.json()["data"]["outcome"] == "CANCELLED"
    )
    assert (
        await c.post(endpoint, json=data, headers={"Idempotency-Key": str(uuid4())})
    ).status_code == 202


async def test_debug_candidate_waits_for_validation_without_fabricating_published_version(site):
    from test_publish import create, queue, completed
    from test_lease_mysql import auth, claim_body
    from veriq_server.db import ResourceVersion

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
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
    path = await create(
        c,
        ws,
        "draft",
        {
            "kind": "CASE",
            "document": {
                "schemaVersion": "1.0",
                "caseKey": "draft",
                "title": "Draft",
                "kind": "READ",
                "roleKey": "reader",
                "catalogVersionId": catalog,
                "steps": [{"id": "open", "action": "goto", "path": "/"}],
            },
        },
    )
    preview, validation = await queue(c, path)
    data = {
        "draftValidationJobId": validation["id"],
        "environmentVersionId": env,
        "roleKeys": ["reader"],
        "browsers": ["chromium"],
        "runtimeIds": [d["runnerId"]],
    }
    admitted = await c.post(
        f"/api/v1/workspaces/{ws}/runs", json=data, headers={"Idempotency-Key": str(uuid4())}
    )
    assert admitted.status_code == 202, admitted.text
    assert admitted.json()["data"]["triggerKind"] == "DEBUG"
    async with db.sessions() as session:
        assert await session.get(ResourceVersion, preview["candidateVersionId"]) is None
    assert (
        await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))
    ).status_code == 204
    # Explicit T04 domain completion fixture isolates dependent-claim behavior here.
    await completed(db, validation["id"])
    request = claim_body(d)
    claim = await c.post("/internal/v1/jobs/claim", json=request, headers=auth(d))
    assert claim.status_code == 200, claim.text
    recovered = await c.post("/internal/v1/jobs/claim", json=request, headers=auth(d))
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["data"]["attemptId"] == claim.json()["data"]["attemptId"]
