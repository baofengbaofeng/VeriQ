"""将已经授权的运行报告裁剪成模型可用的统计与诊断，并将员工审阅过的运行标识交给既有领域服务处理。"""

import json
from hashlib import sha256
from collections import Counter
from typing import Any

from jsonschema import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import WorkspaceScope
from ..contracts import _schema, canonical_bytes
from ..db import Resource, ResourceDependency, ResourceVersion, Run, User
from ..repositories.resource import ResourceRepository
from ..service import Problem
from ..validation import validate_api
from .report import ReportService
from .runs import RunService

RUN_ACTIONS = frozenset({"CANCEL_RUN", "RERUN_RUN"})
_CASE_LIMIT = 8
_ATTEMPT_LIMIT = 2
_ERROR_LIMIT = 8


def _attempt_evidence(attempt: dict[str, Any], codes: set[str]) -> dict[str, Any]:
    """仅选择可定位尝试的引用和受控结果；诊断文本、源数据、设备身份及租约信息都不进入模型证据。"""
    result = {
        "attemptId": attempt["id"],
        "attemptNo": attempt["attemptNo"],
        "phase": attempt["phase"],
        "outcome": attempt["outcome"],
        "lastSequence": attempt["lastSequence"],
    }
    facts = attempt["facts"]
    code = facts.get("errorCode")
    if isinstance(code, str) and code in codes:
        result["errorCode"] = code
    enums = {
        "business": _schema()["$defs"]["Outcome"]["enum"],
        "cleanup": _schema()["$defs"]["CleanupStatus"]["enum"],
        "evidence": ("COMPLETE", "INCOMPLETE"),
        "retryReasonCode": ("RETRY_SAFETY_UNCONFIRMED",),
    }
    for key, values in enums.items():
        if facts.get(key) in values:
            result[key] = facts[key]
    return result


def project_run_report(report: dict[str, Any], *, diagnose: bool = False) -> dict[str, Any]:
    """投影授权报告的用例、最近尝试和门禁；诊断对完整报告计数，优先展示异常用例并标注抽样省略数量。"""
    cases = report["cases"]
    run = report["run"]
    codes = set(_schema()["$defs"]["ProtectedExecutionErrorCode"]["enum"])
    result: dict[str, Any] = {
        "runId": run["id"],
        "state": run["state"],
        "outcome": run.get("outcome"),
        "source": run["source"],
        "triggerKind": run["triggerKind"],
        "statistics": {
            k: report["statistics"][k]
            for k in ("caseCount", "firstPassCount", "retryPassCount", "infrastructureErrorCount")
        },
        "gateAtExecution": report["gateAtExecution"],
        "gateNow": report["gateNow"],
        "omittedCases": max(0, len(cases) - _CASE_LIMIT),
    }
    if run.get("reasonCode") in (
        "COMPILED_PROVENANCE_REQUIRED",
        "NO_CASES_SELECTED",
        "OVERLAP_SKIPPED",
        "RUN_TIMEOUT",
        "USER_CANCELLED",
    ):
        result["reasonCode"] = run["reasonCode"]
    if diagnose:
        error_counts: Counter[str] = Counter()
        for case in cases:
            for attempt in case["attempts"]:
                code = attempt["facts"].get("errorCode")
                if isinstance(code, str) and code in codes:
                    error_counts[code] += 1
        result["diagnosis"] = {
            "outcomeCounts": dict(Counter(c["outcome"] for c in cases if c["outcome"])),
            "attemptErrorCounts": dict(
                sorted(error_counts.items(), key=lambda pair: (-pair[1], pair[0]))[:_ERROR_LIMIT]
            ),
            "omittedErrorCodeCount": max(0, len(error_counts) - _ERROR_LIMIT),
        }
        cases = sorted(
            cases,
            key=lambda case: case["outcome"] not in ("FAILED", "ERROR", "UNSTABLE", "INCOMPLETE"),
        )
    result["cases"] = [
        {
            "caseExecutionId": case["id"],
            "caseVersionId": case["caseVersionId"],
            "state": case["state"],
            "outcome": case["outcome"],
            "attemptCount": len(case["attempts"]),
            "attempts": [_attempt_evidence(a, codes) for a in case["attempts"][-_ATTEMPT_LIMIT:]],
        }
        for case in cases[:_CASE_LIMIT]
    ]
    return result


def format_run_report(projected: dict[str, Any], *, chinese: bool = False) -> str:
    """直接用已授权的有界报告生成结论、门禁原因及用例尝试引用，保留未结束状态和抽样边界供员工核对。"""
    stats = projected["statistics"]
    lines = [
        f"Run {projected['runId']} · {projected['state']} · {projected['outcome'] or '—'}",
        (
            f"用例 {stats['caseCount']} · 首次通过 {stats['firstPassCount']} · 重试通过 {stats['retryPassCount']}"
            f" · 基础设施错误 {stats['infrastructureErrorCount']}"
            if chinese
            else f"Cases {stats['caseCount']} · Passed first try {stats['firstPassCount']}"
            f" · Passed on retry {stats['retryPassCount']}"
            f" · Infrastructure errors {stats['infrastructureErrorCount']}"
        ),
    ]
    if projected.get("reasonCode"):
        lines.append(f"{'运行原因' if chinese else 'Run reason'} · {projected['reasonCode']}")
    for name, label in (
        ("gateAtExecution", "执行时门禁" if chinese else "Gate at execution"),
        ("gateNow", "当前门禁" if chinese else "Gate now"),
    ):
        gate = projected[name]
        decision = "PASSED" if gate["passed"] else "BLOCKED"
        lines.append(" · ".join((label, decision, *gate["reasons"])))
    counts = projected.get("diagnosis", {}).get("attemptErrorCounts", {})
    if counts:
        lines.append(
            " · ".join(
                [
                    "尝试错误次数" if chinese else "Attempt error counts",
                    *(f"{code} × {count}" for code, count in counts.items()),
                ]
            )
        )
    for case in projected["cases"]:
        lines.append(
            f"{'用例' if chinese else 'Case'} {case['caseExecutionId']} · {case['state']} · {case['outcome'] or '—'}"
        )
        for attempt in case["attempts"]:
            reference = f"{'尝试' if chinese else 'Attempt'} {attempt['attemptNo']} · {attempt['attemptId']}"
            details = [
                str(attempt[key]) for key in ("errorCode", "retryReasonCode") if key in attempt
            ]
            if "evidence" in attempt:
                details.append(f"{'证据' if chinese else 'Evidence'} {attempt['evidence']}")
            lines.append(
                " · ".join([reference, attempt["phase"], attempt["outcome"] or "—", *details])
            )
        if omitted := case["attemptCount"] - len(case["attempts"]):
            lines.append(
                f"另有 {omitted} 次较早尝试" if chinese else f"{omitted} earlier attempts omitted"
            )
    if omitted := projected["omittedCases"]:
        lines.append(f"另有 {omitted} 个用例" if chinese else f"{omitted} additional cases omitted")
    return "\n".join(lines)


async def read_run_report(
    report: ReportService, scope: WorkspaceScope, run_id: str, *, diagnose: bool = False
) -> dict[str, Any]:
    """从当前员工有权读取的准确运行获取正式报告，保留报告服务对跨空间访问、保留期限和在线门禁的判定。"""
    report.employee()
    return project_run_report(await report.get(scope, run_id), diagnose=diagnose)


def _not_repeatable() -> Problem:
    return Problem(
        409,
        "AGENT_RUN_NOT_REPEATABLE",
        "Choose a finished manual run of published cases or a suite",
    )


async def _require_active_dependencies(
    session: AsyncSession, scope: WorkspaceScope, selection: dict[str, Any]
) -> None:
    """从选定用例、套件和环境沿发布时登记的版本依赖检查归档状态，任何一层资源退出都必须重新选择。"""
    roots = [selection["environmentVersionId"], *selection.get("caseVersionIds", [])]
    if "suiteVersionId" in selection:
        roots.append(selection["suiteVersionId"])
    versions = (
        select(ResourceVersion.id)
        .where(ResourceVersion.workspace_id == scope.workspace_id, ResourceVersion.id.in_(roots))
        .cte(recursive=True)
    )
    versions = versions.union(
        select(ResourceDependency.dependency_version_id)
        .join(versions, ResourceDependency.version_id == versions.c.id)
        .where(ResourceDependency.workspace_id == scope.workspace_id)
    )
    archived = await session.scalar(
        select(Resource.id)
        .join(ResourceVersion, ResourceVersion.resource_id == Resource.id)
        .join(versions, ResourceVersion.id == versions.c.id)
        .where(
            Resource.workspace_id == scope.workspace_id,
            ResourceVersion.workspace_id == scope.workspace_id,
            Resource.status == "ARCHIVED",
        )
        .limit(1)
    )
    if archived is not None:
        raise Problem(
            409, "RESOURCE_ARCHIVED", "A resource in the published selection was archived"
        )


async def _repeat_selection(
    session: AsyncSession, scope: WorkspaceScope, user: User, run: Run
) -> dict[str, Any]:
    """只从已完成的手动运行取回原始发布选择，并复核当前可用资源和设备，私有运行变量仅供原发起者复用。"""
    if (
        run.state != "FINISHED"
        or run.trigger_kind != "MANUAL"
        or run.source not in {"MANAGED_CLOUD", "CONNECTED_LOCAL"}
        or run.plan_id is not None
        or run.requester_service_token_id is not None
    ):
        raise _not_repeatable()
    artifact = await ResourceRepository(session, scope).artifact(run.snapshot_hash)
    try:
        snapshot = json.loads(artifact.content)
    except ValueError:
        raise _not_repeatable() from None
    if not isinstance(snapshot, dict) or snapshot.get("runId") != run.id:
        raise _not_repeatable()
    selection = snapshot.get("request")
    try:
        validate_api("RunCreate", selection)
    except ValidationError:
        raise _not_repeatable() from None
    if (
        not isinstance(selection, dict)
        or ("suiteVersionId" in selection) == ("caseVersionIds" in selection)
        or sha256(canonical_bytes({"actorId": run.created_by, "request": selection})).hexdigest()
        != run.request_hash
        or "draftValidationJobId" in selection
        or (run.created_by != user.id and selection.get("variables"))
    ):
        raise _not_repeatable()
    # 确认入口由动作分派模块调用，延迟导入以复用同一发布选择校验，避免双向模块初始化或两套归档规则。
    from .agent_actions import current_selection

    await _require_active_dependencies(session, scope, selection)
    await current_selection(session, scope, user, {"type": "RUN_ONCE", "selection": selection})
    return selection


async def _review_target(service: RunService, scope: WorkspaceScope, action: dict[str, Any]) -> Run:
    """领取审阅目标时先复核执行资格，再核对来源归属与不可变摘要，旧提议不能悄然更换来源或目标运行。"""
    await service.authorize(scope.workspace_id)
    if (
        not isinstance(action.get("type"), str)
        or action["type"] not in RUN_ACTIONS
        or not isinstance(action.get("sourceRunId"), str)
        or action.keys() - {"type", "sourceRunId", "sourceSnapshotHash"}
    ):
        raise Problem(422, "AGENT_RUN_OPERATION_INVALID", "Choose a supported run operation")
    run = await service.get(scope.workspace_id, action["sourceRunId"].lower())
    if "sourceSnapshotHash" in action and action["sourceSnapshotHash"] != run.snapshot_hash:
        raise Problem(409, "AGENT_RUN_CHANGED", "Review the current source run before confirming")
    return run


async def prepare_run_operation(
    session: AsyncSession,
    scope: WorkspaceScope,
    user: User,
    proposal: dict[str, Any],
    context: dict[str, Any],
) -> dict[str, Any]:
    """把本轮明确可见的运行编号绑定到持久快照摘要，返回确认所需字段，预览不取消、不派发也不返回原始变量。"""
    run_id = proposal.get("sourceRunId")
    if not isinstance(run_id, str) or run_id.lower() not in {
        r["runId"] for r in context.get("runs", [])
    }:
        raise Problem(422, "AGENT_RUN_REFERENCE_REQUIRED", "Select a run from this conversation")
    run = await _review_target(RunService(session, user), scope, proposal)
    if proposal["type"] == "RERUN_RUN":
        await _repeat_selection(session, scope, user, run)
    return {
        "type": proposal["type"],
        "sourceRunId": run.id,
        "sourceSnapshotHash": run.snapshot_hash,
    }


async def apply_run_operation(
    session: AsyncSession, scope: WorkspaceScope, user: User, turn_id: str, action: dict[str, Any]
) -> dict[str, Any]:
    """在确认方已串行化的事务内复核审阅身份，按原运行请求取消或使用轮次幂等键创建一条独立运行及回执。"""
    if set(action) != {"type", "sourceRunId", "sourceSnapshotHash"}:
        raise Problem(
            422, "AGENT_RUN_OPERATION_INVALID", "Confirm a complete reviewed run operation"
        )
    service = RunService(session, user)
    run = await _review_target(service, scope, action)
    if action["type"] == "CANCEL_RUN":
        cancelled = await service.cancel(scope.workspace_id, run.id)
        return {"type": "CANCEL_RUN", "runId": cancelled["id"]}
    selection = await _repeat_selection(session, scope, user, run)
    repeated = await service.create(scope.workspace_id, f"agent-turn:{turn_id}", selection)
    return {"type": "RERUN_RUN", "sourceRunId": run.id, "runId": repeated["id"]}
