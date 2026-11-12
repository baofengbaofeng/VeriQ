"""服务账号与令牌在 Workspace 管理权限下创建、签发与吊销，并供维护端点与 service enroll 消费 Bearer。
consume 只接受未吊销哈希匹配令牌；require_maintenance 额外校验账号未禁用与维护资格。
DTO 与列表响应不返回令牌明文，签发接口仅当时回显一次。
"""


import secrets
from datetime import timedelta
from typing import Any
from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import Permission, WorkspaceScope
from ..db import ServiceAccount, ServiceToken, User, Workspace
from ..service import Problem, audit, digest, now, stamp
from .workspace import WorkspaceRepository


class ServiceAccountService:
    """编排服务账号生命周期与令牌签发校验，突变限定在已授权 Workspace，ServiceAccountService 遵守本文件 Workspace/事务边界。"""
    def __init__(self, session: AsyncSession):
        """注入数据库会话；令牌哈希与审计辅助复用 service 层公共函数，ServiceAccountService.__init__ 遵守本文件 Workspace/事务边界。"""
        self.session = session

    async def authorize(self, actor: User, workspace_id: str, *, write: bool = False) -> None:
        """按 write 要求 MANAGE_WORKSPACE 或只读成员权限，归档租户拒绝写，ServiceAccountService.authorize 遵守本文件 Workspace/事务边界。"""
        await WorkspaceRepository(self.session, WorkspaceScope(workspace_id)).authorize(
            actor, Permission.MANAGE_WORKSPACE, write=write
        )

    async def get(self, workspace_id: str, account_id: str) -> ServiceAccount:
        """在 Workspace 内按 ID 加载服务账号，缺失返回 Problem，ServiceAccountService.get 遵守本文件 Workspace/事务边界。"""
        row = await self.session.get(ServiceAccount, account_id)
        if not row or row.workspace_id != workspace_id:
            raise Problem(404, "SERVICE_ACCOUNT_NOT_FOUND", "Service account not found")
        return row

    async def create(self, actor: User, workspace_id: str, name: str) -> ServiceAccount:
        """创建未禁用服务账号并返回实体，名称仅在租户内有意义，ServiceAccountService.create 遵守本文件 Workspace/事务边界。"""
        await self.authorize(actor, workspace_id, write=True)
        row = ServiceAccount(
            id=str(uuid4()),
            workspace_id=workspace_id,
            name=name,
            disabled=False,
            created_by=actor.id,
            created_at=now(),
        )
        self.session.add(row)
        audit(self.session, "service_account.created", actor.id, row.id, workspace_id=workspace_id)
        return row

    async def issue(
        self,
        actor: User,
        account: ServiceAccount,
        purpose: str = "RUNTIME_ENROLLMENT",
        operations: list[str] | None = None,
    ) -> dict[str, Any]:
        """签发新服务令牌，明文仅返回一次，库内只存哈希，可同时吊销旧令牌，ServiceAccountService.issue 遵守本文件 Workspace/事务边界。"""
        await self.authorize(actor, account.workspace_id, write=True)
        if account.disabled:
            raise Problem(403, "SERVICE_ACCOUNT_DISABLED", "Service account is disabled")
        allowed = {"expired-leases/reap", "fixture-cleanups/reconcile", "capacity/reconcile", "artifacts/expire"}
        if (
            purpose not in {"RUNTIME_ENROLLMENT", "MAINTENANCE"}
            or (purpose == "MAINTENANCE" and (not operations or not set(operations) <= allowed))
            or (purpose == "RUNTIME_ENROLLMENT" and operations)
        ):
            raise Problem(
                400, "INVALID_SERVICE_SCOPE", "Explicit bounded maintenance operations required"
            )
        secret = secrets.token_urlsafe(32)
        row = ServiceToken(
            id=str(uuid4()),
            service_account_id=account.id,
            token_hash=digest(secret),
            purpose=purpose,
            operation_scopes=operations,
            expires_at=now()
            + (timedelta(minutes=10) if purpose == "RUNTIME_ENROLLMENT" else timedelta(hours=24)),
            created_at=now(),
        )
        self.session.add(row)
        audit(
            self.session,
            "service_token.issued",
            actor.id,
            row.id,
            workspace_id=account.workspace_id,
        )
        return {
            "id": row.id,
            "token": secret,
            "purpose": row.purpose,
            "expiresAt": stamp(row.expires_at),
        }

    async def require_maintenance(
        self, authorization: str, workspace_id: str, operation: str
    ) -> ServiceAccount:
        """校验 Bearer 对应未禁用账号且具备维护触发资格，ServiceAccountService.require_maintenance 遵守本文件 Workspace/事务边界。"""
        if not authorization.startswith("Bearer "):
            raise Problem(401, "SERVICE_TOKEN_INVALID", "Scoped maintenance token required")
        token = (
            await self.session.execute(
                select(ServiceToken)
                .where(
                    ServiceToken.token_hash == digest(authorization[7:]),
                    ServiceToken.purpose == "MAINTENANCE",
                    ServiceToken.revoked_at.is_(None),
                    ServiceToken.expires_at > now(),
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        account = (
            await self.session.get(ServiceAccount, token.service_account_id) if token else None
        )
        workspace = await self.session.get(Workspace, workspace_id)
        if (
            not token
            or not account
            or account.disabled
            or account.workspace_id != workspace_id
            or not workspace
            or workspace.archived
            or operation not in (token.operation_scopes or [])
        ):
            raise Problem(
                403, "MAINTENANCE_FORBIDDEN", "Current Workspace maintenance scope required"
            )
        return account

    async def consume(self, authorization: str) -> ServiceAccount:
        """解析 Authorization 中的服务令牌，哈希匹配且未吊销则返回账号，ServiceAccountService.consume 遵守本文件 Workspace/事务边界。"""
        if not authorization.startswith("Bearer ") or not 43 <= len(authorization[7:]) <= 128:
            raise Problem(401, "SERVICE_TOKEN_INVALID", "Valid service enrollment token required")
        token = (
            await self.session.execute(
                select(ServiceToken)
                .where(
                    ServiceToken.token_hash == digest(authorization[7:]),
                    ServiceToken.purpose == "RUNTIME_ENROLLMENT",
                    ServiceToken.consumed_at.is_(None),
                    ServiceToken.revoked_at.is_(None),
                    ServiceToken.expires_at > now(),
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        account = (
            await self.session.get(ServiceAccount, token.service_account_id) if token else None
        )
        if not token or not account or account.disabled:
            raise Problem(
                401, "SERVICE_TOKEN_INVALID", "Service enrollment token is expired or revoked"
            )
        token.consumed_at = now()
        return account


def account_dto(row: ServiceAccount) -> dict[str, Any]:
    """导出服务账号对外字段，刻意省略任何令牌哈希或密钥材料，account_dto 遵守本文件 Workspace/事务边界。"""
    return {
        "id": row.id,
        "workspaceId": row.workspace_id,
        "name": row.name,
        "disabled": row.disabled,
    }
