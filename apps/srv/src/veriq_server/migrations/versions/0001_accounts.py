"""Initial VeriQ account schema and singleton initialization guard."""

from typing import Any
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import DATETIME

revision = "0001_accounts"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    uid = sa.String(36, collation="ascii_bin")
    digest = sa.String(64, collation="ascii_bin")
    options: dict[str, Any] = {
        "mysql_engine": "InnoDB",
        "mysql_charset": "utf8mb4",
        "mysql_collate": "utf8mb4_0900_as_cs",
    }
    op.create_table(
        "veriq_installation",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("initialized", sa.Boolean, nullable=False),
        sa.Column("setup_secret_hash", digest),
        **options,
    )
    op.execute(sa.text("INSERT INTO veriq_installation (id, initialized) VALUES (1, 0)"))
    op.create_table(
        "veriq_users",
        sa.Column("id", uid, primary_key=True),
        sa.Column(
            "email", sa.String(254, collation="utf8mb4_0900_as_ci"), nullable=False, unique=True
        ),
        sa.Column("display_name", sa.String(160), nullable=False),
        sa.Column("password_hash", sa.String(255, collation="ascii_bin"), nullable=False),
        sa.Column("disabled", sa.Boolean, nullable=False),
        sa.Column("system_admin", sa.Boolean, nullable=False),
        **options,
    )
    op.create_table(
        "veriq_user_sessions",
        sa.Column("id", uid, primary_key=True),
        sa.Column("user_id", uid, sa.ForeignKey("veriq_users.id"), nullable=False, index=True),
        sa.Column("token_hash", digest, nullable=False, unique=True),
        sa.Column("expires_at", DATETIME(fsp=6), nullable=False),
        sa.Column("created_at", DATETIME(fsp=6), nullable=False),
        **options,
    )
    op.create_table(
        "veriq_user_tokens",
        sa.Column("id", uid, primary_key=True),
        sa.Column("user_id", uid, sa.ForeignKey("veriq_users.id"), nullable=False, index=True),
        sa.Column("token_hash", digest, nullable=False, unique=True),
        sa.Column("expires_at", DATETIME(fsp=6), nullable=False),
        sa.Column("consumed", sa.Boolean, nullable=False),
        **options,
    )
    op.create_table(
        "veriq_audit_logs",
        sa.Column("id", uid, primary_key=True),
        sa.Column("actor_id", uid),
        sa.Column("target_id", uid),
        sa.Column("action", sa.String(80, collation="ascii_bin"), nullable=False),
        sa.Column("created_at", DATETIME(fsp=6), nullable=False),
        **options,
    )


def downgrade() -> None:
    for table in [
        "veriq_audit_logs",
        "veriq_user_tokens",
        "veriq_user_sessions",
        "veriq_users",
        "veriq_installation",
    ]:
        op.drop_table(table)
