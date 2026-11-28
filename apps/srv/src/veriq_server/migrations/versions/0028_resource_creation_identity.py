"""为资源保留首次创建请求的指纹以支持录制草稿恢复，新增列允许既有记录为空，回退前检查是否已存恢复标识。"""

import sqlalchemy as sa
from alembic import op

__doc__ = """Retain the original create request fingerprint for recoverable draft creation."""

revision = "0028_resource_creation_identity"
down_revision = "0027_agent_form_receipts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """在资源表新增允许为空的创建请求指纹列，不改写既有资源标识和草稿内容，旧记录可继续保持空指纹。"""
    op.add_column(
        "veriq_resources",
        sa.Column("creation_request_hash", sa.String(64, collation="ascii_bin"), nullable=True),
    )


def downgrade() -> None:
    """回退前检查是否已有资源保存创建请求指纹，存在时拒绝删除恢复依据；仅当整列为空时才允许移除该列。"""
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
