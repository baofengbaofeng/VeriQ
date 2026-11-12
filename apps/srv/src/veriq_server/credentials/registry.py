from typing import Any
from hashlib import sha256
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import WorkspaceScope
from ..contracts import canonical_bytes, validate_schema
from ..db import AuthAdapterVersion, SecretVersion
from ..service import Problem


def adapter_dto(row: AuthAdapterVersion) -> dict[str, Any]:
    """把认证适配器版本行投影为对外 DTO，只暴露配置哈希与内容而不泄露内部审计字段；供注册表冻结与 HTTP 列表共用，保持字段稳定。
    adapter_dto 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
    """
    return {
        "workspaceId": row.workspace_id,
        "versionId": row.id,
        "configuration": row.configuration,
        "contentHash": row.content_hash,
    }


class IdentityRegistry:
    """发布前身份冻结注册表：校验适配器未撤销、密钥版本仍可用，并收紧 allowedIdentityIds；冻结顺序先适配器再密钥，降低死锁与竞态窗口。
    IdentityRegistry 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
    """

    async def adapter(
        self, session: AsyncSession, scope: WorkspaceScope, version: str
    ) -> AuthAdapterVersion:
        """在当前 Workspace 锁定加载适配器版本，校验 Schema 与 content_hash 一致后返回行；revoked 或哈希漂移都视为不可用，映射 422。
        adapter 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
        """
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
        """校验角色绑定的适配器与密钥版本均未撤销，且显式身份集合不超出密钥允许范围；allowedIdentityIds 必须非空且为密钥允许集子集。
        require_role 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
        """
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
        # 身份子集必须落在密钥版本声明的允许集合内，禁止运行时扩权。
        if not allowed or not set(allowed) <= set(row.allowed_identity_ids):
            raise Problem(
                422,
                "IDENTITY_NOT_ALLOWED",
                "Explicit allowed identities must match credential scope",
            )

    async def freeze(
        self, session: AsyncSession, scope: WorkspaceScope, roles: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """按稳定顺序冻结 Attempt 身份引用，返回去重后的适配器快照供导出与解析共用；返回按 versionId 排序的去重适配器快照列表。
        freeze 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
        """
        result = {}
        for version in sorted({role["authAdapterVersionId"] for role in roles}):
            await self.adapter(session, scope, version)
        for role in sorted(roles, key=lambda r: (r["secretRef"], r["secretVersionId"])):
            await self.require_role(session, scope, role)
            row = await self.adapter(session, scope, role["authAdapterVersionId"])
            result[row.id] = adapter_dto(row)
        return [result[key] for key in sorted(result)]
