from alembic import context
from sqlalchemy.engine import Connection
from veriq_server.db import Base


def run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection, target_metadata=Base.metadata, version_table="veriq_alembic_version"
    )
    with context.begin_transaction():
        # 相对目标按整条命令开始时的数据库版本解释，不能在中间某一步用已变化的版本重新计算降级范围。
        migration = context.get_context()
        migration.opts["veriq_start_heads"] = migration.get_current_heads()
        context.run_migrations()


run_migrations(context.config.attributes["connection"])
