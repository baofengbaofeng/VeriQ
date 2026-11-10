"""Authenticated account/password/session controls."""

from sqlalchemy import delete, select
from ..db import UserSession, UserToken
from ..service import (
    Problem,
    admin_dto,
    audit,
    hash_password,
    invalidate,
    lock_installation,
    now,
    stamp,
    verify,
)
from .base import API


class AccountAPI(API):
    async def get(self, user_id: str | None = None) -> None:
        async with self.db.sessions() as s:
            if self.action == "account":
                user, _ = await self.identity(s)
                self.respond(admin_dto(user))
            elif self.action == "sessions":
                user, current = await self.identity(s)
                sessions = (
                    (
                        await s.execute(
                            select(UserSession)
                            .where(UserSession.user_id == user.id, UserSession.expires_at > now())
                            .order_by(UserSession.created_at)
                        )
                    )
                    .scalars()
                    .all()
                )
                self.respond(
                    {
                        "items": [
                            {
                                "id": v.id,
                                "createdAt": stamp(v.created_at),
                                "expiresAt": stamp(v.expires_at),
                                "current": v.id == current.id,
                            }
                            for v in sessions
                        ],
                        "nextCursor": None,
                    }
                )
            else:
                raise Problem(404, "NOT_FOUND", "API endpoint not found")

    async def post(self, user_id: str | None = None) -> None:
        async with self.db.sessions.begin() as s:
            if self.action == "password":
                data = self.body("ChangePasswordRequest")
                await lock_installation(s)
                user, _ = await self.identity(s)
                if not await verify(user.password_hash, data["currentPassword"]):
                    raise Problem(400, "INVALID_PASSWORD", "Current password is incorrect")
                user.password_hash = await hash_password(data["newPassword"])
                await invalidate(s, user.id)
                await s.execute(delete(UserToken).where(UserToken.user_id == user.id))
                audit(s, "password.changed", user.id, user.id)
                self.respond({})
            elif self.action == "revoke-own":
                self.body("Empty")
                user, _ = await self.identity(s)
                await invalidate(s, user.id)
                audit(s, "sessions.revoked", user.id, user.id)
                self.respond({})
            else:
                raise Problem(404, "NOT_FOUND", "API endpoint not found")
