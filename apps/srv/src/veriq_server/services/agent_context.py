"""为当前员工构造有界的对话候选目录，只投影发布版本、可派发设备、计划预览及报告统计，原文留在业务库。"""

import re
from datetime import timedelta
from typing import Any

from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import WorkspaceScope
from ..contracts import canonical_bytes
from ..db import (
    AgentTurn,
    ExecutionPlan,
    Resource,
    ResourceVersion,
    Run,
    Runtime,
    RuntimeBinding,
    User,
)
from ..service import Problem, now
from ..settings import Settings
from .report import ReportService
from .runtime import RuntimeService

UUID_IN_TEXT = re.compile(r"\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b", re.I)
PLAN_FIELDS = {
    "suiteVersionId",
    "environmentVersionId",
    "browsers",
    "runtimeIds",
    "roleKeys",
    "overlapPolicy",
    "maxCaseRetries",
}


def safe_plan(row: ExecutionPlan) -> dict[str, Any]:
    """使用正向选择投影计划中允许预览的字段，避免变量和日后新增的操作选项自动穿透到供应商请求或员工对话。"""
    return {
        "name": row.name,
        "revision": row.revision,
        **{k: row.selection[k] for k in PLAN_FIELDS},
    }


def _rank(text, *columns):
    """按本轮文字中出现的名称或标识排序，在有界候选页内优先保留直接点名的资源，值通过绑定参数传入。"""
    return case((or_(*(func.instr(text, col) > 0 for col in columns)), 0), else_=1)


async def run_summary(report: ReportService, scope: WorkspaceScope, run_id: str) -> dict:
    """只从报告服务读取当前状态与用例统计，保留结果为空的实际语义，避免把入队回执或模型猜测作为测试结论。"""
    result = await report.get(scope, run_id)
    run = result["run"]
    return {
        "runId": run_id,
        "state": run["state"],
        "outcome": run.get("outcome"),
        "statistics": result["statistics"],
        "gateAtExecution": result["gateAtExecution"]["passed"],
        "gateNow": result["gateNow"]["passed"],
    }


async def _assets(s, scope, text, plans):
    """目录默认展示每个活动资源的最新发布版本，计划锁定的旧版本同样参与查询，但仍需满足资源和版本的空间归属。"""
    pinned = {p.selection[f] for p in plans for f in ("suiteVersionId", "environmentVersionId")}
    result = []
    for kind in ("SUITE", "CASE", "ENVIRONMENT"):
        query = (
            select(Resource, ResourceVersion)
            .join(ResourceVersion, ResourceVersion.resource_id == Resource.id)
            .where(
                Resource.workspace_id == scope.workspace_id,
                ResourceVersion.workspace_id == scope.workspace_id,
                Resource.kind == kind,
                ResourceVersion.kind == kind,
                Resource.status != "ARCHIVED",
                or_(
                    ResourceVersion.id == Resource.latest_version_id, ResourceVersion.id.in_(pinned)
                ),
            )
            .order_by(
                _rank(text, Resource.key, Resource.name, ResourceVersion.id),
                ResourceVersion.id.in_(pinned).desc(),
                ResourceVersion.published_at.desc(),
                ResourceVersion.id,
            )
            .limit(24)
        )
        for resource, version in await s.execute(query):
            doc = version.document_json["document"]
            asset = {
                "versionId": version.id,
                "kind": kind,
                "name": resource.name,
                "key": resource.key,
            }
            if kind == "ENVIRONMENT":
                asset["roleKeys"] = [role["roleKey"] for role in doc["roles"]][:32]
            if kind == "CASE":
                asset.update(title=doc["title"][:160], roleKey=doc["roleKey"])
            if kind == "SUITE":
                suite_cases = [member["versionId"] for member in doc["cases"]]
                asset.update(caseCount=len(suite_cases), caseVersionIds=suite_cases[:32])
                pinned.update(suite_cases[:32])
            result.append(asset)
    # 已发布套件可能保留较旧用例，模型可据可见版本关联标题；不在授权候选页的成员不发送标识。
    visible_cases = {item["versionId"] for item in result if item["kind"] == "CASE"}
    for item in result:
        if item["kind"] == "SUITE":
            item["caseVersionIds"] = [cid for cid in item["caseVersionIds"] if cid in visible_cases]
    return result


async def _runtimes(s, scope, user, text, plans):
    """取当前绑定的设备并逐个复核可派发权限，保留可用浏览器和在线状态，私人设备详情仅进入获授权员工的上下文。"""
    pinned = {rid for p in plans for rid in p.selection["runtimeIds"]}
    query = (
        select(Runtime)
        .join(RuntimeBinding, RuntimeBinding.runtime_id == Runtime.id)
        .where(
            RuntimeBinding.workspace_id == scope.workspace_id,
            RuntimeBinding.active.is_(True),
            Runtime.trust_status != "REVOKED",
        )
        .order_by(
            _rank(text, Runtime.name, Runtime.id),
            Runtime.id.in_(pinned).desc(),
            Runtime.created_at.desc(),
        )
        .limit(80)
    )
    service = RuntimeService(s)
    result = []
    for runtime in await s.scalars(query):
        try:
            await service.require_dispatch(user, scope.workspace_id, runtime.id)
        except Problem as problem:
            if problem.status not in {401, 403, 404}:
                raise
            continue
        result.append(
            {
                "id": runtime.id,
                "name": runtime.name,
                "location": runtime.location,
                "online": bool(
                    runtime.last_seen_at and runtime.last_seen_at > now() - timedelta(minutes=1)
                ),
                "browsers": [
                    b
                    for b in runtime.capabilities.get("browsers", [])
                    if b in ("chromium", "webkit", "firefox")
                ],
            }
        )
        if len(result) == 24:
            break
    return result


async def build_context(
    s: AsyncSession,
    scope: WorkspaceScope,
    user: User,
    settings: Settings,
    text: str,
    recent: list[AgentTurn],
) -> dict:
    """从同一授权事务生成规划输入，先匹配用户点名和历史引用，再以最新发布补齐候选，对话窗口按真实时间顺序传递。"""
    history = [
        {
            "text": t.text[:1200],
            "reply": (t.reply or "")[:1800],
            **({"receipt": t.receipt} if t.receipt else {}),
        }
        for t in recent
    ]
    mentions = text + " " + " ".join(str(t.proposal or t.receipt or "") for t in recent)
    plans = list(
        await s.scalars(
            select(ExecutionPlan)
            .where(
                ExecutionPlan.workspace_id == scope.workspace_id, ExecutionPlan.archived.is_(False)
            )
            .order_by(
                _rank(text, ExecutionPlan.id, ExecutionPlan.name),
                _rank(mentions, ExecutionPlan.id),
                ExecutionPlan.created_at.desc(),
                ExecutionPlan.id,
            )
            .limit(10)
        )
    )
    assets = await _assets(s, scope, mentions, plans)
    runtimes = await _runtimes(s, scope, user, mentions, plans)
    visible = {r["id"] for r in runtimes}
    versions = {r["versionId"] for r in assets}
    plans = [
        p
        for p in plans
        if set(p.selection["runtimeIds"]) <= visible
        and {p.selection["suiteVersionId"], p.selection["environmentVersionId"]} <= versions
    ]
    # 将引用限制到本次仍可见的候选；模型只应在当前授权内延续之前的建议，设备撤销后不能再次寄送旧选择。
    for item, turn in zip(history, recent, strict=True):
        if turn.proposal:
            selected = turn.proposal.get("plan") or turn.proposal.get("selection") or {}
            if set(selected.get("runtimeIds", [])) <= visible and (
                not turn.proposal.get("planId")
                or any(p.id == turn.proposal["planId"] for p in plans)
            ):
                item["proposal"] = turn.proposal

    # 用户主动给出的标识先通过同空间运行表解析，正文、报告日志、截图或随环境保存的凭据都不进入模型。
    mentioned = UUID_IN_TEXT.findall(text)[:8]
    explicit = list(
        await s.scalars(
            select(Run.id).where(Run.workspace_id == scope.workspace_id, Run.id.in_(mentioned))
        )
    )
    report = ReportService(s, user, settings)
    runs = []
    for rid in list(
        dict.fromkeys(
            [*explicit, *(t.related_run_id for t in reversed(recent) if t.related_run_id)]
        )
    )[:4]:
        try:
            runs.append(await run_summary(report, scope, rid))
        except Problem as problem:
            if problem.status not in {404, 410}:
                raise
    context = {
        "request": text,
        "history": history,
        "plans": [{"id": p.id, **safe_plan(p)} for p in plans],
        "assets": assets,
        "runtimes": runtimes,
        "runs": runs,
    }
    # 长 Unicode 文本和角色名称按实际序列化字节计费，超限先舍弃最早轮次，再截掉排名靠后的候选项。
    for items in (history, assets, context["plans"], runtimes):
        while items and len(canonical_bytes(context)) > 65536:
            items.pop(0 if items is history else -1)
    return context
