"""Session-authorized Workspace, member and invitation HTTP API."""

import logging
import secrets
from datetime import timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy import and_, or_, select

from ..auth.authorization import Authorization, Permission, WorkspaceScope
from ..db import User, Workspace, WorkspaceMember, WorkspaceInvite
from ..pagination import Page, boolean_filter
from ..service import Problem, audit, create_user, digest, lock_installation, now, stamp, user_dto
from ..services.workspace import WorkspaceRepository, workspace_dto, member_dto, invitation_dto
from .base import API

log = logging.getLogger("veriq.http")


class WorkspaceAPI(API):
    def prepare(self) -> None:
        super().prepare()
        allowed = {
            "workspaces": {"GET", "POST"},
            "workspace": {"GET", "PATCH", "DELETE"},
            "members": {"GET"},
            "member": {"PUT", "DELETE"},
            "invitations": {"GET", "POST"},
            "invitation": {"DELETE"},
            "accept-invitation": {"POST"},
        }
        if self.request.method not in allowed[self.action]:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")

    def page(self, actor_id: str, workspace_id: str | None = None, **filters: Any) -> Page:
        return Page.read(
            self,
            {"list": self.action, "actor": actor_id, "workspaceId": workspace_id, **filters},
            self.config.signing_key.get_secret_value(),
        )

    async def get(self, workspace_id: str | None = None) -> None:
        async with self.db.sessions() as s:
            user, _ = await self.identity(s)
            if self.action == "workspaces":
                archived = boolean_filter(self, "archived")
                page = self.page(user.id, archived=archived)
                query = (
                    select(Workspace, WorkspaceMember)
                    .join(WorkspaceMember)
                    .where(WorkspaceMember.user_id == user.id, WorkspaceMember.status == "ACTIVE")
                )
                if archived is not None:
                    query = query.where(Workspace.archived.is_(archived))
                if page.last:
                    key, identifier = page.last
                    query = query.where(
                        or_(
                            Workspace.key > key,
                            and_(Workspace.key == key, Workspace.id > identifier),
                        )
                    )
                rows = (
                    await s.execute(
                        query.order_by(Workspace.key, Workspace.id).limit(page.limit + 1)
                    )
                ).all()
                items = rows[: page.limit]
                cursor = (
                    page.next((items[-1][0].key, items[-1][0].id), len(rows) > page.limit)
                    if items
                    else None
                )
                self.respond(
                    {"items": [workspace_dto(w, m.role) for w, m in items], "nextCursor": cursor}
                )
                return
            assert workspace_id is not None
            repo = WorkspaceRepository(s, WorkspaceScope(workspace_id))
            permission = (
                Permission.MANAGE_MEMBERS if self.action == "invitations" else Permission.VIEW
            )
            workspace, actor = await repo.authorize(user, permission)
            if self.action == "workspace":
                self.respond(workspace_dto(workspace, actor.role))
                return
            page = self.page(user.id, workspace_id)
            if self.action == "members":
                query_members = (
                    select(WorkspaceMember, User)
                    .join(User)
                    .where(WorkspaceMember.workspace_id == workspace_id)
                )
                if page.last:
                    email, identifier = page.last
                    query_members = query_members.where(
                        or_(User.email > email, and_(User.email == email, User.id > identifier))
                    )
                members = (
                    await s.execute(
                        query_members.order_by(User.email, User.id).limit(page.limit + 1)
                    )
                ).all()
                shown_members = members[: page.limit]
                cursor = (
                    page.next(
                        (shown_members[-1][1].email, shown_members[-1][1].id),
                        len(members) > page.limit,
                    )
                    if shown_members
                    else None
                )
                self.respond(
                    {"items": [member_dto(m, u) for m, u in shown_members], "nextCursor": cursor}
                )
            else:
                query_invites = select(WorkspaceInvite).where(
                    WorkspaceInvite.workspace_id == workspace_id
                )
                if page.last:
                    email, identifier = page.last
                    query_invites = query_invites.where(
                        or_(
                            WorkspaceInvite.email > email,
                            and_(WorkspaceInvite.email == email, WorkspaceInvite.id > identifier),
                        )
                    )
                invites = (
                    (
                        await s.execute(
                            query_invites.order_by(WorkspaceInvite.email, WorkspaceInvite.id).limit(
                                page.limit + 1
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                shown = invites[: page.limit]
                cursor = (
                    page.next((shown[-1].email, shown[-1].id), len(invites) > page.limit)
                    if shown
                    else None
                )
                self.respond({"items": [invitation_dto(i) for i in shown], "nextCursor": cursor})

    async def post(self, workspace_id: str | None = None) -> None:
        if self.action == "accept-invitation":
            await self.accept_invitation()
            return
        data = self.body("WorkspaceWrite" if self.action == "workspaces" else "InviteRequest")
        result: dict[str, Any]
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            user, _ = await self.identity(s)
            if self.action == "workspaces":
                exists = (
                    await s.execute(select(Workspace.id).where(Workspace.key == data["key"]))
                ).scalar_one_or_none()
                if exists:
                    raise Problem(
                        409,
                        "WORKSPACE_KEY_EXISTS",
                        "Workspace key already exists, including archived Workspaces",
                    )
                workspace = Workspace(
                    id=str(uuid4()),
                    key=data["key"],
                    name=data["name"],
                    archived=False,
                    created_at=now(),
                )
                s.add(workspace)
                await s.flush()
                s.add(
                    WorkspaceMember(
                        workspace_id=workspace.id, user_id=user.id, role="OWNER", status="ACTIVE"
                    )
                )
                audit(s, "workspace.created", user.id, workspace.id, workspace_id=workspace.id)
                result = workspace_dto(workspace, "OWNER")
            else:
                assert workspace_id is not None
                repo = WorkspaceRepository(s, WorkspaceScope(workspace_id))
                await repo.authorize(user, Permission.MANAGE_MEMBERS, write=True)
                if data.get("sendEmail") and not self.application.settings["mail_delivery"]:
                    raise Problem(
                        409,
                        "SMTP_UNAVAILABLE",
                        "Email delivery is not configured; use a copyable link",
                    )
                token = secrets.token_urlsafe(32)
                invitation = WorkspaceInvite(
                    id=str(uuid4()),
                    workspace_id=workspace_id,
                    email=data["email"].lower(),
                    role=data["role"],
                    token_hash=digest(token),
                    expires_at=now() + timedelta(days=7),
                    created_at=now(),
                    consumed=False,
                    revoked=False,
                )
                s.add(invitation)
                audit(s, "workspace.invited", user.id, invitation.id, workspace_id=workspace_id)
                result = {
                    "id": invitation.id,
                    "expiresAt": stamp(invitation.expires_at),
                    "invitationUrl": self.config.public_url + "/invitations/accept#token=" + token,
                    "delivery": "NOT_REQUESTED",
                }
        if self.action == "invitations" and data.get("sendEmail"):
            try:
                await self.application.settings["mail_delivery"].send(
                    data["email"].lower(),
                    "VeriQ Workspace invitation",
                    "Accept your Workspace invitation: " + result["invitationUrl"],
                )
                result["delivery"] = "SENT"
            except Exception:
                # The copyable link remains usable; do not log addresses/tokens/adapter errors.
                log.warning("Workspace invitation email delivery failed")
                result["delivery"] = "FAILED"
        self.respond(result, 201)

    async def accept_invitation(self) -> None:
        data = self.body("InvitationAcceptRequest")
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            invitation = (
                await s.execute(
                    select(WorkspaceInvite).where(
                        WorkspaceInvite.token_hash == digest(data["token"])
                    )
                )
            ).scalar_one_or_none()
            if (
                not invitation
                or invitation.consumed
                or invitation.revoked
                or invitation.expires_at <= now()
            ):
                raise Problem(400, "INVALID_INVITATION", "Invitation is invalid or expired")
            repo = WorkspaceRepository(s, WorkspaceScope(invitation.workspace_id))
            if (await repo.get()).archived:
                raise Problem(409, "WORKSPACE_ARCHIVED", "Workspace is archived")
            user = (
                await s.execute(select(User).where(User.email == invitation.email))
            ).scalar_one_or_none()
            if user:
                if user.disabled:
                    raise Problem(403, "USER_DISABLED", "Account is disabled")
                authenticated, _ = await self.identity(s)
                if authenticated.id != user.id:
                    raise Problem(
                        403, "INVITATION_IDENTITY_MISMATCH", "Sign in with the invited account"
                    )
                if "password" in data or "displayName" in data:
                    raise Problem(
                        400,
                        "EXISTING_ACCOUNT",
                        "Existing accounts accept using their current identity",
                    )
            else:
                if "password" not in data or "displayName" not in data:
                    raise Problem(
                        400,
                        "ACCOUNT_DETAILS_REQUIRED",
                        "New accounts require display name and password",
                    )
                user = await create_user(s, {**data, "email": invitation.email})
            if await repo.member(user.id):
                raise Problem(409, "MEMBER_EXISTS", "Account is already a Workspace member")
            s.add(
                WorkspaceMember(
                    workspace_id=invitation.workspace_id,
                    user_id=user.id,
                    role=invitation.role,
                    status="ACTIVE",
                )
            )
            invitation.consumed = True
            audit(
                s,
                "workspace.invitation_accepted",
                user.id,
                invitation.id,
                workspace_id=invitation.workspace_id,
            )
            result = user_dto(user)
        self.respond(result)

    async def patch(self, workspace_id: str) -> None:
        data = self.body("WorkspaceRename")
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            user, _ = await self.identity(s)
            workspace, actor = await WorkspaceRepository(s, WorkspaceScope(workspace_id)).authorize(
                user, Permission.MANAGE_WORKSPACE, write=True
            )
            workspace.name = data["name"]
            audit(s, "workspace.updated", user.id, workspace_id, workspace_id=workspace_id)
            result = workspace_dto(workspace, actor.role)
        self.respond(result)

    async def put(self, workspace_id: str, user_id: str) -> None:
        data = self.body("MemberWrite")
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            user, _ = await self.identity(s)
            scope = WorkspaceScope(workspace_id)
            repo = WorkspaceRepository(s, scope)
            _, actor = await repo.authorize(user, Permission.MANAGE_MEMBERS, write=True)
            member = await repo.member(user_id)
            target = await s.get(User, user_id)
            if not member or not target:
                raise Problem(404, "MEMBER_NOT_FOUND", "Workspace member not found")
            if member.role == "OWNER" or data["role"] == "OWNER":
                Authorization.require(actor, scope, Permission.OWNERSHIP)
            if data["role"] != "OWNER" or data["status"] != "ACTIVE":
                await repo.protect_owner(user_id)
            if (
                data["role"] == "OWNER"
                and member.role != "OWNER"
                and (target.disabled or data["status"] != "ACTIVE")
            ):
                raise Problem(409, "OWNER_DISABLED", "OWNER must be an enabled active member")
            member.role, member.status = data["role"], data["status"]
            audit(s, "workspace.member_updated", user.id, user_id, workspace_id=workspace_id)
            result = member_dto(member, target)
        self.respond(result)

    async def delete(self, workspace_id: str, identifier: str | None = None) -> None:
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            user, _ = await self.identity(s)
            scope = WorkspaceScope(workspace_id)
            repo = WorkspaceRepository(s, scope)
            permission = (
                Permission.OWNERSHIP if self.action == "workspace" else Permission.MANAGE_MEMBERS
            )
            workspace, actor = await repo.authorize(user, permission, write=True)
            if self.action == "workspace":
                workspace.archived = True
                audit(s, "workspace.archived", user.id, workspace_id, workspace_id=workspace_id)
            elif self.action == "member":
                assert identifier is not None
                member = await repo.member(identifier)
                if not member:
                    raise Problem(404, "MEMBER_NOT_FOUND", "Workspace member not found")
                if member.role == "OWNER":
                    Authorization.require(actor, scope, Permission.OWNERSHIP)
                await repo.protect_owner(identifier)
                await s.delete(member)
                audit(s, "workspace.member_removed", user.id, identifier, workspace_id=workspace_id)
            else:
                assert identifier is not None
                invitation = await repo.invite(identifier)
                invitation.revoked = True
                audit(
                    s,
                    "workspace.invitation_revoked",
                    user.id,
                    identifier,
                    workspace_id=workspace_id,
                )
        self.respond({})
