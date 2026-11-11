"""Account operations share a singleton row lock for bootstrap/admin invariants."""

import asyncio
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, UTC
from uuid import uuid4
from typing import Any

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import AuditLog, Database, Installation, User, UserSession, UserToken

password_hasher = PasswordHasher()
# Constant work for absent users. This is a hash of random material, never an account password.
dummy_hash = password_hasher.hash(secrets.token_urlsafe(32))


def now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def stamp(value: datetime) -> str:
    return value.isoformat(timespec="microseconds") + "Z"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class Problem(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message


def user_dto(user: User) -> dict[str, Any]:
    return {
        "id": user.id,
        "email": user.email,
        "displayName": user.display_name,
        "disabled": user.disabled,
    }


def admin_dto(user: User) -> dict[str, Any]:
    return {**user_dto(user), "systemAdmin": user.system_admin}


def audit(
    s: AsyncSession,
    action: str,
    actor: str | None = None,
    target: str | None = None,
    *,
    workspace_id: str | None = None,
) -> None:
    s.add(
        AuditLog(
            id=str(uuid4()),
            actor_id=actor,
            target_id=target,
            workspace_id=workspace_id,
            action=action,
            created_at=now(),
        )
    )


async def lock_installation(s: AsyncSession) -> Installation:
    return (
        await s.execute(select(Installation).where(Installation.id == 1).with_for_update())
    ).scalar_one()


async def provision_setup_secret(db: Database, secret: str) -> None:
    async with db.sessions.begin() as s:
        installation = await lock_installation(s)
        if installation.initialized:
            raise Problem(409, "ALREADY_INITIALIZED", "Installation already initialized")
        installation.setup_secret_hash = digest(secret)


async def hash_password(password: str) -> str:
    if len(password) < 12 or len(password) > 1024:
        raise Problem(400, "WEAK_PASSWORD", "Password must contain 12 to 1024 characters")
    return await asyncio.to_thread(password_hasher.hash, password)


async def verify(password_hash: str, password: str) -> bool:
    try:
        return await asyncio.to_thread(password_hasher.verify, password_hash, password)
    except VerificationError:
        return False


async def create_user(s: AsyncSession, data: dict[str, Any], *, first: bool = False) -> User:
    user = User(
        id=str(uuid4()),
        email=data["email"].lower(),
        display_name=data["displayName"],
        password_hash=await hash_password(data["password"]),
        disabled=False,
        system_admin=first or data.get("systemAdmin", False),
    )
    s.add(user)
    await s.flush()
    return user


async def initialize(db: Database, data: dict[str, Any]) -> User:
    async with db.sessions.begin() as s:
        installation = await lock_installation(s)
        if installation.initialized:
            raise Problem(409, "ALREADY_INITIALIZED", "Installation already initialized")
        if not installation.setup_secret_hash or not hmac.compare_digest(
            installation.setup_secret_hash, digest(data["installationSecret"])
        ):
            raise Problem(403, "INVALID_INSTALLATION_SECRET", "Installation secret is invalid")
        user = await create_user(s, data, first=True)
        installation.initialized = True
        installation.setup_secret_hash = None
        audit(s, "installation.initialized", user.id, user.id)
        return user


async def invalidate(s: AsyncSession, user_id: str) -> None:
    await s.execute(delete(UserSession).where(UserSession.user_id == user_id))


async def issue_reset(s: AsyncSession, user: User, minutes: int) -> tuple[str, datetime]:
    # A newly issued link supersedes all previous reset links.
    await s.execute(delete(UserToken).where(UserToken.user_id == user.id))
    token = secrets.token_urlsafe(32)
    expiry = now() + timedelta(minutes=minutes)
    s.add(
        UserToken(
            id=str(uuid4()),
            user_id=user.id,
            token_hash=digest(token),
            expires_at=expiry,
            consumed=False,
        )
    )
    return token, expiry
