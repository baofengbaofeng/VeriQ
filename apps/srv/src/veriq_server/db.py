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
    Index,
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
    content: Mapped[bytes | None] = mapped_column(LONGBLOB, nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer)
    media_type: Mapped[str] = mapped_column(String(80, collation="ascii_bin"))
    storage_backend: Mapped[str] = mapped_column(
        String(16), default="INLINE", server_default="INLINE"
    )
    storage_incarnation: Mapped[str | None] = mapped_column(uuid_type)
    expired_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    deleted_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))


class ArtifactDeletion(Base):
    """Durable deletion of one immutable physical incarnation, never a job queue."""

    __tablename__ = "veriq_artifact_deletions"
    __table_args__ = (Index("ix_artifact_delete_pending", "workspace_id", "deleted_at"),)
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_workspaces.id"))
    sha256: Mapped[str] = mapped_column(hash_type)
    storage_backend: Mapped[str] = mapped_column(String(16))
    storage_incarnation: Mapped[str | None] = mapped_column(uuid_type)
    deleted_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))


class ArtifactPublication(Base):
    """Durable immutable incarnation intent; RETIRED is irreversible."""

    __tablename__ = "veriq_artifact_publications"
    __table_args__ = (
        Index("ix_artifact_publication_pending", "workspace_id", "state", "id"),
        CheckConstraint("state IN ('PENDING','COMMITTED','RETIRED')", name="ck_publication_state"),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_workspaces.id"))
    sha256: Mapped[str] = mapped_column(hash_type)
    storage_backend: Mapped[str] = mapped_column(String(16))
    upload_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_attempt_uploads.id"))
    state: Mapped[str] = mapped_column(String(16), default="PENDING")


class Job(Base):
    """Single shared Runtime queue. T09 adds claims/leases/capacity."""

    __tablename__ = "veriq_jobs"
    __table_args__ = (
        UniqueConstraint("workspace_id", "id"),
        UniqueConstraint("workspace_id", "validation_key"),
        Index("ix_veriq_job_claim", "workspace_id", "state", "created_at", "id"),
        ForeignKeyConstraint(
            ["workspace_id", "maintenance_id"],
            ["veriq_maintenance_receipts.workspace_id", "veriq_maintenance_receipts.id"],
            name="fk_job_maintenance",
        ),
        CheckConstraint(
            "kind <> 'TEST' OR subject_id = case_execution_id", name="ck_job_case_subject"
        ),
        CheckConstraint(
            "kind <> 'CLEANUP' OR (maintenance_id IS NOT NULL AND subject_id = maintenance_id AND origin_attempt_id IS NOT NULL)",
            name="ck_job_cleanup_subject",
        ),
        CheckConstraint("kind IN ('TEST','VALIDATE','CLEANUP')", name="ck_job_kind"),
        CheckConstraint("max_retries >= 0 AND max_retries <= 1", name="ck_job_retry_bound"),
        CheckConstraint(
            "(kind = 'TEST' AND run_id IS NOT NULL AND case_execution_id IS NOT NULL) OR (kind <> 'TEST' AND run_id IS NULL AND case_execution_id IS NULL)",
            name="ck_job_subject",
        ),
        ForeignKeyConstraint(
            ["workspace_id", "run_id", "case_execution_id"],
            [
                "veriq_case_executions.workspace_id",
                "veriq_case_executions.run_id",
                "veriq_case_executions.id",
            ],
            name="fk_job_run_execution",
        ),
        ForeignKeyConstraint(
            ["workspace_id", "origin_attempt_id"],
            ["veriq_attempts.workspace_id", "veriq_attempts.id"],
            name="fk_job_origin_attempt",
            use_alter=True,
        ),
        ForeignKeyConstraint(
            ["workspace_id", "run_id"],
            ["veriq_runs.workspace_id", "veriq_runs.id"],
            name="fk_job_run",
        ),
        ForeignKeyConstraint(
            ["workspace_id", "case_execution_id"],
            ["veriq_case_executions.workspace_id", "veriq_case_executions.id"],
            name="fk_job_execution",
        ),
        ForeignKeyConstraint(
            ["workspace_id", "id", "active_attempt_id"],
            ["veriq_attempts.workspace_id", "veriq_attempts.job_id", "veriq_attempts.id"],
            name="fk_job_active_attempt",
            use_alter=True,
        ),
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
    run_id: Mapped[str | None] = mapped_column(uuid_type)
    case_execution_id: Mapped[str | None] = mapped_column(uuid_type)
    requested_runtime_id: Mapped[str | None] = mapped_column(uuid_type)
    requested_location: Mapped[str | None] = mapped_column(String(24, collation="ascii_bin"))
    requester_service_token_id: Mapped[str | None] = mapped_column(
        uuid_type, ForeignKey("veriq_service_tokens.id", name="fk_job_service_requester")
    )
    origin_attempt_id: Mapped[str | None] = mapped_column(uuid_type)
    maintenance_id: Mapped[str | None] = mapped_column(uuid_type)
    outcome: Mapped[str | None] = mapped_column(String(24, collation="ascii_bin"))
    wait_reason: Mapped[str | None] = mapped_column(String(24, collation="ascii_bin"))
    max_retries: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    fence: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
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
        ForeignKeyConstraint(
            ["workspace_id", "job_id", "attempt_id", "runtime_id"],
            [
                "veriq_attempts.workspace_id",
                "veriq_attempts.job_id",
                "veriq_attempts.id",
                "veriq_attempts.runtime_id",
            ],
            name="fk_validation_attempt",
        ),
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
    last_seen_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))


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
    rotation_request_id: Mapped[str | None] = mapped_column(uuid_type)
    successor_hash: Mapped[str | None] = mapped_column(hash_type)


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
    operation_scopes: Mapped[list[str] | None] = mapped_column(JSON)
    expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    consumed_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    revoked_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class Run(Base):
    __tablename__ = "veriq_runs"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "snapshot_hash"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
        UniqueConstraint("workspace_id", "id"),
        UniqueConstraint("workspace_id", "idempotency_key"),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_workspaces.id"))
    created_by: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    idempotency_key: Mapped[str] = mapped_column(String(160, collation="ascii_bin"))
    request_hash: Mapped[str] = mapped_column(hash_type)
    trigger_kind: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    reason_code: Mapped[str | None] = mapped_column(String(80, collation="ascii_bin"))
    source: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    state: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    outcome: Mapped[str | None] = mapped_column(String(24, collation="ascii_bin"))
    snapshot_hash: Mapped[str] = mapped_column(hash_type)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class CaseExecution(Base):
    __tablename__ = "veriq_case_executions"
    __table_args__ = (
        UniqueConstraint("workspace_id", "run_id", "id"),
        ForeignKeyConstraint(
            ["workspace_id", "source_snapshot_hash"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
        ForeignKeyConstraint(
            ["workspace_id", "published_case_version_id"],
            ["veriq_resource_versions.workspace_id", "veriq_resource_versions.id"],
        ),
        CheckConstraint(
            "(published_case_version_id IS NULL) <> (candidate_version_id IS NULL)",
            name="ck_case_source_kind",
        ),
        CheckConstraint(
            "case_version_id = COALESCE(published_case_version_id, candidate_version_id)",
            name="ck_case_source_identity",
        ),
        UniqueConstraint("workspace_id", "id"),
        UniqueConstraint("run_id", "variant_key"),
        ForeignKeyConstraint(
            ["workspace_id", "run_id"], ["veriq_runs.workspace_id", "veriq_runs.id"]
        ),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    run_id: Mapped[str] = mapped_column(uuid_type)
    case_version_id: Mapped[str] = mapped_column(uuid_type)
    published_case_version_id: Mapped[str | None] = mapped_column(uuid_type)
    candidate_version_id: Mapped[str | None] = mapped_column(uuid_type)
    source_snapshot_hash: Mapped[str] = mapped_column(hash_type)
    variant_key: Mapped[str] = mapped_column(hash_type)
    provenance: Mapped[dict[str, Any]] = mapped_column(JSON)
    state: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    outcome: Mapped[str | None] = mapped_column(String(24, collation="ascii_bin"))


class Attempt(Base):
    __tablename__ = "veriq_attempts"
    __table_args__ = (
        Index("ix_veriq_attempt_expiry", "workspace_id", "phase", "lease_expires_at", "id"),
        UniqueConstraint("workspace_id", "id", "runtime_id"),
        ForeignKeyConstraint(
            ["workspace_id", "snapshot_hash"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
        ForeignKeyConstraint(
            ["workspace_id", "manifest_hash"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
        CheckConstraint(
            "fencing_token >= 1 AND fencing_token <= 9007199254740991", name="ck_attempt_fence"
        ),
        CheckConstraint(
            "phase IN ('LEASED','PREPARING','RUNNING','CLEANING','FINALIZING','FINISHED')",
            name="ck_attempt_phase",
        ),
        CheckConstraint(
            "capacity_state IN ('HELD','QUARANTINED','RELEASED')", name="ck_attempt_capacity_state"
        ),
        UniqueConstraint("workspace_id", "id"),
        UniqueConstraint("job_id", "attempt_no"),
        UniqueConstraint("workspace_id", "job_id", "id"),
        UniqueConstraint("workspace_id", "job_id", "id", "runtime_id"),
        ForeignKeyConstraint(
            ["workspace_id", "job_id"], ["veriq_jobs.workspace_id", "veriq_jobs.id"]
        ),
        ForeignKeyConstraint(
            ["runtime_id", "workspace_id"],
            ["veriq_runtime_bindings.runtime_id", "veriq_runtime_bindings.workspace_id"],
        ),
        CheckConstraint("attempt_no >= 1 AND attempt_no <= 2", name="ck_attempt_retry_bound"),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    job_id: Mapped[str] = mapped_column(uuid_type)
    runtime_id: Mapped[str] = mapped_column(uuid_type)
    attempt_no: Mapped[int] = mapped_column(Integer)
    snapshot_hash: Mapped[str] = mapped_column(hash_type)
    manifest_hash: Mapped[str] = mapped_column(hash_type)
    lease_token_hash: Mapped[str] = mapped_column(hash_type)
    fencing_token: Mapped[int] = mapped_column(BigInteger)
    lease_expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    activated_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    phase: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    outcome: Mapped[str | None] = mapped_column(String(24, collation="ascii_bin"))
    capacity_state: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    facts: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    execution_provenance: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    finished_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    finish_hash: Mapped[str | None] = mapped_column(hash_type)
    finish_receipt: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    last_sequence: Mapped[int] = mapped_column(BigInteger, default=0)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class CapacityPool(Base):
    __tablename__ = "veriq_capacity_pools"
    key: Mapped[str] = mapped_column(String(240, collation="ascii_bin"), primary_key=True)
    limit: Mapped[int] = mapped_column(Integer)
    used: Mapped[int] = mapped_column(Integer, default=0)
    __table_args__ = (CheckConstraint("used >= 0 AND used <= `limit`", name="ck_capacity_bound"),)


class ResourceLease(Base):
    __tablename__ = "veriq_resource_leases"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "attempt_id"], ["veriq_attempts.workspace_id", "veriq_attempts.id"]
        ),
    )
    attempt_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    pool_key: Mapped[str] = mapped_column(
        String(240, collation="ascii_bin"), ForeignKey("veriq_capacity_pools.key"), primary_key=True
    )
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    state: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))


class ClaimReceipt(Base):
    __tablename__ = "veriq_claim_receipts"
    __table_args__ = (
        Index("ix_veriq_claim_idle", "runtime_id", "attempt_id"),
        Index("ix_veriq_claim_expiry", "workspace_id", "created_at"),
        ForeignKeyConstraint(
            ["runtime_id", "workspace_id"],
            ["veriq_runtime_bindings.runtime_id", "veriq_runtime_bindings.workspace_id"],
        ),
        ForeignKeyConstraint(
            ["workspace_id", "attempt_id", "runtime_id"],
            ["veriq_attempts.workspace_id", "veriq_attempts.id", "veriq_attempts.runtime_id"],
        ),
    )
    runtime_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    client_request_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    request_hash: Mapped[str] = mapped_column(hash_type)
    attempt_id: Mapped[str | None] = mapped_column(uuid_type)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class AttemptEvent(Base):
    __tablename__ = "veriq_attempt_events"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "attempt_id"], ["veriq_attempts.workspace_id", "veriq_attempts.id"]
        ),
    )
    attempt_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    sequence: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    event_hash: Mapped[str] = mapped_column(hash_type)
    document: Mapped[dict[str, Any]] = mapped_column(JSON)


class AttemptUpload(Base):
    __tablename__ = "veriq_attempt_uploads"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "attempt_id"], ["veriq_attempts.workspace_id", "veriq_attempts.id"]
        ),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    attempt_id: Mapped[str] = mapped_column(uuid_type, index=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    sha256: Mapped[str] = mapped_column(hash_type)
    size_bytes: Mapped[int] = mapped_column(Integer)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON)
    content: Mapped[bytes] = mapped_column(LONGBLOB, default=bytes)
    expired_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    complete: Mapped[bool] = mapped_column(Boolean, default=False)


class MaintenanceReceipt(Base):
    __tablename__ = "veriq_maintenance_receipts"
    __table_args__ = (UniqueConstraint("workspace_id", "id"),)
    id: Mapped[str] = mapped_column(uuid_type)
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), primary_key=True
    )
    idempotency_key: Mapped[str] = mapped_column(
        String(160, collation="ascii_bin"), primary_key=True
    )
    request_hash: Mapped[str] = mapped_column(hash_type)
    receipt: Mapped[dict[str, Any]] = mapped_column(JSON)
