"""用真实租约与专用数据库验证静态行读取按冻结套件条目授权，并保留无序号和独立用例的历史读取。"""

from base64 import b64encode
from dataclasses import dataclass
from hashlib import sha256, sha512
from uuid import uuid4

import httpx
import pytest
from test_auth import login, setup
from test_lease_mysql import auth, claim_body, device, queued_browser_jobs
from test_workspace import workspace

from veriq_server.auth.authorization import WorkspaceScope
from veriq_server.contracts import asset_source_hash, canonical_bytes, validate_schema
from veriq_server.db import CaseExecution, Database, Job
from veriq_server.repositories.resource import ResourceRepository


@dataclass(frozen=True)
class FrozenVariant:
    """同一行键用于各矩阵版本，预期响应由场景直接指定，另可调整首条目的执行轴来单独检查绑定。"""

    index: int | None
    version_pick: int
    content: bytes | None
    second_value: str = "B"
    first_role: str = "reader"
    first_browser: str = "chromium"
    case_root: bool = False


def _asset(kind: str, version_id: str, document: dict[str, object]) -> dict[str, object]:
    """冻结资产按标准资产包络计算文档摘要，版本与资源标识分别生成，使内容相同的两个版本仍然不同。"""
    body = {"kind": kind, "document": document}
    return {
        **body,
        "versionId": version_id,
        "resourceId": str(uuid4()),
        "sha256": sha256(canonical_bytes(body)).hexdigest(),
    }


def _source(
    case: CaseExecution, versions: tuple[str, str], variant: FrozenVariant
) -> dict[str, object]:
    """固定用例默认矩阵用于第一条目，第二条目覆盖版本；完整原始源保留实际资源顺序与验证目标。"""
    catalog_id = str(uuid4())
    owner = _asset(
        "CASE",
        case.case_version_id,
        {
            "schemaVersion": "1.0",
            "caseKey": "read",
            "title": "Read",
            "kind": "READ",
            "roleKey": "reader",
            "catalogVersionId": catalog_id,
            "datasetVersionId": versions[0],
            "steps": [{"id": "open", "action": "goto", "path": "/"}],
        },
    )
    assets = [
        owner,
        _asset(
            "ELEMENT_CATALOG",
            catalog_id,
            {
                "schemaVersion": "1.0",
                "elements": [{"key": "name", "locator": {"by": "veriqId", "value": "name"}}],
            },
        ),
    ]
    for version_id, value in zip(versions, ("A", variant.second_value), strict=True):
        if variant.case_root and version_id != versions[0]:
            break
        assets.append(
            _asset(
                "DATASET",
                version_id,
                {
                    "schemaVersion": "1.0",
                    "columns": {"name": "string"},
                    "rows": [{"key": "shared", "values": {"name": value}}],
                },
            )
        )
    root = owner
    if not variant.case_root:
        root = _asset(
            "SUITE",
            str(uuid4()),
            {
                "schemaVersion": "1.0",
                "cases": [
                    {
                        "versionId": case.case_version_id,
                        "roleKeys": [variant.first_role],
                        "browsers": [variant.first_browser],
                    },
                    {"versionId": case.case_version_id, "datasetVersionId": versions[1]},
                ],
            },
        )
        assets.append(root)
    source = {
        "schemaVersion": "1.0",
        "workspaceId": case.workspace_id,
        "engineVersion": "0.1.0",
        "entryCaseVersionIds": [case.case_version_id],
        "assets": assets,
        "validationTarget": {
            "resourceId": root["resourceId"],
            "versionId": root["versionId"],
            "revision": 1,
        },
    }
    return {**source, "sourceHash": asset_source_hash(source)}


def _snapshot(
    case: CaseExecution, source: dict[str, object], version_id: str, variant: FrozenVariant
) -> dict[str, object]:
    """按本次所请求版本的真实行生成摘要，交叉场景只改变版本与条目的归属，保留行本身的完整性。"""
    value = ("A", variant.second_value)[variant.version_pick]
    row = {"key": "shared", "values": {"name": value}}
    origin = "https://example.test"
    return {
        "schemaVersion": "2.0",
        "workspaceId": case.workspace_id,
        "runId": case.run_id,
        "caseExecutionId": case.id,
        "caseVersionId": case.case_version_id,
        "assetSourceHash": source["sourceHash"],
        "environmentVersionId": str(uuid4()),
        "environment": {
            "schemaVersion": "1.0",
            "baseURL": origin,
            "apiBaseURL": origin,
            "allowedOrigins": [origin],
            "locale": "en-US",
            "timezone": "UTC",
            "roles": [
                {
                    "roleKey": "reader",
                    "authAdapterVersionId": str(uuid4()),
                    "secretRef": "business",
                    "secretVersionId": str(uuid4()),
                }
            ],
        },
        "roleKey": "reader",
        "browser": "chromium",
        "variables": {},
        "secretVersions": [],
        "namespace": "attempt_" + case.id.replace("-", ""),
        "attemptNo": 1,
        **({"suiteEntryIndex": variant.index} if variant.index is not None else {}),
        "datasetVersionId": version_id,
        "selectedRow": {
            "versionId": version_id,
            "rowKey": "shared",
            "rowSha256": sha256(canonical_bytes(row)).hexdigest(),
        },
    }


async def _store_manifest(
    repo: ResourceRepository, job: Job, case: CaseExecution, source: dict[str, object]
) -> str:
    """领取前存储引用实际冻结字节的完整清单和描述符，静态读取用例以这组服务端摘要完成真实激活。"""
    entrypoint = f"cases/{case.case_version_id}.test.ts"
    bundle_files = []
    for path, content in [
        ("source/asset-snapshot.json", canonical_bytes(source)),
        (entrypoint, b"export {};\n"),
    ]:
        bundle_files.append(
            {"path": path, "sha256": await repo.store(content), "sizeBytes": len(content)}
        )
    bundle = {
        "schemaVersion": "1.0",
        "sourceHash": source["sourceHash"],
        "engineVersion": "0.1.0",
        "compilerVersion": "0.1.0",
        "runnerSdkVersion": "0.1.0",
        "entrypoints": [{"caseVersionId": case.case_version_id, "path": entrypoint}],
        "files": bundle_files,
        "dependencies": [
            {
                "name": "@veriq/runner-sdk",
                "version": "0.1.0",
                "integrity": "sha512-" + b64encode(sha512(b"fixture").digest()).decode("ascii"),
            }
        ],
    }
    assert not validate_schema("CompiledAssetBundle", bundle)
    manifest = {
        "schemaVersion": "1.0",
        "workspaceId": case.workspace_id,
        "jobId": job.id,
        "snapshotSha256": job.snapshot_hash,
        "engineVersion": "0.1.0",
        "kind": "TEST",
        "caseExecutionId": case.id,
        "caseVersionId": case.case_version_id,
        "executionSnapshotSha256": job.snapshot_hash,
        "compiledBundleSha256": await repo.store(canonical_bytes(bundle)),
    }
    assert not validate_schema("TestJobManifestV1", manifest)
    return await repo.store(canonical_bytes(manifest))


async def _freeze(db: Database, ws: str, job_id: str, variant: FrozenVariant) -> str:
    """把合法原源与快照写入尚未领取的现有队列作业，版本错配仅由用例构造的内部冻结关系表达。"""
    versions = (str(uuid4()), str(uuid4()))
    version_id = versions[variant.version_pick]
    async with db.sessions.begin() as session:
        repo = ResourceRepository(session, WorkspaceScope(ws))
        job = await session.get(Job, job_id)
        assert job is not None
        case = await session.get(CaseExecution, job.case_execution_id)
        assert case is not None
        source = _source(case, versions, variant)
        frozen = _snapshot(case, source, version_id, variant)
        assert not validate_schema("AssetSnapshotV1", source)
        assert not validate_schema("ConnectedExecutionSnapshotV2", frozen)
        case.source_snapshot_hash = await repo.store(canonical_bytes(source))
        job.snapshot_hash = await repo.store(canonical_bytes(frozen))
        job.manifest_hash = await _store_manifest(repo, job, case, source)
        job.required_capabilities = {**job.required_capabilities, "connectedDatasets": "2.0"}
    return version_id


async def _active_attempt(
    client: httpx.AsyncClient, credentials: dict[str, str], job_id: str
) -> tuple[str, dict[str, str]]:
    """经真实设备领取入口声明联网能力并激活目标作业，静态请求使用该尝试签发的租约与围栏证明。"""
    request = claim_body(credentials)
    request["capabilities"] = {**request["capabilities"], "connectedDatasets": "2.0"}
    headers = auth(credentials)
    claimed = await client.post("/internal/v1/jobs/claim", json=request, headers=headers)
    assert claimed.status_code == 200
    claim = claimed.json()["data"]
    assert claim["jobId"] == job_id
    base = f"/internal/v1/attempts/{claim['attemptId']}"
    proof = {key: claim[key] for key in ("leaseToken", "fencingToken")}
    activated = await client.post(f"{base}/activate", json=proof, headers=headers)
    assert activated.status_code == 200
    assert activated.json()["data"]["activated"] is True
    return f"{base}/datasets/static", {
        **headers,
        "X-VeriQ-Lease-Token": proof["leaseToken"],
        "X-VeriQ-Fencing-Token": str(proof["fencingToken"]),
    }


@pytest.mark.parametrize(
    "variant",
    [
        pytest.param(
            FrozenVariant(0, 0, b'{"key":"shared","values":{"name":"A"}}'), id="zero-default"
        ),
        pytest.param(
            FrozenVariant(1, 1, b'{"key":"shared","values":{"name":"B"}}'), id="one-override"
        ),
        pytest.param(FrozenVariant(0, 1, None), id="crossed-version"),
        pytest.param(FrozenVariant(0, 1, None, second_value="A"), id="crossed-identical-content"),
        pytest.param(FrozenVariant(0, 0, None, first_role="editor"), id="wrong-role"),
        pytest.param(FrozenVariant(0, 0, None, first_browser="firefox"), id="wrong-browser"),
        pytest.param(FrozenVariant(2, 0, None), id="missing-entry"),
        pytest.param(
            FrozenVariant(None, 1, b'{"key":"shared","values":{"name":"B"}}'), id="no-index"
        ),
        pytest.param(
            FrozenVariant(3, 0, b'{"key":"shared","values":{"name":"A"}}', case_root=True),
            id="historical-case-index",
        ),
    ],
)
async def test_static_row_belongs_to_frozen_variant(
    site: tuple[httpx.AsyncClient, Database], variant: FrozenVariant
) -> None:
    """在同一活跃租约中先确认正文可供编译闭包读取，再验证行专用入口只能读取实际归属于该变体的版本。"""
    client, db = site
    await setup(client)
    await login(client)
    ws = await workspace(client)
    credentials = await device(client, ws)
    (job_id,) = await queued_browser_jobs(client, db, ws, 1)
    version_id = await _freeze(db, ws, job_id, variant)
    path, headers = await _active_attempt(client, credentials, job_id)
    dataset = await client.post(
        path, json={"selection": "DATASET", "versionId": version_id}, headers=headers
    )
    assert dataset.status_code == 200
    assert dataset.json()["rows"] == [
        {"key": "shared", "values": {"name": ("A", variant.second_value)[variant.version_pick]}}
    ]
    result = await client.post(
        path,
        json={"selection": "ROW", "versionId": version_id, "rowKey": "shared"},
        headers=headers,
    )
    if variant.content is None:
        assert result.status_code == 403
        assert result.json()["code"] == "DATASET_NOT_ASSIGNED"
    else:
        assert result.status_code == 200
        assert result.content == variant.content
