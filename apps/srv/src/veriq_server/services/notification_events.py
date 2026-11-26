"""业务写事务在完成邀请、对话或运行转换时记录最小通知事件，并为符合当时条件的账号持久化接收范围。

已有安装写锁保证同一源事件的重复检查和 per-user 顺序分配串行执行；回滚后事件、接收记录和修订一并消失。
"""

from datetime import datetime, timedelta
from typing import Any, cast
from uuid import uuid4

from sqlalchemy import Select, func, insert, literal, select, update
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import Authorization, Permission
from ..db import (
    AgentSession,
    AgentTurn,
    ExecutionPlan,
    Notification,
    NotificationEvent,
    NotificationInboxState,
    Run,
    User,
    WorkspaceInvite,
    WorkspaceMember,
)

_AGENT_GRACE = timedelta(seconds=2)


async def notification_time(session: AsyncSession) -> datetime:
    """所有节点使用同一个 MySQL UTC 时钟记录事件及确认期限，主机时钟变化不能提前投递或延迟其他节点的读取。"""
    return cast(datetime, await session.scalar(select(func.utc_timestamp(6))))


async def _event(
    session: AsyncSession, workspace_id: str, kind: str, subject_id: str, payload: dict[str, Any]
) -> NotificationEvent | None:
    """调用方沿用安装写锁，即使同一业务转换收到重试，事件身份仍以工作区、类型和源对象三项共同确定。"""
    original = await session.scalar(
        select(NotificationEvent.id).where(
            NotificationEvent.workspace_id == workspace_id,
            NotificationEvent.kind == kind,
            NotificationEvent.subject_id == subject_id,
        )
    )
    if original is not None:
        return None
    event = NotificationEvent(
        id=str(uuid4()),
        workspace_id=workspace_id,
        kind=kind,
        subject_id=subject_id,
        occurred_at=await notification_time(session),
        payload=payload,
    )
    session.add(event)
    # 批量接收人由 SQL 直接插入，其外键指向本次刚建立的事件，先刷新同一事务中的可见性而不提前提交。
    await session.flush()
    return event


async def _deliver_immediately(
    session: AsyncSession, event: NotificationEvent, audience: Select[tuple[str]]
) -> None:
    """即时事件从同一事务中的接收范围批量分配收件箱位置，新增状态行、接收记录和可观察修订都不逐成员查询。"""
    people = audience.subquery()
    states = mysql_insert(NotificationInboxState).from_select(["user_id"], select(people.c.user_id))
    await session.execute(states.on_duplicate_key_update(user_id=NotificationInboxState.user_id))
    await session.execute(
        insert(Notification).from_select(
            ["id", "event_id", "user_id", "sequence", "deliver_at"],
            select(
                func.uuid(),
                literal(event.id),
                NotificationInboxState.user_id,
                NotificationInboxState.sequence + 1,
                literal(event.occurred_at),
            ).join(people, people.c.user_id == NotificationInboxState.user_id),
        )
    )
    # 只推进由本次事件成功写入的收件人版本，空受众不产生无关账号状态，节点读取器因而只唤醒受影响的连接。
    await session.execute(
        update(NotificationInboxState)
        .where(
            NotificationInboxState.user_id.in_(
                select(Notification.user_id).where(Notification.event_id == event.id)
            )
        )
        .values(
            sequence=NotificationInboxState.sequence + 1,
            revision=NotificationInboxState.revision + 1,
        )
    )


async def record_invitation(
    session: AsyncSession, invitation: WorkspaceInvite, inviter: User
) -> None:
    """把邀请转换投递给当时已注册且启用的同邮箱账号，只使用邀请标识和公开摘要，邮件链接凭证继续留在原签发路径。"""
    event = await _event(
        session,
        invitation.workspace_id,
        "WORKSPACE_INVITED",
        invitation.id,
        {"actorName": inviter.display_name},
    )
    if event is not None:
        await _deliver_immediately(
            session,
            event,
            select(User.id.label("user_id")).where(
                User.email == invitation.email, User.disabled.is_(False)
            ),
        )


async def record_agent_reply(
    session: AsyncSession, conversation: AgentSession, turn: AgentTurn
) -> None:
    """只为已经成功生成完整回复的轮次创建待投递记录，正文使用保存后的公共回复摘要，窗口可在数秒内确认实际展示。"""
    if turn.status != "COMPLETED" or not turn.reply:
        return
    preview = " ".join(turn.reply[:480].split())[:120]
    event = await _event(
        session,
        conversation.workspace_id,
        "AGENT_REPLY",
        turn.id,
        {"sessionId": conversation.id, "preview": preview},
    )
    if event is not None:
        session.add(
            Notification(
                id=str(uuid4()),
                event_id=event.id,
                user_id=conversation.user_id,
                deliver_at=event.occurred_at + _AGENT_GRACE,
            )
        )
        # 普通调用以提交为可见边界，显式刷新也让同一事务中的展示确认或重复入口能命中持久化记录。
        await session.flush()


async def record_run_transition(
    session: AsyncSession, run: Run, previous_state: str | None
) -> None:
    """运行通知跟随真实 Run 状态提交，只处理关联计划的首次领取和终态，保留取消与跳过等未开始便结束的事实。"""
    if run.plan_id is None or previous_state == run.state:
        return
    if run.state == "RUNNING" and previous_state == "QUEUED":
        kind = "RUN_STARTED"
    elif run.state == "FINISHED":
        kind = "RUN_FINISHED"
    else:
        return
    plan_name = await session.scalar(
        select(ExecutionPlan.name).where(
            ExecutionPlan.id == run.plan_id, ExecutionPlan.workspace_id == run.workspace_id
        )
    )
    if plan_name is None:
        return
    event = await _event(
        session,
        run.workspace_id,
        kind,
        run.id,
        {"planName": plan_name, "outcome": run.outcome if kind == "RUN_FINISHED" else None},
    )
    if event is not None:
        # 新加入的成员不会获得历史事件，权限的后续撤销由收件箱读取谓词过滤，源事务只快照事件时的合格会员。
        people = (
            select(WorkspaceMember.user_id)
            .join(User, User.id == WorkspaceMember.user_id)
            .where(
                WorkspaceMember.workspace_id == run.workspace_id,
                WorkspaceMember.status == "ACTIVE",
                WorkspaceMember.role.in_(Authorization.roles(Permission.VIEW)),
                User.disabled.is_(False),
            )
        )
        await _deliver_immediately(session, event, people)


async def invalidate_inbox(session: AsyncSession, user_id: str) -> None:
    """账号的成员关系或读取状态改变时仅推进已经存在的收件箱状态，空收件箱仍保留初始版本，无需制造通知。"""
    await session.execute(
        update(NotificationInboxState)
        .where(NotificationInboxState.user_id == user_id)
        .values(revision=NotificationInboxState.revision + 1)
    )


async def invalidate_workspace_inboxes(session: AsyncSession, workspace_id: str) -> None:
    """工作区名称和归档状态会影响通知展示，仅失效曾收到该空间通知的账号，关联读取和版本推进在原操作事务内完成。"""
    audience = (
        select(Notification.user_id)
        .join(NotificationEvent)
        .where(NotificationEvent.workspace_id == workspace_id)
    )
    await _invalidate_audience(session, audience)


async def invalidate_invitation_inbox(session: AsyncSession, invitation: WorkspaceInvite) -> None:
    """通过邮件链接消费或管理员吊销邀请时更新已有接收人的快照版本，不为这些操作写入未获批准的通知类型。"""
    audience = (
        select(Notification.user_id)
        .join(NotificationEvent)
        .where(
            NotificationEvent.workspace_id == invitation.workspace_id,
            NotificationEvent.kind == "WORKSPACE_INVITED",
            NotificationEvent.subject_id == invitation.id,
        )
    )
    await _invalidate_audience(session, audience)


async def _invalidate_audience(session: AsyncSession, audience: Select[tuple[str]]) -> None:
    """受众查询只读取接收记录，避免更新目标关联到自身子查询造成 MySQL 拒绝，同时令每个账号只变化一次。"""
    await session.execute(
        update(NotificationInboxState)
        .where(NotificationInboxState.user_id.in_(audience))
        .values(revision=NotificationInboxState.revision + 1)
    )
