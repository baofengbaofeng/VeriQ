"""Alembic 升级入口：仅接受 MySQL 8.4，在同一连接上同步执行 upgrade 到 head，版本表为 veriq_alembic_version。

控制面启动或 `veriq_server migrate` 调用本函数；失败时关闭引擎并向上抛出，避免半迁移后继续提供服务。
迁移脚本位于本包 migrations/，通过 Config.attributes['connection'] 注入现有异步连接的同步侧。
"""

from pathlib import Path
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.engine import Connection
from .db import Database
from .settings import Settings


async def migrate(settings: Settings) -> None:
    """校验 MySQL 小版本后在单连接上运行 Alembic upgrade head，提交完成后释放数据库引擎，migrate 的失败路径返回稳定错误。
    migrate 实现于 apps/srv/src/veriq_server/migrate.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
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
                """在 run_sync 回调内挂接同步连接并执行 Alembic 升级到最新修订版本，migrate.upgrade 的失败路径返回稳定错误。
                upgrade 实现于 apps/srv/src/veriq_server/migrate.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
                """
                config.attributes["connection"] = sync_connection
                command.upgrade(config, "head")

            await connection.run_sync(upgrade)
            await connection.commit()
    finally:
        await db.close()
