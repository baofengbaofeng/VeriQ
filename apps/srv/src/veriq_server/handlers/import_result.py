"""Cookie/CSRF offline import, separate from authenticated online completions."""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any
from sqlalchemy.ext.asyncio import AsyncSession
from ..service import Problem, lock_installation
from ..db import User
from ..auth.authorization import WorkspaceScope
from ..services.import_result import ImportService
from .base import API, MAX_HTTP_BODY_BYTES
from .enrollment import DeviceAPI


class ImportAPI(API):
    body_limit = MAX_HTTP_BODY_BYTES

    async def bounded_import(
        self, operation: Callable[[], Awaitable[dict[str, Any]]]
    ) -> dict[str, Any]:
        # Reuse the existing two-slot bundle crypto budget; never queue archive copies unboundedly.
        semaphore = self.application.settings["bundle_export_slots"]
        try:
            await asyncio.wait_for(semaphore.acquire(), timeout=5)
        except TimeoutError:
            raise Problem(
                429, "BUNDLE_IMPORT_BUSY", "Bundle verification capacity is busy"
            ) from None
        try:
            return await operation()
        finally:
            semaphore.release()

    async def post(self, workspace_id: str) -> None:
        async with self.db.sessions() as session:
            user, _ = await self.identity(session)
            result = self.body("OfflineResultV1")

            async def reauthorize(current: AsyncSession) -> User:
                actor, _ = await self.identity(current)
                return actor

            # Release identity/device locks before waiting for bounded verification.
            await session.commit()
            receipt = await self.bounded_import(
                lambda: ImportService(session, user, self.config, reauthorize).import_result(
                    WorkspaceScope(workspace_id),
                    result,
                    self.request.headers.get("Idempotency-Key", ""),
                )
            )
        self.respond(receipt, 201)


class ImportUploadAPI(API):
    body_limit = 1024 * 1024

    async def actor(self, session: AsyncSession, workspace_id: str) -> User:
        user, _ = await self.identity(session)
        return user

    async def post(self, workspace_id: str) -> None:
        from ..services.import_upload import ImportUploadService

        async with self.db.sessions() as session:
            user = await self.actor(session, workspace_id)
            req = self.body("OfflineUploadRequest")

            async def reauthorize(current: AsyncSession) -> User:
                return await self.actor(current, workspace_id)

            row = await ImportUploadService(session, user, self.config, reauthorize).reserve(
                WorkspaceScope(workspace_id), req
            )
        prefix = "/internal/v1" if self.action.startswith("native-") else "/api/v1"
        self.respond(
            {
                "id": row.id,
                "uploadUrl": f"{prefix}/workspaces/{workspace_id}/result-import-uploads/{row.id}",
            },
            201,
        )

    async def put(self, workspace_id: str, upload_id: str) -> None:
        from ..services.import_upload import ImportUploadService
        from ..service import Problem

        offset = self.get_query_argument("offset", "")
        if (
            not offset.isascii()
            or not offset.isdecimal()
            or len(offset) > 9
            or self.request.headers.get("Content-Type") != "application/octet-stream"
        ):
            raise Problem(400, "INVALID_CHUNK", "Bounded octet-stream chunk required")
        async with self.db.sessions() as session:
            user = await self.actor(session, workspace_id)

            async def reauthorize(current: AsyncSession) -> User:
                return await self.actor(current, workspace_id)

            receipt = await ImportUploadService(session, user, self.config, reauthorize).chunk(
                WorkspaceScope(workspace_id), upload_id, int(offset), self.request.body
            )
        self.respond(receipt)


async def device_actor(handler: API, session: AsyncSession, workspace_id: str) -> User:
    from ..db import User
    from ..service import Problem
    from ..services.runtime import RuntimeService

    # Follow RuntimeService lock order: installation before device-token row.
    await lock_installation(session)
    service = RuntimeService(session)
    runtime, binding, _ = await service.require_device(
        handler.request.headers.get("Authorization", "")
    )
    if binding.workspace_id != workspace_id or not runtime.owner_user_id:
        raise Problem(403, "WORKSPACE_FORBIDDEN", "Current user-owned Workspace device required")
    user = await session.get(User, runtime.owner_user_id)
    assert user is not None
    await service.require_dispatch(user, workspace_id, runtime.id)
    return user


class NativeImportAPI(ImportAPI):
    prepare = DeviceAPI.prepare
    check_xsrf_cookie = DeviceAPI.check_xsrf_cookie

    async def post(self, workspace_id: str) -> None:
        async with self.db.sessions() as session:
            user = await device_actor(self, session, workspace_id)
            result = self.body("OfflineResultV1")

            async def reauthorize(current: AsyncSession) -> User:
                return await device_actor(self, current, workspace_id)

            # Release identity/device locks before waiting for bounded verification.
            await session.commit()
            receipt = await self.bounded_import(
                lambda: ImportService(session, user, self.config, reauthorize).import_result(
                    WorkspaceScope(workspace_id),
                    result,
                    self.request.headers.get("Idempotency-Key", ""),
                )
            )
        self.respond(receipt, 201)


class NativeImportUploadAPI(ImportUploadAPI):
    prepare = DeviceAPI.prepare
    check_xsrf_cookie = DeviceAPI.check_xsrf_cookie

    async def actor(self, session: AsyncSession, workspace_id: str) -> User:
        return await device_actor(self, session, workspace_id)
