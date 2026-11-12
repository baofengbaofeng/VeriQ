
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import DATETIME

revision = "0012_bundle_exports"
down_revision = "0011_bundles"
branch_labels = None
depends_on = None


def upgrade() -> None:
    uid = sa.String(36, collation="ascii_bin")
    op.create_table(
        "veriq_bundle_exports",
        sa.Column("id", uid, primary_key=True),
        sa.Column("workspace_id", uid, sa.ForeignKey("veriq_workspaces.id"), nullable=False),
        sa.Column("idempotency_key", sa.String(160, collation="ascii_bin"), nullable=False),
        sa.Column("actor_id", uid, sa.ForeignKey("veriq_users.id"), nullable=False),
        sa.Column("request_hash", sa.String(64, collation="ascii_bin"), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("bundle_id", uid, sa.ForeignKey("veriq_bundles.id"), nullable=True),
        sa.Column("authority", sa.JSON, nullable=False),
        sa.Column("created_at", DATETIME(fsp=6), nullable=False),
        sa.UniqueConstraint("workspace_id", "idempotency_key"),
    )


def downgrade() -> None:
    if op.get_bind().execute(sa.text("SELECT COUNT(*) FROM veriq_bundle_exports")).scalar_one():
        raise RuntimeError("Export reservations must be retained for retry safety")
    op.drop_table("veriq_bundle_exports")
