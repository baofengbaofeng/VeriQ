"""通过真实 HTTP 和隔离的 MySQL 核对新分配与回执签发，合成发行库存及编译文件仅用于检验服务端的接纳策略。

使用临时库存文件和已冻结的源码旁车。测试不启动编译器、引擎或浏览器，且不向 HTTP 数据源发送请求。
"""

from collections.abc import Callable
from dataclasses import dataclass
from functools import partialmethod
from hashlib import sha256
import json
from pathlib import Path
from typing import Literal

import httpx
import pytest
from sqlalchemy import select
from test_auth import login, setup
from test_completion_mysql import upload
from test_http_datasets import REF, config, connection
from test_lease_mysql import auth, claim_body, device
from test_publish import create, queue
from test_workspace import workspace

from veriq_server.contracts import asset_source_hash, canonical_bytes, validate_schema
from veriq_server.datasets.connection import DatasetConnection
from veriq_server.db import Artifact, Attempt, CapacityPool, Database, Job, ResourceLease
from veriq_server.db import ValidationReceipt
from veriq_server.settings import Settings

_CONNECTED = (("compilerConnectedDatasets", "2.0"), ("runnerSdkConnectedDatasets", "2.0"))
_HTTP = (("compilerHttpDatasets", "1.0"), ("runnerSdkHttpDatasets", "1.0"))
_ENGINE_VERSION = "0.1.0"
_RELEASE_FILES = (
    ("package.json", b'{"name":"veriq-r09-test-fixture"}\n'),
    ("package-lock.json", b'{"lockfileVersion":3}\n'),
    ("dependencies.json", b'{"fixture":true}\n'),
    ("engine/compiler.tgz", b"R09 synthetic compiler archive fixture\n"),
)
_CLAIM_PATH = "/internal/v1/jobs/claim"
_DataKind = Literal["none", "static", "http"]
_Site = tuple[httpx.AsyncClient, Database]
_Claim = dict[str, str | int]


@dataclass(frozen=True)
class _Validation:
    """记录真实草稿校验的设备、任务与摘要，以及由队列为本次验证生成的精确源码旁车，供领取和完成共同核对。"""

    workspace_id: str
    job_id: str
    source_hash: str
    manifest_hash: str
    source_file: bytes
    credential: dict[str, str]


def _settings_with_inventory(
    settings: Settings,
    path: Path,
    original_init: Callable[..., None],
    /,
    **values: object,
) -> None:
    """为现有真实站点的设置模型传入本次用例的临时库存路径，库存读取和结构校验仍由正式批准服务执行。"""
    original_init(settings, **{**values, "approved_engine_inventory_path": str(path)})


@pytest.fixture(autouse=True, name="inventory_path")
def _inventory_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """在站点创建配置前接入独立库存文件，使领取和完成从同一临时路径读取，而共享集成库存始终留在原处。"""
    path = tmp_path / "approved-engine-inventory.json"
    monkeypatch.setattr(
        Settings, "__init__", partialmethod(_settings_with_inventory, path, Settings.__init__)
    )
    return path


@pytest.fixture(name="dataset_deployment")
def _dataset_deployment() -> dict[str, DatasetConnection]:
    """提供真实站点夹具读取的独立连接登记表，待工作区和员工建好后再登记只允许无认证读取的合成定义。"""
    return {}


async def _queue_validation(
    site: _Site, dataset_deployment: dict[str, DatasetConnection], mode: _DataKind
) -> _Validation:
    """通过公开资源和受管设备入口排队，再从数据库核对冻结能力、草稿预览源摘要和投影旁车的字节绑定。"""
    client, database = site
    await setup(client)
    await login(client)
    ws = await workspace(client)
    credential = await device(client, ws)
    runtime = f"/api/v1/workspaces/{ws}/runtimes/{credential['runnerId']}"
    assert (
        await client.put(
            runtime + "/grants",
            json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
        )
    ).status_code == 200
    assert (
        await client.put(
            runtime + "/trust", json={"trustStatus": "MANAGED", "allowCredentialDelivery": False}
        )
    ).status_code == 200
    content = None
    required: dict[str, str | bool] = {"engineVersion": _ENGINE_VERSION, "compileAssets": True}
    if mode != "none":
        required["connectedDatasets"] = "2.0"
        document = {
            "schemaVersion": "1.0",
            "columns": {"label": "string"},
            "rows": [{"key": "one", "values": {"label": "synthetic"}}],
        }
        if mode == "http":
            actor = (await client.get("/api/v1/account")).json()["data"]["id"]
            dataset_deployment[REF] = connection().model_copy(
                update={"workspace_id": ws, "user_ids": [actor], "auth_kinds": ["NONE"]}
            )
            document = config()
            document["source"]["auth"] = {"kind": "NONE"}
            required["httpDatasets"] = "1.0"
        content = {"kind": "DATASET", "document": document}
    path = await create(client, ws, "engine-capability", content)
    preview, queued = await queue(client, path)
    return await _read_validation(
        database, credential, queued["id"], preview["sourceHash"], required
    )


async def _read_validation(
    database: Database,
    credential: dict[str, str],
    job_id: str,
    source_hash: str,
    required: dict[str, str | bool],
) -> _Validation:
    """从已保存的校验任务读取原始快照与投影旁车，确认两个摘要均可追溯到预览阶段收到的同一源码身份。"""
    async with database.sessions() as session:
        job = await session.get(Job, job_id)
        assert job is not None and job.required_capabilities == required
        ws = job.workspace_id
        original = await session.get(Artifact, (ws, job.snapshot_hash))
        manifest = await session.get(Artifact, (ws, job.manifest_hash))
        assert original is not None and manifest is not None
        assert sha256(original.content).hexdigest() == job.snapshot_hash
        assert sha256(manifest.content).hexdigest() == job.manifest_hash
        frozen, assignment = json.loads(original.content), json.loads(manifest.content)
        assert asset_source_hash(frozen) == frozen["sourceHash"] == source_hash
        assert assignment["sourceHash"] == source_hash
        assert frozen["entryCaseVersionIds"] == []
        projected = await session.get(Artifact, (ws, assignment["snapshotSha256"]))
        assert projected is not None
        assert sha256(projected.content).hexdigest() == assignment["snapshotSha256"]
        return _Validation(
            ws, job.id, source_hash, job.manifest_hash, projected.content, credential
        )


def _file_entry(path: str, content: bytes) -> dict[str, object]:
    """以实际上传的文件字节计算摘要和长度，使批准库存、编译描述符和服务端保留的内容可以逐项交叉核对。"""
    return {"path": path, "sha256": sha256(content).hexdigest(), "sizeBytes": len(content)}


def _release_identity() -> dict[str, object]:
    """构造编译描述符和库存共同引用的固定合成版本与依赖，能力变化时维持原有文件和发行身份完全一致。"""
    return {
        "engineVersion": _ENGINE_VERSION,
        "compilerVersion": _ENGINE_VERSION,
        "runnerSdkVersion": _ENGINE_VERSION,
        "dependencies": [
            {"name": "@veriq/runner-sdk", "version": _ENGINE_VERSION, "integrity": "synthetic-r09"}
        ],
    }


def _write_inventory(
    path: Path, features: dict[str, str], *, invalid_field: str | None = None
) -> str:
    """保存真实库存读取器会读取的文件并生成单条发行摘要，明确区分合法空缺与原有结构校验能拒绝的错误版本。"""
    engine = {
        **_release_identity(),
        **features,
        "files": [_file_entry(name, content) for name, content in _RELEASE_FILES],
    }
    inventory = {"schemaVersion": "1.0", "engines": [engine]}
    issues = validate_schema("ApprovedEngineInventoryV1", inventory)
    expected = [f"/engines/0/{invalid_field}"] if invalid_field is not None else []
    assert [issue["path"] for issue in issues] == expected
    path.write_bytes(canonical_bytes(inventory))
    return sha256(canonical_bytes(engine)).hexdigest()


def _claim_request(validation: _Validation) -> dict[str, object]:
    """每次新领取都以不同请求标识自报完整联网支持，确认设备声明足以通过协议协商却不能补齐操作员证明。"""
    request = claim_body(validation.credential)
    request["capabilities"] = {
        **request["capabilities"],
        "connectedDatasets": "2.0",
        "httpDatasets": "1.0",
    }
    return request


_CLAIM_REQUIRED_FIELDS = (
    ("static", "compilerConnectedDatasets"),
    ("static", "runnerSdkConnectedDatasets"),
    ("http", "compilerConnectedDatasets"),
    ("http", "runnerSdkConnectedDatasets"),
    ("http", "compilerHttpDatasets"),
    ("http", "runnerSdkHttpDatasets"),
)


@pytest.mark.parametrize(
    "requirement", _CLAIM_REQUIRED_FIELDS, ids=["-".join(r) for r in _CLAIM_REQUIRED_FIELDS]
)
@pytest.mark.parametrize("wrong_version", [False, True], ids=["missing", "wrong-version"])
async def test_new_claim_requires_approved_components(
    site: _Site,
    inventory_path: Path,
    dataset_deployment: dict[str, DatasetConnection],
    requirement: tuple[_DataKind, str],
    wrong_version: bool,
) -> None:
    """逐项拒绝缺失或不匹配的批准声明，核对任务等候原因及无新增尝试和容量占用，再用完整库存领取同一任务。"""
    mode, field = requirement
    client, database = site
    validation = await _queue_validation(site, dataset_deployment, mode)
    full = dict(_CONNECTED if mode == "static" else _CONNECTED + _HTTP)
    incomplete = full.copy()
    if wrong_version:
        incomplete[field] = "9.0"
    else:
        del incomplete[field]
    _write_inventory(inventory_path, incomplete, invalid_field=field if wrong_version else None)
    response = await client.post(
        _CLAIM_PATH, json=_claim_request(validation), headers=auth(validation.credential)
    )
    assert response.status_code == 204
    async with database.sessions() as session:
        job = await session.get(Job, validation.job_id)
        assert job is not None and job.state == "QUEUED" and job.wait_reason == "NO_CAPABILITY"
        assert job.active_attempt_id is None
        assert not (await session.scalars(select(Attempt).where(Attempt.job_id == job.id))).all()
        assert not (await session.scalars(select(ResourceLease))).all()
        assert not (await session.scalars(select(CapacityPool).where(CapacityPool.used > 0))).all()
    _write_inventory(inventory_path, full)
    response = await client.post(
        _CLAIM_PATH, json=_claim_request(validation), headers=auth(validation.credential)
    )
    assert response.status_code == 200
    assert response.json()["data"]["jobId"] == validation.job_id
    assert response.json()["data"]["snapshotSha256"] == validation.manifest_hash


async def _upload_bundle(client: httpx.AsyncClient, validation: _Validation, claim: _Claim) -> str:
    """通过本次尝试正式上传合成文件、冻结源码与空入口计划，让完成服务可以检查真实保留的散列和长度。"""
    members = dict(_RELEASE_FILES)
    members.update(
        {
            "source/asset-snapshot.json": validation.source_file,
            "metadata/expected-plans.json": canonical_bytes({"schemaVersion": "1.0", "cases": []}),
        }
    )
    for name, content in members.items():
        await upload(client, validation.credential, claim, content, name)
    bundle = {
        "schemaVersion": "1.0",
        "sourceHash": validation.source_hash,
        **_release_identity(),
        "entrypoints": [],
        "validationOnly": True,
        "files": [
            _file_entry(name, content)
            for name, content in members.items()
            if name != "engine/compiler.tgz"
        ],
    }
    assert not validate_schema("CompiledAssetBundle", bundle)
    return await upload(
        client, validation.credential, claim, canonical_bytes(bundle), "bundle.json", "MANIFEST"
    )


async def _finish(
    client: httpx.AsyncClient,
    validation: _Validation,
    claim: _Claim,
    bundle_hash: str,
    inventory_hash: str,
) -> httpx.Response:
    """以与当前库存条目匹配的摘要提交完成清单，冻结任务、上传产物和租约证明均随本次完成请求保持绑定。"""
    proof = {key: claim[key] for key in ("leaseToken", "fencingToken")}
    completion = {
        "schemaVersion": "1.0",
        "attemptId": claim["attemptId"],
        "jobManifestSha256": validation.manifest_hash,
        "kind": "VALIDATE",
        "businessOutcome": "PASSED",
        "cleanupStatus": "NOT_REQUIRED",
        "evidence": [],
        "requiredEvidence": [],
        "processStopped": True,
        "processStopScope": "NO_PROCESS_SPAWNED",
        "compiledBundleSha256": bundle_hash,
        "engineInventorySha256": inventory_hash,
    }
    manifest = await upload(
        client,
        validation.credential,
        claim,
        canonical_bytes(completion),
        "completion.json",
        "MANIFEST",
    )
    return await client.post(
        f"/internal/v1/attempts/{claim['attemptId']}/finish",
        json={
            **proof,
            "kind": "VALIDATE",
            "outcome": "PASSED",
            "manifestSha256": manifest,
            "lastSequence": 0,
            "cleanupStatus": "NOT_REQUIRED",
        },
        headers=auth(validation.credential),
    )


async def _claim_and_activate(client: httpx.AsyncClient, validation: _Validation) -> _Claim:
    """创建并激活新的受管验证尝试，保留任务清单的精确绑定；已有领取请求标识的同次尝试重放沿用既有协议。"""
    response = await client.post(
        _CLAIM_PATH, json=_claim_request(validation), headers=auth(validation.credential)
    )
    assert response.status_code == 200
    claim: _Claim = response.json()["data"]
    assert claim["jobId"] == validation.job_id and claim["jobKind"] == "VALIDATE"
    assert claim["snapshotSha256"] == validation.manifest_hash
    activation = await client.post(
        f"/internal/v1/attempts/{claim['attemptId']}/activate",
        json={key: claim[key] for key in ("leaseToken", "fencingToken")},
        headers=auth(validation.credential),
    )
    assert activation.status_code == 200
    return claim


async def _assert_no_receipt(site: _Site, validation: _Validation, receipt_path: str) -> None:
    """用工作区公开入口与数据库同时确认拒绝后没有回执，避免只因任务尚未显示终态而忽略提前写入的记录。"""
    client, database = site
    unavailable = await client.get(receipt_path)
    assert unavailable.status_code == 409
    assert unavailable.json()["code"] == "VALIDATION_RECEIPT_UNAVAILABLE"
    async with database.sessions() as session:
        assert not (
            await session.scalars(
                select(ValidationReceipt).where(ValidationReceipt.job_id == validation.job_id)
            )
        ).all()


@pytest.mark.parametrize(
    ("mode", "missing"),
    (("none", None), ("static", None), ("http", None), *_CLAIM_REQUIRED_FIELDS),
)
async def test_finish_rechecks_current_approved_components(
    site: _Site,
    inventory_path: Path,
    dataset_deployment: dict[str, DatasetConnection],
    mode: _DataKind,
    missing: str | None,
) -> None:
    """已领取并激活的任务在签发回执时仍需当前库存支持，恢复声明后应能用同一尝试与同一编译产物成功完成。"""
    client = site[0]
    validation = await _queue_validation(site, dataset_deployment, mode)
    full = dict({"none": (), "static": _CONNECTED, "http": _CONNECTED + _HTTP}[mode])
    full_hash = _write_inventory(inventory_path, full)
    claim = await _claim_and_activate(client, validation)
    bundle_hash = await _upload_bundle(client, validation, claim)
    receipt_path = (
        f"/api/v1/workspaces/{validation.workspace_id}/jobs/{validation.job_id}/validation-receipt"
    )
    if missing is not None:
        reduced_hash = _write_inventory(
            inventory_path, {key: value for key, value in full.items() if key != missing}
        )
        assert reduced_hash != full_hash
        result = await _finish(client, validation, claim, bundle_hash, reduced_hash)
        assert result.status_code == 409
        assert result.json()["code"] == "ENGINE_NOT_APPROVED"
        await _assert_no_receipt(site, validation, receipt_path)
        assert _write_inventory(inventory_path, full) == full_hash

    result = await _finish(client, validation, claim, bundle_hash, full_hash)
    assert result.status_code == 200, result.text
    assert result.json()["data"]["outcome"] == "PASSED"
    result = await client.get(receipt_path)
    assert result.status_code == 200, result.text
    data = result.json()["data"]
    assert data["sourceHash"] == validation.source_hash
    assert data["compiledBundleSha256"] == bundle_hash
    assert data["engineVersion"] == _ENGINE_VERSION
