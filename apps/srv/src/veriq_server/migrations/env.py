"""在调用方提供的同一数据库连接上计算迁移路径，预检降级涉及的历史保留要求，再通过原生迁移执行器变更结构。"""

from alembic import context
from alembic.runtime.migration import RevisionStep
from sqlalchemy.engine import Connection
from veriq_server.db import Base


def run_migrations(connection: Connection) -> None:
    """升级和降级都按当前数据库版本规划，只有实际跨过的降级修订才需要在任何隐式提交之前检验历史数据。"""
    context.configure(
        connection=connection, target_metadata=Base.metadata, version_table="veriq_alembic_version"
    )
    with context.begin_transaction():
        migration = context.get_context()
        # 使用本次命令从实际起始版本计算的步骤预检整条降级路径。MySQL 的首个结构变更即可隐式提交。
        if "destination_rev" in migration.opts:
            for step in migration.opts["fn"](migration.get_current_heads(), migration):
                if isinstance(step, RevisionStep) and step.is_downgrade:
                    check = getattr(step.revision.module, "require_downgrade_safe", None)
                    if check is not None:
                        check(connection)
        context.run_migrations()


run_migrations(context.config.attributes["connection"])
