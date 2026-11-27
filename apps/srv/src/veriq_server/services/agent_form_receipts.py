"""来自私有轮次的表单请求随领域事务保存经验证的精简回执，普通请求不关联对话。"""

import re
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import WorkspaceScope
from ..db import AgentFormReceipt, AgentSession, AgentTurn, User
from ..service import Problem, now, stamp
from .agent_capabilities import authorize_workspace_form

FORM_ORIGIN_HEADER = "X-VeriQ-Agent-Form"
MAX_TURN_FORM_RECEIPTS = 10
_UUID = re.compile(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}")


async def record_form_receipt(
    session: AsyncSession,
    origin: str | None,
    user: User,
    workspace_id: str,
    *,
    action: str,
    target_id: str,
    capability: str,
    revision: int | None = None,
) -> None:
    """确认当前员工拥有活跃会话和准确的已保存表单，将业务事实记录在调用方现有的写事务中。"""
    if origin is None:
        return
    if not _UUID.fullmatch(origin):
        raise Problem(404, "AGENT_FORM_NOT_FOUND", "Workspace form not found")
    source = await session.scalar(
        select(AgentTurn.id)
        .join(AgentSession, AgentTurn.session_id == AgentSession.id)
        .where(
            AgentTurn.id == origin.lower(),
            AgentTurn.status == "COMPLETED",
            AgentTurn.workspace_capability == capability,
            AgentSession.workspace_id == workspace_id,
            AgentSession.user_id == user.id,
            AgentSession.archived.is_(False),
        )
        .with_for_update()
    )
    if source is None:
        raise Problem(404, "AGENT_FORM_NOT_FOUND", "Workspace form not found")
    await authorize_workspace_form(
        session, WorkspaceScope(workspace_id), user, capability, opening=True
    )
    session.add(
        AgentFormReceipt(
            id=str(uuid4()),
            turn_id=source,
            action=action,
            target_id=target_id,
            revision=revision,
            created_at=now(),
        )
    )


async def list_form_receipts(
    session: AsyncSession,
    scope: WorkspaceScope,
    user: User,
    turn: AgentTurn,
    *,
    for_model: bool = False,
) -> list[dict[str, Any]]:
    """调用方已验证会话归属；只在当前仍具备领域权限时返回最近的有界结果。"""
    capability = turn.workspace_capability
    if turn.status != "COMPLETED" or not capability:
        return []
    try:
        await authorize_workspace_form(session, scope, user, capability, opening=False)
    except Problem:
        return []
    rows = (
        await session.scalars(
            select(AgentFormReceipt)
            .where(AgentFormReceipt.turn_id == turn.id)
            .order_by(AgentFormReceipt.created_at.desc(), AgentFormReceipt.id.desc())
            .limit(3 if for_model else MAX_TURN_FORM_RECEIPTS)
        )
    ).all()

    result = []
    for row in reversed(rows):
        item: dict[str, Any] = {
            "action": row.action,
            "capability": capability,
            "createdAt": stamp(row.created_at),
        }
        if not for_model:
            item["id"] = row.id
        if not for_model or capability in {"ENVIRONMENT", "FIXTURE", "HTTP_DATASET"}:
            item["targetId"] = row.target_id
            if row.revision is not None:
                item["revision"] = row.revision
        result.append(item)
    return result
