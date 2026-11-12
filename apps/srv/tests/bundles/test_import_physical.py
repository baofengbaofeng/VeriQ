"""Actual publication -> disconnected native execution -> enrolled upload -> MySQL report."""

import asyncio
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
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
from test_lease_mysql import device
from test_agent_mysql import agent_once
from veriq_server.bundles.issuer import Issuer
from veriq_server.db import Attempt, OfflineAttempt, CaseExecution
from veriq_server.handlers.base import MAX_HTTP_BODY_BYTES


@pytest.fixture
def control_server(monkeypatch):
    captured = []
    original = HTTPServer.add_sockets

    def capture(server, sockets):
        if any(socket.getsockname()[1] == 18889 for socket in sockets):
            captured.append(server)
        return original(server, sockets)

    monkeypatch.setattr(HTTPServer, "add_sockets", capture)
    return captured


@pytest.fixture
async def physical_site(control_server, site):
    yield (*site, control_server[0])


async def test_actual_offline_browser_result_uploads_to_enrolled_mysql_import(
    physical_site, tmp_path
):
    c, db, control = physical_site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    base = f"/api/v1/workspaces/{ws}"
    secret = "synthetic-offline-composition-credential"
    observed = {"identity": 0, "page": 0}

    class Business(RequestHandler):
        def get(self, path):
            if path == "identity":
                assert self.request.headers.get("Authorization") == "Bearer " + secret
                observed["identity"] += 1
                self.finish({"id": "reader"})
            else:
                observed["page"] += 1
                self.finish("<div data-testid='text'>Visible offline business</div>")

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

        async def publish(kind, key, document):
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
            await agent_once(profile, release)
            status = (await c.get(job)).json()["data"]
            assert status["outcome"] == "PASSED", status
            receipt = (await c.get(job + "/validation-receipt")).json()["data"]
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
                "elements": [{"key": "text", "locator": {"by": "testId", "value": "text"}}],
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
                        "roleKey": "reader",
                        "authAdapterVersionId": adapter,
                        "secretRef": "business",
                        "secretVersionId": pin,
                        "allowedIdentityIds": ["reader"],
                    }
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
                    }
                ],
            },
        )
        exported = await c.post(
            base + "/bundles",
            json={
                "caseVersionIds": [case],
                "environmentVersionId": environment,
                "validationStatus": "VALIDATED",
            },
            headers={"Idempotency-Key": str(uuid4())},
        )
        assert exported.status_code == 201, exported.text
        bundle = exported.json()["data"]
        # Operator key input is independent from the downloaded archive/routing metadata.
        issuer = Issuer(tmp_path / "issuer" / "keys.json").public()
        (profile / "integration-input.json").write_text(
            json.dumps(
                {
                    "issuer": issuer,
                    "bundleId": bundle["id"],
                    "secretVersionId": pin,
                    "secret": secret,
                }
            )
        )
        os.chmod(profile / "integration-input.json", 0o600)

        async def host(phase):
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
                stdout, stderr = await asyncio.wait_for(process.communicate(), 120)
            except BaseException:
                if process.returncode is None:
                    process.terminate()
                    await process.communicate()
                raise
            assert process.returncode == 0, stderr.decode()
            assert not stdout, "Driver must not print credentials or raw evidence"

        async def online_authority():
            async with db.sessions() as session:
                rows = (
                    (await session.execute(select(*Attempt.__table__.columns).order_by(Attempt.id)))
                    .mappings()
                    .all()
                )
                assert len(rows) == 3
                return sha256(
                    json.dumps([dict(row) for row in rows], default=str, sort_keys=True).encode()
                ).hexdigest()

        before = await online_authority()
        await host("prepare")
        archive = zipfile.ZipFile(io.BytesIO((profile / "bundle.zip").read_bytes()))
        source = archive.read(f"provenance/{case}/source.json")
        control.stop()
        await control.close_all_connections()
        async with httpx.AsyncClient(timeout=2) as disconnected:
            with pytest.raises(httpx.ConnectError):
                await disconnected.get("http://127.0.0.1:18889/api/v1/setup")
        await host("execute")
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
        assert report["run"]["outcome"] == "PASSED", report
        assert not report["gateAtExecution"]["passed"] and not report["gateNow"]["passed"]
        remote_attempt = report["cases"][0]["attempts"][0]["id"]
        events = (
            await c.get(
                base + f"/attempts/{remote_attempt}/history", params={"after": 0}
            )
        ).json()["data"]["items"]
        assert [event["type"] for event in events] == [
            event["type"] for event in local["attempts"][0]["events"]
        ]
        files = (await c.get(base + f"/attempts/{remote_attempt}/artifacts")).json()["data"][
            "items"
        ]
        trace = next(file for file in files if file["kind"] == "TRACE")
        original_trace = next(
            file for file in local["attempts"][0]["artifacts"] if file["kind"] == "TRACE"
        )
        raw = await c.get(base + f"/attempts/{remote_attempt}/artifacts/{trace['id']}")
        assert raw.status_code == 200, raw.text[:100]
        assert sha256(raw.content).hexdigest() == original_trace["sha256"] == trace["sha256"]
        async with db.sessions() as session:
            imported = await session.get(OfflineAttempt, remote_attempt)
            assert imported.document == local["attempts"][0]
            execution = await session.get(CaseExecution, imported.case_execution_id)
            assert execution.source_snapshot_hash == sha256(source).hexdigest()
            assert execution.variant_key == local["attempts"][0]["variantKey"]
        assert await online_authority() == before, "Offline import changed online Attempt authority"
        print(
            json.dumps(
                {
                    "actualComposedImport": "PASSED",
                    "controlDisconnected": True,
                    "onlineAttemptsUnchanged": 3,
                    "events": len(events),
                    "traceSha256": trace["sha256"],
                    "officialGatePassed": False,
                    "manifestSha256": local["manifestSha256"],
                }
            )
        )
    finally:
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
