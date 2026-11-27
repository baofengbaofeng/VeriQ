import hashlib
import json
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select
from test_auth import setup, login
from test_workspace import workspace
from test_publish import create, publish
from test_completion_mysql import seed_historical_validation_attempt
from test_lease_mysql import device
from test_server_compilation import _settings as compiler_settings
from veriq_server.services.server_compilation import _claim as claim_validation
import veriq_server.db
from veriq_server.db import Job, Artifact, CaseExecution


async def published(c, db, ws, key, kind, document):
    path = await create(c, ws, key, {"kind": kind, "document": document})
    version, _, _ = await publish(c, db, path)
    return version["id"]


async def environment(
    c,
    db,
    ws,
    with_fixture=False,
    *,
    origin="https://business.test",
    identity_path="/me",
    token="synthetic-business-secret",
):
    base = f"/api/v1/workspaces/{ws}"
    secret = (
        await c.post(
            base + "/credentials",
            json={
                "secretRef": "business",
                "value": {"token": token},
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
                    "identityPath": identity_path,
                    "identityPointer": "/id",
                }
            },
        )
    ).json()["data"]
    doc = {
        "schemaVersion": "1.0",
        "baseURL": origin,
        "apiBaseURL": origin,
        "allowedOrigins": [origin],
        "locale": "en-US",
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
    }
    if with_fixture:
        fixture_secret = (
            await c.post(
                base + "/credentials",
                json={
                    "secretRef": "fixture",
                    "value": {"token": "synthetic-fixture-secret"},
                    "allowedIdentityIds": ["fixture-service"],
                },
            )
        ).json()["data"]
        doc["fixtureBaseURL"] = "https://business.test"
        doc["fixtureIdentity"] = {
            "authAdapterVersionId": adapter["versionId"],
            "secretRef": "fixture",
            "secretVersionId": fixture_secret["versionId"],
            "allowedIdentityIds": ["fixture-service"],
        }
    return await published(c, db, ws, "env", "ENVIRONMENT", doc)


def _resource_lock(*parts: str) -> str:
    """
    以标准库为固定字符串数组生成紧凑的 UTF-8 正文及摘要，独立核对任务持久化的资源锁标识。
    """
    raw = json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


async def _snapshot(session, ws, job):
    """
    用请求指定的工作空间与任务内容摘要读取快照原件，分别核对任务及冻结数据所属的工作空间。
    """
    assert job.workspace_id == ws
    frozen = json.loads((await session.get(Artifact, (ws, job.snapshot_hash))).content)
    assert frozen["workspaceId"] == ws
    return frozen


async def _assert_dataset_snapshots(session, ws, env, datasets, reference, run_id):
    """
    根据提交套件的条目顺序确定预期数据集和行值，逐一核对执行来源、冻结快照及数据资源锁。
    """
    from veriq_server.contracts import canonical_bytes, validate_schema

    jobs = (await session.execute(select(Job).where(Job.run_id == run_id))).scalars().all()
    assert len(jobs) == 2
    executions = (
        (await session.execute(select(CaseExecution).where(CaseExecution.run_id == run_id)))
        .scalars()
        .all()
    )
    assert {e.provenance["datasetVersionId"] for e in executions} == set(datasets)
    assert {e.provenance["suiteEntryIndex"] for e in executions} == {0, 1}
    environment_version = await session.get(veriq_server.db.ResourceVersion, env)
    versions = [
        await session.get(veriq_server.db.ResourceVersion, dataset_id) for dataset_id in datasets
    ]
    assert versions[0].resource_id != versions[1].resource_id
    by_id = {execution.id: execution for execution in executions}
    assert {job.case_execution_id for job in jobs} == set(by_id)
    for job in jobs:
        execution = by_id[job.case_execution_id]
        index = execution.provenance["suiteEntryIndex"]
        dataset_id = datasets[index]
        assert execution.provenance["datasetVersionId"] == dataset_id
        frozen = await _snapshot(session, ws, job)
        assert execution.provenance["rowKey"] == "same"
        assert frozen["caseExecutionId"] == execution.id
        assert frozen["datasetVersionId"] == dataset_id
        assert not validate_schema("ConnectedExecutionSnapshotV2", frozen)
        assert "dataRow" not in frozen
        assert frozen["datasetBindings"] == {"reference": reference}
        row = {"key": "same", "values": {"value": ("A", "B")[index]}}
        assert frozen["selectedRow"] == {
            "versionId": dataset_id,
            "rowKey": "same",
            "rowSha256": hashlib.sha256(canonical_bytes(row)).hexdigest(),
        }
        assert frozen["variables"] == {"initial": "frozen input"} and frozen["authAdapters"]
        assert "synthetic-business-secret" not in json.dumps(frozen)
        assert job.required_capabilities["resourceKeys"] == [
            _resource_lock("identity", environment_version.resource_id, "business", "reader"),
            _resource_lock("data", versions[index].resource_id, "same"),
        ]

    dependency_ids = {job.required_capabilities["validationJobId"] for job in jobs}
    assert len(dependency_ids) == 1
    migration = await session.get(Job, dependency_ids.pop())
    assert {execution.source_snapshot_hash for execution in executions} == {migration.snapshot_hash}
    assert migration.kind == "VALIDATE"
    assert migration.required_capabilities["connectedDatasets"] == "2.0"
    return migration


async def _assert_data_free_snapshot(session, ws, run_id, env):
    """
    从调试运行的持久化记录读取执行与快照，确认空数据行只保留空来源键且不增加数据资源锁。
    """
    execution = (
        await session.execute(select(CaseExecution).where(CaseExecution.run_id == run_id))
    ).scalar_one()
    job = (await session.execute(select(Job).where(Job.run_id == run_id))).scalar_one()
    environment_version = await session.get(veriq_server.db.ResourceVersion, env)
    frozen = await _snapshot(session, ws, job)
    assert execution.provenance["rowKey"] is None
    assert execution.provenance["datasetVersionId"] is None
    assert frozen["caseExecutionId"] == execution.id
    assert "dataRow" not in frozen and "datasetVersionId" not in frozen
    assert job.required_capabilities["resourceKeys"] == [
        _resource_lock("identity", environment_version.resource_id, "business", "reader"),
    ]


async def test_suite_matrix_preserves_dataset_row_provenance_and_frozen_variables(site):
    """
    经真实运行入口验证跨数据集矩阵、冻结输入及资源锁，并保留同一运行的幂等和容量控制断言。
    """
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    env = await environment(c, db, ws)
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
    reference = await published(
        c,
        db,
        ws,
        "reference",
        "DATASET",
        {
            "schemaVersion": "2.0",
            "shape": "TABLE",
            "fields": {},
            "source": {"kind": "STATIC", "rows": []},
        },
    )
    case = await published(
        c,
        db,
        ws,
        "case",
        "CASE",
        {
            "schemaVersion": "1.0",
            "caseKey": "case",
            "title": "Frozen",
            "kind": "READ",
            "roleKey": "reader",
            "catalogVersionId": catalog,
            "initialVariables": {"initial": "string"},
            "datasetBindings": {"reference": reference},
            "steps": [
                {"id": "fill", "action": "fill", "target": "name", "value": "{{vars.initial}}"}
            ],
        },
    )
    # 变体共享行键但分别冻结旧表和新版树，身份必须保留数据集版本，执行行仅包含稳定键与字段值。
    datasets = [
        await published(
            c,
            db,
            ws,
            "datasetA",
            "DATASET",
            {
                "schemaVersion": "1.0",
                "columns": {"value": "string"},
                "rows": [{"key": "same", "values": {"value": "A"}}],
            },
        ),
        await published(
            c,
            db,
            ws,
            "datasetB",
            "DATASET",
            {
                "schemaVersion": "2.0",
                "shape": "TREE",
                "fields": {"value": {"type": "string", "required": True, "nullable": False}},
                "source": {
                    "kind": "STATIC",
                    "rows": [
                        {"key": "same", "values": {"value": "B"}, "parentKey": None, "order": 0}
                    ],
                },
            },
        ),
    ]
    suite = await published(
        c,
        db,
        ws,
        "suite",
        "SUITE",
        {
            "schemaVersion": "1.0",
            "cases": [{"versionId": case, "datasetVersionId": dataset} for dataset in datasets],
        },
    )
    data = {
        "suiteVersionId": suite,
        "environmentVersionId": env,
        "roleKeys": ["reader"],
        "browsers": ["chromium"],
        "runtimeIds": [d["runnerId"]],
    }
    endpoint = f"/api/v1/workspaces/{ws}/runs"
    bad = await c.post(endpoint, json=data, headers={"Idempotency-Key": str(uuid4())})
    assert bad.status_code == 422, bad.text
    data["variables"] = {"initial": "frozen input"}
    key = str(uuid4())
    response = await c.post(endpoint, json=data, headers={"Idempotency-Key": key})
    assert response.status_code == 202, response.text
    run = response.json()["data"]
    assert (await c.post(endpoint, json=data, headers={"Idempotency-Key": key})).json()[
        "data"
    ] == run
    async with db.sessions() as session:
        migration = await _assert_dataset_snapshots(
            session, ws, env, datasets, reference, run["id"]
        )

    async def current_migration():
        retry = await c.post(endpoint, json=data, headers={"Idempotency-Key": str(uuid4())})
        assert retry.status_code == 202, retry.text
        async with db.sessions() as session:
            jobs = (
                await session.execute(select(Job).where(Job.run_id == retry.json()["data"]["id"]))
            ).scalars()
            ids = {j.required_capabilities["validationJobId"] for j in jobs}
            assert len(ids) == 1
        cancelled = await c.post(
            endpoint + "/" + retry.json()["data"]["id"] + "/cancel",
            json={"reason": "Release isolated test capacity"},
        )
        assert cancelled.json()["data"]["outcome"] == "CANCELLED"
        return ids.pop()

    previous = migration.id
    assert await current_migration() == previous
    for outcome in ("ERROR", "CANCELLED"):
        async with db.sessions.begin() as session:
            old = await session.get(Job, previous)
            old.state, old.outcome = "FINISHED", outcome
        replacement = await current_migration()
        assert replacement != previous
        assert await current_migration() == replacement
        async with db.sessions() as session:
            assert (await session.get(Job, previous)).outcome == outcome
        previous = replacement
    empty = {k: v for k, v in data.items() if k != "suiteVersionId"}
    empty["caseVersionIds"] = []
    zero = await c.post(endpoint, json=empty, headers={"Idempotency-Key": str(uuid4())})
    assert zero.status_code == 202, zero.text
    assert zero.json()["data"]["outcome"] == "INCOMPLETE"
    assert zero.json()["data"]["reasonCode"] == "NO_CASES_SELECTED"
    for _ in range(9):
        admitted = await c.post(endpoint, json=data, headers={"Idempotency-Key": str(uuid4())})
        assert admitted.status_code == 202, admitted.text
    overflow = await c.post(endpoint, json=data, headers={"Idempotency-Key": str(uuid4())})
    assert overflow.status_code == 429 and overflow.json()["code"] == "RUN_LIMIT"
    assert (await c.post(endpoint, json=data, headers={"Idempotency-Key": key})).status_code == 202
    cancelled = await c.post(
        endpoint + f"/{run['id']}/cancel", json={"reason": "Operator cancellation"}
    )
    assert cancelled.status_code == 200, cancelled.text
    assert (
        cancelled.json()["data"]["state"] == "FINISHED"
        and cancelled.json()["data"]["outcome"] == "CANCELLED"
    )
    assert (
        await c.post(endpoint, json=data, headers={"Idempotency-Key": str(uuid4())})
    ).status_code == 202


async def test_debug_candidate_waits_for_validation_without_fabricating_published_version(site):
    """
    调试运行先冻结不含数据行的候选快照，仍须经原验证任务完成后才能领取，且不生成发布版本。
    """
    from test_publish import create, queue, completed
    from test_lease_mysql import auth, claim_body
    from veriq_server.db import ResourceVersion

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    env = await environment(c, db, ws)
    catalog = await published(
        c,
        db,
        ws,
        "catalog",
        "ELEMENT_CATALOG",
        {
            "schemaVersion": "1.0",
            "elements": [{"key": "save", "locator": {"by": "veriqId", "value": "save"}}],
        },
    )
    path = await create(
        c,
        ws,
        "draft",
        {
            "kind": "CASE",
            "document": {
                "schemaVersion": "1.0",
                "caseKey": "draft",
                "title": "Draft",
                "kind": "READ",
                "roleKey": "reader",
                "catalogVersionId": catalog,
                "steps": [{"id": "open", "action": "goto", "path": "/"}],
            },
        },
    )
    preview, validation = await queue(c, path)
    data = {
        "draftValidationJobId": validation["id"],
        "environmentVersionId": env,
        "roleKeys": ["reader"],
        "browsers": ["chromium"],
        "runtimeIds": [d["runnerId"]],
    }
    admitted = await c.post(
        f"/api/v1/workspaces/{ws}/runs", json=data, headers={"Idempotency-Key": str(uuid4())}
    )
    assert admitted.status_code == 202, admitted.text
    assert admitted.json()["data"]["triggerKind"] == "DEBUG"
    async with db.sessions() as session:
        assert await session.get(ResourceVersion, preview["candidateVersionId"]) is None
        await _assert_data_free_snapshot(session, ws, admitted.json()["data"]["id"], env)
    assert (
        await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))
    ).status_code == 204
    # 依赖未完成时领取返回空响应，再由校验夹具补齐回执，验证相同领取请求重放能够取回同一个执行尝试。
    await completed(db, validation["id"])
    request = claim_body(d)
    claim = await c.post("/internal/v1/jobs/claim", json=request, headers=auth(d))
    assert claim.status_code == 200, claim.text
    recovered = await c.post("/internal/v1/jobs/claim", json=request, headers=auth(d))
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["data"]["attemptId"] == claim.json()["data"]["attemptId"]


async def test_claim_skips_corrupt_historical_inputs_and_aggregates_failed_run(site, monkeypatch):
    from test_lease_mysql import auth, claim_body, queued_browser_jobs
    from veriq_server.db import Run, ValidationReceipt
    from veriq_server.repositories.resource import ResourceRepository
    from veriq_server.auth.authorization import WorkspaceScope
    from veriq_server.contracts import canonical_bytes
    from veriq_server.service import Problem

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    runtime = await device(c, ws)
    _, receipt_id, source = await historical_dataset_case(c, db, ws)
    broken_ids = [(await queued_browser_jobs(c, db, ws, 1))[0] for _ in range(4)]
    (ready,) = await queued_browser_jobs(c, db, ws, 1)
    runs, cases, frozen_hashes = [], [], []
    async with db.sessions.begin() as session:
        repo = ResourceRepository(session, WorkspaceScope(ws))
        receipt = await session.get(ValidationReceipt, receipt_id)
        for i, jid in enumerate(broken_ids):
            job = await session.get(Job, jid)
            case = await session.get(CaseExecution, job.case_execution_id)
            runs.append(job.run_id)
            cases.append(case.id)
            if i == 0:
                original = await session.get(Artifact, (ws, case.source_snapshot_hash))
                original.content = b"synthetic-corruption"
            elif i == 1:
                job.snapshot_hash = await repo.store(
                    canonical_bytes({"assetSourceHash": source["sourceHash"]})
                )
                job.required_capabilities = {
                    **job.required_capabilities,
                    "connectedDatasets": "2.0",
                    "validationJobId": receipt.job_id,
                }
                bundle = json.loads((await repo.artifact(receipt.compiled_bundle_sha256)).content)
                bundle["files"] = [
                    f for f in bundle["files"] if f["path"] != "source/asset-snapshot.json"
                ]
                receipt.compiled_bundle_sha256 = await repo.store(canonical_bytes(bundle))
            else:
                manifest = await historical_test_manifest(repo, job, case, source, pinned=i == 3)
                manifest["compiledBundleSha256"] = receipt.compiled_bundle_sha256
                job.manifest_hash = await repo.store(canonical_bytes(manifest))
                case.provenance = {"validationJobId": receipt.job_id if i == 2 else str(uuid4())}
            frozen_hashes.append(job.snapshot_hash)
    request = claim_body(runtime)
    request["capabilities"] = {**request["capabilities"], "connectedDatasets": "2.0"}

    async def unavailable(*_):
        raise Problem(503, "ARTIFACT_STORE_UNAVAILABLE", "Storage temporarily unavailable")

    with monkeypatch.context() as patch:
        patch.setattr(ResourceRepository, "artifact", unavailable)
        temporary = await c.post("/internal/v1/jobs/claim", headers=auth(runtime), json=request)
        assert temporary.status_code == 503
    async with db.sessions() as session:
        assert (await session.get(Job, broken_ids[0])).state == "QUEUED"
        assert (await session.get(Job, ready)).state == "QUEUED"
    response = await c.post("/internal/v1/jobs/claim", headers=auth(runtime), json=request)
    assert response.status_code == 200, response.text
    assert response.json()["data"]["jobId"] == ready
    async with db.sessions() as session:
        for jid, case_id, run_id, original_hash in zip(broken_ids, cases, runs, frozen_hashes):
            assert (await session.get(Job, jid)).snapshot_hash == original_hash
            run = await session.get(Run, run_id)
            for record in [
                await session.get(Job, jid),
                await session.get(CaseExecution, case_id),
                run,
            ]:
                assert (record.state, record.outcome) == ("FINISHED", "ERROR")
            assert run.reason_code == "COMPILED_PROVENANCE_REQUIRED"


async def historical_dataset_case(c, db, ws):
    """通过正常发布流程生成包含静态行的真实用例版本，使历史分配的套件成员和原始验证回执都可以独立核对。"""
    dataset = await published(
        c,
        db,
        ws,
        "rows",
        "DATASET",
        {
            "schemaVersion": "1.0",
            "columns": {"name": "string"},
            "rows": [{"key": "k", "values": {"name": "synthetic"}}],
        },
    )
    catalog = await published(
        c,
        db,
        ws,
        "catalog",
        "ELEMENT_CATALOG",
        {
            "schemaVersion": "1.0",
            "elements": [{"key": "e", "locator": {"by": "veriqId", "value": "e"}}],
        },
    )
    path = await create(
        c,
        ws,
        "frozen",
        {
            "kind": "CASE",
            "document": {
                "schemaVersion": "1.0",
                "caseKey": "frozen",
                "kind": "READ",
                "title": "Frozen",
                "roleKey": "reader",
                "catalogVersionId": catalog,
                "datasetVersionId": dataset,
                "steps": [{"id": "s", "action": "goto", "path": "/"}],
            },
        },
    )
    return await publish(c, db, path)


async def historical_test_manifest(repo, job, case, source, *, pinned=True):
    """用仓库保留的旧版序列化样例还原执行分配，测试可以分别提供已编译摘要、在途验证依赖或故意损坏的清单。"""
    from veriq_server.contracts import canonical_bytes

    examples = json.loads(Path("packages/contracts/fixtures/compatibility.json").read_bytes())
    frozen = next(x["value"] for x in examples if x["name"] == "execution-snapshot")
    case.case_version_id = case.published_case_version_id = source["entryCaseVersionIds"][0]
    case.candidate_version_id = None
    asset = next(a for a in source["assets"] if a["kind"] == "DATASET")
    frozen.update(
        dataRow=asset["document"]["rows"][0],
        assetSourceHash=source["sourceHash"],
        workspaceId=job.workspace_id,
        runId=job.run_id,
        caseExecutionId=case.id,
        caseVersionId=case.case_version_id,
    )
    if pinned:
        frozen["datasetVersionId"] = asset["versionId"]
    case.source_snapshot_hash = await repo.store(canonical_bytes(source))
    job.snapshot_hash = await repo.store(canonical_bytes(frozen))
    return {
        "schemaVersion": "1.0",
        "workspaceId": job.workspace_id,
        "jobId": job.id,
        "kind": "TEST",
        "engineVersion": source["engineVersion"],
        "caseExecutionId": case.id,
        "caseVersionId": case.case_version_id,
        "snapshotSha256": job.snapshot_hash,
        "executionSnapshotSha256": job.snapshot_hash,
    }


def historical_compiler_settings(tmp_path, *, connected=False):
    """按历史节点声明构造批准发行，使用相同版本与真实领取器验证发现新数据能力后的跨节点交接。"""
    settings = compiler_settings(tmp_path)
    if connected:
        inventory_path = Path(settings.approved_engine_inventory_path)
        inventory = json.loads(inventory_path.read_bytes())
        inventory["engines"][0].update(
            compilerConnectedDatasets="2.0", runnerSdkConnectedDatasets="2.0"
        )
        inventory_path.write_text(json.dumps(inventory), encoding="utf-8")
    return settings


@pytest.mark.parametrize("defect", ["empty", "overflow", "snapshot", "pending", "bundle"])
async def test_historical_manifests_are_verified_before_projection(site, defect, tmp_path):
    """检查历史清单的损坏只终结相应排队任务，兼容节点可领取完整投影，而已租给旧设备的清单和尝试保留原值。"""
    from test_lease_mysql import auth, claim_body, queued_browser_jobs
    from veriq_server.db import Attempt, ValidationReceipt
    from test_publish import queue
    from veriq_server.auth.authorization import WorkspaceScope
    from veriq_server.contracts import canonical_bytes
    from veriq_server.repositories.resource import ResourceRepository

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    runtime = await device(c, ws)
    _, original_receipt, source = await historical_dataset_case(c, db, ws)
    content = {
        "kind": "DATASET",
        "document": {
            "schemaVersion": "1.0",
            "columns": {"name": "string"},
            "rows": [{"key": "k", "values": {"name": "synthetic"}}],
        },
    }
    validations = []
    for name in ("wrong-revision", "valid-validation", "old-device-validation"):
        _, assignment = await queue(c, await create(c, ws, name, content))
        validations.append(assignment["id"])
    wrong_validation, valid_validation, device_validation = validations
    bad, pending, compiled, healthy = [
        (await queued_browser_jobs(c, db, ws, 1))[0] for _ in range(4)
    ]
    async with db.sessions.begin() as session:
        repo = ResourceRepository(session, WorkspaceScope(ws))
        receipt = await session.get(ValidationReceipt, original_receipt)
        dependency = receipt.job_id
        frozen_validations = {}
        for validation_id in validations:
            validation = await session.get(Job, validation_id)
            original = json.loads((await repo.artifact(validation.manifest_hash)).content)
            original["snapshotSha256"] = validation.snapshot_hash
            if validation_id in (wrong_validation, device_validation):
                original["revision"] += 1
            validation.manifest_hash = await repo.store(canonical_bytes(original))
            validation.required_capabilities = {
                "compileAssets": True,
                "engineVersion": source["engineVersion"],
            }
            frozen_validations[validation_id] = (validation.snapshot_hash, validation.manifest_hash)
        original_manifests = {}
        for jid in [bad, pending, compiled]:
            job = await session.get(Job, jid)
            case = await session.get(CaseExecution, job.case_execution_id)
            manifest = await historical_test_manifest(repo, job, case, source)
            case.provenance = {"validationJobId": dependency}
            if jid == pending or (jid == bad and defect == "pending"):
                manifest["pendingValidationJobId"] = dependency
                job.required_capabilities = {
                    **job.required_capabilities,
                    "validationJobId": dependency,
                }
            else:
                manifest["compiledBundleSha256"] = receipt.compiled_bundle_sha256
                if jid == bad and defect == "bundle":
                    manifest["compiledBundleSha256"] = "a" * 64
            if jid == bad and defect == "snapshot":
                manifest["executionSnapshotSha256"] = "f" * 64
            if jid == bad and defect == "pending":
                manifest["pendingValidationJobId"] = str(uuid4())
            raw = canonical_bytes(manifest)
            if jid == bad and defect == "empty":
                raw = b"{}"
            if jid == bad and defect == "overflow":
                raw = raw[:-1] + b',"number":1e999}'
            job.manifest_hash = await repo.store(raw)
            original_manifests[jid] = (job.manifest_hash, job.snapshot_hash)
    response = await c.post(
        "/internal/v1/jobs/claim", headers=auth(runtime), json=claim_body(runtime)
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["jobId"] == healthy
    legacy_worker = historical_compiler_settings(tmp_path)
    legacy_device = await device(c, ws)
    device_claim = await seed_historical_validation_attempt(
        db, device_validation, legacy_device["runnerId"], str(c.base_url)
    )
    for _ in (wrong_validation, valid_validation):
        assert await claim_validation(db, legacy_worker) is None
    async with db.sessions() as session:
        repo = ResourceRepository(session, WorkspaceScope(ws))
        job = await session.get(Job, bad)
        assert (job.state, job.outcome) == ("FINISHED", "ERROR")
        assert (job.manifest_hash, job.snapshot_hash) == original_manifests[bad]
        rejected = await session.get(Job, wrong_validation)
        assert (rejected.snapshot_hash, rejected.manifest_hash) == frozen_validations[
            wrong_validation
        ]
        leased = await session.get(Job, device_validation)
        attempt = await session.get(Attempt, device_claim["attemptId"])
        assert leased.active_attempt_id == attempt.id and leased.server_compilation_id is None
        assert (leased.state, attempt.phase) == ("LEASED", "LEASED")
        assert (attempt.snapshot_hash, attempt.manifest_hash) == frozen_validations[
            device_validation
        ]
        assert (leased.snapshot_hash, leased.manifest_hash) == frozen_validations[device_validation]
        assert "connectedDatasets" not in leased.required_capabilities
        assert (rejected.state, rejected.outcome) == ("FINISHED", "ERROR")
        for jid in [pending, compiled, valid_validation]:
            job = await session.get(Job, jid)
            assert job.state == "QUEUED" and job.required_capabilities["connectedDatasets"] == "2.0"
            manifest = json.loads((await repo.artifact(job.manifest_hash)).content)
            projected = json.loads((await repo.artifact(manifest["snapshotSha256"])).content)
            assert projected["schemaVersion"] == "2.0"
            if jid != valid_validation:
                assert manifest["pendingValidationJobId"] == dependency
                assert manifest["executionSnapshotSha256"] == job.snapshot_hash
                assert "dataRow" not in projected
    capable_worker = historical_compiler_settings(tmp_path, connected=True)
    claim = await claim_validation(db, capable_worker)
    assert claim is not None and claim.job_id == valid_validation and claim.connected
