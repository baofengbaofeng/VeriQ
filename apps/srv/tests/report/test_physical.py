"""Actual CLI/Agent compilation, publish, browser execution and restricted reports."""

import asyncio
import io
import json
import os
import shutil
import tempfile
import zipfile
from pathlib import Path
from uuid import uuid4
from tornado.web import Application, RequestHandler
from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets
from test_auth import setup, login
from test_workspace import workspace, new_member, client
from test_lease_mysql import device
from test_agent_mysql import agent_once


async def test_real_agent_report_compiler_diagnostics_credentials_and_trust(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    base = f"/api/v1/workspaces/{ws}"
    secret = "synthetic-report-credential"

    class Business(RequestHandler):
        def get(self, path):
            if path == "identity":
                self.finish({"id": "reader"})
            else:
                self.set_cookie("session", secret)
                self.finish("<div data-testid='text'>Visible " + secret + "</div>")

    sockets = bind_sockets(0, "127.0.0.1")
    server = HTTPServer(Application([(r"/(.*)", Business)]))
    server.add_sockets(sockets)
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
    profile = Path(tempfile.mkdtemp(prefix="vq12-", dir="/tmp"))
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

        async def compile_resource(kind, key, document, fail=False):
            created = await c.post(
                base + "/resources",
                json={
                    "kind": kind,
                    "key": key,
                    "name": key,
                    "content": {"kind": kind, "document": document},
                },
            )
            assert created.status_code == 201, created.text
            resource = base + "/resources/" + created.json()["data"]["id"]
            preview = (await c.get(resource + "/validation-preview")).json()["data"]
            queued = await c.post(
                resource + "/validate",
                json={"revision": preview["revision"], "sourceHash": preview["sourceHash"]},
            )
            assert queued.status_code == 202, queued.text
            job = base + "/jobs/" + queued.json()["data"]["id"]
            await agent_once(profile, release)
            status = (await c.get(job)).json()["data"]
            if fail:
                assert status["outcome"] == "ERROR"
                assert status["diagnostics"][0]["code"] == "UNKNOWN_ELEMENT"
                assert status["diagnostics"][0]["pathStatus"] == "EXACT"
                assert status["diagnostics"][0]["path"].endswith("/steps/0/target")
                assert secret not in json.dumps(status)
                assert (await c.get(job + "/validation-receipt")).status_code == 409
                return None
            assert status["outcome"] == "PASSED", status
            receipt = (await c.get(job + "/validation-receipt")).json()["data"]
            published = await c.post(
                resource + "/publish",
                json={"revision": preview["revision"], "validationReceiptId": receipt["id"]},
            )
            assert published.status_code == 201, published.text
            version = published.json()["data"]["id"]
            files = (await c.get(resource + f"/versions/{version}/compiled-source")).json()["data"][
                "files"
            ]
            # Exact emitted TS contains references only, never resolved platform credentials.
            import httpx

            async with httpx.AsyncClient(
                base_url=str(c.base_url), cookies=c.cookies, headers=c.headers
            ) as raw:
                for file in files:
                    result = await raw.get(
                        resource + f"/versions/{version}/compiled-source",
                        params={"path": file["path"]},
                    )
                    assert result.status_code == 200
                    assert secret.encode() not in result.content
            return version

        catalog = await compile_resource(
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
        environment = await compile_resource(
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
        document = {
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
        }
        case = await compile_resource("CASE", "case", document)
        await compile_resource(
            "CASE",
            "bad",
            {**document, "steps": [{"id": "bad", "action": "click", "target": secret}]},
            True,
        )
        response = await c.post(
            base + "/runs",
            headers={"Idempotency-Key": str(uuid4())},
            json={
                "caseVersionIds": [case],
                "environmentVersionId": environment,
                "roleKeys": ["reader"],
                "browsers": ["chromium"],
                "runtimeIds": [credential["runnerId"]],
            },
        )
        assert response.status_code == 202, response.text
        run = response.json()["data"]["id"]
        await agent_once(profile, release)
        report = (await c.get(base + f"/runs/{run}/report")).json()["data"]
        assert report["run"]["outcome"] == "PASSED", report
        assert report["gateAtExecution"]["passed"] and report["gateNow"]["passed"]
        attempt = report["cases"][0]["attempts"][0]["id"]
        display_response = await c.get(base + f"/runs/{run}/attempts/{attempt}/display")
        assert display_response.status_code == 200, display_response.text
        display = display_response.json()["data"]
        assert display["metadataStatus"] == "AVAILABLE" and display["display"]["title"] == "Visible"
        assert display["display"]["steps"][0]["sourceId"] == "open"
        assert display["display"]["steps"][0]["assertions"][0]["sourceId"] == "visible"
        assert secret not in json.dumps(display)
        assert (
            await c.get(base + f"/runs/{uuid4()}/attempts/{attempt}/display")
        ).status_code == 404
        history = (await c.get(base + f"/attempts/{attempt}/history")).json()["data"]
        assert any(e["type"] == "ASSERTION_RESULT" for e in history["items"])
        assert secret not in json.dumps(history)
        artifacts = (await c.get(base + f"/attempts/{attempt}/artifacts")).json()["data"]["items"]
        kinds = {a["kind"] for a in artifacts}
        assert {"TRACE", "HTML", "JUNIT", "SCREENSHOT"} <= kinds
        trace = next(a for a in artifacts if a["kind"] == "TRACE")
        downloaded = await c.get(base + f"/attempts/{attempt}/artifacts/{trace['id']}")
        assert downloaded.status_code == 200
        with zipfile.ZipFile(io.BytesIO(downloaded.content)) as archive:
            trace_text = b"".join(
                archive.read(name)
                for name in archive.namelist()
                if name.endswith((".trace", ".network"))
            )
        assert secret.encode() in trace_text
        viewer_process = await asyncio.create_subprocess_exec(
            "node",
            "apps/web/tests/physical-report-view.mjs",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        view_output, view_error = await viewer_process.communicate()
        assert viewer_process.returncode == 0, view_error.decode() + view_output.decode()
        assert (
            await c.put(runtime + "/credential-delivery", json={"allowCredentialDelivery": False})
        ).status_code == 200
        withdrawn = (await c.get(base + f"/runs/{run}/report")).json()["data"]
        assert withdrawn["run"]["outcome"] == "PASSED" and withdrawn["gateAtExecution"]["passed"]
        assert not withdrawn["gateNow"]["passed"]
        assert "CREDENTIAL_DELIVERY_APPROVAL_REVOKED" in withdrawn["gateNow"]["reasons"]
        assert (
            await c.put(runtime + "/credential-delivery", json={"allowCredentialDelivery": True})
        ).status_code == 200
        from veriq_server.db import SecretVersion

        async with db.sessions.begin() as session:
            retained_pin = await session.get(SecretVersion, pin)
            retained_pin.revoked = True
        revoked_history = (await c.get(base + f"/attempts/{attempt}/history")).json()["data"]
        assert secret not in json.dumps(revoked_history)
        assert all(e["valuesAvailable"] for e in revoked_history["items"])
        async with db.sessions.begin() as session:
            retained_pin = await session.get(SecretVersion, pin)
            ciphertext = retained_pin.ciphertext
            retained_pin.ciphertext = b"invalid-encrypted-test-data"
        unavailable = (await c.get(base + f"/attempts/{attempt}/history")).json()["data"]
        assert all(not e["valuesAvailable"] for e in unavailable["items"])
        assert all(
            "actual" not in e["payload"] and "expected" not in e["payload"]
            for e in unavailable["items"]
        )
        assert (await c.get(base + f"/runs/{run}/attempts/{attempt}/display")).json()["data"][
            "metadataStatus"
        ] == "REDACTED"
        async with db.sessions.begin() as session:
            retained_pin = await session.get(SecretVersion, pin)
            retained_pin.ciphertext = ciphertext
        await new_member(c, ws, "report-viewer@example.com", "VIEWER")
        async with client(c, "report-viewer@example.com") as viewer:
            assert (await viewer.get(base + f"/runs/{run}/report")).status_code == 200
            assert (
                await viewer.get(base + f"/attempts/{attempt}/artifacts/{trace['id']}")
            ).status_code == 403
        assert (
            await c.put(
                runtime + "/trust",
                json={"trustStatus": "USER_REGISTERED", "allowCredentialDelivery": False},
            )
        ).status_code == 200
        changed = (await c.get(base + f"/runs/{run}/report")).json()["data"]
        assert (
            changed["run"]["outcome"] == "PASSED"
            and changed["gateAtExecution"]["passed"]
            and not changed["gateNow"]["passed"]
        )
    finally:
        if previous is None:
            approved.unlink(missing_ok=True)
        else:
            approved.write_bytes(previous)
        shutil.rmtree(profile)
        server.stop()
        await server.close_all_connections()
