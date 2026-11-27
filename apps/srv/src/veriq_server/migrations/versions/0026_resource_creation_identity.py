"""Retain the original create request fingerprint for recoverable draft creation."""

import sqlalchemy as sa
from alembic import op

revision = "0026_resource_creation_identity"
down_revision = "0025_file_volume"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add the optional fingerprint while preserving existing resource IDs and drafts."""
    op.add_column(
        "veriq_resources",
        sa.Column("creation_request_hash", sa.String(64, collation="ascii_bin"), nullable=True),
    )


def downgrade() -> None:
    """Preserve fingerprints once recording clients rely on recovering their requests."""
    stored = (
        op.get_bind()
        .execute(
            sa.text("SELECT 1 FROM veriq_resources WHERE creation_request_hash IS NOT NULL LIMIT 1")
        )
        .first()
    )
    if stored:
        raise RuntimeError("Draft creation identity must be retained; downgrade refused")
    op.drop_column("veriq_resources", "creation_request_hash")
