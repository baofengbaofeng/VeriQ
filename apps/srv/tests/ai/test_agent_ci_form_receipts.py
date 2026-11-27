"""使用真实账号和令牌接口核验对话表单回执的事务边界，检查一次性签发的令牌材料不会进入对话历史。"""

import json
from uuid import uuid4

from emulator import emulator
from sqlalchemy import select
from test_conversational_agent import conversation, submit
from test_trigger import plan_fixture

from veriq_server.db import AgentFormReceipt, ServiceToken


async def test_ci_account_and_token_receipts_follow_successful_mutations_and_hide_token(site):
    """从私有对话打开 CI 表单并执行每种支持的治理操作，无效来源撤销整个签发事务，合法回执只存动作及实体编号。"""
    client, db, workspace, _, plan = await plan_fixture(site)
    base = f"/api/v1/workspaces/{workspace}/service-accounts"
    async with emulator() as model:
        path, _, _ = await conversation(client, workspace, model)
        model.output = {
            "reply": "Manage plan tokens.",
            "workspaceForm": {"capability": "CI_PLAN_TOKENS"},
        }
        turn = await submit(client, path, "Manage service account tokens")
        assert turn["workspaceForm"]["capability"] == "CI_PLAN_TOKENS"
        origin = {"X-VeriQ-Agent-Form": turn["id"]}
        ordinary = await client.post(base, json={"name": "Ordinary service"})
        assert ordinary.status_code == 201, ordinary.text
        created = await client.post(base, json={"name": "Scoped service"}, headers=origin)
        assert created.status_code == 201, created.text
        account = created.json()["data"]["id"]
        tokens = f"{base}/{account}/tokens"
        enrollment = {"purpose": "RUNTIME_ENROLLMENT"}
        forbidden_issue = await client.post(tokens, json=enrollment, headers=origin)
        assert (forbidden_issue.status_code, forbidden_issue.json().get("code")) == (
            422,
            "PLAN_TOKEN_PURPOSE_REQUIRED",
        )
        ordinary_token = await client.post(tokens, json=enrollment)
        assert ordinary_token.status_code == 201, ordinary_token.text
        ordinary_token_id = ordinary_token.json()["data"]["id"]
        enrollment_revoke = f"{tokens}/{ordinary_token_id}/revoke"
        denied = await client.post(enrollment_revoke, json={}, headers=origin)
        assert (denied.status_code, denied.json().get("code")) == (
            422,
            "PLAN_TOKEN_PURPOSE_REQUIRED",
        )
        async with db.sessions() as session:
            assert (await session.get(ServiceToken, ordinary_token_id)).revoked_at is None
        assert (await client.post(enrollment_revoke, json={})).status_code == 200

        intent = {"purpose": "EXECUTION", "operations": ["trigger"], "planIds": [plan["id"]]}
        wrong_origin = await client.post(
            tokens, json=intent, headers={"X-VeriQ-Agent-Form": str(uuid4())}
        )
        assert (wrong_origin.status_code, wrong_origin.json().get("code")) == (
            404,
            "AGENT_FORM_NOT_FOUND",
        )
        async with db.sessions() as session:
            assert not (
                await session.scalars(
                    select(ServiceToken).where(
                        ServiceToken.service_account_id == account,
                        ServiceToken.purpose == "EXECUTION",
                    )
                )
            ).all()
        issued = await client.post(tokens, json=intent, headers=origin)
        assert issued.status_code == 201, issued.text
        issued_data = issued.json()["data"]
        token_id = issued_data["id"]
        assert issued_data["token"]
        revoked = await client.post(f"{tokens}/{token_id}/revoke", json={}, headers=origin)
        disabled = await client.post(f"{base}/{account}/disable", json={}, headers=origin)
        assert revoked.status_code == disabled.status_code == 200
        async with db.sessions() as session:
            first_revocation = (await session.get(ServiceToken, token_id)).revoked_at
        assert (
            await client.post(f"{tokens}/{token_id}/revoke", json={}, headers=origin)
        ).status_code == 200
        assert (
            await client.post(f"{base}/{account}/disable", json={}, headers=origin)
        ).status_code == 200
        async with db.sessions() as session:
            assert (await session.get(ServiceToken, token_id)).revoked_at == first_revocation
        history = (await client.get(path)).json()["data"]["items"]
        receipts = next(row for row in history if row["id"] == turn["id"])["workspaceFormReceipts"]
        expected = [
            ("service_account.created", account),
            ("service_token.issued", token_id),
            ("service_token.revoked", token_id),
            ("service_account.disabled", account),
        ]
        assert [(r["action"], r["targetId"]) for r in receipts] == expected
        assert all(r["capability"] == "CI_PLAN_TOKENS" for r in receipts)
        assert issued_data["token"] not in json.dumps(history)
        model.output = {"reply": "The account operations are complete."}
        await submit(client, path, "What changed?")
        sent = json.dumps(model.calls[-1]["body"]["messages"])
        assert issued_data["token"] not in sent and token_id not in sent
        async with db.sessions() as session:
            rows = (
                await session.scalars(
                    select(AgentFormReceipt).where(AgentFormReceipt.turn_id == turn["id"])
                )
            ).all()
            assert len(rows) == 4
