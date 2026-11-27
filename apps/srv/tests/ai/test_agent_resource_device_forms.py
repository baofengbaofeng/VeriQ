"""在真实资源与设备管理接口上核对私有表单来源，只有提交成功的业务变化才能作为当前员工对话中的回执。"""

import json
from pathlib import Path

import pytest
from emulator import emulator
from sqlalchemy import select
from test_agent_resource_lifecycle import _compile
from test_auth import login, setup
from test_conversational_agent import conversation, submit
from test_http_datasets import REF, config as http_configuration, connection as approved_connection
from test_publish import CATALOG
from test_workspace import client as member_client, new_member, workspace

from veriq_server.db import AgentFormReceipt, ResourceDraft
from veriq_server.settings import Settings
from veriq_server.services.agent_form_receipts import FORM_ORIGIN_HEADER


def _example(name):
    """按公开契约的夹具目录取现有的普通编辑器示例，资源类型和输入值在发出领域请求之前已独立确定。"""
    catalog = Path("packages/contracts/fixtures/compatibility.json")
    return next(
        item["value"]
        for item in json.loads(catalog.read_text(encoding="utf-8"))
        if item["name"] == name
    )


async def _form(client, turns, provider, capability):
    """通过供应商协议在真实员工会话中交付目标能力的表单卡，以持久化轮次标识作为后续领域操作的私有来源。"""
    provider.output = {
        "reply": "Review the workspace form.",
        "workspaceForm": {"capability": capability},
    }
    return (await submit(client, turns, f"Open {capability} form for review"))["id"]


async def _receipts(db, turn):
    """直接按已持久化的员工轮次读取事务结果，检查数据库保存的目标、动作与修订，排除页面渲染造成的假象。"""
    async with db.sessions() as session:
        return (
            await session.execute(
                select(
                    AgentFormReceipt.action, AgentFormReceipt.target_id, AgentFormReceipt.revision
                )
                .where(AgentFormReceipt.turn_id == turn)
                .order_by(AgentFormReceipt.created_at, AgentFormReceipt.id)
            )
        ).all()


async def test_fixture_form_records_writes_with_committed_revision(site):
    """表单创建和保存只登记实际草稿修订，失效的旧保存与无关目录不产生回执，同一校验作业的重放也保持唯一。"""
    client, db = site
    await setup(client)
    await login(client)
    wid = await workspace(client)
    base = f"/api/v1/workspaces/{wid}/resources"
    fixture = _example("asset-FIXTURE")
    async with emulator() as model:
        turns, _, _ = await conversation(client, wid, model)
        turn = await _form(client, turns, model, "FIXTURE")
    headers = {FORM_ORIGIN_HEADER: turn}
    response = await client.post(
        base,
        json={"kind": "FIXTURE", "key": "form", "name": "Form", "content": fixture},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    rid = response.json()["data"]["id"]
    path = base + "/" + rid
    assert await _receipts(db, turn) == [("resource.created", rid, 1)]
    unrelated = await client.post(
        base,
        json={"kind": "ELEMENT_CATALOG", "key": "catalog", "name": "Catalog", "content": CATALOG},
        headers=headers,
    )
    assert unrelated.status_code == 201
    write = {"revision": 1, "content": fixture}
    assert (await client.put(path + "/draft", json=write, headers=headers)).is_success
    assert (await client.put(path + "/draft", json=write, headers=headers)).status_code == 409
    preview = (await client.get(path + "/validation-preview")).json()["data"]
    request = {"revision": 2, "sourceHash": preview["sourceHash"]}
    assert (await client.post(path + "/validate", json=request, headers=headers)).status_code == 202
    assert (await client.post(path + "/validate", json=request, headers=headers)).status_code == 202
    assert await _receipts(db, turn) == [
        ("resource.created", rid, 1),
        ("resource.draft_updated", rid, 2),
        ("resource.validation_queued", rid, 2),
    ]

    # 恢复历史安装时草稿计数可能超过三十二位，真实的新保存和对话回执都必须保留同一精确修订。
    high = 2**32 + 15
    async with db.sessions.begin() as session:
        draft = await session.get(ResourceDraft, rid)
        draft.revision = high
    saved = await client.put(
        path + "/draft", json={"revision": high, "content": fixture}, headers=headers
    )
    assert saved.is_success, saved.text
    assert saved.json()["data"]["revision"] == high + 1
    assert (await _receipts(db, turn))[-1] == ("resource.draft_updated", rid, high + 1)


async def test_device_form_mismatch_rolls_back_and_delivery_has_distinct_card(site):
    """设备授权和凭据投递必须来自各自能力卡，错误卡不能留下批准或共享变更，正确回执仅含真实设备身份。"""
    client, db = site
    await setup(client)
    await login(client)
    wid = await workspace(client)
    async with emulator() as model:
        turns, _, _ = await conversation(client, wid, model)
        access = await _form(client, turns, model, "DEVICE_ACCESS")
        delivery = await _form(client, turns, model, "DEVICE_CREDENTIAL_DELIVERY")
    enrollment = await client.post(
        "/api/v1/runtime-enrollments",
        json={
            "name": "Device",
            "location": "CONNECTED_LOCAL",
            "capabilities": {
                "engineVersion": "0.1.0",
                "os": "linux",
                "arch": "x64",
                "browsers": ["chromium"],
            },
        },
    )
    assert enrollment.status_code == 201
    item = enrollment.json()["data"]
    approve = f"/api/v1/runtime-enrollments/{item['id']}/approve"
    body = {
        "userCode": item["userCode"],
        "workspaceId": wid,
        "private": False,
        "sharedWithUserIds": [],
    }
    wrong = await client.post(approve, json=body, headers={FORM_ORIGIN_HEADER: delivery})
    assert wrong.status_code == 404
    approved = await client.post(approve, json=body, headers={FORM_ORIGIN_HEADER: access})
    assert approved.is_success, approved.text
    rid = approved.json()["data"]["id"]
    base = f"/api/v1/workspaces/{wid}/runtimes/{rid}"
    assert (
        await client.put(
            base + "/trust",
            json={"trustStatus": "MANAGED", "allowCredentialDelivery": False},
            headers={FORM_ORIGIN_HEADER: access},
        )
    ).is_success
    assert (
        await client.put(
            base + "/credential-delivery",
            json={"allowCredentialDelivery": True},
            headers={FORM_ORIGIN_HEADER: access},
        )
    ).status_code == 404
    assert (await client.get(base)).json()["data"]["allowCredentialDelivery"] is False
    assert (
        await client.put(
            base + "/credential-delivery",
            json={"allowCredentialDelivery": True},
            headers={FORM_ORIGIN_HEADER: delivery},
        )
    ).is_success
    unchanged = await client.put(
        base + "/credential-delivery",
        json={"allowCredentialDelivery": True},
        headers={FORM_ORIGIN_HEADER: delivery},
    )
    assert unchanged.is_success
    assert (
        await client.put(
            base + "/grants",
            json={"workspaceId": wid, "userIds": [], "sharedWithWorkspace": False},
            headers={FORM_ORIGIN_HEADER: access},
        )
    ).is_success
    assert (
        await client.post(base + "/revoke", json={}, headers={FORM_ORIGIN_HEADER: access})
    ).is_success
    assert (
        await client.post(base + "/revoke", json={}, headers={FORM_ORIGIN_HEADER: access})
    ).is_success
    assert await _receipts(db, access) == [
        ("runtime.enrolled", rid, None),
        ("runtime.trust_changed", rid, None),
        ("runtime.grants_changed", rid, None),
        ("runtime.revoked", rid, None),
    ]
    assert await _receipts(db, delivery) == [("runtime.credential_delivery_changed", rid, None)]


@pytest.fixture(name="dataset_deployment")
def _deployment():
    """使用当前测试站点独享的数据集部署注册表，在真实用户和工作区创建后只授权本次受控读取配置。"""
    return {}


async def test_http_dataset_form_records_real_publication_and_copy(dataset_deployment, site):
    """通过正式受管编译器取得连接数据集的发布回执，重复发布不再追加记录，跨资源复制只记录目标草稿标识。"""
    client, db = site
    await setup(client)
    await login(client)
    wid = await workspace(client)
    uid = (await client.get("/api/v1/account")).json()["data"]["id"]
    doc = http_configuration()
    doc["source"]["auth"] = {"kind": "NONE"}
    dataset_deployment[REF] = approved_connection().model_copy(
        update={"workspace_id": wid, "user_ids": [uid], "auth_kinds": ["NONE"]}
    )
    async with emulator() as model:
        turns, _, _ = await conversation(client, wid, model)
        turn = await _form(client, turns, model, "HTTP_DATASET")
    headers = {FORM_ORIGIN_HEADER: turn}
    base = f"/api/v1/workspaces/{wid}/resources"
    created = await client.post(
        base,
        json={
            "kind": "DATASET",
            "key": "original",
            "name": "Original",
            "content": {"kind": "DATASET", "document": doc},
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    rid = created.json()["data"]["id"]
    path = base + "/" + rid
    preview = (await client.get(path + "/validation-preview")).json()["data"]
    job = await client.post(
        path + "/validate",
        json={"revision": 1, "sourceHash": preview["sourceHash"]},
        headers=headers,
    )
    assert job.status_code == 202
    settings = Settings(
        database_url=db.engine.url.render_as_string(hide_password=False),
        environment="development",
        public_url="http://127.0.0.1:18889",
        master_key="a" * 64,
        signing_key="b" * 64,
        dataset_connections=dataset_deployment,
    )
    assert await _compile(db, settings)
    jid = job.json()["data"]["id"]
    proof = await client.get(f"/api/v1/workspaces/{wid}/jobs/{jid}/validation-receipt")
    assert proof.is_success, proof.text
    request = {"revision": 1, "validationReceiptId": proof.json()["data"]["id"]}
    version = await client.post(path + "/publish", json=request, headers=headers)
    assert version.status_code == 201, version.text
    assert (await client.post(path + "/publish", json=request, headers=headers)).json()[
        "data"
    ] == version.json()["data"]
    copied = await client.post(
        base + "/dataset-copies",
        json={
            "sourceWorkspaceId": wid,
            "sourceDatasetVersionId": version.json()["data"]["id"],
            "key": "copy",
            "name": "Copy",
        },
        headers=headers,
    )
    assert copied.status_code == 201, copied.text
    cid = copied.json()["data"]["id"]
    assert (
        await client.patch(base + "/" + cid, json={"name": "Renamed"}, headers=headers)
    ).is_success
    assert (
        await client.patch(base + "/" + cid, json={"name": "Renamed"}, headers=headers)
    ).is_success
    static = _example("asset-DATASET")
    for revision in (1, 2):
        converted = await client.put(
            base + "/" + cid + "/draft",
            json={"revision": revision, "content": static},
            headers=headers,
        )
        assert converted.is_success, converted.text
    assert await _receipts(db, turn) == [
        ("resource.created", rid, 1),
        ("resource.validation_queued", rid, 1),
        ("resource.published", rid, 1),
        ("dataset.copied", cid, 1),
        ("resource.updated", cid, 1),
        ("resource.draft_updated", cid, 2),
    ]


async def test_environment_form_uses_actual_resource_kind_and_private_owner(site):
    """同一环境写入必须匹配环境卡以及当前用户，即使另一个表单来自同一会话，错误来源也不能提交资源或其回执。"""
    client, db = site
    await setup(client)
    await login(client)
    wid = await workspace(client)
    async with emulator() as model:
        turns, _, _ = await conversation(client, wid, model)
        environment = await _form(client, turns, model, "ENVIRONMENT")
        incorrect = await _form(client, turns, model, "FIXTURE")
    document = _example("asset-ENVIRONMENT")
    url = f"/api/v1/workspaces/{wid}/resources"
    body = {"kind": "ENVIRONMENT", "key": "qa-env", "name": "Environment", "content": document}
    await new_member(client, wid, "other-admin@example.com", "ADMIN")
    async with member_client(client, "other-admin@example.com") as other:
        unauthorized = await other.post(url, json=body, headers={FORM_ORIGIN_HEADER: environment})
    assert unauthorized.status_code == 404 and unauthorized.json()["code"] == "AGENT_FORM_NOT_FOUND"
    assert await _receipts(db, environment) == []
    wrong = await client.post(url, json=body, headers={FORM_ORIGIN_HEADER: incorrect})
    assert wrong.status_code == 404 and wrong.json()["code"] == "AGENT_FORM_NOT_FOUND"
    assert await _receipts(db, incorrect) == []
    created = await client.post(url, json=body, headers={FORM_ORIGIN_HEADER: environment})
    assert created.status_code == 201, created.text
    assert await _receipts(db, environment) == [
        ("resource.created", created.json()["data"]["id"], 1)
    ]
