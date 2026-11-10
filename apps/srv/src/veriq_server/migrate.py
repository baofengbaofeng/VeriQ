"""Explicit migration entry, never called by API application startup."""

from pathlib import Path
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.engine import Connection
from .db import Database
from .settings import Settings


async def migrate(settings: Settings) -> None:
    db = Database(settings)
    try:
        async with db.engine.connect() as connection:
            version = str((await connection.execute(text("SELECT VERSION()"))).scalar())
            if not version.startswith("8.4."):
                raise ValueError("VeriQ requires MySQL 8.4")
            await connection.commit()
            config = Config()
            config.set_main_option("script_location", str(Path(__file__).parent / "migrations"))

            def upgrade(sync_connection: Connection) -> None:
                config.attributes["connection"] = sync_connection
                command.upgrade(config, "head")

            await connection.run_sync(upgrade)
            await connection.commit()
    finally:
        await db.close()
