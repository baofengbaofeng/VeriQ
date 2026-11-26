"""为复制事件保留明确的来源版本，历史审计行继续保留原义，不从现有草稿或时间推测来源。"""

from alembic import context, op
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


def require_downgrade_safe() -> None:
    """在删除任何新版本结构前先验证复制来源以及本次路径涉及的制品保留历史，两类事实都不能静默丢弃。"""
    if (
        op.get_bind()
        .execute(
            sa.text("SELECT 1 FROM veriq_audit_logs WHERE source_version_id IS NOT NULL LIMIT 1")
        )
        .first()
    ):
        raise RuntimeError("Dataset copy provenance must be retained; downgrade refused")
    # MySQL 删除列会隐式提交；若本次降级还要删除制品年龄，必须在首个结构变更前验证其保留保护。
    migration = op.get_context()
    assert migration.script is not None
    steps = migration.script.iterate_revisions(
        migration.opts["veriq_start_heads"],
        context.get_revision_argument(),
        select_for_downgrade=True,
    )
    for step in steps:
        if step.revision == down_revision:
            step.module.require_empty_artifact_history()
            break


def downgrade() -> None:
    """单独回退复制审计时执行相同预检，只有通过保护后才允许触发 MySQL 隐式提交的结构变更。"""
    require_downgrade_safe()
    op.drop_column("veriq_audit_logs", "source_version_id")
