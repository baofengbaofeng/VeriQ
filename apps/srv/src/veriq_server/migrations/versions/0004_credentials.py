"""Workspace-bound encrypted credential versions."""

from typing import Any
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

revision = "0004_credentials"
down_revision = "0003_resources"
branch_labels = None
depends_on = None


def upgrade() -> None:
    uid = sa.String(36, collation="ascii_bin")
    key = sa.String(160, collation="ascii_bin")
    options: dict[str, Any] = {
        "mysql_charset": "utf8mb4",
        "mysql_collate": "utf8mb4_0900_as_cs",
        "mysql_engine": "InnoDB",
    }
    op.create_table(
        "veriq_secret_refs",
        sa.Column("workspace_id", uid, nullable=False),
        sa.Column("key", key, nullable=False),
        sa.Column("created_at", mysql.DATETIME(fsp=6), nullable=False),
        sa.PrimaryKeyConstraint("workspace_id", "key"),
        sa.ForeignKeyConstraint(["workspace_id"], ["veriq_workspaces.id"]),
        **options,
    )
    op.create_table(
        "veriq_secret_versions",
        sa.Column("id", uid, nullable=False),
        sa.Column("workspace_id", uid, nullable=False),
        sa.Column("secret_ref", key, nullable=False),
        sa.Column("key_id", sa.String(80, collation="ascii_bin"), nullable=False),
        sa.Column("nonce", mysql.LONGBLOB(), nullable=False),
        sa.Column("ciphertext", mysql.LONGBLOB(), nullable=False),
        sa.Column("allowed_identity_ids", sa.JSON(), nullable=False),
        sa.Column("revoked", sa.Boolean(), nullable=False),
        sa.Column("created_at", mysql.DATETIME(fsp=6), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workspace_id", "id"),
        sa.ForeignKeyConstraint(
            ["workspace_id", "secret_ref"],
            ["veriq_secret_refs.workspace_id", "veriq_secret_refs.key"],
        ),
        **options,
    )

    op.create_table(
        "veriq_auth_adapter_versions",
        sa.Column("id", uid, nullable=False),
        sa.Column("workspace_id", uid, nullable=False),
        sa.Column("content_hash", sa.String(64, collation="ascii_bin"), nullable=False),
        sa.Column("configuration", sa.JSON(), nullable=False),
        sa.Column("revoked", sa.Boolean(), nullable=False),
        sa.Column("created_at", mysql.DATETIME(fsp=6), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["workspace_id"], ["veriq_workspaces.id"]),
        **options,
    )
    op.create_index(
        "ix_veriq_auth_adapter_versions_workspace_id",
        "veriq_auth_adapter_versions",
        ["workspace_id"],
    )


def downgrade() -> None:
    op.drop_table("veriq_auth_adapter_versions")
    op.drop_table("veriq_secret_versions")
    op.drop_table("veriq_secret_refs")
