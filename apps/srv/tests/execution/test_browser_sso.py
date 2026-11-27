"""浏览器 SSO 用例覆盖真实站点的适配器注册、环境冻结、事件证明和受保护证据路径。"""

import json
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from test_auth import login, setup
from test_lease_mysql import auth, claim_body, device, queued_browser_jobs
from test_publish import create
from test_workspace import workspace

from veriq_server.auth.authorization import WorkspaceScope
from veriq_server.contracts import canonical_bytes
from veriq_server.db import Attempt
from veriq_server.repositories.resource import ResourceRepository
from veriq_server.service import lock_installation


async def _authenticated_site(site):
    """安装及登录用于建立真实平台会话，历史引导响应多出的 createdAt 与本次被测接口的契约无关。"""
    c, db = site
    async with httpx.AsyncClient(
        base_url=c.base_url, headers=c.headers, cookies=c.cookies
    ) as bootstrap:
        assert (await setup(bootstrap)).status_code == 201
        assert (await login(bootstrap)).status_code == 200
        c.headers["X-CSRF-Token"] = bootstrap.headers["X-CSRF-Token"]
        c.cookies.update(bootstrap.cookies)
    return c, db


@pytest.mark.parametrize("variant", ["valid", "missing_idp", "business_idp", "sso_fixture"])
async def test_sso_environment_preview_enforces_origin_scope_and_separate_fixture_identity(
    site, variant
):
    """通过真实注册和发布预览核对冻结环境授权，避免只对浏览器运行时断言身份站点和夹具边界。"""
    c, _ = await _authenticated_site(site)
    ws = await workspace(c)
    base = f"/api/v1/workspaces/{ws}"
    fixture = Path(__file__).parents[4] / "packages/contracts/fixtures/browser-sso.json"
    configuration = json.loads(fixture.read_text(encoding="utf-8"))
    business = "https://employees.sso.test"
    if variant == "business_idp":
        configuration["idpOrigin"] = business
    registered = await c.post(base + "/auth-adapters", json={"configuration": configuration})
    assert registered.status_code == 201, registered.text
    credential = await c.post(
        base + "/credentials",
        json={
            "secretRef": "employee-sso",
            "value": {"username": "employee-test", "password": "fixture-password"},
            "allowedIdentityIds": ["editor"],
        },
    )
    assert credential.status_code == 201, credential.text
    identity = {
        "authAdapterVersionId": registered.json()["data"]["versionId"],
        "secretRef": "employee-sso",
        "secretVersionId": credential.json()["data"]["versionId"],
        "allowedIdentityIds": ["editor"],
    }
    origins = [business]
    if variant != "missing_idp":
        origins.append(configuration["idpOrigin"])
    environment = {
        "schemaVersion": "1.0",
        "baseURL": business,
        "apiBaseURL": business + "/api",
        "allowedOrigins": origins,
        "locale": "en-US",
        "timezone": "UTC",
        "roles": [{"roleKey": "editor", **identity}],
    }
    if variant == "sso_fixture":
        environment.update(fixtureBaseURL=business, fixtureIdentity=identity)
    path = await create(c, ws, "sso-env", {"kind": "ENVIRONMENT", "document": environment})
    preview = await c.get(path + "/validation-preview")
    if variant == "valid":
        assert preview.status_code == 200, preview.text
    else:
        assert preview.status_code == 422, preview.text
        expected = (
            "SSO_FIXTURE_UNSUPPORTED" if variant == "sso_fixture" else "SSO_ORIGIN_NOT_ALLOWED"
        )
        assert preview.json()["code"] == expected


@pytest.mark.parametrize("sso_selected", [True, False])
async def test_sso_execution_evidence_is_bound_to_the_selected_frozen_role(site, sso_selected):
    """按真实租约向冻结角色提交事件和原始制品，核对所选角色的单点登录配置如何决定上传权限和历史认证结果。"""
    c, db = await _authenticated_site(site)
    ws = await workspace(c)
    await queued_browser_jobs(c, db, ws, 1)
    credential = await device(c, ws)
    headers = auth(credential)
    claimed = await c.post("/internal/v1/jobs/claim", json=claim_body(credential), headers=headers)
    assert claimed.status_code == 200, claimed.text
    claim = claimed.json()["data"]
    endpoint = f"/internal/v1/attempts/{claim['attemptId']}"
    proof = {name: claim[name] for name in ("leaseToken", "fencingToken")}
    activated = await c.post(endpoint + "/activate", json=proof, headers=headers)
    assert activated.status_code == 200, activated.text

    fixture = Path(__file__).parents[4] / "packages/contracts/fixtures/browser-sso.json"
    configuration = json.loads(fixture.read_text(encoding="utf-8"))
    sso_version = str(uuid4())
    snapshot = {
        "roleKey": "employee" if sso_selected else "reader",
        "environment": {
            "roles": [
                {"roleKey": "employee", "authAdapterVersionId": sso_version},
                {"roleKey": "reader", "authAdapterVersionId": str(uuid4())},
            ],
        },
        "authAdapters": [{"versionId": sso_version, "configuration": configuration}],
        "secretVersions": [{"secretRef": "unavailable", "versionId": str(uuid4())}],
    }
    async with db.sessions.begin() as session:
        await lock_installation(session)
        attempt = await session.get(Attempt, claim["attemptId"])
        attempt.snapshot_hash = await ResourceRepository(session, WorkspaceScope(ws)).store(
            canonical_bytes(snapshot)
        )

    raw = b"synthetic evidence test"
    upload = await c.post(
        endpoint + "/artifact-uploads",
        json={
            **proof,
            "kind": "TRACE",
            "filename": "trace.zip",
            "contentType": "application/zip",
            "sha256": sha256(raw).hexdigest(),
            "sizeBytes": len(raw),
            "sensitivity": "CREDENTIAL_RESTRICTED",
        },
        headers=headers,
    )
    assert upload.status_code == (409 if sso_selected else 201), upload.text
    authentication = {
        "stage": "IDP",
        "outcome": "FAILED",
        "durationMs": 110,
        "errorCode": "SSO_CHALLENGE_REQUIRED",
    }
    event = {
        "schemaVersion": "1.0",
        "attemptId": claim["attemptId"],
        "sequence": 1,
        "timestamp": "2026-11-22T00:00:00Z",
        "type": "ATTEMPT_FINISHED",
        "payload": {
            "outcome": "ERROR",
            "cleanupStatus": "NOT_REQUIRED",
            "authentication": authentication,
        },
    }
    if sso_selected:
        passed_without_authentication = {
            **event,
            "payload": {"outcome": "PASSED", "cleanupStatus": "NOT_REQUIRED"},
        }
        rejected = await c.post(
            endpoint + "/events",
            json={**proof, "events": [passed_without_authentication]},
            headers=headers,
        )
        assert rejected.status_code == 409, rejected.text
    result = await c.post(endpoint + "/events", json={**proof, "events": [event]}, headers=headers)
    assert result.status_code == (200 if sso_selected else 409), result.text
    if sso_selected:
        history_path = f"/api/v1/workspaces/{ws}/attempts/{claim['attemptId']}/history"
        report = await c.get(history_path)
        assert report.status_code == 200, report.text
        item = report.json()["data"]["items"][0]
        assert item["valuesAvailable"] is False
        assert item["payload"]["authentication"] == authentication
