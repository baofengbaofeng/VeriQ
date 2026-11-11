"""Bootstrap, password authentication and single-use reset handlers."""

import secrets
from datetime import timedelta
from uuid import uuid4
from sqlalchemy import delete, select
from ..db import Installation, User, UserSession, UserToken
from ..service import (
    Problem,
    audit,
    digest,
    dummy_hash,
    hash_password,
    initialize,
    invalidate,
    lock_installation,
    now,
    stamp,
    user_dto,
    verify,
)
from .base import API
from ..delivery import ResetDispatcher
from typing import cast


class AuthAPI(API):
    async def get(self, user_id: str | None = None) -> None:
        async with self.db.sessions() as s:
            if self.action == "setup":
                installation = await s.get(Installation, 1)
                self.respond(
                    {
                        "initialized": bool(installation and installation.initialized),
                        "csrfToken": self.xsrf_token.decode(),
                    }
                )
            elif self.action == "session":
                user, session = await self.identity(s)
                self.respond(
                    {
                        "user": user_dto(user),
                        "csrfToken": self.xsrf_token.decode(),
                        "expiresAt": stamp(session.expires_at),
                    }
                )
            else:
                raise Problem(404, "NOT_FOUND", "API endpoint not found")

    async def post(self, user_id: str | None = None) -> None:
        if self.action == "setup":
            self.respond(user_dto(await initialize(self.db, self.body("SetupRequest"))), 201)
            return
        async with self.db.sessions.begin() as s:
            if self.action == "login":
                await lock_installation(s)
                data = self.body("LoginRequest")
                user = (
                    await s.execute(select(User).where(User.email == data["email"].lower()))
                ).scalar_one_or_none()
                valid = await verify(user.password_hash if user else dummy_hash, data["password"])
                if not valid or not user or user.disabled:
                    raise Problem(401, "INVALID_CREDENTIALS", "Email or password is incorrect")
                token = secrets.token_urlsafe(32)
                expiry = now() + timedelta(hours=self.config.session_hours)
                old = self.get_cookie("veriq_session")
                if old:
                    await s.execute(
                        delete(UserSession).where(UserSession.token_hash == digest(old))
                    )
                s.add(
                    UserSession(
                        id=str(uuid4()),
                        user_id=user.id,
                        token_hash=digest(token),
                        created_at=now(),
                        expires_at=expiry,
                    )
                )
                audit(s, "session.created", user.id, user.id)
                await s.commit()
                self.set_cookie(
                    "veriq_session",
                    token,
                    httponly=True,
                    secure=self.config.environment == "production",
                    samesite="Strict",
                    expires=expiry,
                    path="/",
                )
                self.respond(
                    {
                        "user": user_dto(user),
                        "csrfToken": self.xsrf_token.decode(),
                        "expiresAt": stamp(expiry),
                    }
                )
            elif self.action == "reset-request":
                data = self.body("EmailRequest")
                # Dispatch before account lookup: status/body never reveal membership.
                dispatcher = cast(ResetDispatcher, self.application.settings["reset_dispatcher"])
                dispatcher.submit(data["email"])
                self.respond({})
            elif self.action == "reset-confirm":
                data = self.body("ResetPasswordRequest")
                await lock_installation(s)
                reset_token = (
                    await s.execute(
                        select(UserToken)
                        .where(UserToken.token_hash == digest(data["token"]))
                        .with_for_update()
                    )
                ).scalar_one_or_none()
                if not reset_token or reset_token.consumed or reset_token.expires_at <= now():
                    raise Problem(400, "INVALID_RESET_TOKEN", "Reset link is invalid or expired")
                user = await s.get(User, reset_token.user_id)
                if not user or user.disabled:
                    raise Problem(400, "INVALID_RESET_TOKEN", "Reset link is invalid or expired")
                user.password_hash = await hash_password(data["newPassword"])
                reset_token.consumed = True
                await invalidate(s, user.id)
                audit(s, "password.reset", None, user.id)
                self.respond({})
            elif self.action == "logout":
                self.body("Empty")
                user, session = await self.identity(s)
                await s.delete(session)
                audit(s, "session.logout", user.id, user.id)
                self.clear_cookie(
                    "veriq_session",
                    path="/",
                    samesite="Strict",
                    secure=self.config.environment == "production",
                )
                self.respond({})
            else:
                raise Problem(404, "NOT_FOUND", "API endpoint not found")
