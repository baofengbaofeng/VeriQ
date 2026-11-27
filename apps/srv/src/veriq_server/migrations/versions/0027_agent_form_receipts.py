"""保存由领域事务确认的 Test Agent 表单操作回执。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.mysql import DATETIME

revision = "0027_agent_form_receipts"
down_revision = "0026_agent_tasks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """新增轮次外键和时间索引，既有会话不需要回填。"""
    uid = sa.String(36, collation="ascii_bin")
    op.create_table(
        "veriq_agent_form_receipts",
        sa.Column("id", uid, primary_key=True),
        sa.Column("turn_id", uid, sa.ForeignKey("veriq_agent_turns.id"), nullable=False),
        sa.Column("action", sa.String(64, collation="ascii_bin"), nullable=False),
        sa.Column("target_id", uid, nullable=False),
        sa.Column("revision", sa.BigInteger),
        sa.Column("created_at", DATETIME(fsp=6), nullable=False),
        sa.Index("ix_agent_form_history", "turn_id", "created_at", "id"),
    )


def require_downgrade_safe(connection: sa.Connection) -> None:
    """旧版无法读取回执，在执行任何跨版本 DDL 前检查是否存在用户历史。"""
    if connection.execute(sa.text("SELECT 1 FROM veriq_agent_form_receipts LIMIT 1")).first():
        raise RuntimeError("Persisted Test Agent form receipts must be retained")


def downgrade() -> None:
    """守卫通过时移除空表。"""
    require_downgrade_safe(op.get_bind())
    op.drop_table("veriq_agent_form_receipts")
