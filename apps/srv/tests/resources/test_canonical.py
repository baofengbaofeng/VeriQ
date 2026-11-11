import json
from pathlib import Path
from veriq_server import contracts


def test_jcs_vectors():
    canonical = getattr(contracts, "canonical_bytes", None)
    assert callable(canonical), "JCS source identity is not implemented"
    for vector in json.loads(Path("packages/contracts/fixtures/canonical.json").read_text()):
        assert canonical(vector["value"]).decode() == vector["canonical"]


def test_source_identity_matches_shared_hash_and_excludes_transient_target():
    source = json.loads(Path("packages/contracts/fixtures/asset-source.json").read_text())
    snapshot = source["snapshot"]
    assert contracts.asset_source_hash(snapshot) == source["sha256"]
    snapshot.pop("validationTarget")
    snapshot["sourceHash"] = "0" * 64
    assert contracts.asset_source_hash(snapshot) == source["sha256"]
    snapshot["engineVersion"] = "9.0.0"
    assert contracts.asset_source_hash(snapshot) != source["sha256"]


def test_identity_registry_projection_matches_shared_hash():
    vector = json.loads(Path("packages/contracts/fixtures/identity-source.json").read_text())
    assert contracts.asset_source_hash(vector["snapshot"]) == vector["sha256"]
    vector["snapshot"]["authAdapters"].reverse()
    assert contracts.asset_source_hash(vector["snapshot"]) == vector["sha256"]
    vector["snapshot"]["authAdapters"][0]["configuration"]["identityPath"] = "/changed"
    assert contracts.asset_source_hash(vector["snapshot"]) != vector["sha256"]
