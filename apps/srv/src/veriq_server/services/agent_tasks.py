"""后台跟踪器持久化私有任务，用短事务读取授权执行状态，等待期间不占用对话或模型调用预算。"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import Permission, WorkspaceScope
from ..db import AgentSession, AgentTask, AiGeneration, AiProvider, Database, Run, User
from ..service import Problem, audit
from ..settings import Settings
from .agent_task_analysis import analyze_task, require_report_metadata
from .ai_endpoints import endpoint_allowed
from .jobs import database_time
from .runs import RunService
from .workspace import WorkspaceRepository

_ACTIVE = ("QUEUED", "FOLLOWING", "ANALYZING")
_MAX_PER_USER = 8
_MAX_PER_WORKSPACE = 64
_CHECK_DELAY = timedelta(seconds=3)
_ANALYSIS_DEADLINE = timedelta(seconds=90)
_ANALYSIS_SLOTS = 4
_log = logging.getLogger("veriq.agent_tasks")


def task_dto(task: AgentTask, run: Run) -> dict[str, Any]:
    """只向已授权的会话返回任务和运行标识；完成后的结论来自运行记录，跟踪失败时仅返回固定错误码。"""
    result = {"id": task.id, "runId": run.id, "mode": task.mode, "state": task.state}
    if task.state in {"ANALYZING", "COMPLETED"} and run.outcome:
        result["outcome"] = run.outcome
    if task.error_code:
        result["errorCode"] = task.error_code
    return result


async def list_tasks(
    s: AsyncSession, owned: AgentSession, user: User, settings: Settings
) -> list[dict[str, Any]]:
    """按会话和工作区读取关联，优先返回活动任务，防止古老终态回执把仍可继续的后台工作挤出集合。"""
    query = (
        select(AgentTask, Run)
        .join(Run, Run.id == AgentTask.run_id)
        .where(AgentTask.session_id == owned.id, Run.workspace_id == owned.workspace_id)
        .order_by(AgentTask.state.in_(_ACTIVE).desc(), AgentTask.created_at.desc(), AgentTask.id)
        .limit(100)
    )
    return [
        await _visible_task(s, owned, user, settings, task, run)
        for task, run in await s.execute(query)
    ]


async def _visible_task(
    s: AsyncSession, owned: AgentSession, user: User, settings: Settings, task: AgentTask, run: Run
) -> dict[str, Any]:
    """跟踪事实始终来自 Run，分析正文还受当前编辑权限和对应模型配置约束，撤权不隐藏真实测试结果。"""
    result = task_dto(task, run)
    if task.analysis is None or not task.analysis_attempt_id:
        return result
    try:
        await WorkspaceRepository(s, WorkspaceScope(owned.workspace_id)).authorize(
            user, Permission.EDIT
        )
    except Problem:
        return result
    usage = await s.get(AiGeneration, task.analysis_attempt_id)
    provider = await s.get(AiProvider, usage.provider_id) if usage else None
    if (
        usage
        and usage.workspace_id == owned.workspace_id
        and usage.actor_id == user.id
        and usage.status == "SUCCEEDED"
        and not usage.data.get("metadataExpiredAt")
        and provider
        and provider.enabled
        and not provider.deleted
        and provider.revision == usage.data.get("providerRevision")
        and endpoint_allowed(settings, provider.config.get("baseURL"))
    ):
        try:
            await require_report_metadata(s, run)
        except Problem:
            pass
        else:
            result["analysis"] = task.analysis
    return result


async def follow_run(
    s: AsyncSession,
    owned: AgentSession,
    user: User,
    request_id: str,
    run_id: str,
    mode: str,
    *,
    analyze: bool = False,
    from_turn: bool = False,
) -> dict[str, Any]:
    """在调用方的安装写锁内检查工作区运行、请求参数与并发上限，确保确认回执和跟踪任务在同一事务生效。"""
    run = await RunService(s, user).get(owned.workspace_id, run_id.lower())
    if analyze:
        await WorkspaceRepository(s, WorkspaceScope(owned.workspace_id)).authorize(
            user, Permission.EDIT, write=True
        )
    request_id = ("turn:" if from_turn else "request:") + request_id.lower()
    task = await s.scalar(
        select(AgentTask).where(
            AgentTask.session_id == owned.id,
            AgentTask.request_id == request_id,
            AgentTask.mode == mode,
        )
    )
    if task:
        if task.run_id != run.id or task.analysis_requested != analyze:
            raise Problem(
                409, "IDEMPOTENCY_CONFLICT", "This request ID already follows a different Run"
            )
        return task_dto(task, run)
    task = await s.scalar(
        select(AgentTask).where(
            AgentTask.session_id == owned.id,
            AgentTask.run_id == run.id,
            AgentTask.state.in_(_ACTIVE),
        )
    )
    if task:
        # 保留每次请求的独立重放身份，调用端应复用仍在跟踪中的原始任务来避免并行订阅同一运行。
        raise Problem(
            409, "AGENT_TASK_ALREADY_FOLLOWING", "This session is already following the Run"
        )
    terminal = run.state == "FINISHED" and not analyze
    if not terminal:
        active = (
            select(func.count())
            .select_from(AgentTask)
            .join(AgentSession)
            .where(AgentTask.state.in_(_ACTIVE), AgentSession.workspace_id == owned.workspace_id)
        )
        workspace_count = await s.scalar(active)
        user_count = await s.scalar(active.where(AgentSession.user_id == user.id))
        if (workspace_count or 0) >= _MAX_PER_WORKSPACE or (user_count or 0) >= _MAX_PER_USER:
            raise Problem(429, "AGENT_TASK_LIMIT", "Too many active background tasks")
    observed = await database_time(s)
    task = AgentTask(
        id=str(uuid4()),
        session_id=owned.id,
        run_id=run.id,
        request_id=request_id,
        mode=mode,
        state="COMPLETED" if terminal else "QUEUED",
        created_at=observed,
        next_check_at=None if terminal else observed,
        analysis_requested=analyze,
    )
    s.add(task)
    audit(s, "agent.task_created", user.id, task.id, workspace_id=owned.workspace_id)
    return task_dto(task, run)


async def stop_task(s: AsyncSession, owned: AgentSession, task_id: str) -> dict[str, Any]:
    """仅停止当前会话下的活动跟踪行，与工作进程串行更新该行；不调用运行取消或修改真实执行记录。"""
    task = await s.scalar(
        select(AgentTask)
        .where(AgentTask.id == task_id.lower(), AgentTask.session_id == owned.id)
        .with_for_update()
    )
    run = await s.get(Run, task.run_id) if task else None
    if task is None or run is None or run.workspace_id != owned.workspace_id:
        raise Problem(404, "AGENT_TASK_NOT_FOUND", "Background task not found")
    if task.state in _ACTIVE:
        task.state, task.next_check_at = "STOPPED", None
        await _seal_usage(s, task)
        audit(s, "agent.task_stopped", owned.user_id, task.id, workspace_id=owned.workspace_id)
    return task_dto(task, run)


async def _take_due(db: Database, analysis_slots: int) -> tuple[int, list[tuple[str, datetime]]]:
    """领取已到检查时间的跟踪行并原子推进，实例重启可重读未提交的行，多实例跳过已锁定的待处理任务。"""
    async with db.sessions.begin() as s:
        observed = await database_time(s)
        query = (
            select(AgentTask)
            .where(AgentTask.next_check_at <= observed)
            .order_by(AgentTask.next_check_at, AgentTask.id)
            .limit(16)
            .with_for_update(skip_locked=True)
        )
        tasks = (await s.scalars(query)).all()
        claimed: list[tuple[str, datetime]] = []
        for task in tasks:
            deadline = await _refresh_task(s, task, observed, len(claimed) < analysis_slots)
            if deadline is not None:
                claimed.append((task.id, deadline))
        return len(tasks), claimed


async def _refresh_task(
    s: AsyncSession, task: AgentTask, observed: datetime, analyze: bool
) -> datetime | None:
    """再次核对员工持有的私有会话和运行，越权或不可读的任务只记终态及稳定错误，不产生模型请求。"""
    if task.state == "ANALYZING" and task.analysis_attempt_id:
        # 模型端可能已收费，超时接管只封存本次尝试及未知用量，绝不隐式发出第二个付费请求。
        await _seal_usage(s, task)
        task.state, task.error_code, task.next_check_at = (
            "COMPLETED",
            "AGENT_ANALYSIS_EXPIRED",
            None,
        )
        return None
    owned = await s.get(AgentSession, task.session_id)
    user = await s.get(User, owned.user_id) if owned else None
    if not user or not owned or owned.archived:
        task.state, task.error_code, task.next_check_at = "FAILED", "AGENT_TASK_UNAVAILABLE", None
        return None
    try:
        run = await RunService(s, user).get(owned.workspace_id, task.run_id)
    except Problem:
        task.state, task.error_code, task.next_check_at = "FAILED", "AGENT_TASK_UNAVAILABLE", None
        return None
    if run.state == "FINISHED":
        if not task.analysis_requested:
            task.state, task.next_check_at = "COMPLETED", None
        elif analyze:
            deadline = observed + _ANALYSIS_DEADLINE
            task.state, task.next_check_at = "ANALYZING", deadline
            return deadline
        else:
            task.state, task.next_check_at = "FOLLOWING", observed + _CHECK_DELAY
    else:
        task.state, task.next_check_at = "FOLLOWING", observed + _CHECK_DELAY
    return None


async def _seal_usage(s: AsyncSession, task: AgentTask) -> None:
    """终止尚在运行的费用记录但保留未知上游费用和预留金额；迟到回执仍可记录实际用量，无须重新调用模型。"""
    if task.analysis_attempt_id:
        usage = await s.get(AiGeneration, task.analysis_attempt_id)
        if usage and usage.status == "RUNNING":
            usage.status = "FAILED"


async def advance_tasks(db: Database, settings: Settings | None = None) -> int:
    """进行一批可重放的事实读取。付费分析需要部署配置，只在持久化领取提交后调用模型网关。"""
    count, claimed = await _take_due(db, _ANALYSIS_SLOTS if settings is not None else 0)
    if claimed and settings is not None:
        async with asyncio.TaskGroup() as group:
            for task_id, deadline in claimed:
                group.create_task(analyze_task(db, settings, task_id, expected_deadline=deadline))
    return count


async def serve_agent_tasks(db: Database, settings: Settings) -> None:
    """重复处理已到期的有界批次，连接异常时按同一间隔重试，未提交的任务仍由数据库保留供其它进程接管。"""

    async def analyze_one(task_id: str, deadline: datetime) -> None:
        """分析事务失败时保留到期围栏，其他任务与运行跟踪仍可继续，日志不记录模型上下文或数据库输入。"""
        try:
            await analyze_task(db, settings, task_id, expected_deadline=deadline)
        except Exception as error:
            _log.warning("Test Agent background analysis failed (%s)", type(error).__name__)

    pending: set[asyncio.Task[None]] = set()
    async with asyncio.TaskGroup() as group:
        while True:
            try:
                count, claimed = await _take_due(db, _ANALYSIS_SLOTS - len(pending))
            except SQLAlchemyError:
                _log.warning("Test Agent background task refresh failed")
                count, claimed = 0, []
            for task_id, deadline in claimed:
                running = group.create_task(analyze_one(task_id, deadline))
                pending.add(running)
                running.add_done_callback(pending.discard)
            if count < 16:
                await asyncio.sleep(1)
