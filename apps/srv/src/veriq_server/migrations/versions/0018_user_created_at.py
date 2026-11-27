"""为控制面用户账号补充创建时间列，既有账号回填为迁移时刻的 UTC 墙钟时间，仅用于列表展示与审计，不改动认证或授权。"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import DATETIME

revision = "0018_user_created_at"
down_revision = "0017_conversational_agent"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """新增非空 created_at 列，迁移时用服务器当前时间回填既有用户；应用层此后显式写入 now() 保证与模型一致。"""
    op.add_column(
        "veriq_users",
        sa.Column(
            "created_at",
            DATETIME(fsp=6),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP(6)"),
        ),
    )


def downgrade() -> None:
    """回退时从 veriq_users 删除 created_at，既有账号的创建时间随列删除，再次升级会按新的迁移时刻回填。"""
    op.drop_column("veriq_users", "created_at")
