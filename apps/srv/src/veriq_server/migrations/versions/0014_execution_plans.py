"""新增计划和独立执行令牌的最小持久化关联，既有用户运行与离线导入保持空计划字段，升级不重写历史快照或归因，降级拒绝丢弃已有计划及其服务授权信息。"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import DATETIME

revision = "0014_execution_plans"
down_revision = "0013_offline_imports"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """计划的序号在安装锁事务内分配并保存在运行上，令牌计划列表只存授权标识而不含密钥；所有新增外键均保留原有用户归因，使历史执行无需迁移成虚构服务用户。"""
    uid = sa.String(36, collation="ascii_bin")
    op.create_table(
        "veriq_execution_plans",
        sa.Column("id", uid, primary_key=True),
        sa.Column("workspace_id", uid, sa.ForeignKey("veriq_workspaces.id"), nullable=False),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("next_sequence", sa.Integer, nullable=False),
        sa.Column("archived", sa.Boolean, nullable=False),
        sa.Column("selection", sa.JSON, nullable=False),
        sa.Column("created_by", uid, sa.ForeignKey("veriq_users.id"), nullable=False),
        sa.Column("created_at", DATETIME(fsp=6), nullable=False),
        sa.UniqueConstraint("workspace_id", "id"),
    )
    op.add_column("veriq_service_tokens", sa.Column("plan_scopes", sa.JSON))
    op.add_column("veriq_runs", sa.Column("plan_id", uid))
    op.add_column("veriq_runs", sa.Column("plan_revision", sa.Integer))
    op.add_column("veriq_runs", sa.Column("plan_sequence", sa.Integer))
    op.add_column("veriq_runs", sa.Column("requester_service_token_id", uid))
    op.create_foreign_key(
        "fk_run_plan",
        "veriq_runs",
        "veriq_execution_plans",
        ["workspace_id", "plan_id"],
        ["workspace_id", "id"],
    )
    op.create_foreign_key(
        "fk_run_service_token",
        "veriq_runs",
        "veriq_service_tokens",
        ["requester_service_token_id"],
        ["id"],
    )
    op.create_unique_constraint("uq_run_plan_sequence", "veriq_runs", ["plan_id", "plan_sequence"])


def downgrade() -> None:
    """存在计划或执行令牌时拒绝降级，因为旧版本不能表达已授予的计划范围或运行顺序；空数据库才可逆向删除本迁移字段，避免降级悄然扩大或遗失独立服务身份的授权。"""
    connection = op.get_bind()
    if connection.execute(sa.text("SELECT COUNT(*) FROM veriq_execution_plans")).scalar():
        raise RuntimeError("Execution plans must be retained; downgrade refused")
    if connection.execute(
        sa.text("SELECT COUNT(*) FROM veriq_service_tokens WHERE purpose='EXECUTION'")
    ).scalar():
        raise RuntimeError("Execution tokens must be retained; downgrade refused")
    op.drop_constraint("fk_run_service_token", "veriq_runs", type_="foreignkey")
    op.drop_constraint("fk_run_plan", "veriq_runs", type_="foreignkey")
    op.drop_constraint("uq_run_plan_sequence", "veriq_runs", type_="unique")
    for name in ["plan_id", "plan_revision", "plan_sequence", "requester_service_token_id"]:
        op.drop_column("veriq_runs", name)
    op.drop_column("veriq_service_tokens", "plan_scopes")
    op.drop_table("veriq_execution_plans")
