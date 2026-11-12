import pytest
from veriq_server.services.completion import retry_is_safe


@pytest.mark.parametrize(
    "declared,observed,fixture,cleanup,safe",
    [
        (False, "READ_ONLY_OBSERVED", False, "NOT_REQUIRED", True),
        (True, "READ_ONLY_OBSERVED", False, "NOT_REQUIRED", False),
        (False, "WRITE_POSSIBLE", False, "NOT_REQUIRED", False),
        (False, "UNKNOWN", False, "NOT_REQUIRED", False),
        (None, "READ_ONLY_OBSERVED", False, "NOT_REQUIRED", False),
        (False, None, False, "NOT_REQUIRED", False),
        (True, "WRITE_POSSIBLE", False, "SUCCEEDED", False),
        (True, "WRITE_POSSIBLE", True, "SUCCEEDED", True),
        (None, None, True, "SUCCEEDED", True),
        (True, "WRITE_POSSIBLE", True, "FAILED", False),
    ],
)
def test_retry_requires_approved_read_only_observation_or_real_declared_fixture_closure(
    declared, observed, fixture, cleanup, safe
):
    assert retry_is_safe(declared, observed, fixture, cleanup) is safe


def test_canonical_cancelled_step_preserves_existing_failure_priority():
    from veriq_server.services.results import reduce_test

    plan = {
        "steps": [
            {
                "id": "request",
                "order": 0,
                "failurePolicy": "STOP",
                "assertions": [],
                "observers": [],
            }
        ]
    }
    events = [
        {"type": "ATTEMPT_STARTED", "payload": {}},
        {"type": "STEP_STARTED", "stepId": "request", "payload": {}},
        {
            "type": "STEP_FINISHED",
            "stepId": "request",
            "payload": {"status": "CANCELLED", "errorCode": "CANCELLED"},
        },
        {"type": "CLEANUP_RESULT", "payload": {"cleanupStatus": "NOT_REQUIRED"}},
        {
            "type": "ATTEMPT_FINISHED",
            "payload": {"outcome": "CANCELLED", "cleanupStatus": "NOT_REQUIRED"},
        },
    ]
    manifest = {"businessOutcome": "CANCELLED", "cleanupStatus": "NOT_REQUIRED"}
    assert (
        reduce_test(plan, events, manifest, evidence_complete=True, cancel_requested=True)[
            "outcome"
        ]
        == "CANCELLED"
    )
    events[2]["payload"] = {"status": "FAILED", "errorCode": "ACTION_FAILED"}
    result = reduce_test(plan, events, manifest, evidence_complete=True, cancel_requested=True)
    assert result["outcome"] != "CANCELLED"
    assert "FAILED" in result["stepOutcomes"]
