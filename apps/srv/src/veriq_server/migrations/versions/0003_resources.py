"""Immutable resources and shared validation queue."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

revision = "0003_resources"
down_revision = "0002_workspaces"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "veriq_artifacts",
        sa.Column("workspace_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("sha256", sa.String(length=64, collation="ascii_bin"), nullable=False),
        sa.Column("content", mysql.LONGBLOB(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("media_type", sa.String(length=80, collation="ascii_bin"), nullable=False),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["veriq_workspaces.id"],
        ),
        sa.PrimaryKeyConstraint("workspace_id", "sha256"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_0900_as_cs",
        mysql_engine="InnoDB",
    )
    op.create_table(
        "veriq_resources",
        sa.Column("id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("workspace_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("kind", sa.String(length=24, collation="ascii_bin"), nullable=False),
        sa.Column("key", sa.String(length=160, collation="ascii_bin"), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("status", sa.String(length=16, collation="ascii_bin"), nullable=False),
        sa.Column("latest_version_id", sa.String(length=36, collation="ascii_bin"), nullable=True),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["veriq_workspaces.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workspace_id", "id"),
        sa.UniqueConstraint("workspace_id", "kind", "key"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_0900_as_cs",
        mysql_engine="InnoDB",
    )
    op.create_table(
        "veriq_jobs",
        sa.Column("id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("workspace_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("kind", sa.String(length=16, collation="ascii_bin"), nullable=False),
        sa.Column("subject_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("state", sa.String(length=24, collation="ascii_bin"), nullable=False),
        sa.Column("snapshot_hash", sa.String(length=64, collation="ascii_bin"), nullable=False),
        sa.Column("manifest_hash", sa.String(length=64, collation="ascii_bin"), nullable=False),
        sa.Column("validation_key", sa.String(length=64, collation="ascii_bin"), nullable=True),
        sa.Column("required_capabilities", sa.JSON(), nullable=False),
        sa.Column("active_attempt_id", sa.String(length=36, collation="ascii_bin"), nullable=True),
        sa.Column("created_by", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("created_at", mysql.DATETIME(fsp=6), nullable=False),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["veriq_users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id", "manifest_hash"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id", "snapshot_hash"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["veriq_workspaces.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workspace_id", "id"),
        sa.UniqueConstraint("workspace_id", "validation_key"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_0900_as_cs",
        mysql_engine="InnoDB",
    )
    op.create_index(op.f("ix_veriq_jobs_state"), "veriq_jobs", ["state"], unique=False)
    op.create_table(
        "veriq_resource_drafts",
        sa.Column("resource_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("workspace_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("revision", sa.BigInteger(), nullable=False),
        sa.Column("document_json", sa.JSON(), nullable=False),
        sa.Column("updated_by", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("updated_at", mysql.DATETIME(fsp=6), nullable=False),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["veriq_users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id", "resource_id"],
            ["veriq_resources.workspace_id", "veriq_resources.id"],
        ),
        sa.PrimaryKeyConstraint("resource_id"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_0900_as_cs",
        mysql_engine="InnoDB",
    )
    op.create_table(
        "veriq_resource_versions",
        sa.Column("id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("resource_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("workspace_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("kind", sa.String(length=24, collation="ascii_bin"), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("draft_revision", sa.BigInteger(), nullable=False),
        sa.Column("document_json", sa.JSON(), nullable=False),
        sa.Column("sha256", sa.String(length=64, collation="ascii_bin"), nullable=False),
        sa.Column("source_hash", sa.String(length=64, collation="ascii_bin"), nullable=False),
        sa.Column("engine_version", sa.String(length=80, collation="ascii_bin"), nullable=False),
        sa.Column("receipt_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("published_by", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("published_at", mysql.DATETIME(fsp=6), nullable=False),
        sa.ForeignKeyConstraint(
            ["published_by"],
            ["veriq_users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id", "resource_id"],
            ["veriq_resources.workspace_id", "veriq_resources.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("resource_id", "draft_revision"),
        sa.UniqueConstraint("resource_id", "version_no"),
        sa.UniqueConstraint("workspace_id", "id"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_0900_as_cs",
        mysql_engine="InnoDB",
    )
    op.create_table(
        "veriq_resource_dependencies",
        sa.Column("workspace_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("version_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column(
            "dependency_version_id", sa.String(length=36, collation="ascii_bin"), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id", "dependency_version_id"],
            ["veriq_resource_versions.workspace_id", "veriq_resource_versions.id"],
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id", "version_id"],
            ["veriq_resource_versions.workspace_id", "veriq_resource_versions.id"],
        ),
        sa.PrimaryKeyConstraint("workspace_id", "version_id", "dependency_version_id"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_0900_as_cs",
        mysql_engine="InnoDB",
    )
    op.create_table(
        "veriq_validation_receipts",
        sa.Column("id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("workspace_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("resource_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("job_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("revision", sa.BigInteger(), nullable=False),
        sa.Column("source_hash", sa.String(length=64, collation="ascii_bin"), nullable=False),
        sa.Column("engine_version", sa.String(length=80, collation="ascii_bin"), nullable=False),
        sa.Column(
            "compiled_bundle_sha256", sa.String(length=64, collation="ascii_bin"), nullable=False
        ),
        sa.Column("runtime_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("attempt_id", sa.String(length=36, collation="ascii_bin"), nullable=False),
        sa.Column("compiler_trust", sa.String(length=24, collation="ascii_bin"), nullable=False),
        sa.Column("validated_at", mysql.DATETIME(fsp=6), nullable=False),
        sa.ForeignKeyConstraint(
            ["workspace_id", "compiled_bundle_sha256"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id", "job_id"],
            ["veriq_jobs.workspace_id", "veriq_jobs.id"],
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id", "resource_id"],
            ["veriq_resources.workspace_id", "veriq_resources.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_0900_as_cs",
        mysql_engine="InnoDB",
    )


def downgrade() -> None:
    op.drop_table("veriq_validation_receipts")
    op.drop_table("veriq_resource_dependencies")
    op.drop_table("veriq_resource_versions")
    op.drop_table("veriq_resource_drafts")
    op.drop_table("veriq_jobs")
    op.drop_table("veriq_resources")
    op.drop_table("veriq_artifacts")
