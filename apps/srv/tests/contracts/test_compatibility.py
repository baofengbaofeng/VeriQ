"""Shared behavior cases must agree with the Node validator."""

import importlib
import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
FIXTURES = json.loads((ROOT / "packages/contracts/fixtures/compatibility.json").read_text())


def contracts():
    assert importlib.util.find_spec("veriq_server.contracts") is not None, (
        "Missing shared schema validation implementation"
    )
    return importlib.import_module("veriq_server.contracts")


@pytest.mark.parametrize("sample", FIXTURES, ids=lambda sample: sample["name"])
def test_shared_fixture(sample):
    issues = contracts().validate_schema(sample["schema"], sample["value"])
    assert (issues == []) is sample["valid"], issues


def test_case_interface():
    validator = contracts()
    valid = FIXTURES[0]["value"]
    invalid = next(x["value"] for x in FIXTURES if x["name"] == "unknown-action")
    assert validator.validate_case_schema(valid) == []
    assert validator.validate_case_schema(invalid)


def test_literal_evidence_is_distinct_from_interpolated_dsl():
    validator = contracts()
    observed = {"present": True, "value": {"text": "{{customer.name}}"}}
    assert (
        validator.parse_contract(
            "ActualValueV1", validator.serialize_contract("ActualValueV1", observed)
        )
        == observed
    )
    assert validator.validate_schema(
        "StepV1", {"id": "fill", "action": "fill", "target": "input", "value": "{{evil()}}"}
    )


def test_python_and_node_agree():
    validator = contracts()
    expected = [
        {"name": row["name"], "valid": not validator.validate_schema(row["schema"], row["value"])}
        for row in FIXTURES
    ]
    result = subprocess.run(
        [
            "node",
            "--import",
            "./packages/contracts/node_modules/tsx/dist/loader.mjs",
            "packages/contracts/tests/validate-fixtures.ts",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(result.stdout) == expected


@pytest.mark.parametrize(
    "value",
    [
        float("nan"),
        float("inf"),
        {"n": float("-inf")},
        {"n": 2**53},
        10**1000,
        (1, 2),
        {1: "value"},
    ],
)
def test_nonportable_json_rejected(value):
    assert contracts().validate_schema("JsonValue", value)


def test_cycles_are_rejected():
    value = []
    value.append(value)
    assert contracts().validate_schema("JsonValue", value)


def test_real_serialization():
    validator = contracts()
    value = FIXTURES[0]["value"]
    encoded = validator.serialize_contract("CaseDslV1", value)
    assert validator.parse_contract("CaseDslV1", encoded) == value
    with pytest.raises(ValueError):
        validator.parse_contract("CaseDslV1", '{"schemaVersion":"1.0","number":NaN}')
    with pytest.raises(ValueError):
        validator.serialize_contract("CaseDslV1", {"action": "evaluate"})


def test_all_schemas_are_valid():
    from jsonschema import Draft202012Validator

    paths = list((ROOT / "packages/contracts/schemas").glob("*.schema.json"))
    assert paths, "Missing shared JSON Schemas"
    for path in paths:
        Draft202012Validator.check_schema(json.loads(path.read_text()))
