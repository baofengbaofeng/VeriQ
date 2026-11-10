"""Global user administration, serialized last-admin invariant."""

from sqlalchemy import delete, select, func
from ..db import User, UserToken
from ..service import (
    Problem,
    admin_dto,
    audit,
    create_user,
    invalidate,
    issue_reset,
    lock_installation,
    stamp,
)
from .base import API


class AdminAPI(API):
    async def get(self, user_id: str | None = None) -> None:
        async with self.db.sessions() as s:
            if self.action == "users":
                await self.identity(s, True)
                users = (await s.execute(select(User).order_by(User.email))).scalars().all()
                self.respond({"items": [admin_dto(u) for u in users], "nextCursor": None})
            else:
                raise Problem(404, "NOT_FOUND", "API endpoint not found")

    async def post(self, user_id: str | None = None) -> None:
        async with self.db.sessions.begin() as s:
            if self.action in {"users", "reset-link", "revoke-user"}:
                data = self.body("CreateUserRequest" if self.action == "users" else "Empty")
                await lock_installation(s)
                actor, _ = await self.identity(s, True)
                user: User | None
                if self.action == "users":
                    user = await create_user(s, data)
                    audit(s, "user.created", actor.id, user.id)
                    self.respond(admin_dto(user), 201)
                else:
                    user = await s.get(User, user_id)
                    if not user:
                        raise Problem(404, "USER_NOT_FOUND", "User not found")
                    if self.action == "revoke-user":
                        await invalidate(s, user.id)
                        audit(s, "sessions.revoked", actor.id, user.id)
                        self.respond({})
                    else:
                        if user.disabled:
                            raise Problem(
                                409, "USER_DISABLED", "Enable this user before issuing a reset link"
                            )
                        token, expiry = await issue_reset(s, user, self.config.reset_minutes)
                        audit(s, "reset.issued", actor.id, user.id)
                        self.respond(
                            {
                                "url": self.config.public_url + "/reset/confirm#token=" + token,
                                "expiresAt": stamp(expiry),
                            }
                        )
            else:
                raise Problem(404, "NOT_FOUND", "API endpoint not found")

    async def patch(self, user_id: str) -> None:
        if self.action != "user":
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        data = self.body("UpdateUserRequest")
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            actor, _ = await self.identity(s, True)
            user = await s.get(User, user_id)
            if not user:
                raise Problem(404, "USER_NOT_FOUND", "User not found")
            disabled = data.get("disabled", user.disabled)
            admin = data.get("systemAdmin", user.system_admin)
            if user.system_admin and (not user.disabled) and (disabled or not admin):
                count = (
                    await s.execute(
                        select(func.count())
                        .select_from(User)
                        .where(User.system_admin.is_(True), User.disabled.is_(False))
                    )
                ).scalar_one()
                if count <= 1:
                    raise Problem(
                        409, "LAST_ADMIN", "Create another enabled system administrator first"
                    )
            user.disabled, user.system_admin = (disabled, admin)
            if disabled:
                await invalidate(s, user.id)
                await s.execute(delete(UserToken).where(UserToken.user_id == user.id))
            audit(s, "user.updated", actor.id, user.id)
            self.respond(admin_dto(user))
