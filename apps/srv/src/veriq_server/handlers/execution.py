"""Native device queue transport; web admission remains cookie/CSRF protected."""

from typing import Any

from ..credentials.resolve import CredentialProofTransport
from ..service import lock_installation, Problem
from ..services.jobs import JobService, RuntimeIdentity
from ..services.lease import LeaseService
from ..services.maintenance import MaintenanceService
from ..services.content import ContentService, CHUNK_BYTES
from ..services.completion import CompletionService
from .enrollment import DeviceAPI


class ExecutionAPI(DeviceAPI):
    body_limit = CHUNK_BYTES

    def header_proof(self) -> CredentialProofTransport:
        return CredentialProofTransport.parse(
            self.request.headers.get("Authorization", ""),
            self.request.headers.get("X-VeriQ-Lease-Token", ""),
            self.request.headers.get("X-VeriQ-Fencing-Token", ""),
        )

    async def put(self, attempt_id: str, upload_id: str) -> None:
        if self.action != "upload-chunk":
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        if self.request.headers.get("Content-Type") != "application/octet-stream":
            raise Problem(415, "BINARY_REQUIRED", "Binary upload required")
        offset = self.get_argument("offset", "")
        if not offset.isascii() or not offset.isdecimal() or len(offset) > 10:
            raise Problem(400, "INVALID_OFFSET", "Nonnegative bounded offset required")
        from ..db import AttemptUpload, Artifact
        from uuid import uuid4
        from ..services.artifact import artifact_store, RAW_KINDS, verify

        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            attempt, _, _, _ = await LeaseService(session, self.config).proof(
                attempt_id, self.header_proof()
            )
            upload = await session.get(AttemptUpload, upload_id)
            if (
                not upload
                or upload.attempt_id != attempt.id
                or upload.workspace_id != attempt.workspace_id
            ):
                raise Problem(404, "UPLOAD_NOT_FOUND", "Upload not assigned to Attempt")
            prefix, complete, workspace = upload.content, upload.complete, attempt.workspace_id
            digest, size = upload.sha256, upload.size_bytes
            artifact = await session.get(Artifact, (workspace, digest))
            if upload.expired_at or (complete and artifact and artifact.expired_at):
                raise Problem(410, "ARTIFACT_EXPIRED", "Evidence retention has expired")
            if complete and artifact is None:
                raise Problem(409, "INVALID_ARTIFACT", "Completed artifact is missing")
            raw = upload.metadata_json["kind"] in RAW_KINDS
            backend = (
                artifact.storage_backend
                if artifact and not artifact.expired_at and (raw or complete)
                else (self.config.artifact_backend if raw else "INLINE")
            )
            incarnation = (
                artifact.storage_incarnation if artifact and not artifact.expired_at else None
            )
            if (
                not complete
                and backend != "INLINE"
                and int(offset) == len(prefix)
                and len(prefix) + len(self.request.body) == size
            ):
                try:
                    verify(prefix + self.request.body, digest, size)
                except ValueError:
                    raise Problem(
                        409, "UPLOAD_HASH_MISMATCH", "Uploaded bytes do not match declared hash"
                    ) from None
                if artifact is None:
                    incarnation = str(uuid4())
                    artifact = Artifact(
                        workspace_id=workspace,
                        sha256=digest,
                        content=None,
                        size_bytes=size,
                        media_type=upload.metadata_json["contentType"],
                        storage_backend=backend,
                        storage_incarnation=incarnation,
                    )
                    session.add(artifact)
                elif artifact.expired_at:
                    # The old immutable incarnation has its own durable deletion record.
                    # Rehydration never clears any old AttemptUpload logical tombstone.
                    incarnation = str(uuid4())
                    artifact.storage_backend, artifact.storage_incarnation = backend, incarnation
                    artifact.content = None
                    artifact.expired_at = artifact.deleted_at = None
                await session.flush()
        external = None
        if complete and backend != "INLINE":
            external = await artifact_store(self.config, backend).read(
                workspace, digest, size, incarnation
            )
        elif (
            not complete
            and backend != "INLINE"
            and int(offset) == len(prefix)
            and len(prefix) + len(self.request.body) == size
        ):
            verify(prefix + self.request.body, digest, size)
            await artifact_store(self.config, backend).put(
                workspace, digest, prefix + self.request.body, incarnation
            )
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            result = await ContentService(session, self.config).chunk(
                attempt_id,
                upload_id,
                self.header_proof(),
                int(offset),
                self.request.body,
                external=external,
                staged=(prefix, complete, backend, incarnation),
            )
        self.respond(result)

    async def post(self, attempt_id: str | None = None) -> None:
        result: dict[str, Any] | None
        if self.action in {
            "expired-leases/reap",
            "fixture-cleanups/reconcile",
            "capacity/reconcile",
            "artifacts/expire",
            "reconcile",
        }:
            data = self.body(
                "ReconcileRequest" if self.action == "reconcile" else "MaintenanceRequest"
            )
            async with self.db.sessions.begin() as session:
                await lock_installation(session)
                maintenance_service = MaintenanceService(session, self.config)
                authorization = self.request.headers.get("Authorization", "")
                if self.action == "reconcile":
                    assert attempt_id
                    result = await maintenance_service.stopped(authorization, attempt_id, data)
                else:
                    if not data.get("workspaceId"):
                        raise Problem(
                            400, "WORKSPACE_REQUIRED", "Maintenance requires explicit Workspace"
                        )
                    result = await maintenance_service.execute(
                        authorization,
                        data["workspaceId"],
                        self.action,
                        self.request.headers.get("Idempotency-Key", ""),
                        data["limit"],
                        data.get("cursor", ""),
                    )
            if self.action == "artifacts/expire":
                from sqlalchemy import select
                from ..db import Artifact, ArtifactDeletion
                from ..services.artifact import artifact_store
                from ..services.service_account import ServiceAccountService
                from ..service import now

                async with self.db.sessions.begin() as session:
                    await lock_installation(session)
                    await ServiceAccountService(session).require_maintenance(
                        authorization, data["workspaceId"], self.action
                    )
                    rows = list(
                        (
                            await session.execute(
                                select(ArtifactDeletion)
                                .where(
                                    ArtifactDeletion.workspace_id == data["workspaceId"],
                                    ArtifactDeletion.deleted_at.is_(None),
                                )
                                .limit(data["limit"])
                            )
                        ).scalars()
                    )
                    deletes = [
                        (
                            row.id,
                            row.workspace_id,
                            row.sha256,
                            row.storage_backend,
                            row.storage_incarnation,
                        )
                        for row in rows
                    ]
                for deletion_id, workspace, digest, backend, incarnation in deletes:
                    await artifact_store(self.config, backend).delete(
                        workspace, digest, incarnation
                    )
                    async with self.db.sessions.begin() as session:
                        await lock_installation(session)
                        await ServiceAccountService(session).require_maintenance(
                            authorization, workspace, self.action
                        )
                        row = await session.get(Artifact, (workspace, digest))
                        deleted = await session.get(ArtifactDeletion, deletion_id)
                        assert deleted
                        deleted.deleted_at = now()
                        if (
                            row
                            and row.expired_at
                            and row.storage_backend == backend
                            and row.storage_incarnation == incarnation
                        ):
                            row.deleted_at = deleted.deleted_at
            self.respond(result)
            return
        schema = {
            "finish": "FinishRequest",
            "events": "EventBatchRequest",
            "upload-create": "ArtifactUploadRequest",
            "claim": "ClaimRequest",
            "activate": "LeaseProofRequest",
            "heartbeat": "HeartbeatRequest",
        }[self.action]
        data = self.body(schema)
        authorization = self.request.headers.get("Authorization", "")
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            if self.action == "claim":
                result = await JobService(session, self.config).claim(
                    RuntimeIdentity(authorization), data
                )
            else:
                assert attempt_id
                proof = CredentialProofTransport.parse(
                    authorization, data["leaseToken"], str(data["fencingToken"])
                )
                if self.action in {"finish", "events"}:
                    completion = CompletionService(session, self.config)
                    result = await (
                        completion.finish(attempt_id, proof, data)
                        if self.action == "finish"
                        else completion.events(attempt_id, proof, data["events"])
                    )
                elif self.action == "upload-create":
                    result = await ContentService(session, self.config).create_upload(
                        attempt_id, proof, data
                    )
                else:
                    service = LeaseService(session, self.config)
                    result = await (
                        service.activate(attempt_id, proof)
                        if self.action == "activate"
                        else service.heartbeat(attempt_id, proof, data["progress"])
                    )
        if result is None:
            self.set_status(204)
            self.finish()
        else:
            self.respond(result, 201 if self.action == "upload-create" else 200)

    async def get(self, *args: str) -> None:
        if self.action != "content":
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        workspace_id, attempt_id, digest = args
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            content = await ContentService(session, self.config).download(
                workspace_id, attempt_id, digest, self.header_proof()
            )
        self.set_header("Content-Type", "application/octet-stream")
        self.finish(content)
