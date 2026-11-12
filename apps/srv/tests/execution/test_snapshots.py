
import importlib
import pytest
from veriq_server.service import Problem


def validator():
    try:
        module = importlib.import_module("veriq_server.services.snapshots")
    except ModuleNotFoundError:
        pytest.fail("Run admission is missing frozen initial-variable validation")
    return module.validate_initial_variables


def test_frozen_initial_variables_require_presence_and_distinguish_bool_from_number():
    check = validator()
    for declaration, values in [
        ({"count": "integer"}, {}),
        ({"count": "integer"}, {"count": True}),
        ({"count": "integer"}, {"count": 1.5}),
        ({"x": "null"}, {}),
    ]:
        with pytest.raises(Problem) as error:
            check(declaration, values)
        assert error.value.code == "INITIAL_VARIABLE_INVALID"
    check({"count": "number", "nullable": "null"}, {"count": 1, "nullable": None, "extra": {}})
    check({"count": "integer"}, {"count": 1.0})
