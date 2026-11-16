"""VeriQ 为制品保留期增加数据库生成的创建时间和工作区扫描索引，历史未知年龄统一从迁移时刻起算，
不把旧内容推测为已经过期，也不为回收功能增加新的无前缀状态表。
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import DATETIME

revision = "0015_artifact_retention"
down_revision = "0014_execution_plans"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """非空时间列由 MySQL 当前事务时钟填充已有行并成为后续插入默认值，迁移之后至少经过完整保留期才允许回收旧缓存，
    索引把工作区与年龄及稳定摘要游标共同纳入扫描条件。
    """
    op.add_column(
        "veriq_artifacts",
        sa.Column(
            "created_at",
            DATETIME(fsp=6),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP(6)"),
        ),
    )
    op.create_index(
        "ix_veriq_artifact_retention", "veriq_artifacts", ["workspace_id", "created_at", "sha256"]
    )


def downgrade() -> None:
    """降级会丢弃回收安全所依赖的年龄事实，因此只允许完全没有制品的空安装回退，生产恢复必须使用匹配版本的完整快照，
    不能移除时间列后继续猜测历史对象的有效保留窗口。
    """
    if op.get_bind().execute(sa.text("SELECT 1 FROM veriq_artifacts LIMIT 1")).first():
        raise RuntimeError("Artifact retention history must be retained; downgrade refused")
    op.drop_index("ix_veriq_artifact_retention", table_name="veriq_artifacts")
    op.drop_column("veriq_artifacts", "created_at")
