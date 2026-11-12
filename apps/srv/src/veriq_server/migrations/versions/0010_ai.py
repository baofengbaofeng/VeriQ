
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import DATETIME, LONGBLOB

revision = "0010_ai"
down_revision = "0009_publication_fences"
branch_labels = None
depends_on = None


def upgrade() -> None:
    uid = sa.String(36, collation="ascii_bin")
    op.create_table(
        "veriq_ai_providers",
        sa.Column("id", uid, primary_key=True),
        sa.Column("workspace_id", uid, sa.ForeignKey("veriq_workspaces.id"), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("config", sa.JSON, nullable=False),
        sa.Column("enabled", sa.Boolean, nullable=False),
        sa.Column("deleted", sa.Boolean, nullable=False),
        sa.Column("key_id", sa.String(80), nullable=False),
        sa.Column("key_version", uid, nullable=False),
        sa.Column("nonce", LONGBLOB, nullable=False),
        sa.Column("ciphertext", LONGBLOB, nullable=False),
    )
    op.create_index("ix_veriq_ai_providers_workspace_id", "veriq_ai_providers", ["workspace_id"])
    op.create_table(
        "veriq_ai_generations",
        sa.Column("id", uid, primary_key=True),
        sa.Column("workspace_id", uid, sa.ForeignKey("veriq_workspaces.id"), nullable=False),
        sa.Column("provider_id", uid, sa.ForeignKey("veriq_ai_providers.id"), nullable=False),
        sa.Column("actor_id", uid, sa.ForeignKey("veriq_users.id"), nullable=False),
        sa.Column("request_id", uid, nullable=False),
        sa.Column("request_hash", sa.String(64, collation="ascii_bin"), nullable=False),
        sa.Column("created_at", DATETIME(fsp=6), nullable=False),
        sa.Column("month", sa.String(7), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("purpose", sa.String(24), nullable=False),
        sa.Column("reserved_micros", sa.BigInteger, nullable=False),
        sa.Column("cost_micros", sa.BigInteger),
        sa.Column("data", sa.JSON, nullable=False),
        sa.UniqueConstraint("workspace_id", "request_id", name="uq_ai_request"),
    )
    op.create_index("ix_ai_history", "veriq_ai_generations", ["workspace_id", "created_at", "id"])


def downgrade() -> None:
    if op.get_bind().execute(sa.text("SELECT COUNT(*) FROM veriq_ai_generations")).scalar_one():
        raise RuntimeError("AI reservation history must be retained")
    op.drop_table("veriq_ai_generations")
    op.drop_table("veriq_ai_providers")
