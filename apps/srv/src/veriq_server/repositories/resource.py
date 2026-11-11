"""Immutable, Workspace-scoped resource and content reads.

The calling service authorizes current membership. Mutations acquire the existing
installation guard before identity/scoped reads and retain it through commit.
"""

from typing import Protocol, cast
from hashlib import sha256
from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import WorkspaceScope
from ..db import (
    Resource,
    ResourceDraft,
    ResourceVersion,
    Artifact,
    ArtifactDeletion,
    Job,
    ValidationReceipt,
)
from ..service import Problem


class InlineArtifact(Protocol):
    """Read-only validated shape; the returned object remains the retained ORM row."""

    @property
    def content(self) -> bytes: ...
    @property
    def size_bytes(self) -> int: ...


class ResourceRepository:
    def __init__(self, session: AsyncSession, scope: WorkspaceScope):
        self.session, self.scope = session, scope

    async def resource(self, resource_id: str) -> Resource:
        row = (
            await self.session.execute(
                select(Resource).where(
                    Resource.workspace_id == self.scope.workspace_id, Resource.id == resource_id
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise Problem(404, "RESOURCE_NOT_FOUND", "Resource not found")
        return row

    async def draft(self, resource_id: str) -> ResourceDraft:
        row = (
            await self.session.execute(
                select(ResourceDraft).where(
                    ResourceDraft.workspace_id == self.scope.workspace_id,
                    ResourceDraft.resource_id == resource_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise Problem(404, "DRAFT_NOT_FOUND", "Draft not found")
        return row

    async def version(self, version_id: str) -> ResourceVersion:
        row = (
            await self.session.execute(
                select(ResourceVersion).where(
                    ResourceVersion.workspace_id == self.scope.workspace_id,
                    ResourceVersion.id == version_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise Problem(404, "VERSION_NOT_FOUND", "Version not found")
        return row

    async def job(self, job_id: str) -> Job:
        row = (
            await self.session.execute(
                select(Job).where(Job.workspace_id == self.scope.workspace_id, Job.id == job_id)
            )
        ).scalar_one_or_none()
        if row is None:
            raise Problem(404, "JOB_NOT_FOUND", "Job not found")
        return row

    async def receipt(self, receipt_id: str) -> ValidationReceipt | None:
        return (
            await self.session.execute(
                select(ValidationReceipt).where(
                    ValidationReceipt.workspace_id == self.scope.workspace_id,
                    ValidationReceipt.id == receipt_id,
                )
            )
        ).scalar_one_or_none()

    async def artifact(self, digest: str) -> InlineArtifact:
        row = await self.session.get(Artifact, (self.scope.workspace_id, digest))
        if (
            row is None
            or row.content is None
            or row.expired_at is not None
            or row.sha256 != sha256(row.content).hexdigest()
            or row.size_bytes != len(row.content)
        ):
            raise Problem(409, "INVALID_ARTIFACT", "Immutable artifact missing or corrupt")
        return cast(InlineArtifact, row)

    async def store(self, content: bytes, media_type: str = "application/json") -> str:
        digest = sha256(content).hexdigest()
        existing = await self.session.get(Artifact, (self.scope.workspace_id, digest))
        if existing is None:
            self.session.add(
                Artifact(
                    workspace_id=self.scope.workspace_id,
                    sha256=digest,
                    content=content,
                    size_bytes=len(content),
                    media_type=media_type,
                )
            )
            await self.session.flush()
        elif existing.content is None or existing.expired_at is not None:
            # A later source/manifest write pins these exact bytes inline. Raw read ACLs
            # remain tied to AttemptUpload, not the physical storage representation.
            if existing.storage_backend != "INLINE" and existing.expired_at is None:
                self.session.add(
                    ArtifactDeletion(
                        id=str(uuid4()),
                        workspace_id=self.scope.workspace_id,
                        sha256=digest,
                        storage_backend=existing.storage_backend,
                        storage_incarnation=existing.storage_incarnation,
                    )
                )
            existing.content = content
            existing.storage_backend = "INLINE"
            existing.storage_incarnation = None
            existing.expired_at = existing.deleted_at = None
            await self.session.flush()
        else:
            await self.artifact(digest)
        return digest
