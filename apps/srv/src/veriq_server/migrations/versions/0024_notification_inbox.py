"""增加从业务事务生成的通知事件、接收记录和每用户水位，部署新版本时保持已有工作区和登录历史原样。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.mysql import DATETIME

revision = "0024_notification_inbox"
down_revision = "0023_account_sessions"
branch_labels = None
depends_on = None

_UUID = sa.String(36, collation="ascii_bin")


def upgrade() -> None:
    """按外键依赖创建三张窄表，以唯一业务事件、接收人及投递位置约束防止跨节点重试重复显示消息记录。"""
    op.create_table(
        "veriq_notification_events",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("workspace_id", _UUID, sa.ForeignKey("veriq_workspaces.id"), nullable=False),
        sa.Column("kind", sa.String(24, collation="ascii_bin"), nullable=False),
        sa.Column("subject_id", _UUID, nullable=False),
        sa.Column("occurred_at", DATETIME(fsp=6), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("workspace_id", "kind", "subject_id", name="uq_notification_event"),
        sa.CheckConstraint(
            "kind IN ('WORKSPACE_INVITED', 'AGENT_REPLY', 'RUN_STARTED', 'RUN_FINISHED')",
            name="ck_notification_event_kind",
        ),
    )
    op.create_table(
        "veriq_notification_inbox_states",
        sa.Column("user_id", _UUID, sa.ForeignKey("veriq_users.id"), primary_key=True),
        sa.Column("revision", sa.BigInteger, server_default=sa.text("0"), nullable=False),
        sa.Column("sequence", sa.BigInteger, server_default=sa.text("0"), nullable=False),
    )
    op.create_table(
        "veriq_notifications",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("event_id", _UUID, sa.ForeignKey("veriq_notification_events.id"), nullable=False),
        sa.Column("user_id", _UUID, sa.ForeignKey("veriq_users.id"), nullable=False),
        sa.Column("sequence", sa.BigInteger),
        sa.Column("deliver_at", DATETIME(fsp=6), nullable=False),
        sa.Column("read_at", DATETIME(fsp=6)),
        sa.Column("suppressed_at", DATETIME(fsp=6)),
        sa.UniqueConstraint("event_id", "user_id", name="uq_notification_recipient"),
        sa.UniqueConstraint("user_id", "sequence", name="uq_notification_sequence"),
        sa.CheckConstraint(
            "(sequence IS NULL OR suppressed_at IS NULL) AND (read_at IS NULL OR sequence IS NOT NULL)",
            name="ck_notification_delivery",
        ),
    )
    op.create_index(
        "ix_notification_due",
        "veriq_notifications",
        ["sequence", "suppressed_at", "deliver_at", "id"],
    )


def downgrade() -> None:
    """回滚只按逆依赖顺序删除本次引入的通知数据，既有邀请、Agent 回复和运行记录仍由原版本读取。"""
    op.drop_table("veriq_notifications")
    op.drop_table("veriq_notification_inbox_states")
    op.drop_table("veriq_notification_events")
