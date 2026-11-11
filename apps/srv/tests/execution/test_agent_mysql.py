"""Real Node Agent -> archived compiler -> fenced HTTP completion (no fixture completion writer)."""

import asyncio
import json
import os
import shutil
import signal
from pathlib import Path
import pytest
from sqlalchemy import select
from test_auth import setup, login
from test_workspace import workspace
from test_lease_mysql import device
from test_runs_mysql import published
from veriq_server.contracts import canonical_bytes
from veriq_server.db import Job, Artifact, Attempt, ValidationReceipt, Run
from uuid import uuid4
from tornado.web import Application, RequestHandler
from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets


@pytest.fixture
async def business():
    facts = {
        "writes": 0,
        "reads": 0,
        "readonly_cookies": [],
        "prepare": [],
        "cleanup": [],
        "cookies": [],
        "fixtureIds": [],
        "hold_status": False,
        "prepared": asyncio.Event(),
    }

    class Target(RequestHandler):
        async def get(self, path):
            if path == "identity":
                self.finish(
                    {
                        "id": "fixture-service"
                        if self.request.headers.get("Authorization") == "Bearer synthetic-fixture"
                        else "reader"
                    }
                )
            elif path == "readonly-status":
                facts["reads"] += 1
                self.finish({"ok": facts["reads"] == 2})
            elif path == "readonly":
                facts["readonly_cookies"].append(self.request.headers.get("Cookie", ""))
                self.set_cookie("readonly_attempt", "present")
                self.finish("Read only")
            elif path == "status":
                if facts["hold_status"]:
                    await asyncio.sleep(30)
                self.finish({"ok": len(facts["prepare"]) == 2})
            else:
                facts["cookies"].append(self.request.headers.get("Cookie", ""))
                self.set_cookie("attempt", str(len(facts["prepare"])))
                self.finish("<div data-testid='name'>Ready</div>")

        async def post(self, path):
            if path == "write":
                # Business accepted the write, but the caller cannot learn its result.
                facts["writes"] += 1
                self.request.connection.stream.close()
                return
            body = json.loads(self.request.body)
            expected = f"{body['workspaceId']}:{body['caseExecutionId']}:{body['attemptNo']}"
            assert body["idempotencyKey"] == expected
            if path == "prepare":
                facts["prepare"].append(expected)
                facts["prepared"].set()
                fid = str(uuid4())
                facts["fixtureIds"].append(fid)
                self.finish(
                    {
                        "fixtureId": fid,
                        "namespace": body["namespace"],
                        "variables": {},
                        "cleanupToken": "restricted-cleanup",
                    }
                )
            else:
                facts["cleanup"].append(expected)
                self.finish({"status": "CLEANED"})

    sockets = bind_sockets(0, "127.0.0.1")
    server = HTTPServer(Application([(r"/(.*)", Target)]))
    server.add_sockets(sockets)
    try:
        yield f"http://127.0.0.1:{sockets[0].getsockname()[1]}", facts
    finally:
        server.stop()
        await server.close_all_connections()


async def agent_once(profile, release, *, expected_code=0, browser="/usr/bin/chromium"):
    process = await asyncio.create_subprocess_exec(
        "node",
        "--import",
        "tsx",
        "src/cli.ts",
        "--config-dir",
        str(profile),
        "runtime",
        "start",
        "--release-dir",
        str(release),
        "--browser-executable",
        browser,
        "--once",
        cwd="apps/runtime",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 100)
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            process.terminate()
        await asyncio.wait_for(process.communicate(), 40)
        raise
    assert process.returncode == expected_code, stderr.decode()
    return stdout.decode()


@pytest.mark.parametrize("failure", [False, True])
async def test_agent_actual_compiler_completion_and_sanitized_no_bundle_failure(
    site, tmp_path, failure, business
):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
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
    fixture_id = await published(
        c,
        db,
        ws,
        "fixture",
        "FIXTURE",
        {
            "schemaVersion": "1.0",
            "prepare": {"method": "POST", "path": "/prepare"},
            "query": {"method": "GET", "path": "/query"},
            "cleanup": {"method": "POST", "path": "/cleanup"},
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object"},
            "ttlSeconds": 60,
        },
    )
    doc = {
        "schemaVersion": "1.0",
        "caseKey": "case",
        "title": "Actual compiler",
        "kind": "READ",
        "roleKey": "reader",
        "catalogVersionId": catalog,
        "fixtureVersionId": fixture_id,
        "steps": [{"id": "open", "action": "click", "target": "missing"}]
        if failure
        else [
            {"id": "open", "action": "goto", "path": "/"},
            {
                "id": "status",
                "action": "apiRequest",
                "method": "GET",
                "path": "/status",
                "observers": [
                    {
                        "id": "response",
                        "method": "GET",
                        "path": "/status",
                        "window": {"mode": "UNTIL_ACTION_SETTLED", "quietMs": 0},
                    }
                ],
                "afterAssertions": [
                    {
                        "id": "ready",
                        "type": "responseField",
                        "source": "response:response",
                        "pointer": "/ok",
                        "operator": "equals",
                        "expected": True,
                        "severity": "BLOCK",
                        "expectedSource": "REQ-ready",
                    }
                ],
            },
        ],
    }
    resource = await c.post(
        f"/api/v1/workspaces/{ws}/resources",
        json={
            "kind": "CASE",
            "key": "target",
            "name": "Target",
            "content": {"kind": "CASE", "document": doc},
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
    source_path = tmp_path / "source.json"
    source_path.write_bytes(source)
    output = tmp_path / "build"
    process = await asyncio.create_subprocess_exec(
        "node",
        "--import",
        "../contracts/node_modules/tsx/dist/loader.mjs",
        "tests/queue-fixture.ts",
        str(source_path),
        str(output),
        *(["--expect-failure"] if failure else []),
        cwd="packages/runner-sdk",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    assert process.returncode == 0, stderr.decode()
    records = json.loads((output / "index.json").read_text())
    config = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
    Path(config["approved_engine_inventory_path"]).write_bytes(
        canonical_bytes(records["inventory"])
    )
    release = tmp_path / "release"
    release.mkdir()
    (release / "inventory.json").write_bytes(canonical_bytes(records["inventory"]))
    for file in records["inventory"]["engines"][0]["files"]:
        target = release / file["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((output / file["sha256"]).read_bytes())
    shutil.rmtree(output)
    base_runtime = f"/api/v1/workspaces/{ws}/runtimes/{d['runnerId']}"
    assert (
        await c.put(
            base_runtime + "/grants",
            json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
        )
    ).status_code == 200
    assert (
        await c.put(
            base_runtime + "/trust",
            json={"trustStatus": "MANAGED", "allowCredentialDelivery": True},
        )
    ).status_code == 200
    profile = tmp_path / "profile"
    profile.mkdir(mode=0o700)
    (profile / "device.json").write_text(json.dumps({"server": "http://127.0.0.1:18889", **d}))
    os.chmod(profile / "device.json", 0o600)
    await agent_once(profile, release)
    async with db.sessions() as session:
        job = await session.get(Job, job_id)
        attempts = (
            (await session.execute(select(Attempt).where(Attempt.job_id == job_id))).scalars().all()
        )
        assert len(attempts) == 1
        assert job.state == "FINISHED"
        assert job.outcome == ("ERROR" if failure else "PASSED"), attempts[0].facts
        assert attempts[0].capacity_state == "RELEASED"
        receipts = (
            (
                await session.execute(
                    select(ValidationReceipt).where(ValidationReceipt.job_id == job_id)
                )
            )
            .scalars()
            .all()
        )
        assert len(receipts) == (0 if failure else 1)
    completion_files = list((profile / "agent/work").glob("*/completion.json"))
    assert len(completion_files) == 1
    completion = json.loads(completion_files[0].read_text())
    assert completion["processStopped"] is True
    if failure:
        assert completion["failureCode"] == "UNKNOWN_ELEMENT"
        assert "compiledBundleSha256" not in completion
        assert completion["requiredEvidence"]

    else:
        receipt = (await c.get(f"/api/v1/workspaces/{ws}/jobs/{job_id}/validation-receipt")).json()[
            "data"
        ]
        published_case = await c.post(
            base + "/publish",
            json={"revision": preview["revision"], "validationReceiptId": receipt["id"]},
        )
        assert published_case.status_code == 201, published_case.text
        origin, facts = business
        secrets = {}
        for ref in ["business", "fixture"]:
            secrets[ref] = (
                await c.post(
                    f"/api/v1/workspaces/{ws}/credentials",
                    json={
                        "secretRef": ref,
                        "value": {"token": "synthetic-" + ref},
                        "allowedIdentityIds": [
                            "reader" if ref == "business" else "fixture-service"
                        ],
                    },
                )
            ).json()["data"]["versionId"]
        adapter = (
            await c.post(
                f"/api/v1/workspaces/{ws}/auth-adapters",
                json={
                    "configuration": {
                        "kind": "HTTP_BEARER",
                        "identityPath": "/identity",
                        "identityPointer": "/id",
                    }
                },
            )
        ).json()["data"]["versionId"]

        def identity(ref):
            return {
                "authAdapterVersionId": adapter,
                "secretRef": ref,
                "secretVersionId": secrets[ref],
                "allowedIdentityIds": ["reader" if ref == "business" else "fixture-service"],
            }

        environment = await published(
            c,
            db,
            ws,
            "env",
            "ENVIRONMENT",
            {
                "schemaVersion": "1.0",
                "baseURL": origin,
                "apiBaseURL": origin,
                "fixtureBaseURL": origin,
                "allowedOrigins": [origin],
                "locale": "en",
                "timezone": "UTC",
                "roles": [{"roleKey": "reader", **identity("business")}],
                "fixtureIdentity": identity("fixture"),
            },
        )
        admitted = await c.post(
            f"/api/v1/workspaces/{ws}/runs",
            headers={"Idempotency-Key": str(uuid4())},
            json={
                "caseVersionIds": [published_case.json()["data"]["id"]],
                "environmentVersionId": environment,
                "roleKeys": ["reader"],
                "browsers": ["chromium"],
                "runtimeIds": [d["runnerId"]],
                "maxRetries": 1,
            },
        )
        assert admitted.status_code == 202, admitted.text
        for _ in range(2):
            await agent_once(profile, release)
        async with db.sessions() as session:
            run = await session.get(Run, admitted.json()["data"]["id"])
            assert run.state == "FINISHED" and run.outcome == "UNSTABLE"
            job = (await session.execute(select(Job).where(Job.run_id == run.id))).scalar_one()
            attempts = (
                (
                    await session.execute(
                        select(Attempt).where(Attempt.job_id == job.id).order_by(Attempt.attempt_no)
                    )
                )
                .scalars()
                .all()
            )
            assert [a.outcome for a in attempts] == ["FAILED", "PASSED"]
            assert all(a.capacity_state == "RELEASED" for a in attempts)
            assert len(set(a.snapshot_hash for a in attempts)) == 2
        assert len(set(facts["prepare"])) == 2
        assert len(set(facts["fixtureIds"])) == 2
        assert facts["cleanup"] == facts["prepare"]
        assert facts["cookies"] == ["", ""]

        # A second real Run reaches Attempt2, then its owned worker crashes after prepare.
        admitted = await c.post(
            f"/api/v1/workspaces/{ws}/runs",
            headers={"Idempotency-Key": str(uuid4())},
            json={
                "caseVersionIds": [published_case.json()["data"]["id"]],
                "environmentVersionId": environment,
                "roleKeys": ["reader"],
                "browsers": ["chromium"],
                "runtimeIds": [d["runnerId"]],
                "maxRetries": 1,
            },
        )
        assert admitted.status_code == 202, admitted.text
        await agent_once(profile, release)
        facts["hold_status"] = True
        facts["prepared"].clear()
        crashing = asyncio.create_task(agent_once(profile, release, expected_code=1))
        await asyncio.wait_for(facts["prepared"].wait(), 30)
        async with db.sessions() as session:
            crashed_job = (
                await session.execute(
                    select(Job).where(Job.run_id == admitted.json()["data"]["id"])
                )
            ).scalar_one()
            crashed = await session.get(Attempt, crashed_job.active_attempt_id)
            assert crashed.attempt_no == 2
            original = json.loads(
                (await session.get(Artifact, (ws, crashed.snapshot_hash))).content
            )
        journal = json.loads(
            (profile / "agent/processes" / f"{crashed.id}.process.json").read_text()
        )
        assert journal["state"] == "RUNNING"
        assert Path(f"/proc/{journal['pid']}/comm").read_text().strip() == "veriq_runner"
        os.killpg(journal["pid"], signal.SIGKILL)
        await crashing
        facts["hold_status"] = False
        account = (
            await c.post(f"/api/v1/workspaces/{ws}/service-accounts", json={"name": "Compensation"})
        ).json()["data"]
        token = (
            await c.post(
                f"/api/v1/workspaces/{ws}/service-accounts/{account['id']}/tokens",
                json={"purpose": "MAINTENANCE", "operations": ["fixture-cleanups/reconcile"]},
            )
        ).json()["data"]["token"]
        compensation = await c.post(
            "/internal/v1/maintenance/fixture-cleanups/reconcile",
            headers={"Authorization": "Bearer " + token, "Idempotency-Key": str(uuid4())},
            json={"workspaceId": ws, "limit": 100},
        )
        assert compensation.status_code == 200, compensation.text
        assert compensation.json()["data"]["processedCount"] == 1
        async with db.sessions() as session:
            cleanup_job = (
                await session.execute(
                    select(Job).where(Job.origin_attempt_id == crashed.id, Job.kind == "CLEANUP")
                )
            ).scalar_one()
            subject = json.loads(
                (await session.get(Artifact, (ws, cleanup_job.snapshot_hash))).content
            )
            assert subject["attemptNo"] == 2
            assert secrets["business"] not in json.dumps(subject)
            assert subject["namespace"] == original["namespace"]
            assert subject["caseExecutionId"] == original["caseExecutionId"]
            assert subject["secretVersions"] == [
                {"secretRef": "fixture", "versionId": secrets["fixture"]}
            ]
        # An impossible browser executable proves this real CLEANUP does not launch one.
        await agent_once(
            profile, release, browser="/nonexistent/veriq-cleanup-must-not-launch-browser"
        )
        async with db.sessions() as session:
            cleaned = await session.get(Job, cleanup_job.id)
            assert cleaned.outcome == "PASSED"
        assert facts["cleanup"][-1] == facts["prepare"][-1]
        assert facts["prepare"][-1].endswith(":2")
        # User cancellation is observed by the real heartbeat while a request is unfinished.
        facts["hold_status"] = True
        facts["prepared"].clear()
        cancelled = await c.post(
            f"/api/v1/workspaces/{ws}/runs",
            headers={"Idempotency-Key": str(uuid4())},
            json={
                "caseVersionIds": [published_case.json()["data"]["id"]],
                "environmentVersionId": environment,
                "roleKeys": ["reader"],
                "browsers": ["chromium"],
                "runtimeIds": [d["runnerId"]],
            },
        )
        assert cancelled.status_code == 202, cancelled.text
        cancelling = asyncio.create_task(agent_once(profile, release))
        await asyncio.wait_for(facts["prepared"].wait(), 30)
        response = await c.post(
            f"/api/v1/workspaces/{ws}/runs/{cancelled.json()['data']['id']}/cancel",
            json={"reason": "Physical Agent cancellation"},
        )
        assert response.status_code == 200, response.text
        await cancelling
        facts["hold_status"] = False
        async with db.sessions() as session:
            run = await session.get(Run, cancelled.json()["data"]["id"])
            assert run.state == "FINISHED" and run.outcome == "CANCELLED"
        assert facts["cleanup"][-1] == facts["prepare"][-1]

        # Both cases use actual compilation/publication and the same approved release.
        # No fixture exists to close a namespace: retry must depend on trusted source
        # plus the complete physical business observation, never the exit code alone.
        for method in ["POST", "GET"]:
            retry_doc = {k: v for k, v in doc.items() if k != "fixtureVersionId"}
            retry_doc["caseKey"] = "no-fixture-" + method.lower()
            retry_doc["steps"] = (
                [{"id": "write", "action": "apiRequest", "method": "POST", "path": "/write"}]
                if method == "POST"
                else [
                    {"id": "open", "action": "goto", "path": "/readonly"},
                    {
                        **doc["steps"][1],
                        "path": "/readonly-status",
                        "observers": [
                            {**doc["steps"][1]["observers"][0], "path": "/readonly-status"}
                        ],
                    },
                ]
            )
            created = await c.post(
                f"/api/v1/workspaces/{ws}/resources",
                json={
                    "kind": "CASE",
                    "key": retry_doc["caseKey"],
                    "name": retry_doc["caseKey"],
                    "content": {"kind": "CASE", "document": retry_doc},
                },
            )
            assert created.status_code == 201, created.text
            retry_base = f"/api/v1/workspaces/{ws}/resources/{created.json()['data']['id']}"
            retry_preview = (await c.get(retry_base + "/validation-preview")).json()["data"]
            queued = await c.post(
                retry_base + "/validate",
                json={
                    "revision": retry_preview["revision"],
                    "sourceHash": retry_preview["sourceHash"],
                },
            )
            assert queued.status_code == 202, queued.text
            await agent_once(profile, release)
            receipt = (
                await c.get(
                    f"/api/v1/workspaces/{ws}/jobs/{queued.json()['data']['id']}/validation-receipt"
                )
            ).json()["data"]
            approved = await c.post(
                retry_base + "/publish",
                json={
                    "revision": retry_preview["revision"],
                    "validationReceiptId": receipt["id"],
                },
            )
            assert approved.status_code == 201, approved.text
            admitted = await c.post(
                f"/api/v1/workspaces/{ws}/runs",
                headers={"Idempotency-Key": str(uuid4())},
                json={
                    "caseVersionIds": [approved.json()["data"]["id"]],
                    "environmentVersionId": environment,
                    "roleKeys": ["reader"],
                    "browsers": ["chromium"],
                    "runtimeIds": [d["runnerId"]],
                    "maxRetries": 1,
                },
            )
            assert admitted.status_code == 202, admitted.text
            await agent_once(profile, release)
            # GET takes a new Attempt; POST finds no queued business work to replay.
            await agent_once(profile, release)
            async with db.sessions() as session:
                run = await session.get(Run, admitted.json()["data"]["id"])
                assert run.state == "FINISHED"
                assert run.outcome == ("FAILED" if method == "POST" else "UNSTABLE")
                job = (await session.execute(select(Job).where(Job.run_id == run.id))).scalar_one()
                attempts = (
                    (
                        await session.execute(
                            select(Attempt)
                            .where(Attempt.job_id == job.id)
                            .order_by(Attempt.attempt_no)
                        )
                    )
                    .scalars()
                    .all()
                )
                assert len(attempts) == (1 if method == "POST" else 2)
                assert all(a.capacity_state == "RELEASED" for a in attempts)
                completions = [
                    json.loads((profile / "agent/work" / a.id / "completion.json").read_text())
                    for a in attempts
                ]
                assert all(item["cleanupStatus"] == "NOT_REQUIRED" for item in completions)
                if method == "POST":
                    assert attempts[0].facts["retryReasonCode"] == "RETRY_SAFETY_UNCONFIRMED"
                    assert completions[0]["retrySafety"] == "WRITE_POSSIBLE"
                    assert facts["writes"] == 1
                else:
                    assert all(item["retrySafety"] == "READ_ONLY_OBSERVED" for item in completions)
                    assert len({a.snapshot_hash for a in attempts}) == 2
                    assert facts["reads"] == 2
                    assert facts["readonly_cookies"] == ["", ""]
