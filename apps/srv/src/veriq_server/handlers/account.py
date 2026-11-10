"""Authenticated account/password/session controls."""

from datetime import datetime
from sqlalchemy import delete, select, and_, or_
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
from ..pagination import Page


class AccountAPI(API):
    async def get(self, user_id: str | None = None) -> None:
        async with self.db.sessions() as s:
            if self.action == "account":
                user, _ = await self.identity(s)
                self.respond(admin_dto(user))
            elif self.action == "sessions":
                user, current = await self.identity(s)
                page = Page.read(
                    self,
                    {"list": "sessions", "actor": user.id},
                    self.config.signing_key.get_secret_value(),
                )
                statement = select(UserSession).where(
                    UserSession.user_id == user.id, UserSession.expires_at > now()
                )
                if page.last:
                    try:
                        created = datetime.fromisoformat(page.last[0])
                        if created.tzinfo is not None:
                            raise ValueError
                    except ValueError:
                        raise Problem(
                            400, "INVALID_CURSOR", "Session cursor timestamp is invalid"
                        ) from None
                    statement = statement.where(
                        or_(
                            UserSession.created_at > created,
                            and_(UserSession.created_at == created, UserSession.id > page.last[1]),
                        )
                    )
                rows = (
                    (
                        await s.execute(
                            statement.order_by(UserSession.created_at, UserSession.id).limit(
                                page.limit + 1
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                sessions = rows[: page.limit]
                cursor = (
                    page.next(
                        (
                            sessions[-1].created_at.isoformat(timespec="microseconds"),
                            sessions[-1].id,
                        ),
                        len(rows) > page.limit,
                    )
                    if sessions
                    else None
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
                        "nextCursor": cursor,
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
