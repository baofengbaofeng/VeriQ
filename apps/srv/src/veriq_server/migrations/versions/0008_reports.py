from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

revision = "0008_reports"
down_revision = "0007_device_rotation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("veriq_artifacts", "content", existing_type=mysql.LONGBLOB(), nullable=True)
    op.add_column(
        "veriq_artifacts",
        sa.Column("storage_backend", sa.String(16), nullable=False, server_default="INLINE"),
    )
    op.add_column(
        "veriq_artifacts",
        sa.Column("storage_incarnation", sa.String(36, collation="ascii_bin"), nullable=True),
    )
    op.add_column("veriq_artifacts", sa.Column("expired_at", mysql.DATETIME(fsp=6), nullable=True))
    op.add_column("veriq_artifacts", sa.Column("deleted_at", mysql.DATETIME(fsp=6), nullable=True))
    op.add_column("veriq_attempts", sa.Column("execution_provenance", sa.JSON(), nullable=True))
    op.add_column("veriq_attempts", sa.Column("finished_at", mysql.DATETIME(fsp=6), nullable=True))

    op.add_column(
        "veriq_attempt_uploads", sa.Column("expired_at", mysql.DATETIME(fsp=6), nullable=True)
    )
    op.create_table(
        "veriq_artifact_deletions",
        sa.Column("id", sa.String(36, collation="ascii_bin"), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.String(36, collation="ascii_bin"),
            sa.ForeignKey("veriq_workspaces.id"),
            nullable=False,
        ),
        sa.Column("sha256", sa.String(64, collation="ascii_bin"), nullable=False),
        sa.Column("storage_backend", sa.String(16), nullable=False),
        sa.Column("storage_incarnation", sa.String(36, collation="ascii_bin"), nullable=True),
        sa.Column("deleted_at", mysql.DATETIME(fsp=6), nullable=True),
    )
    op.create_index(
        "ix_artifact_delete_pending", "veriq_artifact_deletions", ["workspace_id", "deleted_at"]
    )


def require_downgrade_safe(connection: sa.Connection) -> None:
    """检查仅能在新版表示的外部制品、过期上传与待删除记录，使跨版本降级能够在任何结构变更之前拒绝。"""
    count = connection.execute(
        sa.text("SELECT COUNT(*) FROM veriq_artifacts WHERE content IS NULL")
    ).scalar_one()
    logical = connection.execute(
        sa.text("SELECT COUNT(*) FROM veriq_attempt_uploads WHERE expired_at IS NOT NULL")
    ).scalar_one()
    pending = connection.execute(
        sa.text("SELECT COUNT(*) FROM veriq_artifact_deletions WHERE deleted_at IS NULL")
    ).scalar_one()
    if count or logical or pending:
        raise RuntimeError("Rehydrate external artifacts before downgrade")


def downgrade() -> None:
    require_downgrade_safe(op.get_bind())
    op.drop_table("veriq_artifact_deletions")
    op.drop_column("veriq_attempt_uploads", "expired_at")
    op.drop_column("veriq_attempts", "finished_at")
    op.drop_column("veriq_attempts", "execution_provenance")
    for name in ["deleted_at", "expired_at", "storage_incarnation", "storage_backend"]:
        op.drop_column("veriq_artifacts", name)
    op.alter_column("veriq_artifacts", "content", existing_type=mysql.LONGBLOB(), nullable=False)
