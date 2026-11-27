import asyncio
import json
import os
import shutil
import signal
import subprocess
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


@pytest.fixture(name="business")
async def business_service():
    facts = {
        "writes": 0,
        "reads": 0,
        "readonly_cookies": [],
        "prepare": [],
        "cleanup": [],
        "cookies": [],
        "fixtureIds": [],
        "hold_status": False,
        "echo_observed": asyncio.Event(),
        "echo_release": asyncio.Event(),
        "prepared": asyncio.Event(),
    }

    class Target(RequestHandler):
        async def get(self, path):
            if path == "identity":
                self.finish(
                    {
                        "id": (
                            "fixture-service"
                            if self.request.headers.get("Authorization")
                            == "Bearer synthetic-fixture"
                            else "reader"
                        )
                    }
                )
            elif path == "verified" and self.get_query_argument("echo", None):
                facts["echo"] = self.get_query_argument("echo")
                if facts.get("echo_mode") == "fail":
                    self.redirect("/mismatch?seen=" + facts["echo"])
                elif facts.get("echo_mode") == "hold":
                    self.finish("<div>" + facts["echo"] + "</div><img src='/echo-hold'>")
                else:
                    self.finish(facts["echo"])
            elif path == "echo-hold":
                facts["echo_observed"].set()
                await facts["echo_release"].wait()
                self.finish()
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
                self.finish("<div veriq-id='name'>Ready</div>")

        async def post(self, path):
            if path == "write":
                # 夹具把本次 POST 计入业务写入次数后立即关闭请求流，使调用方在连接断开前收不到业务响应。
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


def guardian_diagnostics(profile):
    facts = []
    for path in sorted((profile / "agent/processes").glob("*.process.json"))[:20]:
        journal = json.loads(path.read_text())
        proof_path = path.with_name(path.name.replace(".process.json", ".drained.json"))
        proof = json.loads(proof_path.read_text()) if proof_path.exists() else {}
        error_path = proof_path.with_name(proof_path.name + ".error")
        error = json.loads(error_path.read_text()) if error_path.exists() else {}
        facts.append(
            {
                "attemptId": journal.get("attemptId"),
                "state": journal.get("state"),
                "workerPid": journal.get("pid"),
                "guardianPid": journal.get("guardianPid"),
                "hasProof": bool(proof),
                "proofState": proof.get("state"),
                "nonceMatches": bool(proof) and proof.get("nonce") == journal.get("nonce"),
                "identityMatches": bool(proof)
                and all(
                    proof.get(key) == journal.get(value)
                    for key, value in [
                        ("uid", "uid"),
                        ("workerPid", "pid"),
                        ("workerStartTime", "startTime"),
                        ("guardianPid", "guardianPid"),
                        ("guardianStartTime", "guardianStartTime"),
                    ]
                ),
                "failureCode": error.get("failureCode"),
                "errno": error.get("errno"),
                "failurePid": error.get("pid"),
                "observedUid": error.get("observedUid"),
            }
        )
    return facts


async def server_compile_once(db, release: Path) -> None:
    """用真实测试发行和隔离数据库处理一个验证任务，执行用例的后续测试单独启动实际连接设备。"""
    from veriq_server.services.server_compilation import compile_next
    from veriq_server.settings import Settings

    test_env = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
    node = shutil.which("node")
    npm = shutil.which("npm")
    assert node and npm, "Node 24 and npm are required by the compiler test fixture"
    settings = Settings(
        database_url=db.engine.url.render_as_string(hide_password=False),
        public_url="http://127.0.0.1:18889",
        master_key="a" * 64,
        signing_key="b" * 64,
        environment="development",
        approved_engine_inventory_path=test_env["approved_engine_inventory_path"],
        server_compiler_release_dir=str(release.resolve()),
        server_compiler_node_path=str(Path(node).resolve()),
        server_compiler_npm_cli_path=str(Path(npm).resolve()),
        server_compiler_tsx_path=str(
            Path("packages/contracts/node_modules/tsx/dist/loader.mjs").resolve()
        ),
    )
    assert await compile_next(db, settings)


async def runtime_browser_executable() -> str:
    """让 Python 启动的物理用例和前端驱动通过同一测试入口解析浏览器路径，再由真实 Runtime 做版本检查。"""
    resolver = await asyncio.create_subprocess_exec(
        "node",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        "import { chromiumForTest } from './tests/support/chromium.ts';"
        "process.stdout.write(chromiumForTest())",
        cwd="apps/runtime",
        stdout=asyncio.subprocess.PIPE,
    )
    stdout, _ = await resolver.communicate()
    assert resolver.returncode == 0, "Unable to locate the Runtime test browser"
    return os.fsdecode(stdout)


async def agent_once(profile, release, *, expected_code=0, browser=None, expected_error=None):
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
        browser if browser is not None else await runtime_browser_executable(),
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
    assert process.returncode == expected_code, stderr.decode() + json.dumps(
        guardian_diagnostics(profile)
    )
    if expected_error is not None:
        assert expected_error in stderr.decode()
    return stdout.decode()


@pytest.mark.parametrize("failure", [False, True])
async def test_server_compiler_completion_and_sanitized_failure_then_agent_execution(
    site, tmp_path, failure, business
):
    """服务端编译的成功与失败均应直接结算发布任务，真实代理只为后续成功发布的用例产生执行和恢复证据。"""
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    catalog = await published(
        c,
        db,
        ws,
        "catalog",
        "ELEMENT_CATALOG",
        {
            "schemaVersion": "1.0",
            "elements": [{"key": "name", "locator": {"by": "veriqId", "value": "name"}}],
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
        "steps": (
            [{"id": "open", "action": "click", "target": "missing"}]
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
            ]
        ),
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
    await server_compile_once(db, release)
    async with db.sessions() as session:
        job = await session.get(Job, job_id)
        attempts = (
            (await session.execute(select(Attempt).where(Attempt.job_id == job_id))).scalars().all()
        )
        assert attempts == []
        assert job.state == "FINISHED"
        assert job.outcome == ("ERROR" if failure else "PASSED"), job.server_compile_result
        compilation_id = job.server_compilation_id
        assert compilation_id is not None
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
    job_path = f"/api/v1/workspaces/{ws}/jobs/{job_id}"
    if failure:
        result = (await c.get(job_path)).json()["data"]
        assert result["errorCode"] == "UNKNOWN_ELEMENT"
        assert result["diagnostics"][0]["code"] == "UNKNOWN_ELEMENT"
        assert "compiledBundleSha256" not in result
        assert (await c.get(job_path + "/validation-receipt")).status_code == 409

    else:
        receipt = (await c.get(job_path + "/validation-receipt")).json()["data"]
        assert receipt["serverCompilationId"] == compilation_id
        assert "attemptId" not in receipt and "runtimeId" not in receipt
        published_case = await c.post(
            base + "/publish",
            json={"revision": preview["revision"], "validationReceiptId": receipt["id"]},
        )
        assert published_case.status_code == 201, published_case.text
        d = await device(c, ws)
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

        # 用同一发布版本再提交一次 Run，等待夹具准备事件并确认进入第二次 Attempt 后，终止 Worker 进程组。
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
        assert journal["guardianPid"] != journal["pid"]
        assert os.getpgid(journal["pid"]) == journal["pid"]
        assert os.getpgid(journal["guardianPid"]) == journal["guardianPid"]
        attempt_journal = json.loads(
            (profile / "agent/attempts" / f"{crashed.id}.json").read_text()
        )
        pending_claim = json.loads((profile / "agent/claim-request.json").read_text())
        assert attempt_journal["claimRequestId"] == pending_claim["clientRequestId"]
        assert Path(f"/proc/{journal['pid']}/comm").read_text().strip() == "veriq_runner"
        os.killpg(journal["pid"], signal.SIGKILL)
        await crashing
        async with db.sessions() as session:
            stopped = await session.get(Attempt, crashed.id)
            assert stopped.capacity_state == "RELEASED", guardian_diagnostics(profile)
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
        missing_browser = "/nonexistent/veriq-cleanup-must-not-launch-browser"
        await agent_once(
            profile,
            release,
            browser=missing_browser,
            expected_code=1,
            expected_error="DOCTOR_FAILED",
        )
        async with db.sessions() as session:
            unclaimed = await session.get(Job, cleanup_job.id)
            assert unclaimed.state == "QUEUED" and unclaimed.active_attempt_id is None
            assert not (
                await session.scalars(select(Attempt).where(Attempt.job_id == cleanup_job.id))
            ).all()
        # 先用锁定浏览器完成能力检查，随后只向实际执行监督器提供不存在的路径，验证清理作业不会启动浏览器。
        await asyncio.to_thread(
            subprocess.run,
            [
                "node",
                "--import",
                "tsx",
                "tests/support/run-connected-attempt.ts",
                str(profile),
                str(release),
                await runtime_browser_executable(),
                "cleanup",
                missing_browser,
            ],
            cwd="apps/runtime",
            check=True,
            timeout=100,
        )
        async with db.sessions() as session:
            cleaned = await session.get(Job, cleanup_job.id)
            assert cleaned.state == "FINISHED" and cleaned.outcome == "PASSED"
            cleanup_attempt = (
                await session.scalars(select(Attempt).where(Attempt.job_id == cleaned.id))
            ).one()
            assert (
                cleanup_attempt.runtime_id == d["runnerId"] and cleanup_attempt.outcome == "PASSED"
            )
        assert facts["cleanup"][-1] == facts["prepare"][-1]
        assert facts["prepare"][-1].endswith(":2")
        # 让夹具延迟状态响应，等准备事件后从控制面取消 Run，再核对终局为 CANCELLED 且清理键匹配准备请求。
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

        # 分别编译并发布无数据夹具的 POST 与 GET 用例，再用同一引擎发布目录运行，比较业务观察与重试结果。
        # 写入后断连的请求记为 WRITE_POSSIBLE，只读分支记为 READ_ONLY_OBSERVED。
        # 只读重试使用不同快照，两次请求页面时均未携带 Cookie。
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
            await server_compile_once(db, release)
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
            # 再次轮询后检查 Attempt 数量，GET 用例应有两次尝试，POST 用例应只有一次尝试且只记录一次业务写入。
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
