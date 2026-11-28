"""通过独立员工登录、真实管理请求和回环供应商协议确认私有表单回执的事务边界、可见字段及撤权结果。"""

import json

import pytest
from emulator import emulator
from test_agent_sessions import _scope
from test_conversational_agent import conversation, submit
from test_workspace import client, new_member


@pytest.fixture(name="credential_form")
async def _credential_form(site):
    """成员以可降级的管理角色在自己的会话中打开凭据表单，空间所有者独立登录以验证同权限员工的操作隔离。"""
    owner, _ = site
    ws = await _scope(owner)
    user_id = await new_member(owner, ws, role="ADMIN")
    async with client(owner, "member@example.com") as admin, emulator() as model:
        path, _, _ = await conversation(admin, ws, model)
        model.output = {
            "reply": "Open the credential form.",
            "workspaceForm": {"capability": "AUTH_CREDENTIALS"},
        }
        original = await submit(admin, path, "Open the credential form.")
        assert original["workspaceForm"]["capability"] == "AUTH_CREDENTIALS"
        yield owner, admin, user_id, f"/api/v1/workspaces/{ws}", model, path, original


def credential(ref):
    """用彼此不同的私有标记生成合法凭据请求，从出站模型报文中能够独立检查每个表单字段是否泄露。"""
    return {
        "secretRef": ref,
        "value": {"token": f"synthetic-secret-for-{ref}"},
        "allowedIdentityIds": ["private-reader-alias"],
    }


async def history(admin, turns):
    """通过同一员工在授权会话中的公开历史接口重新读取结果，并按轮次编号保留回执与原提案的对应关系。"""
    result = await admin.get(turns)
    assert result.is_success, result.text
    return {turn["id"]: turn for turn in result.json()["data"]["items"]}


async def test_auth_adapter_form_receipts_cover_only_state_changes(credential_form):
    """每次提交后读取原会话历史，核对创建和首次撤销各写一条指向同一适配器版本的回执，重复撤销保留两条原回执。"""
    _, admin, _, base, _, turns, original = credential_form
    route = base + "/auth-adapters"
    headers = {"X-VeriQ-Agent-Form": original["id"]}
    configuration = {"kind": "HTTP_BEARER", "identityPath": "/me", "identityPointer": "/id"}
    created = await admin.post(route, json={"configuration": configuration}, headers=headers)
    assert created.status_code == 201, created.text
    version = created.json()["data"]["versionId"]
    receipts = (await history(admin, turns))[original["id"]]["workspaceFormReceipts"]
    assert [(row["action"], row["targetId"]) for row in receipts] == [
        ("auth_adapter.created", version)
    ]
    for _ in range(2):
        revoked = await admin.post(f"{route}/{version}/revoke", json={}, headers=headers)
        assert revoked.status_code == 200, revoked.text
        assert revoked.json()["data"]["revoked"] is True
        receipts = (await history(admin, turns))[original["id"]]["workspaceFormReceipts"]
        assert [(row["action"], row["targetId"]) for row in receipts] == [
            ("auth_adapter.created", version),
            ("auth_adapter.revoked", version),
        ]


async def test_wrong_actor_and_wrong_workflow_roll_back_credential_creation(credential_form):
    """有领域权限的其他员工以及持有别种表单的原员工都不能借用轮次；拒绝后凭据和对话回执都不存在。"""
    owner, admin, _, base, model, turns, original = credential_form
    model.output = {
        "reply": "Open the member form.",
        "workspaceForm": {"capability": "WORKSPACE_MEMBERS"},
    }
    unrelated = await submit(admin, turns, "Open member settings.")
    assert unrelated["workspaceForm"]["capability"] == "WORKSPACE_MEMBERS"
    route = base + "/credentials"
    for requester, turn_id in [(owner, original["id"]), (admin, unrelated["id"])]:
        denied = await requester.post(
            route,
            json=credential("rollback-marker"),
            headers={"X-VeriQ-Agent-Form": turn_id},
        )
        assert denied.status_code == 404 and denied.json()["code"] == "AGENT_FORM_NOT_FOUND"
        listed = await admin.get(route)
        assert listed.is_success and listed.json()["data"]["items"] == []
        assert all(
            "workspaceFormReceipts" not in row for row in (await history(admin, turns)).values()
        )


async def test_private_credential_receipt_has_bounded_model_projection_and_live_role_gate(
    credential_form,
):
    """同一员工在其他标签页的普通写入不归入会话；表单写入后核对历史、模型上下文和角色降级后的再次读取。"""
    owner, admin, user_id, base, model, turns, original = credential_form
    route = base + "/credentials"
    async with client(owner, "member@example.com") as other_tab:
        direct = await other_tab.post(route, json=credential("direct-tab"))
    assert direct.status_code == 201, direct.text
    assert "workspaceFormReceipts" not in (await history(admin, turns))[original["id"]]

    target_ids = []
    private_values = {direct.json()["data"]["versionId"]}
    for index in range(4):
        value = credential(f"reviewed-form-{index}")
        created = await admin.post(
            route, json=value, headers={"X-VeriQ-Agent-Form": original["id"]}
        )
        assert created.status_code == 201, created.text
        target_ids.append(created.json()["data"]["versionId"])
        private_values.update(
            (value["value"]["token"], value["secretRef"], *value["allowedIdentityIds"])
        )
    reviewed = (await history(admin, turns))[original["id"]]
    receipts = reviewed["workspaceFormReceipts"]
    assert [row["targetId"] for row in receipts] == target_ids
    for receipt in receipts:
        assert set(receipt) == {"id", "action", "capability", "targetId", "createdAt"}
        assert receipt["action"] == "credential.version.created"
        assert receipt["capability"] == "AUTH_CREDENTIALS"
    assert all(value not in json.dumps(reviewed) for value in private_values)

    model.output = {"reply": "We can continue."}
    followup = await submit(admin, turns, "Summarize the change I just made.")
    assert followup["status"] == "COMPLETED"
    outbound = model.calls[-1]["body"]
    sent = json.loads(outbound["messages"][1]["content"])["context"]["history"]
    summaries = [item for turn in sent for item in turn.get("workspaceFormReceipts", [])]
    assert summaries == [
        {field: receipt[field] for field in ("action", "capability", "createdAt")}
        for receipt in receipts[-3:]
    ]
    private_values.update(target_ids)
    private_values.update(row["id"] for row in receipts)
    assert all(value not in json.dumps(outbound) for value in private_values)

    changed = await owner.put(
        base + "/members/" + user_id, json={"role": "EDITOR", "status": "ACTIVE"}
    )
    assert changed.is_success, changed.text
    visible = (await history(admin, turns))[original["id"]]
    assert "workspaceForm" not in visible and "workspaceFormReceipts" not in visible
    another = await submit(admin, turns, "What should we work on next?")
    assert another["status"] == "COMPLETED"
    after = json.loads(model.calls[-1]["body"]["messages"][1]["content"])["context"]["history"]
    assert all("workspaceFormReceipts" not in turn for turn in after)

    restored = await owner.put(
        base + "/members/" + user_id, json={"role": "ADMIN", "status": "ACTIVE"}
    )
    assert restored.is_success, restored.text
    assert (await history(admin, turns))[original["id"]]["workspaceFormReceipts"] == receipts
