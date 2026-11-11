"""Runtime registration and current authorization, independent of the T09 queue.

Callers acquire lock_installation before identity/Workspace reads and retain it
through the authorized operation. This is the existing account/membership guard;
T09 must preserve its ordering when adding assignment, lease and fencing locks.
Capabilities are untrusted reports, never approved compiler release provenance.
"""

import base64
import secrets
from datetime import timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import Permission, WorkspaceScope
from ..db import (
    Runtime,
    RuntimeBinding,
    RuntimeEnrollment,
    RuntimeGrant,
    RuntimeToken,
    User,
    Workspace,
    ServiceAccount,
)
from ..service import Problem, audit, digest, now, stamp
from .workspace import WorkspaceRepository


class RuntimeService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def request_enrollment(
        self, data: dict[str, Any], request_key: str, public_url: str
    ) -> dict[str, Any]:
        if data["location"] != "CONNECTED_LOCAL":
            raise Problem(
                403,
                "SERVICE_ENROLLMENT_REQUIRED",
                "Cloud registration requires a deployment service account",
            )
        count = (
            await self.session.execute(
                select(func.count())
                .select_from(RuntimeEnrollment)
                .where(
                    RuntimeEnrollment.request_hash == digest(request_key),
                    RuntimeEnrollment.created_at > now() - timedelta(minutes=10),
                )
            )
        ).scalar_one()
        if count >= 20:
            raise Problem(429, "ENROLLMENT_RATE_LIMIT", "Try enrollment again after ten minutes")
        user_code = base64.b32encode(secrets.token_bytes(8)).decode()[:12]
        device_code = secrets.token_urlsafe(32)
        row = RuntimeEnrollment(
            id=str(uuid4()),
            user_code_hash=digest(user_code),
            device_code_hash=digest(device_code),
            request_hash=digest(request_key),
            name=data["name"],
            capabilities=data["capabilities"],
            created_at=now(),
            expires_at=now() + timedelta(minutes=10),
            consumed=False,
        )
        self.session.add(row)
        return {
            "id": row.id,
            "userCode": user_code,
            "deviceCode": device_code,
            "expiresAt": stamp(row.expires_at),
            "verificationUrl": public_url + "/runtimes",
            "intervalSeconds": 5,
        }

    async def enrollment(self, code: str) -> RuntimeEnrollment:
        row = (
            await self.session.execute(
                select(RuntimeEnrollment)
                .where(RuntimeEnrollment.user_code_hash == digest(code))
                .with_for_update()
            )
        ).scalar_one_or_none()
        if not row or row.consumed or row.expires_at <= now():
            raise Problem(401, "ENROLLMENT_INVALID", "Enrollment is invalid or expired")
        if row.runtime_id:
            raise Problem(409, "ENROLLMENT_APPROVED", "Enrollment already approved")
        return row

    async def approve_enrollment(
        self,
        actor: User,
        code: str,
        binding: str,
        grants: dict[str, Any],
        *,
        enrollment_id: str | None = None,
    ) -> dict[str, Any]:
        row = await self.enrollment(code)
        if enrollment_id and row.id != enrollment_id:
            raise Problem(401, "ENROLLMENT_INVALID", "Enrollment does not match code")
        await WorkspaceRepository(self.session, WorkspaceScope(binding)).authorize(
            actor, Permission.EXECUTE, write=True
        )
        runtime = Runtime(
            id=str(uuid4()),
            owner_user_id=actor.id,
            name=row.name,
            location="CONNECTED_LOCAL",
            trust_status="USER_REGISTERED",
            capabilities=row.capabilities,
            created_at=now(),
        )
        self.session.add(runtime)
        await self.session.flush()
        bound = RuntimeBinding(
            runtime_id=runtime.id,
            workspace_id=binding,
            shared_with_workspace=False,
            allow_credential_delivery=False,
            active=True,
        )
        self.session.add(bound)
        await self.session.flush()
        await self.set_grants(actor, bound, runtime, grants)
        row.runtime_id = runtime.id
        audit(self.session, "runtime.enrolled", actor.id, runtime.id, workspace_id=binding)
        return await self.dto(runtime, bound, actor)

    async def poll(self, device_code: str) -> dict[str, Any]:
        row = (
            await self.session.execute(
                select(RuntimeEnrollment)
                .where(RuntimeEnrollment.device_code_hash == digest(device_code))
                .with_for_update()
            )
        ).scalar_one_or_none()
        if not row or row.expires_at <= now() or row.consumed:
            raise Problem(401, "ENROLLMENT_INVALID", "Enrollment is invalid or expired")
        if not row.runtime_id:
            if row.last_polled_at and row.last_polled_at > now() - timedelta(seconds=5):
                raise Problem(429, "ENROLLMENT_SLOW_DOWN", "Poll at most once every five seconds")
            row.last_polled_at = now()
            raise Problem(409, "ENROLLMENT_PENDING", "Waiting for owner approval")
        runtime = await self.session.get(Runtime, row.runtime_id)
        binding = (
            await self.session.execute(
                select(RuntimeBinding).where(RuntimeBinding.runtime_id == row.runtime_id)
            )
        ).scalar_one()
        assert runtime
        await self.require_owner_current(runtime, binding)
        row.consumed = True
        return self.issue_token(runtime, binding)

    def issue_token(
        self, runtime: Runtime, binding: RuntimeBinding, secret: str | None = None
    ) -> dict[str, Any]:
        secret = secret or secrets.token_urlsafe(32)
        expires = now() + timedelta(hours=24)
        self.session.add(
            RuntimeToken(
                id=str(uuid4()),
                runtime_id=runtime.id,
                workspace_id=binding.workspace_id,
                token_hash=digest(secret),
                expires_at=expires,
                revoked=False,
                created_at=now(),
            )
        )
        audit(
            self.session,
            "runtime.token_issued",
            runtime.owner_user_id,
            runtime.id,
            workspace_id=binding.workspace_id,
        )
        return {
            "runnerId": runtime.id,
            "workspaceId": binding.workspace_id,
            "deviceToken": secret,
            "expiresAt": stamp(expires),
        }

    async def bound(self, workspace_id: str, runtime_id: str) -> tuple[Runtime, RuntimeBinding]:
        row = (
            await self.session.execute(
                select(Runtime, RuntimeBinding)
                .join(RuntimeBinding, RuntimeBinding.runtime_id == Runtime.id)
                .where(Runtime.id == runtime_id, RuntimeBinding.workspace_id == workspace_id)
            )
        ).first()
        if not row:
            raise Problem(404, "RUNTIME_NOT_FOUND", "Runtime is not bound to this Workspace")
        return row[0], row[1]

    async def service_enroll(self, authorization: str, data: dict[str, Any]) -> dict[str, Any]:
        from .service_account import ServiceAccountService

        account = await ServiceAccountService(self.session).consume(authorization)
        workspace = await self.session.get(Workspace, account.workspace_id)
        if not workspace or workspace.archived:
            raise Problem(401, "SERVICE_TOKEN_INVALID", "Workspace is inactive")
        runtime = Runtime(
            id=str(uuid4()),
            owner_service_account_id=account.id,
            name=data["name"],
            location="MANAGED_CLOUD",
            trust_status="USER_REGISTERED",
            capabilities=data["capabilities"],
            created_at=now(),
        )
        self.session.add(runtime)
        await self.session.flush()
        binding = RuntimeBinding(
            runtime_id=runtime.id,
            workspace_id=account.workspace_id,
            shared_with_workspace=data["sharedWithWorkspace"],
            allow_credential_delivery=False,
            active=True,
        )
        self.session.add(binding)
        await self.session.flush()
        audit(
            self.session,
            "runtime.service_enrolled",
            None,
            runtime.id,
            workspace_id=account.workspace_id,
        )
        return self.issue_token(runtime, binding)

    async def can_manage(self, actor: User, runtime: Runtime, binding: RuntimeBinding) -> bool:
        if runtime.owner_user_id:
            return actor.id == runtime.owner_user_id
        account = await self.session.get(ServiceAccount, runtime.owner_service_account_id)
        if not account or account.workspace_id != binding.workspace_id:
            return False
        try:
            await WorkspaceRepository(self.session, WorkspaceScope(binding.workspace_id)).authorize(
                actor, Permission.MANAGE_WORKSPACE
            )
        except Problem:
            return False
        return True

    async def require_owner_current(self, runtime: Runtime, binding: RuntimeBinding) -> None:
        if runtime.trust_status == "REVOKED" or not binding.active:
            raise Problem(401, "DEVICE_REVOKED", "Runtime authorization is revoked")
        if runtime.owner_service_account_id:
            account = await self.session.get(ServiceAccount, runtime.owner_service_account_id)
            workspace = await self.session.get(Workspace, binding.workspace_id)
            if (
                not account
                or account.disabled
                or account.workspace_id != binding.workspace_id
                or not workspace
                or workspace.archived
            ):
                raise Problem(401, "DEVICE_REVOKED", "Service account authorization is inactive")
            return
        owner = (
            await self.session.get(User, runtime.owner_user_id) if runtime.owner_user_id else None
        )
        workspace = await self.session.get(Workspace, binding.workspace_id)
        if not owner or owner.disabled or not workspace or workspace.archived:
            raise Problem(401, "DEVICE_REVOKED", "Runtime owner or Workspace is inactive")
        try:
            await WorkspaceRepository(self.session, WorkspaceScope(binding.workspace_id)).authorize(
                owner, Permission.EXECUTE
            )
        except Problem:
            raise Problem(
                401, "DEVICE_REVOKED", "Runtime owner authorization is inactive"
            ) from None

    async def rotate(self, authorization: str, data: dict[str, Any]) -> dict[str, Any]:
        if not data:
            runtime, binding, token = await self.require_device(authorization)
            token.revoked = True
            audit(
                self.session,
                "runtime.token_revoked",
                runtime.owner_user_id,
                runtime.id,
                workspace_id=binding.workspace_id,
            )
            return self.issue_token(runtime, binding)
        candidate = data["replacementToken"]
        if authorization == "Bearer " + candidate:
            raise Problem(400, "INVALID_ROTATION", "Replacement must be a new credential")
        if not authorization.startswith("Bearer ") or not 43 <= len(authorization[7:]) <= 128:
            raise Problem(401, "DEVICE_UNAUTHORIZED", "Valid device authentication required")
        predecessor = (
            await self.session.execute(
                select(RuntimeToken)
                .where(RuntimeToken.token_hash == digest(authorization[7:]))
                .with_for_update()
            )
        ).scalar_one_or_none()
        if predecessor and predecessor.rotation_request_id:
            if predecessor.rotation_request_id != data[
                "clientRequestId"
            ] or predecessor.successor_hash != digest(candidate):
                raise Problem(401, "DEVICE_UNAUTHORIZED", "Rotation recovery is not authorized")
            runtime, binding, successor = await self.require_device("Bearer " + candidate)
            if (
                runtime.id != predecessor.runtime_id
                or binding.workspace_id != predecessor.workspace_id
            ):
                raise Problem(401, "DEVICE_UNAUTHORIZED", "Rotation recovery is not authorized")
            return {
                "runnerId": runtime.id,
                "workspaceId": binding.workspace_id,
                "deviceToken": candidate,
                "expiresAt": stamp(successor.expires_at),
            }
        runtime, binding, token = await self.require_device(authorization)
        if (
            await self.session.execute(
                select(RuntimeToken.id).where(RuntimeToken.token_hash == digest(candidate))
            )
        ).first():
            raise Problem(400, "INVALID_ROTATION", "Replacement must be a new credential")
        token.revoked = True
        audit(
            self.session,
            "runtime.token_revoked",
            runtime.owner_user_id,
            runtime.id,
            workspace_id=binding.workspace_id,
        )
        token.rotation_request_id = data["clientRequestId"]
        token.successor_hash = digest(candidate)
        return self.issue_token(runtime, binding, candidate)

    async def require_device(
        self, authorization: str
    ) -> tuple[Runtime, RuntimeBinding, RuntimeToken]:
        # A cookie or human enrollment code is never accepted as device identity.
        if not authorization.startswith("Bearer ") or not 43 <= len(authorization[7:]) <= 128:
            raise Problem(401, "DEVICE_UNAUTHORIZED", "Valid device authentication required")
        token = (
            await self.session.execute(
                select(RuntimeToken)
                .where(
                    RuntimeToken.token_hash == digest(authorization[7:]),
                    RuntimeToken.revoked.is_(False),
                    RuntimeToken.expires_at > now(),
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        if not token:
            raise Problem(401, "DEVICE_UNAUTHORIZED", "Device credential is expired or revoked")
        runtime, binding = await self.bound(token.workspace_id, token.runtime_id)
        await self.require_owner_current(runtime, binding)
        return runtime, binding, token

    async def can_view(self, actor: User, runtime: Runtime, binding: RuntimeBinding) -> bool:
        if await self.can_manage(actor, runtime, binding) or binding.shared_with_workspace:
            return True
        return (
            await self.session.get(RuntimeGrant, (runtime.id, binding.workspace_id, actor.id))
            is not None
        )

    async def require_access(
        self, actor: User, workspace_id: str, runtime_id: str, *, owner: bool = False
    ) -> tuple[Runtime, RuntimeBinding]:
        await WorkspaceRepository(self.session, WorkspaceScope(workspace_id)).authorize(actor)
        runtime, binding = await self.bound(workspace_id, runtime_id)
        if (
            owner and not await self.can_manage(actor, runtime, binding)
        ) or not await self.can_view(actor, runtime, binding):
            raise Problem(403, "PRIVATE_RUNTIME_FORBIDDEN", "Runtime owner consent required")
        return runtime, binding

    async def require_dispatch(self, actor: User, workspace_id: str, runtime_id: str) -> Runtime:
        await WorkspaceRepository(self.session, WorkspaceScope(workspace_id)).authorize(
            actor, Permission.EXECUTE, write=True
        )
        runtime, binding = await self.require_access(actor, workspace_id, runtime_id)
        await self.require_owner_current(runtime, binding)
        return runtime

    async def set_grants(
        self, actor: User, binding: RuntimeBinding, runtime: Runtime, grants: dict[str, Any]
    ) -> None:
        if not await self.can_manage(actor, runtime, binding):
            raise Problem(403, "PRIVATE_RUNTIME_FORBIDDEN", "Only the Runtime owner may share it")
        if grants["workspaceId"] != binding.workspace_id:
            raise Problem(422, "INVALID_REFERENCE", "Grant belongs to another Workspace")
        if runtime.trust_status == "REVOKED":
            raise Problem(409, "DEVICE_REVOKED", "Revoked Runtime cannot be shared")
        repo = WorkspaceRepository(self.session, WorkspaceScope(binding.workspace_id))
        await repo.authorize(actor, Permission.EXECUTE, write=True)
        for uid in grants["userIds"]:
            user = await self.session.get(User, uid)
            member = await repo.member(uid)
            if not user or user.disabled or not member or member.status != "ACTIVE":
                raise Problem(
                    422, "INVALID_REFERENCE", "Share target must be a current Workspace member"
                )
        await self.session.execute(
            delete(RuntimeGrant).where(
                RuntimeGrant.runtime_id == runtime.id,
                RuntimeGrant.workspace_id == binding.workspace_id,
            )
        )
        for uid in grants["userIds"]:
            self.session.add(
                RuntimeGrant(runtime_id=runtime.id, workspace_id=binding.workspace_id, user_id=uid)
            )
        binding.shared_with_workspace = grants["sharedWithWorkspace"]
        # Any consent change invalidates the earlier admin trust/delivery approval.
        binding.allow_credential_delivery = False
        runtime.trust_status = "USER_REGISTERED"
        audit(
            self.session,
            "runtime.grants_changed",
            actor.id,
            runtime.id,
            workspace_id=binding.workspace_id,
        )
        await self.session.flush()

    async def set_credential_delivery(
        self, actor: User, runtime: Runtime, binding: RuntimeBinding, allowed: bool
    ) -> None:
        await WorkspaceRepository(self.session, WorkspaceScope(binding.workspace_id)).authorize(
            actor, Permission.MANAGE_ENVIRONMENT, write=True
        )
        if allowed:
            await self.require_owner_current(runtime, binding)
            has_share = binding.shared_with_workspace or bool(
                (
                    await self.session.execute(
                        select(RuntimeGrant).where(
                            RuntimeGrant.runtime_id == runtime.id,
                            RuntimeGrant.workspace_id == binding.workspace_id,
                        )
                    )
                ).first()
            )
            if not has_share or runtime.trust_status != "MANAGED":
                raise Problem(
                    403,
                    "CREDENTIAL_DELIVERY_FORBIDDEN",
                    "Credential delivery requires owner consent and MANAGED trust",
                )
        binding.allow_credential_delivery = allowed
        audit(
            self.session,
            "runtime.credential_delivery_changed",
            actor.id,
            runtime.id,
            workspace_id=binding.workspace_id,
        )

    async def dto(
        self, runtime: Runtime, binding: RuntimeBinding, actor: User | None = None
    ) -> dict[str, Any]:
        users = (
            (
                await self.session.execute(
                    select(RuntimeGrant.user_id)
                    .where(
                        RuntimeGrant.runtime_id == runtime.id,
                        RuntimeGrant.workspace_id == binding.workspace_id,
                    )
                    .order_by(RuntimeGrant.user_id)
                )
            )
            .scalars()
            .all()
        )
        return {
            "id": runtime.id,
            "ownerId": runtime.owner_user_id or runtime.owner_service_account_id,
            "ownerType": "USER" if runtime.owner_user_id else "SERVICE_ACCOUNT",
            "workspaceId": binding.workspace_id,
            "name": runtime.name,
            "location": runtime.location,
            "trustStatus": runtime.trust_status,
            "status": "REVOKED"
            if runtime.trust_status == "REVOKED"
            else (
                "ONLINE"
                if runtime.last_seen_at and runtime.last_seen_at > now() - timedelta(seconds=60)
                else "OFFLINE"
            ),
            **({"lastSeenAt": stamp(runtime.last_seen_at)} if runtime.last_seen_at else {}),
            "capabilities": runtime.capabilities,
            "capabilitiesSource": "DEVICE_REPORTED",
            "sharedWithWorkspace": binding.shared_with_workspace,
            "sharedWithUserIds": list(users),
            "allowCredentialDelivery": binding.allow_credential_delivery,
            "canManage": bool(actor and await self.can_manage(actor, runtime, binding)),
        }
