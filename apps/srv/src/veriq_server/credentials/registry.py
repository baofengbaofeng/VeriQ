"""Typed immutable authentication configurations; no user-supplied code."""

from typing import Any
from hashlib import sha256
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import WorkspaceScope
from ..contracts import canonical_bytes, validate_schema
from ..db import AuthAdapterVersion, SecretVersion
from ..service import Problem


def adapter_dto(row: AuthAdapterVersion) -> dict[str, Any]:
    return {
        "workspaceId": row.workspace_id,
        "versionId": row.id,
        "configuration": row.configuration,
        "contentHash": row.content_hash,
    }


class IdentityRegistry:
    async def adapter(
        self, session: AsyncSession, scope: WorkspaceScope, version: str
    ) -> AuthAdapterVersion:
        row = (
            await session.execute(
                select(AuthAdapterVersion)
                .execution_options(populate_existing=True)
                .with_for_update()
                .where(
                    AuthAdapterVersion.workspace_id == scope.workspace_id,
                    AuthAdapterVersion.id == version,
                )
            )
        ).scalar_one_or_none()
        if row is None or row.revoked:
            raise Problem(422, "AUTH_ADAPTER_UNAVAILABLE", "Authentication adapter is unavailable")
        if (
            validate_schema("AuthAdapterConfigV1", row.configuration)
            or sha256(canonical_bytes(row.configuration)).hexdigest() != row.content_hash
        ):
            raise Problem(422, "AUTH_ADAPTER_INVALID", "Authentication adapter is invalid")
        return row

    async def require_role(
        self, session: AsyncSession, scope: WorkspaceScope, role: dict[str, Any]
    ) -> None:
        await self.adapter(session, scope, role["authAdapterVersionId"])
        row = (
            await session.execute(
                select(SecretVersion)
                .execution_options(populate_existing=True)
                .with_for_update()
                .where(
                    SecretVersion.workspace_id == scope.workspace_id,
                    SecretVersion.secret_ref == role["secretRef"],
                    SecretVersion.id == role["secretVersionId"],
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise Problem(422, "CREDENTIAL_NOT_FOUND", "Credential reference is unavailable")
        if row.revoked:
            raise Problem(409, "CREDENTIAL_REVOKED", "Credential version is revoked")
        allowed = role.get("allowedIdentityIds")
        if not allowed or not set(allowed) <= set(row.allowed_identity_ids):
            raise Problem(
                422,
                "IDENTITY_NOT_ALLOWED",
                "Explicit allowed identities must match credential scope",
            )

    async def freeze(
        self, session: AsyncSession, scope: WorkspaceScope, roles: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        result = {}
        for version in sorted({role["authAdapterVersionId"] for role in roles}):
            await self.adapter(session, scope, version)
        for role in sorted(roles, key=lambda r: (r["secretRef"], r["secretVersionId"])):
            await self.require_role(session, scope, role)
            row = await self.adapter(session, scope, role["authAdapterVersionId"])
            result[row.id] = adapter_dto(row)
        return [result[key] for key in sorted(result)]
