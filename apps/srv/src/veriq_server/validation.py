"""Use the existing canonical OpenAPI schemas at HTTP boundaries."""

import json
from functools import lru_cache
from pathlib import Path
from importlib.resources import files
from typing import Any, cast
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


@lru_cache
def api_document() -> dict[str, Any]:
    source = Path(__file__).resolve().parents[4] / "packages/contracts/openapi/platform.yaml"
    return cast(
        dict[str, Any],
        json.loads(
            source.read_text()
            if source.exists()
            else files("veriq_server").joinpath("_openapi.json").read_text()
        ),
    )


def validate_api(name: str, value: Any) -> None:
    doc = api_document()
    # External Id/Timestamp references keep the T01 validators and profile.
    schema_path = (
        Path(__file__).resolve().parents[4] / "packages/contracts/schemas/platform-v1.schema.json"
    )
    if schema_path.exists():
        canonical = json.loads(schema_path.read_text())
    else:
        canonical = json.loads(
            files("veriq_server").joinpath("_schemas/platform-v1.schema.json").read_text()
        )
    uri = "https://veriq.local/openapi/platform.yaml"
    registry: Registry[Any] = Registry().with_resources(
        [
            (
                uri,
                Resource.from_contents(
                    {"$schema": "https://json-schema.org/draft/2020-12/schema", **doc}
                ),
            ),
            (
                "https://veriq.local/schemas/platform-v1.schema.json",
                Resource.from_contents(canonical),
            ),
        ]
    )
    Draft202012Validator(
        {"$ref": uri + "#/components/schemas/" + name},
        registry=registry,
        format_checker=FormatChecker(),
    ).validate(value)
