
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import DATETIME, LONGBLOB

revision = "0013_offline_imports"
down_revision = "0012_bundle_exports"
branch_labels = None
depends_on = None


def upgrade() -> None:
    uid = sa.String(36, collation="ascii_bin")
    digest = sa.String(64, collation="ascii_bin")
    op.create_table(
        "veriq_offline_imports",
        sa.Column("id", uid, primary_key=True),
        sa.Column("workspace_id", uid, sa.ForeignKey("veriq_workspaces.id"), nullable=False),
        sa.Column("bundle_id", uid, sa.ForeignKey("veriq_bundles.id"), nullable=False),
        sa.Column("local_run_id", uid, nullable=False),
        sa.Column("actor_id", uid, sa.ForeignKey("veriq_users.id"), nullable=False),
        sa.Column("run_id", uid, sa.ForeignKey("veriq_runs.id"), nullable=False),
        sa.Column("request_hash", digest, nullable=False),
        sa.Column("declared", sa.JSON, nullable=False),
        sa.Column("verified", sa.JSON, nullable=False),
        sa.Column("created_at", DATETIME(fsp=6), nullable=False),
        sa.UniqueConstraint("workspace_id", "bundle_id", "local_run_id"),
        sa.UniqueConstraint("workspace_id", "id"),
    )
    op.create_table(
        "veriq_offline_import_keys",
        sa.Column("workspace_id", uid, primary_key=True),
        sa.Column("key", sa.String(160, collation="ascii_bin"), primary_key=True),
        sa.Column("import_id", uid, nullable=False),
        sa.Column("actor_id", uid, nullable=False),
        sa.Column("request_hash", digest, nullable=False),
        sa.ForeignKeyConstraint(
            ["workspace_id", "import_id"],
            ["veriq_offline_imports.workspace_id", "veriq_offline_imports.id"],
        ),
    )
    op.create_table(
        "veriq_offline_attempts",
        sa.Column("id", uid, primary_key=True),
        sa.Column("workspace_id", uid, nullable=False),
        sa.Column("import_id", uid, nullable=False),
        sa.Column(
            "case_execution_id", uid, sa.ForeignKey("veriq_case_executions.id"), nullable=False
        ),
        sa.Column("local_attempt_id", uid, nullable=False),
        sa.Column("attempt_no", sa.Integer, nullable=False),
        sa.Column("outcome", sa.String(24), nullable=False),
        sa.Column("facts", sa.JSON, nullable=False),
        sa.Column("document", sa.JSON, nullable=False),
        sa.ForeignKeyConstraint(
            ["workspace_id", "import_id"],
            ["veriq_offline_imports.workspace_id", "veriq_offline_imports.id"],
        ),
        sa.UniqueConstraint("workspace_id", "id"),
        sa.UniqueConstraint("case_execution_id", "attempt_no"),
    )
    op.create_table(
        "veriq_offline_import_uploads",
        sa.Column("id", uid, primary_key=True),
        sa.Column("workspace_id", uid, sa.ForeignKey("veriq_workspaces.id"), nullable=False),
        sa.Column("bundle_id", uid, sa.ForeignKey("veriq_bundles.id"), nullable=False),
        sa.Column("local_run_id", uid, nullable=False),
        sa.Column("local_attempt_id", uid, nullable=False),
        sa.Column("actor_id", uid, sa.ForeignKey("veriq_users.id"), nullable=False),
        sa.Column("path", sa.String(240, collation="ascii_bin"), nullable=False),
        sa.Column("sha256", digest, nullable=False),
        sa.Column("size_bytes", sa.Integer, nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("sensitivity", sa.String(24), nullable=False),
        sa.Column("content", LONGBLOB),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("storage_incarnation", uid),
        sa.Column("created_at", DATETIME(fsp=6), nullable=False),
        sa.Column("expires_at", DATETIME(fsp=6), nullable=False),
        sa.Column("expired_at", DATETIME(fsp=6)),
        sa.UniqueConstraint("workspace_id", "id"),
        sa.UniqueConstraint(
            "workspace_id", "bundle_id", "local_run_id", "local_attempt_id", "path"
        ),
    )

    op.alter_column("veriq_artifact_publications", "upload_id", existing_type=uid, nullable=True)
    op.add_column("veriq_artifact_publications", sa.Column("offline_upload_id", uid, nullable=True))
    op.create_foreign_key(
        "fk_publication_offline_upload",
        "veriq_artifact_publications",
        "veriq_offline_import_uploads",
        ["workspace_id", "offline_upload_id"],
        ["workspace_id", "id"],
    )
    op.create_check_constraint(
        "ck_publication_owner",
        "veriq_artifact_publications",
        "(upload_id IS NULL) <> (offline_upload_id IS NULL)",
    )


def downgrade() -> None:
    for table in ["veriq_offline_imports", "veriq_offline_import_uploads"]:
        if op.get_bind().execute(sa.text(f"SELECT COUNT(*) FROM {table}")).scalar_one():
            raise RuntimeError("Offline history and publication authority must be retained")
    op.drop_constraint("ck_publication_owner", "veriq_artifact_publications", type_="check")
    op.drop_constraint(
        "fk_publication_offline_upload", "veriq_artifact_publications", type_="foreignkey"
    )
    op.drop_column("veriq_artifact_publications", "offline_upload_id")
    op.alter_column(
        "veriq_artifact_publications",
        "upload_id",
        existing_type=sa.String(36, collation="ascii_bin"),
        nullable=False,
    )
    for table in [
        "veriq_offline_attempts",
        "veriq_offline_import_keys",
        "veriq_offline_import_uploads",
        "veriq_offline_imports",
    ]:
        op.drop_table(table)
