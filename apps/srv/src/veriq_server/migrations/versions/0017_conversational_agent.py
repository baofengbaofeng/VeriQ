"""新增对话的独立设置、员工会话和私有轮次，现有工作区可保持空配置，升级无需复制生成历史或重写执行计划。"""

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import DATETIME

revision = "0017_conversational_agent"
down_revision = "0016_dataset_copy_audit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """设置通过工作区主键保证唯一，会话和轮次的复合索引支持有界分页，在 MySQL 层约束同会话内的请求重复与供应商快照。"""
    uid = sa.String(36, collation="ascii_bin")
    op.create_table(
        "veriq_agent_settings",
        sa.Column("workspace_id", uid, sa.ForeignKey("veriq_workspaces.id"), primary_key=True),
        sa.Column("default_provider_id", uid, sa.ForeignKey("veriq_ai_providers.id")),
        sa.Column("agent_provider_id", uid, sa.ForeignKey("veriq_ai_providers.id")),
    )
    # 工作区和员工列始终作为历史索引最左前缀，归档状态只改变所属列表，任何会话仍能按主键安全定位。
    op.create_table(
        "veriq_agent_sessions",
        sa.Column("id", uid, primary_key=True),
        sa.Column("workspace_id", uid, sa.ForeignKey("veriq_workspaces.id"), nullable=False),
        sa.Column("user_id", uid, sa.ForeignKey("veriq_users.id"), nullable=False),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("created_at", DATETIME(fsp=6), nullable=False),
        sa.Column("archived", sa.Boolean, nullable=False),
        sa.Index(
            "ix_agent_session_history", "workspace_id", "user_id", "archived", "created_at", "id"
        ),
    )
    # 建立轮次与会话之间的唯一公开父级；供应商和运行是受服务层空间约束的引用，既有记录无需回填。
    op.create_table(
        "veriq_agent_turns",
        sa.Column("id", uid, primary_key=True),
        sa.Column("session_id", uid, sa.ForeignKey("veriq_agent_sessions.id"), nullable=False),
        sa.Column("request_id", uid, nullable=False),
        sa.Column("attempt_id", uid),
        sa.Column("provider_id", uid, sa.ForeignKey("veriq_ai_providers.id")),
        sa.Column("provider_revision", sa.Integer),
        sa.Column("related_run_id", uid, sa.ForeignKey("veriq_runs.id")),
        sa.Column("created_at", DATETIME(fsp=6), nullable=False),
        sa.Column("text", sa.Text, nullable=False),
        sa.Column("status", sa.String(12, collation="ascii_bin"), nullable=False),
        sa.Column("reply", sa.Text),
        sa.Column("error_code", sa.String(80, collation="ascii_bin")),
        sa.Column("proposal", sa.JSON),
        sa.Column("receipt", sa.JSON),
        sa.UniqueConstraint("session_id", "request_id", name="uq_agent_turn_request"),
        sa.Index("ix_agent_turn_history", "session_id", "created_at", "id"),
        sa.CheckConstraint(
            "status IN ('RUNNING', 'COMPLETED', 'FAILED')", name="ck_agent_turn_status"
        ),
        sa.CheckConstraint(
            "(provider_id IS NULL) = (provider_revision IS NULL)", name="ck_agent_turn_provider"
        ),
    )


def downgrade() -> None:
    """逐个检查设置、会话和轮次是否为空，拒绝删除一侧仍需读取的私有对话或已确认业务回执，空安装按引用顺序回退。"""
    connection = op.get_bind()
    tables = ("veriq_agent_turns", "veriq_agent_sessions", "veriq_agent_settings")
    # 先检查所有表再执行第一个 DDL，避免发现已存在的会话时已经移除一张仍为新版服务所需的表。
    for name in tables:
        if connection.execute(sa.select(1).select_from(sa.table(name)).limit(1)).first():
            raise RuntimeError("Conversational agent history or settings must be retained")
    # 目标若还要跨过数据集迁移，先执行其保留预检；拒绝时必须连同当前版本的对话表一并保全。
    migration = op.get_context()
    assert migration.script is not None
    steps = migration.script.iterate_revisions(
        migration.opts["veriq_start_heads"],
        context.get_revision_argument(),
        select_for_downgrade=True,
    )
    for step in steps:
        if step.revision == down_revision:
            step.module.require_downgrade_safe()
            break
    for name in tables:
        op.drop_table(name)
