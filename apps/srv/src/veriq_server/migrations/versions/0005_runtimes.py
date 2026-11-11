"""Runtime identity, owner consent and bounded one-time enrollment."""

from typing import Any
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

revision = "0005_runtimes"
down_revision = "0004_credentials"
branch_labels = None
depends_on = None


def upgrade() -> None:
    uid = sa.String(36, collation="ascii_bin")
    digest = sa.String(64, collation="ascii_bin")
    timestamp = mysql.DATETIME(fsp=6)
    options: dict[str, Any] = dict(
        mysql_charset="utf8mb4", mysql_collate="utf8mb4_0900_as_cs", mysql_engine="InnoDB"
    )
    op.create_table(
        "veriq_service_accounts",
        sa.Column("id", uid, primary_key=True),
        sa.Column(
            "workspace_id", uid, sa.ForeignKey("veriq_workspaces.id"), nullable=False, index=True
        ),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("disabled", sa.Boolean(), nullable=False),
        sa.Column("created_by", uid, sa.ForeignKey("veriq_users.id"), nullable=False),
        sa.Column("created_at", timestamp, nullable=False),
        **options,
    )
    op.create_table(
        "veriq_service_tokens",
        sa.Column("id", uid, primary_key=True),
        sa.Column(
            "service_account_id",
            uid,
            sa.ForeignKey("veriq_service_accounts.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("token_hash", digest, nullable=False, unique=True),
        sa.Column("purpose", sa.String(40, collation="ascii_bin"), nullable=False),
        sa.Column("expires_at", timestamp, nullable=False),
        sa.Column("consumed_at", timestamp),
        sa.Column("revoked_at", timestamp),
        sa.Column("created_at", timestamp, nullable=False),
        **options,
    )
    op.create_table(
        "veriq_runtimes",
        sa.Column("id", uid, primary_key=True),
        sa.Column("owner_user_id", uid, sa.ForeignKey("veriq_users.id")),
        sa.Column("owner_service_account_id", uid, sa.ForeignKey("veriq_service_accounts.id")),
        sa.CheckConstraint(
            "(owner_user_id IS NULL) <> (owner_service_account_id IS NULL)",
            name="ck_runtime_one_owner",
        ),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("location", sa.String(24, collation="ascii_bin"), nullable=False),
        sa.Column("trust_status", sa.String(24, collation="ascii_bin"), nullable=False),
        sa.Column("capabilities", sa.JSON(), nullable=False),
        sa.Column("created_at", timestamp, nullable=False),
        **options,
    )
    op.create_table(
        "veriq_runtime_bindings",
        sa.Column("runtime_id", uid, sa.ForeignKey("veriq_runtimes.id"), primary_key=True),
        sa.Column("workspace_id", uid, sa.ForeignKey("veriq_workspaces.id"), primary_key=True),
        sa.Column("shared_with_workspace", sa.Boolean(), nullable=False),
        sa.Column("allow_credential_delivery", sa.Boolean(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        **options,
    )

    def binding_fk() -> sa.ForeignKeyConstraint:
        return sa.ForeignKeyConstraint(
            ["runtime_id", "workspace_id"],
            ["veriq_runtime_bindings.runtime_id", "veriq_runtime_bindings.workspace_id"],
        )

    op.create_table(
        "veriq_runtime_grants",
        sa.Column("runtime_id", uid, primary_key=True),
        sa.Column("workspace_id", uid, primary_key=True),
        sa.Column("user_id", uid, sa.ForeignKey("veriq_users.id"), primary_key=True),
        binding_fk(),
        **options,
    )
    op.create_table(
        "veriq_runtime_enrollments",
        sa.Column("id", uid, primary_key=True),
        sa.Column("user_code_hash", digest, nullable=False, unique=True),
        sa.Column("device_code_hash", digest, nullable=False, unique=True),
        sa.Column("last_polled_at", timestamp),
        sa.Column("request_hash", digest, nullable=False, index=True),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("capabilities", sa.JSON(), nullable=False),
        sa.Column("expires_at", timestamp, nullable=False),
        sa.Column("created_at", timestamp, nullable=False),
        sa.Column("runtime_id", uid, sa.ForeignKey("veriq_runtimes.id")),
        sa.Column("consumed", sa.Boolean(), nullable=False),
        **options,
    )
    op.create_table(
        "veriq_runtime_tokens",
        sa.Column("id", uid, primary_key=True),
        sa.Column("runtime_id", uid, nullable=False),
        sa.Column("workspace_id", uid, nullable=False),
        sa.Column("token_hash", digest, nullable=False, unique=True),
        sa.Column("expires_at", timestamp, nullable=False),
        sa.Column("revoked", sa.Boolean(), nullable=False),
        sa.Column("created_at", timestamp, nullable=False),
        binding_fk(),
        **options,
    )


def downgrade() -> None:
    for name in ["tokens", "enrollments", "grants", "bindings"]:
        op.drop_table("veriq_runtime_" + name)
    op.drop_table("veriq_runtimes")
    op.drop_table("veriq_service_tokens")
    op.drop_table("veriq_service_accounts")
