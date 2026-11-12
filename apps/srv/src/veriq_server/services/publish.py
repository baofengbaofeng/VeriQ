"""PublishService 在校验回执与草稿修订一致后发布不可变资源版本，并更新 latest_version_id，失败不留半发布状态。
继承 ResourceService 的授权与修订检查；发布必须 MANAGED 回执且源哈希匹配。
receipt_dto 导出回执稳定字段供 API 展示。
"""


import json
from typing import Any
from sqlalchemy import func, select
from ..auth.authorization import Permission, WorkspaceScope
from ..contracts import canonical_bytes, validate_schema
from ..db import ResourceVersion, ResourceDependency, ValidationReceipt
from ..repositories.resource import ResourceRepository
from ..service import Problem, audit, now, stamp
from .resource import ResourceService, document_hash, version_dto, asset_references


def receipt_dto(row: ValidationReceipt) -> dict[str, Any]:
    """将 ValidationReceipt 转为 API DTO，包含引擎、源哈希与编译产物摘要等字段，receipt_dto 遵守本文件 Workspace/事务边界。"""
    return {
        "id": row.id,
        "workspaceId": row.workspace_id,
        "resourceId": row.resource_id,
        "jobId": row.job_id,
        "revision": row.revision,
        "sourceHash": row.source_hash,
        "engineVersion": row.engine_version,
        "compiledBundleSha256": row.compiled_bundle_sha256,
        "validatedAt": stamp(row.validated_at),
        "runtimeId": row.runtime_id,
        "attemptId": row.attempt_id,
        "compilerTrust": row.compiler_trust,
    }


class PublishService(ResourceService):
    """在回执门禁通过后冻结草稿为 ResourceVersion，并维护依赖边与最新指针，PublishService 遵守本文件 Workspace/事务边界。"""
    async def publish(
        self, scope: WorkspaceScope, resource_id: str, draft_revision: int, receipt_id: str
    ) -> dict[str, Any]:
        """校验修订、回执与编译产物后写入不可变版本；冲突或回执失效返回 Problem，PublishService.publish 遵守本文件 Workspace/事务边界。"""
        resource = await self.editable(scope, resource_id, Permission.PUBLISH)
        repo = ResourceRepository(self.session, scope)
        draft = await repo.draft(resource_id)
        self.require_revision(draft, draft_revision)
        receipt = await repo.receipt(receipt_id)
        if (
            receipt is None
            or receipt.resource_id != resource_id
            or receipt.revision != draft_revision
        ):
            raise Problem(409, "INVALID_RECEIPT", "Receipt does not match this draft")
        snapshot = await self.snapshot(scope, resource, draft)
        if (
            receipt.source_hash != snapshot["sourceHash"]
            or receipt.engine_version != snapshot["engineVersion"]
        ):
            raise Problem(409, "INVALID_RECEIPT", "Receipt source or engine does not match")
        try:
            job = await repo.job(receipt.job_id)
            if (
                job.kind != "VALIDATE"
                or job.subject_id != resource_id
                or job.state != "FINISHED"
                or receipt.compiler_trust != "MANAGED"
                or receipt.attempt_id != job.active_attempt_id
            ):
                raise ValueError("Invalid validation job")
            retained = await repo.artifact(job.snapshot_hash)
            if retained.content != canonical_bytes(snapshot):
                raise ValueError("Snapshot changed")
            manifest = json.loads((await repo.artifact(job.manifest_hash)).content)
            expected = {
                "schemaVersion": "1.0",
                "workspaceId": scope.workspace_id,
                "jobId": job.id,
                "snapshotSha256": job.snapshot_hash,
                "engineVersion": snapshot["engineVersion"],
                "kind": "VALIDATE",
                "resourceId": resource_id,
                "revision": draft_revision,
                "sourceHash": snapshot["sourceHash"],
            }
            if manifest != expected:
                raise ValueError("Manifest changed")
            bundle = json.loads((await repo.artifact(receipt.compiled_bundle_sha256)).content)
            if (
                validate_schema("CompiledAssetBundle", bundle)
                or bundle["sourceHash"] != snapshot["sourceHash"]
                or bundle["engineVersion"] != snapshot["engineVersion"]
            ):
                raise ValueError("Compiled descriptor mismatch")
            entries = bundle["entrypoints"]
            if sorted(e["caseVersionId"] for e in entries) != sorted(
                snapshot["entryCaseVersionIds"]
            ):
                raise ValueError("Entrypoint selection mismatch")
            if bool(bundle.get("validationOnly")) != (not snapshot["entryCaseVersionIds"]):
                raise ValueError("Validation-only boundary mismatch")
            files = {f["path"]: f for f in bundle["files"]}
            if len(files) != len(bundle["files"]) or any(e["path"] not in files for e in entries):
                raise ValueError("Ambiguous or missing file")
            for file in files.values():
                artifact = await repo.artifact(file["sha256"])
                if artifact.size_bytes != file["sizeBytes"]:
                    raise ValueError("Compiled file size mismatch")
        except (ValueError, TypeError, KeyError, Problem):
            raise Problem(
                409,
                "INVALID_RECEIPT",
                "Validation provenance or compiled bytes are missing or inconsistent",
            ) from None
        existing = (
            await self.session.execute(
                select(ResourceVersion).where(
                    ResourceVersion.workspace_id == scope.workspace_id,
                    ResourceVersion.resource_id == resource_id,
                    ResourceVersion.draft_revision == draft_revision,
                )
            )
        ).scalar_one_or_none()
        if existing:
            published_receipt = await repo.receipt(existing.receipt_id)
            if (
                published_receipt is None
                or published_receipt.compiled_bundle_sha256 != receipt.compiled_bundle_sha256
            ):
                raise Problem(
                    409,
                    "REPRODUCIBILITY_CONFLICT",
                    "This immutable revision already binds different compiled artifacts",
                )
            if (
                existing.source_hash != snapshot["sourceHash"]
                or existing.engine_version != snapshot["engineVersion"]
                or existing.sha256 != document_hash(draft.document_json)
            ):
                raise Problem(
                    409,
                    "REVISION_ALREADY_PUBLISHED",
                    "This revision was published with a different source or engine; save a new revision",
                )
            return version_dto(existing)
        number = (
            await self.session.execute(
                select(func.max(ResourceVersion.version_no)).where(
                    ResourceVersion.workspace_id == scope.workspace_id,
                    ResourceVersion.resource_id == resource_id,
                )
            )
        ).scalar_one() or 0
        version = ResourceVersion(
            id=snapshot["validationTarget"]["versionId"],
            resource_id=resource_id,
            workspace_id=scope.workspace_id,
            kind=resource.kind,
            version_no=number + 1,
            draft_revision=draft_revision,
            document_json=draft.document_json,
            sha256=document_hash(draft.document_json),
            source_hash=snapshot["sourceHash"],
            engine_version=snapshot["engineVersion"],
            receipt_id=receipt.id,
            published_by=self.user.id,
            published_at=now(),
        )
        self.session.add(version)
        await self.session.flush()
        for dep, _ in asset_references(draft.document_json):
            self.session.add(
                ResourceDependency(
                    workspace_id=scope.workspace_id,
                    version_id=version.id,
                    dependency_version_id=dep,
                )
            )
        resource.latest_version_id, resource.status = version.id, "PUBLISHED"
        audit(
            self.session,
            "resource.published",
            self.user.id,
            version.id,
            workspace_id=scope.workspace_id,
        )
        return version_dto(version)
