from alembic import op
import sqlalchemy as sa

revision = "0009_publication_fences"
down_revision = "0008_reports"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "veriq_artifact_publications",
        sa.Column("id", sa.String(36, collation="ascii_bin"), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.String(36, collation="ascii_bin"),
            sa.ForeignKey("veriq_workspaces.id"),
            nullable=False,
        ),
        sa.Column("sha256", sa.String(64, collation="ascii_bin"), nullable=False),
        sa.Column("storage_backend", sa.String(16), nullable=False),
        sa.Column(
            "upload_id",
            sa.String(36, collation="ascii_bin"),
            sa.ForeignKey("veriq_attempt_uploads.id"),
            nullable=False,
        ),
        sa.Column("state", sa.String(16), nullable=False),
        sa.CheckConstraint(
            "state IN ('PENDING','COMMITTED','RETIRED')", name="ck_publication_state"
        ),
    )
    op.create_index(
        "ix_artifact_publication_pending",
        "veriq_artifact_publications",
        ["workspace_id", "state", "id"],
    )
    # 旧的删除回执无法拦住尚在进行的仅创建写入，升级会按原存储键将已完成的删除记录重新设为待处理。
    # 回收时在同一个键写入空内容屏障，阻止迟到的写入。
    op.execute("UPDATE veriq_artifact_deletions SET deleted_at = NULL")


def require_downgrade_safe(connection: sa.Connection) -> None:
    """确认制品发布日志与退役围栏均为空，旧版本缺少这些记录时无法决定对象是否还可以安全发布。"""
    count = connection.execute(
        sa.text("SELECT COUNT(*) FROM veriq_artifact_publications")
    ).scalar_one()
    if count:
        raise RuntimeError(
            "Publication journals and retirement fences require a proved-safe migration"
        )


def downgrade() -> None:
    require_downgrade_safe(op.get_bind())
    op.drop_table("veriq_artifact_publications")
