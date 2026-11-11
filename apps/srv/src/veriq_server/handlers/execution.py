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
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            result = await ContentService(session, self.config).chunk(
                attempt_id, upload_id, self.header_proof(), int(offset), self.request.body
            )
        self.respond(result)

    async def post(self, attempt_id: str | None = None) -> None:
        result: dict[str, Any] | None
        if self.action in {
            "expired-leases/reap",
            "fixture-cleanups/reconcile",
            "capacity/reconcile",
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
