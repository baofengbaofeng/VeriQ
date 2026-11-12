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


def configured_keyring(settings: Settings, *, purpose: str = "veriq-credential-v1") -> Keyring:
    """从 Settings 组装含历史主密钥的 Keyring，供管理面写入与 Attempt 解析共用同一 purpose。"""
    return Keyring(
        settings.master_key_id,
        {
            **{
                key: bytes.fromhex(value.get_secret_value())
                for key, value in settings.previous_master_keys.items()
            },
            settings.master_key_id: bytes.fromhex(settings.master_key.get_secret_value()),
        },
        purpose=purpose,
    )


def version_dto(row: SecretVersion) -> dict[str, Any]:
    """密钥版本对外投影：暴露允许身份与撤销态，绝不回传 nonce 或密文字节；createdAt 使用 stamp 统一时间格式，便于契约测试。"""
    return {
        "secretRef": row.secret_ref,
        "versionId": row.id,
        "allowedIdentityIds": row.allowed_identity_ids,
        "revoked": row.revoked,
        "createdAt": stamp(row.created_at),
    }


class CredentialService:
    """工作区环境凭据管理服务：创建/轮换/撤销均要求 MANAGE_ENVIRONMENT 写权限；authorize 默认读权限，写接口显式 write=True。"""

    def __init__(self, session: AsyncSession, user: User, keyring: Keyring):
        """绑定当前会话用户与钥匙串，后续操作复用同一事务作用域；session/user/keyring 三元组在实例生命周期内不变。"""
        self.session, self.user, self.keyring = session, user, keyring

    async def authorize(self, scope: WorkspaceScope, write: bool = False) -> None:
        """要求调用方具备环境管理权限；写操作额外打开 Workspace 写锁语义；委托 WorkspaceRepository，统一成员与角色判定。"""
        await WorkspaceRepository(self.session, scope).authorize(
            self.user, Permission.MANAGE_ENVIRONMENT, write=write
        )

    async def create(
        self, scope: WorkspaceScope, secret_ref: str, data: dict[str, Any], *, new: bool
    ) -> dict[str, Any]:
        """新建引用或追加轮换版本：明文经 Keyring 封存后落库并写入审计，返回不含密文的 DTO；new=True 时禁止覆盖已有 secretRef，避免静默轮换。"""
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
        """逻辑撤销指定密钥版本：行级加锁后标记 revoked，后续 Attempt 解析将映射 409；行级 for_update，防止并发撤销与解析竞态。"""
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
