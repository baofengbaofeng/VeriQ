"""从当前工作区和连接批准的版本读取认证材料，发布检查只验证可用性，只有授权的实际读取才解封密文。"""

from cryptography.exceptions import InvalidTag
from sqlalchemy import select

from ..credentials.crypto import EncryptedValue
from ..credentials.service import configured_keyring
from ..db import SecretVersion
from .policy import bind_connection, unavailable


async def authorize_dataset(
    session,
    settings,
    workspace_id,
    user_id,
    environment_id,
    dataset,
    *,
    resolve=False,
    service_account=False,
):
    """复核连接、人员、密钥和批准身份的一致性，凭证撤销后预览和执行都无法凭历史草稿继续读取。"""
    bound = bind_connection(
        settings.dataset_connections if settings else {},
        workspace_id,
        user_id,
        environment_id,
        dataset,
        service_account=service_account,
    )
    auth = dataset["source"]["auth"]
    material = {}
    if auth["kind"] != "NONE":
        key = (auth["secretRef"], auth["secretVersionId"])
        # 同一 SELECT 固定工作区、引用与版本，并读取当前撤销状态，杜绝从另一个工作区借用同名密钥或旧会话值。
        row = (
            await session.scalars(
                select(SecretVersion)
                .where(
                    SecretVersion.workspace_id == workspace_id,
                    SecretVersion.secret_ref == key[0],
                    SecretVersion.id == key[1],
                    SecretVersion.revoked.is_(False),
                )
                .execution_options(populate_existing=True)
            )
        ).one_or_none()
        if row is None or bound.connection.identity_id not in row.allowed_identity_ids:
            raise unavailable()
        # 发布与交付时的复核都只需要确认版本可用；只有真正构造出站请求的首次授权会把密文解封到内存。
        if resolve:
            try:
                value = configured_keyring(settings).decrypt(
                    workspace_id, *key, EncryptedValue(row.key_id, row.nonce, row.ciphertext)
                )
            except (ValueError, InvalidTag):
                raise unavailable() from None
            if not isinstance(value, dict) or (
                auth["kind"] != "BASIC" and type(value.get("value")) is not str
            ):
                raise unavailable()
            material[key] = value if auth["kind"] == "BASIC" else value["value"]

    def secret(ref, version_id):
        if (ref, version_id) not in material:
            raise unavailable()
        return material[ref, version_id]

    return bound, secret
