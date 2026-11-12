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
    """浏览器态离线结果导入：在身份校验后释放锁，再占用导出槽位做有界验签入库；正文上限沿用 MAX_HTTP_BODY_BYTES，避免超大归档拖垮控制面。
    ImportAPI 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    ImportAPI 处理导入或离线回传时需保持幂等键与来源标识，重复提交不得制造双份业务副作用。
    """

    body_limit = MAX_HTTP_BODY_BYTES

    async def bounded_import(
        self, operation: Callable[[], Awaitable[dict[str, Any]]]
    ) -> dict[str, Any]:
        """复用 Bundle 双槽信号量限制并发验签拷贝，超时映射 BUNDLE_IMPORT_BUSY；无论验签成败都在 finally 中释放信号量槽位。
        bounded_import 处理导入或离线回传时需保持幂等键与来源标识，重复提交不得制造双份业务副作用。
        复用既有双槽 Bundle 加密预算；禁止无界排队归档拷贝。
        """
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
        """POST OfflineResultV1：会话授权后 commit 释放锁，再幂等导入并返回回执；reauthorize 回调在长任务中重新校验会话仍有效。
        post 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        post 处理导入或离线回传时需保持幂等键与来源标识，重复提交不得制造双份业务副作用。
        """
        async with self.db.sessions() as session:
            user, _ = await self.identity(session)
            result = self.body("OfflineResultV1")

            async def reauthorize(current: AsyncSession) -> User:
                actor, _ = await self.identity(current)
                return actor

            # 等待有界验签前释放身份/设备锁，避免长时间占住安装锁。
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
    """分块上传预留与写入：先 reserve 得到 uploadUrl，再按 offset 追加 octet-stream；单次分块 body_limit 限制为 1 MiB，防止无界缓冲。
    ImportUploadAPI 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    ImportUploadAPI 处理导入或离线回传时需保持幂等键与来源标识，重复提交不得制造双份业务副作用。
    """

    body_limit = 1024 * 1024

    async def actor(self, session: AsyncSession, workspace_id: str) -> User:
        """浏览器路径以 Cookie 会话用户作为导入主体，workspace_id 交由服务层再校验；本方法可被子类覆盖以切换设备身份解析策略。
        actor 处理导入或离线回传时需保持幂等键与来源标识，重复提交不得制造双份业务副作用。
        """
        user, _ = await self.identity(session)
        return user

    async def post(self, workspace_id: str) -> None:
        """POST 预留导入上传槽位，按 action 前缀区分 /api 与 /internal 上传 URL；返回的 uploadUrl 仅指向本控制面分块写入路径。
        post 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        post 处理导入或离线回传时需保持幂等键与来源标识，重复提交不得制造双份业务副作用。
        """
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
        """PUT 校验有界十进制 offset 与二进制 Content-Type 后写入分块并返回进度回执；offset 必须无前导符号的十进制 ASCII，长度受限。
        put 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        put 处理导入或离线回传时需保持幂等键与来源标识，重复提交不得制造双份业务副作用。
        """
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
    """从设备 Bearer 解析用户拥有的 Runtime，校验绑定 Workspace 与私有派发权后返回主体；require_dispatch 确保设备具备私有派发能力后才导入。
    device_actor 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    device_actor 处理导入或离线回传时需保持幂等键与来源标识，重复提交不得制造双份业务副作用。
    """
    from ..db import User
    from ..service import Problem
    from ..services.runtime import RuntimeService

    # 遵循 RuntimeService 锁序：先安装锁，再设备令牌行。
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
    """设备态离线结果导入：复用 DeviceAPI 的 prepare/CSRF 策略，主体来自 Runtime 所有者；prepare/check_xsrf_cookie 直接绑定 DeviceAPI 实现。
    NativeImportAPI 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    NativeImportAPI 处理导入或离线回传时需保持幂等键与来源标识，重复提交不得制造双份业务副作用。
    """

    prepare = DeviceAPI.prepare
    check_xsrf_cookie = DeviceAPI.check_xsrf_cookie

    async def post(self, workspace_id: str) -> None:
        """设备 Bearer 授权后导入 OfflineResultV1，同样先释放锁再占用验签槽位；Idempotency-Key 透传给 ImportService 保证重复投递安全。
        post 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        post 处理导入或离线回传时需保持幂等键与来源标识，重复提交不得制造双份业务副作用。
        """
        async with self.db.sessions() as session:
            user = await device_actor(self, session, workspace_id)
            result = self.body("OfflineResultV1")

            async def reauthorize(current: AsyncSession) -> User:
                return await device_actor(self, current, workspace_id)

            # 等待有界验签前释放身份/设备锁，避免长时间占住安装锁。
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
    """设备态分块上传：继承上传协议但以 device_actor 替换 Cookie 身份解析；与浏览器上传共享 chunk 协议，仅身份解析不同。
    NativeImportUploadAPI 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    NativeImportUploadAPI 处理导入或离线回传时需保持幂等键与来源标识，重复提交不得制造双份业务副作用。
    """

    prepare = DeviceAPI.prepare
    check_xsrf_cookie = DeviceAPI.check_xsrf_cookie

    async def actor(self, session: AsyncSession, workspace_id: str) -> User:
        """覆盖浏览器 actor：要求设备绑定当前 Workspace 且具备派发权限；失败时映射 WORKSPACE_FORBIDDEN 而非伪装会话错误。
        actor 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        actor 处理导入或离线回传时需保持幂等键与来源标识，重复提交不得制造双份业务副作用。
        """
        return await device_actor(self, session, workspace_id)
