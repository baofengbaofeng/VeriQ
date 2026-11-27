"""为服务端编译新增作业围栏、到期时间与互斥来源回执，保留现有设备尝试及其不可变发布记录。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0020_server_compilation"
down_revision = "0019_agent_turn_thinking_steps"
branch_labels = None
depends_on = None

_jobs = "veriq_jobs"
_receipts = "veriq_validation_receipts"
_uuid = sa.String(36, collation="ascii_bin")


def upgrade() -> None:
    """先扩展作业来源和候选键，再开放回执设备列为空，历史记录原值可直接通过新互斥约束。"""
    op.add_column(_jobs, sa.Column("server_compilation_id", _uuid))
    op.add_column(_jobs, sa.Column("server_compile_expires_at", mysql.DATETIME(fsp=6)))
    op.add_column(_jobs, sa.Column("server_compile_result", sa.JSON))
    op.create_unique_constraint(
        "uq_job_server_compile", _jobs, ["workspace_id", "id", "server_compilation_id"]
    )
    op.create_index("ix_job_server_compile_queue", _jobs, ["kind", "state", "created_at", "id"])
    op.create_check_constraint(
        "ck_job_server_compile_origin",
        _jobs,
        "server_compilation_id IS NULL OR (kind = 'VALIDATE' AND active_attempt_id IS NULL)",
    )
    op.create_check_constraint(
        "ck_job_server_compile_lease",
        _jobs,
        "server_compile_expires_at IS NULL OR server_compilation_id IS NOT NULL",
    )
    # 修改设备来源的两列前解除原复合外键，再按原列顺序恢复约束，使历史尝试继续受工作区与作业归属限制。
    op.drop_constraint("fk_validation_attempt", _receipts, type_="foreignkey")
    op.alter_column(_receipts, "runtime_id", existing_type=_uuid, nullable=True)
    op.alter_column(_receipts, "attempt_id", existing_type=_uuid, nullable=True)
    op.create_foreign_key(
        "fk_validation_attempt",
        _receipts,
        "veriq_attempts",
        ["workspace_id", "job_id", "attempt_id", "runtime_id"],
        ["workspace_id", "job_id", "id", "runtime_id"],
    )
    op.add_column(_receipts, sa.Column("server_compilation_id", _uuid))
    op.create_foreign_key(
        "fk_validation_server_compile",
        _receipts,
        _jobs,
        ["workspace_id", "job_id", "server_compilation_id"],
        ["workspace_id", "id", "server_compilation_id"],
    )
    op.create_check_constraint(
        "ck_validation_provenance",
        _receipts,
        "(server_compilation_id IS NULL AND runtime_id IS NOT NULL AND attempt_id IS NOT NULL) OR "
        "(server_compilation_id IS NOT NULL AND runtime_id IS NULL AND attempt_id IS NULL)",
    )


def require_downgrade_safe(connection: sa.Connection) -> None:
    """在尚未使用新来源时恢复旧表形状，已有服务端编译的数据库拒绝丢弃无法映射到设备的可信记录。"""
    job = connection.execute(
        sa.text("SELECT 1 FROM veriq_jobs WHERE server_compilation_id IS NOT NULL LIMIT 1")
    ).scalar_one_or_none()
    if job is not None:
        raise RuntimeError("Downgrade would discard server compilation provenance")


def downgrade() -> None:
    """确认不存在服务端编译作业后再恢复旧版设备回执的非空约束，移除作业上新增的租约与结果字段。"""
    require_downgrade_safe(op.get_bind())
    op.drop_constraint("ck_validation_provenance", _receipts, type_="check")
    op.drop_constraint("fk_validation_server_compile", _receipts, type_="foreignkey")
    op.drop_column(_receipts, "server_compilation_id")
    op.drop_constraint("fk_validation_attempt", _receipts, type_="foreignkey")
    op.alter_column(_receipts, "runtime_id", existing_type=_uuid, nullable=False)
    op.alter_column(_receipts, "attempt_id", existing_type=_uuid, nullable=False)
    op.create_foreign_key(
        "fk_validation_attempt",
        _receipts,
        "veriq_attempts",
        ["workspace_id", "job_id", "attempt_id", "runtime_id"],
        ["workspace_id", "job_id", "id", "runtime_id"],
    )
    op.drop_constraint("ck_job_server_compile_lease", _jobs, type_="check")
    op.drop_constraint("ck_job_server_compile_origin", _jobs, type_="check")
    op.drop_index("ix_job_server_compile_queue", table_name=_jobs)
    op.drop_constraint("uq_job_server_compile", _jobs, type_="unique")
    for name in ("server_compile_result", "server_compile_expires_at", "server_compilation_id"):
        op.drop_column(_jobs, name)
