"""在真实数据库中检查一次确认多个草稿的提交边界，混合创建和更新时任何一项冲突都应保留确认前的全部资源事实。"""

import pytest
from sqlalchemy import select
from test_auth import login, setup
from test_publish import CATALOG, create
from test_workspace import workspace

from veriq_server.auth.authorization import WorkspaceScope
from veriq_server.db import AuditLog, Resource, ResourceDraft, User
from veriq_server.service import Problem, lock_installation
from veriq_server.services.agent_resource_batch import prepare_resource_batch, save_resource_batch


def _draft(key, rid=None):
    """构造通过普通资源编辑器可表达的完整草稿，更新指向当前修订，创建则仅携带待审阅的资源身份和内容。"""
    result = {
        "type": "SAVE_RESOURCE_DRAFT",
        "resource": {"key": key, "name": key, "kind": "ELEMENT_CATALOG", "content": CATALOG},
    }
    if rid:
        result.update(resourceId=rid, revision=1)
    return result


async def test_stale_second_draft_rolls_back_first_and_its_audit(site):
    """第二个草稿在审阅后被编辑，确认事务即使捕获冲突并继续提交，也不能保留第一项创建或它的审计记录。"""
    client, db = site
    await setup(client)
    await login(client)
    scope = WorkspaceScope(await workspace(client))
    path = await create(client, scope.workspace_id, "existing")
    rid = path.rsplit("/", 1)[1]
    uid = (await client.get("/api/v1/account")).json()["data"]["id"]
    group = {"type": "SAVE_RESOURCE_DRAFTS", "items": [_draft("new"), _draft("existing", rid)]}
    async with db.sessions.begin() as s:
        user = await s.get(User, uid)
        prepared = await prepare_resource_batch(
            s, scope, user, group, {"request": rid, "assets": []}
        )
        assert prepared == group
    assert (await client.put(path + "/draft", json={"revision": 1, "content": CATALOG})).is_success
    async with db.sessions.begin() as s:
        prior_audits = set(await s.scalars(select(AuditLog.id)))
        await lock_installation(s)
        with pytest.raises(Problem) as stale:
            await save_resource_batch(s, scope, user, prepared)
        assert stale.value.code == "STALE_REVISION"
    async with db.sessions() as s:
        assert (await s.scalars(select(Resource.key))).all() == ["existing"]
        assert (await s.get(ResourceDraft, rid)).revision == 2
        assert set(await s.scalars(select(AuditLog.id))) == prior_audits


async def test_duplicate_keys_and_ids_block_batch_before_writes(site):
    """具有重复资源标识或重复类型与键的两项操作会让审阅对象含糊，因此应整组拒绝且数据库不产生草稿。"""
    client, db = site
    await setup(client)
    await login(client)
    scope = WorkspaceScope(await workspace(client))
    uid = (await client.get("/api/v1/account")).json()["data"]["id"]
    async with db.sessions.begin() as s:
        user = await s.get(User, uid)
        for items in (
            [_draft("alpha"), _draft("alpha")],
            [_draft("one", uid), _draft("two", uid.upper())],
        ):
            with pytest.raises(Problem) as duplicate:
                await prepare_resource_batch(
                    s, scope, user, {"type": "SAVE_RESOURCE_DRAFTS", "items": items}
                )
            assert duplicate.value.code == "AGENT_RESOURCE_BATCH_DUPLICATE"
        assert await s.scalar(select(Resource.id)) is None


@pytest.mark.parametrize("count", [1, 6])
async def test_group_size_rejected_before_database_access(count):
    """在查数据库之前先执行整组形状与数量约束，单项仍可走原先的确认流程，超出五项则须由员工拆分。"""
    with pytest.raises(Problem) as invalid:
        await prepare_resource_batch(
            None,
            None,
            None,
            {
                "type": "SAVE_RESOURCE_DRAFTS",
                "items": [_draft(f"draft-{index}") for index in range(count)],
            },
        )
    assert invalid.value.code == "AGENT_RESOURCE_BATCH_INVALID"
