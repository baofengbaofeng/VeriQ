"""VeriQ 显式迁移入口在实际 MySQL 数据库连接上持有按逻辑数据库名隔离的命名锁，再把同一物理连接注入 Alembic，避免多实例同时升级造成迁移竞争。

锁的生命周期独立于事务提交；任何未知获取或释放结果均拒绝成功，连接失效后不借新连接证明旧锁释放。
"""

from hashlib import sha256
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncConnection

from .db import Database
from .settings import Settings


def _migration_lock_name(database: object) -> str:
    """锁身份只依赖当前连接选中的逻辑数据库名，不依赖地址拼法或凭据；无法确定数据库身份时直接拒绝迁移，以免不同实例误用默认锁而绕过同一数据库的升级互斥约束。"""
    if not isinstance(database, str) or not database:
        raise RuntimeError("MIGRATION_SCHEMA_UNKNOWN")
    return "veriq_migrate_" + sha256(database.encode("utf-8")).hexdigest()[:48]


def _cleanup_failure(
    primary: BaseException | None, error: BaseException, code: str
) -> BaseException:
    """保留升级或取消时已存在的首个异常身份，清理故障只补充固定非敏感状态；仅有清理失败时把普通驱动错误替换为稳定错误码，取消等控制异常继续保留原来的类型和实例。"""
    if primary is not None:
        primary.add_note(code)
        return primary
    if not isinstance(error, Exception):
        error.add_note(code)
        return error
    return RuntimeError(code)


async def _release_lock(connection: AsyncConnection, name: str, owner: int, driver: object) -> None:
    """释放前同时检查异步连接有效状态、实际驱动连接身份和原 MySQL owner，禁止失效后查询触发透明重连；只有原物理连接明确返回释放成功才能确认本次迁移已交还数据库锁。"""
    if connection.closed or connection.invalidated:
        raise RuntimeError("MIGRATION_LOCK_RELEASE_UNCONFIRMED")
    current = await connection.get_raw_connection()
    if current.driver_connection is not driver:
        raise RuntimeError("MIGRATION_LOCK_RELEASE_UNCONFIRMED")
    current_owner = (await connection.execute(text("SELECT CONNECTION_ID()"))).scalar_one()
    if current_owner != owner:
        raise RuntimeError("MIGRATION_LOCK_RELEASE_UNCONFIRMED")
    result = (
        await connection.execute(text("SELECT RELEASE_LOCK(:name)"), {"name": name})
    ).scalar_one()
    if result != 1:
        raise RuntimeError("MIGRATION_LOCK_RELEASE_UNCONFIRMED")


async def migrate(settings: Settings, *, lock_timeout_seconds: int = 60) -> None:
    """校验有界等待参数与 MySQL 版本后，在同一真实连接上获取数据库维度命名锁并升级到 Alembic head；提交和明确解锁都成功才返回，任何失败均关闭引擎且保留首个异常。

    默认最多等待锁六十秒，零表示立即拒绝忙锁；调用方仍需把迁移作为独立生产部署任务执行。
    """
    if type(lock_timeout_seconds) is not int or not 0 <= lock_timeout_seconds <= 60:
        raise ValueError("MIGRATION_LOCK_TIMEOUT_INVALID")
    db = Database(settings)
    connection: AsyncConnection | None = None
    primary: BaseException | None = None
    lock_attempted = False
    name = ""
    owner = 0
    driver: object = None
    try:
        connection = await db.engine.connect()
        version, database, owner = (
            await connection.execute(text("SELECT VERSION(), DATABASE(), CONNECTION_ID()"))
        ).one()
        if not str(version).startswith("8.4."):
            raise ValueError("VeriQ requires MySQL 8.4")
        name = _migration_lock_name(database)
        driver = (await connection.get_raw_connection()).driver_connection
        # 获取过程中被取消也可能已在服务器端持锁，因此必须走原连接清理；明确忙锁则确认本连接未获锁，无需释放其他 owner 的锁或重试数据库调用。
        lock_attempted = True
        try:
            acquired = (
                await connection.execute(
                    text("SELECT GET_LOCK(:name, :timeout)"),
                    {"name": name, "timeout": lock_timeout_seconds},
                )
            ).scalar_one()
        except Exception:
            raise RuntimeError("MIGRATION_LOCK_ACQUIRE_UNCONFIRMED") from None
        if acquired == 0:
            lock_attempted = False
            raise RuntimeError("MIGRATION_LOCK_BUSY")
        if acquired != 1:
            raise RuntimeError("MIGRATION_LOCK_ACQUIRE_UNCONFIRMED")
        await connection.commit()
        config = Config()
        config.set_main_option("script_location", str(Path(__file__).parent / "migrations"))

        def upgrade(sync_connection: Connection) -> None:
            """把已经取得命名锁的异步连接之同步侧直接交给现有 Alembic 环境执行升级，任何事务提交都不会提前释放 MySQL session 级锁，禁止再从连接池借其他连接执行迁移。"""
            config.attributes["connection"] = sync_connection
            command.upgrade(config, "head")

        await connection.run_sync(upgrade)
        await connection.commit()
    except BaseException as error:
        primary = error
    finally:
        if connection is not None:
            if lock_attempted:
                try:
                    await _release_lock(connection, name, owner, driver)
                except BaseException as error:
                    primary = _cleanup_failure(primary, error, "MIGRATION_LOCK_RELEASE_UNCONFIRMED")
                    # 未确认释放的连接必须失效销毁，不能归还池后继续承载任务；失效失败只记录固定状态，由后续连接关闭和引擎释放继续尝试清理原来的物理连接。
                    try:
                        await connection.invalidate()
                    except BaseException as error:
                        primary = _cleanup_failure(
                            primary, error, "MIGRATION_CONNECTION_INVALIDATION_UNCONFIRMED"
                        )
            try:
                await connection.close()
            except BaseException as error:
                primary = _cleanup_failure(primary, error, "MIGRATION_CONNECTION_CLOSE_UNCONFIRMED")
        try:
            await db.close()
        except BaseException as error:
            primary = _cleanup_failure(primary, error, "MIGRATION_ENGINE_CLOSE_UNCONFIRMED")
    if primary is not None:
        raise primary
