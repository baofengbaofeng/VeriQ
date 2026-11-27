"""在安装单例上保存各控制节点共同使用的文件卷标识，升级时先保留空值，待核验历史证据后绑定原卷。"""

import sqlalchemy as sa
from alembic import op

revision = "0025_file_volume"
down_revision = "0024_notification_inbox"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """为既有安装新增可空的证据卷标识，保留原有制品数据，交由操作员从已验证的历史卷完成绑定。"""
    op.add_column("veriq_installation", sa.Column("file_volume_id", sa.String(36), nullable=True))


def require_downgrade_safe(connection: sa.Connection) -> None:
    """确认安装尚未绑定证据文件卷，旧版服务无法校验卷身份，丢弃绑定可能使后续节点从错误的卷读取证据。"""
    bound = connection.execute(
        sa.text("SELECT 1 FROM veriq_installation WHERE file_volume_id IS NOT NULL LIMIT 1")
    ).first()
    if bound:
        raise RuntimeError("Bound FILE volume identity must be retained; downgrade refused")


def downgrade() -> None:
    """未绑定文件卷的安装才允许移除卷标识列，保留已有绑定的数据库需要通过升级前的配套备份回滚。"""
    require_downgrade_safe(op.get_bind())
    op.drop_column("veriq_installation", "file_volume_id")
