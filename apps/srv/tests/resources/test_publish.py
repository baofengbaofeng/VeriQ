
import asyncio
import copy
import json
from hashlib import sha256
from uuid import uuid4

import pytest
from sqlalchemy import select
from test_auth import setup, login
from test_workspace import workspace, new_member, client
from veriq_server.contracts import canonical_bytes, asset_source_hash
from veriq_server.db import Artifact, Job, ValidationReceipt, Runtime, RuntimeBinding, Attempt
from veriq_server.service import now

CATALOG = {
    "kind": "ELEMENT_CATALOG",
    "document": {
        "schemaVersion": "1.0",
        "elements": [{"key": "save", "locator": {"by": "testId", "value": "save"}}],
    },
}


async def create(c, ws, key="catalog", content=None):
    content = content or CATALOG
    r = await c.post(
        f"/api/v1/workspaces/{ws}/resources",
        json={"kind": content["kind"], "key": key, "name": key, "content": content},
    )
    assert r.status_code == 201, r.text
    return f"/api/v1/workspaces/{ws}/resources/{r.json()['data']['id']}"


async def queue(c, path):
    preview = await c.get(path + "/validation-preview")
    assert preview.status_code == 200, preview.text
    p = preview.json()["data"]
    r = await c.post(
        path + "/validate", json={"revision": p["revision"], "sourceHash": p["sourceHash"]}
    )
    assert r.status_code == 202, r.text
    return p, r.json()["data"]


async def completed(db, job_id):
    async with db.sessions.begin() as s:
        job = await s.get(Job, job_id)
        source = await s.get(Artifact, (job.workspace_id, job.snapshot_hash))
        snapshot = json.loads(source.content)
        assert asset_source_hash(snapshot) == snapshot["sourceHash"]
        target = snapshot["validationTarget"]
        body = b"// T04 test fixture: retained compilation bytes\nexport {};\n"
        digest = sha256(body).hexdigest()
        if not await s.get(Artifact, (job.workspace_id, digest)):
            s.add(
                Artifact(
                    workspace_id=job.workspace_id,
                    sha256=digest,
                    content=body,
                    size_bytes=len(body),
                    media_type="text/typescript",
                )
            )
            await s.flush()
        bundle = {
            "schemaVersion": "1.0",
            "sourceHash": snapshot["sourceHash"],
            "engineVersion": snapshot["engineVersion"],
            "compilerVersion": "0.1.0",
            "runnerSdkVersion": "0.1.0",
            "entrypoints": [
                {"caseVersionId": v, "path": "entry.ts"} for v in snapshot["entryCaseVersionIds"]
            ],
            "files": [{"path": "entry.ts", "sha256": digest, "sizeBytes": len(body)}],
            "dependencies": [
                {"name": "@veriq/runner-sdk", "version": "0.1.0", "integrity": "sha256-" + digest}
            ],
        }
        if not snapshot["entryCaseVersionIds"]:
            bundle["validationOnly"] = True
        raw = canonical_bytes(bundle)
        digest = sha256(raw).hexdigest()
        if not await s.get(Artifact, (job.workspace_id, digest)):
            s.add(
                Artifact(
                    workspace_id=job.workspace_id,
                    sha256=digest,
                    content=raw,
                    size_bytes=len(raw),
                    media_type="application/json",
                )
            )
            await s.flush()
        runtime_id, attempt_id = str(uuid4()), str(uuid4())
        s.add(
            Runtime(
                id=runtime_id,
                owner_user_id=job.created_by,
                name="T04 provenance fixture",
                location="CONNECTED_LOCAL",
                trust_status="MANAGED",
                capabilities={
                    "engineVersion": "0.1.0",
                    "os": "linux",
                    "arch": "x64",
                    "browsers": ["chromium"],
                },
                created_at=now(),
            )
        )
        await s.flush()
        s.add(
            RuntimeBinding(
                runtime_id=runtime_id,
                workspace_id=job.workspace_id,
                active=True,
                shared_with_workspace=False,
                allow_credential_delivery=False,
            )
        )
        await s.flush()
        s.add(
            Attempt(
                id=attempt_id,
                workspace_id=job.workspace_id,
                job_id=job.id,
                runtime_id=runtime_id,
                attempt_no=1,
                snapshot_hash=job.snapshot_hash,
                manifest_hash=job.manifest_hash,
                lease_token_hash="0" * 64,
                fencing_token=1,
                lease_expires_at=now(),
                phase="FINISHED",
                outcome="PASSED",
                capacity_state="RELEASED",
                facts={},
                last_sequence=0,
                created_at=now(),
            )
        )
        await s.flush()
        job.state = "FINISHED"
        job.active_attempt_id = attempt_id
        job.fence = 1
        receipt = ValidationReceipt(
            id=str(uuid4()),
            workspace_id=job.workspace_id,
            resource_id=target["resourceId"],
            job_id=job.id,
            runtime_id=runtime_id,
            attempt_id=job.active_attempt_id,
            compiler_trust="MANAGED",
            revision=target["revision"],
            source_hash=snapshot["sourceHash"],
            engine_version=snapshot["engineVersion"],
            compiled_bundle_sha256=digest,
            validated_at=now(),
        )
        s.add(receipt)
        return receipt.id, snapshot


async def publish(c, db, path):
    preview, job = await queue(c, path)
    receipt, snapshot = await completed(db, job["id"])
    r = await c.post(
        path + "/publish", json={"revision": preview["revision"], "validationReceiptId": receipt}
    )
    assert r.status_code == 201, r.text
    assert r.json()["data"]["id"] == preview["candidateVersionId"]
    return r.json()["data"], receipt, snapshot


async def test_draft_revision_is_atomic_and_validation_is_pending(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    path = await create(c, ws)
    draft = (await c.get(path + "/draft")).json()["data"]
    assert draft["revision"] == 1
    assert draft["documentHash"] == sha256(canonical_bytes(CATALOG)).hexdigest()
    responses = await asyncio.gather(
        *[c.put(path + "/draft", json={"revision": 1, "content": CATALOG}) for _ in range(2)]
    )
    assert sorted(r.status_code for r in responses) == [200, 409]
    p, job = await queue(c, path)
    assert job["state"] == "QUEUED"
    assert (await queue(c, path))[1]["id"] == job["id"]
    assert (
        await c.post(path + "/validate", json={"revision": 2, "sourceHash": "0" * 64})
    ).status_code == 409
    assert (
        await c.post(path + "/publish", json={"revision": 2, "validationReceiptId": str(uuid4())})
    ).status_code == 409
    assert (
        await c.get(f"/api/v1/workspaces/{ws}/jobs/{job['id']}/validation-receipt")
    ).status_code == 409
    async with db.sessions() as s:
        assert not (await s.execute(select(ValidationReceipt))).scalars().all()
        persisted = await s.get(Job, job["id"])
        snapshot = json.loads((await s.get(Artifact, (ws, persisted.snapshot_hash))).content)
        assert snapshot["entryCaseVersionIds"] == []
        assert len(snapshot["assets"]) == 1 and snapshot["assets"][0]["kind"] == "ELEMENT_CATALOG"


async def test_immutable_publication_and_stale_receipts(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    path = await create(c, ws)
    version, receipt, snapshot = await publish(c, db, path)
    adopted = copy.deepcopy(snapshot)
    adopted.pop("validationTarget")
    assert asset_source_hash(adopted) == snapshot["sourceHash"]
    changed = copy.deepcopy(CATALOG)
    changed["document"]["elements"][0]["key"] = "changed"
    assert (
        await c.put(path + "/draft", json={"revision": 1, "content": changed})
    ).status_code == 200
    assert (
        await c.post(path + "/publish", json={"revision": 2, "validationReceiptId": receipt})
    ).status_code == 409
    assert (await c.get(path + "/versions/" + version["id"])).json()["data"]["content"] == CATALOG
    second, _, _ = await publish(c, db, path)
    assert second["versionNo"] == 2 and second["id"] != version["id"]
    assert (await c.patch(path, json={"name": "Archived", "archived": True})).status_code == 200
    assert (
        await c.put(path + "/draft", json={"revision": 2, "content": CATALOG})
    ).status_code == 409
    response = await c.post(
        f"/api/v1/workspaces/{ws}/resources",
        json={"kind": "ELEMENT_CATALOG", "key": "catalog", "name": "Again", "content": CATALOG},
    )
    assert response.status_code == 409


async def test_references_impact_and_workspace_isolation(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    ws2 = await workspace(c, "other")
    path = await create(c, ws)
    version, _, _ = await publish(c, db, path)
    case = {
        "kind": "CASE",
        "document": {
            "schemaVersion": "1.0",
            "caseKey": "read",
            "title": "Read",
            "kind": "READ",
            "roleKey": "user",
            "catalogVersionId": version["id"],
            "steps": [{"id": "open", "action": "goto", "path": "/"}],
        },
    }
    casepath = await create(c, ws, "read", case)
    v, _, snap = await publish(c, db, casepath)
    assert snap["entryCaseVersionIds"] == [v["id"]] and len(snap["assets"]) == 2
    assert (await c.get(path + "/dependents")).json()["data"]["items"][0]["id"] == v["resourceId"]
    otherpath = await create(c, ws2, "foreign", case)
    assert (await c.get(otherpath + "/validation-preview")).status_code == 422
    assert (await c.get(path.replace(ws, ws2))).status_code == 404
    assert (await c.get(path.replace(ws, ws2) + "/versions/" + version["id"])).status_code == 404
    wrong = copy.deepcopy(case)
    wrong["document"]["catalogVersionId"] = v["id"]
    await c.put(casepath + "/draft", json={"revision": 1, "content": wrong})
    assert (await c.get(casepath + "/validation-preview")).status_code == 422


async def test_environment_permissions_and_unresolved_identity_registry(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    env = {
        "kind": "ENVIRONMENT",
        "document": {
            "schemaVersion": "1.0",
            "baseURL": "https://example.com",
            "apiBaseURL": "https://example.com",
            "allowedOrigins": ["https://example.com"],
            "locale": "en-US",
            "timezone": "UTC",
            "roles": [
                {
                    "roleKey": "user",
                    "authAdapterVersionId": str(uuid4()),
                    "secretRef": "test",
                    "secretVersionId": str(uuid4()),
                }
            ],
        },
    }
    path = await create(c, ws, "env", env)
    cat = await create(c, ws)
    assert (await c.get(path + "/validation-preview")).status_code == 422
    await new_member(c, ws, role="EDITOR")
    async with client(c, "member@example.com") as editor:
        assert (
            await editor.put(path + "/draft", json={"revision": 1, "content": env})
        ).status_code == 403
        assert (await editor.patch(path, json={"name": "changed"})).status_code == 403
        assert (
            await editor.put(cat + "/draft", json={"revision": 1, "content": env})
        ).status_code == 422
        assert (
            await editor.post(
                cat + "/publish", json={"revision": 1, "validationReceiptId": str(uuid4())}
            )
        ).status_code == 403
        assert (
            await editor.post(
                f"/api/v1/workspaces/{ws}/resources",
                json={"kind": "ENVIRONMENT", "key": "x", "name": "x", "content": env},
            )
        ).status_code == 403


@pytest.mark.parametrize(
    "tamper",
    ["source", "engine", "bundle", "file", "revision", "job", "target", "trust", "attempt"],
)
async def test_publication_rejects_tampered_provenance(site, tamper):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    path = await create(c, ws)
    p, j = await queue(c, path)
    rid, _ = await completed(db, j["id"])
    if tamper == "attempt":
        from sqlalchemy.exc import IntegrityError

        # T09 now rejects impossible provenance at the composite FK itself.
        with pytest.raises(IntegrityError, match="fk_validation_attempt"):
            async with db.sessions.begin() as s:
                r = await s.get(ValidationReceipt, rid)
                r.attempt_id = str(uuid4())
                await s.flush()
        return
    async with db.sessions.begin() as s:
        r = await s.get(ValidationReceipt, rid)
        job = await s.get(Job, j["id"])
        if tamper == "trust":
            r.compiler_trust = "USER_REGISTERED"
        if tamper == "source":
            r.source_hash = "0" * 64
        if tamper == "engine":
            r.engine_version = "999.0.0"
        if tamper == "revision":
            r.revision = 2
        if tamper == "job":
            job.state = "QUEUED"
        if tamper == "target":
            job.subject_id = str(uuid4())
        if tamper in {"bundle", "file"}:
            a = await s.get(Artifact, (ws, r.compiled_bundle_sha256))
            if tamper == "file":
                a = await s.get(Artifact, (ws, json.loads(a.content)["files"][0]["sha256"]))
            a.content = b"corrupted"
    r = await c.post(
        path + "/publish", json={"revision": p["revision"], "validationReceiptId": rid}
    )
    assert r.status_code == 409, r.text


async def test_large_document_bounded_lists_and_small_auth_limit(site):
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    data = {
        "kind": "DATASET",
        "document": {
            "schemaVersion": "1.0",
            "columns": {"value": "string"},
            "rows": [{"key": "row" + str(i), "values": {"value": "x" * 1000}} for i in range(100)],
        },
    }
    path = await create(c, ws, "large", data)
    assert len(json.dumps(data)) > 65536
    assert (await c.get(path + "/draft")).json()["data"]["content"] == data
    await create(c, ws, "another")
    base = f"/api/v1/workspaces/{ws}/resources"
    page = (await c.get(base + "?limit=1")).json()["data"]
    assert len(page["items"]) == 1 and page["nextCursor"]
    nextpage = (await c.get(base, params={"limit": 1, "cursor": page["nextCursor"]})).json()["data"]
    assert nextpage["items"][0]["id"] != page["items"][0]["id"]
    assert (await c.get(base + "?limit=101")).status_code == 400
    assert (
        await c.post("/api/v1/auth/login", json={"email": "a@example.com", "password": "x" * 70000})
    ).status_code == 413
    assert (
        await c.put(
            path + "/draft",
            content=b" " * (2 * 1024 * 1024 + 4097),
            headers={"Content-Type": "application/json"},
        )
    ).status_code == 413


async def test_all_eight_kinds_share_publication_rules(site, monkeypatch):
    from pathlib import Path

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    fixtures = json.loads(Path("packages/contracts/fixtures/compatibility.json").read_text())
    documents = {
        f["value"]["kind"]: copy.deepcopy(f["value"])
        for f in fixtures
        if f["valid"] and f["name"].startswith("asset-") and f["schema"] == "ResourceDocumentV1"
    }
    expected_role = documents["ENVIRONMENT"]["document"]["roles"][0]

    secret = (
        await c.post(
            f"/api/v1/workspaces/{ws}/credentials",
            json={
                "secretRef": expected_role["secretRef"],
                "value": {"token": "synthetic-test-secret"},
                "allowedIdentityIds": ["editor"],
            },
        )
    ).json()["data"]
    adapter = (
        await c.post(
            f"/api/v1/workspaces/{ws}/auth-adapters",
            json={
                "configuration": {
                    "kind": "HTTP_BEARER",
                    "identityPath": "/me",
                    "identityPointer": "/id",
                }
            },
        )
    ).json()["data"]
    expected_role.update(
        secretVersionId=secret["versionId"],
        authAdapterVersionId=adapter["versionId"],
        allowedIdentityIds=["editor"],
    )
    versions = {}
    for kind in [
        "ELEMENT_CATALOG",
        "ASSERTION_TEMPLATE",
        "DATASET",
        "FLOW",
        "FIXTURE",
        "ENVIRONMENT",
        "CASE",
        "SUITE",
    ]:
        content = documents[kind]
        if kind == "CASE":
            doc = content["document"]
            for field, target in [
                ("catalogVersionId", "ELEMENT_CATALOG"),
                ("fixtureVersionId", "FIXTURE"),
                ("datasetVersionId", "DATASET"),
            ]:
                doc[field] = versions[target]["id"]
            doc["steps"].append(
                {
                    "id": "reuse",
                    "action": "callFlow",
                    "versionId": versions["FLOW"]["id"],
                    "afterAssertions": [
                        {
                            "id": "template",
                            "type": "template",
                            "versionId": versions["ASSERTION_TEMPLATE"]["id"],
                            "severity": "BLOCK",
                            "expectedSource": "REQ-1",
                        }
                    ],
                }
            )
        if kind == "SUITE":
            content["document"]["cases"][0]["versionId"] = versions["CASE"]["id"]
        path = await create(c, ws, kind.lower(), content)
        version, receipt, snapshot = await publish(c, db, path)
        versions[kind] = version
        assert version["content"] == content
        assert snapshot["entryCaseVersionIds"] == (
            [] if kind not in {"CASE", "SUITE"} else [versions["CASE"]["id"]]
        )
        assert (
            await c.post(path + "/publish", json={"revision": 1, "validationReceiptId": receipt})
        ).json()["data"]["id"] == version["id"]
    assert len(versions) == 8


async def test_literal_uuid_data_is_not_a_reference_and_foreign_receipts_fail(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    content = {
        "kind": "DATASET",
        "document": {
            "schemaVersion": "1.0",
            "columns": {"versionId": "string"},
            "rows": [
                {
                    "key": "one",
                    "values": {"versionId": str(uuid4()), "authAdapterVersionId": str(uuid4())},
                }
            ],
        },
    }
    path = await create(c, ws, "literal", content)
    _, receipt, _ = await publish(c, db, path)
    other = await create(c, ws, "second", content)
    response = await c.post(
        other + "/publish", json={"revision": 1, "validationReceiptId": receipt}
    )
    assert response.status_code == 409
    await new_member(c, ws, role="VIEWER")
    async with client(c, "member@example.com") as viewer:
        assert (
            await viewer.put(path + "/draft", json={"revision": 1, "content": content})
        ).status_code == 403
        assert (await viewer.get(path + "/draft")).status_code == 200
    assert (
        await c.post(f"/api/v1/workspaces/{ws}/jobs/{str(uuid4())}/validation-receipt", json={})
    ).status_code == 405


async def test_version_pages_receipt_polling_and_current_membership(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    path = await create(c, ws)
    version, receipt, _ = await publish(c, db, path)
    _, job = await queue(c, path)
    jobpath = f"/api/v1/workspaces/{ws}/jobs/{job['id']}"
    assert (await c.get(jobpath)).json()["data"]["state"] == "FINISHED"
    assert (await c.get(jobpath + "/validation-receipt")).json()["data"]["id"] == receipt
    await c.put(path + "/draft", json={"revision": 1, "content": CATALOG})
    second, _, _ = await publish(c, db, path)
    page = (await c.get(path + "/versions?limit=1")).json()["data"]
    assert page["items"][0]["id"] == version["id"]
    page = (
        await c.get(path + "/versions", params={"limit": 1, "cursor": page["nextCursor"]})
    ).json()["data"]
    assert page["items"][0]["id"] == second["id"] and page["nextCursor"] is None
    uid = await new_member(c, ws, role="VIEWER")
    async with client(c, "member@example.com") as viewer:
        assert (await viewer.get(jobpath)).status_code == 200
        await c.put(
            f"/api/v1/workspaces/{ws}/members/{uid}", json={"role": "VIEWER", "status": "DISABLED"}
        )
        for route in [
            path,
            path + "/draft",
            path + "/versions",
            path + "/versions/" + version["id"],
            path + "/dependents",
            path + "/validation-preview",
            jobpath,
            jobpath + "/validation-receipt",
        ]:
            assert (await viewer.get(route)).status_code == 403


async def test_resource_migration_preserves_workspace_and_members(site):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from veriq_server import migrate
    from veriq_server.db import Workspace, WorkspaceMember

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    config = Config()
    config.set_main_option("script_location", str(Path(migrate.__file__).parent / "migrations"))
    async with db.engine.connect() as connection:

        def downgrade(sync):
            config.attributes["connection"] = sync
            command.downgrade(config, "0002_workspaces")

        await connection.run_sync(downgrade)
        await connection.commit()

        def upgrade(sync):
            config.attributes["connection"] = sync
            command.upgrade(config, "head")

        await connection.run_sync(upgrade)
        await connection.commit()
    async with db.sessions() as s:
        assert (await s.get(Workspace, ws)).key == "alpha"
        assert (
            await s.execute(select(WorkspaceMember).where(WorkspaceMember.workspace_id == ws))
        ).scalar_one().role == "OWNER"
    assert (await c.get(f"/api/v1/workspaces/{ws}")).status_code == 200
    await create(c, ws)


async def test_dependency_limit_counts_root_and_pending_ancestors(site, monkeypatch):
    from veriq_server.services import resource as services

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    catalog = await create(c, ws)
    version, _, _ = await publish(c, db, catalog)
    content = {
        "kind": "CASE",
        "document": {
            "schemaVersion": "1.0",
            "caseKey": "read",
            "title": "Read",
            "kind": "READ",
            "roleKey": "user",
            "catalogVersionId": version["id"],
            "steps": [{"id": "open", "action": "goto", "path": "/"}],
        },
    }
    path = await create(c, ws, "case", content)
    monkeypatch.setattr(services, "ASSET_LIMIT", 1)
    response = await c.get(path + "/validation-preview")
    assert response.status_code == 422, response.text
    assert response.json()["code"] == "DEPENDENCY_LIMIT"


async def test_engine_change_cannot_republish_same_immutable_revision(site):
    """通过真实第二个应用实例使用新引擎配置重新校验同一修订，必须生成不同来源的任务并拒绝覆盖旧发布版本；测试不再修改模块常量，因为 HTTP 服务已由显式 Settings 注入选择。

    两个应用共享隔离数据库，但分别拥有确定的运行配置。
    新预览与新 Job 的差异在创建回执前明确验证。
    旧版本仍由原应用读取，确认历史响应没有被新配置改写。
    """
    import httpx
    from tornado.httpserver import HTTPServer
    from tornado.netutil import bind_sockets
    from veriq_server.app import make_app
    from veriq_server.settings import Settings

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    path = await create(c, ws)
    old, _, original_snapshot = await publish(c, db, path)
    sockets = bind_sockets(0, "127.0.0.1")
    origin = f"http://127.0.0.1:{sockets[0].getsockname()[1]}"
    settings = Settings(database_url=db.engine.url.render_as_string(hide_password=False), public_url=origin, master_key="a" * 64, signing_key="b" * 64, environment="development", validation_engine_version="0.2.0")
    application = make_app(settings, db)
    server = HTTPServer(application)
    server.add_sockets(sockets)
    try:
        async with httpx.AsyncClient(base_url=origin, headers={"Origin": origin}) as current:
            state = await current.get("/api/v1/setup")
            current.headers["X-CSRF-Token"] = state.json()["data"]["csrfToken"]
            assert (await login(current)).status_code == 200
            preview, job = await queue(current, path)
            assert preview["engineVersion"] == "0.2.0"
            assert preview["sourceHash"] != original_snapshot["sourceHash"]
            receipt, _ = await completed(db, job["id"])
            response = await current.post(path + "/publish", json={"revision": 1, "validationReceiptId": receipt})
            assert response.status_code == 409, response.text
            assert (await c.get(path + "/versions/" + old["id"])).json()["data"] == old
    finally:
        server.stop()
        await server.close_all_connections()
        await application.settings["reset_dispatcher"].close()


@pytest.mark.parametrize("changed_bytes", [False, True])
async def test_revalidation_requires_identical_compiled_artifacts(site, changed_bytes):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    path = await create(c, ws)
    old, receipt_id, _ = await publish(c, db, path)
    async with db.sessions.begin() as s:
        original = await s.get(ValidationReceipt, receipt_id)
        first = await s.get(Job, original.job_id)
        job_id = str(uuid4())
        manifest = json.loads((await s.get(Artifact, (ws, first.manifest_hash))).content)
        manifest["jobId"] = job_id
        raw = canonical_bytes(manifest)
        digest = sha256(raw).hexdigest()
        s.add(
            Artifact(
                workspace_id=ws,
                sha256=digest,
                content=raw,
                size_bytes=len(raw),
                media_type="application/json",
            )
        )
        await s.flush()
        s.add(
            Job(
                id=job_id,
                workspace_id=ws,
                kind="VALIDATE",
                subject_id=first.subject_id,
                state="QUEUED",
                snapshot_hash=first.snapshot_hash,
                manifest_hash=digest,
                required_capabilities=first.required_capabilities,
                created_by=first.created_by,
                created_at=now(),
            )
        )
    second_id, _ = await completed(db, job_id)
    if changed_bytes:
        async with db.sessions.begin() as s:
            receipt = await s.get(ValidationReceipt, second_id)
            descriptor = json.loads(
                (await s.get(Artifact, (ws, receipt.compiled_bundle_sha256))).content
            )
            body = b"// different compiler bytes\nexport const different = true;\n"
            digest = sha256(body).hexdigest()
            s.add(
                Artifact(
                    workspace_id=ws,
                    sha256=digest,
                    content=body,
                    size_bytes=len(body),
                    media_type="text/typescript",
                )
            )
            descriptor["files"][0].update(sha256=digest, sizeBytes=len(body))
            raw = canonical_bytes(descriptor)
            digest = sha256(raw).hexdigest()
            s.add(
                Artifact(
                    workspace_id=ws,
                    sha256=digest,
                    content=raw,
                    size_bytes=len(raw),
                    media_type="application/json",
                )
            )
            await s.flush()
            receipt.compiled_bundle_sha256 = digest
    response = await c.post(
        path + "/publish", json={"revision": 1, "validationReceiptId": second_id}
    )
    assert response.status_code == (409 if changed_bytes else 201), response.text
    async with db.sessions() as s:
        from veriq_server.db import ResourceVersion

        assert (await s.get(ResourceVersion, old["id"])).receipt_id == receipt_id
