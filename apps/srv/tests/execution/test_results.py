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
        event(
            "ASSERTION_RESULT",
            {"status": "PASSED", "severity": "BLOCK"},
            stepId="save",
            assertionId="persisted",
        ),
        event("STEP_FINISHED", {"status": "PASSED"}, stepId="save"),
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


def canonical_case(plan, events, business="PASSED"):
    """Schema-valid producer facts; evidence_complete is the upload verifier precondition."""
    from veriq_server.contracts import validate_schema

    uid = "11111111-1111-4111-8111-111111111111"
    expected = {"caseVersionId": uid, "requiredEvidenceKinds": ["TRACE"], "steps": plan}
    manifest = {
        "schemaVersion": "1.0",
        "kind": "TEST",
        "attemptId": uid,
        "jobManifestSha256": "a" * 64,
        "caseVersionId": uid,
        "expectedPlansSha256": "b" * 64,
        "businessOutcome": business,
        "cleanupStatus": "NOT_REQUIRED",
        "evidence": [],
        "requiredEvidence": [],
        "processStopped": True,
    }
    canonical = [
        {
            "schemaVersion": "1.0",
            "attemptId": uid,
            "sequence": i,
            "timestamp": "2026-11-11T12:00:00Z",
            **e,
        }
        for i, e in enumerate(events, 1)
    ]
    assert not validate_schema("ExpectedPlansV1", {"schemaVersion": "1.0", "cases": [expected]})
    assert not validate_schema("CompletionManifestV1", manifest)
    for entry in canonical:
        assert not validate_schema("ExecutionEventV1", entry), entry
    return reducer()(expected, canonical, manifest, evidence_complete=True)


def expected_step(sid="save", order=0, **extra):
    return {
        "id": sid,
        "order": order,
        "failurePolicy": "STOP",
        "assertions": [],
        "observers": [],
        **extra,
    }


def began():
    return event("ATTEMPT_STARTED", {"engineVersion": "0.1.0", "sourceHash": "c" * 64})


def finished(outcome="PASSED"):
    return event("ATTEMPT_FINISHED", {"outcome": outcome, "cleanupStatus": "NOT_REQUIRED"})


def step_end(sid="save", status="PASSED", **proof):
    return event("STEP_FINISHED", {"status": status, "durationMs": 1, **proof}, stepId=sid)


def cleanup_event():
    return event("CLEANUP_RESULT", {"cleanupStatus": "NOT_REQUIRED"})


@pytest.mark.parametrize("business", ["FAILED", "ERROR", "INCOMPLETE", "CANCELLED", "SKIPPED"])
def test_post_step_business_failure_is_never_reduced_to_pass(business):
    # SDK origin enforcement can fail after every step passed.
    result = canonical_case(
        [expected_step()],
        [
            began(),
            event("STEP_STARTED", {}, stepId="save"),
            step_end(),
            cleanup_event(),
            finished(business),
        ],
        business,
    )
    assert result["outcome"] == business and result["business"] == business


@pytest.mark.parametrize(
    "business, terminal, outcome",
    [
        ("PASSED", "FAILED", "INCOMPLETE"),
        ("FAILED", "PASSED", "INCOMPLETE"),
        ("PASSED", "ERROR", "ERROR"),
    ],
)
def test_conflicting_terminal_facts_preserve_negative_outcomes(business, terminal, outcome):
    result = canonical_case(
        [expected_step()],
        [
            began(),
            event("STEP_STARTED", {}, stepId="save"),
            step_end(),
            cleanup_event(),
            finished(terminal),
        ],
        business,
    )
    assert result["outcome"] == outcome and result["evidence"] == "INCOMPLETE"


def test_terminal_before_business_work_cannot_be_complete():
    result = canonical_case(
        [expected_step()],
        [
            began(),
            finished(),
            event("STEP_STARTED", {}, stepId="save"),
            step_end(),
            cleanup_event(),
        ],
    )
    assert result["outcome"] == "INCOMPLETE" and result["evidence"] == "INCOMPLETE"


@pytest.mark.parametrize(
    "ordering", ["nested", "child_before_parent", "child_after_parent", "later_sibling_first"]
)
def test_nested_step_intervals_and_declared_sibling_order(ordering):
    plan = [
        expected_step("parent", 0),
        expected_step("child", 1, parentId="parent"),
        expected_step("later", 2),
    ]

    def start(sid):
        return event("STEP_STARTED", {}, stepId=sid)

    body = [
        start("parent"),
        start("child"),
        step_end("child"),
        step_end("parent"),
        start("later"),
        step_end("later"),
    ]
    if ordering == "child_before_parent":
        body[0], body[1] = body[1], body[0]
    elif ordering == "child_after_parent":
        body[2], body[3] = body[3], body[2]
    elif ordering == "later_sibling_first":
        body = body[-2:] + body[:-2]
    result = canonical_case(plan, [began(), *body, cleanup_event(), finished()])
    assert result["outcome"] == ("PASSED" if ordering == "nested" else "INCOMPLETE")


def test_post_terminal_artifact_and_log_tail_is_explicitly_allowed():
    artifact = event(
        "ARTIFACT_CREATED",
        {
            "artifactId": "22222222-2222-4222-8222-222222222222",
            "file": {
                "path": "trace.zip",
                "sha256": "d" * 64,
                "sizeBytes": 1,
                "sensitivity": "REDACTED",
            },
            "kind": "TRACE",
        },
    )
    log = event("LOG", {"level": "INFO", "message": "upload complete"})
    result = canonical_case(
        [expected_step()],
        [
            began(),
            event("STEP_STARTED", {}, stepId="save"),
            step_end(),
            cleanup_event(),
            finished(),
            artifact,
            log,
        ],
    )
    assert result["outcome"] == "PASSED"


def assertion_event(aid, status="PASSED", sid="save", **proof):
    return event(
        "ASSERTION_RESULT",
        {
            "status": status,
            "severity": "BLOCK",
            "expectedSource": "REQ-1",
            "expected": True,
            "actual": {"present": True, "value": status == "PASSED"},
            "durationMs": 1,
            **proof,
        },
        stepId=sid,
        assertionId=aid,
    )


@pytest.mark.parametrize("stage", ["BEFORE", "RESPONSE"])
@pytest.mark.parametrize("proof_kind", ["valid", "forged", "reversed"])
def test_same_step_block_proves_later_after_skip(stage, proof_kind):
    plan = [
        expected_step(
            assertions=[
                {"id": "gate", "severity": "BLOCK", "stage": stage},
                {"id": "after", "severity": "BLOCK", "stage": "AFTER"},
            ]
        )
    ]
    failed = assertion_event("gate", "FAILED")
    skipped = assertion_event(
        "after",
        "SKIPPED",
        blockedByStepId="save",
        blockedByAssertionId="gate" if proof_kind != "forged" else "invented",
    )
    facts = [failed, skipped] if proof_kind != "reversed" else [skipped, failed]
    result = canonical_case(
        plan,
        [
            began(),
            event("STEP_STARTED", {}, stepId="save"),
            *facts,
            step_end(status="FAILED"),
            cleanup_event(),
            finished("FAILED"),
        ],
        "FAILED",
    )
    assert result["outcome"] == ("FAILED" if proof_kind == "valid" else "INCOMPLETE")
    assert result["evidence"] == ("COMPLETE" if proof_kind == "valid" else "INCOMPLETE")


@pytest.mark.parametrize("proof", [True, False])
def test_observer_block_is_recorded_only_with_explicit_step_failure_proof(proof):
    plan = [
        expected_step(
            assertions=[{"id": "gate", "severity": "BLOCK", "stage": "BEFORE"}],
            observers=["network"],
        )
    ]
    finish = step_end(
        status="FAILED",
        **({"blockedByStepId": "save", "blockedByAssertionId": "gate"} if proof else {}),
    )
    result = canonical_case(
        plan,
        [
            began(),
            event("STEP_STARTED", {}, stepId="save"),
            assertion_event("gate", "FAILED"),
            finish,
            cleanup_event(),
            finished("FAILED"),
        ],
        "FAILED",
    )
    assert result["outcome"] == ("FAILED" if proof else "INCOMPLETE")
    assert result.get("blockedObservers", []) == (
        [
            {
                "stepId": "save",
                "observerId": "network",
                "blockedByStepId": "save",
                "blockedByAssertionId": "gate",
            }
        ]
        if proof
        else []
    )


@pytest.mark.parametrize("stage", ["BEFORE", "AFTER"])
def test_only_ancestor_before_block_can_prevent_child_work(stage):
    plan = [
        expected_step(
            "parent", 0, assertions=[{"id": "gate", "severity": "BLOCK", "stage": stage}]
        ),
        expected_step("child", 1, parentId="parent"),
    ]
    result = canonical_case(
        plan,
        [
            began(),
            event("STEP_STARTED", {}, stepId="parent"),
            assertion_event("gate", "FAILED", "parent"),
            step_end("child", "SKIPPED", blockedByStepId="parent", blockedByAssertionId="gate"),
            step_end("parent", "FAILED"),
            cleanup_event(),
            finished("FAILED"),
        ],
        "FAILED",
    )
    assert result["outcome"] == ("FAILED" if stage == "BEFORE" else "INCOMPLETE")


def observer_event():
    return event(
        "OBSERVER_RESULT",
        {
            "observerId": "network",
            "matchedCount": 1,
            "windowMode": "FIXED",
            "durationMs": 1,
            "ambiguous": False,
            "requests": [],
        },
        stepId="save",
    )


@pytest.mark.parametrize(
    "ordering",
    [
        "valid",
        "observer_after_step",
        "assertion_after_step",
        "finalize_before_observer",
        "finalize_forges_after_skip",
    ],
)
def test_actual_finalize_stage_and_step_local_intervals(ordering):
    plan = [
        expected_step(
            assertions=[
                {"id": "count", "severity": "BLOCK", "stage": "FINALIZE"},
                {"id": "after", "severity": "BLOCK", "stage": "AFTER"},
            ],
            observers=["network"],
        )
    ]
    after, observed, count = (
        assertion_event("after"),
        observer_event(),
        assertion_event("count", "FAILED"),
    )
    body = [
        event("STEP_STARTED", {}, stepId="save"),
        after,
        observed,
        count,
        step_end(status="FAILED"),
    ]
    if ordering == "observer_after_step":
        body = [body[0], after, count, body[-1], observed]
    elif ordering == "assertion_after_step":
        body = [body[0], after, observed, body[-1], count]
    elif ordering == "finalize_before_observer":
        body = [body[0], after, count, observed, body[-1]]
    elif ordering == "finalize_forges_after_skip":
        after = assertion_event(
            "after", "SKIPPED", blockedByStepId="save", blockedByAssertionId="count"
        )
        body = [body[0], observed, count, after, body[-1]]
    result = canonical_case(plan, [began(), *body, cleanup_event(), finished("FAILED")], "FAILED")
    assert result["outcome"] == ("FAILED" if ordering == "valid" else "INCOMPLETE")


def test_cancellation_does_not_bypass_invalid_lifecycle_order():
    plan = {"steps": [expected_step()]}
    events = [
        began(),
        finished("CANCELLED"),
        event("STEP_STARTED", {}, stepId="save"),
        cleanup_event(),
    ]
    result = reducer()(
        plan,
        events,
        {"businessOutcome": "CANCELLED", "cleanupStatus": "NOT_REQUIRED"},
        evidence_complete=True,
        cancel_requested=True,
    )
    assert result["outcome"] == "INCOMPLETE"
