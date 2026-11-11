"""Cookie/CSRF exports and distinct bearer-only native downloads."""

import asyncio
import json
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import Permission, WorkspaceScope
from ..bundles.issuer import Issuer
from ..db import Bundle, User
from ..pagination import Page
from ..repositories.resource import ResourceRepository
from ..service import Problem, lock_installation
from ..services.bundle import BundleService, bundle_dto
from ..services.runtime import RuntimeService
from ..services.workspace import WorkspaceRepository
from .base import API
from .enrollment import DeviceAPI


class BundleAPI(API):
    async def post(self, workspace_id: str, bundle_id: str | None = None) -> None:
        if self.action != "bundles":
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        req = self.body("BundleCreate")
        semaphore = self.application.settings["bundle_export_slots"]
        try:
            await asyncio.wait_for(semaphore.acquire(), timeout=5)
        except TimeoutError:
            raise Problem(429, "BUNDLE_EXPORT_BUSY", "Bundle export capacity is busy") from None
        try:
            async with self.db.sessions() as session:
                user, _ = await self.identity(session)

                async def reauthorize(current: AsyncSession) -> User:
                    actor, _ = await self.identity(current)
                    return actor

                result = await BundleService(session, user, self.config, reauthorize).export(
                    WorkspaceScope(workspace_id), req
                )
        finally:
            semaphore.release()
        self.respond(result, 201)

    async def get(self, workspace_id: str, bundle_id: str | None = None) -> None:
        scope = WorkspaceScope(workspace_id)
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            service = BundleService(session, user, self.config)
            await service.authorize(scope)
            if not bundle_id:
                page = Page.read(
                    self,
                    {"list": "bundles", "workspaceId": workspace_id, "actor": user.id},
                    self.config.signing_key.get_secret_value(),
                )
                query = select(Bundle).where(Bundle.workspace_id == workspace_id)
                _, membership = await WorkspaceRepository(session, scope).authorize(user)
                if membership.role not in {"OWNER", "ADMIN", "EDITOR"}:
                    query = query.where(Bundle.contains_draft.is_(False))
                if page.last:
                    query = query.where(Bundle.id > page.last[1])
                rows = (
                    (await session.execute(query.order_by(Bundle.id).limit(page.limit + 1)))
                    .scalars()
                    .all()
                )
                shown = rows[: page.limit]
                self.respond(
                    {
                        "items": [bundle_dto(row) for row in shown],
                        "nextCursor": page.next(
                            (shown[-1].id, shown[-1].id), len(rows) > page.limit
                        )
                        if shown
                        else None,
                    }
                )
                return
            row = await service.get(scope, bundle_id)
            if self.action == "bundle":
                self.respond(bundle_dto(row))
                return
            repo = ResourceRepository(session, scope)
            raw = (
                await repo.artifact(
                    row.archive_hash if self.action == "bundle-download" else row.manifest_hash
                )
            ).content
        if self.action == "bundle-manifest":
            self.respond(json.loads(raw))
            return
        self.set_header("Content-Type", "application/octet-stream")
        self.set_header(
            "Content-Disposition",
            f'attachment; filename="{bundle_id}{".zip" if self.action == "bundle-download" else ".json"}"',
        )
        self.set_header("Content-Security-Policy", "sandbox")
        self.finish(raw)


class NativeBundleAPI(DeviceAPI):
    async def post(self, *args: str) -> None:
        raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")

    async def get(self, workspace_id: str | None = None, bundle_id: str | None = None) -> None:
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            runtime, binding, _ = await RuntimeService(session).require_device(
                self.request.headers.get("Authorization", "")
            )
            if self.action == "issuer-trust":
                self.respond(Issuer(self.config.bundle_issuer_path).public())
                return
            if workspace_id != binding.workspace_id or not runtime.owner_user_id:
                raise Problem(403, "WORKSPACE_FORBIDDEN", "User-owned Workspace binding required")
            user = await session.get(User, runtime.owner_user_id)
            assert user is not None and workspace_id and bundle_id
            scope = WorkspaceScope(workspace_id)
            await WorkspaceRepository(session, scope).authorize(user, Permission.DOWNLOAD)
            row = await BundleService(session, user, self.config).get(scope, bundle_id)
            raw = (await ResourceRepository(session, scope).artifact(row.archive_hash)).content
        self.set_header("Content-Type", "application/octet-stream")
        self.set_header("Content-Disposition", f'attachment; filename="{bundle_id}.zip"')
        self.set_header("Content-Security-Policy", "sandbox")
        self.finish(raw)
