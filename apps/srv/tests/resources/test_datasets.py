"""使用与编译器相同的数据夹具确认服务端草稿入口接受合法结构，并将行值与树关系的业务验证留给现有可信编译环节。"""

import json
from pathlib import Path

import pytest
from sqlalchemy import select
from test_auth import login, setup
from test_publish import create, publish
from test_workspace import accept, client as member_client, invite, new_member, workspace

from veriq_server.db import AuditLog

from veriq_server.service import Problem
from veriq_server.services.resource import check_document

ROOT = Path(__file__).resolve().parents[4]
FIXTURES = json.loads(
    (ROOT / "packages/contracts/fixtures/datasets.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("fixture", FIXTURES, ids=[fixture["name"] for fixture in FIXTURES])
def test_dataset_document_structure(fixture):
    """标准资源校验应识别新版表格、树及空集合，但树行缺少序号或在表格附带树属性时须拒绝保存。"""
    content = {"kind": "DATASET", "document": fixture["document"]}
    if fixture.get("invalidStructure"):
        with pytest.raises(Problem) as error:
            check_document("DATASET", content)
        assert error.value.code == "INVALID_RESOURCE_DOCUMENT"
    else:
        check_document("DATASET", content)


def test_legacy_dataset_document():
    """上一个契约版本的正式示例依旧经过原资源入口验证，列声明和行仍保留在同一层级以兼容已发布资产。"""
    sample = ROOT / "fixtures/sample-workspace/assets/dataset.json"
    check_document("DATASET", json.loads(sample.read_text(encoding="utf-8")))


async def _copy_fixture(site, content):
    """复用真实工作区和发布接口准备冻结来源，使目标操作只接收版本标识而没有注入文档的测试捷径。"""

    client, db = site
    await setup(client)
    await login(client)
    source = await workspace(client, "source")
    target = await workspace(client, "target")
    path = await create(client, source, "original", content)
    version, _, _ = await publish(client, db, path)
    route = f"/api/v1/workspaces/{target}/resources/dataset-copies"
    body = {
        "sourceWorkspaceId": source,
        "sourceDatasetVersionId": version["id"],
        "key": "copy",
        "name": "Independent copy",
    }
    return route, path, body


async def test_copy_dataset_checks_both_workspaces(site):
    """两个租户均有成员关系时分别撤去下载和编辑能力，确保列表和写入均在读取来源信息之前拒绝。"""
    owner, _ = site
    content = json.loads((ROOT / "fixtures/sample-workspace/assets/dataset.json").read_text())
    route, _, body = await _copy_fixture(site, content)
    source = body["sourceWorkspaceId"]
    target = route.split("/")[4]
    email = "member@example.com"
    uid = await new_member(owner, source, email, "VIEWER")
    token = await invite(owner, target, email, "EDITOR")
    async with member_client(owner, email) as member:
        assert (await accept(member, token)).status_code == 200
        for source_role, target_role in [("VIEWER", "EDITOR"), ("EXECUTOR", "VIEWER")]:
            for ws, role in [(source, source_role), (target, target_role)]:
                result = await owner.put(
                    f"/api/v1/workspaces/{ws}/members/{uid}",
                    json={"role": role, "status": "ACTIVE"},
                )
                assert result.status_code == 200
            assert (
                await member.get(route, params={"sourceWorkspaceId": source})
            ).status_code == 403
            assert (await member.post(route, json=body)).status_code == 403
    assert (await owner.get(route.rsplit("/", 1)[0])).json()["data"]["items"] == []


@pytest.mark.parametrize("legacy", [True, False])
async def test_copy_dataset_is_independent(site, legacy):
    """从已发布版本建立副本后修改源草稿，目标仍持有原内容；同键冲突和伪造来源均不能留下部分结果。"""
    client, db = site
    legacy_content = json.loads(
        (ROOT / "fixtures/sample-workspace/assets/dataset.json").read_text()
    )
    v2 = {"kind": "DATASET", "document": FIXTURES[0]["document"]}
    content, changed = (legacy_content, v2) if legacy else (v2, legacy_content)
    route, source_path, body = await _copy_fixture(site, content)
    source = body["sourceWorkspaceId"]
    index = await client.get(route, params={"sourceWorkspaceId": source})
    assert index.status_code == 200
    assert index.json()["data"] == {
        "items": [
            {
                "resourceId": source_path.rsplit("/", 1)[1],
                "key": "original",
                "name": "original",
                "versionId": body["sourceDatasetVersionId"],
                "versionNo": 1,
            }
        ],
        "nextCursor": None,
    }
    # 先让来源草稿与已发布正文产生差异，使误读草稿的实现即使生成新的资源标识也无法通过内容断言。
    assert (
        await client.put(source_path + "/draft", json={"revision": 1, "content": changed})
    ).status_code == 200
    created = await client.post(route, json=body)
    assert created.status_code == 201, created.text
    resource = created.json()["data"]
    assert resource["id"] != source_path.rsplit("/", 1)[1] and resource["status"] == "DRAFT"
    next_version, _, _ = await publish(client, db, source_path)
    assert next_version["content"] == changed
    base = route.rsplit("/", 1)[0]
    draft = (await client.get(f"{base}/{resource['id']}/draft")).json()["data"]
    assert draft["content"] == content and draft["revision"] == 1
    assert (await client.post(route, json=body)).status_code == 409
    wrong = {**body, "sourceWorkspaceId": resource["workspaceId"], "key": "other"}
    assert (await client.post(route, json=wrong)).status_code == 404
    assert (await client.get(base)).json()["data"]["items"] == [resource]
    logs = (await client.get(f"/api/v1/workspaces/{resource['workspaceId']}/audit")).json()["data"][
        "items"
    ]
    event = next(row for row in logs if row["action"] == "dataset.copied")
    assert (
        event["targetId"] == resource["id"] and body["sourceDatasetVersionId"] not in event.values()
    )
    async with db.sessions() as session:
        created_event = (
            await session.scalars(
                select(AuditLog).where(
                    AuditLog.target_id == resource["id"], AuditLog.action == "resource.created"
                )
            )
        ).one()
        assert created_event.source_version_id is None
        log = (
            await session.scalars(
                select(AuditLog).where(
                    AuditLog.workspace_id == resource["workspaceId"],
                    AuditLog.action == "dataset.copied",
                )
            )
        ).one()
        assert (
            log.target_id == resource["id"]
            and log.source_version_id == body["sourceDatasetVersionId"]
        )


async def test_dataset_copy_discovery_paginates_only_source_dataset_versions(site):
    """翻页只暴露指定工作区的数据集版本元信息，不能列出未发布草稿或其它类型，也不能复用另一来源的游标。"""
    client, db = site
    content = {"kind": "DATASET", "document": FIXTURES[0]["document"]}
    route, source_path, body = await _copy_fixture(site, content)
    source = body["sourceWorkspaceId"]
    await create(client, source, "unpublished", content)
    catalog = await create(client, source)
    other_kind, _, _ = await publish(client, db, catalog)
    assert (
        await client.post(route, json={**body, "sourceDatasetVersionId": other_kind["id"]})
    ).status_code == 404
    await client.put(source_path + "/draft", json={"revision": 1, "content": content})
    second, _, _ = await publish(client, db, source_path)
    query = {"sourceWorkspaceId": source, "limit": 1}
    first = (await client.get(route, params=query)).json()["data"]
    assert len(first["items"]) == 1 and first["nextCursor"]
    query["cursor"] = first["nextCursor"]
    last = (await client.get(route, params=query)).json()["data"]
    assert len(last["items"]) == 1 and last["nextCursor"] is None
    assert {row["versionId"] for row in first["items"] + last["items"]} == {
        body["sourceDatasetVersionId"],
        second["id"],
    }
    wrong_scope = {**query, "sourceWorkspaceId": route.split("/")[4]}
    assert (await client.get(route, params=wrong_scope)).status_code == 400
    assert (await client.get(route, params={"sourceWorkspaceId": "bad-id"})).status_code == 400
