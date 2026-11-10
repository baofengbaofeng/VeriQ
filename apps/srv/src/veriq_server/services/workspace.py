"""Workspace persistence and invariant helpers.

All mutations acquire the installation singleton before identity or scoped reads.
That lock serializes account disable and all membership/ownership changes,
including invitation acceptance, through commit. Current services need no second
explicit row lock. Future row locks must follow Workspace ID then user/member/
invite ID order; never acquire the singleton after another mutation row lock.
Reads authorize current database membership; cursor possession grants no permission.
"""

from typing import Any
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import Actor, Authorization, Permission, WorkspaceScope
from ..db import User, Workspace, WorkspaceMember, WorkspaceInvite
from ..service import Problem, stamp, now


class WorkspaceRepository:
    def __init__(self, session: AsyncSession, scope: WorkspaceScope):
        self.session, self.scope = session, scope

    async def get(self) -> Workspace:
        workspace = await self.session.get(Workspace, self.scope.workspace_id)
        if workspace is None:
            raise Problem(404, "WORKSPACE_NOT_FOUND", "Workspace not found")
        return workspace

    async def member(self, user_id: str) -> WorkspaceMember | None:
        return await self.session.get(WorkspaceMember, (self.scope.workspace_id, user_id))

    async def authorize(
        self, user: User, permission: Permission = Permission.VIEW, *, write: bool = False
    ) -> tuple[Workspace, Actor]:
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
    return {
        "id": workspace.id,
        "key": workspace.key,
        "name": workspace.name,
        "role": role,
        "archived": workspace.archived,
    }


def member_dto(member: WorkspaceMember, user: User) -> dict[str, Any]:
    return {
        "userId": user.id,
        "email": user.email,
        "displayName": user.display_name,
        "role": member.role,
        "status": member.status,
        "userDisabled": user.disabled,
    }


def invitation_dto(invite: WorkspaceInvite) -> dict[str, Any]:
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
