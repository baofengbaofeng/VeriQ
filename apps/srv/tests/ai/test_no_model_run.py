"""通过回环业务站点、模型模拟器和真正的浏览器运行验证模型费用隔离及后台跟踪期间的对话可用性。"""

import asyncio
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
from test_agent_mysql import agent_once, guardian_diagnostics, server_compile_once
from test_generation import ai_setup, provider_config, request
from emulator import emulator
from test_conversational_agent import conversation, submit

from veriq_server.services.agent_tasks import advance_tasks
from veriq_server.settings import Settings


async def test_disabled_and_exhausted_provider_do_not_affect_actual_run(site, tmp_path):
    c, db = site
    browser_at_page, release_page = asyncio.Event(), asyncio.Event()
    release_page.set()

    class Target(RequestHandler):
        async def get(self, path):
            if path == "me":
                self.write({"id": "reader"})
            else:
                if path == "" and "Chrome/" in self.request.headers.get("User-Agent", ""):
                    browser_at_page.set()
                    await release_page.wait()
                self.write('<h1 veriq-id="ready">Ready</h1>')

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
                    "elements": [{"key": "ready", "locator": {"by": "veriqId", "value": "ready"}}],
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
            await server_compile_once(db, release)
            receipt = (await c.get(base + "/jobs/" + job["id"] + "/validation-receipt")).json()[
                "data"
            ]
            version = await c.post(
                path + "/publish",
                json={"revision": preview["revision"], "validationReceiptId": receipt["id"]},
            )
            assert version.status_code == 201, version.text
            selection = {
                "caseVersionIds": [version.json()["data"]["id"]],
                "environmentVersionId": env,
                "roleKeys": ["reader"],
                "browsers": ["chromium"],
                "runtimeIds": [d["runnerId"]],
                "maxRetries": 0,
            }
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
                    json=selection,
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
            evidence_path.write_text(json.dumps({"runs": evidence, "stops": stops}, indent=2))
            # 用已通过运行的脱敏报告发起失败分析，检查出站模型请求没有业务密钥、密钥版本标识或追踪附件名。
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
            turns, _, _ = await conversation(c, ws, model)
            model.output = {
                "reply": "Run the reader case and analyze its report.",
                "proposal": {
                    "type": "RUN_ONCE",
                    "selection": selection,
                    "delegateRun": True,
                    "analyzeRun": True,
                },
            }
            proposal = await submit(
                c, turns, "Run the reader case, follow it, and analyze its report."
            )
            assert proposal.get("proposal", {}).get("type") == "RUN_ONCE", proposal
            confirmed = await c.post(f"{turns}/{proposal['id']}/confirm")
            assert confirmed.is_success, confirmed.text
            run_id = confirmed.json()["data"]["receipt"]["runId"]
            report_path = f"{base}/runs/{run_id}/report"
            tasks = turns.removesuffix("/turns") + "/tasks"
            (queued,) = (await c.get(tasks)).json()["data"]["items"]
            assert queued["runId"] == run_id and queued["state"] == "QUEUED"

            # 只在真实 Chromium 抵达业务页面后继续，让运行停在真实断言之前；并发前台轮次不得依赖该页面完成。
            browser_at_page.clear()
            release_page.clear()
            executing = asyncio.create_task(agent_once(profile, release))
            try:
                await asyncio.wait_for(browser_at_page.wait(), 45)
                live = (await c.get(report_path)).json()["data"]["run"]
                assert live["state"] == "RUNNING", live
                assert await advance_tasks(db) == 1
                (following,) = (await c.get(tasks)).json()["data"]["items"]
                assert following == {**queued, "state": "FOLLOWING"}
                model.output = {"reply": "The reader case checks the ready heading."}
                reply = await submit(c, turns, "What does the ready assertion check?")
                assert reply["status"] == "COMPLETED" and reply["reply"] == model.output["reply"]
                assert not executing.done()
            finally:
                release_page.set()
                await executing

            final = (await c.get(report_path)).json()["data"]["run"]
            assert final["state"] == "FINISHED" and final["outcome"] == "PASSED", final
            settings = Settings(
                database_url=db.engine.url.render_as_string(hide_password=False),
                public_url=str(c.base_url).rstrip("/"),
                master_key="a" * 64,
                signing_key="b" * 64,
                environment="development",
                ai_allowed_base_urls=[model.base_url],
            )
            model.output = {
                "basis": "The browser assertion passed.",
                "suggestions": ["Keep the reader case."],
            }
            calls_before_analysis = len(model.calls)
            # 沿用工作器正常的再次检查间隔，直接运行一轮生产调度逻辑，不修改数据库的到期时间或运行结果。
            async with asyncio.timeout(15):
                while not await advance_tasks(db, settings):
                    await asyncio.sleep(0.25)
            (completed,) = (await c.get(tasks)).json()["data"]["items"]
            assert completed == {
                **following,
                "state": "COMPLETED",
                "outcome": final["outcome"],
                "analysis": model.output,
            }
            assert len(model.calls) == calls_before_analysis + 1
            source = json.loads(model.calls[-1]["body"]["messages"][1]["content"])["context"]
            assert source["runId"] == run_id and source["outcome"] == final["outcome"], source
            assert source["diagnosis"]["outcomeCounts"] == {"PASSED": 1}
            assert [item["caseVersionId"] for item in source["cases"]] == selection[
                "caseVersionIds"
            ]
            model.output = {"reply": "The browser is still running.", "relatedRunId": run_id}
            status = await submit(c, turns, "Run status")
            assert status["relatedRunId"] == run_id and "PASSED" in status["reply"], status
            assert model.output["reply"] not in status["reply"] and "proposal" not in status

    finally:
        server.stop()
        await server.close_all_connections()
