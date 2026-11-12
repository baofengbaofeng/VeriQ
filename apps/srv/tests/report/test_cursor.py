
import importlib
from uuid import uuid4
import pytest
from veriq_server.service import Problem
from veriq_server.validation import validate_api


def test_cursor_roundtrip_at_admission_bound_and_rejects_foreign_or_future_positions():
    module = importlib.import_module("veriq_server.handlers.report")
    assert hasattr(module, "encode_cursor"), (
        "Cursor serialization needs an explicit bounded contract"
    )
    scope = {"workspaceId": str(uuid4()), "runId": str(uuid4()), "userId": str(uuid4())}
    positions = {str(uuid4()): 9007199254740991 for _ in range(2000)}
    token = module.encode_cursor("b" * 64, scope, positions)
    assert len(token) < 230000
    validate_api("ReportStreamRequest", {"cursor": token})
    assert module.decode_cursor("b" * 64, scope, token, positions) == positions
    for known in [{}, {**positions, next(iter(positions)): 0}]:
        with pytest.raises(Problem, match="Cursor"):
            module.decode_cursor("b" * 64, scope, token, known)
    with pytest.raises(Problem):
        module.decode_cursor("b" * 64, {**scope, "userId": str(uuid4())}, token, positions)


def test_current_gate_never_promotes_unmanaged_or_historical_unknown_execution():
    from veriq_server.services.gate import gate

    assert not gate("PASSED", None, current=True)["passed"]
    assert not gate(
        "PASSED", {"trustStatus": "USER_REGISTERED", "formalEligible": False}, current=True
    )["passed"]
    assert not gate("UNSTABLE", {"formalEligible": True}, current=True)["passed"]
