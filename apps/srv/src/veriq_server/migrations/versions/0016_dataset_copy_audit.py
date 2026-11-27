"""为复制事件保留明确的来源版本，历史审计行继续保留原义，不从现有草稿或时间推测来源。"""

from alembic import op
import sqlalchemy as sa

revision = "0016_dataset_copy_audit"
down_revision = "0015_artifact_retention"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """来源版本标识仅适用于复制事件，允许为空使既有审计写入及其他业务事件无需构造虚假来源。"""
    op.add_column(
        "veriq_audit_logs",
        sa.Column("source_version_id", sa.String(36, collation="ascii_bin"), nullable=True),
    )


def require_downgrade_safe(connection: sa.Connection) -> None:
    """检查是否存在新版专有的复制来源标识，防止旧版表结构无法记录的数据集版本关系随降级而丢失。"""
    if connection.execute(
        sa.text("SELECT 1 FROM veriq_audit_logs WHERE source_version_id IS NOT NULL LIMIT 1")
    ).first():
        raise RuntimeError("Dataset copy provenance must be retained; downgrade refused")


def downgrade() -> None:
    """单独回退复制审计时执行相同预检，只有通过保护后才允许触发 MySQL 隐式提交的结构变更。"""
    require_downgrade_safe(op.get_bind())
    op.drop_column("veriq_audit_logs", "source_version_id")
