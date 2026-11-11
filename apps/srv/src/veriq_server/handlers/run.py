"""Workspace Run admission, reads and cancellation."""

from sqlalchemy import select
from ..auth.authorization import WorkspaceScope
from ..db import Run
from ..pagination import Page
from ..service import lock_installation
from ..services.runs import RunService, run_dto
from ..services.workspace import WorkspaceRepository
from .base import API


class RunAPI(API):
    async def post(self, workspace_id: str, run_id: str | None = None) -> None:
        data = self.body("RunCreate" if self.action == "runs" else "CancelRequest")
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            service = RunService(session, user)
            if self.action == "runs":
                result = await service.create(
                    workspace_id, self.request.headers.get("Idempotency-Key", ""), data
                )
            else:
                assert run_id
                result = await service.cancel(workspace_id, run_id)
        self.respond(result, 202 if self.action == "runs" else 200)

    async def get(self, workspace_id: str, run_id: str | None = None) -> None:
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            if run_id:
                result = run_dto(await RunService(session, user).get(workspace_id, run_id))
            else:
                await WorkspaceRepository(session, WorkspaceScope(workspace_id)).authorize(user)
                page = Page.read(
                    self,
                    {"list": "runs", "workspaceId": workspace_id, "actor": user.id},
                    self.config.signing_key.get_secret_value(),
                )
                query = select(Run).where(Run.workspace_id == workspace_id)
                if page.last:
                    query = query.where(Run.id > page.last[1])
                rows = (
                    (await session.execute(query.order_by(Run.id).limit(page.limit + 1)))
                    .scalars()
                    .all()
                )
                shown = rows[: page.limit]
                result = {
                    "items": [run_dto(r) for r in shown],
                    "nextCursor": page.next((shown[-1].id, shown[-1].id), len(rows) > page.limit)
                    if shown
                    else None,
                }
        self.respond(result)


class AttemptAuditAPI(API):
    async def post(self, workspace_id: str, attempt_id: str) -> None:
        from uuid import uuid4
        from ..auth.authorization import Permission
        from ..db import Attempt, AuditLog
        from ..service import Problem, now
        from ..services.capacity import CapacityService

        data = self.body("AdminReconcileRequest")
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            await WorkspaceRepository(session, WorkspaceScope(workspace_id)).authorize(
                user, Permission.MANAGE_WORKSPACE, write=True
            )
            attempt = await session.get(Attempt, attempt_id)
            if not attempt or attempt.workspace_id != workspace_id:
                raise Problem(404, "ATTEMPT_NOT_FOUND", "Attempt not found")
            if attempt.capacity_state not in {"QUARANTINED", "RELEASED"}:
                raise Problem(
                    409, "ATTEMPT_STILL_ACTIVE", "Active Attempt requires cancellation and stopping"
                )
            await CapacityService(session, self.config).release(attempt)
            attempt.facts = {
                **attempt.facts,
                "administratorStopConfirmation": {
                    "actorId": user.id,
                    "reason": data["reason"],
                    "processStopped": True,
                },
            }
            record = AuditLog(
                id=str(uuid4()),
                workspace_id=workspace_id,
                actor_id=user.id,
                target_id=attempt.id,
                action="attempt.admin_capacity_release",
                created_at=now(),
            )
            session.add(record)
            result = {"attemptId": attempt.id, "capacityReleased": True, "auditId": record.id}
        self.respond(result)
