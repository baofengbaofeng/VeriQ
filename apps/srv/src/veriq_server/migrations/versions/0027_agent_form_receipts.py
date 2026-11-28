"""新增关联私有对话轮次的表单操作回执表，保存领域事务确认的实体与修订信息，并阻止丢失已有回执的降级。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.mysql import DATETIME

__doc__ = """保存由领域事务确认的 Test Agent 表单操作回执。"""

revision = "0027_agent_form_receipts"
down_revision = "0026_agent_tasks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """新增带轮次外键的回执表，并按轮次、创建时间和标识建立历史索引；既有会话无需回填任何回执数据。"""
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
    """旧版无法读取私有表单回执，在执行跨版本结构变更前检查是否已有历史记录；存在记录时立即拒绝降级。"""
    if connection.execute(sa.text("SELECT 1 FROM veriq_agent_form_receipts LIMIT 1")).first():
        raise RuntimeError("Persisted Test Agent form receipts must be retained")


def downgrade() -> None:
    """先查询回执表并拒绝删除已保存的用户历史，只有确认表内没有记录后，才移除本次迁移新增的回执表。"""
    require_downgrade_safe(op.get_bind())
    op.drop_table("veriq_agent_form_receipts")
