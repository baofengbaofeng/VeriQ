"""User approval is Cookie/CSRF protected; device transport never uses cookies."""

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
    def check_xsrf_cookie(self) -> None:
        # Native clients use bounded enrollment secrets or an Authorization bearer.
        pass

    def prepare(self) -> None:
        self.set_header("X-Request-Id", self.request_id)
        if len(self.request.body) > self.body_limit:
            raise Problem(413, "BODY_TOO_LARGE", "Request body exceeds operation limit")
        origin = self.request.headers.get("Origin")
        if origin and origin != self.config.public_url:
            raise Problem(403, "ORIGIN_FORBIDDEN", "Request origin is not allowed")

    async def post(self) -> None:
        if self.action == "device-info":
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        schema = {
            "service-enroll": "ServiceEnrollmentRequest",
            "enrollment-request": "EnrollmentRequest",
            "enrollment-poll": "EnrollmentPoll",
            "device-rotate": "EmptyObject",
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
                        # Persist only the throttle timestamp; no credential was issued.
                        await session.commit()
                    raise
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
    async def post(self, enrollment_id: str | None = None) -> None:
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
    def prepare(self) -> None:
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
