"""为既有对话轮次增加可空附件元数据和重放指纹，保留历史兼容，附件字节始终留在单轮模型请求内存中。"""

import sqlalchemy as sa
from alembic import op

revision = "0022_agent_attachments"
down_revision = "0021_agent_title_activity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """新增历史展示和重放判定各需的一列，历史无附件的记录保持为空，附件入站正文无需额外存储或迁移。"""
    op.add_column("veriq_agent_turns", sa.Column("attachments", sa.JSON))
    op.add_column(
        "veriq_agent_turns",
        sa.Column("attachment_fingerprint", sa.String(64, collation="ascii_bin")),
    )


def downgrade() -> None:
    """回到不支持附件的历史格式时移除元数据及指纹，旧的非空正文约束恢复前为无正文轮次保留可阅读提示。"""
    op.execute(
        "UPDATE veriq_agent_turns SET text = '[Attachment]' WHERE text = '' AND attachments IS NOT NULL"
    )
    op.drop_column("veriq_agent_turns", "attachment_fingerprint")
    op.drop_column("veriq_agent_turns", "attachments")
