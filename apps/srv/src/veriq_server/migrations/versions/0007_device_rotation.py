"""Hash-only recoverable device token rotation."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

revision = "0007_device_rotation"
down_revision = "0006_execution"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("veriq_runtimes", sa.Column("last_seen_at", mysql.DATETIME(fsp=6), nullable=True))
    op.add_column(
        "veriq_runtime_tokens",
        sa.Column("rotation_request_id", sa.String(36, collation="ascii_bin"), nullable=True),
    )
    op.add_column(
        "veriq_runtime_tokens",
        sa.Column("successor_hash", sa.String(64, collation="ascii_bin"), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("veriq_runtimes", "last_seen_at")
    op.drop_column("veriq_runtime_tokens", "successor_hash")
    op.drop_column("veriq_runtime_tokens", "rotation_request_id")
