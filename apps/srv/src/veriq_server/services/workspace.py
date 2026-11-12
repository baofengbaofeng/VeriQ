"""Workspace 仓储与 DTO：在 scope 内读取租户、成员与邀请，并执行角色授权与最后 Owner 保护，防止拆空所有权。
authorize 组合成员角色与 Permission；protect_user_disable 拒绝禁用仍为唯一 Owner 的用户。
DTO 只导出稳定对外字段，永不包含邀请或会话令牌明文。
"""

from typing import Any
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import Actor, Authorization, Permission, WorkspaceScope
from ..db import User, Workspace, WorkspaceMember, WorkspaceInvite
from ..service import Problem, stamp, now


class WorkspaceRepository:
    """绑定会话与 WorkspaceScope，提供 get/member/authorize/invite 与 Owner 保护原语。"""
    def __init__(self, session: AsyncSession, scope: WorkspaceScope):
        """保存会话与作用域，后续查询一律携带 workspace_id 谓词，WorkspaceRepository.__init__ 遵守本文件 Workspace/事务边界。"""
        self.session, self.scope = session, scope

    async def get(self) -> Workspace:
        """加载当前 scope 的 Workspace 行，供授权与成员流程复用，WorkspaceRepository.get 遵守本文件 Workspace/事务边界。"""
        workspace = await self.session.get(Workspace, self.scope.workspace_id)
        if workspace is None:
            raise Problem(404, "WORKSPACE_NOT_FOUND", "Workspace not found")
        return workspace

    async def member(self, user_id: str) -> WorkspaceMember | None:
        """返回指定用户在本 Workspace 的成员行，不存在则为 None，WorkspaceRepository.member 遵守本文件 Workspace/事务边界。"""
        return await self.session.get(WorkspaceMember, (self.scope.workspace_id, user_id))

    async def authorize(
        self, user: User, permission: Permission = Permission.VIEW, *, write: bool = False
    ) -> tuple[Workspace, Actor]:
        """校验活跃成员后按 Permission 要求角色，失败抛出 WORKSPACE_FORBIDDEN，WorkspaceRepository.authorize 遵守本文件 Workspace/事务边界。"""
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
        """按邀请 ID 读取本 Workspace 邀请，供接受或吊销流程使用，WorkspaceRepository.invite 遵守本文件 Workspace/事务边界。"""
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
        """阻止移除或降级最后一位 OWNER，避免 Workspace 失去所有权锚点，WorkspaceRepository.protect_owner 遵守本文件 Workspace/事务边界。"""
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


async def protect_user_disable(session: AsyncSession, user_id: str) -> None:
    """禁用用户前检查是否为任何 Workspace 最后 Owner，是则拒绝以免租户悬空，protect_user_disable 遵守本文件 Workspace/事务边界。"""
    # Caller holds installation guard, shared with Workspace mutations.
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
    """导出 Workspace 公共字段并附带调用方在该租户的角色信息，workspace_dto 遵守本文件 Workspace/事务边界。"""
    return {
        "id": workspace.id,
        "key": workspace.key,
        "name": workspace.name,
        "role": role,
        "archived": workspace.archived,
    }


def member_dto(member: WorkspaceMember, user: User) -> dict[str, Any]:
    """组合成员角色状态与用户公开资料，供成员列表 API 返回，member_dto 遵守本文件 Workspace/事务边界。"""
    return {
        "userId": user.id,
        "email": user.email,
        "displayName": user.display_name,
        "role": member.role,
        "status": member.status,
        "userDisabled": user.disabled,
    }


def invitation_dto(invite: WorkspaceInvite) -> dict[str, Any]:
    """导出邀请元数据且不含 token 明文，包含角色与过期相关字段，invitation_dto 遵守本文件 Workspace/事务边界。"""
    status = (
        "REVOKED"
        if invite.revoked
        else "ACCEPTED"
        if invite.consumed
        else "EXPIRED"
        if invite.expires_at <= now()
        else "PENDING"
    )
    return {
        "id": invite.id,
        "email": invite.email,
        "role": invite.role,
        "expiresAt": stamp(invite.expires_at),
        "status": status,
    }
