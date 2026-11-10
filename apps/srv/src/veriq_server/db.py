"""Async MySQL persistence. Schema creation belongs exclusively to Alembic."""

from datetime import datetime

from sqlalchemy import Boolean, ForeignKey, Integer, String
from sqlalchemy.dialects.mysql import DATETIME
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .settings import Settings


class Base(DeclarativeBase):
    pass


uuid_type = String(36, collation="ascii_bin")
hash_type = String(64, collation="ascii_bin")


class Installation(Base):
    __tablename__ = "veriq_installation"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    initialized: Mapped[bool] = mapped_column(Boolean, default=False)
    setup_secret_hash: Mapped[str | None] = mapped_column(hash_type)


class User(Base):
    __tablename__ = "veriq_users"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    email: Mapped[str] = mapped_column(String(254, collation="utf8mb4_0900_as_ci"), unique=True)
    display_name: Mapped[str] = mapped_column(String(160))
    password_hash: Mapped[str] = mapped_column(String(255, collation="ascii_bin"))
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    system_admin: Mapped[bool] = mapped_column(Boolean, default=False)


class UserSession(Base):
    __tablename__ = "veriq_user_sessions"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    user_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(hash_type, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class UserToken(Base):
    __tablename__ = "veriq_user_tokens"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    user_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(hash_type, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    consumed: Mapped[bool] = mapped_column(Boolean, default=False)


class AuditLog(Base):
    __tablename__ = "veriq_audit_logs"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    actor_id: Mapped[str | None] = mapped_column(uuid_type)
    target_id: Mapped[str | None] = mapped_column(uuid_type)
    action: Mapped[str] = mapped_column(String(80, collation="ascii_bin"))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class Database:
    def __init__(self, settings: Settings):
        self.engine = create_async_engine(
            settings.database_url.get_secret_value(),
            isolation_level="READ COMMITTED",
            pool_pre_ping=True,
            connect_args={"charset": "utf8mb4", "init_command": "SET time_zone = '+00:00'"},
            hide_parameters=True,
        )
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    async def close(self) -> None:
        await self.engine.dispose()
