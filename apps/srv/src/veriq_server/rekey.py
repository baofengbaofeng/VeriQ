"""
VeriQ 主密钥轮换生成保留完整历史环的私有新配置，再依据显式停机声明分批重新封装凭据和模型密钥。
版本身份与业务明文不变，任何解密失败都会回滚该批而不丢弃旧密钥。
"""

import json
from pathlib import Path
import secrets
from typing import Any

import sqlalchemy
from sqlalchemy.dialects import mysql
from sqlalchemy.sql import expression

from veriq_server import db as orm_db

from .credentials.crypto import EncryptedValue
from .credentials.service import configured_keyring
from .service import lock_installation
from .settings import Settings, operator_config_values
from .snapshot_io import private_file


def rotate_configuration(settings: Settings, output: Path, key_id: str) -> None:
    """
    生成新的外置配置并保留当前及历史密钥字节，拒绝复用已有标识或覆盖正在使用的配置。
    操作员切换到新配置后再重封装，命令不会打印新密钥或擅自替换服务配置文件。
    """
    if (
        not output.is_absolute()
        or key_id == settings.master_key_id
        or key_id in settings.previous_master_keys
    ):
        raise ValueError("ROTATION_NEW_ID_AND_ABSOLUTE_OUTPUT_REQUIRED")
    values = operator_config_values(settings.model_dump())
    values["previous_master_keys"][settings.master_key_id] = settings.master_key.get_secret_value()
    values["master_key_id"], values["master_key"] = key_id, secrets.token_hex(32)
    Settings.model_validate(values)
    private_file(output, (json.dumps(values, indent=2) + "\n").encode())


async def rekey(
    db: orm_db.Database, settings: Settings, *, services_stopped: bool, limit: int
) -> dict[str, Any]:
    """
    在安装锁下按有限批次解密旧密钥版本并用当前密钥重新封装，凭据与供应商的版本标识原样保留。
    完成后统计仍引用历史密钥的行数，只有两个表都为零才能考虑移除历史密钥。
    """
    if not services_stopped or not 1 <= limit <= 1000:
        raise ValueError("REKEY_QUIESCENCE_AND_BOUNDED_LIMIT_REQUIRED")
    processed = 0
    async with db.sessions.begin() as session:
        await lock_installation(session)
        # 候选与剩余行查询均按密钥标识的原始字节比较，使数据库排序规则不会合并密钥环中仅大小写不同的标识。
        for model, purpose in (
            (orm_db.SecretVersion, "veriq-credential-v1"),
            (orm_db.AiProvider, "veriq-ai-provider-v1"),
        ):
            if processed == limit:
                break
            # 查询只投影当前模型的完整实体，显式保留两个映射类型才能让取出的行携带各自的加密身份字段。
            statement: sqlalchemy.Select[tuple[orm_db.SecretVersion | orm_db.AiProvider]] = (
                sqlalchemy.select(model)
            )
            rows = list(
                (
                    await session.execute(
                        statement.where(
                            model.key_id.cast(mysql.BINARY)
                            != expression.literal(settings.master_key_id).cast(mysql.BINARY)
                        )
                        .order_by(model.id)
                        .limit(limit - processed)
                        .with_for_update()
                    )
                ).scalars()
            )
            ring = configured_keyring(settings, purpose=purpose)
            for row in rows:
                # 凭据行以引用和行号绑定密文，供应商行用行号和密钥版本绑定，按映射实体选取各自的标识。
                if isinstance(row, orm_db.SecretVersion):
                    reference, version = row.secret_ref, row.id
                else:
                    reference, version = row.id, row.key_version
                value = ring.decrypt(
                    row.workspace_id,
                    reference,
                    version,
                    EncryptedValue(row.key_id, row.nonce, row.ciphertext),
                )
                sealed = ring.encrypt(row.workspace_id, reference, version, value)
                row.key_id, row.nonce, row.ciphertext = (
                    sealed.key_id,
                    sealed.nonce,
                    sealed.ciphertext,
                )
                processed += 1
        await session.flush()
        pending = False
        for model in (orm_db.SecretVersion, orm_db.AiProvider):
            pending |= (
                await session.execute(
                    sqlalchemy.select(model.id)
                    .where(
                        model.key_id.cast(mysql.BINARY)
                        != expression.literal(settings.master_key_id).cast(mysql.BINARY)
                    )
                    .limit(1)
                )
            ).first() is not None
    return {"processedCount": processed, "hasMore": pending, "activeKeyId": settings.master_key_id}
