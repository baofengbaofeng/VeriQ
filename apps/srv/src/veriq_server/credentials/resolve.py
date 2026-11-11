"""Server-only verifier boundary. T08/T09 must supply actual device/Attempt proof."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import WorkspaceScope
from ..db import SecretVersion
from ..service import Problem, now
from .crypto import EncryptedValue, Keyring
from .registry import IdentityRegistry


@dataclass(frozen=True)
class CredentialProofTransport:
    authorization: str = field(repr=False)
    lease_token: str = field(repr=False)
    fencing_token: int

    @classmethod
    def parse(
        cls, authorization: str, lease_token: str, fencing_token: str
    ) -> "CredentialProofTransport":
        if not authorization or not lease_token or not fencing_token:
            raise Problem(
                403, "ATTEMPT_PROOF_REQUIRED", "Device authorization, lease and fence are required"
            )
        if (
            not authorization.startswith("Bearer ")
            or not authorization[7:]
            or len(authorization) > 4096
            or len(lease_token) > 4096
            or len(fencing_token) > 16
            or not fencing_token.isascii()
            or not fencing_token.isdecimal()
            or not 1 <= int(fencing_token) <= 9007199254740991
        ):
            raise Problem(400, "INVALID_ATTEMPT_PROOF", "Attempt proof transport is invalid")
        return cls(authorization, lease_token, int(fencing_token))


@dataclass(frozen=True)
class VerifiedAttempt:
    workspace_id: str
    attempt_id: str
    device_id: str
    active: bool
    trust_status: str
    credential_grant: bool
    membership_active: bool
    lease_until: datetime
    fence: int
    current_fence: int
    identities: list[dict[str, Any]]


class AttemptProofVerifier(Protocol):
    async def verify(
        self, session: AsyncSession, attempt_id: str, proof: CredentialProofTransport
    ) -> VerifiedAttempt: ...


class DenyAttemptProof:
    async def verify(
        self, session: AsyncSession, attempt_id: str, proof: CredentialProofTransport
    ) -> VerifiedAttempt:
        raise Problem(
            403, "ATTEMPT_PROOF_REQUIRED", "Verified active Attempt authorization is required"
        )


async def resolve_verified(
    session: AsyncSession, proof: VerifiedAttempt, secret_ref: str, version: str, keyring: Keyring
) -> Any:
    if not (
        proof.active
        and proof.trust_status == "MANAGED"
        and proof.credential_grant
        and proof.membership_active
        and proof.lease_until > now()
        and proof.fence == proof.current_fence
        and proof.device_id
    ):
        raise Problem(
            403, "CREDENTIAL_GRANT_DENIED", "Current managed device authorization is required"
        )
    identities = [
        r
        for r in proof.identities
        if r["secretRef"] == secret_ref and r["secretVersionId"] == version
    ]
    if not identities:
        raise Problem(403, "CREDENTIAL_NOT_ASSIGNED", "Credential is not assigned to this Attempt")
    await IdentityRegistry().freeze(session, WorkspaceScope(proof.workspace_id), identities)
    row = (
        await session.execute(
            select(SecretVersion)
            .execution_options(populate_existing=True)
            .where(
                SecretVersion.workspace_id == proof.workspace_id,
                SecretVersion.secret_ref == secret_ref,
                SecretVersion.id == version,
            )
            .with_for_update()
        )
    ).scalar_one()
    if row.revoked:
        raise Problem(409, "CREDENTIAL_REVOKED", "Credential version is revoked")
    return keyring.decrypt(
        proof.workspace_id,
        secret_ref,
        version,
        EncryptedValue(row.key_id, row.nonce, row.ciphertext),
    )
