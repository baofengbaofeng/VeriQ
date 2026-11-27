"""通过真实工作区资源和受管编译器核对对话动作的修订、回执、授权与不可变发布结果，验证失败时保留原始草稿。"""

import json
from pathlib import Path
import shutil

import pytest
from sqlalchemy import select
from test_auth import login, setup
from test_http_datasets import REF, config as http_configuration, connection as approved_connection
from test_publish import CATALOG, create
from test_workspace import workspace

from veriq_server.auth.authorization import WorkspaceScope
from veriq_server.db import Job, ResourceVersion, User, WorkspaceMember
from veriq_server.service import Problem, lock_installation
from veriq_server.services.agent_resource_drafts import find_configuration
from veriq_server.services.agent_resource_lifecycle import (
    apply_resource_lifecycle,
    prepare_resource_lifecycle,
    validation_progress,
)
from veriq_server.services.server_compilation import compile_next
from veriq_server.settings import Settings


@pytest.fixture(name="catalog_action")
async def _catalog_action(site):
    """从正常管理界面创建资源并读取数据库中的当前成员，向同一个工作区提交确切版本的校验及发布。"""
    client, db = site
    await setup(client)
    await login(client)
    scope = WorkspaceScope(await workspace(client))
    path = await create(client, scope.workspace_id)
    rid = path.rsplit("/", 1)[1]
    uid = (await client.get("/api/v1/account")).json()["data"]["id"]
    settings = Settings(
        database_url=db.engine.url.render_as_string(hide_password=False),
        environment="development",
        public_url="http://127.0.0.1:18889",
        master_key="a" * 64,
        signing_key="b" * 64,
    )
    return (
        client,
        db,
        scope,
        path,
        uid,
        settings,
        {"type": "VALIDATE_RESOURCE", "resourceId": rid, "revision": 1},
    )


async def _compile(db, settings):
    """仅在需要验证真实编译回执的测试中装入已批准发行及本机工具，权限或发现测试可以独立在纯服务器环境执行。"""
    release = Path(".superpowers/cache/t11/release").resolve()
    node = shutil.which("node")
    npm = shutil.which("npm")
    assert node and npm and (release / "inventory.json").is_file()
    settings = settings.model_copy(
        update={
            "approved_engine_inventory_path": str(release / "inventory.json"),
            "server_compiler_release_dir": str(release),
            "server_compiler_node_path": str(Path(node).resolve()),
            "server_compiler_npm_cli_path": str(Path(npm).resolve()),
            "server_compiler_tsx_path": str(
                Path("packages/contracts/node_modules/tsx/dist/loader.mjs").resolve()
            ),
        }
    )
    return await compile_next(db, settings)


async def test_review_queue_compile_publish_exact_resource(catalog_action):
    """用户确认一次后真实编译器消费作业，进度返回受管回执，再用确认卡发布同一修订并读取不可变版本。"""
    client, db, scope, path, uid, settings, choice = catalog_action
    async with db.sessions.begin() as s:
        user = await s.get(User, uid)
        proposal = await prepare_resource_lifecycle(s, scope, user, choice, settings)
        assert await s.scalar(select(Job.id)) is None
    async with db.sessions.begin() as s:
        await lock_installation(s)
        queued = await apply_resource_lifecycle(s, scope, user, proposal, settings)
    locator = {"validationJobId": queued["validationJobId"]}
    publish = {**choice, "type": "PUBLISH_RESOURCE", **locator}
    async with db.sessions.begin() as s:
        pending = await validation_progress(s, scope, user, locator, settings)
        assert pending == {
            **locator,
            "resourceId": choice["resourceId"],
            "revision": 1,
            "sourceHash": proposal["sourceHash"],
            "state": "QUEUED",
        }
        assert pending == await validation_progress(
            s, scope, user, {"resourceId": choice["resourceId"], "revision": 1}, settings
        )
        with pytest.raises(Problem) as blocked:
            await prepare_resource_lifecycle(s, scope, user, publish, settings)
        assert blocked.value.code == "VALIDATION_RECEIPT_UNAVAILABLE"
    assert await _compile(db, settings)
    async with db.sessions.begin() as s:
        progress = await validation_progress(s, scope, user, locator, settings)
        assert progress["state"] == "FINISHED" and progress["outcome"] == "PASSED"
        approved = await prepare_resource_lifecycle(s, scope, user, publish, settings)
        assert approved == {
            **publish,
            "sourceHash": proposal["sourceHash"],
            "validationReceiptId": progress["validationReceiptId"],
        }
    async with db.sessions.begin() as s:
        await lock_installation(s)
        saved = await apply_resource_lifecycle(s, scope, user, approved, settings)
        assert saved == {**approved, "versionId": saved["versionId"]}
    version = (await client.get(path + "/versions/" + saved["versionId"])).json()["data"]
    assert version["content"] == CATALOG and version["versionNo"] == 1
    async with db.sessions() as s:
        row = await s.get(ResourceVersion, saved["versionId"])
        assert (row.draft_revision, row.receipt_id) == (1, approved["validationReceiptId"])

    assert (await client.put(path + "/draft", json={"revision": 1, "content": CATALOG})).is_success
    async with db.sessions.begin() as s:
        await lock_installation(s)
        with pytest.raises(Problem) as stale_publish:
            await apply_resource_lifecycle(s, scope, user, approved, settings)
        assert stale_publish.value.code == "STALE_REVISION"
        assert (await s.scalars(select(ResourceVersion.id))).all() == [saved["versionId"]]


async def test_stale_and_failed_reviews_refuse_publication(catalog_action):
    """草稿在审阅后被编辑、权限在入队后被撤销时均不得发布，读取失败进度只返回确定的状态和结论。"""
    client, db, scope, path, uid, settings, choice = catalog_action
    async with db.sessions.begin() as s:
        user = await s.get(User, uid)
        proposal = await prepare_resource_lifecycle(s, scope, user, choice, settings)
    assert (
        await client.put(path + "/draft", json={"revision": 1, "content": CATALOG})
    ).status_code == 200
    async with db.sessions.begin() as s:
        await lock_installation(s)
        with pytest.raises(Problem) as stale:
            await apply_resource_lifecycle(s, scope, user, proposal, settings)
        assert stale.value.code == "STALE_REVISION"
        proposal = await prepare_resource_lifecycle(
            s, scope, user, {**choice, "revision": 2}, settings
        )
        queued = await apply_resource_lifecycle(s, scope, user, proposal, settings)
        member = await s.get(WorkspaceMember, (scope.workspace_id, uid))
        member.role = "VIEWER"
    await _compile(db, settings)
    key = {"validationJobId": queued["validationJobId"]}
    async with db.sessions.begin() as s:
        progress = await validation_progress(s, scope, user, key, settings)
        assert progress["outcome"] == "ERROR" and "validationReceiptId" not in progress
        current_member = await s.get(WorkspaceMember, (scope.workspace_id, uid))
        current_member.role = "OWNER"
    async with db.sessions.begin() as s:
        with pytest.raises(Problem) as failed:
            await prepare_resource_lifecycle(
                s,
                scope,
                user,
                {**choice, "type": "PUBLISH_RESOURCE", "revision": 2, **key},
                settings,
            )
        assert failed.value.code == "VALIDATION_RECEIPT_UNAVAILABLE"


async def test_connected_draft_uses_registered_binding_without_projecting_configuration(
    catalog_action,
):
    """编辑器保存的连接数据集可按绑定校验；审阅与查询均隐藏请求参数，确认时若用户已失去连接授权则拒绝排队。"""
    client, db, scope, _, uid, settings, _ = catalog_action
    doc = http_configuration()
    doc["source"]["auth"] = {"kind": "NONE"}
    binding = approved_connection().model_copy(
        update={"workspace_id": scope.workspace_id, "user_ids": [uid], "auth_kinds": ["NONE"]}
    )
    settings.dataset_connections = {REF: binding}
    path = await create(
        client, scope.workspace_id, "connected", {"kind": "DATASET", "document": doc}
    )
    rid = path.rsplit("/", 1)[1]
    choice = {"type": "VALIDATE_RESOURCE", "resourceId": rid, "revision": 1}
    async with db.sessions.begin() as s:
        user = await s.get(User, uid)
        context = {"assets": []}
        found = await find_configuration(s, scope, {"resourceId": rid}, context, set())
        assert found["items"][0]["revision"] == 1 and found["draft"] == {}
        proposal = await prepare_resource_lifecycle(s, scope, user, choice, settings, context)
        assert set(proposal) == {"type", "resourceId", "revision", "sourceHash"}
        assert REF not in json.dumps([found, proposal]) and "/items" not in json.dumps(
            [found, proposal]
        )
    settings.dataset_connections = {}
    async with db.sessions.begin() as s:
        await lock_installation(s)
        with pytest.raises(Problem) as revoked:
            await apply_resource_lifecycle(s, scope, user, proposal, settings)
        assert revoked.value.code == "DATASET_CONNECTION_UNAVAILABLE"
        assert await s.scalar(select(Job.id)) is None


async def test_workspace_check_and_foreign_receipts(catalog_action):
    """即使同一用户也是两个空间的所有者，查询作业与准备发布仍必须绑定选中资源的工作区、修订和成功回执。"""
    client, db, scope, _, uid, settings, choice = catalog_action
    other_scope = WorkspaceScope(await workspace(client, "other"))
    other_rid = (await create(client, other_scope.workspace_id)).rsplit("/", 1)[1]
    async with db.sessions.begin() as s:
        user = await s.get(User, uid)
        await lock_installation(s)
        proposal = await prepare_resource_lifecycle(s, scope, user, choice, settings)
        queued = await apply_resource_lifecycle(s, scope, user, proposal, settings)
    async with db.sessions.begin() as s:
        locator = {"validationJobId": queued["validationJobId"]}
        with pytest.raises(Problem) as wrong_job:
            await validation_progress(s, other_scope, user, locator, settings)
        assert wrong_job.value.code == "JOB_NOT_FOUND"
        with pytest.raises(Problem) as wrong_resource:
            await prepare_resource_lifecycle(s, other_scope, user, choice, settings)
        assert wrong_resource.value.code == "RESOURCE_NOT_FOUND"
        with pytest.raises(Problem) as wrong_publish:
            await prepare_resource_lifecycle(
                s,
                other_scope,
                user,
                {**choice, "type": "PUBLISH_RESOURCE", "resourceId": other_rid, **locator},
                settings,
            )
        assert wrong_publish.value.code == "JOB_NOT_FOUND"


async def test_native_fixture_revision_available_without_endpoint_projection(catalog_action):
    """用户在专用表单保存夹具后，对话目录仅展示其修订便可准备校验，夹具地址和完整请求不会传入模型。"""
    client, db, scope, _, uid, settings, _ = catalog_action
    examples = json.loads(
        Path("packages/contracts/fixtures/compatibility.json").read_text(encoding="utf-8")
    )
    fixture = next(row["value"] for row in examples if row["name"] == "asset-FIXTURE")
    path = await create(client, scope.workspace_id, "native-fixture", fixture)
    rid = path.rsplit("/", 1)[1]
    async with db.sessions() as s:
        context = {"assets": []}
        user = await s.get(User, uid)
        result = await find_configuration(s, scope, {"resourceId": rid}, context, set())
        assert result == {
            "items": [
                {
                    "resourceId": rid,
                    "kind": "FIXTURE",
                    "key": "native-fixture",
                    "name": "native-fixture",
                    "revision": 1,
                }
            ]
        }
        selected = {"type": "VALIDATE_RESOURCE", "resourceId": rid, "revision": 1}
        action = await prepare_resource_lifecycle(s, scope, user, selected, settings, context)
        assert set(action) == {"type", "resourceId", "revision", "sourceHash"}
