"""Reduce actual canonical facts against compiler-produced expectations."""

from typing import Any

PRIORITY = ["ERROR", "INCOMPLETE", "FAILED", "CANCELLED", "UNSTABLE", "SKIPPED", "PASSED"]


def aggregate(outcomes: list[str]) -> str:
    return next((o for o in PRIORITY if o in outcomes), "INCOMPLETE")


def reduce_test(
    plan: dict[str, Any],
    events: list[dict[str, Any]],
    manifest: dict[str, Any],
    *,
    evidence_complete: bool,
    cancel_requested: bool = False,
) -> dict[str, Any]:
    steps = {s["id"]: s for s in plan["steps"]}
    starts = {e.get("stepId"): e for e in events if e["type"] == "STEP_STARTED"}
    finished = {e.get("stepId"): e for e in events if e["type"] == "STEP_FINISHED"}
    assertions = {
        (e.get("stepId"), e.get("assertionId")): e
        for e in events
        if e["type"] == "ASSERTION_RESULT"
    }
    cleanup = manifest["cleanupStatus"]
    complete = bool(steps) and evidence_complete
    complete &= sum(e["type"] == "ATTEMPT_STARTED" for e in events) == 1
    complete &= sum(e["type"] == "ATTEMPT_FINISHED" for e in events) == 1
    complete &= any(
        e["type"] == "CLEANUP_RESULT" and e["payload"]["cleanupStatus"] == cleanup for e in events
    )
    lifecycle_complete = complete
    complete &= len(steps) == len(plan["steps"])
    complete &= len({s["order"] for s in steps.values()}) == len(steps)
    outcomes = []

    def skipped(step: dict[str, Any], payload: dict[str, Any]) -> bool:
        blocker = steps.get(payload.get("blockedByStepId"))
        if not blocker or blocker["order"] >= step["order"]:
            return False
        aid = payload.get("blockedByAssertionId")
        if aid:
            expectation = next((a for a in blocker["assertions"] if a["id"] == aid), None)
            fact = assertions.get((blocker["id"], aid))
            return bool(
                expectation
                and expectation["severity"] == "BLOCK"
                and fact
                and fact["payload"]["status"] == "FAILED"
            )
        fact = finished.get(blocker["id"])
        return bool(
            blocker["failurePolicy"] != "CONTINUE"
            and fact
            and fact["payload"]["status"] in {"FAILED", "ERROR"}
        )

    for sid, step in steps.items():
        fact = finished.get(sid)
        if not fact:
            complete = False
            continue
        status = fact["payload"]["status"]
        if status == "SKIPPED":
            complete &= skipped(step, fact["payload"])
            continue
        if sid not in starts or events.index(starts[sid]) >= events.index(fact):
            complete = False
        outcomes.append(status)
        for assertion in step["assertions"]:
            fact = assertions.get((sid, assertion["id"]))
            if not fact or fact["payload"]["severity"] != assertion["severity"]:
                complete = False
                continue
            status = fact["payload"]["status"]
            if status == "SKIPPED":
                complete &= skipped(step, fact["payload"])
            elif status == "FAILED" and assertion["severity"] != "WARN":
                outcomes.append("FAILED")
        for observer in step["observers"]:
            complete &= any(
                e["type"] == "OBSERVER_RESULT"
                and e.get("stepId") == sid
                and e["payload"]["observerId"] == observer
                for e in events
            )
    # Unexpected/duplicate terminal facts are not silently collapsed into the maps.
    complete &= len(starts) == sum(e["type"] == "STEP_STARTED" for e in events)
    complete &= set(starts) <= set(steps)
    complete &= len(finished) == sum(e["type"] == "STEP_FINISHED" for e in events)
    complete &= set(finished) <= set(steps)
    complete &= len(assertions) == sum(e["type"] == "ASSERTION_RESULT" for e in events)
    complete &= set(assertions) <= {
        (sid, a["id"]) for sid, step in steps.items() for a in step["assertions"]
    }
    if cancel_requested and manifest["businessOutcome"] == "CANCELLED":
        complete = lifecycle_complete and any(
            e["type"] == "ATTEMPT_FINISHED" and e["payload"]["outcome"] == "CANCELLED"
            for e in events
        )
    if manifest["businessOutcome"] in {"ERROR", "CANCELLED"}:
        outcomes.append(manifest["businessOutcome"])
    if cleanup == "FAILED":
        outcomes.append("ERROR")
    if not complete or cleanup == "PENDING":
        outcomes.append("INCOMPLETE")
    outcome = aggregate(outcomes)
    return {
        "outcome": outcome,
        "business": manifest["businessOutcome"],
        "cleanup": cleanup,
        "evidence": "COMPLETE" if complete else "INCOMPLETE",
        "stepOutcomes": outcomes,
        **({"errorCode": "CLEANUP_FAILED"} if cleanup == "FAILED" else {}),
    }
