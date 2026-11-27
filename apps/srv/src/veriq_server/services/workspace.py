"""Workspace 仓储与 DTO：在 scope 内读取租户、成员与邀请，并执行角色授权与最后 Owner 保护，防止拆空所有权。authorize
组合成员角色与 Permission；protect_user_disable

拒绝禁用仍为唯一 Owner 的用户。DTO 只导出稳定对外字段，永不包含邀请或会话令牌明文。
"""

from typing import Any
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import Actor, Authorization, Permission, WorkspaceScope
from ..db import User, Workspace, WorkspaceMember, WorkspaceInvite
from ..service import Problem, audit, stamp, now
from .notification_events import invalidate_inbox, notification_time


class WorkspaceRepository:
    """绑定会话与 WorkspaceScope，提供 get/member/authorize/invite 与 Owner 保护原语。WorkspaceRepository 必须坚持
    Workspace 归属与成员授权，

    嵌套资源引用不得跨空间隐式放行。
    """

    def __init__(self, session: AsyncSession, scope: WorkspaceScope):
        """保存会话与作用域，后续查询一律携带 workspace_id 谓词，WorkspaceRepository.__init__ 遵守本文件
        Workspace/事务边界。
        __init__ 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        self.session, self.scope = session, scope

    async def get(self) -> Workspace:
        """加载当前 scope 的 Workspace 行，供授权与成员流程复用，WorkspaceRepository.get 遵守本文件 Workspace/事务边界。
        get 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        workspace = await self.session.get(Workspace, self.scope.workspace_id)
        if workspace is None:
            raise Problem(404, "WORKSPACE_NOT_FOUND", "Workspace not found")
        return workspace

    async def member(self, user_id: str) -> WorkspaceMember | None:
        """返回指定用户在本 Workspace 的成员行，不存在则为 None，WorkspaceRepository.member 遵守本文件 Workspace/事务边
        界。
        member 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        return await self.session.get(WorkspaceMember, (self.scope.workspace_id, user_id))

    async def authorize(
        self, user: User, permission: Permission = Permission.VIEW, *, write: bool = False
    ) -> tuple[Workspace, Actor]:
        """校验活跃成员后按 Permission 要求角色，失败抛出 WORKSPACE_FORBIDDEN，WorkspaceRepository.authorize 遵守本文件
        Workspace/事务边界。
        authorize 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        member = await self.member(user.id)
        actor = Actor(
            user.id,
            self.scope.workspace_id,
            member.role if member else "",
            bool(member and member.status == "ACTIVE" and not user.disabled),
        )
        Authorization.require(actor, self.scope, permission)
        workspace = await self.get()
        if write and workspace.archived:
            raise Problem(409, "WORKSPACE_ARCHIVED", "Workspace is archived")
        return workspace, actor

    async def invite(self, invitation_id: str) -> WorkspaceInvite:
        """按邀请 ID 读取本 Workspace 邀请，供接受或吊销流程使用，WorkspaceRepository.invite 遵守本文件 Workspace/事务边
        界。
        invite 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        invite = (
            await self.session.execute(
                select(WorkspaceInvite).where(
                    WorkspaceInvite.workspace_id == self.scope.workspace_id,
                    WorkspaceInvite.id == invitation_id,
                )
            )
        ).scalar_one_or_none()
        if not invite:
            raise Problem(404, "INVITATION_NOT_FOUND", "Invitation not found")
        return invite

    async def protect_owner(self, user_id: str) -> None:
        """阻止移除或降级最后一位 OWNER，避免 Workspace 失去所有权锚点，WorkspaceRepository.protect_owner 遵守本文件
        Workspace/事务边界。
        protect_owner 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        member = await self.member(user_id)
        if not member or member.role != "OWNER" or member.status != "ACTIVE":
            return
        workspace = await self.get()
        if workspace.archived:
            return
        count = (
            await self.session.execute(
                select(func.count())
                .select_from(WorkspaceMember)
                .join(User, User.id == WorkspaceMember.user_id)
                .where(
                    WorkspaceMember.workspace_id == self.scope.workspace_id,
                    WorkspaceMember.role == "OWNER",
                    WorkspaceMember.status == "ACTIVE",
                    User.disabled.is_(False),
                    User.id != user_id,
                )
            )
        ).scalar_one()
        if count == 0:
            raise Problem(409, "LAST_OWNER", "Assign another enabled OWNER first")


async def require_open_invitation(
    session: AsyncSession, invitation: WorkspaceInvite | None
) -> WorkspaceRepository:
    """链接与站内快捷入口共用邀请终态、数据库到期时钟和空间归档校验，调用方在现有安装护栏内验证各自凭据。"""
    if (
        not invitation
        or invitation.consumed
        or invitation.revoked
        or invitation.expires_at <= await notification_time(session)
    ):
        raise Problem(400, "INVALID_INVITATION", "Invitation is invalid or expired")
    repo = WorkspaceRepository(session, WorkspaceScope(invitation.workspace_id))
    if (await repo.get()).archived:
        raise Problem(409, "WORKSPACE_ARCHIVED", "Workspace is archived")
    return repo


async def add_invited_member(
    repo: WorkspaceRepository, invitation: WorkspaceInvite, user: User
) -> None:
    """邀请凭据与身份已经由当前入口核验，成员、消费标记、审计和收件箱状态在同一个业务事务内写入。"""
    if await repo.member(user.id):
        raise Problem(409, "MEMBER_EXISTS", "Account is already a Workspace member")
    repo.session.add(
        WorkspaceMember(
            workspace_id=invitation.workspace_id,
            user_id=user.id,
            role=invitation.role,
            status="ACTIVE",
        )
    )
    invitation.consumed = True
    audit(
        repo.session,
        "workspace.invitation_accepted",
        user.id,
        invitation.id,
        workspace_id=invitation.workspace_id,
    )
    # 新成员身份会使同一工作区所有待接受邀请失效，并改变旧工作区事件的可见性，按收件人一次性刷新整个快照。
    await invalidate_inbox(repo.session, user.id)


async def protect_user_disable(session: AsyncSession, user_id: str) -> None:
    """禁用用户前检查是否为任何 Workspace 最后 Owner，是则拒绝以免租户悬空，protect_user_disable 遵守本文件
    Workspace/事务边界。protect_user_disable 必须坚持

    Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。调用方须持有安装护栏，并与 Workspace 变更共用这把锁。
    """
    workspace_ids = (
        (
            await session.execute(
                select(WorkspaceMember.workspace_id)
                .where(
                    WorkspaceMember.user_id == user_id,
                    WorkspaceMember.role == "OWNER",
                    WorkspaceMember.status == "ACTIVE",
                )
                .order_by(WorkspaceMember.workspace_id)
            )
        )
        .scalars()
        .all()
    )
    for workspace_id in workspace_ids:
        await WorkspaceRepository(session, WorkspaceScope(workspace_id)).protect_owner(user_id)


def workspace_dto(workspace: Workspace, role: str) -> dict[str, Any]:
    """导出 Workspace 公共字段并附带调用方在该租户的角色信息，workspace_dto 遵守本文件
    Workspace/事务边界。workspace_dto 必须坚持 Workspace 归属与成员授权，

    嵌套资源引用不得跨空间隐式放行。
    """
    return {
        "id": workspace.id,
        "key": workspace.key,
        "name": workspace.name,
        "role": role,
        "archived": workspace.archived,
        "createdAt": stamp(workspace.created_at),
    }


def member_dto(member: WorkspaceMember, user: User) -> dict[str, Any]:
    """组合成员角色状态与用户公开资料，供成员列表 API 返回，member_dto 遵守本文件 Workspace/事务边界。member_dto
    必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """
    return {
        "userId": user.id,
        "email": user.email,
        "displayName": user.display_name,
        "role": member.role,
        "status": member.status,
        "userDisabled": user.disabled,
    }


def invitation_dto(invite: WorkspaceInvite) -> dict[str, Any]:
    """导出邀请元数据且不含 token 明文，包含角色与过期相关字段，invitation_dto 遵守本文件 Workspace/事务边界。
    invitation_dto 必须坚持 Workspace 归属与成员授权，

    嵌套资源引用不得跨空间隐式放行。
    """
    if invite.revoked:
        status = "REVOKED"
    elif invite.consumed:
        status = "ACCEPTED"
    else:
        status = "EXPIRED" if invite.expires_at <= now() else "PENDING"
    return {
        "id": invite.id,
        "email": invite.email,
        "role": invite.role,
        "expiresAt": stamp(invite.expires_at),
        "status": status,
        "createdAt": stamp(invite.created_at),
    }
