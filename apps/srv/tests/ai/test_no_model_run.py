
import json
import os
from pathlib import Path
from uuid import uuid4

from tornado.web import Application, RequestHandler
from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets
from test_lease_mysql import device
from test_runs_mysql import published
from test_publish import create, queue
from test_agent_mysql import agent_once, guardian_diagnostics
from test_generation import ai_setup, provider_config, request
from emulator import emulator


async def test_disabled_and_exhausted_provider_do_not_affect_actual_run(site, tmp_path):
    c, db = site

    class Target(RequestHandler):
        def get(self, path):
            if path == "me":
                self.write({"id": "reader"})
            else:
                self.write('<h1 data-testid="ready">Ready</h1>')

    sockets = bind_sockets(0, "127.0.0.1")
    origin = f"http://127.0.0.1:{sockets[0].getsockname()[1]}"
    server = HTTPServer(Application([(r"/(.*)", Target)]))
    server.add_sockets(sockets)
    try:
        async with emulator() as model:
            ws, ai, p = await ai_setup(c, model.base_url, enabled=False)
            base = f"/api/v1/workspaces/{ws}"
            denied = await c.post(ai + "/generations", json=request(p["id"]))
            assert denied.status_code == 409
            d = await device(c, ws)
            catalog = await published(
                c,
                db,
                ws,
                "catalog",
                "ELEMENT_CATALOG",
                {
                    "schemaVersion": "1.0",
                    "elements": [{"key": "ready", "locator": {"by": "testId", "value": "ready"}}],
                },
            )
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
            env = await published(
                c,
                db,
                ws,
                "env",
                "ENVIRONMENT",
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
                            "authAdapterVersionId": adapter["versionId"],
                            "secretRef": "business",
                            "secretVersionId": secret["versionId"],
                            "allowedIdentityIds": ["reader"],
                        }
                    ],
                },
            )
            path = await create(
                c,
                ws,
                "actual-case",
                {
                    "kind": "CASE",
                    "document": {
                        "schemaVersion": "1.0",
                        "caseKey": "actual-case",
                        "title": "REQ-ready",
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
                                        "id": "ready",
                                        "type": "ui",
                                        "target": "ready",
                                        "operator": "textEquals",
                                        "expected": "Ready",
                                        "severity": "BLOCK",
                                        "expectedSource": "REQ-ready",
                                    }
                                ],
                            }
                        ],
                    },
                },
            )
            preview, job = await queue(c, path)
            release = Path(".superpowers/cache/t11/release").resolve()
            assert (release / "inventory.json").is_file(), "Run prepare-editor-agent.mjs first"
            conf = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
            Path(conf["approved_engine_inventory_path"]).write_bytes(
                (release / "inventory.json").read_bytes()
            )
            runtime = base + "/runtimes/" + d["runnerId"]
            assert (
                await c.put(
                    runtime + "/grants",
                    json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
                )
            ).status_code == 200
            assert (
                await c.put(
                    runtime + "/trust",
                    json={"trustStatus": "MANAGED", "allowCredentialDelivery": True},
                )
            ).status_code == 200
            profile = tmp_path / "profile"
            profile.mkdir(mode=0o700)
            (profile / "device.json").write_text(
                json.dumps({"server": "http://127.0.0.1:18889", **d})
            )
            os.chmod(profile / "device.json", 0o600)
            await agent_once(profile, release)
            receipt = (await c.get(base + "/jobs/" + job["id"] + "/validation-receipt")).json()[
                "data"
            ]
            version = await c.post(
                path + "/publish",
                json={"revision": preview["revision"], "validationReceiptId": receipt["id"]},
            )
            assert version.status_code == 201, version.text
            evidence = []
            for condition in ["disabled", "exhausted"]:
                if condition == "exhausted":
                    config = provider_config(model.base_url, enabled=True, monthlyBudgetUsd=0)
                    config.pop("apiKey")
                    assert (
                        await c.put(ai + "/providers/" + p["id"], json=config)
                    ).status_code == 200
                    denied = await c.post(ai + "/generations", json=request(p["id"]))
                    assert denied.status_code == 429, denied.text
                run = await c.post(
                    base + "/runs",
                    headers={"Idempotency-Key": str(uuid4())},
                    json={
                        "caseVersionIds": [version.json()["data"]["id"]],
                        "environmentVersionId": env,
                        "roleKeys": ["reader"],
                        "browsers": ["chromium"],
                        "runtimeIds": [d["runnerId"]],
                        "maxRetries": 0,
                    },
                )
                assert run.status_code == 202, run.text
                await agent_once(profile, release)
                final = (await c.get(base + "/runs/" + run.json()["data"]["id"])).json()["data"]
                assert final["state"] == "FINISHED" and final["outcome"] == "PASSED", final
                assert len(model.calls) == 0
                evidence.append(
                    {
                        "provider": condition,
                        "runId": final["id"],
                        "outcome": final["outcome"],
                        "modelHttpCalls": len(model.calls),
                    }
                )
            stops = guardian_diagnostics(profile)
            assert stops and all(s["state"] == "STOPPED" for s in stops)
            evidence_path = Path(".superpowers/sdd/veriq-1/evidence/t13/no-model-runs.json")
            evidence_path.parent.mkdir(parents=True, exist_ok=True)
            evidence_path.write_text(
                json.dumps({"runs": evidence, "stops": stops}, indent=2)
            )
            # Failure-analysis context uses ordinary sanitized report projections even for a passing Run.
            model.output = {
                "suggestions": ["Inspect supplied assertion basis"],
                "basis": "REQ-ready",
            }
            config = provider_config(model.base_url, monthlyBudgetUsd=1)
            config.pop("apiKey")
            assert (await c.put(ai + "/providers/" + p["id"], json=config)).status_code == 200
            analysis = await c.post(
                ai + "/generations",
                json=request(p["id"], purpose="FAILURE_ANALYSIS", runId=final["id"]),
            )
            assert analysis.status_code == 201, analysis.text
            assert analysis.json()["data"]["status"] == "SUCCEEDED", analysis.text
            outbound = json.dumps(model.calls[0]["body"])
            assert "synthetic-business-secret" not in outbound
            assert "secretVersionId" not in outbound and "trace.zip" not in outbound
    finally:
        server.stop()
        await server.close_all_connections()
