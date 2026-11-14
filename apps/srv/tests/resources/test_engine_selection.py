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
from veriq_server.db import User, Job, Artifact, ResourceVersion
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


async def test_selected_engine_publishes_through_http_with_matching_receipt(site) -> None:
    """非默认引擎的发布必须沿用同一 HTTP 应用的配置，并精确绑定当前成功校验回执；这里复用现有发布服务夹具测试配置传递，真实生产器编译与浏览器执行另由桌面完整验收证明。

    旧测试只检查新引擎不能覆盖已发布修订，错误的默认引擎回退也可能产生同样的 409。
    本例创建全新资源并要求 201，因而漏传引擎配置会稳定失败。
    发布结果必须保留回执来源摘要和明确的 1.0.0 版本。
    """
    import httpx
    from tornado.httpserver import HTTPServer
    from tornado.netutil import bind_sockets
    from test_publish import queue, completed
    from veriq_server.app import make_app

    client, database = site
    await setup(client)
    sockets = bind_sockets(0, "127.0.0.1")
    origin = f"http://127.0.0.1:{sockets[0].getsockname()[1]}"
    settings = Settings(
        database_url=database.engine.url.render_as_string(hide_password=False),
        public_url=origin,
        master_key="a" * 64,
        signing_key="b" * 64,
        environment="development",
        validation_engine_version="1.0.0",
    )
    application = make_app(settings, database)
    server = HTTPServer(application)
    server.add_sockets(sockets)
    try:
        async with httpx.AsyncClient(base_url=origin, headers={"Origin": origin}) as current:
            state = await current.get("/api/v1/setup")
            current.headers["X-CSRF-Token"] = state.json()["data"]["csrfToken"]
            assert (await login(current)).status_code == 200
            workspace_id = await workspace(current, "selected-engine-publish")
            path = await create(current, workspace_id)
            preview, job = await queue(current, path)
            assert preview["engineVersion"] == "1.0.0"
            receipt_id, snapshot = await completed(database, job["id"])
            receipt = (
                await current.get(
                    f"/api/v1/workspaces/{workspace_id}/jobs/{job['id']}/validation-receipt"
                )
            ).json()["data"]
            assert receipt["engineVersion"] == "1.0.0"
            response = await current.post(
                path + "/publish",
                json={"revision": preview["revision"], "validationReceiptId": receipt_id},
            )
            assert response.status_code == 201, response.text
            published = response.json()["data"]
            async with database.sessions() as session:
                persisted = await session.get(ResourceVersion, published["id"])
                assert persisted is not None
                assert persisted.engine_version == receipt["engineVersion"] == "1.0.0"
                assert persisted.receipt_id == receipt_id
                assert persisted.source_hash == receipt["sourceHash"] == snapshot["sourceHash"]
                assert persisted.workspace_id == workspace_id
                assert persisted.id == snapshot["validationTarget"]["versionId"]
    finally:
        server.stop()
        await server.close_all_connections()
        await application.settings["reset_dispatcher"].close()
