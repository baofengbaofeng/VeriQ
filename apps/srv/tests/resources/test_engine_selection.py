"""真实 MySQL 集成验证引擎配置切换只改变新校验的快照与能力要求，旧预览提交必须冲突且旧 Job 的来源字节保持不变；未批准发行仍由既有 ApprovedEngines 边界拒绝。

复用现有鉴权与隔离数据库夹具，不创建第二套资源服务。
校验任务可以等待 Runtime，不把排队任务当作成功回执。
"""

import json

import pytest
from sqlalchemy import select

from test_auth import setup, login
from test_workspace import workspace
from test_publish import create
from veriq_server.auth.authorization import WorkspaceScope
from veriq_server.db import User, Job, Artifact
from veriq_server.service import Problem, lock_installation
from veriq_server.services.resource import ResourceService
from veriq_server.services.engines import ApprovedEngines
from veriq_server.settings import Settings


async def test_engine_switch_conflicts_stale_preview_and_keeps_old_job(site) -> None:
    """通过真实 HTTP 创建资产后在同一授权服务中分别选择旧、新引擎，检查旧预览 sourceHash 被拒绝以及已排队 Job 的持久化快照不变，确保配置切换不能重写历史编译输入。

    安装行锁沿用资源写入事务协议。
    比较读取到的 Artifact 原始字节，而非只比较内存 DTO。
    """
    client, database = site
    await setup(client)
    await login(client)
    ws = await workspace(client, "engine-selection")
    path = await create(client, ws)
    resource_id = path.rsplit("/", 1)[1]
    async with database.sessions.begin() as session:
        await lock_installation(session)
        user = (
            await session.execute(select(User).where(User.email == "admin@example.com"))
        ).scalar_one()
        scope = WorkspaceScope(ws)
        previous = ResourceService(session, user)
        preview = await previous.preview(scope, resource_id)
        queued = await previous.validate(
            scope, resource_id, preview["revision"], preview["sourceHash"]
        )
        job = await session.get(Job, queued["id"])
        artifact = await session.get(Artifact, (ws, job.snapshot_hash))
        frozen = artifact.content
        selected = ResourceService(session, user, engine_version="1.0.0")
        current = await selected.preview(scope, resource_id)
        assert current["engineVersion"] == "1.0.0"
        assert current["sourceHash"] != preview["sourceHash"]
        with pytest.raises(Problem) as stale:
            await selected.validate(scope, resource_id, preview["revision"], preview["sourceHash"])
        assert stale.value.code == "STALE_SOURCE_HASH"
        assert artifact.content == frozen
        assert json.loads(frozen)["engineVersion"] == "0.1.0"


def test_unknown_engine_cannot_become_approved_by_selection(tmp_path) -> None:
    """配置中选择一个语法合法但未批准的版本不能授予发行权威，正式发布需要的 ApprovedEngines 查询仍返回 ENGINE_NOT_APPROVED；该拒绝不限制原有未验证 DSL 调试流程。

    空批准列表代表操作员尚未晋升任何候选。
    Settings 接受选择值与批准查询拒绝是不同责任边界。
    """
    path = tmp_path / "approved.json"
    path.write_text('{"schemaVersion":"1.0","engines":[]}')
    settings = Settings(
        database_url="mysql+asyncmy://unused:unused@localhost/veriq_unused",
        public_url="https://veriq.example",
        master_key="a" * 64,
        signing_key="b" * 64,
        validation_engine_version="9.0.0",
        approved_engine_inventory_path=str(path),
    )
    with pytest.raises(Problem) as rejected:
        ApprovedEngines(settings).require(settings.validation_engine_version)
    assert rejected.value.code == "ENGINE_NOT_APPROVED"
