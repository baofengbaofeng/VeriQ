from typing import Any
from hashlib import sha256
from urllib.parse import urlsplit
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import WorkspaceScope
from ..contracts import canonical_bytes, validate_schema
from ..db import AuthAdapterVersion, SecretVersion
from ..service import Problem


def adapter_dto(row: AuthAdapterVersion) -> dict[str, Any]:
    """把认证适配器版本行投影为对外 DTO，只暴露配置哈希与内容而不泄露内部审计字段；供注册表冻结与 HTTP 列表共用，
    保持字段稳定。adapter_dto 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
    """
    return {
        "workspaceId": row.workspace_id,
        "versionId": row.id,
        "configuration": row.configuration,
        "contentHash": row.content_hash,
    }


def uses_browser_sso(role: dict[str, Any], adapters: list[dict[str, Any]]) -> bool:
    """按角色固定的适配器版本确定认证模式，同一环境内未选中的其他角色不参与当前证据和浏览器能力判断。"""
    return any(
        item["versionId"] == role["authAdapterVersionId"]
        and item["configuration"]["kind"] == "BROWSER_SSO"
        for item in adapters
    )


def _base_origin(url: str) -> str | None:
    """把业务页面和身份验证接口的基址还原为来源，保留非默认端口并拒绝包含用户信息的无效或不完整地址。"""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    hostname = parts.hostname
    if parts.scheme not in {"http", "https"} or not hostname or parts.username is not None:
        return None
    host = f"[{hostname}]" if ":" in hostname else hostname
    default_port = 443 if parts.scheme == "https" else 80
    suffix = f":{port}" if port is not None and port != default_port else ""
    return f"{parts.scheme}://{host}{suffix}"


def validate_browser_sso_scope(environment: dict[str, Any], adapters: list[dict[str, Any]]) -> None:
    """环境冻结和派单均复查浏览器身份站点，区分可获得账号密码的登录端与只接收回跳或会话的业务来源。"""
    fixture = environment.get("fixtureIdentity")
    if fixture and uses_browser_sso(fixture, adapters):
        raise Problem(422, "SSO_FIXTURE_UNSUPPORTED", "Fixture identity requires an HTTP adapter")
    identity_origins = {
        item["configuration"]["idpOrigin"]
        for item in adapters
        if item["configuration"]["kind"] == "BROWSER_SSO"
    }
    if not identity_origins:
        return
    business_origins = {
        _base_origin(environment["baseURL"]),
        _base_origin(environment["apiBaseURL"]),
    }
    allowed = set(environment["allowedOrigins"])
    if business_origins & identity_origins or not (business_origins | identity_origins) <= allowed:
        raise Problem(
            422,
            "SSO_ORIGIN_NOT_ALLOWED",
            "Browser SSO requires separate allowed application and identity origins",
        )


class IdentityRegistry:
    """发布前身份冻结注册表：校验适配器未撤销、密钥版本仍可用，并收紧 allowedIdentityIds；冻结顺序先适配器再密钥，
    降低死锁与竞态窗口。IdentityRegistry 触及凭证材料：管理面不得回传明文，

    日志与审计只能保留摘要或引用标识。
    """

    async def adapter(
        self, session: AsyncSession, scope: WorkspaceScope, version: str
    ) -> AuthAdapterVersion:
        """在当前 Workspace 锁定加载适配器版本，校验 Schema 与 content_hash 一致后返回行；revoked
        或哈希漂移都视为不可用，映射 422。
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
        """校验角色绑定的适配器与密钥版本均未撤销，且显式身份集合不超出密钥允许范围；allowedIdentityIds
        必须非空且为密钥允许集子集。require_role 触及凭证材料：管理面不得回传明文，

        日志与审计只能保留摘要或引用标识。
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
        # 调用方指定的身份子集必须包含于该密钥版本声明的允许集合，空集合或越界身份直接拒绝，禁止执行时扩大凭据作用域。
        if not allowed or not set(allowed) <= set(row.allowed_identity_ids):
            raise Problem(
                422,
                "IDENTITY_NOT_ALLOWED",
                "Explicit allowed identities must match credential scope",
            )

    async def freeze(
        self, session: AsyncSession, scope: WorkspaceScope, roles: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """按稳定顺序冻结 Attempt 身份引用，返回去重后的适配器快照供导出与解析共用；返回按 versionId
        排序的去重适配器快照列表。freeze 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
        """
        result = {}
        for version in sorted({role["authAdapterVersionId"] for role in roles}):
            await self.adapter(session, scope, version)
        for role in sorted(roles, key=lambda r: (r["secretRef"], r["secretVersionId"])):
            await self.require_role(session, scope, role)
            row = await self.adapter(session, scope, role["authAdapterVersionId"])
            result[row.id] = adapter_dto(row)
        return [result[key] for key in sorted(result)]
