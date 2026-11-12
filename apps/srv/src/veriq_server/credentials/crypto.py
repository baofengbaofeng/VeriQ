from dataclasses import dataclass
import json
import os
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..contracts import canonical_bytes


@dataclass(frozen=True)
class EncryptedValue:
    """已封存的密钥材料元组：记录所用 key_id、随机 nonce 以及 AES-GCM 密文本体；三字段足够重建 AESGCM.decrypt 所需全部材料。"""

    key_id: str
    nonce: bytes
    ciphertext: bytes


class Keyring:
    """工作区凭据 AES-GCM 钥匙串：用 purpose 与引用路径构造 AAD，支持活跃密钥与历史密钥解密；purpose 进入 AAD，防止跨用途密文被误解密。"""

    def __init__(
        self, active_key_id: str, keys: dict[str, bytes], *, purpose: str = "veriq-credential-v1"
    ):
        """装载 32 字节主密钥映射并锁定当前写入用 active_key_id；密钥长度不符则拒绝初始化；active_key_id 必须存在于 keys，且每把密钥恰 32 字节。"""
        self.purpose = purpose
        if active_key_id not in keys or any(len(key) != 32 for key in keys.values()):
            raise ValueError("INVALID_KEYRING")
        self.active_key_id = active_key_id
        self._keys = dict(keys)

    def _aad(self, workspace_id: str, secret_ref: str, version_id: str) -> bytes:
        return canonical_bytes([self.purpose, workspace_id, secret_ref, version_id])

    def encrypt(
        self, workspace_id: str, secret_ref: str, version_id: str, value: Any
    ) -> EncryptedValue:
        """将可移植 JSON 明文用活跃密钥加密，AAD 绑定 Workspace 与 secret 版本路径防串改；nonce 每调一用，12 字节随机，满足 GCM 唯一性要求。"""
        nonce = os.urandom(12)
        ciphertext = AESGCM(self._keys[self.active_key_id]).encrypt(
            nonce, canonical_bytes(value), self._aad(workspace_id, secret_ref, version_id)
        )
        return EncryptedValue(self.active_key_id, nonce, ciphertext)

    def decrypt(
        self, workspace_id: str, secret_ref: str, version_id: str, value: EncryptedValue
    ) -> Any:
        """按密文携带的 key_id 选择历史或活跃密钥解密；密钥缺失映射 KEY_UNAVAILABLE；json.loads 还原规范化明文，失败向上抛出加密库异常。"""
        key = self._keys.get(value.key_id)
        if key is None:
            raise ValueError("KEY_UNAVAILABLE")
        return json.loads(
            AESGCM(key).decrypt(
                value.nonce, value.ciphertext, self._aad(workspace_id, secret_ref, version_id)
            )
        )
