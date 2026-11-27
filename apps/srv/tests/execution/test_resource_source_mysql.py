import asyncio
import json
import os
import shutil
import tempfile
from functools import partialmethod
from hashlib import sha256
from pathlib import Path

import httpx
import pytest
from test_auth import setup, login
from test_workspace import workspace, new_member, client
from test_lease_mysql import device
import test_agent_mysql
import test_http_datasets
from test_engine_capabilities_mysql import _settings_with_inventory, _write_inventory
from veriq_server.db import Artifact
from veriq_server.settings import Settings

business = test_agent_mysql.business
dataset_deployment = test_http_datasets.dataset_deployment


async def test_published_source_exact_bytes_integrity_scope_and_current_membership(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    other_ws = await workspace(c, "other")
    created = await c.post(
        f"/api/v1/workspaces/{ws}/resources",
        json={
            "kind": "ELEMENT_CATALOG",
            "key": "catalog",
            "name": "Catalog",
            "content": {
                "kind": "ELEMENT_CATALOG",
                "document": {
                    "schemaVersion": "1.0",
                    "elements": [{"key": "name", "locator": {"by": "veriqId", "value": "name"}}],
                },
            },
        },
    )
    assert created.status_code == 201
    rid = created.json()["data"]["id"]
    base = f"/api/v1/workspaces/{ws}/resources/{rid}"
    preview = (await c.get(base + "/validation-preview")).json()["data"]
    queued = await c.post(
        base + "/validate",
        json={"revision": preview["revision"], "sourceHash": preview["sourceHash"]},
    )
    assert queued.status_code == 202
    job_id = queued.json()["data"]["id"]
    assert (
        await c.get(f"/api/v1/workspaces/{ws}/jobs/{job_id}/validation-receipt")
    ).status_code == 409
    # 测试用 Node 打包脚本准备真实的引擎发行，再将库存写入获准清单，独立 Worker 直接使用发行字节。
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
    approved = Path(env["approved_engine_inventory_path"])
    previous = approved.read_bytes() if approved.exists() else None
    try:
        approved.write_bytes((release / "inventory.json").read_bytes())
        await test_agent_mysql.server_compile_once(db, release)
        status = (await c.get(f"/api/v1/workspaces/{ws}/jobs/{job_id}")).json()["data"]
        assert status["state"] == "FINISHED" and status["outcome"] == "PASSED"
        receipt = (await c.get(f"/api/v1/workspaces/{ws}/jobs/{job_id}/validation-receipt")).json()[
            "data"
        ]
        assert receipt["serverCompilationId"] and "runtimeId" not in receipt
        published = await c.post(
            base + "/publish",
            json={"revision": preview["revision"], "validationReceiptId": receipt["id"]},
        )
        assert published.status_code == 201
        vid = published.json()["data"]["id"]
        source = base + f"/versions/{vid}/compiled-source"
        metadata = (await c.get(source)).json()["data"]
        assert metadata["descriptorSha256"] == receipt["compiledBundleSha256"]
        assert metadata["files"] and all(f["path"].endswith(".ts") for f in metadata["files"])
        file = metadata["files"][0]
        async with httpx.AsyncClient(
            base_url=str(c.base_url), cookies=c.cookies, headers=c.headers
        ) as raw:
            response = await raw.get(source, params={"path": file["path"]})
            assert response.status_code == 200
            actual = response.content
            assert sha256(actual).hexdigest() == file["sha256"] and len(actual) == file["sizeBytes"]
            assert response.headers["Content-Type"].startswith("text/plain")
            assert response.headers["X-Content-Type-Options"] == "nosniff"
            assert response.headers["Cache-Control"] == "private, no-store"
            assert "sandbox" in response.headers["Content-Security-Policy"]
            for path in [
                "package.json",
                "../../etc/passwd",
                file["sha256"],
                "trace.zip",
                "source/asset-snapshot.json",
            ]:
                assert (await raw.get(source, params={"path": path})).status_code == 404
            foreign = source.replace(f"/workspaces/{ws}/", f"/workspaces/{other_ws}/")
            assert (await raw.get(foreign, params={"path": file["path"]})).status_code == 404
            second = await c.post(
                f"/api/v1/workspaces/{ws}/resources",
                json={
                    "kind": "DATASET",
                    "key": "data",
                    "name": "Data",
                    "content": {
                        "kind": "DATASET",
                        "document": {
                            "schemaVersion": "1.0",
                            "columns": {"name": "string"},
                            "rows": [{"key": "one", "values": {"name": "literal"}}],
                        },
                    },
                },
            )
            assert second.status_code == 201
            mismatched = source.replace(
                f"/resources/{rid}/", f"/resources/{second.json()['data']['id']}/"
            )
            assert (await raw.get(mismatched, params={"path": file["path"]})).status_code == 404
            # 保持编译描述符和回执原样，先改保存的源码字节，再恢复字节并改记录长度，两次下载请求均应返回 409。
            async with db.sessions.begin() as session:
                artifact = await session.get(Artifact, (ws, file["sha256"]))
                artifact.content = actual + b"tampered"
            corrupt = await raw.get(source, params={"path": file["path"]})
            assert corrupt.status_code == 409 and corrupt.json()["code"] == "INVALID_ARTIFACT"
            async with db.sessions.begin() as session:
                artifact = await session.get(Artifact, (ws, file["sha256"]))
                artifact.content = actual
                artifact.size_bytes = len(actual) + 1
            assert (await raw.get(source, params={"path": file["path"]})).status_code == 409
            async with db.sessions.begin() as session:
                artifact = await session.get(Artifact, (ws, file["sha256"]))
                artifact.size_bytes = len(actual)
            assert (await raw.get(source, params={"path": file["path"]})).content == actual
        uid = await new_member(c, ws, "source-viewer@example.com", "VIEWER")
        async with client(c, "source-viewer@example.com") as viewer:
            assert (await viewer.get(source, params={"path": file["path"]})).status_code == 200
            assert (await viewer.get(foreign, params={"path": file["path"]})).status_code == 403
            assert (await c.delete(f"/api/v1/workspaces/{ws}/members/{uid}")).status_code == 200
            assert (await viewer.get(source, params={"path": file["path"]})).status_code == 403
        # 用服务端 Worker 编译引用缺失元素的用例，检查公开错误码为 UNKNOWN_ELEMENT 且回执查询返回 409。
        bad = await c.post(
            f"/api/v1/workspaces/{ws}/resources",
            json={
                "kind": "CASE",
                "key": "bad",
                "name": "Bad",
                "content": {
                    "kind": "CASE",
                    "document": {
                        "schemaVersion": "1.0",
                        "caseKey": "bad",
                        "title": "Bad",
                        "kind": "READ",
                        "roleKey": "reader",
                        "catalogVersionId": vid,
                        "steps": [{"id": "missing", "action": "click", "target": "missing"}],
                    },
                },
            },
        )
        assert bad.status_code == 201
        bad_base = f"/api/v1/workspaces/{ws}/resources/{bad.json()['data']['id']}"
        candidate = (await c.get(bad_base + "/validation-preview")).json()["data"]
        failed = await c.post(
            bad_base + "/validate",
            json={"revision": candidate["revision"], "sourceHash": candidate["sourceHash"]},
        )
        assert failed.status_code == 202
        await test_agent_mysql.server_compile_once(db, release)
        failed_job = f"/api/v1/workspaces/{ws}/jobs/{failed.json()['data']['id']}"
        failure = (await c.get(failed_job)).json()["data"]
        assert failure["outcome"] == "ERROR" and failure["errorCode"] == "UNKNOWN_ELEMENT"
        assert (
            "issues" not in failure
            and (await c.get(failed_job + "/validation-receipt")).status_code == 409
        )
    finally:
        # 测试结束时恢复共享夹具原先使用的获准清单字节，原先无库存文件时则删除此次创建的测试清单。
        if previous is None:
            approved.unlink(missing_ok=True)
        else:
            approved.write_bytes(previous)


async def test_static_fetch_is_scoped_to_attempt_fence_and_version(site):
    from uuid import uuid4
    from test_lease_mysql import auth, claim_body, queued_browser_jobs
    from veriq_server.auth.authorization import WorkspaceScope
    from veriq_server.contracts import canonical_bytes, asset_source_hash
    from veriq_server.db import Job, CaseExecution
    from veriq_server.repositories.resource import ResourceRepository

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    foreign = await device(c, await workspace(c, "external"))
    (jid,) = await queued_browser_jobs(c, db, ws, 1)
    vid, rid = str(uuid4()), str(uuid4())
    document = {
        "schemaVersion": "1.0",
        "columns": {"n": "string"},
        "rows": [{"key": "k", "values": {"n": "synthetic-正文"}}],
    }
    asset = {
        "resourceId": rid,
        "versionId": vid,
        "kind": "DATASET",
        "document": document,
        "sha256": sha256(canonical_bytes({"kind": "DATASET", "document": document})).hexdigest(),
    }
    async with db.sessions.begin() as session:
        repo = ResourceRepository(session, WorkspaceScope(ws))
        job = await session.get(Job, jid)
        case = await session.get(CaseExecution, job.case_execution_id)
        case_content = {
            "kind": "CASE",
            "document": {
                "schemaVersion": "1.0",
                "caseKey": "case",
                "title": "Case",
                "kind": "READ",
                "roleKey": "reader",
                "catalogVersionId": str(uuid4()),
                "steps": [{"id": "published", "action": "goto", "path": "/"}],
            },
        }
        case_asset = {
            **case_content,
            "versionId": case.case_version_id,
            "resourceId": str(uuid4()),
            "sha256": sha256(canonical_bytes(case_content)).hexdigest(),
        }
        source = {
            "schemaVersion": "1.0",
            "workspaceId": ws,
            "engineVersion": "0.1.0",
            "entryCaseVersionIds": [case.case_version_id],
            "assets": [asset, case_asset],
        }
        source["sourceHash"] = asset_source_hash(source)
        case.source_snapshot_hash = await repo.store(canonical_bytes(source))
        snapshot = {
            "schemaVersion": "2.0",
            "workspaceId": ws,
            "caseExecutionId": case.id,
            "assetSourceHash": source["sourceHash"],
            "datasetVersionId": vid,
            "selectedRow": {
                "versionId": vid,
                "rowKey": "k",
                "rowSha256": sha256(canonical_bytes(document["rows"][0])).hexdigest(),
            },
        }
        display = {
            "schemaVersion": "1.0",
            "cases": [
                {
                    "caseVersionId": case.case_version_id,
                    "caseKey": "case",
                    "title": "Case",
                    "steps": [
                        {
                            "id": "v_" + "a" * 64,
                            "sourceId": "published",
                            "sourcePath": "/assets/0",
                            "action": "goto",
                            "order": 0,
                            "observers": [],
                            "assertions": [],
                        }
                    ],
                }
            ],
        }
        from veriq_server.contracts import validate_schema

        assert not validate_schema("ReportDisplayV1", display)
        file = await repo.store(canonical_bytes(display))
        descriptor = {
            "files": [
                {"path": "metadata/report-display.json", "sha256": file},
                {"path": "source/asset-snapshot.json", "sha256": case.source_snapshot_hash},
            ]
        }
        job.manifest_hash = await repo.store(
            canonical_bytes(
                {
                    "compiledBundleSha256": await repo.store(canonical_bytes(descriptor)),
                    "caseVersionId": case.case_version_id,
                    "engineVersion": "0.1.0",
                }
            )
        )
        job.snapshot_hash = await repo.store(canonical_bytes(snapshot))
        job.required_capabilities = {**job.required_capabilities, "connectedDatasets": "2.0"}
    request = claim_body(d)
    request["capabilities"] = {**request["capabilities"], "connectedDatasets": "2.0"}
    claim = (await c.post("/internal/v1/jobs/claim", json=request, headers=auth(d))).json()["data"]
    path = f"/internal/v1/attempts/{claim['attemptId']}/datasets/static"
    headers = {
        **auth(d),
        "X-VeriQ-Lease-Token": claim["leaseToken"],
        "X-VeriQ-Fencing-Token": str(claim["fencingToken"]),
    }
    selection = {"selection": "DATASET", "versionId": vid}
    proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
    assert (
        await c.post(path.rsplit("/datasets", 1)[0] + "/activate", json=proof, headers=auth(d))
    ).status_code == 200
    base = path.rsplit("/datasets", 1)[0]
    blocked = await c.post(
        base + "/artifact-uploads",
        json={
            **proof,
            "kind": "TRACE",
            "filename": "trace.zip",
            "contentType": "application/octet-stream",
            "sizeBytes": 12,
            "sha256": "1" * 64,
            "sensitivity": "CREDENTIAL_RESTRICTED",
        },
        headers=auth(d),
    )
    assert blocked.status_code == 409 and blocked.json()["code"] == "DATASET_EVIDENCE_FORBIDDEN"
    body = b'{"echo":"synthetic-private-body"}'
    metadata = {
        **proof,
        "kind": "MANIFEST",
        "filename": "completion.json",
        "contentType": "application/octet-stream",
        "sizeBytes": len(body),
        "sha256": sha256(body).hexdigest(),
        "sensitivity": "REDACTED",
    }
    blocked = await c.post(
        base + "/artifact-uploads",
        json={**metadata, "contentType": "synthetic-private-body"},
        headers=auth(d),
    )
    assert blocked.status_code == 409 and blocked.json()["code"] == "DATASET_EVIDENCE_FORBIDDEN"
    allowed = await c.post(base + "/artifact-uploads", json=metadata, headers=auth(d))
    assert allowed.status_code == 201
    upload = allowed.json()["data"]
    blocked = await c.put(
        upload["uploadUrl"] + "?offset=0",
        content=body,
        headers={**headers, "Content-Type": "application/octet-stream"},
    )
    assert blocked.status_code == 409 and blocked.json()["code"] == "DATASET_EVIDENCE_FORBIDDEN"
    from veriq_server.db import AttemptUpload

    async with db.sessions() as session:
        retained = await session.get(AttemptUpload, upload["artifactId"])
        assert not retained.complete and retained.content == b""
    unsafe = {
        "schemaVersion": "1.0",
        "sequence": 1,
        "attemptId": claim["attemptId"],
        "timestamp": claim["serverTime"],
        "type": "ASSERTION_RESULT",
        "stepId": "example",
        "assertionId": "echo",
        "payload": {
            "status": "FAILED",
            "severity": "BLOCK",
            "expectedSource": "published",
            "expected": None,
            "actual": {"present": True, "value": "synthetic-private-body"},
            "durationMs": 1,
        },
    }
    blocked = await c.post(base + "/events", json={**proof, "events": [unsafe]}, headers=auth(d))
    assert blocked.status_code == 409 and blocked.json()["code"] == "DATASET_EVIDENCE_FORBIDDEN"
    from veriq_server.db import AttemptEvent

    location = {k: v for k, v in unsafe.items() if k not in {"payload", "stepId", "assertionId"}}
    private = "private_echo_marker"
    for fact in [
        {"type": "LOG", "payload": {"level": "ERROR", "message": private}},
        {
            **unsafe,
            "payload": {
                **unsafe["payload"],
                "actual": {"present": False},
                "expectedSource": private,
            },
        },
        {"type": "STEP_STARTED", "stepId": private, "payload": {}},
        {"type": "STEP_STARTED", "stepId": "v_" + "a" * 64, "payload": {}},
        {"type": "CLEANUP_RESULT", "payload": {"cleanupStatus": "FAILED", "errorCode": private}},
    ]:
        blocked = await c.post(
            base + "/events", json={**proof, "events": [{**location, **fact}]}, headers=auth(d)
        )
        assert blocked.status_code == 409 and blocked.json()["code"] == "DATASET_EVIDENCE_FORBIDDEN"
    async with db.sessions() as session:
        assert await session.get(AttemptEvent, (claim["attemptId"], 1)) is None
    response = await c.post(path, json=selection, headers=headers)
    assert response.status_code == 200, response.text
    assert response.content == canonical_bytes(document)
    row = await c.post(
        path, json={"selection": "ROW", "versionId": vid, "rowKey": "k"}, headers=headers
    )
    assert row.content == canonical_bytes(document["rows"][0])
    for args in [
        {**selection, "versionId": str(uuid4())},
        {"selection": "VALIDATION_SOURCE"},
        {"selection": "ROW", "versionId": vid, "rowKey": "different"},
    ]:
        assert (await c.post(path, json=args, headers=headers)).status_code == 403
    assert (
        await c.post(path, json=selection, headers={**headers, **auth(foreign)})
    ).status_code == 403
    stale = {**headers, "X-VeriQ-Fencing-Token": str(claim["fencingToken"] + 1)}
    assert (await c.post(path, json=selection, headers=stale)).status_code == 409
    await c.post(f"/api/v1/workspaces/{ws}/runtimes/{d['runnerId']}/revoke", json={})
    assert (await c.post(path, json=selection, headers=headers)).status_code == 401


@pytest.fixture
async def dataset_wire(monkeypatch):
    """真实回环服务器按线上的路径记录每一笔请求，测试只替换部署目标套接字，继续使用 HTTPX 完整收发响应。"""
    from veriq_server.datasets import request

    calls = []
    state = {}

    async def serve(reader, writer):
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            method, target, _ = head.split(b"\r\n", 1)[0].split()
            assert method == b"GET"
            calls.append(target)
            body = json.dumps(state["read"](target)).encode()
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                + str(len(body)).encode()
                + b"\r\n\r\n"
                + body
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    async with await asyncio.start_server(serve, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]

        class Loopback(httpx.AsyncHTTPTransport):
            async def handle_async_request(self, req):
                req.url = req.url.copy_with(scheme="http", host="127.0.0.1", port=port)
                return await super().handle_async_request(req)

        monkeypatch.setattr(request, "open_transport", Loopback)
        yield calls, state


@pytest.mark.parametrize("live", [False, True], ids=["static", "http"])
async def test_legacy_published_dataset_revalidation_uses_frozen_original(
    site, business, dataset_deployment, dataset_wire, live
):
    from uuid import uuid4
    from sqlalchemy import select
    from test_publish import create, publish
    from test_runs_mysql import environment, published
    from test_lease_mysql import auth, claim_body
    from veriq_server.db import (
        Attempt,
        AttemptEvent,
        AttemptUpload,
        Job,
        ResourceVersion,
        Runtime,
        ValidationReceipt,
    )
    from veriq_server.contracts import canonical_bytes

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    runtime_url = f"/api/v1/workspaces/{ws}/runtimes/{d['runnerId']}"
    assert (
        await c.put(
            runtime_url + "/grants",
            json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
        )
    ).status_code == 200
    assert (
        await c.put(
            runtime_url + "/trust", json={"trustStatus": "MANAGED", "allowCredentialDelivery": True}
        )
    ).status_code == 200
    origin, facts = business
    env = await environment(c, db, ws, origin=origin, identity_path="/identity", token="CAS")
    catalog = await published(
        c,
        db,
        ws,
        "elems",
        "ELEMENT_CATALOG",
        {
            "schemaVersion": "1.0",
            "elements": [{"key": "e", "locator": {"by": "veriqId", "value": "e"}}],
        },
    )
    marker = "TASK-SCOPED-PRIVATE-ECHO-41873"
    payload = marker + "正文😀" * 8000
    assert len(payload.encode()) > 65536
    expected_row = {
        "key": "first",
        "values": {"label": payload, "lookup": "first", "path": marker},
    }
    dataset = {
        "kind": "DATASET",
        "document": {
            "schemaVersion": "1.0",
            "columns": {"label": "string", "lookup": "string", "path": "string"},
            "rows": [json.loads(json.dumps(expected_row))],
        },
    }
    data_path = await create(c, ws, "rows", dataset)
    dataset_version, _, _ = await publish(c, db, data_path)
    document = {
        "schemaVersion": "1.0",
        "caseKey": "frozen",
        "title": "Frozen original",
        "kind": "READ",
        "roleKey": "reader",
        "catalogVersionId": catalog,
        "datasetVersionId": dataset_version["id"],
        "datasetBindings": {"labels": dataset_version["id"]},
        "steps": [
            {
                "id": "go",
                "action": "goto",
                "path": "/verified?echo={{data.path}}",
                "afterAssertions": [
                    {
                        "id": "echo",
                        "type": "url",
                        "source": "page",
                        "operator": "contains",
                        "severity": "BLOCK",
                        "expectedSource": "Published CAST route prefix",
                        "expected": "/verified",
                    },
                    {
                        "id": "url",
                        "type": "url",
                        "source": "page",
                        "operator": "contains",
                        "severity": "BLOCK",
                        "expectedSource": "Published expected route",
                        "datasetExpected": {
                            "op": "field",
                            "alias": "labels",
                            "key": "{{data.lookup}}",
                            "field": "path",
                        },
                    },
                ],
            }
        ],
    }
    editor = await new_member(c, ws, "previous-publisher@example.com", "ADMIN")
    executor_id = await new_member(c, ws, "current-executor@example.com", "EXECUTOR")
    http_calls, wire = dataset_wire
    phase_targets = [b"/items?q=first&q=", b"/items?q=first&q=", b"/items?q=second&q="]
    if live:
        from test_http_datasets import config, connection, REF

        actor = (await c.get("/api/v1/account")).json()["data"]["id"]
        remote = config()
        remote["source"].update(environmentVersionId=env, auth={"kind": "NONE"})
        dataset_deployment[REF] = connection().model_copy(
            update={
                "workspace_id": ws,
                "environment_version_id": env,
                "user_ids": [actor, editor, executor_id],
                "auth_kinds": ["NONE"],
            }
        )
        remote_path = await create(c, ws, "live", {"kind": "DATASET", "document": remote})
        remote_version, _, _ = await publish(c, db, remote_path)
        live_id = remote_version["id"]
        document["datasetBindings"]["remote"] = live_id
        checks = document["steps"][0]["afterAssertions"]
        checks.append(
            {
                **checks[-1],
                "id": "online",
                "datasetExpected": {
                    "op": "field",
                    "alias": "remote",
                    "key": "first",
                    "field": "label",
                    "parameters": {"search": "{{data.lookup}}"},
                },
            }
        )

        primary = checks[-1]

        def sampled(name, key, search):
            return {
                **primary,
                "id": name,
                "datasetExpected": {
                    **primary["datasetExpected"],
                    "key": key,
                    "parameters": {"search": search},
                },
            }

        document["steps"][0]["beforeAssertions"] = [
            sampled("preA", "common", "{{data.lookup}}"),
            sampled("preB", "common", "{{data.lookup}}"),
        ]
        checks.extend(
            [sampled("repeat", "first", "{{data.lookup}}"), sampled("different", "first", "second")]
        )

        def response(target):
            transient = wire.get("mismatch") and target == phase_targets[-1]
            return {
                "items": [
                    {"id": "first", "name": "missing-on-first-attempt" if transient else marker},
                    {"id": "common", "name": ":"},
                    {"id": "unused", "name": payload},
                ]
            }

        wire["read"] = response
    case_path = await create(c, ws, "legacy", {"kind": "CASE", "document": document})
    async with client(c, "previous-publisher@example.com") as publisher:
        version, original_receipt, original = await publish(publisher, db, case_path)
    assert (await c.delete(f"/api/v1/workspaces/{ws}/members/{editor}")).status_code == 200
    updated = {
        **document,
        "title": "Newer draft",
        "steps": [{"id": "bad", "action": "click", "target": "absent"}],
    }
    assert (
        await c.put(
            case_path + "/draft",
            json={"revision": 1, "content": {"kind": "CASE", "document": updated}},
        )
    ).status_code == 200
    dataset["document"]["rows"][0]["values"]["label"] = "CHANGED"
    assert (
        await c.put(data_path + "/draft", json={"revision": 1, "content": dataset})
    ).status_code == 200

    process = await asyncio.create_subprocess_exec(
        "node",
        "apps/web/tests/prepare-editor-agent.mjs",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    assert process.returncode == 0, stderr.decode()
    release = Path(".superpowers/cache/t11/release").resolve()
    config = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
    approved = Path(config["approved_engine_inventory_path"])
    previous = approved.read_bytes() if approved.exists() else None
    profile = Path(tempfile.mkdtemp(prefix="vq5-", dir="/tmp"))
    try:
        approved.write_bytes((release / "inventory.json").read_bytes())
        generated_url = case_path + f"/versions/{version['id']}/compiled-source"
        assert (await c.get(generated_url)).status_code == 409
        selection = {
            "caseVersionIds": [version["id"]],
            "environmentVersionId": env,
            "roleKeys": ["reader"],
            "browsers": ["chromium"],
            "runtimeIds": [d["runnerId"]],
        }
        async with db.sessions.begin() as session:
            from veriq_server.repositories.resource import ResourceRepository
            from veriq_server.auth.authorization import WorkspaceScope

            repo = ResourceRepository(session, WorkspaceScope(ws))
            frozen_receipt = await session.get(ValidationReceipt, original_receipt)
            original_bundle = frozen_receipt.compiled_bundle_sha256
            descriptor = json.loads((await repo.artifact(original_bundle)).content)
            member = next(
                f for f in descriptor["files"] if f["path"] == "source/asset-snapshot.json"
            )
            wrong = next(f for f in descriptor["files"] if f["path"] == "entry.ts")
            member.update(sha256=wrong["sha256"], sizeBytes=wrong["sizeBytes"])
            frozen_receipt.compiled_bundle_sha256 = await repo.store(canonical_bytes(descriptor))
        async with client(c, "current-executor@example.com") as executor:
            endpoint = f"/api/v1/workspaces/{ws}/runs"
            mismatch = await executor.post(
                endpoint, headers={"Idempotency-Key": str(uuid4())}, json=selection
            )
            assert (
                mismatch.status_code == 409
                and mismatch.json()["code"] == "COMPILED_PROVENANCE_REQUIRED"
            )
            assert not list(profile.iterdir())
            async with db.sessions.begin() as session:
                frozen_receipt = await session.get(ValidationReceipt, original_receipt)
                frozen_receipt.compiled_bundle_sha256 = original_bundle
            rsp = await executor.post(
                endpoint, headers={"Idempotency-Key": str(uuid4())}, json=selection
            )
        assert rsp.status_code == 202, rsp.text
        run_id = rsp.json()["data"]["id"]
        async with db.sessions.begin() as session:
            job = (await session.execute(select(Job).where(Job.run_id == run_id))).scalar_one()
            migration_id = job.required_capabilities["validationJobId"]
            test_id = job.id
            old_receipt = await session.get(ValidationReceipt, original_receipt)
            old_bundle = old_receipt.compiled_bundle_sha256
            runtime = await session.get(Runtime, d["runnerId"])
            runtime.capabilities = {**runtime.capabilities, "connectedDatasets": "2.0"}
        assert (
            await c.post("/internal/v1/jobs/claim", headers=auth(d), json=claim_body(d))
        ).status_code == 204
        claim_request = claim_body(d)
        claim_request["capabilities"] = {
            **claim_request["capabilities"],
            "connectedDatasets": "2.0",
        }
        if live:
            old_static = await c.post(
                "/internal/v1/jobs/claim", headers=auth(d), json=claim_request
            )
            assert old_static.status_code == 204
            claim_request.update(clientRequestId=str(uuid4()))
            claim_request["capabilities"]["httpDatasets"] = "1.0"
        assert (
            await c.post("/internal/v1/jobs/claim", headers=auth(d), json=claim_request)
        ).status_code == 204
        claim_request["clientRequestId"] = str(uuid4())
        (profile / "agent").mkdir(mode=0o700)
        (profile / "agent/claim-request.json").write_text(json.dumps(claim_request))
        (profile / "device.json").write_text(json.dumps({"server": "http://127.0.0.1:18889", **d}))
        os.chmod(profile / "device.json", 0o600)

        # 已有历史报告库与联网 Agent 共用档案，真实 CLI 建库后记录其逻辑内容，覆盖 WAL/SQLite 数据的检查。
        history = await asyncio.create_subprocess_exec(
            "node",
            "--import",
            "tsx",
            "src/cli.ts",
            "--config-dir",
            str(profile),
            "results",
            "history",
            "--workspace",
            ws,
            cwd="apps/runtime",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        output, errors = await history.communicate()
        assert history.returncode == 0 and json.loads(output) == [], errors.decode()
        import sqlite3

        history_path = profile / "offline/veriq.sqlite"
        with sqlite3.connect(history_path.as_uri() + "?mode=ro", uri=True) as historical:
            history_before = list(historical.iterdump())

        scratch_parent = profile / "scratch"
        scratch_parent.mkdir(mode=0o700)

        async def launch(*args):
            return await asyncio.create_subprocess_exec(
                "node",
                "--import",
                "tsx",
                "tests/support/run-connected-attempt.ts",
                str(profile),
                str(release),
                "/usr/bin/chromium",
                *args,
                env={**os.environ, "TMPDIR": str(scratch_parent)},
                cwd="apps/runtime",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

        async def finish(child):
            _, err = await child.communicate()
            assert child.returncode == 0, err.decode()

        await test_agent_mysql.server_compile_once(db, release)
        async with db.sessions() as session:
            migrated = await session.get(Job, migration_id)
            assert migrated.outcome == "PASSED", (migrated.state, migrated.outcome)
            assert migrated.active_attempt_id is None
            assert not (
                await session.scalars(select(Attempt).where(Attempt.job_id == migration_id))
            ).all()
            new_receipt = (
                await session.execute(
                    select(ValidationReceipt).where(ValidationReceipt.job_id == migration_id)
                )
            ).scalar_one()
            assert (
                new_receipt.source_hash == original["sourceHash"]
                and new_receipt.compiled_bundle_sha256 != old_bundle
            )
            assert new_receipt.server_compilation_id == migrated.server_compilation_id
            assert (
                await session.get(ResourceVersion, version["id"])
            ).receipt_id == original_receipt
            assert (
                await session.get(ValidationReceipt, original_receipt)
            ).compiled_bundle_sha256 == old_bundle
        view = await c.get(generated_url)
        assert view.status_code == 200, view.text
        assert view.json()["data"]["descriptorSha256"] == new_receipt.compiled_bundle_sha256
        await finish(await launch())
        async with db.sessions() as session:
            test_job = await session.get(Job, test_id)
            assert (test_job.state, test_job.outcome) == ("FINISHED", "PASSED"), (
                test_job.state,
                test_job.wait_reason,
                test_job.outcome,
            )
        async with db.sessions() as session:
            attempt = (
                await session.execute(select(Attempt).where(Attempt.job_id == test_id))
            ).scalar_one()
            events = list(
                (
                    await session.scalars(
                        select(AttemptEvent.document).where(AttemptEvent.attempt_id == attempt.id)
                    )
                ).all()
            )
            uploads = list(
                (
                    await session.scalars(
                        select(AttemptUpload.metadata_json).where(
                            AttemptUpload.attempt_id == attempt.id
                        )
                    )
                ).all()
            )
            assert marker not in json.dumps(events)
            assert {entry["kind"] for entry in uploads} == {"MANIFEST"}
            assertions = [event for event in events if event["type"] == "ASSERTION_RESULT"]
            assert len(assertions) == (7 if live else 2) and all(
                event["payload"]["status"] == "PASSED" for event in assertions
            )
            assert all(event["payload"]["actual"] == {"present": False} for event in assertions)
            static = [e for e in assertions if "sample" not in e["payload"]]
            assert len(static) == 2
            assert static[0]["payload"]["expectedSource"] == "CASE"
            assert all("Published CAST" not in json.dumps(event) for event in assertions)
            assert dataset_version["id"] in static[1]["payload"]["expectedSource"]
            if live:
                assert http_calls == phase_targets
                remote_payload = assertions[-1]["payload"]
                assert remote_payload["expectedSource"] == "DATASET:" + live_id
                assert remote_payload["sample"]["sourceVersionId"] == live_id
                assert set(remote_payload["sample"]) == {"sourceVersionId", "fetchedAt"}
                times = [
                    e["payload"]["sample"]["fetchedAt"]
                    for e in assertions
                    if "sample" in e["payload"]
                ]
                assert len(times) == 5 and times[0] == times[1] and times[2] == times[3]
                history = await c.get(f"/api/v1/workspaces/{ws}/attempts/{attempt.id}/history")
                assert history.status_code == 200, history.text
                reported = history.json()["data"]
                normalized = next(
                    e
                    for e in reported["items"]
                    if e.get("assertionId") == assertions[-1]["assertionId"]
                )
                assert normalized["payload"]["sample"] == remote_payload["sample"]
                assert marker not in json.dumps(reported)
        assert facts["echo"] == marker
        # 相同执行主体随后再次运行同一发布版本，应复用已经成功的独立验证，不能改写回执或重复创建验证任务。
        async with client(c, "current-executor@example.com") as executor:
            rerun = await executor.post(
                endpoint,
                headers={"Idempotency-Key": str(uuid4())},
                json={**selection, "maxRetries": 1 if live else 0},
            )
            assert rerun.status_code == 202, rerun.text
        async with db.sessions() as session:
            queued = (
                await session.execute(select(Job).where(Job.run_id == rerun.json()["data"]["id"]))
            ).scalar_one()
            assert queued.required_capabilities["validationJobId"] == migration_id
        workdirs = list((profile / "agent/work").iterdir())
        assert len(workdirs) == 2
        for directory in workdirs:
            assert (directory / "completion.json").exists()
        for file in profile.rglob("*"):
            if file.is_file() and not file.is_symlink():
                assert marker.encode() not in file.read_bytes(), file
        testdir = next(
            directory for directory in workdirs if (directory / "execution.json").exists()
        )
        selected = json.loads((testdir / "execution.json").read_bytes())["selectedRow"]
        assert selected["rowSha256"] == sha256(canonical_bytes(expected_row)).hexdigest()

        def inspect_files(directory):
            # 实际运行中的浏览器会原子替换单个临时文件，只忽略检查时已经消失的名字，不跟随浏览器进程创建的链接。
            for item in directory.rglob("*"):
                try:
                    if item.is_file() and not item.is_symlink():
                        content = item.read_bytes()
                        for encoding in ("utf-8", "utf-16le"):
                            assert marker.encode(encoding) not in content, item
                except FileNotFoundError:
                    continue

        # 目标网页已接收冻结值之后分别观察真实业务失败、心跳取消和宿主 SIGKILL；后者由新进程取得原生停止证明。
        if live:
            wire["mismatch"] = True
        else:
            facts["echo_mode"] = "fail"
        await finish(await launch())
        async with db.sessions() as session:
            failed = (
                await session.scalars(select(Attempt).where(Attempt.job_id == queued.id))
            ).one()
            assert failed.outcome == "FAILED", failed.facts
            failed_facts = list(
                (
                    await session.scalars(
                        select(AttemptEvent.document).where(AttemptEvent.attempt_id == failed.id)
                    )
                ).all()
            )
            assert marker not in json.dumps(failed_facts)
            assert any(
                e["type"] == "ASSERTION_RESULT"
                and e["payload"]["status"] == "FAILED"
                and e["payload"]["errorCode"] == "ASSERTION_FAILED"
                for e in failed_facts
            )
        if live:
            assert http_calls == phase_targets * 2
            async with db.sessions() as session:
                waiting = await session.get(Job, queued.id)
                assert waiting.state == "QUEUED", failed.facts
            wire["mismatch"] = False
            await finish(await launch())
            async with db.sessions() as session:
                attempts = (
                    await session.scalars(
                        select(Attempt)
                        .where(Attempt.job_id == queued.id)
                        .order_by(Attempt.attempt_no)
                    )
                ).all()
                assert [(a.attempt_no, a.outcome) for a in attempts] == [
                    (1, "FAILED"),
                    (2, "PASSED"),
                ]
                assert attempts[0].id != attempts[1].id
            assert http_calls == phase_targets * 3
        for end in ["cancel", "crash"]:
            facts["echo_mode"] = "hold"
            facts["echo_observed"].clear()
            facts["echo_release"].clear()
            async with client(c, "current-executor@example.com") as executor:
                new = await executor.post(
                    endpoint, headers={"Idempotency-Key": str(uuid4())}, json=selection
                )
            assert new.status_code == 202, new.text
            rid = new.json()["data"]["id"]
            agent = await launch()
            try:
                await asyncio.wait_for(facts["echo_observed"].wait(), 60)
                async with db.sessions() as session:
                    active_job = (await session.scalars(select(Job).where(Job.run_id == rid))).one()
                    active_id = active_job.active_attempt_id
                active_journal = json.loads(
                    (profile / "agent/attempts" / (active_id + ".json")).read_bytes()
                )
                scratch = scratch_parent / active_journal["allocation"]["temporaryName"]
                assert scratch.is_dir()
                await asyncio.to_thread(inspect_files, scratch)
                await asyncio.to_thread(inspect_files, profile)
                if end == "cancel":
                    # 使用有效设备、当前围栏和同一真实编译断言，仅替换出处。两种伪造均须在写入前拒绝。
                    async with db.sessions() as session:
                        active = await session.get(Attempt, active_id)
                        sequence = active.last_sequence + 1
                    confirmed = assertions[-1]
                    for name in [marker, assertions[0]["payload"]["expectedSource"]]:
                        forged = {
                            **confirmed,
                            "attemptId": active_id,
                            "sequence": sequence,
                            "payload": {**confirmed["payload"], "expectedSource": name},
                        }
                        proof = {
                            key: active_journal["claim"][key]
                            for key in ["leaseToken", "fencingToken"]
                        }
                        rejected = await c.post(
                            f"/internal/v1/attempts/{active_id}/events",
                            json={**proof, "events": [forged]},
                            headers=auth(json.loads((profile / "device.json").read_bytes())),
                        )
                        assert rejected.status_code == 409
                        assert rejected.json()["code"] == "DATASET_EVIDENCE_FORBIDDEN"
                    response = await c.post(
                        endpoint + "/" + rid + "/cancel", json={"reason": "Privacy test"}
                    )
                    assert response.status_code == 200, response.text
                    await asyncio.wait_for(finish(agent), 50)
                else:
                    agent.kill()
                    await agent.wait()
                    assert agent.returncode == -9
                    await finish(await launch("recover"))
            finally:
                facts["echo_release"].set()
                if agent.returncode is None:
                    agent.kill()
                    await agent.wait()
            async with db.sessions() as session:
                job = (await session.scalars(select(Job).where(Job.run_id == rid))).one()
                attempt = (
                    await session.scalars(select(Attempt).where(Attempt.job_id == job.id))
                ).one()
                if end == "cancel":
                    assert attempt.outcome == "CANCELLED", attempt.facts
                retained = list(
                    (
                        await session.scalars(
                            select(AttemptEvent.document).where(
                                AttemptEvent.attempt_id == attempt.id
                            )
                        )
                    ).all()
                )
                assert marker not in json.dumps(retained)
            journal = json.loads((profile / "agent/attempts" / (attempt.id + ".json")).read_bytes())
            assert journal["stop"]["processStopScope"] == "FULL_DESCENDANT_TREE"
            tombstone = scratch_parent / journal["allocation"]["temporaryName"]
            modules = Path(journal["work"]) / "node_modules"
            await asyncio.to_thread(inspect_files, tombstone)
            assert (tombstone / ".veriq-retirement-inventory").is_file()
            assert (modules / ".veriq-retired").is_file()
            assert journal["dataCleanup"] == "OWNERSHIP_UNCONFIRMED"
        for file in profile.rglob("*"):
            if file.is_file() and not file.is_symlink():
                assert marker.encode() not in file.read_bytes(), file
        with sqlite3.connect(history_path.as_uri() + "?mode=ro", uri=True) as historical:
            history_after = list(historical.iterdump())
            assert history_before == history_after
            assert marker not in "\n".join(history_after)
    finally:
        shutil.rmtree(profile)
        if previous is None:
            approved.unlink(missing_ok=True)
        else:
            approved.write_bytes(previous)


async def test_mvp_exposes_connected_runtime_only(site):
    c, _db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    base = f"/api/v1/workspaces/{ws}"
    for path in ("bundles", "result-imports", "result-import-uploads"):
        response = await c.post(base + "/" + path, json={})
        assert response.status_code == (405 if path == "bundles" else 404), (
            path,
            response.status_code,
        )
    assert (await c.get(base + "/runtimes")).status_code == 200


def test_protected_occurrences_expand_only_frozen_case_and_resolve_parameter_provenance():
    from veriq_server.services.connected_datasets import protected_occurrences

    def wire(path: str) -> str:
        return "v_" + sha256(path.encode("utf8")).hexdigest()

    tree = {
        "assets": [
            {"versionId": "dataset", "kind": "DATASET", "document": {"fields": {"value": {}}}},
            {
                "versionId": "case",
                "kind": "CASE",
                "document": {
                    "steps": [
                        {
                            "action": "callFlow",
                            "versionId": "flow",
                            "parameters": {"value": "literal", "fromMatrix": "{{data.value}}"},
                        }
                    ]
                },
            },
            {
                "versionId": "flow",
                "kind": "FLOW",
                "document": {
                    "steps": [
                        {
                            "action": "goto",
                            "observers": [{"id": "realObserver"}],
                            "afterAssertions": [
                                {
                                    "type": "template",
                                    "versionId": "template",
                                    "severity": "WARN",
                                    "parameters": {"carried": "{{data.fromMatrix}}"},
                                }
                            ],
                        }
                    ]
                },
            },
            {
                "versionId": "template",
                "kind": "ASSERTION_TEMPLATE",
                "document": {
                    "assertions": [
                        {"type": "url", "severity": "BLOCK", "expected": "{{data.value}}"},
                        {"type": "url", "severity": "BLOCK", "expected": "{{data.carried}}"},
                        {"type": "url", "severity": "BLOCK", "datasetExpected": {"alias": "named"}},
                        {
                            "type": "responseSchema",
                            "severity": "BLOCK",
                            "expected": {"const": "{{data.carried}}"},
                        },
                    ]
                },
            },
            {"versionId": "other", "kind": "CASE", "document": {"steps": [{"action": "goto"}]}},
        ]
    }
    steps, sources = protected_occurrences(
        tree, "case", {"datasetVersionId": "dataset", "datasetBindings": {"named": "named-version"}}
    )
    root = "/assets/1/document/steps/0"
    nested = root + "/flow/0"
    assert steps == {wire(root): set(), wire(nested): {"realObserver"}}
    assert [
        sources[wire(nested), wire(nested + f"/afterAssertions/0/template/{i}")] for i in range(4)
    ] == [
        ("CASE", "WARN"),
        ("DATASET:dataset", "WARN"),
        ("DATASET:named-version", "WARN"),
        ("CASE", "WARN"),
    ]


async def test_http_dataset_rechecks_access_before_delivery(dataset_deployment, site, monkeypatch):
    """在独立的回环上游收到请求后撤销真实凭证，证明交付前重新校验，同时观察未绑定版本与旧围栏不会发包。"""
    from uuid import uuid4
    from test_http_datasets import REF, config, connection
    from test_lease_mysql import auth, claim_body
    from test_runs_mysql import environment, published
    from test_publish import create, queue, completed
    from veriq_server.auth.authorization import WorkspaceScope
    from veriq_server.services.connected_datasets import protected_event_context
    from veriq_server.datasets import request
    from veriq_server.db import Job, Attempt
    from veriq_server.repositories.resource import ResourceRepository

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    actor = (await c.get("/api/v1/account")).json()["data"]["id"]
    cred = f"/api/v1/workspaces/{ws}/credentials"
    secret = await c.post(
        cred,
        json={
            "secretRef": "catalog",
            "value": {"value": "synthetic-key"},
            "allowedIdentityIds": ["dataset-reader"],
        },
    )
    assert secret.status_code == 201
    key = secret.json()["data"]["versionId"]
    env = await environment(c, db, ws)
    deployment = connection()
    dataset_deployment[REF] = deployment.model_copy(
        update={
            "workspace_id": ws,
            "environment_version_id": env,
            "user_ids": [actor],
            "credentials": {
                "catalog": deployment.credentials["catalog"].model_copy(update={"version_id": key})
            },
        }
    )
    doc = config()
    doc["source"]["environmentVersionId"] = env
    doc["source"]["auth"]["secretVersionId"] = key
    doc["source"]["pagination"] = {
        "kind": "PAGE",
        "parameter": "page",
        "next": "/more",
        "maxPages": 1,
    }
    versions = [await published(c, db, ws, name, "DATASET", doc) for name in ("named", "other")]
    catalog = await published(
        c,
        db,
        ws,
        "catalog",
        "ELEMENT_CATALOG",
        {
            "schemaVersion": "1.0",
            "elements": [{"key": "label", "locator": {"by": "veriqId", "value": "label"}}],
        },
    )
    cases = []
    for name, value in zip(("named", "other"), versions):
        checks = [
            {
                "id": level.lower(),
                "type": "url",
                "operator": "contains",
                "source": "page",
                "expectedSource": "catalog",
                "severity": level,
                "datasetExpected": {
                    "op": "field",
                    "alias": name,
                    "key": "one",
                    "field": "label",
                    "parameters": {"search": "one"},
                },
            }
            for level in ("WARN", "BLOCK")
        ]
        cases.append(
            await published(
                c,
                db,
                ws,
                name + "Case",
                "CASE",
                {
                    "schemaVersion": "1.0",
                    "caseKey": name,
                    "title": name,
                    "kind": "READ",
                    "roleKey": "reader",
                    "catalogVersionId": catalog,
                    "datasetBindings": {name: value},
                    "steps": [
                        {"id": "home", "action": "goto", "path": "/", "afterAssertions": checks}
                    ],
                },
            )
        )
    suite = await create(
        c,
        ws,
        "suite",
        {
            "kind": "SUITE",
            "document": {"schemaVersion": "1.0", "cases": [{"versionId": case} for case in cases]},
        },
    )
    preview, validate = await queue(c, suite)
    receipt, _ = await completed(db, validate["id"], connected=True)
    pub = await c.post(
        suite + "/publish", json={"revision": preview["revision"], "validationReceiptId": receipt}
    )
    assert pub.status_code == 201, pub.text
    selection = {
        "suiteVersionId": pub.json()["data"]["id"],
        "environmentVersionId": env,
        "roleKeys": ["reader"],
        "browsers": ["chromium"],
        "runtimeIds": [d["runnerId"]],
    }
    submit = await c.post(
        f"/api/v1/workspaces/{ws}/runs", headers={"Idempotency-Key": str(uuid4())}, json=selection
    )
    assert submit.status_code == 202, submit.text
    body = claim_body(d)
    body["capabilities"] = {**body["capabilities"], "connectedDatasets": "2.0"}
    old = await c.post("/internal/v1/jobs/claim", json=body, headers=auth(d))
    assert old.status_code == 204
    body = {
        **body,
        "clientRequestId": str(uuid4()),
        "capabilities": {**body["capabilities"], "httpDatasets": "1.0"},
    }
    claimed = await c.post("/internal/v1/jobs/claim", json=body, headers=auth(d))
    assert claimed.status_code == 200, claimed.text
    claim = claimed.json()["data"]
    jid = claim["jobId"]
    async with db.sessions() as session:
        job = await session.get(Job, jid)
        attempt = await session.get(Attempt, claim["attemptId"])
        repo = ResourceRepository(session, WorkspaceScope(ws))
        ctx = await protected_event_context(repo, attempt, job)
        vid = next(iter(ctx["httpAssertions"].values()))
        other = next(v for v in versions if v != vid)
    base = f"/internal/v1/attempts/{claim['attemptId']}"
    headers = {
        **auth(d),
        "X-VeriQ-Lease-Token": claim["leaseToken"],
        "X-VeriQ-Fencing-Token": str(claim["fencingToken"]),
    }
    activated = await c.post(
        base + "/activate",
        headers=auth(d),
        json={k: claim[k] for k in ["fencingToken", "leaseToken"]},
    )
    assert activated.status_code == 200, activated.text
    calls = []
    started, release = asyncio.Event(), asyncio.Event()
    disconnected = asyncio.Event()
    mode = "empty"

    async def upstream(reader, writer):
        wire = await reader.readuntil(b"\r\n\r\n")
        calls.append(wire.split(b"\r\n", 1)[0])
        assert b"x-signature:" in wire.lower()
        if mode in {"timeout", "abandon"}:
            if mode == "abandon":
                started.set()
            await reader.read(1)
            disconnected.set()
            writer.close()
            await writer.wait_closed()
            return
        if mode == "revoke":
            started.set()
            await release.wait()
        payload = json.dumps({"items": [], "more": mode == "partial"}).encode()
        status = b"401 Unauthorized" if mode == "reject" else b"200 OK"
        writer.write(
            b"HTTP/1.1 "
            + status
            + b"\r\nContent-Type: application/json\r\nContent-Length: "
            + str(len(payload)).encode()
            + b"\r\nConnection: close\r\n\r\n"
            + payload
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    proof = {k: claim[k] for k in ("leaseToken", "fencingToken")}
    deadline_events = [
        {
            "schemaVersion": "1.0",
            "sequence": seq,
            "attemptId": claim["attemptId"],
            "timestamp": claim["serverTime"],
            "type": "ASSERTION_RESULT",
            "stepId": step,
            "assertionId": assertion,
            "payload": {
                "expectedSource": "PROTECTED_CASE",
                "status": "ERROR",
                "severity": ctx["sources"][step, assertion][1],
                "errorCode": "BUSINESS_TIMEOUT",
                "durationMs": 0,
                "expected": None,
                "actual": {"present": False},
            },
        }
        for seq, (step, assertion) in enumerate(ctx["httpAssertions"], 1)
    ]
    assert {e["payload"]["severity"] for e in deadline_events} == {"WARN", "BLOCK"}
    events_url = base + "/events"
    for event in deadline_events:
        severity = event["payload"]["severity"]
        for status in ("PASSED", "WARN" if severity == "WARN" else "FAILED"):
            invalid = {**event, "sequence": 1, "payload": {**event["payload"], "status": status}}
            rejected = await c.post(
                events_url, headers=auth(d), json={**proof, "events": [invalid]}
            )
            assert (
                rejected.status_code == 409
                and rejected.json()["code"] == "DATASET_EVIDENCE_FORBIDDEN"
            )
    accepted = await c.post(events_url, headers=auth(d), json={**proof, "events": deadline_events})
    assert accepted.status_code == 200, accepted.text

    async with await asyncio.start_server(upstream, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]

        class Loopback(httpx.AsyncHTTPTransport):
            async def handle_async_request(self, req):
                req.url = req.url.copy_with(scheme="http", host="127.0.0.1", port=port)
                return await super().handle_async_request(req)

        monkeypatch.setattr(request, "open_transport", Loopback)

        async def fetch(version=vid, proof_headers=None):
            return await c.post(
                base + "/datasets/http",
                headers=proof_headers or headers,
                json={"versionId": version, "parameters": {"search": "one"}},
            )

        assert (await fetch(other)).status_code == 403
        assert (
            await fetch(proof_headers={**headers, "X-VeriQ-Fencing-Token": "999"})
        ).status_code == 409
        assert calls == []
        empty = await fetch()
        assert empty.status_code == 200, empty.text
        assert empty.json()["rows"] == [] and empty.json()["sourceVersionId"] == vid
        assert empty.headers["cache-control"] == "no-store"
        for mode, code in [
            ("reject", "DATASET_UPSTREAM_REJECTED"),
            ("partial", "DATASET_PAGINATION_INCOMPLETE"),
            ("timeout", "DATASET_REQUEST_TIMEOUT"),
        ]:
            assert (await fetch()).json()["code"] == code
        mode = "abandon"
        started.clear()
        disconnected.clear()
        pending = asyncio.create_task(fetch())
        await asyncio.wait_for(started.wait(), 2)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        await asyncio.wait_for(disconnected.wait(), 1.5)
        started.clear()
        # 以实际计划绑定和服务令牌重新读取。创建者仍然获准使用此连接，但不能代替服务账号自己的明确授权。
        from veriq_server.db import ExecutionPlan, Run
        from veriq_server.service import now

        plan = str(uuid4())
        async with db.sessions.begin() as session:
            session.add(
                ExecutionPlan(
                    id=plan,
                    workspace_id=ws,
                    name="Sample",
                    created_by=actor,
                    created_at=now(),
                    selection={"runtimeIds": [d["runnerId"]]},
                )
            )
        acc = await c.post(
            f"/api/v1/workspaces/{ws}/service-accounts", json={"name": "Sample account"}
        )
        assert acc.status_code == 201
        account = acc.json()["data"]["id"]
        token = await c.post(
            f"/api/v1/workspaces/{ws}/service-accounts/{account}/tokens",
            json={"purpose": "EXECUTION", "operations": ["trigger"], "planIds": [plan]},
        )
        assert token.status_code == 201
        token_id = token.json()["data"]["id"]
        shared = await c.put(
            f"/api/v1/workspaces/{ws}/runtimes/{d['runnerId']}/grants",
            json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
        )
        assert shared.status_code == 200
        async with db.sessions.begin() as session:
            job = await session.get(Job, jid)
            run = await session.get(Run, job.run_id)
            run.plan_id = plan
            run.requester_service_token_id = job.requester_service_token_id = token_id
        mode = "empty"
        assert (await fetch()).status_code == 422 and len(calls) == 5
        dataset_deployment[REF] = dataset_deployment[REF].model_copy(
            update={"service_account_ids": [account]}
        )
        assert (await fetch()).status_code == 200 and len(calls) == 6
        mode = "revoke"
        pending = asyncio.create_task(fetch())
        try:
            await asyncio.wait_for(started.wait(), 5)
            revoked = await c.post(f"{cred}/catalog/versions/{key}/revoke", json={})
            assert revoked.status_code == 200
        finally:
            release.set()
        refused = await pending
        assert (
            refused.status_code == 422
            and refused.json()["code"] == "DATASET_CONNECTION_UNAVAILABLE"
        )
        assert (await fetch()).status_code == 422 and len(calls) == 7


def test_protected_sample_is_accepted_only_for_the_frozen_http_assertion():
    """模拟同一 CASE 中静态与远程两条断言的独立冻结出处，不能用正确围栏把合法采样元数据贴到另一条来源。"""
    from veriq_server.services.connected_datasets import protected_event

    vid = "00000000-0000-4000-8000-000000000001"
    sample = {"sourceVersionId": vid, "fetchedAt": "2026-01-02T01:02:03.000Z"}
    ctx = {
        "steps": {"s": set()},
        "sources": {("s", "http"): ("DATASET:" + vid, "BLOCK"), ("s", "static"): ("CASE", "BLOCK")},
        "httpAssertions": {("s", "http"): vid},
    }
    payload = {
        "status": "PASSED",
        "severity": "BLOCK",
        "expectedSource": "PROTECTED_CASE",
        "expected": None,
        "actual": {"present": False},
        "durationMs": 1,
    }

    def accepted(assertion, **extra):
        return protected_event(
            ctx,
            {
                "type": "ASSERTION_RESULT",
                "stepId": "s",
                "assertionId": assertion,
                "payload": {**payload, **extra},
            },
        )

    assert accepted("http", sample=sample)
    assert not accepted("static", sample=sample)
    assert not accepted("http", sample={**sample, "sourceVersionId": "other"})
    assert not accepted("http")
    assert accepted("http", status="ERROR")
    assert not accepted("http", sample=sample, status="SKIPPED")


async def test_old_http_projection_reuses_only_the_live_capable_revalidation():
    """相同投影摘要不能证明旧版 SDK 能够在线取数，以当前请求者已有的合格重验证替换旧回执，保持版本不可变。"""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock
    from test_http_datasets import config
    from veriq_server.services.connected_datasets import checksum, project_source, revalidate_bundle

    dataset = {
        "kind": "DATASET",
        "document": config(),
        "versionId": "source",
        "resourceId": "dataset",
        "sha256": "a" * 64,
    }
    source = {"schemaVersion": "1.0", "assets": [dataset]}
    member = {"path": "source/asset-snapshot.json", "sha256": checksum(project_source(source))}
    old = SimpleNamespace(
        id="old", subject_id="subject", required_capabilities={"connectedDatasets": "2.0"}
    )
    migration = SimpleNamespace(id="replacement", state="QUEUED")
    rows = Mock()
    rows.scalar_one_or_none.return_value = migration
    repo = SimpleNamespace(
        scope=SimpleNamespace(workspace_id="workspace"),
        session=SimpleNamespace(execute=AsyncMock(return_value=rows)),
    )
    result = await revalidate_bundle(
        repo,
        old,
        source,
        {"files": [member]},
        SimpleNamespace(compiled_bundle_sha256="old-archive"),
        requester="actor",
    )
    assert result == (migration, None)


@pytest.fixture
async def historical_http_case(site, dataset_deployment):
    """共用正常创建的环境、HTTP 数据版本、用例草稿和受信设备，旧回执与新投影分别由各测试场景单独生成。"""
    from test_http_datasets import REF, config, connection
    from test_publish import create
    from test_runs_mysql import environment, published

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    shared = await c.put(
        f"/api/v1/workspaces/{ws}/runtimes/{d['runnerId']}/grants",
        json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
    )
    assert shared.status_code == 200, shared.text
    trust = await c.put(
        f"/api/v1/workspaces/{ws}/runtimes/{d['runnerId']}/trust",
        json={"trustStatus": "MANAGED", "allowCredentialDelivery": True},
    )
    assert trust.status_code == 200, trust.text
    actor = (await c.get("/api/v1/account")).json()["data"]["id"]
    env = await environment(c, db, ws)
    remote = config()
    remote["source"].update(environmentVersionId=env, auth={"kind": "NONE"})
    dataset_deployment[REF] = connection().model_copy(
        update={
            "workspace_id": ws,
            "environment_version_id": env,
            "user_ids": [actor],
            "auth_kinds": ["NONE"],
        }
    )
    vid = await published(c, db, ws, "remote", "DATASET", remote)
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
    path = await create(
        c,
        ws,
        "case",
        {
            "kind": "CASE",
            "document": {
                "schemaVersion": "1.0",
                "caseKey": "case",
                "title": "Frozen",
                "kind": "READ",
                "roleKey": "reader",
                "catalogVersionId": catalog,
                "datasetBindings": {"remote": vid},
                "steps": [{"id": "home", "action": "goto", "path": "/"}],
            },
        },
    )
    return ws, d, env, path


@pytest.fixture
def approved_http_revalidation_inventory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """只为领取新重验证的纯服务正例装入双组件均支持联网的合成库存，旧式投影回执和其他测试仍使用原有夹具。"""
    path = tmp_path / "approved-http-revalidation.json"
    _write_inventory(
        path,
        {
            "compilerConnectedDatasets": "2.0",
            "runnerSdkConnectedDatasets": "2.0",
            "compilerHttpDatasets": "1.0",
            "runnerSdkHttpDatasets": "1.0",
        },
    )
    monkeypatch.setattr(
        Settings, "__init__", partialmethod(_settings_with_inventory, path, Settings.__init__)
    )


@pytest.mark.usefixtures("approved_http_revalidation_inventory")
async def test_previously_projected_http_job_revalidates_its_immutable_bundle(
    site, historical_http_case
):
    """复现旧式投影回执与已排队测试同时跨版本升级；新增运行及既有运行应共享同一份从冻结原稿生成的重验证。"""
    from uuid import uuid4
    from sqlalchemy import select
    from test_lease_mysql import auth, claim_body
    from test_publish import completed, queue
    from veriq_server.db import Job, ValidationReceipt

    c, db = site
    ws, d, env, path = historical_http_case
    preview, validation = await queue(c, path)
    receipt, _ = await completed(db, validation["id"], connected=True)
    published_case = await c.post(
        path + "/publish", json={"revision": preview["revision"], "validationReceiptId": receipt}
    )
    assert published_case.status_code == 201, published_case.text
    selection = {
        "caseVersionIds": [published_case.json()["data"]["id"]],
        "environmentVersionId": env,
        "roleKeys": ["reader"],
        "browsers": ["chromium"],
        "runtimeIds": [d["runnerId"]],
    }

    async def submit():
        response = await c.post(
            f"/api/v1/workspaces/{ws}/runs",
            json=selection,
            headers={"Idempotency-Key": str(uuid4())},
        )
        assert response.status_code == 202, response.text
        return response.json()["data"]["id"]

    from veriq_server.auth.authorization import WorkspaceScope
    from veriq_server.repositories.resource import ResourceRepository
    from veriq_server.contracts import canonical_bytes
    from veriq_server.db import Attempt
    from veriq_server.services.connected_datasets import frozen_object

    malformed = [await submit() for _ in range(4)]
    prior, waiting = await submit(), await submit()
    async with db.sessions.begin() as session:
        repo = ResourceRepository(session, WorkspaceScope(ws))
        original = await session.get(Job, validation["id"])
        for rid in [*malformed, prior, waiting]:
            queued = (await session.execute(select(Job).where(Job.run_id == rid))).scalar_one()
            assert "validationJobId" not in queued.required_capabilities
            queued.required_capabilities = {
                k: v for k, v in queued.required_capabilities.items() if k != "httpDatasets"
            }
            manifest = await frozen_object(repo, queued.manifest_hash)
            if rid == malformed[3]:
                queued.required_capabilities = {
                    **queued.required_capabilities,
                    "httpDatasets": "1.0",
                }
            if rid not in (prior, *malformed[2:]):
                manifest.pop("compiledBundleSha256")
            if rid in malformed[2:]:
                queued.required_capabilities = {
                    **queued.required_capabilities,
                    "validationJobId": None,
                }
            if rid in (malformed[1], waiting):
                queued.required_capabilities = {
                    **queued.required_capabilities,
                    "validationJobId": original.id,
                }
                manifest["pendingValidationJobId"] = original.id if rid == waiting else str(uuid4())
            queued.manifest_hash = await repo.store(canonical_bytes(manifest))
        original.required_capabilities = {
            k: v for k, v in original.required_capabilities.items() if k != "httpDatasets"
        }
        retained = (await session.get(ValidationReceipt, receipt)).compiled_bundle_sha256
    later = await submit()
    body = claim_body(d)
    body["capabilities"] = {
        **body["capabilities"],
        "connectedDatasets": "2.0",
        "httpDatasets": "1.0",
    }
    response = await c.post("/internal/v1/jobs/claim", headers=auth(d), json=body)
    assert response.status_code == 204, response.text
    async with db.sessions() as session:
        jobs = (
            (await session.execute(select(Job).where(Job.run_id.in_([prior, waiting, later]))))
            .scalars()
            .all()
        )
        assert len(jobs) == 3
        broken = (await session.scalars(select(Job).where(Job.run_id.in_(malformed)))).all()
        assert len(broken) == 4 and all(
            j.state == "FINISHED" and j.outcome == "ERROR" for j in broken
        )
        assert not (
            await session.scalars(select(Attempt).where(Attempt.job_id.in_([j.id for j in broken])))
        ).all()
        replacement_ids = {j.required_capabilities["validationJobId"] for j in jobs}
        assert len(replacement_ids) == 1 and validation["id"] not in replacement_ids
        replacement = await session.get(Job, replacement_ids.pop())
        assert (replacement.kind, replacement.state, replacement.active_attempt_id) == (
            "VALIDATE",
            "QUEUED",
            None,
        )
        assert all(j.required_capabilities.get("httpDatasets") == "1.0" for j in jobs)
        assert (await session.get(ValidationReceipt, receipt)).compiled_bundle_sha256 == retained


@pytest.mark.parametrize("ready", [False, True], ids=["pending", "ready"])
async def test_historical_scheduler_redirect_keeps_only_its_original_lineage(
    site, historical_http_case, dataset_deployment, monkeypatch, ready
):
    """使用旧代调度器的真实重定向写入与撤权发布方，只有原清单所派生的验证可恢复执行，其它同源验证不能借用。"""
    from uuid import uuid4
    from sqlalchemy import select
    from test_http_datasets import REF
    from test_lease_mysql import auth, claim_body
    from test_publish import completed, queue
    from veriq_server.auth.authorization import WorkspaceScope
    from veriq_server.repositories.resource import ResourceRepository
    from veriq_server.services import connected_datasets as connected, runs
    from veriq_server.db import Attempt, CaseExecution, Job, ValidationReceipt, CapacityPool
    from veriq_server.contracts import canonical_bytes

    c, db = site
    ws, d, env, path = historical_http_case
    editor = await new_member(c, ws, "old-publisher@example.com", "ADMIN")
    deployment = dataset_deployment[REF]
    dataset_deployment[REF] = deployment.model_copy(
        update={"user_ids": [*deployment.user_ids, editor]}
    )

    async def claim(live=False):
        body = claim_body(d)
        body["capabilities"] = {
            **body["capabilities"],
            "connectedDatasets": "2.0",
            **({"httpDatasets": "1.0"} if live else {}),
        }
        return await c.post("/internal/v1/jobs/claim", headers=auth(d), json=body)

    async def submit(original):
        response = await c.post(
            f"/api/v1/workspaces/{ws}/runs",
            headers={"Idempotency-Key": str(uuid4())},
            json={
                "draftValidationJobId": original,
                "environmentVersionId": env,
                "roleKeys": ["reader"],
                "browsers": ["chromium"],
                "runtimeIds": [d["runnerId"]],
            },
        )
        assert response.status_code == 202, response.text
        return response.json()["data"]["id"]

    with monkeypatch.context() as old:
        # 此处重放 15cb5cc 的静态能力输入，正常调度器仍自行建重验证、选择幂等键、改写依赖并保留原清单。
        old.setattr(connected, "http_capabilities", lambda _: {})
        old.setattr(runs, "http_capabilities", lambda _: {})
        async with client(c, "old-publisher@example.com") as publisher:
            preview, validation = await queue(publisher, path)
            original = validation["id"]
            receipt_id, _ = await completed(db, original, connected=False)
            published = await publisher.post(
                path + "/publish",
                json={"revision": preview["revision"], "validationReceiptId": receipt_id},
            )
            assert published.status_code == 201, published.text
        assert (await c.delete(f"/api/v1/workspaces/{ws}/members/{editor}")).status_code == 200
        good, wrong = await submit(original), await submit(original)
        assert (await claim()).status_code == 204
        async with db.sessions.begin() as session:
            repo = ResourceRepository(session, WorkspaceScope(ws))
            candidates = (
                await session.scalars(select(Job).where(Job.run_id.in_([good, wrong])))
            ).all()
            assert len(candidates) == 2
            redirected = candidates[0].required_capabilities["validationJobId"]
            assert redirected != original
            for job in candidates:
                case = await session.get(CaseExecution, job.case_execution_id)
                assert case.provenance["validationJobId"] == original
                manifest = await connected.frozen_object(repo, job.manifest_hash)
                assert manifest["pendingValidationJobId"] == original
                assert job.required_capabilities["validationJobId"] == redirected
            replacement = await repo.job(redirected)
            assert replacement.required_capabilities["publishedValidationJobId"] == original
            # 同一个工作区、请求者、原始源、资源和引擎，也可有来自另一验证链的同形重验证；复制标志不能伪造幂等键。
            subject = await repo.job(original)
            source = await connected.frozen_object(repo, subject.snapshot_hash)
            receipt = await session.get(ValidationReceipt, receipt_id)
            bundle = await connected.frozen_object(repo, receipt.compiled_bundle_sha256)
            sibling, _ = await connected.revalidate_bundle(
                repo, replacement, source, bundle, receipt, requester=replacement.created_by
            )
            assert sibling.validation_key != replacement.validation_key
            sibling.required_capabilities = {
                **sibling.required_capabilities,
                "publishedValidationJobId": original,
                "revalidationGroup": replacement.required_capabilities["revalidationGroup"],
            }
            rejected = next(j for j in candidates if j.run_id == wrong)
            rejected.required_capabilities = {
                **rejected.required_capabilities,
                "validationJobId": sibling.id,
            }
            bad_id = rejected.id
        if ready:
            good_receipt, _ = await completed(db, redirected, connected=True)
            wrong_receipt, _ = await completed(db, sibling.id, connected=True)
            async with db.sessions.begin() as session:
                repo = ResourceRepository(session, WorkspaceScope(ws))
                # 通用回执夹具写入成功 Attempt 和回执，补齐正式完成器同时记录的作业终态以重放旧队列。
                for id_ in (redirected, sibling.id):
                    finished = await repo.job(id_)
                    actual = await session.get(Attempt, finished.active_attempt_id)
                    assert (actual.phase, actual.outcome) == ("FINISHED", "PASSED")
                    finished.outcome = actual.outcome
                alternate = await session.get(ValidationReceipt, wrong_receipt)
                descriptor = await connected.frozen_object(repo, alternate.compiled_bundle_sha256)
                entry = next(f for f in descriptor["files"] if f["path"] == "entry.ts")
                alternate_body = b"// independent synthetic compiler build\nexport {};\n"
                entry.update(sha256=await repo.store(alternate_body), sizeBytes=len(alternate_body))
                alternate.compiled_bundle_sha256 = await repo.store(canonical_bytes(descriptor))
                wrong_digest = alternate.compiled_bundle_sha256
                good_digest = (
                    await session.get(ValidationReceipt, good_receipt)
                ).compiled_bundle_sha256
                assert wrong_digest != good_digest
                session.add(CapacityPool(key="00/global/browser", limit=4, used=4))
            # 旧领取器已写完最终包，再由数据库里已满的浏览器池拒绝派发，故两个没有显式依赖的 TEST 仍然排队。
            assert (await claim()).status_code == 204
            async with db.sessions.begin() as session:
                repo = ResourceRepository(session, WorkspaceScope(ws))
                for run_id, expected_digest in ((good, good_digest), (wrong, wrong_digest)):
                    queued = (await session.scalars(select(Job).where(Job.run_id == run_id))).one()
                    assert (queued.state, queued.wait_reason) == ("QUEUED", "CAPACITY")
                    assert "validationJobId" not in queued.required_capabilities
                    manifest = await connected.frozen_object(repo, queued.manifest_hash)
                    assert "pendingValidationJobId" not in manifest
                    assert manifest["compiledBundleSha256"] == expected_digest
                    case = await session.get(CaseExecution, queued.case_execution_id)
                    assert case.provenance["validationJobId"] == original
                pool = await session.get(CapacityPool, "00/global/browser")
                pool.used = 0

    assert (await claim()).status_code == 204
    async with db.sessions() as session:
        good_job = (await session.scalars(select(Job).where(Job.run_id == good))).one()
        rejected = await session.get(Job, bad_id)
        assert (good_job.state, good_job.required_capabilities.get("httpDatasets")) == (
            "QUEUED",
            "1.0",
        )
        assert good_job.required_capabilities["validationJobId"] == (
            original if ready else redirected
        )
        assert (rejected.state, rejected.outcome) == ("FINISHED", "ERROR")
        assert not (await session.scalars(select(Attempt).where(Attempt.job_id == bad_id))).all()
        expected_test = good_job.id
    if ready:
        assert (await claim(live=True)).status_code == 204
        async with db.sessions() as session:
            queued = await session.get(Job, expected_test)
            replacement_id = queued.required_capabilities["validationJobId"]
            fresh = await session.get(Job, replacement_id)
            assert fresh.required_capabilities["httpDatasets"] == "1.0"
            assert fresh.required_capabilities["publishedValidationJobId"] == original
            assert replacement_id not in (original, redirected, sibling.id)
    else:
        replacement_id = redirected
    await completed(db, replacement_id, connected=True)
    result = await claim(live=True)
    assert result.status_code == 200, result.text
    assert (result.json()["data"]["jobId"], result.json()["data"]["jobKind"]) == (
        expected_test,
        "TEST",
    )
