"""实际升降级保留旧重置链接，活跃冷却阻止整条回滚，而已消费或过窗历史不永久阻止恢复。"""

from datetime import timedelta
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import inspect, select, text, update

from veriq_server import migrate
from veriq_server.db import User, UserToken
from veriq_server.service import issue_reset, lock_installation, now
from test_auth import setup


@pytest.mark.parametrize("history", ["consumed", "cooled"])
async def test_reset_migration_refuses_active_cooldown_but_allows_old_history(site, history):
    """MySQL 隐式 DDL 前拒绝活跃冷却；历史记录安全时允许降级并升级，原令牌摘要及有效期不改变。"""
    client, db = site
    await setup(client)
    async with db.sessions.begin() as session:
        await lock_installation(session)
        user = (await session.execute(select(User))).scalar_one()
        await issue_reset(session, user, 30)
    config = Config()
    config.set_main_option("script_location", str(Path(migrate.__file__).parent / "migrations"))
    head = ScriptDirectory.from_config(config).get_current_head()
    async with db.engine.connect() as connection:

        def downgrade(sync):
            """使用发行共用的迁移环境执行完整降级路径，先验证历史预检拒绝，避免只测试单个函数而漏掉隐式提交边界。"""
            config.attributes["connection"] = sync
            command.downgrade(config, "0028_resource_creation_identity")

        with pytest.raises(RuntimeError, match="cooldown"):
            await connection.run_sync(downgrade)
        assert (
            await connection.execute(text("SELECT version_num FROM veriq_alembic_version"))
        ).scalar() == head
        assert await connection.run_sync(
            lambda sync: "issued_at"
            in {column["name"] for column in inspect(sync).get_columns("veriq_user_tokens")}
        )
        await connection.rollback()
    async with db.sessions.begin() as session:
        fields = (
            {"consumed": True}
            if history == "consumed"
            else {"issued_at": now() - timedelta(seconds=61)}
        )
        await session.execute(update(UserToken).values(**fields))
        original = (await session.execute(select(UserToken.token_hash, UserToken.expires_at))).one()
    async with db.engine.connect() as connection:
        try:
            await connection.run_sync(downgrade)
            assert await connection.run_sync(
                lambda sync: "issued_at"
                not in {column["name"] for column in inspect(sync).get_columns("veriq_user_tokens")}
            )
        finally:

            def upgrade(sync):
                """验证后恢复最新迁移结构并提交连接事务，使后续独立用例不会读到本次降级遗留的旧结构或未提交状态。"""
                config.attributes["connection"] = sync
                command.upgrade(config, "head")

            await connection.run_sync(upgrade)
            await connection.commit()
    async with db.sessions() as session:
        restored = (await session.execute(select(UserToken))).scalar_one()
        assert (restored.token_hash, restored.expires_at) == tuple(original)
        assert restored.issued_at is None
