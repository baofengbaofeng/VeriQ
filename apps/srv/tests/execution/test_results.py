import importlib
import pytest


def reducer():
    try:
        return importlib.import_module("veriq_server.services.results").reduce_test
    except ModuleNotFoundError:
        pytest.fail("Server is missing trusted expected-plan completion reduction")


def event(kind, payload, **extra):
    return {"type": kind, "payload": payload, **extra}


def test_exit_claim_cannot_create_pass_without_expected_events():
    plan = {
        "steps": [
            {
                "id": "save",
                "order": 0,
                "failurePolicy": "STOP",
                "assertions": [{"id": "persisted", "severity": "BLOCK", "stage": "AFTER"}],
                "observers": [],
            }
        ]
    }
    manifest = {"businessOutcome": "PASSED", "cleanupStatus": "NOT_REQUIRED"}
    reduce = reducer()
    assert reduce(plan, [], manifest, evidence_complete=True)["outcome"] == "INCOMPLETE"
    events = [
        event("ATTEMPT_STARTED", {}),
        event("STEP_STARTED", {}, stepId="save"),
        event("STEP_FINISHED", {"status": "PASSED"}, stepId="save"),
        event(
            "ASSERTION_RESULT",
            {"status": "PASSED", "severity": "BLOCK"},
            stepId="save",
            assertionId="persisted",
        ),
        event("CLEANUP_RESULT", {"cleanupStatus": "NOT_REQUIRED"}),
        event("ATTEMPT_FINISHED", {"outcome": "PASSED", "cleanupStatus": "NOT_REQUIRED"}),
    ]
    assert reduce(plan, events, manifest, evidence_complete=True)["outcome"] == "PASSED"
    assert reduce(plan, events, manifest, evidence_complete=False)["outcome"] == "INCOMPLETE"
    assert (
        reduce(plan, events, {**manifest, "cleanupStatus": "FAILED"}, evidence_complete=False)[
            "outcome"
        ]
        == "ERROR"
    )
    assert (
        reduce({"steps": []}, events, manifest, evidence_complete=True)["outcome"] == "INCOMPLETE"
    )


def test_blocked_dependent_skip_requires_actual_prior_block_failure():
    plan = {
        "steps": [
            {
                "id": "first",
                "order": 0,
                "failurePolicy": "STOP",
                "assertions": [{"id": "gate", "severity": "BLOCK", "stage": "AFTER"}],
                "observers": [],
            },
            {
                "id": "dependent",
                "order": 1,
                "failurePolicy": "STOP",
                "assertions": [{"id": "later", "severity": "BLOCK", "stage": "AFTER"}],
                "observers": [],
            },
        ]
    }
    manifest = {"businessOutcome": "FAILED", "cleanupStatus": "NOT_REQUIRED"}
    events = [
        event("ATTEMPT_STARTED", {}),
        event("STEP_STARTED", {}, stepId="first"),
        event(
            "ASSERTION_RESULT",
            {"status": "FAILED", "severity": "BLOCK"},
            stepId="first",
            assertionId="gate",
        ),
        event("STEP_FINISHED", {"status": "FAILED"}, stepId="first"),
        event(
            "STEP_FINISHED",
            {"status": "SKIPPED", "blockedByStepId": "first", "blockedByAssertionId": "gate"},
            stepId="dependent",
        ),
        event("CLEANUP_RESULT", {"cleanupStatus": "NOT_REQUIRED"}),
        event("ATTEMPT_FINISHED", {"outcome": "FAILED", "cleanupStatus": "NOT_REQUIRED"}),
    ]
    assert reducer()(plan, events, manifest, evidence_complete=True)["outcome"] == "FAILED"
    assert (
        reducer()(
            plan,
            [e for e in events if e.get("stepId") != "dependent"],
            manifest,
            evidence_complete=True,
        )["outcome"]
        == "INCOMPLETE"
    )
    events[4]["payload"]["blockedByAssertionId"] = "invented"
    assert reducer()(plan, events, manifest, evidence_complete=True)["outcome"] == "INCOMPLETE"
