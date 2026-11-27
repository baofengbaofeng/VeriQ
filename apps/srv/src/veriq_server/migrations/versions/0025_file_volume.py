"""在安装单例上保存各控制节点共同使用的文件卷标识，升级时先保留空值，待核验历史证据后绑定原卷。"""

import sqlalchemy as sa
from alembic import op

revision = "0025_file_volume"
down_revision = "0024_notification_inbox"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("veriq_installation", sa.Column("file_volume_id", sa.String(36), nullable=True))


def downgrade() -> None:
    op.drop_column("veriq_installation", "file_volume_id")
