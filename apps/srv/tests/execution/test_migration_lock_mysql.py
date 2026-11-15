"""迁移互斥测试复用已获授权的独占 MySQL 测试数据库，通过不同真实连接观察命名锁的所有者与释放结果，避免仅以 SQL 字符串或模拟返回值证明互斥成立。

故障注入只用于数据库难以稳定制造的释放未知分支，正常升级与竞争均保留真实连接。
"""

import asyncio
from typing import Any, cast

import pytest
from sqlalchemy import event, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection
from sqlalchemy.util import await_only

import veriq_server.migrate as migration
from veriq_server.db import Database
from veriq_server.settings import Settings


@pytest.fixture
def migration_settings(site: tuple[Any, Database]) -> Settings:
    """从既有受保护 site 的真实引擎复用数据库配置并保留固定测试密钥，所有测试仅操作已获授权的 veriq_test，且不输出连接地址或密码等敏感内容。"""
    _, db = site
    assert db.engine.url.database == "veriq_test"
    return Settings(
        database_url=db.engine.url.render_as_string(hide_password=False),
        public_url="http://127.0.0.1:18889",
        master_key="a" * 64,
        signing_key="b" * 64,
        environment="development",
    )


async def test_upgrade_lock_is_visible_to_another_real_connection(
    site: tuple[Any, Database], migration_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """若迁移入口未在传给 Alembic 的物理连接上先取得锁，另一真实连接将观察不到当前 owner，断言在真正调用升级前失败，因而能捕获旧入口的并发漏洞。"""
    _, db = site
    original = migration.command.upgrade
    async with db.engine.connect() as observer:

        def upgrade(config: Any, revision: str) -> None:
            """由另一真实 MySQL 连接独立读取命名锁 owner，再让原始 Alembic 完成实际升级，确保锁归属断言与真实升级入口的连接身份保持一致而非只检查模拟调用。"""
            connection: Connection = config.attributes["connection"]
            owner = connection.execute(text("SELECT CONNECTION_ID()")).scalar_one()
            observed = await_only(
                observer.execute(
                    text(
                        "SELECT IS_USED_LOCK(CONCAT('veriq_migrate_', "
                        "LEFT(SHA2(DATABASE(), 256), 48)))"
                    )
                )
            ).scalar_one()
            assert observed == owner, "Alembic connection must own the schema migration lock"
            original(config, revision)
            connection.commit()
            after_commit = await_only(
                observer.execute(
                    text(
                        "SELECT IS_USED_LOCK(CONCAT('veriq_migrate_', "
                        "LEFT(SHA2(DATABASE(), 256), 48)))"
                    )
                )
            ).scalar_one()
            assert after_commit == owner, "Ordinary commits must retain the migration lock"

        monkeypatch.setattr(migration.command, "upgrade", upgrade)
        await migration.migrate(migration_settings)


async def _lock_name(connection: AsyncConnection) -> str:
    """在独立观察连接上由 MySQL 自身计算期望锁名，避免测试依赖生产代码的散列辅助函数而同步复制错误，同时始终只使用当前已授权测试 schema 的数据库身份。"""
    return str(
        (
            await connection.execute(
                text("SELECT CONCAT('veriq_migrate_', LEFT(SHA2(DATABASE(), 256), 48))")
            )
        ).scalar_one()
    )


async def _reacquire(connection: AsyncConnection, name: str) -> None:
    """通过独立物理连接实际重新获取并释放迁移锁来证明原 session 已不再占有锁，有界等待只用于数据库断开后的释放传播，不能以本地状态标记代替数据库事实。"""
    assert (
        await connection.execute(text("SELECT GET_LOCK(:name, 2)"), {"name": name})
    ).scalar_one() == 1
    assert (
        await connection.execute(text("SELECT RELEASE_LOCK(:name)"), {"name": name})
    ).scalar_one() == 1


async def test_external_owner_refuses_upgrade_and_release_allows_real_upgrade(
    site: tuple[Any, Database], migration_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """外部真实连接先持有迁移锁时零等待必须拒绝运行 Alembic，待外部 owner 明确释放后同一入口应完成真实 head 升级，捕获把超时误当成功或忽略竞争的问题。"""
    _, db = site
    original = migration.command.upgrade
    upgrades: list[str] = []

    def upgrade(config: Any, revision: str) -> None:
        """只记录实际 Alembic 升级调用并保留完整升级副作用，让竞争断言能识别忙锁期间的错误执行，同时在锁释放后的成功路径继续运行仓库原本的迁移脚本。"""
        upgrades.append(revision)
        original(config, revision)

    monkeypatch.setattr(migration.command, "upgrade", upgrade)
    async with db.engine.connect() as holder:
        name = await _lock_name(holder)
        assert (
            await holder.execute(text("SELECT GET_LOCK(:name, 0)"), {"name": name})
        ).scalar_one() == 1
        try:
            with pytest.raises(RuntimeError, match="^MIGRATION_LOCK_BUSY$"):
                await migration.migrate(migration_settings, lock_timeout_seconds=0)
            assert upgrades == []
        finally:
            await holder.execute(text("SELECT RELEASE_LOCK(:name)"), {"name": name})
        await migration.migrate(migration_settings, lock_timeout_seconds=0)
        assert upgrades == ["head"]
        await _reacquire(holder, name)


async def test_two_migrations_serialize_on_distinct_real_connections(
    site: tuple[Any, Database], migration_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """首个迁移在真实持锁回调中暂停时第二调用已经发起数据库锁请求却不能进入升级，释放屏障后两个不同 owner 依次完成，防止进程内锁或额外借连接伪造互斥。"""
    entered, contender, proceed = asyncio.Event(), asyncio.Event(), asyncio.Event()
    owners: list[int] = []
    original = migration.command.upgrade
    requests = 0

    def before_execute(
        connection: Any, cursor: Any, statement: str, parameters: Any, context: Any, many: bool
    ) -> None:
        """仅观察真实驱动即将发送的获取锁请求并建立事件屏障，不修改查询及结果；第二次请求发生后再断言升级尚未进入，避免依赖调度延迟或固定睡眠判断并发状态。"""
        nonlocal requests
        if "GET_LOCK(" in statement:
            requests += 1
            if requests == 2:
                contender.set()

    async def pause(owner: int) -> None:
        """首位真实 owner 保持其数据库连接并等待显式测试事件，后续 owner 不再暂停；此屏障安排只控制升级时机，实际排队仍由 MySQL 命名锁负责而非测试替代。"""
        owners.append(owner)
        if len(owners) == 1:
            entered.set()
            await proceed.wait()

    def upgrade(config: Any, revision: str) -> None:
        """取得 Alembic 同步侧连接的真实数据库 session 标识后通过绿色线程暂停首位迁移，再运行原始升级命令，从而在不模拟 SQL 的条件下观察两次入口的严格顺序。"""
        connection: Connection = config.attributes["connection"]
        await_only(pause(connection.execute(text("SELECT CONNECTION_ID()")).scalar_one()))
        original(config, revision)

    event.listen(Engine, "before_cursor_execute", before_execute)
    monkeypatch.setattr(migration.command, "upgrade", upgrade)
    tasks: list[asyncio.Task[None]] = []
    try:
        tasks.append(asyncio.create_task(migration.migrate(migration_settings)))
        await asyncio.wait_for(entered.wait(), 5)
        tasks.append(asyncio.create_task(migration.migrate(migration_settings)))
        await asyncio.wait_for(contender.wait(), 5)
        assert len(owners) == 1
        proceed.set()
        await asyncio.wait_for(asyncio.gather(*tasks), 10)
        assert len(owners) == 2 and owners[0] != owners[1]
    finally:
        proceed.set()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        event.remove(Engine, "before_cursor_execute", before_execute)


@pytest.mark.parametrize("release_failure", [False, True])
async def test_upgrade_error_preserved_and_real_lock_released(
    site: tuple[Any, Database],
    migration_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
    release_failure: bool,
) -> None:
    """升级抛出的原始异常必须在解锁及引擎关闭也失败时仍保留身份，独立连接同时证明旧锁实际可重取，避免清理异常覆盖故障根因或把锁留在连接池中阻塞后续升级。"""
    failure = ValueError("controlled upgrade failure")
    original_execute, original_close = AsyncConnection.execute, Database.close

    def upgrade(config: Any, revision: str) -> None:
        """在取得真实迁移锁后的 Alembic 边界抛出固定异常实例，测试断言同一实例向上传播，从而区分保留首错与重建相似错误消息而丢失原始故障身份的实现差异。"""
        raise failure

    async def execute(self: AsyncConnection, statement: Any, *args: Any, **kwargs: Any) -> Any:
        """只在指定场景让释放查询失败而保持获取锁与升级连接均真实存在，异常文字使用合成敏感标记以验证清理状态不会传播任意驱动消息，其余 SQL 完整委托真实引擎。"""
        if release_failure and "RELEASE_LOCK(" in str(statement):
            raise RuntimeError("synthetic-secret")
        return await original_execute(self, statement, *args, **kwargs)

    async def close(self: Database) -> None:
        """先完成真实引擎资源释放再模拟关闭报告失败，确保测试故障不会制造连接泄漏，并证明首个升级异常在随后释放及引擎关闭的多重清理故障下仍保持原样向上传播。"""
        await original_close(self)
        if release_failure:
            raise RuntimeError("synthetic-secret")

    monkeypatch.setattr(migration.command, "upgrade", upgrade)
    monkeypatch.setattr(AsyncConnection, "execute", execute)
    monkeypatch.setattr(Database, "close", close)
    with pytest.raises(ValueError) as raised:
        await migration.migrate(migration_settings)
    assert raised.value is failure
    if release_failure:
        assert "MIGRATION_LOCK_RELEASE_UNCONFIRMED" in raised.value.__notes__
        assert "synthetic-secret" not in str(raised.value.__notes__)
    monkeypatch.setattr(AsyncConnection, "execute", original_execute)
    monkeypatch.setattr(Database, "close", original_close)
    async with site[1].engine.connect() as observer:
        await _reacquire(observer, await _lock_name(observer))


@pytest.mark.parametrize("result", [None, 0, "unknown", "raise"])
async def test_release_unconfirmed_never_returns_success(
    site: tuple[Any, Database],
    migration_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
    result: Any,
) -> None:
    """真实升级完成后释放返回未知值或发生驱动错误必须拒绝成功且只暴露固定错误码，随后独立连接能实际重取锁，防止持锁连接被归池或任意驱动消息泄露操作员配置。"""
    original_execute = AsyncConnection.execute

    async def execute(self: AsyncConnection, statement: Any, *args: Any, **kwargs: Any) -> Any:
        """仅在真实释放边界注入无法确认的响应或异常，正常 SQL 仍访问实际 MySQL；未知返回值不执行释放以额外验证失败路径确实销毁持锁物理连接而非只修改本地状态。"""
        if "RELEASE_LOCK(" in str(statement):
            if result == "raise":
                raise RuntimeError("synthetic-secret")
            from types import SimpleNamespace

            return SimpleNamespace(scalar_one=lambda: result)
        return await original_execute(self, statement, *args, **kwargs)

    monkeypatch.setattr(AsyncConnection, "execute", execute)
    with pytest.raises(RuntimeError, match="^MIGRATION_LOCK_RELEASE_UNCONFIRMED$") as raised:
        await migration.migrate(migration_settings)
    assert "synthetic-secret" not in str(raised.value)
    monkeypatch.setattr(AsyncConnection, "execute", original_execute)
    async with site[1].engine.connect() as observer:
        await _reacquire(observer, await _lock_name(observer))


@pytest.mark.parametrize("state", ["invalidated", "reconnected", "closed"])
async def test_invalidated_or_replaced_session_never_executes_release_query(
    site: tuple[Any, Database],
    migration_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
    state: str,
) -> None:
    """Alembic 回调主动失效原连接并清理事务后可能透明重连，入口必须识别物理 session 已改变或失效并拒绝解锁确认，禁止让新连接的查询结果冒充旧 owner 已安全释放。"""
    released: list[str] = []

    def observe(
        connection: Any, cursor: Any, statement: str, parameters: Any, context: Any, many: bool
    ) -> None:
        """记录迁移清理期间真正发往驱动的释放语句，已失效连接场景应保持空记录，因而可捕获先发送查询触发透明重连再比较 owner 的错误检查顺序和多余数据库操作。"""
        if "RELEASE_LOCK(" in statement:
            released.append(statement)

    def upgrade(config: Any, revision: str) -> None:
        """在真实连接上触发 SQLAlchemy 标准失效及事务清理，并可选择显式触发新物理 session，分别覆盖 invalidated 标志仍存在以及已重连后标志消失的两种释放前状态。"""
        connection: Connection = config.attributes["connection"]
        if state == "closed":
            connection.close()
        else:
            connection.invalidate()
            connection.rollback()
            if state == "reconnected":
                connection.execute(text("SELECT 1"))

    monkeypatch.setattr(migration.command, "upgrade", upgrade)
    event.listen(Engine, "before_cursor_execute", observe)
    try:
        with pytest.raises(RuntimeError) as raised:
            await migration.migrate(migration_settings)
        assert str(raised.value) == "MIGRATION_LOCK_RELEASE_UNCONFIRMED"
        assert released == []
    finally:
        event.remove(Engine, "before_cursor_execute", observe)
    async with site[1].engine.connect() as observer:
        await _reacquire(observer, await _lock_name(observer))


@pytest.mark.parametrize("disconnect", [False, True])
async def test_cancel_or_disconnect_preserves_failure_and_eventually_releases_real_lock(
    site: tuple[Any, Database],
    migration_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
    disconnect: bool,
) -> None:
    """迁移在真实驱动查询期间被取消或连接被断开时必须保留首个失败并最终释放原锁，取消不依赖后台无限屏蔽任务，独立连接的有界重取验证物理 session 清理实际发生。"""
    async with site[1].engine.connect() as observer:
        name = await _lock_name(observer)
        barrier = "veriq_cancel_" + name[-48:]
        assert (
            await observer.execute(text("SELECT GET_LOCK(:name, 0)"), {"name": barrier})
        ).scalar_one() == 1
        entered = asyncio.Event()

        def upgrade(config: Any, revision: str) -> None:
            """让真实持锁 session 等待观察连接控制的五秒有界数据库屏障，或关闭真实驱动后查询触发断线；屏障由测试主动释放，因此能确定取消时查询仍阻塞而不依赖固定睡眠。"""
            connection: Connection = config.attributes["connection"]
            entered.set()
            if disconnect:
                connection.connection.driver_connection.close()
                connection.execute(text("SELECT 1"))
            else:
                connection.execute(text("SELECT GET_LOCK(:barrier, 5)"), {"barrier": barrier})

        monkeypatch.setattr(migration.command, "upgrade", upgrade)
        task = asyncio.create_task(migration.migrate(migration_settings))
        try:
            await asyncio.wait_for(entered.wait(), 5)
            if disconnect:
                with pytest.raises(DBAPIError) as raised_disconnect:
                    await asyncio.wait_for(task, 5)
                failure: BaseException = raised_disconnect.value
            else:
                owner = (
                    await observer.execute(text("SELECT IS_USED_LOCK(:name)"), {"name": name})
                ).scalar_one()
                assert owner is not None
                task.cancel()
                with pytest.raises(asyncio.CancelledError) as raised_cancel:
                    await asyncio.wait_for(task, 5)
                failure = raised_cancel.value
                assert (
                    await observer.execute(text("SELECT IS_USED_LOCK(:name)"), {"name": name})
                ).scalar_one() == owner
                assert (
                    await observer.execute(text("SELECT GET_LOCK(:name, 0)"), {"name": name})
                ).scalar_one() == 0
            assert "MIGRATION_LOCK_RELEASE_UNCONFIRMED" in failure.__notes__
        finally:
            await observer.execute(text("SELECT RELEASE_LOCK(:name)"), {"name": barrier})
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await _reacquire(observer, name)


@pytest.mark.parametrize("result", [None, 2, "unknown", "raise"])
async def test_acquisition_unknown_refuses_upgrade_and_cleans_uncertain_owner(
    site: tuple[Any, Database],
    migration_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
    result: Any,
) -> None:
    """获取响应丢失或未知时即使服务器已实际取得锁也不能开始升级，入口应返回稳定获取失败并清理原连接，独立重取锁验证未知响应没有将隐藏持锁 session 遗留在连接池中。"""
    original_execute = AsyncConnection.execute
    upgrades: list[str] = []

    async def execute(self: AsyncConnection, statement: Any, *args: Any, **kwargs: Any) -> Any:
        """让真实获取锁请求先到达数据库再丢失其响应，其他查询继续委托真实驱动；此故障特意保留服务器持锁副作用，以捕获只处理本地返回值却不清理未知获取状态的实现漏洞。"""
        response = await original_execute(self, statement, *args, **kwargs)
        if "GET_LOCK(" in str(statement):
            if result == "raise":
                raise RuntimeError("synthetic-secret")
            from types import SimpleNamespace

            return SimpleNamespace(scalar_one=lambda: result)
        return response

    def upgrade(config: Any, revision: str) -> None:
        """只记录意外进入升级的行为供错误路径断言，正常获取锁和未知响应后的释放仍由实际数据库处理，本场景不以模拟升级成功替代要求的真实锁拥有与清理事实验证。"""
        upgrades.append(revision)

    monkeypatch.setattr(AsyncConnection, "execute", execute)
    monkeypatch.setattr(migration.command, "upgrade", upgrade)
    with pytest.raises(RuntimeError, match="^MIGRATION_LOCK_ACQUIRE_UNCONFIRMED$"):
        await migration.migrate(migration_settings)
    assert upgrades == []
    monkeypatch.setattr(AsyncConnection, "execute", original_execute)
    async with site[1].engine.connect() as observer:
        await _reacquire(observer, await _lock_name(observer))


@pytest.mark.parametrize("timeout", [-1, 61, True, False, 1.0, "0", None])
async def test_invalid_timeout_rejected_before_database_access(
    monkeypatch: pytest.MonkeyPatch, timeout: Any
) -> None:
    """非法超时包括布尔值和看似整数的字符串必须在构造数据库前拒绝，防止控制参数隐式转换扩大等待范围或让无效请求接触操作员数据库，测试明确拦截任何数据库访问尝试。"""

    def database(settings: Any) -> Any:
        """参数验证应先于数据库构造，若实现把拒绝逻辑移动到连接建立之后便在此直接失败，因而无需真实凭据也能证明非法输入不会产生连接副作用或消耗数据库资源。"""
        raise AssertionError("Database must not be constructed for an invalid timeout")

    monkeypatch.setattr(migration, "Database", database)
    with pytest.raises(ValueError, match="^MIGRATION_LOCK_TIMEOUT_INVALID$"):
        await migration.migrate(cast(Settings, None), lock_timeout_seconds=timeout)


@pytest.mark.parametrize("schema", [None, "", 3])
def test_unknown_schema_rejected(schema: Any) -> None:
    """没有实际逻辑数据库身份时不能选择默认锁或把空值转换成字符串继续迁移，纯值测试覆盖未知数据库身份的拒绝路径，避免为了测试独立 schema 而创建额外数据库扩大授权范围。"""
    with pytest.raises(RuntimeError, match="^MIGRATION_SCHEMA_UNKNOWN$"):
        migration._migration_lock_name(schema)


def test_schema_lock_mapping_is_stable_bounded_and_distinct() -> None:
    """同一实际数据库名应映射到固定长度锁名且不同数据库保持独立，期望值用事先独立计算的散列常量固定，避免调用生产辅助函数自行生成期望而掩盖错误的锁键算法。"""
    assert migration._migration_lock_name("veriq_test") == (
        "veriq_migrate_48a230fc2a442dd6f0bbe2ca37ae4bff3d2b7179127332fd"
    )
    assert len(migration._migration_lock_name("另一个数据库")) == 62
    assert migration._migration_lock_name("veriq_test") != migration._migration_lock_name("other")
