"""完整组合验收通过实际服务账号设备、已发布套件、HTTP 触发与 Node Agent 执行读取业务页面，再由独立 CI 进程轮询并下载安全 JUnit；测试保留开发 Chromium 来源而不冒称正式发行浏览器验收。"""

import asyncio
import json
import os
from pathlib import Path
from uuid import uuid4
import httpx
from test_auth import setup, login
from test_workspace import workspace
from test_lease_mysql import CAPABILITIES
from test_agent_mysql import agent_once
import test_agent_mysql
from veriq_server.db import User

business = test_agent_mysql.business


async def test_real_service_plan_agent_ci_is_independent_of_creator_login(site, tmp_path, business):
    """真实服务设备完成所有资源编译发布后，以受限执行令牌触发套件并禁用创建者员工；执行、凭证下发、完成和 CI 状态读取仍依赖独立服务主体，原始报告拒绝该令牌且安全 JUnit 不含业务密钥。"""
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    base = f"/api/v1/workspaces/{ws}"
    actor = (await c.get("/api/v1/account")).json()["data"]["id"]
    account = (await c.post(base + "/service-accounts", json={"name": "Independent CI"})).json()[
        "data"
    ]["id"]
    issued = await c.post(
        base + f"/service-accounts/{account}/tokens", json={"purpose": "RUNTIME_ENROLLMENT"}
    )
    assert issued.status_code == 201, issued.text
    enrollment = await c.post(
        "/internal/v1/runtime-enrollments/service",
        json={"name": "Actual CI Agent", "capabilities": CAPABILITIES, "sharedWithWorkspace": True},
        headers={"Authorization": "Bearer " + issued.json()["data"]["token"]},
    )
    assert enrollment.status_code == 201, enrollment.text
    device = enrollment.json()["data"]
    runtime = base + f"/runtimes/{device['runnerId']}"
    trust = await c.put(
        runtime + "/trust", json={"trustStatus": "MANAGED", "allowCredentialDelivery": True}
    )
    assert trust.status_code == 200, trust.text
    process = await asyncio.create_subprocess_exec(
        "node",
        "apps/web/tests/prepare-editor-agent.mjs",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    assert process.returncode == 0, stderr.decode()
    release = Path(".superpowers/cache/t11/release").resolve()
    env = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
    inventory = Path(env["approved_engine_inventory_path"])
    previous = inventory.read_bytes() if inventory.exists() else None
    profile = tmp_path / "profile"
    profile.mkdir(mode=0o700)
    (profile / "device.json").write_text(
        json.dumps({"server": str(c.base_url).rstrip("/"), **device})
    )
    os.chmod(profile / "device.json", 0o600)

    async def publish(kind, key, document):
        resource = await c.post(
            base + "/resources",
            json={
                "kind": kind,
                "key": key,
                "name": key,
                "content": {"kind": kind, "document": document},
            },
        )
        assert resource.status_code == 201, resource.text
        path = base + "/resources/" + resource.json()["data"]["id"]
        preview = (await c.get(path + "/validation-preview")).json()["data"]
        queued = await c.post(
            path + "/validate",
            json={"revision": preview["revision"], "sourceHash": preview["sourceHash"]},
        )
        assert queued.status_code == 202, queued.text
        await agent_once(profile, release)
        receipt = await c.get(base + "/jobs/" + queued.json()["data"]["id"] + "/validation-receipt")
        assert receipt.status_code == 200, receipt.text
        version = await c.post(
            path + "/publish",
            json={
                "revision": preview["revision"],
                "validationReceiptId": receipt.json()["data"]["id"],
            },
        )
        assert version.status_code == 201, version.text
        return version.json()["data"]["id"]

    try:
        inventory.write_bytes((release / "inventory.json").read_bytes())
        catalog = await publish(
            "ELEMENT_CATALOG",
            "catalog",
            {
                "schemaVersion": "1.0",
                "elements": [{"key": "name", "locator": {"by": "testId", "value": "name"}}],
            },
        )
        case = await publish(
            "CASE",
            "ci-case",
            {
                "schemaVersion": "1.0",
                "caseKey": "ci-case",
                "title": "CI real page",
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
                                "target": "name",
                                "operator": "textEquals",
                                "expected": "Ready",
                                "severity": "BLOCK",
                                "expectedSource": "REQ-ci-page",
                            }
                        ],
                    }
                ],
            },
        )
        suite = await publish(
            "SUITE", "suite", {"schemaVersion": "1.0", "cases": [{"versionId": case}]}
        )
        secret = (
            await c.post(
                base + "/credentials",
                json={
                    "secretRef": "reader",
                    "value": {"token": "synthetic-ci-business-secret"},
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
                        "identityPath": "/identity",
                        "identityPointer": "/id",
                    }
                },
            )
        ).json()["data"]
        target, _ = business
        environment = await publish(
            "ENVIRONMENT",
            "environment",
            {
                "schemaVersion": "1.0",
                "baseURL": target,
                "apiBaseURL": target,
                "allowedOrigins": [target],
                "locale": "en-US",
                "timezone": "UTC",
                "roles": [
                    {
                        "roleKey": "reader",
                        "authAdapterVersionId": adapter["versionId"],
                        "secretRef": "reader",
                        "secretVersionId": secret["versionId"],
                        "allowedIdentityIds": ["reader"],
                    }
                ],
            },
        )
        plan = await c.post(
            base + "/execution-plans",
            json={
                "name": "Actual CI suite",
                "suiteVersionId": suite,
                "environmentVersionId": environment,
                "roleKeys": ["reader"],
                "browsers": ["chromium"],
                "runtimeIds": [device["runnerId"]],
                "overlapPolicy": "QUEUE",
                "maxCaseRetries": 0,
                "variables": {},
            },
        )
        assert plan.status_code == 201, plan.text
        plan_id = plan.json()["data"]["id"]
        token = await c.post(
            base + f"/service-accounts/{account}/tokens",
            json={
                "purpose": "EXECUTION",
                "operations": ["trigger", "read", "cancel"],
                "planIds": [plan_id],
            },
        )
        assert token.status_code == 201, token.text
        bearer = token.json()["data"]["token"]
        key = str(uuid4())
        async with httpx.AsyncClient(base_url=str(c.base_url)) as external:
            headers = {"Authorization": "Bearer " + bearer, "Idempotency-Key": key}
            trigger = await external.post(
                base + f"/execution-plans/{plan_id}/trigger", json={}, headers=headers
            )
            assert trigger.status_code == 202, trigger.text
            run = trigger.json()["data"]
            async with db.sessions.begin() as session:
                user = await session.get(User, actor)
                user.disabled = True
            replay = await external.post(
                base + f"/execution-plans/{plan_id}/trigger", json={}, headers=headers
            )
            assert replay.status_code == 200, replay.text
            output = tmp_path / "junit.xml"
            ci = await asyncio.create_subprocess_exec(
                "python",
                "scripts/veriq_ci.py",
                "--server",
                str(c.base_url).rstrip("/"),
                "--workspace",
                ws,
                "--plan",
                plan_id,
                "--key",
                key,
                "--timeout",
                "90",
                "--poll-interval",
                "0.2",
                "--junit",
                str(output),
                env={**os.environ, "VERIQ_CI_TOKEN": bearer},
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await agent_once(profile, release)
            stdout, stderr = await asyncio.wait_for(ci.communicate(), 100)
            status = await external.get(run["statusUrl"], headers=headers)
            assert status.json()["data"].get("outcome") == "PASSED", status.text
            assert ci.returncode == 0, stdout.decode() + stderr.decode()
            assert b'failures="0"' in output.read_bytes()
            assert b"synthetic-ci-business-secret" not in output.read_bytes()
            assert (
                await external.get(run["statusUrl"] + "/report", headers=headers)
            ).status_code == 401
            report = await external.get(run["statusUrl"] + "/ci-report", headers=headers)
            assert report.json()["data"]["statistics"]["caseCount"] == 1
            assert report.json()["data"]["gatePassed"] is True
    finally:
        if previous is None:
            inventory.unlink(missing_ok=True)
        else:
            inventory.write_bytes(previous)
