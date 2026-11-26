"""为有效登录会话增加可空展示分类和活动时间，旧记录的凭证摘要、有效期和会话标识均不需要重写。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.mysql import DATETIME

revision = "0023_account_sessions"
down_revision = "0022_agent_attachments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """仅添加可空字段，升级前已经登录的客户端继续认证，没有记录过的分类或活动时间由账户接口省略。"""
    op.add_column("veriq_user_sessions", sa.Column("browser", sa.String(16, collation="ascii_bin")))
    op.add_column(
        "veriq_user_sessions", sa.Column("operating_system", sa.String(16, collation="ascii_bin"))
    )
    op.add_column("veriq_user_sessions", sa.Column("last_active_at", DATETIME(fsp=6)))


def downgrade() -> None:
    """撤回新字段时只舍弃可重建的活动及分类摘要，保留旧版使用的认证摘要、创建时间与固定过期时间。"""
    op.drop_column("veriq_user_sessions", "last_active_at")
    op.drop_column("veriq_user_sessions", "operating_system")
    op.drop_column("veriq_user_sessions", "browser")
