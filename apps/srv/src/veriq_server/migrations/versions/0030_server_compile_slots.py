"""按作业状态与数据库期限索引服务端编译的活动围栏，保留已有领取、终态和收据的全部来源字段。"""

from alembic import op

revision = "0030_server_compile_slots"
down_revision = "0029_reset_token_issued"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """覆盖领取事务对未过期围栏所属工作区的限量读取，升级前已提交的活动作业会直接进入配额计算。"""
    op.create_index(
        "ix_job_server_compile_slots",
        "veriq_jobs",
        ["state", "server_compile_expires_at", "workspace_id"],
    )


def downgrade() -> None:
    """移除仅用于领取查询的索引，已签发的编译身份、到期时间与历史收据继续保存在原有表中。"""
    op.drop_index("ix_job_server_compile_slots", table_name="veriq_jobs")
