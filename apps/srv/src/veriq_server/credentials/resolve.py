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
    """Attempt 凭据证明传输层：捆绑 Bearer、租约令牌与 fencing 令牌供设备侧解析入口校验；repr 隐藏敏感令牌字段，降低日志意外泄露。
    CredentialProofTransport 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
    """

    authorization: str = field(repr=False)
    lease_token: str = field(repr=False)
    fencing_token: int

    @classmethod
    def parse(
        cls, authorization: str, lease_token: str, fencing_token: str
    ) -> "CredentialProofTransport":
        """解析并边界校验 Authorization、租约与 fencing 字符串，非法输入映射 400/403；fencing 必须是有界正十进制，拒绝科学计数法。
        parse 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
        """
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
    """已通过租约校验的 Attempt 证明快照：含信任态、凭据发放权、租约截止与当前 fence；由 AttemptProofVerifier 产出，供 resolve_verified 消费。
    VerifiedAttempt 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    VerifiedAttempt 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
    """

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
    """Attempt 证明校验协议：由执行层注入实现，凭据解析侧仅依赖此契约；Protocol 仅声明 verify，具体实现位于执行/租约服务。
    AttemptProofVerifier 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
    """

    async def verify(
        self, session: AsyncSession, attempt_id: str, proof: CredentialProofTransport
    ) -> VerifiedAttempt:
        """校验 Bearer、租约与 fencing 令牌后返回 VerifiedAttempt 快照，供凭据解密入口消费与授权判定。
        verify 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
        """
        ...


class DenyAttemptProof:
    """默认拒绝型校验器：在未装配真实租约校验时一律返回 ATTEMPT_PROOF_REQUIRED；用于测试与未接线部署的安全默认，拒绝一切解析。
    DenyAttemptProof 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
    """

    async def verify(
        self, session: AsyncSession, attempt_id: str, proof: CredentialProofTransport
    ) -> VerifiedAttempt:
        """故意不读取证明内容，强制控制面在缺省配置下拒绝任何凭据解析请求；忽略输入参数，始终抛出 ATTEMPT_PROOF_REQUIRED。
        verify 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
        """
        raise Problem(
            403, "ATTEMPT_PROOF_REQUIRED", "Verified active Attempt authorization is required"
        )


async def resolve_verified(
    session: AsyncSession, proof: VerifiedAttempt, secret_ref: str, version: str, keyring: Keyring
) -> Any:
    """在 MANAGED 租约、有效 fence 与身份冻结通过后解密指定密钥版本，绝不向未授权 Attempt 泄密；解密前再次 freeze 身份，确保适配器与密钥仍未撤销。
    resolve_verified 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
    必须同时满足活跃租约、托管信任、凭据发放权、成员有效与 fence 对齐。
    """
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
