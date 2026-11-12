"""Bounded offline bytes use the same private publication and retirement store as online evidence."""

from datetime import timedelta
from hashlib import sha256
from typing import Any
from uuid import uuid4
from sqlalchemy import select
from ..auth.authorization import WorkspaceScope
from ..bundles.authority import authority_guard
from ..contracts import validate_schema
from ..db import OfflineImportUpload, OfflineImport, OfflineAttempt, Artifact, ArtifactPublication
from ..service import Problem, now, lock_installation
from .import_result import ImportService
from .bundle import safe_path
from .artifact import artifact_store, listed_offline_artifact


class ImportUploadService(ImportService):
    async def reserve(self, scope: WorkspaceScope, req: dict[str, Any]) -> OfflineImportUpload:
        file = req["file"]
        if (
            validate_schema("OfflineArtifactV1", file)
            or not safe_path(file["path"])
            or file["sizeBytes"] > 32 * 1024 * 1024
            or "kind" not in file
        ):
            raise Problem(400, "INVALID_OFFLINE_ARTIFACT", "Invalid bounded artifact descriptor")
        await self.session.commit()
        async with authority_guard(self.settings, False) as authority:
            await lock_installation(self.session)
            await self.authorize(scope, req["bundleId"], authority)
            existing = (
                await self.session.execute(
                    select(OfflineImportUpload).where(
                        OfflineImportUpload.workspace_id == scope.workspace_id,
                        OfflineImportUpload.bundle_id == req["bundleId"],
                        OfflineImportUpload.local_run_id == req["localRunId"],
                        OfflineImportUpload.local_attempt_id == req["attemptId"],
                        OfflineImportUpload.path == file["path"],
                    )
                )
            ).scalar_one_or_none()
            imported = await self.imported(scope, req["bundleId"], req["localRunId"])
            if imported and not existing:
                raise Problem(409, "OFFLINE_IMPORT_IMMUTABLE", "Result artifact set is committed")
            if existing:
                await self.committed_artifact(scope, existing, imported)
                if (
                    existing.actor_id != self.actor.id
                    or existing.sha256 != file["sha256"]
                    or existing.size_bytes != file["sizeBytes"]
                    or existing.kind != file["kind"]
                ):
                    raise Problem(409, "IDEMPOTENCY_CONFLICT", "Artifact upload is already bound")
                if existing.expired_at:
                    raise Problem(410, "ARTIFACT_EXPIRED", "Upload is expired")
                await self.session.commit()
                return existing
            count = len(
                list(
                    (
                        await self.session.execute(
                            select(OfflineImportUpload.id)
                            .where(
                                OfflineImportUpload.workspace_id == scope.workspace_id,
                                OfflineImportUpload.bundle_id == req["bundleId"],
                                OfflineImportUpload.local_run_id == req["localRunId"],
                            )
                            .limit(1001)
                        )
                    ).scalars()
                )
            )
            if count >= 1000:
                raise Problem(413, "UPLOAD_LIMIT", "Local Run upload count exceeds limit")
            row = OfflineImportUpload(
                id=str(uuid4()),
                workspace_id=scope.workspace_id,
                bundle_id=req["bundleId"],
                local_run_id=req["localRunId"],
                local_attempt_id=req["attemptId"],
                actor_id=self.actor.id,
                path=file["path"],
                sha256=file["sha256"],
                size_bytes=file["sizeBytes"],
                kind=file["kind"],
                sensitivity="CREDENTIAL_RESTRICTED",
                content=b"",
                state="PENDING",
                created_at=now(),
                expires_at=now() + timedelta(hours=24),
            )
            self.session.add(row)
            await self.session.commit()
            return row

    async def imported(
        self, scope: WorkspaceScope, bundle_id: str, local_run_id: str
    ) -> OfflineImport | None:
        return (
            await self.session.execute(
                select(OfflineImport).where(
                    OfflineImport.workspace_id == scope.workspace_id,
                    OfflineImport.bundle_id == bundle_id,
                    OfflineImport.local_run_id == local_run_id,
                )
            )
        ).scalar_one_or_none()

    async def committed_artifact(
        self, scope: WorkspaceScope, row: OfflineImportUpload, imported: OfflineImport | None
    ) -> None:
        if imported is None:
            return
        attempt = (
            await self.session.execute(
                select(OfflineAttempt).where(
                    OfflineAttempt.workspace_id == scope.workspace_id,
                    OfflineAttempt.import_id == imported.id,
                    OfflineAttempt.local_attempt_id == row.local_attempt_id,
                )
            )
        ).scalar_one_or_none()
        if (
            row.state != "COMPLETE"
            or not attempt
            or not listed_offline_artifact(attempt.document, row)
        ):
            raise Problem(
                409, "OFFLINE_IMPORT_IMMUTABLE", "Upload is absent from the committed result"
            )

    async def current(
        self, scope: WorkspaceScope, upload_id: str, authority: Any
    ) -> OfflineImportUpload:
        row = await self.session.get(OfflineImportUpload, upload_id, populate_existing=True)
        if not row or row.workspace_id != scope.workspace_id:
            raise Problem(404, "UPLOAD_NOT_FOUND", "Upload not found")
        await self.authorize(scope, row.bundle_id, authority)
        if row.actor_id != self.actor.id:
            raise Problem(403, "UPLOAD_FORBIDDEN", "Upload actor differs")
        if row.expired_at or (row.state != "COMPLETE" and row.expires_at <= now()):
            raise Problem(410, "ARTIFACT_EXPIRED", "Upload expired")
        await self.committed_artifact(
            scope, row, await self.imported(scope, row.bundle_id, row.local_run_id)
        )
        return row

    async def chunk(
        self, scope: WorkspaceScope, upload_id: str, offset: int, raw: bytes
    ) -> dict[str, Any]:
        if len(raw) > 1024 * 1024 or offset < 0:
            raise Problem(413, "CHUNK_LIMIT", "Chunk exceeds bound")
        await self.session.commit()
        replay = await self.completed_chunk(scope, upload_id, offset, raw)
        if replay is not None:
            return replay
        content: bytes | None = None
        async with authority_guard(self.settings, False) as authority:
            await lock_installation(self.session)
            row = await self.current(scope, upload_id, authority)
            if row.state == "COMPLETE":
                raise Problem(
                    409, "UPLOAD_RACE_RETRY", "Upload completed concurrently; replay the same chunk"
                )
            retained = row.content or b""
            if offset > len(retained) or offset + len(raw) > row.size_bytes:
                raise Problem(409, "UPLOAD_OFFSET_MISMATCH", "Upload offset differs")
            if offset < len(retained):
                if retained[offset : offset + len(raw)] != raw:
                    raise Problem(409, "UPLOAD_BYTES_CHANGED", "Chunk replay differs")
            else:
                retained += raw
                row.content = retained
            if len(retained) < row.size_bytes:
                await self.session.commit()
                return {"id": row.id, "receivedBytes": len(retained), "complete": False}
            if sha256(retained).hexdigest() != row.sha256:
                raise Problem(409, "ARTIFACT_HASH_MISMATCH", "Complete bytes differ")
            artifact = await self.session.get(Artifact, (scope.workspace_id, row.sha256))
            if artifact and not artifact.expired_at:
                if artifact.size_bytes != row.size_bytes:
                    raise Problem(409, "ARTIFACT_CONFLICT", "Artifact size differs")
                incarnation = artifact.storage_incarnation
                backend = artifact.storage_backend
                if backend == "INLINE":
                    if artifact.content != retained:
                        raise Problem(409, "ARTIFACT_CONFLICT", "Artifact bytes differ")
                    row.state = "COMPLETE"
                    row.content = None
                    row.expires_at = now() + timedelta(days=self.settings.artifact_retention_days)
                    await self.session.commit()
                    return {"id": row.id, "receivedBytes": row.size_bytes, "complete": True}
                publication = await self.session.get(ArtifactPublication, incarnation)
                if not publication or publication.state == "RETIRED":
                    raise Problem(410, "ARTIFACT_EXPIRED", "Publication is retired")
            else:
                incarnation = str(uuid4())
                backend = self.settings.artifact_backend
                publication = ArtifactPublication(
                    id=incarnation,
                    workspace_id=scope.workspace_id,
                    sha256=row.sha256,
                    storage_backend=backend,
                    upload_id=None,
                    offline_upload_id=row.id,
                    state="PENDING",
                )
                self.session.add(publication)
                if artifact:
                    artifact.content = None
                    artifact.storage_backend = backend
                    artifact.storage_incarnation = incarnation
                    artifact.expired_at = None
                    artifact.deleted_at = None
                else:
                    artifact = Artifact(
                        workspace_id=scope.workspace_id,
                        sha256=row.sha256,
                        content=None,
                        size_bytes=row.size_bytes,
                        media_type="application/octet-stream",
                        storage_backend=backend,
                        storage_incarnation=incarnation,
                    )
                    self.session.add(artifact)
            row.storage_incarnation = incarnation
            content = retained
            digest = row.sha256
            await self.session.commit()
        # All filesystem/S3 work occurs outside transactions and configuration locks.
        try:
            await artifact_store(self.settings, backend).put(
                scope.workspace_id, digest, content, incarnation
            )
        except (ValueError, OSError):
            raise Problem(
                409,
                "ARTIFACT_PUBLICATION_FAILED",
                "Evidence publication was retired or failed; retained authority must be reconciled",
            ) from None
        async with authority_guard(self.settings, False) as authority:
            await lock_installation(self.session)
            row = await self.current(scope, upload_id, authority)
            artifact = await self.session.get(
                Artifact, (scope.workspace_id, row.sha256), populate_existing=True
            )
            publication = await self.session.get(
                ArtifactPublication, incarnation, populate_existing=True
            )
            if (
                not artifact
                or artifact.expired_at
                or artifact.storage_incarnation != incarnation
                or not publication
                or publication.workspace_id != scope.workspace_id
                or publication.state == "RETIRED"
            ):
                raise Problem(410, "ARTIFACT_EXPIRED", "Publication authority changed")
            row.state = "COMPLETE"
            row.content = None
            row.expires_at = now() + timedelta(days=self.settings.artifact_retention_days)
            publication.state = "COMMITTED"
            await self.session.commit()
            return {"id": row.id, "receivedBytes": row.size_bytes, "complete": True}

    async def completed_chunk(
        self, scope: WorkspaceScope, upload_id: str, offset: int, raw: bytes
    ) -> dict[str, Any] | None:
        async with authority_guard(self.settings, False) as authority:
            await lock_installation(self.session)
            row = await self.current(scope, upload_id, authority)
            if row.state != "COMPLETE":
                await self.session.commit()
                return None
            artifact = await self.session.get(Artifact, (scope.workspace_id, row.sha256))
            if not artifact or artifact.expired_at:
                raise Problem(410, "ARTIFACT_EXPIRED", "Evidence is expired")
            digest, size, backend, incarnation, content = (
                artifact.sha256,
                artifact.size_bytes,
                artifact.storage_backend,
                artifact.storage_incarnation,
                artifact.content,
            )
            await self.session.commit()
        if backend != "INLINE":
            content = await artifact_store(self.settings, backend).read(
                scope.workspace_id, digest, size, incarnation
            )
        if (
            content is None
            or offset + len(raw) > size
            or content[offset : offset + len(raw)] != raw
        ):
            raise Problem(409, "UPLOAD_BYTES_CHANGED", "Completed chunk replay differs")
        async with authority_guard(self.settings, False) as authority:
            await lock_installation(self.session)
            row = await self.current(scope, upload_id, authority)
            artifact = await self.session.get(
                Artifact, (scope.workspace_id, digest), populate_existing=True
            )
            if not artifact or artifact.expired_at or artifact.storage_incarnation != incarnation:
                raise Problem(410, "ARTIFACT_EXPIRED", "Evidence authority changed")
            await self.session.commit()
            return {"id": row.id, "receivedBytes": size, "complete": True}
