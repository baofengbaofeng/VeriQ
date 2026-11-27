import asyncio
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
from uuid import uuid4
import zipfile

import httpx
import pytest
from sqlalchemy import select
from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets
from tornado.web import Application, RequestHandler

sys.path.insert(0, str(Path(__file__).parents[1] / "execution"))
from test_auth import setup, login
from test_workspace import workspace
from test_lease_mysql import auth, claim_body, device
from test_agent_mysql import server_compile_once
from veriq_server.bundles.issuer import Issuer
from veriq_server.db import Attempt, CaseExecution, Job, OfflineAttempt, ValidationReceipt
from veriq_server.handlers.base import MAX_HTTP_BODY_BYTES


async def _online_authority(db, attempt_id, published_receipts):
    """记录实际在线认领及每份已发布资源的服务端编译作业和回执，离线导入结束后逐项核对这些持久记录。"""
    async with db.sessions() as session:
        attempts = (
            (await session.execute(select(*Attempt.__table__.columns).order_by(Attempt.id)))
            .mappings()
            .all()
        )
        assert [row["id"] for row in attempts] == [attempt_id]
        jobs = (
            (
                await session.execute(
                    select(*Job.__table__.columns)
                    .where(Job.server_compilation_id.is_not(None))
                    .order_by(Job.id)
                )
            )
            .mappings()
            .all()
        )
        assert {row["id"] for row in jobs} == set(published_receipts)
        assert all(row["state"] == "FINISHED" and row["outcome"] == "PASSED" for row in jobs)
        receipts = (
            (
                await session.execute(
                    select(*ValidationReceipt.__table__.columns).order_by(ValidationReceipt.id)
                )
            )
            .mappings()
            .all()
        )
        assert {row["job_id"]: row["id"] for row in receipts} == published_receipts
        compilation_ids = {row["id"]: row["server_compilation_id"] for row in jobs}
        assert all(
            row["server_compilation_id"] == compilation_ids[row["job_id"]]
            and row["runtime_id"] is None
            and row["attempt_id"] is None
            for row in receipts
        )
        records = [dict(row) for row in [*attempts, *jobs, *receipts]]
        return sha256(json.dumps(records, default=str, sort_keys=True).encode()).hexdigest()


@pytest.fixture(name="control_server")
def _control_server(monkeypatch):
    captured = []
    original = HTTPServer.add_sockets

    def capture(server, sockets):
        if any(socket.getsockname()[1] == 18889 for socket in sockets):
            captured.append(server)
        return original(server, sockets)

    monkeypatch.setattr(HTTPServer, "add_sockets", capture)
    return captured


@pytest.fixture(name="physical_site")
async def _physical_site(control_server, site):
    yield (*site, control_server[0])


@pytest.mark.parametrize("scenario", ["single", "matrix", "draft_suite", "recovery_download"])
async def test_actual_offline_browser_result_uploads_to_enrolled_mysql_import(
    physical_site, tmp_path, scenario
):
    c, db, control = physical_site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    base = f"/api/v1/workspaces/{ws}"
    secret = "synthetic-offline-composition-credential"
    observed = {"identity": 0, "page": 0}
    blocked, release_business = asyncio.Event(), asyncio.Event()
    download_bytes = b"actual crash-surviving offline download"

    class Business(RequestHandler):
        async def get(self, path):
            if path == "identity":
                assert self.request.headers.get("Authorization") == "Bearer " + secret
                observed["identity"] += 1
                self.finish({"id": "reader"})
            elif path == "download":
                self.set_header("Content-Type", "application/octet-stream")
                self.set_header("Content-Disposition", 'attachment; filename="actual.bin"')
                self.finish(download_bytes)
            elif path == "hold":
                blocked.set()
                await release_business.wait()
                self.finish("released")
            else:
                observed["page"] += 1
                self.finish(
                    (
                        "<div veriq-id='text'>Visible offline business</div><a veriq-id='download' download "
                        "href='/download'>Download</a>"
                    )
                )

    sockets = bind_sockets(0, "127.0.0.1")
    business = HTTPServer(Application([(r"/(.*)", Business)]))
    business.add_sockets(sockets)
    origin = f"http://127.0.0.1:{sockets[0].getsockname()[1]}"
    process = await asyncio.create_subprocess_exec(
        "node",
        "apps/web/tests/prepare-editor-agent.mjs",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, errors = await process.communicate()
    assert process.returncode == 0, errors.decode()
    release = Path(".superpowers/cache/t11/release").resolve()
    config = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
    approved = Path(config["approved_engine_inventory_path"])
    previous = approved.read_bytes() if approved.exists() else None
    profile = Path(tempfile.mkdtemp(prefix="vq15-compose-", dir="/tmp"))
    replacement = None
    try:
        approved.write_bytes((release / "inventory.json").read_bytes())
        credential = await device(c, ws)
        runtime = base + f"/runtimes/{credential['runnerId']}"
        assert (
            await c.put(
                runtime + "/grants",
                json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
            )
        ).status_code == 200
        assert (
            await c.put(
                runtime + "/trust", json={"trustStatus": "MANAGED", "allowCredentialDelivery": True}
            )
        ).status_code == 200
        assert (
            await c.put(runtime + "/credential-delivery", json={"allowCredentialDelivery": True})
        ).status_code == 200
        (profile / "device.json").write_text(
            json.dumps({"server": "http://127.0.0.1:18889", **credential})
        )
        os.chmod(profile / "device.json", 0o600)

        published_receipts = {}

        async def publish(kind, key, document, draft=False):
            response = await c.post(
                base + "/resources",
                json={
                    "kind": kind,
                    "key": key,
                    "name": key,
                    "content": {"kind": kind, "document": document},
                },
            )
            assert response.status_code == 201, response.text
            resource = base + "/resources/" + response.json()["data"]["id"]
            preview = (await c.get(resource + "/validation-preview")).json()["data"]
            queued = await c.post(
                resource + "/validate",
                json={"revision": preview["revision"], "sourceHash": preview["sourceHash"]},
            )
            assert queued.status_code == 202, queued.text
            job = base + "/jobs/" + queued.json()["data"]["id"]
            if draft:
                return queued.json()["data"]["id"]
            await server_compile_once(db, release)
            status = (await c.get(job)).json()["data"]
            assert status["outcome"] == "PASSED", status
            receipt = (await c.get(job + "/validation-receipt")).json()["data"]
            published_receipts[queued.json()["data"]["id"]] = receipt["id"]
            published = await c.post(
                resource + "/publish",
                json={"revision": preview["revision"], "validationReceiptId": receipt["id"]},
            )
            assert published.status_code == 201, published.text
            return published.json()["data"]["id"]

        catalog = await publish(
            "ELEMENT_CATALOG",
            "catalog",
            {
                "schemaVersion": "1.0",
                "elements": [
                    {"key": key, "locator": {"by": "veriqId", "value": key}}
                    for key in ["text", "download"]
                ],
            },
        )
        pin = (
            await c.post(
                base + "/credentials",
                json={
                    "secretRef": "business",
                    "value": {"token": secret},
                    "allowedIdentityIds": ["reader"],
                },
            )
        ).json()["data"]["versionId"]
        adapter = (
            await c.post(
                base + "/auth-adapters",
                json={
                    "configuration": {
                        "kind": "HTTP_BEARER",
                        "identityPath": "/identity",
                        "identityPointer": "/id",
                    }
                },
            )
        ).json()["data"]["versionId"]
        environment = await publish(
            "ENVIRONMENT",
            "environment",
            {
                "schemaVersion": "1.0",
                "baseURL": origin,
                "apiBaseURL": origin,
                "allowedOrigins": [origin],
                "locale": "en",
                "timezone": "UTC",
                "roles": [
                    {
                        "roleKey": role_key,
                        "authAdapterVersionId": adapter,
                        "secretRef": "business",
                        "secretVersionId": pin,
                        "allowedIdentityIds": ["reader"],
                    }
                    for role_key in ["reader", "auditor"]
                ],
            },
        )
        case = await publish(
            "CASE",
            "case",
            {
                "schemaVersion": "1.0",
                "caseKey": "visible",
                "title": "Visible",
                "kind": "READ",
                "roleKey": "reader",
                "catalogVersionId": catalog,
                "steps": [
                    {
                        "id": "open",
                        "action": "goto",
                        "path": "/",
                        "afterAssertions": [
                            {
                                "id": "visible",
                                "type": "ui",
                                "operator": "textContains",
                                "target": "text",
                                "expected": "Visible",
                                "severity": "BLOCK",
                                "expectedSource": "REQ-visible",
                            }
                        ],
                    },
                    *(
                        [
                            {
                                "id": "download",
                                "action": "click",
                                "target": "download",
                                "observers": [{"id": "file", "kind": "download"}],
                            },
                            {"id": "hold", "action": "goto", "path": "/hold"},
                        ]
                        if scenario == "recovery_download"
                        else []
                    ),
                ],
            },
        )
        selection = {"caseVersionIds": [case]}
        if scenario in {"matrix", "draft_suite"}:
            dataset = await publish(
                "DATASET",
                "rows",
                {
                    "schemaVersion": "1.0",
                    "columns": {"name": "string"},
                    "rows": [{"key": key, "values": {"name": key}} for key in ["one", "two"]],
                },
            )
            suite = await publish(
                "SUITE",
                "suite",
                {
                    "schemaVersion": "1.0",
                    "cases": [
                        {
                            "versionId": case,
                            "datasetVersionId": dataset,
                            "roleKeys": ["auditor"],
                            "browsers": ["chromium"],
                        }
                    ],
                },
                draft=scenario == "draft_suite",
            )
            selection = {
                "draftValidationJobId" if scenario == "draft_suite" else "suiteVersionId": suite
            }
        export_started = time.monotonic()
        exported = await c.post(
            base + "/bundles",
            json={
                **selection,
                "environmentVersionId": environment,
                "validationStatus": (
                    "UNVALIDATED_DEBUG" if scenario == "draft_suite" else "VALIDATED"
                ),
            },
            headers={"Idempotency-Key": str(uuid4())},
            timeout=60,
        )
        assert exported.status_code == 201, exported.text
        bundle = exported.json()["data"]
        export_elapsed = time.monotonic() - export_started
        # 从独立的签发器文件读取公钥作为操作员输入，使制品签名验证的信任来源独立于下载归档和路由元数据。
        issuer = Issuer(tmp_path / "issuer" / "keys.json").public()
        (profile / "integration-input.json").write_text(
            json.dumps(
                {
                    "issuer": issuer,
                    "bundleId": bundle["id"],
                    "secretVersionId": pin,
                    "secret": secret,
                    "scenario": scenario,
                }
            )
        )
        os.chmod(profile / "integration-input.json", 0o600)

        async def host(phase, kill_when_blocked=False):
            process = await asyncio.create_subprocess_exec(
                "node",
                "--import",
                "tsx",
                "tests/offline-import-driver.ts",
                phase,
                str(profile),
                str(release),
                cwd="apps/runtime",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                if kill_when_blocked:
                    await asyncio.wait_for(blocked.wait(), 60)
                    process.kill()
                    await process.communicate()
                    return
                stdout, stderr = await asyncio.wait_for(process.communicate(), 120)
            except BaseException:
                if process.returncode is None:
                    process.terminate()
                    await process.communicate()
                raise
            assert process.returncode == 0, stderr.decode()
            assert not stdout, "Driver must not print credentials or raw evidence"

        assert len(published_receipts) == {"matrix": 5, "draft_suite": 4}.get(scenario, 3)
        online = await c.post(
            base + "/runs",
            headers={"Idempotency-Key": str(uuid4())},
            json={
                "caseVersionIds": [case],
                "environmentVersionId": environment,
                "roleKeys": ["reader"],
                "browsers": ["chromium"],
                "runtimeIds": [credential["runnerId"]],
                "maxRetries": 0,
            },
        )
        assert online.status_code == 202, online.text
        claimed = await c.post(
            "/internal/v1/jobs/claim", headers=auth(credential), json=claim_body(credential)
        )
        assert claimed.status_code == 200, claimed.text
        attempt_id = claimed.json()["data"]["attemptId"]
        cancelled = await c.post(
            base + "/runs/" + online.json()["data"]["id"] + "/cancel",
            json={"reason": "Preserve online authority for offline import comparison"},
        )
        assert cancelled.status_code == 200, cancelled.text
        before = await _online_authority(db, attempt_id, published_receipts)
        await host("prepare")
        archive_bytes = (profile / "bundle.zip").read_bytes()
        print(
            json.dumps(
                {
                    "scenario": scenario,
                    "exportSeconds": round(export_elapsed, 3),
                    "archiveBytes": len(archive_bytes),
                }
            )
        )
        archive = zipfile.ZipFile(io.BytesIO(archive_bytes))
        source = archive.read(
            "draft/source.json"
            if scenario == "draft_suite"
            else f"provenance/{suite if scenario == 'matrix' else case}/source.json"
        )
        control.stop()
        await control.close_all_connections()
        async with httpx.AsyncClient(timeout=2) as disconnected:
            with pytest.raises(httpx.ConnectError):
                await disconnected.get("http://127.0.0.1:18889/api/v1/setup")
        await host(
            "execute_prefix" if scenario == "matrix" else "execute",
            kill_when_blocked=scenario == "recovery_download",
        )
        if scenario == "recovery_download":
            await host("recover")
        assert observed["identity"] > 0 and observed["page"] > 0
        local = json.loads((profile / "local-result.json").read_text())
        assert secret not in json.dumps(local)
        assert local["manifestSha256"] == bundle["manifestSha256"]
        assert (
            local["attempts"][0]["execution"]["assetSourceHash"] == json.loads(source)["sourceHash"]
        )
        replacement = HTTPServer(control.request_callback, max_body_size=MAX_HTTP_BODY_BYTES)
        replacement.listen(18889, "127.0.0.1")
        await host("upload")
        receipt = json.loads((profile / "import-receipt.json").read_text())
        report_response = await c.get(base + f"/runs/{receipt['runId']}/report")
        assert report_response.status_code == 200, report_response.text
        report = report_response.json()["data"]
        assert report["run"]["source"] == "OFFLINE_IMPORT"
        expected_outcome = "PASSED" if scenario == "single" else "INCOMPLETE"
        assert report["run"]["outcome"] == expected_outcome, report
        if scenario == "matrix":
            assert report["statistics"]["caseCount"] == 2
            assert sum(not case["attempts"] for case in report["cases"]) == 1
        assert not report["gateAtExecution"]["passed"] and not report["gateNow"]["passed"]
        remote_attempt = next(
            case["attempts"][0]["id"]
            for case in report["cases"]
            if case["attempts"]
            and case["provenance"]["selection"]["variantKey"] == local["attempts"][0]["variantKey"]
        )
        events = (
            await c.get(base + f"/attempts/{remote_attempt}/history", params={"after": 0})
        ).json()["data"]["items"]
        assert [event["type"] for event in events] == [
            event["type"] for event in local["attempts"][0]["events"]
        ]
        files = (await c.get(base + f"/attempts/{remote_attempt}/artifacts")).json()["data"][
            "items"
        ]
        artifact_kind = "DOWNLOAD" if scenario == "recovery_download" else "TRACE"
        trace = next(file for file in files if file["kind"] == artifact_kind)
        original_trace = next(
            file for file in local["attempts"][0]["artifacts"] if file["kind"] == artifact_kind
        )
        raw = await c.get(base + f"/attempts/{remote_attempt}/artifacts/{trace['id']}")
        assert raw.status_code == 200, raw.text[:100]
        assert sha256(raw.content).hexdigest() == original_trace["sha256"] == trace["sha256"]
        if scenario == "recovery_download":
            assert raw.content == b"actual crash-surviving offline download"
        async with db.sessions() as session:
            imported = await session.get(OfflineAttempt, remote_attempt)
            assert imported.document == local["attempts"][0]
            execution = await session.get(CaseExecution, imported.case_execution_id)
            assert execution.source_snapshot_hash == sha256(source).hexdigest()
            assert execution.variant_key == local["attempts"][0]["variantKey"]
            assert execution.published_case_version_id == case
            assert execution.candidate_version_id is None
            assert (
                execution.provenance["compilation"]["publishedDependencySourceSha256"]
                == sha256(archive.read(f"provenance/{case}/source.json")).hexdigest()
            )
            assert (
                execution.provenance["compilation"]["publishedDependencyReceiptSha256"]
                == sha256(archive.read(f"provenance/{case}/receipt.json")).hexdigest()
            )
        if scenario == "matrix":
            legacy = json.loads(json.dumps(local))
            legacy["localRunId"] = str(uuid4())
            for attempt in legacy["attempts"]:
                attempt.pop("execution")
                attempt.pop("variantKey")
                attempt["artifacts"] = []
            rejected = await c.post(
                base + "/result-imports", json=legacy, headers={"Idempotency-Key": str(uuid4())}
            )
            assert rejected.status_code == 422, rejected.text
            assert rejected.json()["code"] == "OFFLINE_VARIANT_FACTS_REQUIRED"
            replacement.stop()
            await replacement.close_all_connections()
            await host("execute")
            replacement = HTTPServer(control.request_callback, max_body_size=MAX_HTTP_BODY_BYTES)
            replacement.listen(18889, "127.0.0.1")
            await host("upload")
            complete = json.loads((profile / "import-receipt.json").read_text())
            complete_report = (await c.get(base + f"/runs/{complete['runId']}/report")).json()[
                "data"
            ]
            assert complete_report["run"]["outcome"] == "PASSED", complete_report
            assert complete_report["statistics"]["caseCount"] == 2
            assert all(case["attempts"] for case in complete_report["cases"])
        assert await _online_authority(db, attempt_id, published_receipts) == before
        print(
            json.dumps(
                {
                    "actualComposedImport": "PASSED",
                    "controlDisconnected": True,
                    "onlineAttemptsUnchanged": True,
                    "scenario": scenario,
                    "events": len(events),
                    "traceSha256": trace["sha256"],
                    "officialGatePassed": False,
                    "manifestSha256": local["manifestSha256"],
                }
            )
        )
    finally:
        release_business.set()
        if replacement:
            replacement.stop()
            await replacement.close_all_connections()
        business.stop()
        await business.close_all_connections()
        if previous is None:
            approved.unlink(missing_ok=True)
        else:
            approved.write_bytes(previous)
        for directory in profile.rglob("*"):
            if directory.is_dir():
                directory.chmod(0o700)
        shutil.rmtree(profile)
