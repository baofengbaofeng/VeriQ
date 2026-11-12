
from test_auth import setup, login
from test_workspace import workspace
from test_lease_mysql import queued_browser_jobs
from veriq_server.db import Job
import pytest


@pytest.mark.parametrize("legacy_inline", [False, True])
@pytest.mark.parametrize("outcome, days", [("PASSED", 14), ("INCOMPLETE", 30)])
async def test_raw_trace_claimed_redacted_requires_current_environment_permission(
    site, legacy_inline, outcome, days
):
    from test_lease_mysql import device, auth, claim_body
    from test_completion_mysql import upload
    from veriq_server.db import WorkspaceMember, AttemptUpload
    from sqlalchemy import select

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    await queued_browser_jobs(c, db, ws, 1)
    credential = await device(c, ws)
    response = await c.post(
        "/internal/v1/jobs/claim", json=claim_body(credential), headers=auth(credential)
    )
    assert response.status_code == 200, response.text
    claim = response.json()["data"]
    proof = {key: claim[key] for key in ["leaseToken", "fencingToken"]}
    assert (
        await c.post(
            f"/internal/v1/attempts/{claim['attemptId']}/activate",
            json=proof,
            headers=auth(credential),
        )
    ).status_code == 200
    from veriq_server.db import Attempt

    async with db.sessions() as session:
        activated = await session.get(Attempt, claim["attemptId"])
        assert activated.execution_provenance is not None
        assert activated.execution_provenance["trustStatus"] == "USER_REGISTERED"
        run_id = (await session.get(Job, activated.job_id)).run_id
    legacy = await c.get(
        f"/api/v1/workspaces/{ws}/runs/{run_id}/attempts/{claim['attemptId']}/display"
    )
    assert legacy.status_code == 200 and legacy.json()["data"]["metadataStatus"] == "ABSENT"
    raw = b"protocol-fixture-not-a-real-trace: synthetic-private-credential"
    digest = await upload(c, credential, claim, raw, "trace.zip", "TRACE")
    shared = b"shared-source-and-evidence-protocol-fixture"
    await upload(c, credential, claim, shared, "shared.log", "LOG")
    await upload(c, credential, claim, shared, "source.ts", "SOURCE")
    async with db.sessions() as session:
        row = (
            await session.execute(select(AttemptUpload).where(AttemptUpload.sha256 == digest))
        ).scalar_one()
        upload_id = row.id
    path = f"/api/v1/workspaces/{ws}/attempts/{claim['attemptId']}/artifacts/{upload_id}"
    owner = await c.get(path)
    assert owner.status_code == 200, owner.text
    assert owner.content == raw
    assert owner.headers["x-content-type-options"] == "nosniff"
    assert "attachment" in owner.headers["content-disposition"]
    actor = (await c.get("/api/v1/account")).json()["data"]["id"]
    async with db.sessions.begin() as session:
        member = await session.get(WorkspaceMember, (ws, actor))
        member.role = "EXECUTOR"
    assert (await c.get(path)).status_code == 403
    # Retention operates on real uploaded bytes while preserving historical facts.
    from datetime import timedelta
    from uuid import uuid4
    from veriq_server.service import now

    async with db.sessions.begin() as session:
        member = await session.get(WorkspaceMember, (ws, actor))
        member.role, member.status = "OWNER", "ACTIVE"
        attempt = await session.get(Attempt, claim["attemptId"])
        attempt.phase, attempt.outcome = "FINISHED", outcome
        attempt.created_at = now() - timedelta(days=40)
        attempt.facts = {"business": "PASSED", "cleanup": "NOT_REQUIRED", "evidence": "INCOMPLETE"}
        if legacy_inline:
            from veriq_server.db import Artifact

            artifact = await session.get(Artifact, (ws, digest))
            artifact.content, artifact.storage_backend = raw, "INLINE"
    account = (
        await c.post(f"/api/v1/workspaces/{ws}/service-accounts", json={"name": "Retention"})
    ).json()["data"]
    issued = await c.post(
        f"/api/v1/workspaces/{ws}/service-accounts/{account['id']}/tokens",
        json={"purpose": "MAINTENANCE", "operations": ["artifacts/expire"]},
    )
    assert issued.status_code == 201, issued.text
    headers = {
        "Authorization": "Bearer " + issued.json()["data"]["token"],
        "Idempotency-Key": str(uuid4()),
    }
    target = "/internal/v1/maintenance/artifacts/expire"
    # A legacy terminal record without server terminal time remains pinned even if
    # its creation time is old; no client clock or lease time is a substitute.
    unknown = await c.post(target, json={"workspaceId": ws, "limit": 100}, headers=headers)
    assert unknown.status_code == 200 and unknown.json()["data"]["processedCount"] == 0
    async with db.sessions.begin() as session:
        attempt = await session.get(Attempt, claim["attemptId"])
        attempt.finished_at = now() - timedelta(days=days) + timedelta(minutes=1)
    headers["Idempotency-Key"] = str(uuid4())
    recent = await c.post(target, json={"workspaceId": ws, "limit": 100}, headers=headers)
    assert recent.json()["data"]["processedCount"] == 0
    async with db.sessions.begin() as session:
        attempt = await session.get(Attempt, claim["attemptId"])
        attempt.finished_at = now() - timedelta(days=days) - timedelta(minutes=1)
    headers["Idempotency-Key"] = str(uuid4())
    first = await c.post(target, json={"workspaceId": ws, "limit": 100}, headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["data"]["processedCount"] == 2
    assert (await c.post(target, json={"workspaceId": ws, "limit": 100}, headers=headers)).json()[
        "data"
    ] == first.json()["data"]
    assert (await c.get(path)).status_code == 410
    async with db.sessions() as session:
        attempt = await session.get(Attempt, claim["attemptId"])
        assert attempt.outcome == outcome and attempt.facts["evidence"] == "INCOMPLETE"
    async with db.sessions.begin() as session:
        member = await session.get(WorkspaceMember, (ws, actor))
        member.role = "OWNER"
        member.status = "REMOVED"
    assert (await c.get(path)).status_code == 403


async def test_report_retains_queued_cases_without_inventing_passing_attempts(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    jobs = await queued_browser_jobs(c, db, ws, 2)
    async with db.sessions() as session:
        run_id = (await session.get(Job, jobs[0])).run_id
    response = await c.get(f"/api/v1/workspaces/{ws}/runs/{run_id}/report")
    assert response.status_code == 200, response.text
    report = response.json()["data"]
    assert report["run"]["state"] == "QUEUED"
    assert len(report["cases"]) == 2
    assert all(case["attempts"] == [] for case in report["cases"])
    assert report["gateNow"]["passed"] is False
    foreign = await workspace(c, key="foreign")
    assert (await c.get(f"/api/v1/workspaces/{foreign}/runs/{run_id}/report")).status_code == 404
