import copy
import json
from pathlib import Path
from veriq_server.contracts import validate_schema

FIXTURES = json.loads(Path("packages/contracts/fixtures/compatibility.json").read_text())


def example(schema):
    return copy.deepcopy(next(x["value"] for x in FIXTURES if x["schema"] == schema and x["valid"]))


def test_noncase_validation_requires_explicit_target():
    value = example("AssetSnapshotV1")
    value["entryCaseVersionIds"] = []
    assert validate_schema("AssetSnapshotV1", value)
    value["validationTarget"] = {
        "resourceId": value["assets"][0]["resourceId"],
        "versionId": value["assets"][0]["versionId"],
        "revision": 1,
    }
    assert not validate_schema("AssetSnapshotV1", value)
