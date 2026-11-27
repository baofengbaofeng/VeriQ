"""将模型返回的有限选择转换为员工可审阅的公开提议；在确认事务里按冻结修订重新取数并调用现有业务服务。"""

from typing import Any

from jsonschema import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import Permission, WorkspaceScope
from ..db import AgentSession, AgentTurn, ExecutionPlan, ResourceVersion, User
from ..repositories.resource import ResourceRepository
from ..service import Problem
from ..settings import Settings
from ..validation import validate_api
from .agent_context import safe_plan
from .agent_resource_batch import RESOURCE_BATCH_ACTION, save_resource_batch
from .agent_resource_drafts import RESOURCE_ACTION, save_resource_draft
from .agent_resource_lifecycle import (
    RESOURCE_LIFECYCLE_ACTIONS,
    apply_resource_lifecycle,
    authorize_resource_lifecycle,
)
from .agent_run_operations import RUN_ACTIONS, apply_run_operation
from .agent_tasks import follow_run
from .execution_plan import ExecutionPlanService, TriggerService
from .runtime import RuntimeService
from .runs import RunService, selected_axes
from .workspace import WorkspaceRepository


def _invalid() -> Problem:
    return Problem(
        422,
        "AGENT_SELECTION_INVALID",
        "Choose published assets, roles and Runtimes from the available list",
    )


def _check_selection(
    selection: dict[str, Any] | None,
    assets: dict[str, dict[str, Any]],
    runtimes: dict[str, dict[str, Any]],
) -> None:
    """逐项匹配环境角色、发布类型、设备位置和浏览器能力，标识合法但未在本次授权候选中出现时同样拒绝。"""
    if not isinstance(selection, dict):
        raise _invalid()
    env = assets.get(selection["environmentVersionId"], {})
    if env.get("kind") != "ENVIRONMENT" or not set(selection["roleKeys"]) <= set(env["roleKeys"]):
        raise _invalid()
    if (
        "suiteVersionId" in selection
        and assets.get(selection["suiteVersionId"], {}).get("kind") != "SUITE"
    ):
        raise _invalid()
    if any(
        assets.get(cid, {}).get("kind") != "CASE" for cid in selection.get("caseVersionIds", [])
    ):
        raise _invalid()
    devices = [runtimes[rid] for rid in selection["runtimeIds"] if rid in runtimes]
    if len(devices) != len(selection["runtimeIds"]) or len({d["location"] for d in devices}) != 1:
        raise _invalid()
    if not set(selection["browsers"]) <= {b for d in devices for b in d["browsers"]}:
        raise _invalid()


async def proposal_preview(
    s: AsyncSession, scope: WorkspaceScope, user: User, value: Any, context: dict[str, Any]
) -> dict[str, Any]:
    """以调用前送出的真实基准补全差量字段，只允许模型指出所需变更，回显原配置与完整提议均由控制面构造。"""
    if not isinstance(value, dict) or "previousPlan" in value:
        raise _invalid()
    proposal = dict(value)
    base = None
    kind = proposal.get("type")
    if "planId" in proposal:
        offered = next((p for p in context["plans"] if p["id"] == proposal["planId"]), None)
        if offered is None:
            raise _invalid()
        row = await ExecutionPlanService(s, user).get(scope.workspace_id, proposal["planId"])
        if row.archived or row.revision != offered["revision"]:
            raise Problem(409, "PLAN_REVISION_CONFLICT", "Review the current active plan revision")
        base = safe_plan(row)
        # 在合并前比较模型所选修订与实际发给模型的修订；不能把一个陈旧或缺少修订的增量自动升级。
        if kind == "SAVE_PLAN":
            patch = proposal.get("plan")
            if not isinstance(patch, dict) or patch.get("revision") != base["revision"]:
                raise _invalid()
            # 当模型回传完整表单时，脱敏占位同样表示基准值；实际合并须保留未曾交给供应商的原有配置。
            changes = {k: v for k, v in patch.items() if v != offered.get(k)}
            proposal.update(plan={**base, **changes}, previousPlan=base)
        elif proposal.get("planRevision") != base["revision"]:
            raise _invalid()
        elif kind == "RUN_ONCE":
            patch = proposal.get("selection")
            if not isinstance(patch, dict):
                raise _invalid()
            base_selection = {
                k: v
                for k, v in base.items()
                if k not in {"name", "revision", "overlapPolicy", "maxCaseRetries"}
            }
            if "caseVersionIds" in patch:
                base_selection.pop("suiteVersionId")
            proposal["selection"] = {
                **base_selection,
                "maxRetries": base["maxCaseRetries"],
                **patch,
            }
    try:
        validate_api("AgentProposal", proposal)
        if kind == "RUN_ONCE":
            validate_api("RunCreate", proposal["selection"])
    except ValidationError:
        raise _invalid() from None
    selection = proposal.get("plan") or proposal.get("selection") or base
    _check_selection(
        selection,
        {a["versionId"]: a for a in context["assets"]},
        {r["id"]: r for r in context["runtimes"]},
    )
    return proposal


async def _require_workload(
    s: AsyncSession,
    scope: WorkspaceScope,
    selection: dict[str, Any],
    variants: list[dict[str, Any]],
) -> None:
    """按不可变用例版本取角色键并逐条交叉匹配，不把不同套件条目的角色与浏览器拼成一个并不存在的可运行组合。"""
    ids = {v["versionId"] for v in variants}
    query = select(
        ResourceVersion.id, ResourceVersion.document_json["document"]["roleKey"].as_string()
    ).where(
        ResourceVersion.workspace_id == scope.workspace_id,
        ResourceVersion.kind == "CASE",
        ResourceVersion.id.in_(ids),
    )
    roles = dict((await s.execute(query)).tuples().all())
    for variant in variants:
        role = roles.get(variant["versionId"])
        if role and all(selected_axes(variant, role, selection)):
            return
    raise Problem(
        422,
        "AGENT_NO_MATCHING_CASE",
        "No published case matches this role and browser combination. Choose a different role, browser or suite.",
    )


async def current_selection(
    s: AsyncSession, scope: WorkspaceScope, user: User, proposal: dict[str, Any]
) -> ExecutionPlan | None:
    """重新解析确认所用的确切版本并读取服务端变量，套件和环境归档、计划修订变化或撤销设备授权都阻止执行。"""
    plan = None
    if "planId" in proposal:
        plan = await ExecutionPlanService(s, user).get(scope.workspace_id, proposal["planId"])
        revision = (
            proposal["plan"]["revision"]
            if proposal["type"] == "SAVE_PLAN"
            else proposal["planRevision"]
        )
        if plan.archived or plan.revision != revision:
            raise Problem(
                409,
                "PLAN_REVISION_CONFLICT",
                "Review the latest active plan revision before confirming",
            )
    selection = proposal.get("plan") or proposal.get("selection")
    if not selection:
        if plan is None:
            raise _invalid()
        selection = safe_plan(plan)
    repo = ResourceRepository(s, scope)
    assets = {}
    ids = [selection["environmentVersionId"], *selection.get("caseVersionIds", [])]
    if "suiteVersionId" in selection:
        ids.append(selection["suiteVersionId"])
    variants = [{"versionId": cid} for cid in selection.get("caseVersionIds", [])]
    for vid in ids:
        version = await repo.version(vid)
        if (await repo.resource(version.resource_id)).status == "ARCHIVED":
            raise Problem(409, "RESOURCE_ARCHIVED", "A selected published resource was archived")
        roles = (
            version.document_json["document"].get("roles", [])
            if version.kind == "ENVIRONMENT"
            else []
        )
        if version.kind == "SUITE":
            variants = version.document_json["document"]["cases"]
        assets[vid] = {"kind": version.kind, "roleKeys": [r["roleKey"] for r in roles]}
    devices = {}
    for rid in selection["runtimeIds"]:
        runtime = await RuntimeService(s).require_dispatch(user, scope.workspace_id, rid)
        devices[rid] = {
            "location": runtime.location,
            "browsers": runtime.capabilities.get("browsers", []),
        }
    _check_selection(selection, assets, devices)
    await _require_workload(s, scope, selection, variants)
    return plan


async def apply_proposal(
    s: AsyncSession, scope: WorkspaceScope, user: User, turn: AgentTurn, settings: Settings
) -> dict[str, Any]:
    """以具体提议轮次的稳定身份应用操作，先验证当前权限再复用回执；首次确认与领域变更在调用方同一事务提交。"""
    action = turn.proposal or turn.receipt
    if turn.status != "COMPLETED" or not action:
        raise Problem(409, "AGENT_NO_PROPOSAL", "There is no reviewed action to confirm")
    kind = action["type"]
    if kind in RESOURCE_LIFECYCLE_ACTIONS:
        await authorize_resource_lifecycle(s, scope, user, action)
    else:
        permission = (
            Permission.EDIT
            if kind in {"SAVE_PLAN", RESOURCE_ACTION, RESOURCE_BATCH_ACTION}
            else Permission.EXECUTE
        )
        await WorkspaceRepository(s, scope).authorize(user, permission, write=True)
    if turn.receipt:
        return turn.receipt
    if kind == RESOURCE_ACTION:
        receipt = await save_resource_draft(s, scope, user, action)
    elif kind == RESOURCE_BATCH_ACTION:
        receipt = await save_resource_batch(s, scope, user, action)
    elif kind in RESOURCE_LIFECYCLE_ACTIONS:
        receipt = await apply_resource_lifecycle(s, scope, user, action, settings)
    elif kind in RUN_ACTIONS:
        receipt = await apply_run_operation(s, scope, user, turn.id, action)
    else:
        receipt = await _apply_execution(s, scope, user, turn.id, action)
    validate_api("AgentReceipt", receipt)
    turn.receipt = receipt
    turn.related_run_id = receipt.get("runId")
    if kind in {"RUN_ONCE", "TRIGGER_PLAN", "RERUN_RUN"} and turn.related_run_id:
        await _follow_confirmed_run(s, user, turn, action)
    return receipt


async def _follow_confirmed_run(
    s: AsyncSession, user: User, turn: AgentTurn, action: dict[str, Any]
) -> None:
    """员工审阅过的委派方式优先于模型建议，自动跟踪达到当前容量上限时，仍提交已经获准的真实运行回执。"""
    mode = turn.delegation_mode
    if mode in {None, "MAIN"} or (mode == "AUTO" and action.get("delegateRun") is False):
        return
    owner = await s.get(AgentSession, turn.session_id)
    if owner is None or turn.related_run_id is None:
        raise _invalid()
    # 先把父运行写入当前事务，再插入跟踪任务。手动运行和计划触发均以此顺序满足外键约束，并保持提交的原子性。
    await s.flush()
    try:
        await follow_run(
            s,
            owner,
            user,
            turn.id,
            turn.related_run_id,
            "MANUAL" if mode == "SUBAGENT" else "AUTO",
            analyze=action.get("analyzeRun", False),
            from_turn=True,
        )
    except Problem as problem:
        if problem.code != "AGENT_TASK_ALREADY_FOLLOWING" and (
            mode != "AUTO" or problem.code != "AGENT_TASK_LIMIT"
        ):
            raise


async def _apply_execution(
    s: AsyncSession, scope: WorkspaceScope, user: User, turn_id: str, action: dict[str, Any]
) -> dict[str, Any]:
    """计划和运行继续经各自领域服务保存或排队，稳定轮次标识用于执行端幂等，模型不传入计划内部变量。"""
    kind = action["type"]
    plan = await current_selection(s, scope, user, action)
    variables = plan.selection.get("variables", {}) if plan else {}
    key = f"agent-turn:{turn_id}"
    if kind == "SAVE_PLAN":
        saved = await ExecutionPlanService(s, user).write(
            scope.workspace_id, {**action["plan"], "variables": variables}, action.get("planId")
        )
        receipt = {"type": kind, "planId": saved.id, "planRevision": saved.revision}
    elif kind == "TRIGGER_PLAN":
        if plan is None:
            raise _invalid()
        triggered = await TriggerService(s, user).trigger(
            scope, plan.id, action.get("triggerInput", {}), key
        )
        receipt = {
            "type": kind,
            "planId": plan.id,
            "planRevision": plan.revision,
            "decision": triggered["decision"],
            "runId": triggered["runId"],
        }
    else:
        run = await RunService(s, user).create(
            scope.workspace_id, key, {**action["selection"], "variables": variables}
        )
        receipt = {"type": kind, "runId": run["id"]}
    return receipt
