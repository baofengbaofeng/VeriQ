"""使用独立的 MySQL 测试库验证收件箱持久化、租户权限和业务事务边界，测试自身不访问开发库或外部服务。"""

import asyncio
import json
import os
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import delete, update
from sqlalchemy.engine import make_url

from veriq_server.db import (
    AgentSession,
    AgentTurn,
    Database,
    Notification,
    User,
    Workspace,
    WorkspaceInvite,
    WorkspaceMember,
)
from veriq_server.migrate import migrate
from veriq_server.service import Problem, digest, lock_installation, now
from veriq_server.services.notification_events import record_agent_reply, record_invitation
from veriq_server.services.notification_inbox import (
    NotificationInbox,
    deliver_due_notifications,
    notification_revisions,
)
from veriq_server.settings import Settings


@pytest.fixture(name="inbox_store")
async def _inbox_store():
    """保留一份只属于专用集成测试的数据库连接，使用真实迁移兼顾已有安装与新表查询，每次测试通过新账号隔离历史数据。"""
    configured = os.environ.get("VERIQ_NOTIFICATION_TEST_DSN")
    if not configured:
        path = Path(".superpowers/sdd/veriq-1/test-env.json")
        configured = json.loads(path.read_text(encoding="utf-8"))["mysql_dsn"]
    assert make_url(configured).database in {"veriq_test", "veriq_notification_test"}
    settings = Settings(
        database_url=configured,
        public_url="http://127.0.0.1:8888",
        master_key="a" * 64,
        signing_key="b" * 64,
        environment="development",
    )
    await migrate(settings)
    database = Database(settings)
    try:
        async with database.sessions.begin() as session:
            suffix = uuid4().hex
            people = [
                User(
                    id=str(uuid4()),
                    email=f"{role}-{suffix}@example.test",
                    display_name=role,
                    password_hash="unusable",
                    disabled=False,
                    system_admin=False,
                    created_at=now(),
                )
                for role in ("owner", "guest", "outsider")
            ]
            workspace = Workspace(
                id=str(uuid4()),
                key=f"test-{suffix}",
                name="Notification Workspace",
                created_at=now(),
            )
            session.add_all([*people, workspace])
            await session.flush()
            session.add(
                WorkspaceMember(
                    workspace_id=workspace.id, user_id=people[0].id, role="OWNER", status="ACTIVE"
                )
            )
        yield database, settings, workspace, people
    finally:
        await database.close()


async def make_invite(session, workspace, owner, guest):
    """插入带摘要的真实邀请并调用同一个事务写入点，单元边界之外的签发鉴权与站内快速接受分别交给真实 API 回归。"""
    identifier = str(uuid4())
    invite = WorkspaceInvite(
        id=identifier,
        workspace_id=workspace.id,
        email=guest.email,
        role="VIEWER",
        token_hash=digest(identifier),
        expires_at=now() + timedelta(days=7),
        created_at=now(),
        consumed=False,
        revoked=False,
    )
    session.add(invite)
    await session.flush()
    await record_invitation(session, invite, owner)
    return invite


async def test_inbox_rollback_scope_and_mark_all_watermark(inbox_store):
    """通知与邀请业务事务共同回滚，多页全部已读仅标记服务器此前签发的水位，随后投递仍未读且不能跨账号重放。"""
    database, settings, workspace, (owner, guest, outsider) = inbox_store
    async with database.sessions() as session:
        await lock_installation(session)
        await make_invite(session, workspace, owner, guest)
        await session.rollback()
    async with database.sessions.begin() as session:
        assert not (await NotificationInbox(session, guest, settings).list(None, 1, False))["items"]
        await lock_installation(session)
        await make_invite(session, workspace, owner, guest)
        await make_invite(session, workspace, owner, guest)
    async with database.sessions.begin() as session:
        inbox = NotificationInbox(session, guest, settings)
        snapshot = await inbox.list(None, 1, False)
        assert len(snapshot["items"]) == 1 and snapshot["unreadCount"] == 2
        assert len((await inbox.list(snapshot["nextCursor"], 1, False))["items"]) == 1
        hostile = NotificationInbox(session, outsider, settings)
        with pytest.raises(Problem) as denied:
            await hostile.detail(snapshot["items"][0]["id"])
        assert denied.value.status == 404
        with pytest.raises(Problem) as rejected:
            await hostile.read_all(snapshot["readThrough"])
        assert rejected.value.status == 400
    async with database.sessions.begin() as session:
        await lock_installation(session)
        await make_invite(session, workspace, owner, guest)
    async with database.sessions.begin() as session:
        inbox = NotificationInbox(session, guest, settings)
        assert await inbox.read_all(snapshot["readThrough"]) == {"updated": 2}
        assert await inbox.read_all(snapshot["readThrough"]) == {"updated": 0}
        assert (await inbox.list(None, 25, False))["unreadCount"] == 1


async def test_notification_quick_accept_rechecks_recipient_and_is_idempotent(inbox_store):
    """快速接受使用与原邀请链接一致的加入约束，已处理通知可重复请求，其他账号即使知道收件箱编号仍无法加入对应空间。"""
    database, settings, workspace, (owner, guest, outsider) = inbox_store
    async with database.sessions.begin() as session:
        await lock_installation(session)
        await make_invite(session, workspace, owner, guest)
        await make_invite(session, workspace, owner, guest)
    async with database.sessions.begin() as session:
        inbox = NotificationInbox(session, guest, settings)
        item, duplicate = (await inbox.list(None, 25, False))["items"]
        assert item["invitationStatus"] == "PENDING" and "token" not in str(item).lower()
        with pytest.raises(Problem) as denied:
            await NotificationInbox(session, outsider, settings).accept(item["id"])
        assert denied.value.status == 404
        assert await inbox.accept(item["id"]) == {"workspaceId": workspace.id}
        assert await inbox.accept(item["id"]) == {"workspaceId": workspace.id}
        updated = await inbox.detail(item["id"])
        assert updated["invitationStatus"] == "ACCEPTED" and updated["readAt"]
        assert (await inbox.detail(duplicate["id"]))["invitationStatus"] == "UNAVAILABLE"
        with pytest.raises(Problem) as already_member:
            await inbox.accept(duplicate["id"])
        assert already_member.value.code == "MEMBER_EXISTS"


async def _make_replies(database, workspace, owner, *identifiers):
    """以真实的会话所有权和完成轮次建立待投递消息，确认路径和扫描节点读取的是同一数据库事实与收件人。"""
    session_id = str(uuid4())
    async with database.sessions.begin() as session:
        await lock_installation(session)
        conversation = AgentSession(
            id=session_id,
            workspace_id=workspace.id,
            user_id=owner.id,
            title="Private conversation",
            created_at=now(),
            archived=False,
        )
        session.add(conversation)
        await session.flush()
        for identifier in identifiers:
            turn = AgentTurn(
                id=identifier,
                session_id=session_id,
                request_id=str(uuid4()),
                status="COMPLETED",
                text="Private prompt",
                reply="答" * 135,
                created_at=now(),
            )
            session.add(turn)
            await session.flush()
            await record_agent_reply(session, conversation, turn)
    return session_id


async def _bring_deliveries_due(database, owner):
    """直接调整测试接收记录的 UTC 到期时间，保留实际扫描和分配过程，测试无须等待通知的宽限窗口流逝。"""
    async with database.sessions.begin() as session:
        await session.execute(
            update(Notification).where(Notification.user_id == owner.id).values(deliver_at=now())
        )


async def test_agent_seen_and_revoked_membership_across_deliverers(inbox_store):
    """同一持久回复不会被两个扫描节点重复投递，确认已展示的回复及失去成员资格的历史消息均不增加未读。"""
    database, settings, workspace, (owner, _, outsider) = inbox_store
    early, late = str(uuid4()), str(uuid4())
    session_id = await _make_replies(database, workspace, owner, early, late)
    async with database.sessions.begin() as session:
        inbox = NotificationInbox(session, owner, settings)
        assert await inbox.agent_seen(workspace.id, session_id, early) == {"acknowledged": True}
        assert (await inbox.list(None, 25, False))["unreadCount"] == 0

    await _bring_deliveries_due(database, owner)

    async def poll_node():
        """为每个扫描节点开启各自独立的事务，真实模拟同时领取单条到期回复时数据库提供的并发保护。"""
        async with database.sessions.begin() as session:
            await deliver_due_notifications(session)

    await asyncio.gather(poll_node(), poll_node())
    async with database.sessions.begin() as session:
        inbox = NotificationInbox(session, owner, settings)
        items = (await inbox.list(None, 25, False))["items"]
        assert [(item["turnId"], item["preview"]) for item in items] == [(late, "答" * 120)]
        assert await NotificationInbox(session, outsider, settings).agent_seen(
            workspace.id, session_id, late
        ) == {
            "acknowledged": False,
        }
        assert await inbox.agent_seen(workspace.id, session_id, late) == {"acknowledged": True}
        assert (await inbox.list(None, 25, False))["unreadCount"] == 0
        await session.execute(delete(WorkspaceMember).where(WorkspaceMember.user_id == owner.id))
        assert not (await inbox.list(None, 25, False))["items"]


async def test_agent_due_delivery_rechecks_membership_before_version_change(inbox_store):
    """收到完整回复后若立即被撤销成员资格，后台扫描必须抑制尚未投递的记录，防止跨节点推送可观察的未授权变更。"""
    database, settings, workspace, (owner, _, _) = inbox_store
    await _make_replies(database, workspace, owner, str(uuid4()))
    await _bring_deliveries_due(database, owner)
    async with database.sessions.begin() as session:
        await session.execute(delete(WorkspaceMember).where(WorkspaceMember.user_id == owner.id))
        assert await deliver_due_notifications(session)
        assert await notification_revisions(session, [owner.id]) == {owner.id: "0"}
        session.add(
            WorkspaceMember(
                workspace_id=workspace.id, user_id=owner.id, role="OWNER", status="ACTIVE"
            )
        )
        assert not (await NotificationInbox(session, owner, settings).list(None, 25, False))[
            "items"
        ]
