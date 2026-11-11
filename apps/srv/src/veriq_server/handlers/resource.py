"""Resource HTTP boundary: canonical schemas, current membership and short transactions."""

from typing import Any
from sqlalchemy import and_, or_, select
from ..auth.authorization import Permission, WorkspaceScope
from ..db import Resource, ResourceVersion, ResourceDependency, ValidationReceipt
from ..pagination import Page
from ..repositories.resource import ResourceRepository
from ..service import Problem, audit, lock_installation
from ..services.workspace import WorkspaceRepository
from ..services.resource import ResourceService, resource_dto, draft_dto, version_dto, job_dto
from ..services.publish import PublishService, receipt_dto
from .base import API


class ResourceAPI(API):
    def prepare(self) -> None:
        # JSON resource envelopes get 2 MiB + bounded envelope overhead; all other
        # operations retain the 64 KiB account/API bound.
        self.body_limit = 2 * 1024 * 1024 + 4096 if self.action in {"resources", "draft"} else 65536
        super().prepare()
        allowed = {
            "resources": {"GET", "POST"},
            "resource": {"GET", "PATCH"},
            "draft": {"GET", "PUT"},
            "validation-preview": {"GET"},
            "validate": {"POST"},
            "publish": {"POST"},
            "versions": {"GET"},
            "version": {"GET"},
            "dependents": {"GET"},
            "job": {"GET"},
            "validation-receipt": {"GET"},
        }
        if self.request.method not in allowed[self.action]:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")

    def service(self, session: Any, user: Any, publish: bool = False) -> ResourceService:
        cls = PublishService if publish else ResourceService
        return cls(session, user, self.application.settings.get("identity_reference_registry"))

    async def get(
        self, workspace_id: str, resource_id: str | None = None, version_id: str | None = None
    ) -> None:
        scope = WorkspaceScope(workspace_id)
        async with self.db.sessions() as s:
            user, _ = await self.identity(s)
            await WorkspaceRepository(s, scope).authorize(user)
            repo = ResourceRepository(s, scope)
            if self.action in {"job", "validation-receipt"}:
                assert resource_id
                job = await repo.job(resource_id)
                if self.action == "job":
                    self.respond(job_dto(job))
                    return
                receipt = (
                    await s.execute(
                        select(ValidationReceipt).where(
                            ValidationReceipt.workspace_id == workspace_id,
                            ValidationReceipt.job_id == job.id,
                        )
                    )
                ).scalar_one_or_none()
                if receipt is None:
                    raise Problem(
                        409,
                        "VALIDATION_NOT_COMPLETED",
                        "No successful validation receipt is available",
                    )
                self.respond(receipt_dto(receipt))
                return
            resource = await repo.resource(resource_id) if resource_id else None
            if self.action == "resource":
                assert resource
                self.respond(resource_dto(resource))
                return
            if self.action == "draft":
                assert resource_id
                self.respond(draft_dto(await repo.draft(resource_id)))
                return
            if self.action == "validation-preview":
                assert resource_id
                self.respond(await self.service(s, user).preview(scope, resource_id))
                return
            if self.action == "version":
                assert version_id
                version = await repo.version(version_id)
                if version.resource_id != resource_id:
                    raise Problem(404, "VERSION_NOT_FOUND", "Version not found")
                self.respond(version_dto(version))
                return
            filters: dict[str, Any] = {}
            if self.action == "resources":
                kind, status = (
                    self.get_query_argument("kind", None),
                    self.get_query_argument("status", None),
                )
                if (
                    kind is not None
                    and kind
                    not in {
                        "CASE",
                        "ELEMENT_CATALOG",
                        "ASSERTION_TEMPLATE",
                        "DATASET",
                        "FLOW",
                        "FIXTURE",
                        "SUITE",
                        "ENVIRONMENT",
                    }
                    or status is not None
                    and status not in {"DRAFT", "PUBLISHED", "ARCHIVED"}
                ):
                    raise Problem(400, "INVALID_FILTER", "Invalid resource filter")
                filters = {"kind": kind, "status": status}
            page = Page.read(
                self,
                {
                    "list": self.action,
                    "actor": user.id,
                    "workspaceId": workspace_id,
                    "resourceId": resource_id,
                    **filters,
                },
                self.config.signing_key.get_secret_value(),
            )
            if self.action == "versions":
                query_v = select(ResourceVersion).where(
                    ResourceVersion.workspace_id == workspace_id,
                    ResourceVersion.resource_id == resource_id,
                )
                if page.last:
                    query_v = query_v.where(ResourceVersion.version_no > int(page.last[0]))
                rows_v = (
                    (
                        await s.execute(
                            query_v.order_by(ResourceVersion.version_no).limit(page.limit + 1)
                        )
                    )
                    .scalars()
                    .all()
                )
                shown_v = rows_v[: page.limit]
                self.respond(
                    {
                        "items": [version_dto(v) for v in shown_v],
                        "nextCursor": page.next(
                            (str(shown_v[-1].version_no), shown_v[-1].id), len(rows_v) > page.limit
                        )
                        if shown_v
                        else None,
                    }
                )
                return
            query = select(Resource).where(Resource.workspace_id == workspace_id)
            if self.action == "dependents":
                targets = select(ResourceVersion.id).where(
                    ResourceVersion.workspace_id == workspace_id,
                    ResourceVersion.resource_id == resource_id,
                )
                dependents = (
                    select(ResourceVersion.resource_id)
                    .join(
                        ResourceDependency,
                        and_(
                            ResourceDependency.version_id == ResourceVersion.id,
                            ResourceDependency.workspace_id == ResourceVersion.workspace_id,
                        ),
                    )
                    .where(
                        ResourceVersion.workspace_id == workspace_id,
                        ResourceDependency.dependency_version_id.in_(targets),
                    )
                )
                query = query.where(Resource.id.in_(dependents))
            for key, value in filters.items():
                if value is not None:
                    query = query.where(getattr(Resource, key) == value)
            if page.last:
                query = query.where(
                    or_(
                        Resource.key > page.last[0],
                        and_(Resource.key == page.last[0], Resource.id > page.last[1]),
                    )
                )
            rows = (
                (await s.execute(query.order_by(Resource.key, Resource.id).limit(page.limit + 1)))
                .scalars()
                .all()
            )
            shown = rows[: page.limit]
            self.respond(
                {
                    "items": [resource_dto(r) for r in shown],
                    "nextCursor": page.next((shown[-1].key, shown[-1].id), len(rows) > page.limit)
                    if shown
                    else None,
                }
            )

    async def post(self, workspace_id: str, resource_id: str | None = None) -> None:
        data = self.body(
            {
                "resources": "ResourceCreate",
                "validate": "ValidationRequest",
                "publish": "PublishRequest",
            }[self.action]
        )
        scope = WorkspaceScope(workspace_id)
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            user, _ = await self.identity(s)
            service = self.service(s, user)
            if self.action == "resources":
                result = await service.create(scope, data)
            elif self.action == "validate":
                assert resource_id
                result = await service.validate(
                    scope, resource_id, data["revision"], data["sourceHash"]
                )
            else:
                assert resource_id
                result = await PublishService(
                    s, user, self.application.settings.get("identity_reference_registry")
                ).publish(scope, resource_id, data["revision"], data["validationReceiptId"])
        self.respond(result, 202 if self.action == "validate" else 201)

    async def put(self, workspace_id: str, resource_id: str) -> None:
        data = self.body("DraftWrite")
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            user, _ = await self.identity(s)
            result = await self.service(s, user).update_draft(
                WorkspaceScope(workspace_id), resource_id, data["revision"], data["content"]
            )
        self.respond(result)

    async def patch(self, workspace_id: str, resource_id: str) -> None:
        data = self.body("ResourceUpdate")
        scope = WorkspaceScope(workspace_id)
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            user, _ = await self.identity(s)
            await WorkspaceRepository(s, scope).authorize(user, Permission.EDIT, write=True)
            resource = await ResourceRepository(s, scope).resource(resource_id)
            await self.service(s, user).authorize(scope, resource.kind)
            resource.name = data["name"]
            if "archived" in data:
                resource.status = (
                    "ARCHIVED"
                    if data["archived"]
                    else "PUBLISHED"
                    if resource.latest_version_id
                    else "DRAFT"
                )
            audit(s, "resource.updated", user.id, resource.id, workspace_id=workspace_id)
            result = resource_dto(resource)
        self.respond(result)
