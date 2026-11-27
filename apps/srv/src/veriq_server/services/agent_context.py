"""为当前员工构造有界的对话候选目录，只投影发布版本、可派发设备、计划预览及报告统计，原文留在业务库。"""

import re
from datetime import timedelta
from typing import Any

from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute
from sqlalchemy.sql.elements import Case

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
from .agent_sessions import receipt_dto
from .report import ReportService
from .runtime import RuntimeService

# 标识可直接邻接中文而不带空格，但不能从较长的英数标记中截出一个 UUID 当成用户指定的运行。
UUID_IN_TEXT = re.compile(r"\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b", re.I | re.ASCII)
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


def _rank(text: str, *columns: InstrumentedAttribute[str]) -> Case[int]:
    """按本轮文字中出现的名称或标识排序，在有界候选页内优先保留直接点名的资源，值通过绑定参数传入。"""
    return case((or_(*(func.instr(text, col) > 0 for col in columns)), 0), else_=1)


async def run_summary(report: ReportService, scope: WorkspaceScope, run_id: str) -> dict[str, Any]:
    """仅从报告服务读取当前状态和实际结论，允许尚无结论的运行作为回答依据；统计及门禁在完整报告中计算。"""
    # 对话轮次只读有成员授权的运行头，不在持有安装锁时展开逐用例和逐尝试的完整报告或计算门禁。
    run = await report.run(scope, run_id)
    return {"runId": run.id, "state": run.state, "outcome": run.outcome}


async def _assets(
    s: AsyncSession, scope: WorkspaceScope, text: str, plans: list[ExecutionPlan]
) -> list[dict[str, Any]]:
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
            asset: dict[str, Any] = {
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


async def _runtimes(
    s: AsyncSession, scope: WorkspaceScope, user: User, text: str, plans: list[ExecutionPlan]
) -> list[dict[str, Any]]:
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


def _visible_selection(selection: dict[str, Any], devices: set[str], versions: set[str]) -> bool:
    """历史轮次只能复用目前目录中有权选择的设备和发布版本，包括原计划预览中的套件以及直接运行的每个用例。"""
    referenced = {selection["environmentVersionId"], *selection.get("caseVersionIds", [])}
    if "suiteVersionId" in selection:
        referenced.add(selection["suiteVersionId"])
    return referenced <= versions and set(selection["runtimeIds"]) <= devices


async def build_context(
    s: AsyncSession,
    scope: WorkspaceScope,
    user: User,
    settings: Settings,
    text: str,
    recent: list[AgentTurn],
    attachments: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """从同一授权事务生成规划输入，先匹配用户点名和历史引用，再以最新发布补齐候选，对话窗口按真实时间顺序传递。"""
    history: list[dict[str, Any]] = [
        {
            "text": t.text[:1200],
            "reply": (t.reply or "")[:1800],
            **({"receipt": receipt_dto(t.receipt)} if t.receipt else {}),
        }
        for t in recent
    ]
    # 配置草稿全文只在已授权的审阅卡片展示，后续模型上下文仅沿用资源回执和原有规划候选。
    plan_proposals = [
        t.proposal if t.proposal and "resource" not in t.proposal else None for t in recent
    ]
    mentions = (
        text
        + " "
        + " ".join(
            str(proposal or receipt_dto(t.receipt) or "")
            for proposal, t in zip(plan_proposals, recent, strict=True)
        )
    )
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
    plan_ids = {p.id for p in plans}
    # 增量预览中旧值可能包含已撤销的私有设备，历史引用只有在三组选择全部仍可见时才发给供应商。
    for item, proposal in zip(history, plan_proposals, strict=True):
        if not proposal or ("planId" in proposal and proposal["planId"] not in plan_ids):
            continue
        selections = [proposal[k] for k in ("plan", "previousPlan", "selection") if k in proposal]
        if all(_visible_selection(selected, visible, versions) for selected in selections):
            item["proposal"] = proposal

    # 用户主动给出的标识先通过同空间运行表解析，正文、报告日志、截图或随环境保存的凭据都不进入模型。
    mentioned = [rid.lower() for rid in UUID_IN_TEXT.findall(text)[:8]]
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
            if problem.status not in {404, 410} and problem.code != "REPORT_LIMIT":
                raise
    allowed_ids = visible | versions | plan_ids | {r["runId"] for r in runs}
    for item in history:
        for field in ("text", "reply"):
            item[field] = UUID_IN_TEXT.sub(
                lambda match: (
                    match[0] if match[0].lower() in allowed_ids else "[unavailable reference]"
                ),
                item[field],
            )
    context: dict[str, Any] = {
        "request": text,
        "history": history,
        "plans": [{"id": p.id, **safe_plan(p)} for p in plans],
        "assets": assets,
        "runtimes": runtimes,
        "runs": runs,
    }
    if attachments:
        context["attachments"] = attachments
    # 长 Unicode 文本和角色名称按实际序列化字节计费，超限先舍弃最早轮次，再截掉排名靠后的候选项。
    for items in (history, assets, context["plans"], runtimes):
        while items and len(canonical_bytes(context)) > 65536:
            items.pop(0 if items is history else -1)
    if attachments and len(canonical_bytes(context)) > 65536:
        raise Problem(422, "AI_REQUEST_LIMIT", "Conversation context exceeds the attachment limit")
    return context
