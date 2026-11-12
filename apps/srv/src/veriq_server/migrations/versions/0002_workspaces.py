
from typing import Any
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import DATETIME

revision = "0002_workspaces"
down_revision = "0001_accounts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    uid = sa.String(36, collation="ascii_bin")
    role = sa.String(16, collation="ascii_bin")
    options: dict[str, Any] = {
        "mysql_engine": "InnoDB",
        "mysql_charset": "utf8mb4",
        "mysql_collate": "utf8mb4_0900_as_cs",
    }
    op.create_table(
        "veriq_workspaces",
        sa.Column("id", uid, primary_key=True),
        sa.Column("key", sa.String(160, collation="ascii_bin"), nullable=False, unique=True),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("archived", sa.Boolean, nullable=False),
        sa.Column("created_at", DATETIME(fsp=6), nullable=False),
        **options,
    )
    op.create_table(
        "veriq_workspace_members",
        sa.Column("workspace_id", uid, sa.ForeignKey("veriq_workspaces.id"), primary_key=True),
        sa.Column("user_id", uid, sa.ForeignKey("veriq_users.id"), primary_key=True),
        sa.Column("role", role, nullable=False),
        sa.Column("status", role, nullable=False),
        **options,
    )
    op.create_index("ix_veriq_workspace_members_user_id", "veriq_workspace_members", ["user_id"])
    op.create_table(
        "veriq_workspace_invites",
        sa.Column("id", uid, primary_key=True),
        sa.Column("workspace_id", uid, sa.ForeignKey("veriq_workspaces.id"), nullable=False),
        sa.Column("email", sa.String(254, collation="utf8mb4_0900_as_ci"), nullable=False),
        sa.Column("role", role, nullable=False),
        sa.Column("token_hash", sa.String(64, collation="ascii_bin"), nullable=False, unique=True),
        sa.Column("expires_at", DATETIME(fsp=6), nullable=False),
        sa.Column("created_at", DATETIME(fsp=6), nullable=False),
        sa.Column("consumed", sa.Boolean, nullable=False),
        sa.Column("revoked", sa.Boolean, nullable=False),
        **options,
    )
    op.create_index(
        "ix_veriq_workspace_invites_workspace_id", "veriq_workspace_invites", ["workspace_id"]
    )

    op.add_column("veriq_audit_logs", sa.Column("workspace_id", uid, nullable=True))
    op.create_foreign_key(
        "fk_veriq_audit_workspace", "veriq_audit_logs", "veriq_workspaces", ["workspace_id"], ["id"]
    )
    op.create_index("ix_veriq_audit_logs_workspace_id", "veriq_audit_logs", ["workspace_id"])


def downgrade() -> None:
    op.drop_constraint("fk_veriq_audit_workspace", "veriq_audit_logs", type_="foreignkey")
    op.drop_index("ix_veriq_audit_logs_workspace_id", table_name="veriq_audit_logs")
    op.drop_column("veriq_audit_logs", "workspace_id")
    op.drop_table("veriq_workspace_invites")
    op.drop_table("veriq_workspace_members")
    op.drop_table("veriq_workspaces")
