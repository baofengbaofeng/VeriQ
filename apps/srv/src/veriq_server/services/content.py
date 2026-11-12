"""在线 Attempt 证据上传与内容下载：分块写入受租约与围栏约束，完成前对报告不可见，下载校验 digest，本文件注释仅描述该模块专属行为。
create_upload 建立 AttemptUpload 与 publication；chunk 追加字节并校验偏移。
"""


import json
from hashlib import sha256
from typing import Any
from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import WorkspaceScope
from ..contracts import validate_schema
from ..credentials.resolve import CredentialProofTransport
from ..db import AttemptUpload, Artifact
from ..repositories.resource import ResourceRepository
from ..service import Problem, stamp
from ..settings import Settings
from .lease import LeaseService

MAX_FILE = 32 * 1024 * 1024
MAX_ATTEMPT_BYTES = 256 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024


class ContentService:
    """编排在线证据上传会话与按 digest 下载，所有操作绑定 Attempt 租约证明，ContentService 遵守本文件 Workspace/事务边界。"""
    def __init__(self, session: AsyncSession, settings: Settings):
        """注入会话与 Settings，用于租约校验与产物存储后端选择，ContentService.__init__ 遵守本文件 Workspace/事务边界。"""
        self.session, self.settings = session, settings

    async def create_upload(
        self, attempt_id: str, proof: CredentialProofTransport, data: dict[str, Any]
    ) -> dict[str, Any]:
        """在有效租约下创建上传会话与 PENDING publication，返回 uploadId，ContentService.create_upload 遵守本文件 Workspace/事务边界。"""
        attempt, _, _, _ = await LeaseService(self.session, self.settings).proof(attempt_id, proof)
        if data["sizeBytes"] > MAX_FILE or validate_schema("FilePath", data["filename"]):
            raise Problem(413, "UPLOAD_LIMIT", "Upload filename or size is outside limits")
        rows = (
            (
                await self.session.execute(
                    select(AttemptUpload).where(AttemptUpload.attempt_id == attempt_id)
                )
            )
            .scalars()
            .all()
        )
        metadata = {k: v for k, v in data.items() if k not in {"leaseToken", "fencingToken"}}
        existing = next((r for r in rows if r.metadata_json == metadata), None)
        if not existing:
            if (
                len(rows) >= 1000
                or sum(r.size_bytes for r in rows) + data["sizeBytes"] > MAX_ATTEMPT_BYTES
            ):
                raise Problem(413, "UPLOAD_LIMIT", "Attempt upload budget exceeded")
            existing = AttemptUpload(
                id=str(uuid4()),
                attempt_id=attempt_id,
                workspace_id=attempt.workspace_id,
                sha256=data["sha256"],
                size_bytes=data["sizeBytes"],
                metadata_json=metadata,
                content=b"",
                complete=False,
            )
            self.session.add(existing)
        return {
            "artifactId": existing.id,
            "uploadUrl": f"{self.settings.public_url}/internal/v1/attempts/{attempt_id}/artifact-uploads/{existing.id}",
            "method": "PUT",
            "expiresAt": stamp(attempt.lease_expires_at),
        }

    async def chunk(
        self,
        attempt_id: str,
        upload_id: str,
        proof: CredentialProofTransport,
        offset: int,
        content: bytes,
        *,
        external: bytes | None = None,
        staged: tuple[bytes, bool, str, str | None] | None = None,
    ) -> dict[str, Any]:
        """按偏移写入分块并更新进度；偏移不连续或租约失效则拒绝，ContentService.chunk 遵守本文件 Workspace/事务边界。"""
        attempt, _, _, _ = await LeaseService(self.session, self.settings).proof(attempt_id, proof)
        upload = await self.session.get(AttemptUpload, upload_id)
        if (
            not upload
            or upload.attempt_id != attempt.id
            or upload.workspace_id != attempt.workspace_id
        ):
            raise Problem(404, "UPLOAD_NOT_FOUND", "Upload not assigned to Attempt")
        if upload.expired_at:
            raise Problem(410, "ARTIFACT_EXPIRED", "Evidence retention has expired")
        if len(content) > CHUNK_BYTES or offset < 0 or offset + len(content) > upload.size_bytes:
            raise Problem(413, "UPLOAD_LIMIT", "Chunk exceeds upload bounds")
        repo = ResourceRepository(self.session, WorkspaceScope(attempt.workspace_id))
        if staged and (upload.content != staged[0] or upload.complete != staged[1]):
            raise Problem(409, "UPLOAD_CONFLICT", "Upload changed during storage staging")
        retained = (
            (external if external is not None else (await repo.artifact(upload.sha256)).content)
            if upload.complete
            else upload.content
        )
        if offset < len(retained) or upload.complete:
            if retained[offset : offset + len(content)] != content:
                raise Problem(409, "UPLOAD_CONFLICT", "Replayed chunk differs")
        elif offset != len(retained):
            raise Problem(409, "UPLOAD_OFFSET", "Upload offset is not contiguous")
        else:
            retained += content
            if len(retained) == upload.size_bytes:
                if sha256(retained).hexdigest() != upload.sha256:
                    raise Problem(
                        409, "UPLOAD_HASH_MISMATCH", "Uploaded bytes do not match declared hash"
                    )
                if staged and staged[2] != "INLINE":
                    from ..db import ArtifactPublication

                    publication = (
                        await self.session.get(ArtifactPublication, staged[3])
                        if staged[3]
                        else None
                    )
                    existing = await self.session.get(
                        Artifact, (attempt.workspace_id, upload.sha256)
                    )
                    if (
                        not existing
                        or existing.expired_at
                        or existing.storage_backend != staged[2]
                        or existing.storage_incarnation != staged[3]
                        or (publication and publication.state == "RETIRED")
                    ):
                        raise Problem(
                            409, "UPLOAD_CONFLICT", "Artifact incarnation changed during staging"
                        )
                    if publication:
                        publication.state = "COMMITTED"
                else:
                    await repo.store(retained, upload.metadata_json["contentType"])
                upload.complete, upload.content = True, b""
            else:
                upload.content = retained
        return {
            "artifactId": upload.id,
            "receivedBytes": len(retained),
            "complete": upload.complete,
        }

    async def download(
        self, workspace_id: str, attempt_id: str, digest: str, proof: CredentialProofTransport
    ) -> bytes:
        """按 Workspace 与 digest 读取已提交产物，供 Runtime 拉取钉死内容，ContentService.download 遵守本文件 Workspace/事务边界。"""
        attempt, job, _, _ = await LeaseService(self.session, self.settings).proof(
            attempt_id, proof, active=False
        )
        if workspace_id != attempt.workspace_id:
            raise Problem(404, "CONTENT_NOT_FOUND", "Content is not assigned to Attempt")
        repo = ResourceRepository(self.session, WorkspaceScope(workspace_id))
        allowed = {job.snapshot_hash, job.manifest_hash}
        manifest = json.loads((await repo.artifact(job.manifest_hash)).content)
        bundle_hash = manifest.get("compiledBundleSha256")
        if bundle_hash:
            allowed.add(bundle_hash)
            bundle = json.loads((await repo.artifact(bundle_hash)).content)
            allowed.update(f["sha256"] for f in bundle["files"])
        if digest not in allowed:
            raise Problem(404, "CONTENT_NOT_FOUND", "Content is not assigned to Attempt")
        return (await repo.artifact(digest)).content
