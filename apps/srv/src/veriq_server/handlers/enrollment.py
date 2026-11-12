from typing import Any
from sqlalchemy import false, or_, select

from ..db import Runtime, RuntimeBinding, RuntimeGrant
from ..auth.authorization import Permission, WorkspaceScope
from ..pagination import Page
from ..service import Problem, audit, lock_installation
from ..services.runtime import RuntimeService
from ..services.workspace import WorkspaceRepository
from .base import API


class DeviceAPI(API):
    """原生设备注册与令牌生命周期入口：跳过 Cookie CSRF，依赖注册密钥或 Bearer；子类 ExecutionAPI/Native* 复用其 prepare 与 CSRF 策略。
    DeviceAPI 实现于 apps/srv/src/veriq_server/handlers/enrollment.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    def check_xsrf_cookie(self) -> None:
        """原生客户端使用有界注册密钥或 Authorization Bearer，不校验浏览器 CSRF Cookie；空实现防止 Tornado 默认 Cookie CSRF 拦截设备调用。
        check_xsrf_cookie 实现于 apps/srv/src/veriq_server/handlers/enrollment.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        pass

    def prepare(self) -> None:
        """设置请求号与正文上限；仅当显式携带 Origin 时才强制与 public_url 一致；无 Origin 的原生请求放行，有 Origin 则必须同源。
        prepare 实现于 apps/srv/src/veriq_server/handlers/enrollment.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        self.set_header("X-Request-Id", self.request_id)
        if len(self.request.body) > self.body_limit:
            raise Problem(413, "BODY_TOO_LARGE", "Request body exceeds operation limit")
        origin = self.request.headers.get("Origin")
        if origin and origin != self.config.public_url:
            raise Problem(403, "ORIGIN_FORBIDDEN", "Request origin is not allowed")

    async def post(self) -> None:
        """POST 服务注册、发起/轮询用户注册、轮换设备令牌或登出吊销当前令牌；enrollment-poll 在 PENDING 时仍提交节流时间戳。
        post 实现于 apps/srv/src/veriq_server/handlers/enrollment.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        if self.action == "device-info":
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        schema = {
            "service-enroll": "ServiceEnrollmentRequest",
            "enrollment-request": "EnrollmentRequest",
            "enrollment-poll": "EnrollmentPoll",
            "device-rotate": "DeviceRotationRequest",
            "device-logout": "EmptyObject",
        }[self.action]
        data = self.body(schema)
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            service = RuntimeService(session)
            if self.action == "service-enroll":
                result = await service.service_enroll(
                    self.request.headers.get("Authorization", ""), data
                )
            elif self.action == "enrollment-request":
                result = await service.request_enrollment(
                    data, self.request.remote_ip or "unknown", self.config.public_url
                )
            elif self.action == "enrollment-poll":
                try:
                    result = await service.poll(data["deviceCode"])
                except Problem as error:
                    if error.code == "ENROLLMENT_PENDING":
                        # 仅持久化节流时间戳；此时尚未签发任何设备凭证。
                        await session.commit()
                    raise
            elif self.action == "device-rotate":
                result = await service.rotate(self.request.headers.get("Authorization", ""), data)
            else:
                runtime, binding, token = await service.require_device(
                    self.request.headers.get("Authorization", "")
                )
                token.revoked = True
                audit(
                    session,
                    "runtime.token_revoked",
                    runtime.owner_user_id,
                    runtime.id,
                    workspace_id=binding.workspace_id,
                )
                result = (
                    service.issue_token(runtime, binding) if self.action == "device-rotate" else {}
                )
        self.respond(
            result, 201 if self.action in {"enrollment-request", "service-enroll"} else 200
        )

    async def get(self) -> None:
        """GET device-info：用 Bearer 解析 Runtime 绑定并返回设备 DTO；仅 device-info 允许 GET，其它 action 映射 405。
        get 实现于 apps/srv/src/veriq_server/handlers/enrollment.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        if self.action != "device-info":
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            service = RuntimeService(session)
            runtime, binding, _ = await service.require_device(
                self.request.headers.get("Authorization", "")
            )
            result = await service.dto(runtime, binding)
        self.respond(result)


class EnrollmentAPI(API):
    """浏览器态注册审批：检查用户码元数据，或批准设备进入指定 Workspace 并配置共享；审批主体是浏览器会话用户，不是设备 Bearer。
    EnrollmentAPI 实现于 apps/srv/src/veriq_server/handlers/enrollment.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    async def post(self, enrollment_id: str | None = None) -> None:
        """POST inspect 返回待批设备摘要；approve 校验私有/共享互斥后写入绑定；private 与 sharedWithUserIds 互斥，防止矛盾共享语义。
        post 实现于 apps/srv/src/veriq_server/handlers/enrollment.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        data = self.body(
            "EnrollmentInspect" if self.action == "enrollment-inspect" else "EnrollmentApprove"
        )
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            service = RuntimeService(session)
            if self.action == "enrollment-inspect":
                row = await service.enrollment(data["userCode"])
                result: dict[str, Any] = {
                    "id": row.id,
                    "name": row.name,
                    "capabilities": row.capabilities,
                }
            else:
                if data["private"] and data["sharedWithUserIds"]:
                    raise Problem(
                        400, "INVALID_REQUEST", "Private registration cannot include shares"
                    )
                result = await service.approve_enrollment(
                    user,
                    data["userCode"],
                    data["workspaceId"],
                    {
                        "workspaceId": data["workspaceId"],
                        "userIds": data["sharedWithUserIds"],
                        "sharedWithWorkspace": not data["private"]
                        and not data["sharedWithUserIds"],
                    },
                    enrollment_id=enrollment_id,
                )
        self.respond(result)


class RuntimeAPI(API):
    """工作区 Runtime 管理：列表可见范围、授权共享、信任审批、凭据投递开关与吊销；信任审批与授权名单变更都写 runtime.* 审计事件。
    RuntimeAPI 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    def prepare(self) -> None:
        """按 action 固定允许的单一 HTTP 动词，防止用错误方法触发信任态变更；每个 action 只允许一种方法，读写路径清晰分离。
        prepare 实现于 apps/srv/src/veriq_server/handlers/enrollment.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        super().prepare()
        allowed = {
            "runtimes": "GET",
            "runtime": "GET",
            "runtime-grants": "PUT",
            "runtime-trust": "PUT",
            "runtime-delivery": "PUT",
            "runtime-revoke": "POST",
        }[self.action]
        if self.request.method != allowed:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")

    async def get(self, workspace_id: str, runtime_id: str | None = None) -> None:
        """GET 读取单机或列出本人拥有/被共享/服务账号（管理员）可见的 Runtime；可见性条件在 SQL 层用 OR 组合，避免应用层二次过滤泄露。
        get 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        if self.action not in {"runtimes", "runtime"}:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        async with self.db.sessions() as session:
            user, _ = await self.identity(session)
            service = RuntimeService(session)
            await WorkspaceRepository(session, WorkspaceScope(workspace_id)).authorize(user)
            if runtime_id:
                runtime, binding = await service.require_access(user, workspace_id, runtime_id)
                self.respond(await service.dto(runtime, binding, user))
                return
            page = Page.read(
                self,
                {"list": "runtimes", "workspaceId": workspace_id, "actor": user.id},
                self.config.signing_key.get_secret_value(),
            )
            grant = select(RuntimeGrant.runtime_id).where(
                RuntimeGrant.workspace_id == workspace_id, RuntimeGrant.user_id == user.id
            )
            _, member = await WorkspaceRepository(session, WorkspaceScope(workspace_id)).authorize(
                user
            )
            # 仅 OWNER/ADMIN 可看见服务账号拥有的 Runtime；其余角色靠拥有/共享/授权。
            service_owned = (
                Runtime.owner_service_account_id.is_not(None)
                if member.role in {"OWNER", "ADMIN"}
                else false()
            )
            query = (
                select(Runtime, RuntimeBinding)
                .join(RuntimeBinding, RuntimeBinding.runtime_id == Runtime.id)
                .where(
                    RuntimeBinding.workspace_id == workspace_id,
                    or_(
                        service_owned,
                        Runtime.owner_user_id == user.id,
                        RuntimeBinding.shared_with_workspace.is_(True),
                        Runtime.id.in_(grant),
                    ),
                )
            )
            if page.last:
                query = query.where(Runtime.id > page.last[1])
            rows = (await session.execute(query.order_by(Runtime.id).limit(page.limit + 1))).all()
            shown = rows[: page.limit]
            self.respond(
                {
                    "items": [await service.dto(r, b, user) for r, b in shown],
                    "nextCursor": page.next(
                        (shown[-1][0].id, shown[-1][0].id), len(rows) > page.limit
                    )
                    if shown
                    else None,
                }
            )

    async def put(self, workspace_id: str, runtime_id: str) -> None:
        """PUT 更新授权名单、凭据投递开关或由系统管理员审批 MANAGED 信任；凭据投递打开时额外要求 MANAGE_ENVIRONMENT 写权限。
        put 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        if self.action not in {"runtime-grants", "runtime-trust", "runtime-delivery"}:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        data = self.body(
            {
                "runtime-grants": "RuntimeGrantWrite",
                "runtime-trust": "RuntimeTrustWrite",
                "runtime-delivery": "RuntimeCredentialDeliveryWrite",
            }[self.action]
        )
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            service = RuntimeService(session)
            runtime, binding = await service.require_access(
                user, workspace_id, runtime_id, owner=self.action == "runtime-grants"
            )
            if self.action == "runtime-grants":
                await service.set_grants(user, binding, runtime, data)
            elif self.action == "runtime-delivery":
                await service.set_credential_delivery(
                    user, runtime, binding, data["allowCredentialDelivery"]
                )
            else:
                if not user.system_admin:
                    raise Problem(
                        403,
                        "ADMIN_REQUIRED",
                        "Only a system administrator can approve Runtime trust",
                    )
                await service.require_owner_current(runtime, binding)
                has_share = binding.shared_with_workspace or bool(
                    (
                        await session.execute(
                            select(RuntimeGrant).where(
                                RuntimeGrant.runtime_id == runtime_id,
                                RuntimeGrant.workspace_id == workspace_id,
                            )
                        )
                    ).first()
                )
                # MANAGED 信任前必须已有所有者共享或显式授权，防止静默托管。
                if data["trustStatus"] == "MANAGED" and not has_share:
                    raise Problem(
                        403,
                        "OWNER_CONSENT_REQUIRED",
                        "Owner must share the Runtime before trust approval",
                    )
                if data["allowCredentialDelivery"] and data["trustStatus"] != "MANAGED":
                    raise Problem(
                        400, "INVALID_REQUEST", "Credential delivery requires MANAGED trust"
                    )
                if data["allowCredentialDelivery"]:
                    await WorkspaceRepository(session, WorkspaceScope(workspace_id)).authorize(
                        user, Permission.MANAGE_ENVIRONMENT, write=True
                    )
                runtime.trust_status = data["trustStatus"]
                binding.allow_credential_delivery = data["allowCredentialDelivery"]
                audit(
                    session, "runtime.trust_changed", user.id, runtime.id, workspace_id=workspace_id
                )
            result = await service.dto(runtime, binding, user)
        self.respond(result)

    async def post(self, workspace_id: str, runtime_id: str) -> None:
        """POST runtime-revoke：所有者吊销信任、停用绑定并关闭凭据投递；吊销后 binding.active=False，后续派发将被拒绝。
        post 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        if self.action != "runtime-revoke":
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        self.body("EmptyObject")
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            service = RuntimeService(session)
            runtime, binding = await service.require_access(
                user, workspace_id, runtime_id, owner=True
            )
            runtime.trust_status = "REVOKED"
            binding.active = False
            binding.allow_credential_delivery = False
            audit(session, "runtime.revoked", user.id, runtime.id, workspace_id=workspace_id)
            result = await service.dto(runtime, binding, user)
        self.respond(result)
