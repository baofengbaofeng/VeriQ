
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import DATETIME, LONGBLOB

revision = "0011_bundles"
down_revision = "0010_ai"
branch_labels = None
depends_on = None


def upgrade() -> None:
    uid = sa.String(36, collation="ascii_bin")
    digest = sa.String(64, collation="ascii_bin")
    op.create_table(
        "veriq_bundles",
        sa.Column("id", uid, primary_key=True),
        sa.Column("workspace_id", uid, sa.ForeignKey("veriq_workspaces.id"), nullable=False),
        sa.Column("exported_by", uid, sa.ForeignKey("veriq_users.id"), nullable=False),
        sa.Column("manifest_hash", digest, nullable=False),
        sa.Column("archive_hash", digest, nullable=False),
        sa.Column("snapshot_hash", digest, nullable=False),
        sa.Column("signature", LONGBLOB, nullable=False),
        sa.Column("contains_draft", sa.Boolean, nullable=False),
        sa.Column("validation_status", sa.String(20), nullable=False),
        sa.Column("created_at", DATETIME(fsp=6), nullable=False),
    )
    op.create_index("ix_veriq_bundles_workspace_id", "veriq_bundles", ["workspace_id"])


def downgrade() -> None:
    if op.get_bind().execute(sa.text("SELECT COUNT(*) FROM veriq_bundles")).scalar_one():
        raise RuntimeError("Signed bundle provenance must be retained")
    op.drop_table("veriq_bundles")
