"""保存会话标题的人工锁定状态，并用独立字段存放可公开的供应商推理摘要，保留原有会话数据。"""

import sqlalchemy as sa
from alembic import op

revision = "0021_agent_title_activity"
down_revision = "0020_server_compilation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """旧会话没有标题来源记录，统一保留原题；摘要使用新列，原始思考字段在升级后的 API 中不再公开。"""
    op.add_column(
        "veriq_agent_sessions",
        sa.Column("title_locked", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column("veriq_agent_turns", sa.Column("reasoning_summary", sa.Text()))


def downgrade() -> None:
    """回退只移除新版本独立保存的摘要及锁定状态，用户标题、正文、工具步骤与原始旧列均保持原有值。"""
    op.drop_column("veriq_agent_turns", "reasoning_summary")
    op.drop_column("veriq_agent_sessions", "title_locked")
