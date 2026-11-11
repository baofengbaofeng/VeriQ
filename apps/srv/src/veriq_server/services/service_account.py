"""Reusable Workspace service identities; only enrollment purpose exists in T08."""

import secrets
from datetime import timedelta
from typing import Any
from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import Permission, WorkspaceScope
from ..db import ServiceAccount, ServiceToken, User
from ..service import Problem, audit, digest, now, stamp
from .workspace import WorkspaceRepository


class ServiceAccountService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def authorize(self, actor: User, workspace_id: str, *, write: bool = False) -> None:
        await WorkspaceRepository(self.session, WorkspaceScope(workspace_id)).authorize(
            actor, Permission.MANAGE_WORKSPACE, write=write
        )

    async def get(self, workspace_id: str, account_id: str) -> ServiceAccount:
        row = await self.session.get(ServiceAccount, account_id)
        if not row or row.workspace_id != workspace_id:
            raise Problem(404, "SERVICE_ACCOUNT_NOT_FOUND", "Service account not found")
        return row

    async def create(self, actor: User, workspace_id: str, name: str) -> ServiceAccount:
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

    async def issue(self, actor: User, account: ServiceAccount) -> dict[str, Any]:
        await self.authorize(actor, account.workspace_id, write=True)
        if account.disabled:
            raise Problem(403, "SERVICE_ACCOUNT_DISABLED", "Service account is disabled")
        secret = secrets.token_urlsafe(32)
        row = ServiceToken(
            id=str(uuid4()),
            service_account_id=account.id,
            token_hash=digest(secret),
            purpose="RUNTIME_ENROLLMENT",
            expires_at=now() + timedelta(minutes=10),
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

    async def consume(self, authorization: str) -> ServiceAccount:
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
    return {
        "id": row.id,
        "workspaceId": row.workspace_id,
        "name": row.name,
        "disabled": row.disabled,
    }
