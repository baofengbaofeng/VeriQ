"""个人收件箱服务投影当前可见的业务事件，对单条访问、快捷操作与全部已读使用相同的账号和租户约束。

睡眠或断线由传输层管理。本模块只在有界事务内访问数据库，返回稳定通知 DTO 或域错误，避免将业务正文送进 SSE。
"""

import json
from collections.abc import Iterable
from datetime import datetime
from typing import Any, cast

from sqlalchemy import SQLColumnExpression, Select, and_, false, func, or_, select, update
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.engine import CursorResult
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement
from tornado.web import create_signed_value, decode_signed_value

from ..auth.authorization import Authorization, Permission, WorkspaceScope
from ..db import (
    AgentSession,
    AgentTurn,
    Notification,
    NotificationEvent,
    NotificationInboxState,
    User,
    Workspace,
    WorkspaceInvite,
    WorkspaceMember,
)
from ..service import Problem, lock_installation, stamp
from ..settings import Settings
from .notification_events import invalidate_inbox, notification_time
from .workspace import WorkspaceRepository, add_invited_member, require_open_invitation

_CURSOR = "veriq_inbox_cursor_v1"
_READ_THROUGH = "veriq_inbox_read_through_v1"
# 查询结果的内部行形状固定，左连接仅使邀请或对话信息为空，发给浏览器前由事件类型决定实际公开字段。
InboxRow = tuple[
    Notification, NotificationEvent, Workspace, WorkspaceInvite | None, AgentSession | None, bool
]


def _membership(
    user_id: str | SQLColumnExpression[str], workspace_id: SQLColumnExpression[str]
) -> ColumnElement[bool]:
    """数据库投影必须与单条报告授权共享角色允许列表，系统管理员与已失效成员均不能借用通知记录访问工作区。"""
    return (
        select(WorkspaceMember.user_id)
        .where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.user_id == user_id,
            WorkspaceMember.status == "ACTIVE",
            WorkspaceMember.role.in_(Authorization.roles(Permission.VIEW)),
        )
        .exists()
    )


def _with_email(user: User) -> ColumnElement[bool]:
    """邀请允许尚未成为成员的当前受邀账号读取，同时把匹配绑定到实时邮箱和邀请工作区防止读到旁人的邀请。"""
    return (
        select(WorkspaceInvite.id)
        .where(
            WorkspaceInvite.id == NotificationEvent.subject_id,
            WorkspaceInvite.workspace_id == NotificationEvent.workspace_id,
            WorkspaceInvite.email == user.email,
        )
        .correlate(NotificationEvent)
        .exists()
    )


def _owns_reply(user_id: str | SQLColumnExpression[str]) -> ColumnElement[bool]:
    """仅匹配本人工作区中的已经完整保存的轮次，会话标识和源轮次标识必须同时对应同一密封业务记录。"""
    return (
        select(AgentTurn.id)
        .join(AgentSession, AgentSession.id == AgentTurn.session_id)
        .where(
            AgentTurn.id == NotificationEvent.subject_id,
            AgentTurn.status == "COMPLETED",
            AgentSession.user_id == user_id,
            AgentSession.workspace_id == NotificationEvent.workspace_id,
        )
        .correlate(NotificationEvent, Notification)
        .exists()
    )


def _visible(user: User) -> ColumnElement[bool]:
    """统一列表、详情与修改的可见性边界，邀请使用账号邮箱验证，其他事件持续要求当前工作区成员身份。"""
    if user.disabled:
        return false()
    return or_(
        and_(NotificationEvent.kind == "WORKSPACE_INVITED", _with_email(user)),
        and_(
            _membership(user.id, NotificationEvent.workspace_id),
            or_(
                NotificationEvent.kind.in_(("RUN_STARTED", "RUN_FINISHED")),
                and_(
                    NotificationEvent.kind == "AGENT_REPLY",
                    _owns_reply(user.id),
                ),
            ),
        ),
    )


def _pending() -> ColumnElement[bool]:
    """待投递索引只匹配尚未分配序号且未被 Agent 展示确认抑制的记录，正好对应两个合法终态之前的唯一状态。"""
    return and_(Notification.sequence.is_(None), Notification.suppressed_at.is_(None))


def _dto(row: InboxRow, current: datetime) -> dict[str, Any]:
    """平铺事件摘要和当前目标的公开字段，邀请明文及 Agent 提示词从不进入该结构，文本展示由客户端保持纯文本。"""
    notice, event, workspace, invitation, conversation, already_member = row
    result: dict[str, Any] = {
        "id": notice.id,
        "kind": event.kind,
        "workspaceId": workspace.id,
        "workspaceName": workspace.name,
        "occurredAt": stamp(event.occurred_at),
        "readAt": stamp(notice.read_at) if notice.read_at else None,
    }
    if event.kind == "WORKSPACE_INVITED" and invitation is not None:
        # 终态按服务端时钟与权威记录派生，接受一份邀请后其余邀请仍保留历史，当前成员入口由真实成员关系决定。
        status = (
            "REVOKED"
            if invitation.revoked
            else (
                "ACCEPTED"
                if invitation.consumed
                else (
                    "EXPIRED"
                    if invitation.expires_at <= current
                    else "UNAVAILABLE" if workspace.archived or already_member else "PENDING"
                )
            )
        )
        result.update(
            invitationId=invitation.id,
            actorName=event.payload["actorName"],
            invitationRole=invitation.role,
            invitationStatus=status,
        )
    elif event.kind == "AGENT_REPLY" and conversation is not None:
        result.update(
            sessionId=conversation.id,
            turnId=event.subject_id,
            sessionTitle=conversation.title,
            preview=event.payload["preview"],
        )
    else:
        result.update(
            runId=event.subject_id,
            planName=event.payload["planName"],
            outcome=event.payload["outcome"],
        )
    return result


class NotificationInbox:
    """服务绑定独立事务当前认证用户，后端签发的标记范围不能跨账号重用，客户端不指定目标收件人的权限域。"""

    def __init__(self, session: AsyncSession, user: User, settings: Settings):
        """保存认证主体与同源游标签名密钥，读取始终以当前账号为主键，写入调用方沿用现有认证事务及安装护栏。"""
        self.session = session
        self.user = user
        self.secret = settings.signing_key.get_secret_value()

    def _scope(self) -> ColumnElement[bool]:
        """只选择已投递到当前用户且仍可访问的记录，未到期 Agent 事件不会出现在列表、计数或单条读取接口。"""
        return and_(
            Notification.user_id == self.user.id,
            Notification.sequence.is_not(None),
            _visible(self.user),
        )

    def _rows(self) -> Select[InboxRow]:
        """批量加载列表所需的关联公开信息，使用单个有序查询避免每条消息访问一次关联业务或绕过投影中的权限。"""
        # 接受邀请与授权读取不同，拥有任意成员状态都会阻断再次加入，此检查不能复用仅匹配活跃成员的可见性谓词。
        existing_member = (
            select(WorkspaceMember.user_id)
            .where(
                WorkspaceMember.workspace_id == NotificationEvent.workspace_id,
                WorkspaceMember.user_id == self.user.id,
            )
            .correlate(NotificationEvent)
            .exists()
        )
        query = (
            select(
                Notification,
                NotificationEvent,
                Workspace,
                WorkspaceInvite,
                AgentSession,
                existing_member,
            )
            .join(NotificationEvent, NotificationEvent.id == Notification.event_id)
            .join(Workspace, Workspace.id == NotificationEvent.workspace_id)
            .outerjoin(
                WorkspaceInvite,
                and_(
                    NotificationEvent.kind == "WORKSPACE_INVITED",
                    WorkspaceInvite.id == NotificationEvent.subject_id,
                    WorkspaceInvite.workspace_id == NotificationEvent.workspace_id,
                ),
            )
            .outerjoin(
                AgentTurn,
                and_(
                    NotificationEvent.kind == "AGENT_REPLY",
                    AgentTurn.id == NotificationEvent.subject_id,
                ),
            )
            .outerjoin(
                AgentSession,
                and_(
                    AgentSession.id == AgentTurn.session_id,
                    AgentSession.workspace_id == NotificationEvent.workspace_id,
                    AgentSession.user_id == self.user.id,
                ),
            )
            .where(self._scope())
        )
        # SQLAlchemy 的类型系统无法从左连接推断外侧实体可空，显式声明两类事件实际返回的联合行形状。
        return cast(Select[InboxRow], query)

    def _sign(self, name: str, sequence: int, unread: bool = False) -> str:
        """投递水位和翻页游标使用不同签名用途，同一数字位置不可替换成另一种操作的授权范围或绕过筛选条件。"""
        payload = json.dumps([self.user.id, sequence, unread], separators=(",", ":"))
        return create_signed_value(self.secret, name, payload, version=2).decode()

    def _position(self, name: str, token: str, code: str, unread: bool = False) -> int:
        """完整校验签名、账号、筛选和有限整数范围，布尔值虽然是 Python 整数子类型但不代表合法数据库位置。"""
        if token and len(token) <= 4096:
            raw = decode_signed_value(self.secret, name, token, max_age_days=1, min_version=2)
            if raw:
                try:
                    owner, sequence, mode = json.loads(raw)
                    if (
                        owner == self.user.id
                        and mode is unread
                        and isinstance(sequence, int)
                        and not isinstance(sequence, bool)
                        and 0 <= sequence < 2**63
                    ):
                        return sequence
                except (TypeError, ValueError):
                    pass
        raise Problem(400, code, "Notification position is invalid or expired")

    async def list(self, cursor: str | None, limit: int, unread: bool) -> dict[str, Any]:
        """用同一投递水位约束分页与未读查询，后续并发到达的通知不会被旧水位覆盖，其他节点的已读变更通过实时流刷新。"""
        if not 1 <= limit <= 100:
            raise Problem(400, "INVALID_LIMIT", "Page limit must be an integer from 1 to 100")
        current = await notification_time(self.session)
        watermark = (
            await self.session.scalar(
                select(NotificationInboxState.sequence).where(
                    NotificationInboxState.user_id == self.user.id
                )
            )
            or 0
        )
        query = self._rows().where(Notification.sequence <= watermark)
        if cursor is not None:
            query = query.where(
                Notification.sequence < self._position(_CURSOR, cursor, "INVALID_CURSOR", unread)
            )
        if unread:
            query = query.where(Notification.read_at.is_(None))
        rows = (
            (
                await self.session.execute(
                    query.order_by(Notification.sequence.desc()).limit(limit + 1)
                )
            )
            .tuples()
            .all()
        )
        count = await self.session.scalar(
            select(func.count())
            .select_from(Notification)
            .join(NotificationEvent)
            .where(
                self._scope(), Notification.read_at.is_(None), Notification.sequence <= watermark
            )
        )
        result: dict[str, Any] = {
            "items": [_dto(row, current) for row in rows[:limit]],
            "unreadCount": count or 0,
            "readThrough": self._sign(_READ_THROUGH, watermark),
        }
        if len(rows) > limit:
            position = rows[limit - 1][0].sequence
            assert position is not None
            result["nextCursor"] = self._sign(_CURSOR, position, unread)
        return result

    async def _get(self, notification_id: str) -> InboxRow:
        """跨用户、未投递或已失权通知统一回复找不到，使知道任意记录标识无法区分目标存在性或获取事件数据。"""
        row = (
            (
                await self.session.execute(
                    self._rows().where(Notification.id == notification_id.lower())
                )
            )
            .tuples()
            .one_or_none()
        )
        if row is None:
            raise Problem(404, "NOTIFICATION_NOT_FOUND", "Notification not found")
        return row

    async def detail(self, notification_id: str) -> dict[str, Any]:
        """详情从业务投影读取最新已读和邀请状态，直接访问与列表一致地检查当前用户及授权，不产生读取副作用。"""
        return _dto(await self._get(notification_id), await notification_time(self.session))

    async def _mark(self, notice: Notification, current: datetime) -> None:
        """首次读取更新 UTC 时间与持久化版本，重试保留原时间，新版本只在拓扑中存在对其它标签页有意义的变更时产生。"""
        if notice.read_at is None:
            notice.read_at = current
            await invalidate_inbox(self.session, self.user.id)

    async def read(self, notification_id: str) -> dict[str, Any]:
        """在全局写入护栏内核验当前权限并原子标记，收到旧页面操作时仍拒绝不可见记录，响应可用于刷新本地列表。"""
        await lock_installation(self.session)
        row = await self._get(notification_id)
        current = await notification_time(self.session)
        await self._mark(row[0], current)
        return _dto(row, current)

    async def read_all(self, through: str) -> dict[str, Any]:
        """按服务器签发的位置范围单次更新现有可见消息，实现跨页全部已读，当前用户未见过的较新消息保留原状态。"""
        position = self._position(_READ_THROUGH, through, "INVALID_READ_THROUGH")
        await lock_installation(self.session)
        event_scope = select(NotificationEvent.id).where(_visible(self.user))
        result = cast(
            CursorResult[Any],
            await self.session.execute(
                update(Notification)
                .where(
                    Notification.user_id == self.user.id,
                    Notification.sequence <= position,
                    Notification.read_at.is_(None),
                    Notification.event_id.in_(event_scope),
                )
                .values(read_at=await notification_time(self.session))
                .execution_options(synchronize_session=False)
            ),
        )
        if result.rowcount:
            await invalidate_inbox(self.session, self.user.id)
        return {"updated": result.rowcount}

    async def accept(self, notification_id: str) -> dict[str, Any]:
        """按通知所属账号接受邀请，持有同一安装锁复查邀请和成员状态，失败时工作区写入与已读状态均保持原样。"""
        await lock_installation(self.session)
        notice, event, workspace, invitation, _, _ = await self._get(notification_id)
        if event.kind != "WORKSPACE_INVITED" or invitation is None:
            raise Problem(404, "NOTIFICATION_NOT_FOUND", "Invitation notification not found")
        if invitation.consumed and not invitation.revoked and not workspace.archived:
            repo = WorkspaceRepository(self.session, WorkspaceScope(workspace.id))
            member = await repo.member(self.user.id)
            if member is None or member.status != "ACTIVE":
                raise Problem(400, "INVALID_INVITATION", "Invitation is invalid or expired")
        else:
            repo = await require_open_invitation(self.session, invitation)
            await add_invited_member(repo, invitation, self.user)
        await self._mark(notice, await notification_time(self.session))
        return {"workspaceId": workspace.id}

    async def agent_seen(self, workspace_id: str, session_id: str, turn_id: str) -> dict[str, Any]:
        """只接受本人会话已完成回复的可见确认。确认较早时抑制待投递项，已实际投递时转换为普通已读。"""
        await lock_installation(self.session)
        notice = await self.session.scalar(
            select(Notification)
            .join(NotificationEvent)
            .where(
                Notification.user_id == self.user.id,
                NotificationEvent.kind == "AGENT_REPLY",
                NotificationEvent.workspace_id == workspace_id.lower(),
                NotificationEvent.subject_id == turn_id.lower(),
                NotificationEvent.payload["sessionId"].as_string() == session_id.lower(),
                _visible(self.user),
            )
        )
        if notice is None:
            return {"acknowledged": False}
        current = await notification_time(self.session)
        if notice.sequence is not None:
            await self._mark(notice, current)
        elif notice.suppressed_at is None:
            notice.suppressed_at = current
        return {"acknowledged": True}


async def notification_revisions(session: AsyncSession, user_ids: Iterable[str]) -> dict[str, str]:
    """批量获取活跃连接用户的版本，缺省收件箱始终返回零，十进制字符串避免浏览器丢失数据库整数精度。"""
    states = dict.fromkeys(user_ids, "0")
    if states:
        rows = await session.execute(
            select(NotificationInboxState.user_id, NotificationInboxState.revision).where(
                NotificationInboxState.user_id.in_(states)
            )
        )
        states.update((user_id, str(revision)) for user_id, revision in rows)
    return states


async def deliver_due_notifications(session: AsyncSession, limit: int = 100) -> bool:
    """后台节点分别检查有限待投递批次，只有确有任务时才申请安装写锁，再以锁定读复查避免重复发号。"""
    due = select(Notification).where(_pending(), Notification.deliver_at <= func.utc_timestamp(6))
    if await session.scalar(due.with_only_columns(Notification.id).limit(1)) is None:
        return False
    await lock_installation(session)
    pending = (
        await session.scalars(
            due.order_by(Notification.deliver_at, Notification.id).limit(limit).with_for_update()
        )
    ).all()
    if not pending:
        return True
    # 对话已完成到实际投递之间可能移除成员或禁用账户，批量重验受众，失权记录不会产生可观察的收件箱变化。
    allowed = set(
        await session.scalars(
            select(Notification.id)
            .join(NotificationEvent)
            .join(User, User.id == Notification.user_id)
            .where(
                Notification.id.in_([notice.id for notice in pending]),
                User.disabled.is_(False),
                NotificationEvent.kind == "AGENT_REPLY",
                _membership(Notification.user_id, NotificationEvent.workspace_id),
                _owns_reply(Notification.user_id),
            )
        )
    )
    current = await notification_time(session)
    for notice in pending:
        if notice.id not in allowed:
            notice.suppressed_at = current
    if allowed:
        # 同一账号可能有多个待投递事件，只批量初始化和读取一次，缩短与运行及权限写入共享的安装锁持有时间。
        user_ids = sorted({notice.user_id for notice in pending if notice.id in allowed})
        insert_state = mysql_insert(NotificationInboxState).values(
            [{"user_id": user_id} for user_id in user_ids]
        )
        await session.execute(
            insert_state.on_duplicate_key_update(user_id=NotificationInboxState.user_id)
        )
        states = {
            state.user_id: state
            for state in await session.scalars(
                select(NotificationInboxState)
                .where(NotificationInboxState.user_id.in_(user_ids))
                .order_by(NotificationInboxState.user_id)
                .with_for_update()
            )
        }
        # 按待投递创建顺序在同一账号内分配位置，失败回滚状态和实际消息写入，收件箱不会遗漏已经承诺的投递位置。
        for notice in pending:
            if notice.id not in allowed:
                continue
            state = states[notice.user_id]
            state.sequence += 1
            state.revision += 1
            notice.sequence = state.sequence
    return True
