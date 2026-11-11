"""Async MySQL persistence. Schema creation belongs exclusively to Alembic."""

from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    ForeignKeyConstraint,
    BigInteger,
    JSON,
)
from sqlalchemy.dialects.mysql import DATETIME, LONGBLOB
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
    workspace_id: Mapped[str | None] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), index=True
    )
    action: Mapped[str] = mapped_column(String(80, collation="ascii_bin"))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class Workspace(Base):
    __tablename__ = "veriq_workspaces"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    key: Mapped[str] = mapped_column(String(160, collation="ascii_bin"), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class WorkspaceMember(Base):
    __tablename__ = "veriq_workspace_members"
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_users.id"), primary_key=True, index=True
    )
    role: Mapped[str] = mapped_column(String(16, collation="ascii_bin"))
    status: Mapped[str] = mapped_column(String(16, collation="ascii_bin"))


class WorkspaceInvite(Base):
    __tablename__ = "veriq_workspace_invites"
    __table_args__ = (UniqueConstraint("token_hash"),)
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), index=True
    )
    email: Mapped[str] = mapped_column(String(254, collation="utf8mb4_0900_as_ci"))
    role: Mapped[str] = mapped_column(String(16, collation="ascii_bin"))
    token_hash: Mapped[str] = mapped_column(hash_type)
    expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    consumed: Mapped[bool] = mapped_column(Boolean, default=False)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
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


# Immutable source, content and validation provenance share the existing Workspace.
class Resource(Base):
    __tablename__ = "veriq_resources"
    __table_args__ = (
        UniqueConstraint("workspace_id", "kind", "key"),
        UniqueConstraint("workspace_id", "id"),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_workspaces.id"))
    kind: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    key: Mapped[str] = mapped_column(String(160, collation="ascii_bin"))
    name: Mapped[str] = mapped_column(String(160))
    status: Mapped[str] = mapped_column(String(16, collation="ascii_bin"))
    latest_version_id: Mapped[str | None] = mapped_column(uuid_type)


class ResourceDraft(Base):
    __tablename__ = "veriq_resource_drafts"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "resource_id"], ["veriq_resources.workspace_id", "veriq_resources.id"]
        ),
    )
    resource_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    revision: Mapped[int] = mapped_column(BigInteger)
    document_json: Mapped[dict[str, Any]] = mapped_column(JSON)
    updated_by: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    updated_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class ResourceVersion(Base):
    __tablename__ = "veriq_resource_versions"
    __table_args__ = (
        UniqueConstraint("resource_id", "version_no"),
        UniqueConstraint("workspace_id", "id"),
        UniqueConstraint("resource_id", "draft_revision"),
        ForeignKeyConstraint(
            ["workspace_id", "resource_id"], ["veriq_resources.workspace_id", "veriq_resources.id"]
        ),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    resource_id: Mapped[str] = mapped_column(uuid_type)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    kind: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    version_no: Mapped[int] = mapped_column(Integer)
    draft_revision: Mapped[int] = mapped_column(BigInteger)
    document_json: Mapped[dict[str, Any]] = mapped_column(JSON)
    sha256: Mapped[str] = mapped_column(hash_type)
    source_hash: Mapped[str] = mapped_column(hash_type)
    engine_version: Mapped[str] = mapped_column(String(80, collation="ascii_bin"))
    receipt_id: Mapped[str] = mapped_column(uuid_type)
    published_by: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    published_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class ResourceDependency(Base):
    __tablename__ = "veriq_resource_dependencies"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "version_id"],
            ["veriq_resource_versions.workspace_id", "veriq_resource_versions.id"],
        ),
        ForeignKeyConstraint(
            ["workspace_id", "dependency_version_id"],
            ["veriq_resource_versions.workspace_id", "veriq_resource_versions.id"],
        ),
    )
    workspace_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    version_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    dependency_version_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)


class Artifact(Base):
    """Immutable content-addressed bytes; T12 extends external storage/retention."""

    __tablename__ = "veriq_artifacts"
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), primary_key=True
    )
    sha256: Mapped[str] = mapped_column(hash_type, primary_key=True)
    content: Mapped[bytes] = mapped_column(LONGBLOB)
    size_bytes: Mapped[int] = mapped_column(Integer)
    media_type: Mapped[str] = mapped_column(String(80, collation="ascii_bin"))


class Job(Base):
    """Single shared Runtime queue. T09 adds claims/leases/capacity."""

    __tablename__ = "veriq_jobs"
    __table_args__ = (
        UniqueConstraint("workspace_id", "id"),
        UniqueConstraint("workspace_id", "validation_key"),
        ForeignKeyConstraint(
            ["workspace_id", "snapshot_hash"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
        ForeignKeyConstraint(
            ["workspace_id", "manifest_hash"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_workspaces.id"))
    kind: Mapped[str] = mapped_column(String(16, collation="ascii_bin"))
    subject_id: Mapped[str] = mapped_column(uuid_type)
    state: Mapped[str] = mapped_column(String(24, collation="ascii_bin"), index=True)
    snapshot_hash: Mapped[str] = mapped_column(hash_type)
    manifest_hash: Mapped[str] = mapped_column(hash_type)
    validation_key: Mapped[str | None] = mapped_column(hash_type)
    required_capabilities: Mapped[dict[str, Any]] = mapped_column(JSON)
    active_attempt_id: Mapped[str | None] = mapped_column(uuid_type)
    created_by: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class ValidationReceipt(Base):
    """Only verified Runtime completion may create this provenance record."""

    __tablename__ = "veriq_validation_receipts"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "resource_id"], ["veriq_resources.workspace_id", "veriq_resources.id"]
        ),
        ForeignKeyConstraint(
            ["workspace_id", "job_id"], ["veriq_jobs.workspace_id", "veriq_jobs.id"]
        ),
        ForeignKeyConstraint(
            ["workspace_id", "compiled_bundle_sha256"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
        UniqueConstraint("job_id"),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    resource_id: Mapped[str] = mapped_column(uuid_type)
    job_id: Mapped[str] = mapped_column(uuid_type)
    revision: Mapped[int] = mapped_column(BigInteger)
    source_hash: Mapped[str] = mapped_column(hash_type)
    engine_version: Mapped[str] = mapped_column(String(80, collation="ascii_bin"))
    compiled_bundle_sha256: Mapped[str] = mapped_column(hash_type)
    runtime_id: Mapped[str] = mapped_column(uuid_type)
    attempt_id: Mapped[str] = mapped_column(uuid_type)
    compiler_trust: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    validated_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class SecretRef(Base):
    __tablename__ = "veriq_secret_refs"
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), primary_key=True
    )
    key: Mapped[str] = mapped_column(String(160, collation="ascii_bin"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class SecretVersion(Base):
    __tablename__ = "veriq_secret_versions"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "secret_ref"],
            ["veriq_secret_refs.workspace_id", "veriq_secret_refs.key"],
        ),
        UniqueConstraint("workspace_id", "id"),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    secret_ref: Mapped[str] = mapped_column(String(160, collation="ascii_bin"))
    key_id: Mapped[str] = mapped_column(String(80, collation="ascii_bin"))
    nonce: Mapped[bytes] = mapped_column(LONGBLOB)
    ciphertext: Mapped[bytes] = mapped_column(LONGBLOB)
    allowed_identity_ids: Mapped[list[str]] = mapped_column(JSON)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class AuthAdapterVersion(Base):
    __tablename__ = "veriq_auth_adapter_versions"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), index=True
    )
    content_hash: Mapped[str] = mapped_column(hash_type)
    configuration: Mapped[dict[str, Any]] = mapped_column(JSON)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class Runtime(Base):
    __tablename__ = "veriq_runtimes"
    __table_args__ = (
        CheckConstraint(
            "(owner_user_id IS NULL) <> (owner_service_account_id IS NULL)",
            name="ck_runtime_one_owner",
        ),
    )
    owner_service_account_id: Mapped[str | None] = mapped_column(
        uuid_type, ForeignKey("veriq_service_accounts.id")
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    owner_user_id: Mapped[str | None] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    name: Mapped[str] = mapped_column(String(160))
    location: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    trust_status: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    capabilities: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class RuntimeBinding(Base):
    __tablename__ = "veriq_runtime_bindings"
    runtime_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_runtimes.id"), primary_key=True
    )
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), primary_key=True
    )
    shared_with_workspace: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_credential_delivery: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class RuntimeGrant(Base):
    __tablename__ = "veriq_runtime_grants"
    __table_args__ = (
        ForeignKeyConstraint(
            ["runtime_id", "workspace_id"],
            ["veriq_runtime_bindings.runtime_id", "veriq_runtime_bindings.workspace_id"],
        ),
    )
    runtime_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    user_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"), primary_key=True)


class RuntimeEnrollment(Base):
    __tablename__ = "veriq_runtime_enrollments"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    user_code_hash: Mapped[str] = mapped_column(hash_type, unique=True)
    device_code_hash: Mapped[str] = mapped_column(hash_type, unique=True)
    last_polled_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    request_hash: Mapped[str] = mapped_column(hash_type, index=True)
    name: Mapped[str] = mapped_column(String(160))
    capabilities: Mapped[dict[str, Any]] = mapped_column(JSON)
    expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    runtime_id: Mapped[str | None] = mapped_column(uuid_type, ForeignKey("veriq_runtimes.id"))
    consumed: Mapped[bool] = mapped_column(Boolean, default=False)


class RuntimeToken(Base):
    __tablename__ = "veriq_runtime_tokens"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    runtime_id: Mapped[str] = mapped_column(uuid_type)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    __table_args__ = (
        ForeignKeyConstraint(
            ["runtime_id", "workspace_id"],
            ["veriq_runtime_bindings.runtime_id", "veriq_runtime_bindings.workspace_id"],
        ),
    )
    token_hash: Mapped[str] = mapped_column(hash_type, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class ServiceAccount(Base):
    __tablename__ = "veriq_service_accounts"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), index=True
    )
    name: Mapped[str] = mapped_column(String(160))
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class ServiceToken(Base):
    __tablename__ = "veriq_service_tokens"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    service_account_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_service_accounts.id"), index=True
    )
    token_hash: Mapped[str] = mapped_column(hash_type, unique=True)
    purpose: Mapped[str] = mapped_column(String(40, collation="ascii_bin"))
    expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    consumed_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    revoked_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
