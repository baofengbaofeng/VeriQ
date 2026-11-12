from alembic import context
from sqlalchemy.engine import Connection
from veriq_server.db import Base


def run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection, target_metadata=Base.metadata, version_table="veriq_alembic_version"
    )
    with context.begin_transaction():
        context.run_migrations()


run_migrations(context.config.attributes["connection"])
