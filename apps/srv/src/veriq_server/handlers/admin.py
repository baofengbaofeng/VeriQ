"""Global user administration, serialized last-admin invariant."""

from sqlalchemy import delete, select, func, and_, or_
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
from ..pagination import Page, boolean_filter
from ..services.workspace import protect_user_disable


class AdminAPI(API):
    async def get(self, user_id: str | None = None) -> None:
        async with self.db.sessions() as s:
            if self.action == "users":
                actor, _ = await self.identity(s, True)
                query = self.get_query_argument("q", "")
                if len(query) > 254:
                    raise Problem(
                        400, "INVALID_FILTER", "Search query is limited to 254 characters"
                    )
                disabled = boolean_filter(self, "disabled")
                system_admin = boolean_filter(self, "systemAdmin")
                page = Page.read(
                    self,
                    {
                        "list": "users",
                        "actor": actor.id,
                        "q": query,
                        "disabled": disabled,
                        "systemAdmin": system_admin,
                    },
                    self.config.signing_key.get_secret_value(),
                )
                statement = select(User)
                if query:
                    statement = statement.where(
                        or_(
                            User.email.contains(query, autoescape=True),
                            User.display_name.contains(query, autoescape=True),
                        )
                    )
                if disabled is not None:
                    statement = statement.where(User.disabled.is_(disabled))
                if system_admin is not None:
                    statement = statement.where(User.system_admin.is_(system_admin))
                if page.last:
                    email, identifier = page.last
                    statement = statement.where(
                        or_(User.email > email, and_(User.email == email, User.id > identifier))
                    )
                rows = (
                    (await s.execute(statement.order_by(User.email, User.id).limit(page.limit + 1)))
                    .scalars()
                    .all()
                )
                users = rows[: page.limit]
                cursor = (
                    page.next((users[-1].email, users[-1].id), len(rows) > page.limit)
                    if users
                    else None
                )
                self.respond({"items": [admin_dto(user) for user in users], "nextCursor": cursor})
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
            if disabled and not user.disabled:
                await protect_user_disable(s, user.id)
            user.disabled, user.system_admin = (disabled, admin)
            if disabled:
                await invalidate(s, user.id)
                await s.execute(delete(UserToken).where(UserToken.user_id == user.id))
            audit(s, "user.updated", actor.id, user.id)
            self.respond(admin_dto(user))
