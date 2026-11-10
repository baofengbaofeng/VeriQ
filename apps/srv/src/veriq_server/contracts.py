"""Validate wire documents against the canonical, packaged JSON Schemas.

This module has no dependency on Node or the checkout at runtime.
"""

from __future__ import annotations

import json
import math
from functools import cache
from importlib.resources import files
from pathlib import Path
from typing import Any, TypedDict

from jsonschema import Draft202012Validator, FormatChecker

MAX_SAFE_INTEGER = 9_007_199_254_740_991


class ValidationIssue(TypedDict):
    path: str
    code: str
    message: str


@cache
def _schema() -> dict[str, Any]:
    resource = files("veriq_server").joinpath("_schemas/platform-v1.schema.json")
    if resource.is_file():
        return json.loads(resource.read_text(encoding="utf-8"))  # type: ignore[no-any-return]
    # Hatch editable installs expose src; wheels include the canonical directory.
    path = (
        Path(__file__).resolve().parents[4] / "packages/contracts/schemas/platform-v1.schema.json"
    )
    return json.loads(path.read_text(encoding="utf-8"))  # type: ignore[no-any-return]


@cache
def _validator(schema_name: str) -> Draft202012Validator:
    definitions = _schema()["$defs"]
    if schema_name not in definitions:
        raise ValueError(f"Unknown contract schema: {schema_name}")
    return Draft202012Validator(
        {"$ref": f"#/$defs/{schema_name}", "$defs": definitions}, format_checker=FormatChecker()
    )


def _pointer(parts: Any) -> str:
    return "".join("/" + str(part).replace("~", "~0").replace("/", "~1") for part in parts)


def _portable_json(value: Any, ancestors: set[int]) -> bool:
    if value is None or type(value) in (str, bool):
        return True
    if type(value) is int:
        return abs(value) <= MAX_SAFE_INTEGER
    if type(value) is float:
        return math.isfinite(value) and (not value.is_integer() or abs(value) <= MAX_SAFE_INTEGER)
    if type(value) not in (dict, list) or id(value) in ancestors:
        return False
    ancestors.add(id(value))
    try:
        if isinstance(value, dict):
            return all(
                type(key) is str and _portable_json(item, ancestors) for key, item in value.items()
            )
        return all(_portable_json(item, ancestors) for item in value)
    finally:
        ancestors.remove(id(value))


def validate_schema(schema_name: str, value: Any) -> list[ValidationIssue]:
    """Return issues (empty means valid); unknown schema names raise ValueError."""
    validator = _validator(schema_name)
    if not _portable_json(value, set()):
        return [
            {"path": "", "code": "INVALID_JSON", "message": "Expected finite, portable JSON values"}
        ]
    return [
        {
            "path": _pointer(error.absolute_path),
            "code": "SCHEMA_VIOLATION",
            "message": error.message,
        }
        for error in sorted(
            validator.iter_errors(value), key=lambda error: _pointer(error.absolute_path)
        )
    ]


def validate_case_schema(value: Any) -> list[ValidationIssue]:
    return validate_schema("CaseDslV1", value)


def serialize_contract(schema_name: str, value: Any) -> str:
    """Validate and emit compact UTF-8 JSON text; this is not a signing canonicalizer."""
    issues = validate_schema(schema_name, value)
    if issues:
        raise ValueError(issues)
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def parse_contract(schema_name: str, text: str) -> Any:
    def reject_constant(constant: str) -> None:
        raise ValueError(f"Non-JSON constant: {constant}")

    value = json.loads(text, parse_constant=reject_constant)
    issues = validate_schema(schema_name, value)
    if issues:
        raise ValueError(issues)
    return value
