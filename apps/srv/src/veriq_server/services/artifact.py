"""Bounded private evidence CAS. All network/filesystem I/O is staged outside DB locks."""

import asyncio
import os
import re
import tempfile
from hashlib import sha256
from pathlib import Path
from typing import Any, Protocol
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import Permission, WorkspaceScope
from ..db import (
    Artifact,
    ArtifactPublication,
    Attempt,
    AttemptUpload,
    User,
    OfflineAttempt,
    OfflineImport,
    OfflineImportUpload,
)
from ..service import Problem
from ..settings import Settings
from .workspace import WorkspaceRepository

MAX_FILE = 32 * 1024 * 1024
RAW_KINDS = {"TRACE", "HTML", "SCREENSHOT", "DOWNLOAD", "LOG", "JUNIT"}


def listed_offline_artifact(document: dict[str, Any], upload: OfflineImportUpload) -> bool:
    """Only the immutable result's exact descriptors can expose staged bytes."""
    return any(
        file["path"] == upload.path
        and file["sha256"] == upload.sha256
        and file["sizeBytes"] == upload.size_bytes
        and file.get("kind") == upload.kind
        for file in document.get("artifacts", [])
    )


def key(workspace: str, digest: str, incarnation: str | None = None) -> str:
    if str(UUID(workspace)) != workspace or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("INVALID_ARTIFACT_KEY")
    if incarnation is not None and str(UUID(incarnation)) != incarnation:
        raise ValueError("INVALID_ARTIFACT_INCARNATION")
    return f"{workspace}/{digest}" + (f".{incarnation}" if incarnation else "")


def verify(content: bytes, digest: str, size: int) -> bytes:
    if size > MAX_FILE or len(content) != size or sha256(content).hexdigest() != digest:
        raise ValueError("INVALID_ARTIFACT_BYTES")
    return content


class ArtifactStore(Protocol):
    async def put(
        self, workspace: str, digest: str, content: bytes, incarnation: str | None = None
    ) -> None: ...
    async def read(
        self, workspace: str, digest: str, size: int, incarnation: str | None = None
    ) -> bytes: ...
    async def delete(self, workspace: str, digest: str, incarnation: str | None = None) -> None: ...
    async def retire(self, workspace: str, digest: str, incarnation: str | None = None) -> None: ...


class FileArtifactStore:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def _path(self, workspace: str, digest: str, incarnation: str | None = None) -> Path:
        path = self.root / key(workspace, digest, incarnation)
        if path.parent.is_symlink() or path.is_symlink():
            raise ValueError("UNSAFE_ARTIFACT_PATH")
        return path

    async def put(
        self, workspace: str, digest: str, content: bytes, incarnation: str | None = None
    ) -> None:
        verify(content, digest, len(content))

        def write() -> None:
            path = self._path(workspace, digest, incarnation)
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".stage-")
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    verify(path.read_bytes(), digest, len(content))
                directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            finally:
                os.unlink(temporary)

        await asyncio.to_thread(write)

    async def read(
        self, workspace: str, digest: str, size: int, incarnation: str | None = None
    ) -> bytes:
        def read() -> bytes:
            path = self._path(workspace, digest, incarnation)
            with path.open("rb") as stream:
                return verify(stream.read(min(size, MAX_FILE) + 1), digest, size)

        return await asyncio.to_thread(read)

    async def delete(self, workspace: str, digest: str, incarnation: str | None = None) -> None:
        await asyncio.to_thread(self._path(workspace, digest, incarnation).unlink, missing_ok=True)

    async def retire(self, workspace: str, digest: str, incarnation: str | None = None) -> None:
        def barrier() -> None:
            path = self._path(workspace, digest, incarnation)
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".retire-")
            try:
                with os.fdopen(fd, "wb") as stream:
                    os.fsync(stream.fileno())
                os.replace(temporary, path)
                directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            finally:
                Path(temporary).unlink(missing_ok=True)

        await asyncio.to_thread(barrier)


class S3ArtifactStore:
    def __init__(self, bucket: str, endpoint: str | None = None, region: str = "us-east-1"):
        self.bucket, self.endpoint, self.region = bucket, endpoint, region
        self._client: Any = None

    @property
    def client(self) -> Any:
        if self._client is None:
            import boto3  # type: ignore[import-untyped]
            from botocore.config import Config  # type: ignore[import-untyped]

            self._client = boto3.client(
                "s3",
                endpoint_url=self.endpoint,
                region_name=self.region,
                config=Config(
                    connect_timeout=5,
                    read_timeout=15,
                    retries={"max_attempts": 1},
                    s3={"addressing_style": "path"},
                ),
            )
        return self._client

    async def put(
        self, workspace: str, digest: str, content: bytes, incarnation: str | None = None
    ) -> None:
        from botocore.exceptions import ClientError  # type: ignore[import-untyped]

        verify(content, digest, len(content))
        object_key = key(workspace, digest, incarnation)

        def write() -> None:
            try:
                self.client.put_object(
                    Bucket=self.bucket,
                    Key=object_key,
                    Body=content,
                    IfNoneMatch="*",
                    ContentType="application/octet-stream",
                )
            except ClientError as exc:
                if exc.response["ResponseMetadata"]["HTTPStatusCode"] != 412:
                    raise
                self._read(object_key, digest, len(content))

        await asyncio.to_thread(write)

    def _read(self, object_key: str, digest: str, size: int) -> bytes:
        result = self.client.get_object(Bucket=self.bucket, Key=object_key)
        try:
            return verify(result["Body"].read(min(size, MAX_FILE) + 1), digest, size)
        finally:
            result["Body"].close()

    async def read(
        self, workspace: str, digest: str, size: int, incarnation: str | None = None
    ) -> bytes:
        return await asyncio.to_thread(
            self._read, key(workspace, digest, incarnation), digest, size
        )

    async def delete(self, workspace: str, digest: str, incarnation: str | None = None) -> None:
        await asyncio.to_thread(
            lambda: self.client.delete_object(
                Bucket=self.bucket, Key=key(workspace, digest, incarnation)
            )
        )

    async def retire(self, workspace: str, digest: str, incarnation: str | None = None) -> None:
        # Keep the key occupied forever: late conditional puts cannot resurrect bytes.
        await asyncio.to_thread(
            lambda: self.client.put_object(
                Bucket=self.bucket,
                Key=key(workspace, digest, incarnation),
                Body=b"",
                ContentType="application/octet-stream",
                Metadata={"veriq-retired": "true"},
            )
        )


def artifact_store(settings: Settings, backend: str | None = None) -> ArtifactStore:
    if (backend or settings.artifact_backend) == "FILE":
        return FileArtifactStore(Path(settings.artifact_directory))
    if not settings.artifact_s3_bucket:
        raise Problem(503, "ARTIFACT_STORE_UNAVAILABLE", "S3 bucket is not configured")
    return S3ArtifactStore(
        settings.artifact_s3_bucket, settings.artifact_s3_endpoint, settings.artifact_s3_region
    )


def effective_sensitivity(metadata: dict[str, Any]) -> str:
    # Raw uploads are not proof of sanitized content, including caller-labelled LOG/SOURCE.
    return "CREDENTIAL_RESTRICTED"


class ArtifactService:
    def __init__(self, session: AsyncSession, user: User):
        self.session, self.user = session, user

    async def authorized(
        self, scope: WorkspaceScope, attempt_id: str, upload_id: str
    ) -> tuple[AttemptUpload | OfflineImportUpload, Artifact]:
        await WorkspaceRepository(self.session, scope).authorize(
            self.user, Permission.MANAGE_ENVIRONMENT
        )
        offline = await self.session.get(OfflineAttempt, attempt_id)
        if offline and offline.workspace_id == scope.workspace_id:
            imported = await self.session.get(OfflineImport, offline.import_id)
            offline_upload = await self.session.get(OfflineImportUpload, upload_id)
            if (
                not imported
                or not offline_upload
                or offline_upload.workspace_id != scope.workspace_id
                or offline_upload.bundle_id != imported.bundle_id
                or offline_upload.local_run_id != imported.local_run_id
                or offline_upload.local_attempt_id != offline.local_attempt_id
                or offline_upload.state != "COMPLETE"
                or not listed_offline_artifact(offline.document, offline_upload)
            ):
                raise Problem(404, "ARTIFACT_NOT_FOUND", "Artifact not found in this Attempt")
            artifact = await self.session.get(Artifact, (scope.workspace_id, offline_upload.sha256))
            publication = (
                await self.session.get(ArtifactPublication, artifact.storage_incarnation)
                if artifact and artifact.storage_incarnation
                else None
            )
            if (
                not artifact
                or offline_upload.expired_at
                or artifact.expired_at
                or (publication and publication.state == "RETIRED")
            ):
                raise Problem(410, "ARTIFACT_EXPIRED", "Evidence retention has expired")
            return offline_upload, artifact
        attempt = await self.session.get(Attempt, attempt_id)
        upload = await self.session.get(AttemptUpload, upload_id)
        if (
            not attempt
            or attempt.workspace_id != scope.workspace_id
            or not upload
            or upload.workspace_id != scope.workspace_id
            or upload.attempt_id != attempt.id
            or not upload.complete
        ):
            raise Problem(404, "ARTIFACT_NOT_FOUND", "Artifact not found in this Attempt")
        artifact = await self.session.get(Artifact, (scope.workspace_id, upload.sha256))
        if not artifact:
            raise Problem(409, "INVALID_ARTIFACT", "Artifact metadata missing")
        publication = (
            await self.session.get(ArtifactPublication, artifact.storage_incarnation)
            if artifact.storage_incarnation
            else None
        )
        if (
            upload.expired_at
            or artifact.expired_at
            or (publication and publication.state == "RETIRED")
        ):
            raise Problem(410, "ARTIFACT_EXPIRED", "Evidence retention has expired")
        return upload, artifact
