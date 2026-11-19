from importlib import import_module

import pytest
from cryptography.exceptions import InvalidTag


def keyring():
    module = import_module("veriq_server.credentials.crypto")
    return module.Keyring("current", {"current": bytes.fromhex("ab" * 32)})


def test_encrypted_value_roundtrip_random_nonce_and_bound_identity():
    ring = keyring()
    value = {"password": "synthetic-protected-password", "username": "demo"}
    first = ring.encrypt("workspace-a", "business", "version-a", value)
    second = ring.encrypt("workspace-a", "business", "version-a", value)
    assert first.ciphertext != second.ciphertext
    assert b"synthetic-protected-password" not in first.ciphertext
    assert ring.decrypt("workspace-a", "business", "version-a", first) == value
    for identity in [
        ("workspace-b", "business", "version-a"),
        ("workspace-a", "fixture", "version-a"),
        ("workspace-a", "business", "version-b"),
    ]:
        with pytest.raises(InvalidTag):
            ring.decrypt(*identity, first)


def test_key_rotation_preserves_old_key_reads_and_uses_active_key():
    old = keyring()
    encrypted = old.encrypt("ws", "ref", "version", {"token": "synthetic"})
    module = import_module("veriq_server.credentials.crypto")
    rotated = module.Keyring(
        "next", {"current": bytes.fromhex("ab" * 32), "next": bytes.fromhex("cd" * 32)}
    )
    assert rotated.decrypt("ws", "ref", "version", encrypted) == {"token": "synthetic"}
    replacement = rotated.encrypt(
        "ws", "ref", "version", rotated.decrypt("ws", "ref", "version", encrypted)
    )
    assert replacement.key_id == "next"
    assert rotated.decrypt("ws", "ref", "version", replacement) == {"token": "synthetic"}
    with pytest.raises(ValueError, match="KEY_UNAVAILABLE"):
        module.Keyring("next", {"next": bytes.fromhex("cd" * 32)}).decrypt(
            "ws", "ref", "version", encrypted
        )
