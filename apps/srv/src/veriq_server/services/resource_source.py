"""已发布编译源码读取核对回执、VALIDATE Job 与 CompiledAssetBundle 后仅暴露白名单 TS 路径。
回执须匹配修订/源哈希/引擎/MANAGED；size 不一致拒绝，防清单漂移。
"""


import json
import re
from typing import Any

from ..contracts import validate_schema
from ..repositories.resource import ResourceRepository
from ..service import Problem


_SOURCE_PATH = re.compile(r"(?:validation\.ts|source/context\.ts|cases/[0-9a-fA-F-]{36}\.test\.ts)")


async def compiled_source(
    repo: ResourceRepository, resource_id: str, version_id: str, path: str | None
) -> tuple[dict[str, Any], bytes | None]:
    """验证发布溯源后返回元数据，可选读取单个生成 TypeScript 文件字节，compiled_source 路径必须遵守 Workspace 作用域。"""
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
        or receipt.compiler_trust != "MANAGED"
    ):
        raise Problem(409, "INVALID_RECEIPT", "Published compilation provenance is unavailable")
    job = await repo.job(receipt.job_id)
    if (
        job.kind != "VALIDATE"
        or job.subject_id != resource_id
        or job.state != "FINISHED"
        or job.active_attempt_id != receipt.attempt_id
    ):
        raise Problem(409, "INVALID_RECEIPT", "Published compilation provenance is unavailable")
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
