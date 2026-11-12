"""结果归约：aggregate 合并多 Attempt 结果；reduce_test 按步骤/断言时序裁剪展示树，保留阻塞失败语义。
供报告与完成聚合复用，不直接触达数据库。
"""


from typing import Any

PRIORITY = ["ERROR", "INCOMPLETE", "FAILED", "CANCELLED", "UNSTABLE", "SKIPPED", "PASSED"]
STAGES = {"BEFORE": 0, "RESPONSE": 1, "AFTER": 2, "FINALIZE": 3}


def aggregate(outcomes: list[str]) -> str:
    """将 outcome 列表归约为代表结果，优先级体现失败重于通过与不稳定，aggregate 遵守本文件边界，失败返回稳定 Problem。
    aggregate 实现于 apps/srv/src/veriq_server/services/results.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    return next((o for o in PRIORITY if o in outcomes), "INCOMPLETE")


def reduce_test(
    plan: dict[str, Any],
    events: list[dict[str, Any]],
    manifest: dict[str, Any],
    *,
    evidence_complete: bool,
    cancel_requested: bool = False,
) -> dict[str, Any]:
    """按步骤与断言时序归约测试事实树，保留阻塞点并省略冗余通过噪音，reduce_test 遵守本文件边界，失败返回稳定 Problem。
    reduce_test 实现于 apps/srv/src/veriq_server/services/results.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    steps = {s["id"]: s for s in plan["steps"]}
    positions = {id(e): i for i, e in enumerate(events)}
    starts = {e.get("stepId"): e for e in events if e["type"] == "STEP_STARTED"}
    finished = {e.get("stepId"): e for e in events if e["type"] == "STEP_FINISHED"}
    assertions = {
        (e.get("stepId"), e.get("assertionId")): e
        for e in events
        if e["type"] == "ASSERTION_RESULT"
    }
    observers = {
        (e.get("stepId"), e["payload"]["observerId"]): e
        for e in events
        if e["type"] == "OBSERVER_RESULT"
    }
    attempt_starts = [i for i, e in enumerate(events) if e["type"] == "ATTEMPT_STARTED"]
    attempt_ends = [i for i, e in enumerate(events) if e["type"] == "ATTEMPT_FINISHED"]
    cleanups = [i for i, e in enumerate(events) if e["type"] == "CLEANUP_RESULT"]
    cleanup = manifest["cleanupStatus"]
    lifecycle = len(attempt_starts) == len(attempt_ends) == len(cleanups) == 1
    if lifecycle:
        begin, end, clean = attempt_starts[0], attempt_ends[0], cleanups[0]
        lifecycle &= begin < clean < end and events[clean]["payload"]["cleanupStatus"] == cleanup
        # Only upload notification/log tails may occur outside the execution interval.
        lifecycle &= all(
            begin < i < end
            or e["type"] in {"ATTEMPT_STARTED", "ATTEMPT_FINISHED", "ARTIFACT_CREATED", "LOG"}
            for i, e in enumerate(events)
        )
        lifecycle &= all(
            i < clean
            for i, e in enumerate(events)
            if e["type"]
            in {
                "STEP_STARTED",
                "STEP_FINISHED",
                "ASSERTION_RESULT",
                "OBSERVER_RESULT",
                "VARIABLE_EXTRACTED",
            }
        )
    complete = bool(steps) and evidence_complete and lifecycle
    valid = len(steps) == len(plan["steps"]) and len({s["order"] for s in steps.values()}) == len(
        steps
    )
    outcomes: list[str] = []
    blocked_observers: list[dict[str, str]] = []

    def before(a: dict[str, Any], b: dict[str, Any]) -> bool:
        return positions[id(a)] < positions[id(b)]

    def ancestor(parent: str, child: str) -> bool:
        seen = set()
        while child in steps and child not in seen:
            seen.add(child)
            child = steps[child].get("parentId", "")
            if child == parent:
                return True
        return False

    def rank(step: dict[str, Any], assertion: dict[str, Any]) -> tuple[int, int]:
        return STAGES[assertion["stage"]], step["assertions"].index(assertion)

    def block_assertion(fact: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
        payload = fact["payload"]
        blocker = steps.get(payload.get("blockedByStepId"))
        if not blocker:
            return None
        aid = payload.get("blockedByAssertionId")
        expected = next((a for a in blocker["assertions"] if a["id"] == aid), None)
        actual = assertions.get((blocker["id"], aid))
        if (
            expected
            and expected["severity"] == "BLOCK"
            and actual
            and actual["payload"]["status"] == "FAILED"
            and actual["payload"]["severity"] == "BLOCK"
            and before(actual, fact)
        ):
            return blocker, expected
        return None

    def skipped(
        step: dict[str, Any], fact: dict[str, Any], assertion: dict[str, Any] | None = None
    ) -> bool:
        payload = fact["payload"]
        blocker = steps.get(payload.get("blockedByStepId"))
        if not blocker or blocker["order"] > step["order"]:
            return False
        if payload.get("blockedByAssertionId"):
            cause = block_assertion(fact)
            if not cause:
                return False
            _, expected = cause
            if blocker["id"] == step["id"]:
                return assertion is not None and rank(blocker, expected) < rank(step, assertion)
            if ancestor(blocker["id"], step["id"]):
                return bool(expected["stage"] == "BEFORE")
            return True
        actual = finished.get(blocker["id"])
        return bool(
            blocker["order"] < step["order"]
            and not ancestor(blocker["id"], step["id"])
            and blocker["failurePolicy"] != "CONTINUE"
            and actual
            and actual["payload"]["status"] in {"FAILED", "ERROR"}
            and before(actual, fact)
        )

    for sid, step in steps.items():
        parent = steps.get(step.get("parentId"))
        if step.get("parentId"):
            valid &= parent is not None and parent["order"] < step["order"]
        valid &= len({a["id"] for a in step["assertions"]}) == len(step["assertions"])
        fact = finished.get(sid)
        if not fact:
            complete = False
            continue
        status = fact["payload"]["status"]
        outcomes.append(status)
        if status == "SKIPPED":
            valid &= skipped(step, fact)
            valid &= sid not in starts and not any(k[0] == sid for k in [*assertions, *observers])
            continue
        start = starts.get(sid)
        valid &= start is not None and before(start, fact)
        if parent:
            ps, pe = starts.get(parent["id"]), finished.get(parent["id"])
            valid &= (
                ps is not None
                and pe is not None
                and start is not None
                and before(ps, start)
                and before(fact, pe)
            )
        seen_assertions: list[tuple[tuple[int, int], int]] = []
        for assertion in step["assertions"]:
            actual = assertions.get((sid, assertion["id"]))
            if not actual:
                complete = False
                continue
            valid &= actual["payload"]["severity"] == assertion["severity"]
            valid &= start is not None and before(start, actual) and before(actual, fact)
            seen_assertions.append((rank(step, assertion), positions[id(actual)]))
            if actual["payload"]["status"] == "SKIPPED":
                valid &= skipped(step, actual, assertion)
            elif actual["payload"]["status"] == "FAILED" and assertion["severity"] != "WARN":
                outcomes.append("FAILED")
            # Executed parent assertions bracket child work by actual execution stage.
            if actual["payload"]["status"] != "SKIPPED":
                for child in steps.values():
                    if child.get("parentId") != sid or child["id"] not in starts:
                        continue
                    boundary = (
                        starts[child["id"]]
                        if assertion["stage"] == "BEFORE"
                        else finished.get(child["id"])
                    )
                    valid &= boundary is not None and (
                        before(actual, boundary)
                        if assertion["stage"] == "BEFORE"
                        else before(boundary, actual)
                    )
        ordered = [pos for _, pos in sorted(seen_assertions)]
        valid &= ordered == sorted(ordered)
        cause = block_assertion(fact)
        observer_block = bool(
            status in {"FAILED", "ERROR"}
            and cause
            and cause[0]["id"] == sid
            and cause[1]["stage"] != "FINALIZE"
        )
        for observer in step["observers"]:
            actual = observers.get((sid, observer))
            if actual:
                valid &= start is not None and before(start, actual) and before(actual, fact)
                for assertion in step["assertions"]:
                    terminal = assertions.get((sid, assertion["id"]))
                    if (
                        assertion["stage"] == "FINALIZE"
                        and terminal
                        and terminal["payload"]["status"] != "SKIPPED"
                    ):
                        valid &= before(actual, terminal)
            elif observer_block:
                blocked_observers.append(
                    {
                        "stepId": sid,
                        "observerId": observer,
                        "blockedByStepId": sid,
                        "blockedByAssertionId": fact["payload"]["blockedByAssertionId"],
                    }
                )
            else:
                complete = False

    # Direct siblings execute in declared order; children must remain within parents.
    for parent_id in {s.get("parentId") for s in steps.values()}:
        siblings = sorted(
            (s for s in steps.values() if s.get("parentId") == parent_id), key=lambda s: s["order"]
        )
        for left, right in zip(siblings, siblings[1:]):
            previous_end, next_start = (
                finished.get(left["id"]),
                starts.get(right["id"], finished.get(right["id"])),
            )
            if previous_end and next_start:
                valid &= before(previous_end, next_start)
    checks: list[tuple[set[Any], str, set[Any]]] = [
        (set(starts), "STEP_STARTED", set(steps)),
        (set(finished), "STEP_FINISHED", set(steps)),
        (
            set(assertions),
            "ASSERTION_RESULT",
            {(sid, a["id"]) for sid, s in steps.items() for a in s["assertions"]},
        ),
        (
            set(observers),
            "OBSERVER_RESULT",
            {(sid, o) for sid, s in steps.items() for o in s["observers"]},
        ),
    ]
    for keys, kind, allowed in checks:
        valid &= len(keys) == sum(e["type"] == kind for e in events) and keys <= allowed
    if cancel_requested and manifest["businessOutcome"] == "CANCELLED":
        complete = bool(steps) and evidence_complete and lifecycle
    outcomes.append(manifest["businessOutcome"])
    if cleanup == "FAILED":
        outcomes.append("ERROR")
    if cleanup == "PENDING":
        outcomes.append("INCOMPLETE")
    reported = aggregate(outcomes)
    for index in attempt_ends:
        terminal = events[index]["payload"]
        valid &= terminal["outcome"] == reported and terminal["cleanupStatus"] == cleanup
        outcomes.append(terminal["outcome"])
    complete &= valid
    if not complete:
        outcomes.append("INCOMPLETE")
    return {
        "outcome": aggregate(outcomes),
        "business": manifest["businessOutcome"],
        "cleanup": cleanup,
        "evidence": "COMPLETE" if complete else "INCOMPLETE",
        "stepOutcomes": outcomes,
        **({"blockedObservers": blocked_observers} if blocked_observers else {}),
        **({"errorCode": "CLEANUP_FAILED"} if cleanup == "FAILED" else {}),
    }
