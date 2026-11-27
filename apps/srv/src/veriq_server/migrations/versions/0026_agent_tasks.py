"""保存后台工作与触发轮次的委派偏好，使进度跟踪可跨连接和进程恢复，旧会话继续按原有规则读取。"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import DATETIME

revision = "0026_agent_tasks"
down_revision = "0025_file_volume"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """添加可空的用户选择和私有后台任务表，计划与运行已有的数据库身份及完整性约束保持可用。"""
    uid = sa.String(36, collation="ascii_bin")
    op.add_column(
        "veriq_agent_turns", sa.Column("delegation_mode", sa.String(8, collation="ascii_bin"))
    )
    op.add_column(
        "veriq_agent_turns", sa.Column("workspace_capability", sa.String(32, collation="ascii_bin"))
    )
    op.create_table(
        "veriq_agent_tasks",
        sa.Column("id", uid, primary_key=True),
        sa.Column("session_id", uid, sa.ForeignKey("veriq_agent_sessions.id"), nullable=False),
        sa.Column("run_id", uid, sa.ForeignKey("veriq_runs.id"), nullable=False),
        sa.Column("request_id", sa.String(48, collation="ascii_bin"), nullable=False),
        sa.Column("mode", sa.String(6, collation="ascii_bin"), nullable=False),
        sa.Column("state", sa.String(12, collation="ascii_bin"), nullable=False),
        sa.Column("error_code", sa.String(80, collation="ascii_bin")),
        sa.Column("analysis_requested", sa.Boolean, nullable=False),
        sa.Column("analysis_attempt_id", uid),
        sa.Column("analysis", sa.JSON),
        sa.Column("created_at", DATETIME(fsp=6), nullable=False),
        sa.Column("next_check_at", DATETIME(fsp=6)),
        sa.UniqueConstraint("session_id", "request_id", "mode", name="uq_agent_task_request"),
        sa.Index("ix_agent_task_session", "session_id", "created_at", "id"),
        sa.Index("ix_agent_task_due", "next_check_at", "id"),
        sa.Index("ix_agent_task_usage", "analysis_attempt_id"),
    )


def require_downgrade_safe(connection: sa.Connection) -> None:
    """检查已保存的后台跟踪回执和员工审阅过的委派选择，只有旧版不必读取这些新增记录时才允许移除表和字段。"""
    if connection.execute(sa.text("SELECT 1 FROM veriq_agent_tasks LIMIT 1")).first():
        raise RuntimeError("Persisted Test Agent tasks must be retained")
    if connection.execute(
        sa.text(
            "SELECT 1 FROM veriq_agent_turns "
            "WHERE delegation_mode IS NOT NULL OR workspace_capability IS NOT NULL LIMIT 1"
        )
    ).first():
        raise RuntimeError("Persisted Test Agent delegation choices must be retained")


def downgrade() -> None:
    """降级前检查持久化跟踪任务和委派选择，防止回滚时把用户当前工作和历史回执当成空表删除。"""
    require_downgrade_safe(op.get_bind())
    op.drop_table("veriq_agent_tasks")
    op.drop_column("veriq_agent_turns", "workspace_capability")
    op.drop_column("veriq_agent_turns", "delegation_mode")
