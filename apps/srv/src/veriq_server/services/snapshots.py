"""Server-frozen execution context; source compilation remains on Runtime."""

from typing import Any

from jsonschema import Draft202012Validator

from ..contracts import validate_schema
from ..service import Problem


def validate_initial_variables(declarations: dict[str, str], values: dict[str, Any]) -> None:
    """Same required own-key and JSON type semantics as resolveInitialVariables.

    Extra values are retained for compatibility, but the compiler/SDK only exposes
    declared names to the binding scope. jsonschema implements JSON integer rules
    (including integral floats) and does not mistake Python booleans for numbers.
    """
    schema = {
        "type": "object",
        "properties": {key: {"type": kind} for key, kind in declarations.items()},
        "required": list(declarations),
    }
    if validate_schema("JsonObject", values) or not Draft202012Validator(schema).is_valid(values):
        raise Problem(
            422, "INITIAL_VARIABLE_INVALID", "Initial variables do not match CASE declarations"
        )
