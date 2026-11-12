import base64
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from veriq_server.bundles.issuer import Issuer
from veriq_server.service import Problem


def test_persistent_issuer_rotation_and_monotonic_revocation(tmp_path):
    path = tmp_path / "private" / "issuer.json"
    issuer = Issuer.initialize(path)
    old = issuer.public()
    raw = b'{"exact": "bytes"}\n'
    signature = issuer.sign(raw)
    restarted = Issuer(path)
    assert restarted.public() == old and restarted.sign(raw) == signature
    restarted.rotate()
    rotated = Issuer(path)
    assert rotated.public()["issuerId"] == old["issuerId"]
    assert len(rotated.public()["keys"]) == 2
    Ed25519PublicKey.from_public_bytes(base64.b64decode(old["keys"][0]["publicKey"])).verify(
        signature, raw
    )
    rotated.revoke(old["keys"][0]["keyId"])
    assert Issuer(path).public()["keys"][0]["revoked"] is True
    assert path.stat().st_mode & 0o077 == 0
    assert path.parent.stat().st_mode & 0o077 == 0
    with pytest.raises(FileExistsError):
        Issuer.initialize(path)
    with pytest.raises(ValueError):
        rotated.revoke(rotated.data["activeKeyId"])


def test_issuer_missing_or_unsafe_key_never_falls_back_to_cookie_key(tmp_path):
    with pytest.raises(Problem) as absent:
        Issuer(None)
    assert absent.value.code == "ISSUER_UNAVAILABLE"
    path = tmp_path / "private" / "issuer.json"
    Issuer.initialize(path)
    path.chmod(0o644)
    with pytest.raises(Problem):
        Issuer(path)
    path.chmod(0o600)
    linked = tmp_path / "linked"
    linked.symlink_to(path)
    with pytest.raises(Problem):
        Issuer(linked)
