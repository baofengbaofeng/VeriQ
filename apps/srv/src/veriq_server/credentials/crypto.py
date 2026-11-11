"""Version-bound authenticated encryption using externally configured AES keys."""

from dataclasses import dataclass
import json
import os
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..contracts import canonical_bytes


@dataclass(frozen=True)
class EncryptedValue:
    key_id: str
    nonce: bytes
    ciphertext: bytes


class Keyring:
    def __init__(
        self, active_key_id: str, keys: dict[str, bytes], *, purpose: str = "veriq-credential-v1"
    ):
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
        nonce = os.urandom(12)
        ciphertext = AESGCM(self._keys[self.active_key_id]).encrypt(
            nonce, canonical_bytes(value), self._aad(workspace_id, secret_ref, version_id)
        )
        return EncryptedValue(self.active_key_id, nonce, ciphertext)

    def decrypt(
        self, workspace_id: str, secret_ref: str, version_id: str, value: EncryptedValue
    ) -> Any:
        key = self._keys.get(value.key_id)
        if key is None:
            raise ValueError("KEY_UNAVAILABLE")
        return json.loads(
            AESGCM(key).decrypt(
                value.nonce, value.ciphertext, self._aad(workspace_id, secret_ref, version_id)
            )
        )
