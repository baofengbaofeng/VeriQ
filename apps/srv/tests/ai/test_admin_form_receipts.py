"""通过实际员工表单写入验证会话回执、凭据数据隔离、供应商修订和工作区归档都遵循各自的事务边界。"""

from uuid import uuid4

from sqlalchemy import select
from test_agent_sessions import _create, _scope
from test_generation import provider_config
from test_workspace import new_member, workspace as create_workspace

from veriq_server.db import AgentFormReceipt, AgentTurn
from veriq_server.service import now


async def test_admin_form_mutations_commit_only_scoped_receipts(site):
    """让一条错误能力的凭据提交先失败，再复用同一引用正确创建，核对版本、修订与归档的权威回执。"""
    client, database = site
    workspace = await _scope(client)
    conversation = await _create(client, workspace, "Administrative forms")
    cards = {
        capability: str(uuid4())
        for capability in (
            "AUTH_CREDENTIALS",
            "AI_PROVIDERS",
            "WORKSPACE_MEMBERS",
            "NOTIFICATION_INBOX",
            "WORKSPACE_ARCHIVE",
        )
    }
    async with database.sessions.begin() as session:
        for capability, turn in cards.items():
            session.add(
                AgentTurn(
                    id=turn,
                    session_id=conversation["id"],
                    request_id=str(uuid4()),
                    attempt_id=str(uuid4()),
                    created_at=now(),
                    status="COMPLETED",
                    text="Open the administrative form",
                    workspace_capability=capability,
                )
            )

    def origin(capability):
        return {"X-VeriQ-Agent-Form": cards[capability]}

    base = f"/api/v1/workspaces/{workspace}"
    secret = {
        "secretRef": "integration",
        "value": {"token": "synthetic"},
        "allowedIdentityIds": ["reader"],
    }
    failed = await client.post(base + "/credentials", json=secret, headers=origin("AI_PROVIDERS"))
    assert (failed.status_code, failed.json()["code"]) == (404, "AGENT_FORM_NOT_FOUND")
    assert (await client.get(base + "/credentials")).json()["data"]["items"] == []
    created = await client.post(
        base + "/credentials", json=secret, headers=origin("AUTH_CREDENTIALS")
    )
    assert created.status_code == 201, created.text
    version = created.json()["data"]["versionId"]
    address = base + f"/credentials/integration/versions/{version}/revoke"
    assert (
        await client.post(address, json={}, headers=origin("AUTH_CREDENTIALS"))
    ).status_code == 200

    replay = await client.post(address, json={}, headers=origin("AUTH_CREDENTIALS"))
    assert replay.status_code == 200
    providers = base + "/ai/providers"
    config = provider_config("https://api.openai.com/v1")
    provider = await client.post(providers, json=config, headers=origin("AI_PROVIDERS"))
    assert provider.status_code == 201, provider.text
    provider_id = provider.json()["data"]["id"]
    result = await client.put(
        providers + "/" + provider_id,
        json={**config, "monthlyBudgetUsd": 2},
        headers=origin("AI_PROVIDERS"),
    )
    assert result.status_code == 200, result.text
    assert (
        await client.delete(providers + "/" + provider_id, headers=origin("AI_PROVIDERS"))
    ).status_code == 200
    invitation = await client.post(
        base + "/invitations",
        json={"email": "receipt@example.test", "role": "VIEWER"},
        headers=origin("WORKSPACE_MEMBERS"),
    )
    assert invitation.status_code == 201, invitation.text
    invitation_id = invitation.json()["data"]["id"]
    member = await new_member(client, workspace)
    member_url = base + "/members/" + member
    for _ in range(2):
        response = await client.put(
            member_url,
            json={"role": "EXECUTOR", "status": "DISABLED"},
            headers=origin("WORKSPACE_MEMBERS"),
        )
        assert response.status_code == 200, response.text
    assert (await client.delete(member_url, headers=origin("WORKSPACE_MEMBERS"))).status_code == 200

    other = await create_workspace(client, "another")
    for identifier in [workspace, other]:
        invited = await client.post(
            f"/api/v1/workspaces/{identifier}/invitations",
            json={"email": "admin@example.com", "role": "VIEWER"},
        )
        assert invited.status_code == 201
    inbox = "/api/v1/notifications"
    notices = (await client.get(inbox)).json()["data"]["items"]
    by_space = {notice["workspaceId"]: notice["id"] for notice in notices}
    wrong = await client.post(
        inbox + "/" + by_space[other] + "/read", json={}, headers=origin("NOTIFICATION_INBOX")
    )
    assert wrong.status_code == 404
    for _ in range(2):
        marked = await client.post(
            inbox + "/" + by_space[workspace] + "/read",
            json={},
            headers=origin("NOTIFICATION_INBOX"),
        )
        assert marked.status_code == 200, marked.text
    assert (await client.delete(base, headers=origin("WORKSPACE_ARCHIVE"))).status_code == 200

    async with database.sessions() as session:
        book = await session.scalars(
            select(AgentFormReceipt).where(AgentFormReceipt.turn_id.in_(cards.values()))
        )
        receipts = [(row.turn_id, row.action, row.target_id, row.revision) for row in book]
        assert len(receipts) == len(set(receipts))
        assert set(receipts) == {
            (cards["AUTH_CREDENTIALS"], "credential.version.created", version, None),
            (cards["AUTH_CREDENTIALS"], "credential.version.revoked", version, None),
            (cards["AI_PROVIDERS"], "ai.provider_configured", provider_id, 1),
            (cards["AI_PROVIDERS"], "ai.provider_configured", provider_id, 2),
            (cards["AI_PROVIDERS"], "ai.provider_deleted", provider_id, 3),
            (cards["WORKSPACE_MEMBERS"], "workspace.invited", invitation_id, None),
            (cards["WORKSPACE_MEMBERS"], "workspace.member_updated", member, None),
            (cards["WORKSPACE_MEMBERS"], "workspace.member_removed", member, None),
            (cards["NOTIFICATION_INBOX"], "notification.read", by_space[workspace], None),
            (cards["WORKSPACE_ARCHIVE"], "workspace.archived", workspace, None),
        }
