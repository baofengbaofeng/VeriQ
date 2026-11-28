"""为新重置令牌保留数据库签发时间，使密码重置邮件的冷却在多个 API 节点间一致。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.mysql import DATETIME

revision = "0029_reset_token_issued"
down_revision = "0028_resource_creation_identity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """只增加可空数据库签发时间列，保留旧令牌摘要、有效期及消费状态；升级本身不会使既有重置链接失效。"""
    op.add_column("veriq_user_tokens", sa.Column("issued_at", DATETIME(fsp=6), nullable=True))


def require_downgrade_safe(connection: sa.Connection) -> None:
    """整个降级序列执行 DDL 前核查冷却记录，避免更高修订先发生不可回滚的 MySQL 结构变化。"""
    if connection.execute(
        sa.text(
            "SELECT 1 FROM veriq_user_tokens WHERE consumed = 0 "
            "AND expires_at > UTC_TIMESTAMP(6) "
            "AND issued_at > UTC_TIMESTAMP(6) - INTERVAL 60 SECOND LIMIT 1"
        )
    ).first():
        raise RuntimeError("Issued password reset tokens must retain their delivery cooldown")


def downgrade() -> None:
    """没有活跃冷却依赖时才移除时间列；已消费或过窗的令牌历史不阻止回滚，摘要与有效期继续保留。"""
    require_downgrade_safe(op.get_bind())
    op.drop_column("veriq_user_tokens", "issued_at")
