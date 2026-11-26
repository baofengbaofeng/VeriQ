"""已发布编译源码读取核对回执、VALIDATE Job 与 CompiledAssetBundle 后仅暴露白名单 TS
路径。回执须匹配修订/源哈希/引擎/MANAGED；size 不一致拒绝，防清单漂移。
"""

import json
import re
from typing import Any

from sqlalchemy import select

from ..db import Job, ValidationReceipt
from ..contracts import asset_source_hash, validate_schema
from .compilation_provenance import validation_origin_filter, validation_origin_matches
from .connected_datasets import project_source, checksum
from ..repositories.resource import ResourceRepository
from ..service import Problem

_SOURCE_PATH = re.compile(r"(?:validation\.ts|source/context\.ts|cases/[0-9a-fA-F-]{36}\.test\.ts)")


async def compiled_source(
    repo: ResourceRepository, resource_id: str, version_id: str, path: str | None
) -> tuple[dict[str, Any], bytes | None]:
    """验证发布溯源后返回元数据，可选读取单个生成 TypeScript 文件字节，compiled_source 路径必须遵守 Workspace 作用域。
    compiled_source 实现于 apps/srv/src/veriq_server/services/resource_source.py：请按该符号的输入校验、
    错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    await repo.resource(resource_id)
    version = await repo.version(version_id)
    if version.resource_id != resource_id:
        raise Problem(404, "VERSION_NOT_FOUND", "Version not found")
    receipt = await repo.receipt(version.receipt_id)
    if (
        receipt is None
        or receipt.resource_id != resource_id
        or receipt.revision != version.draft_revision
        or receipt.source_hash != version.source_hash
        or receipt.engine_version != version.engine_version
    ):
        raise Problem(409, "INVALID_RECEIPT", "Published compilation provenance is unavailable")
    job = await repo.job(receipt.job_id)
    if not validation_origin_matches(job, receipt):
        raise Problem(409, "INVALID_RECEIPT", "Published compilation provenance is unavailable")
    frozen = json.loads((await repo.artifact(job.snapshot_hash)).content)
    retained = (
        {k: v for k, v in frozen.items() if k != "validationTarget"}
        if frozen["entryCaseVersionIds"]
        else frozen
    )
    expected = project_source(retained)
    if expected is not retained and not job.required_capabilities.get("connectedDatasets"):
        # 历史源码视图按原始任务和不可变快照查找已完成的联网重验证，读取操作自身不创建任务或改变发布版本的回执。
        migrated = (
            await repo.session.execute(
                select(ValidationReceipt)
                .join(Job, Job.id == ValidationReceipt.job_id)
                .where(
                    Job.workspace_id == repo.scope.workspace_id,
                    Job.required_capabilities["publishedValidationJobId"].as_string() == job.id,
                    Job.required_capabilities["connectedDatasets"].as_string() == "2.0",
                    Job.snapshot_hash == job.snapshot_hash,
                    Job.outcome == "PASSED",
                    validation_origin_filter(),
                    ValidationReceipt.source_hash == version.source_hash,
                    ValidationReceipt.engine_version == version.engine_version,
                    ValidationReceipt.resource_id == resource_id,
                    ValidationReceipt.revision == version.draft_revision,
                )
                .order_by(ValidationReceipt.id)
                .limit(1)
            )
        ).scalar_one_or_none()
        if not migrated:
            raise Problem(
                409,
                "CONNECTED_REVALIDATION_REQUIRED",
                "Published source requires connected validation",
            )
        receipt = migrated
    descriptor = await repo.artifact(receipt.compiled_bundle_sha256)
    try:
        bundle = json.loads(descriptor.content)
    except (ValueError, UnicodeDecodeError):
        raise Problem(409, "INVALID_ARTIFACT", "Compiled descriptor is invalid") from None
    if (
        validate_schema("CompiledAssetBundle", bundle)
        or bundle["sourceHash"] != version.source_hash
        or bundle["engineVersion"] != version.engine_version
    ):
        raise Problem(409, "INVALID_ARTIFACT", "Compiled descriptor is inconsistent")
    if expected is not retained and (
        asset_source_hash(frozen) != version.source_hash
        or not any(
            f["path"] == "source/asset-snapshot.json" and f["sha256"] == checksum(expected)
            for f in bundle["files"]
        )
    ):
        raise Problem(409, "INVALID_ARTIFACT", "Retained connected source differs")
    files = [file for file in bundle["files"] if _SOURCE_PATH.fullmatch(file["path"])]
    if len({file["path"] for file in bundle["files"]}) != len(bundle["files"]):
        raise Problem(409, "INVALID_ARTIFACT", "Compiled descriptor has duplicate paths")
    metadata = {"descriptorSha256": receipt.compiled_bundle_sha256, "files": files}
    if path is None:
        return metadata, None
    member = next((file for file in files if file["path"] == path), None)
    if member is None:
        raise Problem(404, "SOURCE_NOT_FOUND", "Generated TypeScript file not found")
    artifact = await repo.artifact(member["sha256"])
    if artifact.size_bytes != member["sizeBytes"]:
        raise Problem(409, "INVALID_ARTIFACT", "Compiled source length is inconsistent")
    return metadata, artifact.content
