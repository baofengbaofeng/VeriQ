"""资源列表摘要读取已保存草稿并与最新发布修订比较，测试经真实工作区、资源和发布接口验证可见结果。"""

from test_auth import login, setup
from test_http_datasets import config
from test_publish import create, publish
from test_workspace import client, new_member, workspace


async def test_dataset_list_projects_current_saved_draft_and_publication_state(site):
    """保存产生待发布提示，发布当前修订清除提示，再保存时列表显示新规模和草稿的实际保存时间。"""
    owner, db = site
    await setup(owner)
    await login(owner)
    ws = await workspace(owner)
    url = f"/api/v1/workspaces/{ws}/resources"
    doc = {
        "schemaVersion": "2.0",
        "shape": "TABLE",
        "fields": {"label": {"type": "string", "required": True, "nullable": False}},
        "source": {"kind": "STATIC", "rows": []},
    }
    content = {"kind": "DATASET", "document": doc}
    path = await create(owner, ws, "dataset", content)

    async def current():
        """每个写入或发布步骤结束后再请求数据集列表，以列表返回的草稿规模和发布状态核对该步骤的结果。"""
        response = await owner.get(url, params={"kind": "DATASET"})
        assert response.status_code == 200, response.text
        return response.json()["data"]["items"][0]

    initial = (await owner.get(path + "/draft")).json()["data"]
    expected = {
        "format": "STATIC_TABLE",
        "fieldCount": 1,
        "entryCount": 0,
        "lastSavedAt": initial["updatedAt"],
        "hasUnpublishedChanges": False,
    }
    assert (await current())["datasetSummary"] == expected

    # 草稿保存后尚无发布指针，提示也要出现。发布同一修订时应只清除提示，不改变该草稿的保存时间。
    doc["source"]["rows"].append({"key": "record", "values": {"label": "Hidden row value"}})
    saved = await owner.put(path + "/draft", json={"revision": 1, "content": content})
    assert saved.status_code == 200, saved.text
    expected.update(
        entryCount=1, lastSavedAt=saved.json()["data"]["updatedAt"], hasUnpublishedChanges=True
    )
    item = await current()
    assert item["status"] == "DRAFT" and item["datasetSummary"] == expected
    version, _, _ = await publish(owner, db, path)
    item = await current()
    assert item["status"] == "PUBLISHED" and item["latestVersionId"] == version["id"]
    assert item["datasetSummary"] == {**expected, "hasUnpublishedChanges": False}

    # 已发布资源继续保持已发布状态，列表改为展示更新后的草稿规模，发布指针仍定位旧发布版本。
    doc["source"]["rows"].append({"key": "second", "values": {"label": "Another hidden row"}})
    saved = await owner.put(path + "/draft", json={"revision": 2, "content": content})
    assert saved.status_code == 200, saved.text
    expected.update(entryCount=2, lastSavedAt=saved.json()["data"]["updatedAt"])
    item = await current()
    assert item["status"] == "PUBLISHED" and item["latestVersionId"] == version["id"]
    assert item["datasetSummary"] == expected
    assert "Hidden row value" not in str(item)
    assert "datasetSummary" not in (await owner.get(path)).json()["data"]


async def test_dataset_summary_preserves_pages_legacy_shape_and_workspace_access(site):
    """游标仅返回本工作区命中的数据集，V1 按静态表计算，树和远程数据集保留各自的计数语义。"""
    owner, _ = site
    await setup(owner)
    await login(owner)
    ws = await workspace(owner)
    foreign = await workspace(owner, "foreign")
    await new_member(owner, ws)
    legacy = {
        "schemaVersion": "1.0",
        "columns": {"label": "string"},
        "rows": [{"key": "one", "values": {"label": "Legacy"}}],
    }
    await create(owner, ws, "legacy", {"kind": "DATASET", "document": legacy})
    await create(owner, foreign, "legacy", {"kind": "DATASET", "document": legacy})
    await create(owner, ws)
    tree = {
        "schemaVersion": "2.0",
        "shape": "TREE",
        "fields": {},
        "source": {
            "kind": "STATIC",
            "rows": [{"key": "root", "values": {}, "parentKey": None, "order": 0}],
        },
    }
    await create(owner, ws, "tree", {"kind": "DATASET", "document": tree})
    remote = config()
    await create(owner, ws, "remote-table", {"kind": "DATASET", "document": remote})
    remote["shape"] = "TREE"
    remote["source"]["mapping"].update(parentKey="/parent", order="/order")
    await create(owner, ws, "remote-tree", {"kind": "DATASET", "document": remote})

    url = f"/api/v1/workspaces/{ws}/resources"
    async with client(owner, "@".join(("member", "example.com"))) as viewer:
        # 查看者继承同一工作区草稿读取权限。跨工作区访问前置失败，不能从统计数据侧面获得资源信息。
        assert (
            await viewer.get(url.replace(ws, foreign), params={"kind": "DATASET"})
        ).status_code == 403
        params = {"kind": "DATASET", "limit": 2}
        first = (await viewer.get(url, params=params)).json()["data"]
        second = (await viewer.get(url, params={**params, "cursor": first["nextCursor"]})).json()[
            "data"
        ]
        assert second["nextCursor"] is None
        items = first["items"] + second["items"]
        assert [item["key"] for item in items] == ["legacy", "remote-table", "remote-tree", "tree"]
        assert all(item["workspaceId"] == ws for item in items)
        legacy_summary, http_table, http_tree, static_tree = (
            item["datasetSummary"] for item in items
        )
        assert (
            legacy_summary["format"],
            legacy_summary["fieldCount"],
            legacy_summary["entryCount"],
        ) == ("STATIC_TABLE", 1, 1)
        assert (static_tree["format"], static_tree["fieldCount"], static_tree["entryCount"]) == (
            "STATIC_TREE",
            0,
            1,
        )
        for http, format_name in [(http_table, "HTTP_TABLE"), (http_tree, "HTTP_TREE")]:
            assert http["format"] == format_name and http["fieldCount"] == 1
            assert "entryCount" not in http
        catalog_page = (await viewer.get(url, params={"kind": "ELEMENT_CATALOG"})).json()["data"]
        assert len(catalog_page["items"]) == 1 and "datasetSummary" not in catalog_page["items"][0]
