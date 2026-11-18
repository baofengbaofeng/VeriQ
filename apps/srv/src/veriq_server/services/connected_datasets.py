"""工作区内完整冻结源仅供服务端保存，联网任务采用剔除静态行的独立投影，编译回执仍以原始版本摘要为准。"""

import json
from hashlib import sha256
from typing import Any
from uuid import uuid4

from sqlalchemy import or_, select

from ..contracts import asset_source_hash, canonical_bytes, validate_schema
from ..db import CaseExecution, Job, ValidationReceipt
from ..repositories.resource import ResourceRepository
from ..service import Problem, now
from .snapshots import execution_data_row


async def frozen_object(repo: ResourceRepository, digest: str, schema: str | None = None) -> dict:
    """仅将已读取静态字节的解码或结构失败归为永久溯源错误，数据库连接与事务错误继续沿原始重试路径上报。"""
    artifact = await repo.artifact(digest)
    try:
        value = json.loads(artifact.content)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Invalid frozen document") from None
    if not isinstance(value, dict) or (schema and validate_schema(schema, value)):
        raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Invalid frozen document")
    return value


def checksum(value: Any) -> str:
    """对约定传递的对象使用跨语言规范编码计算摘要，树行在此之前已按矩阵语义去掉与执行无关的排序字段。"""
    return sha256(canonical_bytes(value)).hexdigest()


def project_source(source: dict) -> dict:
    """数据资产保留版本、声明与双重摘要，顺序沿用冻结快照以便还原；没有数据集的旧任务可以继续按原契约读取。"""
    if not any(a["kind"] == "DATASET" for a in source["assets"]):
        return source
    assets = []
    for a in source["assets"]:
        if a["kind"] != "DATASET":
            assets.append(a)
            continue
        doc = a["document"]
        schema = {k: doc[k] for k in ("schemaVersion", "columns", "shape", "fields") if k in doc}
        assets.append(
            {
                **{k: a[k] for k in ("kind", "resourceId", "versionId", "sha256")},
                "schema": schema,
                "contentSha256": checksum(doc),
            }
        )
    return {**source, "assets": assets, "schemaVersion": "2.0", "originalSha256": checksum(source)}


def project_execution(execution: dict, source: dict) -> dict:
    """矩阵只给执行目录保留行键与行摘要，别名独立锁定版本；源中包含其它套件变体的数据时也启用联网格式。"""
    if not any(a["kind"] == "DATASET" for a in source["assets"]):
        return execution
    projected = {**execution, "schemaVersion": "2.0"}
    if row := projected.pop("dataRow", None):
        if not projected.get("datasetVersionId"):
            raise Problem(
                409, "COMPILED_PROVENANCE_REQUIRED", "Original row has no assigned version"
            )
        projected["selectedRow"] = {
            "versionId": execution["datasetVersionId"],
            "rowKey": row["key"],
            "rowSha256": checksum(row),
        }
    return projected


async def revalidate_bundle(
    repo: ResourceRepository,
    validation: Job,
    source: dict,
    bundle: dict,
    receipt: ValidationReceipt,
    *,
    requester: str,
    service_token: str | None = None,
    plan_id: str | None = None,
) -> tuple[Job, str | None]:
    """旧发布回执不可变，以独立幂等验证任务重新编译原始冻结快照，使用同一个版本和引擎，绝不读取当前草稿。"""
    retained = {k: v for k, v in source.items() if k != "validationTarget"}
    expected = project_source(retained)
    if expected is retained:
        return validation, receipt.compiled_bundle_sha256
    member = next((f for f in bundle["files"] if f["path"] == "source/asset-snapshot.json"), None)
    if not member:
        raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Compiled source missing")
    if member["sha256"] == checksum(expected) and validation.required_capabilities.get(
        "connectedDatasets"
    ):
        return validation, receipt.compiled_bundle_sha256
    if member["sha256"] != checksum(retained):
        raise Problem(
            409, "COMPILED_PROVENANCE_REQUIRED", "Retained source differs from frozen version"
        )
    key = checksum(
        {
            "connectedDatasets": "2.0",
            "validationJobId": validation.id,
            "requester": requester,
            "serviceToken": service_token,
            "planId": plan_id,
        }
    )
    # 已有版本使用单一幂等键；同一组后续重验证另取代次键。保留失败任务和旧依赖的关联，使既有运行终态可追查。
    group = key
    existing = (
        await repo.session.execute(
            select(Job)
            .where(
                Job.workspace_id == repo.scope.workspace_id,
                Job.subject_id == validation.subject_id,
                or_(
                    Job.validation_key == group,
                    Job.required_capabilities["revalidationGroup"].as_string() == group,
                ),
            )
            .order_by(
                Job.required_capabilities["revalidationGeneration"].as_integer().desc(),
                Job.id.desc(),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    generation = 0
    if existing:
        if existing.state != "CANCEL_REQUESTED" and (
            existing.state != "FINISHED" or existing.outcome == "PASSED"
        ):
            return existing, None
        generation = existing.required_capabilities.get("revalidationGeneration", 0) + 1
        key = checksum({"group": group, "generation": generation})
    jid = str(uuid4())
    manifest = await frozen_object(repo, validation.manifest_hash, "JobManifestV1")
    manifest.update(
        jobId=jid, snapshotSha256=await repo.store(canonical_bytes(project_source(source)))
    )
    job = Job(
        id=jid,
        workspace_id=validation.workspace_id,
        kind="VALIDATE",
        subject_id=validation.subject_id,
        state="QUEUED",
        snapshot_hash=validation.snapshot_hash,
        manifest_hash=await repo.store(canonical_bytes(manifest)),
        validation_key=key,
        required_capabilities={
            "engineVersion": source["engineVersion"],
            "compileAssets": True,
            "connectedDatasets": "2.0",
            "publishedValidationJobId": validation.id,
            "revalidationGroup": group,
            "revalidationGeneration": generation,
            **({"revalidationPlanId": plan_id} if service_token else {}),
        },
        requester_service_token_id=service_token,
        created_by=requester,
        created_at=now(),
    )
    repo.session.add(job)
    await repo.session.flush()
    return job, None


async def static_bytes(
    repo: ResourceRepository, job: Job, snapshot_hash: str, selection: dict
) -> bytes:
    """验证候选源只在验证任务内可读，执行任务从其用例冻结的完整闭包重建编译输入，行选择还必须匹配该次矩阵。"""
    denied = Problem(403, "DATASET_NOT_ASSIGNED", "Dataset selection is not assigned to Attempt")
    subject = json.loads((await repo.artifact(snapshot_hash)).content)
    if subject.get("workspaceId") != repo.scope.workspace_id:
        raise denied
    mode = selection["selection"]
    if (
        job.kind == "VALIDATE"
        and mode == "VALIDATION_SOURCE"
        and job.required_capabilities.get("connectedDatasets")
    ):
        if asset_source_hash(subject) != subject["sourceHash"]:
            raise Problem(409, "SOURCE_HASH_MISMATCH", "Frozen validation source differs")
        return canonical_bytes(subject)
    if job.kind != "TEST" or mode == "VALIDATION_SOURCE" or subject.get("schemaVersion") != "2.0":
        raise denied
    case = await repo.session.get(CaseExecution, job.case_execution_id)
    if (
        not case
        or case.workspace_id != repo.scope.workspace_id
        or case.id != subject["caseExecutionId"]
    ):
        raise denied
    source = json.loads((await repo.artifact(case.source_snapshot_hash)).content)
    if (
        source["workspaceId"] != case.workspace_id
        or asset_source_hash(source) != subject["assetSourceHash"]
    ):
        raise denied
    asset = next(
        (
            a
            for a in source["assets"]
            if a["kind"] == "DATASET" and a["versionId"] == selection["versionId"]
        ),
        None,
    )
    if not asset:
        raise denied
    doc = asset["document"]
    if asset["sha256"] != checksum({"kind": "DATASET", "document": doc}):
        raise Problem(409, "DATASET_HASH_MISMATCH", "Frozen dataset differs")
    if mode == "DATASET":
        return canonical_bytes(doc)
    row = subject.get("selectedRow", {})
    if (
        row.get("versionId") != asset["versionId"]
        or row.get("versionId") != subject.get("datasetVersionId")
        or row.get("rowKey") != selection["rowKey"]
    ):
        raise denied
    rows = doc["rows"] if doc["schemaVersion"] == "1.0" else doc["source"]["rows"]
    selected = next((execution_data_row(r) for r in rows if r["key"] == row["rowKey"]), None)
    if not selected or checksum(selected) != row["rowSha256"]:
        raise Problem(409, "ROW_HASH_MISMATCH", "Frozen row differs")
    return canonical_bytes(selected)


async def legacy_source(repo: ResourceRepository, job: Job) -> dict | None:
    """旧任务未携带能力标记时检查服务器保留的原始源，避免升级前派发的租约继续从普通附件入口下载完整数据正文。"""
    if job.kind not in {"TEST", "VALIDATE"} or job.required_capabilities.get("connectedDatasets"):
        return None
    digest = job.snapshot_hash
    if job.kind == "TEST":
        case = await repo.session.get(CaseExecution, job.case_execution_id)
        if not case or case.workspace_id != repo.scope.workspace_id:
            raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Missing original case")
        digest = case.source_snapshot_hash
    source = await frozen_object(repo, digest)
    assets = source.get("assets", [])
    if not isinstance(assets, list) or any(
        not isinstance(asset, dict) or not asset.get("kind") for asset in assets
    ):
        raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Invalid historical assets")
    if not any(asset["kind"] == "DATASET" for asset in assets):
        return None
    if (
        validate_schema("AssetSnapshotV1", source)
        or asset_source_hash(source) != source["sourceHash"]
    ):
        raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Invalid historical source")
    return source


async def upgrade_queued(repo: ResourceRepository, job: Job) -> bool:
    """已排队的历史任务只在任何新租约产生之前更换传输投影；原始验证源和既有尝试的不可变清单始终保留。"""
    source = await legacy_source(repo, job)
    if not source:
        return False
    manifest = await frozen_object(repo, job.manifest_hash)
    caps = {**job.required_capabilities, "connectedDatasets": "2.0"}
    if job.kind == "VALIDATE":
        manifest["snapshotSha256"] = await repo.store(canonical_bytes(project_source(source)))
    else:
        subject = await frozen_object(repo, job.snapshot_hash, "ExecutionSnapshotV1")
        if (
            source.get("sourceHash") != subject["assetSourceHash"]
            or asset_source_hash(source) != source["sourceHash"]
        ):
            raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Assigned source identity differs")
        projected = project_execution(subject, source)
        job.snapshot_hash = await repo.store(canonical_bytes(projected))
        manifest["executionSnapshotSha256"] = manifest["snapshotSha256"] = job.snapshot_hash
        if manifest.pop("compiledBundleSha256", None):
            case = await repo.session.get(CaseExecution, job.case_execution_id)
            validation_id = (
                case.provenance.get("validationJobId")
                if isinstance(case.provenance, dict)
                else None
            )
            if not isinstance(validation_id, str):
                raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Original validation missing")
            validation = await repo.job(validation_id)
            if validation.snapshot_hash != case.source_snapshot_hash:
                raise Problem(
                    409, "COMPILED_PROVENANCE_REQUIRED", "Validation differs from original case"
                )
            manifest["pendingValidationJobId"] = caps["validationJobId"] = validation.id
    job.manifest_hash = await repo.store(canonical_bytes(manifest))
    job.required_capabilities = caps
    return True
