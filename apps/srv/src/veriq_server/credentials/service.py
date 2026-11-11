"""Credential lifecycle; management never returns plaintext."""

from typing import Any
from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import Permission, WorkspaceScope
from ..db import SecretRef, SecretVersion, User
from ..service import Problem, audit, now, stamp
from ..services.workspace import WorkspaceRepository
from ..settings import Settings
from .crypto import Keyring


def configured_keyring(settings: Settings) -> Keyring:
    return Keyring(
        settings.master_key_id,
        {
            **{
                key: bytes.fromhex(value.get_secret_value())
                for key, value in settings.previous_master_keys.items()
            },
            settings.master_key_id: bytes.fromhex(settings.master_key.get_secret_value()),
        },
    )


def version_dto(row: SecretVersion) -> dict[str, Any]:
    return {
        "secretRef": row.secret_ref,
        "versionId": row.id,
        "allowedIdentityIds": row.allowed_identity_ids,
        "revoked": row.revoked,
        "createdAt": stamp(row.created_at),
    }


class CredentialService:
    def __init__(self, session: AsyncSession, user: User, keyring: Keyring):
        self.session, self.user, self.keyring = session, user, keyring

    async def authorize(self, scope: WorkspaceScope, write: bool = False) -> None:
        await WorkspaceRepository(self.session, scope).authorize(
            self.user, Permission.MANAGE_ENVIRONMENT, write=write
        )

    async def create(
        self, scope: WorkspaceScope, secret_ref: str, data: dict[str, Any], *, new: bool
    ) -> dict[str, Any]:
        await self.authorize(scope, True)
        ref = await self.session.get(SecretRef, (scope.workspace_id, secret_ref))
        if new and ref:
            raise Problem(409, "CREDENTIAL_EXISTS", "Credential reference already exists")
        if not new and not ref:
            raise Problem(404, "CREDENTIAL_NOT_FOUND", "Credential reference not found")
        if ref is None:
            self.session.add(
                SecretRef(workspace_id=scope.workspace_id, key=secret_ref, created_at=now())
            )
            await self.session.flush()
        version = str(uuid4())
        sealed = self.keyring.encrypt(scope.workspace_id, secret_ref, version, data["value"])
        row = SecretVersion(
            id=version,
            workspace_id=scope.workspace_id,
            secret_ref=secret_ref,
            key_id=sealed.key_id,
            nonce=sealed.nonce,
            ciphertext=sealed.ciphertext,
            allowed_identity_ids=data["allowedIdentityIds"],
            revoked=False,
            created_at=now(),
        )
        self.session.add(row)
        audit(
            self.session,
            "credential.version.created",
            self.user.id,
            version,
            workspace_id=scope.workspace_id,
        )
        await self.session.flush()
        return version_dto(row)

    async def revoke(self, scope: WorkspaceScope, secret_ref: str, version: str) -> dict[str, Any]:
        await self.authorize(scope, True)
        row = (
            await self.session.execute(
                select(SecretVersion)
                .where(
                    SecretVersion.workspace_id == scope.workspace_id,
                    SecretVersion.secret_ref == secret_ref,
                    SecretVersion.id == version,
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        if row is None:
            raise Problem(404, "CREDENTIAL_NOT_FOUND", "Credential version not found")
        row.revoked = True
        audit(
            self.session,
            "credential.version.revoked",
            self.user.id,
            version,
            workspace_id=scope.workspace_id,
        )
        return version_dto(row)
