"""使用真实控制面和专用 MySQL 验证数据集的规范字节上限以及按资源种类区分的请求包络，避免客户端单独放宽。"""

from test_auth import setup, login
from test_workspace import workspace
from veriq_server.contracts import canonical_bytes

_CATALOG = {
    "kind": "ELEMENT_CATALOG",
    "document": {
        "schemaVersion": "1.0",
        "elements": [{"key": "save", "locator": {"by": "veriqId", "value": "save"}}],
    },
}


async def _create(c, ws, key="catalog", content=None):
    """通过资源创建端点取得后续保存使用的真实资源路径，沿用当前会话和工作区的认证与请求校验。"""
    data = content or _CATALOG
    response = await c.post(
        f"/api/v1/workspaces/{ws}/resources",
        json={"kind": data["kind"], "key": key, "name": key, "content": data},
    )
    assert response.status_code == 201
    return f"/api/v1/workspaces/{ws}/resources/{response.json()['data']['id']}"


async def test_dataset_draft_budget_accepts_ten_mib_and_preserves_failed_revision(site):
    """真实请求跨过默认传输上限且准确到达数据集的规范字节边界，超限写入不能改变持久化内容或修订。"""
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    data = {
        "kind": "DATASET",
        "document": {
            "schemaVersion": "1.0",
            "columns": {"value": "string"},
            "rows": [{"key": "sample", "values": {"value": ""}}],
        },
    }
    values = data["document"]["rows"][0]["values"]
    limit = 10 * 1024 * 1024
    remaining = limit - len(canonical_bytes(data))
    small_path = await _create(c, ws, "initial", data)
    values["value"] = "a" * (3 * 1024 * 1024)
    saved = await c.put(small_path + "/draft", json={"revision": 1, "content": data})
    assert saved.status_code == 200

    values["value"] = "数" * (remaining // 3) + "a" * (remaining % 3)
    assert len(canonical_bytes(data)) == limit
    path = await _create(c, ws, "ten-mib", data)
    saved = (await c.get(path + "/draft")).json()["data"]
    assert saved["revision"] == 1 and saved["content"] == data

    values["value"] = "据" + values["value"][1:]
    updated = await c.put(path + "/draft", json={"revision": 1, "content": data})
    assert updated.status_code == 200
    assert updated.json()["data"]["revision"] == 2
    values["value"] += "x"
    rejected = await c.put(path + "/draft", json={"revision": 2, "content": data})
    assert rejected.status_code == 413 and rejected.json()["code"] == "BODY_TOO_LARGE"
    values["value"] = values["value"][:-1]
    saved = (await c.get(path + "/draft")).json()["data"]
    assert saved["revision"] == 2 and saved["content"] == data


async def test_non_dataset_write_envelope_remains_bounded(site):
    """资源写入路径仍按文档种类限制请求正文，扩大的数据集入口不允许其他资源使用额外的包络体积。"""
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    path = await _create(c, ws)
    payloads = (
        (
            "POST",
            f"/api/v1/workspaces/{ws}/resources",
            {"kind": _CATALOG["kind"], "key": "another", "name": "Another", "content": _CATALOG},
        ),
        ("PUT", path + "/draft", {"revision": 1, "content": _CATALOG}),
    )
    for method, url, payload in payloads:
        body = canonical_bytes(payload).ljust(2 * 1024 * 1024 + 4097)
        response = await c.request(
            method, url, content=body, headers={"Content-Type": "application/json"}
        )
        assert response.status_code == 413 and response.json()["code"] == "BODY_TOO_LARGE"

    declared_dataset = {
        "kind": "DATASET",
        "document": {
            "schemaVersion": "1.0",
            "columns": {"value": "string"},
            "rows": [{"key": "sample", "values": {"value": "sample"}}],
        },
    }
    body = canonical_bytes({"revision": 1, "content": declared_dataset}).ljust(
        2 * 1024 * 1024 + 4097
    )
    response = await c.put(
        path + "/draft", content=body, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422 and response.json()["code"] == "INVALID_RESOURCE_DOCUMENT"
    assert (await c.get(path + "/draft")).json()["data"]["revision"] == 1
